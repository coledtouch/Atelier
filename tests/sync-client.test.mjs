// public/sync.js, the browser engine, run in Node: each "device" has an in-memory atelier-data store, a Map-backed
// sync store and its own Web Locks fake; every request goes through the REAL src/sync.js over tests/fake-r2.mjs
// (with the worker's passcode check in front), so client and server are tested together.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeR2, workerRequest } from './fake-r2.mjs';
import { handleSync, SYNC_TIMING } from '../src/sync.js';
import {
  createSync, memoryStore, statusLine, countsLine, sizeText, agoText, forkNote, patchInPlace, COPY, SYNC_CLIENT, wipeText, deviceOnly, bindUi,
} from '../public/sync.js';
import { canonical, strip, applyPush, sha256hex, entryHash, quickPrint, utf8Length } from '../public/sync-merge.js';
import { validateBackup, recoverThread } from '../public/data-safety.js';
import { createHash } from 'node:crypto';

const T0 = 1_800_000_000_000, MIN = 60_000;
const NO_TIMERS = { setTimeout: () => 0, clearTimeout: () => {} };
const ask = (id, at, text = `answer ${id}`, extra = {}) => ({ id, kind: 'ask', prompt: `prompt ${id}`, createdAt: at, text, ...extra });
const thread = (id, entries, extra = {}) => ({ id, title: `Thread ${id}`, createdAt: entries[0]?.createdAt ?? T0, updatedAt: T0, entries, ...extra });
const shape = (t) => t && { title: t.title, entries: t.entries.map((e) => canonical(strip(e))) };
const tick = () => new Promise((r) => setImmediate(r));

// ── harness ──
function world({ bucket = true, pageSize } = {}) {
  const clock = { t: T0 };
  const r2 = fakeR2({ pageSize });
  SYNC_TIMING.now = () => clock.t; SYNC_TIMING.sleep = async () => {}; SYNC_TIMING.jitter = () => 0;
  const w = { clock, r2, env: bucket ? { SYNC_BUCKET: r2, SYNC_QUOTA_BYTES: '53687091200' } : {}, log: [] };
  w.fetchFor = (dev) => async (url, init = {}) => {
    const u = new URL(url, 'https://atelier.test');
    const headers = new Headers(init.headers || {});
    const entry = { dev: dev.name, method: init.method || 'GET', path: u.pathname.slice('/api/sync/'.length) + u.search, keepalive: Boolean(init.keepalive), body: init.body, inm: headers.get('if-none-match') };
    w.log.push(entry);
    if (dev.offline) throw new TypeError('Failed to fetch');
    const hooked = await dev.before?.(entry);
    if (hooked) return hooked;
    // worker.js in front of handleSync: passcodeGuard → 401 on a wrong passcode
    if (headers.get('x-app-pass') !== 'pw') return new Response('{"error":"Wrong passcode"}', { status: 401 });
    if (init.body != null) headers.set('content-length', String(typeof init.body === 'string' ? Buffer.byteLength(init.body) : init.body.byteLength));
    const res = await handleSync(workerRequest(u, { method: entry.method, headers, body: init.body }), w.env, u, u.pathname.slice('/api/'.length));
    entry.status = res.status;
    return res;
  };
  w.requests = (dev) => w.log.filter((x) => !dev || x.dev === dev.name);
  w.doc = (id) => r2.json(`t/${id}.json`);
  return w;
}
function memDb() {
  const m = new Map(), removed = [];
  const c = (v) => (v === undefined ? undefined : structuredClone(v));
  return {
    m, removed,
    async get(id) { return c(m.get(id)); },
    async put(t) { m.set(t.id, c(t)); },
    async putAll(ts) { for (const t of ts) m.set(t.id, c(t)); },
    async del(id) { if (m.delete(id)) removed.push(id); },
    async keys() { return [...m.keys()]; },
    async update(id, fn) { const cur = c(m.get(id)); const next = fn(cur); if (next === null) { if (m.delete(id)) removed.push(id); } else if (next) m.set(id, c(next)); return cur; },
  };
}
function fakeLocks() {
  const held = new Map();
  return {
    held,
    async request(name, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {}; }
      while (held.has(name)) {
        if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        await Promise.race([held.get(name).done, new Promise((_, rej) => opts.signal?.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')), { once: true }))]);
      }
      let release;
      held.set(name, { done: new Promise((r) => { release = r; }) });
      try { return await cb({ name }); } finally { held.delete(name); release(); }
    },
    async query() { return { held: [...held.keys()].map((name) => ({ name })), pending: [] }; },
  };
}
// A BroadcastChannel stand-in shared by the tabs of one device.
function bus() {
  const ports = [];
  return () => {
    const port = { listeners: [], addEventListener(_, fn) { this.listeners.push(fn); }, postMessage(data) { for (const p of ports) if (p !== port) for (const fn of p.listeners) queueMicrotask(() => fn({ data: structuredClone(data) })); } };
    ports.push(port);
    return port;
  };
}
function device(w, name, opts = {}) {
  const dev = { name, db: opts.db || memDb(), store: opts.store || memoryStore(), locks: opts.locks || fakeLocks(), offline: false, tester: false, traces: false, open: null, live: new Set(), toasts: [], applied: [], asked: [], statuses: [], n: 0, pass: 'pw', ...opts };
  dev.engine = createSync({
    db: dev.db, store: dev.store, locks: dev.locks, channel: opts.channel || null,
    apiHeaders: () => ({ 'content-type': 'application/json', ...(dev.pass ? { 'x-app-pass': dev.pass } : {}) }),
    isOwner: () => !dev.tester && Boolean(dev.pass), isTester: () => dev.tester, hasTesterTraces: () => dev.traces,
    getOpen: () => dev.open, isLive: (id) => dev.live.has(id), onApplied: (x) => dev.applied.push(x), onAsk: (n) => dev.asked.push(n),
    onStatus: (st) => dev.statuses.push(st),
    fetch: w.fetchFor(dev), now: () => w.clock.t, uid: () => `${name}f${++dev.n}`, timers: opts.timers || NO_TIMERS,
    online: () => !dev.offline, visible: () => !dev.hiddenTab, toast: (m) => dev.toasts.push(m), random: () => 0.5,
    onCleared: () => { dev.cleared = (dev.cleared || 0) + 1; }, ...(opts.validate ? { validate: opts.validate } : {}),
    connection: () => dev.conn || null, ...(opts.engine || {}),
  });
  // app.js's wrapped DB: put saves through the engine (saveThread: a copy it knows takes in other tabs' saves first),
  // then tells it the save landed (noteWrite); load is DB.get, whose object the engine knows as read (noteRead) — what
  // a tab's open thread is refreshed against.
  dev.put = async (t) => { await dev.engine.saveThread(t); dev.engine.noteWrite([t.id], [t]); };
  dev.load = async (id) => { const t = await dev.db.get(id); dev.engine.noteRead(t); return t; };
  dev.get = (id) => dev.db.m.get(id);
  return dev;
}
async function sync(dev) {
  for (let i = 0; i < 4; i++) { await dev.engine.run({ pull: true }); await tick(); if (!dev.engine.busy()) return; }
}
async function push(dev) { for (let i = 0; i < 4; i++) { await dev.engine.run({ pull: false }); await tick(); if (!dev.engine.busy()) return; } }
async function online(dev) { await dev.engine.verified(); await tick(); await sync(dev); }
// Lets message handlers and background cycles run until every listed engine has been idle for a while (real time:
// SHA-256 settles on Node's thread pool, which a busy machine slows down).
async function settle(...devs) {
  let quiet = 0;
  for (let i = 0; i < 3000 && quiet < 12; i++) {
    await new Promise((r) => (i < 10 ? setImmediate(r) : setTimeout(r, 1)));
    quiet = devs.every((d) => !d.engine.busy()) ? quiet + 1 : 0;
  }
}
// Waits (real time, bounded) until check() holds; each round may first nudge the work along.
async function until(check, nudge = () => {}, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await check()) && Date.now() < end) { nudge(); await new Promise((r) => setTimeout(r, 2)); }
  return check();
}
// Timers the test fires by hand: fire(ms) runs every pending timer armed with exactly that delay.
function manualTimers() {
  const q = [];
  return {
    q,
    setTimeout: (fn, ms) => { q.push({ fn, ms }); return q.length; },
    clearTimeout: (i) => { if (q[i - 1]) q[i - 1].fn = null; },
    fire(pred) { const due = q.filter((t) => t.fn && (typeof pred === 'function' ? pred(t.ms) : t.ms === pred)); for (const t of due) { const f = t.fn; t.fn = null; f(); } return due.length; },
    armed(pred) { return q.filter((t) => t.fn && (typeof pred === 'function' ? pred(t.ms) : t.ms === pred)).length; },
  };
}
// Two tabs of one browser: one IndexedDB, one sync store, one lock manager, one BroadcastChannel.
function twoTabs(w, opts1 = {}, opts2 = {}) {
  const db = memDb(), store = memoryStore(), locks = fakeLocks(), port = bus();
  return [device(w, 'tab1', { db, store, locks, channel: port(), ...opts1 }), device(w, 'tab2', { db, store, locks, channel: port(), ...opts2 })];
}
const posts = (w, dev) => w.requests(dev).filter((x) => x.method === 'POST' && x.path.startsWith('thread/')).map((x) => JSON.parse(x.body));

// ── copy ──
test('status and counts lines use the exact Settings copy', () => {
  const at = T0;
  const base = { owner: true, on: true, state: 'idle', paused: null, waiting: 0, lastOkAt: at - 2 * MIN };
  assert.equal(statusLine({ owner: true, on: false }), COPY.off);
  assert.equal(statusLine({ owner: false, on: false }), '');
  assert.equal(statusLine(base, at), 'Up to date · synced 2 min ago');
  assert.equal(statusLine({ ...base, lastOkAt: at - 5000 }, at), 'Up to date · synced just now');
  assert.equal(statusLine({ ...base, state: 'syncing', progress: { verb: 'threads', done: 11, total: 48 } }, at), 'Syncing… 12 of 48 threads');
  assert.equal(statusLine({ ...base, state: 'syncing', progress: { verb: 'download', done: 4, total: 20 } }, at), 'Downloading 5 of 20 items');
  assert.equal(statusLine({ ...base, state: 'syncing', progress: { verb: 'upload', done: 2, total: 9, left: 64 * 1024 * 1024 } }, at), 'Uploading 3 of 9 items · 64 MB left');
  assert.equal(statusLine({ ...base, waiting: 4 }, at), '4 changes waiting to sync');
  assert.equal(statusLine({ ...base, state: 'offline', waiting: 4 }, at), 'Offline · 4 changes waiting to sync');
  assert.equal(statusLine({ ...base, state: 'offline', waiting: 1 }, at), 'Offline · 1 change waiting to sync');
  assert.equal(statusLine({ ...base, paused: { reason: 'passcode' } }, at), 'Paused — your passcode wasn’t accepted. Re-enter it under General.');
  assert.match(statusLine({ ...base, paused: { reason: 'lockout', until: at + 15 * MIN } }, at), /^Paused — too many wrong passcodes from this network\. Trying again at \d{1,2}:\d{2}/);
  assert.equal(statusLine({ ...base, paused: { reason: 'unconfigured' } }, at), 'Sync isn’t set up on the server yet.');
  assert.equal(statusLine({ ...base, paused: { reason: 'disabled' } }, at), 'Sync is switched off on the server.');
  assert.equal(statusLine({ ...base, paused: { reason: 'upgrade' } }, at), 'Update Atelier on this device to keep syncing.');
  assert.equal(statusLine({ ...base, quotaFull: true, server: { quota: 53687091200 } }, at), 'Server storage limit reached (50 GB). New media stays on this device.');
  assert.equal(countsLine({ on: true, synced: 148, server: { bytes: 1.2 * 1024 ** 3 }, waiting: 3, tooLarge: 1, quarantined: 1, heldMedia: 2, media: { image: false, video: false } }),
    '148 threads synced · 1.2 GB on your server · 3 waiting to sync · 1 thread too large to sync stays on this device · 1 item couldn’t be applied and was set aside · Images and videos stay on this device until the next update');
  assert.equal(countsLine({ on: true, synced: 1, heldMedia: 1, media: { image: true, video: true } }), '1 thread synced');
  assert.equal(countsLine({ on: false, synced: 3 }), '');
  assert.deepEqual([sizeText(0), sizeText(2048), sizeText(340 * 1024 * 1024), agoText(at - 3 * 3_600_000, at)], ['0 bytes', '2 KB', '340 MB', '3 h ago']);
  assert.equal(forkNote({ forkOf: 'e1' }), 'Edited on two devices at the same time — both versions are kept.');
  assert.equal(forkNote({ forkOf: 'e1', recovered: true }), 'From an interrupted retry — the saved answer is just above.');
  assert.equal(forkNote({}), '');
});

// ── turning on ──
test('a verified owner without tester traces turns sync on, and two devices converge (long text travels as a blob)', async () => {
  const w = world();
  const pc = device(w, 'pc'), phone = device(w, 'phone');
  const html = `<!doctype html><title>x</title>${'<p>app</p>'.repeat(11_000)}`; // ~110 KB: a Build app
  await pc.db.put(thread('t1', [ask('e1', T0), { id: 'e2', kind: 'build', prompt: 'make an app', createdAt: T0 + 1, app: { title: 'App', html } }], { title: 'Plans' }));
  await pc.db.put(thread('t2', [ask('e3', T0 + 5)]));
  await online(pc);
  assert.equal(pc.engine.config().enabled, true);
  assert.equal(pc.engine.config().mode, 'all');
  assert.ok(pc.toasts.includes(COPY.firstEnable));
  assert.ok(pc.toasts.includes(COPY.firstDone));
  assert.equal(w.r2.keys('b/').length, 1, 'the app html went up once as a text blob');
  assert.equal(w.doc('t1').entries[1].d.app.html.$b.length, 64);
  await online(phone);
  assert.deepEqual(phone.toasts, [COPY.firstEnable, COPY.firstDone], 'one first-run message, then done ("Bringing in…" isn’t stacked after it)');
  for (const id of ['t1', 't2']) assert.deepEqual(shape(phone.get(id)), shape(pc.get(id)), id);
  assert.equal(phone.get('t1').entries[1].app.html, html);
  assert.equal(phone.get('t1').title, 'Plans');
  const s = phone.engine.status();
  assert.equal(statusLine(s, w.clock.t), 'Up to date · synced just now');
  assert.equal(s.synced, 2);
  // nothing left to do: a second cycle pulls nothing and pushes nothing
  w.log.length = 0;
  await sync(pc); await sync(phone);
  assert.deepEqual(w.log.map((x) => `${x.method} ${x.path.replace(/\?.*/, '')}`).filter((x) => !/index|status/.test(x)), []);
  assert.ok(w.log.some((x) => x.path === 'index' && x.inm), 'the index is asked for with If-None-Match');
});

test('a browser with tester traces asks first; "only new threads" leaves old ones on the device', async () => {
  const w = world();
  const pc = device(w, 'pc', { traces: true });
  await pc.db.put(thread('old', [ask('o1', T0 - 10 * MIN)]));
  await pc.engine.verified();
  assert.deepEqual(pc.asked, [1], 'the dialog is asked for with the local thread count');
  assert.equal(w.log.length, 0, 'nothing is sent before the owner chooses');
  assert.equal(pc.engine.config(), null);
  await pc.engine.enable('new');
  await sync(pc);
  assert.equal(w.doc('old'), null, 'the old thread stays on this device');
  assert.equal(pc.engine.badge(pc.get('old')), ' · This device only');
  w.clock.t += 1000;
  await pc.put(thread('new', [ask('n1', w.clock.t)]));
  await sync(pc);
  assert.ok(w.doc('new'));
  assert.equal(pc.engine.badge(pc.get('new')), '');
  await pc.engine.uploadOlder();
  await sync(pc);
  assert.ok(w.doc('old'), 'Upload older threads too');
});

test('threads written in tester mode are marked localOnly and never upload', async () => {
  const w = world();
  const dev = device(w, 'pc');
  dev.tester = true;
  await dev.put(thread('mine', [ask('m1', T0)]));
  assert.equal(await dev.store.get('lo:mine'), 1);
  assert.equal(await dev.store.get('trace'), 1);
  await dev.engine.verified(); // not the owner: nothing
  assert.equal(w.log.length, 0);
  dev.tester = false; // the owner signs in on this browser later
  await dev.engine.verified();
  assert.deepEqual(dev.asked, [1], 'the tester trace makes it ask');
  await dev.engine.enable('all');
  await sync(dev);
  assert.equal(w.doc('mine'), null, 'a tester-mode thread never uploads, even in mode all');
  assert.equal(dev.engine.badge('mine'), ' · This device only');
});

// ── stop conditions ──
test('the first 401 pauses sync: no retries until the passcode is proven again', async () => {
  const w = world();
  const dev = device(w, 'pc');
  await dev.db.put(thread('t1', [ask('e1', T0)]));
  await online(dev);
  dev.pass = 'stale';
  w.log.length = 0;
  await dev.put(thread('t1', [ask('e1', T0, 'changed')]));
  await sync(dev);
  assert.equal(w.log.length, 1, 'exactly one request with the stale passcode');
  assert.equal(w.log[0].status, undefined);
  assert.equal(dev.engine.status().paused.reason, 'passcode');
  assert.equal(statusLine(dev.engine.status()), COPY.passcode);
  for (const r of ['visible', 'online', 'drawer', 'now', 'settled']) dev.engine.kick(r);
  await sync(dev);
  assert.equal(w.log.length, 1, 'nothing retries while paused');
  dev.pass = 'pw';
  await dev.engine.verified(); // after pullMe proved the passcode
  await tick(); await sync(dev);
  assert.equal(dev.engine.status().paused, null);
  assert.equal(w.doc('t1').entries[0].d.text, 'changed');
});

test('429 pauses until the lockout ends; 503 sync_unconfigured pauses with one request; Sync now retries', async () => {
  const w = world();
  const dev = device(w, 'pc');
  dev.before = (x) => (dev.lock ? new Response('{"error":"Too many attempts"}', { status: 429 }) : null);
  dev.lock = true;
  await dev.engine.verified(); await tick(); await sync(dev);
  assert.equal(w.log.length, 1);
  const p = dev.engine.status().paused;
  assert.equal(p.reason, 'lockout');
  assert.equal(p.until, w.clock.t + SYNC_CLIENT.lockoutMs);
  dev.lock = false;
  await sync(dev);
  assert.equal(w.log.length, 1, 'still locked out');
  w.clock.t += SYNC_CLIENT.lockoutMs + 1;
  await sync(dev);
  assert.equal(dev.engine.status().paused, null);
  assert.ok(w.log.length > 1);

  const w2 = world({ bucket: false });
  const d2 = device(w2, 'pc');
  await d2.engine.verified(); await tick(); await sync(d2);
  assert.equal(w2.log.length, 1);
  assert.equal(statusLine(d2.engine.status()), 'Sync isn’t set up on the server yet.');
  await sync(d2);
  assert.equal(w2.log.length, 1, 'no retry loop');
  d2.engine.kick('now');
  await tick(); await sync(d2);
  assert.equal(w2.log.length, 2, 'Sync now tries once more');
});

