// Video Remix: the render engine — lazy-loaded (remix-app.js imports it with import() only when a clip is attached in
// Video mode or a cut starts) together with the vendored Mediabunny 1.61.0 (public/vendor/mediabunny.js, MPL-2.0).
//   capabilities()  what this browser can do (WebCodecs, an H.264 encoder at the output size, AAC encode)
//   probeSource()   codec, size, rotation, fps, bitrate, audio, HDR and whether the video track decodes here
//   analyseSource() a 64 px wide gray pass over every frame → mean luma + a 16-bin histogram + keyframe times, the input
//                   of remix-cuts.js cutsFrom()
//   renderCut()     decode → draw each output frame with remix-draw.js composeFrame (remix-graph.js frameAt) → encode
//                   H.264 → MP4 with the source's own audio packets copied untouched (keep), or the soundtrack cut and
//                   re-encoded as AAC (follow_cuts).
// Every Mediabunny/WebCodecs touch goes through `mb` and `env` parameters, so the orchestration is node-tested with
// fakes (tests/remix-render.test.mjs); the real engine is checked in the browser (scripts/remix-browser-check.mjs).
// Memory: at most one decoded sample per active item is open (≤ 3 during a crossfade), each is closed as soon as the
// next one replaces it, and VideoSource.add() is awaited per frame (encoder backpressure).
import { frameAt as graphFrame, sampleTimes, keepPackets } from './remix-graph.js?v=69';
import { composeFrame, canvasToDataUrl, makeCanvas } from './remix-draw.js?v=69';

export const MEDIABUNNY_URL = './vendor/mediabunny.js';
export const H264_PROFILES = Object.freeze(['avc1.640028', 'avc1.4d0028', 'avc1.420028']); // High, Main, Baseline @ 4.0
export const WATCHDOG_MS = 8000;
export const ANALYSE_WIDTH = 64;
export const POSTER_EDGE = 480;
export const AAC_KBPS = 160;

/** code: 'unsupported' (no WebCodecs/H.264 here), 'no-decode', 'stalled', 'source', 'aborted'. */
export class RenderError extends Error {
  constructor(code, message) { super(message); this.name = 'RenderError'; this.code = code; }
}
export const MESSAGES = Object.freeze({
  unsupported: 'This browser can’t assemble video — your plan and shots are saved; finish on desktop Chrome or Edge.',
  noH264: 'This browser has no H.264 encoder at this size — your plan and shots are saved; finish on desktop Chrome or Edge.',
  noDecode: 'Can’t cut this video in this browser — export it as MP4 (H.264) or open Atelier in Chrome.',
  stalled: 'The video encoder stopped responding — tap Try again (it’s free).',
  source: 'Atelier couldn’t read the original video — attach it again.',
});
const abortError = () => new DOMException('Aborted', 'AbortError');
const isAbort = (e) => e?.name === 'AbortError';

let mbPromise = null;
/** The vendored Mediabunny module (cached; a failed load can be retried). */
export function loadMediabunny() {
  if (!mbPromise) mbPromise = import(MEDIABUNNY_URL).catch((err) => { mbPromise = null; throw err; });
  return mbPromise;
}

/** 'android' | 'ios' | 'desktop' from a user agent (outputSize uses it). */
export function platformOf(ua = globalThis.navigator?.userAgent || '') {
  if (/android/i.test(ua)) return 'android';
  if (/iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && globalThis.navigator?.maxTouchPoints > 1)) return 'ios';
  return 'desktop';
}
const isWebKit = (ua = globalThis.navigator?.userAgent || '') => /applewebkit/i.test(ua) && !/chrome|chromium|crios|edg|android/i.test(ua);

/**
 * The first H.264 profile the VideoEncoder takes at this size. env: {VideoEncoder}. → codec string | null.
 */
export async function pickH264({ w, h, kbps = 2500, fps = 30 }, env = globalThis) {
  const VE = env.VideoEncoder;
  if (typeof VE?.isConfigSupported !== 'function') return null;
  for (const codec of H264_PROFILES) {
    try {
      const r = await VE.isConfigSupported({ codec, width: w, height: h, bitrate: kbps * 1000, framerate: fps, avc: { format: 'avc' } });
      if (r?.supported) return codec;
    } catch {}
  }
  return null;
}
/**
 * What this browser can do for an out size. opts: {out: {w, h}, mb, env}. → {webcodecs, h264 (codec string or null),
 * aacEncode, path: 'webcodecs' | 'none', platform, webkit, reason}.
 */
