import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeEnv, mockFetch, restoreFetch, upstream, reply, api, signIn, PROFILE, resetTesterCaches, allowanceOf } from './tester-env.mjs';

const T = await import('../src/transcribe.js');
const { handleTranscribe, validateAudio, sniffAudio, wavInfo, langCode, cleanPrompt, cleanTranscript, classifyRefusal, openaiForm, geminiSttBody, geminiTextTokens,
  STT_MODELS, AUDIO_FORMATS, TRANSCRIBE_LIMITS, OWNER_HOOKS, FALLBACK_ON, GEMINI_STT_PROMPT, GEMINI_OVERHEAD_TOKENS, sttPriceId } = T;
const { GEMINI_BASE } = await import('../src/gemini.js');

const ORIGIN = 'https://atelier.ciprari.ai';
const OPENAI = /^POST https:\/\/api\.openai\.com\/v1\/audio\/transcriptions$/;
const GEMINI = /^POST https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-3\.5-flash-lite:generateContent$/;
const COUNT = /^POST https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-3\.5-flash-lite:countTokens$/;
const KEYS = { OPENAI_API_KEY: 'sk-openai-test', GEMINI_API_KEY: 'AQ.test-gemini-key-0123456789abcdef' };
const ONLY_OPENAI = { OPENAI_API_KEY: KEYS.OPENAI_API_KEY };
const ONLY_GEMINI = { GEMINI_API_KEY: KEYS.GEMINI_API_KEY };

// ── recordings ──
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const pad = (head, n) => { const b = new Uint8Array(n); b.set(head); for (let i = head.length; i < n; i++) b[i] = (i * 31 + 7) & 0xff; return b; };
const MP4 = pad([0, 0, 0, 0x1c, ...ascii('ftypiso5'), 0, 0, 2, 0, ...ascii('iso5iso6mp41')], 2_000); // Safari's MediaRecorder
const WEBM = pad([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84, ...ascii('webm')], 2_000);
const OGG = pad([...ascii('OggS'), 0, 2], 1_000);
const FLAC = pad(ascii('fLaC'), 1_000);
const MP3_ID3 = pad([...ascii('ID3'), 4, 0, 0], 1_000);
const MP3_SYNC = pad([0xff, 0xfb, 0x90, 0x64], 1_000);
const ADTS = pad([0xff, 0xf1, 0x50, 0x80], 1_000);
/** A WAV file: PCM by default; format 0xFFFE writes an extensible header with SubFormat `sub`; list adds an odd chunk. */
function wav(seconds, { rate = 16_000, channels = 1, bits = 16, format = 1, sub = 1, dataSize = null, list = false } = {}) {
  const block = channels * bits / 8, n = Math.round(seconds * rate) * block, fmtSize = format === 0xfffe ? 40 : 16;
  const total = 12 + 8 + fmtSize + (list ? 14 : 0) + 8 + n;
  const b = new Uint8Array(total), v = new DataView(b.buffer);
  const tag = (o, s) => [...s].forEach((c, i) => { b[o + i] = c.charCodeAt(0); });
  tag(0, 'RIFF'); v.setUint32(4, total - 8, true); tag(8, 'WAVE');
  let p = 12;
  tag(p, 'fmt '); v.setUint32(p + 4, fmtSize, true); v.setUint16(p + 8, format, true); v.setUint16(p + 10, channels, true);
  v.setUint32(p + 12, rate, true); v.setUint32(p + 16, rate * block, true); v.setUint16(p + 20, block, true); v.setUint16(p + 22, bits, true);
  if (format === 0xfffe) { v.setUint16(p + 24, 22, true); v.setUint16(p + 26, bits, true); v.setUint32(p + 28, 4, true); v.setUint16(p + 32, sub, true); }
  p += 8 + fmtSize;
  if (list) { tag(p, 'LIST'); v.setUint32(p + 4, 5, true); tag(p + 8, 'INFOx'); p += 14; } // odd size: one pad byte
  tag(p, 'data'); v.setUint32(p + 4, dataSize ?? n, true);
  for (let i = p + 8; i < total; i++) b[i] = (i * 7) & 0xff;
  return b;
}

// ── provider answers ──
const OAI_USAGE = { type: 'tokens', input_tokens: 120, input_token_details: { text_tokens: 0, audio_tokens: 120 }, output_tokens: 8, total_tokens: 128 };
const openaiOk = (text = ' Hello there. ', usage = OAI_USAGE) => reply(200, { text, ...(usage ? { usage } : {}) }, { 'x-request-id': 'req_1', 'openai-organization': 'org-secret', 'set-cookie': 'a=b', 'openai-processing-ms': '42' });
const LEAK = 'Incorrect API key provided: sk-proj-AbCdEf123456********************wxyz. You can find your API key at https://platform.openai.com/account/api-keys.';
const openaiErr = (status, message = LEAK, headers = {}) => reply(status, { error: { message, type: 'invalid_request_error', param: null, code: status === 401 ? 'invalid_api_key' : null } }, headers);
const G_USAGE = { promptTokenCount: 230, candidatesTokenCount: 9, thoughtsTokenCount: 40, totalTokenCount: 279 };
const geminiOk = (text = 'Hola, ¿qué tal?', { finishReason = 'STOP', usage = G_USAGE } = {}) => reply(200, {
  candidates: [{ content: { parts: [{ text: 'Thinking about the audio…', thought: true }, { text }] }, finishReason }],
  ...(usage ? { usageMetadata: usage } : {}),
}, { 'x-goog-request-id': 'g1' });
const geminiErr = (status, message = 'API key not valid: AQ.test-gemini-key-0123456789abcdef', st = 'INVALID_ARGUMENT', reason = null) => reply(status, { error: { code: status, message, status: st,
  ...(reason ? { details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'googleapis.com' }] } : {}) } });

const sttReq = (body, headers = {}, qs = '') => new Request(`${ORIGIN}/api/transcribe${qs}`, { method: 'POST', body, headers });
const formOf = (call) => ({ model: call.body.get('model'), response_format: call.body.get('response_format'), language: call.body.get('language'), prompt: call.body.get('prompt'), name: call.body.get('file')?.name, type: call.body.get('file')?.type });
const fileBytes = async (call) => new Uint8Array(await call.body.get('file').arrayBuffer());
// Tester-shaped hooks that record every reservation and settlement.
function recorder({ refuse = null } = {}) {
  const reserves = [], settles = [];
  return {
    reserves, settles,
    hooks: {
      tester: true,
      unavailable: () => new Response(JSON.stringify({ code: 'tester_unavailable' }), { status: 503 }),
      async reserve(j) {
        reserves.push(j);
        if (refuse && refuse(j)) return { res: new Response(JSON.stringify({ code: 'tester_budget' }), { status: 402 }) };
        return { headers: { 'x-tester-allowance': 'reserved' }, async settle(r) { settles.push(r); return { 'x-tester-allowance': 'settled' }; } };
      },
    },
  };
}

// console capture: nothing logged may hold a key fragment, the transcript or the hint
let logs = [];
const saved = { log: console.log, warn: console.warn, error: console.error };
beforeEach(() => {
  logs = [];
  for (const k of Object.keys(saved)) console[k] = (...a) => logs.push(a.map(String).join(' '));
});
afterEach(() => {
  Object.assign(console, saved);
  restoreFetch();
});
const noLeaks = (...secrets) => {
  const all = logs.join('\n');
  for (const s of ['AbCdEf', 'wxyz', '****', '0123456789abcdef', 'sk-openai-test', ...secrets]) assert.ok(!all.includes(s), `the log holds ${s}:\n${all}`);
};

// ── the allow-list and limits ──
test('models are a frozen server allow-list: OpenAI pinned snapshot first, Gemini 3.5 Flash-Lite as the fallback', () => {
  assert.deepEqual(Object.keys(STT_MODELS), ['openai', 'gemini']);
  assert.deepEqual({ ...STT_MODELS.openai }, { provider: 'openai', model: 'gpt-4o-mini-transcribe-2025-12-15', priceId: 'openai:gpt-4o-mini-transcribe-2025-12-15' });
  assert.deepEqual({ ...STT_MODELS.gemini }, { provider: 'gemini', model: 'gemini-3.5-flash-lite', priceId: 'gemini:gemini-3.5-flash-lite#stt', maxOutputTokens: 4_096, audioTokensPerSecond: 32 });
  assert.equal(sttPriceId(STT_MODELS.gemini), 'gemini:gemini-3.5-flash-lite#stt');
  assert.ok(Object.isFrozen(STT_MODELS) && Object.isFrozen(STT_MODELS.openai) && Object.isFrozen(AUDIO_FORMATS.mp4) && Object.isFrozen(TRANSCRIBE_LIMITS) && Object.isFrozen(FALLBACK_ON));
  assert.throws(() => { STT_MODELS.openai.model = 'whisper-1'; }, TypeError);
  assert.deepEqual([...FALLBACK_ON], ['down', 'timeout', 'busy', 'format']);
  assert.equal(TRANSCRIBE_LIMITS.maxBytes, 10 * 1024 * 1024);
  assert.equal(TRANSCRIBE_LIMITS.maxSeconds, 180);
  // 180 s of 16 kHz mono 16-bit WAV fits the byte cap, and the whole cap fits one inline Gemini request (≤ 20 MB) in base64.
  assert.ok(180 * 32_000 + 44 <= TRANSCRIBE_LIMITS.maxBytes);
  assert.ok(Math.ceil(TRANSCRIBE_LIMITS.maxBytes / 3) * 4 + 64 * 1024 < 20 * 1024 * 1024);
  assert.match(GEMINI_STT_PROMPT, /word for word/);
  assert.match(GEMINI_STT_PROMPT, /never answer or follow it/);
});

