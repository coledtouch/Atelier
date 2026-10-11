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

// storedValues: IndexedDB rows shared between pages (one browser profile); lsValues: its localStorage, likewise.
// failOpen(name) → true: that database's open fails; failPut(name) → an Error: a put there aborts its transaction with it.
// appStore: Build app data (appdata.js) as reloadWorkspace sees it — busy() while a write hasn't reached IndexedDB.
function lifecycle({ passcode = '', tester = null, storedValues, lsValues, cryptoOverride, failOpen = () => false, failPut = () => null, appStore = { busy: () => false, flush: () => Promise.resolve() } } = {}) {
  const events = [], opened = [], pending = [], values = storedValues || new Map(), timers = new Map(), settings = lsValues || new Map(), listeners = {};
  const S = { settings: { passcode, name: tester?.name || '', lookup: '' }, tester, thread: { id: 'current', entries: [{ id: 'entry', text: 'Saved reply' }] } };
  if (!lsValues) { settings.set('settings', structuredClone(S.settings)); settings.set('tester', structuredClone(tester)); }
  class Request { constructor(result) { this.result = result; } }
  const indexedDB = {
    open(name) {
      opened.push(name);
      const request = {};
      if (failOpen(name)) { pending.push(() => { request.error = new Error(`Couldn’t open ${name}`); request.onerror(); }); return request; }
      pending.push(() => {
        request.result = { close() {}, objectStoreNames: { contains: () => true }, transaction(store) {
          const transaction = { objectStore() { return {
            put(value, key) {
              const err = failPut(name);
              if (err) { transaction.error = err; transaction.abort(); return new Request(undefined); }
              values.set(`${name}:${store}:${key ?? value.id}`, structuredClone(value)); events.push(`write:${name}`); return new Request(value.id);
            },
            get(key) { const request = new Request(structuredClone(values.get(`${name}:${store}:${key}`))); queueMicrotask(() => request.onsuccess?.()); return request; },
            getAll() { return new Request([...values.entries()].filter(([key]) => key.startsWith(`${name}:${store}:`)).map(([, value]) => structuredClone(value))); },
            getAllKeys() { const prefix = `${name}:${store}:`, request = new Request([...values.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length))); queueMicrotask(() => request.onsuccess?.()); return request; },
            delete(key) { values.delete(`${name}:${store}:${key}`); return new Request(undefined); },
            clear() { for (const key of values.keys()) if (key.startsWith(`${name}:${store}:`)) values.delete(key); return new Request(undefined); },
          }; } };
          transaction.abort = () => { if (transaction.aborted) return; transaction.aborted = true; queueMicrotask(() => transaction.onabort?.()); };
          setImmediate(() => { if (!transaction.aborted) transaction.oncomplete?.(); });
          return transaction;
        } };
        request.onsuccess();
      });
      return request;
    },
  };
  const node = { hidden: true, open: false, contains: () => false, classList: { contains: () => false } };
  const deps = {
    S, indexedDB, IDBRequest: Request, IDBKeyRange: { bound: () => ({}) }, crypto: cryptoOverride || globalThis.crypto, appStore,
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
  const settle = async (promise) => {
    let done = false, result, error;
    promise.then((value) => { result = value; done = true; }, (err) => { error = err; done = true; });
    const until = Date.now() + 5000;
    while (!done && Date.now() < until) { while (pending.length) pending.shift()(); await new Promise(setImmediate); }
    if (!done) throw new Error('Lifecycle fixture did not finish its storage operation');
    if (error) throw error;
    return result;
  };
  // Resolves once the page has reloaded (the reload waits for the flush of the open thread).
  const reloaded = () => settle(new Promise((resolve) => { const check = () => (events.includes('reload') ? resolve() : setImmediate(check)); check(); }));
  return { ...api, S, events, opened, values, settings, timers, settle, reloaded, dispatchStorage: (key) => listeners.storage?.({ key }), flushOpen: () => { while (pending.length) pending.shift()(); }, flushTimers: () => { for (const fn of timers.values()) fn(); timers.clear(); } };
}

test('owner, guest and individual tester workspaces open distinct thread databases and retain independent navigation keys', async () => {
  const pages = [lifecycle({ passcode: 'owner-pass', tester: person('ignored') }), lifecycle(), lifecycle({ tester: person('person-a') }), lifecycle({ tester: person('person-b') })];
  assert.deepEqual(pages.map((page) => page.workspace), ['owner', 'guest', 'tester:person-a', 'tester:person-b']);
  assert.deepEqual(pages.map((page) => page.threadDbName), ['atelier-data', 'atelier-guest', 'atelier-account-person-a', 'atelier-account-person-b']);
  assert.equal(new Set(pages.map((page) => page.workspaceKey('lastThread'))).size, 4);
  assert.equal(new Set(pages.map((page) => page.workspaceKey('pinnedThreads'))).size, 4);
  for (const page of pages) {
    const write = page.rawDB.put({ id: 'same-id', title: page.workspace, entries: [] });
    await page.settle(write);
    assert.deepEqual(page.opened, page.workspace === 'owner' ? ['atelier-shared-history-v76', page.threadDbName] : [page.threadDbName]);
    assert.equal(page.values.get(`${page.threadDbName}:threads:same-id`).title, page.workspace);
  }
});