export async function capabilities({ out = { w: 1080, h: 1350 }, kbps = 2500, fps = 30, mb = null, env = globalThis } = {}) {
  const platform = platformOf(env.navigator?.userAgent);
  const webkit = isWebKit(env.navigator?.userAgent);
  const webcodecs = typeof env.VideoEncoder === 'function' && typeof env.VideoDecoder === 'function' && typeof env.VideoFrame === 'function';
  let h264 = webcodecs ? await pickH264({ ...out, kbps, fps }, env) : null;
  if (!h264 && webcodecs && out.h % 16) h264 = await pickH264({ w: Math.round(out.w / 16) * 16, h: Math.round(out.h / 16) * 16, kbps, fps }, env);
  let aacEncode = false;
  try {
    const m = mb || (webcodecs ? await loadMediabunny() : null);
    aacEncode = Boolean(m && (await m.canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: 48000, bitrate: AAC_KBPS * 1000 })));
  } catch {}
  const path = webcodecs && h264 ? 'webcodecs' : 'none';
  return { webcodecs, h264, aacEncode, path, platform, webkit, reason: path === 'none' ? (webcodecs ? MESSAGES.noH264 : MESSAGES.unsupported) : null };
}

const openInput = (mb, file) => new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
const VCODEC = { avc: 'avc1', hevc: 'hvc1', vp8: 'vp8', vp9: 'vp09', av1: 'av01' };
/**
 * The facts a remix needs about the source. → {name, size, duration, width, height (upright display size), rotation,
 * fps, vcodec, vkbps, audio ('aac'|'opus'|'mp3'|null), hasAudio, hdr, canDecode, audioCanDecode}.
 */
export async function probeSource(file, { mb = null } = {}) {
  const m = mb || (await loadMediabunny());
  const input = openInput(m, file);
  try {
    const v = await input.getPrimaryVideoTrack();
    if (!v) throw new RenderError('source', 'That file has no video track.');
    const a = await input.getPrimaryAudioTrack();
    const rotation = Number(await v.getRotation?.()) || 0;
    const duration = Number(await input.computeDuration()) || 0;
    let fps = 30, vkbps = null;
    try {
      const st = await v.computePacketStats(240);
      if (st?.averagePacketRate > 0) fps = st.averagePacketRate;
      if (st?.averageBitrate > 0) vkbps = Math.round(st.averageBitrate / 1000);
    } catch {}
    const snapFps = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60].filter((f) => Math.abs(f - fps) < 0.6).sort((a, b) => Math.abs(a - fps) - Math.abs(b - fps))[0];
    const codec = await v.getCodec?.() ?? v.codec;
    const acodec = a ? (await a.getCodec?.() ?? a.codec) : null;
    return {
      name: file.name || 'video', size: file.size || 0, duration: Math.round(duration * 1000) / 1000,
      width: v.displayWidth ?? (await v.getDisplayWidth()), height: v.displayHeight ?? (await v.getDisplayHeight()),
      codedWidth: v.codedWidth, codedHeight: v.codedHeight,
      rotation: [0, 90, 180, 270].includes(rotation) ? rotation : 0,
      fps: Math.round((snapFps || fps) * 1000) / 1000, vcodec: VCODEC[codec] || String(codec || 'unknown').slice(0, 40), vkbps,
      audio: ['aac', 'opus', 'mp3'].includes(acodec) ? acodec : null, hasAudio: Boolean(a),
      hdr: Boolean(await v.hasHighDynamicRange?.().catch(() => false)),
      canDecode: Boolean(await v.canDecode().catch(() => false)),
      audioCanDecode: a ? Boolean(await a.canDecode().catch(() => false)) : false,
    };
  } finally { input.dispose?.(); }
}

