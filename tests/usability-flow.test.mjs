// Run the actual app storage/account lifecycle functions with minimal browser adapters. This tests behavior during
// delayed IndexedDB operations and role transitions, without providers or a second copy of the implementation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeMe, allowedIds } from '../public/tester.js';
const APP = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const SYNC = await readFile(new URL('../public/sync.js', import.meta.url), 'utf8');
function between(text, start, end) {
  const a = text.indexOf(start), b = text.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(`Lifecycle fixture cannot locate ${start}`);
  return text.slice(a, b);
}
const workspaceSource = between(APP, 'const workspaceOf =', '// This browser was used');
const rawDbSource = between(APP, 'const rawDB = (() =>', '// One-time copy of threads');
const persistSource = between(APP, 'let persistTimer;', 'function storageError');
const rolesSource = between(APP, 'function syncRole()', '// GET /api/tester/me');
const wrapSource = between(SYNC, 'export function wrapDb(rawDB)', '// Called once at boot.').replace(/^export /, '');
const selectSource = between(APP, 'function selectOpt(', 'function modelChoices');
const composerSource = between(APP, 'function renderComposerControls()', "$('#essentialOptions').addEventListener('click'");
const person = (sub, extra = {}) => normalizeMe({ sub, name: `Name ${sub}`, models: { chat: ['anthropic:claude-sonnet-5-5'] }, ...extra });
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

function lifecycle({ passcode = '', tester = null } = {}) {
  const events = [], opened = [], pending = [], values = new Map(), timers = new Map(), settings = new Map(), listeners = {};
  const S = { settings: { passcode, name: tester?.name || '', lookup: '' }, tester, thread: { id: 'current', entries: [{ id: 'entry', text: 'Saved reply' }] } };
  settings.set('settings', structuredClone(S.settings)); settings.set('tester', structuredClone(tester));
  class Request { constructor(result) { this.result = result; } }
  const indexedDB = {
    open(name) {
      opened.push(name);
      const request = {};
      pending.push(() => {
        request.result = { close() {}, objectStoreNames: { contains: () => true }, transaction(store) {
          const transaction = { objectStore() { return {
            put(value, key) { values.set(`${name}:${store}:${key || value.id}`, structuredClone(value)); events.push(`write:${name}`); return new Request(value.id); },
            get(key) { return new Request(values.get(`${name}:${store}:${key}`)); },
            getAll() { return new Request([...values.entries()].filter(([key]) => key.startsWith(`${name}:${store}:`)).map(([, value]) => structuredClone(value))); },
            getAllKeys() { return new Request([...values.keys()].filter((key) => key.startsWith(`${name}:${store}:`)).map((key) => key.split(':').at(-1))); },
            delete(key) { values.delete(`${name}:${store}:${key}`); return new Request(undefined); },
            clear() { for (const key of values.keys()) if (key.startsWith(`${name}:${store}:`)) values.delete(key); return new Request(undefined); },
          }; } };
          queueMicrotask(() => transaction.oncomplete?.());
          return transaction;
        } };
        request.onsuccess();
      });
      return request;
    },
  };
  const node = { hidden: true, open: false, contains: () => false, classList: { contains: () => false } };
  const deps = {
    S, indexedDB, IDBRequest: Request, IDBKeyRange: { bound: () => ({}) },
    Sync: { wrapDb: (db) => db, suspend: () => events.push('suspend-sync') },
    stopAll: () => events.push('stop-runs'), toast: () => {},
    setTimeout: (fn) => { const id = timers.size + 1; timers.set(id, fn); return id; }, clearTimeout: (id) => { timers.delete(id); events.push('cancel-persist'); },
    sessionStorage: { setItem: (key, value) => { settings.set(key, value); events.push('resume-marker'); } }, location: { reload: () => events.push('reload') },
    LS: { get: (key, fallback) => settings.get(key) ?? fallback, set: (key, value) => settings.set(key, structuredClone(value)) },
    normalizeMe, allowedIds, reader: { clearCache: () => events.push('clear-reader') }, deadProviders: new Set(),
    document: { body: { classList: { toggle: () => events.push('render-role') } }, activeElement: null }, $: () => node,
    window: { addEventListener: (name, handler) => { listeners[name] = handler; } },
    syncLaunchRole: () => '', roleOf: () => '', launchWiped: () => {}, syncMic: () => events.push('render-mic'),
    loadMe: () => { events.push('read-profile'); return {}; }, setSync: () => {},
    saveSettings: () => { settings.set('settings', structuredClone(S.settings)); events.push('save-settings'); }, renderWelcome: () => {}, renderYou: () => {}, selectSettings: () => {},
    renderAllowance: () => {}, updateKeyState: () => {}, renderOptions: () => events.push('render-options'),
    renderTesterAccess: () => {}, renderReadAloud: () => {}, retitleReads: () => {}, storageError: (err) => { throw err; },
  };
  const create = new Function(...Object.keys(deps), `let testerAllow = allowedIds(S.tester), ME = {};
    ${workspaceSource}\n${rawDbSource}\n${persistSource}\n${rolesSource}
    return { workspace, threadDbName, workspaceKey, rawDB, persist, reloadWorkspace, syncRole, setTester, reloading: () => accountReloading };`);
  const api = create(...Object.values(deps));
  return { ...api, S, events, opened, values, settings, timers, dispatchStorage: (key) => listeners.storage?.({ key }), flushOpen: () => { while (pending.length) pending.shift()(); }, flushTimers: () => { for (const fn of timers.values()) fn(); timers.clear(); } };
}

