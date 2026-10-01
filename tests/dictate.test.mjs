// Dictation on the client (public/dictate.js): platform and engine choice, the VAD, the helpers, and the controller
// driven with fake MediaRecorder / SpeechRecognition / getUserMedia / AudioContext / fetch on a fake clock.
// No real provider or network is ever called.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  DICTATE_LIMITS, VAD_DEFAULTS, RECORDER_TYPES, RECORDER_TYPES_APPLE, STATES, SAY, MIC_HELP,
  platformOf, pickEngine, pickRecorderType, baseType, sniffAudio, uploadType, isoLang, langTag, promptHeader, rms, meterLevel, clock, createVad,
  mergeResults, micHelp, micError, speechError, refusalMessage, retryAfterS, insertText, createDictation, startFromGesture,
} from '../public/dictate.js';

// ── user agents ──
const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1',
  iphoneEdge: 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 EdgiOS/141.0.0.0 Mobile/15E148 Safari/605.1.15',
  iphoneFirefox: 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/143.0 Mobile/15E148 Safari/605.1.15',
  iphoneLinkedIn: 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [LinkedInApp]/9.31.1234',
  iphoneApp: 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  ipad: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15',
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  android: 'Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0',
};

// ── console capture: nothing logged may hold the transcript, the passcode or the audio ──
let logs = [];
const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
beforeEach(() => { logs = []; for (const k of Object.keys(saved)) console[k] = (...a) => logs.push(a.map(String).join(' ')); });
afterEach(() => { Object.assign(console, saved); });

// ── a fake clock: timers run only when the test advances time ──
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
function fakeClock() {
  let t = 1_000_000, seq = 0;
  const q = new Map();
  const add = (f, ms, every) => { const id = ++seq; q.set(id, { at: t + Math.max(0, Number(ms) || 0), f, every }); return id; };
  return {
    now: () => t,
    pending: () => q.size,
    setTimeout: (f, ms) => add(f, ms, 0), clearTimeout: (id) => { q.delete(id); },
    setInterval: (f, ms) => add(f, ms, Math.max(1, Number(ms) || 1)), clearInterval: (id) => { q.delete(id); },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [id, e] of q) if (e.at <= end && (!next || e.at < next[1].at || (e.at === next[1].at && id < next[0]))) next = [id, e];
        if (!next) break;
        const [id, e] = next;
        t = e.at;
        if (e.every) e.at += e.every; else q.delete(id);
        e.f();
        await flush(3);
      }
      t = end;
      await flush();
    },
  };
}

// ── fake media ──
const MAGIC = {
  mp4: [0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x36, 0x00, 0x00, 0x00, 0x00],
  webm: [0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0xf2, 0x81],
};
const audioBytes = (kind, size) => { const b = new Uint8Array(size); b.set(MAGIC[kind] || []); for (let i = 16; i < size; i++) b[i] = (i * 31) & 0xff; return b; };

function fakeStream() {
  const track = new EventTarget();
  track.kind = 'audio'; track.readyState = 'live'; track.stops = 0;
  track.stop = () => { track.stops++; track.readyState = 'ended'; };
  return { track, getTracks: () => [track], getAudioTracks: () => [track] };
}
function fakeRecorder({ supported = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'], bytes = 6_000, defaultType } = {}) {
  const made = [];
  class MR {
    static isTypeSupported(t) { return supported.includes(t); }
    constructor(stream, o = {}) {
      if (o.mimeType && !supported.includes(o.mimeType)) throw Object.assign(new Error('unsupported'), { name: 'NotSupportedError' });
      Object.assign(this, { stream, options: o, mimeType: o.mimeType || defaultType || supported[0] || '', state: 'inactive' });
      made.push(this);
    }
    start(ts) { this.timeslice = ts; this.state = 'recording'; }
    stop() {
      if (this.state === 'inactive') throw Object.assign(new Error('inactive'), { name: 'InvalidStateError' });
      this.state = 'inactive';
      const kind = this.mimeType.startsWith('audio/webm') ? 'webm' : 'mp4';
      Promise.resolve().then(() => {
        if (MR.bytes > 0) this.ondataavailable?.({ data: new Blob([audioBytes(kind, MR.bytes)], { type: this.mimeType }) });
        this.onstop?.();
      });
    }
  }
  MR.made = made; MR.bytes = bytes;
  return MR;
}
function fakeAudioContext(mic) {
  const made = [];
  class AC {
    constructor() { Object.assign(this, { state: mic.ctxState || 'running', destination: {}, closed: false }); made.push(this); }
    resume() { return Promise.resolve(); }
    close() { this.closed = true; this.state = 'closed'; return Promise.resolve(); }
    createMediaStreamSource() { return { connect() {} }; }
    createAnalyser() { return { fftSize: 2048, connect() {}, getFloatTimeDomainData(buf) { buf.fill(mic.level); } }; }
    createGain() { return { gain: { value: 1 }, connect() {} }; }
  }
  AC.made = made;
  return AC;
}
// Results as a SpeechRecognitionResultList: [[{transcript}], isFinal]
const results = (...pieces) => pieces.map(([text, isFinal = false]) => Object.assign([{ transcript: text, confidence: 0.9 }], { isFinal }));
function fakeSpeech(log) {
  const made = [];
  class SR {
    constructor() { made.push(this); this.running = false; this.aborts = 0; this.stops = 0; }
    start() { if (SR.throwOnStart) throw Object.assign(new Error('nope'), { name: SR.throwOnStart }); this.running = true; log.push('sr:start'); }
    stop() { this.stops++; if (SR.endOnStop !== false) Promise.resolve().then(() => this.end()); }
    abort() { this.aborts++; Promise.resolve().then(() => { this.onerror?.({ error: 'aborted' }); this.end(); }); }
    emit(type, ev = {}) { this[`on${type}`]?.(ev); }
    result(...pieces) { this.onresult?.({ results: results(...pieces) }); }
    end() { if (!this.running && this.ended) return; this.running = false; this.ended = true; log.push('sr:end'); this.onend?.(); }
  }
  SR.made = made;
  return SR;
}
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/**
 * A dictation controller on fake everything. o: ua, standalone, speech (give it a SpeechRecognition), server (serverReady
 * result), replies (fetch answers in order: a Response, a function, or an Error to throw), recorder options, gum
 * (a function returning the getUserMedia promise), level (mic RMS), ctxState, tester, lang, limits, vad, onLine.
 */
function rig(o = {}) {
  const log = [], c = fakeClock(), mic = { level: o.level ?? 0, ctxState: o.ctxState };
  const MR = fakeRecorder(o.recorder);
  const AC = fakeAudioContext(mic);
  const SR = o.speech === false ? undefined : fakeSpeech(log);
  const streams = [];
  const nav = {
    userAgent: o.ua ?? UA.iphone, platform: o.platform ?? '', maxTouchPoints: o.maxTouchPoints ?? 5, language: o.navLang ?? 'en-US',
    standalone: o.standalone ?? false, onLine: o.onLine ?? true, ...(o.permissions ? { permissions: o.permissions } : {}),
    mediaDevices: {
      calls: 0,
      getUserMedia(constraints) {
        this.calls++; log.push('gum');
        // getUserMedia and recognition never run together
        assert.ok(!(SR?.made || []).some((r) => r.running), 'getUserMedia while a recognizer is running');
        nav.mediaDevices.constraints = constraints;
        if (o.gum) return o.gum(constraints);
        const s = fakeStream(); streams.push(s);
        return Promise.resolve(s);
      },
    },
  };
  const replies = [...(o.replies || [])], calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: init.body, headers: init.headers });
    log.push('fetch');
    const next = replies.shift();
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next(url, init);
    return next || json({ text: 'hello there', provider: 'openai' }, 200, { 'x-transcribe-provider': 'openai' });
  };
  const states = [], details = [], texts = [], toasts = [], levels = [], responses = [], refusals = [];
  let before = 0;
  const doc = new EventTarget(); doc.visibilityState = 'visible';
  const d = createDictation({
    navigator: nav, MediaRecorder: o.noRecorder ? undefined : MR, AudioContext: AC, SpeechRecognition: SR, document: doc,
    matchMedia: (q) => ({ matches: Boolean(o.standaloneMedia) && /standalone/.test(q) }),
    fetch, now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, setInterval: c.setInterval, clearInterval: c.clearInterval,
    apiHeaders: (extra = {}) => ({ 'content-type': 'application/json', ...extra, ...(o.tester ? {} : { 'x-app-pass': 'pass-SECRET-1234' }) }),
    serverReady: () => (o.server === undefined ? true : o.server),
    isTester: () => Boolean(o.tester), lang: () => o.lang ?? 'en-US',
    beforeStart: () => { before++; log.push('beforeStart'); },
    onState: (s, detail) => { states.push(s); details.push(detail); log.push(`state:${s}`); if (o.onState) o.onState(s, detail); },
    onText: (t, detail) => texts.push({ t, ...detail }),
    onLevel: (l, detail) => levels.push({ l, ...detail }),
    onResponse: (r) => responses.push(r.status),
    onRefusal: (info) => refusals.push(info),
    toast: (m, { error } = {}) => toasts.push({ m, error }),
    limits: o.limits, vad: o.vad,
  });
  return { d, c, mic, MR, AC, SR, nav, doc, streams, calls, states, details, texts, toasts, levels, responses, refusals, log, before: () => before };
}
const lastState = (r) => r.states.at(-1);
const allStopped = (r) => r.streams.every((s) => s.track.readyState === 'ended');
const speakFor = async (r, ms, level = 0.1) => { r.mic.level = level; await r.c.advance(ms); };