/** One 64 px gray frame's RGBA → {luma (0–255 mean), hist (16 bins as 2-hex-char 1/255 fractions, cuts.parseHist form)}. */
export function lumaStats(data) {
  const bins = new Array(16).fill(0);
  let sum = 0, n = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    const y = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    sum += y; n++;
    bins[Math.min(15, Math.floor(y / 16))]++;
  }
  const hist = bins.map((b) => Math.round((b / Math.max(1, n)) * 255).toString(16).padStart(2, '0')).join('');
  return { luma: Math.round((sum / Math.max(1, n)) * 100) / 100, hist };
}
/**
 * Scene-change input for cutsFrom: every frame at 64 px → {luma[], hist[], keyframes[], fps}. opts: {mb, signal,
 * onProgress(fraction)}.
 */
export async function analyseSource(file, { mb = null, signal = null, onProgress = null, width = ANALYSE_WIDTH } = {}) {
  const m = mb || (await loadMediabunny());
  const input = openInput(m, file);
  try {
    const v = await input.getPrimaryVideoTrack();
    if (!v) throw new RenderError('source', 'That file has no video track.');
    const duration = Number(await input.computeDuration()) || 0;
    const luma = [], hist = [], keyframes = [];
    const sink = new m.CanvasSink(v, { width, poolSize: 2 });
    let last = 0;
    for await (const wc of sink.canvases()) {
      if (signal?.aborted) throw abortError();
      const c = wc.canvas, ctx = c.getContext('2d', { willReadFrequently: true });
      const st = lumaStats(ctx.getImageData(0, 0, c.width, c.height).data);
      luma.push(st.luma); hist.push(st.hist);
      if (onProgress && duration > 0 && wc.timestamp - last > 0.5) { last = wc.timestamp; onProgress(Math.min(1, wc.timestamp / duration)); }
    }
    try {
      const ps = new m.EncodedPacketSink(v);
      for (let p = await ps.getFirstKeyPacket({ metadataOnly: true }); p && keyframes.length < 600; p = await ps.getNextKeyPacket(p, { metadataOnly: true })) {
        if (signal?.aborted) throw abortError();
        keyframes.push(Math.round(p.timestamp * 1000) / 1000);
      }
    } catch (err) { if (isAbort(err)) throw err; }
    const fps = duration > 0 ? Math.round((luma.length / duration) * 1000) / 1000 : 30;
    onProgress?.(1);
    return { luma, hist, keyframes, fps };
  } finally { input.dispose?.(); }
}

/**
 * For each item: the first and last output frame it is drawn in (crossfade handles included), so its decoder opens
 * just in time and closes right after. → Map(itemId → {first, last}).
 */
export function itemSpans(g) {
  const spans = new Map();
  for (let k = 0; k < g.frames; k++) {
    for (const d of graphFrame(g, k).draws) {
      const s = spans.get(d.id);
      if (s) s.last = k; else spans.set(d.id, { first: k, last: k });
    }
  }
  return spans;
}

/**
 * A per-item reader over samplesAtTimestamps: get(t) returns the sample for media time t (the one for the largest
 * listed time ≤ t), closing the one it replaces. One iterator — one warm decoder — per item.
 */
export function itemReader(sink, times) {
  const it = sink.samplesAtTimestamps(times)[Symbol.asyncIterator]();
  let idx = 0, cur = null, done = false;
  return {
    async get(t) {
      while (!done && idx < times.length && times[idx] <= t + 1e-6) {
        const r = await it.next();
        if (r.done) { done = true; break; }
        idx++;
        if (r.value) { if (cur && cur !== r.value) cur.close?.(); cur = r.value; }
      }
      return cur;
    },
    async close() { cur?.close?.(); cur = null; done = true; try { await it.return?.(); } catch {} },
  };
}

/** Promise p, or a RenderError('stalled') after ms. */
function watchdog(p, ms, setT = setTimeout, clearT = clearTimeout) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setT(() => rej(new RenderError('stalled', MESSAGES.stalled)), ms); })]).finally(() => clearT(t));
}

/**
 * follow_cuts: where each segment's source audio goes, in samples at sampleRate, with each cut moved to the quietest
 * `window` within ±snap of it (rms(t0, t1) → number gives the loudness of a source range) and `ramp`-long fades.
 * → [{kind, outStart, outEnd (samples), mediaIn, mediaOut (seconds, snapped), gain (linear), ramp (samples), shot?}].
 */
