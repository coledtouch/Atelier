import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, mockFetch, restoreFetch, upstream, reply, api } from './tester-env.mjs';

const {
  handleTts, validateTts, sseToAudio, toWav, wavHeader, previewCacheKey, openaiSpeechBody, geminiSpeechBody, spokenUnits, previewId,
  TTS_BRIEF, TTS_BRIEF_V, PREVIEW_TEXT, PREVIEW_ID, TTS_VOICES, TTS_VOICE_IDS, TTS_LIMITS, OWNER_HOOKS, ttsPriceId, GEMINI_MAX_OUTPUT_TOKENS,
} = await import('../src/tts.js');
const { GEMINI_BASE } = await import('../src/gemini.js');

const ORIGIN = 'https://atelier.ciprari.ai';
const OPENAI = /^POST https:\/\/api\.openai\.com\/v1\/audio\/speech$/;
const GEMINI = /^POST https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-3\.8-flash-lite-tts:generateContent$/;
const KEYS = { OPENAI_API_KEY: 'sk-openai-test', GEMINI_API_KEY: 'AQ.test-gemini-key-0123456789abcdef' };
const enc = new TextEncoder();
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const MP3 = Uint8Array.from({ length: 5_000 }, (_, i) => (i * 7) % 256);
const delta = (bytes) => `data: ${JSON.stringify({ type: 'speech.audio.delta', audio: b64(bytes) })}\n\n`;
const done = (usage = { input_tokens: 150, output_tokens: 900, total_tokens: 1_050 }) => `data: ${JSON.stringify({ type: 'speech.audio.done', ...(usage ? { usage } : {}) })}\n\n`;
const sseText = (bytes = MP3, usage) => [delta(bytes.subarray(0, 2_000)), delta(bytes.subarray(2_000)), done(usage)].join('');
const streamOf = (parts) => new ReadableStream({ start(c) { for (const p of parts) c.enqueue(typeof p === 'string' ? enc.encode(p) : p); c.close(); } });
const speech = (text = sseText(), headers = {}) => new Response(streamOf([text]), { headers: { 'content-type': 'text/event-stream', ...headers } });
const ttsReq = (body, headers = {}) => new Request(`${ORIGIN}/api/tts`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
const bytesOf = async (res) => new Uint8Array(await res.arrayBuffer());
const collect = async (stream) => new Uint8Array(await new Response(stream).arrayBuffer());

// console capture: nothing logged may hold a key fragment or the text being read
let logs = [];
const saved = { log: console.log, warn: console.warn, error: console.error };
beforeEach(() => {
  logs = [];
  for (const k of Object.keys(saved)) console[k] = (...a) => logs.push(a.map(String).join(' '));
});
afterEach(() => {
  Object.assign(console, saved);
  restoreFetch();
  delete globalThis.caches;
});

// A Cache API stand-in for caches.default.
function fakeCache() {
  const store = new Map(), puts = [];
  return {
    store, puts,
    async match(key) { const v = store.get(String(key)); return v ? new Response(v.bytes, { headers: v.headers }) : undefined; },
    async put(key, res) { puts.push(String(key)); store.set(String(key), { bytes: new Uint8Array(await res.arrayBuffer()), headers: Object.fromEntries(res.headers) }); },
  };
}

// ── the allow-list and the brief ──
test('voices are a frozen server allow-list; the default is OpenAI marin on the pinned snapshot', () => {
  assert.deepEqual([...TTS_VOICE_IDS], ['atelier', 'cedar', 'sage', 'sulafat']);
  assert.deepEqual({ ...TTS_VOICES.atelier }, { provider: 'openai', model: 'gpt-4o-mini-tts-2025-12-15', voice: 'marin' });
  assert.equal(TTS_VOICES.cedar.voice, 'cedar');
  assert.equal(TTS_VOICES.sage.voice, 'sage');
  assert.equal(TTS_VOICES.sulafat.provider, 'gemini');
  assert.equal(TTS_VOICES.sulafat.voice, 'Sulafat');
  assert.ok(Object.isFrozen(TTS_VOICES) && Object.isFrozen(TTS_VOICES.atelier) && Object.isFrozen(TTS_LIMITS));
  assert.throws(() => { TTS_VOICES.atelier.voice = 'alloy'; }, TypeError);
  assert.equal(ttsPriceId(TTS_VOICES.atelier), 'openai:gpt-4o-mini-tts-2025-12-15');
  assert.equal(ttsPriceId(TTS_VOICES.sulafat), 'gemini:gemini-3.8-flash-lite-tts');
  assert.equal(TTS_BRIEF_V, 1);
  assert.match(TTS_BRIEF, /^Voice: warm, soft and close/);
  assert.match(TTS_BRIEF, /never salesy, theatrical or announcer-like/);
  assert.ok(PREVIEW_TEXT.startsWith('Hello, I’m the voice of Atelier.'));
  assert.deepEqual({ ...TTS_LIMITS }, { bodyBytes: 16_384, ownerChars: 4_000, testerChars: 1_000, maxAudioBytes: 8 * 1024 * 1024, timeoutMs: 30_000 });
  // Gemini's output is bounded at the source: as many audio tokens (25 a second) as fit in maxAudioBytes of 24 kHz s16 PCM.
  assert.equal(GEMINI_MAX_OUTPUT_TOKENS, 4_369);
  assert.ok(GEMINI_MAX_OUTPUT_TOKENS / 25 * 48_000 <= TTS_LIMITS.maxAudioBytes);
  assert.equal(TTS_VOICES.sulafat.maxOutputTokens, GEMINI_MAX_OUTPUT_TOKENS);
  assert.equal(geminiSpeechBody(TTS_VOICES.sulafat, 'x').generationConfig.maxOutputTokens, GEMINI_MAX_OUTPUT_TOKENS);
  // The preview line is part of its cache key.
  assert.match(PREVIEW_ID, /^[0-9a-f]{8}$/);
  assert.equal(PREVIEW_ID, previewId(PREVIEW_TEXT));
  assert.notEqual(previewId(PREVIEW_TEXT.replace('calmly', 'gently')), PREVIEW_ID);
});

test('spokenUnits: a character each, more for digits, symbols read as words and CJK characters', () => {
  assert.equal(spokenUnits('Hello there.'), 12);
  assert.equal(spokenUnits('987'), 12);
  assert.equal(spokenUnits('50% & $5'), 8 + 3 * 3 + 3 * 2); // 3 digits, 3 symbols
  assert.equal(spokenUnits('你好。'), 3 + 2 * 2);
  assert.equal(spokenUnits('カタカナとひらがな'), 9 * 3);
  assert.equal(spokenUnits('한국어'), 9);
  assert.equal(spokenUnits(''), 0);
  assert.equal(spokenUnits(null), 0);
});

// ── validation: before any reserve or upstream call ──
test('validateTts: voice ids are an allow-list, text must be a non-empty string within the cap, extra fields are ignored', () => {
  const ok = validateTts({ voice: 'atelier', text: '  Hello\u0007 there.\n', instructions: 'shout', model: 'tts-1', speed: 4 });
  assert.deepEqual({ ...ok, voice: ok.voice.voice }, { ok: true, voiceId: 'atelier', voice: 'marin', text: 'Hello there.', units: 12, preview: false });
  const prev = validateTts({ voice: 'sage', preview: true, text: 'ignored' });
  assert.equal(prev.text, PREVIEW_TEXT);
  assert.equal(prev.preview, true);
  for (const body of [null, [], 'x', 5, { voice: 'atelier' }, { voice: 'atelier', text: 5 }, { voice: 'atelier', text: ['a'] }, { voice: 'atelier', text: ' \n\t ' },
    { text: 'hi' }, { voice: 'device', text: 'hi' }, { voice: 'Atelier', text: 'hi' }, { voice: 'constructor', text: 'hi' }, { voice: '__proto__', text: 'hi' },
    { voice: 'toString', text: 'hi' }, { voice: 'marin', text: 'hi' }, { voice: 'atelier', preview: 'yes' }]) {
    const v = validateTts(body);
    assert.equal(v.ok, false, JSON.stringify(body));
    assert.equal(v.status, 400, JSON.stringify(body));
    assert.equal(v.code, 'bad_request');
  }
  assert.equal(validateTts({ voice: 'atelier', text: 'x'.repeat(4_000) }).ok, true);
  assert.deepEqual(validateTts({ voice: 'atelier', text: 'x'.repeat(4_001) }).status, 413);
  assert.equal(validateTts({ voice: 'atelier', text: 'x'.repeat(1_000) }, { tester: true }).ok, true);
  const big = validateTts({ voice: 'atelier', text: 'x'.repeat(1_001) }, { tester: true });
  assert.deepEqual([big.status, big.code], [413, 'too_large']);
  // A tester's cap counts spoken units: numbers and CJK text take longer to say than their length suggests.
  assert.equal(validateTts({ voice: 'atelier', text: '7'.repeat(250) }, { tester: true }).ok, true);
  assert.equal(validateTts({ voice: 'atelier', text: '7'.repeat(251) }, { tester: true }).status, 413);
  assert.equal(validateTts({ voice: 'sulafat', text: '好'.repeat(333) }, { tester: true }).units, 999);
  assert.equal(validateTts({ voice: 'sulafat', text: '好'.repeat(334) }, { tester: true }).status, 413);
  assert.equal(validateTts({ voice: 'atelier', text: '7'.repeat(4_000) }).ok, true, 'the owner’s cap is OpenAI’s, in characters');
  // Gemini reads <...> as a sound cue: the brackets go (and a text of only brackets is empty)
  assert.equal(validateTts({ voice: 'sulafat', text: 'Take a breath <sigh> and go.' }).text, 'Take a breath sigh and go.');
  assert.equal(validateTts({ voice: 'sulafat', text: '<>' }).ok, false);
  assert.equal(validateTts({ voice: 'atelier', text: 'a < b > c' }).text, 'a < b > c', 'OpenAI text keeps its brackets');
});

test('bad requests answer 400 / 413 with no upstream call (owner and tester caps)', async () => {
  mockFetch([]);
  const reserves = [];
  const testerHooks = { tester: true, unavailable: () => new Response('', { status: 401 }), reserve: async (j) => { reserves.push(j); return { res: new Response('', { status: 402 }) }; } };
  const cases = [
    ['', 400], ['not json', 400], ['[]', 400], ['null', 400], [{ voice: 'atelier' }, 400], [{ voice: 'atelier', text: 7 }, 400], [{ voice: 'atelier', text: '   ' }, 400],
    [{ voice: 'alloy', text: 'hi' }, 400], [{ voice: 'device', text: 'hi' }, 400], [{ voice: 'atelier', text: 'x'.repeat(4_001) }, 413],
    [{ voice: 'atelier', text: 'x'.repeat(17_000) }, 413], // over the 16 KB body cap
  ];
  for (const [body, status] of cases) {
    const r = await handleTts(ttsReq(body), KEYS);
    assert.equal(r.status, status, JSON.stringify(body).slice(0, 60));
    const j = await r.json();
    assert.equal(j.code, status === 413 ? 'too_large' : 'bad_request');
    assert.equal(typeof j.error, 'string');
  }
  // a declared body over the cap is refused before it is read
  let r = await handleTts(ttsReq({ voice: 'atelier', text: 'hi' }, { 'content-length': String(TTS_LIMITS.bodyBytes + 1) }), KEYS);
  assert.equal(r.status, 413);
  // testers: 1,000 characters; nothing reserved for a refused body
  r = await handleTts(ttsReq({ voice: 'atelier', text: 'x'.repeat(1_001) }), KEYS, testerHooks);
  assert.equal(r.status, 413);
  r = await handleTts(ttsReq('{"voice":"atelier"'), KEYS, testerHooks);
  assert.equal(r.status, 400);
  assert.equal(reserves.length, 0);
  assert.equal(upstream.calls.length, 0);
  // a valid tester body reaches reserve (and its refusal is returned as is)
  r = await handleTts(ttsReq({ voice: 'atelier', text: 'x'.repeat(1_000) }), KEYS, testerHooks);
  assert.equal(r.status, 402);
  assert.deepEqual(reserves.map((j) => [j.voiceId, j.chars, j.units, j.preview]), [['atelier', 1_000, 1_000, false]]);
  assert.equal(upstream.calls.length, 0);
});

// ── OpenAI ──
test('OpenAI: the upstream body is rebuilt from server constants; mp3 streams back with our own headers only', async () => {
  mockFetch([[OPENAI, () => speech(sseText(), { 'x-request-id': 'req_123', 'openai-organization': 'org-secret', 'set-cookie': 'a=b', 'openai-processing-ms': '42' })]]);
  const r = await handleTts(ttsReq({ voice: 'atelier', text: 'Hello there.', instructions: 'Speak like a pirate', model: 'tts-1', voice_id: 'alloy', speed: 4, response_format: 'wav', stream_format: 'audio', input: 'evil' }), KEYS);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.fromEntries(r.headers), { 'cache-control': 'no-store', 'content-type': 'audio/mpeg', 'x-tts-brief': '1', 'x-tts-voice': 'atelier' });
  assert.deepEqual(await bytesOf(r), MP3);
  assert.equal(upstream.calls.length, 1);
  const call = upstream.calls[0];
  assert.equal(call.headers.get('authorization'), 'Bearer sk-openai-test');
  assert.equal(call.headers.get('accept'), 'text/event-stream');
  assert.deepEqual(call.json, { model: 'gpt-4o-mini-tts-2025-12-15', voice: 'marin', input: 'Hello there.', instructions: TTS_BRIEF, response_format: 'mp3', stream_format: 'sse' });
  assert.deepEqual(openaiSpeechBody(TTS_VOICES.atelier, 'Hello there.'), call.json);
  for (const [id, voice] of [['cedar', 'cedar'], ['sage', 'sage']]) {
    const res = await handleTts(ttsReq({ voice: id, text: 'Hi.' }), KEYS);
    assert.equal(res.headers.get('x-tts-voice'), id);
    await res.arrayBuffer();
    assert.equal(upstream.calls.at(-1).json.voice, voice);
    assert.equal(upstream.calls.at(-1).json.model, 'gpt-4o-mini-tts-2025-12-15');
  }
  // the owner log carries token counts, never the text
  assert.ok(logs.some((l) => /tts atelier tokens in 150 out 900/.test(l)), logs.join('\n'));
  assert.ok(!logs.some((l) => /Hello there/.test(l)));
});