// ── pure helpers ──
test('platformOf: iPhone, iPadOS-as-Mac, Android, desktop, and the Home Screen app', () => {
  assert.deepEqual(platformOf({ userAgent: UA.iphone }), { ios: true, android: false, apple: true, standalone: false, browser: 'safari' });
  assert.equal(platformOf({ userAgent: UA.iphoneChrome }).ios, true, 'Chrome on iPhone is WebKit too');
  assert.equal(platformOf({ userAgent: UA.iphoneChrome }).browser, 'Chrome');
  assert.equal(platformOf({ userAgent: UA.iphoneEdge }).browser, 'Edge');
  assert.equal(platformOf({ userAgent: UA.iphoneFirefox }).browser, 'Firefox');
  assert.equal(platformOf({ userAgent: UA.iphoneLinkedIn }).browser, 'inapp', 'an app’s built-in browser: no Safari/ token');
  assert.equal(platformOf({ userAgent: UA.iphoneApp, standalone: true }).browser, 'safari', 'the Home Screen app drops Safari/ too');
  assert.equal(platformOf({ userAgent: UA.ipad, platform: 'MacIntel', maxTouchPoints: 5 }).browser, 'safari');
  assert.equal(platformOf({ userAgent: UA.android }).browser, null);
  assert.equal(platformOf({ userAgent: UA.ipad, platform: 'MacIntel', maxTouchPoints: 5 }).ios, true, 'iPadOS says Mac but has touch');
  assert.equal(platformOf({ userAgent: UA.macSafari, platform: 'MacIntel', maxTouchPoints: 0 }).ios, false);
  assert.equal(platformOf({ userAgent: UA.macSafari, platform: 'MacIntel', maxTouchPoints: 0 }).apple, true, 'Mac Safari records MP4 first');
  assert.equal(platformOf({ userAgent: UA.macChrome }).apple, false);
  assert.deepEqual(platformOf({ userAgent: UA.android }), { ios: false, android: true, apple: false, standalone: false, browser: null });
  assert.equal(platformOf({ userAgent: UA.iphone, standalone: true }).standalone, true, 'navigator.standalone (iOS Home Screen)');
  assert.equal(platformOf({ userAgent: UA.android }, (q) => ({ matches: q.includes('standalone') })).standalone, true, 'display-mode');
  assert.equal(platformOf({ userAgent: UA.android }, () => { throw new Error('no'); }).standalone, false);
  assert.deepEqual(platformOf(undefined), { ios: false, android: false, apple: false, standalone: false, browser: null });
});

test('pickEngine: never Web Speech on iPhone/iPad; Web Speech first elsewhere; recording needs the server', () => {
  for (const standalone of [false, true]) {
    assert.equal(pickEngine({ ios: true, speech: true, recorder: true, server: true, standalone }), 'record');
    assert.equal(pickEngine({ ios: true, speech: true, recorder: true, server: false, standalone }), null, 'no Web Speech fallback on iOS');
  }
  assert.equal(pickEngine({ speech: true, recorder: true, server: true }), 'speech');
  assert.equal(pickEngine({ speech: true, recorder: true, server: false }), 'speech', 'Web Speech needs no server');
  assert.equal(pickEngine({ speech: true, recorder: true, server: true, speechBroken: true }), 'record');
  assert.equal(pickEngine({ speech: true, recorder: true, server: false, speechBroken: true }), 'speech', 'nothing else can run: keep trying it (the mic stays)');
  assert.equal(pickEngine({ speech: false, recorder: true, server: true }), 'record', 'Firefox');
  assert.equal(pickEngine({ speech: true, recorder: true, server: true, prefer: 'record' }), 'record', 'a setting can prefer the server');
  assert.equal(pickEngine({ speech: true, recorder: true, server: false, prefer: 'record' }), 'speech', 'but not without it');
  assert.equal(pickEngine({ speech: false, recorder: false, server: true }), null);
  assert.equal(pickEngine(), null);
});

test('pickRecorderType: MP4/AAC first on Apple, WebM/Opus first elsewhere, "" when nothing fits', () => {
  const all = (t) => [...RECORDER_TYPES, ...RECORDER_TYPES_APPLE].includes(t);
  assert.equal(pickRecorderType(all, { apple: true }), 'audio/mp4;codecs=mp4a.40.2');
  assert.equal(pickRecorderType((t) => t === 'audio/mp4' || t === 'audio/webm;codecs=opus', { apple: true }), 'audio/mp4');
  assert.equal(pickRecorderType((t) => t.startsWith('audio/webm'), { apple: true }), 'audio/webm;codecs=opus', 'iOS 18.4+ without MP4');
  assert.equal(pickRecorderType(all), 'audio/webm;codecs=opus');
  assert.equal(pickRecorderType(() => false), '');
  assert.equal(pickRecorderType(() => { throw new Error('x'); }), '');
  assert.equal(pickRecorderType(undefined), '');
});

test('sniffAudio / uploadType / baseType label the upload by its real container', () => {
  assert.equal(sniffAudio(audioBytes('mp4', 32)), 'mp4');
  assert.equal(sniffAudio(audioBytes('webm', 32)), 'webm');
  assert.equal(sniffAudio(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])), 'wav');
  assert.equal(sniffAudio(new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0, 0])), 'mp3');
  assert.equal(sniffAudio(new TextEncoder().encode('OggS\0\x02\0\0\0\0\0\0\0\0')), 'ogg', 'Firefox');
  assert.equal(sniffAudio(new TextEncoder().encode('fLaC\0\0\0\x22\0\0\0\0')), 'flac');
  assert.equal(uploadType(new TextEncoder().encode('OggS\0\x02\0\0\0\0\0\0\0\0'), ''), 'audio/ogg');
  assert.equal(sniffAudio(new Uint8Array([0xff, 0xf1, 0x50, 0x80, 0, 0, 0, 0, 0, 0, 0, 0])), null, 'ADTS AAC (layer 0) is not MP3');
  assert.equal(sniffAudio(new Uint8Array(4)), null);
  assert.equal(sniffAudio(null), null);
  assert.equal(uploadType(audioBytes('mp4', 16), 'audio/webm'), 'audio/mp4', 'the bytes win over the label');
  assert.equal(uploadType(new Uint8Array(16), 'audio/webm;codecs=opus'), 'audio/webm');
  assert.equal(uploadType(new Uint8Array(16), ''), 'application/octet-stream');
  assert.equal(baseType('Audio/MP4; codecs="mp4a.40.2"'), 'audio/mp4');
  assert.equal(baseType('not a type'), '');
  assert.equal(baseType(undefined), '');
});

test('sniffAudio matches src/transcribe.js', async () => {
  const server = await import('../src/transcribe.js');
  assert.equal(typeof server.sniffAudio, 'function', 'src/transcribe.js exports sniffAudio');
  const kindOf = (v) => (v && typeof v === 'object' ? v.kind : v ?? null); // the server returns its format entry
  const samples = [audioBytes('mp4', 16), audioBytes('webm', 16), new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]),
    new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0, 0]), new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0, 0, 0, 0, 0]),
    new Uint8Array([0xff, 0xf1, 0x50, 0x80, 0, 0, 0, 0, 0, 0, 0, 0]), new TextEncoder().encode('OggS\0\x02\0\0\0\0\0\0\0\0'),
    new TextEncoder().encode('fLaC\0\0\0\x22\0\0\0\0'), new Uint8Array(16), new Uint8Array(3)];
  for (const b of samples) assert.equal(sniffAudio(b), kindOf(server.sniffAudio(b)), String([...b.slice(0, 12)]));
  // Every kind the client can label is one the server accepts.
  if (server.AUDIO_FORMATS) for (const b of samples) { const k = sniffAudio(b); if (k) assert.ok(server.AUDIO_FORMATS[k], k); }
});

test('isoLang: the server gets ISO 639-1 from a BCP 47 tag, or nothing', () => {
  assert.equal(isoLang('en-US'), 'en');
  assert.equal(isoLang('pt_BR'), 'pt');
  assert.equal(isoLang('zh-Hant-TW'), 'zh');
  assert.equal(isoLang('FR'), 'fr');
  assert.equal(isoLang('iw-IL'), 'he', 'legacy Android code');
  assert.equal(isoLang('in'), 'id');
  assert.equal(isoLang('nb-NO'), 'no');
  assert.equal(isoLang('fil-PH'), 'tl');
  assert.equal(isoLang('yue-HK'), '', 'no two-letter code: let the model detect it');
  assert.equal(isoLang(''), '');
  assert.equal(isoLang(null), '');
  assert.equal(isoLang('e1'), '');
  assert.equal(langTag('pt_BR'), 'pt-BR');
  assert.equal(langTag('yue-HK'), 'yue-HK', 'the whole tag still helps the fallback model');
  assert.equal(langTag('en US'), '');
  assert.equal(langTag('x'.repeat(40)), '');
  assert.equal(langTag(undefined), '');
});

