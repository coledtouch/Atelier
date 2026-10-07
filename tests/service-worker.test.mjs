import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
const VERSION = source.match(/const VERSION = '([^']+)'/)[1]; // bumped on every deploy
// Cached on first use, never at install (the Video Remix engine and Mediabunny): read from the source like VERSION.
const LAZY = JSON.parse(source.match(/const LAZY = (\[[^\]]*\]);/)[1].replace(/'/g, '"'));
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
  assert.deepEqual(versioned.sort(), ['/app.css', '/app.js', '/feedback.css', '/remix.css', '/studio.css'].map((p) => `${p}?v=${VERSION.slice('atelier-v'.length)}`));
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
    for (const [, path, q = ''] of src.matchAll(/^import\s[^;]*?\sfrom\s+'\.\/([\w.-]+\.js)(\?v=\d+)?'/gm)) assert.ok(s.cached.includes(`/${path}${q}`), `/${path}${q} (imported by ${f}) is precached`);
  }
});
// sw.js answers static files from its cache first, so an unversioned import lets a new app.js run against an older cached
// module (a bare screen after v52). app.js and every module it reaches import at ?v=<VERSION number>, the worker
// precaches exactly those URLs, and scripts/bump-version.mjs moves all of them together.
test('every module the app loads is imported and precached at ?v=<VERSION number>', async () => {
  const s = setup(); let done;
  s.handlers.install({ waitUntil: (p) => done = p }); await done;
  const v = `?v=${VERSION.slice('atelier-v'.length)}`, seen = new Set(), todo = ['app.js'];
  while (todo.length) {
    const f = todo.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    const src = await readFile(new URL(`../public/${f}`, import.meta.url), 'utf8');
    // from './x.js', import './x.js' and import('./x.js'), wherever they sit (a multi-line import can't slip past)
    for (const [, path, q = ''] of src.matchAll(/\b(?:from|import)\s*\(?\s*['"]\.\/([\w./-]+\.m?js)(\?[^'"]*)?['"]/g)) {
      assert.equal(q, v, `${f} imports ./${path}${q}: it must be ./${path}${v}`);
      if (LAZY.includes(`/${path}`)) assert.ok(!s.cached.includes(`/${path}${v}`), `/${path} is LAZY: cached on first use, not at install`);
      else assert.ok(s.cached.includes(`/${path}${v}`), `/${path}${v} (imported by ${f}) is precached`);
      todo.push(path);
    }
  }
  assert.ok(seen.size > 1, 'app.js imports its modules');
  for (const f of seen) assert.ok(!s.cached.includes(`/${f}`), `/${f} is precached only at its ?v= URL (never a second, stale copy)`);
});
// Chrome's WebAPK update check fetches the manifest through this worker: a cache-first copy would report "no change"
// for a day after every manifest deploy (new shortcuts, share_target). Pages and the manifest go network-first.
test('the manifest is fetched network-first (cache only offline); other shell files stay cache-first', async () => {
  const s = setup();
  assert.equal(await (await s.dispatch('/manifest.webmanifest', { destination: 'manifest' })).text(), 'network');
  assert.equal(await (await s.dispatch('/manifest.webmanifest')).text(), 'network', 'by path too (a request without a destination)');
  assert.equal(await (await s.dispatch('/app.js')).text(), 'cached', 'scripts and styles stay cache-first (versioned URLs)');
  const off = setup({ offline: true });
  assert.equal(await (await off.dispatch('/manifest.webmanifest', { destination: 'manifest' })).text(), 'cached');
  await Promise.all(off.waited);
});

// Video Remix: the render engine and the vendored Mediabunny (689 KB) are never precached, but once fetched they are
// served from the cache like the shell (so a cut works offline after the first one).
test('LAZY files are not in the install list, and are cached on first use', async () => {
  assert.deepEqual(LAZY, ['/remix-render.js', '/vendor/mediabunny.js']);
  const s = setup(); let done;
  s.handlers.install({ waitUntil: (p) => done = p }); await done;
  for (const p of LAZY) assert.ok(!s.cached.some((u) => String(u).split('?')[0] === p), `${p} isn't precached`);
  const v = `?v=${VERSION.slice('atelier-v'.length)}`;
  const miss = setup({ hit: null });
  assert.equal(await (await miss.dispatch(`/remix-render.js${v}`)).text(), 'network');
  assert.equal(await (await miss.dispatch('/vendor/mediabunny.js')).text(), 'network');
  await Promise.all(miss.waited);
  assert.equal(miss.cached.length, 2, 'both responses were put in the cache');
  const hit = setup();
  assert.equal(await (await hit.dispatch('/vendor/mediabunny.js')).text(), 'cached', 'then cache-first');
  assert.equal(setup().dispatch('/vendor/mediabunny.LICENSE.txt'), undefined, 'the licence text is a plain static file');
});
