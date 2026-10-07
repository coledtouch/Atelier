// Video Remix: the render graph — a plan's layout turned into exactly what each output frame draws and which audio
// goes out, so remix-render.js (WebCodecs + Mediabunny, or the real-time recorder) and remix-draw.js only decode,
// draw and encode. Pure and deterministic (tests/remix-graph.test.mjs): the same graph drives the export, Preview
// (half size, 15 fps) and the exact-frame row previews.
//
// Time model: output frame k is at t = k / fps. Each layout item covers [outStart, outEnd) of output time and maps it
// to its own media clock (source seconds, seconds into a shot, seconds into a card). Transitions:
//   dip  — 0.2 s through the brand colour centred on the cut (the outgoing item to the cut, the incoming after it);
//   fade — a 0.33 s crossfade centred on the cut using handles (media beyond the out / before the in; layout() only
//          keeps 'fade' where those exist).
// Layers draw in the order cover → image → text, with their fades; text drift is px per second at 1080 wide.
import { cropFor, FADES, BRAND } from './remix.js?v=77';

const r6 = (t) => Math.round(t * 1e6) / 1e6;
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const LAYER_ORDER = { cover: 0, image: 1, text: 2 };

/**
 * lay: remix.js layout() output; plan: the settled plan (for cards, shots and audio); ctx: {fps, out: {w, h},
 * source: {width, height, rotation, duration}, shots: {[shotId]: {width, height}} (decoded size of each filmed shot)}.
 * → {fps, frames, w, h, duration, items[], transitions[], layers[], audio}.
 */
export function buildGraph(lay, plan, ctx = {}) {
  const fps = Number(ctx.fps) > 0 ? Number(ctx.fps) : 30;
  const w = ctx.out?.w || 1080, h = ctx.out?.h || 1350;
  const src = ctx.source || {};
  const cards = new Map((plan?.timeline || []).filter((c) => c.type === 'card').map((c) => [c.id, c]));
  const items = (lay?.items || []).map((it) => {
    const g = { id: it.id, type: it.type, outStart: it.outStart, outEnd: it.outEnd, mediaIn: it.mediaIn, mediaOut: it.mediaOut, enter: it.enter };
    if (it.type === 'source') g.crop = cropFor(src.width, src.height, w, h, src.rotation || 0);
    if (it.type === 'shot') {
      const sz = ctx.shots?.[it.shot] || {};
      g.shot = it.shot;
      g.crop = cropFor(sz.width || 720, sz.height || 1280, w, h, 0);
    }
    if (it.type === 'card') {
      const c = cards.get(it.id) || {};
      g.card = { backdrop: c.backdrop || { kind: 'brand' }, lines: c.lines || [], motion: c.motion || 'none', accent: plan?.style?.accent || 'lime' };
      if (c.backdrop && c.backdrop.kind !== 'brand') g.crop = cropFor(src.width, src.height, w, h, src.rotation || 0);
    }
    return g;
  });
  const transitions = [];
  items.forEach((it, i) => {
    if (i === 0 && it.enter !== 'cut') transitions.push({ kind: 'dip', at: 0, start: 0, end: FADES.dip / 2, from: null, to: it.id });
    if (i === 0 || it.enter === 'cut') return;
    const prev = items[i - 1], half = (it.enter === 'fade' ? FADES.fade : FADES.dip) / 2;
    transitions.push({ kind: it.enter, at: it.outStart, start: r6(Math.max(prev.outStart, it.outStart - half)), end: r6(Math.min(it.outEnd, it.outStart + half)), from: prev.id, to: it.id });
  });
  const layers = (lay?.layers || []).map((l) => {
    const f = l.kind === 'text' ? FADES.text : l.kind === 'image' ? FADES.image : { in: 0, out: 0 };
    return { ...l, fadeIn: f.in, fadeOut: f.out };
  }).sort((a, b) => LAYER_ORDER[a.kind] - LAYER_ORDER[b.kind]);
  const duration = lay?.duration || 0;
  return { fps, frames: Math.round(duration * fps), w, h, duration, background: BRAND, items, transitions, layers, audio: audioPlan(lay, plan, src.duration) };
}

const itemAt = (g, t) => {
  for (let i = 0; i < g.items.length; i++) if (t < g.items[i].outEnd - 1e-9) return g.items[i];
  return g.items[g.items.length - 1] || null;
};
// media time of item `it` at output time t (may run past its in/out inside a fade: those are its handles)
const mediaAt = (it, t) => r6(it.mediaIn + (t - it.outStart));
/** A card's own animation at output time t: push-in scale and the text fade. */
function cardState(it, t) {
  const local = t - it.outStart, len = it.outEnd - it.outStart;
  const scale = it.card?.motion === 'push' ? 1 + 0.04 * clamp01(local / Math.max(len, 1e-6)) : 1;
  const alpha = Math.min(clamp01(local / FADES.card.in), clamp01((len - local) / FADES.card.out));
  return { scale: r6(scale), textAlpha: r6(alpha), local: r6(local) };
}

