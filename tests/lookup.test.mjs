// Look up, server side (src/lookup.js): GET /api/lookup and the GET /api/lookup/img image proxy.
// Upstream is always a mock: the fixtures in tests/fixtures/lookup/ were recorded once from the live APIs (2026-10-01)
// and trimmed of anything identifying the recorder. No test here ever reaches Wikipedia or Wikimedia.
import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import * as S from '../src/lookup.js';

mock.method(console, 'warn', () => {}); // the expected 'lookup upstream …' lines; the logging test below captures them itself

const {
  LOOKUP, LOOKUP_TIMING, THUMB_WIDTHS, STANDARD_WIDTHS, IMAGE, LICENSE, WIKIS, cleanTerm, searchText, wikiSite, titlePath, summaryUrl, safeSummaryUrl,
  searchUrl, innerTerm, innerParts, innerFits, thumbAt, imageFrom, imageKey, parseImageKey, proxyImageUrl, sniffImage, imageSize, trimExtract, relevant,
  shownTitle, shapeSummary, shapeSearch, userAgent, cacheKey, imageCacheKey, lookup, handleLookup, resetLookupState,
} = S;

const TIMING = { ...LOOKUP_TIMING };
const realFetch = globalThis.fetch;
const hadCaches = 'caches' in globalThis, realCaches = globalThis.caches;
afterEach(() => {
  Object.assign(LOOKUP_TIMING, TIMING);
  globalThis.fetch = realFetch;
  if (hadCaches) globalThis.caches = realCaches; else delete globalThis.caches;
  resetLookupState();
});

// ── fixtures ──
const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/lookup/${name}.json`, import.meta.url), 'utf8'));
const DOMUS = fx('summary-domus-aurea').body;
const NOT_FOUND = fx('summary-nero-full-404').body; // {"status":404,"type":"Internal error"}
const SEARCH_NERO_LIVE = fx('search-neros-golden-house').body;
const MERCURY = fx('summary-mercury').body;
const SEARCH_MERCURY = fx('search-mercury').body;
const INCEPTION = fx('summary-inception').body;
// recorded 2026-10-01 for the review fixes
const UK = fx('summary-uk').body; // "UK" → United Kingdom
const CAMBRIDGE_UK_404 = fx('summary-cambridge-uk-404').body;
const SEARCH_CAMBRIDGE_UK = fx('search-cambridge-uk').body; // "Cambridge UK" → Cambridge first
const IPHONE = fx('summary-iphone-lower').body; // titles { normalized: 'IPhone', display: 'iPhone' }
const SEARCH_IPHONE = fx('search-iphone').body; // with displaytitle
const ZH_HISTORY_CN = fx('summary-zh-roman-history-zh-cn'); // asked with accept-language zh-cn
const DE_NERO_404 = fx('summary-de-neros-golden-house-404').body;
const SEARCH_DE_NERO = fx('search-de-neros-golden-house').body; // one hit: "Kevin – Allein zu Haus" (Home Alone)
const SEARCH_EN_NERO = fx('search-en-neros-golden-house-v2').body;
const C_DRIVE_504 = fx('summary-c-drive-504'); // {"status":504,"type":"Internal error"}: "C:" reads as an interwiki prefix
const SEARCH_C_DRIVE = fx('search-c-drive').body;
const RU_HERMITAGE = fx('summary-ru-hermitage').body; // an SVG thumbnail rendered in Russian: …/langru-330px-…
// The live search plus a disambiguation page ranked first: it must be dropped, never shown as the best match.
const SEARCH_NERO = structuredClone(SEARCH_NERO_LIVE);
for (const p of SEARCH_NERO.query.pages) p.index += 1;
SEARCH_NERO.query.pages.push({ pageid: 4242, ns: 0, title: 'Golden House', index: 1, description: 'Topics referred to by the same term', pageprops: { disambiguation: '' }, extract: 'Golden House may refer to:' });
const UNRELATED = { batchcomplete: true, query: { pages: [
  { pageid: 11, ns: 0, title: 'Banana', index: 1, description: 'Edible fruit', extract: 'A banana is an elongated, edible fruit.' },
  { pageid: 12, ns: 0, title: 'Apple', index: 2, description: 'Fruit of the apple tree', extract: 'An apple is a round, edible fruit.' },
  { pageid: 13, ns: 0, title: 'Cherry', index: 3, description: 'Fruit', extract: 'A cherry is a fruit.' },
] } };
const EMPTY_SEARCH = { batchcomplete: true };

// ── fakes ──
const ORIGIN = 'https://atelier.ciprari.ai';
const WMF_COOKIE = 'WMF-Last-Access=01-Oct-2026;Path=/;HttpOnly;secure';
const wiki = (status, body, headers = {}) => new Response(body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'set-cookie': WMF_COOKIE, ...headers },
});
const img = (bytes, type = 'image/png', headers = {}) => new Response(bytes, { status: 200, headers: { 'content-type': type, 'set-cookie': WMF_COOKIE, ...headers } });
// fetch mock: [regex on "METHOD url", handler(call)]; every call is recorded; an unmatched call throws.
function mockFetch(routes = []) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const call = { url: String(input), method: init.method || 'GET', headers: new Headers(init.headers), signal: init.signal, redirect: init.redirect };
    calls.push(call);
    for (const [pattern, handler] of routes) if (pattern.test(`${call.method} ${call.url}`)) return handler(call);
    throw new Error(`unmocked fetch ${call.method} ${call.url}`);
  };
  return Object.assign(fetch, { calls });
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SUM = (t, host = 'en.wikipedia.org') => new RegExp(`^GET ${esc(`https://${host}/api/rest_v1/page/summary/${titlePath(t)}`)}$`);
const SEARCH = (host = 'en.wikipedia.org') => new RegExp(`^GET ${esc(`https://${host}/w/api.php?`)}`);
const ANY_SUMMARY = /^GET https:\/\/[a-z-]+\.wikipedia\.org\/api\/rest_v1\/page\/summary\//;
const hang = (call) => new Promise((_, reject) => call.signal.addEventListener('abort', () => reject(call.signal.reason), { once: true }));
function fakeCache() {
  const store = new Map(), puts = [], matches = [];
  return {
    store, puts, matches,
    async match(k) { matches.push(String(k)); const r = store.get(String(k)); return r ? r.clone() : undefined; },
    async put(k, r) { puts.push({ key: String(k), res: r.clone() }); store.set(String(k), r); },
  };
}
const limiter = (success = true) => { const keys = []; return { keys, limit: async ({ key }) => { keys.push(key); return { success }; } }; };

// One request through handleLookup. query: an object or a raw query string. → { res, status, body, headers }
async function call(query = {}, { env = {}, fetch = mockFetch(), cache = null, key = 'owner', method = 'GET', headers = {}, path = 'lookup', now } = {}) {
  const qs = typeof query === 'string' ? query : new URLSearchParams(query).toString();
  const req = new Request(`${ORIGIN}/api/${path}${qs ? `?${qs}` : ''}`, { method, headers });
  const res = await handleLookup(req, env, new URL(req.url), { key }, { fetch, cache, ...(now ? { now } : {}) });
  const isJson = (res.headers.get('content-type') || '').startsWith('application/json');
  const body = isJson ? await res.clone().json() : new Uint8Array(await res.clone().arrayBuffer());
  return { res, status: res.status, body, headers: res.headers, fetch };
}

// image bytes (with a real pixel size in the header: the proxy reads it for untouched originals)
const bytesOf = (head, n = 64) => { const b = new Uint8Array(Math.max(n, head.length)); b.set(head); return b; };
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const be32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255], be16 = (v) => [(v >> 8) & 255, v & 255], le16 = (v) => [v & 255, (v >> 8) & 255];
const le24 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255];
const PNG = (n, w = 200, h = 100) => bytesOf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, ...ascii('IHDR'), ...be32(w), ...be32(h)], n);
// SOI, an APP0 segment, then SOF0 (height before width)
const JPEG = (n, w = 200, h = 100) => bytesOf([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, ...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, 0, 0x11, 8, ...be16(h), ...be16(w), 3], n);
const GIF = (n, w = 200, h = 100) => bytesOf([...ascii('GIF89a'), ...le16(w), ...le16(h)], n);
const WEBP = (n, w = 200, h = 100) => bytesOf([...ascii('RIFF'), 0x90, 0, 0, 0, ...ascii('WEBPVP8 '), 0x80, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h)], n);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>');
const DOMUS_KEY = 'thumb/0/03/Domus_Aurea_pianta_generale.png/330px-Domus_Aurea_pianta_generale.png';
const DOMUS_UPSTREAM = `https://upload.wikimedia.org/wikipedia/commons/${DOMUS_KEY}`;
const UPLOAD = /^GET https:\/\/upload\.wikimedia\.org\//;
const imgQuery = (k) => proxyImageUrl(k).split('?')[1];

// ── 1. cleanTerm ──
const KEEP = [
  ['“Nero’s Golden House (Domus Aurea)”,', 'Nero’s Golden House (Domus Aurea)'],
  ["Nero's Golden House (Domus Aurea)", "Nero's Golden House (Domus Aurea)"],
  ['(Domus Aurea)', 'Domus Aurea'],
  ['**Mercury**', 'Mercury'],
  ['Rome[12].', 'Rome'],
  ['Augustus[citation needed]', 'Augustus'],
  ['- Nero', 'Nero'],
  ['• Nero', 'Nero'],
  ['1. Nero', 'Nero'],
  ['AC/DC', 'AC/DC'],
  ['C++', 'C++'],
  ["Achilles' heel", "Achilles' heel"],
  ['Café', 'Café'],
  ['Café', 'Café'], // NFC
  ['Star Wars: Episode IV', 'Star Wars: Episode IV'],
  ['„Haus“', 'Haus'],
  ['«Paris»', 'Paris'],
  ['「東京」', '東京'],
  ['Rome;', 'Rome'],
  ['Nero (', 'Nero'],
  ['(a) and (b)', '(a) and (b)'],
  ['Mercury (planet)', 'Mercury (planet)'],
  ['  Golden \n\t House  ', 'Golden House'],
  ['Golden​ House‎', 'Golden House'],
  ['<Domus> Aurea', 'Domus Aurea'],
  ['Domus #Aurea|', 'Domus Aurea'],
  // a letter's # is "sharp" (Wikipedia's spelling): F# major is not F major, C# is not C
  ['F# major', 'F sharp major'],
  ['C# programming', 'C sharp programming'],
  ['C#', 'C sharp'],
  ['(C#)', 'C sharp'],
  ['f#.', 'f sharp'],
  ['#hashtag', 'hashtag'],
  ['issue#12', 'issue12'],
  ['Nero!?…', 'Nero'],
  ['Vietnam War 1955–1975', 'Vietnam War 1955–1975'],
];
const REJECT = ['', 'a', '42', '…', '  ', 'https://x.y', 'www.x.com', 'a@b.co', 'mail me at a@b.co', '555-123-4567', '0123456789', 'call 555 123 4567',
  'a = b;', 'foo()', '${x}', '{x}', 'x => y', 'std::vector', '`code`', '.', '..', './x', 'a/../b', 'x'.repeat(121), Array(13).fill('word').join(' '),
  null, undefined, 42, {}, 'x'.repeat(5000)];
test('cleanTerm: cleans selections and refuses what isn’t a term', () => {
  for (const [raw, want] of KEEP) assert.equal(cleanTerm(raw), want, JSON.stringify(raw));
  for (const raw of REJECT) assert.equal(cleanTerm(raw), null, JSON.stringify(raw));
  assert.equal(cleanTerm('x'.repeat(120)), 'x'.repeat(120));
  assert.equal(cleanTerm(Array(12).fill('word').join(' ')), Array(12).fill('word').join(' '));
});
test('cleanTerm is idempotent (the client sends cleaned words; the server cleans them again)', () => {
  const samples = [...KEEP.map(([r]) => r), '(- Nero)', '<(Nero)>', '’90s', "'quoted'", '"x" and "y"', 'Haus“', '“Haus', ') Nero', 'abc (def) ghi ('];
  for (const raw of samples) {
    const once = cleanTerm(raw);
    assert.equal(cleanTerm(once), once, JSON.stringify(raw));
  }
});
test('cleanTerm is self-contained, so the client copy can be compared as source text', () => {
  const src = cleanTerm.toString();
  for (const name of ['LOOKUP', 'CONTROL', 'STOP', 'CIRRUS', 'clean(', 'clamp(']) assert.ok(!src.includes(name), name);
});
const clientUrl = new URL('../public/lookup.js', import.meta.url);
const client = existsSync(clientUrl) ? await import(clientUrl.href).catch(() => null) : null;
test('cleanTerm parity: public/lookup.js has the same function, character for character', { skip: !client?.cleanTerm && 'public/lookup.js (client) not written yet' }, () => {
  assert.equal(client.cleanTerm.toString(), cleanTerm.toString());
  for (const raw of [...KEEP.map(([r]) => r), ...REJECT]) assert.equal(client.cleanTerm(raw), cleanTerm(raw), JSON.stringify(raw));
});