test('OpenAI: plain audio (no SSE) still plays, under the same byte cap', async () => {
  mockFetch([[OPENAI, () => new Response(streamOf([MP3]), { headers: { 'content-type': 'audio/mpeg' } })]]);
  const r = await handleTts(ttsReq({ voice: 'atelier', text: 'Hi.' }), KEYS);
  assert.equal(r.status, 200);
  assert.deepEqual(await bytesOf(r), MP3);
});

// ── sseToAudio ──
test('sseToAudio: exact bytes across any chunk split, LF or CRLF; stops at speech.audio.done', async () => {
  const a = Uint8Array.from({ length: 777 }, (_, i) => i % 256), b = Uint8Array.from({ length: 333 }, (_, i) => 255 - (i % 256));
  const after = Uint8Array.of(9, 9, 9);
  for (const eol of ['\n', '\r\n']) {
    const text = [`event: speech.audio.delta`, `data: ${JSON.stringify({ type: 'speech.audio.delta', audio: b64(a) })}`, '',
      `data: ${JSON.stringify({ type: 'speech.audio.delta', audio: b64(b) })}`, '', ': keep-alive', '',
      `data: ${JSON.stringify({ type: 'speech.audio.done', usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } })}`, '',
      `data: ${JSON.stringify({ type: 'speech.audio.delta', audio: b64(after) })}`, '', 'data: [DONE]', ''].join(eol);
    const all = enc.encode(text);
    const want = new Uint8Array([...a, ...b]);
    // every two-way split, then a byte-by-byte feed
    for (let cut = 0; cut <= all.length; cut += 37) {
      const out = await collect(streamOf([all.subarray(0, cut), all.subarray(cut)]).pipeThrough(sseToAudio(10_000)));
      assert.deepEqual(out, want, `${JSON.stringify(eol)} cut at ${cut}`);
    }
    const bytewise = await collect(streamOf([...all].map((x) => Uint8Array.of(x))).pipeThrough(sseToAudio(10_000)));
    assert.deepEqual(bytewise, want);
  }
  // no trailing newline on the last event is fine
  const last = await collect(streamOf([`data: ${JSON.stringify({ type: 'speech.audio.delta', audio: b64(a) })}`]).pipeThrough(sseToAudio(10_000)));
  assert.deepEqual(last, a);
});

