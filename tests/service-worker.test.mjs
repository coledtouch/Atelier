import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
const VERSION = source.match(/const VERSION = '([^']+)'/)[1]; // bumped on every deploy
function setup({ offline = false, hit = new Response('cached'), keys = [] } = {}) {
  const handlers = {}, deleted = [], fetched = [], cached = [], waited = [];
  const cache = { match: async () => hit, put: async (key, response) => cached.push(key), addAll: async list => cached.push(...list) };
  vm.runInNewContext(source, { URL, Response, location: { origin: 'https://atelier.test' },
    self: { addEventListener: (name, fn) => handlers[name] = fn, clients: { claim: async () => {} }, skipWaiting: async () => {} },
    caches: { open: async () => cache, keys: async () => keys, delete: async k => deleted.push(k) },
    fetch: async req => { fetched.push(req); if (offline) throw new Error('offline'); return new Response('network'); },
  });
  const dispatch = (path, opts = {}) => {
    let response;
    handlers.fetch({ request: { url: `https://atelier.test${path}`, method: 'GET', mode: 'cors', ...opts }, waitUntil: p => waited.push(p), respondWith: p => response = p });
    return response;
  };
  return { handlers, deleted, fetched, cached, waited, dispatch };
}
test('never intercepts API requests or generated files', () => {
  const s = setup(); assert.equal(s.dispatch('/api/chat'), undefined); assert.equal(s.dispatch('/private-image.png'), undefined); assert.equal(s.fetched.length, 0);
});
test('serves cached static assets offline without rejected background work', async () => {
  const s = setup({ offline: true }); assert.equal(await (await s.dispatch('/app.js')).text(), 'cached'); await Promise.all(s.waited);
});
test('offline navigation uses cached legal page and uncached assets fail predictably', async () => {
  const s = setup({ offline: true }); assert.equal(await (await s.dispatch('/privacy', {mode:'navigate'})).text(), 'cached');
  const empty = setup({ offline: true, hit: null }); assert.equal((await empty.dispatch('/app.js')).type, 'error');
});
test('online navigation prefers the current server response', async () => {
  const s = setup(); assert.equal(await (await s.dispatch('/', {mode:'navigate'})).text(), 'network'); assert.ok(s.cached.includes('/index.html'));
});
test('index.html asks for exactly the versioned shell files the worker precaches', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const versioned = [...html.matchAll(/(?:href|src)="(\/[\w.-]+\?v=[^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(versioned.sort(), ['/app.css', '/app.js', '/studio.css'].map((p) => `${p}?v=${VERSION.slice('atelier-v'.length)}`));
  const s = setup(); let done;
  s.handlers.install({ waitUntil: (p) => done = p }); await done;
  for (const u of versioned) assert.ok(s.cached.includes(u), `${u} is precached`);
  const offline = setup({ offline: true }); assert.equal(await (await offline.dispatch(versioned[0])).text(), 'cached');
});
test('activation removes only old Atelier caches', async () => {
  const s = setup({keys: ['atelier-v1', VERSION, 'another-app']}); let done;
  s.handlers.activate({waitUntil: p => done = p}); await done; assert.deepEqual(s.deleted, ['atelier-v1']);
});
// An installed PWA started offline loads nothing if one static import isn't precached: guard every module app.js pulls in.
test('every module the app imports is precached', async () => {
  const s = setup(); let done;
  s.handlers.install({ waitUntil: (p) => done = p }); await done;
  for (const f of ['app.js', 'data-safety.js']) {
    const src = await readFile(new URL(`../public/${f}`, import.meta.url), 'utf8');
    for (const [, path] of src.matchAll(/^import\s[^;]*?\sfrom\s+'\.\/([\w.-]+\.js)'/gm)) assert.ok(s.cached.includes(`/${path}`), `/${path} (imported by ${f}) is precached`);
  }
});
