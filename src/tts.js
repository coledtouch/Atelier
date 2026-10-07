// Read aloud in the Atelier voice: POST /api/tts.
// One pipeline serves the owner (worker.js, after the passcode check) and testers (src/tester/router.js, which passes
// hooks that reserve and settle in the Ledger). The client sends only {voice, text} or {voice, preview: true}. The model,
// the voice brief and the audio format are server constants here, and voice ids are an allow-list (TTS_VOICES).
// Provider errors are mapped to our own codes and never passed through (error bodies can quote part of the key), no
// upstream header is copied onto the response, and the text being read is never logged.
// Design: tts-design.json (2026-09-30). Every AI voice is Google Gemini speech (generateContent, audio back as WAV):
//   atelier (the default)  gemini-3.8-flash-tts (GA 2026-09-22), prebuilt voice Achernar ("Soft"), the soft GEMINI_STYLE
//   sulafat                gemini-3.8-flash-lite-tts, prebuilt voice Sulafat
// OpenAI's gpt-4o-mini-tts retires 2027-01-06 with no /v1/audio/speech successor, so its voices (marin as 'atelier',
// cedar, sage) were dropped in v80; a saved 'cedar' or 'sage' reads as 'atelier' (RETIRED_VOICES).
// Docs: https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash-tts  https://ai.google.dev/gemini-api/docs/speech-generation
import { GEMINI_BASE } from './gemini.js';

// Bump TTS_BRIEF_V whenever anything that changes how a voice sounds (its model, provider voice or GEMINI_STYLE)
// changes: clients key their cached clips on it, and the server's cached Settings previews roll over with it. Editing
// PREVIEW_TEXT needs no bump (previews are keyed on PREVIEW_ID, its hash), only the copy in public/readaloud.js.
// 1: OpenAI gpt-4o-mini-tts marin and its spoken brief. 2 (v80): Gemini 3.8 Flash TTS, Achernar, with GEMINI_STYLE.
export const TTS_BRIEF_V = 2;
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
 * Korean character as a syllable or more. Tester requests are capped in these units (TTS_LIMITS.testerChars) and
 * priced on ttsCeilingUnits, which builds on them. public/readaloud.js segments with the same function (a test keeps the
 * two in step).
 */
