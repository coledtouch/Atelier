// Read aloud in the Atelier voice: POST /api/tts.
// One pipeline serves the owner (worker.js, after the passcode check) and testers (src/tester/router.js, which passes
// hooks that reserve and settle in the Ledger). The client sends only {voice, text} or {voice, preview: true}. The model,
// the voice brief and the audio format are server constants here, and voice ids are an allow-list (TTS_VOICES).
// Provider errors are mapped to our own codes and never passed through (OpenAI's 401 bodies quote part of the key), no
// upstream header is copied onto the response, and the text being read is never logged.
// Design: tts-design.json (2026-09-30). Default voice: OpenAI gpt-4o-mini-tts (snapshot pinned), voice "marin".
import { GEMINI_BASE } from './gemini.js';
import { meter, openaiUsage } from './tester/usage.js';

// Bump TTS_BRIEF_V whenever TTS_BRIEF or anything that changes how a voice sounds (its model, provider voice or style)
// changes: clients key their cached clips on it, and the server's cached Settings previews roll over with it. Editing
// PREVIEW_TEXT needs no bump (previews are keyed on PREVIEW_ID, its hash), only the copy in public/readaloud.js.
export const TTS_BRIEF_V = 1;
export const TTS_BRIEF = [
  'Voice: warm, soft and close, like a thoughtful studio companion reading a note aloud across a quiet worktable.',
  'Tone: calm, kind and quietly confident; sincere, never salesy, theatrical or announcer-like.',
  'Pacing: unhurried and even, a touch slower than conversation, with natural pauses at commas, between sentences and before each list item.',
  'Intonation: gentle and natural; sentences settle softly at the end, with no exaggerated emphasis or upspeak.',
  'Pronunciation: clear and relaxed; read numbers, dates, units and names plainly.',
  'Emotion: present and warm, with the faint hint of a smile.',
].join('\n');
/** The Settings "Preview" line (the client never sends preview text). */
export const PREVIEW_TEXT = 'Hello, I’m the voice of Atelier. Whenever you’d like a rest from the screen, I’ll read your answers aloud, calmly and at your pace.';
/** A short hash of a preview line (FNV-1a over its UTF-16 code units, 8 hex digits). */
export function previewId(text) {
  let h = 0x811c9dc5;
  for (const ch of String(text)) for (let i = 0; i < ch.length; i++) h = Math.imul(h ^ ch.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}
/** Part of every preview cache key (here and in public/readaloud.js, which mirrors it), so a new line is never served stale. */
export const PREVIEW_ID = previewId(PREVIEW_TEXT);

/**
 * Spoken length: characters, plus extra weight for what takes longer to say than to write. A digit is read as part of a
 * number word ("987" → "nine hundred eighty-seven"), a symbol as a word ("%" → "percent"), and a Chinese, Japanese or
 * Korean character as a syllable or more. Tester requests are capped (TTS_LIMITS.testerChars) and priced in these
 * units. public/readaloud.js segments with the same function (a test keeps the two in step).
 */
const SPOKEN_EXTRA = [[/[0-9]/g, 3], [/[%$€£¥&@#°×÷=+/§‰]/g, 2], [/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, 2]];
export function spokenUnits(text) {
  const s = String(text ?? '');
  let n = s.length;
  for (const [re, w] of SPOKEN_EXTRA) n += (s.match(re)?.length || 0) * w;
  return n;
}

export const TTS_LIMITS = Object.freeze({
  bodyBytes: 16_384, // the whole JSON request
  ownerChars: 4_000, // per request (OpenAI's hard limit is 4,096); the client sends one segment at a time
  testerChars: 1_000, // per request, in spoken units (spokenUnits): plain prose is one unit per character
  maxAudioBytes: 8 * 1024 * 1024, // decoded audio per request
  timeoutMs: 30_000, // until the provider starts answering
});

const OPENAI_TTS_MODEL = 'gpt-4o-mini-tts-2025-12-15'; // pinned snapshot: the brand voice can't change between deploys
const GEMINI_TTS_MODEL = 'gemini-3.8-flash-lite-tts';
const GEMINI_STYLE = 'warm, soft and calm; unhurried and gentle, speaking a little slowly, like a thoughtful friend reading aloud';
const PCM_BYTES_PER_SECOND = 48_000; // Gemini speech: 24 kHz, 16-bit, mono
const GEMINI_AUDIO_TOKENS_PER_SECOND = 25; // published; prices.js bills by it
/**
 * Gemini output is bounded at the source: generationConfig.maxOutputTokens = as many audio tokens as fit in
 * TTS_LIMITS.maxAudioBytes (4,369 ≈ 174.8 s). Google bills what it generates, so a longer answer must not be produced
 * only to be thrown away; tester reservations use this bound as their ceiling (prices.js ttsWorstCase maxAudioTokens).
 */
export const GEMINI_MAX_OUTPUT_TOKENS = Math.floor(TTS_LIMITS.maxAudioBytes / PCM_BYTES_PER_SECOND * GEMINI_AUDIO_TOKENS_PER_SECOND);

/**
 * The server allow-list of voices. The client sends only the id. 'device' (the browser's own speechSynthesis) is a
 * client-only option and is not served here. To change the default voice, edit the 'atelier' row (and bump TTS_BRIEF_V).
 */
export const TTS_VOICES = deepFreeze({
  atelier: { provider: 'openai', model: OPENAI_TTS_MODEL, voice: 'marin' },
  cedar: { provider: 'openai', model: OPENAI_TTS_MODEL, voice: 'cedar' },
  sage: { provider: 'openai', model: OPENAI_TTS_MODEL, voice: 'sage' },
  sulafat: { provider: 'gemini', model: GEMINI_TTS_MODEL, voice: 'Sulafat', style: GEMINI_STYLE, maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS },
});
export const TTS_VOICE_IDS = Object.freeze(Object.keys(TTS_VOICES));
/** The prices.js id a voice is metered under, e.g. 'openai:gpt-4o-mini-tts-2025-12-15'. */
export const ttsPriceId = (voice) => `${voice.provider}:${voice.model}`;

const PROVIDER_KEYS = Object.freeze({ openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY' });
const OPENAI_SPEECH = 'https://api.openai.com/v1/audio/speech';
const PREVIEW_MAX_AGE = 30 * 86_400;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const ANGLES = /[<>＜＞]/g; // Gemini reads <...> as a sound cue (<sigh>, <laugh>, <short pause>)

function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
}
const fail = (status, code, error, headers = {}) =>
  new Response(JSON.stringify({ error, code }), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
const unavailable = () => fail(502, 'tts_unavailable', 'Read aloud is unavailable right now.');
// Upstream error text for the log: at most 200 characters, with anything key-shaped removed.
const redact = (s) => String(s ?? '')
  .replace(/\bsk-[^\s"',]+/g, 'sk-[redacted]').replace(/\bAIza[\w-]+/g, 'AIza[redacted]').replace(/\bAQ\.[\w.-]+/g, 'AQ.[redacted]')
  .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]').replace(/\s+/g, ' ').slice(0, 200);

// ── request ──
/**
 * Checks a parsed request body → {ok: true, voiceId, voice, text, units, preview} | {ok: false, status, code, error}.
 * Only `voice`, `text` and `preview` are read; every other field is ignored. The owner's cap is in characters (OpenAI's
 * limit is), a tester's in spoken units (spokenUnits), which is also what a tester's reservation is priced on.
 */
export function validateTts(body, { tester = false } = {}) {
  const bad = (status, code, error) => ({ ok: false, status, code, error });
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad(400, 'bad_request', 'Send JSON {voice, text} or {voice, preview: true}.');
  const voiceId = body.voice;
  if (typeof voiceId !== 'string' || !Object.hasOwn(TTS_VOICES, voiceId)) return bad(400, 'bad_request', `Unknown voice. Use one of: ${TTS_VOICE_IDS.join(', ')}.`);
  const voice = TTS_VOICES[voiceId];
  if (body.preview === true) return { ok: true, voiceId, voice, text: PREVIEW_TEXT, units: spokenUnits(PREVIEW_TEXT), preview: true };
  if (typeof body.text !== 'string') return bad(400, 'bad_request', 'text must be a string.');
  let text = body.text.replace(CONTROL, '');
  if (voice.provider === 'gemini') text = text.replace(ANGLES, ' ').replace(/[ \t]{2,}/g, ' ');
  text = text.trim();
  if (!text) return bad(400, 'bad_request', 'There is nothing to read aloud.');
  const cap = tester ? TTS_LIMITS.testerChars : TTS_LIMITS.ownerChars;
  const units = spokenUnits(text);
  if ((tester ? units : text.length) > cap) return bad(413, 'too_large', `Read aloud takes up to ${cap.toLocaleString('en-US')} characters at a time.`);
  return { ok: true, voiceId, voice, text, units, preview: false };
}

// Reads a byte stream → {bytes, size}. Past `cap` bytes, bytes is null; the rest is then read only to be counted, up to
// `countTo` bytes (so a caller can tell how much a provider produced), and size is the count so far.
async function readSized(stream, cap, countTo = cap) {
  if (!stream) return { bytes: new Uint8Array(0), size: 0 };
  const reader = stream.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    n += r.value.byteLength;
    if (n > cap) {
      chunks.length = 0;
      if (n > countTo) { reader.cancel().catch(() => {}); break; }
      continue;
    }
    chunks.push(r.value);
  }
  if (n > cap) return { bytes: null, size: n };
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return { bytes: out, size: n };
}
// Reads a byte stream into one Uint8Array, or null once it passes `cap` bytes.
const readCapped = async (stream, cap) => (await readSized(stream, cap)).bytes;

function b64bytes(s) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(s);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── OpenAI: SSE → mp3 bytes ──
/**
 * OpenAI speech SSE (`data: {"type":"speech.audio.delta","audio":"<base64>"}` … `speech.audio.done`) → the raw mp3
 * bytes. Lines may be split anywhere across chunks and end in LF or CRLF. Deltas after speech.audio.done are ignored
 * (the stream is still read to its end, so the usage tap sees it). Errors on an error event, on undecodable audio,
 * once the decoded audio passes maxBytes, or when the stream ends without any audio.
 */
export function sseToAudio(maxBytes = TTS_LIMITS.maxAudioBytes) {
  const dec = new TextDecoder();
  let buf = '', total = 0, done = false;
  const line = (raw, ctrl) => {
    const l = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!l.startsWith('data:')) return;
    const d = l.slice(5).trim();
    if (!d || d === '[DONE]') return;
    let j;
    try { j = JSON.parse(d); } catch { return; }
    if (j?.type === 'speech.audio.delta') {
      if (done || typeof j.audio !== 'string' || !j.audio) return;
      let bytes;
      try { bytes = b64bytes(j.audio); } catch { throw new Error('undecodable audio from the provider'); }
      total += bytes.byteLength;
      if (total > maxBytes) throw new Error('the audio is longer than one read-aloud request allows');
      ctrl.enqueue(bytes);
    } else if (j?.type === 'speech.audio.done') {
      done = true;
    } else if (j?.type === 'error' || j?.error) {
      throw new Error(`provider error event: ${redact(j?.error?.message || j?.error?.code || j?.message || 'unknown')}`);
    }
  };
  return new TransformStream({
    transform(chunk, ctrl) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); line(l, ctrl); }
      // base64 is 4/3 of the audio; a line far past that can only be garbage
      if (buf.length > maxBytes * 2) throw new Error('an oversized event from the provider');
    },
    flush(ctrl) {
      buf += dec.decode();
      if (buf) line(buf, ctrl);
      buf = '';
      if (!total) throw new Error('the provider returned no audio');
    },
  });
}

// Passes bytes through unchanged, erroring past maxBytes (used if OpenAI answers with plain audio instead of SSE).
function capBytes(maxBytes) {
  let total = 0;
  return new TransformStream({
    transform(chunk, ctrl) {
      total += chunk.byteLength;
      if (total > maxBytes) throw new Error('the audio is longer than one read-aloud request allows');
      ctrl.enqueue(chunk);
    },
    flush() { if (!total) throw new Error('the provider returned no audio'); },
  });
}

async function timed(url, init) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(new Error('the voice provider did not answer in time')), TTS_LIMITS.timeoutMs);
  try { return await fetch(url, { ...init, signal: ctl.signal, redirect: 'manual' }); } finally { clearTimeout(t); }
}