test('sseToAudio: errors past maxBytes, on an error event, on bad base64 and when no audio came', async () => {
  const chunk = new Uint8Array(600);
  await assert.rejects(collect(streamOf([delta(chunk), delta(chunk)]).pipeThrough(sseToAudio(1_000))), /longer than one read-aloud request/);
  assert.deepEqual(await collect(streamOf([delta(chunk), delta(chunk)]).pipeThrough(sseToAudio(1_200))), new Uint8Array(1_200), 'exactly at the cap is fine');
  await assert.rejects(collect(streamOf([delta(chunk), `data: ${JSON.stringify({ type: 'error', error: { message: 'boom sk-proj-SECRET123' } })}\n\n`]).pipeThrough(sseToAudio())), (e) => /provider error event/.test(e.message) && !/SECRET123/.test(e.message));
  await assert.rejects(collect(streamOf([`data: {"type":"speech.audio.delta","audio":"%%%not-base64%%%"}\n\n`]).pipeThrough(sseToAudio())), /undecodable audio/);
  await assert.rejects(collect(streamOf([done()]).pipeThrough(sseToAudio())), /no audio/);
  await assert.rejects(collect(streamOf(['x'.repeat(2_500)]).pipeThrough(sseToAudio(1_000))), /oversized event/);
});

