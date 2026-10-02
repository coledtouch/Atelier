import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// public/remix-draw.js — drawing remix frames, against a fake 2D context that records every call and property set.
const D = await import('../public/remix-draw.js');
const R = await import('../public/remix.js');
const G = await import('../public/remix-graph.js');
const { cutsFrom } = await import('../public/remix-cuts.js');
const FX = JSON.parse(readFileSync(new URL('./fixtures/remix/remix-plan-promo.json', import.meta.url), 'utf8'));
const LUMA = JSON.parse(readFileSync(new URL('./fixtures/remix/promo-luma.json', import.meta.url), 'utf8'));
const SRC = { duration: 48, width: 1080, height: 1350, fps: 30, vkbps: 1046, rotation: 0 };

// A fake canvas + context: calls → ops [name, ...args]; sets → ops ['set', prop, value]. measureText: 0.5 em a char.
function fakeCanvas(w = 1080, h = 1350, log = []) {
  const canvas = { width: w, height: h, log };
  const state = { font: '10px x', globalAlpha: 1 };
  const ctx = new Proxy({}, {
    get(_, k) {
      if (k === 'canvas') return canvas;
      if (k === 'measureText') return (t) => { const px = Number(/(\d+)px/.exec(state.font)?.[1] || 10); return { width: String(t).length * px * 0.5 }; };
      if (k === 'getImageData') return (x, y, gw, gh) => { log.push(['getImageData', x, y, gw, gh]); return { data: new Uint8ClampedArray(gw * gh * 4).fill(100) }; };
      if (k === 'createLinearGradient') return (...a) => { log.push(['createLinearGradient', ...a]); return { stops: [], addColorStop(o, c) { this.stops.push([o, c]); } }; };
      if (k in state) return state[k];
      return (...a) => { log.push([k, ...a]); };
    },
    set(_, k, v) { state[k] = v; log.push(['set', k, v]); return true; },
    has: (_, k) => k === 'letterSpacing' || k in state,
  });
  canvas.getContext = () => ctx;
  canvas.toDataURL = () => 'data:image/jpeg;base64,AAAA';
  return canvas;
}
const mk = (w, h) => fakeCanvas(w, h, []);
const calls = (log, name) => log.filter((x) => x[0] === name);
const sets = (log, prop) => log.filter((x) => x[0] === 'set' && x[1] === prop).map((x) => x[2]);

test('styleFor: scales with output width, resolves the accent, tracking in px', () => {
  const k = D.styleFor('kicker', 540, 'pink');
  assert.equal(k.size, 13);
  assert.equal(k.upper, true);
  assert.equal(k.tracking, 0.17 * 13);
  assert.match(k.font, /^500 13px 'JetBrains Mono'/);
  assert.equal(D.styleFor('accent', 1080, 'pink').color, R.ACCENTS.pink);
  assert.equal(D.styleFor('headline_italic', 1080).font.startsWith('italic 400 86px'), true);
  assert.equal(D.styleFor('nope').size, 40, 'unknown style → body');
});

test('ensureFonts: loads each face used with its real text; a slow or empty load falls back', async () => {
  const plan = R.settlePlan(FX.plan, { source: SRC, opts: { maxNew: 0 } }).plan;
  const loaded = [];
  const fonts = { load: async (f, text) => { loaded.push([f, text]); return [{}]; } };
  assert.equal(await D.ensureFonts(plan, { fonts }), 'studio');
  assert.ok(loaded.some(([f, t]) => f === '400 40px "Instrument Serif"' && t.includes('Connected to your tools:')));
  assert.ok(loaded.some(([f]) => f === '600 40px "Hanken Grotesk"'));
  assert.equal(await D.ensureFonts(plan, { fonts: { load: async () => [] } }), 'fallback', 'no face matched');
  assert.equal(await D.ensureFonts(plan, { fonts: { load: () => new Promise(() => {}) }, timeout: 10 }), 'fallback', 'timed out');
  assert.equal(await D.ensureFonts(plan, { fonts: null }), 'fallback');
  assert.equal(await D.ensureFonts({ timeline: [], overlays: [] }, { fonts }), 'studio', 'nothing to load');
});

test('wrapText/layoutLines: greedy wrap at the measure; headline rows are tighter', () => {
  const c = fakeCanvas();
  const ctx = c.getContext();
  ctx.font = '400 40px x';
  assert.deepEqual(D.wrapText(ctx, 'aaaa bbbb cccc', 200), ['aaaa bbbb', 'cccc']);
  const lay = D.layoutLines(ctx, [{ text: 'Connected to your tools:', style: 'headline' }, { text: 'Gmail', style: 'accent' }], 1080, 'lime');
  assert.deepEqual(lay.rows.map((r) => r.text), ['Connected to your', 'tools:', 'Gmail'], 'wrapped at 84 % of the width');
  assert.equal(lay.rows[0].h, Math.round(86 * 1.04));
  assert.equal(lay.rows[2].h, Math.round(46 * 1.3));
});

