// v91 review, through the real Worker (tests/tester-env.mjs):
//   access-chat-preauth-body / live-chat-preauth-body-parse: POST /api/chat read and parsed its whole body before it
//     looked at the passcode — the one route that did.
//   critic-no-client-build-floor: the app's own safety rules reach a device only once that tab runs the build that has
//     them, and nothing on the server knew which build was calling. Every API call now names it (x-atelier-build), a
//     build below src/worker.js MIN_CLIENT_BUILD gets 426 app_outdated on the routes that act on the owner's accounts or
//     write synced data, and a long-open tab looks for a new version when it comes back into view.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeEnv, api, mockFetch, restoreFetch, upstream, reply, signIn, PROFILE, resetTesterCaches } from './tester-env.mjs';
const { MIN_CLIENT_BUILD, clientOutdated } = await import('../src/worker.js');

const read = async (p) => (await readFile(new URL(`../${p}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
afterEach(() => restoreFetch());

// A body that fails the test the moment anything reads it.
const untouchable = () => new ReadableStream({ pull() { throw new Error('the body was read before the passcode was checked'); } });

test('POST /api/chat without the passcode is refused before its body is read or parsed (401, no upstream call)', async () => {
  mockFetch([]);
  const { env } = makeEnv({ testers: false });
  for (const body of ['x', '{}', JSON.stringify({ model: 'anthropic:claude-sonnet-5-5', messages: [] })]) {
    const r = await api(env, 'chat', { method: 'POST', body, headers: { 'content-type': 'application/json' } });
    assert.equal(r.status, 401, body);
    assert.equal((await r.json()).error, 'Enter your passcode to use Atelier.');
  }
  const stream = await api(env, 'chat', { method: 'POST', body: untouchable(), headers: { 'content-type': 'application/json' } });
  assert.equal(stream.status, 401, 'refused without a byte read');
  const wrong = await api(env, 'chat', { method: 'POST', body: untouchable(), headers: { 'content-type': 'application/json' } }, { pass: 'nope' });
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).error, 'Wrong passcode — check it in Settings.');
  assert.equal(upstream.calls.length, 0, 'no provider was called');
  // With the passcode, a bad body is still a 400 (the check after it is unchanged).
  const bad = await api(env, 'chat', { method: 'POST', body: 'x', headers: { 'content-type': 'application/json' } }, { pass: 'pw' });
  assert.equal(bad.status, 400);
  const src = await read('src/worker.js');
  assert.match(src, /async function handleChat\(req, env\) \{\n(?:\s*\/\/[^\n]*\n)*\s*if \(!passOk\(req, env\)\) return missingKey\(req, env, 'nvidia'\);\n\s*let body;/);
});

test('a build below MIN_CLIENT_BUILD gets 426 app_outdated on chat, tools, relay commands and sync writes — never on reads or other routes', async () => {
  mockFetch([[/./, () => reply(200, { ok: true })]]);
  const { env } = makeEnv({ testers: false });
  const old = String(MIN_CLIENT_BUILD - 1), current = String(MIN_CLIENT_BUILD);
  const call = (path, method, build, body) => api(env, path, { method, headers: { 'content-type': 'application/json', ...(build == null ? {} : { 'x-atelier-build': build }) }, ...(body === undefined ? {} : { body }) }, { pass: 'pw' });
  for (const [path, method] of [['chat', 'POST'], ['tools', 'GET'], ['tools/run', 'POST'], ['relay/cmd', 'POST'], ['sync/thread/t1', 'POST'], ['sync/thread/t1', 'DELETE'], ['sync/blobs/missing', 'POST'], ['sync/trash/restore', 'POST']]) {
    const r = await call(path, method, old, method === 'GET' ? undefined : '{}');
    assert.equal(r.status, 426, `${method} ${path}`);
    assert.deepEqual(await r.json(), { error: 'Atelier was updated — reloading this page.', code: 'app_outdated' });
  }
  assert.equal(upstream.calls.length, 0, 'nothing reached a provider or a service');
  // Reads, and routes that change nothing of the owner's accounts, answer as before; so does a current build.
  for (const [path, method] of [['sync/index', 'GET'], ['me', 'GET'], ['health', 'GET']]) assert.notEqual((await call(path, method, old)).status, 426, `${method} ${path}`);
  assert.notEqual((await call('chat', 'POST', current, 'x')).status, 426, 'the floor itself is current');
  // No header (a build from before it, or not the app): not refused for that yet.
  assert.notEqual((await call('chat', 'POST', null, 'x')).status, 426);
  // A malformed one isn't the app's: refused like an old one.
  assert.equal((await call('chat', 'POST', 'v90', 'x')).status, 426);
  // A tester's sync write from an old build: the same.
  resetTesterCaches();
  const t = makeEnv({ testers: true });
  const s = await signIn(t.L, PROFILE(7001));
  const r = await api(t.env, 'tester/sync/thread/t1', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', 'x-atelier-build': old } }, { cookie: s.token });
  assert.equal(r.status, 426);
  assert.equal(clientOutdated(new Request('https://a/api/chat', { method: 'POST', headers: { 'x-atelier-build': old } }), 'chat'), true);
  assert.equal(clientOutdated(new Request('https://a/api/chat', { method: 'GET', headers: { 'x-atelier-build': old } }), 'chat'), false);
});

test('the floor never refuses the build being shipped: MIN_CLIENT_BUILD ≤ the app’s APP_BUILD and sw.js VERSION', async () => {
  const app = await read('public/app.js'), sw = await read('public/sw.js');
  const build = Number(/const APP_BUILD = '(\d+)';/.exec(app)[1]), version = Number(/const VERSION = 'atelier-v(\d+)';/.exec(sw)[1]);
  assert.equal(build, version);
  assert.ok(MIN_CLIENT_BUILD <= build, `MIN_CLIENT_BUILD ${MIN_CLIENT_BUILD} must not exceed the shipped build ${build}`);
  assert.ok(MIN_CLIENT_BUILD >= 84, 'v84 is where the accounts agent learned the thread-taint rules');
  assert.equal(app.split("const APP_BUILD = '").length - 1, 1, 'one APP_BUILD (scripts/bump-version.mjs moves it)');
});

test('client: every API call names its build; 426 app_outdated saves, updates and reloads (once a minute at most); long-open tabs check hourly', async () => {
  const app = await read('public/app.js'), sync = await read('public/sync.js');
  // apiHeaders, declared before anything calls it
  assert.match(app, /const APP_BUILD = '\d+';\nconst SW_CHECK_MS = 3_600_000;[^\n]*\nfunction apiHeaders\(extra = \{\}\) \{\n  const h = \{ 'content-type': 'application\/json', 'x-atelier-build': APP_BUILD, \.\.\.extra \};/);
  assert.ok(app.indexOf("const APP_BUILD = '") < app.indexOf('function toApiError('));
  assert.match(app, /if \(code === 'app_outdated'\) \{ appOutdated\(\); return new ApiError\(r\.status, /);
  assert.match(app, /onOutdated: appOutdated,/);
  assert.match(sync, /if \(r\.status === 426\) \{ await pauseFor\('upgrade'\); try \{ deps\.onOutdated\?\.\(\); \} catch \{\} throw new Halt\('426'\); \}/);
  assert.match(app, /if \(document\.visibilityState !== 'visible' \|\| Date\.now\(\) - swCheckedAt < SW_CHECK_MS\) return;\n\s+swCheckedAt = Date\.now\(\);\n\s+navigator\.serviceWorker\.getRegistration\(\)\.then\(\(r\) => r\?\.update\(\)\)/);
  // appOutdated, run against stubs: saves, updates, reloads; a second 426 within a minute only says so
  const fn = app.slice(app.indexOf('let outdatedReload = false;'), app.indexOf('\n}\n', app.indexOf('function appOutdated()')) + 2);
  const run = (session) => {
    const log = [];
    const deps = {
      sessionStorage: { getItem: (k) => session.get(k) ?? null, setItem: (k, v) => session.set(k, v) },
      toast: (m, o) => log.push(['toast', m, Boolean(o?.error)]), persist: () => { log.push('persist'); return Promise.resolve(); },
      navigator: { serviceWorker: { getRegistration: async () => ({ update: async () => log.push('update') }) } },
      appDataSaved: async () => log.push('apps'), location: { reload: () => log.push('reload') },
    };
    const api = new Function(...Object.keys(deps), `${fn}\nreturn appOutdated;`)(...Object.values(deps));
    return { log, api };
  };
  const session = new Map();
  const a = run(session);
  a.api(); a.api();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(a.log, [['toast', 'Atelier was updated — reloading…', false], 'persist', 'update', 'apps', 'reload'], 'once, in order');
  const b = run(session); // the reloaded page, still outdated (a stale cache): no loop
  b.api();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(b.log, [['toast', 'Atelier was updated — reload this page to keep going.', true]]);
});
