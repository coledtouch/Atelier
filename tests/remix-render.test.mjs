import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// public/remix-render.js — the render engine's orchestration against a fake Mediabunny/WebCodecs: what gets decoded,
// drawn, encoded and muxed, in which order, and that every decoded sample is closed. The real engine (Mediabunny +
// WebCodecs) is exercised in the browser by scripts/remix-browser-check.mjs.
const X = await import('../public/remix-render.js');
const R = await import('../public/remix.js');
const G = await import('../public/remix-graph.js');
const { cutsFrom } = await import('../public/remix-cuts.js');
const FX = JSON.parse(readFileSync(new URL('./fixtures/remix/remix-plan-promo.json', import.meta.url), 'utf8'));
const LUMA = JSON.parse(readFileSync(new URL('./fixtures/remix/promo-luma.json', import.meta.url), 'utf8'));
const SRC = { duration: 48, width: 1080, height: 1350, fps: 30, vkbps: 1046, rotation: 0 };

// ── a fake Mediabunny ──
function fakeMb({ audioPts = [], canDecode = true, stallAt = -1, frameRate = 30 } = {}) {
  const log = { samples: 0, closed: 0, iterators: 0, returned: 0, added: [], audioAtAdd: [], audio: [], disposed: 0, cancelled: 0, finalized: 0, started: 0, requested: [], tracks: [] };
  class Track {
    constructor(kind, file) { this.kind = kind; this.file = file; this.codec = kind === 'video' ? 'avc' : 'aac'; this.displayWidth = file.w || 1080; this.displayHeight = file.h || 1350; this.codedWidth = this.displayWidth; this.codedHeight = this.displayHeight; this.sampleRate = 48000; this.numberOfChannels = 2; }
    async getRotation() { return 0; }
    async canDecode() { return canDecode; }
    async getCodec() { return this.codec; }
    async hasHighDynamicRange() { return false; }
    async computePacketStats() { return this.kind === 'video' ? { packetCount: 1440, averagePacketRate: frameRate, averageBitrate: 1_173_000 } : { packetCount: audioPts.length, averagePacketRate: 46.875, averageBitrate: 128_000 }; }
    async getDecoderConfig() { return { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 }; }
  }
  class Input {
    constructor({ source }) { this.file = source.file; }
    async getPrimaryVideoTrack() { const t = new Track('video', this.file); log.tracks.push(t); return t; }
    async getPrimaryAudioTrack() { return this.file.audio === false ? null : new Track('audio', this.file); }
    async computeDuration() { return this.file.duration ?? 48; }
    dispose() { log.disposed++; }
  }
  class VideoSampleSink {
    constructor(track) { this.track = track; }
    samplesAtTimestamps(times) {
      log.requested.push({ file: this.track.file.name, times: [...times] });
      log.iterators++;
      const list = [...times];
      return (async function* () {
        try {
          for (const t of list) { log.samples++; yield { timestamp: t, file: list, close() { log.closed++; }, drawWithFit() {} }; }
        } finally { log.returned++; }
      })();
    }
  }
  class EncodedPacketSink {
    constructor(track) { this.track = track; }
    packets() { return (async function* () { for (const t of audioPts) yield { timestamp: t, duration: 0.021333, type: 'key', data: new Uint8Array(4) }; })(); }
    async getFirstKeyPacket() { return { timestamp: 0 }; }
    async getNextKeyPacket(p) { return p.timestamp < 46 ? { timestamp: p.timestamp + 2 } : null; }
  }
  class CanvasSink {
    constructor(track, opts) { this.track = track; this.opts = opts; }
    async *canvases() {
      for (let i = 0; i < 90; i++) {
        const v = i < 45 ? 40 : 200; // a hard cut at 1.5 s
        yield { timestamp: i / 30, canvas: { width: 64, height: 80, getContext: () => ({ getImageData: () => ({ data: new Uint8ClampedArray(64 * 80 * 4).fill(v) }) }) } };
      }
    }
  }
  class CanvasSource {
    constructor(canvas, cfg) { this.canvas = canvas; this.cfg = cfg; log.videoConfig = cfg; }
    add(t, d) { log.added.push([t, d]); log.audioAtAdd.push([t, log.audio.length]); if (log.added.length - 1 === stallAt) return new Promise(() => {}); return Promise.resolve(); }
    close() { log.videoClosed = true; }
  }
  class EncodedAudioPacketSource {
    constructor(codec) { log.audioCodec = codec; }
    async add(p, meta) { log.audio.push({ t: p.timestamp, meta }); }
    close() {}
  }
  class Output {
    constructor(o) { this.o = o; this.target = o.target; }
    addVideoTrack(src, meta) { log.videoMeta = meta; }
    addAudioTrack() { log.hasAudio = true; }
    async start() { log.started++; }
    async finalize() { log.finalized++; this.target.buffer = new Uint8Array(1000).buffer; }
    async cancel() { log.cancelled++; }
  }
  return {
    log,
    mb: {
      Input, BlobSource: class { constructor(file) { this.file = file; } }, ALL_FORMATS: [],
      VideoSampleSink, EncodedPacketSink, CanvasSink, CanvasSource, EncodedAudioPacketSource, Output,
      Mp4OutputFormat: class { constructor(o) { log.format = o; } }, BufferTarget: class {}, Quality: class { constructor(o) { this.o = o; } },
      canEncodeAudio: async () => true,
    },
  };
}
const fakeCanvas = (w, h) => ({ width: Math.round(w), height: Math.round(h), getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }), toDataURL: () => 'data:image/jpeg;base64,QUJD' });
const file = (o = {}) => ({ name: 'Atelier-promo-4x5.mp4', size: 8_290_821, duration: 48, ...o });
const graph = (fps = 10, plan = FX.plan, opts = { maxNew: 0 }) => {
  const s = R.settlePlan(plan, { source: SRC, opts, cuts: cutsFrom(LUMA.polished) });
  return G.buildGraph(s.layout, s.plan, { fps, out: { w: 1080, h: 1350 }, source: SRC });
};
// keep mode: 2251 AAC packets with the priming packet at −0.021333 (the design's measurement)
const PTS = Array.from({ length: 2251 }, (_, i) => Math.round((-0.021333 + i * 0.021333) * 1e6) / 1e6);

