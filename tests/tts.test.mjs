import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, mockFetch, restoreFetch, upstream, reply, api } from './tester-env.mjs';

const {
  handleTts, validateTts, toWav, wavHeader, previewCacheKey, geminiSpeechBody, spokenUnits, previewId,
  TTS_BRIEF_V, PREVIEW_TEXT, PREVIEW_ID, TTS_VOICES, TTS_VOICE_IDS, TTS_LIMITS, OWNER_HOOKS, ttsPriceId, GEMINI_MAX_OUTPUT_TOKENS,
  ttsCeilingUnits, TTS_CEILING, RETIRED_VOICES,
} = await import('../src/tts.js');
const { GEMINI_BASE } = await import('../src/gemini.js');

const ORIGIN = 'https://atelier.ciprari.ai';
const OPENAI = /^POST https:\/\/api\.openai\.com\//;
// The Atelier voice (gemini-3.8-flash-tts) and Sulafat (gemini-3.8-flash-lite-tts).
const FLASH = /^POST https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-3\.8-flash-tts:generateContent$/;
const GEMINI = /^POST https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-3\.8-flash-lite-tts:generateContent$/;
const KEYS = { OPENAI_API_KEY: 'sk-openai-test', GEMINI_API_KEY: 'AQ.test-gemini-key-0123456789abcdef' };
const enc = new TextEncoder();
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const PCM = Uint8Array.from({ length: 4_800 }, (_, i) => (i * 7) % 256); // 0.1 s at 24 kHz s16le mono
const WAV = toWav(PCM, 'audio/L16;codec=pcm;rate=24000').wav;
const spoken = (pcm = PCM, usageMetadata = { promptTokenCount: 30, candidatesTokenCount: 4, totalTokenCount: 34 }, headers = {}) => reply(200, {
  candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: b64(pcm) } }] }, finishReason: 'STOP' }],
  ...(usageMetadata ? { usageMetadata } : {}),
}, headers);
const ttsReq = (body, headers = {}) => new Request(`${ORIGIN}/api/tts`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
const bytesOf = async (res) => new Uint8Array(await res.arrayBuffer());

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

// ── the allow-list ──
test('voices are a frozen server allow-list; the default is Gemini 3.8 Flash TTS, Achernar, with the soft style', () => {
  assert.deepEqual([...TTS_VOICE_IDS], ['atelier', 'sulafat']);
  assert.deepEqual({ ...TTS_VOICES.atelier }, { provider: 'gemini', model: 'gemini-3.8-flash-tts', voice: 'Achernar', style: TTS_VOICES.sulafat.style, maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS });
  assert.match(TTS_VOICES.atelier.style, /^warm, soft and calm; unhurried and gentle/);
  assert.deepEqual({ ...TTS_VOICES.sulafat }, { provider: 'gemini', model: 'gemini-3.8-flash-lite-tts', voice: 'Sulafat', style: TTS_VOICES.atelier.style, maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS });
  assert.ok(Object.values(TTS_VOICES).every((v) => v.provider === 'gemini'), 'no OpenAI voice is left (gpt-4o-mini-tts retires 2027-01-06)');
  assert.ok(Object.isFrozen(TTS_VOICES) && Object.isFrozen(TTS_VOICES.atelier) && Object.isFrozen(TTS_LIMITS) && Object.isFrozen(RETIRED_VOICES));
  assert.throws(() => { TTS_VOICES.atelier.voice = 'Puck'; }, TypeError);
  assert.equal(ttsPriceId(TTS_VOICES.atelier), 'gemini:gemini-3.8-flash-tts');
  assert.equal(ttsPriceId(TTS_VOICES.sulafat), 'gemini:gemini-3.8-flash-lite-tts');
  assert.equal(TTS_BRIEF_V, 2, 'the Atelier voice changed in v80: cached clips and previews roll over');
  assert.deepEqual({ ...RETIRED_VOICES }, { cedar: 'atelier', sage: 'atelier' });
  assert.ok(PREVIEW_TEXT.startsWith('Hello, I’m the voice of Atelier.'));
  assert.deepEqual({ ...TTS_LIMITS }, { bodyBytes: 16_384, ownerChars: 4_000, testerChars: 1_000, maxAudioBytes: 8 * 1024 * 1024, timeoutMs: 30_000 });
  // Gemini's output is bounded at the source: as many audio tokens (25 a second) as fit in maxAudioBytes of 24 kHz s16
  // PCM, well under both models' 16,384-token output limit.
  assert.equal(GEMINI_MAX_OUTPUT_TOKENS, 4_369);
  assert.ok(GEMINI_MAX_OUTPUT_TOKENS / 25 * 48_000 <= TTS_LIMITS.maxAudioBytes && GEMINI_MAX_OUTPUT_TOKENS <= 16_384);
  assert.equal(geminiSpeechBody(TTS_VOICES.sulafat, 'x').generationConfig.maxOutputTokens, GEMINI_MAX_OUTPUT_TOKENS);
  assert.equal(geminiSpeechBody(TTS_VOICES.atelier, 'x').generationConfig.maxOutputTokens, GEMINI_MAX_OUTPUT_TOKENS);
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

// What a voice may say for a symbol or an emoji (Unicode / CLDR names) — what ttsCeilingUnits must leave time for.
const SAID = [
  ['≤', 'less-than or equal to'], ['≥', 'greater-than or equal to'], ['≠', 'not equal to'], ['≈', 'almost equal to'],
  ['→', 'rightwards arrow'], ['←', 'leftwards arrow'], ['⇔', 'left right double arrow'], ['∑', 'n-ary summation'], ['√', 'square root'],
  ['∞', 'infinity'], ['±', 'plus-minus sign'], ['<', 'less-than sign'], ['>', 'greater-than sign'], ['|', 'vertical line'], ['~', 'tilde'],
  ['^', 'circumflex accent'], ['`', 'grave accent'], ['½', 'one half'], ['²', 'superscript two'], ['Ⅷ', 'roman numeral eight'], ['•', 'bullet'],
  ['%', 'percent'], ['&', 'and'], ['@', 'at'], ['#', 'number sign'], ['$', 'dollars'], ['€', 'euros'], ['£', 'pounds'], ['¥', 'yen'], ['₹', 'rupees'],
  ['+', 'plus'], ['=', 'equals'], ['*', 'asterisk'], ['/', 'slash'], ['\\', 'backslash'], ['_', 'underscore'], ['°', 'degrees'], ['×', 'times'],
  ['÷', 'divided by'], ['§', 'section sign'], ['‰', 'per mille'], ['٣', 'three'], ['５', 'five'],
  ['™', 'trade mark sign'], ['©', 'copyright sign'], ['®', 'registered sign'], ['🦒', 'giraffe'], ['😍', 'smiling face with heart-eyes'],
  ['👍🏽', 'thumbs up: medium skin tone'], ['🇺🇸', 'flag: United States'], ['🏴󠁧󠁢󠁥󠁮󠁧󠁿', 'flag: England'], ['#️⃣', 'keycap: number sign'],
  ['👨‍👩‍👧‍👦', 'family: man, woman, girl, boy'], ['🧑🏽‍🤝‍🧑🏻', 'people holding hands: medium skin tone, light skin tone'],
  ['👩🏼‍❤️‍👨🏾', 'couple with heart: woman, man, medium-light skin tone, medium-dark skin tone'],
  ['👩🏾‍🦼‍➡️', 'woman in motorized wheelchair facing right: medium-dark skin tone'],
];
// Reserved seconds (units / 8) against the name read at 10 characters a second (prose runs 11-13).
const covers = (text, said) => ttsCeilingUnits(text) / 8 >= said.length / 10;

test('ttsCeilingUnits: every symbol and emoji is reserved for at least its spoken name; prose is priced as before', () => {
  for (const [s, said] of SAID) assert.ok(covers(s, said), `${s} (${said}): ${ttsCeilingUnits(s)} units`);
  // Adversarial texts within a tester's 1,000-unit cap: all symbols, all emoji, mixed with prose and digits.
  const symbols = SAID.filter(([s]) => !/\p{Extended_Pictographic}/u.test(s));
  const emoji = SAID.filter(([s]) => /\p{Extended_Pictographic}/u.test(s));
  for (const list of [symbols, emoji, SAID]) {
    for (const sep of ['', ' ', ' and ']) {
      const text = list.map(([s]) => s).join(sep), said = list.map(([, n]) => n).join(sep || ' ');
      assert.ok(covers(text, said), `${sep}: ${ttsCeilingUnits(text)} units for ${said.length} characters`);
      const many = text.repeat(40), saidMany = `${said} `.repeat(40);
      assert.ok(covers(many, saidMany), 'repeated');
    }
  }
  // Clusters count once: a flag, keycap, skin tone or ZWJ family is one emoji (plus its parts), not one per code point.
  assert.equal(ttsCeilingUnits('🦒'), 2 + TTS_CEILING.emoji);
  assert.equal(ttsCeilingUnits('🇺🇸'), 4 + TTS_CEILING.emoji + TTS_CEILING.emojiPart);
  assert.equal(ttsCeilingUnits('👨‍👩‍👧‍👦'), 11 + TTS_CEILING.emoji + 3 * TTS_CEILING.emojiPart);
  // Prose, its punctuation (curly quotes, dashes, ellipses, CJK punctuation), digits and CJK text keep spokenUnits.
  for (const prose of ['Hello there.', 'It’s a “state-of-the-art” idea — really… (maybe); yes: no! ok?', 'Call 555-0100 on 2026-09-30.', '你好，世界。「こんにちは」', 'Ünïcödé façade, naïve café.']) {
    assert.equal(ttsCeilingUnits(prose), spokenUnits(prose), prose);
  }
  assert.equal(ttsCeilingUnits(''), 0);
  assert.equal(ttsCeilingUnits(null), 0);
});

// ── validation: before any reserve or upstream call ──
test('validateTts: voice ids are an allow-list, text must be a non-empty string within the cap, extra fields are ignored', () => {
  const ok = validateTts({ voice: 'atelier', text: '  Hello\u0007 there.\n', instructions: 'shout', model: 'tts-1', speed: 4 });
  assert.deepEqual({ ...ok, voice: ok.voice.voice }, { ok: true, voiceId: 'atelier', voice: 'Achernar', text: 'Hello there.', units: 12, ceiling: 12, preview: false });
  // retired ids read as their stand-in
  const old = validateTts({ voice: 'cedar', text: 'Hello there.' });
  assert.deepEqual([old.ok, old.voiceId, old.voice.voice], [true, 'atelier', 'Achernar']);
  const prev = validateTts({ voice: 'sage', preview: true, text: 'ignored' });
  assert.equal(prev.voiceId, 'atelier');
  assert.equal(prev.text, PREVIEW_TEXT);
  assert.equal(prev.preview, true);
  assert.equal(prev.ceiling, ttsCeilingUnits(PREVIEW_TEXT));
  // The cap counts spoken units (as the client segments); the reservation's ceiling counts symbols read as words.
  const sym = validateTts({ voice: 'atelier', text: '≤'.repeat(1_000) }, { tester: true });
  assert.deepEqual([sym.ok, sym.units, sym.ceiling], [true, 1_000, 21_000]);
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
  assert.equal(validateTts({ voice: 'atelier', text: '7'.repeat(4_000) }).ok, true, 'the owner’s cap is in characters');
  // Gemini reads <...> as a sound cue: the brackets go (and a text of only brackets is empty)
  assert.equal(validateTts({ voice: 'sulafat', text: 'Take a breath <sigh> and go.' }).text, 'Take a breath sigh and go.');
  assert.equal(validateTts({ voice: 'sulafat', text: '<>' }).ok, false);
  assert.equal(validateTts({ voice: 'atelier', text: 'a < b > c' }).text, 'a b c', 'the Atelier voice is Gemini too');
  assert.equal(validateTts({ voice: 'cedar', text: 'Take a breath <sigh> now.' }).text, 'Take a breath sigh now.');
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

// ── the Atelier voice: Gemini 3.8 Flash TTS ──
test('Atelier: the request goes to gemini-3.8-flash-tts with voice Achernar and the soft style; the WAV comes back with our own headers only', async () => {
  mockFetch([[FLASH, () => spoken(PCM, { promptTokenCount: 30, candidatesTokenCount: 4, totalTokenCount: 34 }, { 'x-goog-request-id': 'g1', 'set-cookie': 'a=b' })]]);
  const r = await handleTts(ttsReq({ voice: 'atelier', text: 'Hello <laugh> there.', instructions: 'Speak like a pirate', model: 'tts-1', style: 'shouting', speed: 4, voice_id: 'Puck' }), KEYS);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.fromEntries(r.headers), { 'cache-control': 'no-store', 'content-type': 'audio/wav', 'x-tts-brief': '2', 'x-tts-voice': 'atelier' });
  assert.deepEqual(await bytesOf(r), WAV);
  assert.equal(upstream.calls.length, 1);
  const call = upstream.calls[0];
  assert.equal(call.url, `${GEMINI_BASE}/v1beta/models/gemini-3.8-flash-tts:generateContent`);
  assert.equal(call.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-tts:generateContent');
  assert.equal(call.headers.get('x-goog-api-key'), KEYS.GEMINI_API_KEY);
  assert.equal(call.headers.get('authorization'), null);
  assert.equal(call.headers.get('content-type'), 'application/json');
  assert.deepEqual(call.json, {
    contents: [{ role: 'user', parts: [{ text: 'Hello laugh there.', speech_metadata: { style: TTS_VOICES.atelier.style } }] }],
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { voice: 'Achernar' } }, maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS },
  });
  assert.deepEqual(geminiSpeechBody(TTS_VOICES.atelier, 'Hello laugh there.'), call.json);
  // the owner log carries token counts, never the text
  assert.ok(logs.some((l) => /^tts atelier tokens in 30 out 4 seconds 0\.1$/.test(l)), logs.join('\n'));
  assert.ok(!logs.some((l) => /Hello/.test(l)));
});

test('Atelier: a RIFF answer (Gemini’s default WAV) passes through as it came', async () => {
  const riff = new Uint8Array(44 + 2_400);
  riff.set(wavHeader(2_400, 24_000), 0);
  mockFetch([[FLASH, () => reply(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: b64(riff) } }] } }] })]]);
  const r = await handleTts(ttsReq({ voice: 'atelier', text: 'Hi.' }), KEYS);
  assert.equal(r.headers.get('content-type'), 'audio/wav');
  assert.deepEqual(await bytesOf(r), riff);
});