test('drawFrame: a VideoSample draws through drawWithFit with its crop; a canvas through drawImage; nothing → brand', () => {
  const c = fakeCanvas(), ctx = c.getContext();
  let fit = null;
  D.drawFrame(ctx, { drawWithFit: (cx, o) => { fit = o; } }, { sx: 0, sy: 190, sw: 720, sh: 900 }, 1080, 1350);
  assert.deepEqual(fit, { fit: 'fill', crop: { left: 0, top: 190, width: 720, height: 900 } });
  const img = { width: 720, height: 1280 };
  D.drawFrame(ctx, img, { sx: 0, sy: 190, sw: 720, sh: 900 }, 1080, 1350);
  assert.deepEqual(calls(c.log, 'drawImage').at(-1), ['drawImage', img, 0, 190, 720, 900, 0, 0, 1080, 1350]);
  D.drawFrame(ctx, null, null, 1080, 1350);
  assert.deepEqual(calls(c.log, 'fillRect').at(-1), ['fillRect', 0, 0, 1080, 1350]);
  assert.equal(sets(c.log, 'fillStyle').at(-1), R.BRAND);
});

test('drawCard: brand fill, push-in scale about the centre, blurred backdrop cached, text centred with its fade', () => {
  const c = fakeCanvas(), ctx = c.getContext(), cache = new Map();
  const card = { backdrop: { kind: 'frame_blur', t: 24 }, lines: [{ text: 'Connected', style: 'headline' }, { text: 'Gmail', style: 'accent', glow: true }], motion: 'push', accent: 'pink' };
  const bd = { width: 1080, height: 1350 };
  D.drawCard(ctx, { W: 1080, H: 1350, id: 'tools', card, state: { scale: 1.02, textAlpha: 0.5 }, backdrop: bd, crop: null, cache, mk });
  assert.deepEqual(calls(c.log, 'scale')[0], ['scale', 1.02, 1.02]);
  assert.ok(cache.has('blur:tools'), 'the blurred backdrop is kept for the next frames');
  const texts = calls(c.log, 'fillText').map((x) => x[1]);
  assert.deepEqual(texts, ['Connected', 'Gmail', 'Gmail'], 'glow pass, then crisp');
  assert.ok(sets(c.log, 'fillStyle').includes(R.ACCENTS.pink));
  assert.ok(sets(c.log, 'shadowColor').includes(R.GLOW.color));
  assert.ok(sets(c.log, 'globalAlpha').includes(0.5));
  const again = fakeCanvas(), n0 = cache.size;
  D.drawCard(again.getContext(), { W: 1080, H: 1350, id: 'tools', card, state: { scale: 1, textAlpha: 1 }, backdrop: bd, cache, mk });
  assert.equal(cache.size, n0);
  // brand card: no backdrop draw at all
  const b = fakeCanvas();
  D.drawCard(b.getContext(), { W: 1080, H: 1350, card: { backdrop: { kind: 'brand' }, lines: [] }, state: { scale: 1, textAlpha: 1 }, mk });
  assert.equal(calls(b.log, 'drawImage').length, 0);
  assert.equal(calls(b.log, 'fillText').length, 0);
});

test('drawText: inside its band, moved by drift, scrim for captions; nothing at alpha 0', () => {
  const c = fakeCanvas(), ctx = c.getContext();
  const layer = { lines: [{ text: 'Auto picks the right model', style: 'caption' }], position: 'lower_third', scrim: false };
  D.drawText(ctx, layer, { W: 1080, H: 1350, alpha: 1, dy: 0 });
  const y0 = calls(c.log, 'fillText')[0][3];
  const [b0, b1] = R.BANDS.lower_third;
  assert.ok(y0 >= (b0 / 1000) * 1350 - 30 && y0 <= (b1 / 1000) * 1350, `y ${y0} in the band`);
  assert.ok(calls(c.log, 'fill').length >= 1, 'caption style brings a scrim');
  const d = fakeCanvas();
  D.drawText(d.getContext(), layer, { W: 1080, H: 1350, alpha: 1, dy: -12 });
  assert.equal(calls(d.log, 'fillText')[0][3], y0 - 12);
  const z = fakeCanvas();
  D.drawText(z.getContext(), layer, { W: 1080, H: 1350, alpha: 0 });
  assert.equal(z.log.length, 0);
});

test('ringColors: averages the 1-px ring around a box per side', () => {
  const w = 6, h = 6, data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; data[i] = y === 0 ? 200 : y === 5 ? 20 : 90; data[i + 1] = 0; data[i + 2] = 0; }
  const r = D.ringColors(data, w, h, 1, 1, 4, 4);
  assert.equal(r.top[0], 200);
  assert.equal(r.bottom[0], 20);
});