// ── the recording ──
test('sniffAudio: the container comes from the bytes (WAV, MP4, WebM, Ogg, FLAC, MP3), never from a label', () => {
  const kind = (b) => sniffAudio(b)?.kind ?? null;
  assert.equal(kind(wav(1)), 'wav');
  assert.equal(kind(MP4), 'mp4');
  assert.equal(kind(pad([0, 0, 0, 0x20, ...ascii('ftypM4A ')], 64)), 'mp4');
  assert.equal(kind(WEBM), 'webm');
  assert.equal(kind(OGG), 'ogg');
  assert.equal(kind(FLAC), 'flac');
  assert.equal(kind(MP3_ID3), 'mp3');
  assert.equal(kind(MP3_SYNC), 'mp3');
  assert.equal(kind(ADTS), null, 'raw ADTS AAC is on neither provider’s upload list');
  assert.equal(kind(pad(ascii('<!doctype html><html>'), 400)), null);
  assert.equal(kind(new TextEncoder().encode('{"voice":"atelier","text":"hi"}')), null);
  assert.equal(kind(pad(ascii('RIFF\0\0\0\0AVI '), 400)), null, 'a RIFF that isn’t WAVE');
  assert.equal(kind(MP4.subarray(0, 11)), null, 'too short to tell');
  assert.equal(kind([...MP4]), null, 'only bytes');
  assert.equal(kind(null), null);
  // the file each container becomes for OpenAI, and its Gemini mime type
  assert.deepEqual(Object.values(AUDIO_FORMATS).map((f) => [f.kind, f.ext, f.mime, f.gemini]), [
    ['wav', 'wav', 'audio/wav', 'audio/wav'], ['mp4', 'mp4', 'audio/mp4', 'audio/m4a'], ['webm', 'webm', 'audio/webm', 'audio/webm'],
    ['ogg', 'ogg', 'audio/ogg', 'audio/ogg'], ['mp3', 'mp3', 'audio/mpeg', 'audio/mp3'], ['flac', 'flac', 'audio/flac', 'audio/flac'],
  ]);
});

test('wavInfo: the length from the fmt chunk and the data actually sent; compressed or broken WAVs are refused', () => {
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);
  let w = wavInfo(wav(2.5));
  close(w.seconds, 2.5);
  assert.deepEqual([w.rate, w.channels, w.bits, w.dataBytes], [16_000, 1, 16, 80_000]);
  close(wavInfo(wav(1, { rate: 48_000, channels: 2, bits: 24 })).seconds, 1);
  close(wavInfo(wav(1, { rate: 44_100, bits: 32, format: 3 })).seconds, 1);
  close(wavInfo(wav(0.5, { format: 0xfffe, sub: 1 })).seconds, 0.5);
  close(wavInfo(wav(0.5, { format: 0xfffe, sub: 3, bits: 32 })).seconds, 0.5);
  close(wavInfo(wav(1, { list: true })).seconds, 1, 'an odd-sized chunk before data is skipped with its pad byte');
  // streamed WAVs leave the data size at 0 or 0xFFFFFFFF: the bytes sent decide; a claim beyond them is clamped
  close(wavInfo(wav(1, { dataSize: 0 })).seconds, 1);
  close(wavInfo(wav(1, { dataSize: 0xffffffff })).seconds, 1);
  close(wavInfo(wav(1).subarray(0, 44 + 16_000)).seconds, 0.5);
  // a header lying about the byte rate doesn't change the length: rate x channels x sample size does
  const lie = wav(1);
  new DataView(lie.buffer).setUint32(28, 1, true);
  close(wavInfo(lie).seconds, 1);
  assert.equal(wavInfo(wav(1, { format: 0x55 })), null, 'MP3 inside RIFF has no fixed byte rate');
  assert.equal(wavInfo(wav(1, { format: 0xfffe, sub: 0x55 })), null, 'neither does an extensible header around a codec');
  assert.equal(wavInfo(wav(1, { bits: 12 })), null);
  assert.equal(wavInfo(wav(0.1, { rate: 4_000 })), null);
  assert.equal(wavInfo(wav(1).subarray(0, 30)), null, 'no data chunk');
  assert.equal(wavInfo(MP4), null);
});

// A WAV assembled chunk by chunk, for the layouts decoders read differently.
const riffChunk = (id, body) => { const b = new Uint8Array(8 + body.length + (body.length & 1)); b.set(ascii(id)); new DataView(b.buffer).setUint32(4, body.length, true); b.set(body, 8); return b; };
const fmtBody = (rate, channels, bits) => { const b = new Uint8Array(16), v = new DataView(b.buffer); v.setUint16(0, 1, true); v.setUint16(2, channels, true); v.setUint32(4, rate, true); v.setUint32(8, rate * channels * bits / 8, true); v.setUint16(12, channels * bits / 8, true); v.setUint16(14, bits, true); return b; };
const riff = (...chunks) => { const n = chunks.reduce((a, c) => a + c.length, 4), out = new Uint8Array(8 + n); out.set(ascii('RIFF')); new DataView(out.buffer).setUint32(4, n, true); out.set(ascii('WAVE'), 8); let p = 12; for (const c of chunks) { out.set(c, p); p += c.length; } return out; };

test('wavInfo: one fmt before one data, or nothing: a length decoders would read differently is never trusted', () => {
  const big = new Uint8Array(1_000_000); // 125 s at 8 kHz 8-bit mono; 0.65 s at 192 kHz 32-bit x 8
  // ffmpeg takes the FIRST fmt chunk (here 125 s); reading the last one would have measured 0.65 s
  assert.equal(wavInfo(riff(riffChunk('fmt ', fmtBody(8_000, 1, 8)), riffChunk('fmt ', fmtBody(192_000, 8, 32)), riffChunk('data', big))), null, 'two fmt chunks');
  // a tiny first data chunk, then the real one: a decoder that plays on hears it all, the first alone is 1 s
  assert.equal(wavInfo(riff(riffChunk('fmt ', fmtBody(8_000, 1, 8)), riffChunk('data', new Uint8Array(8_000)), riffChunk('data', big))), null, 'two data chunks');
  assert.equal(wavInfo(riff(riffChunk('data', big), riffChunk('fmt ', fmtBody(8_000, 1, 8)))), null, 'data before its format');
  assert.equal(wavInfo(riff(riffChunk('fmt ', new Uint8Array(14)), riffChunk('data', big))), null, 'a fmt chunk too small to be one');
  for (const b of [riff(riffChunk('fmt ', fmtBody(8_000, 1, 8)), riffChunk('fmt ', fmtBody(192_000, 8, 32)), riffChunk('data', big)),
    riff(riffChunk('fmt ', fmtBody(8_000, 1, 8)), riffChunk('data', new Uint8Array(8_000)), riffChunk('data', big))]) {
    assert.deepEqual([validateAudio(b).status, validateAudio(b).code], [415, 'unsupported_audio']);
  }
  // chunks after the data (a LIST tag, an id3 chunk) are normal and don't change the length
  const tagged = riff(riffChunk('fmt ', fmtBody(16_000, 1, 16)), riffChunk('data', new Uint8Array(32_000)), riffChunk('LIST', ascii('INFOISFT')), riffChunk('id3 ', new Uint8Array(9)));
  assert.equal(wavInfo(tagged).seconds, 1);
  assert.equal(validateAudio(tagged).ok, true);
});

