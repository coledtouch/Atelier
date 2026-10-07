import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeR2, workerRequest } from './fake-r2.mjs';
import { handleSync } from '../src/sync.js';
import { createSync, memoryStore, syncNamespace, bindUi, COPY, statusLine, init, wrapDb, suspend } from '../public/sync.js';

const NO_TIMERS = { setTimeout: () => 0, clearTimeout() {} };
const T0 = 1_800_000_000_000;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const sample = (id = 't1') => ({ id, title: 'My own work', createdAt: T0, updatedAt: T0, entries: [{ id: `${id}e1`, kind: 'ask', prompt: 'Help me think', text: 'A private answer', createdAt: T0 }] });
function memDb() {
  const rows = new Map();
  const copy = (value) => value === undefined ? undefined : structuredClone(value);
  return {
    rows,
    async keys() { return [...rows.keys()]; },
    async get(id) { return copy(rows.get(id)); },
    async put(thread) { rows.set(thread.id, copy(thread)); },
    async putAll(threads) { for (const thread of threads) rows.set(thread.id, copy(thread)); },
    async del(id) { rows.delete(id); },
    async clear() { rows.clear(); },
    async update(id, change) { const previous = copy(rows.get(id)), next = change(previous); if (next === null) rows.delete(id); else if (next) rows.set(id, copy(next)); return previous; },
  };
}
function harness(extra = {}) {
  const db = memDb(), store = memoryStore(), log = [], asked = [], bucket = fakeR2();
  const locks = {
    names: [],
    async request(name, options, fn) { this.names.push(name); if (typeof options === 'function') fn = options; return fn({ name }); },
    async query() { return { held: [], pending: [] }; },
  };
  const eng = createSync({
    account: 'tester', scope: 'tester_a', isOwner: () => true, isTester: () => true,
    db, store, locks, timers: NO_TIMERS, now: () => T0, onAsk: (n) => asked.push(n),
    apiHeaders: () => ({ 'x-app-pass': 'owner-secret', 'X-App-Pass': 'owner-secret-again' }),
    fetch: async (url, request) => {
      log.push({ url, ...request });
      // The account router supplies its own private bucket prefix. Exercise the real sync protocol underneath it.
      const routed = new URL(url.replace('/api/tester/sync/', '/api/sync/'), 'https://atelier.test');
      return handleSync(workerRequest(routed, request), { SYNC_BUCKET: bucket }, routed, routed.pathname.slice('/api/'.length));
    },
    ...extra,
  });
  return { eng, db, store, log, asked, locks, bucket };
}
async function settle(eng) {
  for (let i = 0; i < 100; i++) { await tick(); if (!eng.busy()) break; }
}

test('tester sync defaults off and asks even when the verified account has no threads', async () => {
  const { eng, asked, log } = harness();
  assert.equal(eng.firstRunAhead(), false);
  await eng.verified(); await settle(eng);
  assert.deepEqual(asked, [0]);
  assert.equal(eng.on(), false);
  assert.equal(eng.status().asked, false);
  assert.equal(log.length, 0, 'no private data or empty index is requested before consent');
  await eng.answer('off'); await eng.verified();
  assert.deepEqual(asked, [0], 'declining is remembered');
  assert.equal(eng.config().asked, true);
  assert.equal(eng.on(), false);
  eng.destroy();
});

test('unverified tester eligibility cannot ask or start sync', async () => {
  const { eng, asked, log } = harness({ isOwner: () => false });
  await eng.verified();
  assert.equal(await eng.turnOn(), 'no');
  assert.deepEqual(asked, []);
  assert.deepEqual(log, []);
  eng.destroy();
});

test('a tester scope without a verified eligibility predicate stays local', async () => {
  const { eng, asked, log } = harness({ isOwner: undefined });
  await eng.verified();
  assert.equal(await eng.turnOn(), 'no');
  assert.deepEqual(asked, []); assert.deepEqual(log, []);
  eng.destroy();
});