export function mixOps(audio, sampleRate, rms = null) {
  const ops = [];
  const quiet = (t) => {
    if (!rms) return t;
    let best = t, bestR = Infinity;
    for (let d = -audio.snap; d <= audio.snap + 1e-9; d += audio.window) {
      const r = rms(t + d, t + d + audio.window);
      if (r < bestR - 1e-12) { bestR = r; best = t + d; }
    }
    return Math.round(best * 1000) / 1000;
  };
  for (const s of audio.segments || []) {
    const outStart = Math.round(s.outStart * sampleRate), outEnd = Math.round(s.outEnd * sampleRate);
    const op = { kind: s.kind, outStart, outEnd, gain: 10 ** ((s.gainDb || 0) / 20), ramp: Math.round((audio.ramp || 0.02) * sampleRate) };
    if (s.kind !== 'silence') {
      const len = s.outEnd - s.outStart;
      const mi = s.kind === 'source' ? Math.max(0, quiet(s.mediaIn)) : s.mediaIn;
      op.mediaIn = mi; op.mediaOut = mi + len;
      if (s.shot) op.shot = s.shot;
    }
    ops.push(op);
  }
  return ops;
}
/** Copies one segment's planar PCM into the output channels with linear in/out ramps. */
export function mixInto(outChs, srcChs, op) {
  const n = Math.min(op.outEnd - op.outStart, srcChs[0]?.length ?? 0);
  for (let c = 0; c < outChs.length; c++) {
    const src = srcChs[Math.min(c, srcChs.length - 1)], dst = outChs[c];
    for (let i = 0; i < n; i++) {
      const r = op.ramp > 0 ? Math.min(1, i / op.ramp, (n - 1 - i) / op.ramp) : 1;
      const j = op.outStart + i;
      if (j >= 0 && j < dst.length) dst[j] += src[i] * op.gain * Math.max(0, r);
    }
  }
}
// Decodes [t0, t1) of an audio track into planar Float32 channels at the track's own rate.
async function decodeRange(m, track, t0, t1, channels, signal) {
  const sink = new m.AudioSampleSink(track);
  const rate = track.sampleRate || (await track.getSampleRate());
  const n = Math.max(0, Math.round((t1 - t0) * rate));
  const out = Array.from({ length: channels }, () => new Float32Array(n));
  for await (const s of sink.samples(t0, t1)) {
    if (signal?.aborted) { s.close?.(); throw abortError(); }
    const at = Math.round((s.timestamp - t0) * rate), frames = s.numberOfFrames;
    for (let c = 0; c < channels; c++) {
      const tmp = new Float32Array(frames);
      s.copyTo(tmp, { planeIndex: Math.min(c, s.numberOfChannels - 1), format: 'f32-planar' });
      for (let i = 0; i < frames; i++) { const j = at + i; if (j >= 0 && j < n) out[c][j] = tmp[i]; }
    }
    s.close?.();
  }
  return out;
}

/**
 * Renders the cut. args: {file (the source), graph (remix-graph buildGraph), shots: {[shotId]: Blob} (filmed shots),
 * images: {[layerId]: CanvasImageSource} (screenshots, decoded by the caller), codec (an H.264 string from capabilities),
 * kbps, preview, signal, onProgress({k, frames, fraction, etaMs}), mb, env: {now, setTimeout, clearTimeout, webkit},
 * mk (canvas factory), draw (composeFrame), watchdogMs}.
 * → {blob, mime, bytes, w, h, fps, seconds, kbps, path: 'webcodecs', poster (data URL | null), audio: 'copy'|'mix'|'none'}.
 */