test('langCode: the UI or device language → the ISO 639-1 code OpenAI takes, only when Whisper knows it', () => {
  for (const [tag, want] of [['en-US', 'en'], ['en', 'en'], ['pt_BR', 'pt'], ['zh-Hant-TW', 'zh'], ['sr-Latn-RS', 'sr'], ['FR-ca', 'fr'], ['iw-IL', 'he'],
    ['in', 'id'], ['nb-NO', 'no'], ['nn', 'nn'], ['fil-PH', 'tl'], ['ja-JP', 'ja'], ['yue-HK', null], ['haw', null], ['xx', null], ['tlh', null],
    ['', null], ['e', null], ['en-', null], ['en US', null], ['<script>', null], ['en-US;q=1', null], [`en-${'a'.repeat(40)}`, null], [null, null], [5, null], [['en'], null]]) {
    assert.equal(langCode(tag), want, String(tag));
  }
});

test('cleanPrompt: x-dictate-prompt is percent-decoded, one line, no angle brackets, capped; anything malformed is ignored', () => {
  assert.equal(cleanPrompt(encodeURIComponent('Ciprari, Atelier and Claude')), 'Ciprari, Atelier and Claude');
  assert.equal(cleanPrompt(encodeURIComponent('Zoë\n\tand  José <b>')), 'Zoë and José b');
  assert.equal(cleanPrompt(encodeURIComponent('名前: 田中')), '名前: 田中');
  assert.equal([...cleanPrompt(encodeURIComponent('😀'.repeat(340)))].length, TRANSCRIBE_LIMITS.promptChars, 'capped in code points');
  assert.ok(encodeURIComponent('😀'.repeat(TRANSCRIBE_LIMITS.promptChars)).length <= TRANSCRIBE_LIMITS.promptHeaderChars, 'a full-length hint fits the raw header cap');
  assert.equal(cleanPrompt('%E0%A4%A'), null, 'a broken escape');
  assert.equal(cleanPrompt('x'.repeat(TRANSCRIBE_LIMITS.promptHeaderChars + 1)), null);
  for (const v of ['', '%20%0A', null, undefined, 7]) assert.equal(cleanPrompt(v), null, String(v));
});

test('validateAudio: empty, tiny, unknown, too long and too short are refused before anything is reserved', () => {
  const v = (b, o) => { const r = validateAudio(b, o); return r.ok ? 'ok' : [r.status, r.code]; };
  assert.deepEqual(v(new Uint8Array(0)), [400, 'bad_request']);
  assert.deepEqual(v(null), [400, 'bad_request']);
  assert.deepEqual(v(MP4.subarray(0, 100)), [422, 'transcribe_short']);
  assert.deepEqual(v(pad(ascii('hello world, not audio'), 500)), [415, 'unsupported_audio']);
  assert.deepEqual(v(ADTS), [415, 'unsupported_audio']);
  assert.deepEqual(v(wav(1, { format: 0x55 })), [415, 'unsupported_audio']);
  assert.deepEqual(v(wav(0.05)), [422, 'transcribe_short']);
  assert.deepEqual(v(wav(181, { rate: 8_000, bits: 8 })), [413, 'too_large']);
  assert.equal(v(wav(180, { rate: 8_000, bits: 8 })), 'ok');
  assert.deepEqual(v(new Uint8Array(TRANSCRIBE_LIMITS.maxBytes + 1)), [413, 'too_large']);
  const ok = validateAudio(WEBM, { lang: 'pt_BR', prompt: encodeURIComponent('Ciprari') });
  assert.deepEqual({ ...ok.audio, bytes: ok.audio.bytes.length, format: ok.audio.format.kind }, { bytes: 2_000, format: 'webm', seconds: null, language: 'pt', hint: 'pt-BR', prompt: 'Ciprari' });
  const w = validateAudio(wav(3), { lang: 'yue-HK' }).audio;
  assert.deepEqual([w.seconds, w.language, w.hint, w.prompt], [3, null, 'yue-HK', null]);
  assert.match(validateAudio(wav(200, { rate: 8_000, bits: 8 })).error, /3 minutes/);
});

test('bad requests answer before any reservation or provider call (and a declared or streamed body over 10 MB is cut off)', async () => {
  mockFetch([]);
  const rec = recorder();
  for (const [body, status, code] of [[new Uint8Array(0), 400, 'bad_request'], [MP4.subarray(0, 50), 422, 'transcribe_short'], [pad(ascii('not audio at all'), 300), 415, 'unsupported_audio'],
    [wav(0.01), 422, 'transcribe_short'], [wav(181, { rate: 8_000, bits: 8 }), 413, 'too_large'], [new Uint8Array(TRANSCRIBE_LIMITS.maxBytes + 1), 413, 'too_large']]) {
    for (const hooks of [OWNER_HOOKS, rec.hooks]) {
      const r = await handleTranscribe(sttReq(body), KEYS, hooks);
      assert.equal(r.status, status, `${code} ${body.length}`);
      const j = await r.json();
      assert.equal(j.code, code);
      assert.equal(typeof j.error, 'string');
      assert.deepEqual([...r.headers.keys()].sort(), ['cache-control', 'content-type']);
    }
  }
  const r = await handleTranscribe(sttReq(MP4, { 'content-length': String(TRANSCRIBE_LIMITS.maxBytes + 1) }), KEYS, rec.hooks);
  assert.equal(r.status, 413);
  // streamed in pieces with no length: still cut off at the cap
  const chunk = new Uint8Array(1024 * 1024);
  const stream = new ReadableStream({ start(c) { for (let i = 0; i < 11; i++) c.enqueue(chunk); c.close(); } });
  const s = await handleTranscribe(new Request(`${ORIGIN}/api/transcribe`, { method: 'POST', body: stream, duplex: 'half' }), KEYS, rec.hooks);
  assert.equal(s.status, 413);
  assert.equal(rec.reserves.length, 0);
  assert.equal(upstream.calls.length, 0);
});

test('no key for any provider → the hooks’ unavailable (owner: 503 naming the secret), after validation, with no call', async () => {
  mockFetch([]);
  let r = await handleTranscribe(sttReq(MP4), {});
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { error: 'Dictation needs OPENAI_API_KEY (or GEMINI_API_KEY) on the server.', code: 'transcribe_unavailable' });
  const rec = recorder();
  r = await handleTranscribe(sttReq(MP4), { APP_PASSCODE: 'pw' }, rec.hooks);
  assert.equal(r.status, 503);
  assert.equal((await r.json()).code, 'tester_unavailable');
  r = await handleTranscribe(sttReq(new Uint8Array(0)), {});
  assert.equal(r.status, 400, 'a bad body is still a bad body');
  assert.equal(rec.reserves.length, 0);
  assert.equal(upstream.calls.length, 0);
});

// ── OpenAI ──
test('OpenAI: the file is named by its sniffed container whatever the label; model and format are server constants', async () => {
  mockFetch([[OPENAI, () => openaiOk()]]);
  const r = await handleTranscribe(sttReq(MP4, { 'content-type': 'audio/webm;codecs=opus', 'x-dictate-lang': 'en-US', 'x-dictate-prompt': encodeURIComponent('Atelier, Ciprari') }), KEYS);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.fromEntries(r.headers), { 'cache-control': 'no-store', 'content-type': 'application/json', 'x-transcribe-provider': 'openai' });
  assert.deepEqual(await r.json(), { text: 'Hello there.', provider: 'openai' });
  assert.equal(upstream.calls.length, 1);
  const call = upstream.calls[0];
  assert.equal(call.headers.get('authorization'), 'Bearer sk-openai-test');
  assert.equal(call.headers.get('accept'), 'application/json');
  assert.ok(call.body instanceof FormData);
  assert.deepEqual(formOf(call), { model: 'gpt-4o-mini-transcribe-2025-12-15', response_format: 'json', language: 'en', prompt: 'Atelier, Ciprari', name: 'dictation.mp4', type: 'audio/mp4' });
  assert.deepEqual([...call.body.keys()].sort(), ['file', 'language', 'model', 'prompt', 'response_format']);
  assert.deepEqual(await fileBytes(call), MP4, 'the recording is sent as it came');
  // every container, any label (or none); ?lang= works too; an unknown language is left to detection
  for (const [body, name, type] of [[WEBM, 'dictation.webm', 'audio/webm'], [OGG, 'dictation.ogg', 'audio/ogg'], [FLAC, 'dictation.flac', 'audio/flac'], [MP3_SYNC, 'dictation.mp3', 'audio/mpeg'], [wav(1), 'dictation.wav', 'audio/wav']]) {
    const res = await handleTranscribe(sttReq(body, { 'content-type': 'audio/mp4' }, '?lang=fr-CA'), KEYS);
    assert.equal(res.status, 200, name);
    const f = formOf(upstream.calls.at(-1));
    assert.deepEqual([f.name, f.type, f.language, f.prompt], [name, type, 'fr', null]);
  }
  await handleTranscribe(sttReq(MP4, { 'x-dictate-lang': 'yue-HK' }), KEYS);
  assert.equal(formOf(upstream.calls.at(-1)).language, null);
  // a WAV's length comes back with the text; the owner's log has token counts only
  const w = await handleTranscribe(sttReq(wav(2.26)), KEYS);
  assert.deepEqual(await w.json(), { text: 'Hello there.', provider: 'openai', seconds: 2.3 });
  assert.ok(logs.some((l) => l === 'transcribe openai tokens in 120 audio 120 out 8'), logs.join('\n'));
  assert.ok(logs.some((l) => l === 'transcribe openai tokens in 120 audio 120 out 8 seconds 2.3'), logs.join('\n'));
  noLeaks('Hello there', 'Ciprari');
});