test('consented tester threads use the cookie route without either spelling of the owner header', async () => {
  const { eng, db, store, log, locks, bucket } = harness();
  const own = sample(); own.entries[0].cut = 'cap';
  await db.put(own);
  eng.noteWrite([own.id], [own]);
  await eng.verified();
  assert.equal(log.length, 0);
  await eng.answer('all'); await settle(eng); await eng.cycle(); await settle(eng);
  assert.ok(log.length > 0);
  for (const request of log) {
    assert.ok(request.url.startsWith('/api/tester/sync/'));
    assert.equal(request.credentials, 'same-origin');
    assert.equal(new Headers(request.headers).get('x-app-pass'), null);
  }
  assert.ok(bucket.json('t/t1.json'), 'a tester-marked reply can sync inside its own account');
  assert.equal(await store.get('lo:t1'), undefined, 'the old shared-browser local-only marker is not written');
  assert.ok(locks.names.includes('atelier-sync-leader:tester_a'));
  const release = eng.holdRunLock('entry2'); await tick(); release();
  assert.ok(locks.names.includes('atelier-run:tester_a:entry2'));
  assert.equal(eng.status().account, 'tester');
  assert.equal(eng.status().tester, false, 'eligible tester sync uses the same Your data controls');
  eng.destroy();
});

test('owner namespaces stay stable and distinct tester accounts cannot share their state or run locks', () => {
  assert.deepEqual(syncNamespace('owner', 'ignored'), { store: 'atelier-sync', channel: 'atelier-sync', leader: 'atelier-sync-leader', run: 'atelier-run:' });
  const a = syncNamespace('tester', 'tester_a'), b = syncNamespace('tester', 'tester_b');
  for (const field of ['store', 'channel', 'leader', 'run']) assert.notEqual(a[field], b[field]);
  assert.throws(() => syncNamespace('tester', ''), /stable account scope/);
  assert.throws(() => syncNamespace('tester', '../owner'), /stable account scope/);
});

test('tester session expiry pauses further network requests and asks for LinkedIn sign-in', async () => {
  const log = [];
  const { eng } = harness({ fetch: async (url) => { log.push(url); return new Response('{}', { status: 401 }); } });
  await eng.verified(); await eng.answer('all'); await settle(eng);
  await eng.cycle();
  assert.equal(log.length, 1);
  assert.equal(eng.status().paused.reason, 'passcode');
  assert.equal(statusLine(eng.status()), COPY.signIn);
  eng.destroy();
});

function fakeDoc() {
  const elements = new Map();
  const make = () => ({
    hidden: false, checked: false, disabled: false, open: false, offsetParent: null, textContent: '', children: [], listeners: new Map(),
    addEventListener(type, fn) { const list = this.listeners.get(type) || []; list.push(fn); this.listeners.set(type, list); },
    removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter((f) => f !== fn)); },
    fire(type) { for (const fn of this.listeners.get(type) || []) fn({ target: this }); },
    click() { this.fire('click'); }, focus() {}, showModal() { this.open = true; },
    close() { if (!this.open) return; this.open = false; this.fire('close'); }, replaceChildren(...children) { this.children = children; },
  });
  return { querySelector(selector) { if (!elements.has(selector)) elements.set(selector, make()); return elements.get(selector); }, createElement: make };
}
for (const choice of ['keep', 'close', 'enable']) test(`tester consent UI: ${choice} keeps the chosen privacy setting`, async () => {
  const doc = fakeDoc();
  let ui;
  const { eng } = harness({ onAsk: (n) => ui.ask(n) });
  ui = bindUi(eng, { account: 'tester' }, doc);
  await eng.verified();
  assert.match(doc.querySelector('#syncFirstBody').textContent, /Sync threads privately to this LinkedIn account\?/);
  assert.equal(doc.querySelector('#syncFirstNew').textContent, 'Keep on this device');
  assert.equal(doc.querySelector('#syncFirstAll').textContent, 'Enable private sync');
  if (choice === 'close') doc.querySelector('#syncFirst').close();
  else doc.querySelector(choice === 'keep' ? '#syncFirstNew' : '#syncFirstAll').click();
  await settle(eng); await tick();
  assert.equal(eng.config().asked, true);
  assert.equal(eng.on(), choice === 'enable');
  ui.destroy(); eng.destroy();
});

