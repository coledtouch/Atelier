// Offline shell only. API requests and generated media are never cached here.
// Versioning: static files are served cache-first, so a new app.js must never load an older cached module. Three things
// move together on every deploy, to the same number <n>:
//   VERSION below ('atelier-v<n>'), index.html's ?v=<n> on /app.css, /studio.css and /app.js, and the ?v=<n> on every
//   relative import in public/*.js (app.js → './tester.js?v=<n>', context.js → './video.js?v=<n>', …).
// One step does all three:  node scripts/bump-version.mjs <n>
//   (the same by hand: sed -i -E "s/atelier-v[0-9]+'/atelier-v<n>'/" public/sw.js && sed -i -E "s/\?v=[0-9]+/?v=<n>/g" public/index.html public/*.js)
// tests/service-worker.test.mjs fails if they disagree or a module the app loads isn't precached at its ?v= URL.
const VERSION = 'atelier-v54';
const V = VERSION.slice('atelier-v'.length);
// Modules are listed at the exact ?v=<n> URLs they are imported by (PATHS drops the query for the fetch guard below).
const SHELL = ['/', '/index.html', `/app.css?v=${V}`, `/studio.css?v=${V}`, `/app.js?v=${V}`,
  `/data-safety.js?v=${V}`, `/video.js?v=${V}`, `/runway.js?v=${V}`, `/tester.js?v=${V}`, `/context.js?v=${V}`, `/lookup.js?v=${V}`, `/readaloud.js?v=${V}`, `/dictate.js?v=${V}`, `/viewport.js?v=${V}`,
  '/manifest.webmanifest', '/vendor/marked.js', '/vendor/purify.js', '/vendor/highlight.js',
  '/vendor/fflate.js', '/icons/atelier-v2-32.png', '/icons/atelier-v2-180.png', '/icons/atelier-v2-192.png', '/icons/atelier-v2-512.png', '/icons/atelier-v2-maskable-512.png', '/icons/atelier-mark-96.png',
  '/privacy', '/tos', '/legal.css'];
const PATHS = SHELL.map(u => u.split('?')[0]);
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('atelier-v') && k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  const font = ['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname);
  if (!font && (url.origin !== location.origin || !PATHS.includes(url.pathname))) return;
  const navigation = req.mode === 'navigate';
  const key = navigation ? (url.pathname === '/' ? '/index.html' : url.pathname) : req;
  const network = fetch(req).then(async response => {
    if (response.ok || response.type === 'opaque') {
      const cache = await caches.open(VERSION);
      await cache.put(key, response.clone()).catch(() => {});
    }
    return response;
  }).catch(() => null);
  // Keep refreshes alive and always handle rejection, even on a cache hit.
  e.waitUntil(network.then(() => {}));
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    if (navigation) return await network || await cache.match(key) || Response.error();
    return await cache.match(key) || await network || Response.error();
  })());
});