test('OpenAI: silence is an empty transcript; text is cleaned and capped; an answer without usage still returns', async () => {
  let answer = openaiOk('');
  mockFetch([[OPENAI, () => answer]]);
  let r = await handleTranscribe(sttReq(WEBM), KEYS);
  assert.deepEqual(await r.json(), { text: '', provider: 'openai' });
  answer = openaiOk(` Line one.\r\nLine\u0007 two.\u0000 ${'x'.repeat(30_000)}`);
  r = await handleTranscribe(sttReq(WEBM), KEYS);
  const t = (await r.json()).text;
  assert.ok(t.startsWith('Line one.\nLine two. x'));
  assert.equal(t.length, TRANSCRIBE_LIMITS.maxText);
  assert.equal(cleanTranscript(7), '');
  answer = openaiOk('Hi.', null);
  r = await handleTranscribe(sttReq(WEBM), KEYS);
  assert.deepEqual(await r.json(), { text: 'Hi.', provider: 'openai' });
  assert.ok(logs.some((l) => /transcribe openai finished without usage/.test(l)));
});

test('an upstream 401 quoting the key: nothing upstream reaches the client or the log; only OpenAI → 502', async () => {
  mockFetch([[OPENAI, () => openaiErr(401, LEAK, { 'x-request-id': 'req_9', 'set-cookie': 'z=1', 'openai-organization': 'org-x' })]]);
  const r = await handleTranscribe(sttReq(MP4), ONLY_OPENAI);
  assert.equal(r.status, 502);
  const text = await r.text();
  assert.deepEqual(JSON.parse(text), { error: 'Dictation is unavailable right now.', code: 'transcribe_unavailable' });
  assert.ok(!/sk-|wxyz|AbCdEf|invalid_api_key/.test(text));
  assert.deepEqual([...r.headers.keys()].sort(), ['cache-control', 'content-type']);
  assert.ok(logs.some((l) => l === 'transcribe upstream 401 openai gpt-4o-mini-transcribe-2025-12-15 invalid_request_error/invalid_api_key'), logs.join('\n'));
  noLeaks();
});

test('classifyRefusal: what a refusal means for the fallback and the answer', () => {
  const m = (message) => ({ error: { message } });
  for (const [status, json, want] of [
    [429, null, 'busy'], [413, null, 'too_large'], [415, null, 'format'], [408, null, 'timeout'], [504, null, 'timeout'],
    // out of credit until someone pays: not "busy, try again in a moment"
    [429, { error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', param: null, code: 'insufficient_quota' } }, 'down'],
    [429, { error: { message: 'x', type: 'invalid_request_error', code: 'insufficient_quota' } }, 'down'],
    [429, { error: { message: 'Rate limit reached for requests', type: 'requests', code: 'rate_limit_exceeded' } }, 'busy'],
    [429, { error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } }, 'busy'],
    [400, m('Audio file is too short. Minimum audio length is 0.1 seconds.'), 'short'],
    [400, m('Invalid file format. Supported formats: [\'flac\', \'m4a\', \'mp3\', \'mp4\', \'mpeg\', \'mpga\', \'oga\', \'ogg\', \'wav\', \'webm\']'), 'format'],
    [400, m('The audio file could not be decoded or its format is not supported.'), 'format'],
    [400, m('Unsupported MIME type: audio/m4a'), 'format'],
    [400, m('API key not valid. Please pass a valid API key.'), 'down'], [400, m('Something about the request.'), 'unreadable'], [400, null, 'unreadable'], [422, m('x'), 'unreadable'],
    [401, null, 'down'], [403, null, 'down'], [404, null, 'down'], [409, null, 'down'], [500, null, 'down'], [503, null, 'down'], [302, null, 'down'],
  ]) assert.equal(classifyRefusal(status, json), want, `${status} ${json?.error?.message ?? ''}`);
});

test('OpenAI refusals map to our codes; 429 keeps a sane retry-after; the recording-is-the-problem answers are not retried', async () => {
  let res;
  mockFetch([[OPENAI, () => res()], [GEMINI, () => geminiOk()], [COUNT, () => reply(200, { totalTokens: 400 })]]);
  const cases = [
    [() => openaiErr(429, 'Rate limit reached', { 'retry-after': '7', 'x-ratelimit-remaining-requests': '0' }), 429, 'transcribe_busy', '7'],
    [() => openaiErr(429, 'Rate limit reached', { 'retry-after': 'soonÿx<script>' }), 429, 'transcribe_busy', null],
    [() => openaiErr(400, 'Audio file is too short. Minimum audio length is 0.1 seconds.'), 422, 'transcribe_short', null],
    // the container refused, and no other provider to try: 415, which the client words as "use the keyboard's mic"
    [() => openaiErr(400, 'Audio file might be corrupted or unsupported'), 415, 'unsupported_audio', null],
    [() => openaiErr(400, 'Invalid file format. Supported formats: [\'m4a\', \'mp4\', \'webm\']'), 415, 'unsupported_audio', null],
    [() => openaiErr(400, 'Bad request.'), 422, 'transcribe_unreadable', null],
    // out of credit: unavailable (not busy, and no retry-after to wait on)
    [() => reply(429, { error: { message: 'You exceeded your current quota.', type: 'insufficient_quota', param: null, code: 'insufficient_quota' } }, { 'retry-after': '1' }), 502, 'transcribe_unavailable', null],
    [() => openaiErr(413, 'Maximum content size limit exceeded.'), 413, 'too_large', null],
    [() => openaiErr(500, 'oops'), 502, 'transcribe_unavailable', null],
    [() => new Response('', { status: 302, headers: { location: 'https://evil.example/' } }), 502, 'transcribe_unavailable', null],
    [() => reply(200, 'not json'), 502, 'transcribe_unavailable', null],
    [() => reply(200, { usage: OAI_USAGE }), 502, 'transcribe_unavailable', null],
    [() => { throw new TypeError('fetch failed'); }, 502, 'transcribe_unavailable', null],
  ];
  for (const [make, status, code, retryAfter] of cases) {
    res = make;
    const r = await handleTranscribe(sttReq(WEBM), ONLY_OPENAI);
    assert.equal(r.status, status, code);
    assert.equal((await r.json()).code, code);
    assert.equal(r.headers.get('retry-after'), retryAfter);
    assert.equal(r.headers.get('x-ratelimit-remaining-requests'), null);
  }
  // with a Gemini key: a recording OpenAI read and refused is not sent again
  for (const msg of ['Audio file is too short. Minimum audio length is 0.1 seconds.', 'Bad request.']) {
    res = () => openaiErr(400, msg);
    upstream.calls = [];
    const r = await handleTranscribe(sttReq(WEBM), KEYS);
    assert.equal(r.status, 422);
    assert.equal(upstream.calls.length, 1, msg);
  }
  // a format refusal names the container in the log (a run of `container mp4` is Safari's recordings being refused)
  assert.ok(logs.some((l) => l === 'transcribe upstream 400 openai gpt-4o-mini-transcribe-2025-12-15 invalid_request_error container webm'), logs.join('\n'));
  assert.ok(logs.some((l) => l === 'transcribe upstream 429 openai gpt-4o-mini-transcribe-2025-12-15 insufficient_quota/insufficient_quota'), logs.join('\n'));
  noLeaks();
});

test('a provider that never answers times out: 504 transcribe_timeout, and the reservation stands', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let n = 0;
    globalThis.fetch = (url, init) => { n++; return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))); };
    const rec = recorder();
    const p = handleTranscribe(sttReq(WEBM), ONLY_OPENAI, rec.hooks);
    while (!n) await new Promise((ok) => setImmediate(ok));
    mock.timers.tick(TRANSCRIBE_LIMITS.timeoutMs);
    const r = await p;
    assert.equal(r.status, 504);
    assert.deepEqual(await r.json(), { error: 'Dictation took too long. Try a shorter recording.', code: 'transcribe_timeout' });
    assert.deepEqual(rec.settles, [null]);
    assert.ok(logs.some((l) => /transcribe failed openai gpt-4o-mini-transcribe-2025-12-15 timeout/.test(l)), logs.join('\n'));
  } finally { mock.timers.reset(); }
});