// ── 2-4. search text, sites, URLs ──
test('searchText strips CirrusSearch operators but keeps ordinary punctuation', () => {
  assert.equal(searchText('intitle:foo -bar "baz"~ *x insource:/y/ (q)'), 'foo bar baz x /y/ q');
  assert.equal(searchText('Star Wars: Episode IV'), 'Star Wars: Episode IV');
  assert.equal(searchText("Nero's Golden House"), "Nero's Golden House");
  assert.equal(searchText('morelike: Nero !important hastemplate:x'), 'Nero important x');
});
test('wikiSite: only listed wikis become hosts; aliases, variants and direction', () => {
  assert.equal(wikiSite('en').host, 'en.wikipedia.org');
  assert.equal(wikiSite('nb').lang, 'no');
  assert.equal(wikiSite('yue').host, 'zh-yue.wikipedia.org');
  assert.equal(wikiSite('DE').lang, 'de');
  for (const bad of ['evil.com', 'en.evil', '../x', 'EN;drop', '', null, undefined, 'constructor', '__proto__', 'toString', 'en/../x', 'xx']) {
    assert.equal(wikiSite(bad).lang, 'en', String(bad));
  }
  assert.equal(wikiSite('zh', 'zh-tw').acceptLanguage, 'zh-tw');
  assert.equal(wikiSite('zh', 'ZH-CN').acceptLanguage, 'zh-cn');
  assert.equal(wikiSite('en', 'zh-tw').acceptLanguage, null);
  assert.equal(wikiSite('zh', 'zh-evil').acceptLanguage, null);
  assert.equal(wikiSite('sr', 'sr-el').acceptLanguage, 'sr-el');
  assert.equal(wikiSite('he').dir, 'rtl');
  assert.equal(wikiSite('en').dir, 'ltr');
  for (const l of [...WIKIS, 'nb', 'yue', 'evil', '']) assert.match(wikiSite(l).host, /^[a-z-]+\.wikipedia\.org$/);
});
test('summary URLs: underscores, percent-encoding, and the path guard', () => {
  assert.equal(summaryUrl('en.wikipedia.org', "Nero's Golden House (Domus Aurea)"), "https://en.wikipedia.org/api/rest_v1/page/summary/Nero's_Golden_House_(Domus_Aurea)");
  assert.ok(summaryUrl('en.wikipedia.org', 'C++').endsWith('/C%2B%2B'));
  assert.ok(summaryUrl('en.wikipedia.org', 'AC/DC').endsWith('/AC%2FDC'));
  assert.ok(summaryUrl('en.wikipedia.org', 'What? #1').endsWith('/What%3F_%231'));
  assert.equal(safeSummaryUrl('en.wikipedia.org', '..'), null);
  assert.equal(safeSummaryUrl('en.wikipedia.org', '.'), null);
  assert.equal(safeSummaryUrl('en.wikipedia.org', '\ud800'), null); // can't be encoded
  assert.equal(safeSummaryUrl('en.wikipedia.org', 'Domus Aurea'), 'https://en.wikipedia.org/api/rest_v1/page/summary/Domus_Aurea');
});
test('innerTerm: the bracketed name of "Name (Inner)"', () => {
  assert.equal(innerTerm("Nero's Golden House (Domus Aurea)"), 'Domus Aurea');
  assert.equal(innerTerm('Domus Aurea'), null);
  assert.equal(innerTerm('x (y)'), null); // too short
  assert.equal(innerTerm('Mercury (planet)'), 'planet');
  assert.deepEqual(innerParts('Cambridge (UK)'), { outer: 'Cambridge', inner: 'UK' });
  assert.equal(innerParts('Cambridge'), null);
});
test('innerFits: the bracketed name’s article must mention something from outside the brackets', () => {
  const domus = shapeSummary(DOMUS, wikiSite('en')), uk = shapeSummary(UK, wikiSite('en'));
  assert.equal(innerFits("Nero's Golden House", domus), true, 'the Domus Aurea lead names Nero');
  assert.equal(innerFits('Neros Goldenes Haus', domus), true, 'a shared start: Neros ~ Nero (another language)');
  assert.equal(innerFits('Cambridge', uk), false, 'the United Kingdom is the qualifier, not the selection');
  assert.equal(innerFits('Golden Gate Bridge', { title: 'San Francisco', description: 'City in California', extract: 'San Francisco is a commercial and cultural center.' }), false);
  assert.equal(innerFits('AI', { title: 'Artificial intelligence', description: '', extract: '' }), true, 'nothing to check against: it counts');
  assert.equal(innerFits('Nero', { title: 'Neon', description: '', extract: '' }), false, 'a different word never matches');
  assert.equal(innerFits('Rom', { title: 'Romania', description: '', extract: '' }), false, 'under 4 letters only an exact word matches');
});

// ── 5. a summary hit ──
test('summary hit: one call, the whitelisted article, a policy User-Agent, nothing of the visitor forwarded', async () => {
  const domus = { ...DOMUS, content_urls: { desktop: { page: 'javascript:alert(1)' } } };
  const fetch = mockFetch([[SUM('Domus Aurea'), () => wiki(200, domus)]]);
  const { status, body, headers } = await call({ q: 'Domus Aurea', lang: 'en' }, {
    fetch, env: { WIKI_CONTACT: 'cole@ciprari.ai' },
    headers: { cookie: '__Host-atelier_tester=secret', 'x-app-pass': 'pw', 'cf-connecting-ip': '203.0.113.9', 'user-agent': 'Visitor/1.0', 'accept-language': 'fr' },
  });
  assert.equal(status, 200);
  assert.equal(headers.get('content-type'), 'application/json');
  assert.equal(headers.get('cache-control'), 'no-store');
  assert.equal(fetch.calls.length, 1);
  assert.deepEqual(Object.keys(body).sort(), ['description', 'dir', 'extract', 'found', 'image', 'kind', 'lang', 'license', 'others', 'query', 'title', 'trimmed', 'url', 'v', 'via']);
  assert.equal(body.v, 1); assert.equal(body.found, true); assert.equal(body.kind, 'article'); assert.equal(body.via, 'title');
  assert.equal(body.title, 'Domus Aurea'); assert.equal(body.description, 'Roman palace'); assert.equal(body.query, 'Domus Aurea');
  assert.equal(body.lang, 'en'); assert.equal(body.dir, 'ltr'); assert.equal(body.trimmed, false);
  assert.equal(body.extract, DOMUS.extract);
  assert.equal(body.url, 'https://en.wikipedia.org/wiki/Domus_Aurea');
  assert.deepEqual(body.others, []);
  assert.deepEqual(body.license, LICENSE);
  for (const k of ['extract_html', 'displaytitle', 'titles', 'coordinates', 'wikibase_item', 'content_urls', 'thumbnail', 'originalimage']) assert.ok(!(k in body), k);
  assert.ok(!JSON.stringify(body).includes('javascript:'));

  const up = fetch.calls[0];
  assert.equal(up.redirect, 'manual');
  assert.ok(up.signal instanceof AbortSignal);
  assert.deepEqual([...up.headers.keys()].sort(), ['accept', 'user-agent']);
  assert.equal(up.headers.get('accept'), 'application/json');
  assert.match(up.headers.get('user-agent'), /^Atelier\/\d+\.\d+ \(https:\/\/atelier\.ciprari\.ai\/(; .+)?\) Cloudflare-Workers$/);
  assert.equal(up.headers.get('user-agent'), 'Atelier/1.0 (https://atelier.ciprari.ai/; cole@ciprari.ai) Cloudflare-Workers');
});
test('userAgent: policy format with or without a contact, and a contact can’t break the header', () => {
  const re = /^Atelier\/\d+\.\d+ \(https:\/\/atelier\.ciprari\.ai\/(; .+)?\) Cloudflare-Workers$/;
  assert.equal(userAgent({}), 'Atelier/1.0 (https://atelier.ciprari.ai/) Cloudflare-Workers');
  assert.match(userAgent(undefined), re);
  assert.match(userAgent({ WIKI_CONTACT: 'cole@ciprari.ai' }), re);
  const odd = userAgent({ WIKI_CONTACT: 'a@b.c\r\nx-evil: 1 (x)' });
  assert.match(odd, re);
  assert.ok(!/[\r\n()]/.test(odd.slice(odd.indexOf('; '), odd.lastIndexOf(')'))));
  new Headers({ 'user-agent': odd }); // valid header value
});
test('the summary image is a Commons thumbnail served through /api/lookup/img, at the bounded widths', async () => {
  const fetch = mockFetch([[SUM('Domus Aurea'), () => wiki(200, DOMUS)]]);
  const { body } = await call({ q: 'Domus Aurea' }, { fetch });
  const im = body.image;
  assert.deepEqual(Object.keys(im).sort(), ['file', 'height', 'mat', 'page', 'src', 'srcset', 'width']);
  assert.equal(im.src, proxyImageUrl(DOMUS_KEY));
  assert.match(im.src, /^\/api\/lookup\/img\?k=[A-Za-z0-9%._~-]+$/);
  assert.equal(im.width, 330); assert.equal(im.height, 229);
  assert.equal(im.file, 'Domus_Aurea_pianta_generale.png');
  assert.equal(im.page, 'https://commons.wikimedia.org/wiki/File:Domus_Aurea_pianta_generale.png');
  assert.equal(im.mat, true);
  assert.deepEqual(im.srcset.map(([w]) => w), [250, 330, 500]);
  assert.deepEqual(THUMB_WIDTHS, [250, 330, 500]);
  for (const [w, u] of im.srcset) {
    assert.match(u, /^\/api\/lookup\/img\?k=[A-Za-z0-9%._~-]+$/);
    assert.equal(u, im.src.replace('330px-', `${w}px-`)); // only the /NNNpx- part differs
  }
  assert.ok(!JSON.stringify(body).includes('wikimedia.org/wikipedia'), 'no direct Wikimedia image URL reaches the browser');
});

