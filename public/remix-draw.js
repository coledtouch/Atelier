// Video Remix: drawing one output frame onto a 2D canvas — the source (or shot) frame through its crop, cards, covers,
// screenshots, the Tap cursor and text layers, then the dips and fades remix-graph.js frameAt() asks for. The SAME code
// draws the export (remix-render.js), Preview, the exact-frame row previews and card thumbnails, so what the review
// shows is what the cut gets. No ctx.filter (older Safari): blur is a downscale/upscale chain, glow is shadowBlur.
// Node-tested with a fake 2D context that records calls (tests/remix-draw.test.mjs); the DOM helpers at the bottom
// (grabFrame, padFrameAt) only run in a browser.
import { CARD_STYLES, ACCENTS, GLOW, BANDS, BRAND, padBox } from './remix.js?v=88';

export const FALLBACK_FAMILIES = Object.freeze({
  'Instrument Serif': "'Instrument Serif', 'Iowan Old Style', Georgia, serif",
  'Hanken Grotesk': "'Hanken Grotesk', ui-sans-serif, system-ui, sans-serif",
  'JetBrains Mono': "'JetBrains Mono', ui-monospace, 'Cascadia Code', monospace",
});
export const FONT_TIMEOUT = 3000;
const SCRIM = 'rgba(14,13,11,0.55)';
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** A canvas of w×h: OffscreenCanvas where there is one, else a <canvas>. Tests inject their own. */
export function makeCanvas(w, h) {
  const W = Math.max(1, Math.round(w)), H = Math.max(1, Math.round(h));
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(W, H);
  const c = globalThis.document?.createElement('canvas');
  if (!c) throw new Error('No canvas in this environment');
  c.width = W; c.height = H;
  return c;
}

/** The style a card or text line uses at output width W. → {font, color, tracking (px), upper, alpha, size, scrim}. */
export function styleFor(name, W = 1080, accent = 'lime') {
  const s = CARD_STYLES[name] || CARD_STYLES.body;
  const k = W / 1080, size = Math.round(s.size * k);
  const family = FALLBACK_FAMILIES[s.family] || s.family;
  return {
    font: `${s.italic ? 'italic ' : ''}${s.weight} ${size}px ${family}`,
    family: s.family, weight: s.weight, italic: Boolean(s.italic), size,
    color: s.color === 'accent' ? ACCENTS[accent] || ACCENTS.lime : s.color,
    tracking: s.tracking ? s.tracking * size : 0, upper: Boolean(s.upper), alpha: s.alpha ?? 1, scrim: s.scrim ?? 0,
  };
}

/** Every (style, text) a plan draws: cards' lines and text layers' lines. */
export function fontsUsed(plan) {
  const out = [];
  for (const c of plan?.timeline || []) if (c.type === 'card') for (const l of c.lines || []) out.push(l);
  for (const o of plan?.overlays || []) if (o.kind === 'text') for (const l of o.lines || []) out.push(l);
  return out;
}
/**
 * Awaits document.fonts.load() for each face the plan uses, with its real text. → 'studio' (all loaded) or 'fallback'
 * (timed out or unavailable: the app.css fallback stacks draw instead). opts: {fonts (a FontFaceSet), timeout}.
 */
export async function ensureFonts(plan, { fonts = globalThis.document?.fonts, timeout = FONT_TIMEOUT } = {}) {
  if (!fonts?.load) return 'fallback';
  const faces = new Map();
  for (const l of fontsUsed(plan)) {
    const s = CARD_STYLES[l.style] || CARD_STYLES.body;
    const key = `${s.italic ? 'italic ' : ''}${s.weight} 40px "${s.family}"`;
    faces.set(key, (faces.get(key) || '') + (l.text || ''));
  }
  if (!faces.size) return 'studio';
  let timer;
  const late = new Promise((res) => { timer = setTimeout(() => res('fallback'), timeout); });
  const load = Promise.all([...faces].map(([f, text]) => fonts.load(f, text.slice(0, 200) || 'Aa'))).then((lists) => (lists.every((l) => !Array.isArray(l) || l.length) ? 'studio' : 'fallback'), () => 'fallback');
  try { return await Promise.race([load, late]); } finally { clearTimeout(timer); }
}