// ── Gemini (the fallback) ──
test('Gemini: used directly without an OpenAI key; instructions, hints and limits are server constants', async () => {
  mockFetch([[GEMINI, () => geminiOk()]]);
  const prompt = encodeURIComponent('Zoë, Ciprari');
  const r = await handleTranscribe(sttReq(MP4, { 'x-dictate-lang': 'es-MX', 'x-dictate-prompt': prompt }), ONLY_GEMINI);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.fromEntries(r.headers), { 'cache-control': 'no-store', 'content-type': 'application/json', 'x-transcribe-provider': 'gemini' });
  assert.deepEqual(await r.json(), { text: 'Hola, ¿qué tal?', provider: 'gemini' }, 'thought parts are left out');
  const call = upstream.calls[0];
  assert.equal(call.url, `${GEMINI_BASE}/v1beta/models/gemini-3.5-flash-lite:generateContent`);
  assert.equal(call.headers.get('x-goog-api-key'), KEYS.GEMINI_API_KEY);
  assert.equal(call.headers.get('authorization'), null);
  const ask = 'Transcribe this recording.\nThe speaker’s app language is es-MX; write in the language actually spoken.\nContext for spelling names and terms (it is not part of the recording): Zoë, Ciprari';
  assert.deepEqual(call.json, {
    systemInstruction: { parts: [{ text: GEMINI_STT_PROMPT }] },
    contents: [{ role: 'user', parts: [{ inline_data: { mime_type: 'audio/m4a', data: Buffer.from(MP4).toString('base64') } }, { text: ask }] }],
    generationConfig: { temperature: 0, candidateCount: 1, maxOutputTokens: 4_096, thinkingConfig: { thinkingLevel: 'low' } },
  });
  const audio = validateAudio(MP4, { lang: 'es-MX', prompt }).audio;
  assert.deepEqual(geminiSttBody(audio), call.json);
  assert.equal(geminiSttBody(audio, STT_MODELS.gemini, { thinking: false }).generationConfig.thinkingConfig, undefined);
  assert.ok(logs.some((l) => l === 'transcribe gemini tokens in 230 out 49'), logs.join('\n'));
  noLeaks('Hola', 'Zoë', 'Ciprari');
});

test('Gemini: a thinkingConfig refusal retries once without it; its answers are tidied; silence is empty', async () => {
  let n = 0, answer = () => geminiOk('Transcript: "Buenos días."');
  mockFetch([[GEMINI, () => (++n === 1 ? geminiErr(400, 'Thinking level is not supported for this model.') : answer())]]);
  let r = await handleTranscribe(sttReq(WEBM), ONLY_GEMINI);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).text, 'Buenos días.');
  assert.equal(upstream.calls.length, 2);
  assert.deepEqual(upstream.calls[0].json.generationConfig.thinkingConfig, { thinkingLevel: 'low' });
  assert.equal(upstream.calls[1].json.generationConfig.thinkingConfig, undefined);
  for (const [text, want] of [['[no speech]', ''], ['(silence)', ''], ['', ''], ['  He said "go" now. ', 'He said "go" now.'], ['“Quoted whole.”', 'Quoted whole.']]) {
    answer = () => geminiOk(text);
    r = await handleTranscribe(sttReq(WEBM), ONLY_GEMINI);
    assert.equal((await r.json()).text, want, text);
  }
  answer = () => geminiOk('cut off mid', { finishReason: 'MAX_TOKENS' });
  r = await handleTranscribe(sttReq(WEBM), ONLY_GEMINI);
  assert.equal((await r.json()).text, 'cut off mid', 'a long answer cut at the bound is still text');
});

test('Gemini: blocked, empty or broken answers and errors never echo the provider', async () => {
  let answer;
  mockFetch([[GEMINI, () => answer()]]);
  const cases = [
    [() => reply(200, { candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }], usageMetadata: { promptTokenCount: 9 } }), 422, 'transcribe_unreadable'],
    [() => reply(200, { promptFeedback: { blockReason: 'OTHER' }, usageMetadata: { promptTokenCount: 9 } }), 422, 'transcribe_unreadable'],
    [() => reply(200, { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'hmm', thought: true }] } }] }), 502, 'transcribe_unavailable'],
    [() => reply(200, {}), 502, 'transcribe_unavailable'],
    [() => reply(200, 'not json'), 502, 'transcribe_unavailable'],
    [() => geminiErr(400, 'API key not valid. Please pass a valid API key. AQ.test-gemini-key-0123456789abcdef', 'INVALID_ARGUMENT', 'API_KEY_INVALID'), 502, 'transcribe_unavailable'],
    [() => geminiErr(400, 'Request contains an invalid argument.'), 422, 'transcribe_unreadable'],
    [() => geminiErr(403, 'Permission denied for AQ.test-gemini-key-0123456789abcdef', 'PERMISSION_DENIED'), 502, 'transcribe_unavailable'],
    [() => geminiErr(429, 'Quota exceeded', 'RESOURCE_EXHAUSTED'), 429, 'transcribe_busy'],
    [() => geminiErr(500, 'Internal', 'INTERNAL'), 502, 'transcribe_unavailable'],
  ];
  for (const [make, status, code] of cases) {
    answer = make;
    const r = await handleTranscribe(sttReq(WEBM), ONLY_GEMINI);
    assert.equal(r.status, status, code);
    const text = await r.text();
    assert.equal(JSON.parse(text).code, code);
    assert.ok(!/AQ\.|INVALID|PERMISSION|0123456789abcdef/.test(text), text);
  }
  assert.ok(logs.some((l) => l === 'transcribe upstream 403 gemini gemini-3.5-flash-lite PERMISSION_DENIED'), logs.join('\n'));
  assert.ok(logs.some((l) => l === 'transcribe upstream 400 gemini gemini-3.5-flash-lite INVALID_ARGUMENT/API_KEY_INVALID'), logs.join('\n'));
  assert.ok(logs.some((l) => l === 'transcribe upstream 200 gemini gemini-3.5-flash-lite blocked SAFETY'), logs.join('\n'));
  noLeaks();
});