export async function renderCut(args) {
  const { file, graph: g, shots = {}, images = {}, kbps = 2500, preview = false, signal = null, onProgress = null } = args;
  const env = args.env || {};
  const now = env.now || (() => (globalThis.performance?.now?.() ?? Date.now()));
  const setT = env.setTimeout || setTimeout, clearT = env.clearTimeout || clearTimeout;
  const mk = args.mk || makeCanvas, draw = args.draw || composeFrame;
  const wd = args.watchdogMs || WATCHDOG_MS;
  if (signal?.aborted) throw abortError();
  if (!g?.frames) throw new RenderError('source', 'Nothing to cut — the plan has no beats.');
  const m = args.mb || (await loadMediabunny());
  const inputs = [], readers = new Map(), opened = [];
  let output = null, finished = false;
  try {
    const src = openInput(m, file);
    inputs.push(src);
    const vtrack = await src.getPrimaryVideoTrack();
    if (!vtrack) throw new RenderError('source', MESSAGES.source);
    if (!(await vtrack.canDecode())) throw new RenderError('no-decode', MESSAGES.noDecode);
    const atrack = g.audio?.mode === 'copy' || g.audio?.mode === 'mix' ? await src.getPrimaryAudioTrack() : null;
    const srcSink = new m.VideoSampleSink(vtrack);
    const shotSinks = new Map();
    for (const [id, blob] of Object.entries(shots)) {
      if (!blob) continue;
      const inp = openInput(m, blob);
      inputs.push(inp);
      const t = await inp.getPrimaryVideoTrack();
      if (t) shotSinks.set(id, { sink: new m.VideoSampleSink(t), input: inp, track: t });
    }

    // the canvas the encoder reads, and the output
    const canvas = mk(g.w, g.h), ctx = canvas.getContext('2d', { alpha: false });
    output = new m.Output({ format: new m.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new m.BufferTarget() });
    const quality = typeof m.Quality === 'function' ? new m.Quality({ bitrate: kbps * 1000, bitrateMode: 'variable' }) : undefined;
    const vsrc = new m.CanvasSource(canvas, {
      codec: 'avc', ...(quality ? { quality } : { bitrate: kbps * 1000 }), keyFrameInterval: 2,
      latencyMode: env.webkit ? 'realtime' : 'quality', ...(args.codec ? { fullCodecString: args.codec } : {}),
    });
    output.addVideoTrack(vsrc, { frameRate: g.fps });

    // audio
    let audioMode = 'none', asrc = null, packets = null, nextPacket = null, firstMeta = null;
    if (atrack && g.audio.mode === 'copy') {
      audioMode = 'copy';
      asrc = new m.EncodedAudioPacketSource(atrack.codec ?? (await atrack.getCodec()));
      output.addAudioTrack(asrc);
      firstMeta = { decoderConfig: await atrack.getDecoderConfig() };
      packets = new m.EncodedPacketSink(atrack).packets()[Symbol.asyncIterator]();
      opened.push(packets);
    } else if (atrack && g.audio.mode === 'mix' && typeof m.AudioSampleSource === 'function') {
      audioMode = 'mix';
      asrc = new m.AudioSampleSource({ codec: 'aac', bitrate: AAC_KBPS * 1000 });
      output.addAudioTrack(asrc);
    }
    await output.start();

    // keep mode: the source's packets, timestamps untouched, interleaved ahead of the picture by `lead` seconds
    const D = g.audio?.end ?? g.duration, lead = g.audio?.lead ?? 0.5;
    const pumpAudio = async (until) => {
      if (audioMode !== 'copy') return;
      for (;;) {
        if (!nextPacket) { const r = await packets.next(); if (r.done) { audioMode = 'done'; return; } nextPacket = r.value; }
        if (!(nextPacket.timestamp < until)) return;
        const p = nextPacket; nextPacket = null;
        if (keepPackets([p.timestamp], D).length) { await asrc.add(p, firstMeta || undefined); firstMeta = null; }
      }
    };

    const times = sampleTimes(g), spans = itemSpans(g);
    const items = new Map(g.items.map((it) => [it.id, it])), layerMap = new Map(g.layers.map((l) => [l.id, l]));
    const cache = new Map();
    const readerFor = (it) => {
      let r = readers.get(it.id);
      if (r) return r;
      const list = times[it.id];
      if (!list?.length) return null;
      const sink = it.type === 'shot' ? shotSinks.get(it.shot)?.sink : srcSink;
      if (!sink) return null;
      r = itemReader(sink, list);
      readers.set(it.id, r);
      return r;
    };
    const posterK = Math.min(g.frames - 1, Math.round(0.5 * g.fps));
    let poster = null;
    const t0 = now();
    for (let k = 0; k < g.frames; k++) {
      if (signal?.aborted) throw abortError();
      const gf = graphFrame(g, k);
      const frames = {};
      for (const d of gf.draws) {
        const it = items.get(d.id);
        if (!it) continue;
        if (it.type === 'card' && !it.card?.backdrop?.kind?.startsWith('frame')) continue;
        const r = readerFor(it);
        if (!r) continue;
        const want = it.type === 'card' ? it.card.backdrop.t : d.media;
        frames[d.id] = await r.get(want);
      }
      draw(ctx, gf, g, { frames, images }, { cache, mk, itemMap: items, layerMap });
      // items whose last frame this was: close their decoder now
      for (const [id, s] of spans) if (s.last === k && readers.has(id)) { await readers.get(id).close(); readers.delete(id); cache.delete(`blur:${id}`); }
      await pumpAudio(gf.t + lead);
      await watchdog(vsrc.add(gf.t, 1 / g.fps), wd, setT, clearT);
      if (k === posterK && !preview) { try { poster = await snapshot(canvas, mk); } catch { poster = null; } }
      if (onProgress && (k % 5 === 0 || k === g.frames - 1)) {
        const el = now() - t0, f = (k + 1) / g.frames;
        onProgress({ k: k + 1, frames: g.frames, fraction: f, etaMs: f > 0.02 ? Math.round((el / f) * (1 - f)) : null });
      }
    }
    await pumpAudio(Infinity);
    if (audioMode === 'mix') await mixAudio(m, { atrack, shotSinks, g, asrc, signal });
    vsrc.close?.(); asrc?.close?.();
    await output.finalize();
    finished = true;
    const buf = output.target.buffer;
    const blob = new Blob([buf], { type: 'video/mp4' });
    return { blob, mime: 'video/mp4', bytes: blob.size, w: g.w, h: g.h, fps: g.fps, seconds: g.duration, kbps, path: 'webcodecs', poster, audio: audioMode === 'done' ? 'copy' : audioMode };
  } catch (err) {
    if (output && !finished) { try { await output.cancel(); } catch {} }
    if (isAbort(err) || err instanceof RenderError) throw err;
    if (signal?.aborted) throw abortError();
    throw new RenderError('encode', `The cut failed: ${String(err?.message || err).slice(0, 200)} — tap Try again.`);
  } finally {
    for (const r of readers.values()) await r.close();
    for (const it of opened) { try { await it.return?.(); } catch {} }
    for (const inp of inputs) { try { inp.dispose?.(); } catch {} }
  }
}