// ── outbox and never-push rules ──
test('the dirty marker is the outbox: cleared after a push, kept when a newer write landed meanwhile', async () => {
  const w = world();
  const dev = device(w, 'pc');
  await dev.db.put(thread('t1', [ask('e1', T0)]));
  await online(dev);
  assert.equal(await dev.store.get('d:t1'), undefined);
  // a write lands while the push is on the wire
  let once = true;
  dev.before = async (x) => {
    if (once && x.method === 'POST') { once = false; await dev.put({ ...dev.get('t1'), entries: [ask('e1', T0, 'v2'), ask('e2', T0 + 1)] }); }
    return null;
  };
  await dev.put({ ...dev.get('t1'), entries: [ask('e1', T0, 'v2')] });
  const stamp = await dev.store.get('d:t1');
  await dev.engine.run({ pull: false });
  const after = await dev.store.get('d:t1');
  assert.ok(after === undefined || after !== stamp);
  await sync(dev);
  assert.equal(await dev.store.get('d:t1'), undefined);
  assert.deepEqual(w.doc('t1').entries.map((e) => e.id), ['e1', 'e2']);
});

test('pending, run-locked and refused entries are never pushed; they go once settled', async () => {
  const w = world();
  const dev = device(w, 'pc');
  await online(dev);
  await dev.put(thread('t1', [ask('e1', T0), ask('e2', T0 + 1, '', { pending: true, stage: 'x' })]));
  const release = dev.engine.holdRunLock('e3');
  await dev.put({ ...dev.get('t1'), entries: [...dev.get('t1').entries, ask('e3', T0 + 2, 'Interrupted', { recovered: true })] });
  await sync(dev);
  assert.deepEqual(w.doc('t1').entries.map((e) => e.id), ['e1'], 'only the settled, unlocked entry');
  for (const b of posts(w, dev)) for (const e of b.entries) assert.ok(!('pending' in e.d) && !('recovered' in e.d) && !('stage' in e.d));
  // the run settles: pending cleared, lock released → both go up
  const t = dev.get('t1');
  t.entries[1] = ask('e2', T0 + 1, 'done');
  t.entries[2] = ask('e3', T0 + 2, 'finished answer');
  release();
  await dev.put(t);
  dev.engine.kick('settled');
  await tick(); await sync(dev);
  assert.deepEqual(w.doc('t1').entries.map((e) => [e.id, e.d.text]), [['e1', 'answer e1'], ['e2', 'done'], ['e3', 'finished answer']]);
  assert.equal(w.requests(dev).filter((x) => x.status === 422 || x.status === 400).length, 0);
});

test('a recovered entry never overwrites the synced answer: the server copy comes back, partial work forks', async () => {
  const w = world();
  const pc = device(w, 'pc'), phone = device(w, 'phone');
  await pc.db.put(thread('t1', [ask('e1', T0, 'the good answer'), ask('e2', T0 + 1, 'other')]));
  await online(pc); await online(phone);
  // the phone was killed mid-Retry of e1 and e2: recoverThread marks them recovered
  const t = phone.get('t1');
  t.entries[0] = { ...ask('e1', T0, 'half an ans'), recovered: true, error: 'This response was interrupted…' };
  t.entries[1] = { ...ask('e2', T0 + 1, ''), recovered: true, error: 'Interrupted' };
  await phone.put(t);
  await sync(phone); await sync(pc);
  assert.equal(w.doc('t1').entries.find((e) => e.id === 'e1').d.text, 'the good answer');
  const got = phone.get('t1').entries;
  assert.deepEqual(got.map((e) => e.text), ['the good answer', 'half an ans', 'other']);
  assert.equal(got[1].forkOf, 'e1');
  assert.equal(got[1].recovered, true, 'the fork keeps its note locally');
  assert.ok(!('recovered' in got[0]) && !got[0].error);
  assert.deepEqual(shape(pc.get('t1')), shape(phone.get('t1')));
  // a never-synced recovered entry IS pushed: it is the only copy of the prompt
  await phone.put(thread('t2', [{ ...ask('n1', T0 + 9, ''), recovered: true, error: 'Interrupted' }]));
  await sync(phone);
  assert.equal(w.doc('t2').entries[0].id, 'n1');
});

test('a pulled entry that fails validateBackup is quarantined, never applied, and the toast comes once', async () => {
  const w = world();
  const pc = device(w, 'pc'), phone = device(w, 'phone');
  await pc.db.put(thread('t1', [ask('e1', T0)]));
  await online(pc);
  // something wrote an entry the app can't render (kind 'bogus'): the server's shape checks let it through
  const d1 = { id: 'bad1', kind: 'bogus', prompt: 'x', createdAt: T0 + 1 }, d2 = { id: 'bad2', kind: 'ask', prompt: 7, createdAt: T0 + 2 };
  const body = { v: 1, createdAt: T0, entries: [{ id: 'bad1', base: 0, createdAt: T0 + 1, h: await entryHash(d1), d: d1 }, { id: 'bad2', base: 0, createdAt: T0 + 2, h: await entryHash(d2), d: d2 }] };
  const r = await w.fetchFor({ name: 'x' })('/api/sync/thread/t1', { method: 'POST', headers: { 'x-app-pass': 'pw', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(r.status, 200);
  await online(phone);
  assert.deepEqual(phone.get('t1').entries.map((e) => e.id), ['e1']);
  assert.equal((await phone.store.entries('q:')).length, 2);
  assert.equal(phone.toasts.filter((m) => m === COPY.quarantine).length, 1);
  assert.match(countsLine(phone.engine.status()), /2 items couldn’t be applied and were set aside/);
  w.log.length = 0;
  await sync(phone); await sync(phone);
  assert.equal(phone.toasts.filter((m) => m === COPY.quarantine).length, 1);
  assert.ok(w.log.filter((x) => x.path.startsWith('thread/')).length <= 1, 'a quarantined version is not fetched over and over');
});

// ── server loss, deletes, trash ──
test('a thread the server lost is pushed again, never deleted locally', async () => {
  const w = world();
  const pc = device(w, 'pc');
  await pc.db.put(thread('t1', [ask('e1', T0), ask('e2', T0 + 1)], { title: 'Keep me' }));
  await online(pc);
  await w.r2.delete('t/t1.json');
  await sync(pc);
  assert.deepEqual(w.doc('t1').entries.map((e) => e.id), ['e1', 'e2']);
  assert.equal(w.doc('t1').title, 'Keep me');
  assert.deepEqual(pc.db.removed, []);
  // and an entry the server lost (a rolled-back document: same rev, new etag) comes back too
  const doc = w.doc('t1');
  doc.entries = doc.entries.slice(0, 1);
  await w.r2.put('t/t1.json', JSON.stringify(doc), { customMetadata: { v: '1', rev: String(doc.rev), at: String(doc.changedAt), del: '0', n: '1', snap: '0' } });
  await sync(pc);
  assert.deepEqual(w.doc('t1').entries.map((e) => e.id), ['e1', 'e2']);
  assert.equal(pc.get('t1').entries.length, 2);
});

test('delete everywhere: the open thread closes on the other device, Recently deleted lists it and Restore brings it back', async () => {
  const w = world();
  const pc = device(w, 'pc'), phone = device(w, 'phone');
  await pc.db.put(thread('t1', [ask('e1', T0), ask('e2', T0 + 1)], { title: 'Doomed' }));
  await online(pc); await online(phone);
  phone.open = structuredClone(phone.get('t1'));
  assert.match(await pc.engine.deleteCopy('t1'), /^Delete this thread from all your devices\?/);
  await pc.engine.deleteThread('t1');
  assert.equal(pc.get('t1'), undefined);
  await sync(pc);
  const sent = w.requests(pc).find((x) => x.method === 'DELETE');
  assert.deepEqual(JSON.parse(sent.body).seen, { e1: 1, e2: 1 });
  assert.ok(w.doc('t1').deletedAt);
  await sync(phone);
  assert.equal(phone.get('t1'), undefined);
  assert.ok(phone.applied.some((x) => x.open?.closed));
  assert.ok(phone.toasts.includes(COPY.openDeleted));
  phone.open = null;
  const { items } = await phone.engine.trash();
  assert.equal(items.length, 1);
  assert.deepEqual([items[0].id, items[0].title, items[0].n], ['t1', 'Doomed', 2]);
  const r = await phone.engine.restore(items[0].key);
  assert.equal(r.title, 'Doomed');
  await sync(phone); await sync(pc);
  for (const d of [pc, phone]) assert.deepEqual(d.get('t1')?.entries.map((e) => e.id), ['e1', 'e2'], d.name);
  assert.equal(pc.get('t1').title, 'Doomed');
  assert.equal((await pc.engine.trash()).items.length, 0);
});

test('a delete keeps what changed elsewhere after the deleter looked, and says so', async () => {
  const w = world();
  const pc = device(w, 'pc'), phone = device(w, 'phone');
  await pc.db.put(thread('t1', [ask('e1', T0), ask('e2', T0 + 1)], { title: 'Plans' }));
  await online(pc); await online(phone);
  const t = phone.get('t1');
  t.entries[1].text = 'phone kept working';
  await phone.put(t);
  await sync(phone);
  await pc.engine.deleteThread('t1');
  await sync(pc);
  assert.ok(pc.toasts.includes('Part of “Plans” changed on another device after you deleted it, so that part was kept.'));
  assert.deepEqual(pc.get('t1').entries.map((e) => e.text), ['phone kept working']);
  await sync(phone);
  assert.deepEqual(shape(phone.get('t1')), shape(pc.get('t1')));
});

test('offline: the delete happens now, is sent on reconnect, and a stale tab putting it back is undone', async () => {
  const w = world();
  const pc = device(w, 'pc');
  await pc.db.put(thread('t1', [ask('e1', T0)]));
  await online(pc);
  const copy = structuredClone(pc.get('t1'));
  pc.offline = true;
  await pc.engine.deleteThread('t1');
  assert.equal(pc.engine.badge('t1'), ' · Deleting…');
  assert.match(statusLine(pc.engine.status()), /^Offline · 1 change waiting to sync$/);
  pc.offline = false;
  await sync(pc);
  assert.ok(w.doc('t1').deletedAt);
  await pc.put(copy); // an old tab writes its copy back
  await sync(pc);
  assert.equal(pc.get('t1'), undefined, 'removed again: it holds nothing new');
  assert.ok(w.doc('t1').deletedAt);
  // …but new work added to a deleted thread revives it
  await pc.put({ ...copy, entries: [...copy.entries, ask('e9', T0 + 9, 'new work')] });
  await sync(pc); await sync(pc);
  assert.deepEqual(w.doc('t1').entries.map((e) => e.id), ['e9']);
  assert.equal(w.doc('t1').deletedAt, null);
  assert.deepEqual(pc.get('t1').entries.map((e) => e.id), ['e9']);
});

// ── merging into the open thread, deferral, tabs ──
test('the open thread is merged in place: same object, new entries spliced in, onApplied told', async () => {
  const w = world();
  const pc = device(w, 'pc'), phone = device(w, 'phone');
  await pc.db.put(thread('t1', [ask('e1', T0), ask('e3', T0 + 3)]));
  await online(pc); await online(phone);
  const open = structuredClone(phone.get('t1'));
  const first = open.entries[0];
  phone.open = open;
  const t = pc.get('t1');
  t.entries.splice(1, 0, ask('e2', T0 + 2, 'from the pc'));
  t.entries[0].text = 'edited on the pc';
  await pc.put(t);
  await sync(pc); await sync(phone);
  assert.equal(phone.open, open);
  assert.equal(open.entries[0], first, 'replaced entries keep their object');
  assert.deepEqual(open.entries.map((e) => e.text), ['edited on the pc', 'from the pc', 'answer e3']);
  const last = phone.applied.at(-1);
  assert.deepEqual([last.open.added, last.open.replaced], [['e2'], ['e1']]);
  assert.deepEqual(shape(phone.get('t1')), shape(open), 'and written through');
});

test('a generating thread is not touched until its run settles', async () => {
  const w = world();
  const pc = device(w, 'pc'), phone = device(w, 'phone');
  await pc.db.put(thread('t1', [ask('e1', T0)]));
  await online(pc); await online(phone);
  const open = structuredClone(phone.get('t1'));
  open.entries.push(ask('p1', T0 + 5, '', { pending: true }));
  phone.open = open; phone.live.add('t1');
  const t = pc.get('t1'); t.entries[0].text = 'pc edit'; await pc.put(t);
  await sync(pc); await sync(phone);
  assert.equal(open.entries[0].text, 'answer e1', 'deferred');
  open.entries[1] = ask('p1', T0 + 5, 'settled');
  phone.live.delete('t1');
  await phone.put(open);
  phone.engine.kick('settled');
  await tick(); await sync(phone);
  assert.deepEqual(open.entries.map((e) => e.text), ['pc edit', 'settled']);
  assert.deepEqual(w.doc('t1').entries.map((e) => e.d.text), ['pc edit', 'settled']);
});

test('two tabs: only the leader talks to the server; a follower’s open thread is refreshed in place', async () => {
  const w = world();
  const db = memDb(), store = memoryStore(), locks = fakeLocks(), port = bus();
  const tab1 = device(w, 'tab1', { db, store, locks, channel: port() });
  const tab2 = device(w, 'tab2', { db, store, locks, channel: port() });
  const pc = device(w, 'pc');
  await db.put(thread('t1', [ask('e1', T0)]));
  await tab1.engine.verified(); await tick();
  await tab2.engine.verified(); await tick();
  await sync(tab1);
  assert.equal(tab1.engine.isLeader(), true);
  assert.equal(tab2.engine.isLeader(), false);
  const open = structuredClone(db.m.get('t1'));
  tab2.open = open;
  await online(pc);
  const t = pc.get('t1'); t.entries.push(ask('e2', T0 + 1, 'from the pc')); await pc.put(t);
  await sync(pc);
  await sync(tab1); await tick(); await tick();
  assert.deepEqual(open.entries.map((e) => e.id), ['e1', 'e2'], 'patched from what the leader wrote');
  assert.ok(tab2.applied.some((x) => x.open?.added?.includes('e2')));
  // a write in the follower tab is pushed by the leader
  open.entries.push(ask('e3', T0 + 2, 'typed in tab 2'));
  await tab2.put(open);
  await tick();
  await sync(tab1);
  assert.deepEqual(w.doc('t1').entries.map((e) => e.id), ['e1', 'e2', 'e3']);
  assert.equal(w.requests(tab2).length, 0, 'the follower never fetched');
  // the leader goes away: the follower takes over
  tab1.engine.stop();
  await tick(); await tick();
  assert.equal(tab2.engine.isLeader(), true);
});

test('pendingCount, hidden flush with keepalive, debounced push and forget()', async () => {
  const w = world();
  const timers = [];
  const dev = device(w, 'pc', { timers: { setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: (i) => { if (timers[i - 1]) timers[i - 1].fn = null; } } });
  await dev.db.put(thread('t1', [ask('e1', T0)]));
  await online(dev);
  dev.offline = true;
  await dev.put({ ...dev.get('t1'), entries: [ask('e1', T0, 'edit'), ask('e2', T0 + 1)] });
  assert.equal(await dev.engine.pendingCount(), 2, 'two entries waiting');
  assert.ok(timers.some((x) => x.fn && x.ms === SYNC_CLIENT.pushDebounceMs), 'a push is scheduled 3 s after the write');
  dev.offline = false;
  dev.hiddenTab = true; // visibilitychange → hidden: persist(true), then flush()
  w.log.length = 0;
  await dev.engine.flush();
  assert.ok(w.log.some((x) => x.method === 'POST' && x.keepalive), 'a small delta goes with keepalive');
  assert.equal(await dev.engine.pendingCount(), 0);
  await dev.engine.forget();
  assert.equal(dev.store.map.size, 0);
  assert.equal(dev.engine.on(), false);
});

test('patchInPlace inserts after the nearest neighbour, skips pending entries and keeps transient keys', () => {
  const target = { title: 'a', updatedAt: 1, entries: [ask('e1', 1), { ...ask('e3', 3), pending: true }, ask('e4', 4, 'x', { stage: 's' })] };
  const source = { title: 'b', updatedAt: 9, entries: [ask('e1', 1, 'new'), ask('e2', 2), ask('e3', 3, 'remote'), ask('e4', 4, 'y')] };
  const info = patchInPlace(target, source, ['e1', 'e2', 'e3', 'e4'], [], { title: true });
  assert.deepEqual(target.entries.map((e) => e.id), ['e1', 'e2', 'e3', 'e4']);
  assert.deepEqual(info, { replaced: ['e1', 'e4'], added: ['e2'], removed: [], skipped: [], closed: false });
  assert.equal(target.entries[2].text, 'answer e3', 'pending untouched');
  assert.equal(target.entries[3].stage, 's');
  assert.deepEqual([target.title, target.updatedAt], ['b', 9]);
});

test('patchInPlace leaves an entry the user changed after the merge was planned (and reports it), but applies the rest', () => {
  const before = { e1: ask('e1', 1, 'old 1'), e2: ask('e2', 2, 'old 2'), e3: ask('e3', 3, 'old 3') };
  const prints = Object.fromEntries(Object.entries(before).map(([k, v]) => [k, quickPrint(v)]));
  // the open copy: e1 untouched, e2 retried by the user meanwhile, e3 already the merged version
  const target = { title: 't', entries: [structuredClone(before.e1), ask('e2', 2, 'user retry'), ask('e3', 3, 'new 3')] };
  const source = { title: 't', entries: [ask('e1', 1, 'new 1'), ask('e2', 2, 'new 2'), ask('e3', 3, 'new 3')] };
  const info = patchInPlace(target, source, ['e1', 'e2', 'e3'], [], { prints });
  assert.deepEqual(target.entries.map((e) => e.text), ['new 1', 'user retry', 'new 3']);
  assert.deepEqual([info.replaced, info.skipped], [['e1', 'e3'], ['e2']]);
});

// ── review findings, one device (each failed before its fix) ──
test('review: a same-length edit of a long answer reaches the other device, both ways', async () => {
  const w = world();
  const pc = device(w, 'pc'), phone = device(w, 'phone');
  const long = (tag) => `Generated ${tag}${'y'.repeat(40_000)}`; // differs only at index 10: no sample ever saw it
  await pc.put(thread('t1', [ask('e1', T0, long('A'))]));
  await online(pc); await online(phone);
  assert.equal(phone.get('t1').entries[0].text, long('A'));
  const t = structuredClone(pc.get('t1')); t.entries[0].text = long('B'); w.clock.t += MIN; await pc.put(t);
  await sync(pc); await sync(phone);
  assert.equal(w.doc('t1').entries[0].d.text.$b, await sha256hex(long('B')), 'the server holds the new text');
  assert.equal(phone.get('t1').entries[0].text, long('B'), 'the phone got the new text, not the old one');
  // back the other way: the pc's local (older) string is never taken for the new blob
  const p = structuredClone(phone.get('t1')); p.entries[0].text = long('C'); w.clock.t += MIN; await phone.put(p);
  await sync(phone); await sync(pc);
  assert.equal(pc.get('t1').entries[0].text, long('C'));
  assert.deepEqual(shape(pc.get('t1')), shape(phone.get('t1')));
});

test('review: a conflicting server version this device rejects never makes forks multiply', async () => {
  const w = world();
  // the phone runs an older app: its validator rejects what the newer pc writes
  const strict = (data) => { for (const e of data.threads[0].entries) if (e.media?.some?.((m) => m.type === 'audio')) throw new Error('old validator'); return validateBackup(data); };
  const pc = device(w, 'pc'), phone = device(w, 'phone', { validate: strict });
  await pc.put(thread('t1', [ask('e1', T0)]));
  await online(pc); await online(phone);
  const t = structuredClone(pc.get('t1')); t.entries[0].media = [{ type: 'audio', src: 'x' }]; w.clock.t += 1000; await pc.put(t); await sync(pc);
  phone.offline = true;
  const p = structuredClone(phone.get('t1')); p.entries[0].text = 'phone retry'; w.clock.t += 1000; await phone.put(p);
  phone.offline = false;
  for (let i = 0; i < 4; i++) { w.clock.t += 61_000; await sync(phone); }
  assert.deepEqual(phone.get('t1').entries.map((e) => [e.id, e.text]), [['e1', 'phone retry']], 'kept once, no forks');
  assert.equal(w.doc('t1').entries.length, 1, 'no forks on the server either');
  assert.equal((await phone.store.entries('q:')).length, 1);
  w.log.length = 0;
  await sync(phone); await sync(phone);
  assert.equal(w.requests(phone).filter((x) => x.method === 'POST').length, 0, 'and it stops asking');
});

test('review: a delete keeps what never reached the server restorable (offline edits, a never-synced thread)', async () => {
  const w = world();
  const pc = device(w, 'pc');
  await pc.put(thread('t1', [ask('e1', T0)], { title: 'Synced' }));
  await online(pc);
  pc.offline = true;
  const t = structuredClone(pc.get('t1')); t.entries.push(ask('e2', T0 + 5000, 'offline work')); await pc.put(t);
  assert.equal(await pc.engine.deleteCopy('t1'), COPY.deleteConfirm);
  await pc.engine.deleteThread('t1');
  await pc.put(thread('t2', [ask('n1', T0 + 9000, 'never synced')], { title: 'Draft' }));
  assert.equal(await pc.engine.deleteCopy('t2'), COPY.deleteConfirm);
  await pc.engine.deleteThread('t2');
  assert.deepEqual([pc.get('t1'), pc.get('t2')], [undefined, undefined]);
  pc.offline = false;
  await sync(pc);
  assert.ok(w.doc('t1').deletedAt && w.doc('t2').deletedAt, 'both deleted on the server');
  const { items } = await pc.engine.trash();
  assert.deepEqual(items.map((x) => [x.id, x.title]).sort(), [['t1', 'Synced'], ['t2', 'Draft']]);
  for (const it of items) await pc.engine.restore(it.key);
  await sync(pc);
  assert.deepEqual(pc.get('t1').entries.map((e) => e.text), ['answer e1', 'offline work'], 'the offline entry came back');
  assert.deepEqual(pc.get('t2').entries.map((e) => e.text), ['never synced']);
  assert.ok(!pc.toasts.some((m) => m.startsWith('Part of')));
  // a thread that can never reach the server: the confirm says so
  pc.tester = true; await pc.put(thread('t3', [ask('x1', T0 + 20_000)])); pc.tester = false;
  assert.equal(await pc.engine.deleteCopy('t3'), COPY.deleteLocal);
});

test('review: a delete made offline after a lost push answer covers that push (no resurrection, no false toast)', async () => {
  const w = world();
  const pc = device(w, 'pc');
  await pc.engine.verified(); await tick();
  await pc.put(thread('t1', [ask('e1', T0)]));
  let drop = true;
  pc.before = async (x) => {
    if (!drop || x.method !== 'POST' || !x.path.startsWith('thread/')) return null;
    const u = new URL(`https://atelier.test/api/sync/${x.path}`);
    await handleSync(workerRequest(u, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(x.body)) }, body: x.body }), w.env, u, `sync/${x.path}`);
    throw new TypeError('network connection lost'); // stored on the server, answer lost
  };
  await push(pc);
  drop = false;
  assert.ok(w.doc('t1'), 'the push landed');
  pc.offline = true;
  await pc.engine.deleteThread('t1');
  pc.offline = false;
  await sync(pc); await sync(pc);
  assert.equal(pc.get('t1'), undefined);
  assert.ok(w.doc('t1').deletedAt);
  assert.ok(!pc.toasts.some((m) => m.startsWith('Part of')), pc.toasts.join(' / '));
});