test('retired voices (cedar, sage) read as the Atelier voice, on Gemini; nothing reaches OpenAI', async () => {
  mockFetch([[FLASH, () => spoken()]]);
  const reserves = [];
  const hooks = { tester: true, reserve: async (j) => { reserves.push(j); return { headers: {}, limits: { outputTokens: 96 }, settle: async () => null }; } };
  for (const id of ['cedar', 'sage']) {
    const v = validateTts({ voice: id, text: 'Hi.' });
    assert.equal(v.ok, true);
    assert.equal(v.voiceId, 'atelier');
    assert.equal(v.voice, TTS_VOICES.atelier);
    const r = await handleTts(ttsReq({ voice: id, text: 'Hi.' }), KEYS, hooks);
    assert.equal(r.status, 200, id);
    assert.equal(r.headers.get('x-tts-voice'), 'atelier', `${id} answers as atelier`);
    assert.deepEqual(await bytesOf(r), WAV);
    assert.equal(upstream.calls.at(-1).json.generationConfig.speechConfig.voiceConfig.voice, 'Achernar');
    assert.equal(upstream.calls.at(-1).json.generationConfig.maxOutputTokens, 96, 'held to the tester reservation');
  }
  assert.deepEqual(reserves.map((j) => [j.voiceId, j.voice.model]), [['atelier', 'gemini-3.8-flash-tts'], ['atelier', 'gemini-3.8-flash-tts']]);
  assert.ok(upstream.calls.every((c) => FLASH.test(`${c.method} ${c.url}`)), 'only Gemini Flash TTS was called');
  // a retired preview is the Atelier preview
  assert.equal(validateTts({ voice: 'sage', preview: true }).voiceId, 'atelier');
  // provider voice names were never ids, and still aren't
  for (const voice of ['marin', 'Achernar', 'Sulafat', 'Cedar', 'alloy']) assert.equal(validateTts({ voice, text: 'Hi.' }).ok, false, voice);
});

