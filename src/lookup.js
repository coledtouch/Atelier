// Look up (server): GET /api/lookup → a short Wikipedia summary for a few words selected in a finished answer, and
// GET /api/lookup/img → that summary's free Wikimedia Commons thumbnail, fetched here so Wikimedia never sees the
// viewer's device (IP address, browser, the page they were on). Both routes are for the owner (passcode, worker.js) and
// signed-in testers (a free TESTER_ROUTES entry, rate-limited per tester); worker.js and src/tester/router.js call
// handleLookup(req, env, url, { key }).
//
// Rules this module keeps:
// - It imports nothing (no worker.js, no 'cloudflare:workers', no tester modules), so node tests import it directly.
// - It never touches ATELIER_KV or LEDGER. The only per-isolate state is two back-off timestamps (plain numbers) set
//   when Wikimedia answers 429; there are no promises, semaphores or single-flight maps shared between requests.
// - Upstream requests carry a fresh Headers object (a policy-format User-Agent, accept, and accept-language only for
//   a script variant). Nothing from the incoming request (cookie, x-app-pass, cf-*) is ever forwarded.
// - Results are cached at the edge (caches.default) under sha256 keys, so the selected words never appear in a key.
//   Each person has their own entries (the key hashes who asked), so no one can learn from a cache hit — or from how
//   fast an answer comes back — what the owner or another tester looked up. Failures are never cached anywhere.
// - Testers share one Wikimedia budget (WIKI_LIMIT keys 'wikimedia' / 'commons'); the owner has a separate one, so
//   testers can never use up Look up for the owner.
// - The selected text, titles, image keys and tester ids are never logged: only the step, the status and the wiki.
// - Every JSON answer is a whitelisted shape with plain strings; upstream HTML (extract_html, displaytitle) is never read.

export const LOOKUP = Object.freeze({
  minChars: 2, maxChars: 120, maxWords: 12, maxTitleBytes: 255, maxCalls: 3, bodyCap: 262144, extractChars: 480, sentences: 3,
  titleChars: 200, descChars: 120, choices: 4, others: 2, ttlFound: 86400, ttlMiss: 3600, retryMin: 5, retryMax: 120, rateRetry: 30, busyRetry: 10,
});
// Mutable so tests can shorten them (like VIDEO_TIMING).
export const LOOKUP_TIMING = { summaryMs: 3500, searchMs: 4000, deadlineMs: 7000, imageMs: 8000 };
// Wikimedia only serves these thumbnail widths; any other width is refused with HTTP 400.
export const STANDARD_WIDTHS = Object.freeze([20, 40, 60, 120, 250, 330, 500, 960, 1280, 1920, 3840]);
// The widths the image proxy will fetch: a bounded subset (a card thumbnail is 72-84 CSS px, the expanded figure ≤ 420).
export const THUMB_WIDTHS = Object.freeze([250, 330, 500]);
export const IMAGE = Object.freeze({
  host: 'upload.wikimedia.org', // the only host the proxy ever fetches from
  sourceHosts: Object.freeze(['thumb.wikimedia.org', 'upload.wikimedia.org']), // hosts a summary/search thumbnail may name
  prefix: '/wikipedia/commons/', // free-licensed Commons files only (non-free fair-use files live under /wikipedia/<wiki>/)
  path: '/api/lookup/img',
  maxBytes: 1_500_000,
  maxOriginal: 500, // an untouched original (no /thumb/) is used only up to this width — checked in its header bytes too
  maxOriginalBytes: 524_288, // and only up to this size (a ≤ 500 px raster is far smaller)
  // A key names the file twice (thumb/a/ab/<name>/<W>px-<name>); a name of up to 160 bytes (Wikimedia shortens longer
  // ones to "thumbnail.<ext>") is up to 480 percent-encoded characters, so real keys stay under ~1000 characters.
  keyChars: 1600,
  urlChars: 1800, // the longest /api/lookup/img?k=… URL the client accepts (public/lookup.js safeImageUrl)
  ttl: 604800, // edge cache: a week (thumbnails rarely change)
  types: Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
});
export const LICENSE = Object.freeze({ name: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' });
export const WIKIS = Object.freeze(['en', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'pl', 'ru', 'uk', 'ja', 'zh', 'ko', 'ar', 'he', 'fa', 'tr', 'sv', 'no', 'da',
  'fi', 'cs', 'hu', 'ro', 'el', 'id', 'vi', 'th', 'hi', 'bn', 'ca', 'eu', 'gl', 'sr', 'hr', 'sk', 'bg', 'ms', 'et', 'lt', 'lv', 'sl', 'zh-yue']);
export const ALIASES = Object.freeze({ nb: 'no', yue: 'zh-yue' });
export const VARIANTS = Object.freeze({ zh: Object.freeze(['zh-cn', 'zh-tw', 'zh-hk', 'zh-sg', 'zh-hans', 'zh-hant']), sr: Object.freeze(['sr-ec', 'sr-el']) });
export const RTL = new Set(['ar', 'he', 'fa']);

const SUMMARY_PREFIX = '/api/rest_v1/page/summary/';
const ACTION_PATH = '/w/api.php';
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'its', 'his', 'her', 'their', 'was', 'are']);
const CIRRUS = /\b(intitle|insource|incategory|hastemplate|linksto|morelike|prefer-recent|deepcat|deepcategory|boost-templates|subpageof|articletopic|inlanguage|filetype|filemime|filesize|neartitle|nearcoord|pageid|prefix|keyword)\s*:/gi;
// Words a sentence splitter mistakes for a sentence end ("Arm. gen. Ing. John Smith…", "Dr. Smith", "U.S. troops").
const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'jr', 'sr', 'prof', 'gen', 'col', 'lt', 'sgt', 'capt', 'cpt', 'maj', 'adm', 'rev', 'hon',
  'gov', 'sen', 'rep', 'pres', 'arm', 'ing', 'dipl', 'mag', 'vs', 'etc', 'approx', 'ca', 'cf', 'vol', 'vols', 'fig', 'figs', 'pp', 'inc', 'ltd', 'co',
  'corp', 'mt', 'ft', 'ave', 'blvd', 'rd', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'no', 'op']);

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };
const reply = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
const failure = (status, code, error, extra = {}, headers = {}) => reply({ error, code, ...extra }, status, headers);
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