// ── errors are mapped, never passed through ──
test('an upstream 401 quoting the key becomes a generic 502; nothing upstream reaches the client or the log', async () => {
  const leak = 'Incorrect API key provided: sk-proj-AbCdEf123456********************wxyz. You can find your API key at https://platform.openai.com/account/api-keys.';
  mockFetch([[OPENAI, () => reply(401, { error: { message: leak, type: 'invalid_request_error', code: 'invalid_api_key' } }, { 'x-request-id': 'req_9', 'set-cookie': 'z=1', 'openai-organization': 'org-x' })]]);
  const r = await handleTts(ttsReq({ voice: 'atelier', text: 'Private sentence to read.' }), KEYS);
  assert.equal(r.status, 502);
  const text = await r.text();
  assert.deepEqual(JSON.parse(text), { error: 'Read aloud is unavailable right now.', code: 'tts_unavailable' });
  assert.ok(!/sk-|wxyz|AbCdEf|invalid_api_key/.test(text));
  assert.deepEqual([...r.headers.keys()].sort(), ['cache-control', 'content-type']);
  const logged = logs.join('\n');
  assert.match(logged, /tts upstream 401 openai atelier/);
  assert.ok(!/AbCdEf|wxyz|\*\*\*\*/.test(logged), logged);
  assert.ok(!/Private sentence/.test(logged), 'the text is never logged');
});