// ── errors are mapped, never passed through ──
test('an upstream error quoting the key becomes a generic 502; nothing upstream reaches the client or the log', async () => {
  const leak = 'API key not valid. Please pass a valid API key: AQ.test-gemini-key-0123456789abcdef (Bearer sk-proj-AbCdEf123456wxyz)';
  mockFetch([[FLASH, () => reply(400, { error: { code: 400, message: leak, status: 'INVALID_ARGUMENT' } }, { 'x-goog-request-id': 'req_9', 'set-cookie': 'z=1' })]]);
  const r = await handleTts(ttsReq({ voice: 'atelier', text: 'Private sentence to read.' }), KEYS);
  assert.equal(r.status, 502);
  const text = await r.text();
  assert.deepEqual(JSON.parse(text), { error: 'Read aloud is unavailable right now.', code: 'tts_unavailable' });
  assert.ok(!/AQ\.|sk-|wxyz|AbCdEf|INVALID/.test(text));
  assert.deepEqual([...r.headers.keys()].sort(), ['cache-control', 'content-type']);
  const logged = logs.join('\n');
  assert.match(logged, /tts upstream 400 gemini atelier/);
  assert.ok(!/0123456789abcdef|AbCdEf|wxyz/.test(logged), logged);
  assert.ok(!/Private sentence/.test(logged), 'the text is never logged');
});