test('promptHeader: one short line, percent-encoded, no markup', () => {
  assert.equal(promptHeader('  Atelier,\nCole  <b>'), encodeURIComponent('Atelier, Cole b'));
  assert.equal(decodeURIComponent(promptHeader('é'.repeat(400))).length, 300);
  assert.equal(promptHeader(''), '');
  assert.equal(promptHeader(null), '');
});

test('rms, meterLevel and clock', () => {
  assert.equal(rms(new Float32Array([0.5, -0.5, 0.5, -0.5])), 0.5);
  assert.equal(rms(new Uint8Array([128, 128])), 0);
  assert.ok(Math.abs(rms(new Uint8Array([192, 64])) - 0.5) < 1e-9);
  assert.equal(rms(null), 0);
  assert.equal(meterLevel(0), 0);
  assert.equal(meterLevel(0.001), 0, '-60 dBFS');
  assert.ok(Math.abs(meterLevel(0.316) - 1) < 0.01, '-10 dBFS');
  assert.ok(meterLevel(0.03) > 0.2 && meterLevel(0.03) < 0.6);
  assert.equal(clock(0), '0:00');
  assert.equal(clock(7_400), '0:07');
  assert.equal(clock(119_999), '1:59');
  assert.equal(clock(-5), '0:00');
});

// ── the VAD ──
const feed = (vad, frames, from = 0, step = 50) => { let t = from, out; for (const level of frames) { out = vad.push(level, t); t += step; } return { out, t }; };
const n = (count, level) => Array(count).fill(level);

test('VAD: 1 s of speech arms it; then 2.5 s of quiet stops it', () => {
  const v = createVad();
  let r = feed(v, n(10, 0.002)); // 0.5 s of room noise
  assert.equal(r.out, 'waiting');
  r = feed(v, n(30, 0.1), r.t); // 1.5 s of speech
  assert.equal(r.out, 'speaking');
  assert.ok(v.heard && v.armed && v.speechMs >= 1_000);
  r = feed(v, n(48, 0.002), r.t); // 2.4 s of quiet
  assert.equal(r.out, 'speaking', 'not yet');
  r = feed(v, n(4, 0.002), r.t);
  assert.equal(r.out, 'stop');
});

test('VAD: before 1 s of speech a pause never stops it (an "um", then thinking); only noSpeechMs of quiet does', () => {
  for (const [first, ms] of [[0.08, 600], [0.1, 300], [0.1, 500]]) { // "um", a cough, a short "yes"
    const v = createVad();
    let r = feed(v, n(10, 0.003)); // the room
    r = feed(v, n(ms / 50, first), r.t);
    assert.ok(v.heard && !v.armed, `${ms} ms heard, not armed`);
    r = feed(v, n(Math.round(VAD_DEFAULTS.noSpeechMs / 50) - 1, 0.003), r.t); // just under 12 s of thinking
    assert.equal(r.out, 'speaking', `${ms} ms of sound, then a long pause: still listening`);
    r = feed(v, n(2, 0.003), r.t);
    assert.equal(r.out, 'stop', 'noSpeechMs of quiet after short speech does stop');
  }
  // the rest of the sentence after the pause arms it as usual
  const v = createVad();
  let r = feed(v, n(12, 0.08)); // "um"
  r = feed(v, n(84, 0.003), r.t); // 4.2 s of thinking: the old 4 s short-pause stop would have cut here
  assert.equal(r.out, 'speaking');
  r = feed(v, n(30, 0.1), r.t); // the sentence
  assert.ok(v.armed);
  r = feed(v, n(51, 0.003), r.t);
  assert.equal(r.out, 'stop', '2.5 s after armed speech');
  assert.equal(VAD_DEFAULTS.shortSilenceMs, undefined, 'no shorter stop before armMs');
});

test('VAD: a click is not speech; nothing for 12 s is no-speech; a steady background is learnt, so silence still stops', () => {
  const v = createVad();
  let r = feed(v, [0.3, 0.3, 0.002, 0.002]); // 100 ms click
  assert.equal(v.heard, false);
  r = feed(v, n(240, 0.002), r.t);
  assert.equal(r.out, 'no-speech');
  assert.ok(v.peak >= 0.3);
  // a steady room at or above minLevel from the first frame (a fan, a TV, a car): never "speech", and the floor is it
  for (const level of [0.012, 0.015, 0.02, 0.03]) {
    const loud = createVad();
    const out = feed(loud, n(100, level)).out;
    assert.equal(loud.heard, false, `steady ${level} is not speech`);
    assert.equal(out, 'waiting');
    assert.ok(loud.threshold > VAD_DEFAULTS.minLevel && loud.threshold >= level * 2, `threshold ${loud.threshold} over ${level}`);
    // speech over it, then the room again: the silence stop still comes 2.5 s later (it never did before)
    let x = feed(loud, n(10, level), 5_000);
    x = feed(loud, n(60, 0.1), x.t);
    assert.ok(loud.armed, `speech heard over ${level}`);
    x = feed(loud, n(49, level), x.t);
    assert.equal(x.out, 'speaking');
    x = feed(loud, n(2, level), x.t);
    assert.equal(x.out, 'stop', `stops in a ${level} room`);
  }
  // a TV starting after the speech: learnt within the floor window, then the silence stop
  const tv = createVad();
  let t = feed(tv, n(10, 0.003));
  t = feed(tv, n(60, 0.1), t.t);
  t = feed(tv, n(Math.round((VAD_DEFAULTS.floorWindowMs + VAD_DEFAULTS.silenceMs) / 50) + 2, 0.02), t.t);
  assert.equal(t.out, 'stop', 'a TV that comes on does not hold the recording open to the cap');
  // speaking doesn't raise the floor: speech with its pauses keeps the quiet frames in the window
  const talk = createVad();
  let k = feed(talk, n(10, 0.003));
  for (let i = 0; i < 10; i++) { k = feed(talk, n(8, 0.1), k.t); k = feed(talk, n(2, 0.004), k.t); } // 5 s of words and gaps
  assert.ok(talk.threshold <= 0.02 && k.out === 'speaking', String(talk.threshold));
  const room = createVad();
  feed(room, n(20, 0.008));
  assert.ok(room.threshold >= 0.012 && room.threshold <= 0.08);
  feed(room, n(20, 0.009), 1_000);
  assert.equal(room.heard, false, 'steady room noise under the threshold is not speech');
});

// ── Web Speech helpers ──
test('mergeResults keeps interim text, joins pieces, replaces cumulative repeats, no spaces inside CJK', () => {
  assert.equal(mergeResults(results(['hello', true], [' world', false])), 'hello world');
  assert.equal(mergeResults(results(['I', false], ['I am here', false])), 'I am here', 'cumulative');
  assert.equal(mergeResults(results(['你好', true], ['世界', false])), '你好世界');
  assert.equal(mergeResults(results(['  ', false])), '');
  assert.equal(mergeResults(undefined), '');
});

test('speechError: what falls back to recording and what shows help', () => {
  assert.deepEqual(speechError('aborted'), { say: null, fallback: false });
  assert.equal(speechError('no-speech').fallback, false);
  assert.equal(speechError('not-allowed', { android: true, standalone: true }).say, MIC_HELP.androidApp);
  assert.equal(speechError('not-allowed', { android: true }).fallback, false);
  for (const code of ['network', 'service-not-allowed', 'language-not-supported', 'bad-grammar', 'something-new']) assert.equal(speechError(code).fallback, true, code);
  assert.equal(speechError('audio-capture').fallback, false);
});

test('micError / micHelp: human help for each failure, per platform', () => {
  const err = (name) => Object.assign(new Error('x'), { name });
  assert.equal(micError(err('NotAllowedError'), { ios: true, standalone: true }), MIC_HELP.iosApp);
  assert.equal(micError(err('NotAllowedError'), { ios: true }), MIC_HELP.ios);
  assert.equal(micError(err('NotAllowedError'), { android: true }), MIC_HELP.android);
  assert.equal(micError(err('SecurityError'), {}), MIC_HELP.desktop);
  assert.equal(micError(err('NotFoundError')), SAY.noMic);
  assert.equal(micError(err('NotReadableError')), SAY.micBusy);
  assert.equal(micError(new TypeError('x'), { ios: true }), SAY.unsupportedIos);
  assert.equal(micHelp({ android: true, standalone: true }), MIC_HELP.androidApp);
  for (const m of Object.values(MIC_HELP)) assert.ok(m.length < 220 && !/undefined/.test(m));
  // iPhone outside Safari: Safari's aA menu isn't there
  const chrome = platformOf({ userAgent: UA.iphoneChrome });
  assert.equal(micError(err('NotAllowedError'), chrome), 'Atelier can’t use the microphone. Allow it for this site in Chrome, or turn it on in Settings → Apps → Chrome → Microphone, then try again.');
  assert.match(micHelp(platformOf({ userAgent: UA.iphoneFirefox })), /Settings → Apps → Firefox → Microphone/);
  assert.match(micHelp(platformOf({ userAgent: UA.iphoneEdge })), /in Edge/);
  assert.equal(micHelp(platformOf({ userAgent: UA.iphoneLinkedIn })), MIC_HELP.iosInApp, 'an app’s built-in browser: open it in Safari');
  assert.equal(micHelp(platformOf({ userAgent: UA.iphone })), MIC_HELP.ios);
  assert.equal(micHelp(platformOf({ userAgent: UA.iphoneApp, standalone: true })), MIC_HELP.iosApp);
  for (const ua of [UA.iphoneChrome, UA.iphoneLinkedIn]) assert.ok(!/aA|In Safari, open/.test(micHelp(platformOf({ userAgent: ua }))), ua);
  assert.equal(speechError('not-allowed', platformOf({ userAgent: UA.android })).say, MIC_HELP.android);
});

