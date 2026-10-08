// Offline shell only. API requests and generated media are never cached here.
// Versioning: static files are served cache-first, so a new app.js must never load an older cached module. Three things
// move together on every deploy, to the same number <n>:
//   VERSION below ('atelier-v<n>'), index.html's ?v=<n> on /app.css, /studio.css and /app.js, and the ?v=<n> on every
//   relative import in public/*.js (app.js → './tester.js?v=<n>', context.js → './video.js?v=<n>', …).
// One step does all three:  node scripts/bump-version.mjs <n>
//   (the same by hand: sed -i -E "s/atelier-v[0-9]+'/atelier-v<n>'/" public/sw.js && sed -i -E "s/\?v=[0-9]+/?v=<n>/g" public/index.html public/*.js)
// tests/service-worker.test.mjs fails if they disagree or a module the app loads isn't precached at its ?v= URL.
const VERSION = 'atelier-v81';
const V = VERSION.slice('atelier-v'.length);
// Modules are listed at the exact ?v=<n> URLs they are imported by (PATHS drops the query for the fetch guard below).
const SHELL = ['/', '/index.html', `/app.css?v=${V}`, `/studio.css?v=${V}`, `/app.js?v=${V}`,
  `/data-safety.js?v=${V}`, `/sync.js?v=${V}`, `/sync-merge.js?v=${V}`, `/video.js?v=${V}`, `/runway.js?v=${V}`, `/omni.js?v=${V}`, `/xai.js?v=${V}`, `/tester.js?v=${V}`, `/context.js?v=${V}`, `/launch.js?v=${V}`, `/lookup.js?v=${V}`, `/readaloud.js?v=${V}`, `/dictate.js?v=${V}`, `/viewport.js?v=${V}`, `/builds.js?v=${V}`, `/claude-import.js?v=${V}`, `/claude-worker.js?v=${V}`,
  `/remix.js?v=${V}`, `/remix-cuts.js?v=${V}`, `/remix-shots.js?v=${V}`, `/remix-graph.js?v=${V}`, `/remix-store.js?v=${V}`, `/remix-draw.js?v=${V}`, `/remix-app.js?v=${V}`, `/remix.css?v=${V}`,
  `/feedback.js?v=${V}`, `/feedback.css?v=${V}`,
  '/manifest.webmanifest', '/vendor/marked.js', '/vendor/purify.js', '/vendor/highlight.js',
  '/vendor/fflate.js', '/icons/atelier-v2-32.png', '/icons/atelier-v2-180.png', '/icons/atelier-v2-192.png', '/icons/atelier-v2-512.png', '/icons/atelier-v2-maskable-512.png', '/icons/atelier-mark-96.png',
  '/privacy', '/tos', '/legal.css'];