/** The JSON body sent to OpenAI: model, brief and format are server constants. */
export const openaiSpeechBody = (voice, text) => ({
  model: voice.model, voice: voice.voice, input: text, instructions: TTS_BRIEF, response_format: 'mp3', stream_format: 'sse',
});
/** POST /v1/audio/speech (SSE) → the upstream Response (body unread). */
export function openaiSpeech({ key, voice, text }) {
  return timed(OPENAI_SPEECH, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(openaiSpeechBody(voice, text)),
  });
}

// ── Gemini: unary generateContent → WAV ──
/** A 44-byte WAV (RIFF) header for `dataBytes` of PCM. */
export function wavHeader(dataBytes, rate = 24_000, channels = 1, bits = 16) {
  const v = new DataView(new ArrayBuffer(44));
  const tag = (at, s) => { for (let i = 0; i < 4; i++) v.setUint8(at + i, s.charCodeAt(i)); };
  const block = channels * bits / 8;
  tag(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); tag(8, 'WAVE');
  tag(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * block, true); v.setUint16(32, block, true); v.setUint16(34, bits, true);
  tag(36, 'data'); v.setUint32(40, dataBytes, true);
  return new Uint8Array(v.buffer);
}
const isRiff = (b) => b.length >= 44 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46; // "RIFF"