test('review: a push-only run after the server re-created a thread never overwrites another device’s concurrent edit', async () => {
  const w = world();
  const pc = device(w, 'pc'), phone = device(w, 'phone');
  await pc.put(thread('t1', [ask('e1', T0, 'v0')]));
  await online(pc); await online(phone);
  await w.r2.delete('t/t1.json'); // the server loses the document
  w.clock.t += 2000;
  const t = structuredClone(pc.get('t1')); t.entries[0].text = 'pc edit'; await pc.put(t); await push(pc);
  assert.deepEqual([w.doc('t1').entries[0].d.text, w.doc('t1').entries[0].rev], ['pc edit', 1], 're-created: a new lineage at rev 1');
  const p = structuredClone(phone.get('t1')); p.entries[0].text = 'phone edit'; w.clock.t += 1000; await phone.put(p);
  await push(phone); // push-only: its record still holds e1 at r = 1 of the OLD lineage
  assert.ok(posts(w, phone).at(-1)?.born > 0, 'the body says which lineage its bases belong to');
  assert.equal(w.doc('t1').entries.find((e) => e.id === 'e1').d.text, 'pc edit', 'not replaced');
  await sync(phone); await sync(pc); await sync(phone);
  const texts = new Set([...pc.get('t1').entries, ...phone.get('t1').entries].map((e) => e.text));
  assert.ok(texts.has('pc edit') && texts.has('phone edit'), [...texts].join(' | '));
  assert.deepEqual(shape(pc.get('t1')), shape(phone.get('t1')));
});

test('review: a push answer for a generating thread waits for the run, so the run’s own save can’t erase a fork', async () => {
  const w = world();
  const pc = device(w, 'pc'), phone = device(w, 'phone');
  await pc.put(thread('t1', [ask('e1', T0, 'v0')]));
  await online(pc); await online(phone);
  const ph = structuredClone(phone.get('t1')); ph.entries[0].text = 'phone edit'; w.clock.t += 1000; await phone.put(ph); await sync(phone);
  // the pc, offline, retries e1, then sends e2 and moves to another thread while e2 generates
  pc.offline = true;
  const live = structuredClone(pc.get('t1')); // app.js liveThreads' object for t1 (not the open thread)
  live.entries[0].text = 'pc edit'; await pc.put(live);
  live.entries.push({ ...ask('e2', T0 + 10, ''), pending: true }); await pc.put(live); pc.live.add('t1');
  pc.offline = false;
  pc.hiddenTab = true;
  await pc.engine.flush(); // a hidden flush: one pass, then the page sleeps
  assert.equal(pc.get('t1').entries.length, 2, 'nothing was merged into the generating thread');
  // e2 settles: run() finally saves its own object
  pc.live.delete('t1'); pc.hiddenTab = false;
  live.entries[1] = ask('e2', T0 + 10, 'e2 answer');
  await pc.put(live);
  pc.engine.kick('settled');
  for (let i = 0; i < 3; i++) { w.clock.t += 61_000; await sync(pc); await sync(phone); }
  const all = [...pc.get('t1').entries, ...phone.get('t1').entries, ...w.doc('t1').entries.map((e) => e.d)].map((e) => e.text);
  assert.ok(all.includes('pc edit') && all.includes('phone edit') && all.includes('e2 answer'), [...new Set(all)].join(' | '));
  assert.deepEqual(shape(pc.get('t1')), shape(phone.get('t1')));
});

test('review: "Remove synced threads" keeps every thread holding something only this device has', async () => {
  const w = world();
  const pc = device(w, 'pc', { engine: { media: { image: false, video: false } } }); // a device still on phase 1 (its media stays here)
  const img = `data:image/png;base64,${Buffer.from('fake png bytes').toString('base64')}`;
  await pc.put(thread('t1', [ask('e1', T0, 'text answer'), { ...ask('e2', T0 + 1, ''), kind: 'image', images: [img] }]));
  await pc.put(thread('t2', [ask('e3', T0 + 2)]));
  await pc.put(thread('t3', [ask('e4', T0 + 3)]));
  await online(pc);
  assert.equal(w.doc('t1').entries.length, 1, 'phase 1: the image entry stays on the device');
  pc.offline = true;
  const t3 = structuredClone(pc.get('t3')); t3.entries.push(ask('e5', T0 + 4, 'not synced yet')); await pc.put(t3);
  assert.equal(await pc.engine.removeSynced().then((r) => JSON.stringify(r)), JSON.stringify({ removed: 1, kept: 2 }));
  assert.ok(pc.get('t1')?.entries.some((e) => e.id === 'e2'), 'the image is still here');
  assert.ok(pc.get('t3')?.entries.some((e) => e.id === 'e5'), 'so is the unsynced turn');
  assert.equal(pc.get('t2'), undefined, 'the fully synced thread went');
  assert.ok(w.doc('t2'), 'and stays on the server');
});

test('review: tester-only marks in local threads count as tester traces; the Settings switch asks first too', async () => {
  const w = world();
  const pc = device(w, 'pc');
  await pc.db.put(thread('t1', [ask('e1', T0, 'a reply cut at the tester cap', { cut: 'cap' })]));
  await pc.engine.verified();
  assert.deepEqual(pc.asked, [1], 'the first-sync question instead of auto-enable');
  assert.equal(pc.engine.config(), null);
  assert.equal(w.log.length, 0);
  // the switch: the engine's own trace key is enough (e.g. a tester signed out on this browser earlier)
  const pc2 = device(w, 'pc2');
  await pc2.store.set('trace', 1);
  await pc2.db.put(thread('t2', [ask('e2', T0)]));
  assert.equal(await pc2.engine.turnOn(), 'ask');
  assert.deepEqual([pc2.asked, pc2.engine.config()], [[1], null]);
  const pc3 = device(w, 'pc3');
  await pc3.db.put(thread('t3', [ask('e3', T0, 'ok', { budget: undefined })]));
  assert.equal(await pc3.engine.turnOn(), 'on', 'no traces: the switch turns it on');
  assert.equal(pc3.engine.config().mode, 'all');
});

// Found by the overlap-mode simulation (seed 144; it also failed on the pre-review code): a deleted thread whose
// tombstone the server lost had its whole record dropped, so after another device re-created the thread, a stale tab's
// old copy looked like a new edit and replaced the newer answer.
test('a deleted thread whose tombstone the server lost keeps its history: a stale copy never overwrites a re-created thread', async () => {
  const w = world();
  const pc = device(w, 'pc'), phone = device(w, 'phone');
  await pc.put(thread('t1', [ask('e1', T0, 'v1')]));
  await online(pc); await online(phone);
  const stale = structuredClone(pc.get('t1'));
  await pc.engine.deleteThread('t1'); await sync(pc);
  assert.ok(w.doc('t1').deletedAt);
  await w.r2.delete('t/t1.json'); // the server loses the tombstone
  w.clock.t += MIN; await sync(pc); // pc sees it gone
  assert.ok(pc.engine.record('t1'), 'the record (and its history) stays');
  // the phone hadn't pulled the delete: its retry re-creates the thread
  const p = structuredClone(phone.get('t1')); p.entries[0].text = 'v2'; w.clock.t += 1000; await phone.put(p); await push(phone);
  assert.equal(w.doc('t1').entries[0].d.text, 'v2');
  w.clock.t += MIN; await sync(pc);
  assert.equal(pc.get('t1')?.entries[0].text, 'v2', 'the re-created thread came back to the pc');
  await pc.put(structuredClone(stale)); // an old tab writes its copy back
  w.clock.t += MIN; await sync(pc); await sync(phone); await sync(pc);
  assert.equal(w.doc('t1').entries.find((e) => e.id === 'e1').d.text, 'v2', 'never replaced by the stale copy');
  assert.deepEqual([pc.get('t1').entries.map((e) => e.text), phone.get('t1').entries.map((e) => e.text)], [['v2'], ['v2']]);
});

// Found by the overlap-mode simulation (seed 289) in the R3 fix itself: a delete made while this device's push of an
// edit was on the wire, where that push conflicted with another device's newer edit. The push answer moved the record
// to the other device's revision; the kept copy then went up on that base and replaced the other device's answer.
test('a delete’s kept entries go up on the base they had when the delete was made (a concurrent edit is never replaced)', async () => {
  const w = world();
  const pc = device(w, 'pc'), phone = device(w, 'phone');
  await pc.put(thread('t1', [ask('e1', T0, 'v1')], { title: 'Plans' }));
  await online(pc); await online(phone);
  const t = structuredClone(pc.get('t1')); t.entries[0].text = 'v2'; w.clock.t += 1000; await pc.put(t); await sync(pc);
  // the phone, not having pulled v2, edits e1 too; its push is on the wire when the owner deletes the thread there
  let release, held = false;
  const gate = new Promise((r) => { release = r; });
  phone.before = async (x) => { if (x.method === 'POST' && x.path === 'thread/t1') { phone.before = null; held = true; await gate; } return null; };
  const p = structuredClone(phone.get('t1')); p.entries[0].text = 'v3'; w.clock.t += 1000; await phone.put(p);
  const running = push(phone);
  assert.ok(await until(() => held), 'the push is on the wire');
  await phone.engine.deleteThread('t1');
  release(); await running;
  w.clock.t += MIN; await sync(phone); await sync(pc);
  const trashed = w.r2.keys('x/').flatMap((k) => w.r2.json(k).entries.map((e) => e.d.text));
  const onServer = w.doc('t1').entries.map((e) => e.d.text);
  assert.ok(onServer.includes('v2'), `the other device's answer survives (server: ${onServer.join(', ')})`);
  assert.ok(trashed.includes('v3') || onServer.includes('v3'), 'and so does the phone’s');
  assert.ok(phone.toasts.some((m) => m.startsWith('Part of “Plans” changed on another device')), 'the phone is told the newer part was kept');
});

// Found by the overlap-mode simulation (seed 565; the logic predates the review): a stale tab wrote back a copy holding
// only entries deleted everywhere, the next pull was a delta (a rename) that removed them, and the emptied copy was
// taken for a deleted thread — so this device never got the live thread back.
test('a stale copy holding only entries deleted everywhere never makes a live thread look deleted here', async () => {
  const w = world();
  const pc = device(w, 'pc'), phone = device(w, 'phone');
  await pc.put(thread('t1', [ask('e1', T0), ask('e2', T0 + 1)], { title: 'Plans' }));
  await online(pc); await online(phone);
  const stale = structuredClone(pc.get('t1'));
  phone.offline = true;
  await pc.engine.deleteThread('t1'); await sync(pc); // e1, e2 deleted everywhere
  const p = structuredClone(phone.get('t1')); p.entries.push(ask('e3', T0 + 2, 'phone work')); await phone.put(p);
  phone.offline = false; await sync(phone); // revives the thread with e3
  w.clock.t += MIN; await sync(pc);
  assert.deepEqual(pc.get('t1')?.entries.map((e) => e.id), ['e3']);
  pc.offline = true;
  await pc.put(structuredClone(stale)); // an old tab writes back [e1, e2]
  const r = structuredClone(phone.get('t1')); r.title = 'Renamed'; w.clock.t += 1000; await phone.put(r); await sync(phone); // only the title changes
  pc.offline = false;
  w.clock.t += MIN; await sync(pc); await sync(pc);
  assert.deepEqual(pc.get('t1')?.entries.map((e) => e.id), ['e3'], 'the live thread is here, without the stale entries');
  assert.equal(pc.get('t1').title, 'Renamed');
  assert.equal(pc.engine.record('t1').deleted, undefined);
  assert.deepEqual(w.doc('t1').entries.map((e) => e.id), ['e3']);
});

// ── review findings, several tabs and the network (each failed before its fix) ──
async function bothUp(w, tab1, tab2, threads = [thread('t1', [ask('e1', T0)])]) {
  for (const t of threads) await tab1.db.put(t);
  await tab1.engine.verified(); await settle(tab1);
  await tab2.engine.verified(); await settle(tab1, tab2);
  await sync(tab1); await settle(tab1, tab2);
  assert.deepEqual([tab1.engine.isLeader(), tab2.engine.isLeader()], [true, false]);
}
const leaderOf = (...tabs) => tabs.find((t) => t.engine.isLeader());

test('review: settings are shared — off in any tab stops the leader; back on, sync resumes; Upload older works from a follower', async () => {
  const w = world();
  const [tab1, tab2] = twoTabs(w);
  await bothUp(w, tab1, tab2);
  await tab2.engine.disable(); await settle(tab1, tab2);
  assert.deepEqual([tab1.engine.isLeader(), tab2.engine.isLeader()], [false, false], 'the leader stopped and let the lock go');
  w.log.length = 0;
  await tab1.put({ ...tab1.db.m.get('t1'), entries: [ask('e1', T0), ask('e2', T0 + 1)] });
  await sync(tab1); await settle(tab1, tab2);
  assert.equal(w.log.length, 0, 'nothing is sent once switched off');
  assert.equal((await tab1.store.get('cfg')).enabled, false, 'and no tab writes "on" back');
  // on again (in the tab that was leading): exactly one tab leads, and the turn written while off goes up
  await tab1.engine.enable('all'); await settle(tab1, tab2);
  assert.equal([tab1, tab2].filter((t) => t.engine.isLeader()).length, 1);
  await sync(leaderOf(tab1, tab2)); await settle(tab1, tab2);
  assert.deepEqual(w.doc('t1').entries.map((e) => e.id), ['e1', 'e2']);
  // only new threads from now on, then "Upload older threads too" clicked in the follower
  await leaderOf(tab1, tab2).engine.disable(); await settle(tab1, tab2);
  await tab1.db.put(thread('old', [ask('o1', T0 - 10 * MIN)]));
  w.clock.t += MIN;
  await tab1.engine.enable('new'); await settle(tab1, tab2);
  const lead = leaderOf(tab1, tab2), follow = lead === tab1 ? tab2 : tab1;
  await sync(lead); await settle(tab1, tab2);
  assert.equal(w.doc('old'), null);
  await follow.engine.uploadOlder(); await settle(tab1, tab2);
  await sync(lead);
  assert.ok(w.doc('old'), 'the leader now uploads it');
  assert.equal((await tab1.store.get('cfg')).mode, 'all');
});