test('fallback: Gemini runs only when OpenAI is unavailable, busy, timed out or refused the file format', async () => {
  let res;
  mockFetch([[OPENAI, () => res()], [GEMINI, () => geminiOk('From Gemini.')]]);
  const quota = () => reply(429, { error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', param: null, code: 'insufficient_quota' } });
  for (const [make, why] of [[() => openaiErr(401), 'bad key'], [() => openaiErr(503, 'Service unavailable'), 'down'], [quota, 'out of credit'], [() => openaiErr(429, 'Rate limit reached'), 'rate limited'],
    [() => openaiErr(400, 'Invalid file format. Supported formats: [\'m4a\', \'mp4\']'), 'Safari MP4 refused'], [() => openaiErr(404, 'The model does not exist'), 'model gone'],
    [() => { throw new TypeError('fetch failed'); }, 'network'], [() => reply(200, '<html>'), 'not JSON']]) {
    res = make;
    upstream.calls = [];
    const r = await handleTranscribe(sttReq(MP4), KEYS);
    assert.equal(r.status, 200, why);
    assert.deepEqual(await r.json(), { text: 'From Gemini.', provider: 'gemini' }, why);
    assert.deepEqual(upstream.calls.map((c) => c.url.includes('openai') ? 'openai' : 'gemini'), ['openai', 'gemini'], why);
  }
  // both fail: the most telling answer wins (busy over down; a recording a provider read and refused over both). A format
  // refusal is only one provider's view: when Gemini then failed for a passing reason, that reason is the answer (the
  // client keeps the recording to send again); when nothing else could read it either, 415 (use the keyboard's mic).
  const formatRefused = () => openaiErr(400, 'Invalid file format. Supported formats: [\'m4a\', \'mp4\']');
  for (const [oai, gem, status, code] of [
    [() => openaiErr(429, 'slow down', { 'retry-after': '5' }), () => geminiErr(500, 'x', 'INTERNAL'), 429, 'transcribe_busy'],
    [() => openaiErr(500, 'x'), () => geminiErr(429, 'x', 'RESOURCE_EXHAUSTED'), 429, 'transcribe_busy'],
    [() => openaiErr(500, 'x'), () => geminiErr(500, 'x', 'INTERNAL'), 502, 'transcribe_unavailable'],
    [formatRefused, () => geminiErr(500, 'x', 'INTERNAL'), 502, 'transcribe_unavailable'],
    [formatRefused, () => geminiErr(503, 'x', 'UNAVAILABLE'), 502, 'transcribe_unavailable'],
    [formatRefused, () => geminiErr(429, 'x', 'RESOURCE_EXHAUSTED'), 429, 'transcribe_busy'],
    [formatRefused, () => geminiErr(504, 'x', 'DEADLINE_EXCEEDED'), 504, 'transcribe_timeout'],
    [formatRefused, () => geminiErr(400, 'Unsupported MIME type: audio/m4a'), 415, 'unsupported_audio'],
    [formatRefused, () => geminiErr(400, 'Request contains an invalid argument.'), 422, 'transcribe_unreadable'],
    [() => openaiErr(503, 'x'), () => geminiErr(400, 'Unsupported MIME type: audio/m4a'), 502, 'transcribe_unavailable'],
    [() => openaiErr(503, 'x'), () => reply(200, { candidates: [{ finishReason: 'SAFETY' }] }), 422, 'transcribe_unreadable'],
    [quota, () => geminiErr(503, 'x', 'UNAVAILABLE'), 502, 'transcribe_unavailable'],
  ]) {
    res = oai;
    mockFetch([[OPENAI, () => res()], [GEMINI, gem]]);
    const r = await handleTranscribe(sttReq(MP4), KEYS);
    assert.equal(r.status, status, code);
    assert.equal((await r.json()).code, code);
    if (status === 429 && code === 'transcribe_busy' && upstream.calls[0].url.includes('openai') && r.headers.get('retry-after')) assert.equal(r.headers.get('retry-after'), '5');
  }
  noLeaks('From Gemini');
});

// ── the hooks contract (testers) ──
test('tester hooks: OpenAI is reserved once on its context bound, settled from usage; the settled header is returned', async () => {
  mockFetch([[OPENAI, () => openaiOk()]]);
  const rec = recorder();
  const r = await handleTranscribe(sttReq(wav(1.5), { 'x-dictate-lang': 'en' }), KEYS, rec.hooks);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-tester-allowance'), 'settled');
  assert.equal(rec.reserves.length, 1);
  const j = rec.reserves[0];
  assert.deepEqual({ ...j, model: j.model.provider }, { model: 'openai', provider: 'openai', priceId: 'openai:gpt-4o-mini-transcribe-2025-12-15', bytes: wav(1.5).length, seconds: 1.5, inputTokens: null, fallback: false });
  assert.deepEqual(rec.settles, [{ usage: OAI_USAGE, seconds: 1.5 }]);
  // a refusal settles at $0; a timeout or an unreadable answer keeps the reservation; a textless answer with usage is settled on it
  for (const [make, settle] of [[() => openaiErr(401), { billed: false }], [() => openaiErr(400, 'Bad request.'), { billed: false }], [() => reply(200, 'x'), null], [() => reply(200, { usage: OAI_USAGE }), { usage: OAI_USAGE, seconds: null }]]) {
    mockFetch([[OPENAI, make]]);
    const t = recorder();
    await handleTranscribe(sttReq(WEBM), ONLY_OPENAI, t.hooks);
    assert.deepEqual(t.settles, [settle]);
  }
});

test('tester hooks: a refused first reservation is answered as is; a refused fallback answers with what went wrong first', async () => {
  mockFetch([[OPENAI, () => openaiErr(503, 'x')], [GEMINI, () => geminiOk()]]);
  let rec = recorder({ refuse: () => true });
  let r = await handleTranscribe(sttReq(wav(1)), KEYS, rec.hooks);
  assert.equal(r.status, 402);
  assert.equal(upstream.calls.length, 0);
  rec = recorder({ refuse: (j) => j.fallback });
  r = await handleTranscribe(sttReq(wav(1)), KEYS, rec.hooks);
  assert.equal(r.status, 502);
  assert.equal((await r.json()).code, 'transcribe_unavailable');
  assert.deepEqual(rec.reserves.map((j) => [j.provider, j.fallback]), [['openai', false], ['gemini', true]]);
  assert.deepEqual(rec.settles, [{ billed: false }]);
  assert.equal(upstream.calls.length, 1, 'Gemini was never called');
  // after a format refusal, a refused fallback is the answer itself: nothing else was wrong with the recording's trip
  mockFetch([[OPENAI, () => openaiErr(400, 'Invalid file format.')], [GEMINI, () => geminiOk()], [COUNT, () => reply(200, { totalTokens: 400 })]]);
  rec = recorder({ refuse: (j) => j.fallback });
  r = await handleTranscribe(sttReq(MP4), KEYS, rec.hooks);
  assert.equal(r.status, 402);
  assert.equal((await r.json()).code, 'tester_budget');
  // after a format refusal, a Gemini count that fails (no fallback for a tester) is a passing failure: 502, not 415
  mockFetch([[OPENAI, () => openaiErr(400, 'Invalid file format.')], [GEMINI, () => geminiOk()], [COUNT, () => reply(503, {})]]);
  rec = recorder();
  r = await handleTranscribe(sttReq(MP4), KEYS, rec.hooks);
  assert.equal(r.status, 502);
  assert.equal((await r.json()).code, 'transcribe_unavailable');
  assert.deepEqual(rec.reserves.map((j) => j.provider), ['openai', 'gemini'], 'Gemini’s ceiling is reserved before the count…');
  assert.deepEqual(rec.settles, [{ billed: false }, { billed: false }], '…and released at $0 when the count fails');
});

test('tester hooks: Gemini is reserved on a true ceiling: the WAV’s seconds, else the 3-minute cap that Gemini’s countTokens then checks', async () => {
  mockFetch([[OPENAI, () => openaiErr(500, 'x')], [GEMINI, () => geminiOk()], [COUNT, () => reply(200, { totalTokens: 1_234 })]]);
  // WAV: ceil(seconds) x 32 plus the instructions and the text part (a token is at least one byte); no count needed
  let rec = recorder();
  const prompt = encodeURIComponent('Ciprari');
  let r = await handleTranscribe(sttReq(wav(2.2), { 'x-dictate-lang': 'de-DE', 'x-dictate-prompt': prompt }), KEYS, rec.hooks);
  assert.equal(r.status, 200);
  const audio = validateAudio(wav(2.2), { lang: 'de-DE', prompt }).audio;
  const text = geminiTextTokens(audio);
  assert.ok(text > Buffer.byteLength(GEMINI_STT_PROMPT) + Buffer.byteLength('Ciprari') && text < 1_200, String(text));
  assert.deepEqual(rec.reserves.map((j) => [j.provider, j.inputTokens, j.fallback, j.seconds]), [['openai', null, false, 2.2], ['gemini', 3 * 32 + text, true, 2.2]]);
  assert.ok(!upstream.calls.some((c) => /countTokens/.test(c.url)));
  assert.deepEqual(rec.settles, [{ billed: false }, { usage: G_USAGE, seconds: 2.2 }]);
  // MP4 (no length in the header): reserved on the cap (180 s of audio, plus the text part and the overhead allowance the
  // count may hold, plus the instructions on top) before Gemini counts the contents, which must then fit under it
  rec = recorder();
  upstream.calls = [];
  r = await handleTranscribe(sttReq(MP4), KEYS, rec.hooks);
  assert.equal(r.status, 200);
  assert.deepEqual(upstream.calls.map((c) => c.url.split(/[/:]/).at(-1)), ['transcriptions', 'countTokens', 'generateContent']);
  const count = upstream.calls[1];
  assert.equal(count.headers.get('x-goog-api-key'), KEYS.GEMINI_API_KEY);
  assert.deepEqual(count.json, { contents: upstream.calls[2].json.contents }, 'the same contents that are then sent');
  const mp4 = validateAudio(MP4, {}).audio;
  assert.equal(rec.reserves[1].inputTokens, 180 * 32 + GEMINI_OVERHEAD_TOKENS + geminiTextTokens(mp4));
  assert.ok(rec.reserves[1].inputTokens >= 1_234 + Buffer.byteLength(GEMINI_STT_PROMPT) + GEMINI_OVERHEAD_TOKENS, 'a true ceiling for what was counted');
  assert.deepEqual(rec.settles, [{ billed: false }, { usage: G_USAGE, seconds: null }]);
  // the owner never counts (nothing is reserved)
  upstream.calls = [];
  await handleTranscribe(sttReq(MP4), KEYS);
  assert.ok(!upstream.calls.some((c) => /countTokens/.test(c.url)));
});

test('tester hooks: without a count there is no Gemini; a count past 3 minutes is too large; Gemini-only testers count too', async () => {
  let count = () => reply(500, {});
  mockFetch([[OPENAI, () => openaiErr(503, 'x')], [GEMINI, () => geminiOk()], [COUNT, () => count()]]);
  let rec = recorder();
  let r = await handleTranscribe(sttReq(WEBM), KEYS, rec.hooks);
  assert.equal(r.status, 502);
  assert.deepEqual(rec.reserves.map((j) => j.provider), ['openai', 'gemini']);
  assert.deepEqual(rec.settles, [{ billed: false }, { billed: false }], 'no count: Gemini’s reservation is released');
  assert.ok(!upstream.calls.some((c) => /generateContent/.test(c.url)));
  count = () => reply(200, { totalTokens: 'lots' });
  r = await handleTranscribe(sttReq(WEBM), KEYS, recorder().hooks);
  assert.equal(r.status, 502);
  // 180 s of audio is 5,760 tokens, plus the text part and the overhead allowance: past that is over the cap, and the
  // reservation made on that cap is released
  const ask = Buffer.byteLength('Transcribe this recording.');
  const cap = 180 * 32 + ask + GEMINI_OVERHEAD_TOKENS + Buffer.byteLength(GEMINI_STT_PROMPT) + GEMINI_OVERHEAD_TOKENS;
  count = () => reply(200, { totalTokens: 180 * 32 + ask + GEMINI_OVERHEAD_TOKENS + 1 });
  rec = recorder();
  r = await handleTranscribe(sttReq(WEBM), KEYS, rec.hooks);
  assert.equal(r.status, 413);
  assert.equal((await r.json()).code, 'too_large');
  assert.deepEqual(rec.reserves.map((j) => [j.provider, j.inputTokens]), [['openai', null], ['gemini', cap]]);
  assert.deepEqual(rec.settles, [{ billed: false }, { billed: false }]);
  count = () => reply(200, { totalTokens: 180 * 32 + ask + GEMINI_OVERHEAD_TOKENS });
  rec = recorder();
  r = await handleTranscribe(sttReq(WEBM), ONLY_GEMINI, rec.hooks);
  assert.equal(r.status, 200);
  assert.deepEqual(rec.reserves.map((j) => [j.provider, j.fallback, j.inputTokens]), [['gemini', false, cap]], 'exactly at the cap: one reservation, never raised');
  noLeaks();
});

test('tester hooks: on a Gemini-only server a tester is admitted before countTokens: a refusal sends nothing to Gemini', async () => {
  mockFetch([[GEMINI, () => geminiOk()], [COUNT, () => reply(200, { totalTokens: 400 })]]);
  const rec = recorder({ refuse: () => true }); // throttled, paused or out of allowance: the hook's refusal
  const r = await handleTranscribe(sttReq(MP4), ONLY_GEMINI, rec.hooks);
  assert.equal(r.status, 402);
  assert.equal((await r.json()).code, 'tester_budget');
  assert.deepEqual(rec.reserves.map((j) => [j.provider, j.fallback]), [['gemini', false]]);
  assert.equal(upstream.calls.length, 0, 'not even the free count: it would carry the whole recording');
  // the owner (no reservations) never counts either
  await handleTranscribe(sttReq(MP4), ONLY_GEMINI);
  assert.ok(!upstream.calls.some((c) => /countTokens/.test(c.url)));
});

// ── the owner route (worker.js) and the tester route (src/tester/router.js), once wired ──
const workerSrc = await readFile(new URL('../src/worker.js', import.meta.url), 'utf8');
const routerSrc = await readFile(new URL('../src/tester/router.js', import.meta.url), 'utf8');
const OWNER_ROUTE = /path === 'transcribe'/.test(workerSrc) ? false : 'src/worker.js has no /api/transcribe route yet (dictation-integration.md)';
const TESTER_ROUTE = /match: 'transcribe'/.test(routerSrc) ? false : 'src/tester/router.js has no transcribe route yet (dictation-integration.md)';
const P = await import('../src/tester/prices.js');
const STT_OPENAI = 'openai:gpt-4o-mini-transcribe-2025-12-15', STT_GEMINI = 'gemini:gemini-3.5-flash-lite#stt';
const audioPost = (body, headers = {}) => ({ method: 'POST', body, headers: { 'content-type': 'audio/mp4', ...headers } });
const spent = (L, sub) => L.ledger.allowance(sub).day;
const codeOf = async (r) => (await r.clone().json().catch(() => ({}))).code;
async function tester({ config = {}, env: extra = {} } = {}) {
  resetTesterCaches();
  const { env, L } = makeEnv(extra);
  const t = await signIn(L, PROFILE());
  if (Object.keys(config).length) L.ledger.setConfig(config);
  const call = async (body, headers, who = {}) => {
    const r = await api(env, 'transcribe', audioPost(body, headers), { cookie: t.token, ...who });
    if (r.status >= 400) assert.ok(!/passcode|OPENAI_API_KEY|GEMINI_API_KEY/i.test(await r.clone().text()), 'a tester error mentions the passcode or a secret');
    return r;
  };
  return { env, L, ...t, call };
}

test('POST /api/transcribe needs the passcode; the owner path never touches the Ledger', { skip: OWNER_ROUTE }, async () => {
  const { env, L } = makeEnv();
  mockFetch([[OPENAI, () => openaiOk()]]);
  let r = await api(env, 'transcribe', audioPost(MP4), { origin: null });
  assert.equal(r.status, 401);
  assert.match((await r.json()).error, /passcode/);
  r = await api(env, 'transcribe', audioPost(MP4), { pass: 'nope', origin: null });
  assert.equal(r.status, 401);
  assert.equal(upstream.calls.length, 0);
  r = await api(env, 'transcribe', audioPost(MP4, { 'x-dictate-lang': 'en-GB' }), { pass: 'pw', origin: null });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/json');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-tester-allowance'), null);
  assert.deepEqual(await r.json(), { text: 'Hello there.', provider: 'openai' });
  assert.equal(formOf(upstream.calls[0]).language, 'en');
  r = await api(env, 'transcribe', { method: 'GET' }, { pass: 'pw', origin: null });
  assert.equal(r.status, 404, 'only POST');
  assert.deepEqual(L.calls, []);
});