const pcmRate = (mime) => { const r = Number(String(mime).match(/rate=(\d+)/i)?.[1]); return r >= 8_000 && r <= 48_000 ? r : 24_000; };
// Seconds of audio in Gemini's bytes: a RIFF header's byte rate, else s16le mono at the mime type's rate (else 24 kHz).
function audioSeconds(bytes, mime = '') {
  if (isRiff(bytes)) {
    const byteRate = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(28, true);
    return byteRate > 0 ? (bytes.length - 44) / byteRate : 0;
  }
  return (bytes.length - (bytes.length % 2)) / (pcmRate(mime) * 2);
}
/** Gemini audio bytes → {wav, seconds}. Headerless PCM (s16le mono, `rate` from the mime type, else 24 kHz) is wrapped. */
export function toWav(bytes, mime = '') {
  if (isRiff(bytes)) return { wav: bytes, seconds: audioSeconds(bytes) };
  const rate = pcmRate(mime);
  const pcm = bytes.length % 2 ? bytes.subarray(0, bytes.length - 1) : bytes;
  const wav = new Uint8Array(44 + pcm.length);
  wav.set(wavHeader(pcm.length, rate), 0);
  wav.set(pcm, 44);
  return { wav, seconds: pcm.length / (rate * 2) };
}

/** The JSON body sent to Gemini (angle brackets are already stripped by validateTts). Output is bounded at the source. */
export const geminiSpeechBody = (voice, text) => ({
  contents: [{ role: 'user', parts: [{ text, speech_metadata: { style: voice.style } }] }],
  generationConfig: {
    responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { voice: voice.voice } },
    ...(voice.maxOutputTokens ? { maxOutputTokens: voice.maxOutputTokens } : {}),
  },
});
// The most of an answer that is kept (base64 of maxAudioBytes plus room for the JSON), and how far past it the rest is
// still counted to learn how much audio the provider made (and billed).
const GEMINI_JSON_CAP = Math.ceil(TTS_LIMITS.maxAudioBytes * 4 / 3) + 256 * 1024;
const GEMINI_COUNT_TO = 64 * 1024 * 1024;
/**
 * POST :generateContent → {res} (a non-OK upstream Response, body unread) | {wav, seconds, usage} | {wav: null, usage}
 * (an answer without audio) | {over: true, seconds, usage} (more audio than one request may return: it was made and
 * billed, so it is settled at its length, but not played). Throws when the answer is not JSON.
 */