test('refusalMessage maps the server contract and shows tester refusals as worded', () => {
  assert.equal(refusalMessage(413, { code: 'too_large' }), SAY.tooLong);
  assert.equal(refusalMessage(415, { code: 'unsupported_type' }), SAY.format);
  assert.equal(refusalMessage(415, { code: 'unsupported_audio' }), SAY.format);
  assert.equal(refusalMessage(422, { code: 'transcribe_unreadable' }), SAY.unreadable);
  assert.equal(refusalMessage(400, { code: 'bad_request' }), SAY.unreadable);
  assert.equal(refusalMessage(422, { code: 'transcribe_short' }), SAY.short);
  assert.equal(refusalMessage(429, { code: 'transcribe_busy' }), SAY.busy);
  assert.equal(refusalMessage(502, { code: 'transcribe_unavailable' }), SAY.down);
  assert.equal(refusalMessage(503, { code: 'transcribe_unavailable', error: 'Dictation needs OPENAI_API_KEY on the server.' }), SAY.down);
  assert.equal(refusalMessage(504, { code: 'transcribe_timeout' }), SAY.slow);
  assert.equal(refusalMessage(402, { code: 'tester_budget', error: 'You’ve used today’s allowance. It resets at midnight UTC.' }), 'You’ve used today’s allowance. It resets at midnight UTC.');
  assert.equal(refusalMessage(401, { code: 'tester_signin', error: 'whatever' }), SAY.signin);
  assert.equal(refusalMessage(401, {}), SAY.passcode);
  assert.equal(refusalMessage(401, {}, { tester: true }), SAY.signin);
  assert.equal(refusalMessage(403, {}), SAY.off);
  assert.equal(refusalMessage(500, { error: 'sk-proj-abc upstream said no' }), SAY.down, 'untrusted text is never shown');
  assert.equal(refusalMessage(500, null), SAY.down);
  // a desktop has no keyboard mic to point at; phones do
  const desk = platformOf({ userAgent: UA.macChrome }), phone = platformOf({ userAgent: UA.android }), iphone = platformOf({ userAgent: UA.iphone });
  assert.equal(refusalMessage(502, { code: 'transcribe_unavailable' }, { plat: desk }), SAY.downDesktop);
  assert.equal(refusalMessage(415, { code: 'unsupported_audio' }, { plat: desk }), SAY.formatDesktop);
  for (const p of [phone, iphone]) {
    assert.equal(refusalMessage(502, {}, { plat: p }), SAY.down);
    assert.equal(refusalMessage(415, {}, { plat: p }), SAY.format);
  }
  assert.ok(!/keyboard/.test(SAY.downDesktop + SAY.formatDesktop));
  assert.equal(speechError('something-new', desk).say, SAY.downDesktop);
  assert.equal(speechError('something-new', phone).say, SAY.down);
  assert.deepEqual(speechError('network', phone, { offline: true }), { say: SAY.offline, fallback: false });
});

test('retryAfterS and insertText', () => {
  assert.equal(retryAfterS('2'), 2);
  assert.equal(retryAfterS('0.5'), 0.5);
  assert.equal(retryAfterS(''), null);
  assert.equal(retryAfterS('soon'), null);
  assert.equal(retryAfterS(new Date(10_000).toUTCString(), 4_000), 6);
  assert.deepEqual(insertText('', 0, 0, ' Hello '), { value: 'Hello', caret: 5 });
  assert.deepEqual(insertText('Note:', 5, 5, 'buy milk'), { value: 'Note: buy milk', caret: 14 });
  assert.deepEqual(insertText('Ask  now', 4, 4, 'it'), { value: 'Ask it now', caret: 6 });
  assert.deepEqual(insertText('one three', 3, 3, 'two'), { value: 'one two three', caret: 7 });
  assert.deepEqual(insertText('end.', 3, 3, 'ing'), { value: 'end ing.', caret: 7 });
  assert.deepEqual(insertText('replace me', 0, 10, 'done'), { value: 'done', caret: 4 });
  assert.deepEqual(insertText('keep', 2, 2, '  '), { value: 'keep', caret: 2 });
  // Chinese and Japanese don't space their words, nor around CJK punctuation; Korean does
  assert.equal(insertText('明日の会議について', 9, 9, '資料を送ってください').value, '明日の会議について資料を送ってください');
  assert.equal(insertText('今日は', 0, 0, '明日').value, '明日今日は');
  assert.equal(insertText('今日は。', 3, 3, '明日').value, '今日は明日。');
  assert.equal(insertText('我们明天', 4, 4, '开会').value, '我们明天开会');
  assert.equal(insertText('「', 1, 1, 'メモ').value, '「メモ');
  assert.equal(insertText('会議は', 3, 3, 'Zoom').value, '会議は Zoom', 'a Latin word beside Japanese keeps its space');
  assert.equal(insertText('안녕하세요', 5, 5, '반갑습니다').value, '안녕하세요 반갑습니다');
  assert.equal(insertText('𠮷野家', 0, 0, '吉').value, '吉𠮷野家', 'a character outside the BMP');
  assert.equal(insertText('野家𠮷', 4, 4, '吉').value, '野家𠮷吉', 'and one at the end of the text before');
  assert.equal(mergeResults(results(['안녕하세요', true], ['반갑습니다', false])), '안녕하세요 반갑습니다', 'Korean keeps its word spaces');
  assert.equal(mergeResults(results(['会議は', true], ['明日です', false])), '会議は明日です');
});

test('limits fit the server: 120 s and well under 10 MB at the requested bitrate', () => {
  assert.equal(DICTATE_LIMITS.maxMs, 120_000);
  assert.equal(DICTATE_LIMITS.maxBytes, 10 * 1024 * 1024);
  assert.ok((DICTATE_LIMITS.bitrate / 8) * (DICTATE_LIMITS.maxMs / 1000) < DICTATE_LIMITS.maxBytes / 4);
  assert.equal(DICTATE_LIMITS.timesliceMs, 1_000);
  assert.equal(DICTATE_LIMITS.speechWatchMs, 8_000);
  assert.equal(VAD_DEFAULTS.silenceMs, 2_500);
  assert.equal(VAD_DEFAULTS.armMs, 1_000);
  assert.deepEqual(STATES, ['idle', 'listening', 'recording', 'transcribing', 'error']);
});