test('upstream 429 keeps retry-after; other failures and network errors are 502 tts_unavailable', async () => {
  let mode = '429';
  mockFetch([[OPENAI, () => {
    if (mode === '429') return reply(429, { error: { message: 'Rate limit' } }, { 'retry-after': '7', 'x-ratelimit-remaining-requests': '0' });
    if (mode === 'bad-retry') return reply(429, {}, { 'retry-after': 'soonÿx<script>' });
    if (mode === '500') return reply(500, 'oops');
    if (mode === '302') return new Response('', { status: 302, headers: { location: 'https://evil.example/' } });
    throw new TypeError('fetch failed');
  }]]);
  let r = await handleTts(ttsReq({ voice: 'atelier', text: 'Hi.' }), KEYS);
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('retry-after'), '7');
  assert.equal(r.headers.get('x-ratelimit-remaining-requests'), null);
  assert.equal((await r.json()).code, 'tts_busy');
  mode = 'bad-retry';
  r = await handleTts(ttsReq({ voice: 'atelier', text: 'Hi.' }), KEYS);
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('retry-after'), null, 'an odd retry-after is dropped');
  for (mode of ['500', '302', 'throw']) {
    r = await handleTts(ttsReq({ voice: 'atelier', text: 'Hi.' }), KEYS);
    assert.equal(r.status, 502, mode);
    assert.deepEqual(await r.json(), { error: 'Read aloud is unavailable right now.', code: 'tts_unavailable' });
  }
});