test('review: a passcode proven in any tab resumes the leader; one refused in a follower doesn’t pause a healthy leader', async () => {
  const w = world();
  const [tab1, tab2] = twoTabs(w);
  await bothUp(w, tab1, tab2);
  tab1.pass = 'stale';
  await tab1.put({ ...tab1.db.m.get('t1'), entries: [ask('e1', T0, 'edit')] });
  await sync(tab1); await settle(tab1, tab2);
  assert.equal(tab1.engine.status().paused?.reason, 'passcode');
  assert.equal(statusLine(tab2.engine.status(), w.clock.t), COPY.passcode, 'the follower shows the pause too');
  tab1.pass = 'pw'; // the owner re-entered it (every tab sends the stored passcode)
  await tab2.engine.verified(); await settle(tab1, tab2);
  await sync(tab1);
  assert.equal(tab1.engine.status().paused, null);
  assert.equal(w.doc('t1').entries[0].d.text, 'edit');
  // a follower holding a stale copy: its own request is refused, the leader checks with its own and carries on
  tab2.pass = 'stale';
  await assert.rejects(tab2.engine.trash(), (err) => err.message === COPY.passcode);
  await settle(tab1, tab2);
  assert.equal(tab1.engine.status().paused, null);
  assert.equal((await tab1.store.get('cfg')).paused, null);
});

test('review: the tab the owner looks at stays current while the leader tab is hidden, and a backoff retry still runs', async () => {
  const w = world();
  const t1 = manualTimers(), t2 = manualTimers();
  const [tab1, tab2] = twoTabs(w, { timers: t1 }, { timers: t2 });
  const phone = device(w, 'phone');
  await bothUp(w, tab1, tab2);
  await online(phone);
  tab1.hiddenTab = true; // the leader tab is in the background
  tab2.open = structuredClone(tab2.db.m.get('t1'));
  const add = async (id, at) => { const p = structuredClone(phone.get('t1')); p.entries.push(ask(id, at, `${id} from the phone`)); await phone.put(p); await sync(phone); };
  await add('e2', T0 + 1);
  w.clock.t += SYNC_CLIENT.pollMs;
  t1.fire(SYNC_CLIENT.pollMs); await settle(tab1, tab2); // the hidden leader alone: nobody visible reported in
  assert.deepEqual(tab2.open.entries.map((e) => e.id), ['e1']);
  assert.ok(t2.armed(SYNC_CLIENT.pollMs) > 0, 'the visible follower runs a poll timer too');
  t2.fire(SYNC_CLIENT.pollMs); await settle(tab1, tab2);
  assert.deepEqual(tab2.open.entries.map((e) => e.id), ['e1', 'e2'], 'its report made the hidden leader pull');
  // a network error in a cycle the follower asked for: the leader's retry runs although the leader is hidden
  tab1.before = async () => { throw new TypeError('Failed to fetch'); };
  w.clock.t += MIN;
  tab2.engine.kick('now'); await settle(tab1, tab2);
  assert.equal(tab2.engine.status().state, 'error');
  tab1.before = null;
  await add('e3', T0 + 2);
  w.clock.t += 3000;
  assert.equal(t1.fire(2000), 1, 'the backoff retry fires');
  await settle(tab1, tab2);
  assert.deepEqual(tab2.open.entries.map((e) => e.id), ['e1', 'e2', 'e3']);
  assert.equal(tab2.engine.status().state, 'idle');
});

test('review: a follower’s counts, badges and pause follow the leader', async () => {
  const w = world();
  const [tab1, tab2] = twoTabs(w);
  await bothUp(w, tab1, tab2);
  const open = structuredClone(tab2.db.m.get('t1'));
  tab2.open = open;
  open.entries.push(ask('e3', T0 + 2, 'typed in tab 2'));
  await tab2.put(open); await settle(tab1, tab2);
  assert.equal(tab2.engine.badge('t1'), ' · Not synced yet');
  await sync(tab1); await settle(tab1, tab2);
  assert.deepEqual(w.doc('t1').entries.map((e) => e.id), ['e1', 'e3']);
  assert.deepEqual([tab2.engine.status().waiting, tab2.engine.badge('t1')], [0, '']);
  await tab2.put(thread('t2', [ask('n1', T0 + 3)])); await settle(tab1, tab2);
  await sync(tab1); await settle(tab1, tab2);
  assert.deepEqual([tab2.engine.badge('t2'), tab2.engine.status().synced, tab2.engine.status().waiting], ['', 2, 0]);
  tab1.pass = 'stale';
  await tab1.put({ ...tab1.db.m.get('t1'), entries: [ask('e1', T0, 'edit'), open.entries[1]] });
  await sync(tab1); await settle(tab1, tab2);
  assert.equal(statusLine(tab2.engine.status(), w.clock.t), COPY.passcode);
});

test('review: one thread that fails to pull holds up neither the others nor this device’s pushes; a full disk says so', async () => {
  const w = world();
  const pc = device(w, 'pc'), phone = device(w, 'phone');
  await pc.put(thread('t1', [ask('e1', T0)])); await pc.put(thread('t3', [ask('e5', T0 + 1)]));
  await online(pc); await online(phone);
  const edit = async (id, eid) => { const t = structuredClone(pc.get(id)); t.entries.push(ask(eid, T0 + 10)); w.clock.t += 1000; await pc.put(t); await sync(pc); };
  await edit('t3', 'e7'); await edit('t1', 'e6'); // t1 is the newest: pulled first
  phone.before = (x) => (x.method === 'GET' && x.path.startsWith('thread/t1') ? new Response('{"error":"x","code":"sync_error"}', { status: 500 }) : null);
  await phone.put(thread('t2', [ask('e2', T0 + 2, 'phone turn')]));
  w.clock.t += MIN; await sync(phone);
  assert.ok(w.doc('t2'), 'the phone’s own thread went up in the same cycle');
  assert.ok(phone.get('t3').entries.some((e) => e.id === 'e7'), 'the other changed thread came down');
  assert.equal(statusLine(phone.engine.status(), w.clock.t), COPY.threadTrouble);
  phone.before = null;
  w.clock.t += 10 * MIN; await sync(phone);
  assert.ok(phone.get('t1').entries.some((e) => e.id === 'e6'));
  assert.match(statusLine(phone.engine.status(), w.clock.t), /^Up to date/);
  // a first sync on a new device with one broken thread still uploads what is only on that device
  const tablet = device(w, 'tablet');
  await tablet.db.put(thread('t9', [ask('e9', T0 + 3)]));
  tablet.before = (x) => (x.method === 'GET' && x.path.startsWith('thread/t1') ? new Response('{"error":"x"}', { status: 500 }) : null);
  await online(tablet);
  assert.ok(w.doc('t9'));
  // writing a pulled thread fails (storage full): that is what the status says
  const update = phone.db.update;
  phone.db.update = async () => { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); };
  await edit('t3', 'e8');
  w.clock.t += MIN; await sync(phone);
  assert.equal(statusLine(phone.engine.status(), w.clock.t), COPY.storage);
  phone.db.update = update;
});

test('review: Clear this device in one tab stops the other tab’s sync for good; nothing downloads back', async () => {
  const w = world();
  const [tab1, tab2] = twoTabs(w);
  const pc = device(w, 'pc');
  await bothUp(w, tab1, tab2);
  await online(pc);
  await tab2.engine.forget(); tab2.db.m.clear(); // app.js: Sync.forget(), then DB.clear()
  await settle(tab1, tab2);
  assert.equal(tab1.cleared, 1, 'the other tab was told');
  assert.deepEqual([tab1.engine.isLeader(), tab1.engine.on()], [false, false]);
  const t = structuredClone(pc.get('t1')); t.entries.push(ask('e2', T0 + 1)); await pc.put(t); await sync(pc);
  await tab1.engine.run({ pull: true }); tab1.engine.kick('visible'); tab1.engine.noteWrite(['t1']); await tab1.engine.verified(); await settle(tab1);
  assert.equal(tab1.db.m.size, 0, 'no thread came back');
  assert.deepEqual([...tab1.store.map.keys()], [], 'and the sync state stays gone');
  assert.equal(w.requests(tab1).filter((x) => x.dev === 'tab1').length > 0, true);
  const n = w.requests(tab1).length;
  await sync(tab1);
  assert.equal(w.requests(tab1).length, n);
});

test('review: a full server (507) gets no more uploads until there is room; a refused blob is never re-sent', async () => {
  const w = world();
  w.env.SYNC_QUOTA_BYTES = '1000';
  const pc = device(w, 'pc');
  await pc.engine.verified(); await tick();
  await pc.put(thread('big', [ask('b1', T0, 'z'.repeat(40_000))]));
  await pc.put(thread('small', [ask('s1', T0 + 1)]));
  await sync(pc);
  const puts = () => w.requests(pc).filter((x) => x.method === 'PUT').length;
  assert.equal(puts(), 1);
  assert.ok(w.doc('small'), 'the other thread synced');
  assert.equal(pc.engine.status().quotaFull, true);
  assert.match(statusLine(pc.engine.status(), w.clock.t), /^Server storage limit reached/);
  for (let i = 0; i < 3; i++) { w.clock.t += MIN; await sync(pc); }
  assert.equal(puts(), 1, 'no re-upload on later polls');
  assert.equal(await pc.store.get('d:big'), undefined, 'and the thread isn’t pushed over and over');
  w.env.SYNC_QUOTA_BYTES = '53687091200'; // the owner raised the cap
  w.clock.t += SYNC_CLIENT.statusEveryMs + 1; await sync(pc); await sync(pc);
  assert.equal(pc.engine.status().quotaFull, false);
  assert.equal(w.doc('big').entries[0].d.text.$b.length, 64, 'the held entry went up once there was room');
  // a blob the server refuses (413): remembered and never offered again; the rest of its thread syncs
  pc.before = (x) => (x.method === 'PUT' ? new Response('{"error":"x","code":"too_large"}', { status: 413 }) : null);
  await pc.put(thread('huge', [ask('h1', T0 + 2, 'q'.repeat(40_000)), ask('h2', T0 + 3)]));
  await sync(pc);
  const n = puts();
  for (let i = 0; i < 3; i++) { w.clock.t += MIN; await sync(pc); }
  assert.equal(puts(), n, 'refused once, not re-sent');
  assert.deepEqual(w.doc('huge').entries.map((e) => e.id), ['h2']);
  assert.match(countsLine(pc.engine.status()), /1 item couldn’t be uploaded and stays on this device/);
  assert.ok(await pc.store.get(`bf:${await sha256hex('q'.repeat(40_000))}`));
});

test('review: a delete made in a follower tab while the leader’s push of that thread is on the wire stays deleted', async () => {
  const w = world();
  const [tab1, tab2] = twoTabs(w);
  await bothUp(w, tab1, tab2, [thread('t1', [ask('e1', T0), ask('e2', T0 + 1), ask('e3', T0 + 2)])]);
  let release, held = false;
  const gate = new Promise((r) => { release = r; });
  tab1.before = async (x) => { if (x.method === 'POST' && x.path === 'thread/t1') { tab1.before = null; held = true; await gate; } return null; };
  const t = structuredClone(tab1.db.m.get('t1')); t.entries.push(ask('e4', T0 + 3));
  await tab2.put(t); await settle(tab2);
  const running = push(tab1);
  assert.ok(await until(() => held), 'the push is on the wire');
  await tab2.engine.deleteThread('t1');
  release();
  await running; await settle(tab1, tab2);
  await sync(tab1); await settle(tab1, tab2);
  assert.ok(w.doc('t1').deletedAt, 'deleted on the server');
  assert.equal(tab1.db.m.get('t1'), undefined, 'and here');
  assert.ok(!tab1.toasts.some((m) => m.startsWith('Part of')), tab1.toasts.join(' / '));
});

test('review: when one upload fails the other stops too — nothing is sent after the cycle ended', async () => {
  const w = world();
  const pc = device(w, 'pc');
  await pc.engine.verified(); await settle(pc); // the first cycle is over: run() below is exactly one cycle
  await pc.put(thread('t1', Array.from({ length: 6 }, (_, i) => ask(`e${i}`, T0 + i, `${i}${'w'.repeat(40_000)}`))));
  let n = 0, release;
  const gate = new Promise((r) => { release = r; });
  pc.before = async (x) => {
    if (x.method !== 'PUT') return null;
    n++;
    if (n === 1) return new Response('{"error":"x"}', { status: 500 });
    if (n === 2) await gate;
    return null;
  };
  assert.equal(await pc.engine.run({ pull: true }), null);
  assert.deepEqual([pc.engine.busy(), n], [false, 2], 'the second upload was abandoned, not left running');
  pc.engine.stop(); release(); await settle(pc);
  assert.equal(n, 2, 'no upload after the cycle failed');
  assert.equal(pc.engine.status().progress, null);
});

test('review: while paused for the passcode nothing at all is sent (Recently deleted, Restore and deletes included)', async () => {
  const w = world();
  const pc = device(w, 'pc');
  await pc.put(thread('t1', [ask('e1', T0)])); await pc.put(thread('t2', [ask('e2', T0 + 1)]));
  await online(pc);
  await pc.engine.deleteThread('t2'); await sync(pc);
  const { items } = await pc.engine.trash();
  assert.equal(items.length, 1);
  pc.pass = 'stale';
  await pc.put({ ...pc.get('t1'), entries: [ask('e1', T0, 'edit')] });
  w.log.length = 0;
  await sync(pc);
  assert.equal(w.log.length, 1, 'the one request that found out');
  await assert.rejects(pc.engine.trash(), (e) => e.message === COPY.passcode);
  await assert.rejects(pc.engine.restore(items[0].key), (e) => e.message === COPY.passcode);
  await pc.put({ ...pc.get('t1'), entries: [ask('e1', T0, 'edit 2')] });
  await pc.engine.deleteThread('t1');
  for (const r of ['visible', 'now', 'drawer', 'delete']) pc.engine.kick(r);
  await sync(pc);
  assert.equal(w.log.length, 1, 'still just that one');
});

test('review: an outbox notice survives a marker that never committed — in a follower, and across a reload', async () => {
  const w = world();
  // (a) the follower's marker write is lost (its tab closed mid-write): the leader still pushes the turn
  const db = memDb(), store = memoryStore(), locks = fakeLocks(), port = bus();
  const lossy = { ...store, drop: false, async set(k, v) { if (lossy.drop && k.startsWith('d:')) return; return store.set(k, v); } };
  const tab1 = device(w, 'tab1', { db, store, locks, channel: port() });
  const tab2 = device(w, 'tab2', { db, store: lossy, locks, channel: port() });
  await bothUp(w, tab1, tab2);
  lossy.drop = true;
  const t = structuredClone(db.m.get('t1')); t.entries.push(ask('e2', T0 + 1)); await tab2.put(t); await settle(tab1, tab2);
  assert.equal(await store.get('d:t1'), undefined, 'the marker never landed');
  await sync(tab1);
  assert.deepEqual(w.doc('t1').entries.map((e) => e.id), ['e1', 'e2']);
  // (b) one tab: the page died between the thread write and its marker; the next session's quick check finds it
  const db2 = memDb(), store2 = memoryStore();
  const a = device(w, 'a', { db: db2, store: store2 });
  await db2.put(thread('p1', [ask('q1', T0)]));
  await online(a);
  await store2.set('cfg', { ...(await store2.get('cfg')), scanAt: w.clock.t }); // today's full scan already ran
  const p = structuredClone(db2.m.get('p1')); p.entries.push(ask('q2', T0 + 1)); p.updatedAt = w.clock.t + 1; await db2.put(p);
  a.engine.stop();
  w.clock.t += MIN;
  const timers = manualTimers();
  const b = device(w, 'b', { db: db2, store: store2, timers });
  await online(b);
  assert.deepEqual(w.doc('p1').entries.map((e) => e.id), ['q1'], 'no marker: the push path doesn’t know yet');
  assert.ok(await b.engine.pendingCount() > 0, 'but Clear this device would warn about it');
  assert.equal(timers.fire(SYNC_CLIENT.scanDelayMs), 1, 'the once-a-session quick check is armed');
  await until(() => w.doc('p1').entries.length === 2 && !b.engine.busy(), () => timers.fire(0)); // idle callbacks run
  assert.deepEqual(w.doc('p1').entries.map((e) => e.id), ['q1', 'q2']);
});

test('review: a stalled request is abandoned after its timeout, and Clear this device never hangs on one', async () => {
  const w = world();
  const timers = manualTimers();
  const pc = device(w, 'pc', { timers });
  await pc.put(thread('t1', [ask('e1', T0)]));
  await online(pc);
  pc.before = () => new Promise(() => {}); // the connection died silently
  w.clock.t += MIN;
  const running = pc.engine.run({ pull: true });
  assert.ok(await until(() => timers.armed(SYNC_CLIENT.requestTimeoutMs) === 1), 'the request is on the wire, with its timeout');
  assert.equal(pc.engine.busy(), true);
  assert.equal(timers.fire(SYNC_CLIENT.requestTimeoutMs), 1);
  assert.equal(await running, null);
  assert.deepEqual([pc.engine.busy(), pc.engine.status().state], [false, 'error']);
  const again = pc.engine.run({ pull: true });
  for (let i = 0; i < 20; i++) await tick();
  await pc.engine.forget(); // aborts the request on the wire
  assert.equal(await again, null);
  assert.equal(pc.store.map.size, 0);
});

test('review: a 413 isn’t forever — the thread cap waits an hour; a thread refused as too large goes again once written', async () => {
  const w = world();
  const pc = device(w, 'pc');
  await online(pc);
  const postCount = () => w.requests(pc).filter((x) => x.method === 'POST' && x.path.startsWith('thread/')).length;
  let cap = true;
  pc.before = (x) => (cap && x.method === 'POST' && x.path === 'thread/t1' ? new Response('{"error":"x","code":"too_many_threads"}', { status: 413 }) : null);
  await pc.put(thread('t1', [ask('e1', T0)]));
  await sync(pc);
  assert.equal(pc.engine.record('t1')?.tooLarge, undefined, 'not marked too large');
  assert.match(countsLine(pc.engine.status()), /holds the most threads it can sync/);
  const n1 = postCount();
  await sync(pc);
  assert.equal(postCount(), n1, 'no retry before the hour is up');
  cap = false;
  w.clock.t += SYNC_CLIENT.capRetryMs + 1; await sync(pc); await sync(pc);
  assert.ok(w.doc('t1'), 'then it goes');
  let big = true;
  pc.before = (x) => (big && x.method === 'POST' && x.path === 'thread/t1' ? new Response('{"error":"x","code":"thread_too_large"}', { status: 413 }) : null);
  await pc.put({ ...pc.get('t1'), entries: [...pc.get('t1').entries, ask('e2', T0 + 1)] });
  await sync(pc);
  assert.ok(pc.engine.record('t1').tooLarge);
  assert.equal(pc.engine.badge('t1'), ' · This device only');
  const n2 = postCount();
  await sync(pc); w.clock.t += 60 * MIN; await sync(pc);
  assert.equal(postCount(), n2, 'no request until it is written again');
  big = false; // the owner trims it
  await pc.put({ ...pc.get('t1'), title: 'Trimmed' });
  w.clock.t += 1000; await sync(pc);
  assert.equal(pc.engine.record('t1').tooLarge, undefined);
  assert.deepEqual([w.doc('t1').entries.map((e) => e.id), w.doc('t1').title], [['e1', 'e2'], 'Trimmed']);
});