const ERR = {
  method: () => failure(405, 'lookup_method', 'Use GET.', {}, { allow: 'GET' }),
  off: () => failure(503, 'lookup_off', 'Look up is turned off for now.'),
  query: () => failure(400, 'lookup_query', 'Select a word or a short name to look up.'),
  image: () => failure(400, 'lookup_query', 'That isn’t a Look up image.'),
  rate: () => failure(429, 'lookup_rate', 'Too many look-ups — try again in a minute.', { retryAfter: LOOKUP.rateRetry }, { 'retry-after': String(LOOKUP.rateRetry) }),
  busy: (s) => failure(429, 'lookup_busy', 'Wikipedia is busy — try again in a few seconds.', { retryAfter: s }, { 'retry-after': String(s) }),
  unavailable: () => failure(502, 'lookup_unavailable', 'Couldn’t reach Wikipedia — try again.'),
  imageUnavailable: () => failure(502, 'lookup_unavailable', 'Couldn’t load the Wikimedia image.'),
};

// A failure that ends a request with one of the fixed answers above. status: the upstream HTTP status, when there was one.
class LookupStop extends Error {
  constructor(kind, retryAfter, status) { super(kind); this.kind = kind; this.retryAfter = retryAfter; this.status = status; }
}

// Whose Wikimedia budget a call spends (WIKI_LIMIT): testers share one, the owner has their own.
const wikiKey = (who, kind) => (who === 'owner' ? `${kind}:owner` : kind);
// x-lookup-cache (hit|miss) is a debugging aid for the owner only.
const cacheState = (who, state) => (who === 'owner' ? { 'x-lookup-cache': state } : {});

// The only per-isolate state: when Wikimedia last said 429, nothing is sent there again until these times pass.
let backoffUntil = 0;
let imageBackoffUntil = 0;
export function resetLookupState() { backoffUntil = 0; imageBackoffUntil = 0; }

// ── selection clean-up (character-identical to cleanTerm in public/lookup.js; a parity test enforces it) ──
// Returns the cleaned words, or null when the selection is not something to look up. Self-contained on purpose (no
// outside constants), so the client copy can be compared as source text.
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

