// Video attachments: shared limits and pure helpers (node-tested), the browser frame sampler and the chunked
// Gemini clip uploader. Nothing here touches the DOM at import time — app.js, data-safety.js and tests import it.

// ── shared constants (src/gemini.js keeps its own copies; tests/video.test.mjs checks they match) ──
export const GEMINI_VIDEO_MIMES = new Set(['video/mp4', 'video/mpeg', 'video/quicktime', 'video/avi', 'video/x-flv', 'video/mpg', 'video/webm', 'video/wmv', 'video/3gpp']);
export const CLIP_MAX_BYTES = 1073741824, CLIP_MAX_SECONDS = 600, CHUNK_NOMINAL = 16777216, CHUNK_MAX = 33554432,
  GRANULARITY_DEFAULT = 8388608, LOCAL_MAX_BYTES = 4294967296, FILE_EXPIRY_MARGIN_MS = 900000, CLIP_POLL_MS = 2000, CLIP_POLL_MAX_MS = 180000;
export const MAX_FRAMES = 16, FRAME_EDGE = 768, FRAME_MAX_BYTES = 90_000, POSTER_EDGE = 320, POSTER_MAX_BYTES = 40_000, CHUNK_RETRIES = 6;
// Waits for the sampler and uploader (ms). Mutable so tests can shrink them. total counts visible time only.
// request: start/query/poll/cancel/delete calls; stall: no upload progress; answer: no reply after the last byte;
// retry…retryMax: chunk backoff (doubling, capped); offline: longest wait for the 'online' event before a retry.
export const VIDEO_TIMING = { meta: 10000, probe: 3000, warm: 1500, seek: 4000, frame: 300, settle: 100, blank: 150, total: 60000,
  poll: CLIP_POLL_MS, pollMax: CLIP_POLL_MAX_MS, retry: 1000, retryMax: 15000, request: 20000, stall: 45000, answer: 60000, offline: 60000 };
export const VIDEO_MIME_RE = /^video\/[\w.+-]{1,40}$/;
const FILE_NAME_RE = /^files\/[\w-]{1,80}$/, FILE_URI_RE = /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/files\/[\w-]{1,80}$/;
const MIME_ALIAS = new Map([['video/x-m4v', 'video/mp4'], ['video/mov', 'video/quicktime'], ['video/x-msvideo', 'video/avi'], ['video/x-ms-wmv', 'video/wmv']]);
const EXT_MIME = new Map([['mp4', 'video/mp4'], ['m4v', 'video/mp4'], ['mov', 'video/quicktime'], ['qt', 'video/quicktime'], ['webm', 'video/webm'],
  ['3gp', 'video/3gpp'], ['avi', 'video/avi'], ['mkv', 'video/x-matroska']]);
const extOf = name => String(name || '').match(/\.([a-z\d]{1,5})$/i)?.[1].toLowerCase();
const num = v => Number.isFinite(v) && v >= 0;
const record = v => v && typeof v === 'object' && !Array.isArray(v);
const safeImageData = v => typeof v === 'string' && /^data:image\/(png|jpe?g|webp);base64,[a-z\d+/=\s]+$/i.test(v);