test('a provider error mid-stream breaks the response body (the client falls back to the device voice)', async () => {
  mockFetch([[OPENAI, () => speech(delta(MP3.subarray(0, 100)) + `data: ${JSON.stringify({ type: 'error', error: { message: 'server_error' } })}\n\n`)]]);
  const r = await handleTts(ttsReq({ voice: 'atelier', text: 'Hi.' }), KEYS);
  assert.equal(r.status, 200);
  await assert.rejects(r.arrayBuffer());
});

test('owner: no key for the voice’s provider → 503 tts_unavailable naming the secret', async () => {
  mockFetch([]);
  let r = await handleTts(ttsReq({ voice: 'atelier', text: 'Hi.' }), { GEMINI_API_KEY: 'g' });
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { error: 'Read aloud needs OPENAI_API_KEY on the server.', code: 'tts_unavailable' });
  r = await handleTts(ttsReq({ voice: 'sulafat', text: 'Hi.' }), { OPENAI_API_KEY: 'k' });
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /GEMINI_API_KEY/);
  assert.equal(upstream.calls.length, 0);
});

// ── Gemini ──
test('Gemini (Sulafat): style and voice in the request, brackets stripped, headerless PCM wrapped as WAV', async () => {
  const pcm = Uint8Array.from({ length: 48_000 }, (_, i) => i % 256); // 1 s at 24 kHz s16le mono
  mockFetch([[GEMINI, () => reply(200, {
    candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: b64(pcm) } }] } }],
    usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 25, totalTokenCount: 45 },
  }, { 'x-goog-request-id': 'g1' })]]);
  const r = await handleTts(ttsReq({ voice: 'sulafat', text: 'Breathe <sigh> slowly.', style: 'shouting' }), KEYS);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'audio/wav');
  assert.equal(r.headers.get('x-tts-voice'), 'sulafat');
  assert.equal(r.headers.get('x-goog-request-id'), null);
  const wav = await bytesOf(r);
  assert.equal(wav.length, 48_044);
  const dv = new DataView(wav.buffer);
  assert.equal(new TextDecoder().decode(wav.subarray(0, 4)), 'RIFF');
  assert.equal(new TextDecoder().decode(wav.subarray(8, 16)), 'WAVEfmt ');
  assert.deepEqual([dv.getUint32(4, true), dv.getUint16(20, true), dv.getUint16(22, true), dv.getUint32(24, true), dv.getUint32(28, true), dv.getUint16(32, true), dv.getUint16(34, true)], [36 + 48_000, 1, 1, 24_000, 48_000, 2, 16]);
  assert.equal(new TextDecoder().decode(wav.subarray(36, 40)), 'data');
  assert.equal(dv.getUint32(40, true), 48_000);
  assert.deepEqual(wav.subarray(44), pcm);
  const call = upstream.calls[0];
  assert.equal(call.headers.get('x-goog-api-key'), KEYS.GEMINI_API_KEY);
  assert.equal(call.headers.get('authorization'), null);
  assert.deepEqual(call.json, {
    contents: [{ role: 'user', parts: [{ text: 'Breathe sigh slowly.', speech_metadata: { style: TTS_VOICES.sulafat.style } }] }],
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { voice: 'Sulafat' } }, maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS },
  });
  assert.ok(logs.some((l) => /tts sulafat tokens in 20 out 25 seconds 1/.test(l)), logs.join('\n'));
});