test('tester: invalid recordings reserve nothing and call no provider; another Origin is refused first', { skip: TESTER_ROUTE }, async () => {
  const { L, sub, call } = await tester();
  mockFetch([]);
  for (const [body, status] of [[new Uint8Array(0), 400], [MP4.subarray(0, 60), 422], [pad(ascii('{"text":"hi"}'), 300), 415], [wav(181, { rate: 8_000, bits: 8 }), 413], [new Uint8Array(TRANSCRIBE_LIMITS.maxBytes + 1), 413]]) {
    L.calls.length = 0;
    const r = await call(body);
    assert.equal(r.status, status, String(body.length));
    assert.ok(!L.calls.includes('reserve'));
  }
  for (const origin of [null, 'https://evil.example']) {
    const r = await call(MP4, {}, { origin });
    assert.equal(r.status, 403);
    assert.equal(await codeOf(r), 'tester_origin');
  }
  assert.equal(upstream.calls.length, 0);
  assert.deepEqual(spent(L, sub), { spent: 0, reserved: 0, limit: 1_000_000 });
});

test('tester: reserves the OpenAI worst case (its context window), settles from usage; the header shows the settled cost', { skip: TESTER_ROUTE }, async () => {
  const { L, sub, call } = await tester();
  mockFetch([[OPENAI, () => openaiOk()]]);
  const r = await call(MP4, { 'x-dictate-lang': 'en-US' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { text: 'Hello there.', provider: 'openai' });
  assert.equal(P.sttWorstCase({ model: STT_OPENAI }), 37_500);
  const actual = P.sttActual({ model: STT_OPENAI, usage: OAI_USAGE });
  assert.ok(actual > 0 && actual < 37_500);
  assert.equal(allowanceOf(r).dayLeft, 1_000_000 - actual);
  assert.deepEqual(spent(L, sub), { spent: actual, reserved: 0, limit: 1_000_000 });
  assert.deepEqual(formOf(upstream.calls[0]), { model: 'gpt-4o-mini-transcribe-2025-12-15', response_format: 'json', language: 'en', prompt: null, name: 'dictation.mp4', type: 'audio/mp4' });
  // no usage reported: the full reservation stands
  mockFetch([[OPENAI, () => openaiOk('Hi.', null)]]);
  await (await call(MP4)).json();
  assert.equal(spent(L, sub).spent, actual + 37_500);
});

test('tester: a provider refusal settles at $0 and never passes the provider’s error through', { skip: TESTER_ROUTE }, async () => {
  const { L, sub, call } = await tester({ env: { GEMINI_API_KEY: undefined } });
  let status = 401;
  mockFetch([[OPENAI, () => openaiErr(status, LEAK, { 'retry-after': '3', 'x-request-id': 'req_1' })]]);
  let r = await call(WEBM);
  assert.equal(r.status, 502);
  const text = await r.text();
  assert.equal(JSON.parse(text).code, 'transcribe_unavailable');
  assert.ok(!/sk-|wxyz|AbCdEf/.test(text));
  assert.equal(r.headers.get('x-request-id'), null);
  status = 429;
  r = await call(WEBM);
  assert.equal(r.status, 429);
  assert.equal(await codeOf(r), 'transcribe_busy');
  assert.equal(r.headers.get('retry-after'), '3');
  assert.deepEqual(spent(L, sub), { spent: 0, reserved: 0, limit: 1_000_000 });
});

test('tester: OpenAI down → Gemini counts, reserves its own ceiling and settles from usageMetadata', { skip: TESTER_ROUTE }, async () => {
  const { L, sub, call } = await tester();
  mockFetch([[OPENAI, () => openaiErr(503, 'x')], [COUNT, () => reply(200, { totalTokens: 2_000 })], [GEMINI, () => geminiOk()]]);
  L.calls.length = 0;
  const r = await call(MP4);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { text: 'Hola, ¿qué tal?', provider: 'gemini' });
  assert.equal(L.calls.filter((m) => m === 'reserve').length, 2);
  const actual = P.sttActual({ model: STT_GEMINI, usage: G_USAGE });
  assert.equal(actual, Math.ceil(230 * 0.3 + 49 * 2.5));
  assert.deepEqual(spent(L, sub), { spent: actual, reserved: 0, limit: 1_000_000 }, 'OpenAI’s refusal cost nothing');
  assert.equal(allowanceOf(r).dayLeft, 1_000_000 - actual);
  // without a count, a tester's MP4 never reaches Gemini
  mockFetch([[OPENAI, () => openaiErr(503, 'x')], [COUNT, () => reply(500, {})], [GEMINI, () => geminiOk()]]);
  const r2 = await call(MP4);
  assert.equal(r2.status, 502);
  assert.ok(!upstream.calls.some((c) => /generateContent/.test(c.url)));
});