test('suspending an account stops old network and old UI without deleting its local saves', async () => {
  const { eng, db, log } = harness();
  await eng.verified(); await eng.answer('all'); await settle(eng);
  const before = log.length;
  eng.destroy(); eng.start(); await eng.verified(); await eng.cycle();
  assert.equal(log.length, before, 'a detached engine cannot restart');
  await eng.saveThread(sample('old_account_write'));
  assert.ok(await db.get('old_account_write'), 'an already-started local save may still land in its original DB');
  const doc = fakeDoc(), answers = [];
  const ui = bindUi({ status: () => ({ owner: true, on: false }), answer: async (x) => answers.push(x) }, { account: 'tester' }, doc);
  await ui.ask(0); ui.destroy();
  doc.querySelector('#syncFirstAll').click();
  assert.deepEqual(answers, [], 'destroying the old dialog cannot enable a different account');
});

test('pending DB callbacks retain the engine and scope from when their operation began', async (context) => {
  const originals = new Map();
  const setGlobal = (name, value) => { originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, writable: true, value }); };
  const channels = [];
  class FakeChannel { constructor(name) { this.name = name; channels.push(this); } addEventListener() {} removeEventListener() {} postMessage() {} close() { this.closed = true; } }
  setGlobal('BroadcastChannel', FakeChannel);
  setGlobal('navigator', { onLine: true, storage: {}, locks: null });
  setGlobal('document', { visibilityState: 'visible', querySelector: () => null });
  context.after(() => { suspend(); for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } });
  const a = memDb(), b = memDb();
  let finishWrite, finishRead, finishDelete;
  a.putAll = () => new Promise((resolve) => { finishWrite = resolve; });
  a.get = () => new Promise((resolve) => { finishRead = resolve; });
  a.del = () => new Promise((resolve) => { finishDelete = resolve; });
  const writesA = [], writesB = [], readsA = [], readsB = [], deletesA = [], deletesB = [];
  const engA = init({ rawDB: a, store: memoryStore(), account: 'tester', scope: 'tester_a', isOwner: () => false, timers: NO_TIMERS });
  engA.noteWrite = (ids) => writesA.push(...ids); engA.noteRead = (row) => readsA.push(row.id); engA.noteHidden = (id) => deletesA.push(id);
  const wrappedA = wrapDb(a);
  const write = wrappedA.putAll([sample('a_only')]), read = wrappedA.get('a_only'), deletion = wrappedA.del('a_deleted');
  suspend();
  const engB = init({ rawDB: b, store: memoryStore(), account: 'tester', scope: 'tester_b', isOwner: () => false, timers: NO_TIMERS });
  engB.noteWrite = (ids) => writesB.push(...ids); engB.noteRead = (row) => readsB.push(row.id); engB.noteHidden = (id) => deletesB.push(id);
  finishWrite(); finishRead(sample('a_only')); finishDelete();
  await Promise.all([write, read, deletion]);
  assert.deepEqual(writesA, ['a_only']); assert.deepEqual(writesB, []);
  assert.deepEqual(readsA, ['a_only']); assert.deepEqual(readsB, []);
  assert.deepEqual(deletesA, ['a_deleted']); assert.deepEqual(deletesB, []);
  assert.deepEqual(channels.map((channel) => channel.name), ['atelier-sync:tester_a', 'atelier-sync:tester_b']);
  assert.equal(channels[0].closed, true);
});