test('toWav: seconds from the PCM length and rate; a RIFF answer passes through unchanged', () => {
  const pcm = new Uint8Array(96_001); // odd length: the stray byte is dropped
  const a = toWav(pcm, 'audio/L16;rate=24000');
  assert.equal(a.seconds, 2);
  assert.equal(a.wav.length, 44 + 96_000);
  const b = toWav(new Uint8Array(32_000), 'audio/pcm;rate=16000');
  assert.equal(b.seconds, 1);
  assert.equal(new DataView(b.wav.buffer).getUint32(24, true), 16_000);
  assert.equal(toWav(new Uint8Array(48_000), 'audio/L16;rate=999999').seconds, 1, 'an implausible rate falls back to 24 kHz');
  const riff = new Uint8Array(44 + 24_000);
  riff.set(wavHeader(24_000, 24_000), 0);
  const c = toWav(riff, 'audio/wav');
  assert.equal(c.wav, riff);
  assert.equal(c.seconds, 0.5);
});

test('Gemini: an answer without audio, or an error, is a 502 that never echoes the provider', async () => {
  let body = { candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }], usageMetadata: { promptTokenCount: 9 } };
  let status = 200;
  mockFetch([[GEMINI, () => reply(status, body)]]);
  let r = await handleTts(ttsReq({ voice: 'sulafat', text: 'Hi.' }), KEYS);
  assert.equal(r.status, 502);
  status = 400; body = { error: { message: 'API key not valid: AQ.test-gemini-key-0123456789abcdef', status: 'INVALID_ARGUMENT' } };
  r = await handleTts(ttsReq({ voice: 'sulafat', text: 'Hi.' }), KEYS);
  assert.equal(r.status, 502);
  assert.ok(!/AQ\.|INVALID/.test(await r.text()));
  assert.ok(!logs.join('\n').includes('0123456789abcdef'), 'the key is redacted from the log');
  status = 200; body = 'not json';
  r = await handleTts(ttsReq({ voice: 'sulafat', text: 'Hi.' }), KEYS);
  assert.equal(r.status, 502);
});

test('Gemini: audio longer than one request allows was made and billed, so it is settled at its length, not the reservation', async () => {
  const settles = [];
  const hooks = { tester: true, reserve: async () => ({ headers: {}, settle: async (r) => { settles.push(r); return null; } }) };
  const answer = (pcmBytes, extra = {}) => JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: Buffer.alloc(pcmBytes).toString('base64') } }] } }], ...extra });
  // Decoded audio just past maxAudioBytes (the JSON still fits): seconds from the PCM, usage kept.
  const usageMetadata = { promptTokenCount: 300, candidatesTokenCount: 4_427, totalTokenCount: 4_727 };
  let body = answer(8_500_000, { usageMetadata });
  mockFetch([[GEMINI, () => new Response(body, { headers: { 'content-type': 'application/json' } })]]);
  let r = await handleTts(ttsReq({ voice: 'sulafat', text: '好'.repeat(300) }), KEYS, hooks);
  assert.equal(r.status, 502);
  assert.equal((await r.json()).code, 'tts_unavailable');
  assert.equal(settles.length, 1);
  assert.ok(settles[0] && Math.abs(settles[0].seconds - 8_500_000 / 48_000) < 1e-9, JSON.stringify(settles[0]));
  assert.deepEqual(settles[0].usage, usageMetadata);
  // An answer too big to keep at all: the rest is counted, and its size gives the seconds.
  body = answer(9_600_000);
  r = await handleTts(ttsReq({ voice: 'sulafat', text: 'Hello there.' }), KEYS, hooks);
  assert.equal(r.status, 502);
  assert.equal(settles.length, 2);
  assert.ok(settles[1].seconds >= 200 && settles[1].seconds < 200.1, String(settles[1].seconds));
  assert.equal(settles[1].usage, null);
  assert.ok(logs.some((l) => /longer than one request allows/.test(l)));
  assert.ok(!logs.some((l) => /Hello there|好好/.test(l)), 'the text is never logged');
});

