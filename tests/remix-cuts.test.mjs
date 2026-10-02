import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// public/remix-cuts.js on the promo reels' measured luma series (scripts/make-remix-fixtures.mjs wrote them with
// ffmpeg; the browser measures the same 64 px gray frames with Mediabunny).
const C = await import('../public/remix-cuts.js');
const LUMA = JSON.parse(readFileSync(new URL('./fixtures/remix/promo-luma.json', import.meta.url), 'utf8'));
const near = (x, y, tol = 0.2) => Math.abs(x - y) <= tol;
const has = (windows, a, b) => windows.some(([x, y]) => near(x, a) && near(y, b));

test('the fixture is the real reel: 1440 frames at 30 fps, 48 s, 1080×1350, irregular keyframes', () => {
  for (const k of ['original', 'polished']) {
    const s = LUMA[k];
    assert.equal(s.luma.length, 1440);
    assert.equal(s.hist.length, 1440);
    assert.deepEqual([s.fps, s.duration, s.width, s.height], [30, 48, 1080, 1350]);
    assert.equal(C.parseHist(s.hist[0]).length, 16);
    assert.ok(Math.abs(C.parseHist(s.hist[100]).reduce((a, b) => a + b, 0) - 1) < 0.05, 'a histogram sums to ~1');
  }
  assert.deepEqual(LUMA.original.keyframes, [0, 4.833, 7.333, 9.633, 16.833, 24, 31.233, 38.4, 40.8]);
  assert.deepEqual(LUMA.polished.keyframes, [0, 5, 7.333, 9.633, 16.833, 24, 31.233, 38.4, 40.033]);
});

test('original reel: the scene changes are found as dissolve windows near 30.87–31.40, 38.03–38.43 and 40.50–40.83', () => {
  const b = C.detectBoundaries(LUMA.original.luma, LUMA.original.hist, 30);
  assert.ok(has(b.dissolves, 30.87, 31.40), JSON.stringify(b.dissolves));
  assert.ok(has(b.dissolves, 38.03, 38.43));
  assert.ok(has(b.dissolves, 40.50, 40.83));
  assert.ok(has(b.dissolves, 16.47, 16.87), 'and the 16.8 s crossfade');
  for (const [a, z] of b.dissolves) assert.ok(z > a && (z - a) * 30 >= 6 - 1e-6 && (z - a) * 30 <= 24 + 1e-6, 'every window is 6–24 frames');
});

test('original reel: the one-frame jumps at 15.1 s and 35.8 s are screen changes, not scene cuts', () => {
  const b = C.detectBoundaries(LUMA.original.luma, LUMA.original.hist, 30);
  assert.ok(b.screens.includes(15.1) && b.screens.includes(35.8), JSON.stringify(b.screens));
  assert.ok(!b.hard.includes(15.1) && !b.hard.includes(35.8));
  assert.deepEqual(b.hard, [], 'the original reel has no hard cuts at all');
  assert.ok(!b.dissolves.some(([a, z]) => a < 37.2 && z > 36.5), 'the easing scroll at 36.5–37.7 s is not a dissolve');
});

test('polished reel: its new opening and closing are hard cuts at 5.0 s and 40.0 s; the fade after 40.0 merges into the cut', () => {
  const b = C.detectBoundaries(LUMA.polished.luma, LUMA.polished.hist, 30);
  assert.deepEqual(b.hard, [5, 40]);
  assert.ok(!b.dissolves.some(([a]) => a > 40 && a < 40.15), JSON.stringify(b.dissolves));
  assert.ok(b.screens.includes(15.1) && b.screens.includes(35.8));
});

test('gopRegular: false for both promo keyframe lists, true for a phone-style 2 s GOP or too few keyframes', () => {
  assert.equal(C.gopRegular(LUMA.original.keyframes), false);
  assert.equal(C.gopRegular(LUMA.polished.keyframes), false);
  assert.equal(C.gopRegular(Array.from({ length: 25 }, (_, i) => i * 2)), true);
  assert.equal(C.gopRegular([0, 2, 4, 6, 7.3]), true, 'the last, cut-short gap doesn’t count');
  assert.equal(C.gopRegular([0, 10]), true);
});

test('synthetic series: a hard cut, a linear fade and an accelerating pan are told apart', () => {
  const L = [], H = [];
  const flat = (v, bin, n) => { for (let i = 0; i < n; i++) { L.push(v + (i % 3) * 0.02); const h = Array(16).fill(0); h[bin] = 1; H.push(h); } };
  flat(40, 2, 30); // 0–1 s
  flat(120, 7, 30); // hard cut at 1.0 s
  for (let i = 1; i <= 12; i++) { const v = 120 - i * 6; L.push(v); const h = Array(16).fill(0); h[Math.floor(v / 16)] = 1; H.push(h); } // 2.0–2.4 s fade to 48
  flat(48, 3, 30);
  for (let i = 1; i <= 20; i++) { L.push(48 + 0.004 * i ** 3); H.push(H[H.length - 1]); } // easing in, like the 36.5 s scroll
  flat(80, 3, 30); // same tones: the pan moved the picture, not the histogram
  const b = C.detectBoundaries(L, H, 30);
  assert.deepEqual(b.hard, [1]);
  assert.deepEqual(b.dissolves, [[2, 2.4]]);
  assert.deepEqual(b.screens, []);
  assert.deepEqual(C.findRamps(L).length, 1, 'the easing ramp is rejected as not steady');
});

test('cutsFrom: the stored shape, capped as validRemix expects', () => {
  const c = C.cutsFrom(LUMA.original);
  assert.deepEqual(Object.keys(c).sort(), ['dissolves', 'gopRegular', 'hard', 'keyframes', 'screens']);
  assert.equal(c.gopRegular, false);
  assert.ok(c.dissolves.length <= C.MAX.dissolves && c.screens.length <= C.MAX.screens);
  assert.deepEqual(C.cutsFrom({}), { hard: [], dissolves: [], screens: [], keyframes: [], gopRegular: true });
  assert.equal(C.histDistance([1, 0], [0, 1]), 1);
  assert.deepEqual(C.parseHist('ff00'), [1, 0]);
  assert.deepEqual(C.parseHist('zz'), []);
});