test('owner, guest and individual tester workspaces open distinct thread databases and retain independent navigation keys', async () => {
  const pages = [lifecycle({ passcode: 'owner-pass', tester: person('ignored') }), lifecycle(), lifecycle({ tester: person('person-a') }), lifecycle({ tester: person('person-b') })];
  assert.deepEqual(pages.map((page) => page.workspace), ['owner', 'guest', 'tester:person-a', 'tester:person-b']);
  assert.deepEqual(pages.map((page) => page.threadDbName), ['atelier-data', 'atelier-guest', 'atelier-account-person-a', 'atelier-account-person-b']);
  assert.equal(new Set(pages.map((page) => page.workspaceKey('lastThread'))).size, 4);
  assert.equal(new Set(pages.map((page) => page.workspaceKey('pinnedThreads'))).size, 4);
  for (const page of pages) {
    const write = page.rawDB.put({ id: 'same-id', title: page.workspace, entries: [] });
    page.flushOpen(); await write;
    assert.deepEqual(page.opened, [page.threadDbName]);
    assert.equal(page.values.get(`${page.threadDbName}:threads:same-id`).title, page.workspace);
  }
});

test('a delayed thread write remains bound to its original account even when another identity is selected before IndexedDB opens', async () => {
  const page = lifecycle({ tester: person('person-a') });
  const pending = page.rawDB.put({ id: 'account-a-work', entries: [] });
  page.S.tester = person('person-b');
  assert.equal(page.reloadWorkspace(), true);
  page.flushOpen(); await pending;
  assert.deepEqual(page.opened, ['atelier-account-person-a']);
  assert.ok(page.values.has('atelier-account-person-a:threads:account-a-work'));
  assert.ok(!page.values.has('atelier-account-person-b:threads:account-a-work'));
});

test('account transition stops runs and sync, cancels pending saves, clears the visible thread and reloads once', () => {
  const page = lifecycle({ tester: person('person-a') });
  page.persist();
  assert.equal(page.timers.size, 1);
  page.S.tester = person('person-b');
  assert.equal(page.reloadWorkspace(), true);
  assert.equal(page.reloadWorkspace(), true); // repeated callers still exit while the navigation is pending
  assert.equal(page.reloading(), true);
  assert.equal(page.S.thread, null);
  assert.equal(page.timers.size, 0);
  assert.equal(page.settings.get('atelier.accountResume'), '1');
  assert.equal(page.events.filter((event) => event === 'reload').length, 1);
  assert.ok(page.events.indexOf('stop-runs') < page.events.indexOf('reload'));
  assert.ok(page.events.indexOf('suspend-sync') < page.events.indexOf('reload'));
  assert.ok(page.events.indexOf('save-settings') < page.events.indexOf('reload'));
  page.flushTimers();
  assert.equal(page.opened.length, 0);
});