test('lumaStats: mean luma and a 16-bin histogram in the cuts.parseHist form', () => {
  const d = new Uint8ClampedArray(8 * 4);
  for (let i = 0; i < 8; i++) { const v = i < 4 ? 0 : 255; d.set([v, v, v, 255], i * 4); }
  const s = X.lumaStats(d);
  assert.equal(s.luma, 127.5);
  assert.equal(s.hist.length, 32);
  assert.equal(s.hist.slice(0, 2), '80', 'half the pixels in bin 0 (128/255)');
  assert.equal(s.hist.slice(30), '80');
});

test('pickH264 / capabilities: first supported profile; no WebCodecs → a clear "can’t assemble" path', async () => {
  const supported = new Set(['avc1.4d0028']);
  const env = { VideoEncoder: Object.assign(function () {}, { isConfigSupported: async (c) => ({ supported: supported.has(c.codec) }) }), VideoDecoder: function () {}, VideoFrame: function () {}, navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 15) Chrome/140' } };
  assert.equal(await X.pickH264({ w: 1088, h: 1360 }, env), 'avc1.4d0028');
  const { mb } = fakeMb();
  const c = await X.capabilities({ out: { w: 1088, h: 1360 }, mb, env });
  assert.deepEqual({ path: c.path, h264: c.h264, aac: c.aacEncode, platform: c.platform }, { path: 'webcodecs', h264: 'avc1.4d0028', aac: true, platform: 'android' });
  const none = await X.capabilities({ mb, env: { navigator: { userAgent: 'Firefox' } } });
  assert.equal(none.path, 'none');
  assert.equal(none.reason, X.MESSAGES.unsupported);
  supported.clear();
  const noH = await X.capabilities({ mb, env });
  assert.equal(noH.path, 'none');
  assert.equal(noH.reason, X.MESSAGES.noH264);
});

test('platformOf: android, ios (iPadOS too), desktop', () => {
  assert.equal(X.platformOf('Mozilla/5.0 (Linux; Android 15)'), 'android');
  assert.equal(X.platformOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)'), 'ios');
  assert.equal(X.platformOf('Mozilla/5.0 (Windows NT 10.0) Chrome/140'), 'desktop');
});

test('probeSource: the facts validRemix stores, from the primary tracks', async () => {
  const { mb, log } = fakeMb();
  const p = await X.probeSource(file(), { mb });
  assert.deepEqual(p, { name: 'Atelier-promo-4x5.mp4', size: 8290821, duration: 48, width: 1080, height: 1350, codedWidth: 1080, codedHeight: 1350, rotation: 0, fps: 30, vcodec: 'avc1', vkbps: 1173, audio: 'aac', hasAudio: true, hdr: false, canDecode: true, audioCanDecode: true });
  assert.equal(log.disposed, 1);
  const r = R.validRemix({ v: 1, phase: 'plan', source: { ...p, codedWidth: undefined, codedHeight: undefined } });
  assert.equal(r, true);
});