// ── the controller: iPhone (the reported bug) ──
test('iPhone Home Screen app: records (never constructs SpeechRecognition), opens the mic inside the tap, transcribes', async () => {
  const r = rig({ ua: UA.iphone, standalone: true });
  assert.equal(r.d.engine(), 'record');
  assert.equal(r.d.needsGesture(), true);
  const p = r.d.start();
  // synchronously, inside the tap: the AudioContext and getUserMedia
  assert.equal(r.nav.mediaDevices.calls, 1);
  assert.equal(r.AC.made.length, 1);
  assert.equal(r.before(), 1);
  assert.equal(r.SR.made.length, 0, 'webkitSpeechRecognition is never constructed on iOS');
  assert.equal(lastState(r), 'recording');
  assert.deepEqual(r.nav.mediaDevices.constraints, { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  assert.equal(await p, true);
  const rec = r.MR.made[0];
  assert.equal(rec.options.mimeType, 'audio/mp4;codecs=mp4a.40.2', 'MP4/AAC first on iOS');
  assert.equal(rec.timeslice, 1000);
  await speakFor(r, 2_000, 0.1);
  assert.ok(r.levels.length > 20 && r.levels.at(-1).l > 0.3, 'the level meter moves');
  assert.ok(r.levels.at(-1).elapsedMs >= 1_900 && r.levels.at(-1).leftMs <= 118_100);
  await speakFor(r, 2_400, 0.002);
  assert.equal(lastState(r), 'recording', '2.4 s of quiet is not yet a pause');
  await speakFor(r, 300, 0.002);
  await flush();
  assert.deepEqual(r.states, ['recording', 'transcribing', 'idle']);
  assert.equal(r.calls.length, 1);
  const call = r.calls[0];
  assert.equal(call.url, '/api/transcribe?lang=en');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.headers.get('content-type'), 'audio/mp4');
  assert.equal(call.headers.get('x-app-pass'), 'pass-SECRET-1234', 'owner: apiHeaders');
  assert.equal(call.headers.get('x-dictate-lang'), 'en-US', 'the whole tag too, for the fallback model');
  assert.equal(call.headers.get('x-dictate-prompt'), null, 'no hint unless the app gives one');
  assert.ok(call.body instanceof Blob && call.body.size === 6_000);
  assert.equal(call.init.credentials, 'same-origin');
  assert.deepEqual(r.texts.map((t) => [t.t, t.final, t.engine]), [['hello there', true, 'record']]);
  assert.equal(r.texts[0].provider, 'openai');
  assert.ok(allStopped(r), 'every track stopped');
  assert.equal(r.AC.made[0].closed, true);
  assert.deepEqual(r.responses, [200]);
  assert.equal(r.c.pending(), 0, 'no timer left behind');
});

test('on iPhone/iPad the recognizer is never even looked up (a second guard behind pickEngine)', () => {
  let looked = 0;
  const seams = (ua) => ({
    navigator: { userAgent: ua, mediaDevices: { getUserMedia: () => new Promise(() => {}) } }, MediaRecorder: fakeRecorder(), AudioContext: undefined,
    get SpeechRecognition() { looked++; return fakeSpeech([]); }, serverReady: () => true,
  });
  const ios = createDictation(seams(UA.iphone));
  assert.equal(ios.engine(), 'record');
  ios.start(); ios.cancel();
  assert.equal(looked, 0);
  assert.equal(createDictation(seams(UA.android)).engine(), 'speech');
  assert.equal(looked, 1);
});

test('iPhone in Safari (not installed) and Chrome on iPhone: also record, never Web Speech', async () => {
  for (const ua of [UA.iphone, UA.iphoneChrome]) {
    const r = rig({ ua, standalone: false });
    assert.equal(r.d.engine(), 'record');
    await r.d.start();
    assert.equal(r.SR.made.length, 0);
    r.d.cancel();
  }
  const ipad = rig({ ua: UA.ipad, platform: 'MacIntel', maxTouchPoints: 5 });
  assert.equal(ipad.d.engine(), 'record');
});

test('iPhone without the server (no passcode / feature off): a clear message, never Web Speech', async () => {
  const r = rig({ ua: UA.iphone, standalone: true, server: 'passcode' });
  assert.equal(r.d.available(), false);
  assert.equal(r.d.whyNot(), 'passcode');
  assert.equal(await r.d.start(), false);
  assert.equal(r.SR.made.length, 0);
  assert.equal(r.nav.mediaDevices.calls, 0);
  assert.deepEqual(r.toasts, [{ m: SAY.passcode, error: true }]);
  assert.equal(lastState(r), 'error');
  await r.c.advance(DICTATE_LIMITS.errorMs);
  assert.equal(lastState(r), 'idle', 'the error clears itself');
  const off = rig({ ua: UA.iphone, server: 'off', tester: true });
  await off.d.start();
  assert.equal(off.toasts[0].m, SAY.off);
  const none = rig({ ua: UA.iphone, noRecorder: true });
  assert.equal(none.d.whyNot(), 'unsupported');
  await none.d.start();
  assert.equal(none.toasts[0].m, SAY.unsupportedIos);
});

test('mic permission denied on iPhone: the Home Screen help, nothing sent, no recognizer', async () => {
  const r = rig({ ua: UA.iphone, standalone: true, gum: () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })) });
  assert.equal(await r.d.start(), false);
  assert.deepEqual(r.states, ['recording', 'error']);
  assert.deepEqual(r.toasts, [{ m: MIC_HELP.iosApp, error: true }]);
  assert.equal(r.calls.length, 0);
  assert.equal(r.SR.made.length, 0);
  assert.equal(r.AC.made[0].closed, true);
});

test('a quick-launch start that cannot open the mic says nothing (the caller arms "Tap to talk")', async () => {
  const r = rig({ ua: UA.iphone, standalone: true, gum: () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })) });
  assert.equal(await r.d.start({ auto: true, autoSend: true, reason: 'launch' }), false);
  assert.deepEqual(r.toasts, []);
  assert.equal(lastState(r), 'idle');
});

test('tap to stop uploads at once; a tap while transcribing says so, a second tap cancels; cancel drops it', async () => {
  const r = rig({ ua: UA.iphone, replies: [() => new Promise(() => {})] });
  await r.d.toggle();
  await speakFor(r, 500, 0.1);
  await r.d.toggle(); // stop
  await flush();
  assert.equal(lastState(r), 'transcribing');
  assert.equal(r.calls.length, 1);
  assert.ok(allStopped(r), 'the mic is off while transcribing');
  assert.equal(await r.d.toggle(), false);
  assert.deepEqual(r.toasts, [{ m: SAY.stillTranscribing, error: false }], 'the first tap says what is happening');
  assert.equal(r.calls.length, 1);
  assert.equal(r.d.busy(), true);
  await r.c.advance(DICTATE_LIMITS.cancelTapMs + 10); // too late for a double tap: the next is a first tap again
  await r.d.toggle();
  assert.equal(lastState(r), 'transcribing');
  assert.equal(r.toasts.length, 2);
  await r.d.toggle(); // the second tap (no phone has an Escape key)
  assert.equal(lastState(r), 'idle');
  assert.equal(r.calls[0].init.signal.aborted, true, 'the upload is aborted');
  assert.deepEqual(r.toasts.at(-1), { m: SAY.cancelled, error: false });
  assert.equal(r.texts.length, 0);
  assert.equal(r.d.hasRetry(), false);
  assert.equal(r.c.pending(), 0, 'no timer left behind');
  // cancel() (Escape) still works directly
  const e = rig({ ua: UA.iphone, replies: [() => new Promise(() => {})] });
  await recordAndSend(e);
  e.d.cancel();
  assert.equal(lastState(e), 'idle');
  assert.equal(e.calls[0].init.signal.aborted, true);
});

test('a tap while the permission prompt is up closes it; a late stream is stopped at once', async () => {
  let give;
  const r = rig({ ua: UA.iphone, gum: () => new Promise((res) => { give = res; }) });
  r.d.toggle();
  assert.equal(lastState(r), 'recording');
  r.d.toggle(); // stop before the stream arrives
  assert.equal(lastState(r), 'idle');
  const late = fakeStream();
  give(late);
  await flush();
  assert.equal(late.track.readyState, 'ended');
  assert.equal(r.MR.made.length, 0);
  assert.equal(r.calls.length, 0);
});

test('the 120 s cap stops and sends; a recording over 10 MB is not sent', async () => {
  const r = rig({ ua: UA.iphone });
  await r.d.start();
  await speakFor(r, 119_000, 0.1);
  assert.equal(lastState(r), 'recording');
  assert.ok(r.levels.at(-1).leftMs <= 1_000);
  await speakFor(r, 1_100, 0.1);
  await flush();
  assert.equal(r.calls.length, 1);
  assert.equal(lastState(r), 'idle');

  const big = rig({ ua: UA.iphone, limits: { maxBytes: 5_000 } });
  await big.d.start();
  await speakFor(big, 1_500, 0.1);
  big.d.stop();
  await flush();
  assert.equal(big.calls.length, 0);
  assert.equal(big.toasts[0].m, SAY.tooLong);
});

test('nothing said: a quiet recording is not sent; a dead analyser never stops a recording by itself', async () => {
  const r = rig({ ua: UA.iphone, level: 0.002 });
  await r.d.start();
  await r.c.advance(VAD_DEFAULTS.noSpeechMs + 200);
  await flush();
  assert.equal(r.calls.length, 0, 'nothing above the room noise: not sent');
  assert.deepEqual(r.toasts, [{ m: SAY.noSpeech, error: true }]);
  assert.ok(allStopped(r));

  const dead = rig({ ua: UA.iphone, level: 0 }); // the analyser reads exact zeros: it isn't getting the mic
  await dead.d.start();
  await dead.c.advance(30_000);
  assert.equal(lastState(dead), 'recording', 'no auto-stop on a dead analyser');
  dead.d.stop();
  await flush();
  assert.equal(dead.calls.length, 1, 'and what was recorded is still sent');

  // room tone above quietPeak but never speech: the automatic stop sends nothing (made-up text, a metered call)
  const soft = rig({ ua: UA.iphone, level: 0.008 });
  await soft.d.start();
  await soft.c.advance(VAD_DEFAULTS.noSpeechMs + 200);
  await flush();
  assert.equal(soft.calls.length, 0, 'room noise is not sent');
  assert.deepEqual(soft.toasts, [{ m: SAY.noSpeech, error: true }]);
  // the same room, but the person taps stop: they asked for it, so it goes (it is above quietPeak)
  const tapped = rig({ ua: UA.iphone, level: 0.008 });
  await tapped.d.start();
  await tapped.c.advance(5_000);
  tapped.d.stop();
  await flush();
  assert.equal(tapped.calls.length, 1, 'a tap sends what was recorded');
  // a call or the lock screen with nothing said: nothing sent either
  const hidden = rig({ ua: UA.iphone, level: 0.008 });
  await hidden.d.start();
  await hidden.c.advance(3_000);
  hidden.doc.visibilityState = 'hidden';
  hidden.doc.dispatchEvent(new Event('visibilitychange'));
  await flush();
  assert.equal(hidden.calls.length, 0);
});