test('review: the hidden flush measures keepalive bodies in UTF-8 bytes, and one thread that can’t go doesn’t stop the rest', async () => {
  const w = world();
  const pc = device(w, 'pc');
  await pc.put(thread('t1', [ask('e1', T0)])); await pc.put(thread('t2', [ask('e2', T0 + 1)]));
  await online(pc);
  pc.offline = true;
  await pc.put({ ...pc.get('t2'), entries: [ask('e2', T0 + 1, 'small edit')] });
  w.clock.t += 1000;
  const cjk = 'あ'.repeat(30_000); // 30 000 characters, 90 000 UTF-8 bytes
  await pc.put({ ...pc.get('t1'), entries: [ask('e1', T0, cjk)] });
  pc.offline = false; pc.hiddenTab = true;
  pc.before = (x) => { if (x.keepalive && Buffer.byteLength(String(x.body || '')) > 65_536) throw new TypeError('keepalive body over 64 KiB'); return null; };
  w.log.length = 0;
  await pc.engine.flush();
  assert.ok(w.log.every((x) => !x.keepalive || utf8Length(String(x.body || '')) <= SYNC_CLIENT.keepaliveMaxBytes));
  assert.equal(w.doc('t2').entries[0].d.text, 'small edit', 'the small change still went');
  pc.hiddenTab = false; await sync(pc);
  assert.equal(w.doc('t1').entries[0].d.text, cjk, 'the big one goes once the page is visible');
});

// ── second review: two tabs on one thread, Clear this device, the first-sync question (each failed before its fix) ──
const idsOf = (t) => (t?.entries || []).map((e) => e.id);
const IMG = `data:image/png;base64,${Buffer.from('fake png bytes').toString('base64')}`;

test('second review: a leader tab holding an older open copy pushes what a second tab saved, takes it in, and never writes its copy back', async () => {
  const w = world();
  const [tab1, tab2] = twoTabs(w);
  await bothUp(w, tab1, tab2);
  const phone = device(w, 'phone');
  await online(phone);
  // both tabs restored the same thread at boot (lastThread): each holds its own copy
  tab1.open = await tab1.load('t1'); tab2.open = await tab2.load('t1');
  const mine = tab1.open;
  tab2.open.entries.push(ask('e2', T0 + 10, 'typed in tab 2')); await tab2.put(tab2.open);
  await settle(tab1, tab2);
  assert.equal(tab1.open, mine, 'same object');
  assert.deepEqual(idsOf(tab1.open), ['e1', 'e2'], 'the leader’s open copy took the save in, in place');
  assert.ok(tab1.applied.some((x) => x.open?.added?.includes('e2')), 'and its page was told');
  await push(tab1); await settle(tab1, tab2);
  assert.deepEqual(idsOf(w.doc('t1')), ['e1', 'e2'], 'its push sent it');
  assert.deepEqual([tab1.engine.status().waiting, await tab1.store.get('d:t1')], [0, undefined]);
  // the phone adds a turn; the leader pulls it
  const ph = structuredClone(phone.get('t1')); ph.entries.push(ask('p1', T0 + 20, 'from the phone')); await phone.put(ph); await sync(phone);
  w.clock.t += MIN; await sync(tab1); await settle(tab1, tab2);
  for (const [name, t] of [['IndexedDB', tab1.db.m.get('t1')], ['tab 1', tab1.open], ['tab 2', tab2.open]]) assert.deepEqual(idsOf(t), ['e1', 'e2', 'p1'], name);
  // the leader tab goes hidden: persist(true) writes its open copy — nothing is lost by that
  await tab1.put(tab1.open); await settle(tab1, tab2);
  assert.deepEqual(idsOf(tab1.db.m.get('t1')), ['e1', 'e2', 'p1']);
  await sync(tab1); await sync(phone);
  assert.deepEqual(shape(phone.get('t1')), shape(tab1.db.m.get('t1')));
});

test('second review: a hidden leader tab with the thread open (nothing known of how it loaded it) takes in every turn typed in the visible tab; all reach the server', async () => {
  const w = world();
  const [tab1, tab2] = twoTabs(w);
  await bothUp(w, tab1, tab2);
  const phone = device(w, 'phone');
  await online(phone);
  tab1.open = structuredClone(tab1.db.m.get('t1')); tab1.hiddenTab = true;
  tab2.open = await tab2.load('t1');
  for (const [i, eid] of ['e2', 'e3', 'e4'].entries()) {
    tab2.open.entries.push(ask(eid, T0 + 10 + i, `turn ${eid} in tab 2`));
    await tab2.put(tab2.open); await settle(tab1, tab2);
    await push(tab1); await settle(tab1, tab2);
    if (i === 1) { // the phone writes in between; the leader pulls (the visible follower's poll)
      const ph = structuredClone(phone.get('t1')); ph.entries.push(ask('p1', T0 + 30, 'from the phone')); await phone.put(ph); await sync(phone);
      w.clock.t += 61_000; await sync(tab1); await settle(tab1, tab2);
    }
  }
  assert.deepEqual(idsOf(w.doc('t1')), ['e1', 'e2', 'e3', 'e4', 'p1'], 'server');
  for (const [name, t] of [['IndexedDB', tab1.db.m.get('t1')], ['tab 1', tab1.open], ['tab 2', tab2.open]]) assert.deepEqual(idsOf(t).sort(), ['e1', 'e2', 'e3', 'e4', 'p1'], name);
  assert.deepEqual([tab2.engine.status().waiting, await tab1.store.get('d:t1')], [0, undefined]);
});

test('second review: a leader tab that opened a thread while another tab generated in it never pushes its "interrupted" copy over the finished answer', async () => {
  const w = world();
  const [tab1, tab2] = twoTabs(w);
  await bothUp(w, tab1, tab2);
  const phone = device(w, 'phone');
  await online(phone);
  // tab 2: send() saves e2 pending, run() holds atelier-run:e2; a mid-run save keeps partial text
  tab2.open = await tab2.load('t1');
  const e2 = { ...ask('e2', T0 + 10, ''), pending: true };
  tab2.open.entries.push(e2); tab2.live.add('t1');
  const release = tab2.engine.holdRunLock('e2');
  await tab2.put(tab2.open);
  e2.text = 'partial'; await tab2.put(tab2.open);
  await settle(tab1, tab2);
  // tab 1 opens the thread from the drawer: recoverThread marks e2 interrupted in its copy
  tab1.open = recoverThread(await tab1.load('t1'));
  assert.equal(tab1.open.entries[1].recovered, true);
  await push(tab1); await settle(tab1, tab2);
  assert.deepEqual(idsOf(w.doc('t1')), ['e1'], 'e2 waits while it is run-locked');
  // the run finishes in tab 2: run() finally saves, lets the lock go and kicks
  e2.text = 'the full answer'; delete e2.pending; tab2.live.delete('t1');
  await tab2.put(tab2.open); release(); tab2.engine.kick('settled');
  await settle(tab1, tab2); await push(tab1); await settle(tab1, tab2);
  assert.equal(w.doc('t1').entries.find((e) => e.id === 'e2')?.d.text, 'the full answer');
  assert.deepEqual([tab1.open.entries[1].text, tab1.open.entries[1].recovered, tab1.open.entries[1].error], ['the full answer', undefined, undefined], 'tab 1’s copy took the finished answer in');
  // tab 1 goes hidden: persist(true) writes its copy — the finished answer stays everywhere
  await tab1.put(tab1.open); await settle(tab1, tab2); await sync(tab1); await sync(phone);
  for (const t of [tab1.db.m.get('t1'), phone.get('t1')]) assert.deepEqual([t.entries[1].text, t.entries[1].error], ['the full answer', undefined]);
  assert.equal(w.doc('t1').entries[1].d.error, undefined);
});

test('second review: a fork the leader merges into a thread generating in another tab survives that run’s save', async () => {
  const w = world();
  const [tab1, tab2] = twoTabs(w);
  await bothUp(w, tab1, tab2, [thread('t1', [ask('e1', T0, 'v0')])]);
  const phone = device(w, 'phone');
  await online(phone);
  const ph = structuredClone(phone.get('t1')); ph.entries[0].text = 'phone edit'; w.clock.t += 1000; await phone.put(ph); await sync(phone);
  // the pc, offline a moment: tab 2 retries e1, sends e2 and moves to another thread while e2 generates
  tab1.offline = tab2.offline = true;
  const live = structuredClone(tab1.db.m.get('t1'));
  live.entries[0].text = 'pc edit'; await tab2.put(live);
  live.entries.push({ ...ask('e2', T0 + 10, ''), pending: true }); tab2.live.add('t1');
  const release = tab2.engine.holdRunLock('e2');
  await tab2.put(live);
  await settle(tab1, tab2);
  tab1.offline = tab2.offline = false;
  let failed = false; // the leader's next thread POST gets a 503 once
  tab1.before = (x) => { if (!failed && x.method === 'POST' && x.path.startsWith('thread/t1')) { failed = true; return new Response('{"error":"busy","code":"sync_busy"}', { status: 503, headers: { 'retry-after': '2' } }); } return null; };
  await sync(tab1); await settle(tab1, tab2);
  assert.equal(tab1.db.m.get('t1').entries[0].text, 'pc edit', 'nothing merged into the generating thread');
  // e2 settles in tab 2: run() finally saves its own object
  tab2.live.delete('t1'); live.entries[1] = ask('e2', T0 + 10, 'e2 answer'); await tab2.put(live); release(); tab2.engine.kick('settled');
  await settle(tab1, tab2);
  for (let i = 0; i < 3; i++) { w.clock.t += 61_000; await sync(tab1); await settle(tab1, tab2); await sync(phone); }
  const all = [...tab1.db.m.get('t1').entries, ...phone.get('t1').entries, ...w.doc('t1').entries.map((e) => e.d)].map((e) => e.text);
  assert.ok(['pc edit', 'phone edit', 'e2 answer'].every((x) => all.includes(x)), [...new Set(all)].join(' | '));
  assert.deepEqual(shape(tab1.db.m.get('t1')), shape(phone.get('t1')));
});

test('second review: Clear this device names everything only this device has — images and videos, threads left out by "Only threads I make from now on"', async () => {
  const w = world();
  const pc = device(w, 'pc', { engine: { media: { image: false, video: false } } }); // a device still on phase 1 (its media stays here)
  await pc.put(thread('t1', [ask('e1', T0)]));
  await online(pc);
  const t = structuredClone(pc.get('t1'));
  t.entries.push({ ...ask('e2', T0 + 1, ''), kind: 'image', media: [{ type: 'image', src: IMG }] }, ask('e3', T0 + 2, 'what is this?', { images: [IMG] }));
  await pc.put(t); await sync(pc);
  assert.deepEqual(idsOf(w.doc('t1')), ['e1'], 'phase 1: both stay on this device');
  assert.match(statusLine(pc.engine.status(), w.clock.t), /^Up to date/);
  assert.deepEqual(await pc.engine.localReport(), { changes: 0, media: 2, other: 0, threads: 0 });
  assert.equal(await pc.engine.pendingCount(), 2);
  assert.equal(wipeText(await pc.engine.localReport()), 'These are only on this device: 2 entries with images or videos. Clearing this device deletes them for good, so export your threads first. Clear anyway?');
  assert.equal(deviceOnly(pc.engine.status()), true, 'the Danger zone hint keeps "Export your threads first"');
  // a browser with tester traces where the owner chose "Only threads I make from now on"
  const tablet = device(w, 'tablet', { traces: true });
  await tablet.db.put(thread('old', [ask('o1', T0 - 10 * MIN)]));
  await tablet.engine.verified(); await tablet.engine.answer('new'); await sync(tablet);
  assert.equal(tablet.engine.badge(tablet.get('old')), ' · This device only');
  assert.equal(await tablet.engine.pendingCount(), 1);
  assert.equal(wipeText(await tablet.engine.localReport()), 'These are only on this device: 1 thread kept only on this device. Clearing this device deletes them for good, so export your threads first. Clear anyway?');
  // offline changes too
  pc.offline = true;
  await pc.put({ ...pc.get('t1'), title: 'Renamed offline' });
  assert.match(wipeText(await pc.engine.localReport()), /^These are only on this device: 1 change not synced yet, 2 entries with images or videos\./);
  // nothing only here: no question, and the plain hint
  const clean = device(w, 'clean'); await online(clean);
  assert.equal(wipeText(await clean.engine.localReport()), '');
  assert.equal(deviceOnly(clean.engine.status()), false);
  assert.equal(wipeText({ changes: 3 }), '3 changes on this device haven’t reached your other devices yet. Clear anyway? Those changes will be lost.');
});

test('second review: a tab in LinkedIn tester mode never gets its threads uploaded by an owner tab leading sync in the same browser', async () => {
  const w = world();
  const [tab1, tab2] = twoTabs(w);
  await bothUp(w, tab1, tab2, [thread('own', [ask('e1', T0)])]);
  // tab 2: the owner clears the passcode there and a LinkedIn tester signs in; tab 1 keeps leading
  tab2.pass = ''; tab2.tester = true;
  await tab2.put(thread('tester1', [ask('x1', T0 + 1000, 'tester private text')]));
  const own = structuredClone(tab2.db.m.get('own')); own.entries.push(ask('x2', T0 + 2000, 'tester entry')); await tab2.put(own);
  await settle(tab1, tab2);
  assert.deepEqual([await tab1.store.get('d:tester1'), await tab1.store.get('lo:tester1')], [undefined, 1], 'no outbox marker, only the local-only mark');
  assert.equal(tab1.engine.badge('tester1'), ' · This device only', 'the leader knew at once');
  w.clock.t += MIN; await sync(tab1); await settle(tab1, tab2);
  // the tester signs out and the owner is back in tab 2; tab 1 still leads
  tab2.tester = false; tab2.pass = 'pw';
  await tab2.engine.verified(); await settle(tab1, tab2);
  w.clock.t += MIN; await sync(tab1); await push(tab1); await settle(tab1, tab2);
  assert.equal(w.doc('tester1'), null, 'a tester-mode thread never reaches the server');
  assert.deepEqual(idsOf(w.doc('own')), ['e1'], 'nor does a tester entry in an owner thread');
  // a tab that never told anyone (no channel), and an old outbox marker: the leader reads 'lo:' from the store
  const tab3 = device(w, 'tab3', { db: tab1.db, store: tab1.store, locks: tab1.locks, channel: null, tester: true, pass: '' });
  await tab3.put(thread('tester2', [ask('y1', T0 + 3000, 'another tester thread')]));
  await tab1.store.set('d:tester2', 1);
  await push(tab1); await settle(tab1, tab2);
  assert.equal(w.doc('tester2'), null);
  assert.equal(await tab1.store.get('d:tester2'), undefined, 'the marker went without a request');
});

test('second review: a wrong passcode answered 403 owner_only (a tester cookie in this browser) pauses sync after one request, like a 401', async () => {
  const w = world();
  const timers = manualTimers();
  const pc = device(w, 'pc', { timers });
  await pc.put(thread('t1', [ask('e1', T0)]));
  await online(pc);
  pc.pass = 'rotated';
  pc.before = () => new Response(JSON.stringify({ error: 'That part of Atelier is only for its owner.', code: 'owner_only' }), { status: 403, headers: { 'content-type': 'application/json' } });
  w.log.length = 0;
  w.clock.t += MIN; await sync(pc);
  assert.equal(w.log.length, 1, 'one request found out');
  assert.equal(pc.engine.status().paused?.reason, 'passcode');
  assert.equal(statusLine(pc.engine.status(), w.clock.t), COPY.passcode);
  for (let i = 0; i < 12; i++) { w.clock.t += SYNC_CLIENT.pollMs; timers.fire(SYNC_CLIENT.pollMs); await settle(pc); }
  await sync(pc);
  assert.equal(w.log.length, 1, 'polls never feed the lockout');
  await assert.rejects(pc.engine.trash(), (err) => err.message === COPY.passcode);
});

test('second review: deleting a thread whose every entry holds an image never promises a 30-day restore', async () => {
  const w = world();
  const pc = device(w, 'pc', { engine: { media: { image: false, video: false } } }); // a device still on phase 1 (its media stays here)
  await pc.put(thread('t1', [ask('e1', T0)]));
  await online(pc);
  await pc.put(thread('p1', [ask('q1', T0 + 1, 'what is this?', { images: [IMG] })])); await sync(pc);
  assert.equal(w.doc('p1'), null);
  assert.equal(pc.engine.badge(pc.get('p1')), ' · This device only');
  assert.equal(await pc.engine.deleteCopy('p1'), COPY.deleteLocal);
  await pc.engine.deleteThread('p1'); await sync(pc);
  assert.deepEqual((await pc.engine.trash()).items, [], 'nothing was restorable, and nothing was promised');
  // a synced thread that also holds an image: restorable (its text), and the image is named
  const t = structuredClone(pc.get('t1')); t.entries.push(ask('e2', T0 + 2, 'and this?', { images: [IMG] })); await pc.put(t); await sync(pc);
  assert.equal(await pc.engine.deleteCopy('t1'), COPY.deleteConfirm + COPY.deleteMedia);
});

// A stand-in for the few DOM calls bindUi makes (index.html's #sync* and #trash* markup).
function fakeDoc() {
  const els = new Map();
  const make = () => ({
    hidden: false, textContent: '', checked: false, disabled: false, open: false, offsetParent: null, children: [], listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    fire(type) { for (const fn of this.listeners[type] || []) fn({ target: this }); },
    showModal() { this.open = true; }, close() { if (!this.open) return; this.open = false; this.fire('close'); },
    click() { this.fire('click'); }, focus() {}, setAttribute() {}, removeAttribute() {}, remove() {},
    replaceChildren(...c) { this.children = c; }, append(...c) { this.children.push(...c); },
  });
  return { querySelector(sel) { if (!els.has(sel)) els.set(sel, make()); return els.get(sel); }, createElement: make };
}