// ── Settings previews ──
test('preview: a miss is generated once and cached per voice and brief version; a hit makes no upstream call', async () => {
  const cache = fakeCache();
  globalThis.caches = { default: cache };
  mockFetch([[OPENAI, () => speech()]]);
  const owner = [];
  const hooks = { reserve: async (j) => { owner.push(j); return OWNER_HOOKS.reserve(j); } };
  let r = await handleTts(ttsReq({ voice: 'atelier', preview: true, text: 'not this' }), KEYS, hooks);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'audio/mpeg');
  assert.deepEqual(await bytesOf(r), MP3);
  assert.equal(upstream.calls.length, 1);
  assert.equal(upstream.calls[0].json.input, PREVIEW_TEXT);
  const key = previewCacheKey(ORIGIN, 'atelier');
  assert.equal(key, `${ORIGIN}/__tts-preview/v${TTS_BRIEF_V}/${PREVIEW_ID}/atelier/gpt-4o-mini-tts-2025-12-15/marin`);
  assert.deepEqual(cache.puts, [key]);
  assert.equal(cache.store.get(key).headers['cache-control'], 'public, max-age=2592000');
  assert.equal(cache.store.get(key).headers['content-type'], 'audio/mpeg');
  r = await handleTts(ttsReq({ voice: 'atelier', preview: true }), KEYS, hooks);
  assert.equal(r.status, 200);
  assert.deepEqual(await bytesOf(r), MP3);
  assert.equal(r.headers.get('x-tts-voice'), 'atelier');
  assert.equal(upstream.calls.length, 1, 'a cache hit calls no provider');
  assert.equal(owner.length, 1, 'and reserves nothing');
  r = await handleTts(ttsReq({ voice: 'cedar', preview: true }), KEYS, hooks);
  await r.arrayBuffer();
  assert.equal(upstream.calls.length, 2, 'each voice has its own clip');
  // a failed preview isn't cached
  mockFetch([[OPENAI, () => reply(500, {})]]);
  r = await handleTts(ttsReq({ voice: 'sage', preview: true }), KEYS);
  assert.equal(r.status, 502);
  assert.ok(!cache.store.has(previewCacheKey(ORIGIN, 'sage')));
});

test('preview without a Cache API (tests, local tools) still works', async () => {
  mockFetch([[OPENAI, () => speech()], [GEMINI, () => reply(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;rate=24000', data: b64(new Uint8Array(4_800)) } }] } }] })]]);
  let r = await handleTts(ttsReq({ voice: 'sage', preview: true }), KEYS);
  assert.deepEqual(await bytesOf(r), MP3);
  r = await handleTts(ttsReq({ voice: 'sulafat', preview: true }), KEYS);
  assert.equal(r.headers.get('content-type'), 'audio/wav');
  assert.equal((await bytesOf(r)).length, 4_844);
  assert.equal(upstream.calls.at(-1).json.contents[0].parts[0].text, PREVIEW_TEXT);
});

// ── the owner route in worker.js ──
test('POST /api/tts needs the passcode; the owner path never touches the Ledger', async () => {
  const { env, L } = makeEnv();
  mockFetch([[OPENAI, () => speech()]]);
  const body = { method: 'POST', body: { voice: 'atelier', text: 'Hi.' }, headers: { 'content-type': 'application/json' } };
  let r = await api(env, 'tts', body, { origin: null });
  assert.equal(r.status, 401);
  assert.match((await r.json()).error, /passcode/);
  r = await api(env, 'tts', body, { pass: 'nope', origin: null });
  assert.equal(r.status, 401);
  assert.equal(upstream.calls.length, 0);
  r = await api(env, 'tts', body, { pass: 'pw', origin: null });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'audio/mpeg');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-tester-allowance'), null);
  assert.deepEqual(await bytesOf(r), MP3);
  r = await api(env, 'tts', { method: 'GET' }, { pass: 'pw', origin: null });
  assert.equal(r.status, 404, 'only POST');
  assert.deepEqual(L.calls, []);
});