test('analyseSource: one luma + histogram per frame, keyframes, fps; feeds cutsFrom', async () => {
  const { mb } = fakeMb();
  const a = await X.analyseSource(file({ duration: 3 }), { mb });
  assert.equal(a.luma.length, 90);
  assert.equal(a.hist.length, 90);
  assert.equal(a.fps, 30);
  assert.deepEqual(a.keyframes.slice(0, 3), [0, 2, 4]);
  const cuts = cutsFrom(a);
  assert.deepEqual(cuts.hard, [1.5], 'the jump at frame 45 is a hard cut');
  const ctrl = new AbortController(); ctrl.abort();
  await assert.rejects(X.analyseSource(file(), { mb, signal: ctrl.signal }), { name: 'AbortError' });
});

test('itemSpans / itemReader: each item’s decoder opens for its frames only; samples are closed when replaced', async () => {
  const g = graph(10);
  const spans = X.itemSpans(g);
  assert.deepEqual(spans.get('open'), { first: 0, last: 239 });
  assert.deepEqual(spans.get('tools'), { first: 240, last: 259 });
  const { mb, log } = fakeMb();
  const r = X.itemReader(new mb.VideoSampleSink({ file: { name: 'x' } }), [0, 0.1, 0.2, 0.3]);
  assert.equal((await r.get(0)).timestamp, 0);
  assert.equal((await r.get(0.05)).timestamp, 0, 'between listed times: the earlier sample');
  assert.equal((await r.get(0.2)).timestamp, 0.2);
  assert.equal(log.closed, 2);
  await r.close();
  assert.equal(log.closed, 3);
  assert.equal(log.returned, 1);
});

test('renderCut: every frame drawn and encoded at k/fps; audio packets copied untouched with the priming packet; all samples closed', async () => {
  const g = graph(10);
  const { mb, log } = fakeMb({ audioPts: PTS });
  const drawn = [];
  const progress = [];
  const res = await X.renderCut({
    file: file(), graph: g, kbps: 2350, codec: 'avc1.640028', mb, mk: fakeCanvas,
    draw: (ctx, gf, gg, src) => { drawn.push({ k: gf.k, ids: Object.keys(src.frames), media: Object.values(src.frames).map((s) => s?.timestamp) }); },
    onProgress: (p) => progress.push(p),
    env: { now: (() => { let t = 0; return () => (t += 10); })() },
  });
  assert.equal(drawn.length, g.frames);
  assert.equal(log.added.length, g.frames);
  assert.deepEqual(log.added.slice(0, 3), [[0, 0.1], [0.1, 0.1], [0.2, 0.1]]);
  assert.deepEqual(log.videoConfig.fullCodecString, 'avc1.640028');
  assert.equal(log.videoConfig.keyFrameInterval, 2);
  assert.deepEqual(log.videoConfig.quality.o, { bitrate: 2_350_000, bitrateMode: 'variable' });
  assert.deepEqual(log.format, { fastStart: 'in-memory' });
  // the card at 25 s draws its blurred backdrop: the source still at backdrop.t
  const card = drawn.find((d) => d.k === 250);
  assert.deepEqual(card.ids, ['tools']);
  assert.equal(card.media[0], g.items.find((i) => i.id === 'tools').card.backdrop.t);
  // the 'models' clip at 30 s output is source 28.0
  assert.equal(drawn.find((d) => d.k === 300).media[0], 28);
  // keep mode: packets < D in, original timestamps, decoder config on the first only
  assert.equal(log.audio.length, PTS.filter((t) => t < 48).length);
  assert.equal(log.audio[0].t, -0.021333, 'priming packet kept at its own negative pts');
  assert.ok(log.audio[0].meta.decoderConfig);
  assert.equal(log.audio[1].meta, undefined);
  assert.equal(res.audio, 'copy');
  // memory: every sample that was decoded is closed; every iterator returned; inputs disposed
  assert.equal(log.closed, log.samples);
  assert.equal(log.returned, log.iterators);
  assert.equal(log.disposed, 1);
  assert.equal(log.finalized, 1);
  assert.equal(res.bytes, 1000);
  assert.equal(res.mime, 'video/mp4');
  assert.match(res.poster, /^data:image\/jpeg;base64,/);
  assert.equal(progress.at(-1).fraction, 1);
});