test('an "um" or a cough, then a long think, keeps recording; the rest of the sentence is sent', async () => {
  const r = rig({ ua: UA.iphone, standalone: true, level: 0.003 });
  await r.d.start();
  await speakFor(r, 500, 0.003);
  await speakFor(r, 600, 0.08); // "um"
  await speakFor(r, 4_200, 0.003); // thinking (the old 4 s short-pause stop uploaded here)
  assert.equal(lastState(r), 'recording');
  assert.equal(r.calls.length, 0);
  await speakFor(r, 2_000, 0.1); // the sentence
  await speakFor(r, 2_600, 0.003);
  await flush();
  assert.deepEqual(r.states, ['recording', 'transcribing', 'idle']);
  assert.equal(r.calls.length, 1);
  // a steady 0.02 room (a TV, a fan) no longer holds the recording open until the 2-minute cap
  const tv = rig({ ua: UA.iphone, standalone: true, level: 0.02 });
  await tv.d.start();
  await speakFor(tv, 1_000, 0.02);
  await speakFor(tv, 3_000, 0.1);
  await speakFor(tv, 2_700, 0.02);
  await flush();
  assert.equal(tv.calls.length, 1, 'stopped 2.5 s after the speech, not at 120 s');
  assert.equal(lastState(tv), 'idle');
});

test('a suspended AudioContext: no meter, no VAD, the recording still works', async () => {
  const r = rig({ ua: UA.iphone, ctxState: 'suspended', level: 0.1 });
  await r.d.start();
  await r.c.advance(20_000);
  assert.equal(lastState(r), 'recording');
  assert.ok(r.levels.every((x) => x.l === 0));
  r.d.stop();
  await flush();
  assert.equal(r.calls.length, 1);
});

test('going to the background stops and transcribes what was said', async () => {
  const r = rig({ ua: UA.iphone });
  await r.d.start();
  await speakFor(r, 1_500, 0.1);
  r.doc.visibilityState = 'hidden';
  r.doc.dispatchEvent(new Event('visibilitychange'));
  await flush();
  assert.equal(r.calls.length, 1);
  assert.equal(lastState(r), 'idle');
  assert.ok(allStopped(r));
});

test('a call taking the mic (track ended) sends what was recorded', async () => {
  const r = rig({ ua: UA.iphone });
  await r.d.start();
  await speakFor(r, 1_500, 0.1);
  r.streams[0].track.dispatchEvent(new Event('ended'));
  await flush();
  assert.equal(r.calls.length, 1);
});

test('the recorder falls back to the browser default when no listed type is supported', async () => {
  const r = rig({ ua: UA.firefox, speech: false, recorder: { supported: [], defaultType: 'audio/webm' } });
  await r.d.start();
  assert.equal(r.MR.made[0].options.mimeType, undefined);
  await speakFor(r, 1_200, 0.1);
  r.d.stop();
  await flush();
  assert.equal(r.calls[0].headers.get('content-type'), 'audio/webm', 'labelled by the sniffed bytes');
});

// ── server answers ──
async function recordAndSend(r, ms = 1_500) {
  await r.d.start();
  await speakFor(r, ms, 0.1);
  r.d.stop();
  await flush();
}

test('429 with a short retry-after is retried once; a long one is "busy" and kept for retry()', async () => {
  const r = rig({ ua: UA.iphone, replies: [json({ error: 'x', code: 'transcribe_busy' }, 429, { 'retry-after': '2' }), json({ text: 'second try', model: 'm' })] });
  await recordAndSend(r);
  assert.equal(r.calls.length, 1);
  await r.c.advance(2_000);
  assert.equal(r.calls.length, 2);
  assert.equal(r.texts[0].t, 'second try');
  assert.equal(lastState(r), 'idle');

  const busy = rig({ ua: UA.iphone, tester: true, replies: [json({ error: 'Dictation is busy right now.', code: 'transcribe_busy' }, 429, { 'retry-after': '30' }), json({ text: 'later' })] });
  await recordAndSend(busy);
  assert.equal(busy.calls.length, 1);
  assert.deepEqual(busy.toasts, [{ m: SAY.busy, error: true }]);
  assert.equal(busy.d.hasRetry(), true);
  assert.equal(await busy.d.retry(), true);
  assert.equal(busy.calls[1].body, busy.calls[0].body, 'the same recording, not a new one');
  assert.equal(busy.texts[0].t, 'later');
  assert.equal(busy.d.hasRetry(), false);
});

test('a dropped connection is retried once, then kept for retry(); offline is said plainly', async () => {
  const r = rig({ ua: UA.iphone, replies: [new TypeError('Failed to fetch'), new TypeError('Failed to fetch')] });
  await recordAndSend(r);
  await r.c.advance(DICTATE_LIMITS.netRetryMs);
  assert.equal(r.calls.length, 2);
  assert.deepEqual(r.toasts, [{ m: SAY.network, error: true }]);
  assert.equal(lastState(r), 'error');
  assert.equal(r.d.hasRetry(), true);
  await r.d.retry();
  assert.equal(r.texts[0].t, 'hello there');

  const off = rig({ ua: UA.iphone, onLine: false });
  await recordAndSend(off);
  assert.equal(off.calls.length, 0);
  assert.deepEqual(off.toasts, [{ m: SAY.offline, error: true }]);
  assert.equal(off.d.hasRetry(), true);
});

test('server refusals become clear messages; tester refusals are passed on and shown as worded', async () => {
  const cases = [
    [json({ error: 'too big', code: 'too_large' }, 413), SAY.tooLong, false],
    [json({ error: 'bad type', code: 'unsupported_type' }, 415), SAY.format, false],
    [json({ error: 'garbled', code: 'transcribe_unreadable' }, 422), SAY.unreadable, false],
    [json({ error: 'Dictation is unavailable right now.', code: 'transcribe_unavailable' }, 502), SAY.down, true],
    [json({ error: 'Dictation needs OPENAI_API_KEY on the server.', code: 'transcribe_unavailable' }, 503), SAY.down, true],
    [json({ error: 'slow', code: 'transcribe_timeout' }, 504), SAY.slow, true],
    [new Response('<html>gateway</html>', { status: 500 }), SAY.down, true],
    [json({ error: 'Add your passcode', code: 'unauthorized' }, 401), SAY.passcode, false],
  ];
  for (const [reply, message, retry] of cases) {
    const r = rig({ ua: UA.iphone, replies: [reply] });
    await recordAndSend(r);
    assert.deepEqual(r.toasts, [{ m: message, error: true }], message);
    assert.equal(r.d.hasRetry(), retry, `${message}: retry ${retry}`);
    assert.equal(lastState(r), 'error');
  }
  const t = rig({ ua: UA.iphone, tester: true, replies: [json({ error: 'You’ve used today’s allowance.', code: 'tester_budget', scope: 'day', resetsAt: '2026-10-01T00:00:00Z' }, 402)] });
  await recordAndSend(t);
  assert.deepEqual(t.toasts, [{ m: 'You’ve used today’s allowance.', error: true }]);
  assert.deepEqual(t.refusals, [{ status: 402, code: 'tester_budget', scope: 'day', resetsAt: '2026-10-01T00:00:00Z', error: 'You’ve used today’s allowance.' }]);
  assert.equal(t.d.hasRetry(), false);
  assert.equal(t.calls[0].headers.get('x-app-pass'), null, 'testers ride on their cookie');
  assert.equal(t.calls[0].headers.get('content-type'), 'audio/mp4');
});

test('an empty transcript says so; a language without a two-letter code sends no ?lang (the tag still goes)', async () => {
  const r = rig({ ua: UA.iphone, lang: 'yue-HK', navLang: 'yue-HK', replies: [json({ text: '   ', provider: 'openai' })] });
  await recordAndSend(r);
  assert.equal(r.calls[0].url, '/api/transcribe');
  assert.equal(r.calls[0].headers.get('x-dictate-lang'), 'yue-HK');
  assert.deepEqual(r.toasts, [{ m: SAY.noWords, error: true }]);
  assert.equal(r.texts.length, 0);
  const es = rig({ ua: UA.iphone, lang: 'es-MX' });
  await recordAndSend(es);
  assert.equal(es.calls[0].url, '/api/transcribe?lang=es');
});

test('a new start during an error, and start() while busy, behave', async () => {
  const r = rig({ ua: UA.iphone, replies: [json({ code: 'transcribe_unavailable', error: 'x' }, 502)] });
  await recordAndSend(r);
  assert.equal(lastState(r), 'error');
  assert.equal(await r.d.start(), true, 'a tap during the error starts a new recording');
  assert.equal(r.d.hasRetry(), false, 'a new recording replaces the unsent one');
  assert.equal(await r.d.start(), false, 'one at a time');
  r.d.cancel();
  assert.ok(allStopped(r));
});