// ── text ──
const setFont = (ctx, st) => {
  ctx.font = st.font;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${st.tracking}px`;
};
/** Greedy word wrap to maxWidth. */
export function wrapText(ctx, text, maxWidth) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && ctx.measureText(next).width > maxWidth) { lines.push(cur); cur = w; } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}
/** Lays out styled lines (wrapped) → {rows: [{text, st, h}], height, width}. */
export function layoutLines(ctx, lines, W, accent, maxWidth = W * 0.84) {
  const rows = [];
  let height = 0, width = 0;
  for (const l of lines || []) {
    const st = styleFor(l.style, W, accent);
    setFont(ctx, st);
    const text = st.upper ? String(l.text).toUpperCase() : String(l.text);
    for (const t of wrapText(ctx, text, maxWidth)) {
      const h = Math.round(st.size * (l.style?.startsWith('headline') ? 1.04 : 1.3));
      rows.push({ text: t, st, h, glow: l.glow === true });
      width = Math.max(width, ctx.measureText(t).width);
      height += h;
    }
  }
  return { rows, height, width };
}
// One row of text, centred on cx with its top at y; glow first (a cyan halo through shadowBlur), then the crisp text.
function fillRow(ctx, row, cx, y, alpha, W) {
  setFont(ctx, row.st);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  if (row.glow) {
    ctx.save();
    ctx.globalAlpha = alpha * GLOW.alpha;
    ctx.shadowColor = GLOW.color;
    ctx.shadowBlur = GLOW.sigma * 2 * (W / 1080);
    ctx.fillStyle = GLOW.color;
    ctx.fillText(row.text, cx, y);
    ctx.restore();
  }
  ctx.globalAlpha = alpha * row.st.alpha;
  ctx.fillStyle = row.st.color;
  ctx.fillText(row.text, cx, y);
}

// ── blur (downscale / upscale chain) ──
/** Draws img's (sx, sy, sw, sh) blurred into ctx at (dx, dy, dw, dh). factor: how far it is scaled down (≥ 2). */
export function drawBlurred(ctx, img, src, dst, { factor = 12, mk = makeCanvas } = {}) {
  const [sx, sy, sw, sh] = src, [dx, dy, dw, dh] = dst;
  let w = Math.max(1, Math.round(dw / factor)), h = Math.max(1, Math.round(dh / factor));
  const a = mk(Math.max(w, Math.round(dw / 2)), Math.max(h, Math.round(dh / 2)));
  const actx = a.getContext('2d');
  actx.imageSmoothingEnabled = true;
  actx.drawImage(img, sx, sy, sw, sh, 0, 0, Math.max(w, Math.round(dw / 2)), Math.max(h, Math.round(dh / 2)));
  // halve until small, then grow back: each pass is a cheap box filter
  let cw = a.width, ch = a.height;
  while (cw / 2 >= w && ch / 2 >= h) {
    actx.drawImage(a, 0, 0, cw, ch, 0, 0, Math.max(1, cw >> 1), Math.max(1, ch >> 1));
    cw = Math.max(1, cw >> 1); ch = Math.max(1, ch >> 1);
  }
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(a, 0, 0, cw, ch, dx, dy, dw, dh);
  ctx.restore();
}

// ── frames ──
/**
 * One decoded frame through its crop into the whole W×H output. img: a Mediabunny VideoSample (drawWithFit applies the
 * track's rotation, crop in display pixels) or any CanvasImageSource already upright. crop: remix.js cropFor output.
 */
export function drawFrame(ctx, img, crop, W, H) {
  if (!img) { ctx.fillStyle = BRAND; ctx.fillRect(0, 0, W, H); return; }
  if (typeof img.drawWithFit === 'function') {
    img.drawWithFit(ctx, { fit: 'fill', ...(crop ? { crop: { left: crop.sx, top: crop.sy, width: crop.sw, height: crop.sh } } : {}) });
    return;
  }
  if (crop) ctx.drawImage(img, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, W, H);
  else ctx.drawImage(img, 0, 0, W, H);
}

/**
 * A card. card: graph item card {backdrop, lines, motion, accent}; state: frameAt's {scale, textAlpha};
 * backdrop: the source still at backdrop.t (any CanvasImageSource or VideoSample), crop: its crop. cache: a Map that keeps
 * the blurred backdrop between frames (key: the card id).
 */
export function drawCard(ctx, { W, H, id = 'card', card, state = { scale: 1, textAlpha: 1 }, backdrop = null, crop = null, cache = null, mk = makeCanvas }) {
  const kind = card?.backdrop?.kind || 'brand';
  ctx.save();
  ctx.fillStyle = BRAND;
  ctx.fillRect(0, 0, W, H);
  if (kind !== 'brand' && backdrop) {
    const s = state.scale || 1;
    ctx.translate(W / 2, H / 2); ctx.scale(s, s); ctx.translate(-W / 2, -H / 2);
    if (kind === 'frame') drawFrame(ctx, backdrop, crop, W, H);
    else {
      let blurred = cache?.get(`blur:${id}`);
      if (!blurred) {
        const flat = mk(W, H), fctx = flat.getContext('2d');
        drawFrame(fctx, backdrop, crop, W, H);
        blurred = mk(W, H);
        drawBlurred(blurred.getContext('2d'), flat, [0, 0, W, H], [0, 0, W, H], { factor: 16, mk });
        cache?.set(`blur:${id}`, blurred);
      }
      ctx.drawImage(blurred, 0, 0, W, H);
      ctx.setTransform?.(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = 'rgba(14,13,11,0.45)';
      ctx.fillRect(0, 0, W, H);
    }
  }
  ctx.restore();
  const lines = card?.lines || [];
  if (!lines.length || !(state.textAlpha > 0)) return;
  ctx.save();
  const lay = layoutLines(ctx, lines, W, card?.accent || 'lime');
  let y = Math.round((H - lay.height) / 2);
  for (const row of lay.rows) { fillRow(ctx, row, W / 2, y, clamp01(state.textAlpha), W); y += row.h; }
  ctx.restore();
}

/** Where a layer's band or box sits in pixels. box/band on the 0–1000 grid. */
export const gridRect = (b, W, H) => ({ x: (b[1] / 1000) * W, y: (b[0] / 1000) * H, w: ((b[3] - b[1]) / 1000) * W, h: ((b[2] - b[0]) / 1000) * H });

/** A text layer: lines in its band (BANDS[position]), centred; optional scrim; drift moves it by dy px. */
export function drawText(ctx, layer, { W, H, alpha = 1, dy = 0, accent = 'lime' }) {
  if (!(alpha > 0) || !layer?.lines?.length) return;
  const band = BANDS[layer.position] || BANDS.lower;
  ctx.save();
  const lay = layoutLines(ctx, layer.lines, W, accent);
  const top = (band[0] / 1000) * H, bottom = (band[1] / 1000) * H;
  let y = Math.round(top + (bottom - top - lay.height) / 2 + dy);
  const scrim = layer.scrim || lay.rows.some((r) => r.st.scrim > 0);
  if (scrim) {
    const pad = Math.round(22 * (W / 1080));
    ctx.globalAlpha = alpha;
    ctx.fillStyle = SCRIM;
    roundRect(ctx, W / 2 - lay.width / 2 - pad, y - pad * 0.6, lay.width + pad * 2, lay.height + pad * 1.2, pad * 0.7);
    ctx.fill();
  }
  for (const row of lay.rows) { fillRow(ctx, row, W / 2, y, alpha, W); y += row.h; }
  ctx.restore();
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') { ctx.roundRect(x, y, w, h, r); return; }
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/** The average colour of a 1-px ring just outside the rect, per side → {top, bottom, left, right} as [r, g, b]. */
export function ringColors(data, cw, ch, x, y, w, h) {
  const px = (xx, yy) => { const i = (Math.min(ch - 1, Math.max(0, yy)) * cw + Math.min(cw - 1, Math.max(0, xx))) * 4; return [data[i], data[i + 1], data[i + 2]]; };
  const avg = (pts) => { const s = [0, 0, 0]; for (const p of pts) { s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; } return s.map((v) => Math.round(v / Math.max(1, pts.length))); };
  const step = Math.max(1, Math.floor(Math.max(w, h) / 64));
  const top = [], bottom = [], left = [], right = [];
  for (let i = x; i < x + w; i += step) { top.push(px(i, y - 1)); bottom.push(px(i, y + h)); }
  for (let j = y; j < y + h; j += step) { left.push(px(x - 1, j)); right.push(px(x + w, j)); }
  return { top: avg(top), bottom: avg(bottom), left: avg(left), right: avg(right) };
}
const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
/**
 * A cover hides a box: 'brand' (solid), 'blur' (the box's own pixels blurred) or 'match' (a gradient from the colours
 * around it, feathered 6 px). Draws over what is already on ctx.
 */
export function drawCover(ctx, layer, { W, H, alpha = 1, mk = makeCanvas }) {
  if (!(alpha > 0) || !layer?.box) return;
  const r = gridRect(layer.box, W, H);
  const x = Math.round(r.x), y = Math.round(r.y), w = Math.max(1, Math.round(r.w)), h = Math.max(1, Math.round(r.h));
  const f = Math.round(6 * (W / 1080));
  ctx.save();
  ctx.globalAlpha = alpha;
  if (layer.fill === 'brand') { ctx.fillStyle = BRAND; ctx.fillRect(x, y, w, h); }
  else if (layer.fill === 'match' && typeof ctx.getImageData === 'function') {
    const gx = Math.max(0, x - 1), gy = Math.max(0, y - 1), gw = Math.min(W - gx, w + 2), gh = Math.min(H - gy, h + 2);
    const img = ctx.getImageData(gx, gy, gw, gh);
    const ring = ringColors(img.data, gw, gh, x - gx, y - gy, w, h);
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, rgb(ring.top)); g.addColorStop(1, rgb(ring.bottom));
    ctx.fillStyle = g;
    ctx.shadowColor = rgb(ring.top); ctx.shadowBlur = f;
    ctx.fillRect(x, y, w, h);
  } else {
    // blur: the box's own pixels, plus a feather of its neighbours
    const src = ctx.canvas;
    if (src) drawBlurred(ctx, src, [Math.max(0, x - f), Math.max(0, y - f), w + 2 * f, h + 2 * f], [x - f, y - f, w + 2 * f, h + 2 * f], { factor: 10, mk });
    else { ctx.fillStyle = BRAND; ctx.fillRect(x, y, w, h); }
  }
  ctx.restore();
}

/** A screenshot in its box (or centred at 62 % width), contained, rounded, with a soft shadow. */
export function drawImageLayer(ctx, layer, img, { W, H, alpha = 1 }) {
  if (!(alpha > 0) || !img) return;
  const iw = img.width || img.displayWidth || 1, ih = img.height || img.displayHeight || 1;
  const box = layer?.box ? gridRect(layer.box, W, H) : { x: W * 0.19, y: H * 0.2, w: W * 0.62, h: H * 0.6 };
  const k = Math.min(box.w / iw, box.h / ih), w = iw * k, h = ih * k;
  const x = box.x + (box.w - w) / 2, y = box.y + (box.h - h) / 2, r = 18 * (W / 1080);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 40 * (W / 1080); ctx.shadowOffsetY = 12 * (W / 1080);
  roundRect(ctx, x, y, w, h, r);
  ctx.fillStyle = BRAND; ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.clip();
  ctx.drawImage(img, x, y, w, h);
  ctx.restore();
}

/** The built-in Tap: a cursor at layer.point with a pulse ring that grows every 0.9 s. local: seconds into the layer. */
export function drawTap(ctx, layer, { W, H, alpha = 1, local = 0 }) {
  if (!(alpha > 0)) return;
  const [py, px] = layer?.point || [500, 500];
  const x = (px / 1000) * W, y = (py / 1000) * H, k = W / 1080;
  const phase = (local % 0.9) / 0.9;
  ctx.save();
  ctx.globalAlpha = alpha * (1 - phase) * 0.9;
  ctx.strokeStyle = ACCENTS.ivory; ctx.lineWidth = 4 * k;
  ctx.beginPath(); ctx.arc(x, y, (18 + 46 * phase) * k, 0, Math.PI * 2); ctx.stroke();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = 'rgba(236,230,217,0.35)';
  ctx.beginPath(); ctx.arc(x, y, 16 * k, 0, Math.PI * 2); ctx.fill();
  // arrow cursor, tip on the point
  ctx.fillStyle = ACCENTS.ivory; ctx.strokeStyle = BRAND; ctx.lineWidth = 3 * k;
  ctx.beginPath();
  ctx.moveTo(x, y); ctx.lineTo(x, y + 52 * k); ctx.lineTo(x + 13 * k, y + 40 * k); ctx.lineTo(x + 23 * k, y + 62 * k);
  ctx.lineTo(x + 32 * k, y + 58 * k); ctx.lineTo(x + 22 * k, y + 37 * k); ctx.lineTo(x + 38 * k, y + 36 * k);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.restore();
}

/**
 * One whole output frame. gf: remix-graph frameAt(g, k); g: the graph; sources: {frames: {[itemId]: image} (each draw's
 * decoded frame: a source/shot frame, or a card's backdrop still), images: {[layerId]: image} (screenshots)};
 * opts: {cache (a Map kept across frames), mk, accent}. Draw order: draws (with their alpha), dip, layers.
 */
export function composeFrame(ctx, gf, g, sources = {}, opts = {}) {
  const W = g.w, H = g.h, frames = sources.frames || {}, images = sources.images || {};
  const items = opts.itemMap || new Map(g.items.map((it) => [it.id, it]));
  const layers = opts.layerMap || new Map(g.layers.map((l) => [l.id, l]));
  const accent = opts.accent || g.items.find((it) => it.card)?.card?.accent || 'lime';
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.fillStyle = g.background || BRAND;
  ctx.fillRect(0, 0, W, H);
  for (const d of gf.draws) {
    const it = items.get(d.id);
    if (!it) continue;
    ctx.globalAlpha = clamp01(d.alpha);
    if (d.type === 'card') {
      ctx.save();
      ctx.globalAlpha = clamp01(d.alpha);
      drawCard(ctx, { W, H, id: it.id, card: it.card, state: d.card, backdrop: frames[d.id] || null, crop: it.crop || null, cache: opts.cache || null, mk: opts.mk || makeCanvas });
      ctx.restore();
    } else drawFrame(ctx, frames[d.id] || null, it.crop || null, W, H);
  }
  ctx.globalAlpha = 1;
  if (gf.dip > 0) { ctx.globalAlpha = clamp01(gf.dip); ctx.fillStyle = BRAND; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1; }
  for (const lf of gf.layers) {
    const l = layers.get(lf.id);
    if (!l) continue;
    if (l.kind === 'cover') drawCover(ctx, l, { W, H, alpha: lf.alpha, mk: opts.mk || makeCanvas });
    else if (l.kind === 'image') {
      if (l.asset === 'tap') drawTap(ctx, l, { W, H, alpha: lf.alpha, local: lf.local });
      else drawImageLayer(ctx, l, images[l.id] || null, { W, H, alpha: lf.alpha });
    } else if (l.kind === 'text') drawText(ctx, l, { W, H, alpha: lf.alpha, dy: lf.dy, accent });
  }
  ctx.restore();
}

/** A card thumbnail (the review's story rows): w px wide at the output's aspect. → the canvas. */
export function cardThumb(card, { w = 216, aspect = 1350 / 1080, backdrop = null, crop = null, accent = 'lime', mk = makeCanvas } = {}) {
  const W = Math.round(w), H = Math.round(w * aspect);
  const c = mk(W, H), ctx = c.getContext('2d');
  // draw at 1080 scale maths but W wide: styleFor scales by W/1080
  drawCard(ctx, { W, H, card: { ...card, accent }, state: { scale: 1, textAlpha: 1 }, backdrop, crop, mk });
  return c;
}

/**
 * The still a shot starts from: the source frame contained in the provider's shape (firstFrameShape) with blurred
 * bands filling the rest. frame: an upright CanvasImageSource (w, h). → the canvas.
 */
export function padFrame(frame, shape = { w: 720, h: 1280 }, { mk = makeCanvas } = {}) {
  const fw = frame.width || frame.videoWidth || frame.displayWidth, fh = frame.height || frame.videoHeight || frame.displayHeight;
  const box = padBox(fw, fh, shape.w, shape.h);
  const c = mk(shape.w, shape.h), ctx = c.getContext('2d');
  ctx.fillStyle = BRAND; ctx.fillRect(0, 0, shape.w, shape.h);
  if (!box) return c;
  // the bands: the frame itself, covering the whole canvas, blurred
  const k = Math.max(shape.w / fw, shape.h / fh), cw = fw * k, ch = fh * k;
  drawBlurred(ctx, frame, [0, 0, fw, fh], [(shape.w - cw) / 2, (shape.h - ch) / 2, cw, ch], { factor: 18, mk });
  ctx.fillStyle = 'rgba(14,13,11,0.25)'; ctx.fillRect(0, 0, shape.w, shape.h);
  ctx.drawImage(frame, 0, 0, fw, fh, box.x, box.y, box.w, box.h);
  return c;
}

// ── browser-only helpers ──
/** A canvas → a JPEG data URL (OffscreenCanvas via convertToBlob). */
export async function canvasToDataUrl(c, quality = 0.86, type = 'image/jpeg') {
  if (typeof c.toDataURL === 'function') return c.toDataURL(type, quality);
  const blob = await c.convertToBlob({ type, quality });
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
}
/**
 * The upright frame of a video File/Blob (or blob: URL) at t seconds, via a <video> element (the browser applies the
 * rotation), as a canvas at most maxEdge on its long side. For previews and first frames — never the export.
 */
export async function grabFrame(src, t = 0, { maxEdge = 1280, timeout = 8000, doc = globalThis.document } = {}) {
  const url = typeof src === 'string' ? src : URL.createObjectURL(src);
  const v = doc.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
  const wait = (ev) => new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('The video didn’t answer in time')), timeout);
    v.addEventListener(ev, () => { clearTimeout(timer); res(); }, { once: true });
    v.addEventListener('error', () => { clearTimeout(timer); rej(new Error('This browser can’t read that video')); }, { once: true });
  });
  try {
    if (v.readyState < 1) await wait('loadedmetadata');
    const target = Math.min(Math.max(0, t), Math.max(0, (v.duration || t) - 0.04));
    if (Math.abs(v.currentTime - target) > 1e-3 || v.readyState < 2) { v.currentTime = target; await wait('seeked'); }
    const k = Math.min(1, maxEdge / Math.max(v.videoWidth, v.videoHeight));
    const c = makeCanvas(v.videoWidth * k, v.videoHeight * k);
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    return c;
  } finally {
    v.removeAttribute('src'); v.load?.();
    if (typeof src !== 'string') URL.revokeObjectURL(url);
  }
}
/** The integration doc's name for grabFrame (rotation is the browser's: <video> draws upright). */
export const frameAt = (file, t, _rotation = 0, opts) => grabFrame(file, t, opts);
/** padFrame of the source at t → a JPEG data URL for shotRequest's image. */
export async function padFrameAt(file, t, shape, opts = {}) {
  const frame = await grabFrame(file, t, { maxEdge: Math.max(shape.w, shape.h), ...opts });
  return canvasToDataUrl(padFrame(frame, shape), 0.9);
}