// Cached on first use, not at install: the render engine and Mediabunny (689 KB, 177 KB gzip) only load when a clip is
// attached in Video mode with Remix on, or a remix is cut.
const LAZY = ['/remix-render.js', '/vendor/mediabunny.js'];
const PATHS = [...SHELL.map(u => u.split('?')[0]), ...LAZY];
// Share target (manifest share_target: POST multipart to /share). The payload waits in its own Cache Storage bucket,
// which activate() never deletes (it isn't 'atelier-v*'); the page takes it from /?share=<id> (launch.js takeShare)
// and deletes it. Nothing lands in the URL, history or Worker logs. One pending share at a time; limits apply per File
// after parsing (a share POST's Content-Length can't be relied on), and a formData() that rejects lands on ?share=failed.
// The limits cap what is stored, not what is read: formData() holds the whole body in this worker's memory first. Running
// out of memory on a huge video kills the worker (no rejection reaches the catch), so the user gets an error page or, if
// Chrome falls back to the network, the Worker's ?share=lost (or Cloudflare's 413 above the plan's body limit). Not yet
// tried on a phone: share a ~300 MB and a ~1 GB video before relying on big ones (docs/quick-launch.md).
// Any site can POST here: a page anywhere can auto-submit a multipart form to /share as a top-level navigation, with no
// tap. The fetch handler's origin test only says the TARGET is this origin (always true for a navigation this worker
// sees); nothing here knows who started it. So a share is only ever prefilled, labelled "From another app or site" and
// never sent (launch.js), and only what one message can carry is stored (launch.js SHARE_LIMITS): one video up to 1 GB
// (Gemini's clip limit), or else up to 4 photos of 25 MB each. The rest is counted in `dropped` and never written, so
// one share stores at most 1 GB, and photos at most 100 MB.
const SHARE = 'atelier-share';
const SHARE_VIDEO_MAX = 1024 ** 3, SHARE_IMAGE_MAX = 25 * 1024 ** 2, SHARE_IMAGES = 4;
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|3gp|3g2|avi|mpe?g|ogv|wmv)$/i; // a typeless video goes by its name, as in video.js
const kindOf = (f) => (/^image\//i.test(f.type || '') ? 'image' : /^video\//i.test(f.type || '') || (!f.type && VIDEO_EXT.test(f.name || '')) ? 'video' : '');
const fits = (f) => f.size <= (kindOf(f) === 'video' ? SHARE_VIDEO_MAX : SHARE_IMAGE_MAX);
const home = (s) => Response.redirect(new URL(`/?share=${s}`, location.origin).href, 303); // absolute: Node's Response.redirect needs it
const shareId = () => 's' + Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => (b % 36).toString(36)).join('');
async function takeShare(req) {
  let form;
  try { form = await req.formData(); } catch { return home('failed'); } // a malformed body; running out of memory is a crash, not this
  const str = (v) => (typeof v === 'string' ? v.trim().slice(0, 8000) : '');
  const all = form.getAll('media').filter((f) => f && typeof f === 'object' && f.size > 0);
  const video = all.find((f) => kindOf(f) === 'video' && fits(f)); // one video per message, as app.js addFiles attaches
  const files = video ? [video] : all.filter((f) => kindOf(f) === 'image' && fits(f)).slice(0, SHARE_IMAGES);
  const dropped = all.length - files.length;
  const tooBig = all.some((f) => kindOf(f) && !fits(f));
  const title = str(form.get('title')), text = str(form.get('text')), url = str(form.get('url'));
  if (!files.length && !title && !text && !url) return home(tooBig ? 'big' : 'failed');
  const id = shareId();
  try {
    await caches.delete(SHARE); // one pending share at a time
    const cache = await caches.open(SHARE);
    await Promise.all(files.map((f, i) => cache.put(`/__share/${id}/${i}`, new Response(f, { headers: { 'content-type': f.type || 'application/octet-stream' } }))));
    await cache.put(`/__share/${id}/meta`, new Response(JSON.stringify({ id, at: Date.now(), title, text, url, dropped,
      files: files.map((f, i) => ({ i, name: String(f.name || `shared-${i + 1}`).slice(0, 120), type: f.type || '' })) }), { headers: { 'content-type': 'application/json' } }));
  } catch { return home('failed'); }
  return home(id);
}
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('atelier-v') && k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  // The target is /share on this origin; the page that started the navigation may be any site (see takeShare above).
  if (req.method === 'POST' && req.mode === 'navigate' && url.origin === location.origin && url.pathname === '/share') return e.respondWith(takeShare(req));
  if (req.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  const font = ['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname);
  if (!font && (url.origin !== location.origin || !PATHS.includes(url.pathname))) return;
  const navigation = req.mode === 'navigate';
  // The manifest goes to the network first, like pages: Chrome's WebAPK update check reads it through this worker, and a
  // cached copy would tell it nothing changed (new shortcuts, share_target) until the next check a day later.
  const fresh = navigation || req.destination === 'manifest' || url.pathname === '/manifest.webmanifest';
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
    if (fresh) return await network || await cache.match(key) || Response.error();
    return await cache.match(key) || await network || Response.error();
  })());
});