test('drawCover: brand is a solid box, match reads the ring and fills a gradient, blur redraws its own pixels', () => {
  const box = [859, 230, 942, 772];
  const a = fakeCanvas();
  D.drawCover(a.getContext(), { box, fill: 'brand' }, { W: 1080, H: 1350, alpha: 1, mk });
  const r = D.gridRect(box, 1080, 1350);
  assert.deepEqual(calls(a.log, 'fillRect')[0], ['fillRect', Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h)]);
  const m = fakeCanvas();
  D.drawCover(m.getContext(), { box, fill: 'match' }, { W: 1080, H: 1350, alpha: 1, mk });
  assert.equal(calls(m.log, 'getImageData').length, 1);
  assert.equal(calls(m.log, 'createLinearGradient').length, 1);
  const b = fakeCanvas();
  D.drawCover(b.getContext(), { box, fill: 'blur' }, { W: 1080, H: 1350, alpha: 1, mk });
  assert.equal(calls(b.log, 'drawImage').length, 1, 'the blurred copy goes back over the box');
});

test('drawImageLayer contains the screenshot in its box; drawTap pulses at its point', () => {
  const c = fakeCanvas();
  D.drawImageLayer(c.getContext(), { box: [200, 100, 800, 900] }, { width: 400, height: 800 }, { W: 1080, H: 1350, alpha: 1 });
  const di = calls(c.log, 'drawImage')[0];
  assert.equal(Math.round(di[5]), Math.round(0.6 * 1350), 'height-bound: fills the box height');
  assert.equal(Math.round(di[4]), Math.round(0.6 * 1350 / 2), 'and keeps its aspect');
  const t = fakeCanvas();
  D.drawTap(t.getContext(), { point: [430, 720] }, { W: 1080, H: 1350, alpha: 1, local: 0.45 });
  const arcs = calls(t.log, 'arc');
  assert.equal(arcs[0][1], 0.72 * 1080);
  assert.equal(arcs[0][2], 0.43 * 1350);
  assert.ok(arcs[0][3] > 18, 'the ring has grown half way');
});

test('composeFrame on the fixture graph: source through its crop, the card with its backdrop, then cover → image → text', () => {
  const s = R.settlePlan(FX.plan, { source: SRC, opts: { maxNew: 0 }, cuts: cutsFrom(LUMA.polished) });
  const g = G.buildGraph(s.layout, s.plan, { fps: 30, out: { w: 1080, h: 1350 }, source: SRC });
  const src = { width: 1080, height: 1350, tag: 'src' };
  // 25.0 s: the card 'tools' (24–26) over its blurred backdrop
  const card = fakeCanvas();
  D.composeFrame(card.getContext(), G.frameAt(g, 25 * 30), g, { frames: { tools: src } }, { mk, cache: new Map() });
  assert.ok(calls(card.log, 'fillText').some((x) => x[1].startsWith('Connected to your')));
  // 30.5 s: 'models' at source 28.5, under the cover and the glowing caption
  const f = G.frameAt(g, Math.round(30.5 * 30));
  assert.deepEqual(f.layers.map((l) => l.id), ['hide', 'fall']);
  const c = fakeCanvas();
  D.composeFrame(c.getContext(), f, g, { frames: { models: src } }, { mk });
  const order = c.log.filter((x) => ['drawImage', 'getImageData', 'fillText'].includes(x[0])).map((x) => x[0]);
  assert.equal(order[0], 'drawImage', 'the frame first');
  assert.ok(order.indexOf('getImageData') < order.indexOf('fillText'), 'cover (match) before text');
  assert.ok(calls(c.log, 'fillText').some((x) => /AUTO PICKS|Auto picks/.test(x[1])));
  // a frame whose decoded image is missing is brand-coloured, never a crash
  const m = fakeCanvas();
  D.composeFrame(m.getContext(), G.frameAt(g, 0), g, { frames: {} }, { mk });
  assert.ok(sets(m.log, 'fillStyle').includes(R.BRAND));
});

test('composeFrame: a dip paints the brand colour over everything at its strength', () => {
  const g = { w: 100, h: 125, background: R.BRAND, items: [{ id: 'a', type: 'source', crop: null }], layers: [] };
  const c = fakeCanvas(100, 125);
  D.composeFrame(c.getContext(), { k: 0, t: 0, draws: [{ id: 'a', type: 'source', media: 0, alpha: 1 }], dip: 0.4, layers: [] }, g, { frames: { a: { width: 100, height: 125 } } }, { mk });
  assert.ok(sets(c.log, 'globalAlpha').includes(0.4));
  assert.deepEqual(calls(c.log, 'fillRect').at(-1), ['fillRect', 0, 0, 100, 125]);
});

test('padFrame: the frame contained in the provider shape over blurred bands; cardThumb draws a small card', () => {
  const frame = { width: 1080, height: 1350 };
  const c = D.padFrame(frame, { w: 720, h: 1280 }, { mk });
  const box = R.padBox(1080, 1350, 720, 1280);
  assert.equal(c.width, 720);
  assert.deepEqual(calls(c.log, 'drawImage').at(-1), ['drawImage', frame, 0, 0, 1080, 1350, box.x, box.y, box.w, box.h]);
  const t = D.cardThumb({ backdrop: { kind: 'brand' }, lines: [{ text: 'Hi', style: 'headline' }] }, { w: 120, mk });
  assert.equal(t.width, 120);
  assert.equal(t.height, 150);
  assert.ok(calls(t.log, 'fillText').length === 1);
});