// The words for CirrusSearch with its operators removed, so a selection can't change how the search runs.
export function searchText(term) {
  return String(term ?? '')
    .replace(CIRRUS, ' ')
    .replace(/["“”„«»‹›~*\\()]/g, ' ')
    .replace(/(^|\s)[-!]+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// Which Wikipedia to ask. Request text never becomes a hostname: anything not on the WIKIS list is English.
export function wikiSite(lang, variant) {
  let l = typeof lang === 'string' ? lang.trim().toLowerCase() : '';
  if (Object.hasOwn(ALIASES, l)) l = ALIASES[l];
  if (!WIKIS.includes(l)) l = 'en';
  const v = typeof variant === 'string' ? variant.trim().toLowerCase() : '';
  const acceptLanguage = Object.hasOwn(VARIANTS, l) && VARIANTS[l].includes(v) ? v : null;
  return { lang: l, host: `${l}.wikipedia.org`, acceptLanguage, dir: RTL.has(l) ? 'rtl' : 'ltr' };
}

export const titlePath = (t) => encodeURIComponent(String(t).trim().replace(/ /g, '_'));
export const summaryUrl = (host, t) => `https://${host}${SUMMARY_PREFIX}${titlePath(t)}`;
// The summary URL, or null when the title would leave the summary path ('.', '..') or can't be encoded.
export function safeSummaryUrl(host, t) {
  try {
    const u = summaryUrl(host, t);
    const p = new URL(u);
    return p.hostname === host && p.pathname === SUMMARY_PREFIX + titlePath(t) && !p.search && !p.hash ? u : null;
  } catch { return null; }
}
export function searchUrl(host, q, limit) {
  const n = String(limit);
  const p = new URLSearchParams({
    action: 'query', format: 'json', formatversion: '2', redirects: '1', generator: 'search', gsrsearch: q, gsrnamespace: '0', gsrlimit: n,
    gsrinfo: '', gsrprop: '', prop: 'extracts|pageimages|description|pageprops|info', exintro: '1', explaintext: '1', exlimit: n,
    piprop: 'thumbnail|name|original', pithumbsize: '330', pilicense: 'free', ppprop: 'disambiguation', inprop: 'url|displaytitle', maxage: '3600', smaxage: '86400',
  });
  return `https://${host}${ACTION_PATH}?${p}`;
}
// encodeURIComponent, plus the quote so links stay inside the client's url pattern ([^\s"'<>]).
const encodeLink = (s) => encodeURIComponent(s).replace(/'/g, '%27');
const wikiUrl = (host, t) => `https://${host}/wiki/${encodeLink(String(t).replace(/ /g, '_'))}`;
const searchLink = (host, q) => `https://${host}/w/index.php?search=${encodeLink(q)}&ns0=1`;

// "Nero's Golden House (Domus Aurea)" → { outer: "Nero's Golden House", inner: "Domus Aurea" }, or null.
export function innerParts(q) {
  const m = /^(.+?)\s*\(([^()]{2,60})\)$/.exec(String(q ?? ''));
  const inner = m ? cleanTerm(m[2]) : null;
  return inner ? { outer: m[1], inner } : null;
}
// "Nero's Golden House (Domus Aurea)" → "Domus Aurea".
export const innerTerm = (q) => innerParts(q)?.inner ?? null;

// A prefix Wikipedia reads as another wiki or project ("C: drive", "It: Chapter Two", "no: …"): its summary is a fixed
// 5xx, which is a miss for that step rather than an outage.
const PREFIXED = /^[^:\s]{1,20}:/;

// ── text ──
function clean(v, max) {
  if (typeof v !== 'string') return '';
  let s = v.replace(/<[^>]*>/g, ' ').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (s.length > max) s = s.slice(0, max).replace(/[\ud800-\udbff]$/, '').trimEnd();
  return s;
}

function endsWithAbbreviation(segment) {
  const m = /(?:^|[\s(])(\p{L}[\p{L}.]*)\.\s*$/u.exec(segment);
  if (!m) return false;
  const w = m[1].toLowerCase();
  return w.length === 1 || w.includes('.') || ABBREVIATIONS.has(w);
}
function sentencesOf(text, lang) {
  let parts = null;
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    for (const locale of [lang, 'en']) {
      try { parts = [...new Intl.Segmenter(locale, { granularity: 'sentence' }).segment(text)].map((x) => x.segment); break; } catch {}
    }
  }
  if (!parts) parts = text.match(/[^.!?…。！？]+(?:[.!?…。！？]+["'”’»)\]]*\s*|$)/gu) || [text];
  const out = [];
  for (const p of parts) {
    if (out.length && endsWithAbbreviation(out[out.length - 1])) out[out.length - 1] += p;
    else out.push(p);
  }
  return out.filter((p) => p.trim());
}

// The first paragraph, up to 3 sentences and 480 characters, as plain text. trimmed = anything was left out.
export function trimExtract(text, lang = 'en') {
  const plain = typeof text === 'string' ? text.replace(/<[^>]*>/g, ' ') : '';
  const paras = plain.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  const first = (paras[0] || '').replace(/\[(?:\d{1,3}|citation needed)\]/gi, '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  let trimmed = paras.length > 1;
  const all = first ? sentencesOf(first, lang) : [];
  if (all.length > LOOKUP.sentences) trimmed = true;
  let extract = all.slice(0, LOOKUP.sentences).join('').replace(/\s+/g, ' ').trim();
  if (extract.length > LOOKUP.extractChars) {
    let cut = extract.slice(0, LOOKUP.extractChars - 1).replace(/[\ud800-\udbff]$/, '');
    const space = cut.lastIndexOf(' ');
    if (space > LOOKUP.extractChars / 2) cut = cut.slice(0, space);
    extract = `${cut.replace(/[\s.,;:!?…\-–—(]+$/u, '')}…`;
    trimmed = true;
  }
  return { extract, trimmed };
}

// Would a search hit plausibly be what was selected? (≥ 60% of the selection's words appear in the hit.)
const tokens = (s) => (String(s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/['’]s\b/g, '').match(/[\p{L}\p{N}]+/gu) || [])
  .filter((t) => t.length >= 3 && !STOP.has(t));
const pageTokens = (page) => new Set(tokens(`${page?.title || ''} ${page?.description || ''} ${String(page?.extract || '').slice(0, 300)}`));
export function relevant(term, page) {
  const want = tokens(term);
  if (want.length < 2) return true;
  const have = pageTokens(page);
  return want.filter((t) => have.has(t)).length >= want.length * 0.6;
}
// Is the bracketed name's article about the selection, or only about its qualifier? It counts when it mentions a word
// from outside the brackets: "Nero's Golden House (Domus Aurea)" → Domus Aurea (its lead names Nero), but
// "Cambridge (UK)" → not the United Kingdom. Words match on a shared start (4+ letters), so "Neros" (German) finds
// "Nero" and "Goldenes" finds "Golden". Nothing to check ("AI (artificial intelligence)") → it counts.
export function innerFits(outer, page) {
  const want = tokens(outer);
  if (!want.length) return true;
  const have = [...pageTokens(page)];
  const near = (a, b) => a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));
  return want.some((t) => have.some((h) => near(t, h)));
}

// Wikipedia's own display form of a title, as plain text: "iPhone" for the page IPhone, the reader's script for a zh/sr
// variant. Used only when it names the same page (the same words ignoring case, or a variant the request asked for);
// otherwise the real title. Never rendered as HTML (the client uses textContent).
const ENTITIES = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' });
function decodeEntities(s) {
  return s.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,6}));/gi, (m, dec, hx, name) => {
    if (name) return Object.hasOwn(ENTITIES, name) ? ENTITIES[name] : m;
    const cp = dec ? Number(dec) : parseInt(hx, 16);
    return cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : m;
  });
}
const foldTitle = (s) => s.replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
export function shownTitle(display, real, site) {
  if (!real || typeof display !== 'string' || !display) return real;
  const text = clean(decodeEntities(display.replace(/<[^>]*>/g, '')), LOOKUP.titleChars);
  if (!text) return real;
  return foldTitle(text) === foldTitle(real) || site?.acceptLanguage ? text : real;
}

// ── images: Commons files only, always fetched through GET /api/lookup/img ──
// A key is the path under /wikipedia/commons/ exactly as Wikimedia writes it (percent-encoded):
//   thumb/<a>/<ab>/<File>/<W>px-<File>[.png]   a rendered thumbnail (SVGs render as .png)
//   thumb/<a>/<ab>/<File>.svg/lang<code>-<W>px-<File>.svg.png   an SVG rendered in one language (ru, uk… wikis)
//   <a>/<ab>/<File>                            a small raster original
const KEY_NAME = "[A-Za-z0-9%._~!*'(),-]+";
const LANG_PREFIX = 'lang[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,3}-';
const THUMB_KEY = new RegExp(`^thumb/([0-9a-f])/(\\1[0-9a-f])/(${KEY_NAME})/(${LANG_PREFIX})?(\\d{1,4})px-(${KEY_NAME})$`);
const ORIGINAL_KEY = new RegExp(`^([0-9a-f])/(\\1[0-9a-f])/(${KEY_NAME})$`);
const FILE_EXT = /\.(jpe?g|png|gif|webp|svg)$/i;
const RASTER_EXT = /\.(jpe?g|png|gif|webp)$/i;

// key → { key, thumb, width, file (decoded), svg } or null.
export function parseImageKey(key) {
  if (typeof key !== 'string' || !key || key.length > IMAGE.keyChars) return null;
  if (/%(?:2f|5c|[01][0-9a-f]|7f)/i.test(key)) return null; // encoded slashes, backslashes and control characters
  const t = THUMB_KEY.exec(key), o = t ? null : ORIGINAL_KEY.exec(key);
  if (!t && !o) return null;
  const name = t ? t[3] : o[3];
  let file;
  try { file = decodeURIComponent(name); } catch { return null; }
  if (name === '.' || name === '..' || file === '.' || file === '..' || /[/\\\u0000-\u001f\u007f]/.test(file) || file.length > 240 || !FILE_EXT.test(file)) return null;
  const svg = /\.svg$/i.test(file);
  if (o) return svg ? null : { key, thumb: false, width: null, file, svg };
  if (t[4] && !svg) return null; // only SVGs render per language
  const width = Number(t[5]);
  const ext = (RASTER_EXT.exec(file) || [])[1] || '';
  const rendered = t[6];
  // A name over 160 bytes renders as "thumbnail.<ext>", with the extension lower-cased.
  const ok = svg ? rendered === `${name}.png` || rendered === 'thumbnail.svg.png'
    : rendered === name || rendered === `thumbnail.${ext}` || rendered === `thumbnail.${ext.toLowerCase()}`;
  return ok && String(width) === t[5] ? { key, thumb: true, width, file, svg } : null;
}

// A Commons image URL from a summary or search result → its key, or null (non-free, other host, odd format…).
export function imageKey(src) {
  let u;
  try { u = new URL(String(src ?? '')); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !IMAGE.sourceHosts.includes(u.hostname)) return null;
  if (!u.pathname.startsWith(IMAGE.prefix)) return null;
  const key = u.pathname.slice(IMAGE.prefix.length);
  const parsed = parseImageKey(key);
  if (!parsed) return null;
  if (parsed.thumb && !RASTER_EXT.test(key)) return null; // what is rendered must be jpg/png/gif/webp
  return key;
}
// The same-origin URL the browser loads (fetch with apiHeaders → blob → object URL). Only [A-Za-z0-9%._~-] after k=.
export const proxyImageUrl = (key) => `${IMAGE.path}?k=${encodeURIComponent(key).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;

// Swap the /NNNpx- width of a thumbnail URL or key to a standard width (never above the original); otherwise unchanged.
// A language prefix (/langru-330px-…) is kept.
export function thumbAt(url, width, origWidth) {
  const s = String(url ?? '');
  if (!s.includes('thumb/') || !STANDARD_WIDTHS.includes(width) || (origWidth > 0 && width > origWidth)) return s;
  return s.replace(/\/(lang[a-z0-9-]+-)?(\d+)px-([^/?#]+)((?:[?#].*)?)$/, (m, lang, w, rest, tail) => `/${lang || ''}${width}px-${rest}${tail}`);
}

const posInt = (n) => (Number.isInteger(n) && n > 0 && n <= 100000 ? n : 0);
// → { src, width, height, srcset: [[w, src]…], file, page, mat } with every src a /api/lookup/img URL, or null.
// width/height (of the 330 px thumbnail, or of a small original) come from Wikipedia; without them there is no image.
export function imageFrom(src, { width, height, origWidth } = {}) {
  const key = imageKey(src);
  const w = posInt(width), h = posInt(height), orig = posInt(origWidth);
  if (!key || !w || !h) return null;
  const parsed = parseImageKey(key);
  let srcset;
  if (parsed.thumb) {
    const limit = orig || parsed.width;
    let widths = THUMB_WIDTHS.filter((x) => x <= limit);
    if (!widths.length) widths = THUMB_WIDTHS.includes(parsed.width) ? [parsed.width] : [];
    srcset = widths.map((x) => [x, proxyImageUrl(thumbAt(key, x, orig))]);
  } else {
    if (w > IMAGE.maxOriginal) return null;
    srcset = [[w, proxyImageUrl(key)]];
  }
  if (!srcset.length || srcset.some(([, u]) => u.length > IMAGE.urlChars)) return null;
  const main = srcset.find(([x]) => x === 330) || srcset[srcset.length - 1];
  const file = parsed.file.slice(0, 240);
  return {
    src: main[1],
    width: main[0],
    height: clamp(Math.round((h * main[0]) / w), 1, 10000),
    srcset,
    file,
    page: `https://commons.wikimedia.org/wiki/File:${encodeLink(file.replace(/ /g, '_'))}`,
    mat: /\.(png|gif|svg)$/i.test(file),
  };
}

// First bytes → the real image type, or null (SVG/XML/HTML/anything else is never served).
export function sniffImage(b) {
  if (!(b instanceof Uint8Array) || b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

// A raster image's pixel size from its header bytes → { width, height }, or null when it can't be read. The image proxy
// uses it to keep untouched originals to IMAGE.maxOriginal wide (a thumbnail's width is already fixed by its key).
export function imageSize(b) {
  const type = sniffImage(b);
  if (!type) return null;
  const u16be = (i) => (b[i] << 8) | b[i + 1], u16le = (i) => b[i] | (b[i + 1] << 8), u24le = (i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  const u32be = (i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  const tag = (i) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
  const size = (width, height) => (width > 0 && height > 0 ? { width, height } : null);
  if (type === 'image/png') return b.length >= 24 && tag(12) === 'IHDR' ? size(u32be(16), u32be(20)) : null;
  if (type === 'image/gif') return size(u16le(6), u16le(8));
  if (type === 'image/webp') {
    if (b.length < 30) return null;
    const chunk = tag(12);
    if (chunk === 'VP8 ') return b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a ? size(u16le(26) & 0x3fff, u16le(28) & 0x3fff) : null;
    if (chunk === 'VP8L') return b[20] === 0x2f ? size((u16le(21) & 0x3fff) + 1, ((u24le(22) >> 6) & 0x3fff) + 1) : null;
    if (chunk === 'VP8X') return size(u24le(24) + 1, u24le(27) + 1);
    return null;
  }
  // JPEG: walk the marker segments to the first start-of-frame (SOF0-3, 5-7, 9-11, 13-15).
  for (let i = 2; i + 9 < b.length;) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; } // fill byte
    if ((m >= 0xd0 && m <= 0xd9) || m === 0x01) { i += 2; continue; } // markers with no length
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return size(u16be(i + 7), u16be(i + 5));
    i += 2 + u16be(i + 2);
  }
  return null;
}

// ── shaping upstream JSON into the whitelisted answer ──
export function shapeSummary(j, site) {
  if (!j || typeof j !== 'object' || j.type !== 'standard' || j.namespace?.id !== 0) return null;
  const real = clean(j.titles?.normalized, LOOKUP.titleChars) || clean(j.title, LOOKUP.titleChars);
  const { extract, trimmed } = trimExtract(j.extract, site.lang);
  if (!real || !extract) return null;
  const canonical = clean(j.titles?.canonical, 400);
  return {
    title: shownTitle(j.titles?.display, real, site),
    ref: real,
    description: clean(j.description, LOOKUP.descChars),
    extract,
    trimmed,
    url: wikiUrl(site.host, canonical || real),
    dir: j.dir === 'rtl' ? 'rtl' : 'ltr',
    image: imageFrom(j.thumbnail?.source, { width: j.thumbnail?.width, height: j.thumbnail?.height, origWidth: j.originalimage?.width }),
  };
}

export function shapeSearch(j, site) {
  const pages = Array.isArray(j?.query?.pages) ? j.query.pages : [];
  return pages
    .filter((p) => p && typeof p === 'object' && (p.ns ?? 0) === 0 && !p.missing && !p.invalid
      && !(p.pageprops && typeof p.pageprops === 'object' && Object.hasOwn(p.pageprops, 'disambiguation')))
    .map((p) => ({ p, i: Number.isFinite(Number(p.index)) ? Number(p.index) : Infinity }))
    .sort((a, b) => a.i - b.i)
    .map(({ p }) => {
      const real = clean(p.title, LOOKUP.titleChars);
      const { extract, trimmed } = trimExtract(p.extract, site.lang);
      return {
        title: shownTitle(p.displaytitle, real, site),
        ref: real,
        description: clean(p.description, LOOKUP.descChars),
        extract,
        trimmed,
        url: wikiUrl(site.host, real),
        dir: site.dir,
        image: imageFrom(p.thumbnail?.source, { width: p.thumbnail?.width, height: p.thumbnail?.height, origWidth: p.original?.width }),
      };
    })
    .filter((x) => x.title);
}

// A name the card offers to look up next ("Not quite?", "Closest:", a meaning). ref: the real title to ask for, only
// when the shown one differs (a display form such as "iPhone", or a zh/sr variant).
const brief = (x) => ({ title: x.title, description: x.description, ...(x.ref && x.ref !== x.title ? { ref: x.ref } : {}) });
const articleBody = (a, site, via, query, others = []) => ({
  v: 1, found: true, kind: 'article', via, lang: site.lang, dir: a.dir, query, title: a.title, description: a.description, extract: a.extract,
  trimmed: a.trimmed, url: a.url, image: a.image, others, license: LICENSE,
});
const noneBody = (site, query, others = []) => ({ v: 1, found: false, lang: site.lang, query, search: searchLink(site.host, query), others });

// policy format: <client>/<version> (<contact>) <library>. WIKI_CONTACT is a public address (wrangler vars).
export function userAgent(env) {
  const contact = String(env?.WIKI_CONTACT ?? '').replace(/[^\w@.+:/-]/g, '').slice(0, 100);
  return `Atelier/1.0 (https://atelier.ciprari.ai/${contact ? `; ${contact}` : ''}) Cloudflare-Workers`;
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256hex = async (s) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
// who ('owner' or t:<sub>) is part of every key: one person's look-ups are never another's cache hits.
export async function cacheKey(origin, site, mode, norm, who) {
  return `${origin}/__lookup/v1/${await sha256hex(JSON.stringify([String(who ?? ''), site.lang, site.acceptLanguage || '', mode, String(norm)]))}`;
}
export async function imageCacheKey(origin, key, who) {
  return `${origin}/__lookup/img/v1/${await sha256hex(JSON.stringify([String(who ?? ''), key]))}`;
}

// An optional rate-limit binding: missing, throwing or answering oddly lets the request through (like auth.js throttled()).
async function allowed(binding, key) {
  if (!binding || typeof binding.limit !== 'function') return true;
  try { return (await binding.limit({ key }))?.success !== false; } catch { return true; }
}

// The response body, stopping as soon as it grows past cap (null then).
async function readCapped(res, cap) {
  const declared = res.headers.get('content-length');
  if (declared && /^\d+$/.test(declared.trim()) && Number(declared) > cap) { await res.body?.cancel().catch(() => {}); return null; }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

// ── upstream calls for one request (no state outlives it) ──
function upstream(env, fetchFn, now, who) {
  const started = now();
  let calls = 0;
  const left = () => LOOKUP.maxCalls - calls;
  // → parsed JSON, or null for a miss. Throws LookupStop for busy / unavailable.
  async function get(url, perCallMs, site, step) {
    const prefix = step === 'summary' ? SUMMARY_PREFIX : ACTION_PATH;
    let target = url;
    for (let hop = 0; ; hop++) {
      if (left() <= 0) return null; // out of upstream calls: the strategy stops here
      if (!(await allowed(env.WIKI_LIMIT, wikiKey(who, 'wikimedia')))) throw new LookupStop('busy', LOOKUP.busyRetry);
      const remaining = LOOKUP_TIMING.deadlineMs - (now() - started);
      if (remaining <= 0) throw new LookupStop('unavailable');
      const headers = new Headers({ 'user-agent': userAgent(env), accept: 'application/json' });
      if (site.acceptLanguage) headers.set('accept-language', site.acceptLanguage);
      calls++;
      let res;
      try {
        res = await fetchFn(target, { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(Math.max(1, Math.min(perCallMs, remaining))) });
      } catch (err) {
        console.warn('lookup upstream', step, err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'network', site.lang);
        throw new LookupStop('unavailable');
      }
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => {});
        const loc = res.headers.get('location');
        let next = null;
        try { next = loc ? new URL(loc, target) : null; } catch {}
        // Only same-wiki https hops that stay on the same API, at most 2 of them; anything else is a miss for this step.
        if (!next || hop >= 2 || next.protocol !== 'https:' || next.hostname !== site.host || next.username || next.password || next.port
          || !next.pathname.startsWith(prefix)) return null;
        target = next.href;
        continue;
      }
      if (res.status === 404) { await res.body?.cancel().catch(() => {}); return null; }
      if (res.status === 429) {
        await res.body?.cancel().catch(() => {});
        const wait = clamp(Number(res.headers.get('retry-after')) || LOOKUP.busyRetry, LOOKUP.retryMin, LOOKUP.retryMax);
        backoffUntil = now() + wait * 1000;
        console.warn('lookup upstream', step, 429, site.lang);
        throw new LookupStop('busy', wait);
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        console.warn('lookup upstream', step, res.status, site.lang);
        throw new LookupStop('unavailable', undefined, res.status);
      }
      let bytes;
      try { bytes = await readCapped(res, LOOKUP.bodyCap); } catch {
        console.warn('lookup upstream', step, 'body', site.lang);
        throw new LookupStop('unavailable');
      }
      if (!bytes) { console.warn('lookup upstream', step, 'too-large', site.lang); throw new LookupStop('unavailable'); }
      try { return JSON.parse(new TextDecoder().decode(bytes)); } catch {
        console.warn('lookup upstream', step, 'not-json', site.lang);
        throw new LookupStop('unavailable');
      }
    }
  }
  return { get, left, get calls() { return calls; } };
}

// ── the strategy: at most 3 upstream calls, usually 1 ──
// params: { site, q } or { site, title }. io: { get(url, ms, site, step), left() } → the answer body.
export async function lookup({ site, q, title }, io) {
  const summary = async (s, t) => {
    const u = safeSummaryUrl(s.host, t);
    if (!u) return null;
    try { return await io.get(u, LOOKUP_TIMING.summaryMs, s, 'summary'); } catch (err) {
      // An interwiki-looking prefix ("C: drive") gets a fixed 5xx from the summary API: a miss, so search still runs.
      if (!title && PREFIXED.test(t) && err instanceof LookupStop && err.kind === 'unavailable' && err.status >= 500) return null;
      throw err;
    }
  };
  if (title) {
    const a = shapeSummary(await summary(site, title), site);
    return a ? articleBody(a, site, 'title', title) : noneBody(site, title);
  }
  // A non-English wiki keeps its last call for the English fallback.
  const reserve = site.lang !== 'en' ? 1 : 0;
  const j = await summary(site, q);
  const hit = shapeSummary(j, site);
  if (hit) return articleBody(hit, site, 'title', q);
  const disambiguation = j && typeof j === 'object' && j.type === 'disambiguation' ? j : null;
  const parts = disambiguation ? null : innerParts(q);
  const inner = parts && parts.inner !== q ? parts.inner : null;
  let innerElsewhere = false; // the bracketed name has an article, but it is about something else ("Cambridge (UK)")
  if (inner && io.left() > reserve) {
    const a = shapeSummary(await summary(site, inner), site);
    if (a && innerFits(parts.outer, a)) return articleBody(a, site, 'inner', q);
    innerElsewhere = Boolean(a);
  }
  let others = [];
  const words = searchText(q);
  if (words && io.left() > reserve) {
    const s = await io.get(searchUrl(site.host, words, disambiguation ? 6 : 4), LOOKUP_TIMING.searchMs, site, 'search');
    const pages = s ? shapeSearch(s, site) : [];
    if (disambiguation) {
      const t = clean(disambiguation.titles?.normalized, LOOKUP.titleChars) || clean(disambiguation.title, LOOKUP.titleChars) || q;
      const choices = pages.slice(0, LOOKUP.choices).map(brief);
      if (choices.length) {
        return {
          v: 1, found: true, kind: 'choices', lang: site.lang, dir: disambiguation.dir === 'rtl' ? 'rtl' : 'ltr', query: q, title: t,
          url: wikiUrl(site.host, clean(disambiguation.titles?.canonical, 400) || t), choices, license: LICENSE,
        };
      }
    } else if (pages.length) {
      const [top, ...rest] = pages;
      if (relevant(q, top)) return articleBody(top, site, 'search', q, rest.slice(0, LOOKUP.others).map(brief));
      // "Closest:" never offers a page that failed the same test (that would suggest something unrelated).
      others = rest.filter((p) => relevant(q, p)).slice(0, LOOKUP.others).map(brief);
    }
  }
  // The one English call: the bracketed name's summary when it is still untried in English, else an English search
  // (which also finds exact titles) with the same relevance test. Its names are never offered as picks: the card asks
  // for picks on the reader's own wiki.
  if (site.lang !== 'en' && !disambiguation && io.left() > 0) {
    const en = wikiSite('en');
    if (inner && !innerElsewhere) {
      const a = shapeSummary(await summary(en, inner), en);
      if (a && innerFits(parts.outer, a)) return articleBody(a, en, 'inner', q);
    } else if (words) {
      const s = await io.get(searchUrl(en.host, words, 4), LOOKUP_TIMING.searchMs, en, 'search');
      const top = s ? shapeSearch(s, en)[0] : null;
      if (top && relevant(q, top)) return articleBody(top, en, foldTitle(top.ref) === foldTitle(q) ? 'title' : 'search', q);
    }
  }
  return noneBody(site, q, others);
}

const utf8Bytes = (s) => new TextEncoder().encode(s).length;
function validTitle(raw) {
  const t = typeof raw === 'string' ? raw.trim() : '';
  if (!t || utf8Bytes(t) > LOOKUP.maxTitleBytes || /[#<>[\]|{}\u0000-\u001f\u007f]/.test(t)) return null;
  if (t === '.' || t === '..' || t.startsWith('./') || t.startsWith('../') || t.includes('/./') || t.includes('/../') || t.endsWith('/.') || t.endsWith('/..')) return null;
  return t;
}

// ── GET /api/lookup and GET /api/lookup/img ──
// key: whose budget this spends — 'owner', or `t:${sub}` for a tester. The caller has already authenticated.
// io (tests): { fetch, cache (a Cache API object or null), now }.
export async function handleLookup(req, env, url, { key } = {}, io = {}) {
  const {
    fetch: fetchFn = (...a) => globalThis.fetch(...a),
    cache = globalThis.caches?.default ?? null,
    now = Date.now,
  } = io;
  env = env || {};
  const who = typeof key === 'string' && key ? key : 'unknown';
  try {
    if (req.method !== 'GET') return ERR.method();
    if (env.LOOKUP_DISABLED === '1') return ERR.off();
    const route = url.pathname.replace(/^\/api\/?/, '');
    if (route === 'lookup/img') return await lookupImage(env, url, who, { fetchFn, cache, now });
    return await lookupSummary(env, url, who, { fetchFn, cache, now });
  } catch (err) {
    if (err instanceof LookupStop) return err.kind === 'busy' ? ERR.busy(err.retryAfter) : ERR.unavailable();
    console.warn('lookup failed', err?.name || 'error'); // never err.message: it can carry the URL, which holds the words
    return ERR.unavailable();
  }
}

async function lookupSummary(env, url, who, { fetchFn, cache, now }) {
  const params = url.searchParams;
  const qs = params.getAll('q'), ts = params.getAll('title');
  if (qs.length + ts.length !== 1) return ERR.query();
  const q = qs.length ? cleanTerm(qs[0]) : null;
  const title = ts.length ? validTitle(ts[0]) : null;
  if (!q && !title) return ERR.query();
  const site = wikiSite(params.get('lang'), params.get('v'));
  const mode = q ? 'q' : 't';
  const norm = q || title;

  if (!(await allowed(env.LOOKUP_LIMIT, who))) return ERR.rate();

  const k = cache ? await cacheKey(url.origin, site, mode, norm, who) : null;
  if (cache) {
    const hit = await Promise.resolve().then(() => cache.match(k)).catch(() => null);
    if (hit) return new Response(await hit.text(), { headers: { ...JSON_HEADERS, ...cacheState(who, 'hit') } });
  }
  if (now() < backoffUntil) return ERR.busy(clamp(Math.ceil((backoffUntil - now()) / 1000), LOOKUP.retryMin, LOOKUP.retryMax));

  const body = await lookup(q ? { site, q } : { site, title }, upstream(env, fetchFn, now, who));
  const text = JSON.stringify(body);
  if (cache) {
    // A fresh Response: Wikimedia's set-cookie headers would stop the Cache API from storing it.
    const ttl = body.found ? LOOKUP.ttlFound : LOOKUP.ttlMiss;
    await Promise.resolve().then(() => cache.put(k, new Response(text, { headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${ttl}` } }))).catch(() => {});
  }
  return new Response(text, { headers: { ...JSON_HEADERS, ...cacheState(who, 'miss') } });
}

// The bytes go to the browser as a same-origin blob: a raster image (sniffed, never SVG), inline, sandboxed.
function imageResponse(bytes, type, who, state) {
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': type,
      'content-length': String(bytes.byteLength),
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-disposition': 'inline',
      'content-security-policy': "default-src 'none'; sandbox",
      'cross-origin-resource-policy': 'same-origin',
      ...cacheState(who, state),
    },
  });
}

// An untouched original is served only when its header says it is at most IMAGE.maxOriginal wide.
const originalOk = (bytes) => { const s = imageSize(bytes); return Boolean(s && s.width <= IMAGE.maxOriginal); };

async function lookupImage(env, url, who, { fetchFn, cache, now }) {
  const ks = url.searchParams.getAll('k');
  const parsed = ks.length === 1 ? parseImageKey(ks[0]) : null;
  // A thumbnail at one of the bounded widths, or a small raster original; nothing else is fetched.
  if (!parsed || (parsed.thumb && !THUMB_WIDTHS.includes(parsed.width)) || (parsed.thumb && !RASTER_EXT.test(parsed.key))) return ERR.image();
  const target = `https://${IMAGE.host}${IMAGE.prefix}${parsed.key}`;
  let u;
  try { u = new URL(target); } catch { return ERR.image(); }
  if (u.hostname !== IMAGE.host || u.pathname !== IMAGE.prefix + parsed.key || u.search || u.hash) return ERR.image();

  if (!(await allowed(env.LOOKUP_LIMIT, `${who}:img`))) return ERR.rate();

  const k = cache ? await imageCacheKey(url.origin, parsed.key, who) : null;
  if (cache) {
    const hit = await Promise.resolve().then(() => cache.match(k)).catch(() => null);
    if (hit) {
      const bytes = new Uint8Array(await hit.arrayBuffer());
      const type = sniffImage(bytes);
      if (type && (parsed.thumb || originalOk(bytes))) return imageResponse(bytes, type, who, 'hit');
    }
  }
  if (now() < imageBackoffUntil) return ERR.busy(clamp(Math.ceil((imageBackoffUntil - now()) / 1000), LOOKUP.retryMin, LOOKUP.retryMax));
  if (!(await allowed(env.WIKI_LIMIT, wikiKey(who, 'commons')))) return ERR.busy(LOOKUP.busyRetry);

  const headers = new Headers({ 'user-agent': userAgent(env), accept: IMAGE.types.join(',') });
  let res;
  try {
    res = await fetchFn(u.href, { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(LOOKUP_TIMING.imageMs) });
  } catch (err) {
    console.warn('lookup image', err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'network');
    return ERR.imageUnavailable();
  }
  const drop = async (why) => { await res.body?.cancel().catch(() => {}); console.warn('lookup image', why); return ERR.imageUnavailable(); };
  if (res.status === 429) {
    await res.body?.cancel().catch(() => {});
    const wait = clamp(Number(res.headers.get('retry-after')) || LOOKUP.busyRetry, LOOKUP.retryMin, LOOKUP.retryMax);
    imageBackoffUntil = now() + wait * 1000;
    console.warn('lookup image', 429);
    return ERR.busy(wait);
  }
  if (res.status >= 300 && res.status < 400) return drop(res.status); // redirects are never followed (one host only)
  if (!res.ok) return drop(res.status);
  const declared = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!IMAGE.types.includes(declared)) return drop('type');
  let bytes;
  try { bytes = await readCapped(res, parsed.thumb ? IMAGE.maxBytes : IMAGE.maxOriginalBytes); } catch { return drop('body'); }
  if (!bytes) return drop('too-large');
  const type = sniffImage(bytes);
  if (!type) return drop('not-an-image');
  // A thumbnail's width is fixed by its key; an original's only by its own header (owner decision 3: a bounded width).
  if (!parsed.thumb && !originalOk(bytes)) return drop('too-wide');
  if (cache) {
    await Promise.resolve().then(() => cache.put(k, new Response(bytes, { headers: { 'content-type': type, 'cache-control': `public, max-age=${IMAGE.ttl}` } }))).catch(() => {});
  }
  return imageResponse(bytes, type, who, 'miss');
}