test('second review: the first-sync question answered in one tab closes in the other, and closing it there changes nothing', async () => {
  const w = world();
  const db = memDb(), store = memoryStore(), locks = fakeLocks(), port = bus();
  await db.put(thread('t1', [ask('e1', T0 - MIN)]));
  const tabs = [1, 2].map((k) => {
    const doc = fakeDoc(), name = `tab${k}`;
    const tab = { name, doc, ui: null, toasts: [] };
    tab.engine = createSync({
      db, store, locks, channel: port(), apiHeaders: () => ({ 'x-app-pass': 'pw' }), isOwner: () => true, hasTesterTraces: () => true,
      onStatus: (s) => tab.ui?.render(s), onAsk: (n) => tab.ui?.ask(n), fetch: w.fetchFor(tab), now: () => w.clock.t, uid: () => `${name}f${Math.random().toString(36).slice(2)}`,
      timers: NO_TIMERS, toast: (m) => tab.toasts.push(m), random: () => 0.5,
    });
    tab.ui = bindUi(tab.engine, { toast: (m) => tab.toasts.push(m) }, doc);
    return tab;
  });
  for (const t of tabs) await t.engine.verified();
  await settle(...tabs);
  for (const t of tabs) assert.equal(t.doc.querySelector('#syncFirst').open, true, `${t.name} asks`);
  assert.equal(tabs[1].doc.querySelector('#syncFirstAll').textContent, 'Upload the thread');
  tabs[0].doc.querySelector('#syncFirstAll').click();
  await settle(...tabs);
  assert.equal(tabs[1].doc.querySelector('#syncFirst').open, false, 'answered in tab 1: tab 2’s copy closed');
  tabs[1].doc.querySelector('#syncFirst').fire('close'); // a late Esc there
  await settle(...tabs);
  const cfg = await store.get('cfg');
  assert.deepEqual([cfg.enabled, cfg.mode], [true, 'all'], 'tab 1’s choice stands');
  assert.equal(await tabs[1].engine.answer('new'), false, 'an answer from a second dialog is not taken');
  assert.equal((await store.get('cfg')).mode, 'all');
  for (const t of tabs) t.engine.stop();
});

test('second review: tester traces but no threads here: sync turns on without a question; with threads, an answered question still brings others in', async () => {
  const w = world();
  const pc = device(w, 'pc', { traces: true });
  await pc.engine.verified(); await sync(pc);
  assert.deepEqual(pc.asked, [], 'nothing to choose: no dialog');
  assert.deepEqual([pc.engine.config().enabled, pc.engine.config().mode], [true, 'all']);
  assert.ok(pc.toasts.includes(COPY.firstEnable));
  pc.tester = true; await pc.put(thread('x', [ask('x1', T0)])); pc.tester = false; // a tester session later on this browser
  await sync(pc);
  assert.equal(w.doc('x'), null, 'its threads still stay here');
  const pc2 = device(w, 'pc2'); await pc2.store.set('trace', 1);
  assert.equal(await pc2.engine.turnOn(), 'on', 'the Settings switch: the same');
  assert.deepEqual(pc2.asked, []);
  // threads here: asked; once answered, threads from the other devices come in with the usual note
  const pc4 = device(w, 'pc4'); await pc4.put(thread('elsewhere', [ask('w1', T0)])); await online(pc4);
  const pc3 = device(w, 'pc3', { traces: true });
  await pc3.db.put(thread('mine', [ask('m1', T0 - MIN)]));
  await pc3.engine.verified();
  assert.deepEqual(pc3.asked, [1]);
  await pc3.engine.answer('all'); await sync(pc3);
  assert.ok(pc3.toasts.includes(COPY.bringing) && !pc3.toasts.includes(COPY.firstEnable), pc3.toasts.join(' / '));
});

test('second review: a thread deleted on another device closes in a follower tab with the same note', async () => {
  const w = world();
  const [tab1, tab2] = twoTabs(w);
  const pc = device(w, 'pc');
  await bothUp(w, tab1, tab2);
  await online(pc);
  tab2.open = await tab2.load('t1');
  await pc.engine.deleteThread('t1'); await sync(pc);
  await sync(tab1); await settle(tab1, tab2);
  assert.ok(tab2.applied.some((x) => x.open?.closed));
  assert.ok(tab2.toasts.includes(COPY.openDeleted), tab2.toasts.join(' / '));
  assert.ok(!tab1.toasts.includes(COPY.openDeleted), 'the leader tab wasn’t showing it');
});

test('second review: going offline shows in the sync status at once, in every tab', async () => {
  const w = world();
  const [tab1, tab2] = twoTabs(w);
  await bothUp(w, tab1, tab2);
  for (const t of [tab1, tab2]) {
    t.statuses.length = 0;
    t.offline = true; t.engine.kick('offline'); await tick();
    assert.equal(statusLine(t.statuses.at(-1), w.clock.t), 'Offline — will sync when you’re back online', t.name);
    assert.equal(t.statuses.at(-1).state, 'offline');
  }
});

test('second review: Recently deleted’s count follows a delete at once, and a delete made elsewhere at the next pull', async () => {
  const w = world();
  const pc = device(w, 'pc'), phone = device(w, 'phone');
  for (const [i, id] of ['t1', 't2', 't3'].entries()) await pc.put(thread(id, [ask(`e${i}`, T0 + i)]));
  await online(pc); await online(phone);
  assert.equal(pc.engine.status().server.trash, 0);
  await pc.engine.deleteThread('t1'); await push(pc);
  assert.equal(pc.engine.status().server.trash, 1);
  await pc.engine.deleteThread('t2'); await push(pc);
  assert.equal(pc.engine.status().server.trash, 2);
  await phone.engine.deleteThread('t3'); await sync(phone);
  w.clock.t += MIN; await sync(pc);
  assert.equal(pc.engine.status().server.trash, 3);
});

test('second review: a save never writes an older copy over another tab’s work, even before that tab’s notice arrived', async () => {
  const w = world();
  const [tab1, tab2] = twoTabs(w);
  await bothUp(w, tab1, tab2);
  tab1.open = await tab1.load('t1'); tab2.open = await tab2.load('t1');
  tab2.open.entries.push(ask('e2', T0 + 10, 'typed in tab 2'));
  await tab2.put(tab2.open); // its notice is still on its way to tab 1
  tab1.open.title = 'Renamed in tab 1';
  await tab1.put(tab1.open); // tab 1 saves at that same moment (persist on hide)
  assert.deepEqual(idsOf(tab1.db.m.get('t1')), ['e1', 'e2'], 'tab 2’s turn is kept');
  assert.equal(tab1.db.m.get('t1').title, 'Renamed in tab 1');
  assert.deepEqual(idsOf(tab1.open), ['e1', 'e2'], 'and tab 1 shows it');
  await settle(tab1, tab2);
  assert.equal(tab2.open.title, 'Renamed in tab 1', 'tab 2 takes the rename in');
  await sync(tab1); await settle(tab1, tab2);
  assert.deepEqual([idsOf(w.doc('t1')), w.doc('t1').title], [['e1', 'e2'], 'Renamed in tab 1']);
});

// ── third review: a write that fails, and two tabs generating in one thread (every user: sync on, tester, sync off) ──
// An atelier-data store that behaves like IndexedDB when writes fail: readwrite transactions run one at a time, each
// a later task than the last one's end (its abort handled, promise rejection included); update runs its callback (which
// may change the app's object), then the commit fails — storage full (QuotaExceededError) refuses every write, or only
// one too big for what is left (fits).
function failingDb() {
  const m = new Map();
  const c = (v) => (v === undefined ? undefined : structuredClone(v));
  const later = () => new Promise((r) => setTimeout(r, 0));
  let chain = Promise.resolve();
  const serial = (fn) => { const p = chain.then(later).then(fn); chain = p.catch(() => {}).then(later); return p; };
  const refuse = (t) => db.fail || (db.fits && t && !db.fits(t));
  const quota = () => new DOMException('The quota has been exceeded.', 'QuotaExceededError');
  const db = {
    m, fail: false, fits: null,
    async get(id) { return c(m.get(id)); },
    put(t) { const v = c(t); return serial(async () => { if (refuse(v)) throw quota(); m.set(v.id, v); }); },
    async putAll(ts) { if (db.fail) throw quota(); for (const t of ts) m.set(t.id, c(t)); },
    async del(id) { m.delete(id); },
    async keys() { return [...m.keys()]; },
    update(id, fn) { return serial(async () => { const cur = c(m.get(id)); const next = fn(cur); if (next && refuse(next)) throw quota(); if (next === null) m.delete(id); else if (next) m.set(id, c(next)); return cur; }); },
  };
  return db;
}
const later = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const WHO = [['sync off', { pass: '' }, false], ['a tester', { pass: '', tester: true }, false], ['the owner, sync on', {}, true]];

for (const [who, opts, on] of WHO) {
  test(`third review (${who}): storage full during a turn — the answer stays in the open thread, and is written once storage is back`, async () => {
    const w = world();
    const dev = device(w, 'pc', { db: failingDb(), ...opts });
    if (on) await online(dev);
    await dev.db.put(thread('T', [ask('e0', T0, 'a0')]));
    const t = dev.open = await dev.load('T');
    dev.db.fail = true; // the phone's storage is full from here on
    const errs = [];
    const save = () => dev.put(t).catch((err) => errs.push(err.name)); // app.js: DB.put(…).catch(storageError), never awaited
    const e1 = { ...ask('e1', T0 + 1, ''), pending: true }; // submit(): the turn goes in, persist(true)
    t.entries.push(e1);
    save();
    await later();
    Object.assign(e1, { pending: false, text: 'the answer the user just got' }); // run() finally: DB.put(thread), then persist(true)
    save(); save();
    await later();
    assert.deepEqual(errs, ['QuotaExceededError', 'QuotaExceededError', 'QuotaExceededError'], 'every save reported the storage error');
    assert.deepEqual(idsOf(t), ['e0', 'e1'], 'the open thread (what Export saves) still holds the answer');
    assert.equal(t.entries[1].text, 'the answer the user just got');
    dev.db.fail = false; // the owner made room
    await dev.put(t);
    assert.deepEqual(idsOf(dev.db.m.get('T')), ['e0', 'e1'], 'IndexedDB gets the answer once a save works');
  });
}

test('third review: an edit made while storage was full is never reverted by the next save', async () => {
  const w = world();
  const dev = device(w, 'pc', { db: failingDb(), pass: '' });
  await dev.db.put(thread('T', [ask('e0', T0, 'old')]));
  const t = dev.open = await dev.load('T');
  dev.db.fail = true;
  t.entries[0].text = 'edited 1';
  await dev.put(t).catch(() => {}); // a merged save: fails
  t.entries[0].text = 'edited 2';
  await dev.put(t).catch(() => {}); // a plain save (what IndexedDB holds is unknown now): fails
  dev.db.fail = false;
  t.title = 'Renamed';
  await dev.put(t);
  assert.equal(t.entries[0].text, 'edited 2', 'the open thread keeps the edit');
  assert.equal(dev.db.m.get('T').entries[0].text, 'edited 2', 'and IndexedDB gets it');
});

test('third review: nearly full storage — a new image the device couldn’t save is never wiped by the next, smaller save', async () => {
  const w = world();
  const dev = device(w, 'pc', { db: failingDb() });
  await online(dev);
  dev.db.fits = (t) => JSON.stringify(t).length <= 50_000; // what the quota still lets this thread take
  const t = dev.open = { id: 'N', title: '', createdAt: T0, updatedAt: T0, entries: [] };
  const e1 = { id: 'e1', kind: 'image', prompt: 'a fox', createdAt: T0 + 1, pending: true };
  t.entries.push(e1);
  await dev.put(t); // submit(): the first turn, small
  Object.assign(e1, { pending: false, media: [{ type: 'image', src: `data:image/png;base64,${'A'.repeat(60_000)}` }] });
  const errs = [];
  const save = () => dev.put(t).catch((err) => errs.push(err.name));
  save(); save(); // run() finally: DB.put(thread), persist(true)
  await later();
  t.title = 'A fox'; save(); // nameThread
  await later();
  save(); // visibilitychange → persist(true)
  await later();
  assert.ok(errs.length >= 2, 'the user was told saving failed');
  assert.equal(t.entries[0].pending, false);
  assert.equal(t.entries[0].media?.length, 1, 'the image is still in the open thread, so Export can save it');
  const stored = dev.db.m.get('N').entries[0];
  assert.ok(stored.pending === true || stored.media?.length === 1, 'IndexedDB never holds a finished entry without its image');
});

// app.js submit() + run() in one tab: the turn goes in and is saved under this tab's run lock (holdRunLock); the thread
// is live in this tab only while this tab's own runs in it go (liveRuns); run()'s finally saves the run's thread object,
// releases the lock, then saves the open thread again (persist(true)).
function sender(tab) {
  tab.runs = tab.runs || new Map();
  const save = (t) => tab.engine.saveThread(t).then(() => tab.engine.noteWrite([t.id], [t]));
  return (id, at) => {
    const t = tab.open, e = { ...ask(id, at, ''), pending: true };
    t.entries.push(e);
    tab.live.add(t.id); tab.runs.set(t.id, (tab.runs.get(t.id) || 0) + 1);
    const release = tab.engine.holdRunLock(e.id);
    save(t);
    return async (text) => {
      Object.assign(e, { pending: false, text });
      const left = tab.runs.get(t.id) - 1;
      if (left > 0) tab.runs.set(t.id, left); else { tab.runs.delete(t.id); tab.live.delete(t.id); }
      const saved = save(t);
      release();
      await saved;
      if (t === tab.open) await save(tab.open);
    };
  };
}
const view = (t) => (t?.entries || []).map((e) => `${e.id}:${e.pending ? 'PENDING' : e.text}`);
for (const [who, opts, on] of [WHO[0], WHO[2]]) {
  for (const first of ['A', 'B']) {
    test(`third review (${who}): two tabs generating in one thread — both answers survive (tab ${first} finishes first) and neither stays live`, async () => {
      const w = world();
      const [A, B] = twoTabs(w, opts, opts);
      if (on) await bothUp(w, A, B, [thread('T', [ask('e0', T0, 'a0')])]);
      else await A.db.put(thread('T', [ask('e0', T0, 'a0')]));
      A.open = await A.load('T'); B.open = await B.load('T');
      const finishA = sender(A)('ea', T0 + 10); await settle(A, B); // a long video in tab A
      const finishB = sender(B)('eb', T0 + 20); await settle(A, B); // a quick question in tab B, same thread
      assert.deepEqual(view(A.open), ['e0:a0', 'ea:PENDING', 'eb:PENDING'], 'tab A shows tab B’s turn generating');
      if (first === 'A') { await finishA('answer A'); await settle(A, B); await finishB('answer B'); }
      else {
        await finishB('answer B'); await settle(A, B);
        assert.deepEqual(view(A.open), ['e0:a0', 'ea:PENDING', 'eb:answer B'], 'tab A, still generating, shows tab B’s answer at once');
        await finishA('answer A');
      }
      await settle(A, B);
      const want = ['e0:a0', 'ea:answer A', 'eb:answer B'];
      assert.deepEqual(view(A.db.m.get('T')), want, 'IndexedDB keeps both answers');
      assert.deepEqual(view(A.open), want, 'tab A shows both');
      assert.deepEqual(view(B.open), want, 'tab B shows both');
      assert.equal(A.live.has('T') || B.live.has('T'), false, 'no tab still treats the thread as generating (pulls into it go on)');
      if (on) {
        await sync(leaderOf(A, B)); await settle(A, B);
        assert.deepEqual(w.doc('T').entries.map((e) => `${e.id}:${e.d.text}`), want, 'both answers reach the server');
      }
    });
  }
}

// IndexedDB with its readwrite transactions run by hand, one at a time: step() runs the next one (its commit fails
// while fail is set) and lets its outcome be handled before returning.
function steppedDb() {
  const m = new Map(), q = [];
  const c = (v) => (v === undefined ? undefined : structuredClone(v));
  const quota = () => new DOMException('The quota has been exceeded.', 'QuotaExceededError');
  const job = (fn) => new Promise((res, rej) => q.push(() => { try { res(fn()); } catch (err) { rej(err); } }));
  const db = {
    m, q, fail: false,
    async get(id) { return c(m.get(id)); },
    put(t) { const v = c(t); return job(() => { if (db.fail) throw quota(); m.set(v.id, v); }); },
    async putAll(ts) { for (const t of ts) m.set(t.id, c(t)); },
    async del(id) { m.delete(id); },
    async keys() { return [...m.keys()]; },
    update(id, fn) { return job(() => { const cur = c(m.get(id)); const next = fn(cur); if (next && db.fail) throw quota(); if (next === null) m.delete(id); else if (next) m.set(id, c(next)); return cur; }); },
    async step() { q.shift()(); for (let i = 0; i < 10; i++) await tick(); },
  };
  return db;
}

test('third review: a save still queued never takes a later save’s snapshot for written, so storage failing in between loses nothing', async () => {
  const w = world();
  const db = steppedDb();
  const dev = device(w, 'pc', { db, pass: '' });
  db.m.set('T', thread('T', [ask('e0', T0, 'a0')]));
  const t = dev.open = await dev.load('T');
  t.entries.push(ask('e1', T0 + 1, 'the new answer'));
  const errs = [];
  const save = () => dev.engine.saveThread(t).catch((err) => errs.push(err.name));
  db.fail = true;
  save(); save(); // run() finally: DB.put(thread), then persist(true) — two merged saves, queued
  await db.step(); // the first one's commit fails: what IndexedDB holds is unknown again
  assert.deepEqual(errs, ['QuotaExceededError']);
  db.fail = false; // there is room again
  save(); // a save made now (a plain one), queued behind the second
  await db.step(); // the second save's merge runs before that plain save has written anything
  assert.deepEqual(idsOf(t), ['e0', 'e1'], 'the open thread keeps the new answer');
  assert.deepEqual(idsOf(db.m.get('T')), ['e0', 'e1'], 'and the second save wrote it');
  await db.step();
  assert.deepEqual(idsOf(db.m.get('T')), ['e0', 'e1']);
  assert.deepEqual(errs, ['QuotaExceededError']);
});

test('third review: app.js run() — a thread stops being live when this tab’s own last run in it ends, not when no entry is pending', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const run = src.slice(src.indexOf('async function run(e) {'), src.indexOf('// The earlier turns as messages'));
  assert.ok(run.includes('liveThreads.set(thread.id, thread); liveRuns.set(thread.id, (liveRuns.get(thread.id) || 0) + 1);'), 'each run counts itself in');
  assert.match(run, /const left = \(liveRuns\.get\(thread\.id\) \|\| 1\) - 1;\s*if \(left > 0\) liveRuns\.set\(thread\.id, left\);\s*else \{ liveRuns\.delete\(thread\.id\); liveThreads\.delete\(thread\.id\); \}/);
  assert.ok(!src.includes('entry.pending)) liveThreads.delete'), 'another tab’s generating entry never keeps the thread live here');
  assert.equal(src.split('liveThreads.delete(').length - 1, 1, 'run() is the only place a thread stops being live');
  assert.ok(run.indexOf('Sync.holdRunLock(e.id)') > 0 && run.indexOf('Sync.holdRunLock(e.id)') < run.indexOf('await runChat'), 'the run lock is taken before the entry’s first save');
});

