// Offline shell only. API requests and generated media are never cached here.
const VERSION = 'atelier-v49';
// index.html loads these three with ?v=<n> (a test keeps it equal to VERSION), so a fresh page never runs stale cached code.
const V = VERSION.slice('atelier-v'.length);
const SHELL = ['/', '/index.html', `/app.css?v=${V}`, `/studio.css?v=${V}`, `/app.js?v=${V}`, '/data-safety.js', '/video.js',
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