// follow_cuts: the whole soundtrack assembled in memory (≤ 90 s on phones — normalizePlan blocks longer) then encoded.
async function mixAudio(m, { atrack, shotSinks, g, asrc, signal }) {
  const rate = atrack.sampleRate || (await atrack.getSampleRate());
  const channels = Math.min(2, atrack.numberOfChannels || (await atrack.getNumberOfChannels()) || 2);
  const total = Math.round(g.duration * rate);
  const out = Array.from({ length: channels }, () => new Float32Array(total));
  // Cut points stay where the plan put them (frame-snapped): finding the quietest 10 ms needs an rms() over decoded
  // source windows, which mixOps takes once that decode is wired (TODO, phase 5); the 20 ms ramps already hide clicks.
  for (const op of mixOps(g.audio, rate)) {
    if (op.kind === 'silence') continue;
    let track = atrack;
    if (op.kind === 'shot') {
      const s = shotSinks.get(op.shot);
      track = s ? await s.input.getPrimaryAudioTrack() : null;
      if (!track) continue;
    }
    const pcm = await decodeRange(m, track, op.mediaIn, op.mediaOut, channels, signal);
    mixInto(out, pcm, op);
  }
  const block = 4096;
  for (let i = 0; i < total; i += block) {
    if (signal?.aborted) throw abortError();
    const n = Math.min(block, total - i);
    const data = new Float32Array(n * channels);
    for (let c = 0; c < channels; c++) data.set(out[c].subarray(i, i + n), c * n);
    const s = new m.AudioSample({ data, format: 'f32-planar', numberOfChannels: channels, sampleRate: rate, timestamp: i / rate });
    await asrc.add(s);
    s.close?.();
  }
}

/** The encoder canvas at its current frame → a ≤ 480 px JPEG data URL (the cut's poster). */
async function snapshot(canvas, mk) {
  const k = Math.min(1, POSTER_EDGE / Math.max(canvas.width, canvas.height));
  const c = mk(canvas.width * k, canvas.height * k);
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  return canvasToDataUrl(c, 0.82);
}