// A run that outlives a delete and a re-import (the From Canva thread keeps its id): its save takes in the new thread's
// entry and drops the deleted ones; the new entry must land where the agreed order (createdAt) puts it, as the server
// and every pull place it — after its neighbour, it went first, and this device showed the turns in another order for good.
test('third review: a run that outlives a delete and a re-import lands in the order the server and every device show', async () => {
  const w = world();
  const [A, B] = twoTabs(w);
  await bothUp(w, A, B, [thread('T', [ask('e0', T0, 'a0')])]);
  B.open = await B.load('T');
  const finishB = sender(B)('eb', T0 + 10); await settle(A, B); // tab B generates in T
  await A.engine.deleteThread('T'); await settle(A, B); // tab A deletes T…
  await A.put({ id: 'T', title: 'From Canva', createdAt: T0 + 20, updatedAt: T0 + 20, entries: [ask('ec', T0 + 20, 'imported')] }); // …and an import makes it again
  await settle(A, B);
  await finishB('answer B'); await settle(A, B); // tab B's run ends: its answer goes into the new thread
  const order = ['eb', 'ec'];
  assert.deepEqual(idsOf(A.db.m.get('T')), order, 'IndexedDB holds the agreed order');
  assert.deepEqual(idsOf(B.open), order, 'so does the open copy');
  await sync(leaderOf(A, B)); await settle(A, B);
  assert.deepEqual(idsOf(w.doc('T')), order, 'the server sorts it the same way');
  assert.deepEqual([idsOf(A.db.m.get('T')), idsOf(B.open)], [order, order]);
  const other = device(w, 'phone'); await online(other);
  assert.deepEqual(idsOf(other.get('T')), order, 'another device pulls the same order');
});

test('patchInPlace sorted: a new entry goes where the agreed order puts it, around entries the source lacks; one without a createdAt keeps the neighbour rule', () => {
  const target = { entries: [ask('e1', 1), ask('e5', 5), ask('e9', 9)] }; // e5: only in this copy (unsaved, or a run's)
  const source = { entries: [ask('e1', 1), ask('e7', 7), ask('e3', 3), ask('e9', 9)] };
  const info = patchInPlace(target, source, ['e7', 'e3'], [], { sorted: true });
  assert.deepEqual(idsOf(target), ['e1', 'e3', 'e5', 'e7', 'e9']);
  assert.deepEqual(info.added, ['e7', 'e3']);
  const plain = { entries: [ask('e1', 1), ask('e5', 5)] };
  patchInPlace(plain, { entries: [ask('e1', 1), ask('e7', 7)] }, ['e7'], []);
  assert.deepEqual(idsOf(plain), ['e1', 'e7', 'e5'], 'unsorted: after its neighbour in the source');
  const legacy = { entries: [ask('e1', 1), ask('e5', 5)] };
  patchInPlace(legacy, { entries: [ask('e1', 1), { ...ask('ex', 0), createdAt: undefined }] }, ['ex'], [], { sorted: true });
  assert.deepEqual(idsOf(legacy), ['e1', 'ex', 'e5'], 'no usable createdAt (it never syncs): after its neighbour');
});

// The index is read with If-None-Match. A thread this device pushed after its last index read, then lost by the server,
// leaves the thread list exactly as that read saw it: a 304 then hid the loss and the thread never went up again.
test('third review: a thread pushed after the last index read and then lost by the server is pushed again (no 304 hides it)', async () => {
  const w = world();
  const pc = device(w, 'pc');
  await pc.db.put(thread('t0', [ask('e0', T0)]));
  await online(pc); // index read: [t0]
  await pc.put(thread('t1', [ask('e1', T0 + 5, 'only on this device')]));
  await push(pc); // t1 goes up; the thread list changed
  assert.deepEqual(idsOf(w.doc('t1')), ['e1']);
  await w.r2.delete('t/t1.json'); // …and the server loses it: the list is [t0] again, as at the last index read
  await sync(pc);
  const reads = w.requests(pc).filter((x) => x.method === 'GET' && x.path.startsWith('index'));
  assert.equal(reads.at(-1).inm, null, 'after its own push, this device reads the whole index');
  assert.deepEqual(idsOf(w.doc('t1')), ['e1'], 'the lost thread is pushed again');
  assert.equal(w.doc('t1').entries[0].d.text, 'only on this device');
  assert.deepEqual(pc.db.removed, []);
});

// v56 review: a write that starts while an index read is in flight (Restore runs outside the cycle) must not let that
// read's answer put back the ETag of the list from before the write — the next read is a whole one, as after any write.
test('v56 review: an index read in flight across a restore does not keep its pre-write ETag', async () => {
  const w = world();
  const pc = device(w, 'pc');
  await pc.db.put(thread('t0', [ask('e0', T0)]));
  await pc.db.put(thread('t1', [ask('e1', T0 + 1)]));
  await online(pc);
  await pc.engine.deleteThread('t1'); await sync(pc);
  const { items } = await pc.engine.trash();
  assert.equal(items.length, 1);
  let gate, held = null;
  const opened = new Promise((r) => { gate = r; });
  pc.before = async (entry) => {
    if (entry.method !== 'GET' || !entry.path.startsWith('index') || held) return null;
    // the server answers now (the list before the restore)…
    const u = new URL(`https://atelier.test/api/sync/${entry.path}`);
    held = await handleSync(workerRequest(u, { method: 'GET', headers: new Headers({ 'x-app-pass': 'pw' }) }), w.env, u, u.pathname.slice('/api/'.length));
    gate(); // …and the answer arrives only after the restore went out
    await new Promise((r) => setTimeout(r, 20));
    return held;
  };
  const cycle = sync(pc);
  await opened;
  await pc.engine.restore(items[0].key);
  await cycle;
  pc.before = null;
  await sync(pc);
  const reads = w.requests(pc).filter((x) => x.method === 'GET' && x.path.startsWith('index'));
  assert.equal(reads.at(-1).inm, null, 'the read after the restore is a whole one');
  assert.deepEqual(pc.get('t1')?.entries.map((e) => e.id), ['e1'], 'the restored thread comes back');
});

// ── phases 2-3: images and videos ──
// Small sizes stand in for the real ones (a 10 MB video on mobile data, a 16 MB "large" blob).
const BUDGET = { cellularMaxBytes: 1000, bigBlobBytes: 4000, printMemoChars: 64 };
const bytesOf = (tag, n) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = (tag.charCodeAt(i % tag.length) * 7 + i * 13 + (i >> 8)) & 255; return b; };
const dataUrl = (type, tag, n) => `data:${type};base64,${bytesOf(tag, n).toString('base64')}`;
const mediaDevice = (w, name, opts = {}) => device(w, name, { ...opts, engine: { budget: BUDGET, idle: (fn) => setImmediate(fn), ...(opts.engine || {}) } });
const blobGets = (w, dev) => w.requests(dev).filter((x) => x.method === 'GET' && x.path.startsWith('blob/'));
const shaOf = (u) => createHash('sha256').update(Buffer.from(u.slice(u.indexOf(',') + 1), 'base64')).digest('hex');

test('images: attached photos, generated images, video posters and frames, motion stills round-trip byte-exact to another device', async () => {
  const w = world();
  const pc = mediaDevice(w, 'pc'), phone = mediaDevice(w, 'phone');
  const photo = dataUrl('image/jpeg', 'photo', 300), gen = dataUrl('image/png', 'gen', 500), still = dataUrl('image/webp', 'still', 200);
  const poster = dataUrl('image/jpeg', 'poster', 120), frame = dataUrl('image/jpeg', 'frame', 90);
  await pc.put(thread('t1', [
    ask('e1', T0, 'what is in this photo?', { images: [photo] }),
    { ...ask('e2', T0 + 1, ''), kind: 'image', media: [{ type: 'image', src: gen }, { type: 'image', src: gen }] },
    { ...ask('e3', T0 + 2, ''), kind: 'video', media: [{ type: 'video', src: dataUrl('video/mp4', 'motion', 300), still }] },
    ask('e4', T0 + 3, 'about the clip', { video: { name: 'clip.mp4', mime: 'video/mp4', size: 10, duration: 1, poster, frames: [{ t: 0, src: frame }] } }),
  ]));
  await online(pc);
  assert.deepEqual(idsOf(w.doc('t1')), ['e1', 'e2', 'e3', 'e4'], 'every image entry went up');
  assert.equal(w.r2.keys('b/').length, 6, 'one blob per distinct image or video (the same image twice is one blob)');
  assert.equal(w.r2.objects.get(`b/${shaOf(gen).slice(0, 2)}/${shaOf(gen)}`).httpMetadata.contentType, 'image/png');
  await online(phone);
  assert.deepEqual(shape(phone.get('t1')), shape(pc.get('t1')), 'byte-exact on the other device');
  assert.equal(phone.get('t1').entries[0].images[0], photo);
  assert.equal(blobGets(w, phone).length, 6, 'each blob downloaded once');
  // the status counts what the server holds
  w.clock.t += 61 * MIN; await sync(phone); // the usage count is recounted hourly (uploads racing each other can undercount it meanwhile)
  assert.match(countsLine(phone.engine.status()), /on your server \(5 images, 1 video\)/);
});

test('phase 1 held image entries go up by themselves once this device syncs images', async () => {
  const w = world();
  const db = memDb(), store = memoryStore();
  const old = mediaDevice(w, 'pc', { db, store, engine: { media: { image: false, video: false } } });
  await old.put(thread('t1', [ask('e1', T0, 'text'), ask('e2', T0 + 1, 'with a photo', { images: [IMG] })]));
  await online(old);
  assert.deepEqual(idsOf(w.doc('t1')), ['e1'], 'phase 1 kept the photo entry here');
  old.engine.stop();
  const pc = mediaDevice(w, 'pc', { db, store }); // the update: same browser, same storage
  w.clock.t += MIN;
  await online(pc);
  assert.deepEqual(idsOf(w.doc('t1')), ['e1', 'e2'], 'the held entry went up without a new write');
  assert.equal(pc.engine.config().media, '11');
});

test('videos: on mobile data a video over the limit waits for Wi-Fi; the thread’s text is already there; Download now fetches it', async () => {
  const w = world();
  const pc = mediaDevice(w, 'pc'), phone = mediaDevice(w, 'phone');
  const clip = dataUrl('video/mp4', 'veo', 1500), small = dataUrl('video/webm', 'tiny', 400);
  await pc.put(thread('t1', [ask('e1', T0, 'first'), { ...ask('e2', T0 + 1, ''), kind: 'video', media: [{ type: 'video', src: clip }] }, { ...ask('e3', T0 + 2, ''), kind: 'video', media: [{ type: 'video', src: small }] }]));
  await online(pc);
  assert.equal(w.doc('t1').entries.length, 3);
  phone.conn = { type: 'cellular' };
  await online(phone);
  assert.deepEqual(idsOf(phone.get('t1')), ['e1', 'e3'], 'text and the small video are here at once');
  assert.equal(blobGets(w, phone).filter((x) => x.path.includes(shaOf(clip))).length, 0, 'the large video was never requested');
  const st = phone.engine.status();
  assert.equal(statusLine(st, w.clock.t), 'Waiting for Wi-Fi · 1 video (1.5 KB)');
  assert.equal(phone.engine.badge(phone.get('t1')), ' · Downloading 1 item');
  assert.deepEqual(phone.engine.noteFor('t1'), { n: 1, wifi: 1, storage: 0, videos: 1, bytes: 1500, downloading: false });
  // the next polls don't read the waiting thread again
  const reads = () => w.requests(phone).filter((x) => x.path.startsWith('thread/t1')).length;
  const before = reads();
  w.clock.t += MIN; await sync(phone); w.clock.t += MIN; await sync(phone);
  assert.equal(reads(), before, 'no re-read while it can only wait');
  await phone.engine.downloadNow('t1');
  await settle(phone);
  assert.deepEqual(shape(phone.get('t1')), shape(pc.get('t1')), 'Download now brought it');
  assert.equal(phone.engine.noteFor('t1').n, 0);
  assert.match(statusLine(phone.engine.status(), w.clock.t), /^Up to date/);
});

test('videos: "Download videos on mobile data" lets them come on mobile data; Wi-Fi coming back does too', async () => {
  const w = world();
  const pc = mediaDevice(w, 'pc'), phone = mediaDevice(w, 'phone'), tablet = mediaDevice(w, 'tablet');
  const clip = dataUrl('video/mp4', 'veo', 1500);
  await pc.put(thread('t1', [{ ...ask('e1', T0, ''), kind: 'video', media: [{ type: 'video', src: clip }] }]));
  await online(pc);
  phone.conn = { type: 'cellular' }; tablet.conn = { type: 'wifi', saveData: true };
  await online(phone); await online(tablet);
  assert.equal(phone.get('t1'), undefined); assert.equal(tablet.get('t1'), undefined, 'Data Saver counts as mobile data');
  await phone.engine.setCellular(true); await settle(phone);
  assert.equal(phone.get('t1')?.entries[0].media[0].src, clip, 'the setting lets it come');
  tablet.conn = { type: 'wifi' }; tablet.engine.netChanged(); await settle(tablet);
  assert.equal(tablet.get('t1')?.entries[0].media[0].src, clip, 'Wi-Fi brings it');
});

test('videos: a phone on mobile data keeps a large new video until Wi-Fi (no upload), says so, and sends it once on Wi-Fi', async () => {
  const w = world();
  const phone = mediaDevice(w, 'phone'), pc = mediaDevice(w, 'pc');
  await online(pc);
  phone.conn = { type: 'cellular' };
  const clip = dataUrl('video/mp4', 'mine', 1500);
  await phone.put(thread('t1', [ask('e1', T0, 'text first'), { ...ask('e2', T0 + 1, ''), kind: 'video', media: [{ type: 'video', src: clip }] }]));
  await online(phone);
  assert.equal(w.requests(phone).filter((x) => x.method === 'PUT').length, 0, 'nothing uploaded over mobile data');
  assert.deepEqual(idsOf(w.doc('t1')), ['e1'], 'the text went up');
  assert.equal(phone.engine.badge(phone.get('t1')), ' · Waiting for Wi-Fi');
  assert.equal(statusLine(phone.engine.status(), w.clock.t), 'Waiting for Wi-Fi · 1 video (1.5 KB)');
  assert.equal(deviceOnly(phone.engine.status()), true, 'Clear this device warns');
  assert.deepEqual(await phone.engine.localReport(), { changes: 0, media: 1, other: 0, threads: 0 });
  assert.equal(await phone.engine.deleteCopy('t1'), COPY.deleteConfirm + COPY.deleteWaiting);
  phone.conn = { type: 'wifi' }; phone.engine.netChanged(); await settle(phone);
  assert.deepEqual(idsOf(w.doc('t1')), ['e1', 'e2'], 'on Wi-Fi it goes');
  assert.equal(w.requests(phone).filter((x) => x.method === 'PUT').length, 1);
  await sync(pc);
  assert.equal(pc.get('t1').entries[1].media[0].src, clip);
});

test('large videos: downloaded after the thread’s text, one at a time, each applied before the next is fetched', async () => {
  const w = world();
  const pc = mediaDevice(w, 'pc'), phone = mediaDevice(w, 'phone');
  const v1 = dataUrl('video/mp4', 'one', 5000), v2 = dataUrl('video/webm', 'two', 6000);
  await pc.put(thread('t1', [ask('e1', T0, 'text'), { ...ask('e2', T0 + 1, ''), kind: 'video', media: [{ type: 'video', src: v1 }] }, { ...ask('e3', T0 + 2, ''), kind: 'video', media: [{ type: 'video', src: v2 }] }]));
  await online(pc);
  const seen = [];
  phone.before = async (x) => {
    if (x.method === 'GET' && x.path.startsWith('blob/')) seen.push([x.path.slice(5, 13), idsOf(phone.get('t1'))]);
    return null;
  };
  await online(phone);
  assert.equal(seen.length, 2, JSON.stringify(seen));
  assert.deepEqual(seen.map((x) => x[1]), [['e1'], seen[0][0] === shaOf(v1).slice(0, 8) ? ['e1', 'e2'] : ['e1', 'e3']], 'text before any video; one applied before the next is fetched');
  assert.deepEqual(shape(phone.get('t1')), shape(pc.get('t1')));
  assert.deepEqual(await phone.store.entries('bc:'), [], 'the download cache is emptied once applied');
});

test('large videos: an interrupted download or a reload never fetches a finished blob again', async () => {
  const w = world();
  const pc = mediaDevice(w, 'pc');
  const v1 = dataUrl('video/mp4', 'one', 5000), v2 = dataUrl('video/mp4', 'two', 5200);
  await pc.put(thread('t1', [ask('e1', T0, 'text'), { ...ask('e2', T0 + 1, ''), kind: 'video', media: [{ type: 'video', src: v1 }, { type: 'video', src: v2 }] }]));
  await online(pc);
  const db = memDb(), store = memoryStore();
  let phone = mediaDevice(w, 'phone', { db, store });
  // the connection drops right after the first video arrived
  phone.before = async (x) => { if (x.method === 'GET' && x.path.includes(shaOf(v2))) throw new TypeError('Failed to fetch'); return null; };
  await online(phone);
  assert.deepEqual(idsOf(phone.get('t1')), ['e1']);
  assert.equal((await store.entries('bc:')).length, 1, 'the finished one waits in the cache');
  // the page reloads
  phone.engine.stop();
  phone = mediaDevice(w, 'phone', { db, store });
  await online(phone);
  assert.deepEqual(shape(phone.get('t1')), shape(pc.get('t1')));
  const gets = w.requests().filter((x) => x.dev === 'phone' && x.method === 'GET' && x.path.startsWith('blob/'));
  assert.equal(gets.filter((x) => x.path.includes(shaOf(v1))).length, 1, 'v1 downloaded once across the reload');
});

test('storage: downloads stop when the browser is 85% full (text still comes) and resume once there is room; a QuotaExceededError pauses them too', async () => {
  const w = world();
  const pc = mediaDevice(w, 'pc');
  await pc.put(thread('t1', [ask('e1', T0, 'text'), ask('e2', T0 + 1, 'pic', { images: [dataUrl('image/png', 'p', 300)] })]));
  await online(pc);
  let est = { usage: 90, quota: 100 };
  const phone = mediaDevice(w, 'phone', { engine: { estimate: async () => est } });
  await online(phone);
  assert.deepEqual(idsOf(phone.get('t1')), ['e1']);
  assert.equal(blobGets(w, phone).length, 0);
  assert.equal(statusLine(phone.engine.status(), w.clock.t), 'Storage almost full on this device · 1 item not downloaded');
  est = { usage: 10, quota: 1_000_000 };
  w.clock.t += 16 * MIN; await sync(phone);
  assert.deepEqual(idsOf(phone.get('t1')), ['e1', 'e2'], 'room again: it came');
  // the cache write itself is refused
  const tablet = mediaDevice(w, 'tablet');
  const set = tablet.store.set;
  tablet.store.set = async (k, v) => { if (k.startsWith('bc:')) { const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e; } return set.call(tablet.store, k, v); };
  await pc.put({ ...structuredClone(pc.get('t1')), entries: [...pc.get('t1').entries, { ...ask('e3', T0 + 2, ''), kind: 'video', media: [{ type: 'video', src: dataUrl('video/mp4', 'big', 5000) }] }] });
  await sync(pc);
  await online(tablet);
  assert.deepEqual(idsOf(tablet.get('t1')), ['e1', 'e2']);
  assert.equal(tablet.engine.status().storageFull, true);
  assert.equal(statusLine(tablet.engine.status(), w.clock.t), 'Storage almost full on this device · 1 item not downloaded');
});