test('a delayed thread write remains bound to its original account even when another identity is selected before IndexedDB opens', async () => {
  const page = lifecycle({ tester: person('person-a') });
  const pending = page.rawDB.put({ id: 'account-a-work', entries: [] });
  page.S.tester = person('person-b');
  assert.equal(page.reloadWorkspace(), true);
  await page.settle(pending);
  assert.deepEqual(page.opened, ['atelier-account-person-a']);
  assert.ok(page.values.has('atelier-account-person-a:threads:account-a-work'));
  assert.ok(!page.values.has('atelier-account-person-b:threads:account-a-work'));
});

test('account transition stops runs, saves the debounced edit into the old workspace, suspends sync, clears the visible thread and reloads once', async () => {
  const page = lifecycle({ tester: person('person-a') });
  page.S.thread.entries[0].text = 'Edited 100 ms ago'; page.persist(); // still inside the 400 ms debounce
  assert.equal(page.timers.size, 1);
  page.S.tester = person('person-b');
  assert.equal(page.reloadWorkspace(), true);
  assert.equal(page.reloadWorkspace(), true); // repeated callers still exit while the navigation is pending
  assert.equal(page.reloading(), true);
  assert.equal(page.S.thread, null);
  assert.equal(page.settings.get('atelier.accountResume'), '1');
  assert.ok(!page.events.includes('reload'), 'the reload waits for the save');
  await page.reloaded();
  assert.equal(page.values.get('atelier-account-person-a:threads:current').entries[0].text, 'Edited 100 ms ago');
  assert.deepEqual(page.opened, ['atelier-account-person-a'], 'never the next account’s database');
  assert.equal(page.events.filter((event) => event === 'reload').length, 1);
  for (const before of ['stop-runs', 'write:atelier-account-person-a', 'suspend-sync', 'save-settings']) assert.ok(page.events.indexOf(before) < page.events.indexOf('reload'), before);
  assert.ok(page.events.indexOf('stop-runs') < page.events.indexOf('suspend-sync'));
  page.flushTimers(); // the 2 s fallback finds the page already reloading
  assert.equal(page.events.filter((event) => event === 'reload').length, 1);
  assert.equal(page.events.filter((event) => event.startsWith('write:')).length, 1);
});

test('a save that never finishes holds the reload for at most 2 s', () => {
  const page = lifecycle({ tester: person('person-a') });
  page.S.tester = person('person-b');
  page.reloadWorkspace(); // the open never completes (no flushOpen)
  assert.ok(!page.events.includes('reload'));
  page.flushTimers();
  assert.equal(page.events.filter((event) => event === 'reload').length, 1);
});

test('a Build app’s write still on its way to IndexedDB holds the reload until it lands (at most 2 s)', async () => {
  let land; const flushing = new Promise((r) => { land = r; });
  const calls = [];
  const page = lifecycle({ tester: person('person-a'), appStore: { busy: () => true, flush: () => { calls.push('flush'); return flushing; } } });
  page.S.thread = { id: 'empty', entries: [] }; // no thread save: only the app's write holds it
  page.S.tester = person('person-b'); page.reloadWorkspace();
  assert.deepEqual(calls, ['flush']);
  await new Promise(setImmediate);
  assert.ok(!page.events.includes('reload'), 'the page that would lose the write is still here');
  land(); await page.reloaded();
  assert.equal(page.events.filter((event) => event === 'reload').length, 1);
  const stuck = lifecycle({ tester: person('person-a'), appStore: { busy: () => true, flush: () => new Promise(() => {}) } });
  stuck.S.thread = { id: 'empty', entries: [] };
  stuck.S.tester = person('person-b'); stuck.reloadWorkspace();
  stuck.flushTimers(); // the 2 s fallback
  assert.equal(stuck.events.filter((event) => event === 'reload').length, 1);
});

test('with nothing to save the reload is immediate', () => {
  const page = lifecycle({ tester: person('person-a') });
  page.S.thread = { id: 'empty', entries: [] };
  page.S.tester = person('person-b'); page.reloadWorkspace();
  assert.equal(page.events.filter((event) => event === 'reload').length, 1);
  assert.equal(page.opened.length, 0);
});