export async function geminiSpeech({ key, voice, text }) {
  const res = await timed(`${GEMINI_BASE}/v1beta/models/${voice.model}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(geminiSpeechBody(voice, text)),
  });
  if (!res.ok) return { res };
  const { bytes: raw, size } = await readSized(res.body, GEMINI_JSON_CAP, GEMINI_COUNT_TO);
  // Too big to keep: the answer is base64 PCM, so its size tells the seconds of audio (at least; past GEMINI_COUNT_TO).
  if (!raw) return { over: true, seconds: Math.floor(size * 3 / 4) / PCM_BYTES_PER_SECOND, usage: null };
  const j = JSON.parse(new TextDecoder().decode(raw));
  const usage = j?.usageMetadata && typeof j.usageMetadata === 'object' ? j.usageMetadata : null;
  const cand = j?.candidates?.[0];
  if (cand?.finishReason === 'MAX_TOKENS') console.warn('tts gemini audio stopped at maxOutputTokens', voice.maxOutputTokens);
  const parts = cand?.content?.parts;
  const part = (Array.isArray(parts) ? parts : []).map((p) => p?.inlineData || p?.inline_data).find((d) => typeof d?.data === 'string' && d.data);
  if (!part) return { wav: null, usage };
  const mime = part.mimeType || part.mime_type;
  const bytes = b64bytes(part.data);
  if (bytes.length > TTS_LIMITS.maxAudioBytes) return { over: true, seconds: audioSeconds(bytes, mime), usage };
  return { ...toWav(bytes, mime), usage };
}

// ── Settings previews: one cached clip per voice, brief version and preview line in the data center's cache ──
export const previewCacheKey = (origin, voiceId) => {
  const v = TTS_VOICES[voiceId];
  return `${origin}/__tts-preview/v${TTS_BRIEF_V}/${PREVIEW_ID}/${voiceId}/${v.model}/${v.voice}`;
};
const edgeCache = () => { try { return globalThis.caches?.default ?? null; } catch { return null; } };
async function cacheGet(key) {
  const cache = edgeCache();
  if (!cache) return null;
  try {
    const hit = await cache.match(key);
    const type = hit?.headers.get('content-type');
    if (!hit?.ok || (type !== 'audio/mpeg' && type !== 'audio/wav')) return null;
    const bytes = new Uint8Array(await hit.arrayBuffer());
    return bytes.length ? { bytes, type } : null;
  } catch { return null; }
}
async function cachePut(key, bytes, type) {
  const cache = edgeCache();
  if (!cache) return;
  try {
    await cache.put(key, new Response(bytes, { headers: { 'content-type': type, 'cache-control': `public, max-age=${PREVIEW_MAX_AGE}` } }));
  } catch (err) { console.warn('tts preview cache put failed', redact(err?.message || err)); }
}

// ── the pipeline ──
const audioResponse = (body, type, voiceId, headers = {}) => new Response(body, {
  status: 200,
  headers: { ...headers, 'content-type': type, 'cache-control': 'no-store', 'x-tts-voice': voiceId, 'x-tts-brief': String(TTS_BRIEF_V) },
});

/**
 * The owner's hooks: nothing is reserved or settled; usage is logged as token counts only (never the text).
 * Hooks for testers come from src/tester/router.js:
 *   tester: true                        tester text cap
 *   unavailable(provider) → Response    no key for that provider
 *   reserve({voiceId, voice, chars, units, preview}) → {res} (refused) | {headers, settle(result) → headers|null}
 *     (chars: the text's length; units: its spoken length, spokenUnits; voice.maxOutputTokens bounds Gemini's audio)
 *     settle(result): null = keep the full reservation (cut off, failed, unknown); {billed: false} = nothing was billed;
 *     {usage, seconds?} = the provider's report (usage may be null when a finished stream reported none).
 */
export const OWNER_HOOKS = Object.freeze({
  tester: false,
  unavailable: (provider) => fail(503, 'tts_unavailable', `Read aloud needs ${PROVIDER_KEYS[provider]} on the server.`),
  async reserve({ voiceId }) {
    return {
      headers: {},
      async settle(r) {
        if (r && 'usage' in r) {
          const u = r.usage || {};
          const inTok = u.input_tokens ?? u.promptTokenCount ?? 0, outTok = u.output_tokens ?? u.candidatesTokenCount ?? 0;
          if ((r.usage && outTok > 0) || r.seconds > 0) console.log('tts', voiceId, 'tokens in', inTok, 'out', outTok, ...(r.seconds != null ? ['seconds', Math.round(r.seconds * 10) / 10] : []));
          else console.warn('tts', voiceId, 'finished without usage');
        }
        return null;
      },
    };
  },
});
const NO_USAGE = Object.freeze({ push() {}, result: () => null });
const RETRY_AFTER = /^[\w ,:+-]{1,40}$/;

async function upstreamFailed(res, m, v) {
  const detail = await res.text().catch(() => '');
  console.warn('tts upstream', res.status, v.voice.provider, v.voiceId, redact(detail));
  await m.settle({ billed: false });
  if (res.status === 429) {
    const ra = res.headers.get('retry-after');
    return fail(429, 'tts_busy', 'Read aloud is busy right now. Try again in a moment.', ra && RETRY_AFTER.test(ra) ? { 'retry-after': ra } : {});
  }
  return unavailable();
}

async function viaOpenAI(key, v, m, cacheKey) {
  const up = await openaiSpeech({ key, voice: v.voice, text: v.text });
  if (!up.ok) return upstreamFailed(up, m, v);
  if (!up.body) { await m.settle(null); return unavailable(); }
  const plain = /^(audio\/|application\/octet-stream)/i.test(up.headers.get('content-type') || '');
  const parser = plain ? NO_USAGE : openaiUsage();
  let settled = null;
  // meter: onEnd(usage, complete) runs once. Only a complete stream settles from its usage; a cut-off one keeps the
  // full reservation (meter reads the parser either way).
  const metered = meter(up.body, parser, async (usage, complete) => { settled = await m.settle(complete ? { usage } : null); });
  const audio = metered.pipeThrough(plain ? capBytes(TTS_LIMITS.maxAudioBytes) : sseToAudio(TTS_LIMITS.maxAudioBytes));
  if (!cacheKey) return audioResponse(audio, 'audio/mpeg', v.voiceId, m.headers);
  const bytes = await readCapped(audio, TTS_LIMITS.maxAudioBytes); // a stream error throws: the reservation stands
  if (!bytes?.length) throw new Error('the provider returned no audio');
  await cachePut(cacheKey, bytes, 'audio/mpeg');
  return audioResponse(bytes, 'audio/mpeg', v.voiceId, settled || m.headers);
}

async function viaGemini(key, v, m, cacheKey) {
  const r = await geminiSpeech({ key, voice: v.voice, text: v.text });
  if (r.res) return upstreamFailed(r.res, m, v);
  if (r.over) { // generated and billed, too long to return: settle what it cost, then the client reads with the device voice
    console.warn('tts upstream', 200, 'gemini', v.voiceId, 'audio longer than one request allows', Math.round(r.seconds), 's');
    await m.settle({ usage: r.usage, seconds: r.seconds });
    return unavailable();
  }
  if (!r.wav) {
    console.warn('tts upstream', 200, 'gemini', v.voiceId, 'answer without audio');
    await m.settle(r.usage ? { usage: r.usage, seconds: 0 } : null);
    return unavailable();
  }
  const settled = await m.settle({ usage: r.usage, seconds: r.seconds });
  if (cacheKey) await cachePut(cacheKey, r.wav, 'audio/wav');
  return audioResponse(r.wav, 'audio/wav', v.voiceId, settled || m.headers);
}

/**
 * POST /api/tts. Validation runs before anything is reserved or any provider is called.
 * → 200 audio/mpeg (OpenAI voices, streamed; a preview arrives whole) or audio/wav (Gemini), with x-tts-voice and
 *   x-tts-brief; or JSON {error, code}: 400 bad_request, 413 too_large, 429 tts_busy (retry-after kept),
 *   502 tts_unavailable, 503 tts_unavailable (owner: no key). Tester hooks add their own refusals (402, 401, 403, 503).
 */
export async function handleTts(req, env, hooks = OWNER_HOOKS) {
  const h = { ...OWNER_HOOKS, ...hooks };
  const tooLarge = () => fail(413, 'too_large', 'This read-aloud request is too large.');
  if (Number(req.headers.get('content-length') || 0) > TTS_LIMITS.bodyBytes) return tooLarge();
  const raw = await readCapped(req.body, TTS_LIMITS.bodyBytes);
  if (!raw) return tooLarge();
  let body = null;
  try { body = JSON.parse(new TextDecoder().decode(raw)); } catch {}
  const v = validateTts(body, { tester: Boolean(h.tester) });
  if (!v.ok) return fail(v.status, v.code, v.error);
  const key = env?.[PROVIDER_KEYS[v.voice.provider]];
  if (!key) return h.unavailable(v.voice.provider);

  const cacheKey = v.preview ? previewCacheKey(new URL(req.url).origin, v.voiceId) : null;
  if (cacheKey) {
    const hit = await cacheGet(cacheKey);
    if (hit) return audioResponse(hit.bytes, hit.type, v.voiceId);
  }
  const m = await h.reserve({ voiceId: v.voiceId, voice: v.voice, chars: v.text.length, units: v.units, preview: v.preview });
  if (m.res) return m.res;
  try {
    return await (v.voice.provider === 'gemini' ? viaGemini : viaOpenAI)(key, v, m, cacheKey);
  } catch (err) {
    console.warn('tts failed', v.voice.provider, v.voiceId, redact(err?.message || err));
    await m.settle(null); // whatever the provider did is unknown: the full reservation stands (no-op if already settled)
    return unavailable();
  }
}
