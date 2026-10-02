// Look up on the client (public/lookup.js): selection clean-up and parity with the server, trigger tiers, the device
// language, placement geometry, payload re-validation, the page-wide client (LRU, in-flight sharing, error mapping, the
// /api/lookup/img blob path), the DOM-free controller on a fake clock, text-only rendering on a fake document, and the
// DOM adapter wired end to end on a fake page. No DOM library, no network.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  LOOKUP_TIMING, LOOKUP_GEOMETRY, LOOKUP_MODES, KINDS, LICENSE, WIKIS, ELIGIBLE, EXCLUDE, COPY, ERRORS,
  cleanTerm, classify, wikiLang, askPrompt, lineRects, place, pickWidth, safeImageUrl, sniffImage, cardModel, eligibleRoot,
  createLookupClient, createController, renderCard, announcement, initLookup,
} from '../public/lookup.js';
import * as server from '../src/lookup.js';

const SRC = await readFile(new URL('../public/lookup.js', import.meta.url), 'utf8');
const TIMING0 = { ...LOOKUP_TIMING };
afterEach(() => { Object.assign(LOOKUP_TIMING, TIMING0); });
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const ZWSP = String.fromCharCode(0x200b), SHY = String.fromCharCode(0xad), LS = String.fromCharCode(0x2028);

// ── fixtures shaped like src/lookup.js answers (the image built by the server's own imageFrom) ──
const DOMUS_THUMB = 'https://thumb.wikimedia.org/wikipedia/commons/thumb/0/03/Domus_Aurea_pianta_generale.png/330px-Domus_Aurea_pianta_generale.png?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail';
const DOMUS_IMAGE = server.imageFrom(DOMUS_THUMB, { width: 330, height: 229, origWidth: 2601 });
const ARTICLE = Object.freeze({
  v: 1, found: true, kind: 'article', via: 'inner', lang: 'en', dir: 'ltr', query: 'Nero’s Golden House (Domus Aurea)', title: 'Domus Aurea',
  description: 'Roman palace', extract: 'The Domus Aurea was a vast landscaped palace built by the Emperor Nero in the heart of ancient Rome.', trimmed: true,
  url: 'https://en.wikipedia.org/wiki/Domus_Aurea', image: DOMUS_IMAGE, others: [], license: LICENSE,
});
const SEARCHED = Object.freeze({ ...ARTICLE, via: 'search', query: 'Nero’s Golden House', others: [{ title: 'Palace Tomb', description: 'Fixture alternative' }, { title: 'Nero', description: 'Roman emperor' }] });
const CHOICES = Object.freeze({
  v: 1, found: true, kind: 'choices', lang: 'en', dir: 'ltr', query: 'Mercury', title: 'Mercury', url: 'https://en.wikipedia.org/wiki/Mercury',
  choices: [{ title: 'Mercury (planet)', description: 'Smallest planet, nearest the Sun' }, { title: 'Mercury (element)', description: 'Chemical element with symbol Hg' }, { title: 'Freddie Mercury', description: 'British singer (1946–1991)' }],
  license: LICENSE,
});
const NONE = Object.freeze({ v: 1, found: false, lang: 'en', query: 'zzz nothing', search: 'https://en.wikipedia.org/w/index.php?search=zzz%20nothing&ns0=1', others: [{ title: 'Sleep', description: 'Fixture alternative' }] });
const XSS = '<img src=x onerror=alert(1)>';
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 4]);

// ── the selection clean-up: one table, the same answers from the client and the server ──
const CLEAN = [
  ['“Nero’s Golden House (Domus Aurea)”,', 'Nero’s Golden House (Domus Aurea)'],
  ["Nero's Golden House (Domus Aurea)", "Nero's Golden House (Domus Aurea)"],
  ['(Domus Aurea)', 'Domus Aurea'], ['**Mercury**', 'Mercury'], ['Rome[12].', 'Rome'], ['Rome[citation needed]', 'Rome'], ['- Nero', 'Nero'], ['• Mercury', 'Mercury'],
  ['«Roma»', 'Roma'], ['„Berlin“', 'Berlin'], ['Domus Aurea)', 'Domus Aurea'], ['(Domus Aurea', 'Domus Aurea'], ["Achilles'", 'Achilles'], ['Paris;', 'Paris'],
  [`Nero${ZWSP} Golden${SHY}House`, 'Nero GoldenHouse'], [`line\none${LS}two`, 'line one two'], ['  spaced\t\tout  ', 'spaced out'],
  ['AC/DC', 'AC/DC'], ['C++', 'C++'], ["Achilles' heel", "Achilles' heel"], ['Café', 'Café'], ['Cafe' + String.fromCharCode(0x301), 'Café'],
  ['Star Wars: Episode IV', 'Star Wars: Episode IV'], ['(a) and (b)', '(a) and (b)'], ['the 1990s', 'the 1990s'],
  ['', null], ['a', null], ['42', null], ['…', null], ['https://x.y', null], ['www.x.com', null], ['a@b.co', null], ['555-123-4567', null],
  ['0123456789', null], ['a = b;', null], ['foo()', null], ['${x}', null], ['.', null], ['..', null], ['./x', null], ['a/../b', null],
  ['x'.repeat(121), null], [Array(13).fill('word').join(' '), null], ['[citation needed]', null], ['`Mercury`', null], ['C#', 'C sharp'], ['F# major', 'F sharp major'], ['#1', null], [null, null], [42, null],
];
test('cleanTerm: the spec table', () => {
  for (const [raw, want] of CLEAN) assert.equal(cleanTerm(raw), want, JSON.stringify(raw));
  assert.equal(cleanTerm('x'.repeat(120)), 'x'.repeat(120));
  assert.equal(cleanTerm(Array(12).fill('word').join(' ')), Array(12).fill('word').join(' '));
});
test('cleanTerm parity: the client copy is the server function, character for character', () => {
  assert.equal(cleanTerm.toString(), server.cleanTerm.toString(), 'public/lookup.js cleanTerm must be copied verbatim from src/lookup.js');
  for (const [raw] of CLEAN) assert.equal(cleanTerm(raw), server.cleanTerm(raw), JSON.stringify(raw));
  assert.deepEqual([...WIKIS], [...server.WIKIS], 'the device-language list matches the server');
  assert.deepEqual(LICENSE, server.LICENSE);
});

test('the module loads without a DOM and touches nothing global on import', async () => {
  const traps = ['document', 'window', 'CSS', 'matchMedia', 'localStorage', 'sessionStorage', 'indexedDB'];
  const saved = traps.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  const navSaved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    for (const k of traps) Object.defineProperty(globalThis, k, { configurable: true, get() { throw new Error(`${k} read at import`); } });
    if (!navSaved || navSaved.configurable) Object.defineProperty(globalThis, 'navigator', { configurable: true, get() { throw new Error('navigator read at import'); } });
    const fresh = await import(`../public/lookup.js?fresh=${Date.now()}`);
    assert.equal(typeof fresh.initLookup, 'function');
  } finally {
    for (const [k, d] of saved) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
    if (navSaved) Object.defineProperty(globalThis, 'navigator', navSaved); else delete globalThis.navigator;
  }
});