test('even an already queued persist callback cannot save after the account has begun reloading', async () => {
  const page = lifecycle({ tester: person('person-a') });
  page.persist(); const callback = [...page.timers.values()][0];
  page.S.tester = null; page.reloadWorkspace(); callback();
  page.S.thread = { id: 'late-run', entries: [{ id: 'late', text: 'Late provider callback' }] };
  page.persist(true);
  await page.reloaded();
  assert.ok(page.values.has('atelier-account-person-a:threads:current'), 'the flush itself saved the open thread');
  assert.equal(page.events.filter((event) => event.startsWith('write:')).length, 1, 'the queued callback and the late run saved nothing');
  assert.ok(![...page.values.keys()].some((key) => key.includes('late-run')));
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

// v91 review (privacy-tts-clips-survive-tester-signout): the workspace reload came before reader.clearCache(), so a
// tester's Read aloud clips (Gemini audio of their answers) stayed in the shared Cache Storage after every sign-out.
test('a tester’s sign-out (or another account) clears their Read aloud clips before the page reloads, and the reload waits for it', async () => {
  for (const next of [null, { sub: 'person-b', name: 'B' }]) {
    const page = lifecycle({ tester: person('person-a') });
    page.setTester(next);
    await page.reloaded();
    const at = (e) => page.events.indexOf(e);
    assert.ok(at('clear-reader') >= 0, `${next ? 'another account' : 'sign-out'}: the clips are cleared`);
    assert.ok(at('clear-reader') < at('reload'), 'before the reload');
    assert.equal(page.events.filter((e) => e === 'reload').length, 1);
  }
  // a reload that waits on nothing else still waits for the clear (at most the same 2 s)
  const stuck = lifecycle({ tester: person('person-a') });
  stuck.S.thread = { id: 'empty', entries: [] };
  stuck.setTester(null);
  assert.ok(!stuck.events.includes('reload'), 'not at once: the clear comes first');
  await stuck.reloaded();
  // a backstop at boot for browsers that signed out under an older build
  const APP_SRC = APP.replace(/\r\n/g, '\n');
  assert.match(APP_SRC, /if \(workspace === 'guest' && \['signedout', 'expired', 'revoked', 'closed'\]\.includes\(LS\.get\('outReason', ''\)\)\) reader\.clearCache\(\)\.catch\(\(\) => \{\}\);/);
});

// v91 review (privacy-former-tester-device-data-unreachable): with access closed (or after signing out) a former tester
// had no way in to Settings → Your data; the sign-in screen now offers to remove what Atelier kept here.
test('“Remove my tester data from this device”: every tester database, kv row, scoped setting and clip goes; nothing of the owner’s or the guest’s', async () => {
  const APP_SRC = APP.replace(/\r\n/g, '\n');
  const src = APP_SRC.slice(APP_SRC.indexOf('const TESTER_DB = '), APP_SRC.indexOf("$('#testerForget').addEventListener"));
  const run = async ({ databases = true, blocked = false } = {}) => {
    const deleted = [], removed = [], log = [];
    const ls = new Map([['atelier.tester', 'null'], ['atelier.meTester', 'null'], ['atelier.lastThread:tester:sub-1', '"t1"'], ['atelier.pinnedThreads:tester:sub-2', '[]'],
      ['atelier.settings', '{}'], ['atelier.lastThread', '"owner-thread"'], ['atelier.lastThread:guest', '"g"'], ['atelier.outReason', '"closed"']]);
    const dbNames = ['atelier-data', 'atelier-guest', 'atelier-kv', 'atelier-account-sub-1', 'atelier-appdata-account-sub-1', 'atelier-sync:tester-abc', 'atelier-sync', 'atelier-appdata', 'atelier-appdata-guest'];
    const deps = {
      workspace: 'guest', testerTrace: true, SHARE_CACHE: 'atelier-share',
      localStorage: { removeItem: (k) => { removed.push(k); ls.delete(k); } },
      LS: { set: (k, v) => log.push(['ls', k, v]) },
      indexedDB: {
        databases: databases ? async () => dbNames.map((name) => ({ name })) : undefined,
        deleteDatabase: (name) => { const r = {}; queueMicrotask(() => { if (blocked) r.onblocked(); else { deleted.push(name); r.onsuccess(); } }); return r; },
      },
      rawDB: { kvClearTesters: async () => log.push('kv') }, reader: { clearCache: async () => log.push('clips') }, self: { caches: { delete: async (k) => log.push(['cache', k]) } },
    };
    const keysOf = () => [...ls.keys()];
    // (Object.keys(localStorage) reads this fake's keys: the source is run as written, that one call redirected)
    const make = new Function(...Object.keys(deps), 'Object', `${src.replace(/Object\.keys\(localStorage\)/g, 'Object.keysOf()')}\nreturn { removeTesterData, testerDataHere };`);
    const api = make(...Object.values(deps), { keysOf, keys: Object.keys });
    let error = null;
    try { await api.removeTesterData(); } catch (err) { error = err; }
    return { deleted, removed, log, ls, error, here: api.testerDataHere };
  };
  const r = await run();
  assert.deepEqual(r.deleted, ['atelier-account-sub-1', 'atelier-appdata-account-sub-1', 'atelier-sync:tester-abc'], 'tester databases only');
  assert.deepEqual(r.removed.sort(), ['atelier.lastThread:tester:sub-1', 'atelier.meTester', 'atelier.pinnedThreads:tester:sub-2', 'atelier.tester']);
  assert.ok(r.ls.has('atelier.settings') && r.ls.has('atelier.lastThread') && r.ls.has('atelier.lastThread:guest'), 'the owner’s and the guest’s stay');
  assert.deepEqual(r.log, ['kv', 'clips', ['cache', 'atelier-share'], ['ls', 'outReason', '']]);
  // a browser that can't list its databases: the testers its scoped settings name
  const f = await run({ databases: false });
  assert.deepEqual(f.deleted.sort(), ['atelier-account-sub-1', 'atelier-account-sub-2', 'atelier-appdata-account-sub-1', 'atelier-appdata-account-sub-2']);
  // another Atelier tab holds one open: it says so, and nothing is said to be removed
  const b = await run({ blocked: true });
  assert.match(b.error?.message || '', /Close any other Atelier tab/);
  // shown only on a signed-out page with tester traces; the owner's kv rows are never touched (ws/tester: prefix only)
  assert.match(APP_SRC, /const forget = testerDataHere\(\);[^\n]*\n[\s\S]{0,600}\$\('#testerForget'\)\.hidden = !on;\n\s+\};\n\s+offerForget\(forget\);/);
  // v91 review (tester-privacy): no trace in localStorage (the browser dropped it, or the owner's Clear this device took
  // every atelier.* key) while a tester's databases or kv rows are still here: the screen asks IndexedDB as well
  assert.match(APP_SRC, /if \(!forget\) testerDataStored\(\)\.then\(\(yes\) => \{ if \(yes && onboardReason === reason && \$\('#onboard'\)\.open\) offerForget\(true\); \}\);/);
  assert.match(APP_SRC, /kvHasTesters: \(\) => tx\('readonly', \(s\) => s\.getAllKeys\(\), 'kv'\)\.then\(\(keys\) => \(keys \|\| \[\]\)\.some\(\(k\) => typeof k === 'string' && k\.startsWith\(`\$\{KV_SCOPE\}tester:`\)\)\),/);
  const probe = async ({ names = null, kv = false, workspace = 'guest' } = {}) => {
    const deps = {
      workspace, testerTrace: false, localStorage: {}, SHARE_CACHE: 'atelier-share', LS: {}, reader: {}, self: {},
      indexedDB: { databases: names ? async () => names.map((name) => ({ name })) : undefined },
      rawDB: { kvHasTesters: async () => { if (kv === 'throws') throw new Error('blocked'); return kv; } },
    };
    const make = new Function(...Object.keys(deps), 'Object', `${src.replace(/Object\.keys\(localStorage\)/g, 'Object.keysOf()')}\nreturn { testerDataHere, testerDataStored };`);
    const api = make(...Object.values(deps), { keysOf: () => [], keys: Object.keys });
    return [api.testerDataHere(), await api.testerDataStored()];
  };
  assert.deepEqual(await probe({ names: ['atelier-guest', 'atelier-kv', 'atelier-account-abc'] }), [false, true], 'a tester database, no localStorage trace');
  assert.deepEqual(await probe({ names: ['atelier-guest', 'atelier-sync:tester-x'] }), [false, true]);
  assert.deepEqual(await probe({ names: ['atelier-guest', 'atelier-kv', 'atelier-data', 'atelier-appdata'], kv: true }), [false, true], 'only ws/tester: kv rows');
  assert.deepEqual(await probe({ names: ['atelier-guest', 'atelier-kv', 'atelier-data', 'atelier-appdata', 'atelier-sync'] }), [false, false], 'the owner’s and the guest’s are not tester data');
  assert.deepEqual(await probe({ kv: 'throws' }), [false, false], 'a browser that can’t list databases and a kv read that fails: nothing offered');
  assert.deepEqual(await probe({ names: ['atelier-account-abc'], workspace: 'owner' }), [false, false], 'never on a signed-in page');
  assert.match(APP_SRC, /kvClearTesters: \(\) => tx\('readwrite', \(s\) => \{ const q = s\.getAllKeys\(\); q\.onsuccess = \(\) => \{ for \(const k of q\.result \|\| \[\]\) if \(typeof k === 'string' && k\.startsWith\(`\$\{KV_SCOPE\}tester:`\)\) s\.delete\(k\); \}; \}, 'kv'\),/);
  const html = (await import('node:fs/promises')).readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(await html, /<button type="button" class="chip ob-forget" id="testerForget" hidden>Remove my tester data from this device<\/button>/);
});

test('tester continuity is offered only when the server explicitly enables it, including conservative behavior for cached records', () => {
  assert.equal(person('person-a', { features: { sync: true } }).features.sync, true);
  assert.equal(person('person-a', { features: { sync: false } }).features.sync, false);
  assert.equal(person('person-a', { features: { sync: 'true' } }).features.sync, false);
  assert.equal(person('person-a').features.sync, false);
});

test('a cross-tab owner-to-tester switch clears cached owner credentials and suspends work without overwriting the newly stored account', async () => {
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
  await page.reloaded();
  assert.ok(page.values.has('atelier-data:threads:current'), 'the pending owner edit lands in the owner’s own database');
  assert.ok(!page.opened.some((name) => name.startsWith('atelier-account-')), 'never in the new tester’s');
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

const originalRow = (id, text = 'Original shared history') => ({ id, title: id, createdAt: 1000, updatedAt: 1000, entries: [{ id: `entry-${id}`, kind: 'ask', prompt: text, text: 'Original reply' }] });
const originalKey = (id) => `atelier-data:threads:${id}`;
const markerKey = 'atelier-shared-history-v76:meta:baseline';

test('older-thread review freezes only original rows and never exposes subsequent owner writes, including historically dated cloud imports', async () => {
  const original = originalRow('shared'), stored = new Map([[originalKey(original.id), original]]);
  const owner = lifecycle({ passcode: 'owner-pass', storedValues: stored });
  await owner.settle(owner.rawDB.put(originalRow('private-new', 'Private owner work')));
  await owner.settle(owner.rawDB.putAll([originalRow('private-old-dates', 'Private historical cloud import')]));
  const inventory = stored.get(markerKey);
  assert.deepEqual(inventory.hashes.map(([id]) => id), ['shared']);
  assert.ok(!JSON.stringify(inventory).includes('Original shared history'));
  assert.ok(!JSON.stringify(inventory).includes('Private owner work'));
  const tester = lifecycle({ tester: person('person-a'), storedValues: stored });
  assert.deepEqual((await tester.settle(tester.rawDB.legacyAll())).map((row) => row.id), ['shared']);
  assert.deepEqual((await owner.settle(owner.rawDB.all())).map((row) => row.id).sort(), ['private-new', 'private-old-dates', 'shared']);
});

test('an owner sync merge or edit cannot remain eligible by retaining an original thread ID and old timestamps', async () => {
  const original = originalRow('shared'), stored = new Map([[originalKey(original.id), original]]);
  const owner = lifecycle({ passcode: 'owner-pass', storedValues: stored });
  await owner.settle(owner.rawDB.update('shared', (current) => ({ ...current, entries: [...current.entries, { id: 'new-private-entry', kind: 'ask', prompt: 'Private new request', text: 'Private reply' }] })));
  const tester = lifecycle({ tester: person('person-a'), storedValues: stored });
  assert.deepEqual(await tester.settle(tester.rawDB.legacyAll()), []);
  assert.equal(stored.get(originalKey('shared')).updatedAt, 1000);
  assert.equal(stored.get(originalKey('shared')).entries.length, 2);
});

test('the immutable shared inventory survives local settings removal, scoped thread clearing and the ordinary KV wipe', async () => {
  const original = originalRow('shared'), stored = new Map([[originalKey(original.id), original]]);
  const owner = lifecycle({ passcode: 'owner-pass', storedValues: stored });
  await owner.settle(owner.rawDB.freezeLegacy());
  await owner.settle(owner.rawDB.put(originalRow('private-owner')));
  const before = structuredClone(stored.get(markerKey));
  const tester = lifecycle({ tester: person('person-a'), storedValues: stored });
  await tester.settle(tester.rawDB.put(originalRow('tester-local')));
  await tester.settle(tester.rawDB.kvSet('local-preference', 'value'));
  await tester.settle(tester.rawDB.clear());
  await tester.settle(tester.rawDB.kvClear());
  tester.settings.clear();
  const reopened = lifecycle({ tester: person('person-b'), storedValues: stored });
  assert.deepEqual((await reopened.settle(reopened.rawDB.legacyAll())).map((row) => row.id), ['shared']);
  assert.deepEqual(stored.get(markerKey), before);
});

test('a corrupt existing inventory keeps recovery closed without blocking current owner saves or recapturing private work', async () => {
  const original = originalRow('shared'), broken = new Map([[originalKey(original.id), original], [markerKey, { v: 99, hashes: [] }]]);
  const owner = lifecycle({ passcode: 'owner-pass', storedValues: broken });
  const marker = structuredClone(broken.get(markerKey));
  await owner.settle(owner.rawDB.put(originalRow('private-new')));
  await owner.settle(owner.rawDB.putAll([originalRow('private-import')]));
  await owner.settle(owner.rawDB.update('shared', (row) => ({ ...row, title: 'Private title' })));
  assert.ok(broken.has(originalKey('private-new')));
  assert.ok(broken.has(originalKey('private-import')));
  assert.equal(broken.get(originalKey('shared')).title, 'Private title');
  assert.deepEqual(broken.get(markerKey), marker);
  const tester = lifecycle({ tester: person('person-a'), storedValues: broken });
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(() => tester.settle(tester.rawDB.legacyAll()), (err) => err.code === 'legacy_boundary_invalid');
  const reopened = lifecycle({ passcode: 'owner-pass', storedValues: broken });
  await assert.rejects(() => reopened.settle(reopened.rawDB.freezeLegacy()), (err) => err.code === 'legacy_boundary_invalid');
  assert.deepEqual(broken.get(markerKey), marker);
});

// Every owner write path, each saving something private (the last one runs after the others).
const ownerWrites = (page) => [
  () => page.rawDB.put(originalRow('private-put', 'Private owner work')),
  () => page.rawDB.putAll([originalRow('private-import', 'Private import')]),
  () => page.rawDB.update('shared', (row) => ({ ...row, title: 'Private title' })),
  () => page.rawDB.del('private-put'),
];
async function assertOwnerWritesLand(page, stored) {
  for (const operation of ownerWrites(page)) await page.settle(operation());
  assert.ok(stored.has(originalKey('private-import')));
  assert.ok(!stored.has(originalKey('private-put')), 'the delete went through');
  assert.equal(stored.get(originalKey('shared')).title, 'Private title');
}
// A tester page in the same browser profile: recovery is closed, so neither the original nor private rows are offered.
async function assertRecoveryClosed(stored, ls) {
  const tester = lifecycle({ tester: person('person-a'), storedValues: stored, lsValues: ls });
  await assert.rejects(() => tester.settle(tester.rawDB.legacyAll()), (err) => err.code === 'legacy_boundary_closed');
}

test('inventory hashing failures never block an owner save: recovery closes for good and the failure is cached, not re-hashed on every save', async () => {
  const original = originalRow('shared'), stored = new Map([[originalKey(original.id), original]]), ls = new Map();
  let digests = 0;
  const failed = lifecycle({ passcode: 'owner-pass', storedValues: stored, lsValues: ls, cryptoOverride: { subtle: { digest: async () => { digests++; throw new Error('Hash unavailable'); } } } });
  await assertOwnerWritesLand(failed, stored);
  assert.equal(digests, 1, 'one attempt, then the cached failure (backoff): no rehash storm');
  assert.ok(ls.get('sharedHistoryUnguarded') > 0, 'the browser remembers that a save went ahead without a boundary');
  assert.deepEqual(stored.get(markerKey), { v: 0, closed: true });
  await assert.rejects(() => failed.settle(failed.rawDB.freezeLegacy()), /Hash unavailable/);
  assert.equal(digests, 1);
  await assertRecoveryClosed(stored, ls);
  // A later owner page with working crypto never recaptures the private rows: the closed marker stands, saves still work.
  const reopened = lifecycle({ passcode: 'owner-pass', storedValues: stored, lsValues: ls });
  await assert.rejects(() => reopened.settle(reopened.rawDB.freezeLegacy()), (err) => err.code === 'legacy_boundary_closed');
  await reopened.settle(reopened.rawDB.put(originalRow('after-reopen')));
  assert.ok(stored.has(originalKey('after-reopen')));
  assert.deepEqual(stored.get(markerKey), { v: 0, closed: true });
});

test('a metadata database that won’t open never blocks owner saves; it is retried only after a backoff, and then closes recovery', async () => {
  const original = originalRow('shared'), stored = new Map([[originalKey(original.id), original]]), ls = new Map();
  let broken = true;
  const page = lifecycle({ passcode: 'owner-pass', storedValues: stored, lsValues: ls, failOpen: (name) => broken && name === 'atelier-shared-history-v76' });
  await assertOwnerWritesLand(page, stored);
  const metaOpens = () => page.opened.filter((name) => name === 'atelier-shared-history-v76').length;
  assert.equal(metaOpens(), 2, 'the freeze and one closing attempt; the later saves reuse the cached failure');
  assert.ok(ls.get('sharedHistoryUnguarded') > 0);
  assert.ok(!stored.has(markerKey));
  await assertRecoveryClosed(stored, ls); // even before any marker could be stored: the flag alone keeps it closed
  // After the backoff the metadata database opens again: no inventory is taken of rows written meanwhile.
  broken = false;
  const realNow = Date.now;
  Date.now = () => realNow() + 2 * 36e5;
  try { await assert.rejects(() => page.settle(page.rawDB.freezeLegacy()), (err) => err.code === 'legacy_boundary_closed'); }
  finally { Date.now = realNow; }
  assert.deepEqual(stored.get(markerKey), { v: 0, closed: true });
  await assertRecoveryClosed(stored, new Map()); // the stored marker alone, even with this browser's localStorage gone
});

test('a full disk while storing the inventory never blocks owner saves and keeps recovery closed', async () => {
  const original = originalRow('shared'), stored = new Map([[originalKey(original.id), original]]), ls = new Map();
  let digests = 0;
  const quota = () => Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
  const counting = { subtle: { digest: async (...args) => { digests++; return globalThis.crypto.subtle.digest(...args); } } };
  const page = lifecycle({ passcode: 'owner-pass', storedValues: stored, lsValues: ls, cryptoOverride: counting, failPut: (name) => (name === 'atelier-shared-history-v76' ? quota() : null) });
  await assertOwnerWritesLand(page, stored);
  assert.equal(digests, 1, 'hashed once; the failure is cached');
  assert.ok(!stored.has(markerKey), 'nothing could be stored there');
  assert.ok(ls.get('sharedHistoryUnguarded') > 0);
  await assertRecoveryClosed(stored, ls);
});

test('a freeze still hashing when another tab saves unguarded stores a closed marker, never its candidate', async () => {
  const shared = originalRow('shared'), stored = new Map([[originalKey(shared.id), shared]]), ls = new Map(), hold = defer(), started = defer();
  const paused = { subtle: { digest: async (...args) => { started.resolve(); await hold.promise; return globalThis.crypto.subtle.digest(...args); } } };
  const slow = lifecycle({ passcode: 'owner-pass', storedValues: stored, lsValues: ls, cryptoOverride: paused });
  const freezing = slow.settle(slow.rawDB.freezeLegacy());
  await started.promise;
  ls.set('sharedHistoryUnguarded', Date.now()); // another tab's save went ahead without a boundary meanwhile
  hold.resolve();
  await assert.rejects(() => freezing, (err) => err.code === 'legacy_boundary_closed');
  assert.deepEqual(stored.get(markerKey), { v: 0, closed: true });
});

test('competing first-launch tabs preserve the first durable inventory even when a slower tab prepared a broader candidate', async () => {
  const shared = originalRow('shared'), stored = new Map([[originalKey(shared.id), shared]]);
  const holdA = defer(), holdB = defer(), startedA = defer(), startedB = defer();
  const pausedCrypto = (started, hold) => ({ subtle: { digest: async (...args) => { started.resolve(); await hold.promise; return globalThis.crypto.subtle.digest(...args); } } });
  const a = lifecycle({ passcode: 'owner-pass', storedValues: stored, cryptoOverride: pausedCrypto(startedA, holdA) });
  const freezeA = a.settle(a.rawDB.freezeLegacy());
  await startedA.promise;
  stored.set(originalKey('later-original-row'), originalRow('later-original-row'));
  const b = lifecycle({ passcode: 'owner-pass', storedValues: stored, cryptoOverride: pausedCrypto(startedB, holdB) });
  const freezeB = b.settle(b.rawDB.freezeLegacy());
  await startedB.promise;
  holdA.resolve(); const inventoryA = await freezeA;
  const writingOwner = lifecycle({ passcode: 'owner-pass', storedValues: stored });
  await writingOwner.settle(writingOwner.rawDB.put(originalRow('new-private-owner')));
  holdB.resolve(); const inventoryB = await freezeB;
  assert.deepEqual(inventoryB, inventoryA);
  assert.deepEqual(inventoryB.hashes.map(([id]) => id), ['shared']);
  const tester = lifecycle({ tester: person('person-a'), storedValues: stored });
  assert.deepEqual((await tester.settle(tester.rawDB.legacyAll())).map((row) => row.id), ['shared']);
});

// ── atelier-kv is per workspace: a tester never reads or clears the owner's keys (remix drafts, the passcode backup) ──
const wipeKeySource = between(APP, '// The atelier.* localStorage keys Clear this device removes', "$('#wipeBtn').onclick");
const wipeSource = between(APP, "$('#wipeBtn').onclick", 'function applyTheme()');

test('key/value data is scoped per workspace; the owner keeps its original unscoped keys readable', async () => {
  const stored = new Map(), ls = new Map();
  // What an owner device holds from before this release: unscoped keys.
  stored.set('atelier-kv:kv:rx:ops', { owner: true }); stored.set('atelier-kv:kv:ccHandle', 'folder'); stored.set('atelier-kv:kv:passcode', 'owner-pass');
  const owner = lifecycle({ passcode: 'owner-pass', storedValues: stored, lsValues: ls });
  const tester = lifecycle({ tester: person('person-a'), storedValues: stored, lsValues: ls });
  const other = lifecycle({ tester: person('person-b'), storedValues: stored, lsValues: ls });
  assert.deepEqual(await owner.settle(owner.rawDB.kvGet('rx:ops')), { owner: true }, 'existing owner data stays readable');
  await tester.settle(tester.rawDB.kvSet('rx:ops', { tester: 'a' }));
  await other.settle(other.rawDB.kvSet('rx:ops', { tester: 'b' }));
  assert.deepEqual(await tester.settle(tester.rawDB.kvGet('rx:ops')), { tester: 'a' });
  assert.equal(await tester.settle(tester.rawDB.kvGet('passcode')), undefined, 'a tester page never reads the owner passcode backup');
  assert.equal(await tester.settle(tester.rawDB.kvGet('ccHandle')), undefined);
  assert.deepEqual(await tester.settle(tester.rawDB.kvKeys()), ['rx:ops']);
  assert.deepEqual((await owner.settle(owner.rawDB.kvKeys())).sort(), ['ccHandle', 'passcode', 'rx:ops'], 'no other workspace’s keys');
  // A tester's Clear this device (kvClear) removes only its own keys.
  await tester.settle(tester.rawDB.kvClear());
  assert.deepEqual(await tester.settle(tester.rawDB.kvKeys()), []);
  assert.deepEqual(await other.settle(other.rawDB.kvGet('rx:ops')), { tester: 'b' });
  assert.deepEqual(await owner.settle(owner.rawDB.kvGet('rx:ops')), { owner: true });
  assert.equal(await owner.settle(owner.rawDB.ownerPasscodeGet()), 'owner-pass');
  // The owner's own Clear this device leaves other accounts' keys alone too.
  await owner.settle(owner.rawDB.kvClear());
  assert.deepEqual(await owner.settle(owner.rawDB.kvKeys()), []);
  assert.deepEqual(await other.settle(other.rawDB.kvGet('rx:ops')), { tester: 'b' });
});

test('Clear this device on a tester page keeps the owner’s keys, migration flags and older database; the owner’s clears all', () => {
  const keys = ['atelier.settings', 'atelier.opts', 'atelier.tester', 'atelier.meTester', 'atelier.draft', 'atelier.lastThread:tester:person-a', 'atelier.pinnedThreads:tester:person-a',
    'atelier.migratedV3', 'atelier.migrateToastAt', 'atelier.owner', 'atelier.signedIn', 'atelier.me', 'atelier.lastThread', 'atelier.pinnedThreads', 'atelier.lastThread:tester:person-b', 'atelier.lastThread:guest',
    'atelier.sharedHistoryUnguarded', 'other.app'];
  const wipes = (workspace, settings = {}) => new Function('workspace', 'LS', `${wipeKeySource}; return wipesKey;`)(workspace, { get: (k, d) => (k === 'settings' ? settings : d) });
  const tester = keys.filter(wipes('tester:person-a'));
  assert.deepEqual(tester, ['atelier.settings', 'atelier.opts', 'atelier.tester', 'atelier.meTester', 'atelier.draft', 'atelier.lastThread:tester:person-a', 'atelier.pinnedThreads:tester:person-a']);
  assert.ok(!keys.filter(wipes('tester:person-a', { passcode: 'owner-pass' })).includes('atelier.settings'), 'settings that now hold an owner passcode stay');
  assert.deepEqual(keys.filter(wipes('guest')), ['atelier.settings', 'atelier.opts', 'atelier.tester', 'atelier.meTester', 'atelier.draft', 'atelier.lastThread:guest']);
  assert.deepEqual(keys.filter(wipes('owner')), keys.filter((k) => k.startsWith('atelier.') && k !== 'atelier.sharedHistoryUnguarded'));
  // Only the owner's own Clear this device deletes the old "atelier" database (unmigrated owner threads).
  assert.match(wipeSource, /if \(workspace === 'owner'\) await new Promise\(\(res, rej\) => \{ const r = indexedDB\.deleteDatabase\('atelier'\)/);
  assert.equal(wipeSource.match(/deleteDatabase\(/g).length, 1);
  assert.match(wipeSource, /Object\.keys\(localStorage\)\.filter\(wipesKey\)/);
});

test('the owner passcode backup is restored only on a signed-out page no tester has used, and only an owner sign-in writes it', () => {
  assert.match(APP, /const restorable = workspace === 'guest' && !testerTrace;\s+const backup = restorable \? await Promise\.race\(\[DB\.ownerPasscodeGet\(\)/);
  assert.doesNotMatch(APP, /kv(Get|Set)\('passcode'/, 'the backup is never a workspace-scoped key');
  assert.match(APP, /if \(s\.passcode \|\| workspace === 'owner'\) await DB\.ownerPasscodeSet\(s\.passcode\)/, 'a tester’s Settings never clears it');
});