test('even an already queued persist callback cannot save after the account has begun reloading', () => {
  const page = lifecycle({ tester: person('person-a') });
  page.persist(); const callback = [...page.timers.values()][0];
  page.S.tester = null; page.reloadWorkspace(); callback();
  page.S.thread = { id: 'late-run', entries: [{ id: 'late', text: 'Late provider callback' }] };
  page.persist(true);
  assert.equal(page.opened.length, 0);
});

test('refreshing the same tester preserves its workspace, while changing tester identity reloads before reading profile or repainting options', () => {
  const page = lifecycle({ tester: person('person-a') });
  page.setTester({ sub: 'person-a', name: 'Updated name', models: { chat: ['anthropic:claude-sonnet-5-5'] } });
  assert.equal(page.reloading(), false);
  assert.equal(page.S.tester.name, 'Updated name');
  page.events.length = 0;
  page.setTester({ sub: 'person-b', name: 'Another tester' });
  assert.equal(page.reloading(), true);
  assert.ok(!page.events.includes('read-profile'));
  assert.ok(!page.events.includes('render-options'));
});

test('switching between guest/tester/owner always reloads instead of presenting data from the prior workspace', () => {
  const guest = lifecycle(); guest.setTester({ sub: 'person-a' }); assert.equal(guest.reloading(), true);
  const tester = lifecycle({ tester: person('person-a') }); tester.setTester(null); assert.equal(tester.reloading(), true);
  const owner = lifecycle({ passcode: 'owner-pass' }); owner.S.settings.passcode = ''; owner.syncRole(); assert.equal(owner.reloading(), true);
  const becomingOwner = lifecycle({ tester: person('person-a') }); becomingOwner.S.settings.passcode = 'owner-pass'; becomingOwner.syncRole(); assert.equal(becomingOwner.reloading(), true);
  assert.equal(becomingOwner.settings.get('settings').passcode, 'owner-pass');
});

test('tester continuity is offered only when the server explicitly enables it, including conservative behavior for cached records', () => {
  assert.equal(person('person-a', { features: { sync: true } }).features.sync, true);
  assert.equal(person('person-a', { features: { sync: false } }).features.sync, false);
  assert.equal(person('person-a', { features: { sync: 'true' } }).features.sync, false);
  assert.equal(person('person-a').features.sync, false);
});

test('a cross-tab owner-to-tester switch clears cached owner credentials and suspends work without overwriting the newly stored account', () => {
  const page = lifecycle({ passcode: 'cached-owner-pass' });
  page.persist();
  const latestSettings = { passcode: '', name: 'New tester', theme: 'paper' };
  page.settings.set('settings', structuredClone(latestSettings));
  page.settings.set('tester', person('person-b'));
  page.dispatchStorage('atelier.settings');
  assert.equal(page.reloading(), true);
  assert.equal(page.S.settings.passcode, '');
  assert.equal(page.S.tester.sub, 'person-b');
  assert.equal(page.S.thread, null);
  assert.equal(page.timers.size, 0);
  assert.ok(page.events.includes('stop-runs'));
  assert.ok(page.events.includes('suspend-sync'));
  assert.ok(!page.events.includes('save-settings'));
  assert.ok(!page.events.includes('resume-marker'));
  assert.deepEqual(page.settings.get('settings'), latestSettings);
  assert.equal(page.events.filter((event) => event === 'reload').length, 1);
});

test('cross-tab tester changes and cleared browser storage reload, while unrelated changes and same-account refreshes preserve the active workspace', () => {
  const same = lifecycle({ tester: person('person-a') });
  same.settings.set('tester', person('person-a', { name: 'Updated account name' }));
  same.dispatchStorage('atelier.tester');
  same.dispatchStorage('atelier.opts');
  assert.equal(same.reloading(), false);
  const changed = lifecycle({ tester: person('person-a') });
  changed.settings.set('tester', person('person-b'));
  changed.dispatchStorage('atelier.tester');
  assert.equal(changed.reloading(), true);
  assert.equal(changed.S.tester.sub, 'person-b');
  assert.ok(!changed.events.includes('read-profile'));
  const cleared = lifecycle({ passcode: 'owner-pass' });
  cleared.settings.clear(); cleared.dispatchStorage(null);
  assert.equal(cleared.reloading(), true);
  assert.equal(cleared.S.settings.passcode, '');
  assert.equal(cleared.S.tester, null);
});