test('source scan: text-only DOM, no storage, no imports, one API, contextmenu never cancelled', () => {
  for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'data-act', 'localStorage', 'sessionStorage', 'indexedDB', 'eval(', 'new Function']) assert.ok(!SRC.includes(bad), bad);
  assert.doesNotMatch(SRC, /^\s*import\s/m, 'no imports: app.js passes everything in');
  const apiPaths = [...SRC.matchAll(/['"`](\/api\/[^'"`?]*)/g)].map((m) => m[1]);
  assert.ok(apiPaths.length >= 1);
  for (const p of apiPaths) assert.ok(p === '/api/lookup' || p.startsWith('/api/lookup'), `only /api/lookup: ${p}`);
  assert.ok(SRC.includes("'/api/lookup?'"), 'the summary URL is built from the /api/lookup literal');
  for (const m of SRC.matchAll(/\bfetch\(/g)) {
    const call = SRC.slice(m.index, SRC.indexOf(')', m.index) + 1);
    assert.doesNotMatch(call, /wikipedia\.org|wikimedia\.org/, call);
  }
  const at = SRC.indexOf("on(doc, 'contextmenu'");
  const lineStart = SRC.lastIndexOf('\n', at), above = SRC.slice(SRC.lastIndexOf('\n', lineStart - 1) + 1, lineStart);
  assert.ok(at > 0 && above.trim().startsWith('// contextmenu: never preventDefault'), 'marker comment sits on the line above');
  const handler = SRC.slice(at, SRC.indexOf('});', at));
  assert.ok(!handler.includes('preventDefault'), 'the contextmenu handler never cancels Chrome’s selection menu');
  assert.ok(!/https:\/\/(thumb|upload)\.wikimedia\.org/.test(SRC.slice(SRC.indexOf('export function safeImageUrl'), SRC.indexOf('export function sniffImage'))), 'safeImageUrl names no Wikimedia host');
});

test('classify: the trigger tiers', () => {
  assert.equal(classify('Domus Aurea'), 'auto');
  assert.equal(classify('Nero’s Golden House (Domus Aurea)'), 'auto'); // 5 words, 33 characters
  assert.equal(classify('one two three four five six'), 'auto');
  assert.equal(classify('one two three four five six seven eight'), 'tap');
  assert.equal(classify('x'.repeat(81)), 'tap');
  assert.equal(classify(Array(13).fill('w').join(' ')), 'none');
  assert.equal(classify('x'.repeat(121)), 'none');
  assert.equal(classify(null), 'none');
  assert.equal(classify(''), 'none');
});

test('wikiLang: the device language, with one English fallback', () => {
  assert.deepEqual(wikiLang(['en-US']), { lang: 'en' });
  assert.deepEqual(wikiLang(['nb-NO']), { lang: 'no' });
  assert.deepEqual(wikiLang(['yue-HK']), { lang: 'zh-yue' });
  assert.deepEqual(wikiLang(['zh-TW']), { lang: 'zh', variant: 'zh-tw' });
  assert.deepEqual(wikiLang(['zh-HK']), { lang: 'zh', variant: 'zh-hk' });
  assert.deepEqual(wikiLang(['zh-Hant']), { lang: 'zh', variant: 'zh-tw' });
  assert.deepEqual(wikiLang(['zh-Hans-CN']), { lang: 'zh', variant: 'zh-cn' });
  assert.deepEqual(wikiLang(['zh']), { lang: 'zh' });
  assert.deepEqual(wikiLang(['sr-Latn']), { lang: 'sr', variant: 'sr-el' });
  assert.deepEqual(wikiLang(['de-DE', 'en']), { lang: 'de' });
  assert.deepEqual(wikiLang(['xx']), { lang: 'en' });
  assert.deepEqual(wikiLang([]), { lang: 'en' });
  assert.deepEqual(wikiLang(undefined), { lang: 'en' });
  for (const tag of ['en-US', 'nb', 'yue', 'zh-TW', 'sr-Latn', 'de', 'he', 'xx']) {
    const { lang, variant } = wikiLang([tag]), site = server.wikiSite(lang, variant);
    assert.equal(site.lang, lang, `${tag}: the server keeps the client's wiki`);
    if (variant) assert.equal(site.acceptLanguage, variant, `${tag}: the server keeps the variant`);
  }
});

test('askPrompt: the selected words, quoted, never a slash command', () => {
  assert.equal(askPrompt('Domus Aurea'), 'Tell me more about “Domus Aurea”.');
  assert.ok(askPrompt('/code rm -rf').startsWith('Tell me more about “'));
  assert.equal(askPrompt('two\n  lines'), 'Tell me more about “two lines”.');
  const long = askPrompt('x'.repeat(400));
  assert.equal(long, `Tell me more about “${'x'.repeat(300)}…”.`);
  for (const t of ['/ask hi', '/img cat', '  /video x']) assert.ok(!askPrompt(t).startsWith('/'));
});

test('lineRects: drops empty rects; first is the top line, last the bottom line', () => {
  const r = (top, bottom, left = 0, width = 50) => ({ top, bottom, left, right: left + width, width, height: bottom - top });
  assert.equal(lineRects([]), null);
  assert.equal(lineRects([r(10, 10), { ...r(5, 20), width: 0 }]), null);
  const a = r(100, 120), b = r(120, 140), c = r(140, 160), zero = { ...r(0, 300), width: 0.5 };
  const out = lineRects([b, zero, c, a]);
  assert.equal(out.first, a); assert.equal(out.last, c);
  const twin = r(140, 160, 60);
  assert.equal(lineRects([a, c, twin]).last, twin, 'ties keep document order: the later rect ends the selection');
});

// ── placement ──
const PHONE = { left: 16, right: 344, top: 106, bottom: 562 };
const line = (top, bottom = top + 20, left = 40, width = 120) => ({ top, bottom, left, right: left + width, width, height: bottom - top });
test('place: phone 360×740 on touch — below the handles, above Chrome’s bar, the roomier side, or docked', () => {
  const G = LOOKUP_GEOMETRY, w = 328, h = 226;
  const below = place({ first: line(180), last: line(180, 200), w, h, band: PHONE, touch: true, phone: true });
  assert.deepEqual(below, { x: 16, y: 232, side: 'below', maxH: 330 });
  assert.equal(below.y, 200 + G.handleClear);
  const above = place({ first: line(520), last: line(530, 550), w, h, band: PHONE, touch: true, phone: true });
  assert.equal(above.side, 'above'); assert.ok(above.y + h <= 520 - G.nativeBar); assert.equal(above.y + h, 448);
  const best = place({ first: line(320), last: line(330, 350), w, h, band: PHONE, touch: true, phone: true });
  assert.equal(best.side, 'below'); assert.ok(best.maxH >= G.minRoom); assert.ok(best.y >= PHONE.top && best.y + Math.min(h, best.maxH) <= PHONE.bottom);
  const dock = place({ first: line(120), last: line(520, 540), w, h, band: PHONE, touch: true, phone: true });
  assert.equal(dock.side, 'dock'); assert.equal(dock.y + h, PHONE.bottom);
  const forced = place({ w, h, band: PHONE, touch: true, phone: true, dock: true });
  assert.deepEqual(forced, { x: 16, y: PHONE.bottom - h, side: 'dock', maxH: PHONE.bottom - PHONE.top });
});
test('place: desktop mouse — above the line, centred on it, clamped to the band and the sidebar', () => {
  const band = { left: 16, right: 1264, top: 84, bottom: 622 }, w = 360, h = 200;
  const p = place({ first: line(400, 420, 600, 100), last: line(400, 420, 600, 100), w, h, band });
  assert.equal(p.side, 'above'); assert.equal(p.y + h, 400 - 8); assert.equal(p.x, 650 - 180);
  assert.equal(place({ first: line(400, 420, 0, 20), last: line(400, 420, 0, 20), w, h, band }).x, band.left);
  assert.equal(place({ first: line(400, 420, 1250, 10), last: line(400, 420, 1250, 10), w, h, band }).x, band.right - w);
  const low = place({ first: line(150, 170, 600, 100), last: line(150, 170, 600, 100), w, h, band });
  assert.equal(low.side, 'below'); assert.equal(low.y, 170 + 8);
  const sidebar = { ...band, left: 240 };
  assert.equal(place({ first: line(400, 420, 100, 40), last: line(400, 420, 100, 40), w, h, band: sidebar }).x, 240);
  const multi = place({ first: line(150, 170, 600, 100), last: line(190, 210, 100, 50), w, h, band });
  assert.equal(multi.side, 'below'); assert.equal(multi.x, 125 - 180 < band.left ? band.left : 125 - 180, 'below centres on the last line');
});
test('place: a chosen side is kept while it has minRoom, even when the other side now fits', () => {
  const w = 328, h = 150, first = line(330), last = line(320, 340);
  assert.equal(place({ first, last, w, h, band: PHONE, touch: true, phone: true }).side, 'below');
  const kept = place({ first, last, w, h, band: PHONE, touch: true, phone: true, prefer: 'above' });
  assert.equal(kept.side, 'above'); assert.equal(kept.maxH, 330 - 72 - 106); assert.equal(kept.y + Math.min(h, kept.maxH), 330 - 72);
  const tight = place({ first: line(250), last: line(250, 270), w, h, band: PHONE, touch: true, phone: true, prefer: 'above' });
  assert.equal(tight.side, 'below', 'under minRoom the preference gives way');
});
test('place: 1000 random selections never cover the selection, its handles or Chrome’s bar, and stay in the band', () => {
  let seed = 7;
  const rand = (lo, hi) => { seed = (seed * 1103515245 + 12345) % 2147483648; return lo + (seed % (hi - lo + 1)); };
  const overlaps = (a1, a2, b1, b2) => a1 < b2 && b1 < a2;
  for (let i = 0; i < 1000; i++) {
    const phone = rand(0, 1) === 1, touch = rand(0, 1) === 1;
    const band = phone ? { left: 16, right: rand(304, 414), top: rand(60, 140), bottom: rand(420, 860) } : { left: rand(16, 260), right: rand(900, 1400), top: rand(60, 100), bottom: rand(500, 900) };
    const w = Math.min(phone ? band.right - band.left : 360, band.right - band.left), h = rand(40, 420);
    const t1 = rand(-200, 1000), lines = rand(1, 6), lh = rand(16, 28);
    const first = line(t1, t1 + lh, rand(band.left, band.right - 20), rand(5, 200));
    const last = line(t1 + (lines - 1) * lh, t1 + lines * lh, rand(band.left, band.right - 20), rand(5, 200));
    const prefer = [null, 'above', 'below', 'dock'][rand(0, 3)];
    const p = place({ first, last, w, h, band, touch, phone, prefer });
    const bottom = p.y + Math.min(h, p.maxH);
    assert.ok(p.maxH >= 0, `maxH ≥ 0 (${i})`);
    assert.ok(p.y >= band.top && bottom <= band.bottom, `inside the band (${i}) ${JSON.stringify({ p, band, h })}`);
    assert.ok(p.x >= band.left && p.x + w <= band.right, `x inside the band (${i})`);
    if (touch && p.side !== 'dock') {
      assert.ok(!overlaps(p.y, bottom, first.top - LOOKUP_GEOMETRY.nativeBar, first.top), `clear of Chrome’s bar (${i})`);
      assert.ok(!overlaps(p.y, bottom, last.top, last.bottom + LOOKUP_GEOMETRY.handleClear), `clear of the handles (${i})`);
    }
  }
});

test('pickWidth: the smallest width covering the box at up to 2×, else the largest', () => {
  const set = [[250, 'a'], [330, 'b'], [500, 'c'], [960, 'd']];
  assert.equal(pickWidth(set, 84, 3), 'a', '84 × min(3, 2) = 168 → 250');
  assert.equal(pickWidth(set, 84, 1), 'a');
  assert.equal(pickWidth(set, 200, 2), 'c', '400 → 500');
  assert.equal(pickWidth(set, 300, 2), 'd', '600 → 960');
  assert.equal(pickWidth(set, 2000, 2), 'd');
  assert.equal(pickWidth(set, 100, 0.5), 'a', 'dpr below 1 counts as 1');
  assert.equal(pickWidth([], 84, 2), null);
  assert.equal(pickWidth(null, 84, 2), null);
});

test('safeImageUrl: only Atelier’s image proxy and the fixture icons — never a Wikimedia host (privacy)', () => {
  for (const [, u] of DOMUS_IMAGE.srcset) assert.equal(safeImageUrl(u), u);
  assert.equal(safeImageUrl('/icons/atelier-v2-512.png'), '/icons/atelier-v2-512.png');
  for (const bad of [
    'https://thumb.wikimedia.org/wikipedia/commons/thumb/0/03/X.png/330px-X.png', 'https://upload.wikimedia.org/wikipedia/commons/0/03/X.png',
    '//evil.example/x.png', 'http://upload.wikimedia.org/x.png', 'javascript:alert(1)', 'data:image/png;base64,AAAA', 'blob:https://x/1',
    '/api/lookup', '/api/lookup/img', '/api/lookup/img?k=', '/api/lookup/img?k=a#b', '/api/lookup/img?k=<x>', '/api/lookup/img?k=a&u=https://evil',
    '/api/lookup/img?k=a b', '/api/lookup/imgx?k=a', '/api/lookup/img/../x?k=a', '/icons/../x.png', '/icons/x.svg', 'https://thumb.wikimedia.org.evil.com/x.png', '', null, 42,
  ]) assert.equal(safeImageUrl(bad), null, String(bad));
});

test('sniffImage: raster bytes only, the same answers as the server', () => {
  const pad = (a) => Uint8Array.from([...a, ...Array(16).fill(0)]);
  const cases = [
    [PNG, 'image/png'], [pad([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg'], [pad([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]), 'image/gif'],
    [pad([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]), 'image/webp'],
    [new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), null], [new TextEncoder().encode('<!doctype html><script>x</script>'), null],
    [Uint8Array.from([0x89, 0x50]), null], [null, null],
  ];
  for (const [b, want] of cases) { assert.equal(sniffImage(b), want); if (b) assert.equal(server.sniffImage(b), want); }
});

// ── payload validation ──
test('cardModel: the server’s article, choices and none answers pass', () => {
  const a = cardModel(ARTICLE);
  assert.equal(a.kind, 'article'); assert.equal(a.title, 'Domus Aurea'); assert.equal(a.via, 'inner'); assert.equal(a.trimmed, true);
  assert.equal(a.url, ARTICLE.url); assert.equal(a.license, LICENSE);
  assert.deepEqual(a.image.srcset.map(([w]) => w), [250, 330, 500]); assert.equal(a.image.mat, true); assert.equal(a.image.page, DOMUS_IMAGE.page);
  const c = cardModel(CHOICES);
  assert.equal(c.kind, 'choices'); assert.equal(c.choices.length, 3); assert.equal(c.choices[2].title, 'Freddie Mercury'); assert.equal(c.image, null);
  const n = cardModel(NONE);
  assert.equal(n.kind, 'none'); assert.equal(n.search, NONE.search); assert.deepEqual(n.others, [{ title: 'Sleep', description: 'Fixture alternative' }]);
  assert.equal(cardModel({ ...ARTICLE, image: null }).image, null);
  const fixture = cardModel({ ...ARTICLE, image: { src: '/icons/atelier-v2-512.png', width: 512, height: 512, srcset: [[512, '/icons/atelier-v2-512.png']], file: 'Fixture.png', page: 'https://commons.wikimedia.org/wiki/File:Fixture.png', mat: true } });
  assert.equal(fixture.image.src, '/icons/atelier-v2-512.png');
});
test('cardModel: markup stays literal text; bad links and images are dropped; caps hold; unknown shapes are refused', () => {
  const x = cardModel({ ...ARTICLE, title: XSS, description: XSS, extract: XSS });
  assert.equal(x.title, XSS); assert.equal(x.description, XSS); assert.equal(x.extract, XSS);
  for (const url of ['javascript:alert(1)', 'https://evil.example/wiki/X', '//en.wikipedia.org/wiki/X', 'http://en.wikipedia.org/wiki/X', 'https://en.wikipedia.org/wiki/X"onmouseover=1', 'https://en.wikipedia.org.evil.com/wiki/X']) {
    assert.equal(cardModel({ ...ARTICLE, url }).url, null, url);
  }
  assert.equal(cardModel({ ...NONE, search: 'https://evil.example/?search=x' }).search, null);
  const img = (patch) => cardModel({ ...ARTICLE, image: { ...DOMUS_IMAGE, ...patch } }).image;
  assert.equal(img({ page: 'https://evil.example/wiki/File:X.png' }), null);
  assert.equal(img({ page: 'javascript:alert(1)' }), null);
  assert.equal(img({ src: DOMUS_THUMB }), null, 'a direct Wikimedia URL is never loaded');
  assert.equal(img({ srcset: [[330, DOMUS_THUMB]] }), null);
  for (const w of [0, -5, 1.5, 99999, '330', null]) assert.equal(img({ srcset: [[w, DOMUS_IMAGE.src]] }), null, `width ${w}`);
  assert.equal(img({ width: 0 }), null); assert.equal(img({ height: 20000 }), null);
  assert.equal(img({ mat: 'yes' }).mat, false);
  const long = cardModel({ ...ARTICLE, title: 'T'.repeat(300), description: 'D'.repeat(300), extract: 'E'.repeat(900), query: 'Q'.repeat(300) });
  assert.equal(long.title.length, 200); assert.equal(long.description.length, 120); assert.equal(long.extract.length, 600); assert.equal(long.query.length, 120);
  const many = cardModel({ ...CHOICES, choices: Array.from({ length: 9 }, (_, i) => ({ title: `T${i}`, description: '' })), others: Array.from({ length: 5 }, (_, i) => ({ title: `O${i}` })) });
  assert.equal(many.choices.length, 4); assert.equal(many.others.length, 2);
  assert.equal(cardModel({ ...ARTICLE, title: `a${String.fromCharCode(7)}b` }).title, 'a b');
  for (const bad of [null, 'x', { ...ARTICLE, v: 2 }, { ...ARTICLE, kind: 'evil' }, { ...ARTICLE, found: 'yes' }, { ...ARTICLE, title: '' }, { ...CHOICES, choices: [] }]) assert.equal(cardModel(bad), null);
  assert.equal(cardModel({ ...ARTICLE, dir: 'evil' }).dir, 'ltr'); assert.equal(cardModel({ ...ARTICLE, dir: 'rtl' }).dir, 'rtl');
  assert.equal(cardModel({ ...ARTICLE, lang: 'EN"' }).lang, 'en'); assert.equal(cardModel({ ...ARTICLE, via: 'evil' }).via, 'title');
  assert.equal(cardModel({ ...ARTICLE, trimmed: 'true' }).trimmed, false);
});
test('cardModel + renderCard: a name shown in its display form ("iPhone") is looked up by its real title (ref)', () => {
  const model = cardModel({ ...SEARCHED, others: [{ title: 'iPhone', description: 'Smartphone', ref: 'IPhone' }, { title: 'Nero', description: 'Roman emperor', ref: 'Nero' }] });
  assert.deepEqual(model.others, [{ title: 'iPhone', description: 'Smartphone', ref: 'IPhone' }, { title: 'Nero', description: 'Roman emperor' }], 'a ref equal to the title is dropped');
  const zh = cardModel({ ...CHOICES, choices: [{ title: '罗马帝国', description: '', ref: '羅馬帝國' }, { title: 'X', ref: 42 }] });
  assert.deepEqual(zh.choices, [{ title: '罗马帝国', description: '', ref: '羅馬帝國' }, { title: 'X', description: '' }], 'a ref that isn’t text is ignored');
  assert.equal(cardModel({ ...NONE, others: [{ title: 'T', ref: `R${'x'.repeat(400)}` }] }).others[0].ref.length, 255);
  // the button says what Wikipedia shows; the request asks for the real page
  const a = rendered({ state: 'article', model });
  const alt = a.els.find((e) => e.dataset.lk === 'alt');
  assert.equal(alt.dataset.title, 'IPhone'); assert.equal(texts(alt).join(''), 'iPhone');
  assert.equal(a.els.filter((e) => e.dataset.lk === 'alt')[1].dataset.title, 'Nero');
  const c = rendered({ state: 'choices', model: zh });
  const pick = c.els.find((e) => e.dataset.lk === 'pick');
  assert.equal(pick.dataset.title, '羅馬帝國'); assert.ok(texts(pick).join('').includes('罗马帝国'));
  // and the server's own answer shape round-trips
  const fromServer = { ...SEARCHED, others: [{ title: 'iPhone', description: 'Line of smartphones', ref: 'IPhone' }] };
  assert.equal(cardModel(JSON.parse(JSON.stringify(fromServer))).others[0].ref, 'IPhone');
});

// ── a tiny fake DOM: enough selector matching for the module's own queries ──
class FakeText {
  constructor(t) { this.nodeType = 3; this.data = String(t); this.parentNode = null; }
  get textContent() { return this.data; }
  get parentElement() { return this.parentNode instanceof FakeEl ? this.parentNode : null; }
  get isConnected() { return Boolean(this.parentNode?.isConnected); }
}
const camel = (k) => k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
function attrOf(el, k) { return k.startsWith('data-') ? el.dataset[camel(k.slice(5))] ?? null : el.getAttribute(k); }
function matchOne(el, part) {
  if (el.sels?.has(part)) return true;
  if (/\s|>/.test(part)) return false;
  let rest = part;
  const nd = rest.endsWith(':not(:disabled)');
  if (nd) { rest = rest.slice(0, -':not(:disabled)'.length); if (el.disabled) return false; }
  rest = rest.replace(/:not\(\[[^\]]*\]\)$/, (m) => { const [, k, v] = m.match(/\[([\w-]+)="?([^"\]]*)"?\]/); if (attrOf(el, k) === v) rest = '\u0000'; return ''; });
  if (rest === '\u0000') return false;
  const tag = rest.match(/^[a-z][a-z0-9]*/i)?.[0];
  if (tag && el.localName !== tag.toLowerCase()) return false;
  for (const t of rest.slice(tag?.length || 0).match(/#[\w-]+|\.[\w-]+|\[[^\]]+\]/g) || []) {
    if (t[0] === '#') { if (el.getAttribute('id') !== t.slice(1)) return false; }
    else if (t[0] === '.') { if (!el.classList.contains(t.slice(1))) return false; }
    else {
      const [, k, v] = t.match(/^\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]$/);
      const val = attrOf(el, k);
      if (val == null || (v !== undefined && val !== v)) return false;
    }
  }
  return true;
}
const matches = (el, sel) => sel.split(',').some((p) => matchOne(el, p.trim()));
class FakeEl {
  constructor(doc, tag, ns = null) {
    Object.assign(this, { ownerDocument: doc, localName: tag.toLowerCase(), namespaceURI: ns, nodeType: 1, parentNode: null, children: [], dataset: {}, attrs: new Map(), listeners: {}, hidden: false, disabled: false });
    const set = new Set();
    this.classList = { add: (...c) => c.forEach((x) => set.add(x)), remove: (...c) => c.forEach((x) => set.delete(x)), contains: (c) => set.has(c),
      toggle: (c, on) => { const v = on === undefined ? !set.has(c) : Boolean(on); if (v) set.add(c); else set.delete(c); return v; }, get size() { return set.size; }, values: () => [...set] };
    this.style = { props: {}, setProperty(k, v) { this.props[k] = v; } };
    Object.assign(this, { offsetWidth: 328, offsetHeight: 226, clientWidth: 328, clientHeight: 226, scrollHeight: 226 });
  }
  get id() { return this.getAttribute('id') || ''; } set id(v) { this.setAttribute('id', v); }
  get className() { return this.classList.values().join(' '); } set className(v) { for (const c of String(v).split(' ')) if (c) this.classList.add(c); }
  get parentElement() { return this.parentNode instanceof FakeEl ? this.parentNode : null; }
  get isConnected() { let x = this; while (x.parentNode) x = x.parentNode; return x === this.ownerDocument; }
  set innerHTML(v) { throw new Error('innerHTML was used'); }
  set outerHTML(v) { throw new Error('outerHTML was used'); }
  insertAdjacentHTML() { throw new Error('insertAdjacentHTML was used'); }
  setAttribute(k, v) { if (k === 'data-act') throw new Error('data-act was set'); this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : k === 'src' && this.src ? this.src : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); }
  append(...kids) { for (const k of kids) { const n = typeof k === 'string' ? new FakeText(k) : k; n.parentNode?.children && n.remove?.(); n.parentNode = this; this.children.push(n); } }
  replaceChildren(...kids) { for (const c of this.children) c.parentNode = null; this.children = []; this.append(...kids); }
  remove() { if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter((c) => c !== this); this.parentNode = null; } }
  get textContent() { return this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.replaceChildren(String(v)); }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  closest(sel) { for (let x = this; x instanceof FakeEl; x = x.parentNode) if (matches(x, sel)) return x; return null; }
  matches(sel) { return matches(this, sel); }
  querySelectorAll(sel) { const out = []; const walk = (n) => { for (const c of n.children) if (c instanceof FakeEl) { if (matches(c, sel)) out.push(c); walk(c); } }; walk(this); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  addEventListener(type, fn, opts) { (this.listeners[type] ||= []).push([fn, opts]); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(([f]) => f !== fn); }
  getClientRects() { for (let x = this; x instanceof FakeEl; x = x.parentNode) if (x.hidden) return []; return [{ width: 10, height: 10 }]; }
  getBoundingClientRect() { return this.rect || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
}
class FakeDoc {
  constructor() {
    this.listeners = {}; this.visibilityState = 'visible'; this.selection = null;
    this.documentElement = new FakeEl(this, 'html'); this.documentElement.parentNode = this;
    this.body = new FakeEl(this, 'body'); this.documentElement.append(this.body);
    this.activeElement = this.body;
  }
  createElement(t) { return new FakeEl(this, t); }
  createElementNS(ns, t) { return new FakeEl(this, t, ns); }
  getElementById(id) { return this.documentElement.querySelector(`#${id}`); }
  querySelector(s) { return this.documentElement.querySelector(s); }
  getSelection() { return this.selection; }
  addEventListener(type, fn, opts) { (this.listeners[type] ||= []).push([fn, opts]); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(([f]) => f !== fn); }
}
const texts = (el) => (el instanceof FakeText ? [el.data] : el.children.flatMap(texts));
const all = (el) => (el instanceof FakeEl ? [el, ...el.children.flatMap(all)] : []);

test('eligibleRoot: finished answer prose and idea text only, both ends in one root, never code or the card', () => {
  const doc = new FakeDoc();
  const entry = (busy = 'false') => { const li = doc.createElement('li'); li.classList.add('entry'); li.setAttribute('aria-busy', busy); li.dataset.id = 'e1'; li.dataset.kind = 'ask'; return li; };
  const prose = (li) => { const p = doc.createElement('div'); p.classList.add('prose'); p.sels = new Set(ELIGIBLE.split(',').map((s) => s.trim())); li.append(p); return p; };
  const text = (parent, t = 'Domus Aurea') => { const n = new FakeText(t); parent.append(n); return n; };
  const li = entry(), root = prose(li), a = text(root), b = text(root, 'Mercury');
  const range = (s, e = s) => ({ startContainer: s, endContainer: e });
  assert.deepEqual(eligibleRoot(range(a, b)), { root, entry: li });
  const busyLi = entry('true'), busyRoot = prose(busyLi); busyRoot.sels = new Set(); // a streaming entry never matches ELIGIBLE
  assert.equal(eligibleRoot(range(text(busyRoot))), null);
  for (const tag of ['pre', 'code']) { const el = doc.createElement(tag); root.append(el); assert.equal(eligibleRoot(range(a, text(el))), null, tag); }
  const think = doc.createElement('div'); think.classList.add('think'); const body = doc.createElement('div'); body.classList.add('think-body'); think.append(body); root.append(think);
  assert.equal(eligibleRoot(range(text(body))), null, 'the reasoning trace');
  const card = doc.createElement('div'); card.classList.add('lookup'); root.append(card);
  assert.equal(eligibleRoot(range(text(card))), null, 'the card itself');
  const li2 = entry(), root2 = prose(li2);
  assert.equal(eligibleRoot(range(a, text(root2))), null, 'two entries');
  assert.deepEqual(eligibleRoot(range(root)), { root, entry: li }, 'an element container works too');
  assert.equal(eligibleRoot(null), null);
  assert.equal(eligibleRoot(range(new FakeText('loose'))), null);
  assert.ok(EXCLUDE.split(',').map((s) => s.trim()).includes('.lookup'));
});

// ── the page-wide client ──
function fakeServer(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const call = { url: String(url), headers: new Headers(init.headers), init, signal: init.signal };
    calls.push(call);
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    for (const [re, fn] of routes) if (re.test(call.url)) return fn(call);
    throw new Error(`unmocked ${call.url}`);
  };
  return { fetch, calls };
}
const hang = (c) => new Promise((_, rej) => c.signal?.addEventListener('abort', () => rej(c.signal.reason ?? new DOMException('Aborted', 'AbortError'))));

test('client: the URL, headers and cache mode; an LRU hit makes no second request', async () => {
  const s = fakeServer([[/^\/api\/lookup\?/, () => json(ARTICLE)]]);
  const c = createLookupClient({ fetch: s.fetch, headers: () => ({ 'x-app-pass': 'pw' }) });
  const req = { q: 'Nero\'s Golden House (Domus Aurea)', lang: 'en' };
  const v = await c.get(req);
  assert.equal(v.state, 'article'); assert.equal(v.model.title, 'Domus Aurea');
  assert.equal(s.calls[0].url, '/api/lookup?q=Nero%27s+Golden+House+%28Domus+Aurea%29&lang=en');
  assert.equal(s.calls[0].headers.get('x-app-pass'), 'pw');
  assert.equal(s.calls[0].init.cache, 'no-store'); assert.equal(s.calls[0].init.credentials, 'same-origin');
  assert.equal(await c.get({ ...req, q: req.q.toUpperCase() }), v, 'the key ignores case for q');
  assert.equal(c.peek(req), v);
  assert.equal(s.calls.length, 1);
  await c.get({ title: 'Domus Aurea', lang: 'zh', variant: 'zh-tw' });
  assert.equal(s.calls[1].url, '/api/lookup?title=Domus+Aurea&lang=zh&v=zh-tw');
});
test('client: articles live 30 minutes, misses 5; errors are never kept', async () => {
  let t = 1_000_000, body = ARTICLE, status = 200;
  const s = fakeServer([[/^\/api\/lookup\?/, () => json(body, status)]]);
  const c = createLookupClient({ fetch: s.fetch, now: () => t });
  await c.get({ q: 'Domus Aurea', lang: 'en' });
  t += 29 * 60e3; await c.get({ q: 'Domus Aurea', lang: 'en' }); assert.equal(s.calls.length, 1);
  t += 2 * 60e3; await c.get({ q: 'Domus Aurea', lang: 'en' }); assert.equal(s.calls.length, 2, 'older than 30 minutes: asked again');
  body = NONE;
  await c.get({ q: 'zzz nothing', lang: 'en' });
  t += 4 * 60e3; await c.get({ q: 'zzz nothing', lang: 'en' }); assert.equal(s.calls.length, 3);
  t += 2 * 60e3; await c.get({ q: 'zzz nothing', lang: 'en' }); assert.equal(s.calls.length, 4, 'a miss older than 5 minutes: asked again');
  body = { error: 'x', code: 'lookup_unavailable' }; status = 502;
  assert.equal((await c.get({ q: 'fail state', lang: 'en' })).code, 'unavailable');
  await c.get({ q: 'fail state', lang: 'en' }); assert.equal(s.calls.length, 6, 'errors are asked again');
  const small = createLookupClient({ fetch: fakeServer([[/./, () => json(ARTICLE)]]).fetch, max: 2 });
  await small.get({ q: 'one', lang: 'en' }); await small.get({ q: 'two', lang: 'en' }); small.peek({ q: 'one', lang: 'en' }); await small.get({ q: 'three', lang: 'en' });
  assert.ok(small.peek({ q: 'one', lang: 'en' }) && !small.peek({ q: 'two', lang: 'en' }), 'least recently used goes first');
});
test('client: one request per key in flight; it is aborted only when every waiter leaves', async () => {
  let release;
  const s = fakeServer([[/^\/api\/lookup\?/, (c) => new Promise((res, rej) => { release = () => res(json(ARTICLE)); c.signal.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError'))); })]]);
  const c = createLookupClient({ fetch: s.fetch });
  const req = { q: 'Domus Aurea', lang: 'en' };
  const a = c.get(req), b = c.get(req);
  await flush();
  assert.equal(s.calls.length, 1);
  release();
  assert.equal(await a, await b);
  const one = new AbortController(), two = new AbortController();
  const p1 = c.get({ q: 'Mercury', lang: 'en' }, one.signal), p2 = c.get({ q: 'Mercury', lang: 'en' }, two.signal);
  await flush();
  const underlying = s.calls.at(-1).signal;
  one.abort();
  await assert.rejects(p1, { name: 'AbortError' });
  assert.equal(underlying.aborted, false, 'the other waiter keeps it alive');
  two.abort();
  await assert.rejects(p2, { name: 'AbortError' });
  assert.equal(underlying.aborted, true);
  await flush();
  assert.equal(c.peek({ q: 'Mercury', lang: 'en' }), undefined, 'nothing stored');
  const pre = new AbortController(); pre.abort();
  await assert.rejects(c.get({ q: 'x y', lang: 'en' }, pre.signal), { name: 'AbortError' });
});
test('client: status mapping (rate, busy, sign-in, off, unavailable, offline, timeout)', async () => {
  const map = async (res, extra = {}) => createLookupClient({ fetch: async () => (typeof res === 'function' ? res() : res), ...extra }).get({ q: 'Domus Aurea', lang: 'en' });
  assert.deepEqual(await map(json({ code: 'lookup_busy', retryAfter: 9 }, 429, { 'retry-after': '7' })), { state: 'error', code: 'busy', retryAfter: 7 });
  assert.deepEqual(await map(json({ code: 'lookup_busy', retryAfter: 9 }, 429)), { state: 'error', code: 'busy', retryAfter: 9 });
  assert.deepEqual(await map(json({ code: 'lookup_rate', retryAfter: 30 }, 429, { 'retry-after': '30' })), { state: 'error', code: 'rate', retryAfter: 30 });
  assert.equal((await map(json({ code: 'lookup_busy' }, 429, { 'retry-after': '900' }))).retryAfter, 120);
  assert.equal((await map(json({}, 429))).retryAfter, 10);
  assert.deepEqual(await map(json({ code: 'tester_signin' }, 401)), { state: 'error', code: 'signin' });
  assert.deepEqual(await map(json({ code: 'owner_only' }, 403)), { state: 'error', code: 'off' });
  assert.deepEqual(await map(json({ code: 'lookup_off' }, 503)), { state: 'error', code: 'off' });
  assert.deepEqual(await map(json({ code: 'other' }, 503)), { state: 'error', code: 'unavailable' });
  assert.deepEqual(await map(json({ code: 'lookup_unavailable' }, 502)), { state: 'error', code: 'unavailable' });
  assert.deepEqual(await map(new Response('<html>oops</html>', { status: 200 })), { state: 'error', code: 'unavailable' });
  assert.deepEqual(await map(json({ v: 2 })), { state: 'error', code: 'unavailable' });
  const q400 = await map(json({ code: 'lookup_query' }, 400));
  assert.equal(q400.state, 'none'); assert.equal(q400.model.kind, 'none'); assert.equal(q400.model.query, 'Domus Aurea');
  assert.deepEqual(await map(() => { throw new TypeError('Failed to fetch'); }, { online: () => false }), { state: 'error', code: 'offline' });
  assert.deepEqual(await map(() => { throw new TypeError('Failed to fetch'); }), { state: 'error', code: 'unavailable' });
  const slow = createLookupClient({ fetch: (u, init) => hang({ signal: init.signal }), timeoutMs: 30 });
  assert.deepEqual(await slow.get({ q: 'slow river', lang: 'en' }), { state: 'error', code: 'unavailable' }, 'a timeout is not an abort');
  const s = fakeServer([[/./, () => json({ code: 'lookup_rate' }, 429)]]);
  const c = createLookupClient({ fetch: s.fetch });
  await c.get({ q: 'busy signal', lang: 'en' }); await c.get({ q: 'busy signal', lang: 'en' });
  assert.equal(s.calls.length, 2, 'a 429 is never cached');
});
test('client.image: the proxy URL with the same headers → a Blob typed by its bytes; anything else → null', async () => {
  let body = PNG, type = 'image/png', status = 200;
  const s = fakeServer([[/^\/api\/lookup\/img\?k=/, () => new Response(body, { status, headers: { 'content-type': type } })], [/^\/icons\//, () => new Response(PNG, { headers: { 'content-type': 'image/png' } })]]);
  const c = createLookupClient({ fetch: s.fetch, headers: () => ({ 'x-app-pass': 'pw' }) });
  const src = DOMUS_IMAGE.src;
  const blob = await c.image(src);
  assert.equal(blob.type, 'image/png'); assert.equal(blob.size, PNG.length);
  assert.equal(s.calls[0].url, src); assert.equal(s.calls[0].headers.get('x-app-pass'), 'pw'); assert.equal(s.calls[0].init.credentials, 'same-origin');
  assert.equal(await c.image(src), blob, 'kept in memory');
  assert.equal(s.calls.length, 1);
  assert.ok(await c.image('/icons/atelier-v2-512.png'), 'the :8791 fixture icon');
  assert.equal(await c.image(DOMUS_THUMB), null, 'never Wikimedia directly');
  assert.equal(s.calls.length, 2);
  type = 'image/jpeg'; // a mislabeled PNG is typed by its bytes
  assert.equal((await c.image(DOMUS_IMAGE.srcset[0][1])).type, 'image/png');
  body = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'); type = 'image/png';
  assert.equal(await c.image(DOMUS_IMAGE.srcset[2][1]), null, 'SVG bytes are refused');
  body = PNG; status = 502;
  assert.equal(await c.image(`${src}x`), null);
  status = 200; body = new Uint8Array(0);
  assert.equal(await c.image(`${src}y`), null, 'empty');
  const big = createLookupClient({ fetch: async () => new Response(Uint8Array.from([...PNG, ...new Uint8Array(64)]), { headers: { 'content-type': 'image/png' } }), imageBytes: 32 });
  assert.equal(await big.image(src), null, 'over the byte cap');
  const ctrl = new AbortController(); ctrl.abort();
  assert.equal(await c.image(`${src}z`, ctrl.signal), null, 'an aborted load is just null');
});

// ── the controller on a fake clock ──
function clock() {
  let t = 0, id = 0;
  const q = new Map();
  return {
    now: () => t,
    schedule: (fn, ms) => { q.set(++id, { at: t + ms, fn }); return id; },
    cancel: (i) => q.delete(i),
    tick(ms) {
      const end = t + ms;
      for (;;) {
        const next = [...q.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        q.delete(next[0]); t = next[1].at; next[1].fn();
      }
      t = end;
    },
    get pending() { return q.size; },
  };
}
function rig({ mode = 'auto', ready = true, cached = null, online = true, defaultInput = 'mouse' } = {}) {
  const ck = clock(), log = [];
  let snap = null;
  const fx = {
    mode: () => (typeof mode === 'function' ? mode() : mode), ready: () => ready, read: () => snap, cached: (req) => (cached ? cached(req) : undefined),
    fetch: (req, seq) => log.push(['fetch', req, seq]), abort: () => log.push(['abort']), show: (view, s) => log.push(['show', view.state, s?.term]),
    hide: (reason) => log.push(['hide', reason]), moving: (on) => log.push(['moving', on]), reposition: () => log.push(['reposition']), reanchor: (s) => log.push(['reanchor', s?.range?.id]),
    highlight: (r) => log.push(['highlight', r ? r.id : null]), announce: (view) => log.push(['announce', view.state]), disable: () => log.push(['disable']),
    online: () => online, defaultInput: () => defaultInput,
  };
  const ctl = createController({ schedule: ck.schedule, cancel: ck.cancel, now: ck.now, timing: { ...LOOKUP_TIMING }, fx });
  const sel = (term, tier = classify(term), id = term) => { snap = term ? { term, tier, entryId: 'e1', kind: 'ask', range: { id } } : null; return snap; };
  const kinds = (k) => log.filter((e) => e[0] === k);
  const lastFetchSeq = () => kinds('fetch').at(-1)?.[2];
  return { ck, ctl, fx, log, sel, kinds, lastFetchSeq, clear: () => (log.length = 0) };
}
const articleView = { state: 'article', model: cardModel(ARTICLE) };

test('controller: nothing for a collapsed or ineligible selection', () => {
  const r = rig();
  r.ctl.selectionChanged({ collapsed: true }); r.ck.tick(1000);
  r.sel(null); r.ctl.pointerUp({ type: 'mouse', detail: 1 }); r.ck.tick(1000);
  assert.deepEqual(r.kinds('show'), []); assert.deepEqual(r.kinds('fetch'), []);
  assert.equal(r.ctl.state, 'idle');
});
test('controller: settle delays — touch 350, Android contextmenu 60, mouse 120 / 260 after mouseup, keyboard 450', () => {
  const touch = rig({ defaultInput: 'touch' });
  touch.sel('Domus Aurea'); touch.ctl.pointerDown({ type: 'touch' }); touch.ctl.selectionChanged({ collapsed: false });
  touch.ck.tick(349); assert.equal(touch.kinds('fetch').length, 0); touch.ck.tick(1); assert.equal(touch.kinds('fetch').length, 1);
  const menu = rig({ defaultInput: 'touch' });
  menu.sel('Domus Aurea'); menu.ctl.pointerDown({ type: 'touch' }); menu.ctl.selectionChanged({ collapsed: false }); menu.ctl.contextMenu({ collapsed: false });
  menu.ck.tick(60); assert.equal(menu.kinds('fetch').length, 1, 'the Android fast path');
  menu.ck.tick(1000); assert.equal(menu.kinds('fetch').length, 1, 'the slower settle re-reads the same term: no second fetch');
  const mouse = rig();
  mouse.sel('Domus Aurea'); mouse.ctl.pointerDown({ type: 'mouse' }); mouse.ctl.selectionChanged({ collapsed: false }); mouse.ck.tick(2000);
  assert.equal(mouse.kinds('fetch').length, 0, 'nothing while the button is held');
  mouse.ctl.pointerUp({ type: 'mouse', detail: 1 }); mouse.ck.tick(119); assert.equal(mouse.kinds('fetch').length, 0); mouse.ck.tick(1); assert.equal(mouse.kinds('fetch').length, 1);
  const dbl = rig();
  dbl.sel('Mercury'); dbl.ctl.pointerDown({ type: 'mouse' }); dbl.ctl.selectionChanged({ collapsed: false }); dbl.ctl.pointerUp({ type: 'mouse', detail: 2 });
  dbl.ck.tick(259); assert.equal(dbl.kinds('fetch').length, 0); dbl.ck.tick(1); assert.equal(dbl.kinds('fetch').length, 1);
  const key = rig();
  key.sel('Mercury'); key.ctl.keySelection(); key.ctl.selectionChanged({ collapsed: false });
  key.ck.tick(449); assert.equal(key.kinds('fetch').length, 0); key.ck.tick(1); assert.equal(key.kinds('fetch').length, 1);
  const contextMouse = rig();
  contextMouse.sel('Mercury'); contextMouse.ctl.pointerDown({ type: 'mouse' }); contextMouse.ctl.contextMenu({ collapsed: false }); contextMouse.ck.tick(100);
  assert.equal(contextMouse.kinds('fetch').length, 0, 'the fast path is touch-only');
});
test('controller: skeleton only after 250 ms; a fast answer never shows it; stale answers are dropped', () => {
  const r = rig({ defaultInput: 'touch' });
  r.sel('Domus Aurea'); r.ctl.selectionChanged({ collapsed: false }); r.ck.tick(350);
  const seq = r.lastFetchSeq();
  r.ck.tick(100); r.ctl.result(articleView, seq);
  assert.deepEqual(r.kinds('show').map((e) => e[1]), ['article'], 'no loading state for a fast answer');
  assert.deepEqual(r.kinds('announce').map((e) => e[1]), ['article']);
  const slow = rig({ defaultInput: 'touch' });
  slow.sel('slow river'); slow.ctl.selectionChanged({ collapsed: false }); slow.ck.tick(350 + 249);
  assert.equal(slow.kinds('show').length, 0); slow.ck.tick(1);
  assert.deepEqual(slow.kinds('show').map((e) => e[1]), ['loading']); assert.equal(slow.ctl.state, 'loading');
  slow.ctl.result({ state: 'error', code: 'unavailable' }, slow.lastFetchSeq() - 1);
  assert.equal(slow.kinds('show').length, 1, 'a stale seq is dropped');
  slow.ctl.result(articleView, slow.lastFetchSeq());
  assert.deepEqual(slow.kinds('show').map((e) => e[1]), ['loading', 'article']);
});
test('controller: a cache hit paints at once; the same term again only repositions; a new term aborts then fetches', () => {
  const r = rig({ defaultInput: 'touch', cached: (req) => (req.q === 'Domus Aurea' ? articleView : undefined) });
  r.sel('Domus Aurea'); r.ctl.selectionChanged({ collapsed: false }); r.ck.tick(350);
  assert.deepEqual(r.kinds('show').map((e) => e[1]), ['article']); assert.equal(r.kinds('fetch').length, 0); assert.equal(r.ctl.state, 'card');
  r.clear();
  r.sel('Domus Aurea'); r.ctl.selectionChanged({ collapsed: false }); r.ck.tick(350);
  assert.deepEqual(r.log.map((e) => e[0]), ['moving', 'reanchor', 'moving', 'reposition'], 'fade while it moves, follow the new selection, re-place: no second fetch');
  r.clear();
  r.sel('Mercury'); r.ctl.selectionChanged({ collapsed: false }); r.ck.tick(350);
  const order = r.log.map((e) => e[0]).filter((k) => k === 'abort' || k === 'fetch');
  assert.deepEqual(order, ['abort', 'fetch']);
  assert.equal(r.ctl.term, 'Mercury');
});
test('controller: the same words selected somewhere else move the card there (and a pinned card’s mark), with no new request', () => {
  const r = rig({ defaultInput: 'touch', cached: (req) => (req.q === 'Nero' ? articleView : undefined) });
  r.sel('Nero', 'auto', 'p1'); r.ctl.selectionChanged({ collapsed: false }); r.ck.tick(350);
  assert.equal(r.ctl.snap.range.id, 'p1');
  r.clear();
  r.sel('Nero', 'auto', 'p4'); r.ctl.contextMenu({ collapsed: false }); r.ctl.selectionChanged({ collapsed: false }); r.ck.tick(350); // a long-press in paragraph 4
  assert.deepEqual(r.kinds('reanchor'), [['reanchor', 'p4']], 'the adapter is told about the new selection'); assert.equal(r.ctl.snap.range.id, 'p4');
  assert.equal(r.kinds('fetch').length, 0); assert.equal(r.kinds('show').length, 0); assert.equal(r.kinds('highlight').length, 0, 'unpinned: nothing marked');
  // pinned: the mark follows too
  r.ctl.pin(); r.clear();
  r.sel('Nero', 'auto', 'p6'); r.ctl.selectionChanged({ collapsed: false }); r.ck.tick(350);
  assert.deepEqual(r.kinds('reanchor'), [['reanchor', 'p6']]); assert.deepEqual(r.kinds('highlight'), [['highlight', 'p6']]); assert.equal(r.ctl.pinned, true);
  // Alt+L on the same words elsewhere does the same
  r.clear(); r.sel('Nero', 'auto', 'p9');
  assert.equal(r.ctl.forceLookup(), true);
  assert.deepEqual(r.kinds('reanchor'), [['reanchor', 'p9']]); assert.deepEqual(r.kinds('highlight'), [['highlight', 'p9']]); assert.equal(r.kinds('fetch').length, 0);
  // and while a request is still out, its answer shows against the newest selection
  const w = rig({ defaultInput: 'touch' });
  w.sel('Mercury', 'auto', 'm1'); w.ctl.selectionChanged({ collapsed: false }); w.ck.tick(350);
  w.sel('Mercury', 'auto', 'm2'); w.ctl.selectionChanged({ collapsed: false }); w.ck.tick(350);
  assert.equal(w.kinds('fetch').length, 1); assert.deepEqual(w.kinds('reanchor'), [['reanchor', 'm2']]);
  w.ctl.result(articleView, w.lastFetchSeq()); assert.equal(w.ctl.snap.range.id, 'm2');
});
test('controller: On tap shows the pill and fetches nothing until it is tapped; long terms always start as a pill', () => {
  const r = rig({ mode: 'tap', defaultInput: 'touch' });
  r.sel('Domus Aurea'); r.ctl.selectionChanged({ collapsed: false }); r.ck.tick(2000);
  assert.deepEqual(r.kinds('show').map((e) => e[1]), ['pill']); assert.equal(r.kinds('fetch').length, 0); assert.equal(r.ctl.state, 'pill');
  r.ctl.pillTap();
  assert.equal(r.kinds('fetch').length, 1); assert.equal(r.ctl.pinned, true); assert.deepEqual(r.kinds('highlight').at(-1), ['highlight', 'Domus Aurea']);
  const auto = rig({ defaultInput: 'touch' });
  auto.sel('one two three four five six seven eight'); auto.ctl.selectionChanged({ collapsed: false }); auto.ck.tick(350);
  assert.deepEqual(auto.kinds('show').map((e) => e[1]), ['pill']); assert.equal(auto.kinds('fetch').length, 0);
  const off = rig({ mode: 'off', defaultInput: 'touch' });
  off.sel('Domus Aurea'); off.ctl.selectionChanged({ collapsed: false }); off.ck.tick(2000);
  assert.equal(off.kinds('show').length + off.kinds('fetch').length, 0);
  const notReady = rig({ ready: false, defaultInput: 'touch' });
  notReady.sel('Domus Aurea'); notReady.ctl.selectionChanged({ collapsed: false }); notReady.ck.tick(2000);
  assert.equal(notReady.kinds('fetch').length, 0);
  const offline = rig({ online: false, defaultInput: 'touch' });
  offline.sel('Domus Aurea'); offline.ctl.selectionChanged({ collapsed: false }); offline.ck.tick(2000);
  assert.equal(offline.kinds('show').length + offline.kinds('fetch').length, 0, 'Automatic + offline: nothing appears');
  const offTap = rig({ online: false, mode: 'tap', defaultInput: 'touch' });
  offTap.sel('Domus Aurea'); offTap.ctl.selectionChanged({ collapsed: false }); offTap.ck.tick(400); offTap.ctl.pillTap();
  assert.equal(offTap.kinds('fetch').length, 1, 'a tap while offline still asks (and shows “You’re offline.”)');
});
test('controller: collapse, pins, outside clicks and the close triggers', () => {
  const open = () => { const r = rig({ defaultInput: 'touch', cached: () => articleView }); r.sel('Domus Aurea'); r.ctl.selectionChanged({ collapsed: false }); r.ck.tick(350); return r; };
  const a = open();
  a.sel(null); a.ctl.selectionChanged({ collapsed: true }); a.ck.tick(149); assert.equal(a.ctl.state, 'card'); a.ck.tick(1);
  assert.equal(a.ctl.state, 'idle'); assert.deepEqual(a.kinds('hide').at(-1), ['hide', 'collapsed']); assert.deepEqual(a.kinds('highlight').at(-1), ['highlight', null]);
  const b = open();
  b.ctl.pin(); assert.equal(b.ctl.pinned, true); assert.deepEqual(b.kinds('highlight').at(-1), ['highlight', 'Domus Aurea']);
  b.sel(null); b.ctl.selectionChanged({ collapsed: true }); b.ck.tick(1000); assert.equal(b.ctl.state, 'card', 'a pinned card ignores losing the selection');
  b.sel('Mercury'); b.ctl.selectionChanged({ collapsed: false }); b.ck.tick(350);
  assert.equal(b.ctl.term, 'Mercury'); assert.equal(b.ctl.pinned, false, 'a new eligible term replaces the pinned card');
  const ios = open(); // iOS: the tap on the card clears the selection first, then pins it inside the grace window
  ios.sel(null); ios.ctl.selectionChanged({ collapsed: true }); ios.ck.tick(60); ios.ctl.pin(); ios.ck.tick(500);
  assert.equal(ios.ctl.state, 'card', 'pinned during the grace period: kept');
  const again = open();
  again.sel(null); again.ctl.selectionChanged({ collapsed: true }); again.ck.tick(60); again.sel('Domus Aurea'); again.ck.tick(200);
  assert.equal(again.ctl.state, 'card', 'a selection that came back inside the grace period keeps the card');
  const c = open();
  c.ctl.outsideClick({ selectionLive: true }); assert.equal(c.ctl.state, 'card', 'a click that ends a new selection is left to the settle');
  c.ctl.outsideClick({ selectionLive: false }); assert.equal(c.ctl.state, 'idle');
  for (const fn of ['overlay', 'focusOutside', 'anchorLost', 'hidden', 'keyboardOpen']) {
    const r = open(); r.ctl.pin(); r.ctl[fn](); assert.equal(r.ctl.state, 'idle', fn); assert.equal(r.ctl.pinned, false, fn);
  }
});
test('controller: Escape closes a visible card (true) and otherwise lets the global handler run (false)', () => {
  const r = rig({ defaultInput: 'touch', cached: () => articleView });
  assert.equal(r.ctl.escape(), false, 'idle: stopAll() still runs');
  r.sel('Domus Aurea'); r.ctl.selectionChanged({ collapsed: false }); r.ck.tick(350);
  assert.equal(r.ctl.escape(), true); assert.equal(r.ctl.state, 'idle'); assert.deepEqual(r.kinds('hide').at(-1), ['hide', 'escape']);
  const w = rig({ defaultInput: 'touch' });
  w.sel('Domus Aurea'); w.ctl.selectionChanged({ collapsed: false }); w.ck.tick(350 + 100);
  assert.equal(w.ctl.state, 'waiting'); assert.equal(w.ctl.escape(), false, 'nothing visible yet: Escape keeps its usual job'); assert.equal(w.ctl.state, 'idle');
  assert.ok(w.kinds('abort').length >= 1);
});
test('controller: user scrolls fade and re-place after 150 ms or scrollend; app scrolls follow', () => {
  const r = rig({ defaultInput: 'touch', cached: () => articleView });
  r.ctl.scroll({ userDriven: true }); assert.equal(r.log.length, 0, 'idle: nothing');
  r.sel('Domus Aurea'); r.ctl.selectionChanged({ collapsed: false }); r.ck.tick(350); r.clear();
  r.ctl.scroll({ userDriven: true }); assert.deepEqual(r.log, [['moving', true]]);
  r.ck.tick(149); r.ctl.scroll({ userDriven: true }); r.ck.tick(149); assert.equal(r.kinds('reposition').length, 0, 'the idle timer restarts');
  r.ck.tick(1); assert.deepEqual(r.log.slice(-2), [['moving', false], ['reposition']]);
  r.clear(); r.ctl.scroll({ userDriven: true }); r.ctl.scrollEnd(); assert.deepEqual(r.log, [['moving', true], ['moving', false], ['reposition']]);
  r.clear(); r.ctl.scrollEnd(); assert.deepEqual(r.log, [], 'scrollend without a pending idle does nothing');
  r.ctl.scroll({ userDriven: false }); assert.deepEqual(r.log, [['reposition']]);
});
test('controller: an off/owner_only answer disables Look up for the session; picks, back and retry', () => {
  const r = rig({ defaultInput: 'touch' });
  r.sel('Domus Aurea'); r.ctl.selectionChanged({ collapsed: false }); r.ck.tick(350);
  r.ctl.result({ state: 'error', code: 'off' }, r.lastFetchSeq());
  assert.deepEqual(r.kinds('disable'), [['disable']]); assert.equal(r.ctl.state, 'idle');
  r.ctl.selectionChanged({ collapsed: false }); r.ck.tick(2000); assert.equal(r.kinds('fetch').length, 1, 'disabled: no more requests');
  const p = rig({ defaultInput: 'touch' });
  p.sel('Mercury'); p.ctl.selectionChanged({ collapsed: false }); p.ck.tick(350);
  const choices = { state: 'choices', model: cardModel(CHOICES) };
  p.ctl.result(choices, p.lastFetchSeq());
  p.ctl.lookTitle('Mercury (planet)');
  assert.deepEqual(p.kinds('fetch').at(-1)[1], { title: 'Mercury (planet)' }); assert.equal(p.ctl.pinned, true);
  p.ctl.result(articleView, p.lastFetchSeq());
  p.ctl.showView(choices); assert.deepEqual(p.kinds('show').at(-1).slice(0, 2), ['show', 'choices']);
  p.ctl.result(articleView, p.lastFetchSeq()); assert.deepEqual(p.kinds('show').at(-1).slice(0, 2), ['show', 'choices'], 'a late answer after Back is dropped');
  p.ctl.lookTitle('Mercury (element)'); p.ctl.result({ state: 'error', code: 'unavailable' }, p.lastFetchSeq());
  p.ctl.retry(); assert.deepEqual(p.kinds('fetch').at(-1)[1], { title: 'Mercury (element)' }, 'Try again repeats the last request');
});
test('controller: Alt+L looks up the live selection whatever the tier', () => {
  const r = rig({ mode: 'tap', defaultInput: 'mouse' });
  assert.equal(r.ctl.forceLookup(), false, 'no selection');
  r.sel('one two three four five six seven eight');
  assert.equal(r.ctl.forceLookup(), true); assert.equal(r.kinds('fetch').length, 1);
  const off = rig({ mode: 'off' }); off.sel('Domus Aurea'); assert.equal(off.ctl.forceLookup(), false);
});

// ── rendering on a fake document ──
const ctx0 = { term: 'Domus Aurea', kind: 'ask', phone: true, dpr: 2, history: false, expanded: false, disabledUntil: 0, now: 1000 };
function rendered(view, ctx = {}) {
  const doc = new FakeDoc(), card = doc.createElement('div'), loads = [];
  renderCard(doc, card, view, { ...ctx0, loadImage: (img, src, slot) => loads.push({ img, src, slot }), ...ctx });
  return { doc, card, loads, els: all(card), text: texts(card).join('') };
}
test('renderCard: text-only DOM; safe links; data-lk controls; dialog semantics', () => {
  const xss = { state: 'article', model: cardModel({ ...SEARCHED, title: XSS, description: XSS, extract: XSS, others: [{ title: XSS, description: XSS }] }) };
  const { card, els, loads } = rendered(xss);
  assert.equal(card.dataset.state, 'article'); assert.equal(card.dataset.kind, 'ask');
  assert.equal(card.getAttribute('role'), 'dialog'); assert.equal(card.getAttribute('aria-labelledby'), 'lkTitle'); assert.equal(card.getAttribute('aria-describedby'), 'lkText');
  assert.equal(card.getAttribute('aria-modal'), 'false'); assert.equal(card.getAttribute('aria-keyshortcuts'), 'Alt+L'); assert.equal(card.getAttribute('aria-busy'), 'false');
  assert.ok(texts(card).some((t) => t === XSS), 'the payload is only ever a text node');
  for (const el of els) for (const [k, v] of el.attrs) assert.ok(!String(v).includes('onerror') || k === 'title' || k === 'data-title' || k === 'alt', `${k}=${v}`);
  for (const a of els.filter((e) => e.localName === 'a')) {
    assert.equal(a.getAttribute('target'), '_blank'); assert.equal(a.getAttribute('rel'), 'noopener noreferrer');
    assert.match(a.getAttribute('href'), /^https:\/\/(en\.wikipedia\.org\/wiki\/|commons\.wikimedia\.org\/wiki\/File:|creativecommons\.org\/licenses\/by-sa\/4\.0\/$)/);
    assert.ok(texts(a).includes(' (opens in a new tab)'), 'external links say so');
  }
  const controls = els.filter((e) => e.localName === 'button');
  assert.ok(controls.length >= 4);
  for (const b of controls) { assert.ok(b.dataset.lk, 'every control carries data-lk'); assert.equal(b.dataset.act, undefined); assert.equal(b.getAttribute('type'), 'button'); }
  assert.deepEqual(controls.map((b) => b.dataset.lk), ['open', 'alt', 'ask', 'close']);
  for (const img of els.filter((e) => e.localName === 'img')) {
    assert.equal(img.referrerPolicy, 'no-referrer'); assert.equal(img.decoding, 'async'); assert.equal(img.getAttribute('src'), null, 'renderCard never sets src: the adapter loads a blob');
    assert.ok(safeImageUrl(img.dataset.lkSrc)); assert.equal(img.getAttribute('alt'), XSS);
  }
  assert.deepEqual(loads.map((l) => [l.slot, l.src]), [['thumb', DOMUS_IMAGE.srcset[0][1]]], 'the thumbnail loads now; the figure waits for a tap');
  assert.equal(els.find((e) => e.getAttribute('id') === 'lkFigure').hidden, true);
});
test('renderCard: the article card, its foot and the expanded figure', () => {
  const view = { state: 'article', model: cardModel(ARTICLE) };
  const { card, els, text } = rendered(view);
  assert.ok(text.includes('Wikipedia · Roman palace')); assert.ok(text.includes('Domus Aurea')); assert.ok(text.includes('Ask about this'));
  assert.ok(text.includes('Wikipedia editors') && text.includes('CC BY-SA 4.0') && text.includes('shortened') && text.includes('Image'));
  const title = els.find((e) => e.getAttribute('id') === 'lkTitle');
  assert.equal(title.localName, 'a'); assert.equal(title.getAttribute('href'), ARTICLE.url); assert.equal(title.getAttribute('lang'), 'en');
  const thumb = els.find((e) => e.classList.contains('lk-thumb'));
  assert.equal(thumb.getAttribute('aria-expanded'), 'false'); assert.equal(thumb.getAttribute('aria-controls'), 'lkFigure'); assert.equal(thumb.dataset.mat, '');
  assert.equal(thumb.getAttribute('aria-label'), 'Show a larger image and the full summary');
  assert.ok(!text.includes('Not quite?'));
  const open = rendered(view, { expanded: true, phone: false, dpr: 2 });
  assert.ok(open.card.classList.contains('is-open'));
  assert.deepEqual(open.loads.map((l) => [l.slot, l.src]), [['thumb', DOMUS_IMAGE.srcset[0][1]], ['figure', DOMUS_IMAGE.srcset[2][1]]], '84px × 2 → 250; 328px × 2 → the largest (500)');
  assert.equal(open.els.find((e) => e.getAttribute('id') === 'lkFigure').hidden, false);
  const searched = rendered({ state: 'article', model: cardModel(SEARCHED) });
  assert.ok(searched.text.includes('Wikipedia · Best match')); assert.ok(searched.text.includes('Not quite?') && searched.text.includes('Palace Tomb') && searched.text.includes('Nero'));
  const plain = rendered({ state: 'article', model: cardModel({ ...ARTICLE, image: null, trimmed: false, description: '' }) });
  assert.ok(!plain.els.some((e) => e.classList.contains('lk-thumb'))); assert.ok(!plain.text.includes('shortened')); assert.ok(!plain.text.includes('Image'));
  assert.ok(plain.text.startsWith('Wikipedia'));
  const rtl = rendered({ state: 'article', model: cardModel({ ...ARTICLE, lang: 'he', dir: 'rtl' }) });
  assert.equal(rtl.els.find((e) => e.getAttribute('id') === 'lkText').getAttribute('dir'), 'rtl');
  assert.equal(rtl.card.getAttribute('dir'), null, 'the card chrome keeps the page direction');
  const back = rendered(view, { history: true });
  assert.equal(back.els.find((e) => e.localName === 'button').dataset.lk, 'back'); assert.ok(back.text.includes('← Meanings'));
});
test('renderCard: pill, loading, choices, none and error states', () => {
  const pill = rendered({ state: 'pill' });
  assert.equal(pill.card.getAttribute('role'), null); assert.equal(pill.card.getAttribute('aria-labelledby'), null);
  const btn = pill.els.find((e) => e.localName === 'button');
  assert.equal(btn.dataset.lk, 'pill'); assert.equal(btn.getAttribute('aria-label'), 'Look up “Domus Aurea” on Wikipedia'); assert.ok(pill.text.includes('Look up'));
  const loading = rendered({ state: 'loading' });
  assert.equal(loading.card.getAttribute('aria-busy'), 'true'); assert.equal(loading.card.getAttribute('role'), 'dialog');
  assert.ok(loading.els.some((e) => e.classList.contains('shimmer'))); assert.equal(loading.els.filter((e) => e.classList.contains('skel')).length, 3);
  assert.equal(loading.els.find((e) => e.classList.contains('lk-skel')).getAttribute('aria-hidden'), 'true');
  const choices = rendered({ state: 'choices', model: cardModel(CHOICES) }, { term: 'Mercury' });
  assert.ok(choices.text.includes('Wikipedia · A few meanings')); assert.ok(choices.text.includes('“Mercury” can mean'));
  assert.deepEqual(choices.els.filter((e) => e.dataset.lk === 'pick').map((e) => e.dataset.title), ['Mercury (planet)', 'Mercury (element)', 'Freddie Mercury']);
  assert.equal(choices.card.getAttribute('aria-describedby'), null);
  const none = rendered({ state: 'none', model: cardModel(NONE) }, { term: 'zzz nothing' });
  assert.ok(none.text.includes('No Wikipedia article matches this.')); assert.ok(none.text.includes('Closest:') && none.text.includes('Sleep')); assert.ok(none.text.includes('Search Wikipedia'));
  assert.equal(none.els.find((e) => e.classList.contains('lk-wiki')).getAttribute('href'), NONE.search);
  for (const [code, sentence] of Object.entries(ERRORS)) {
    const e = rendered({ state: 'error', code }, { term: 'fail state' });
    assert.ok(e.text.includes(sentence), code);
    assert.equal(Boolean(e.els.find((x) => x.dataset.lk === 'retry')), ['offline', 'unavailable', 'busy', 'rate'].includes(code), `${code}: Try again`);
  }
  const busy = rendered({ state: 'error', code: 'busy', retryAfter: 5 }, { disabledUntil: 6000, now: 1000 });
  assert.equal(busy.els.find((x) => x.dataset.lk === 'retry').disabled, true, 'Try again waits for Retry-After');
  const ready = rendered({ state: 'error', code: 'busy', retryAfter: 5 }, { disabledUntil: 6000, now: 6001 });
  assert.equal(ready.els.find((x) => x.dataset.lk === 'retry').disabled, false);
  assert.ok(!rendered({ state: 'none', model: cardModel(NONE) }, { canAsk: false }).els.some((e) => e.dataset.lk === 'ask'), 'no Ask button when it can neither send nor pre-fill');
});
test('renderCard: data-kind only for the six kinds', () => {
  for (const kind of KINDS) assert.equal(rendered({ state: 'loading' }, { kind }).card.dataset.kind, kind);
  for (const kind of ['evil', '', null, 'toString']) assert.equal(rendered({ state: 'loading' }, { kind }).card.dataset.kind, undefined);
});
test('announcement: the words #lookupStatus says', () => {
  const a = { state: 'article', model: cardModel({ ...ARTICLE, description: 'Roman palace (fixture).' }) };
  assert.equal(announcement(a, 'Domus Aurea', false), 'Wikipedia: Domus Aurea, Roman palace (fixture).');
  assert.equal(announcement(a, 'Domus Aurea', true), 'Wikipedia: Domus Aurea, Roman palace (fixture). Press Alt+L to open.');
  assert.equal(announcement({ state: 'choices', model: cardModel(CHOICES) }, 'Mercury'), 'Mercury has several meanings on Wikipedia.');
  assert.equal(announcement({ state: 'none', model: cardModel(NONE) }, 'zzz nothing'), 'No Wikipedia article for zzz nothing.');
  assert.equal(announcement({ state: 'error', code: 'busy' }, 'x'), ERRORS.busy);
  assert.equal(announcement({ state: 'pill' }, 'x'), '');
});

// ── the adapter, end to end on a fake page ──
function page({ askSends = () => true, prefill = true, mode = 'auto', fetchRoutes } = {}) {
  const ck = clock(), doc = new FakeDoc(), revoked = [], created = [], toasts = [], asked = [], prefilled = [], from = [];
  const win = {
    document: doc, navigator: { onLine: true, languages: ['en-US'] }, innerWidth: 360, innerHeight: 740, devicePixelRatio: 2, visualViewport: null,
    setTimeout: ck.schedule, clearTimeout: ck.cancel, requestAnimationFrame: (fn) => ck.schedule(fn, 16), listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }, removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); },
    URL: { createObjectURL: (b) => { const u = `blob:fake/${created.length + 1}`; created.push([u, b]); return u; }, revokeObjectURL: (u) => revoked.push(u) },
    observers: [], MutationObserver: class { constructor(fn) { this.fn = fn; win.observers.push(this); } observe(t) { this.t = t; } disconnect() { this.t = null; } },
    resizers: [], ResizeObserver: class { constructor(fn) { this.fn = fn; win.resizers.push(this); } observe(t) { this.t = t; } disconnect() { this.t = null; } },
    CSS: { highlights: new Map() }, Highlight: class { constructor(r) { this.range = r; } },
  };
  const stage = doc.createElement('main'), stream = doc.createElement('ol'), dock = doc.createElement('footer'), top = doc.createElement('header');
  stage.rect = { left: 0, top: 0, right: 360, bottom: 740, width: 360, height: 740 }; dock.rect = { left: 0, top: 570, right: 360, bottom: 740, width: 360, height: 170 };
  top.rect = { left: 0, top: 0, right: 360, bottom: 98, width: 360, height: 98 };
  const status = doc.createElement('div'); status.setAttribute('id', 'lookupStatus');
  doc.body.append(top, stage, dock, status); stage.append(stream);
  const li = doc.createElement('li'); li.classList.add('entry'); li.setAttribute('aria-busy', 'false'); li.dataset.id = 'e7'; li.dataset.kind = 'ask';
  const prose = doc.createElement('div'); prose.classList.add('prose'); prose.sels = new Set(ELIGIBLE.split(',').map((s) => s.trim()));
  const words = new FakeText('Nero’s Golden House (Domus Aurea) sat on the Oppian Hill.');
  prose.append(words); li.append(prose); stream.append(li);
  const range = { startContainer: words, endContainer: words, top: 300, cloneRange() { return this; }, getClientRects() { return [{ left: 40, right: 200, top: this.top, bottom: this.top + 20, width: 160, height: 20 }]; } };
  const select = (text) => { doc.selection = text ? { rangeCount: 1, isCollapsed: false, getRangeAt: () => range, toString: () => text, collapseToEnd() { this.isCollapsed = true; doc.selection = null; } } : null; };
  const s = fakeServer(fetchRoutes || [
    [/^\/api\/lookup\?/, () => json(ARTICLE)],
    [/^\/api\/lookup\/img\?k=/, () => new Response(PNG, { headers: { 'content-type': 'image/png' } })],
  ]);
  const api = initLookup({
    doc, win, stage, stream, dock, topBar: top, status, fetch: s.fetch, apiHeaders: () => ({ 'content-type': 'application/json', 'x-app-pass': 'pw' }),
    mode: () => mode, ready: () => true, ask: (p, f) => { asked.push(p); from.push(f); }, prefill: prefill ? (p, f) => { prefilled.push(p); from.push(f); } : null, askSends, toast: (m) => toasts.push(m),
    coarse: { matches: true }, languages: ['en-US'],
  });
  const fire = (target, type, props = {}) => {
    const ev = { type, target, defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...props };
    for (const [fn] of [...(target.listeners?.[type] || [])]) fn(ev);
    if (target !== doc) for (const [fn] of [...(doc.listeners[type] || [])]) fn(ev); // bubbles (capture/bubble order is not modelled)
    return ev;
  };
  const card = () => doc.getElementById('lookupCard');
  return { ck, doc, win, api, s, fire, select, card, status, asked, prefilled, from, toasts, created, revoked, stage, stream, dock, li, prose, words, range };
}
async function openCard(p) {
  p.select('Domus Aurea');
  p.fire(p.doc, 'pointerdown', { pointerType: 'touch' });
  p.fire(p.doc, 'selectionchange');
  p.ck.tick(350);
  await flush(); p.ck.tick(20); await flush();
}
test('initLookup: touch select → one /api/lookup request → the card with its proxied blob image and the status line', async () => {
  const p = page();
  assert.equal(p.card(), null, 'the card is created on first use');
  await openCard(p);
  assert.equal(p.s.calls[0].url, '/api/lookup?q=Domus+Aurea&lang=en'); assert.equal(p.s.calls[0].headers.get('x-app-pass'), 'pw');
  const card = p.card();
  assert.ok(card); assert.equal(card.parentNode, p.doc.body, 'mounted on body, never inside #stage or #stream');
  assert.equal(card.dataset.state, 'article'); assert.equal(card.dataset.kind, 'ask'); assert.equal(card.hidden, false); assert.ok(card.classList.contains('show'));
  assert.equal(card.dataset.side, 'below'); assert.equal(card.style.props['--lk-y'], `${320 + LOOKUP_GEOMETRY.handleClear}px`);
  assert.equal(p.status.textContent, 'Wikipedia: Domus Aurea, Roman palace.');
  const img = card.querySelector('img');
  assert.equal(p.s.calls[1].url, DOMUS_IMAGE.srcset[0][1], 'the picture comes through Atelier’s proxy'); assert.equal(p.s.calls[1].headers.get('x-app-pass'), 'pw');
  assert.ok(p.s.calls.every((c) => c.url.startsWith('/api/lookup')), 'nothing goes to Wikipedia or Wikimedia from the browser');
  assert.equal(img.src, 'blob:fake/1'); assert.equal(p.created[0][1].type, 'image/png');
  p.fire(p.doc, 'selectionchange'); p.ck.tick(350); await flush();
  assert.equal(p.s.calls.filter((c) => c.url.startsWith('/api/lookup?')).length, 1, 'the same term settling again: no second request');
  p.api.destroy();
  assert.ok(p.revoked.includes('blob:fake/1'), 'object URLs are revoked');
});
test('initLookup: Ask about this sends for the owner and pre-fills for testers (decision 2)', async () => {
  const owner = page();
  await openCard(owner);
  const ask = owner.card().querySelector('[data-lk=ask]');
  owner.fire(ask, 'pointerdown', { pointerType: 'touch' });
  owner.fire(owner.card(), 'click', { target: ask });
  assert.deepEqual(owner.asked, ['Tell me more about “Domus Aurea”.']); assert.deepEqual(owner.prefilled, []);
  assert.deepEqual(owner.from, [{ entryId: 'e7' }], 'the answer the words came from goes with the ask (its link / share mark is carried)');
  assert.equal(owner.api.isOpen(), false); assert.equal(owner.doc.selection, null, 'the selection collapses after Ask');
  const tester = page({ askSends: () => false });
  await openCard(tester);
  const tAsk = tester.card().querySelector('[data-lk=ask]');
  tester.fire(tester.card(), 'click', { target: tAsk });
  assert.deepEqual(tester.asked, [], 'a tester’s allowance is never spent without their own tap on Send');
  assert.deepEqual(tester.prefilled, ['Tell me more about “Domus Aurea”.']);
  assert.deepEqual(tester.from, [{ entryId: 'e7' }]);
  assert.equal(tester.status.textContent, COPY.prefilled);
  const neither = page({ askSends: () => false, prefill: false });
  await openCard(neither);
  assert.equal(neither.card().querySelector('[data-lk=ask]'), null, 'no pre-fill hook: the button is not offered at all');
  for (const x of [owner, tester, neither]) x.api.destroy();
});
test('initLookup: the card press pins it without moving focus; Escape closes only an open card; contextmenu is never cancelled', async () => {
  const p = page();
  const menu = p.fire(p.doc, 'contextmenu');
  assert.equal(menu.defaultPrevented, false);
  const idleEsc = p.fire(p.doc, 'keydown', { key: 'Escape' });
  assert.equal(idleEsc.stopped, false, 'closed: Escape reaches stopAll()');
  await openCard(p);
  const press = p.fire(p.card(), 'pointerdown', { pointerType: 'touch' });
  assert.equal(press.defaultPrevented, true); assert.equal(p.api.pinned(), true);
  assert.ok(p.win.CSS.highlights.get('atelier-lookup'), 'the term stays marked even if the selection goes');
  p.select(null); p.fire(p.doc, 'selectionchange'); p.ck.tick(1000);
  assert.equal(p.api.isOpen(), true, 'pinned: losing the selection keeps it');
  const esc = p.fire(p.doc, 'keydown', { key: 'Escape' });
  assert.equal(esc.stopped, true); assert.equal(esc.defaultPrevented, true); assert.equal(p.api.isOpen(), false);
  assert.equal(p.win.CSS.highlights.has('atelier-lookup'), false);
  p.ck.tick(300); assert.equal(p.card().hidden, true);
  const again = p.fire(p.doc, 'keydown', { key: 'Escape' });
  assert.equal(again.stopped, false);
  p.api.destroy();
});
test('initLookup: words scrolled out of view hide an unpinned card; Escape then keeps its usual job (stopAll)', async () => {
  const p = page();
  await openCard(p);
  p.range.top = -200; // the app scrolled the answer away under the card
  p.fire(p.stage, 'scroll'); p.ck.tick(200); // a touch is still down: a user scroll, re-placed after the idle step
  assert.ok(p.card().classList.contains('is-moving'), 'hidden while its words are away');
  const esc = p.fire(p.doc, 'keydown', { key: 'Escape' });
  assert.equal(esc.stopped, false, 'an invisible card never eats the Escape that stops a running answer');
  assert.equal(p.api.isOpen(), false);
  p.api.destroy();
});
// A live Range as a browser keeps it: when its text node is removed, both boundaries move to (parent, index) — a node
// that is still connected — and the range collapses. (The page's own fake range never moves, which hid this.)
function liveRangeOn(node, top) {
  return {
    startContainer: node, endContainer: node, startOffset: 0, endOffset: 11, collapsed: false, top,
    cloneRange() { return this; },
    getClientRects() { return this.collapsed ? [] : [{ left: 40, right: 200, top: this.top, bottom: this.top + 20, width: 160, height: 20 }]; },
    relocate(parent) { this.startContainer = this.endContainer = parent; this.startOffset = this.endOffset = 0; this.collapsed = true; },
  };
}
const selectRange = (p, text, range) => { p.doc.selection = { rangeCount: 1, isCollapsed: false, getRangeAt: () => range, toString: () => text, collapseToEnd() {} }; };
const streamMutation = (p) => { for (const o of p.win.observers) if (o.t === p.stream) o.fn([]); };
test('initLookup: the answer re-rendered under an open card (live range moved to the parent) closes it, pinned or not', async () => {
  for (const pinned of [false, true]) {
    const p = page();
    const range = liveRangeOn(p.words, 300);
    selectRange(p, 'Domus Aurea', range);
    p.fire(p.doc, 'pointerdown', { pointerType: 'touch' }); p.fire(p.doc, 'selectionchange'); p.ck.tick(350); await flush(); p.ck.tick(20); await flush();
    assert.equal(p.api.isOpen(), true);
    if (pinned) { p.fire(p.card(), 'pointerdown', { pointerType: 'touch' }); assert.equal(p.api.pinned(), true); }
    // renderThread: stream.innerHTML = '' — the entry goes, the range moves to #stream (still connected) and collapses
    p.li.remove(); range.relocate(p.stream);
    assert.equal(range.startContainer.isConnected, true, 'the old check (startContainer.isConnected) could never fire');
    streamMutation(p);
    assert.equal(p.api.isOpen(), false, `${pinned ? 'pinned' : 'unpinned'}: closed when its words are gone`);
    assert.equal(p.api.pinned(), false, 'so reloadWhenIdle is no longer held off');
    assert.equal(p.win.CSS.highlights.has('atelier-lookup'), false);
    p.api.destroy();
  }
  // a paintEntry-style rebuild of the answer's own .out (the text node replaced, the range collapsed inside the entry)
  const p = page();
  const range = liveRangeOn(p.words, 300);
  selectRange(p, 'Domus Aurea', range);
  p.fire(p.doc, 'pointerdown', { pointerType: 'touch' }); p.fire(p.doc, 'selectionchange'); p.ck.tick(350); await flush(); p.ck.tick(20); await flush();
  p.prose.replaceChildren('Nero’s Golden House (Domus Aurea) sat on the Oppian Hill.'); range.relocate(p.prose);
  streamMutation(p);
  assert.equal(p.api.isOpen(), false);
  // an unrelated mutation (another answer streaming) leaves the card alone
  const q = page();
  const r2 = liveRangeOn(q.words, 300);
  selectRange(q, 'Domus Aurea', r2);
  q.fire(q.doc, 'pointerdown', { pointerType: 'touch' }); q.fire(q.doc, 'selectionchange'); q.ck.tick(350); await flush(); q.ck.tick(20); await flush();
  q.stream.append(q.doc.createElement('li')); streamMutation(q);
  assert.equal(q.api.isOpen(), true);
  p.api.destroy(); q.api.destroy();
});
test('initLookup: the same words long-pressed in another paragraph re-anchor the card there (it was hidden with the old ones)', async () => {
  const p = page();
  const r1 = liveRangeOn(p.words, 300);
  selectRange(p, 'Nero', r1);
  p.fire(p.doc, 'pointerdown', { pointerType: 'touch' }); p.fire(p.doc, 'selectionchange'); p.ck.tick(350); await flush(); p.ck.tick(20); await flush();
  assert.equal(p.card().dataset.side, 'below'); assert.equal(p.card().style.props['--lk-y'], `${320 + LOOKUP_GEOMETRY.handleClear}px`);
  // scroll: paragraph 1 leaves the screen, the unpinned card hides (and is inert)
  r1.top = -400; p.fire(p.stage, 'scroll'); p.ck.tick(200);
  assert.ok(p.card().classList.contains('is-moving')); assert.equal(p.card().inert, true);
  // long-press "Nero" in paragraph 4: no click, a contextmenu, the same term
  const para4 = p.doc.createElement('div'); para4.classList.add('prose'); para4.sels = p.prose.sels; const w4 = new FakeText('Nero rebuilt Rome.'); para4.append(w4); p.li.append(para4);
  const r4 = liveRangeOn(w4, 200);
  selectRange(p, 'Nero', r4);
  p.fire(p.doc, 'pointerdown', { pointerType: 'touch' }); p.fire(p.doc, 'selectionchange'); p.fire(p.doc, 'contextmenu'); p.ck.tick(60); p.ck.tick(20);
  assert.ok(!p.card().classList.contains('is-moving'), 'shown again, beside the new selection'); assert.equal(p.card().inert, false);
  assert.equal(p.card().style.props['--lk-y'], `${220 + LOOKUP_GEOMETRY.handleClear}px`);
  assert.equal(p.s.calls.filter((c) => c.url.startsWith('/api/lookup?')).length, 1, 'no second request');
  // pinned: the mark moves with it; the anchor-lost watch follows the new paragraph
  p.fire(p.card(), 'pointerdown', { pointerType: 'touch' });
  assert.equal(p.win.CSS.highlights.get('atelier-lookup').range, r4);
  r1.relocate(p.prose); streamMutation(p);
  assert.equal(p.api.isOpen(), true, 'paragraph 1 changing no longer matters');
  para4.remove(); r4.relocate(p.li); streamMutation(p);
  assert.equal(p.api.isOpen(), false);
  p.api.destroy();
});
test('initLookup: a drag-selection released over a pinned card still settles the new words', async () => {
  const p = page();
  await openCard(p);
  p.fire(p.card(), 'pointerdown', { pointerType: 'mouse' }); // the person pins the card with the mouse
  assert.equal(p.api.pinned(), true);
  // press on text below the card, drag upward, release over the card
  p.fire(p.doc, 'pointerdown', { pointerType: 'mouse', target: p.prose });
  const r = liveRangeOn(p.words, 300); selectRange(p, 'Mercury', r);
  p.fire(p.doc, 'selectionchange'); p.ck.tick(1000);
  assert.equal(p.s.calls.filter((c) => c.url.includes('q=Mercury')).length, 0, 'nothing while the button is held');
  p.fire(p.doc, 'mouseup', { target: p.card(), detail: 1 });
  p.fire(p.doc, 'click', { target: p.li }); // the click lands on a shared ancestor, with a live selection: left to the settle
  p.ck.tick(LOOKUP_TIMING.mouse); await flush();
  assert.equal(p.s.calls.filter((c) => c.url.includes('q=Mercury')).length, 1, 'the new words were looked up');
  assert.equal(p.api.pinned(), false, 'the new card replaces the pinned one');
  // a press that starts in the card never ends a drag (the card's own press keeps the selection)
  p.fire(p.card(), 'pointerdown', { pointerType: 'mouse' }); p.fire(p.doc, 'mouseup', { target: p.prose, detail: 1 }); p.ck.tick(1000); await flush();
  assert.equal(p.s.calls.filter((c) => c.url.startsWith('/api/lookup?')).length, 2);
  p.api.destroy();
});
test('initLookup: Alt+L on a card hidden with its scrolled-away words docks it in view before focusing it; a focused card docks instead of hiding', async () => {
  const p = page();
  await openCard(p);
  p.range.top = -200; p.fire(p.stage, 'scroll'); p.ck.tick(200);
  const card = p.card();
  assert.ok(card.classList.contains('is-moving')); assert.equal(card.inert, true, 'Tab can’t reach controls nobody can see');
  const before = p.doc.activeElement;
  const alt = p.fire(p.doc, 'keydown', { key: '¬', code: 'KeyL', altKey: true });
  assert.equal(alt.defaultPrevented, true);
  assert.equal(p.api.pinned(), true); assert.equal(card.dataset.side, 'dock');
  assert.ok(!card.classList.contains('is-moving'), 'visible'); assert.equal(card.inert, false);
  assert.ok(card.contains(p.doc.activeElement), 'focus is in a card that can be seen');
  p.fire(p.doc, 'keydown', { key: 'Escape' });
  assert.equal(p.api.isOpen(), false); assert.equal(p.doc.activeElement, before, 'Escape hands focus back');
  p.api.destroy();
  // focus already inside (Alt+L earlier), then the words scroll away: the card docks rather than vanishing around the focus
  const q = page();
  await openCard(q);
  q.fire(q.doc, 'keydown', { key: '¬', code: 'KeyL', altKey: true });
  assert.ok(q.card().contains(q.doc.activeElement)); assert.equal(q.api.pinned(), false);
  q.range.top = -200; q.fire(q.stage, 'scroll'); q.ck.tick(200);
  assert.ok(!q.card().classList.contains('is-moving')); assert.equal(q.card().inert, false);
  assert.equal(q.card().dataset.side, 'dock'); assert.equal(q.api.pinned(), true);
  q.api.destroy();
});
test('initLookup: the composer growing under an open card (dictation, a photo) re-places it above the dock’s new top', async () => {
  const p = page();
  await openCard(p);
  p.fire(p.card(), 'pointerdown', { pointerType: 'touch' }); // pinned: a tap in the dock no longer closes it
  const card = p.card(), G = LOOKUP_GEOMETRY;
  assert.equal(card.dataset.side, 'below'); assert.equal(card.style.props['--lk-y'], `${320 + G.handleClear}px`);
  const dockRo = p.win.resizers.find((r) => r.t === p.dock);
  assert.ok(dockRo, 'the dock’s size is watched');
  // a three-line transcript: the textarea grows and the dock's top rises from 570 to 450, with no window resize
  p.dock.rect = { ...p.dock.rect, top: 450, height: 290 };
  dockRo.fn([]); p.ck.tick(20);
  const y = parseFloat(card.style.props['--lk-y']), maxH = parseFloat(card.style.props['--lk-max']);
  assert.ok(y + Math.min(226, maxH) <= 450 - G.edge, `the card ends above the dock (y ${y}, max ${maxH})`);
  assert.equal(card.dataset.side, 'above', 'no longer room below the words: it moves above them');
  // closed: a resize never re-opens or re-places anything
  p.api.close(); p.ck.tick(300);
  const props = { ...card.style.props };
  p.dock.rect = { ...p.dock.rect, top: 570, height: 170 }; dockRo.fn([]); p.ck.tick(20);
  assert.deepEqual(card.style.props, props); assert.equal(card.hidden, true);
  p.api.destroy();
  assert.equal(dockRo.t, null, 'destroy disconnects it');
});
test('initLookup: “Press Alt+L to open.” is said only while keyboard focus is still outside the card', async () => {
  const lead = 'Wikipedia: Domus Aurea, Roman palace.';
  // a mouse selection settles by itself: focus stays in the answer, so the hint says how to reach the card
  const p = page();
  p.select('Domus Aurea');
  p.fire(p.doc, 'pointerdown', { pointerType: 'mouse', target: p.prose });
  p.fire(p.doc, 'selectionchange');
  p.fire(p.doc, 'mouseup', { target: p.prose, detail: 2 });
  p.ck.tick(1000); await flush(); p.ck.tick(20); await flush();
  assert.equal(p.card().dataset.state, 'article'); assert.ok(!p.card().contains(p.doc.activeElement));
  assert.equal(p.status.textContent, `${lead} Press Alt+L to open.`);
  p.api.destroy();
  // Alt+L on a mouse selection: focus is already on the card's first control when the article is announced
  const q = page();
  q.fire(q.doc, 'pointerdown', { pointerType: 'mouse', target: q.prose });
  q.select('Domus Aurea');
  q.fire(q.doc, 'keydown', { key: '¬', code: 'KeyL', altKey: true, target: q.prose });
  await flush(); q.ck.tick(20); await flush();
  assert.equal(q.card().dataset.state, 'article'); assert.ok(q.card().contains(q.doc.activeElement));
  assert.equal(q.status.textContent, lead);
  q.api.destroy();
  // On tap: Alt+L focuses the pill, Enter on it loads the article and focus stays inside
  const r = page({ mode: 'tap' });
  r.select('Domus Aurea');
  r.fire(r.doc, 'pointerdown', { pointerType: 'mouse', target: r.prose });
  r.fire(r.doc, 'selectionchange');
  r.fire(r.doc, 'mouseup', { target: r.prose, detail: 2 });
  r.ck.tick(1000); await flush(); r.ck.tick(20); await flush();
  assert.equal(r.card().dataset.state, 'pill');
  r.fire(r.doc, 'keydown', { key: '¬', code: 'KeyL', altKey: true, target: r.prose });
  const pill = r.card().querySelector('[data-lk=pill]');
  assert.equal(r.doc.activeElement, pill);
  r.fire(r.card(), 'click', { target: pill });
  await flush(); r.ck.tick(20); await flush();
  assert.equal(r.card().dataset.state, 'article'); assert.ok(r.card().contains(r.doc.activeElement));
  assert.equal(r.status.textContent, lead);
  r.api.destroy();
});
test('initLookup: errors render in the card (never a toast) except the one session-off toast', async () => {
  const p = page({ fetchRoutes: [[/^\/api\/lookup\?/, () => json({ code: 'lookup_busy', retryAfter: 5 }, 429, { 'retry-after': '5' })]] });
  await openCard(p);
  assert.equal(p.card().dataset.state, 'error'); assert.ok(texts(p.card()).join('').includes(ERRORS.busy)); assert.deepEqual(p.toasts, []);
  assert.equal(p.card().querySelector('[data-lk=retry]').disabled, true);
  p.ck.tick(5000); assert.equal(p.card().querySelector('[data-lk=retry]').disabled, false, 'Try again wakes up after Retry-After');
  p.api.destroy();
  const off = page({ fetchRoutes: [[/^\/api\/lookup\?/, () => json({ code: 'owner_only' }, 403)]] });
  await openCard(off);
  assert.equal(off.api.isOpen(), false); assert.deepEqual(off.toasts, [COPY.unavailable]); assert.equal(off.api.mode(), 'off');
  off.select('Mercury'); off.fire(off.doc, 'selectionchange'); off.ck.tick(1000); await flush();
  assert.equal(off.s.calls.length, 1, 'hidden for the rest of the session'); assert.deepEqual(off.toasts, [COPY.unavailable], 'one toast only');
  off.api.destroy();
});
test('initLookup: destroy removes every listener it added', async () => {
  const p = page();
  await openCard(p);
  p.api.destroy();
  const left = (t) => Object.values(t.listeners).reduce((n, l) => n + l.length, 0);
  assert.equal(left(p.doc), 0); assert.equal(left(p.stage), 0); assert.equal(Object.values(p.win.listeners).reduce((n, l) => n + l.length, 0), 0);
  assert.equal(p.card(), null);
});

// ── app.js wiring (skips until lookup-integration.md A1–A8 are applied) ──
const APP = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8').catch(() => '')).replace(/\r\n/g, '\n');
const WIRED = APP.includes('const lookup = initLookup(');
// submit() lifted out of app.js and run against stubs: names it uses that aren't stubbed resolve to no-op functions.
function liftSubmit(stubs) {
  const at = APP.indexOf('async function submit(');
  const src = APP.slice(at, APP.indexOf('\n}\n', at) + 2);
  const scope = new Proxy({}, {
    has: (_, k) => typeof k === 'string' && (k in stubs || !(k in globalThis)),
    get: (_, k) => (k === Symbol.unscopables ? undefined : k in stubs ? stubs[k] : () => undefined),
  });
  return new Function('scope', `with (scope) { return (${src}); }`)(scope);
}
function appRig({ attachments = [{ src: 'data:image/png;base64,QUJD' }], draft = '' } = {}) {
  const calls = { planTasks: 0, renderAttachments: 0, run: [] };
  const input = { value: draft, focus() {} };
  const S = { mode: 'ask', video: null, attachments: [...attachments], thread: null, opts: { ask: {} }, tester: false };
  let id = 0;
  const submit = liftSubmit({
    S, input, $: (sel) => (sel === '#input' ? input : { value: '', focus() {} }), navigator: { onLine: true }, hasCredentials: () => true, feat: () => true,
    MULTI_HINT: /./, MULTI_JOIN: /./, running: new Set(), planTasks: async () => { calls.planTasks++; return null; },
    renderAttachments: () => { calls.renderAttachments++; }, run: async (e) => { calls.run.push(e); }, newThread: () => ({ entries: [] }),
    uid: () => `e${++id}`, videoSource: () => null, welcome: { classList: { add() {} } }, stream: { append() {} }, renderEntry: () => ({}),
  });
  return { submit, S, input, calls };
}
test('app.js wiring: the owner’s “Ask about this” sends no photos and leaves the composer’s mode, draft and waiting attachments alone (A3, A7, A8)', { skip: !WIRED && 'public/app.js is not wired to lookup.js yet (lookup-integration.md A1–A8)' }, async () => {
  const init = APP.slice(APP.indexOf('const lookup = initLookup('));
  assert.match(init.slice(0, 1000), /ask: \(prompt, from\) => submit\(prompt, 'ask', \{ images: \[\], untrusted: markOfEntry\(from\) \}\),/);
  assert.doesNotMatch(init.slice(0, 1000), /ask: \(prompt(?:, from)?\) => \{?\s*setMode/, 'the owner’s ask never switches the composer’s mode under a draft');
  // the Look up ask, with a photo waiting in the composer and words that look like several deliverables
  const r = appRig({ draft: 'half-written message' });
  await r.submit(askPrompt('Tom and Jerry animation, poster and app'), 'ask', { images: [] });
  assert.equal(r.calls.run.length, 1); assert.deepEqual(r.calls.run[0].images, [], 'the photo is not sent to the model');
  assert.equal(r.S.attachments.length, 1, 'and it is still waiting in the composer'); assert.equal(r.calls.renderAttachments, 0);
  assert.equal(r.calls.planTasks, 0, 'one request: never split into parallel image/video tasks');
  assert.equal(r.input.value, 'half-written message', 'the draft is untouched');
  // a composer send still takes the photo and clears it
  const c = appRig({ draft: 'what is this?' });
  await c.submit();
  assert.deepEqual(c.calls.run[0].images, ['data:image/png;base64,QUJD']); assert.equal(c.S.attachments.length, 0); assert.equal(c.calls.renderAttachments, 1);
});
test('constants: modes, kinds and timings the spec names', () => {
  assert.deepEqual([...LOOKUP_MODES], ['auto', 'tap', 'off']);
  assert.deepEqual([...KINDS], ['ask', 'code', 'image', 'video', 'ideas', 'build']);
  assert.equal(LOOKUP_TIMING.touch, 350); assert.equal(LOOKUP_TIMING.skeleton, 250); assert.equal(LOOKUP_TIMING.grace, 150);
  assert.ok(Object.isFrozen(LOOKUP_GEOMETRY)); assert.ok(!Object.isFrozen(LOOKUP_TIMING), 'tests may shorten the timings');
  assert.equal(LICENSE.url, 'https://creativecommons.org/licenses/by-sa/4.0/');
});
