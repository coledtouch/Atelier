// Look up: highlight a short name or term in a finished answer → a short Wikipedia summary and a free Commons image
// (GET /api/lookup, src/lookup.js). Images come through Atelier's own GET /api/lookup/img proxy as blobs, so Wikipedia
// and Wikimedia never see the viewer's device. The pure helpers and createController are node-tested
// (tests/lookup-client.test.mjs); initLookup() is the DOM adapter app.js calls once. Nothing here touches the DOM at
// import time.

// ── constants ──
// Mutable on purpose (like VIDEO_TIMING): tests shorten them.
export const LOOKUP_TIMING = { touch: 350, mouse: 120, mouseMulti: 260, key: 450, menuFast: 60, grace: 150, skeleton: 250, scrollIdle: 150, userWindow: 600, fetchTimeout: 8000, toastOnce: 0 };
// handleClear: room under the last line for Android's selection handles; nativeBar: room over the first line for
// Chrome's Copy / Share / Web search bar (48dp + 2×8dp). Both are calibrated from the lookupDebug trace on a phone.
export const LOOKUP_GEOMETRY = Object.freeze({ gutter: 16, edge: 8, gapMouse: 8, handleClear: 32, nativeBar: 72, minRoom: 120, phoneBreak: 640, phoneMax: 420, deskW: 360 });
export const LOOKUP_MODES = Object.freeze(['auto', 'tap', 'off']);
export const KINDS = Object.freeze(['ask', 'code', 'image', 'video', 'ideas', 'build']);
export const LICENSE = Object.freeze({ name: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' });
// The same list as src/lookup.js WIKIS: a device language outside it reads English Wikipedia.
export const WIKIS = Object.freeze(['en', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'pl', 'ru', 'uk', 'ja', 'zh', 'ko', 'ar', 'he', 'fa', 'tr', 'sv', 'no', 'da', 'fi', 'cs', 'hu', 'ro', 'el', 'id', 'vi', 'th', 'hi', 'bn', 'ca', 'eu', 'gl', 'sr', 'hr', 'sk', 'bg', 'ms', 'et', 'lt', 'lv', 'sl', 'zh-yue']);
// Where a selection may start a look-up: finished answer prose and idea titles/pitches. Streaming entries
// (aria-busy=true) are rebuilt every 33–300 ms, so a selection there never settles.
const DONE = '#stream li.entry[aria-busy="false"]';
export const ELIGIBLE = `${DONE} .out .prose, ${DONE} .idea > h4, ${DONE} .idea > p`;
export const EXCLUDE = 'pre, code, kbd, samp, .codeblock, .think, .meta-line, .steps, .approve-card, .actions, .idea-acts, .error-box, .cut-note, button, input, textarea, select, [contenteditable], .lookup';
export const COPY = Object.freeze({
  lookUp: 'Look up', wikipedia: 'Wikipedia', bestMatch: 'Best match', meanings: 'A few meanings', canMean: (t) => `“${t}” can mean`,
  back: '← Meanings', notQuite: 'Not quite?', closest: 'Closest:', ask: 'Ask about this', wikiLink: 'Wikipedia', search: 'Search Wikipedia',
  retry: 'Try again', close: 'Close look up', noArticle: 'No Wikipedia article matches this.', editors: 'Wikipedia editors', shortened: 'shortened',
  image: 'Image', imageCaption: 'Image · Wikimedia Commons', newTab: ' (opens in a new tab)', thumb: 'Show a larger image and the full summary',
  pill: (t) => `Look up “${t}” on Wikipedia`, prefilled: 'Added to your message. Edit it, then send.', unavailable: 'Look up isn’t available right now.',
});
export const ERRORS = Object.freeze({
  offline: 'You’re offline.',
  unavailable: 'Couldn’t reach Wikipedia.',
  busy: 'Wikipedia is busy — try again in a few seconds.',
  rate: 'Too many look-ups — try again in a minute.',
  signin: 'Sign in to look things up.',
  off: 'Look up isn’t available right now.',
});
const RETRYABLE = new Set(['offline', 'unavailable', 'busy', 'rate']);

// ── text ──
// Keep this function character-identical to src/lookup.js cleanTerm (tests/lookup-client.test.mjs checks both).
export function cleanTerm(raw) {
  if (typeof raw !== 'string' || raw.length > 4000) return null;
  const pairs = [['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’'], ['„', '“'], ['„', '”'], ['‚', '‘'], ['‚', '’'], ['«', '»'], ['»', '«'], ['‹', '›'],
    ['›', '‹'], ['(', ')'], ['（', '）'], ['「', '」'], ['『', '』']];
  const count = (s, c) => s.split(c).length - 1;
  const wraps = (s, open, close) => {
    if (s.length < 2 || s[0] !== open || s[s.length - 1] !== close) return false;
    if (open === close) return !s.slice(1, -1).includes(open);
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === open) depth++;
      else if (s[i] === close && --depth === 0 && i < s.length - 1) return false;
    }
    return depth === 0;
  };
  let s = raw.normalize('NFC')
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f­​‎‏‪-‮⁠-⁤⁦-⁩﻿]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\[(?:\d{1,3}|citation needed)\]/gi, '')
    .replace(/[*_~]/g, '')
    .trim();
  // Code-like text (=, ;, braces, backticks, ::, ${, word()) is never sent; a trailing ; or . is just punctuation.
  if (/[={};`]|::|\$\{|[\p{L}\p{N}]\(\)/u.test(s.replace(/[\s.,;:!?…]+$/, ''))) return null;
  // A letter's # is "sharp", as Wikipedia names it ("F# major" → "F sharp major", "C#" → "C sharp"); then the
  // characters a Wikipedia title can't contain go.
  s = s.replace(/([A-Za-z])#(?=[\s,.;:!?)]|$)/g, '$1 sharp').replace(/[#<>[\]|]/g, '').replace(/\s+/g, ' ').trim();
  for (let prev = null; prev !== s;) {
    prev = s;
    s = s.replace(/^(?:[-–—•·▪◦‣+>]|\d{1,3}[.)])\s+/, '').replace(/[.,;:!?…]+$/, '').trim();
    const pair = pairs.find(([open, close]) => wraps(s, open, close));
    if (pair) { s = s.slice(1, -1).trim(); continue; }
    // An unbalanced quote or bracket at either end: an opener with no closer after it, a closer with no opener before it.
    const head = s[0], tail = s[s.length - 1];
    const closers = pairs.filter(([open]) => open === head).map(([, close]) => close);
    const headOpeners = pairs.filter(([, close]) => close === head);
    if (closers.length ? (closers.includes(head) ? count(s, head) % 2 === 1 : !closers.some((c) => s.slice(1).includes(c))) : headOpeners.length > 0) {
      s = s.slice(1).trim();
      continue;
    }
    const openers = pairs.filter(([, close]) => close === tail).map(([open]) => open);
    const tailClosers = pairs.filter(([open]) => open === tail);
    if (openers.length ? (openers.includes(tail) ? count(s, tail) % 2 === 1 : !openers.some((o) => s.slice(0, -1).includes(o))) : tailClosers.length > 0) {
      s = s.slice(0, -1).trim();
    }
  }
  if (s.length < 2 || s.length > 120 || s.split(' ').length > 12) return null;
  if (!/\p{L}/u.test(s)) return null; // at least one letter
  if (/\S+@\S+\.\S+/.test(s)) return null; // an email address
  if (/[a-z][a-z\d+.-]*:\/\/|\bwww\./i.test(s)) return null; // a link
  if (/\d(?:[ .-]?\d){6,}/.test(s)) return null; // a phone, card or account number: 7+ digits
  if (s.includes('./')) return null; // '.', '..', './x', 'a/../b' (path tricks)
  return s;
}

/** A cleaned term → 'auto' (opens by itself), 'tap' (a Look up pill first) or 'none'. */
export function classify(term) {
  if (typeof term !== 'string' || !term.trim()) return 'none';
  const words = term.trim().split(/\s+/).length, n = term.length;
  return words <= 6 && n <= 80 ? 'auto' : words <= 12 && n <= 120 ? 'tap' : 'none';
}

const LANG_ALIASES = { nb: 'no', yue: 'zh-yue' };
/** navigator.languages → the Wikipedia to read: { lang } or { lang, variant } (zh script/region, sr Latin). */
export function wikiLang(languages = []) {
  const tag = String((Array.isArray(languages) ? languages[0] : languages) || '').trim().toLowerCase();
  const [first = '', ...rest] = tag.split(/[-_]/);
  const lang = LANG_ALIASES[first] || first;
  if (!WIKIS.includes(lang)) return { lang: 'en' };
  if (lang === 'zh') {
    if (rest.includes('hk')) return { lang, variant: 'zh-hk' };
    if (rest.some((r) => r === 'tw' || r === 'mo' || r === 'hant')) return { lang, variant: 'zh-tw' };
    if (rest.some((r) => r === 'cn' || r === 'sg' || r === 'hans')) return { lang, variant: 'zh-cn' };
  }
  if (lang === 'sr' && rest.includes('latn')) return { lang, variant: 'sr-el' };
  return { lang };
}

/** "Ask about this": the SELECTED words (never the Wikipedia title), so a wrong match never misleads the model. */
export function askPrompt(term) {
  const t = String(term ?? '').replace(/\s+/g, ' ').trim();
  return `Tell me more about “${t.length > 300 ? t.slice(0, 300) + '…' : t}”.`; // never starts with '/', so submit() never reads a slash command
}

// ── geometry ──
const rnd = (n) => Math.round(n);
const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);
/** A range's client rects → { first (smallest top), last (largest bottom) }, ignoring rects under 1px. */
export function lineRects(list) {
  let first = null, last = null;
  for (const r of list || []) {
    const w = r.width ?? r.right - r.left, h = r.height ?? r.bottom - r.top;
    if (!(w >= 1 && h >= 1)) continue;
    if (!first || r.top < first.top) first = r;
    if (!last || r.bottom >= last.bottom) last = r;
  }
  return first ? { first, last } : null;
}

/**
 * Where the card goes, in layout-viewport px (the space getClientRects uses).
 * Touch: below the handles, else above Chrome's selection bar, else the roomier side (≥ minRoom), else docked over the
 * composer. Mouse: above, else below. A side chosen earlier (prefer) is kept while it has room, so a growing card caps
 * its height instead of flipping. dock: true places it over the composer directly (an anchor scrolled away).
 */
export function place({ first, last, w, h, band, touch = false, phone = false, prefer = null, dock = false }) {
  const G = LOOKUP_GEOMETRY;
  const bandH = Math.max(0, band.bottom - band.top), bandW = band.right - band.left;
  const xFor = (anchor) => {
    if (phone || !anchor) return band.left + Math.max(0, (bandW - w) / 2);
    const aw = anchor.width ?? anchor.right - anchor.left;
    return clamp(anchor.left + aw / 2 - w / 2, band.left, Math.max(band.left, band.right - w));
  };
  const docked = () => { const maxH = bandH; return { x: rnd(xFor(phone ? null : last)), y: rnd(band.bottom - Math.min(h, maxH)), side: 'dock', maxH: rnd(maxH) }; };
  if (dock || !first || !last) return docked();
  const top = Math.max(last.bottom + (touch ? G.handleClear : G.gapMouse), band.top); // never under the top bar
  const bottom = Math.min(first.top - (touch ? G.nativeBar : G.gapMouse), band.bottom);
  const room = { below: band.bottom - top, above: bottom - band.top };
  let side = null;
  if ((prefer === 'below' || prefer === 'above') && room[prefer] >= Math.min(h, G.minRoom)) side = prefer;
  if (!side) side = (touch ? ['below', 'above'] : ['above', 'below']).find((s) => room[s] >= h) || null;
  if (!side) {
    const best = room.below > room.above || (room.below === room.above && touch) ? 'below' : 'above';
    if (room[best] >= G.minRoom) side = best;
  }
  if (!side) return docked();
  const maxH = Math.max(0, room[side]);
  const y = side === 'below' ? top : bottom - Math.min(h, maxH);
  return { x: rnd(xFor(side === 'above' ? first : last)), y: rnd(y), side, maxH: rnd(maxH) };
}

/** srcset [[w, url], …] ascending → the smallest width covering cssPx at the device ratio (capped at 2×), else the largest. */
export function pickWidth(srcset, cssPx, dpr = 1) {
  if (!Array.isArray(srcset) || !srcset.length) return null;
  const need = cssPx * Math.min(Math.max(Number(dpr) || 1, 1), 2);
  return (srcset.find(([w]) => w >= need) || srcset.at(-1))[1];
}

// ── payload validation (defence in depth: the server already whitelists every field) ──
/**
 * The only image URLs the card loads: Atelier's own image proxy, and the :8791 fixture's icons. Never a Wikimedia
 * host — the owner promised testers that Wikipedia and Wikimedia never see their device.
 */
export function safeImageUrl(u) {
  if (typeof u !== 'string') return null;
  if (/^\/icons\/[\w.-]+\.png$/.test(u)) return u;
  if (/^\/api\/lookup\/img\?k=[A-Za-z0-9%._~-]{1,1800}$/.test(u)) return u; // src/lookup.js proxyImageUrl(key)
  return null;
}
/** The first bytes of an image → its type. Only raster formats an <img> shows; never SVG or HTML. */
export function sniffImage(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

const CTRL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
// Plain text only: the card renders every string with textContent, so markup stays literal characters.
const str = (v, cap) => (typeof v === 'string' ? v.replace(CTRL, ' ').replace(/\s+/g, ' ').trim().slice(0, cap) : '');
const WIKI_URL = /^https:\/\/[a-z0-9-]+\.wikipedia\.org\/wiki\/[^\s"'<>]+$/;
const SEARCH_URL = /^https:\/\/[a-z0-9-]+\.wikipedia\.org\/w\/index\.php\?search=[^\s"'<>]+$/;
const FILE_PAGE = /^https:\/\/commons\.wikimedia\.org\/wiki\/File:[^\s"'<>]+$/;
const isWidth = (n) => Number.isInteger(n) && n >= 16 && n <= 4096;
const isDim = (n) => Number.isInteger(n) && n >= 1 && n <= 10000;
function imageOf(i) {
  if (!i || typeof i !== 'object' || !safeImageUrl(i.src) || !isDim(i.width) || !isDim(i.height)) return null;
  if (typeof i.page !== 'string' || !FILE_PAGE.test(i.page)) return null;
  const raw = i.srcset == null ? [[Math.min(i.width, 4096), i.src]] : i.srcset;
  if (!Array.isArray(raw) || !raw.length || raw.length > 8) return null;
  const srcset = [];
  for (const pair of raw) {
    if (!Array.isArray(pair) || pair.length !== 2 || !isWidth(pair[0]) || !safeImageUrl(pair[1])) return null;
    srcset.push([pair[0], pair[1]]);
  }
  srcset.sort((a, b) => a[0] - b[0]);
  return { src: i.src, width: i.width, height: i.height, srcset, file: str(i.file, 240), page: i.page, mat: i.mat === true };
}
// A name to look up next. ref: the real title to ask for (title=), sent by the server only when the shown title is a
// display form ("iPhone" for the page IPhone, a zh/sr variant).
const pairs = (list, n) => (Array.isArray(list) ? list : []).map((p) => {
  const title = str(p?.title, 200), ref = str(p?.ref, 255);
  return { title, description: str(p?.description, 120), ...(ref && ref !== title ? { ref } : {}) };
}).filter((p) => p.title).slice(0, n);
/** The server's JSON → the card model, or null for an unknown shape (shown as "Couldn't reach Wikipedia"). */
export function cardModel(j) {
  if (!j || typeof j !== 'object' || j.v !== 1 || typeof j.found !== 'boolean') return null;
  const kind = j.found ? j.kind : 'none';
  if (!['article', 'choices', 'none'].includes(kind)) return null;
  const m = {
    kind,
    via: ['title', 'inner', 'search'].includes(j.via) ? j.via : 'title',
    lang: typeof j.lang === 'string' && /^[a-z][a-z-]{1,19}$/.test(j.lang) ? j.lang : 'en',
    dir: j.dir === 'rtl' ? 'rtl' : 'ltr',
    query: str(j.query, 120),
    title: str(j.title, 200),
    description: str(j.description, 120),
    extract: str(j.extract, 600),
    trimmed: j.trimmed === true,
    url: typeof j.url === 'string' && WIKI_URL.test(j.url) ? j.url : null,
    search: typeof j.search === 'string' && SEARCH_URL.test(j.search) ? j.search : null,
    image: kind === 'article' ? imageOf(j.image) : null,
    choices: kind === 'choices' ? pairs(j.choices, 4) : [],
    others: pairs(j.others, 2),
    license: LICENSE,
  };
  if (kind === 'article' && !m.title) return null;
  if (kind === 'choices' && !m.choices.length) return null;
  return m;
}
const noneModel = (query) => ({ kind: 'none', via: 'title', lang: 'en', dir: 'ltr', query: str(query, 120), title: '', description: '', extract: '', trimmed: false, url: null, search: null, image: null, choices: [], others: [], license: LICENSE });

/** Which answer text a selection sits in: { root, entry } when both ends share one eligible root, else null. */
export function eligibleRoot(range) {
  if (!range) return null;
  const el = (n) => (!n ? null : n.nodeType === 1 ? n : n.parentElement);
  const a = el(range.startContainer), b = el(range.endContainer);
  if (!a || !b || typeof a.closest !== 'function' || typeof b.closest !== 'function') return null;
  const root = a.closest(ELIGIBLE);
  if (!root || b.closest(ELIGIBLE) !== root) return null;
  if (a.closest(EXCLUDE) || b.closest(EXCLUDE)) return null;
  return { root, entry: root.closest('li.entry') };
}

// ── network: GET /api/lookup (+ the /api/lookup/img proxy for pictures) ──
const abortError = () => new DOMException('Aborted', 'AbortError');
function withTimeout(signal, ms) {
  if (typeof AbortSignal.any === 'function' && typeof AbortSignal.timeout === 'function') return { signal: AbortSignal.any([signal, AbortSignal.timeout(ms)]), done: () => {} };
  const c = new AbortController(), stop = () => c.abort();
  const t = setTimeout(() => c.abort(new DOMException('Timed out', 'TimeoutError')), ms);
  signal.addEventListener('abort', stop, { once: true });
  return { signal: c.signal, done: () => { clearTimeout(t); signal.removeEventListener('abort', stop); } };
}
/**
 * One page-wide client: an LRU of finished views (errors are never kept), one request per key in flight however many
 * callers wait on it, and the error mapping the card shows. get() resolves a View {state, model?, code?, retryAfter?}.
 */
export function createLookupClient({ fetch, headers = () => ({}), now = Date.now, online = () => true, max = 50, ttlMs = 30 * 60e3, negTtlMs = 5 * 60e3, timeoutMs = LOOKUP_TIMING.fetchTimeout, imageMax = 16, imageBytes = 2 * 1024 * 1024 } = {}) {
  const cache = new Map(), inflight = new Map(), blobs = new Map();
  const keyOf = (req) => `${req.lang || 'en'}|${req.variant || ''}|${req.q != null ? 'q:' + String(req.q).toLowerCase() : 't:' + req.title}`;
  const fail = () => ({ state: 'error', code: online() ? 'unavailable' : 'offline' });
  function peek(req) {
    const k = keyOf(req), e = cache.get(k);
    if (!e) return undefined;
    cache.delete(k);
    if (now() > e.exp) return undefined;
    cache.set(k, e);
    return e.view;
  }
  function store(k, view) {
    cache.delete(k);
    cache.set(k, { view, exp: now() + (view.state === 'none' ? negTtlMs : ttlMs) });
    while (cache.size > max) cache.delete(cache.keys().next().value);
  }
  async function run(req, k, ctrl) {
    const p = req.q != null ? { q: req.q } : { title: req.title };
    const url = '/api/lookup?' + new URLSearchParams({ ...p, lang: req.lang || 'en', ...(req.variant && { v: req.variant }) });
    const t = withTimeout(ctrl.signal, timeoutMs);
    try {
      let r;
      try { r = await fetch(url, { headers: headers(), cache: 'no-store', credentials: 'same-origin', signal: t.signal }); } catch {
        if (ctrl.signal.aborted) throw abortError();
        return fail();
      }
      let j = null;
      try { j = await r.json(); } catch { if (ctrl.signal.aborted) throw abortError(); }
      if (r.status === 200) {
        const model = cardModel(j);
        if (!model) return fail();
        const view = { state: model.kind, model };
        store(k, view);
        return view;
      }
      if (r.status === 400) return { state: 'none', model: noneModel(p.q ?? p.title) };
      if (r.status === 401) return { state: 'error', code: 'signin' };
      if (r.status === 403 || (r.status === 503 && j?.code === 'lookup_off')) return { state: 'error', code: 'off' };
      if (r.status === 429) {
        const retryAfter = clamp(Number(r.headers?.get?.('retry-after') ?? j?.retryAfter) || 10, 1, 120);
        return { state: 'error', code: j?.code === 'lookup_rate' ? 'rate' : 'busy', retryAfter };
      }
      return fail();
    } finally { t.done(); }
  }
  function get(req, signal) {
    const hit = peek(req);
    if (hit) return Promise.resolve(hit);
    if (signal?.aborted) return Promise.reject(abortError());
    const k = keyOf(req);
    let entry = inflight.get(k);
    if (!entry) {
      const ctrl = new AbortController();
      entry = { ctrl, waiters: 0, promise: null };
      const mine = entry;
      entry.promise = run(req, k, ctrl).finally(() => { if (inflight.get(k) === mine) inflight.delete(k); });
      inflight.set(k, entry);
    }
    const e = entry;
    e.waiters++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const leave = () => {
        if (settled) return;
        settled = true;
        if (--e.waiters <= 0) { if (inflight.get(k) === e) inflight.delete(k); e.ctrl.abort(); }
        reject(abortError());
      };
      signal?.addEventListener('abort', leave, { once: true });
      e.promise.then(
        (v) => { if (settled) return; settled = true; signal?.removeEventListener('abort', leave); resolve(v); },
        (err) => { if (settled) return; settled = true; signal?.removeEventListener('abort', leave); reject(err); },
      );
    });
  }
  /** A proxied picture → a Blob typed by its own bytes (null on any failure). Kept in a small in-memory LRU. */
  async function image(src, signal) {
    if (!safeImageUrl(src)) return null;
    const hit = blobs.get(src);
    if (hit) { blobs.delete(src); blobs.set(src, hit); return hit; }
    try {
      const r = await fetch(src, { headers: headers(), credentials: 'same-origin', signal });
      if (!r.ok) return null;
      const blob = await r.blob();
      if (!blob.size || blob.size > imageBytes) return null;
      const type = sniffImage(new Uint8Array(await blob.slice(0, 16).arrayBuffer()));
      if (!type) return null;
      const typed = blob.type === type ? blob : new Blob([blob], { type });
      blobs.set(src, typed);
      while (blobs.size > imageMax) blobs.delete(blobs.keys().next().value);
      return typed;
    } catch { return null; }
  }
  return { get, peek, image, clear: () => { cache.clear(); blobs.clear(); } };
}

// ── the state machine (DOM-free; initLookup supplies fx) ──
/**
 * idle → (settle) → pill | waiting → loading (after LOOKUP_TIMING.skeleton) → card. One timer per job, nothing polled.
 * fx: { mode(), ready(), read() → Snapshot|null, cached(req), fetch(req, seq), abort(), show(view, snap), hide(reason),
 *       moving(on), reposition(), reanchor?(snap), highlight(range|null), announce(view, snap), disable(), online?(),
 *       defaultInput?(), log?() }
 * Snapshot: { term, tier, entryId, kind, range, node, endNode } — node/endNode: the selection's own boundary nodes (a live
 * Range moves to the parent when its text is removed, so only these tell that the words are gone).
 */
export function createController({ schedule = (fn, ms) => setTimeout(fn, ms), cancel = (id) => clearTimeout(id), now = Date.now, timing = LOOKUP_TIMING, fx }) {
  let state = 'idle', visible = false, pinned = false, term = null, snap = null, seq = 0, lastReq = null;
  let lastInput = null, buttonDown = false, disabled = false;
  const timers = { settle: null, grace: null, skel: null, idle: null };
  const clear = (k) => { if (timers[k] != null) { cancel(timers[k]); timers[k] = null; } };
  const later = (k, ms, fn) => { clear(k); timers[k] = schedule(() => { timers[k] = null; fn(); }, ms); };
  const log = (...a) => fx.log?.(...a);
  const input = () => lastInput || fx.defaultInput?.() || 'mouse';

  function show(view) { visible = true; fx.moving(false); fx.show(view, snap); } // a new view is never left faded
  // The same words selected again, maybe somewhere else: the card (and a pinned card's mark) follows the new selection.
  function reanchor(s) {
    snap = s;
    fx.reanchor?.(s);
    if (pinned) fx.highlight(s.range);
  }
  function close(reason = 'close') {
    for (const k of Object.keys(timers)) clear(k);
    const was = state !== 'idle' || visible;
    state = 'idle'; visible = false; pinned = false; term = null; snap = null; lastReq = null; seq++;
    if (was) { fx.abort(); fx.hide(reason); fx.highlight(null); }
  }
  function request(req, forced) {
    lastReq = req;
    const hit = fx.cached(req);
    if (hit) { clear('skel'); seq++; state = 'card'; show(hit); fx.announce(hit, snap); return; }
    if (!forced && fx.online && !fx.online()) { log('offline: nothing to show'); close('offline'); return; } // Automatic + offline: stay quiet
    const my = ++seq;
    state = 'waiting';
    later('skel', timing.skeleton, () => { if (state === 'waiting' && seq === my) { state = 'loading'; show({ state: 'loading' }); } });
    fx.fetch(req, my);
  }
  function settle() {
    if (disabled || fx.mode() === 'off' || !fx.ready()) { if (!pinned) close('off'); return; }
    const s = fx.read();
    log('settle', s && { term: s.term, tier: s.tier, input: input() });
    if (!s || s.tier === 'none') { if (!pinned) close('gone'); return; }
    if (s.term === term && state !== 'idle') { reanchor(s); fx.moving(false); fx.reposition(); return; }
    if (state !== 'idle') { clear('skel'); fx.abort(); if (pinned) { pinned = false; fx.highlight(null); } }
    term = s.term; snap = s;
    if (fx.mode() === 'tap' || s.tier === 'tap') { seq++; state = 'pill'; show({ state: 'pill' }); return; }
    request({ q: s.term }, false);
  }
  return {
    get state() { return state; },
    get visible() { return visible; },
    get pinned() { return pinned; },
    get term() { return term; },
    get snap() { return snap; },
    get lastInput() { return input(); },
    selectionChanged({ collapsed }) {
      clear('settle');
      if (collapsed) {
        if (pinned || state === 'idle') return;
        later('grace', timing.grace, () => { if (!pinned && !fx.read()) close('collapsed'); });
        return;
      }
      clear('grace');
      if (visible && !pinned) fx.moving(true);
      const i = input();
      if (i === 'mouse' && buttonDown) return; // a drag in progress: wait for mouseup
      later('settle', i === 'touch' ? timing.touch : i === 'key' ? timing.key : timing.mouse, settle);
    },
    pointerDown({ type }) {
      lastInput = type === 'mouse' ? 'mouse' : 'touch';
      buttonDown = type === 'mouse';
      if (buttonDown) clear('settle');
    },
    pointerUp({ type, detail = 1 }) {
      if (type !== 'mouse') return;
      lastInput = 'mouse'; buttonDown = false;
      later('settle', detail >= 2 ? timing.mouseMulti : timing.mouse, settle);
    },
    keySelection() { lastInput = 'key'; buttonDown = false; },
    contextMenu({ collapsed }) {
      log('contextmenu', { collapsed, input: input() });
      if (!collapsed && input() === 'touch') later('settle', timing.menuFast, settle); // Android: the selection menu just opened
    },
    /** Alt+L with a live selection: look it up now, whatever the mode's tier rules say. */
    forceLookup() {
      if (disabled || fx.mode() === 'off' || !fx.ready()) return false;
      const s = fx.read();
      if (!s) return false;
      clear('settle'); clear('grace');
      if (s.term === term && visible && state === 'card') { reanchor(s); fx.reposition(); return true; }
      if (state !== 'idle') { clear('skel'); fx.abort(); }
      term = s.term; snap = s;
      request({ q: s.term }, true);
      return true;
    },
    pillTap() {
      if (state !== 'pill' || !snap) return;
      pinned = true; fx.highlight(snap.range);
      request({ q: snap.term }, true);
    },
    /** A choice row or a "Not quite?" name: that exact title, same anchor. */
    lookTitle(title) {
      if (state === 'idle' || !snap || typeof title !== 'string' || !title) return;
      if (!pinned) { pinned = true; fx.highlight(snap.range); }
      fx.abort(); clear('skel');
      request({ title }, true);
    },
    /** "← Meanings": a view the adapter kept, shown again without a request. */
    showView(view) {
      if (state === 'idle' || !view) return;
      seq++; clear('skel'); fx.abort();
      state = 'card'; show(view); fx.announce(view, snap);
    },
    retry() {
      if (state === 'idle' || !lastReq) return;
      fx.abort(); clear('skel');
      request(lastReq, true);
    },
    result(view, mySeq) {
      if (mySeq !== seq || state === 'idle' || state === 'pill') return; // stale, closed, or not asked
      clear('skel');
      log('result', view && { state: view.state, code: view.code });
      if (view?.code === 'off') { disabled = true; fx.disable(); close('off'); return; }
      state = 'card'; show(view); fx.announce(view, snap);
    },
    pin() {
      if (state === 'idle' || !snap || pinned) return;
      pinned = true; fx.highlight(snap.range);
    },
    scroll({ userDriven }) {
      if (!visible) return;
      if (userDriven) { fx.moving(true); later('idle', timing.scrollIdle, () => { fx.moving(false); fx.reposition(); }); }
      else fx.reposition(); // the app's own scroll (an answer streaming below): follow the anchor
    },
    scrollEnd() {
      if (timers.idle == null) return;
      clear('idle'); fx.moving(false); fx.reposition();
    },
    outsideClick({ selectionLive }) { if (state === 'idle' || selectionLive) return; close('outside'); },
    anchorLost() { if (state !== 'idle') close('anchor'); },
    overlay() { if (state !== 'idle') close('overlay'); },
    focusOutside() { if (state !== 'idle') close('focus'); },
    hidden() { if (state !== 'idle') close('hidden'); },
    keyboardOpen() { if (state !== 'idle') close('keyboard'); },
    /** true when Escape closed a card the person could see — the caller then keeps Escape from reaching stopAll(). */
    escape() {
      if (visible) { close('escape'); return true; }
      if (state !== 'idle') close('escape'); // a request nobody can see yet: drop it, let Escape do its usual job
      return false;
    },
    close,
  };
}

// ── rendering (createElement / textContent / setAttribute only) ──
const SVG_NS = 'http://www.w3.org/2000/svg';
const ICON = { chat: 'M4 5h16v11H9l-5 4z', x: 'M6 6l12 12M18 6 6 18', book: 'M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5zM5 19.5A1.5 1.5 0 0 0 6.5 21H19' };
const STATES = ['pill', 'loading', 'article', 'choices', 'none', 'error'];
function make(doc, tag, attrs, ...kids) {
  const el = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') { for (const c of String(v).split(' ')) if (c) el.classList.add(c); }
    else if (k === 'text') el.textContent = String(v);
    else if (k.startsWith('data-')) el.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  const list = kids.filter((c) => c != null && c !== false && c !== '');
  if (list.length) el.append(...list);
  return el;
}
function icon(doc, name) {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
  const path = doc.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICON[name]);
  svg.append(path);
  return svg;
}
const ext = (doc, href, cls, label, arrow = true) => make(doc, 'a', { class: cls, href, target: '_blank', rel: 'noopener noreferrer' },
  label, arrow ? make(doc, 'span', { 'aria-hidden': 'true', text: ' ↗' }) : null, make(doc, 'span', { class: 'sr-only', text: COPY.newTab }));
const dot = (doc) => make(doc, 'span', { 'aria-hidden': 'true', text: '·' });
function picture(doc, model, { onFail, ctx, src }) {
  const img = make(doc, 'img', { alt: model.title, width: model.image.width, height: model.image.height });
  img.referrerPolicy = 'no-referrer';
  img.decoding = 'async';
  img.onload = () => img.classList.add('ok');
  img.onerror = () => { onFail(); ctx.onLayout?.(); };
  img.dataset.lkSrc = src; // a validated same-origin URL; the adapter loads it as a blob
  return img;
}

/** Fills #lookupCard for one view. ctx: { term, kind, phone, dpr, history, expanded, disabledUntil, now, canAsk, contentWidth, loadImage, onLayout }. */
export function renderCard(doc, card, view, ctx = {}) {
  const state = STATES.includes(view?.state) ? view.state : 'error';
  const m = view?.model || null;
  const term = ctx.term || m?.query || '';
  card.dataset.state = state;
  if (KINDS.includes(ctx.kind)) card.dataset.kind = ctx.kind; else delete card.dataset.kind;
  card.setAttribute('aria-busy', state === 'loading' ? 'true' : 'false');
  const open = Boolean(ctx.expanded) && state === 'article' && Boolean(m?.image || m?.extract);
  card.classList.toggle('is-open', open);
  if (state === 'pill') {
    for (const a of ['role', 'aria-labelledby', 'aria-describedby', 'aria-keyshortcuts']) card.removeAttribute(a);
    card.replaceChildren(make(doc, 'button', { type: 'button', class: 'lk-pill', 'data-lk': 'pill', 'aria-label': COPY.pill(term) },
      icon(doc, 'book'), make(doc, 'span', { text: COPY.lookUp }), make(doc, 'i', { text: term })));
    return;
  }
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'false');
  card.setAttribute('aria-keyshortcuts', 'Alt+L');
  card.setAttribute('aria-labelledby', 'lkTitle');
  const content = m ? { lang: m.lang, dir: m.dir === 'rtl' ? 'rtl' : null } : {}; // Wikipedia's language on its own words; the UI copy stays the page's
  const kids = [];
  if (ctx.history) kids.push(make(doc, 'button', { type: 'button', class: 'mini lk-back', 'data-lk': 'back' }, COPY.back));
  const eyebrow = (text) => make(doc, 'p', { class: 'lk-eyebrow' }, make(doc, 'span', { text }));
  const askBtn = ctx.canAsk === false ? null : make(doc, 'button', { type: 'button', class: 'mini lk-ask', 'data-lk': 'ask' }, icon(doc, 'chat'), COPY.ask);
  const closeBtn = make(doc, 'button', { type: 'button', class: 'icon-btn lk-x', 'data-lk': 'close', 'aria-label': COPY.close }, icon(doc, 'x'));
  const acts = (...mid) => make(doc, 'div', { class: 'lk-acts' }, askBtn, ...mid, make(doc, 'span', { class: 'grow' }), closeBtn);
  const titleBtns = (label, list) => make(doc, 'p', { class: 'lk-alts', ...content }, make(doc, 'span', { text: label }),
    ...list.flatMap((o, i) => [i ? dot(doc) : null, make(doc, 'button', { type: 'button', 'data-lk': 'alt', 'data-title': o.ref || o.title, title: o.description || null }, o.title)]));
  const foot = (img) => make(doc, 'p', { class: 'lk-foot' }, make(doc, 'span', { text: COPY.editors }), dot(doc), ext(doc, LICENSE.url, null, LICENSE.name, false),
    m?.trimmed ? dot(doc) : null, m?.trimmed ? make(doc, 'span', { text: COPY.shortened }) : null,
    img ? dot(doc) : null, img ? ext(doc, img.page, null, COPY.image) : null);
  let described = false;

  if (state === 'loading') {
    kids.push(eyebrow(COPY.wikipedia), make(doc, 'p', { id: 'lkTitle', class: 'lk-title is-term' }, make(doc, 'span', { class: 'shimmer', text: term })),
      make(doc, 'div', { class: 'lk-skel', 'aria-hidden': 'true' }, make(doc, 'span', { class: 'skel skel-line' }), make(doc, 'span', { class: 'skel skel-line' })),
      make(doc, 'span', { class: 'lk-thumb skel', 'aria-hidden': 'true' }), acts());
  } else if (state === 'article' && m) {
    kids.push(eyebrow(m.via === 'search' ? `${COPY.wikipedia} · ${COPY.bestMatch}` : m.description ? `${COPY.wikipedia} · ${m.description}` : COPY.wikipedia));
    kids.push(m.url ? make(doc, 'a', { id: 'lkTitle', class: 'lk-title', href: m.url, target: '_blank', rel: 'noopener noreferrer', ...content }, m.title, make(doc, 'span', { class: 'sr-only', text: COPY.newTab }))
      : make(doc, 'p', { id: 'lkTitle', class: 'lk-title', ...content }, m.title));
    if (m.extract) { kids.push(make(doc, 'p', { id: 'lkText', class: 'lk-text', 'data-lk': 'open', ...content }, m.extract)); described = true; }
    const img = m.image;
    const thumbSrc = img && pickWidth(img.srcset, ctx.phone ? 72 : 84, ctx.dpr);
    if (img && thumbSrc) {
      const thumb = make(doc, 'button', { type: 'button', class: 'lk-thumb', 'data-lk': 'open', 'aria-expanded': open ? 'true' : 'false', 'aria-controls': 'lkFigure', 'aria-label': COPY.thumb, 'data-mat': img.mat ? '' : null });
      const t = picture(doc, m, { ctx, src: thumbSrc, onFail: () => thumb.remove() });
      thumb.append(t);
      kids.push(thumb);
      ctx.loadImage?.(t, thumbSrc, 'thumb');
      const figSrc = pickWidth(img.srcset, ctx.contentWidth || (ctx.phone ? 296 : 328), ctx.dpr);
      const figure = make(doc, 'figure', { id: 'lkFigure', class: 'lk-figure', 'data-mat': img.mat ? '' : null });
      const f = picture(doc, m, { ctx, src: figSrc, onFail: () => figure.remove() });
      figure.append(f, make(doc, 'figcaption', null, ext(doc, img.page, null, COPY.imageCaption)));
      figure.hidden = !open;
      kids.push(figure);
      if (open) ctx.loadImage?.(f, figSrc, 'figure');
    }
    if (m.via === 'search' && m.others.length) kids.push(titleBtns(COPY.notQuite, m.others));
    kids.push(acts(m.url ? ext(doc, m.url, 'mini lk-wiki', COPY.wikiLink) : null), foot(img && thumbSrc ? img : null));
  } else if (state === 'choices' && m) {
    kids.push(eyebrow(`${COPY.wikipedia} · ${COPY.meanings}`), make(doc, 'p', { id: 'lkTitle', class: 'lk-title' }, COPY.canMean(term)),
      make(doc, 'ul', { class: 'lk-choices', ...content }, ...m.choices.map((c) => make(doc, 'li', null,
        make(doc, 'button', { type: 'button', 'data-lk': 'pick', 'data-title': c.ref || c.title }, make(doc, 'b', { text: c.title }), c.description ? make(doc, 'span', { text: c.description }) : null)))),
      acts(m.url ? ext(doc, m.url, 'mini lk-wiki', COPY.wikiLink) : null), foot(null));
  } else if (state === 'none') {
    kids.push(eyebrow(COPY.wikipedia), make(doc, 'p', { id: 'lkTitle', class: 'lk-title is-term', text: term }),
      make(doc, 'p', { id: 'lkText', class: 'lk-note', text: COPY.noArticle }));
    described = true;
    if (m?.others?.length) kids.push(titleBtns(COPY.closest, m.others));
    kids.push(acts(m?.search ? ext(doc, m.search, 'mini lk-wiki', COPY.search) : null));
  } else {
    const code = ERRORS[view?.code] ? view.code : 'unavailable';
    kids.push(eyebrow(COPY.wikipedia), make(doc, 'p', { id: 'lkTitle', class: 'lk-title is-term', text: term }),
      make(doc, 'p', { id: 'lkText', class: 'lk-note bad', text: ERRORS[code] }));
    described = true;
    let retry = null;
    if (RETRYABLE.has(code)) {
      retry = make(doc, 'button', { type: 'button', class: 'mini lk-retry', 'data-lk': 'retry' }, COPY.retry);
      retry.disabled = (ctx.disabledUntil || 0) > (ctx.now ?? Date.now());
    }
    kids.push(acts(retry));
  }
  if (described) card.setAttribute('aria-describedby', 'lkText'); else card.removeAttribute('aria-describedby');
  card.replaceChildren(...kids);
}

/** The words #lookupStatus says for a view (ux §7). fine: a mouse/trackpad, which gets the Alt+L hint. */
export function announcement(view, term, fine = false) {
  const m = view?.model;
  if (view?.state === 'article' && m) return `Wikipedia: ${m.title}${m.description ? `, ${m.description.replace(/[.\s]+$/, '')}` : ''}.${fine ? ' Press Alt+L to open.' : ''}`;
  if (view?.state === 'choices') return `${term} has several meanings on Wikipedia.`;
  if (view?.state === 'none') return `No Wikipedia article for ${term}.`;
  if (view?.state === 'error') return ERRORS[view.code] || ERRORS.unavailable;
  return '';
}

// ── the DOM adapter ──
const NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
/**
 * Wires Look up into the page. app.js calls it once (it exports nothing, so everything comes in through deps):
 * { stage, stream, dock, topBar, status, apiHeaders, mode, ready, ask, prefill, askSends, toast, coarse, reducedMotion,
 *   debug, languages, doc, win, fetch }.
 * ask(prompt) sends a follow-up; when askSends() is false (testers) prefill(prompt) puts it in the composer instead.
 */
export function initLookup(deps = {}) {
  const win = deps.win || globalThis.window, doc = deps.doc || win.document;
  const { stage = null, stream = null, dock = null, topBar = null, coarse = null, prefill = null } = deps;
  const apiHeaders = deps.apiHeaders || (() => ({})), modeOf = deps.mode || (() => 'auto'), readyOf = deps.ready || (() => true);
  const ask = deps.ask || (() => {}), askSends = deps.askSends || (() => true), toast = deps.toast || (() => {}), debug = deps.debug || (() => false);
  const fetchFn = deps.fetch || ((...a) => globalThis.fetch(...a));
  const G = LOOKUP_GEOMETRY;
  const { lang, variant } = wikiLang(deps.languages ?? win.navigator?.languages ?? []);
  const client = createLookupClient({ fetch: fetchFn, headers: () => apiHeaders(), online: () => win.navigator?.onLine !== false });
  // The lookupDebug trace for calibrating on a phone: the flag is re-read at most once a second (never per frame), and
  // objects are logged as JSON so a remote-debugging session can copy the rects, the band and the side.
  let dbgOn = false, dbgAt = -Infinity;
  const dbg = (...a) => {
    try {
      const t = Date.now();
      if (t - dbgAt > 1000) { dbgAt = t; dbgOn = Boolean(debug()); }
      if (dbgOn) console.debug('[lookup]', ...a.map((x) => (x && typeof x === 'object' ? JSON.stringify(x) : x)));
    } catch {}
  };
  const raf = (fn) => (win.requestAnimationFrame ? win.requestAnimationFrame(fn) : win.setTimeout(fn, 16));
  const listeners = [];
  const on = (t, type, fn, opts) => { if (!t?.addEventListener) return; t.addEventListener(type, fn, opts); listeners.push([t, type, fn, opts]); };

  let status = deps.status || doc.getElementById('lookupStatus');
  if (!status) {
    status = doc.createElement('div');
    status.id = 'lookupStatus'; status.className = 'sr-only';
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    doc.body.append(status);
  }
  let card = null, cur = null, side = null, history = [], expanded = false, away = false, ctlMoving = false, remeasure = false;
  let lastPointer = null, touchActive = false, userInputAt = 0, returnFocus = null, wantFocus = false, pressOutside = false;
  let fetchCtrl = null, imgCtrl = null, urls = [], placeRaf = 0, hideTimer = 0, retryTimer = 0, sessionOff = false, toasted = false;
  let ro = null, streamObs = null, streamOn = false;

  const isTouch = () => (lastPointer ? lastPointer === 'touch' || lastPointer === 'pen' : Boolean(coarse?.matches));
  const editable = (t) => Boolean(t?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])') || t?.isContentEditable);
  const inCard = (t) => Boolean(card && t && card.contains(t));
  const canAsk = () => askSends() !== false || typeof prefill === 'function';
  // Faded while it moves or while its words are scrolled away; while away it is also inert, so neither Tab nor a
  // keyboard shortcut can reach controls nobody can see.
  const syncMoving = () => { if (!card) return; card.classList.toggle('is-moving', ctlMoving || away); card.inert = away; };
  // Are the selected words gone from the page? A live Range never says so itself: when its text is removed (an answer
  // re-rendered, the thread replaced) it moves to the still-connected parent and collapses.
  const anchorGone = (s) => Boolean(s?.range) && ((s.node && !s.node.isConnected) || (s.endNode && !s.endNode.isConnected) || s.range.collapsed === true);
  const focusables = () => (card ? [...card.querySelectorAll('button:not(:disabled), a[href]')].filter((el) => el.getClientRects().length) : []);
  const focusFirst = () => focusables()[0]?.focus({ preventScroll: true });
  function restoreFocus() {
    const r = returnFocus;
    returnFocus = null;
    if (r && r !== doc.body && r.isConnected && typeof r.focus === 'function') r.focus({ preventScroll: true });
    else if (inCard(doc.activeElement)) doc.activeElement.blur();
  }
  function revoke(list) { for (const u of list) { try { win.URL.revokeObjectURL(u); } catch {} } }

  function read() {
    const sel = doc.getSelection?.();
    if (!sel || sel.rangeCount !== 1 || sel.isCollapsed) return null;
    const r = sel.getRangeAt(0), e = eligibleRoot(r);
    if (!e) return null;
    const term = cleanTerm(sel.toString());
    if (!term) return null;
    return { term, tier: classify(term), entryId: e.entry?.dataset?.id ?? null, kind: e.entry?.dataset?.kind ?? null, range: r.cloneRange(), node: r.startContainer, endNode: r.endContainer };
  }

  function bandRect() {
    const vv = win.visualViewport;
    const vx = vv?.offsetLeft ?? 0, vy = vv?.offsetTop ?? 0, vw = vv?.width ?? win.innerWidth, vh = vv?.height ?? win.innerHeight;
    const left = Math.max(vx, stage ? stage.getBoundingClientRect().left : 0) + G.gutter;
    let top = vy;
    if (topBar && !doc.documentElement.classList.contains('kb-tight')) top = Math.max(top, topBar.getBoundingClientRect().bottom);
    let bottom = vy + vh;
    if (dock) { const d = dock.getBoundingClientRect(); if (d.height > 0) bottom = Math.min(bottom, d.top); }
    return { left, right: vx + vw - G.gutter, top: top + G.edge, bottom: bottom - G.edge };
  }
  function placeNow() {
    if (!card || card.hidden || !cur) return;
    const range = cur.snap?.range;
    let rects = null;
    try { rects = range && !anchorGone(cur.snap) ? lineRects(range.getClientRects()) : null; } catch {}
    if (remeasure) { remeasure = false; delete card.dataset.side; } // a new anchor: measure without the old side's styles
    const band = bandRect(), touch = isTouch(), phone = win.innerWidth <= G.phoneBreak;
    const w = card.offsetWidth, h = card.scrollHeight + (card.offsetHeight - card.clientHeight);
    const seen = rects && rects.last.bottom > band.top && rects.first.top < band.bottom;
    if (!seen && !ctl.pinned) {
      // A card that holds keyboard focus is in use: it docks like a pinned one instead of vanishing around the focus.
      if (inCard(doc.activeElement)) ctl.pin();
      else { away = true; syncMoving(); dbg('away', { band, rects }); return; } // comes back when its anchor does
    }
    if (away) { away = false; syncMoving(); }
    const p = seen ? place({ first: rects.first, last: rects.last, w, h, band, touch, phone, prefer: side }) : place({ w, h, band, touch, phone, dock: true });
    side = p.side;
    card.style.setProperty('--lk-x', `${p.x}px`);
    card.style.setProperty('--lk-y', `${p.y}px`);
    card.style.setProperty('--lk-max', `${p.maxH}px`);
    card.dataset.side = p.side;
    dbg('place', { side: p.side, x: p.x, y: p.y, maxH: p.maxH, w, h, touch, band, first: rects?.first && { top: rects.first.top, bottom: rects.first.bottom }, last: rects?.last && { top: rects.last.top, bottom: rects.last.bottom } });
  }
  function schedulePlace() { if (!placeRaf) placeRaf = raf(() => { placeRaf = 0; placeNow(); }); }

  async function loadImage(img, src) {
    imgCtrl ||= new AbortController();
    const ctrl = imgCtrl;
    const blob = await client.image(src, ctrl.signal);
    if (ctrl.signal.aborted || !img.isConnected) return;
    if (!blob) { img.onerror?.(); return; }
    const u = win.URL.createObjectURL(blob);
    urls.push(u);
    img.src = u;
  }
  function setExpanded(onOff) {
    if (!card || cur?.view?.state !== 'article') return;
    expanded = onOff;
    card.classList.toggle('is-open', onOff);
    card.querySelector('.lk-thumb')?.setAttribute('aria-expanded', onOff ? 'true' : 'false');
    const fig = card.querySelector('#lkFigure');
    if (fig) {
      fig.hidden = !onOff;
      const img = fig.querySelector('img');
      if (onOff && img && !img.getAttribute('src') && img.dataset.lkSrc) {
        const wide = pickWidth(cur.view.model.image.srcset, card.clientWidth - 32, win.devicePixelRatio) || img.dataset.lkSrc;
        loadImage(img, safeImageUrl(wide) || img.dataset.lkSrc);
      }
    }
    schedulePlace();
  }

  function ensureCard() {
    if (card) return card;
    card = doc.createElement('div');
    card.id = 'lookupCard'; card.className = 'lookup'; card.hidden = true;
    card.setAttribute('aria-modal', 'false'); card.setAttribute('aria-keyshortcuts', 'Alt+L');
    // Keep focus and the selection where they are, and pin the card: iOS may clear the selection on any tap.
    const press = (ev) => { ev.preventDefault(); ctl.pin(); };
    on(card, 'pointerdown', press, { passive: false });
    on(card, 'mousedown', press, { passive: false });
    on(card, 'click', onCardClick);
    on(card, 'keydown', onCardKey);
    doc.body.append(card);
    if (win.ResizeObserver) { ro = new win.ResizeObserver(() => schedulePlace()); ro.observe(card); }
    return card;
  }

  function show(view, s) {
    ensureCard();
    win.clearTimeout(hideTimer);
    if (!cur || !s || cur.snap?.term !== s.term) { side = null; history = []; delete card.dataset.side; } // measure without the last card's dock styles
    if (cur?.view !== view) expanded = false;
    if (view?.retryAfter && !view.until) view = { ...view, until: Date.now() + view.retryAfter * 1000 };
    cur = { view, snap: s };
    const hadFocus = inCard(doc.activeElement), focusKey = hadFocus ? doc.activeElement.dataset?.lk : null;
    const old = urls; urls = [];
    imgCtrl?.abort(); imgCtrl = null;
    const phone = win.innerWidth <= G.phoneBreak;
    renderCard(doc, card, view, {
      term: s?.term, kind: s?.kind, phone, dpr: win.devicePixelRatio || 1, history: history.length > 0, expanded,
      disabledUntil: view?.until || 0, now: Date.now(), canAsk: canAsk(), contentWidth: card.clientWidth ? card.clientWidth - 32 : 0,
      loadImage: (img, src) => loadImage(img, src), onLayout: schedulePlace,
    });
    revoke(old);
    win.clearTimeout(retryTimer);
    if (view?.until > Date.now()) {
      const v = view;
      retryTimer = win.setTimeout(() => { const b = cur?.view === v && card.querySelector('[data-lk=retry]'); if (b) b.disabled = false; }, v.until - Date.now());
    }
    if (card.hidden) { card.hidden = false; card.classList.remove('show'); }
    if (stream && win.MutationObserver && !streamOn) {
      streamObs ||= new win.MutationObserver(() => { if (anchorGone(cur?.snap)) ctl.anchorLost(); });
      streamObs.observe(stream, { childList: true, subtree: true });
      streamOn = true;
    }
    placeNow();
    if (!card.classList.contains('show')) raf(() => { if (cur && card && !card.hidden) card.classList.add('show'); });
    if (hadFocus) (card.querySelector(`[data-lk="${focusKey}"]`) || focusables()[0])?.focus({ preventScroll: true });
    else if (wantFocus) { wantFocus = false; focusFirst(); }
  }
  // The same words selected again, maybe in another paragraph: place against the new selection from now on.
  function reanchor(s) {
    if (!cur || !s?.range) return;
    const a = cur.snap?.range, b = s.range;
    const same = a === b || (a && a.startContainer === b.startContainer && a.startOffset === b.startOffset && a.endContainer === b.endContainer && a.endOffset === b.endOffset);
    cur.snap = s;
    if (card) { if (KINDS.includes(s.kind)) card.dataset.kind = s.kind; else delete card.dataset.kind; }
    if (!same) { side = null; remeasure = true; }
  }
  function hide(reason) {
    if (!card) return;
    dbg('hide', reason);
    const focusInside = inCard(doc.activeElement);
    card.classList.remove('show', 'is-open');
    ctlMoving = false; away = false; syncMoving();
    imgCtrl?.abort(); imgCtrl = null;
    win.clearTimeout(retryTimer);
    if (streamOn) { streamObs?.disconnect(); streamOn = false; }
    cur = null; history = []; expanded = false; side = null; wantFocus = false; remeasure = false;
    win.clearTimeout(hideTimer);
    hideTimer = win.setTimeout(() => {
      if (!card || card.classList.contains('show') || cur) return;
      card.hidden = true;
      revoke(urls); urls = [];
    }, 220);
    if (focusInside) restoreFocus();
    else returnFocus = null;
  }
  function highlight(range) {
    const reg = win.CSS?.highlights, H = win.Highlight;
    if (!reg || typeof H !== 'function') return;
    try { if (range) reg.set('atelier-lookup', new H(range)); else reg.delete('atelier-lookup'); } catch {}
  }
  function say(text) { if (status) status.textContent = text; }

  const fx = {
    mode: () => (sessionOff ? 'off' : LOOKUP_MODES.includes(modeOf()) ? modeOf() : 'auto'),
    ready: () => !sessionOff && Boolean(readyOf()) && !doc.querySelector('dialog[open]') && !doc.body.classList.contains('overlay-open'),
    read,
    cached: (req) => client.peek({ ...req, lang, variant }),
    fetch(req, seq) {
      fetchCtrl?.abort();
      const c = (fetchCtrl = new AbortController());
      dbg('fetch', req.q != null ? 'q' : 'title', seq);
      client.get({ ...req, lang, variant }, c.signal).then((v) => { if (!c.signal.aborted) ctl.result(v, seq); }, (e) => {
        if (e?.name !== 'AbortError' && !c.signal.aborted) ctl.result({ state: 'error', code: 'unavailable' }, seq);
      });
    },
    abort() { fetchCtrl?.abort(); fetchCtrl = null; },
    show,
    hide,
    moving(onOff) { ctlMoving = onOff; syncMoving(); },
    reposition: schedulePlace,
    reanchor,
    highlight,
    // "Press Alt+L to open" only while focus is still outside the card: show() has already moved it in for a
    // keyboard path (the pill, a choice, Try again, a forced Alt+L), and telling that person to open it again is wrong.
    announce(view, s) { say(announcement(view, s?.term || '', !isTouch() && !inCard(doc.activeElement))); },
    disable() { sessionOff = true; if (!toasted) { toasted = true; toast(COPY.unavailable); } },
    online: () => win.navigator?.onLine !== false,
    defaultInput: () => (coarse?.matches ? 'touch' : 'mouse'),
    log: dbg,
  };
  const ctl = createController({ schedule: (fn, ms) => win.setTimeout(fn, ms), cancel: (id) => win.clearTimeout(id), fx });

  function doAsk() {
    const t = ctl.term;
    if (!t || !canAsk()) return;
    const prompt = askPrompt(t), send = askSends() !== false;
    try { (send ? ask : prefill)(prompt); } finally {
      ctl.close('ask');
      try { doc.getSelection?.()?.collapseToEnd(); } catch {}
      if (!send) say(COPY.prefilled);
    }
  }
  function onCardClick(ev) {
    const t = ev.target?.closest?.('[data-lk]');
    if (!t || !card.contains(t)) return;
    switch (t.dataset.lk) {
      case 'pill': return ctl.pillTap();
      case 'ask': return doAsk();
      case 'open': return setExpanded(!expanded);
      case 'pick': if (cur?.view?.state === 'choices') history.push(cur.view); // falls through
      case 'alt': expanded = false; return ctl.lookTitle(t.dataset.title);
      case 'back': { const v = history.pop(); return v ? ctl.showView(v) : undefined; }
      case 'retry': return ctl.retry();
      case 'close': return ctl.close('x');
    }
  }
  function onCardKey(ev) {
    if (ev.key !== 'Tab') return;
    const f = focusables();
    if (!f.length) return;
    const a = doc.activeElement;
    if ((!ev.shiftKey && a === f.at(-1)) || (ev.shiftKey && a === f[0])) { ev.preventDefault(); ctl.close('tab'); }
  }

  // ── document listeners: settle detection only resets timers ──
  on(doc, 'selectionchange', (ev) => {
    if (ev.target !== doc) return; // a textarea's own selectionchange bubbles here: the composer never counts
    const sel = doc.getSelection?.();
    ctl.selectionChanged({ collapsed: !sel || sel.rangeCount === 0 || sel.isCollapsed });
  }, { passive: true });
  on(doc, 'pointerdown', (ev) => {
    lastPointer = ev.pointerType || 'mouse'; userInputAt = Date.now();
    if (lastPointer !== 'mouse') touchActive = true;
    const outside = !inCard(ev.target);
    pressOutside = lastPointer === 'mouse' && outside;
    if (outside) ctl.pointerDown({ type: lastPointer === 'mouse' ? 'mouse' : 'touch' });
  }, { capture: true, passive: true });
  // The press decides, not the release: a drag that started in the text ends here even when the button comes up over a
  // pinned card (which stays clickable while a selection is made), so the new words still settle.
  on(doc, 'mouseup', (ev) => {
    if (lastPointer !== 'mouse' || !pressOutside) return;
    pressOutside = false;
    ctl.pointerUp({ type: 'mouse', detail: ev.detail });
  }, { capture: true, passive: true });
  on(doc, 'pointerup', () => { touchActive = false; }, { capture: true, passive: true });
  on(doc, 'touchstart', () => { touchActive = true; userInputAt = Date.now(); }, { capture: true, passive: true });
  for (const type of ['touchend', 'touchcancel']) on(doc, type, () => { touchActive = false; userInputAt = Date.now(); }, { capture: true, passive: true });
  on(doc, 'keydown', (ev) => {
    if (ev.key === 'Escape') {
      if (doc.querySelector('dialog[open]')) return; // native dialogs own Escape
      if (away) { ctl.close('escape'); return; } // hidden while its words are scrolled away: Escape keeps its usual job
      if (ctl.escape()) { ev.stopPropagation(); ev.preventDefault(); } // the first Escape closes the card, never stopAll()
      return;
    }
    if (ev.code === 'KeyL' && ev.altKey && !ev.ctrlKey && !ev.metaKey) {
      if (ctl.visible) {
        ev.preventDefault();
        // Hidden because its words are scrolled away: pin it, so it docks over the composer where it can be seen
        // (and stops being inert) before focus goes in.
        if (away) { ctl.pin(); ctlMoving = false; placeNow(); }
        if (!inCard(doc.activeElement)) returnFocus = doc.activeElement;
        focusFirst();
        return;
      }
      if (editable(ev.target)) return; // Option+L types ¬ on macOS
      if (!read()) return;
      ev.preventDefault();
      returnFocus = doc.activeElement; wantFocus = true;
      lastPointer = 'key';
      if (!ctl.forceLookup()) wantFocus = false;
      return;
    }
    if (NAV_KEYS.has(ev.key)) {
      userInputAt = Date.now();
      if (ev.shiftKey && !editable(ev.target)) { lastPointer = 'key'; ctl.keySelection(); }
    }
  }, { capture: true });
  // contextmenu: never preventDefault — that would cancel Chrome's own selection bar (Copy · Share · Web search)
  on(doc, 'contextmenu', () => {
    if (lastPointer !== 'touch' && lastPointer !== 'pen') return;
    const sel = doc.getSelection?.();
    ctl.contextMenu({ collapsed: !sel || sel.rangeCount === 0 || sel.isCollapsed });
  }, { passive: true });
  on(doc, 'click', (ev) => {
    if (ctl.state === 'idle' || inCard(ev.target)) return;
    ctl.outsideClick({ selectionLive: Boolean(read()) }); // a click that ends a drag-selection is left to the settle
  }, { capture: true, passive: true });
  on(doc, 'focusin', (ev) => { if (ctl.state !== 'idle' && !inCard(ev.target)) ctl.focusOutside(); });
  on(doc, 'visibilitychange', () => { if (doc.visibilityState === 'hidden') ctl.hidden(); });
  on(stage, 'scroll', () => {
    if (!ctl.visible) return;
    const t = Date.now(), user = touchActive || t - userInputAt < LOOKUP_TIMING.userWindow;
    if (user) userInputAt = t; // a fling keeps counting as the person's own scroll until it stops
    ctl.scroll({ userDriven: user });
  }, { passive: true });
  on(stage, 'scrollend', () => ctl.scrollEnd(), { passive: true });
  on(stage, 'wheel', () => { userInputAt = Date.now(); }, { passive: true });
  on(win, 'resize', schedulePlace, { passive: true });
  on(win.visualViewport, 'resize', schedulePlace, { passive: true });
  on(win.visualViewport, 'scroll', schedulePlace, { passive: true });
  on(win, 'online', () => {
    const v = cur?.view;
    if (v?.state === 'error' && v.code === 'offline' && !v.autoRetried) { v.autoRetried = true; ctl.retry(); } // once by itself
  });
  const observers = [];
  if (win.MutationObserver) {
    const body = new win.MutationObserver(() => { if (doc.body.classList.contains('overlay-open')) ctl.overlay(); });
    body.observe(doc.body, { attributes: true, attributeFilter: ['class'] });
    const html = new win.MutationObserver(() => { if (doc.documentElement.classList.contains('kb-open')) ctl.keyboardOpen(); });
    html.observe(doc.documentElement, { attributes: true, attributeFilter: ['class'] });
    observers.push(body, html);
  }
  // The composer can grow under an open card with no window resize at all (a dictated transcript, a photo added, a
  // long draft): re-place it so bandRect() reads the dock's new top and the card never covers the mode tabs or text.
  if (dock && win.ResizeObserver) {
    const dockRo = new win.ResizeObserver(() => { if (ctl.visible) schedulePlace(); });
    dockRo.observe(dock);
    observers.push(dockRo);
  }

  return {
    close: (reason = 'close') => ctl.close(reason),
    isOpen: () => ctl.visible,
    pinned: () => ctl.pinned,
    mode: () => fx.mode(),
    destroy() {
      ctl.close('destroy');
      for (const [t, type, fn, opts] of listeners) t.removeEventListener(type, fn, opts);
      listeners.length = 0;
      for (const o of observers) o.disconnect();
      streamObs?.disconnect(); ro?.disconnect();
      win.clearTimeout(hideTimer); win.clearTimeout(retryTimer);
      revoke(urls); urls = [];
      card?.remove(); card = null;
      client.clear();
    },
  };
}