const SPOKEN_EXTRA = [[/[0-9]/g, 3], [/[%$€£¥&@#°×÷=+/§‰]/g, 2], [/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, 2]];
export function spokenUnits(text) {
  const s = String(text ?? '');
  let n = s.length;
  for (const [re, w] of SPOKEN_EXTRA) n += (s.match(re)?.length || 0) * w;
  return n;
}

// An emoji, once per cluster: a flag (two regional indicators), a keycap, or a pictograph with its skin tone, variation
// selector or tag sequence, and any ZWJ-joined pictographs after it (a family, "woman in motorized wheelchair").
const EMOJI_MOD = '(?:\\uFE0F|\\p{Emoji_Modifier}|[\\u{E0020}-\\u{E007F}])*';
const EMOJI_CLUSTER = new RegExp(`(?:\\p{Regional_Indicator}{2}|[#*0-9]\\uFE0F?\\u20E3|\\p{Extended_Pictographic}${EMOJI_MOD})(?:\\u200D(?:\\p{Extended_Pictographic}|\\p{Regional_Indicator})${EMOJI_MOD})*`, 'gu');
const EMOJI_PART = /\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|⃣/gu;
const SAID_AS_WORD = /[\p{Sc}%&@#+=*/\\_°×÷§‰]/u; // "percent", "dollars", "at", "slash", "underscore", "divided by"
const SAID_AS_NAME = /[\p{S}\p{No}\p{Nl}¶†‡※⁂•‣⁃]/u; // ≤ "less-than or equal to", → "rightwards arrow", < > | ~ ^, ½, Ⅷ, • "bullet"
const OTHER_DIGIT = /(?![0-9])\p{Nd}/u;
/** Extra reading-time units ttsCeilingUnits adds (see there). */
export const TTS_CEILING = Object.freeze({ emoji: 36, emojiPart: 12, symbolTotal: 10, nameSymbol: 20, digit: 3 });
/**
 * A ceiling on the reading time, in spokenUnits' units: what a tester's reservation is priced on and what bounds the
 * audio a tester may get back (src/tester/router.js, prices.js ttsReserved). spokenUnits still sizes the client's
 * segments and the tester cap (public/readaloud.js mirrors it); this adds room for what a voice may read out as a word
 * or a name, at TTS_MIN_CHARS_PER_SECOND (8) units a second:
 *   - an emoji cluster (counted once: a flag, keycap, skin tone, tag or ZWJ sequence; ™ © ® too): +36, and +12 for each
 *     pictograph, skin tone or flag letter in it after the first ("couple with heart: woman, man, medium-light skin
 *     tone, medium-dark skin tone" is 76 characters; the cluster gets 96 units, 12 s)
 *   - any other symbol, fraction, superscript, Roman numeral or bullet, read as a name (≤ → ≈ < > | ~ ^ ½ •): +20
 *   - a symbol read as a word ($ € % & @ # + = * / \ _ ° × ÷ § ‰): 10 units in all
 *   - a digit of another script (Arabic-Indic, fullwidth…): +3, like 0-9
 * Letters, other punctuation and spaces keep their weights, so plain prose is priced as before.
 */
export function ttsCeilingUnits(text) {
  const s = String(text ?? '');
  let n = spokenUnits(s);
  const rest = s.replace(EMOJI_CLUSTER, (m) => {
    n += TTS_CEILING.emoji + TTS_CEILING.emojiPart * Math.max(0, (m.match(EMOJI_PART)?.length || 1) - 1);
    return ' ';
  });
  for (const ch of rest) {
    if (SAID_AS_WORD.test(ch)) n += Math.max(0, TTS_CEILING.symbolTotal - spokenUnits(ch));
    else if (SAID_AS_NAME.test(ch)) n += TTS_CEILING.nameSymbol;
    else if (OTHER_DIGIT.test(ch)) n += TTS_CEILING.digit;
  }
  return n;
}

export const TTS_LIMITS = Object.freeze({
  bodyBytes: 16_384, // the whole JSON request
  ownerChars: 4_000, // per request; the client sends one segment (at most 900 spoken units) at a time
  testerChars: 1_000, // per request, in spoken units (spokenUnits): plain prose is one unit per character
  maxAudioBytes: 8 * 1024 * 1024, // decoded audio per request
  timeoutMs: 30_000, // until the provider starts answering
});

const GEMINI_FLASH_TTS_MODEL = 'gemini-3.8-flash-tts'; // the Atelier voice
const GEMINI_TTS_MODEL = 'gemini-3.8-flash-lite-tts';
const GEMINI_STYLE = 'warm, soft and calm; unhurried and gentle, speaking a little slowly, like a thoughtful friend reading aloud';
const PCM_BYTES_PER_SECOND = 48_000; // Gemini speech: 24 kHz, 16-bit, mono
const GEMINI_AUDIO_TOKENS_PER_SECOND = 25; // published; prices.js bills by it
/**
 * Gemini output is bounded at the source: generationConfig.maxOutputTokens = as many audio tokens as fit in
 * TTS_LIMITS.maxAudioBytes (4,369, under both models' 16,384-token output limit: 174.8 s at the published 25/s, about
 * 137 s at the ≈ 32/s Sulafat really speaks). Google bills what it generates, so a longer answer must not be produced
 * only to be thrown away; tester reservations use this bound as their ceiling (prices.js ttsWorstCase maxAudioTokens).
 */
export const GEMINI_MAX_OUTPUT_TOKENS = Math.floor(TTS_LIMITS.maxAudioBytes / PCM_BYTES_PER_SECOND * GEMINI_AUDIO_TOKENS_PER_SECOND);

/**
 * The server allow-list of voices. The client sends only the id. 'device' (the browser's own speechSynthesis) is a
 * client-only option and is not served here. To change the default voice, edit the 'atelier' row (and bump TTS_BRIEF_V).
 */
export const TTS_VOICES = deepFreeze({
  atelier: { provider: 'gemini', model: GEMINI_FLASH_TTS_MODEL, voice: 'Achernar', style: GEMINI_STYLE, maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS },
  sulafat: { provider: 'gemini', model: GEMINI_TTS_MODEL, voice: 'Sulafat', style: GEMINI_STYLE, maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS },
});
export const TTS_VOICE_IDS = Object.freeze(Object.keys(TTS_VOICES));
/**
 * Retired voice ids → the voice that reads in their place (public/readaloud.js has the same map; a test keeps them in
 * step). The OpenAI voices went with gpt-4o-mini-tts, and 'atelier' is the nearest soft voice. A client still on an
 * older version may send one, so the server takes it too.
 */
export const RETIRED_VOICES = Object.freeze({ cedar: 'atelier', sage: 'atelier' });
/** The prices.js id a voice is metered under, e.g. 'gemini:gemini-3.8-flash-tts'. */
export const ttsPriceId = (voice) => `${voice.provider}:${voice.model}`;

const PROVIDER_KEYS = Object.freeze({ gemini: 'GEMINI_API_KEY' });
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
 * Checks a parsed request body → {ok: true, voiceId, voice, text, units, ceiling, preview} | {ok: false, status, code,
 * error}. Only `voice`, `text` and `preview` are read; every other field is ignored. A retired voice id (RETIRED_VOICES)
 * reads as its stand-in, and voiceId is then the stand-in's. The owner's cap is in characters, a tester's in spoken
 * units (spokenUnits, which the client segments by). ceiling (ttsCeilingUnits) is what a tester's reservation is priced
 * on and held to.
 */
export function validateTts(body, { tester = false } = {}) {
  const bad = (status, code, error) => ({ ok: false, status, code, error });
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad(400, 'bad_request', 'Send JSON {voice, text} or {voice, preview: true}.');
  const voiceId = typeof body.voice === 'string' && Object.hasOwn(RETIRED_VOICES, body.voice) ? RETIRED_VOICES[body.voice] : body.voice;
  if (typeof voiceId !== 'string' || !Object.hasOwn(TTS_VOICES, voiceId)) return bad(400, 'bad_request', `Unknown voice. Use one of: ${TTS_VOICE_IDS.join(', ')}.`);
  const voice = TTS_VOICES[voiceId];
  if (body.preview === true) return { ok: true, voiceId, voice, text: PREVIEW_TEXT, units: spokenUnits(PREVIEW_TEXT), ceiling: ttsCeilingUnits(PREVIEW_TEXT), preview: true };
  if (typeof body.text !== 'string') return bad(400, 'bad_request', 'text must be a string.');
  let text = body.text.replace(CONTROL, '');
  if (voice.provider === 'gemini') text = text.replace(ANGLES, ' ').replace(/[ \t]{2,}/g, ' ');
  text = text.trim();
  if (!text) return bad(400, 'bad_request', 'There is nothing to read aloud.');
  const cap = tester ? TTS_LIMITS.testerChars : TTS_LIMITS.ownerChars;
  const units = spokenUnits(text);
  if ((tester ? units : text.length) > cap) return bad(413, 'too_large', `Read aloud takes up to ${cap.toLocaleString('en-US')} characters at a time.`);
  return { ok: true, voiceId, voice, text, units, ceiling: ttsCeilingUnits(text), preview: false };
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

async function timed(url, init) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(new Error('the voice provider did not answer in time')), TTS_LIMITS.timeoutMs);
  try { return await fetch(url, { ...init, signal: ctl.signal, redirect: 'manual' }); } finally { clearTimeout(t); }
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
// Seconds of audio in Gemini's bytes (`size` of them, starting with `head`): a RIFF header's byte rate, else s16le mono
// at the mime type's rate (else 24 kHz).
function audioSeconds(head, mime = '', size = head.length) {
  if (isRiff(head)) {
    const byteRate = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(28, true);
    return byteRate > 0 ? (size - 44) / byteRate : 0;
  }
  return (size - (size % 2)) / (pcmRate(mime) * 2);
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

/**
 * The JSON body sent to Gemini (angle brackets are already stripped by validateTts). Output is bounded at the source:
 * the voice's maxOutputTokens, or a smaller bound (a tester's reserved audio tokens).
 */
export const geminiSpeechBody = (voice, text, maxOutputTokens) => {
  const bound = Math.min(voice.maxOutputTokens || Infinity, maxOutputTokens > 0 ? maxOutputTokens : Infinity);
  return {
    contents: [{ role: 'user', parts: [{ text, speech_metadata: { style: voice.style } }] }],
    generationConfig: {
      responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { voice: voice.voice } },
      ...(bound < Infinity ? { maxOutputTokens: bound } : {}),
    },
  };
};
// How far past maxAudioBytes an answer is still read (its JSON bytes) to learn how much audio the provider made (and
// billed), and the most the rest of the answer (usage, finish reason, mime type: a few hundred bytes) may take.
const GEMINI_COUNT_TO = 64 * 1024 * 1024;
const SKELETON_MAX = 1024 * 1024;
const AUDIO_MARK = '@audio';
const B64 = (() => {
  const t = new Int8Array(256).fill(-1);
  const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < 64; i++) t[a.charCodeAt(i)] = i;
  t[0x2d] = 62; t[0x5f] = 63; // base64url's - and _
  return t;
})();
const isSpace = (c) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;
const undecodable = () => new Error('undecodable audio from the provider');
/**
 * Reads a Gemini generateContent answer as it arrives, never holding it whole (an answer at the output bound is ~11 MB
 * of JSON; buffered, decoded and copied it peaked near 63 MB of a 128 MB isolate). The audio — the first non-empty
 * `data` string of an inlineData (or inline_data) object — is base64-decoded chunk by chunk into PCM pieces, kept up to
 * `keep` bytes and only counted past that. The rest of the JSON is kept as a small skeleton in which every such data
 * string is emptied and the decoded one reads "@audio". Strings are tracked with their escapes, so text that merely
 * mentions "data" is never taken for audio.
 * → {skeleton, pieces (null past keep), size, head} (size: decoded audio bytes; head: its first 44) | {cut: true, size,
 *   head} when the answer runs past `countTo` bytes (the rest is not read).
 */
async function readGeminiAnswer(stream, keep, countTo) {
  const reader = stream.getReader();
  const skel = [], head = new Uint8Array(44);
  let skelBytes = 0, read = 0, headLen = 0, pieces = [], size = 0;
  // JSON outside the audio: the string being read (its first 16 characters, to compare with key names), the string just
  // closed (a key once ':' follows), the key whose value comes next, and for each open { or [ the key it is the value of.
  let inStr = false, esc = false, str = '', strOk = true, closed = null, valueOf = null;
  const stack = [];
  // Inside an inlineData data string: 1 = decoding the audio, 2 = skipping a later one. Base64 state: bits not yet output.
  let mode = 0, decoded = false, acc = 0, bits = 0, pad = 0;
  const addSkel = (bytes) => {
    skelBytes += bytes.byteLength;
    if (skelBytes > SKELETON_MAX) throw new Error('an oversized answer from the provider');
    skel.push(bytes);
  };
  const decode = (b, from, to) => {
    if (to <= from) return;
    const out = new Uint8Array(Math.ceil((to - from) * 3 / 4) + 2);
    let k = 0;
    for (let i = from; i < to; i++) {
      const c = b[i];
      if (c === 0x3d) { pad++; continue; } // '='
      const v = B64[c];
      if (v < 0) { if (isSpace(c)) continue; throw undecodable(); }
      if (pad) throw undecodable(); // nothing may follow the padding
      acc = (acc << 6) | v; bits += 6;
      if (bits >= 8) { bits -= 8; out[k++] = (acc >> bits) & 0xff; acc &= (1 << bits) - 1; }
    }
    if (!k) return;
    const got = out.subarray(0, k);
    if (headLen < 44) { const n = Math.min(44 - headLen, k); head.set(got.subarray(0, n), headLen); headLen += n; }
    if (pieces && size + k <= keep) pieces.push(got); else pieces = null; // past keep: counted, not kept
    size += k;
  };
  const SLASH = Uint8Array.of(0x2f);
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    const b = r.value;
    read += b.byteLength;
    if (read > countTo) { reader.cancel().catch(() => {}); return { cut: true, size, head: head.subarray(0, headLen) }; }
    try { // a provider answer that fails to parse stops being read
      let i = 0, seg = 0; // seg: where the bytes still to copy into the skeleton start
      while (i < b.length) {
        if (mode) {
          if (esc) { // JSON may escape the base64 "/" as "\/"; nothing else belongs in base64
            esc = false;
            if (b[i] !== 0x2f) throw undecodable();
            if (mode === 1) decode(SLASH, 0, 1);
            i++;
            continue;
          }
          const q = b.indexOf(0x22, i), stop = q < 0 ? b.length : q;
          const e = b.indexOf(0x5c, i), end = e >= 0 && e < stop ? e : stop;
          if (mode === 1) decode(b, i, end);
          i = end;
          if (i === b.length) break;
          if (b[i] === 0x5c) { esc = true; i++; continue; }
          // the closing quote: an empty string leaves the audio for the next data string
          if (mode === 1 && bits === 6) throw undecodable(); // a lone base64 character can't be a byte
          const audio = mode === 1 && size > 0;
          if (audio) decoded = true;
          addSkel(new TextEncoder().encode(audio ? `${AUDIO_MARK}"` : '"'));
          mode = 0; i++; seg = i;
          continue;
        }
        const c = b[i];
        if (inStr) {
          if (esc) { esc = false; strOk = false; }
          else if (c === 0x5c) esc = true;
          else if (c === 0x22) { inStr = false; closed = strOk ? str : null; }
          else if (str.length < 16) str += String.fromCharCode(c);
          else strOk = false;
        } else if (c === 0x22) {
          const parent = stack[stack.length - 1];
          if (valueOf === 'data' && (parent === 'inlineData' || parent === 'inline_data')) {
            addSkel(b.slice(seg, i + 1)); // through the opening quote
            mode = decoded ? 2 : 1; valueOf = null; closed = null; i++;
            continue;
          }
          inStr = true; str = ''; strOk = true; valueOf = null; closed = null;
        } else if (c === 0x3a) { valueOf = closed; closed = null; } // ':' after a key
        else if (c === 0x7b || c === 0x5b) { stack.push(valueOf); valueOf = null; closed = null; } // { [
        else if (c === 0x7d || c === 0x5d) { stack.pop(); valueOf = null; closed = null; } // } ]
        else if (!isSpace(c)) { valueOf = null; closed = null; } // , or a number, true, false, null
        i++;
      }
      if (!mode && seg < b.length) addSkel(b.slice(seg));
    } catch (err) { reader.cancel().catch(() => {}); throw err; }
  }
  const all = new Uint8Array(skelBytes);
  let at = 0;
  for (const s of skel) { all.set(s, at); at += s.byteLength; }
  return { skeleton: new TextDecoder().decode(all), pieces, size, head: head.subarray(0, headLen) };
}
// PCM pieces (`size` bytes, starting with `head`) → {wav, seconds}, like toWav, copying each piece once and letting it go.
function wavOf(pieces, size, head, mime) {
  const riff = isRiff(head), rate = pcmRate(mime);
  const len = riff ? size : size - (size % 2);
  const wav = new Uint8Array(riff ? len : 44 + len);
  let at = riff ? 0 : 44;
  for (let k = 0; k < pieces.length && at < wav.length; k++) {
    const p = pieces[k];
    pieces[k] = null;
    const n = Math.min(p.byteLength, wav.length - at);
    wav.set(n === p.byteLength ? p : p.subarray(0, n), at);
    at += n;
  }
  if (riff) return { wav, seconds: audioSeconds(wav) };
  wav.set(wavHeader(len, rate), 0);
  return { wav, seconds: len / (rate * 2) };
}
/**
 * POST :generateContent → {res} (a non-OK upstream Response, body unread) | {wav, seconds, usage} | {wav: null, usage}
 * (an answer without audio) | {over: true, seconds, usage} (more audio than one request may return: it was made and
 * billed, so it is settled at its length, but not played). Throws when the answer is not JSON or its audio isn't base64.
 * maxOutputTokens: a bound below the voice's own (a tester's reserved audio tokens).
 */
export async function geminiSpeech({ key, voice, text, maxOutputTokens }) {
  const body = geminiSpeechBody(voice, text, maxOutputTokens);
  const res = await timed(`${GEMINI_BASE}/v1beta/models/${voice.model}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { res };
  if (!res.body) throw new Error('an empty answer from the provider');
  const a = await readGeminiAnswer(res.body, TTS_LIMITS.maxAudioBytes, GEMINI_COUNT_TO);
  // Read no further: what was decoded so far is the least it made (the mime type is unread: 24 kHz unless RIFF).
  if (a.cut) return { over: true, seconds: audioSeconds(a.head, '', a.size), usage: null };
  const j = JSON.parse(a.skeleton);
  const usage = j?.usageMetadata && typeof j.usageMetadata === 'object' ? j.usageMetadata : null;
  const cand = j?.candidates?.[0];
  if (cand?.finishReason === 'MAX_TOKENS') console.warn('tts gemini audio stopped at maxOutputTokens', body.generationConfig.maxOutputTokens);
  const parts = cand?.content?.parts;
  const part = (Array.isArray(parts) ? parts : []).map((p) => p?.inlineData || p?.inline_data).find((d) => d?.data === AUDIO_MARK);
  if (!part || !a.size) return { wav: null, usage };
  const mime = part.mimeType || part.mime_type;
  if (!a.pieces) return { over: true, seconds: audioSeconds(a.head, mime, a.size), usage };
  return { ...wavOf(a.pieces, a.size, a.head, mime), usage };
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
    if (!hit?.ok || type !== 'audio/wav') return null; // an older mp3 preview (OpenAI) is a miss
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
 *   reserve({voiceId, voice, chars, units, ceiling, preview}) → {res} (refused) | {headers, limits?, settle(result) →
 *     headers|null}
 *     (chars: the text's length; units: its spoken length, spokenUnits; ceiling: ttsCeilingUnits, a ceiling on its
 *     reading time; voice.maxOutputTokens bounds Gemini's audio)
 *     limits: {outputTokens} lowers Gemini's maxOutputTokens (a tester's reserved audio tokens).
 *     settle(result): null = keep the full reservation (failed, unknown); {billed: false} = nothing was billed;
 *     {usage, seconds} = the provider's report (Gemini usageMetadata, null when the answer had none; the seconds of
 *     audio it made).
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
          const inTok = u.promptTokenCount ?? 0, outTok = u.candidatesTokenCount ?? 0;
          if ((r.usage && outTok > 0) || r.seconds > 0) console.log('tts', voiceId, 'tokens in', inTok, 'out', outTok, ...(r.seconds != null ? ['seconds', Math.round(r.seconds * 10) / 10] : []));
          else console.warn('tts', voiceId, 'finished without usage');
        }
        return null;
      },
    };
  },
});
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

async function viaGemini(key, v, m, cacheKey) {
  const r = await geminiSpeech({ key, voice: v.voice, text: v.text, maxOutputTokens: m.limits?.outputTokens });
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
 * → 200 audio/wav, with x-tts-voice (the voice that read it: a retired id answers as its stand-in) and x-tts-brief;
 *   or JSON {error, code}: 400 bad_request, 413 too_large, 429 tts_busy (retry-after kept),
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
  const m = await h.reserve({ voiceId: v.voiceId, voice: v.voice, chars: v.text.length, units: v.units, ceiling: v.ceiling, preview: v.preview });
  if (m.res) return m.res;
  try {
    return await viaGemini(key, v, m, cacheKey);
  } catch (err) {
    console.warn('tts failed', v.voice.provider, v.voiceId, redact(err?.message || err));
    await m.settle(null); // whatever the provider did is unknown: the full reservation stands (no-op if already settled)
    return unavailable();
  }
}
