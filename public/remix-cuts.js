// Video Remix: where the footage really changes, from a per-frame luma series (remix-render.js analyseSource measures
// mean luma and a 16-bin luma histogram on a 64 px wide copy of every frame). Pure and node-tested
// (tests/remix-cuts.test.mjs runs it on the promo reel's measured series in tests/fixtures/remix/promo-luma.json).
//   hard:      a one-frame jump in the histogram (≥ HARD_HIST of the frame's tones move) — a cut between shots.
//   dissolves: [a, b] windows where luma moves steadily one way for 6–24 frames by ≥ 12 % (fades, dips through black
//              and crossfades between scenes of different brightness). a is the first changed frame (an out-point there
//              keeps the last clean frame), b the first frame after the ramp.
//   screens:   smaller one-frame jumps — in a screen recording these are the app switching screens inside a scene, not
//              scene boundaries, so snapping ranks them last.
// Measured on promo/Atelier-promo-4x5.mp4: the scene changes are 0.3–0.4 s ramps (30.87–31.27, 38.07–38.43,
// 40.53–40.83 …) and the only big one-frame jumps (15.1 s, 35.8 s) are in-app screen changes.

export const CUT_TUNING = Object.freeze({
  spikeSigma: 4, // a jump is mean + 4σ of all frame-to-frame histogram distances…
  isolate: 0.5, // …and both neighbours move less than half as much (a ramp's frames all move alike)
  hardHist: 0.3, // a hard cut moves at least 30 % of the histogram; smaller jumps are screen changes
  rampStep: 0.15, // luma units a ramp moves per frame, at least
  rampMin: 6, rampMax: 24, // frames
  rampRel: 0.12, rampAbs: 2, // total change: ≥ 12 % of the brighter end and ≥ 2 luma units
  smooth: 2.2, // interior steps: max ≤ 2.2 × median (an easing scroll accelerates; a fade doesn't)
  cv: 0.5, // and their coefficient of variation ≤ 0.5
  mergeFrames: 3, // a ramp starting within 3 frames after a hard cut is that cut's fade-in, not its own boundary
});
export const MAX = Object.freeze({ hard: 300, dissolves: 100, screens: 300, keyframes: 600 });

/** A histogram as stored by the fixture script ('0a1b…', 2 hex chars a bin in 1/255ths) or an array of fractions. */
export function parseHist(h) {
  if (Array.isArray(h)) return h.map(Number);
  if (typeof h === 'string' && /^(?:[0-9a-f]{2})+$/i.test(h)) return h.match(/../g).map((x) => parseInt(x, 16) / 255);
  return [];
}
/** Half the L1 distance between two histograms of fractions: 0 (same tones) … 1 (nothing in common). */
export function histDistance(a, b) {
  const n = Math.min(a.length, b.length);
  let d = 0;
  for (let i = 0; i < n; i++) d += Math.abs(a[i] - b[i]);
  return d / 2;
}
const meanSd = (xs) => {
  if (!xs.length) return [0, 0];
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return [m, Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length)];
};
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
const r3 = (t) => Math.round(t * 1000) / 1000;

/** Steady one-way luma ramps → [{i, j}] in frames (steps i … j−1 changed; frame j is the first after). */
export function findRamps(luma, T = CUT_TUNING) {
  const L = luma.map(Number), out = [];
  let i = 1;
  while (i < L.length) {
    const s0 = L[i] - L[i - 1];
    if (!(Math.abs(s0) >= T.rampStep)) { i++; continue; }
    const sign = Math.sign(s0);
    let j = i;
    while (j < L.length && Math.sign(L[j] - L[j - 1]) === sign && Math.abs(L[j] - L[j - 1]) >= T.rampStep) j++;
    const n = j - i, total = Math.abs(L[j - 1] - L[i - 1]), rel = total / Math.max(L[j - 1], L[i - 1], 1e-6);
    if (n >= T.rampMin && n <= T.rampMax && total >= T.rampAbs && rel >= T.rampRel) {
      const steps = [];
      for (let k = i + 1; k < j - 1; k++) steps.push(Math.abs(L[k] - L[k - 1]));
      const med = median(steps), [m, sd] = meanSd(steps);
      if (steps.length < 2 || (Math.max(...steps) <= T.smooth * med && sd / (m || 1) <= T.cv)) out.push({ i, j });
    }
    i = j;
  }
  return out;
}

/**
 * luma: mean luma per frame; hist: per-frame histograms (parseHist forms); fps: the analysed frame rate.
 * → {hard: [s], dissolves: [[a, b]], screens: [s]} (times in seconds, ascending, capped at MAX).
 */
export function detectBoundaries(luma = [], hist = [], fps = 30, T = CUT_TUNING) {
  const f = Number(fps) > 0 ? Number(fps) : 30;
  const H = hist.map(parseHist);
  const n = Math.min(luma.length, H.length || luma.length);
  const dh = new Array(n).fill(0);
  for (let i = 1; i < n; i++) dh[i] = H.length ? histDistance(H[i], H[i - 1]) : Math.abs(luma[i] - luma[i - 1]) / 255;
  const [m, sd] = meanSd(dh.slice(1));
  const ramps = findRamps(luma.slice(0, n), T);
  const inRamp = (k) => ramps.some((r) => k >= r.i && k < r.j);
  const hard = [], screens = [];
  for (let k = 1; k < n; k++) {
    if (!(dh[k] > m + T.spikeSigma * sd) || inRamp(k)) continue;
    const prev = dh[k - 1], next = k + 1 < n ? dh[k + 1] : 0;
    if (prev > T.isolate * dh[k] || next > T.isolate * dh[k]) continue;
    (dh[k] >= T.hardHist ? hard : screens).push(k);
  }
  const dissolves = ramps.filter((r) => !hard.some((k) => r.i >= k && r.i - k <= T.mergeFrames)).map((r) => [r3(r.i / f), r3(r.j / f)]);
  return { hard: hard.map((k) => r3(k / f)).slice(0, MAX.hard), dissolves: dissolves.slice(0, MAX.dissolves), screens: screens.map((k) => r3(k / f)).slice(0, MAX.screens) };
}

/**
 * Keyframes every N seconds like clockwork (a phone camera or a fixed-GOP encoder) say nothing about the content;
 * irregular ones (an editor's export with scene-cut detection) sit on scene changes. True when the gaps' coefficient of
 * variation is under 0.1, or there are too few keyframes to tell.
 */
export function gopRegular(keyframes = []) {
  const k = [...keyframes].map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const gaps = k.slice(1).map((t, i) => t - k[i]).slice(0, -1); // the last gap is cut short by the clip's end
  if (gaps.length < 2) return true;
  const [m, sd] = meanSd(gaps);
  return m > 0 ? sd / m < 0.1 : true;
}

/** Everything snapPlan reads, in the shape e.remix.cuts stores (validRemix caps). */
export function cutsFrom({ luma = [], hist = [], fps = 30, keyframes = [] } = {}) {
  const b = detectBoundaries(luma, hist, fps);
  const kf = [...keyframes].map(Number).filter(Number.isFinite).map(r3).slice(0, MAX.keyframes);
  return { ...b, keyframes: kf, gopRegular: gopRegular(kf) };
}