// ── Android / desktop: Web Speech with a recording fallback ──
test('Android Chrome: Web Speech gives live text, and the last interim result is kept when it ends', async () => {
  const r = rig({ ua: UA.android, standalone: true, lang: 'en-GB' });
  assert.equal(r.d.engine(), 'speech');
  assert.equal(r.d.needsGesture(), false);
  const p = r.d.start({ autoSend: true });
  const sr = r.SR.made[0];
  assert.equal(sr.running, true, 'started inside the tap');
  assert.equal(sr.lang, 'en-GB');
  assert.equal(sr.interimResults, true);
  assert.equal(r.nav.mediaDevices.calls, 0);
  sr.emit('start');
  assert.equal(await p, true);
  assert.equal(lastState(r), 'listening');
  sr.result(['buy', false]);
  sr.result(['buy milk', false]);
  sr.result(['buy milk and', true], [' eggs', false]);
  assert.deepEqual(r.texts.map((t) => [t.t, t.final, t.live]), [['buy', false, true], ['buy milk', false, true], ['buy milk and eggs', false, true]]);
  sr.end(); // never marked final
  await flush();
  assert.deepEqual(r.texts.at(-1), { t: 'buy milk and eggs', final: true, live: true, engine: 'speech', reason: 'tap', auto: false, autoSend: true });
  assert.equal(lastState(r), 'idle');
  assert.equal(r.calls.length, 0, 'no server call');
  assert.equal(r.c.pending(), 0);
});

test('Web Speech that never ends by itself is ended after a pause (and the text promoted)', async () => {
  const r = rig({ ua: UA.macSafari, platform: 'MacIntel', maxTouchPoints: 0 });
  assert.equal(r.d.engine(), 'speech', 'Safari on a Mac keeps Web Speech');
  const p = r.d.start();
  const sr = r.SR.made[0];
  sr.emit('start');
  assert.equal(await p, true);
  sr.result(['hello from safari', false]);
  await r.c.advance(DICTATE_LIMITS.speechQuietMs);
  assert.equal(sr.stops, 1);
  assert.equal(r.texts.at(-1).final, true);
  assert.equal(lastState(r), 'idle');
});

test('Web Speech "network" error: falls back to recording only after the recognizer has ended', async () => {
  const r = rig({ ua: UA.android });
  const p = r.d.start();
  const sr = r.SR.made[0];
  sr.emit('start');
  sr.emit('error', { error: 'network' });
  assert.equal(r.nav.mediaDevices.calls, 0, 'not while the recognizer may still hold the mic');
  await flush(); // abort() → 'aborted' → end
  assert.equal(sr.aborts, 1);
  assert.equal(r.nav.mediaDevices.calls, 1);
  assert.ok(r.log.indexOf('sr:end') < r.log.indexOf('gum'), 'recognizer ended before getUserMedia');
  assert.equal(await p, true);
  assert.equal(lastState(r), 'recording');
  assert.deepEqual(r.toasts, [], 'no toast while the mic opens: a screen reader would speak it into the recording');
  assert.equal(r.details.at(-1).fallback, 'network', 'the state says it is a recording instead');
  assert.equal(r.MR.made[0].options.mimeType, 'audio/webm;codecs=opus', 'WebM/Opus first off Apple');
  await speakFor(r, 1_500, 0.1);
  await speakFor(r, 2_600, 0.002);
  await flush();
  assert.equal(r.calls[0].headers.get('content-type'), 'audio/webm');
  assert.equal(r.texts.at(-1).t, 'hello there');
  assert.equal(r.d.engine(), 'record', 'the next tap records straight away');
  await r.d.start();
  assert.equal(r.SR.made.length, 1, 'no second recognizer');
  r.d.cancel();
  // a 'network' failure may pass: after speechNetHoldMs, Web Speech is tried again
  await r.c.advance(DICTATE_LIMITS.speechNetHoldMs);
  assert.equal(r.d.engine(), 'speech');
});

test('Web Speech "network" while offline: says offline, records nothing, and keeps Web Speech for the next tap', async () => {
  const r = rig({ ua: UA.android, onLine: false });
  r.d.start();
  const sr = r.SR.made[0];
  sr.emit('start');
  sr.emit('error', { error: 'network' });
  sr.end();
  await flush();
  assert.equal(r.nav.mediaDevices.calls, 0, 'a recording couldn’t be sent either');
  assert.deepEqual(r.toasts, [{ m: SAY.offline, error: true }]);
  r.nav.onLine = true;
  assert.equal(r.d.engine(), 'speech', 'not retired by a moment offline');
});

test('Web Speech with no event at all for 8 s (an installed app where it is dead): records instead', async () => {
  const r = rig({ ua: UA.android, standalone: true });
  r.d.start();
  await r.c.advance(7_900);
  assert.equal(r.nav.mediaDevices.calls, 0);
  await r.c.advance(200);
  await flush();
  assert.equal(r.SR.made[0].aborts, 1);
  assert.equal(r.nav.mediaDevices.calls, 1);
  assert.equal(lastState(r), 'recording');
});

test('Web Speech that never fires end is given up on, and the fallback still waits for that', async () => {
  const r = rig({ ua: UA.android });
  r.d.start();
  const sr = r.SR.made[0];
  sr.abort = () => { sr.aborts++; }; // no 'end' ever
  sr.emit('start');
  sr.emit('error', { error: 'service-not-allowed' });
  await flush();
  assert.equal(r.nav.mediaDevices.calls, 0);
  await r.c.advance(DICTATE_LIMITS.speechEndWaitMs);
  assert.equal(r.nav.mediaDevices.calls, 1);
});

test('Web Speech "not-allowed": permission help, no fallback, no getUserMedia', async () => {
  const r = rig({ ua: UA.android, standalone: true });
  r.d.start();
  const sr = r.SR.made[0];
  sr.emit('error', { error: 'not-allowed' });
  sr.end();
  await flush();
  assert.equal(r.nav.mediaDevices.calls, 0);
  assert.deepEqual(r.toasts, [{ m: MIC_HELP.androidApp, error: true }]);
  assert.equal(lastState(r), 'error');
  assert.equal(r.d.engine(), 'speech', 'not-allowed does not mark Web Speech broken');
});

test('Web Speech "no-speech": a plain message; a tap to stop with nothing said is quiet', async () => {
  const r = rig({ ua: UA.android });
  r.d.start();
  const sr = r.SR.made[0];
  sr.emit('start');
  sr.emit('error', { error: 'no-speech' });
  sr.end();
  await flush();
  assert.deepEqual(r.toasts, [{ m: SAY.noSpeech, error: true }]);
  assert.equal(r.nav.mediaDevices.calls, 0);

  const q = rig({ ua: UA.android });
  q.d.start();
  q.SR.made[0].emit('start');
  q.d.toggle(); // stop
  await flush();
  assert.equal(q.SR.made[0].stops, 1);
  assert.deepEqual(q.toasts, []);
  assert.equal(lastState(q), 'idle');
});

test('Web Speech failing without the server: no recording fallback, a message instead', async () => {
  const r = rig({ ua: UA.android, server: 'down' });
  r.d.start();
  const sr = r.SR.made[0];
  sr.emit('start');
  sr.emit('error', { error: 'network' });
  sr.end();
  await flush();
  assert.equal(r.nav.mediaDevices.calls, 0);
  assert.deepEqual(r.toasts, [{ m: SAY.speechNet, error: true }]);
  // Web Speech is all there is here: the next tap tries it again ("Try again" works), and the mic stays visible
  assert.equal(r.d.engine(), 'speech');
  assert.equal(r.d.whyNot(), null);
  const off = rig({ ua: UA.android, server: 'off', tester: true }); // a tester without the dictation feature
  off.d.start();
  off.SR.made[0].emit('error', { error: 'service-not-allowed' });
  off.SR.made[0].end();
  await flush();
  assert.equal(off.d.whyNot(), null, 'not "off": the app would hide the mic');
  assert.equal(off.d.engine(), 'speech');
  // a recognizer that can't even be made is gone for good: then 'off' is the truth (nothing else can run)
  const dead = rig({ ua: UA.android, server: 'off', tester: true });
  dead.SR.throwOnStart = 'NotSupportedError';
  await dead.d.start();
  assert.equal(dead.d.engine(), null);
  assert.equal(dead.d.whyNot(), 'off');
});