test('upstream 429 keeps retry-after; other failures and network errors are 502 tts_unavailable', async () => {
  let mode = '429';
  mockFetch([[FLASH, () => {
    if (mode === '429') return reply(429, { error: { message: 'Resource exhausted' } }, { 'retry-after': '7', 'x-ratelimit-remaining-requests': '0' });
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

test('owner: no GEMINI_API_KEY → 503 tts_unavailable naming the secret (an OpenAI key alone reads nothing)', async () => {
  mockFetch([]);
  for (const voice of ['atelier', 'sulafat', 'cedar']) {
    const r = await handleTts(ttsReq({ voice, text: 'Hi.' }), { OPENAI_API_KEY: 'k' });
    assert.equal(r.status, 503, voice);
    assert.deepEqual(await r.json(), { error: 'Read aloud needs GEMINI_API_KEY on the server.', code: 'tts_unavailable' });
  }
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

// A Gemini answer delivered in pieces of the given sizes (cycled).
const piecewise = (text, sizes) => {
  const all = enc.encode(text);
  return new Response(new ReadableStream({
    start(c) { for (let at = 0, k = 0; at < all.length; k++) { const n = sizes[k % sizes.length]; c.enqueue(all.slice(at, at + n)); at += n; } c.close(); },
  }), { headers: { 'content-type': 'application/json' } });
};
const geminiAnswer = (parts, extra = {}) => JSON.stringify({ candidates: [{ content: { role: 'model', parts } }], ...extra });

test('Gemini: the answer is decoded as it streams, whatever the split, escapes or key order; only the audio data is decoded', async () => {
  const pcm = Uint8Array.from({ length: 4_801 }, (_, i) => (i * 31) % 256); // odd: the stray byte is dropped
  const want = toWav(pcm, 'audio/L16;rate=24000');
  const usageMetadata = { promptTokenCount: 12, candidatesTokenCount: 3, totalTokenCount: 15 };
  const data = b64(pcm), url = data.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const shapes = {
    plain: geminiAnswer([{ inlineData: { mimeType: 'audio/L16;rate=24000', data } }], { usageMetadata }),
    'data before mimeType, usage first': JSON.stringify({ usageMetadata, candidates: [{ content: { parts: [{ inlineData: { data, mimeType: 'audio/L16;rate=24000' } }] } }] }),
    'escaped slashes, spaces': geminiAnswer([{ inlineData: { mimeType: 'audio/L16;rate=24000', data } }], { usageMetadata }).replace(/\//g, '\\/').replace(/":/g, '" :  '),
    'base64url, no padding, inline_data': geminiAnswer([{ inline_data: { mime_type: 'audio/L16;rate=24000', data: url } }], { usageMetadata }),
    'text mentioning data, an empty data first, a later one ignored': geminiAnswer([
      { text: 'a "data": "QUJD" \\"data\\": \\"x\\" {"inlineData": {"data": "QUJD"}}' },
      { inlineData: { mimeType: 'audio/L16;rate=24000', data: '' } },
      { inlineData: { mimeType: 'audio/L16;rate=24000', data } },
      { inlineData: { mimeType: 'audio/L16;rate=16000', data: b64(new Uint8Array(900)) } },
      { executableCode: { data: 'QUJD' } },
    ], { usageMetadata }),
  };
  for (const [name, text] of Object.entries(shapes)) {
    for (const sizes of [[1], [2, 3, 5], [7, 64, 1], [1_000_000]]) {
      const settles = [];
      const hooks = { tester: true, reserve: async () => ({ headers: {}, settle: async (r) => { settles.push(r); return null; } }) };
      mockFetch([[GEMINI, () => piecewise(text, sizes)]]);
      const r = await handleTts(ttsReq({ voice: 'sulafat', text: 'Hi.' }), KEYS, hooks);
      assert.equal(r.status, 200, `${name} ${sizes}`);
      assert.deepEqual(await bytesOf(r), want.wav, `${name} ${sizes}`);
      assert.deepEqual(settles, [{ usage: usageMetadata, seconds: want.seconds }], `${name} ${sizes}`);
    }
  }
  // A RIFF answer passes through as it came.
  const riff = new Uint8Array(44 + 2_400);
  riff.set(wavHeader(2_400, 24_000), 0);
  mockFetch([[GEMINI, () => piecewise(geminiAnswer([{ inlineData: { mimeType: 'audio/wav', data: b64(riff) } }]), [9])]]);
  assert.deepEqual(await bytesOf(await handleTts(ttsReq({ voice: 'sulafat', text: 'Hi.' }), KEYS)), riff);
});

test('Gemini: a truncated answer, bad base64 or audio past the cap never plays; an unparseable answer keeps the reservation', async () => {
  const settles = [];
  const hooks = { tester: true, reserve: async () => ({ headers: {}, settle: async (r) => { settles.push(r); return null; } }) };
  const good = geminiAnswer([{ inlineData: { mimeType: 'audio/L16;rate=24000', data: b64(new Uint8Array(480)) } }]);
  for (const body of [good.slice(0, -3), good.slice(0, 60), geminiAnswer([{ inlineData: { data: 'AAAA*AAA' } }]), geminiAnswer([{ inlineData: { data: 'AAAAA' } }]),
    geminiAnswer([{ inlineData: { data: 'AA==AA' } }]), geminiAnswer([{ inlineData: { data: 'AA\\nAA' } }])]) {
    settles.length = 0;
    mockFetch([[GEMINI, () => piecewise(body, [5])]]);
    const r = await handleTts(ttsReq({ voice: 'sulafat', text: 'Hi.' }), KEYS, hooks);
    assert.equal(r.status, 502, body.slice(0, 60));
    assert.deepEqual(settles, [null], 'the full reservation stands');
  }
  // Bad audio mid-answer: the rest is not read (the upstream is cancelled).
  let cancelled = false, n = 0;
  const parts = ['{"candidates":[{"content":{"parts":[{"inlineData":{"data":"AAAA', 'AA*A', 'AAAA'.repeat(1_000), '"}}]}}]}'];
  mockFetch([[GEMINI, () => new Response(new ReadableStream({ pull(c) { if (n < parts.length) c.enqueue(enc.encode(parts[n++])); else c.close(); }, cancel() { cancelled = true; } }, { highWaterMark: 0 }))]]);
  assert.equal((await handleTts(ttsReq({ voice: 'sulafat', text: 'Hi.' }), KEYS, hooks)).status, 502);
  assert.equal(cancelled, true);
  assert.equal(n, 2);
});

test('Gemini: a tester’s output is bounded by the reservation (hooks limits.outputTokens), never above the voice’s own bound', async () => {
  const sent = [];
  mockFetch([[GEMINI, (call) => { sent.push(call.json.generationConfig.maxOutputTokens); return reply(200, JSON.parse(geminiAnswer([{ inlineData: { mimeType: 'audio/L16;rate=24000', data: b64(new Uint8Array(480)) } }]))); }]]);
  for (const outputTokens of [50, GEMINI_MAX_OUTPUT_TOKENS + 1_000, undefined]) {
    const hooks = { tester: true, reserve: async () => ({ headers: {}, limits: { outputTokens }, settle: async () => null }) };
    assert.equal((await handleTts(ttsReq({ voice: 'sulafat', text: 'Hi.' }), KEYS, hooks)).status, 200);
  }
  assert.deepEqual(sent, [50, GEMINI_MAX_OUTPUT_TOKENS, GEMINI_MAX_OUTPUT_TOKENS]);
  assert.equal(geminiSpeechBody(TTS_VOICES.sulafat, 'x', 0).generationConfig.maxOutputTokens, GEMINI_MAX_OUTPUT_TOKENS);
});

test('Gemini: no network chunk of the answer is held once read (memory stays near one copy of the audio)', async () => {
  const { setFlagsFromString } = await import('node:v8');
  const { runInNewContext } = await import('node:vm');
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc');
  const pcm = Uint8Array.from({ length: 960_000 }, (_, i) => (i * 7) % 256); // 20 s
  const all = enc.encode(geminiAnswer([{ inlineData: { mimeType: 'audio/L16;rate=24000', data: b64(pcm) } }], { usageMetadata: { promptTokenCount: 5 } }));
  const refs = [];
  let at = 0, alive = -1;
  const body = new ReadableStream({
    async pull(c) {
      if (at >= all.length) { // the whole answer has been read: are the chunks still reachable?
        await new Promise((ok) => setTimeout(ok, 0));
        gc();
        alive = refs.filter((r) => r.deref()).length;
        return c.close();
      }
      const chunk = all.slice(at, at += 64 * 1024);
      refs.push(new WeakRef(chunk));
      c.enqueue(chunk);
    },
  }, { highWaterMark: 0 });
  mockFetch([[GEMINI, () => new Response(body, { headers: { 'content-type': 'application/json' } })]]);
  const r = await handleTts(ttsReq({ voice: 'sulafat', text: 'Hello.' }), KEYS);
  assert.equal(r.status, 200);
  assert.deepEqual((await bytesOf(r)).subarray(44), pcm);
  assert.ok(refs.length >= 15, `${refs.length} chunks`);
  assert.ok(alive >= 0 && alive <= 2, `${alive} of ${refs.length} network chunks were still held when the answer ended`);
});

// ── Settings previews ──
test('preview: a miss is generated once and cached per voice and brief version; a hit makes no upstream call', async () => {
  const cache = fakeCache();
  globalThis.caches = { default: cache };
  mockFetch([[FLASH, () => spoken()], [GEMINI, () => spoken()]]);
  const owner = [];
  const hooks = { reserve: async (j) => { owner.push(j); return OWNER_HOOKS.reserve(j); } };
  let r = await handleTts(ttsReq({ voice: 'atelier', preview: true, text: 'not this' }), KEYS, hooks);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'audio/wav');
  assert.deepEqual(await bytesOf(r), WAV);
  assert.equal(upstream.calls.length, 1);
  assert.equal(upstream.calls[0].json.contents[0].parts[0].text, PREVIEW_TEXT);
  const key = previewCacheKey(ORIGIN, 'atelier');
  assert.equal(key, `${ORIGIN}/__tts-preview/v2/${PREVIEW_ID}/atelier/gemini-3.8-flash-tts/Achernar`);
  assert.deepEqual(cache.puts, [key]);
  assert.equal(cache.store.get(key).headers['cache-control'], 'public, max-age=2592000');
  assert.equal(cache.store.get(key).headers['content-type'], 'audio/wav');
  r = await handleTts(ttsReq({ voice: 'atelier', preview: true }), KEYS, hooks);
  assert.equal(r.status, 200);
  assert.deepEqual(await bytesOf(r), WAV);
  assert.equal(r.headers.get('x-tts-voice'), 'atelier');
  assert.equal(upstream.calls.length, 1, 'a cache hit calls no provider');
  assert.equal(owner.length, 1, 'and reserves nothing');
  // a retired id's preview is the Atelier preview: the same cached clip
  r = await handleTts(ttsReq({ voice: 'cedar', preview: true }), KEYS, hooks);
  assert.deepEqual(await bytesOf(r), WAV);
  assert.equal(upstream.calls.length, 1);
  r = await handleTts(ttsReq({ voice: 'sulafat', preview: true }), KEYS, hooks);
  await r.arrayBuffer();
  assert.equal(upstream.calls.length, 2, 'each voice has its own clip');
  // an old mp3 entry under a key is a miss (only audio/wav previews are served)
  const old = previewCacheKey('https://old.example', 'atelier');
  cache.store.set(old, { bytes: Uint8Array.of(0xff, 0xf3, 1, 2), headers: { 'content-type': 'audio/mpeg' } });
  r = await handleTts(new Request('https://old.example/api/tts', { method: 'POST', body: JSON.stringify({ voice: 'atelier', preview: true }) }), KEYS, hooks);
  assert.deepEqual(await bytesOf(r), WAV);
  assert.equal(upstream.calls.length, 3);
  // a failed preview isn't cached
  mockFetch([[GEMINI, () => reply(500, {})]]);
  cache.store.delete(previewCacheKey(ORIGIN, 'sulafat'));
  r = await handleTts(ttsReq({ voice: 'sulafat', preview: true }), KEYS);
  assert.equal(r.status, 502);
  assert.ok(!cache.store.has(previewCacheKey(ORIGIN, 'sulafat')));
});

test('preview without a Cache API (tests, local tools) still works', async () => {
  mockFetch([[FLASH, () => spoken()], [GEMINI, () => reply(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;rate=24000', data: b64(new Uint8Array(4_800)) } }] } }] })]]);
  let r = await handleTts(ttsReq({ voice: 'atelier', preview: true }), KEYS);
  assert.deepEqual(await bytesOf(r), WAV);
  r = await handleTts(ttsReq({ voice: 'sulafat', preview: true }), KEYS);
  assert.equal(r.headers.get('content-type'), 'audio/wav');
  assert.equal((await bytesOf(r)).length, 4_844);
  assert.equal(upstream.calls.at(-1).json.contents[0].parts[0].text, PREVIEW_TEXT);
});

// ── the owner route in worker.js ──
test('POST /api/tts needs the passcode; the owner path never touches the Ledger', async () => {
  const { env, L } = makeEnv();
  mockFetch([[FLASH, () => spoken()]]);
  const body = { method: 'POST', body: { voice: 'atelier', text: 'Hi.' }, headers: { 'content-type': 'application/json' } };
  let r = await api(env, 'tts', body, { origin: null });
  assert.equal(r.status, 401);
  assert.match((await r.json()).error, /passcode/);
  r = await api(env, 'tts', body, { pass: 'nope', origin: null });
  assert.equal(r.status, 401);
  assert.equal(upstream.calls.length, 0);
  r = await api(env, 'tts', body, { pass: 'pw', origin: null });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'audio/wav');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-tester-allowance'), null);
  assert.deepEqual(await bytesOf(r), WAV);
  assert.ok(!upstream.calls.some((c) => OPENAI.test(`${c.method} ${c.url}`)));
  r = await api(env, 'tts', { method: 'GET' }, { pass: 'pw', origin: null });
  assert.equal(r.status, 404, 'only POST');
  assert.deepEqual(L.calls, []);
});