// ── 6-11. the strategy ──
test('"Name (Inner)": the full selection misses, the bracketed name hits — 2 calls, no search', async () => {
  const q = "Nero's Golden House (Domus Aurea)";
  const fetch = mockFetch([[SUM(q), () => wiki(404, NOT_FOUND)], [SUM('Domus Aurea'), () => wiki(200, DOMUS)]]);
  const { status, body } = await call({ q, lang: 'en' }, { fetch });
  assert.equal(status, 200);
  assert.equal(body.kind, 'article'); assert.equal(body.via, 'inner'); assert.equal(body.title, 'Domus Aurea'); assert.equal(body.query, q);
  assert.equal(fetch.calls.length, 2);
  assert.ok(!fetch.calls.some((c) => c.url.includes('/w/api.php')));
});
test('"Name (Qualifier)": a bracketed qualifier’s own article is not the answer — search runs with the whole selection', async () => {
  const q = 'Cambridge (UK)';
  const fetch = mockFetch([[SUM(q), () => wiki(404, CAMBRIDGE_UK_404)], [SUM('UK'), () => wiki(200, UK)], [SEARCH(), () => wiki(200, SEARCH_CAMBRIDGE_UK)]]);
  const { status, body } = await call({ q }, { fetch });
  assert.equal(status, 200);
  assert.equal(body.kind, 'article'); assert.notEqual(body.via, 'inner');
  assert.equal(body.via, 'search'); assert.equal(body.title, 'Cambridge');
  assert.ok(!JSON.stringify(body).includes('United Kingdom of Great Britain'), 'never the United Kingdom card');
  assert.equal(fetch.calls.length, 3);
  assert.equal(new URL(fetch.calls[2].url).searchParams.get('gsrsearch'), 'Cambridge UK', 'the search keeps the whole selection');
});
test('an interwiki-looking prefix ("C: drive"): the summary’s fixed 504 is a miss, and search finds the article', async () => {
  const fetch = mockFetch([[SUM('C: drive'), () => wiki(504, C_DRIVE_504.body)], [SEARCH(), () => wiki(200, SEARCH_C_DRIVE)]]);
  const { status, body } = await call({ q: 'C: drive' }, { fetch });
  assert.equal(status, 200);
  assert.equal(body.found, true); assert.equal(body.via, 'search'); assert.equal(body.title, 'Drive letter assignment');
  assert.equal(fetch.calls.length, 2); assert.ok(fetch.calls[1].url.includes('/w/api.php'));
  // a real outage still says so: the search failing too, a 5xx without a prefix, or a picked title
  let r = await call({ q: 'C: drive' }, { fetch: mockFetch([[ANY_SUMMARY, () => wiki(504, C_DRIVE_504.body)], [SEARCH(), () => wiki(503, {})]]) });
  assert.equal(r.status, 502);
  r = await call({ q: 'Domus Aurea' }, { fetch: mockFetch([[ANY_SUMMARY, () => wiki(504, {})], [SEARCH(), () => wiki(200, EMPTY_SEARCH)]]) });
  assert.equal(r.status, 502);
  r = await call({ q: 'Star Wars: Episode IV' }, { fetch: mockFetch([[ANY_SUMMARY, () => wiki(504, {})], [SEARCH(), () => wiki(200, EMPTY_SEARCH)]]) });
  assert.equal(r.status, 502, 'a space before the colon is not a prefix');
  r = await call({ title: 'C: drive' }, { fetch: mockFetch([[ANY_SUMMARY, () => wiki(504, {})]]) });
  assert.equal(r.status, 502);
  r = await call({ q: 'C: drive' }, { fetch: mockFetch([[ANY_SUMMARY, () => { throw new TypeError('fetch failed'); }], [SEARCH(), () => wiki(200, SEARCH_C_DRIVE)]]) });
  assert.equal(r.status, 502, 'a network failure is never read as a miss');
});
test('search fallback: the best match by index, disambiguation pages dropped, two alternatives, a cacheable query', async () => {
  const q = "Nero's Golden House";
  const fetch = mockFetch([[SUM(q), () => wiki(404, NOT_FOUND)], [SEARCH(), () => wiki(200, SEARCH_NERO)]]);
  const { body } = await call({ q }, { fetch });
  assert.equal(body.kind, 'article'); assert.equal(body.via, 'search');
  assert.equal(body.title, 'Domus Aurea'); assert.equal(body.description, 'Roman palace');
  assert.equal(body.url, 'https://en.wikipedia.org/wiki/Domus_Aurea');
  assert.deepEqual(body.others, [{ title: 'Palace Tomb', description: 'Tomb in Jordan' }, { title: 'Nero', description: 'Roman emperor from AD 54 to 68' }]);
  assert.ok(!JSON.stringify(body).includes('Topics referred to'));
  assert.ok(body.extract.length <= LOOKUP.extractChars);
  assert.equal(body.image.src, proxyImageUrl(DOMUS_KEY));
  assert.equal(fetch.calls.length, 2);
  const u = new URL(fetch.calls[1].url);
  assert.equal(u.host, 'en.wikipedia.org'); assert.equal(u.pathname, '/w/api.php');
  const p = u.searchParams;
  assert.equal(p.get('generator'), 'search'); assert.equal(p.get('gsrsearch'), q); assert.equal(p.get('gsrnamespace'), '0'); assert.equal(p.get('gsrlimit'), '4');
  assert.equal(p.get('pilicense'), 'free'); assert.equal(p.get('smaxage'), '86400'); assert.equal(p.get('maxage'), '3600');
  assert.equal(p.get('prop'), 'extracts|pageimages|description|pageprops|info'); assert.equal(p.get('ppprop'), 'disambiguation');
  assert.ok(!p.has('origin')); assert.ok(!p.has('maxlag'));
  assert.equal(searchUrl('en.wikipedia.org', 'x', 6).includes('gsrlimit=6'), true);
});
test('relevance gate: an unrelated top hit is not called a match, and nothing unrelated is offered as "Closest"', async () => {
  const fetch = mockFetch([[SUM('Quantum chromodynamics lattice'), () => wiki(404, NOT_FOUND)], [SEARCH(), () => wiki(200, UNRELATED)]]);
  const { status, body } = await call({ q: 'Quantum chromodynamics lattice' }, { fetch });
  assert.equal(status, 200);
  assert.equal(body.found, false);
  assert.deepEqual(body.others, [], 'Banana and Apple failed the same test the top hit failed');
  assert.deepEqual(Object.keys(body).sort(), ['found', 'lang', 'others', 'query', 'search', 'v']);
  // a lower hit that does pass is offered
  const mixed = structuredClone(UNRELATED);
  mixed.query.pages[2] = { pageid: 14, ns: 0, title: 'Lattice QCD', index: 3, description: 'Quantum chromodynamics on a lattice', extract: 'Lattice QCD is quantum chromodynamics on a lattice.' };
  const r = await call({ q: 'Quantum chromodynamics lattice' }, { fetch: mockFetch([[ANY_SUMMARY, () => wiki(404, NOT_FOUND)], [SEARCH(), () => wiki(200, mixed)]]) });
  assert.equal(r.body.found, false);
  assert.deepEqual(r.body.others, [{ title: 'Lattice QCD', description: 'Quantum chromodynamics on a lattice' }]);
});
test('relevant(): token overlap, possessives and accents folded, short terms always pass', () => {
  assert.equal(relevant("Nero's Golden House", { title: 'Domus Aurea', description: 'Roman palace', extract: 'The Domus Aurea (Latin, "Golden House") was built by the Emperor Nero.' }), true);
  assert.equal(relevant('Quantum chromodynamics lattice', { title: 'Banana', description: 'Fruit', extract: 'A banana is a fruit.' }), false);
  assert.equal(relevant('Mercury', { title: 'Banana' }), true); // one token: no gate
  assert.equal(relevant('Café Procope history', { title: 'Cafe Procope', description: 'Paris café', extract: '' }), true);
});
test('disambiguation: the meanings, by rank, never a disambiguation page, title and url from the summary', async () => {
  const fetch = mockFetch([[SUM('Mercury'), () => wiki(200, MERCURY)], [SEARCH(), () => wiki(200, SEARCH_MERCURY)]]);
  const { body } = await call({ q: 'Mercury' }, { fetch });
  assert.equal(body.kind, 'choices'); assert.equal(body.found, true);
  assert.equal(body.title, 'Mercury'); assert.equal(body.url, 'https://en.wikipedia.org/wiki/Mercury');
  assert.deepEqual(body.choices.map((c) => c.title), ['Mercury (planet)', 'Freddie Mercury', 'Mercury (element)', 'Mercury Records']);
  assert.ok(body.choices.length <= LOOKUP.choices);
  assert.deepEqual(Object.keys(body).sort(), ['choices', 'dir', 'found', 'kind', 'lang', 'license', 'query', 'title', 'url', 'v']);
  assert.equal(new URL(fetch.calls[1].url).searchParams.get('gsrlimit'), '6');
  assert.equal(fetch.calls.length, 2);
});
test('title= mode: one summary call, never a search; a miss is found:false', async () => {
  let fetch = mockFetch([[SUM('Mercury (planet)'), () => wiki(200, { ...DOMUS, titles: { canonical: 'Mercury_(planet)', normalized: 'Mercury (planet)' }, description: 'First planet from the Sun' })]]);
  let r = await call({ title: 'Mercury (planet)' }, { fetch });
  assert.equal(r.body.kind, 'article'); assert.equal(r.body.via, 'title'); assert.equal(r.body.url, 'https://en.wikipedia.org/wiki/Mercury_(planet)');
  assert.equal(fetch.calls.length, 1);
  fetch = mockFetch([[ANY_SUMMARY, () => wiki(404, NOT_FOUND)]]);
  r = await call({ title: 'No such page at all' }, { fetch });
  assert.equal(r.status, 200); assert.equal(r.body.found, false);
  assert.equal(fetch.calls.length, 1);
  // a disambiguation page asked for by title is not an article either
  fetch = mockFetch([[SUM('Mercury'), () => wiki(200, MERCURY)]]);
  r = await call({ title: 'Mercury' }, { fetch });
  assert.equal(r.body.found, false); assert.equal(fetch.calls.length, 1);
});
test('not found: 200 found:false with a Wikipedia search link — never a 404', async () => {
  const fetch = mockFetch([[ANY_SUMMARY, () => wiki(404, NOT_FOUND)], [SEARCH(), () => wiki(200, EMPTY_SEARCH)]]);
  const { status, body } = await call({ q: "Zork's Lantern" }, { fetch });
  assert.equal(status, 200);
  assert.deepEqual(body, { v: 1, found: false, lang: 'en', query: "Zork's Lantern", search: 'https://en.wikipedia.org/w/index.php?search=Zork%27s%20Lantern&ns0=1', others: [] });
  assert.match(body.search, /^https:\/\/[a-z0-9-]+\.wikipedia\.org\/w\/index\.php\?search=[^\s"'<>]+$/);
});
test('summary types that are not articles are misses: no-extract, mainpage, other namespaces, empty extract', async () => {
  for (const variant of [{ type: 'no-extract' }, { type: 'mainpage' }, { namespace: { id: 4 } }, { extract: '   ' }, { titles: {}, title: '' }]) {
    const fetch = mockFetch([[SUM('Domus Aurea'), () => wiki(200, { ...DOMUS, ...variant })], [SEARCH(), () => wiki(200, EMPTY_SEARCH)]]);
    const { body } = await call({ q: 'Domus Aurea' }, { fetch });
    assert.equal(body.found, false, JSON.stringify(variant));
  }
});
test('another language: the local wiki first, then one English call as the last of at most 3', async () => {
  let fetch = mockFetch([[ANY_SUMMARY, () => wiki(404, NOT_FOUND)], [SEARCH('de.wikipedia.org'), () => wiki(200, EMPTY_SEARCH)], [SEARCH('en.wikipedia.org'), () => wiki(200, EMPTY_SEARCH)]]);
  let r = await call({ q: 'Goldenes Haus', lang: 'de' }, { fetch });
  assert.equal(r.body.found, false); assert.equal(r.body.lang, 'de');
  assert.ok(r.body.search.startsWith('https://de.wikipedia.org/'));
  assert.equal(fetch.calls.length, 3);
  assert.deepEqual(fetch.calls.map((c) => new URL(c.url).host), ['de.wikipedia.org', 'de.wikipedia.org', 'en.wikipedia.org']);
  assert.ok(fetch.calls[2].url.includes('/w/api.php'), 'without a bracketed name the English call is a search (it finds exact titles too)');
  assert.equal(new URL(fetch.calls[2].url).searchParams.get('gsrsearch'), 'Goldenes Haus');
  // with a bracketed name, the English call is still the last one and asks for the inner name
  fetch = mockFetch([[SUM('Domus Aurea'), () => wiki(200, DOMUS)], [ANY_SUMMARY, () => wiki(404, NOT_FOUND)], [SEARCH('de.wikipedia.org'), () => wiki(200, EMPTY_SEARCH)]]);
  r = await call({ q: 'Neros Goldenes Haus (Domus Aurea)', lang: 'de' }, {
    fetch: mockFetch([[SUM('Domus Aurea', 'en.wikipedia.org'), () => wiki(200, DOMUS)], [ANY_SUMMARY, () => wiki(404, NOT_FOUND)], [SEARCH('de.wikipedia.org'), () => wiki(200, EMPTY_SEARCH)]]),
  });
  assert.equal(r.body.kind, 'article'); assert.equal(r.body.lang, 'en'); assert.equal(r.body.dir, 'ltr'); assert.equal(r.body.via, 'inner');
  assert.equal(r.fetch.calls.length, 3);
  assert.equal(new URL(r.fetch.calls[2].url).host, 'en.wikipedia.org');
});
test('a German device reading an English answer: "Nero’s Golden House" resolves through the English search, never a Home Alone suggestion', async () => {
  const q = "Nero's Golden House";
  const fetch = mockFetch([
    [SUM(q, 'de.wikipedia.org'), () => wiki(404, DE_NERO_404)],
    [SEARCH('de.wikipedia.org'), () => wiki(200, SEARCH_DE_NERO)],
    [SEARCH('en.wikipedia.org'), () => wiki(200, SEARCH_EN_NERO)],
  ]);
  const { status, body } = await call({ q, lang: 'de' }, { fetch });
  assert.equal(status, 200);
  assert.equal(body.found, true); assert.equal(body.lang, 'en'); assert.equal(body.via, 'search'); assert.equal(body.title, 'Domus Aurea');
  assert.equal(body.url, 'https://en.wikipedia.org/wiki/Domus_Aurea');
  assert.deepEqual(body.others, [], 'English names are never offered as picks on a German card (picks ask the reader’s own wiki)');
  assert.ok(!JSON.stringify(body).includes('Kevin'), 'the German top hit failed the relevance test and is not suggested');
  assert.deepEqual(fetch.calls.map((c) => `${new URL(c.url).host} ${c.url.includes('/w/api.php') ? 'search' : 'summary'}`),
    ['de.wikipedia.org summary', 'de.wikipedia.org search', 'en.wikipedia.org search']);
  // when nothing in English fits either: found:false on the German wiki, with no unrelated "Closest"
  const none = await call({ q, lang: 'de' }, { fetch: mockFetch([[ANY_SUMMARY, () => wiki(404, DE_NERO_404)], [SEARCH('de.wikipedia.org'), () => wiki(200, SEARCH_DE_NERO)], [SEARCH('en.wikipedia.org'), () => wiki(200, UNRELATED)]]) });
  assert.equal(none.body.found, false); assert.equal(none.body.lang, 'de'); assert.deepEqual(none.body.others, []);
  // an English exact title found by that search is labelled as the title, not a guess
  const exact = await call({ q: 'Domus Aurea', lang: 'de' }, { fetch: mockFetch([[ANY_SUMMARY, () => wiki(404, NOT_FOUND)], [SEARCH('de.wikipedia.org'), () => wiki(200, EMPTY_SEARCH)], [SEARCH('en.wikipedia.org'), () => wiki(200, SEARCH_EN_NERO)]]) });
  assert.equal(exact.body.title, 'Domus Aurea'); assert.equal(exact.body.via, 'title');
});
test('"Cambridge (UK)" on another wiki: an off-topic bracketed article sends the English call to search', async () => {
  const q = 'Cambridge (UK)';
  const fetch = mockFetch([
    [SUM(q, 'de.wikipedia.org'), () => wiki(404, NOT_FOUND)], [SUM('UK', 'de.wikipedia.org'), () => wiki(200, { ...UK, lang: 'de' })],
    [SEARCH('en.wikipedia.org'), () => wiki(200, SEARCH_CAMBRIDGE_UK)],
  ]);
  const { body } = await call({ q, lang: 'de' }, { fetch });
  assert.equal(body.found, true); assert.equal(body.lang, 'en'); assert.equal(body.title, 'Cambridge'); assert.equal(body.via, 'search');
  assert.equal(fetch.calls.length, 3);
});
test('script variants go in accept-language, only on wikis that have them', async () => {
  let fetch = mockFetch([[ANY_SUMMARY, () => wiki(200, DOMUS)]]);
  await call({ q: '羅馬', lang: 'zh', v: 'zh-tw' }, { fetch });
  assert.equal(new URL(fetch.calls[0].url).host, 'zh.wikipedia.org');
  assert.equal(fetch.calls[0].headers.get('accept-language'), 'zh-tw');
  fetch = mockFetch([[ANY_SUMMARY, () => wiki(200, DOMUS)]]);
  await call({ q: 'Rome', lang: 'en', v: 'zh-tw' }, { fetch });
  assert.equal(fetch.calls[0].headers.get('accept-language'), null);
  fetch = mockFetch([[ANY_SUMMARY, () => wiki(200, DOMUS)]]);
  await call({ q: 'Rome', lang: 'evil.example' }, { fetch });
  assert.equal(new URL(fetch.calls[0].url).host, 'en.wikipedia.org');
});
test('a right-to-left wiki: dir comes from the summary, or from the wiki for search results', async () => {
  let fetch = mockFetch([[ANY_SUMMARY, () => wiki(200, { ...DOMUS, dir: 'rtl', lang: 'he' })]]);
  let r = await call({ q: 'דומוס', lang: 'he' }, { fetch });
  assert.equal(r.body.dir, 'rtl');
  fetch = mockFetch([[ANY_SUMMARY, () => wiki(200, { ...DOMUS, dir: 'evil' })]]);
  r = await call({ q: 'Domus Aurea' }, { fetch });
  assert.equal(r.body.dir, 'ltr');
  const pages = shapeSearch(SEARCH_NERO, wikiSite('ar'));
  assert.ok(pages.every((p) => p.dir === 'rtl'));
});

// ── 13. images ──
test('imageFrom: Commons only, https only, the right hosts, raster renders only', () => {
  const dims = { width: 330, height: 229, origWidth: 2601 };
  assert.equal(imageFrom(INCEPTION.thumbnail.source, { width: INCEPTION.thumbnail.width, height: INCEPTION.thumbnail.height, origWidth: INCEPTION.originalimage.width }), null);
  assert.equal(shapeSummary(INCEPTION, wikiSite('en')).image, null);
  const good = `https://thumb.wikimedia.org/wikipedia/commons/${DOMUS_KEY}`;
  assert.ok(imageFrom(good, dims));
  assert.ok(imageFrom(`https://upload.wikimedia.org/wikipedia/commons/${DOMUS_KEY}?utm_source=x`, dims));
  for (const bad of [
    good.replace('https:', 'http:'), good.replace('thumb.wikimedia.org', 'thumb.wikimedia.org:8443'), good.replace('https://', 'https://u:p@'),
    good.replace('thumb.wikimedia.org', 'upload.wikimedia.org.evil.com'), good.replace('thumb.wikimedia.org', 'evil.com'),
    good.replace('/commons/', '/en/'),
    'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Scan.tif/lossy-page1-330px-Scan.tif.jpg',
    'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Paper.pdf/page1-330px-Paper.pdf.jpg',
    'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Clip.webm/330px--Clip.webm.jpg',
    'https://upload.wikimedia.org/wikipedia/commons/a/ab/Clip.webm',
    'https://upload.wikimedia.org/wikipedia/commons/a/ab/Logo.svg',
    'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/x.png/330px-y.png',
    'https://upload.wikimedia.org/wikipedia/commons/thumb/a/cd/x.png/330px-x.png', // hash folders don't nest
    'javascript:alert(1)', '//thumb.wikimedia.org/wikipedia/commons/' + DOMUS_KEY, '', null, 42,
  ]) assert.equal(imageFrom(bad, dims), null, String(bad));
  assert.equal(imageFrom(good, { width: 330 }), null, 'no height → no image');
  // an SVG renders as .svg.png; mat for transparent formats
  const svg = imageFrom('https://thumb.wikimedia.org/wikipedia/commons/thumb/0/03/Flag_of_Italy.svg/330px-Flag_of_Italy.svg.png', { width: 330, height: 220, origWidth: 1500 });
  assert.equal(svg.file, 'Flag_of_Italy.svg'); assert.equal(svg.mat, true);
  assert.equal(imageFrom(`https://thumb.wikimedia.org/wikipedia/commons/thumb/7/71/Claudius_crop.jpg/330px-Claudius_crop.jpg`, dims).mat, false);
  // a small original (no /thumb/) is used as is, up to 500 px
  const small = imageFrom('https://upload.wikimedia.org/wikipedia/commons/a/ab/Small_logo.png', { width: 200, height: 100, origWidth: 200 });
  assert.deepEqual(small.srcset, [[200, proxyImageUrl('a/ab/Small_logo.png')]]);
  assert.equal(small.src, proxyImageUrl('a/ab/Small_logo.png'));
  assert.equal(imageFrom('https://upload.wikimedia.org/wikipedia/commons/a/ab/Huge.png', { width: 900, height: 900, origWidth: 900 }), null);
  // a narrow original: only the widths it can fill
  assert.deepEqual(imageFrom(good, { width: 330, height: 229, origWidth: 300 }).srcset.map(([w]) => w), [250]);
  // names with encoded characters keep their encoding in the key; the page link is a Commons File: page
  const comma = imageFrom('https://thumb.wikimedia.org/wikipedia/commons/thumb/6/63/Palace_Tomb%2C_Petra.jpg/330px-Palace_Tomb%2C_Petra.jpg', dims);
  assert.equal(comma.file, 'Palace_Tomb,_Petra.jpg');
  assert.equal(comma.page, 'https://commons.wikimedia.org/wiki/File:Palace_Tomb%2C_Petra.jpg');
  assert.equal(parseImageKey(new URL(`${ORIGIN}${comma.src}`).searchParams.get('k')).file, 'Palace_Tomb,_Petra.jpg');
  const quote = imageFrom("https://thumb.wikimedia.org/wikipedia/commons/thumb/1/12/Achilles'_heel.jpg/330px-Achilles'_heel.jpg", dims);
  assert.match(quote.page, /^https:\/\/commons\.wikimedia\.org\/wiki\/File:[^\s"'<>]+$/);
  assert.match(quote.src, /^\/api\/lookup\/img\?k=[A-Za-z0-9%._~-]+$/);
});
test('thumbAt: only the /NNNpx- part, only on thumbnails, only to a standard width, never above the original', () => {
  const t = `https://thumb.wikimedia.org/wikipedia/commons/${DOMUS_KEY}?utm_source=x`;
  assert.equal(thumbAt(t, 500, 2601), t.replace('/330px-', '/500px-'));
  assert.equal(thumbAt(t, 400, 2601), t);
  assert.equal(thumbAt(t, 960, 600), t);
  assert.equal(thumbAt(DOMUS_KEY, 250, 2601), DOMUS_KEY.replace('/330px-', '/250px-'));
  const orig = 'https://upload.wikimedia.org/wikipedia/commons/0/03/Domus_Aurea_pianta_generale.png';
  assert.equal(thumbAt(orig, 500, 2601), orig);
  assert.ok(STANDARD_WIDTHS.includes(500) && !STANDARD_WIDTHS.includes(400));
});
test('parseImageKey: the only shapes the image proxy accepts', () => {
  assert.deepEqual(parseImageKey(DOMUS_KEY), { key: DOMUS_KEY, thumb: true, width: 330, file: 'Domus_Aurea_pianta_generale.png', svg: false });
  assert.equal(parseImageKey('a/ab/Small_logo.png').thumb, false);
  assert.equal(parseImageKey('thumb/0/03/Flag.svg/330px-Flag.svg.png').svg, true);
  for (const bad of ['', '../../etc/passwd', 'thumb/0/03/x.png/330px-x.png/../../y', 'thumb/0/13/x.png/330px-x.png', 'thumb/0/03/x.png/330px-y.png',
    'thumb/0/03/x%2F..%2Fy.png/330px-x%2F..%2Fy.png', 'thumb/0/03/x%5Cy.png/330px-x%5Cy.png', 'thumb/0/03/x%0Ay.png/330px-x%0Ay.png', 'thumb/0/03/../330px-..',
    'thumb/0/03/%2e%2e/330px-%2e%2e', 'thumb/0/03/x.png/0330px-x.png', 'thumb/0/03/x.png/330px-x.png?y', 'thumb/0/03/x.png/330px-x.png#y', '0/03/x.svg',
    'thumb/0/03/x.tif/330px-x.tif.jpg', '0/03/x.exe', 'thumb/0/03/x.svg/330px-x.svg', 'thumb/0/03/x y.png/330px-x y.png', 'thumb/0/03/%E0%A4%A.png/330px-%E0%A4%A.png',
    `thumb/0/03/${'a'.repeat(700)}.png/330px-${'a'.repeat(700)}.png`, null, 42]) {
    assert.equal(parseImageKey(bad), null, String(bad));
  }
  assert.equal(imageKey('https://thumb.wikimedia.org/wikipedia/commons/thumb/0/03/Flag.svg/330px-Flag.svg.png'), 'thumb/0/03/Flag.svg/330px-Flag.svg.png');
});
test('an SVG rendered in the wiki’s language (…/langru-330px-…) is a preview image, at every width, through the proxy', async () => {
  const site = wikiSite('ru');
  const a = shapeSummary(RU_HERMITAGE, site);
  assert.ok(a.image, 'the Hermitage logo is shown');
  const base = 'thumb/7/73/Hermitage_logo.svg/langru-330px-Hermitage_logo.svg.png';
  assert.equal(a.image.src, proxyImageUrl(base));
  assert.deepEqual(a.image.srcset.map(([w]) => w), [250, 330, 500]);
  assert.deepEqual(a.image.srcset.map(([, u]) => parseImageKey(new URL(`${ORIGIN}${u}`).searchParams.get('k')).key),
    [base.replace('330px', '250px'), base, base.replace('330px', '500px')]);
  assert.equal(a.image.file, 'Hermitage_logo.svg'); assert.equal(a.image.mat, true);
  assert.deepEqual(parseImageKey(base), { key: base, thumb: true, width: 330, file: 'Hermitage_logo.svg', svg: true });
  assert.equal(parseImageKey('thumb/3/35/Flag_of_Kyiv_Kurovskyi.svg/languk-330px-Flag_of_Kyiv_Kurovskyi.svg.png').width, 330);
  assert.equal(parseImageKey('thumb/0/03/Map.svg/langzh-hans-330px-Map.svg.png').svg, true);
  assert.equal(thumbAt(`https://thumb.wikimedia.org/wikipedia/commons/${base}?utm_source=x`, 500, 2723), `https://thumb.wikimedia.org/wikipedia/commons/${base.replace('330px', '500px')}?utm_source=x`);
  // only SVGs render per language, and the prefix has one shape
  for (const bad of ['thumb/0/03/x.jpg/langru-330px-x.jpg', 'thumb/0/03/x.svg/lang-330px-x.svg.png', 'thumb/0/03/x.svg/langRU-330px-x.svg.png',
    'thumb/0/03/x.svg/langru330px-x.svg.png', 'thumb/0/03/x.svg/xlangru-330px-x.svg.png', 'thumb/0/03/x.svg/langru-330px-y.svg.png']) {
    assert.equal(parseImageKey(bad), null, bad);
  }
  // the proxy fetches exactly that render
  const fetch = mockFetch([[UPLOAD, () => img(PNG())]]);
  const r = await call(a.image.srcset[0][1].split('?')[1], { path: 'lookup/img', fetch });
  assert.equal(r.status, 200);
  assert.equal(fetch.calls[0].url, `https://upload.wikimedia.org/wikipedia/commons/${base.replace('330px', '250px')}`);
});
test('a file name over 160 bytes renders as "thumbnail.<ext>" with the extension lower-cased', () => {
  const name = `${'X'.repeat(170)}.JPG`;
  const key = (r) => `thumb/a/ab/${name}/330px-${r}`;
  assert.equal(parseImageKey(key('thumbnail.jpg')).file, name);
  assert.equal(parseImageKey(key('thumbnail.JPG'))?.file, name, 'the file’s own case is still accepted');
  assert.equal(parseImageKey(key('thumbnail.png')), null);
  assert.ok(imageFrom(`https://upload.wikimedia.org/wikipedia/commons/${key('thumbnail.jpg')}`, { width: 330, height: 200, origWidth: 4000 }));
  assert.equal(parseImageKey(`thumb/a/ab/${'y'.repeat(170)}.svg/330px-thumbnail.svg.png`).svg, true);
});
test('long non-Latin file names (each named twice in a key) still get a picture, within the client’s URL limit', async () => {
  const enc = (s) => encodeURIComponent(s.replace(/ /g, '_'));
  for (const file of ['Воскресенский Ново-Иерусалимский монастырь, вид на закате.jpg', `${'Ж'.repeat(60)}.jpg`, `${'Ж'.repeat(78)}.jpg`, `${'東'.repeat(52)}.png`]) {
    const n = enc(file);
    const src = `https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/${n}/330px-${n}`;
    assert.ok(`thumb/a/ab/${n}/330px-${n}`.length > 600, 'longer than the old 600-character cap');
    const image = imageFrom(src, { width: 330, height: 220, origWidth: 4000 });
    assert.ok(image, file);
    for (const [, u] of image.srcset) {
      assert.ok(u.length <= IMAGE.urlChars, `${u.length}`);
      assert.match(u, /^\/api\/lookup\/img\?k=[A-Za-z0-9%._~-]{1,1800}$/);
      assert.equal(parseImageKey(new URL(`${ORIGIN}${u}`).searchParams.get('k')).file, file.replace(/ /g, '_'));
    }
    const fetch = mockFetch([[UPLOAD, () => img(JPEG())]]);
    assert.equal((await call(image.src.split('?')[1], { path: 'lookup/img', fetch })).status, 200, file);
  }
  // the longest a real key can be (a 160-byte name, twice) stays inside both limits; past them nothing is fetched
  const longest = enc(`${'Ж'.repeat(78)}.jpg`);
  assert.ok(`thumb/a/ab/${longest}/500px-${longest}`.length < IMAGE.keyChars);
  assert.equal(parseImageKey(`thumb/a/ab/${'a'.repeat(1000)}.png/330px-${'a'.repeat(1000)}.png`), null);
});
test('sniffImage: PNG, JPEG, GIF and WebP by their first bytes; SVG, HTML and short bodies are not images', () => {
  assert.equal(sniffImage(PNG()), 'image/png');
  assert.equal(sniffImage(JPEG()), 'image/jpeg');
  assert.equal(sniffImage(GIF()), 'image/gif');
  assert.equal(sniffImage(WEBP()), 'image/webp');
  assert.equal(sniffImage(SVG), null);
  assert.equal(sniffImage(new TextEncoder().encode('<!doctype html><html>')), null);
  assert.equal(sniffImage(PNG().slice(0, 8)), null);
  assert.equal(sniffImage('PNG'), null);
});

// ── 14. extracts ──
test('trimExtract: the first paragraph, up to 3 sentences and 480 characters, as plain text', () => {
  const long = Array.from({ length: 12 }, (_, i) => `Sentence number ${i + 1} talks about the Domus Aurea at some considerable length to fill the space.`).join(' ');
  let r = trimExtract(long, 'en');
  assert.equal(r.trimmed, true);
  assert.ok(r.extract.length <= LOOKUP.extractChars);
  assert.equal((r.extract.match(/\./g) || []).length, 3);
  const words = 'word '.repeat(200);
  r = trimExtract(`${words}end.`, 'en');
  assert.ok(r.extract.length <= LOOKUP.extractChars, String(r.extract.length));
  assert.ok(r.extract.endsWith('…'));
  assert.ok(/\bword…$/.test(r.extract), 'cut at a word boundary');
  assert.equal(r.trimmed, true);
  r = trimExtract('First paragraph.\nSecond paragraph.', 'en');
  assert.deepEqual(r, { extract: 'First paragraph.', trimmed: true });
  r = trimExtract('Rome[12] is a city.[citation needed] It is old.[3]', 'en');
  assert.equal(r.extract, 'Rome is a city. It is old.');
  assert.equal(r.trimmed, false);
  assert.deepEqual(trimExtract('Arm. gen. Ing. John Smith was a soldier.', 'en'), { extract: 'Arm. gen. Ing. John Smith was a soldier.', trimmed: false });
  assert.equal(trimExtract('Arm. gen. Ing. John Smith was a soldier. He fought. He won. He died.', 'en').extract, 'Arm. gen. Ing. John Smith was a soldier. He fought. He won.');
  assert.equal(trimExtract('John F. Kennedy was president. He was born in 1917. He died in 1963. Then more.', 'en').extract, 'John F. Kennedy was president. He was born in 1917. He died in 1963.');
  r = trimExtract('A <img src=x onerror=alert(1)> b. <script>alert(1)</script>C.', 'en');
  assert.ok(!/[<>]/.test(r.extract), r.extract);
  assert.deepEqual(trimExtract(undefined), { extract: '', trimmed: false });
  assert.equal(trimExtract('羅馬是意大利的首都。它很古老。它很美。它很大。', 'zh-yue').extract, '羅馬是意大利的首都。它很古老。它很美。'); // a locale ICU rejects falls back
});
test('trimExtract: the regex fallback works without Intl.Segmenter', () => {
  const Segmenter = Intl.Segmenter;
  delete Intl.Segmenter;
  try {
    assert.equal(typeof Intl.Segmenter, 'undefined');
    assert.equal(trimExtract('One. Two! Three? Four.', 'en').extract, 'One. Two! Three?');
    assert.equal(trimExtract('Arm. gen. Ing. John Smith was a soldier.', 'en').extract, 'Arm. gen. Ing. John Smith was a soldier.');
    assert.equal(trimExtract('Troops of the U.S. Army landed. They won. It ended. Later.', 'en').extract, 'Troops of the U.S. Army landed. They won. It ended.');
    assert.equal(trimExtract('No end mark at all', 'en').extract, 'No end mark at all');
  } finally { Intl.Segmenter = Segmenter; }
});
test('markup in upstream titles, descriptions and extracts comes out as plain text', async () => {
  const xss = '<img src=x onerror=alert(1)>';
  const fetch = mockFetch([[ANY_SUMMARY, () => wiki(200, { ...DOMUS, titles: { normalized: `Domus ${xss}Aurea`, canonical: 'Domus_Aurea' }, description: `Roman ${xss}palace`, extract: `${xss}The Domus Aurea was a palace.\u0007` })]]);
  const { body } = await call({ q: 'Domus Aurea' }, { fetch });
  for (const k of ['title', 'description', 'extract']) {
    assert.ok(!/[<>]/.test(body[k]), `${k}: ${body[k]}`);
    assert.ok(!/[\u0000-\u001f]/.test(body[k]), k);
  }
  assert.equal(body.title, 'Domus Aurea');
  assert.equal(body.extract, 'The Domus Aurea was a palace.');
  // caps
  const long = mockFetch([[ANY_SUMMARY, () => wiki(200, { ...DOMUS, titles: { normalized: 'T'.repeat(500) }, description: 'D'.repeat(500) })]]);
  const r = await call({ q: 'Domus Aurea' }, { fetch: long });
  assert.equal(r.body.title.length, LOOKUP.titleChars);
  assert.equal(r.body.description.length, LOOKUP.descChars);
});
test('titles read as Wikipedia shows them: "iPhone", not the database form "IPhone"; a zh variant in the reader’s script', async () => {
  // summary: titles.display is plain text after its tags go; the link still uses the canonical title
  let fetch = mockFetch([[SUM('iPhone'), () => wiki(200, IPHONE)]]);
  let r = await call({ q: 'iPhone' }, { fetch });
  assert.equal(r.body.title, 'iPhone'); assert.equal(r.body.url, 'https://en.wikipedia.org/wiki/IPhone');
  assert.ok(!('ref' in r.body), 'an article answer keeps its whitelisted keys');
  // search: displaytitle is asked for; a picked name keeps the real title in ref, only when it differs
  fetch = mockFetch([[SUM('iPhone history'), () => wiki(404, NOT_FOUND)], [SEARCH(), () => wiki(200, SEARCH_IPHONE)]]);
  r = await call({ q: 'iPhone history' }, { fetch });
  assert.equal(new URL(fetch.calls[1].url).searchParams.get('inprop'), 'url|displaytitle');
  assert.equal(r.body.title, 'History of the iPhone');
  assert.deepEqual(r.body.others, [{ title: 'iPhone', description: SEARCH_IPHONE.query.pages.find((p) => p.title === 'IPhone').description, ref: 'IPhone' },
    { title: 'List of iPhone models', description: SEARCH_IPHONE.query.pages.find((p) => p.title === 'List of iPhone models').description }]);
  // zh with a variant: the Simplified title above the Simplified extract (the request asked for zh-cn)
  const zh = shapeSummary(ZH_HISTORY_CN.body, wikiSite('zh', 'zh-cn'));
  assert.equal(zh.title, '罗马帝国历史'); assert.equal(zh.ref, '羅馬帝國歷史');
  assert.equal(zh.url, `https://zh.wikipedia.org/wiki/${encodeURIComponent('羅馬帝國歷史')}`);
  assert.equal(shapeSummary(ZH_HISTORY_CN.body, wikiSite('zh')).title, '羅馬帝國歷史', 'no variant asked: the real title');
  // shownTitle: plain text, entities decoded, never a different page's name
  const en = wikiSite('en');
  assert.equal(shownTitle('<i>Star Wars</i>: Episode IV', 'Star Wars: Episode IV', en), 'Star Wars: Episode IV');
  assert.equal(shownTitle('AT&amp;T', 'AT&T', en), 'AT&T');
  assert.equal(shownTitle('<span>eBay</span>', 'EBay', en), 'eBay');
  assert.equal(shownTitle('Something else entirely', 'EBay', en), 'EBay');
  assert.equal(shownTitle('&lt;script&gt;', '<script>', en), '<script>', 'decoded text is still only ever rendered as text');
  assert.equal(shownTitle('', 'EBay', en), 'EBay'); assert.equal(shownTitle(undefined, 'EBay', en), 'EBay'); assert.equal(shownTitle('<b></b>', 'EBay', en), 'EBay');
  assert.equal(shownTitle(`<span>${'x'.repeat(500)}</span>`, 'x'.repeat(LOOKUP.titleChars), en), 'x'.repeat(LOOKUP.titleChars), 'capped like every title');
});

// ── 15. upstream failures ──
test('Wikipedia 429: lookup_busy with a clamped Retry-After, then a back-off with no upstream calls until reset', async () => {
  let t = 1_000_000;
  const now = () => t;
  let fetch = mockFetch([[ANY_SUMMARY, () => wiki(429, '{"error":"rate limited, contact ops"}', { 'retry-after': '300' })]]);
  let r = await call({ q: 'Domus Aurea' }, { fetch, now });
  assert.equal(r.status, 429);
  assert.deepEqual(r.body, { error: 'Wikipedia is busy — try again in a few seconds.', code: 'lookup_busy', retryAfter: 120 });
  assert.equal(r.headers.get('retry-after'), '120');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  fetch = mockFetch([[ANY_SUMMARY, () => wiki(200, DOMUS)]]);
  t += 30_000;
  r = await call({ q: 'Domus Aurea' }, { fetch, now });
  assert.equal(r.status, 429); assert.equal(r.body.code, 'lookup_busy'); assert.equal(r.body.retryAfter, 90);
  assert.equal(fetch.calls.length, 0);
  t += 91_000;
  r = await call({ q: 'Domus Aurea' }, { fetch, now });
  assert.equal(r.status, 200); assert.equal(fetch.calls.length, 1);
  // a tiny or missing Retry-After is raised to the 5 s floor; resetLookupState() clears the window
  fetch = mockFetch([[ANY_SUMMARY, () => wiki(429, {}, { 'retry-after': '1' })]]);
  r = await call({ q: 'Domus Aurea' }, { fetch, now });
  assert.equal(r.body.retryAfter, 5);
  resetLookupState();
  fetch = mockFetch([[ANY_SUMMARY, () => wiki(429, {})]]);
  r = await call({ q: 'Domus Aurea' }, { fetch, now });
  assert.equal(r.body.retryAfter, LOOKUP.busyRetry);
  resetLookupState();
  fetch = mockFetch([[ANY_SUMMARY, () => wiki(200, DOMUS)]]);
  r = await call({ q: 'Domus Aurea' }, { fetch, now });
  assert.equal(r.status, 200);
});
test('upstream errors, a thrown fetch, timeouts, the deadline, oversized and non-JSON bodies → 502 lookup_unavailable', async () => {
  const big = () => new Response(new ReadableStream({ start(c) { const chunk = new Uint8Array(65536).fill(32); for (let i = 0; i < 5; i++) c.enqueue(chunk); c.close(); } }), { status: 200, headers: { 'content-type': 'application/json' } });
  const cases = {
    503: () => wiki(503, 'upstream secret text <html>'),
    500: () => wiki(500, { error: 'boom' }),
    403: () => wiki(403, 'Please set a user-agent'),
    thrown: () => { throw new TypeError('fetch failed https://en.wikipedia.org/api/rest_v1/page/summary/Domus_Aurea'); },
    streamed: big,
    declared: () => wiki(200, '{}', { 'content-length': String(LOOKUP.bodyCap + 1) }),
    'not-json': () => wiki(200, 'not json at all'),
    'redirect-no-location': () => wiki(302, ''),
  };
  for (const [name, handler] of Object.entries(cases)) {
    const fetch = mockFetch([[ANY_SUMMARY, handler], [SEARCH(), () => wiki(200, EMPTY_SEARCH)]]);
    const r = await call({ q: 'Domus Aurea' }, { fetch });
    if (name === 'redirect-no-location') { assert.equal(r.status, 200, name); assert.equal(r.body.found, false); continue; } // a hop with nowhere to go is a miss
    assert.equal(r.status, 502, name);
    assert.deepEqual(r.body, { error: 'Couldn’t reach Wikipedia — try again.', code: 'lookup_unavailable' }, name);
  }
  Object.assign(LOOKUP_TIMING, { summaryMs: 30, searchMs: 30, deadlineMs: 200 });
  const slow = mockFetch([[ANY_SUMMARY, hang]]);
  const t0 = Date.now();
  const r = await call({ q: 'Domus Aurea' }, { fetch: slow });
  assert.equal(r.status, 502); assert.equal(r.body.code, 'lookup_unavailable');
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(slow.calls[0].signal.aborted);
  // the 7 s deadline across steps: the clock passes it after the first miss → no second call
  Object.assign(LOOKUP_TIMING, TIMING);
  let t = 0;
  const fetch = mockFetch([[ANY_SUMMARY, () => { t += LOOKUP_TIMING.deadlineMs + 1; return wiki(404, NOT_FOUND); }], [SEARCH(), () => wiki(200, SEARCH_NERO)]]);
  const late = await call({ q: "Nero's Golden House" }, { fetch, now: () => t });
  assert.equal(late.status, 502); assert.equal(fetch.calls.length, 1);
});
test('redirects: only same-wiki hops on the same API, at most 2; anything else is a miss and is never fetched', async () => {
  let fetch = mockFetch([
    [SUM('Golden House of Nero'), () => wiki(301, '', { location: 'https://evil.example/x' })],
    [/evil\.example/, () => wiki(200, DOMUS)],
    [SEARCH(), () => wiki(200, EMPTY_SEARCH)],
  ]);
  let r = await call({ q: 'Golden House of Nero' }, { fetch });
  assert.equal(r.status, 200); assert.equal(r.body.found, false);
  assert.ok(!fetch.calls.some((c) => c.url.includes('evil.example')));
  fetch = mockFetch([
    [SUM('Golden House of Nero'), () => wiki(301, '', { location: '/api/rest_v1/page/summary/Domus_Aurea' })],
    [SUM('Domus Aurea'), () => wiki(200, DOMUS)],
  ]);
  r = await call({ q: 'Golden House of Nero' }, { fetch });
  assert.equal(r.body.title, 'Domus Aurea'); assert.equal(r.body.via, 'title');
  assert.equal(fetch.calls.length, 2);
  assert.equal(fetch.calls[1].headers.get('cookie'), null);
  for (const loc of ['http://en.wikipedia.org/api/rest_v1/page/summary/Domus_Aurea', 'https://de.wikipedia.org/api/rest_v1/page/summary/Domus_Aurea',
    '/wiki/Domus_Aurea', 'https://en.wikipedia.org:8443/api/rest_v1/page/summary/Domus_Aurea', 'https://u:p@en.wikipedia.org/api/rest_v1/page/summary/X']) {
    fetch = mockFetch([[SUM('Golden House of Nero'), () => wiki(302, '', { location: loc })], [SEARCH(), () => wiki(200, EMPTY_SEARCH)], [/./, () => wiki(200, DOMUS)]]);
    r = await call({ q: 'Golden House of Nero' }, { fetch });
    assert.equal(r.body.found, false, loc);
    assert.equal(fetch.calls.length, 2, loc); // the summary and the search, never the Location
  }
  // a 3rd hop is refused
  fetch = mockFetch([
    [SUM('A1'), () => wiki(302, '', { location: '/api/rest_v1/page/summary/A2' })],
    [SUM('A2'), () => wiki(302, '', { location: '/api/rest_v1/page/summary/A3' })],
    [SUM('A3'), () => wiki(302, '', { location: '/api/rest_v1/page/summary/A4' })],
    [SUM('A4'), () => wiki(200, DOMUS)],
    [SEARCH(), () => wiki(200, EMPTY_SEARCH)],
  ]);
  r = await call({ q: 'A1' }, { fetch });
  assert.equal(r.body.found, false);
  assert.deepEqual(fetch.calls.map((c) => c.url.split('/').pop()), ['A1', 'A2', 'A3']);
});

// ── 17. edge cache ──
test('edge cache: a fresh public copy under a sha256 key, then hits with no upstream call', async () => {
  const cache = fakeCache();
  let fetch = mockFetch([[SUM('Domus Aurea'), () => wiki(200, DOMUS, { 'set-cookie': 'WMF-Uniq=abc; Domain=.wikipedia.org' })]]);
  let r = await call({ q: 'Domus Aurea' }, { fetch, cache });
  assert.equal(r.status, 200); assert.equal(r.headers.get('x-lookup-cache'), 'miss');
  assert.equal(cache.puts.length, 1);
  const put = cache.puts[0];
  assert.match(put.key, /^https:\/\/atelier\.ciprari\.ai\/__lookup\/v1\/[0-9a-f]{64}$/);
  assert.ok(!/domus|aurea/i.test(put.key));
  assert.equal(put.res.headers.get('cache-control'), 'public, max-age=86400');
  assert.equal(put.res.headers.get('content-type'), 'application/json');
  assert.equal(put.res.headers.get('set-cookie'), null);
  assert.deepEqual(await put.res.json(), r.body);
  assert.equal(put.key, await cacheKey(ORIGIN, wikiSite('en'), 'q', 'Domus Aurea', 'owner'));

  fetch = mockFetch();
  const hit = await call({ q: 'Domus Aurea' }, { fetch, cache });
  assert.equal(hit.status, 200); assert.deepEqual(hit.body, r.body);
  assert.equal(hit.headers.get('x-lookup-cache'), 'hit');
  assert.equal(hit.headers.get('cache-control'), 'no-store');
  assert.equal(hit.headers.get('content-type'), 'application/json');
  assert.equal(fetch.calls.length, 0);
  // another person, language, variant or mode is another key
  const keys = new Set([
    await cacheKey(ORIGIN, wikiSite('en'), 'q', 'Domus Aurea', 'owner'), await cacheKey(ORIGIN, wikiSite('de'), 'q', 'Domus Aurea', 'owner'),
    await cacheKey(ORIGIN, wikiSite('zh', 'zh-tw'), 'q', 'Domus Aurea', 'owner'), await cacheKey(ORIGIN, wikiSite('zh'), 'q', 'Domus Aurea', 'owner'),
    await cacheKey(ORIGIN, wikiSite('en'), 't', 'Domus Aurea', 'owner'), await cacheKey(ORIGIN, wikiSite('en'), 'q', 'Domus Aurea', 't:sub-1'),
    await cacheKey(ORIGIN, wikiSite('en'), 'q', 'Domus Aurea', 't:sub-2'),
  ]);
  assert.equal(keys.size, 7);
  // a miss is kept for an hour
  fetch = mockFetch([[ANY_SUMMARY, () => wiki(404, NOT_FOUND)], [SEARCH(), () => wiki(200, EMPTY_SEARCH)]]);
  await call({ q: 'Zork Lantern' }, { fetch, cache });
  assert.equal(cache.puts[1].res.headers.get('cache-control'), 'public, max-age=3600');
});
test('edge cache: one person’s look-ups are never another’s hits, and only the owner sees x-lookup-cache', async () => {
  // The owner looks up a private phrase (a miss on Wikipedia, cached for an hour), then a tester probes the same words.
  const cache = fakeCache();
  const PRIVATE = 'Project Falcon acquisition';
  const missing = () => mockFetch([[ANY_SUMMARY, () => wiki(404, NOT_FOUND)], [SEARCH(), () => wiki(200, EMPTY_SEARCH)]]);
  const owner = await call({ q: PRIVATE }, { cache, fetch: missing() });
  assert.equal(owner.body.found, false); assert.equal(owner.headers.get('x-lookup-cache'), 'miss');
  assert.equal(cache.puts.length, 1);
  const probe = await call({ q: PRIVATE }, { cache, key: 't:abc', fetch: missing() });
  assert.equal(probe.status, 200); assert.deepEqual(probe.body, owner.body);
  assert.equal(probe.headers.get('x-lookup-cache'), null, 'a tester never learns hit or miss');
  assert.equal(probe.fetch.calls.length, 2, 'the owner’s entry is not reused: the tester’s answer costs the same upstream round trip');
  assert.notEqual(cache.puts[1].key, cache.puts[0].key);
  // the tester’s own repeat is a hit (from their own entry), still without the header
  const again = await call({ q: PRIVATE }, { cache, key: 't:abc', fetch: mockFetch() });
  assert.equal(again.status, 200); assert.equal(again.fetch.calls.length, 0); assert.equal(again.headers.get('x-lookup-cache'), null);
  // and the owner never reuses a tester’s entry either
  const other = await call({ q: 'Zork Lantern' }, { cache, key: 't:abc', fetch: missing() });
  assert.equal(other.fetch.calls.length, 2);
  const ownerAfter = await call({ q: 'Zork Lantern' }, { cache, fetch: missing() });
  assert.equal(ownerAfter.fetch.calls.length, 2); assert.equal(ownerAfter.headers.get('x-lookup-cache'), 'miss');
  // errors and refusals for testers carry no cache header either
  const refused = await call({ q: PRIVATE }, { cache, key: 't:abc', env: { LOOKUP_LIMIT: limiter(false) } });
  assert.equal(refused.headers.get('x-lookup-cache'), null);
});
test('edge cache: failures and refusals are never stored, and a broken cache never breaks a lookup', async () => {
  const cache = fakeCache();
  await call({}, { cache }); // 400
  await call({ q: 'Domus Aurea' }, { cache, env: { LOOKUP_LIMIT: limiter(false) } }); // 429 rate
  await call({ q: 'Domus Aurea' }, { cache, fetch: mockFetch([[ANY_SUMMARY, () => wiki(429, {})]]) }); // 429 busy
  resetLookupState();
  await call({ q: 'Domus Aurea' }, { cache, fetch: mockFetch([[ANY_SUMMARY, () => wiki(503, {})]]) }); // 502
  await call({ q: 'Domus Aurea' }, { cache, env: { LOOKUP_DISABLED: '1' } }); // 503
  assert.equal(cache.puts.length, 0);
  const broken = { match: () => { throw new Error('cache down'); }, put: async () => { throw new Error('cache down'); } };
  const r = await call({ q: 'Domus Aurea' }, { cache: broken, fetch: mockFetch([[ANY_SUMMARY, () => wiki(200, DOMUS)]]) });
  assert.equal(r.status, 200); assert.equal(r.body.title, 'Domus Aurea');
});
test('handleLookup uses caches.default and global fetch when nothing is injected', async () => {
  const cache = fakeCache();
  globalThis.caches = { default: cache };
  globalThis.fetch = mockFetch([[ANY_SUMMARY, () => wiki(200, DOMUS)]]);
  const req = new Request(`${ORIGIN}/api/lookup?q=Domus%20Aurea`);
  const res = await handleLookup(req, {}, new URL(req.url), { key: 'owner' });
  assert.equal(res.status, 200);
  assert.equal(globalThis.fetch.calls.length, 1);
  assert.equal(cache.puts.length, 1);
});

// ── 18. handleLookup: the request contract ──
test('handleLookup: method, kill switch, query validation — fixed codes and messages', async () => {
  const fetch = mockFetch([[/./, () => wiki(200, DOMUS)]]);
  const cases = [
    [{}, 400, 'lookup_query'], ['q=', 400, 'lookup_query'], ['q=a', 400, 'lookup_query'], ['q=https%3A%2F%2Fx.y', 400, 'lookup_query'],
    ['q=Rome&title=Rome', 400, 'lookup_query'], ['q=Rome&q=Paris', 400, 'lookup_query'], ['title=', 400, 'lookup_query'],
    [`title=${'%C3%A9'.repeat(128)}`, 400, 'lookup_query'], ['title=..', 400, 'lookup_query'], ['title=.', 400, 'lookup_query'], ['title=a%2F..%2Fb', 400, 'lookup_query'],
    ['title=a%7Cb', 400, 'lookup_query'], ['title=a%23b', 400, 'lookup_query'], ['title=a%0Ab', 400, 'lookup_query'], ['lang=en', 400, 'lookup_query'],
  ];
  for (const [q, status, code] of cases) {
    const r = await call(q, { fetch });
    assert.equal(r.status, status, JSON.stringify(q));
    assert.equal(r.body.code, code, JSON.stringify(q));
    assert.equal(r.body.error, 'Select a word or a short name to look up.');
  }
  assert.equal(fetch.calls.length, 0);
  assert.equal((await call({ title: 'é'.repeat(127) }, { fetch: mockFetch([[ANY_SUMMARY, () => wiki(404, NOT_FOUND)]]) })).status, 200); // 254 bytes is fine
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD']) {
    const r = await call({ q: 'Rome' }, { method, fetch });
    assert.equal(r.status, 405, method);
    if (method !== 'HEAD') assert.deepEqual(r.body, { error: 'Use GET.', code: 'lookup_method' });
  }
  const off = await call({ q: 'Rome' }, { env: { LOOKUP_DISABLED: '1' }, fetch });
  assert.equal(off.status, 503); assert.deepEqual(off.body, { error: 'Look up is turned off for now.', code: 'lookup_off' });
  assert.equal((await call({ q: 'Rome' }, { env: { LOOKUP_DISABLED: '0' }, fetch })).status, 200);
  assert.equal(fetch.calls.length, 1);
});
test('handleLookup: the per-user limit comes first, keyed by who is asking; a missing or broken binding lets it through', async () => {
  let fetch = mockFetch([[/./, () => wiki(200, DOMUS)]]);
  const deny = limiter(false);
  let r = await call({ q: 'Rome' }, { env: { LOOKUP_LIMIT: deny }, key: 't:sub-1', fetch });
  assert.equal(r.status, 429);
  assert.deepEqual(r.body, { error: 'Too many look-ups — try again in a minute.', code: 'lookup_rate', retryAfter: 30 });
  assert.equal(r.headers.get('retry-after'), '30');
  assert.deepEqual(deny.keys, ['t:sub-1']);
  assert.equal(fetch.calls.length, 0);
  const allow = limiter(true);
  r = await call({ q: 'Rome' }, { env: { LOOKUP_LIMIT: allow }, key: 'owner', fetch });
  assert.equal(r.status, 200); assert.deepEqual(allow.keys, ['owner']);
  for (const binding of [{ limit: async () => { throw new Error('down'); } }, { limit: () => { throw new Error('sync'); } }, { limit: async () => undefined }, {}, undefined]) {
    r = await call({ q: 'Rome' }, { env: { LOOKUP_LIMIT: binding }, fetch });
    assert.equal(r.status, 200);
  }
  // the global Wikimedia budget: refused → busy, nothing sent
  const wikiDeny = limiter(false);
  fetch = mockFetch([[/./, () => wiki(200, DOMUS)]]);
  r = await call({ q: 'Rome' }, { env: { WIKI_LIMIT: wikiDeny }, fetch });
  assert.equal(r.status, 429); assert.equal(r.body.code, 'lookup_busy'); assert.equal(r.body.retryAfter, LOOKUP.busyRetry);
  assert.equal(r.headers.get('retry-after'), String(LOOKUP.busyRetry));
  assert.equal(fetch.calls.length, 0);
  assert.deepEqual(wikiDeny.keys, ['wikimedia:owner'], 'the owner has a Wikimedia budget of their own');
  r = await call({ q: 'Rome' }, { env: { WIKI_LIMIT: wikiDeny }, key: 't:sub-1', fetch });
  assert.equal(r.status, 429); assert.deepEqual(wikiDeny.keys, ['wikimedia:owner', 'wikimedia'], 'testers share one');
  // every upstream call asks the global budget first
  const wikiAllow = limiter(true);
  fetch = mockFetch([[SUM("Nero's Golden House (Domus Aurea)"), () => wiki(404, NOT_FOUND)], [SUM('Domus Aurea'), () => wiki(200, DOMUS)]]);
  await call({ q: "Nero's Golden House (Domus Aurea)" }, { env: { WIKI_LIMIT: wikiAllow }, fetch });
  assert.equal(wikiAllow.keys.length, fetch.calls.length);
});
test('testers who use up the shared Wikimedia budget never lock the owner out of Look up', async () => {
  // Fixed-window limiters like the real bindings: LOOKUP_LIMIT 30/min per key, WIKI_LIMIT 120/min per key.
  const window = (max) => { const n = new Map(); return { n, limit: async ({ key }) => { n.set(key, (n.get(key) || 0) + 1); return { success: n.get(key) <= max }; } }; };
  const env = { LOOKUP_LIMIT: window(30), WIKI_LIMIT: window(120) };
  const misses = () => mockFetch([[ANY_SUMMARY, () => wiki(404, NOT_FOUND)], [/\/w\/api\.php\?/, () => wiki(200, EMPTY_SEARCH)]]); // 3 calls each (de summary, de search, en search)
  const codes = [];
  for (const who of ['t:a', 't:b']) {
    for (let i = 0; i < 30; i++) codes.push((await call({ q: `Nonsense phrase ${who} ${i}`, lang: 'de' }, { env, key: who, fetch: misses() })).status);
  }
  assert.ok(codes.includes(429), 'the testers really did exhaust their shared budget');
  assert.ok(!codes.includes(502), 'every tester call reached the budget check');
  assert.ok(env.WIKI_LIMIT.n.get('wikimedia') > 120);
  const owner = await call({ q: 'Domus Aurea' }, { env, fetch: mockFetch([[ANY_SUMMARY, () => wiki(200, DOMUS)]]) });
  assert.equal(owner.status, 200); assert.equal(owner.body.title, 'Domus Aurea');
  // the same for images: four testers fill 'commons', the owner's picture still loads
  for (const who of ['t:a', 't:b', 't:c', 't:d', 't:e']) {
    for (let i = 0; i < 30; i++) await call(imgQuery(DOMUS_KEY), { path: 'lookup/img', env, key: who, fetch: mockFetch([[UPLOAD, () => img(PNG())]]) });
  }
  assert.ok(env.WIKI_LIMIT.n.get('commons') > 120);
  assert.equal((await call(imgQuery(DOMUS_KEY), { path: 'lookup/img', key: 't:f', env, fetch: mockFetch([[UPLOAD, () => img(PNG())]]) })).status, 429);
  const pic = await call(imgQuery(DOMUS_KEY), { path: 'lookup/img', env, fetch: mockFetch([[UPLOAD, () => img(PNG())]]) });
  assert.equal(pic.status, 200);
});
test('handleLookup never touches ATELIER_KV or LEDGER, and no error mentions a passcode', async () => {
  const env = new Proxy({ WIKI_CONTACT: 'cole@ciprari.ai' }, { get(t, k) { if (k === 'ATELIER_KV' || k === 'LEDGER') throw new Error(`touched ${String(k)}`); return t[k]; } });
  const bodies = [];
  const runs = [
    [{}, mockFetch()], [{ q: 'Domus Aurea' }, mockFetch([[ANY_SUMMARY, () => wiki(200, DOMUS)]])], [{ q: 'Mercury' }, mockFetch([[ANY_SUMMARY, () => wiki(200, MERCURY)], [SEARCH(), () => wiki(200, SEARCH_MERCURY)]])],
    [{ q: 'Domus Aurea' }, mockFetch([[ANY_SUMMARY, () => wiki(503, {})]])], [{ q: 'Domus Aurea' }, mockFetch([[ANY_SUMMARY, () => wiki(429, {})]])],
  ];
  for (const [q, fetch] of runs) {
    const r = await call(q, { env, fetch });
    bodies.push(JSON.stringify(r.body));
  }
  resetLookupState();
  for (const method of ['POST']) bodies.push(JSON.stringify((await call({ q: 'x' }, { env, method })).body));
  bodies.push(JSON.stringify((await call({ q: 'Rome' }, { env: { LOOKUP_LIMIT: limiter(false) } })).body));
  bodies.push(JSON.stringify((await call({ q: 'Rome' }, { env: { LOOKUP_DISABLED: '1' } })).body));
  bodies.push(JSON.stringify((await call({}, { env, path: 'lookup/img' })).body));
  for (const b of bodies) assert.ok(!/passcode/i.test(b), b);
});
test('an unexpected failure inside the handler is a 502, never the worker’s generic 500', async () => {
  const r = await call({ q: 'Domus Aurea' }, { fetch: mockFetch([[ANY_SUMMARY, () => wiki(200, DOMUS)]]), env: { get LOOKUP_LIMIT() { throw new Error('boom'); } } });
  assert.equal(r.status, 502); assert.equal(r.body.code, 'lookup_unavailable');
});
test('lookup(): the strategy on its own, with a fake io', async () => {
  const urls = [];
  let budget = 3;
  const io = { left: () => budget, get: async (u) => { urls.push(u); budget--; return u.includes('/summary/Domus_Aurea') ? DOMUS : null; } };
  const body = await lookup({ site: wikiSite('en'), q: "Nero's Golden House (Domus Aurea)" }, io);
  assert.equal(body.via, 'inner');
  assert.equal(urls.length, 2);
});

// ── the image proxy: GET /api/lookup/img?k=… ──
test('image proxy: rebuilds the upload.wikimedia.org URL from the key and serves sniffed bytes with strict headers', async () => {
  const png = PNG(2048);
  const fetch = mockFetch([[UPLOAD, () => img(png, 'image/png', { 'content-length': String(png.length) })]]);
  const r = await call(imgQuery(DOMUS_KEY), { path: 'lookup/img', fetch, headers: { cookie: 'x=1', 'x-app-pass': 'pw', 'cf-connecting-ip': '203.0.113.9' }, env: { WIKI_CONTACT: 'cole@ciprari.ai' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, png);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.equal(r.headers.get('content-length'), '2048');
  assert.equal(r.headers.get('cache-control'), 'private, no-store');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('content-disposition'), 'inline');
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(r.headers.get('content-security-policy'), /\bsandbox\b/);
  assert.equal(r.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(r.headers.get('set-cookie'), null);
  assert.equal(fetch.calls.length, 1);
  const up = fetch.calls[0];
  assert.equal(up.url, DOMUS_UPSTREAM);
  assert.equal(up.redirect, 'manual');
  assert.ok(up.signal instanceof AbortSignal);
  assert.deepEqual([...up.headers.keys()].sort(), ['accept', 'user-agent']);
  assert.equal(up.headers.get('user-agent'), 'Atelier/1.0 (https://atelier.ciprari.ai/; cole@ciprari.ai) Cloudflare-Workers');
  assert.match(up.headers.get('accept'), /^image\//);
});
test('image proxy: the summary’s image URLs round-trip — every srcset entry fetches the matching Commons thumbnail', async () => {
  const s = await call({ q: 'Domus Aurea' }, { fetch: mockFetch([[ANY_SUMMARY, () => wiki(200, DOMUS)]]) });
  for (const [w, u] of s.body.image.srcset) {
    const fetch = mockFetch([[UPLOAD, () => img(PNG())]]);
    const r = await call(u.split('?')[1], { path: 'lookup/img', fetch });
    assert.equal(r.status, 200, u);
    assert.equal(fetch.calls[0].url, DOMUS_UPSTREAM.replace('330px-', `${w}px-`));
  }
  // a summary thumbnail on thumb.wikimedia.org is still fetched from upload.wikimedia.org only
  const comma = imageFrom('https://thumb.wikimedia.org/wikipedia/commons/thumb/6/63/Palace_Tomb%2C_Petra.jpg/330px-Palace_Tomb%2C_Petra.jpg', { width: 330, height: 200, origWidth: 2809 });
  const fetch = mockFetch([[UPLOAD, () => img(JPEG(), 'image/jpeg')]]);
  const r = await call(comma.src.split('?')[1], { path: 'lookup/img', fetch });
  assert.equal(r.status, 200);
  assert.equal(fetch.calls[0].url, 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/63/Palace_Tomb%2C_Petra.jpg/330px-Palace_Tomb%2C_Petra.jpg');
  // a small original
  const small = mockFetch([[UPLOAD, () => img(GIF(), 'image/gif')]]);
  const o = await call(imgQuery('a/ab/Small_logo.gif'), { path: 'lookup/img', fetch: small });
  assert.equal(o.status, 200); assert.equal(o.headers.get('content-type'), 'image/gif');
  assert.equal(small.calls[0].url, 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Small_logo.gif');
});
test('image proxy: the content type comes from the bytes, never from upstream', async () => {
  for (const [label, bytes, want] of [['image/png', JPEG(), 'image/jpeg'], ['image/png', WEBP(), 'image/webp'], ['image/webp', PNG(), 'image/png'], ['image/gif', GIF(), 'image/gif']]) {
    const fetch = mockFetch([[UPLOAD, () => img(bytes, label)]]);
    const r = await call(imgQuery('thumb/0/03/Flag_of_Italy.svg/330px-Flag_of_Italy.svg.png'), { path: 'lookup/img', fetch });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), want);
  }
});
test('image proxy: bad keys are refused before anything is fetched', async () => {
  const fetch = mockFetch([[/./, () => img(PNG())]]);
  const bad = [
    '', 'k=', 'k=..%2F..%2Fetc%2Fpasswd', `${imgQuery(DOMUS_KEY)}&k=${encodeURIComponent(DOMUS_KEY)}`,
    imgQuery(DOMUS_KEY.replaceAll('330px-', '400px-')), imgQuery(DOMUS_KEY.replaceAll('330px-', '960px-')), imgQuery(DOMUS_KEY.replaceAll('330px-', '120px-')),
    imgQuery('thumb/0/13/x.png/330px-x.png'), imgQuery('thumb/0/03/x.png/330px-y.png'), imgQuery('0/03/Logo.svg'),
    imgQuery('thumb/0/03/x.tif/330px-x.tif.jpg'), `k=${encodeURIComponent('https://evil.example/x.png')}`, `k=${encodeURIComponent(`thumb/0/03/x.png/330px-x.png?y=1`)}`,
    `k=${encodeURIComponent('thumb/0/03/x%2F..%2Fy.png/330px-x%2F..%2Fy.png')}`, `k=${encodeURIComponent('thumb/0/03/%2e%2e/330px-%2e%2e.png')}`,
  ];
  for (const q of bad) {
    const r = await call(q, { path: 'lookup/img', fetch });
    assert.equal(r.status, 400, q);
    assert.deepEqual(r.body, { error: 'That isn’t a Look up image.', code: 'lookup_query' }, q);
  }
  assert.equal(fetch.calls.length, 0);
});
test('image proxy: anything that isn’t a small raster image from upload.wikimedia.org is a 502, never passed through', async () => {
  const cases = {
    html: () => img(new TextEncoder().encode('<!doctype html><script>alert(1)</script>'), 'text/html'),
    svgType: () => img(SVG, 'image/svg+xml'),
    svgBytes: () => img(SVG, 'image/png'),
    octet: () => img(PNG(), 'application/octet-stream'),
    notFound: () => img(new Uint8Array(0), 'text/plain', {}) && new Response('missing', { status: 404 }),
    serverError: () => new Response('err', { status: 500 }),
    redirectThumbHost: () => new Response('', { status: 301, headers: { location: 'https://thumb.wikimedia.org/wikipedia/commons/' + DOMUS_KEY } }),
    redirectEvil: () => new Response('', { status: 302, headers: { location: 'https://evil.example/x.png' } }),
    declaredTooBig: () => img(PNG(), 'image/png', { 'content-length': String(IMAGE.maxBytes + 1) }),
    streamedTooBig: () => new Response(new ReadableStream({ start(c) { c.enqueue(PNG(1024)); for (let i = 0; i < 24; i++) c.enqueue(new Uint8Array(65536)); c.close(); } }), { status: 200, headers: { 'content-type': 'image/png' } }),
    empty: () => img(new Uint8Array(0), 'image/png'),
    thrown: () => { throw new TypeError(`fetch failed ${DOMUS_UPSTREAM}`); },
  };
  for (const [name, handler] of Object.entries(cases)) {
    const cache = fakeCache();
    const fetch = mockFetch([[UPLOAD, handler], [/./, () => img(PNG())]]);
    const r = await call(imgQuery(DOMUS_KEY), { path: 'lookup/img', fetch, cache });
    assert.equal(r.status, 502, name);
    assert.deepEqual(r.body, { error: 'Couldn’t load the Wikimedia image.', code: 'lookup_unavailable' }, name);
    assert.equal(fetch.calls.length, 1, `${name}: redirects are never followed`);
    assert.equal(cache.puts.length, 0, `${name}: failures are never cached`);
  }
  Object.assign(LOOKUP_TIMING, { imageMs: 30 });
  const slow = mockFetch([[UPLOAD, hang]]);
  const r = await call(imgQuery(DOMUS_KEY), { path: 'lookup/img', fetch: slow });
  assert.equal(r.status, 502);
  assert.ok(slow.calls[0].signal.aborted);
});
test('image proxy: 429 backs off (separately from summaries); limits are keyed per user and on a separate global key', async () => {
  let t = 5_000_000;
  const now = () => t;
  let fetch = mockFetch([[UPLOAD, () => new Response('', { status: 429, headers: { 'retry-after': '60' } })]]);
  let r = await call(imgQuery(DOMUS_KEY), { path: 'lookup/img', fetch, now });
  assert.equal(r.status, 429); assert.equal(r.body.code, 'lookup_busy'); assert.equal(r.body.retryAfter, 60); assert.equal(r.headers.get('retry-after'), '60');
  fetch = mockFetch([[UPLOAD, () => img(PNG())], [ANY_SUMMARY, () => wiki(200, DOMUS)]]);
  t += 10_000;
  r = await call(imgQuery(DOMUS_KEY), { path: 'lookup/img', fetch, now });
  assert.equal(r.status, 429); assert.equal(r.body.retryAfter, 50); assert.equal(fetch.calls.length, 0);
  assert.equal((await call({ q: 'Domus Aurea' }, { fetch, now })).status, 200, 'summaries are not held back by an image 429');
  resetLookupState();
  assert.equal((await call(imgQuery(DOMUS_KEY), { path: 'lookup/img', fetch, now })).status, 200);

  const user = limiter(false);
  fetch = mockFetch([[UPLOAD, () => img(PNG())]]);
  r = await call(imgQuery(DOMUS_KEY), { path: 'lookup/img', fetch, env: { LOOKUP_LIMIT: user }, key: 't:sub-7' });
  assert.equal(r.status, 429); assert.equal(r.body.code, 'lookup_rate'); assert.deepEqual(user.keys, ['t:sub-7:img']); assert.equal(fetch.calls.length, 0);
  const global = limiter(false);
  r = await call(imgQuery(DOMUS_KEY), { path: 'lookup/img', fetch, env: { WIKI_LIMIT: global } });
  assert.equal(r.status, 429); assert.equal(r.body.code, 'lookup_busy'); assert.deepEqual(global.keys, ['commons:owner']); assert.equal(fetch.calls.length, 0);
  r = await call(imgQuery(DOMUS_KEY), { path: 'lookup/img', fetch, env: { WIKI_LIMIT: global }, key: 't:sub-7' });
  assert.equal(r.status, 429); assert.deepEqual(global.keys, ['commons:owner', 'commons']); assert.equal(fetch.calls.length, 0);
  assert.equal((await call(imgQuery(DOMUS_KEY), { path: 'lookup/img', fetch, env: { LOOKUP_DISABLED: '1' } })).status, 503);
  assert.equal((await call(imgQuery(DOMUS_KEY), { path: 'lookup/img', fetch, method: 'POST' })).status, 405);
});
test('image proxy: edge cache under a sha256 key (no file name), a week, sniffed type, hits re-checked', async () => {
  const cache = fakeCache();
  const png = PNG(512);
  let fetch = mockFetch([[UPLOAD, () => img(png, 'image/png')]]);
  let r = await call(imgQuery(DOMUS_KEY), { path: 'lookup/img', fetch, cache });
  assert.equal(r.status, 200); assert.equal(r.headers.get('x-lookup-cache'), 'miss');
  assert.equal(cache.puts.length, 1);
  const put = cache.puts[0];
  assert.match(put.key, /^https:\/\/atelier\.ciprari\.ai\/__lookup\/img\/v1\/[0-9a-f]{64}$/);
  assert.ok(!/domus/i.test(put.key));
  assert.equal(put.key, await imageCacheKey(ORIGIN, DOMUS_KEY, 'owner'));
  assert.notEqual(put.key, await imageCacheKey(ORIGIN, DOMUS_KEY, 't:sub-1'));
  assert.equal(put.res.headers.get('cache-control'), `public, max-age=${IMAGE.ttl}`);
  assert.equal(put.res.headers.get('content-type'), 'image/png');
  assert.equal(put.res.headers.get('set-cookie'), null);
  fetch = mockFetch();
  r = await call(imgQuery(DOMUS_KEY), { path: 'lookup/img', fetch, cache });
  assert.equal(r.status, 200); assert.deepEqual(r.body, png);
  assert.equal(r.headers.get('x-lookup-cache'), 'hit'); assert.equal(r.headers.get('cache-control'), 'private, no-store');
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.equal(fetch.calls.length, 0);
  // a cached entry that isn't an image is ignored and fetched again
  cache.store.set(put.key, new Response('<svg/>', { headers: { 'content-type': 'image/png' } }));
  fetch = mockFetch([[UPLOAD, () => img(png)]]);
  r = await call(imgQuery(DOMUS_KEY), { path: 'lookup/img', fetch, cache });
  assert.equal(r.status, 200); assert.equal(fetch.calls.length, 1);
  // a tester never reuses (or learns about) the owner's picture: their own fetch, no x-lookup-cache
  fetch = mockFetch([[UPLOAD, () => img(png)]]);
  r = await call(imgQuery(DOMUS_KEY), { path: 'lookup/img', fetch, cache, key: 't:abc' });
  assert.equal(r.status, 200); assert.equal(fetch.calls.length, 1); assert.equal(r.headers.get('x-lookup-cache'), null);
  fetch = mockFetch();
  r = await call(imgQuery(DOMUS_KEY), { path: 'lookup/img', fetch, cache, key: 't:abc' });
  assert.equal(r.status, 200); assert.equal(fetch.calls.length, 0, 'their own repeat is served from their own entry'); assert.equal(r.headers.get('x-lookup-cache'), null);
  // a cached original that is too wide (an entry from before the width check) is not served from the cache
  const wideKey = await imageCacheKey(ORIGIN, 'a/ab/Wide.png', 'owner');
  cache.store.set(wideKey, new Response(PNG(64, 4000, 100), { headers: { 'content-type': 'image/png' } }));
  fetch = mockFetch([[UPLOAD, () => img(PNG(64, 4000, 100))]]);
  r = await call(imgQuery('a/ab/Wide.png'), { path: 'lookup/img', fetch, cache });
  assert.equal(r.status, 502); assert.equal(fetch.calls.length, 1);
});
test('image proxy: an untouched original is served only up to 500 px wide (read from its header) and 512 KB', async () => {
  const run = async (key, res) => {
    const cache = fakeCache();
    const fetch = mockFetch([[UPLOAD, res]]);
    const r = await call(imgQuery(key), { path: 'lookup/img', fetch, cache, key: 't:abc' });
    return { ...r, cache };
  };
  // within the bound, in every format
  for (const [bytes, type] of [[PNG(64, 500, 300), 'image/png'], [JPEG(64, 320, 200), 'image/jpeg'], [GIF(64, 88, 31), 'image/gif'], [WEBP(64, 480, 480), 'image/webp']]) {
    const r = await run('a/ab/Small.png', () => img(bytes, type));
    assert.equal(r.status, 200, type); assert.equal(r.headers.get('content-type'), type); assert.equal(r.cache.puts.length, 1);
  }
  // too wide, unreadable, or too big: a 502 that is never cached
  const huge = JPEG(1_400_000, 4000, 3000);
  for (const [name, res] of [
    ['a 4000 px panorama', () => img(huge, 'image/jpeg', { 'content-length': String(huge.length) })],
    ['a 501 px PNG', () => img(PNG(64, 501, 10))],
    ['a 600 px GIF', () => img(GIF(64, 600, 10))],
    ['a 1000 px WebP', () => img(WEBP(64, 1000, 10))],
    ['no readable size', () => img(bytesOf([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, ...ascii('JFIF')], 64), 'image/jpeg')],
    ['over 512 KB though narrow', () => img(PNG(IMAGE.maxOriginalBytes + 1, 200, 100))],
  ]) {
    const r = await run('a/ab/Huge_panorama.jpg', res);
    assert.equal(r.status, 502, name); assert.equal(r.body.code, 'lookup_unavailable', name); assert.equal(r.cache.puts.length, 0, name);
  }
  // a thumbnail's width is already fixed by its key: it is never re-checked against 500 px
  const thumb = await run(DOMUS_KEY, () => img(PNG(64, 4000, 100)));
  assert.equal(thumb.status, 200);
});
test('imageSize: pixel size from PNG, JPEG, GIF and WebP (VP8, VP8L, VP8X) headers', () => {
  assert.deepEqual(imageSize(PNG(64, 330, 229)), { width: 330, height: 229 });
  assert.deepEqual(imageSize(JPEG(64, 4000, 3000)), { width: 4000, height: 3000 });
  assert.deepEqual(imageSize(GIF(64, 88, 31)), { width: 88, height: 31 });
  assert.deepEqual(imageSize(WEBP(64, 480, 270)), { width: 480, height: 270 });
  // VP8L: signature 0x2f, then 14 bits width-1 and 14 bits height-1
  const w = 777 - 1, h = 333 - 1, bits = w | (h << 14);
  const vp8l = bytesOf([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBPVP8L'), 0, 0, 0, 0, 0x2f, bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >>> 24) & 255]);
  assert.deepEqual(imageSize(vp8l), { width: 777, height: 333 });
  const vp8x = bytesOf([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBPVP8X'), 10, 0, 0, 0, 0, 0, 0, 0, ...le24(1920 - 1), ...le24(1080 - 1)]);
  assert.deepEqual(imageSize(vp8x), { width: 1920, height: 1080 });
  // a JPEG whose frame comes after a long EXIF segment and fill bytes
  const exif = bytesOf([0xff, 0xd8, 0xff, 0xe1, ...be16(2 + 300), ...new Array(300).fill(0), 0xff, 0xff, 0xc2, 0, 0x11, 8, ...be16(240), ...be16(320), 3], 400);
  assert.deepEqual(imageSize(exif), { width: 320, height: 240 });
  for (const bad of [SVG, PNG().slice(0, 16), bytesOf([0xff, 0xd8, 0xff, 0xd9]), 'x', null]) assert.equal(imageSize(bad), null);
});

// ── 19. logging ──
test('logs never carry the selected words, titles, image keys or who asked', async () => {
  const lines = [];
  const saved = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) { saved[level] = console[level]; console[level] = (...a) => lines.push(a.map(String).join(' ')); }
  const TERM = 'Zanzibar Quokka Festival', TITLE = 'Quokka Title Secret', KEY = 'thumb/0/03/Quokka_secret.png/330px-Quokka_secret.png';
  try {
    Object.assign(LOOKUP_TIMING, { summaryMs: 20, searchMs: 20, deadlineMs: 100, imageMs: 20 });
    const runs = [
      [{ q: TERM }, () => wiki(503, `error about ${TERM}`)],
      [{ q: TERM }, () => { throw new TypeError(`fetch failed https://en.wikipedia.org/api/rest_v1/page/summary/${titlePath(TERM)}`); }],
      [{ q: TERM }, () => wiki(200, 'not json')],
      [{ title: TITLE }, () => wiki(500, TITLE)],
      [{ q: TERM }, hang],
      [{ q: TERM }, () => wiki(429, {})],
    ];
    for (const [q, h] of runs) { resetLookupState(); await call(q, { key: 't:sub-secret', fetch: mockFetch([[/./, h]]) }); }
    for (const h of [() => new Response('x', { status: 500 }), () => { throw new Error(`boom ${KEY}`); }, () => img(SVG, 'image/png'), hang, () => new Response('', { status: 429 })]) {
      resetLookupState();
      await call(imgQuery(KEY), { path: 'lookup/img', key: 't:sub-secret', fetch: mockFetch([[/./, h]]) });
    }
    await call({ q: TERM }, { key: 't:sub-secret', env: { get LOOKUP_LIMIT() { throw new Error(`boom ${TERM}`); } } });
  } finally { for (const [level, fn] of Object.entries(saved)) console[level] = fn; }
  assert.ok(lines.length >= 8, `expected warnings, got ${lines.length}`);
  for (const line of lines) {
    for (const secret of ['Zanzibar', 'Quokka', 'sub-secret', titlePath(TERM), 'wikipedia.org/api']) assert.ok(!line.includes(secret), `${secret} leaked: ${line}`);
  }
});