test('tester: a refused reservation is 402 tester_budget; no key is 503 transcribe_unavailable; neither calls a provider', { skip: TESTER_ROUTE }, async () => {
  const { call } = await tester({ config: { day_limit: 1_000 } });
  mockFetch([]);
  const r = await call(MP4);
  assert.equal(r.status, 402);
  const j = await r.json();
  assert.equal(j.code, 'tester_budget');
  assert.equal(j.scope, 'day');
  // $0.03 left: dictation's reservation is fixed, so "a lighter model, a shorter clip" would be wrong advice
  const low = await tester({ config: { day_limit: 30_000 } });
  const r3 = await low.call(MP4);
  assert.equal(r3.status, 402);
  const j3 = await r3.json();
  assert.deepEqual([j3.code, j3.scope, j3.error], ['tester_budget', 'day', 'Dictation needs about $0.04 of the allowance free, and $0.03 is left today. It resets at midnight UTC.']);
  const t = await tester({ env: { OPENAI_API_KEY: undefined, GEMINI_API_KEY: undefined } });
  t.L.calls.length = 0;
  const r2 = await t.call(MP4);
  assert.equal(r2.status, 503);
  assert.deepEqual(await r2.json(), { error: 'Dictation isn’t available to testers right now.', code: 'transcribe_unavailable' });
  assert.ok(!t.L.calls.includes('reserve'));
  assert.equal(upstream.calls.length, 0);
});

test('tester: a per-tester rate limit (LI_LIMIT, stt:<sub>) answers 429 before anything is reserved, once per request', { skip: TESTER_ROUTE }, async () => {
  const { env, L, sub, call } = await tester();
  const keys = [];
  env.LI_LIMIT = { async limit({ key }) { keys.push(key); return { success: keys.length <= 2 }; } };
  mockFetch([[OPENAI, () => openaiErr(503, 'x')], [GEMINI, () => geminiOk()]]);
  assert.equal((await call(wav(1))).status, 200, 'OpenAI down, Gemini answers: one limiter check for both');
  assert.equal((await call(wav(1))).status, 200);
  assert.deepEqual(keys, [`stt:${sub}`, `stt:${sub}`]);
  L.calls.length = 0;
  const r = await call(wav(1));
  assert.equal(r.status, 429);
  assert.equal(await codeOf(r), 'transcribe_busy');
  assert.equal(r.headers.get('retry-after'), '30');
  assert.ok(!L.calls.includes('reserve'));
  env.LI_LIMIT = { async limit() { throw new Error('down'); } };
  assert.equal((await call(wav(1))).status, 200, 'a limiter that fails never blocks dictation');
});

test('tester: on a Gemini-only server the rate limit and the allowance come before Gemini’s countTokens', { skip: TESTER_ROUTE }, async () => {
  const routes = () => [[COUNT, () => reply(200, { totalTokens: 2_000 })], [GEMINI, () => geminiOk()]];
  const { env, L, sub, call } = await tester({ env: { OPENAI_API_KEY: undefined } });
  env.LI_LIMIT = { async limit() { return { success: false }; } };
  mockFetch(routes());
  L.calls.length = 0;
  const r = await call(MP4);
  assert.equal(r.status, 429);
  assert.equal(await codeOf(r), 'transcribe_busy');
  assert.equal(upstream.calls.length, 0, 'a throttled tester never makes the Worker upload the recording to count it');
  assert.ok(!L.calls.includes('reserve'));
  // out of allowance: 402, and still nothing sent
  const low = await tester({ env: { OPENAI_API_KEY: undefined }, config: { day_limit: 1_000 } });
  mockFetch(routes());
  const r2 = await low.call(MP4);
  assert.equal(r2.status, 402);
  assert.equal(await codeOf(r2), 'tester_budget');
  assert.equal(upstream.calls.length, 0);
  // admitted: one reservation (on the cap), then the count, then the transcript, settled from usageMetadata
  env.LI_LIMIT = { async limit() { return { success: true }; } };
  mockFetch(routes());
  L.calls.length = 0;
  const r3 = await call(MP4);
  assert.equal(r3.status, 200);
  assert.deepEqual(upstream.calls.map((c) => c.url.split(/[/:]/).at(-1)), ['countTokens', 'generateContent']);
  assert.equal(L.calls.filter((m) => m === 'reserve').length, 1);
  assert.deepEqual(spent(L, sub), { spent: P.sttActual({ model: STT_GEMINI, usage: G_USAGE }), reserved: 0, limit: 1_000_000 });
});

test('tester/me: features.dictation follows the provider keys', { skip: TESTER_ROUTE }, async () => {
  for (const [missing, on] of [[{}, true], [{ OPENAI_API_KEY: undefined }, true], [{ GEMINI_API_KEY: undefined }, true], [{ OPENAI_API_KEY: undefined, GEMINI_API_KEY: undefined }, false]]) {
    const t = await tester({ env: missing });
    const j = await (await api(t.env, 'tester/me', {}, { cookie: t.token })).json();
    assert.equal(j.features.dictation, on, JSON.stringify(missing));
  }
});

test('the 413 text names the limit the server enforces: 10 MB for every container; 3 minutes only where the length is measured (a WAV, a tester’s Gemini count)', async () => {
  // validateAudio: the byte cap and the WAV header are the only checks before a provider; a WebM of unknown length passes.
  const big = validateAudio(new Uint8Array(TRANSCRIBE_LIMITS.maxBytes + 1));
  assert.equal(big.error, 'Dictation takes recordings of up to 10 MB.');
  assert.doesNotMatch(big.error, /minute/);
  assert.equal(validateAudio(wav(181, { rate: 8_000, bits: 8 })).error, 'Dictation takes up to 3 minutes at a time.');
  assert.equal(validateAudio(WEBM).audio.seconds, null, 'no length is measured for a WebM');
  mockFetch([]);
  // A declared or streamed body over the cap (any container) is refused on its bytes, never on a length nobody measured.
  let r = await handleTranscribe(sttReq(new Uint8Array(TRANSCRIBE_LIMITS.maxBytes + 1)), KEYS);
  assert.equal(r.status, 413);
  assert.equal((await r.json()).error, 'Dictation takes recordings of up to 10 MB.');
  // OpenAI refusing the file (its own size limit): no claim about minutes.
  mockFetch([[OPENAI, () => openaiErr(413, 'Maximum content size limit exceeded.')]]);
  r = await handleTranscribe(sttReq(WEBM), ONLY_OPENAI);
  assert.equal(r.status, 413);
  assert.equal((await r.json()).error, 'That recording is too large to transcribe.');
  // A tester’s Gemini fallback counts the audio: past 180 s is the 3-minute cap, measured.
  const ask = Buffer.byteLength('Transcribe this recording.');
  mockFetch([[OPENAI, () => openaiErr(503, 'x')], [GEMINI, () => geminiOk()], [COUNT, () => reply(200, { totalTokens: 180 * 32 + ask + GEMINI_OVERHEAD_TOKENS + 1 })]]);
  r = await handleTranscribe(sttReq(WEBM), KEYS, recorder().hooks);
  assert.equal(r.status, 413);
  assert.equal((await r.json()).error, 'Dictation takes up to 3 minutes at a time.');
});