test('a parked entry whose server version changed is let go; an edited same-length image is never mistaken for the old one', async () => {
  const w = world();
  const pc = mediaDevice(w, 'pc'), phone = mediaDevice(w, 'phone');
  await pc.put(thread('t1', [{ ...ask('e1', T0, ''), kind: 'video', media: [{ type: 'video', src: dataUrl('video/mp4', 'a', 1500) }] }]));
  await online(pc);
  phone.conn = { type: 'cellular' };
  await online(phone);
  assert.equal(phone.engine.noteFor('t1').n, 1);
  // the video is replaced on the pc by a text answer (a retry)
  const t = structuredClone(pc.get('t1')); t.entries[0] = { ...ask('e1', T0, 'a text answer instead') }; await pc.put(t); await sync(pc);
  w.clock.t += MIN; await sync(phone);
  assert.equal(phone.engine.noteFor('t1').n, 0, 'nothing waits any more');
  assert.equal(phone.get('t1').entries[0].text, 'a text answer instead');
  // same length, different bytes: the print memo must not reuse the old hash
  const img1 = dataUrl('image/png', 'x', 400), img2 = dataUrl('image/png', 'y', 400);
  assert.equal(img1.length, img2.length);
  const t2 = structuredClone(pc.get('t1')); t2.entries.push(ask('e2', T0 + 1, 'pic', { images: [img1] })); await pc.put(t2); await sync(pc);
  const t3 = structuredClone(pc.get('t1')); t3.entries[1].images = [img2]; await pc.put(t3); await sync(pc);
  assert.ok(await pc.store.get('hm:t1'), 'the print memo is kept');
  assert.equal(w.doc('t1').entries[1].d.images[0].$b, shaOf(img2), 'the new image went up');
  phone.conn = null; phone.engine.netChanged(); await settle(phone);
  w.clock.t += MIN; await sync(phone);
  assert.equal(phone.get('t1').entries[1].images[0], img2);
});

test('uploads: only one large blob is decoded and on the wire at a time', async () => {
  const w = world();
  const pc = mediaDevice(w, 'pc');
  let inFlight = 0, most = 0;
  pc.before = async (x) => {
    if (x.method !== 'PUT' || !(x.body?.byteLength > BUDGET.bigBlobBytes)) return null;
    inFlight++; most = Math.max(most, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return null;
  };
  await pc.put(thread('t1', [{ ...ask('e1', T0, ''), kind: 'video', media: [{ type: 'video', src: dataUrl('video/mp4', 'one', 5000) }, { type: 'video', src: dataUrl('video/mp4', 'two', 5100) }, { type: 'image', src: dataUrl('image/png', 'i', 100) }] }]));
  await online(pc);
  assert.equal(w.doc('t1').entries.length, 1);
  assert.equal(most, 1);
});

test('the Settings block and the banner over the open thread: Wi-Fi wait, Download now, the mobile-data switch', async () => {
  const w = world();
  const pc = mediaDevice(w, 'pc');
  await pc.put(thread('t1', [ask('e1', T0, 'text'), { ...ask('e2', T0 + 1, ''), kind: 'video', media: [{ type: 'video', src: dataUrl('video/mp4', 'v', 1500) }] }]));
  await online(pc);
  const doc = fakeDoc();
  const phone = mediaDevice(w, 'phone');
  phone.conn = { type: 'cellular' };
  const ui = bindUi(phone.engine, { toast: () => {}, getOpen: () => phone.open }, doc);
  await online(phone);
  phone.open = await phone.load('t1');
  ui.render(phone.engine.status());
  const $ = (s) => doc.querySelector(s);
  assert.equal($('#syncStatus').textContent, 'Waiting for Wi-Fi · 1 video (1.5 KB)');
  assert.equal($('#syncDownloadNow').hidden, false);
  assert.equal($('#syncCellRow').hidden, false, 'shown where the browser reports its network');
  assert.equal($('#syncNote').hidden, false);
  assert.equal($('#syncNote').children[0].textContent, '1 item in this thread is still downloading · Waiting for Wi-Fi');
  assert.equal($('#syncNote').children[1].textContent, 'Download now');
  $('#syncNote').children[1].click();
  await settle(phone);
  ui.render(phone.engine.status());
  assert.equal($('#syncNote').hidden, true, 'nothing left to download');
  assert.equal($('#syncDownloadNow').hidden, true);
  assert.equal(phone.get('t1').entries.length, 2);
  $('#syncCell').checked = true; $('#syncCell').fire('change');
  await settle(phone);
  assert.equal(phone.engine.config().videosOnCellular, true);
});

test('memory: one thread read brings in about planMediaBytes of media; the rest comes through the cache right after', async () => {
  const w = world();
  const pc = mediaDevice(w, 'pc');
  const imgs = ['a', 'b', 'c', 'd'].map((k) => dataUrl('image/png', k, 600));
  await pc.put(thread('t1', [ask('e0', T0, 'text'), ...imgs.map((src, i) => ask(`e${i + 1}`, T0 + i + 1, 'pic', { images: [src] }))]));
  await online(pc);
  const phone = mediaDevice(w, 'phone', { engine: { budget: { ...BUDGET, planMediaBytes: 1000 } } });
  const sizes = [];
  phone.before = async (x) => { if (x.method === 'GET' && x.path.startsWith('thread/t1')) sizes.push(idsOf(phone.get('t1')).length); return null; };
  await online(phone);
  assert.deepEqual(shape(phone.get('t1')), shape(pc.get('t1')), 'everything arrived');
  assert.ok(sizes.length >= 3, `read again as the cache filled: ${JSON.stringify(sizes)}`);
  assert.equal(blobGets(w, phone).length, 4, 'each image downloaded once');
  assert.deepEqual(await phone.store.entries('bc:'), []);
});

// ── media review (adversarial pass over phases 2-3) ──
const videoEntry = (id, at, src) => ({ ...ask(id, at, ''), kind: 'video', media: [{ type: 'video', src }] });
const getsOf = (w, dev, u) => blobGets(w, dev).filter((x) => x.path.includes(shaOf(u))).length;
const threadReads = (w, dev, id) => w.requests(dev).filter((x) => x.method === 'GET' && x.path.startsWith(`thread/${id}`)).length;

test('media review: a large download that keeps failing never stops the cycle finishing, and waits a backoff between tries', async () => {
  const w = world();
  const pc = mediaDevice(w, 'pc');
  const big = dataUrl('video/mp4', 'big', 5000), pic = dataUrl('image/png', 'pic', 3000);
  await pc.put(thread('t1', [ask('e1', T0, 'text'), videoEntry('e2', T0 + 1, big), ask('e3', T0 + 2, 'pic', { images: [pic] })]));
  await online(pc);
  const phone = mediaDevice(w, 'phone');
  phone.before = async (x) => { if (x.method === 'GET' && (x.path.includes(shaOf(big)) || x.path.includes(shaOf(pic)))) throw new TypeError('connection reset'); return null; };
  await online(phone);
  assert.equal(phone.engine.config().firstDone, true, 'the first sync finished');
  assert.ok(phone.engine.config().lastOkAt > 0);
  assert.deepEqual(idsOf(phone.get('t1')), ['e1'], 'the text is in; both media entries wait');
  for (let i = 0; i < 20; i++) { w.clock.t += MIN; await sync(phone); }
  assert.ok(getsOf(w, phone, big) <= 8, `large blob tried ${getsOf(w, phone, big)} times in 20 polls`);
  assert.ok(getsOf(w, phone, pic) <= 8, `small blob tried ${getsOf(w, phone, pic)} times in 20 polls`);
  assert.equal(phone.engine.status().errorKind, null, 'no error state from one bad blob');
  phone.before = null;
  phone.engine.kick('online'); // the network is back: failed downloads go again at once
  await settle(phone);
  assert.deepEqual(shape(phone.get('t1')), shape(pc.get('t1')));
});

test('media review: a blob the server lacks (404) is asked for with a backoff, not with a thread read and a GET every poll', async () => {
  const w = world();
  const pc = mediaDevice(w, 'pc');
  const big = dataUrl('video/mp4', 'gone', 5000), pic = dataUrl('image/png', 'gonepic', 300);
  await pc.put(thread('t1', [ask('e1', T0, 'text'), videoEntry('e2', T0 + 1, big), ask('e3', T0 + 2, 'pic', { images: [pic] })]));
  await online(pc);
  const phone = mediaDevice(w, 'phone');
  phone.before = async (x) => (x.method === 'GET' && (x.path.includes(shaOf(big)) || x.path.includes(shaOf(pic))) ? new Response('{"error":"Not found.","code":"not_found"}', { status: 404 }) : null);
  await online(phone);
  const reads0 = threadReads(w, phone, 't1'), gets0 = blobGets(w, phone).length;
  for (let i = 0; i < 10; i++) { w.clock.t += MIN; await sync(phone); }
  const reads = threadReads(w, phone, 't1') - reads0, gets = blobGets(w, phone).length - gets0;
  assert.ok(reads <= 4, `thread read ${reads} times in 10 polls`);
  assert.ok(gets <= 8, `missing blobs asked for ${gets} times in 10 polls`);
  assert.deepEqual(idsOf(phone.get('t1')), ['e1']);
  phone.before = null; // it turns up (another device uploads it again): the next read after the backoff brings it
  for (let i = 0; i < 8; i++) { w.clock.t += 10 * MIN; await sync(phone); }
  await settle(phone);
  assert.deepEqual(shape(phone.get('t1')), shape(pc.get('t1')));
});

test('media review: what a parked entry already downloaded stays in the cache through the first sweep (downloaded once)', async () => {
  const w = world();
  const pc = mediaDevice(w, 'pc');
  const still = dataUrl('image/png', 'poster', 300), clip = dataUrl('video/mp4', 'veo', 1500);
  await pc.put(thread('t1', [ask('e1', T0, 'text'), { ...videoEntry('e2', T0 + 1, clip), media: [{ type: 'video', src: clip, still }] }]));
  await online(pc);
  const phone = mediaDevice(w, 'phone');
  phone.conn = { type: 'cellular' };
  await online(phone);
  assert.deepEqual(idsOf(phone.get('t1')), ['e1'], 'the video entry waits for Wi-Fi');
  phone.conn = { type: 'wifi' }; phone.engine.netChanged();
  await settle(phone);
  assert.deepEqual(shape(phone.get('t1')), shape(pc.get('t1')));
  assert.equal(getsOf(w, phone, still), 1, 'the poster came down once');
  assert.deepEqual(await phone.store.entries('bc:'), [], 'and the cache is empty once applied');
});

test('media review: editing an entry whose newer server version waits for Wi-Fi costs no request per poll; both versions are kept', async () => {
  const w = world();
  const pc = mediaDevice(w, 'pc'), phone = mediaDevice(w, 'phone');
  await pc.put(thread('t1', [ask('e1', T0, 'text'), ask('e2', T0 + 1, 'v1')]));
  await online(pc); await online(phone);
  let t = structuredClone(pc.get('t1'));
  t.entries[1] = { ...t.entries[1], kind: 'video', text: '', media: [{ type: 'video', src: dataUrl('video/mp4', 'v2', 1500) }] }; t.updatedAt = T0 + 10;
  await pc.put(t); await sync(pc);
  phone.conn = { type: 'cellular' };
  w.clock.t += MIN; await sync(phone);
  t = structuredClone(phone.get('t1')); t.entries[1].text = 'v1 edited on the phone'; t.updatedAt = T0 + 20;
  await phone.put(t);
  w.clock.t += MIN; await sync(phone);
  const n0 = w.requests(phone).length;
  for (let i = 0; i < 5; i++) { w.clock.t += MIN; await sync(phone); }
  const extra = w.requests(phone).slice(n0).filter((x) => !(x.method === 'GET' && x.path === 'index'));
  assert.deepEqual(extra.map((x) => `${x.method} ${x.path}`), [], 'only the index is read while the video waits');
  phone.conn = { type: 'wifi' }; phone.engine.netChanged();
  await settle(phone); await sync(phone); await sync(pc);
  for (const dev of [phone, pc]) {
    const es = dev.get('t1').entries;
    assert.ok(es.some((e) => e.id === 'e2' && e.media?.length), `${dev.name} has the video`);
    assert.ok(es.some((e) => e.text === 'v1 edited on the phone'), `${dev.name} has the phone's edit`);
  }
  assert.deepEqual(shape(phone.get('t1')), shape(pc.get('t1')));
});

test('media review: a full disk while writing a pulled thread pauses media downloads instead of fetching everything again', async () => {
  const w = world();
  const pc = mediaDevice(w, 'pc');
  const pic = dataUrl('image/png', 'pic', 3000);
  await pc.put(thread('t1', [ask('e1', T0, 'text'), ask('e2', T0 + 1, 'pic', { images: [pic] })]));
  await online(pc);
  const phone = mediaDevice(w, 'phone');
  const update = phone.db.update;
  phone.db.update = async () => { const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e; };
  await online(phone);
  for (let i = 0; i < 10; i++) { w.clock.t += 6 * MIN; await sync(phone); }
  assert.ok(getsOf(w, phone, pic) <= 2, `image downloaded ${getsOf(w, phone, pic)} times`);
  phone.db.update = update;
  w.clock.t += 20 * MIN;
  await sync(phone); await settle(phone);
  assert.deepEqual(shape(phone.get('t1')), shape(pc.get('t1')), 'room again: everything arrives');
});

test('media review: a video held for Wi-Fi goes up after a reload on Wi-Fi (no network change event needed)', async () => {
  const w = world();
  const db = memDb(), store = memoryStore();
  let phone = mediaDevice(w, 'phone', { db, store });
  await phone.put(thread('t1', [ask('e1', T0, 'text'), ask('e2', T0 + 1, 'old answer')]));
  await online(phone);
  phone.conn = { type: 'cellular' };
  const t = structuredClone(phone.get('t1'));
  t.entries[1] = { ...t.entries[1], kind: 'video', text: '', media: [{ type: 'video', src: dataUrl('video/mp4', 'regen', 1500) }] }; t.updatedAt = T0 + 5;
  await phone.put(t); await sync(phone);
  assert.equal(w.doc('t1').entries[1].d.text, 'old answer', 'held on mobile data');
  phone.engine.stop();
  phone = mediaDevice(w, 'phone', { db, store }); // reloaded, on Wi-Fi now
  w.clock.t += MIN;
  await online(phone); await settle(phone);
  assert.ok(w.doc('t1').entries[1].d.media, 'the regenerated video went up');
  assert.equal(phone.engine.record('t1').held || 0, 0);
});

test('media review: the delete-everywhere question warns about a held video on an entry the server knows in an older version', async () => {
  const w = world();
  const phone = mediaDevice(w, 'phone');
  await phone.put(thread('t1', [ask('e1', T0, 'text'), ask('e2', T0 + 1, 'old answer')]));
  await online(phone);
  phone.conn = { type: 'cellular' };
  const t = structuredClone(phone.get('t1'));
  t.entries[1] = { ...t.entries[1], kind: 'video', text: '', media: [{ type: 'video', src: dataUrl('video/mp4', 'regen', 1500) }] }; t.updatedAt = T0 + 5;
  await phone.put(t); await sync(phone);
  const copy = await phone.engine.deleteCopy('t1');
  assert.ok(copy.includes(COPY.deleteWaiting), copy);
});

test('media review: when the Web Locks can’t be read, a pending entry is never taken for an interrupted one', async () => {
  const w = world();
  const locks = fakeLocks();
  const pc = device(w, 'pc'), phone = device(w, 'phone', { locks });
  await pc.put(thread('t1', [ask('e1', T0, 'text'), ask('e2', T0 + 1, 'v1')]));
  await online(pc); await online(phone);
  let t = structuredClone(pc.get('t1')); t.entries[1].text = 'v2 from pc'; t.updatedAt = T0 + 10; await pc.put(t); await sync(pc);
  let release;
  locks.request('atelier-run:e2', () => new Promise((r) => { release = r; }));
  await tick();
  t = structuredClone(phone.get('t1')); t.entries[1] = { ...t.entries[1], pending: true, text: 'partial stream…' }; await phone.db.put(t);
  locks.query = async () => { throw new Error('SecurityError'); };
  w.clock.t += MIN; await sync(phone);
  assert.deepEqual(phone.get('t1').entries.map((e) => [e.id, e.text, e.pending ?? null]), [['e1', 'text', null], ['e2', 'partial stream…', true]]);
  release();
});

test('media review: a thread that changes while its media downloads is planned again without downloading the media again', async () => {
  const w = world();
  const pc = mediaDevice(w, 'pc'), phone = mediaDevice(w, 'phone');
  await pc.put(thread('t1', [ask('e1', T0, 'text')]));
  await online(pc); await online(phone);
  const pic = dataUrl('image/png', 'pic', 3000);
  const t = structuredClone(pc.get('t1')); t.entries.push(ask('e2', T0 + 1, 'pic', { images: [pic] })); t.updatedAt = T0 + 2;
  await pc.put(t); await sync(pc);
  let once = false;
  phone.before = async (x) => {
    if (!once && x.method === 'GET' && x.path.includes(shaOf(pic))) {
      once = true; // the user sends a turn on the phone while the image is on its way
      const p = structuredClone(phone.get('t1')); p.entries.push(ask('e9', T0 + 3, 'typed meanwhile')); p.updatedAt = T0 + 3;
      await phone.put(p);
    }
    return null;
  };
  w.clock.t += MIN; await sync(phone); await settle(phone);
  assert.equal(getsOf(w, phone, pic), 1, 'downloaded once');
  assert.deepEqual(idsOf(phone.get('t1')), ['e1', 'e2', 'e9']);
});

test('media review: a large video planned on Wi-Fi isn’t uploaded once the phone is on mobile data; it goes when Wi-Fi is back', async () => {
  const w = world();
  const phone = mediaDevice(w, 'phone');
  await phone.put(thread('t1', [ask('e1', T0, 'text')]));
  await online(phone);
  const clip = dataUrl('video/mp4', 'clip', 1500);
  const t = structuredClone(phone.get('t1')); t.entries.push(videoEntry('e2', T0 + 1, clip)); t.updatedAt = T0 + 2;
  await phone.put(t);
  phone.before = async (x) => { if (x.method === 'POST' && x.path === 'blobs/missing') phone.conn = { type: 'cellular' }; return null; };
  w.clock.t += MIN; await push(phone);
  const puts = () => w.requests(phone).filter((x) => x.method === 'PUT' && x.path.includes(shaOf(clip))).length;
  assert.equal(puts(), 0, 'no upload on mobile data');
  assert.deepEqual(idsOf(w.doc('t1')), ['e1']);
  assert.equal(phone.engine.status().upWifi, 1, 'shown as waiting for Wi-Fi');
  assert.equal(phone.engine.record('t1').held, 1, 'remembered across a reload');
  phone.before = null; phone.conn = { type: 'wifi' }; phone.engine.netChanged();
  await settle(phone);
  assert.equal(puts(), 1);
  assert.deepEqual(idsOf(w.doc('t1')), ['e1', 'e2']);
});