/**
 * What output frame k shows → {k, t, draws:[{id, type, media, alpha, shot?, card?}], dip (0–1 of the brand colour
 * over everything), layers:[{id, kind, alpha, local, dy}]}. Draw order: draws in order, then the dip, then layers.
 */
export function frameAt(g, k) {
  const t = r6(k / g.fps);
  const it = itemAt(g, t);
  if (!it) return { k, t, draws: [], dip: 1, layers: [] };
  const draw = (x, alpha) => ({ id: x.id, type: x.type, media: mediaAt(x, t), alpha: r6(alpha), ...(x.shot ? { shot: x.shot } : {}), ...(x.type === 'card' ? { card: cardState(x, t) } : {}) });
  let draws = [draw(it, 1)], dip = 0;
  for (const tr of g.transitions) {
    if (t < tr.start - 1e-9 || t >= tr.end - 1e-9) continue;
    if (tr.kind === 'dip') {
      // up to the cut: fade the outgoing item into the brand colour; after it: out of it into the incoming one
      const half = tr.from ? (tr.end - tr.start) / 2 : tr.end - tr.start;
      dip = Math.max(dip, tr.from ? 1 - Math.abs(t - tr.at) / half : 1 - (t - tr.start) / half);
    } else {
      const a = clamp01((t - tr.start) / (tr.end - tr.start));
      const from = g.items.find((x) => x.id === tr.from), to = g.items.find((x) => x.id === tr.to);
      draws = [draw(from, 1), draw(to, a)];
    }
  }
  const layers = [];
  for (const l of g.layers) {
    if (t < l.outStart - 1e-9 || t >= l.outEnd - 1e-9) continue;
    const local = t - l.outStart, len = l.outEnd - l.outStart;
    const alpha = Math.min(l.fadeIn ? clamp01(local / l.fadeIn) : 1, l.fadeOut ? clamp01((len - local) / l.fadeOut) : 1);
    layers.push({ id: l.id, kind: l.kind, alpha: r6(alpha), local: r6(local), dy: r6((Number(l.drift_y) || 0) * local * (g.w / 1080)) });
  }
  return { k, t, draws, dip: r6(clamp01(dip)), layers };
}

/**
 * The media timestamps each item needs, ascending (one per output frame it is drawn in, handles included) — what a
 * decoder's samplesAtTimestamps() takes, so one decoder stays warm per item. → {[itemId]: number[]}.
 */
export function sampleTimes(g) {
  const out = {};
  for (let k = 0; k < g.frames; k++) {
    for (const d of frameAt(g, k).draws) {
      if (d.type === 'card' && !g.items.find((x) => x.id === d.id)?.card?.backdrop?.kind?.startsWith('frame')) continue;
      const list = out[d.id] || (out[d.id] = []);
      const m = d.type === 'card' ? g.items.find((x) => x.id === d.id).card.backdrop.t : d.media;
      if (!list.length || m > list[list.length - 1]) list.push(m);
    }
  }
  return out;
}

/**
 * Audio for the export.
 *   keep:        {mode:'copy', end: D} — the source's own packets, timestamps untouched (AAC priming included); drop only
 *                packets at or after D, interleaved so every packet with pts < T + lead goes in before frame T.
 *   follow_cuts: {mode:'mix', segments:[{kind:'source'|'silence'|'shot', outStart, outEnd, mediaIn?, mediaOut?, shot?,
 *                gainDb}], ramp, snap} — cut points move to the quietest 10 ms within ±snap and get ramp-long fades.
 */
export function audioPlan(lay, plan, D) {
  const mode = plan?.audio?.mode || 'keep';
  if (mode === 'keep') return { mode: 'copy', end: Number(D) > 0 ? Number(D) : lay?.duration || 0, lead: 0.5 };
  const segments = (lay?.items || []).map((it) => {
    if (it.type === 'source') return { kind: 'source', outStart: it.outStart, outEnd: it.outEnd, mediaIn: it.mediaIn, mediaOut: it.mediaOut, gainDb: 0 };
    if (it.type === 'shot' && plan?.audio?.inserts === 'shot') return { kind: 'shot', shot: it.shot, outStart: it.outStart, outEnd: it.outEnd, mediaIn: it.mediaIn, mediaOut: it.mediaOut, gainDb: -6 };
    return { kind: 'silence', outStart: it.outStart, outEnd: it.outEnd, gainDb: 0 };
  });
  return { mode: 'mix', segments, ramp: 0.02, snap: 0.15, window: 0.01 };
}
/** Keep mode: which of the source's audio packets go out (pts in seconds, priming packets before 0 included). */
export const keepPackets = (pts, D) => pts.filter((p) => Number.isFinite(p) && p < D - 1e-9);