test('renderCut: audio leads the picture by 0.5 s — every packet with pts < t + 0.5 is in before frame t', async () => {
  const g = graph(5);
  const { mb, log } = fakeMb({ audioPts: PTS });
  await X.renderCut({ file: file(), graph: g, mb, mk: fakeCanvas, draw: () => {} });
  for (const [t, n] of log.audioAtAdd.filter((_, i) => i % 40 === 0)) {
    const due = PTS.filter((p) => p < t + 0.5 - 1e-9 && p < 48).length;
    assert.ok(n >= due - 1 && n <= due + 1, `at ${t}s: ${n} packets in, ${due} due`);
  }
});

test('renderCut: shots decode from their own blob at use_in…use_out; a missing decoder is refused up front', async () => {
  const plan = structuredClone(FX.plan);
  plan.shots = [{ id: 's1', prompt: 'A walnut desk at dawn', seconds: 4, camera: 'static' }];
  plan.timeline.splice(2, 0, { id: 'v1', type: 'shot', shot: 's1', use_in: 0.5, use_out: 2.5 });
  const g = graph(10, plan, { maxNew: 8 });
  const { mb, log } = fakeMb({ audioPts: PTS });
  await X.renderCut({ file: file(), graph: g, shots: { s1: { name: 'shot.mp4', w: 720, h: 1280 } }, mb, mk: fakeCanvas, draw: () => {} });
  const req = log.requested.find((r) => r.file === 'shot.mp4');
  assert.equal(req.times[0], 0.5);
  assert.ok(req.times.at(-1) < 2.5);
  assert.equal(log.disposed, 2, 'the source and the shot input');
  const bad = fakeMb({ canDecode: false });
  await assert.rejects(X.renderCut({ file: file(), graph: g, mb: bad.mb, mk: fakeCanvas, draw: () => {} }), (e) => e.code === 'no-decode' && e.message === X.MESSAGES.noDecode);
  assert.equal(bad.log.started, 0, 'nothing encoded');
});

test('renderCut: Cancel aborts, cancels the output and still closes everything', async () => {
  const g = graph(10);
  const { mb, log } = fakeMb({ audioPts: PTS });
  const ctrl = new AbortController();
  await assert.rejects(X.renderCut({ file: file(), graph: g, mb, mk: fakeCanvas, signal: ctrl.signal, draw: (ctx, gf) => { if (gf.k === 100) ctrl.abort(); } }), { name: 'AbortError' });
  assert.equal(log.cancelled, 1);
  assert.equal(log.finalized, 0);
  assert.equal(log.closed, log.samples);
  assert.equal(log.returned, log.iterators);
  assert.equal(log.disposed, 1);
});

test('renderCut: an encoder that stops answering trips the watchdog with a retryable message', async () => {
  const g = graph(5);
  const { mb, log } = fakeMb({ stallAt: 3 });
  await assert.rejects(X.renderCut({ file: file({ audio: false }), graph: g, mb, mk: fakeCanvas, draw: () => {}, watchdogMs: 20 }), (e) => e.code === 'stalled' && e.message === X.MESSAGES.stalled);
  assert.equal(log.cancelled, 1);
});

test('mixOps / mixInto: follow_cuts segments in samples with ramps; silence stays silent; shot audio at −6 dB', () => {
  const audio = { mode: 'mix', ramp: 0.02, snap: 0.15, window: 0.01, segments: [
    { kind: 'source', outStart: 0, outEnd: 1, mediaIn: 2, mediaOut: 3, gainDb: 0 },
    { kind: 'silence', outStart: 1, outEnd: 1.5, gainDb: 0 },
    { kind: 'shot', shot: 's1', outStart: 1.5, outEnd: 2, mediaIn: 0, mediaOut: 0.5, gainDb: -6 },
  ] };
  const ops = X.mixOps(audio, 1000);
  assert.deepEqual(ops.map((o) => [o.kind, o.outStart, o.outEnd, o.ramp]), [['source', 0, 1000, 20], ['silence', 1000, 1500, 20], ['shot', 1500, 2000, 20]]);
  assert.ok(Math.abs(ops[2].gain - 0.501) < 0.001);
  // a quiet window 0.05 s later wins the snap
  const snapped = X.mixOps(audio, 1000, (a) => (Math.abs(a - 2.05) < 0.004 ? 0 : 1));
  assert.equal(snapped[0].mediaIn, 2.05);
  const out = [new Float32Array(2000)];
  X.mixInto(out, [new Float32Array(1000).fill(1)], ops[0]);
  assert.equal(out[0][0], 0, 'ramped in');
  assert.equal(out[0][500], 1);
  assert.equal(out[0][1200], 0, 'silence');
});