// ── pure helpers ──
// Lowercase, no ;params, common aliases folded; an empty type falls back to the file extension ('' when unknown).
export function normalizeVideoMime(type, fileName = '') {
  const t = String(type || '').split(';')[0].trim().toLowerCase();
  return t ? MIME_ALIAS.get(t) || t : EXT_MIME.get(extOf(fileName)) || '';
}
export const isVideoFile = f => Boolean(f) && (/^video\//i.test(f.type || '') || !f.type && EXT_MIME.has(extOf(f.name)));
// Display/persisted file name: no control or bidi-override characters, at most 120 UTF-16 units.
export const cleanName = name => typeof name === 'string'
  ? name.replace(/[\p{Cc}‎‏‪-‮⁦-⁩]/gu, '').trim().slice(0, 120).replace(/[\ud800-\udbff]$/, '') : '';
export const isFileName = n => typeof n === 'string' && FILE_NAME_RE.test(n);
export const isGeminiFileUri = u => typeof u === 'string' && FILE_URI_RE.test(u);
export const frameCount = d => !(d > 0 && Number.isFinite(d)) ? 8 : d < 2 ? 4 : Math.min(16, Math.max(6, Math.ceil(d / 2.5)));
// Evenly spaced sample times inside [0, d); strictly increasing (very short clips may yield fewer than n).
export function frameTimes(d, n = frameCount(d)) {
  if (!(d > 0 && Number.isFinite(d)) || !(n >= 1)) return [];
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = Math.max(0, Math.min(d - 0.05, d * (i + 0.5) / n));
    if (!out.length || t > out[out.length - 1]) out.push(t);
  }
  return out;
}
// 'm:ss', or 'h:mm:ss' from an hour; '' for 0, negative, NaN or Infinity.
export function fmtDur(s) {
  if (!(s > 0 && Number.isFinite(s))) return '';
  const x = Math.round(s), h = Math.floor(x / 3600), m = Math.floor(x / 60) % 60, ss = String(x % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
// Slot order for the sampler: both ends, then midpoints level by level (6 → 0,5,2,1,3,4), so a run that stops early
// still spans the whole clip. A permutation of 0…n-1.
export function sampleOrder(n) {
  const out = n > 0 ? [0] : [];
  if (n > 1) out.push(n - 1);
  for (let spans = [[0, n - 1]]; spans.length;) {
    const next = [];
    for (const [a, b] of spans) if (b - a > 1) { const m = (a + b) >> 1; out.push(m); next.push([a, m], [m, b]); }
    spans = next;
  }
  return out;
}
// Evenly thins frames down to cap, always keeping the first and the last.
export function pickFrames(frames, cap = MAX_FRAMES) {
  const list = Array.isArray(frames) ? frames : [], n = Math.max(0, Math.floor(cap) || 0);
  if (list.length <= n) return list.slice();
  if (n <= 1) return list.slice(0, n);
  return Array.from({ length: n }, (_, i) => list[Math.round(i * (list.length - 1) / (n - 1))]);
}
// Accepts a provider ('gemini') or a model id ('gemini:gemini-3.8-flash'); unprefixed ids are NVIDIA → 8.
export const frameCapFor = provider => ['gemini', 'anthropic', 'openai'].includes(String(provider || '').split(':')[0]) ? 16 : 8;
// Why a video can't go to Gemini as a full clip: 'type' | 'empty' | 'too-large' | 'too-long', or null when it can.
export function clipReason(v) {
  if (!v || !GEMINI_VIDEO_MIMES.has(normalizeVideoMime(v.mime))) return 'type';
  if (!(v.size > 0)) return 'empty';
  if (v.size > CLIP_MAX_BYTES) return 'too-large';
  if (Number.isFinite(v.duration) && v.duration > CLIP_MAX_SECONDS) return 'too-long';
  return null;
}
export const clipEligible = v => clipReason(v) === null;
// A Gemini FileRef is usable while more than FILE_EXPIRY_MARGIN_MS remains before its 48 h expiry.
export const fileValid = (file, now = Date.now()) => Boolean(record(file) && isFileName(file.name) && isGeminiFileUri(file.uri)
  && Number.isFinite(file.expiresAt) && file.expiresAt - now > FILE_EXPIRY_MARGIN_MS);
// Trims any {name, uri, mime|mimeType, expiresAt} shape to a FileRef, or null when name/uri aren't Gemini's.
export function toFileRef(f, now = Date.now()) {
  if (!record(f) || !isFileName(f.name) || !isGeminiFileUri(f.uri)) return null;
  const mime = normalizeVideoMime(f.mime || f.mimeType);
  return { name: f.name, uri: f.uri, mime: VIDEO_MIME_RE.test(mime) ? mime : '', expiresAt: Number.isFinite(f.expiresAt) && f.expiresAt > 0 ? f.expiresAt : now + 47 * 3600e3 };
}
// Plans: {kind:'clip', file: FileRef} or {kind:'frames', cap, n}. null when the video has nothing to send.
export const framesPlan = (video, cap) => ({ kind: 'frames', cap, n: pickFrames(video?.frames, cap).length });
// clip: a FileRef the caller already knows is usable (e.g. from ensureClip / fileValid), or null.
export function planFor(video, provider, clip) {
  if (String(provider || '').split(':')[0] === 'gemini' && record(clip) && isGeminiFileUri(clip.uri)) return { kind: 'clip', file: clip };
  return video?.frames?.length ? framesPlan(video, frameCapFor(provider)) : null;
}
// The message parts that go before the prompt text (contract §3).
export function videoParts(video, plan) {
  if (!plan) return [];
  const v = video || {}, name = cleanName(v.name), dur = fmtDur(v.duration);
  const about = `The user attached a video${name ? ` ("${name}")` : ''}${dur ? `, ${dur} long` : ''}.`;
  if (plan.kind === 'clip') return [{ type: 'text', text: `${about} You can watch it and hear its audio. Refer to moments by timestamp (m:ss).` },
    { type: 'video_file', video_file: { file_uri: plan.file.uri, mime_type: plan.file.mime || normalizeVideoMime(v.mime) } }];
  const frames = pickFrames(v.frames, plan.cap ?? MAX_FRAMES), n = frames.length;
  if (!n) return [];
  return [{ type: 'text', text: `${about} You can't play it: below are ${n} still frames sampled evenly across it, each labeled with its timestamp, and there is no audio. If the answer depends on sound or on motion between frames, say so.` },
    ...frames.flatMap((f, i) => [{ type: 'text', text: `Frame ${i + 1} of ${n} · ${fmtDur(f.t) || '0:00'}` }, { type: 'image_url', image_url: { url: f.src } }])];
}
const WHY = new Map([['upload-failed', ' · clip upload failed'], ['expired', ' · clip expired'], ['too-large', ' · over 1 GB for full clip'], ['too-long', ' · over 10 min for full clip']]);
// e.meta.note (contract §1). why: 'upload-failed' | 'expired' | 'too-large' | 'too-long' (others add nothing).
export function noteFor(plan, { followUp = false, why = null, count } = {}) {
  if (!plan) return '';
  const lead = followUp ? 'about the video' : 'video';
  if (plan.kind === 'clip') return `${lead} · full clip with audio`;
  const n = plan.n ?? Math.min(plan.cap ?? MAX_FRAMES, count ?? MAX_FRAMES);
  return `${lead} · ${n} frames${WHY.get(why) || ''}`;
}
export function dataUrlBytes(d) {
  if (typeof d !== 'string') return 0;
  const b64 = d.slice(d.indexOf(',') + 1);
  return Math.max(0, Math.floor(b64.length * 3 / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0));
}
// Scales w×h down (never up) so the long edge is at most `edge`.
export function fitSize(w, h, edge) {
  if (!(w > 0 && h > 0)) return { w: 0, h: 0 };
  const s = Math.min(1, edge / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}
// The persisted e.video (contract §1): only known fields, no File/blob:/session. file is kept only if it is a FileRef.
export function storedVideo(info, file) {
  const i = info || {}, ref = toFileRef(file || i.file), mime = normalizeVideoMime(i.mime);
  return {
    name: cleanName(i.name), mime: VIDEO_MIME_RE.test(mime) ? mime : 'video/unknown',
    size: num(i.size) ? i.size : 0, duration: num(i.duration) ? i.duration : 0, width: num(i.width) ? i.width : 0, height: num(i.height) ? i.height : 0,
    poster: i.clipOnly || !safeImageData(i.poster) ? null : i.poster,
    frames: i.clipOnly || !Array.isArray(i.frames) ? [] : i.frames.filter(f => record(f) && num(f.t) && safeImageData(f.src)).slice(0, MAX_FRAMES).map(f => ({ t: f.t, src: f.src })),
    ...(i.clipOnly && { clipOnly: true }), ...(ref && { file: ref }),
  };
}
// Backup/import check for a persisted e.video (lenient on sizes so older or hand-edited backups still load).
export function validVideo(v) {
  if (!record(v) || typeof v.name !== 'string' || v.name.length > 200 || typeof v.mime !== 'string' || !VIDEO_MIME_RE.test(v.mime)) return false;
  if (!num(v.size) || !num(v.duration) || v.width != null && !num(v.width) || v.height != null && !num(v.height)) return false;
  if (v.poster != null && !safeImageData(v.poster)) return false;
  if (!Array.isArray(v.frames) || v.frames.length > 32 || !v.frames.every(f => record(f) && num(f.t) && safeImageData(f.src))) return false;
  if (v.clipOnly != null && typeof v.clipOnly !== 'boolean') return false;
  const f = v.file;
  return f == null || record(f) && isFileName(f.name) && isGeminiFileUri(f.uri) && num(f.expiresAt) && f.expiresAt <= 8640000000000000 && (f.mime == null || typeof f.mime === 'string');
}

// ── browser: frame sampler ──
const abortError = () => new DOMException('Aborted', 'AbortError');
const failure = (code, message, extra) => Object.assign(new Error(message), { code, ...extra });
const sleep = (ms, signal) => new Promise((res, rej) => {
  if (signal?.aborted) return rej(abortError());
  const ab = () => { clearTimeout(t); rej(abortError()); };
  const t = setTimeout(() => { signal?.removeEventListener('abort', ab); res(); }, ms);
  signal?.addEventListener('abort', ab, { once: true });
});
// Resolves with the first event type seen, or 'timeout'; rejects on abort.
function once(el, types, ms, signal) {
  return new Promise((res, rej) => {
    if (signal?.aborted) return rej(abortError());
    const off = () => { clearTimeout(timer); for (const t of types) el.removeEventListener(t, on); signal?.removeEventListener('abort', ab); };
    const on = ev => { off(); res(ev.type); };
    const ab = () => { off(); rej(abortError()); };
    const timer = setTimeout(() => { off(); res('timeout'); }, ms);
    for (const t of types) el.addEventListener(t, on);
    signal?.addEventListener('abort', ab, { once: true });
  });
}
const rangeEnd = v => {
  for (const r of [v.seekable, v.buffered]) if (r?.length) { const e = r.end(r.length - 1); if (e > 0 && Number.isFinite(e)) return e; }
  return 0;
};

// Samples poster + frames from a local video. Throws Error{code:'decode'|'timeout'} (carrying any known duration/width/height)
// or an AbortError. Pass `url` to reuse the caller's blob: URL (then it is left alone); otherwise one is made and revoked.
// onProgress(fraction, done, total) runs after each frame slot. Slots are sampled ends-first (sampleOrder) and frames come
// back sorted by time; `partial: true` means sampling stopped early (time budget, a decode error, or the file stopped
// decoding part-way) and some slots are missing — the frames still span what was readable.
export async function sampleVideo(file, { onProgress, signal, url } = {}) {
  if (signal?.aborted) throw abortError();
  const T = VIDEO_TIMING, doc = document;
  // Only visible time counts against T.total: iOS freezes a backgrounded page while Date.now() keeps running.
  let end = Date.now() + T.total, hiddenAt = doc.hidden ? Date.now() : 0;
  const onVis = () => { if (doc.hidden) hiddenAt ||= Date.now(); else if (hiddenAt) { end += Date.now() - hiddenAt; hiddenAt = 0; } };
  const remaining = () => { onVis(); return end - (hiddenAt || Date.now()); };
  const left = ms => Math.max(0, Math.min(ms, remaining()));
  doc.addEventListener?.('visibilitychange', onVis);
  const own = !url; if (own) url = URL.createObjectURL(file);
  const v = document.createElement('video'), c = document.createElement('canvas'), probe = document.createElement('canvas');
  const meta = { duration: 0, width: 0, height: 0 };
  Object.assign(v, { muted: true, defaultMuted: true, playsInline: true, preload: 'auto', controls: false, disableRemotePlayback: true, tabIndex: -1 });
  for (const a of ['muted', 'playsinline', 'webkit-playsinline']) v.setAttribute(a, '');
  v.setAttribute('aria-hidden', 'true');
  // Kept in the document (but invisible) so iOS decodes it and requestVideoFrameCallback fires.
  v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:.01;pointer-events:none;z-index:-1';
  try {
    (document.body || document.documentElement).append(v);
    const loaded = once(v, ['loadedmetadata', 'error'], left(T.meta), signal);
    v.src = url;
    const r = await loaded;
    if (r === 'timeout') throw failure('timeout', 'The video took too long to open.', meta);
    if (r === 'loadedmetadata' && Number.isFinite(v.duration) && v.duration > 0) meta.duration = v.duration; // often known even when the picture isn't (HEVC)
    if (r === 'error' || v.error || !v.videoWidth || !v.videoHeight) throw failure('decode', 'This browser can’t decode that video.', meta);
    meta.width = v.videoWidth; meta.height = v.videoHeight;
    const decoded = () => { try { return v.getVideoPlaybackQuality?.().totalVideoFrames ?? null; } catch { return null; } };
    // → {ok, shown, mt, moved}: shown/mt from requestVideoFrameCallback (visible pages only; mt = the presented frame's
    // mediaTime when given), moved = whether the decoder produced any frame during the seek (null when unknown).
    const seek = async t => {
      let shown = false, mt = null, id;
      const before = decoded(), done = once(v, ['seeked', 'error'], left(T.seek), signal);
      v.currentTime = t;
      // Registered after the seek starts so only a frame from this seek answers it; hidden pages never present frames.
      if (v.requestVideoFrameCallback && !doc.hidden) id = v.requestVideoFrameCallback((_, m) => { shown = true; if (Number.isFinite(m?.mediaTime)) mt = m.mediaTime; });
      let ok = await done === 'seeked';
      while (ok && v.seeking) ok = await once(v, ['seeked', 'error'], left(T.seek), signal) === 'seeked'; // a stale 'seeked' from an earlier seek
      if (ok && v.readyState < 2) await once(v, ['loadeddata', 'canplay'], left(1000), signal);
      if (ok && id == null) await sleep(T.settle, signal);
      for (const until = Date.now() + T.frame; ok && id != null && !shown && Date.now() < until;) await sleep(16, signal);
      if (!shown && id != null) v.cancelVideoFrameCallback?.(id);
      const after = decoded();
      return { ok, shown, mt, moved: before == null || after == null ? null : after !== before };
    };
    const known = () => Number.isFinite(v.duration) && v.duration > 0;
    if (!known()) { // MediaRecorder WebM reports Infinity until the end has been seen
      const p = once(v, ['durationchange', 'seeked'], left(T.probe), signal);
      v.currentTime = 1e9;
      await p;
      await seek(0);
    }
    meta.duration = known() ? v.duration : 0;
    try { await Promise.race([v.play(), sleep(T.warm)]); } catch {} // iOS decodes nothing before playback
    v.pause();
    const range = meta.duration || rangeEnd(v);
    const times = range ? frameTimes(range, frameCount(meta.duration)) : [0];
    const box = fitSize(meta.width, meta.height, FRAME_EDGE), posterBox = fitSize(meta.width, meta.height, POSTER_EDGE);
    const ctx = c.getContext('2d');
    probe.width = probe.height = 8;
    const pctx = probe.getContext('2d', { willReadFrequently: true });
    const draw = ({ w, h }) => { if (c.width !== w) c.width = w; if (c.height !== h) c.height = h; ctx.clearRect(0, 0, w, h); ctx.drawImage(v, 0, 0, w, h); };
    // 8×8 downsample of the canvas (null if unreadable): all-transparent means nothing was drawn; it doubles as a picture signature.
    const look = () => { try { pctx.clearRect(0, 0, 8, 8); pctx.drawImage(c, 0, 0, 8, 8); return pctx.getImageData(0, 0, 8, 8).data; } catch { return null; } };
    const isBlank = d => Boolean(d) && d.every((x, i) => i % 4 !== 3 || !x);
    const shot = (b, max) => {
      for (let s = 1; s > 0.4; s *= 0.8) {
        draw({ w: Math.max(1, Math.round(b.w * s)), h: Math.max(1, Math.round(b.h * s)) });
        for (const q of [0.8, 0.7, 0.6, 0.5]) { const d = c.toDataURL('image/jpeg', q); if (d.startsWith('data:image/jpeg;base64,') && dataUrlBytes(d) <= max) return d; }
      }
      return null;
    };
    const order = sampleOrder(times.length), kept = [];
    let poster = null, prevSig = null, limit = Infinity, partial = false;
    for (let k = 0; k < order.length; k++) {
      const t = times[order[k]];
      if (remaining() <= 0) { if (kept.length) { partial = true; break; } throw failure('timeout', 'Reading the video took too long.', meta); }
      if (t >= limit) partial = true; // past the point where the file stopped decoding
      else {
        const s = await seek(t);
        if (s.ok) {
          draw(box);
          let d = look();
          if (isBlank(d)) { await sleep(T.blank, signal); draw(box); d = look(); }
          const sig = d && d.join();
          if (!isBlank(d)) {
            // Nothing decoded and the picture didn't change: the element still shows the previous frame (e.g. a truncated
            // file). Drop it and skip every later slot.
            if (!s.shown && s.moved === false && sig && sig === prevSig) limit = Math.min(limit, t);
            // The browser re-presented a frame we already have (same mediaTime, same picture): drop just this one.
            else if (!(s.mt != null && kept.some(f => f.mt === s.mt && f.sig === sig))) {
              const src = shot(box, FRAME_MAX_BYTES);
              if (src) { kept.push({ t, mt: s.mt, sig, src }); poster ||= shot(posterBox, POSTER_MAX_BYTES); }
            }
            prevSig = sig;
          }
        }
        if (v.error) { if (kept.length) { partial = true; break; } throw failure('decode', 'This browser can’t decode that video.', meta); } // keep what decoded before it
      }
      onProgress?.((k + 1) / order.length, k + 1, order.length);
    }
    if (!kept.length) throw failure('decode', 'This browser can’t decode that video.', meta);
    // Label a frame with the moment it really shows when that is reported and differs (a seek into undecodable data lands
    // on an earlier frame) — unless the reported times look unreliable (two different pictures sharing one time).
    const mts = kept.filter(f => f.mt != null).map(f => f.mt);
    const trusted = new Set(mts).size === mts.length && mts.every(m => m >= 0 && m <= range + 1);
    const frames = kept.map(f => ({ t: Math.round((trusted && f.mt != null && Math.abs(f.mt - f.t) > 0.5 ? f.mt : f.t) * 1000) / 1000, src: f.src }))
      .sort((a, b) => a.t - b.t);
    return { ...meta, poster, frames, ...(partial && { partial: true }) };
  } finally {
    doc.removeEventListener?.('visibilitychange', onVis);
    v.pause();
    v.removeAttribute('src');
    try { v.load(); } catch {}
    v.remove();
    c.width = c.height = 1; probe.width = probe.height = 1;
    if (own) URL.revokeObjectURL(url);
  }
}

// {name, mime, size, duration, width, height, poster, frames, clipOnly, partial?}. A video the browser can't decode comes
// back clipOnly (frames [], poster null, `reason` set) — the caller decides whether Gemini can still take it as a clip.
// partial: true (session-only, never persisted) when sampling stopped early — see sampleVideo.
// Throws AbortError on abort, or Error{code:'size'} above LOCAL_MAX_BYTES.
export async function readVideo(file, { onProgress, signal, url } = {}) {
  const mime = normalizeVideoMime(file?.type, file?.name);
  const base = { name: cleanName(file?.name), mime: VIDEO_MIME_RE.test(mime) ? mime : 'video/unknown', size: num(file?.size) ? file.size : 0 };
  if (base.size > LOCAL_MAX_BYTES) throw failure('size', 'That video is over 4 GB — too big to read on this device.');
  try {
    const s = await sampleVideo(file, { onProgress, signal, url });
    return { ...base, duration: s.duration, width: s.width, height: s.height, poster: s.poster, frames: s.frames, clipOnly: false, ...(s.partial && { partial: true }) };
  } catch (err) {
    if (err?.name === 'AbortError' || signal?.aborted) throw err?.name === 'AbortError' ? err : abortError();
    if (!err?.code) console.warn('[atelier] video sampling failed:', err);
    return { ...base, duration: num(err?.duration) ? err.duration : 0, width: num(err?.width) ? err.width : 0, height: num(err?.height) ? err.height : 0,
      poster: null, frames: [], clipOnly: true, reason: err?.code || 'decode' };
  }
}

// ── browser: Gemini clip upload through the Worker (contract §5) ──
// apiHeaders: app.js's apiHeaders function (called with no arguments) or a plain headers object.
const headersFor = (apiHeaders, extra = {}) => {
  const h = new Headers(typeof apiHeaders === 'function' ? apiHeaders() : apiHeaders || {});
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return h;
};
const readJson = async r => { try { const j = await r.json(); return record(j) ? j : {}; } catch { return {}; } };
const errorOf = (status, j, fallback) => failure(typeof j.code === 'string' && j.code || (status === 409 ? 'sync' : status === 413 ? 'too-large' : status === 415 ? 'type' : 'http'),
  typeof j.error === 'string' && j.error || fallback, { status });
const SYNC = 'Upload out of sync — try attaching again.';
// A signal that fires on the caller's abort or after `ms` (then late() is true); done() drops the timer and listener.
function timed(signal, ms) {
  const ctrl = new AbortController(), ab = () => ctrl.abort();
  let late = false;
  const timer = setTimeout(() => { late = true; ctrl.abort(); }, ms);
  if (signal?.aborted) ctrl.abort(); else signal?.addEventListener('abort', ab, { once: true });
  return { signal: ctrl.signal, late: () => late, done: () => { clearTimeout(timer); signal?.removeEventListener('abort', ab); } };
}
// One JSON call to the Worker, capped at VIDEO_TIMING.request. Throws Error{code:'network'|'timeout'|…, status} or AbortError.
async function call(method, path, { apiHeaders, body, signal, headers } = {}) {
  const json = body !== undefined, t = timed(signal, VIDEO_TIMING.request);
  try {
    let r;
    try { r = await fetch(path, { method, signal: t.signal, headers: headersFor(apiHeaders, { ...(json && { 'content-type': 'application/json' }), ...headers }), body: json ? JSON.stringify(body) : undefined }); }
    catch {
      if (signal?.aborted) throw abortError();
      throw t.late() ? failure('timeout', 'Atelier took too long to answer.', { status: 0 }) : failure('network', 'Couldn’t reach Atelier to send the clip.', { status: 0 });
    }
    const j = await readJson(r);
    if (signal?.aborted) throw abortError();
    if (!r.ok) throw errorOf(r.status, j, `The clip upload failed (${r.status}).`);
    return j;
  } finally { t.done(); }
}
// One chunk PUT → {status, j, retryAfter}: XHR in browsers (for upload progress), fetch where there is no XHR (node tests).
// A stalled request (no upload progress for T.stall, or no answer T.answer after the last byte; fetch: both together)
// rejects with a TypeError like a dropped connection, so it is retried; only the caller's signal gives an AbortError.
function put(url, blob, headers, signal, onLoaded) {
  const T = VIDEO_TIMING;
  if (typeof XMLHttpRequest !== 'function') {
    const t = timed(signal, T.stall + T.answer);
    return fetch(url, { method: 'PUT', headers, body: blob, signal: t.signal })
      .then(async r => {
        onLoaded?.(blob.size);
        const j = await readJson(r); // swallows an abort mid-body, so look again
        if (t.signal.aborted) throw abortError();
        return { status: r.status, j, retryAfter: r.headers.get('retry-after') };
      })
      .catch(err => { if (signal?.aborted) throw abortError(); throw err?.name === 'AbortError' ? new TypeError('Upload stalled') : err; })
      .finally(t.done);
  }
  return new Promise((res, rej) => {
    if (signal?.aborted) return rej(abortError());
    const x = new XMLHttpRequest(), ab = () => x.abort();
    let timer, stalled = false;
    const arm = ms => { clearTimeout(timer); timer = setTimeout(() => { stalled = true; x.abort(); }, ms); };
    const end = () => { clearTimeout(timer); signal?.removeEventListener('abort', ab); };
    x.open('PUT', url);
    headers.forEach((value, key) => x.setRequestHeader(key, value));
    x.upload.onprogress = e => { arm(T.stall); onLoaded?.(e.loaded); };
    x.upload.onload = () => arm(T.answer); // every byte is out: now wait for the Worker's answer
    x.onload = () => { end(); let j = {}; try { j = JSON.parse(x.responseText); } catch {} res({ status: x.status, j: record(j) ? j : {}, retryAfter: x.getResponseHeader?.('retry-after') }); };
    x.onerror = () => { end(); rej(new TypeError('Network error')); };
    x.onabort = () => { end(); rej(stalled ? new TypeError('Upload stalled') : abortError()); };
    signal?.addEventListener('abort', ab, { once: true });
    arm(T.stall);
    x.send(blob);
  });
}
// Fire-and-forget (capped at T.request); resolve true/false, never reject.
const fire = (path, init) => {
  const t = timed(null, VIDEO_TIMING.request);
  return fetch(path, { ...init, keepalive: true, signal: t.signal }).then(r => r.ok, () => false).finally(t.done);
};
export const cancelUpload = (session, apiHeaders) => !session ? Promise.resolve(false)
  : fire('/api/video/upload/cancel', { method: 'POST', headers: headersFor(apiHeaders, { 'x-upload-session': session }) });
export const deleteClip = (name, apiHeaders) => !isFileName(name) ? Promise.resolve(false)
  : fire(`/api/video/file?name=${encodeURIComponent(name)}`, { method: 'DELETE', headers: headersFor(apiHeaders) });

const retryable = s => s === 0 || s === 408 || s === 429 || s >= 500;
const pageHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
const CHUNK_ATTEMPTS = CHUNK_RETRIES * 4; // backstop: no chunk is sent more often than this, whatever the page did
// Waits before retry n: the server's retry-after, else T.retry doubling (both capped at T.retryMax); then, while the
// browser reports being offline, for the 'online' event (at most T.offline).
async function backoff(n, retryAfter, signal) {
  const T = VIDEO_TIMING, ra = Number(retryAfter);
  await sleep(Math.min(T.retryMax, ra > 0 ? ra * 1000 : T.retry * 2 ** n), signal);
  if (globalThis.navigator?.onLine === false && typeof globalThis.addEventListener === 'function') await once(globalThis, ['online'], T.offline, signal);
}

// Polls GET /api/video/file until ACTIVE → FileRef. Each poll is capped at T.request and at what is left of T.pollMax.
// Throws Error{code:'failed'|'gone'|'timeout'|'http'} or AbortError.
export async function waitClipActive(name, { apiHeaders, signal, onState } = {}) {
  if (!isFileName(name)) throw failure('gone', 'The uploaded clip isn’t available any more.', { status: 404 });
  const T = VIDEO_TIMING, end = Date.now() + T.pollMax, late = () => failure('timeout', 'Gemini took too long to prepare the clip.', { status: 504 });
  for (;;) {
    let status = 0, j = {};
    const ms = end - Date.now();
    if (ms <= 0) throw late();
    const t = timed(signal, Math.min(T.request, ms));
    try { const r = await fetch(`/api/video/file?name=${encodeURIComponent(name)}`, { headers: headersFor(apiHeaders), signal: t.signal }); status = r.status; j = await readJson(r); }
    catch {} finally { t.done(); }
    if (signal?.aborted) throw abortError();
    if (status === 404 || j.state === 'GONE') throw failure('gone', 'The uploaded clip isn’t available any more (Gemini keeps uploads for 48 hours).', { status: 404 });
    if (status === 200) {
      if (j.state) onState?.(j.state);
      if (j.state === 'ACTIVE') { const ref = toFileRef(j); if (ref) return ref; throw failure('http', 'Gemini returned an unexpected file.', { status: 502 }); }
      if (j.state === 'FAILED') throw failure('failed', typeof j.error === 'string' && j.error ? `Gemini couldn’t process the clip: ${j.error}` : 'Gemini couldn’t process the clip.', { status: 200 });
    } else if (status && status < 500 && status !== 408 && status !== 429) throw errorOf(status, j, `Couldn’t check the clip (${status}).`);
    if (Date.now() + T.poll > end) throw late();
    await sleep(T.poll, signal);
  }
}

// start → chunk PUTs (x-upload-session, last one finalizes) → poll until ACTIVE → FileRef {name, uri, mime, expiresAt}.
// onProgress(fraction, state) with state 'uploading' | 'processing' | 'active'. The session URL lives only in this call.
// Every request is time-capped (VIDEO_TIMING) and every chunk's retries are bounded, so this always settles, hidden
// page or not. Chunks resume via upload/query after drops.
// On error/abort the Google session is cancelled, and a finalized-but-unready file is deleted. wait:false returns
// right after finalize as FileRef & {state}. Throws Error{code, status} or AbortError.
export async function uploadClip(file, { apiHeaders, onProgress, signal, name, mime, wait = true } = {}) {
  if (signal?.aborted) throw abortError();
  const size = file?.size;
  mime = normalizeVideoMime(mime || file?.type, file?.name);
  const why = clipReason({ mime, size, duration: 0 });
  if (why) throw failure(why, why === 'too-large' ? 'That video is over 1 GB — too big to send as a clip.' : 'Gemini can’t take this video type.', { status: why === 'too-large' ? 413 : 415 });
  let top = 0; // never step back when a chunk is retried
  const report = (p, state) => onProgress?.(top = Math.min(1, Math.max(top, p)), state);
  const start = await call('POST', '/api/video/upload/start', { apiHeaders, signal, body: { name: cleanName(name ?? file.name), mime, size } });
  const session = typeof start.session === 'string' ? start.session : '';
  if (!session) throw failure('http', 'Gemini didn’t start the upload.', { status: 502 });
  let chunk = Number(start.chunk);
  if (!(Number.isInteger(chunk) && chunk > 0)) chunk = CHUNK_NOMINAL;
  chunk = Math.min(chunk, CHUNK_MAX);
  const headers = headersFor(apiHeaders, { 'content-type': 'application/octet-stream', 'x-upload-session': session });
  // Where Google's copy stands → {received} | {done, file}, or null when that can't be found out.
  const query = () => call('POST', `/api/video/upload/query?total=${size}`, { apiHeaders, signal, headers: { 'x-upload-session': session } })
    .then(j => j.done || Number.isSafeInteger(j.received) ? j : null, err => { if (err?.name === 'AbortError') throw err; return null; });
  // Bytes [offset, end) → the Worker's answer ({received} | {done, file}). Dropped connections, stalls, 408/429/5xx are
  // retried with backoff. A connection dropped while the page is hidden (iOS freezes it) doesn't use up a try, but the
  // next one waits for the page to come back (at most T.offline); an answer the server sent always counts. After an
  // unclear failure or a 409 it asks where Google's copy stands and carries on from there instead of starting over.
  const send = async (offset, end) => {
    for (let n = 0, tries = 0, from = offset; ; n++) {
      let r;
      try { r = await put(`/api/video/upload/chunk?offset=${from}&total=${size}`, file.slice(from, end), headers, signal, b => report((from + Math.min(b, end - from)) / size, 'uploading')); }
      catch (err) { if (err?.name === 'AbortError' || signal?.aborted) throw abortError(); r = { status: 0, j: {} }; }
      if (r.status >= 200 && r.status < 300) return r.j;
      const sync = r.status === 409;
      if (!sync && !retryable(r.status)) throw errorOf(r.status, r.j, `The clip upload failed (${r.status}).`);
      if (!sync) {
        const away = !r.status && pageHidden();
        if (!away) tries++;
        if (tries > CHUNK_RETRIES || n + 1 >= CHUNK_ATTEMPTS) throw r.status ? errorOf(r.status, r.j, `The clip upload failed (${r.status}).`) : failure('network', 'The connection dropped while sending the clip.', { status: 0 });
        if (away && typeof document.addEventListener === 'function') await once(document, ['visibilitychange'], VIDEO_TIMING.offline, signal);
        await backoff(n, r.retryAfter, signal);
      }
      const q = await query();
      if (q?.done) return q; // the final chunk had arrived; only its answer was lost
      if (q?.received === end && end < size) return { received: end };
      if (q?.received > from && q.received < end && q.received % GRANULARITY_DEFAULT === 0) { from = q.received; continue; } // Google kept part of it
      if (sync || q && q.received !== from) throw sync ? errorOf(409, r.j, SYNC) : failure('sync', SYNC, { status: 409 });
    }
  };
  let done;
  try {
    report(0, 'uploading');
    for (let offset = 0; offset < size;) {
      const end = Math.min(size, offset + chunk), j = await send(offset, end);
      report(end / size, 'uploading');
      if (end === size) { done = j; break; }
      if (j.received != null && j.received !== end) throw failure('sync', SYNC, { status: 409 });
      offset = end;
    }
    if (!done?.done || !toFileRef(done.file)) throw failure('http', 'Gemini didn’t confirm the upload.', { status: 502 });
  } catch (err) { cancelUpload(session, apiHeaders); throw err; }
  const ref = toFileRef(done.file), state = done.file.state || 'PROCESSING';
  const drop = err => { deleteClip(ref.name, apiHeaders); throw err; };
  if (state === 'FAILED') drop(failure('failed', 'Gemini couldn’t process the clip.', { status: 200 }));
  if (!wait) return { ...ref, state };
  if (signal?.aborted) drop(abortError());
  if (state === 'ACTIVE') { report(1, 'active'); return ref; }
  report(1, 'processing');
  const active = await waitClipActive(ref.name, { apiHeaders, signal }).catch(drop);
  report(1, 'active');
  return active;
}

// ClipJob (contract §2): {state, progress, file, error, promise, abort()}. promise resolves to the FileRef, or null on
// failure/abort (see job.error) — it never rejects. abort() is a no-op once active; delete an active file with deleteClip.
export function startClip(file, { apiHeaders, name, mime, onChange } = {}) {
  const ctrl = new AbortController();
  const job = { state: 'uploading', progress: 0, file: null, error: null, promise: null, abort: () => ctrl.abort() };
  const set = patch => { Object.assign(job, patch); try { onChange?.(job); } catch (err) { console.error(err); } };
  job.promise = uploadClip(file, { apiHeaders, name, mime, signal: ctrl.signal, onProgress: (progress, state) => set({ progress, state }) })
    .then(ref => { set({ state: 'active', progress: 1, file: ref }); return ref; }, error => { set({ state: 'failed', error }); return null; });
  return job;
}