test('Web Speech waits on the browser’s mic prompt: a slow Allow is not "dead here"', async () => {
  const status = new EventTarget();
  status.state = 'prompt';
  const r = rig({ ua: UA.android, standalone: true, permissions: { query: async ({ name }) => { assert.equal(name, 'microphone'); return status; } } });
  r.d.start();
  const sr = r.SR.made[0];
  await flush();
  await r.c.advance(20_000); // the prompt is up: Chrome fires nothing at all meanwhile
  assert.equal(r.nav.mediaDevices.calls, 0, 'no fallback while the person decides');
  assert.equal(lastState(r), 'listening');
  status.state = 'granted';
  status.dispatchEvent(new Event('change'));
  sr.emit('start');
  sr.result(['allowed at last', false]);
  sr.end();
  await flush();
  assert.equal(r.texts.at(-1).t, 'allowed at last');
  assert.equal(r.d.engine(), 'speech', 'Web Speech is still the engine');
  // answered, then silence: the 8 s watch starts from the answer
  const q = new EventTarget();
  q.state = 'prompt';
  const r2 = rig({ ua: UA.android, standalone: true, permissions: { query: async () => q } });
  r2.d.start();
  await flush();
  await r2.c.advance(15_000);
  q.dispatchEvent(new Event('change'));
  await r2.c.advance(DICTATE_LIMITS.speechWatchMs - 100);
  assert.equal(r2.nav.mediaDevices.calls, 0);
  await r2.c.advance(200);
  await flush();
  assert.equal(r2.nav.mediaDevices.calls, 1, 'still nothing 8 s after the answer: record instead');
  r2.d.cancel();
  // no answer at all within speechPromptMs: the watch starts anyway
  const q3 = new EventTarget();
  q3.state = 'prompt';
  const r3 = rig({ ua: UA.android, permissions: { query: async () => q3 } });
  r3.d.start();
  await flush();
  await r3.c.advance(DICTATE_LIMITS.speechPromptMs + DICTATE_LIMITS.speechWatchMs + 100);
  await flush();
  assert.equal(r3.nav.mediaDevices.calls, 1);
  r3.d.cancel();
  // an already-granted mic: the usual 8 s
  const r4 = rig({ ua: UA.android, permissions: { query: async () => ({ state: 'granted' }) } });
  r4.d.start();
  await flush();
  await r4.c.advance(DICTATE_LIMITS.speechWatchMs + 100);
  await flush();
  assert.equal(r4.nav.mediaDevices.calls, 1);
  r4.d.cancel();
});

test('Web Speech: a network error after some text keeps the text and records next time', async () => {
  const r = rig({ ua: UA.android });
  r.d.start();
  const sr = r.SR.made[0];
  sr.emit('start');
  sr.result(['half a sentence', false]);
  sr.emit('error', { error: 'network' });
  sr.end();
  await flush();
  assert.equal(r.nav.mediaDevices.calls, 0, 'no fallback once there is text');
  assert.deepEqual(r.texts.at(-1).t, 'half a sentence');
  assert.equal(r.texts.at(-1).final, true);
  assert.equal(r.d.engine(), 'record');
});

test('a tap while waiting to switch to recording cancels the switch', async () => {
  const r = rig({ ua: UA.android });
  r.d.start();
  const sr = r.SR.made[0];
  sr.abort = () => { sr.aborts++; }; // hold the end back
  sr.emit('start');
  sr.emit('error', { error: 'network' });
  r.d.toggle(); // the person taps stop
  sr.end();
  await flush();
  assert.equal(r.nav.mediaDevices.calls, 0);
  assert.deepEqual(r.toasts, [{ m: SAY.tapToRecord, error: true }]);
});

test('a recognizer that throws on construction or start records in the same tap', async () => {
  const r = rig({ ua: UA.android });
  r.SR.throwOnStart = 'NotSupportedError';
  const p = r.d.start();
  assert.equal(r.nav.mediaDevices.calls, 1, 'getUserMedia still inside the tap');
  assert.equal(await p, true);
  assert.equal(lastState(r), 'recording');
  r.d.cancel();
  assert.ok(allStopped(r));
});

test('cancel during Web Speech aborts it and says nothing', async () => {
  const r = rig({ ua: UA.android });
  r.d.start();
  const sr = r.SR.made[0];
  sr.emit('start');
  sr.result(['draft', false]);
  r.d.cancel();
  await flush();
  assert.equal(sr.aborts, 1);
  assert.equal(lastState(r), 'idle');
  assert.equal(r.texts.filter((t) => t.final).length, 0);
  assert.deepEqual(r.toasts, []);
});

// ── quick launch ──
// A two-level DOM with the dispatch order every engine guarantees: the document's capture listeners first (a stop
// there ends the dispatch), then the listeners on the button the tap landed in.
function fakeDom() {
  const node = (o) => Object.assign(o, {
    l: [],
    addEventListener(type, f, cap) { if (type === 'click') this.l.push({ f, cap: cap === true || cap?.capture === true }); },
    removeEventListener(type, f) { this.l = this.l.filter((x) => x.f !== f); },
  });
  const doc = node({}), icon = {};
  const btn = node({ ownerDocument: doc, contains: (x) => x === btn || x === icon });
  const other = node({ ownerDocument: doc, contains: (x) => x === other });
  function tap(target = btn) {
    const ev = { type: 'click', target, stopped: false, prevented: false };
    ev.stopImmediatePropagation = ev.stopPropagation = () => { ev.stopped = true; };
    ev.preventDefault = () => { ev.prevented = true; };
    for (const { f, cap } of [...doc.l]) { if (cap) f(ev); if (ev.stopped) return ev; }
    for (const { f } of [...(target === icon ? btn : target).l]) { f(ev); if (ev.stopped) break; }
    return ev;
  }
  return { doc, btn, icon, other, tap };
}

test('startFromGesture arms a one-shot "Tap to talk" that starts inside the tap and stops the button toggling', async () => {
  const r = rig({ ua: UA.iphone, standalone: true });
  const dom = fakeDom();
  let own = 0, fired = null, disarmedWhy = null;
  dom.btn.addEventListener('click', () => { own++; r.d.toggle(); }); // app.js's own mic handler
  const disarm = startFromGesture(r.d, dom.btn, { autoSend: true, onFire: (p) => { fired = p; }, onDisarm: (why) => { disarmedWhy = why; } });
  assert.deepEqual(dom.doc.l.map((x) => x.cap), [true], 'one capture listener, on the document');
  assert.equal(dom.btn.l.length, 1, 'nothing added to the button itself');
  dom.tap(dom.other); // a tap somewhere else
  assert.equal(r.nav.mediaDevices.calls, 0);
  assert.equal(disarmedWhy, null, 'still armed');
  const ev = dom.tap(dom.icon); // the tap lands on the mic icon inside the button
  assert.equal(r.nav.mediaDevices.calls, 1, 'getUserMedia during the tap');
  assert.equal(own, 0, 'the button handler did not also run (it would toggle the mic straight off)');
  assert.equal(ev.prevented, true);
  assert.equal(disarmedWhy, 'fired');
  assert.equal(dom.doc.l.length, 0, 'one shot: the listener is gone');
  assert.equal(await fired, true);
  assert.equal(lastState(r), 'recording');
  await speakFor(r, 1_500, 0.1);
  dom.tap(); // the next tap is the button's own again: stop
  assert.equal(own, 1);
  await flush();
  assert.equal(r.texts[0].autoSend, true);
  assert.equal(r.texts[0].reason, 'launch');
  disarm(); // already disarmed: a no-op
  assert.equal(disarmedWhy, 'fired');
});

test('startFromGesture: timeout and manual disarm; busy dictation lets the tap through; no document → the target', async () => {
  const r = rig({ ua: UA.iphone });
  const dom = fakeDom();
  let why = null;
  startFromGesture(r.d, dom.btn, { timeoutMs: 1_000, setTimeout: r.c.setTimeout, clearTimeout: r.c.clearTimeout, onDisarm: (w) => { why = w; } });
  await r.c.advance(1_000);
  assert.equal(why, 'timeout');
  assert.equal(dom.doc.l.length, 0);
  dom.tap();
  assert.equal(r.nav.mediaDevices.calls, 0);

  const off = startFromGesture(r.d, dom.btn);
  off();
  dom.tap();
  assert.equal(r.nav.mediaDevices.calls, 0);

  await r.d.start();
  let own = 0;
  dom.btn.addEventListener('click', () => { own++; });
  startFromGesture(r.d, dom.btn, { onDisarm: (w) => { why = w; } });
  const ev = dom.tap();
  assert.equal(own, 1, 'busy: the tap goes to the button');
  assert.equal(ev.stopped, false);
  assert.equal(why, 'busy');
  assert.equal(r.nav.mediaDevices.calls, 1);
  r.d.cancel();

  const bare = new EventTarget(); // no ownerDocument: listen on the target itself
  startFromGesture(r.d, bare);
  bare.dispatchEvent(new Event('click'));
  assert.equal(r.nav.mediaDevices.calls, 2);
  r.d.cancel();
  assert.equal(typeof startFromGesture(null, dom.btn), 'function');
  assert.equal(typeof startFromGesture(r.d, null), 'function');
});

// ── hygiene ──
test('nothing is logged: not the transcript, the passcode or the audio; callbacks that throw are contained', async () => {
  const r = rig({ ua: UA.iphone, replies: [json({ text: 'my private dictated words', model: 'm' })], onState: () => { throw new Error('ui bug'); } });
  await recordAndSend(r);
  assert.equal(r.texts[0].t, 'my private dictated words');
  assert.equal(lastState(r), 'idle');
  for (const line of logs) {
    assert.ok(!/private dictated|SECRET|pass-/.test(line), `logged: ${line}`);
  }
  assert.ok(logs.length > 0 && logs.every((l) => /ui bug/.test(l)), 'only the thrown UI error is reported');
});