test('an owner passcode changed in another tab reloads even though the workspace role stays owner', () => {
  const page = lifecycle({ passcode: 'old-owner-pass' });
  page.settings.set('settings', { passcode: 'new-owner-pass' });
  page.dispatchStorage('atelier.settings');
  assert.equal(page.reloading(), true);
  assert.equal(page.S.settings.passcode, 'new-owner-pass');
  assert.equal(page.settings.get('settings').passcode, 'new-owner-pass');
  assert.ok(!page.events.includes('save-settings'));
});

test('sync wrapper captures the original engine before an awaited write; a new account receives neither its dirty marker nor read notification', async () => {
  const pendingWrite = defer(), pendingRead = defer(), early = [], inflight = new Set(), notes = { a: [], b: [] };
  const rawA = { put: () => pendingWrite.promise, get: () => pendingRead.promise }, rawB = {};
  const engineFor = (name) => ({ intent: async () => {}, saveThread: () => pendingWrite.promise, noteWrite: (ids) => notes[name].push(['write', ids]), noteRead: (thread) => notes[name].push(['read', thread.id]) });
  const a = engineFor('a'), b = engineFor('b');
  const make = new Function('engine', 'bootDeps', 'early', 'inflight', `${wrapSource}; return { wrapDb, switchTo: (next, db) => { engine = next; bootDeps = { rawDB: db }; } };`);
  const state = make(a, { rawDB: rawA }, early, inflight), wrapped = state.wrapDb(rawA);
  const write = wrapped.put({ id: 'a-only' }), read = wrapped.get('a-only');
  state.switchTo(b, rawB);
  pendingWrite.resolve('saved'); pendingRead.resolve({ id: 'a-only' });
  await Promise.all([write, read]);
  assert.deepEqual(notes.a, [['write', ['a-only']], ['read', 'a-only']]);
  assert.deepEqual(notes.b, []);
  assert.equal(inflight.size, 0);
});

test('the compact composer preserves a user’s current choices when it copies controls whose original HTML still holds older selected attributes', () => {
  const cases = [
    { mode: 'image', key: 'aspect', values: ['1:1', '16:9'], initial: '1:1', live: '16:9' },
    { mode: 'video', key: 'secs', values: [4, 8], initial: 4, live: 8 },
    { mode: 'ideas', key: 'count', values: [6, 9], initial: 6, live: 9 },
    { mode: 'build', key: 'style', values: ['Refined', 'Playful'], initial: 'Refined', live: 'Playful' },
  ];
  const esc = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const selectOpt = new Function('esc', `${selectSource}; return selectOpt;`)(esc);
  for (const item of cases) {
    const html = selectOpt('', item.key, item.values.map((value) => [value, String(value)]), item.initial);
    const original = { value: String(item.live), closest: () => ({ outerHTML: html }) }, advanced = {}, clones = [];
    const box = { set innerHTML(markup) {
      clones.length = 0;
      for (const match of markup.matchAll(/<select\b[^>]*data-essential-opt="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
        const options = [...match[2].matchAll(/<option\b([^>]*)>/g)];
        const selected = options.find((option) => /\bselected\b/.test(option[1])) || options[0];
        const initial = /value="([^"]*)"/.exec(selected?.[1] || '')?.[1] || '';
        clones.push({ dataset: { essentialOpt: match[1] }, initial, value: initial });
      }
    } };
    const $ = (selector) => selector === '#essentialOptions' ? box : selector === '#options' ? advanced : selector === `[data-opt="${item.key}"]` ? original : null;
    const render = new Function('S', '$', '$$', 'esc', 'renderContextChips', `${composerSource}; return renderComposerControls;`)({ mode: item.mode, video: null }, $, () => clones, esc, () => {});
    render();
    const control = clones.find((clone) => clone.dataset.essentialOpt === item.key);
    assert.ok(control, `${item.mode} keeps its essential control available`);
    assert.equal(control.initial, String(item.initial));
    assert.equal(control.value, String(item.live), `${item.mode} keeps the current user choice`);
    original.value = String(item.initial); render();
    assert.equal(clones.find((clone) => clone.dataset.essentialOpt === item.key).value, String(item.initial));
  }
});
