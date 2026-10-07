// Read aloud on the client (public/readaloud.js): Markdown → speakable text, segments, cache keys, the device-voice pick,
// and the player's state machine driven with fake Audio / fetch / speechSynthesis / Cache Storage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../public/vendor/marked.js'; // the UMD bundle sets globalThis.marked, as the app's <script> tag does
import {
  TTS_BRIEF_V, PREVIEW_ID, VOICES, SPEEDS, READ_LIMITS, DEVICE_RATE, TTS_CACHE, CACHE_CAP, NOTES, SAY, DEFAULT_READ_ALOUD,
  normalizeReadAloud, voiceChoices, voiceFor, RETIRED_VOICES, AI_CAPTION, speakable, segments, spokenUnits, textLang, pickDeviceVoice, cacheKey, previewKey, lruAdd, lruTouch, silentWav, createReader,
} from '../public/readaloud.js';
import {
  TTS_VOICE_IDS, TTS_BRIEF_V as SERVER_BRIEF_V, TTS_LIMITS, PREVIEW_ID as SERVER_PREVIEW_ID, PREVIEW_TEXT, previewId,
  spokenUnits as serverUnits, validateTts, RETIRED_VOICES as SERVER_RETIRED,
} from '../src/tts.js';

// ── helpers ──
const tag = (n) => n.toString(26).replace(/./g, (d) => String.fromCharCode(97 + parseInt(d, 26))); // 0 → a, 27 → bb
const sentenceOf = (i, words = 14) => `Sentence ${tag(i)} ${Array.from({ length: words }, (_, k) => `word${tag(i)}x${tag(k)}`).join(' ')}.`;
const paragraph = (from, n) => Array.from({ length: n }, (_, k) => sentenceOf(from + k)).join(' ');
const LONG = [paragraph(0, 6), paragraph(6, 6), paragraph(12, 6), paragraph(18, 6)].join('\n\n'); // several segments
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, what, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await wait(2); }
}

test('the client voice list and brief version match src/tts.js', () => {
  assert.deepEqual(VOICES.filter((v) => v.provider !== 'device').map((v) => v.id), [...TTS_VOICE_IDS]);
  assert.equal(TTS_BRIEF_V, SERVER_BRIEF_V);
  assert.ok(VOICES.some((v) => v.id === 'device'));
  // Every segment fits the tester cap, and an owner read never needs a request over the owner cap.
  assert.ok(READ_LIMITS.target <= TTS_LIMITS.testerChars && READ_LIMITS.first <= READ_LIMITS.target);
  assert.ok(READ_LIMITS.target <= TTS_LIMITS.ownerChars);
  // The preview line's hash, and the spoken-length count segments are sized by, are the server's.
  assert.equal(PREVIEW_ID, SERVER_PREVIEW_ID);
  assert.equal(previewId(PREVIEW_TEXT), SERVER_PREVIEW_ID);
  assert.notEqual(previewId(`${PREVIEW_TEXT} `), SERVER_PREVIEW_ID, 'a new preview line gets a new key');
  for (const t of ['Plain prose.', 'Call 555-0199 at 9:30 or pay $1,250.50 (20% off) & more = 7 × 3 / 2 °C § ‰ ¥ € £ @ #',
    '这是中文的回答。日本語のテキスト、カタカナ。한국어 답변입니다.', '𠀀𠀁 emoji 👍🏽 and ＜tags＞ \u0000', '']) assert.equal(spokenUnits(t), serverUnits(t), t);
});

test('normalizeReadAloud keeps a known voice and one of the speed steps', () => {
  assert.deepEqual(normalizeReadAloud(undefined), { ...DEFAULT_READ_ALOUD });
  assert.deepEqual(normalizeReadAloud({ voice: 'sulafat', speed: 1.25 }), { voice: 'sulafat', speed: 1.25 });
  assert.deepEqual(normalizeReadAloud({ voice: 'marin', speed: 3 }), { voice: 'atelier', speed: 1 }, 'provider voice names are not ids');
  assert.deepEqual(normalizeReadAloud({ voice: 'device', speed: '0.9' }), { voice: 'device', speed: 0.9 });
  assert.deepEqual(SPEEDS, [0.9, 1, 1.1, 1.25]);
  assert.deepEqual(voiceChoices(null).map((v) => v.id), VOICES.map((v) => v.id));
  assert.deepEqual(voiceChoices(['sulafat']).map((v) => v.id), ['sulafat', 'device']);
  assert.deepEqual(voiceChoices(['cedar']).map((v) => v.id), ['atelier', 'device'], 'an old allow-list entry counts as its stand-in');
  assert.deepEqual(voiceChoices([]).map((v) => v.id), ['device']);
});

test('saved OpenAI voices (cedar, sage, retired in v80) migrate to the Atelier voice; the client and server maps agree', () => {
  assert.deepEqual({ ...RETIRED_VOICES }, { ...SERVER_RETIRED });
  assert.deepEqual({ ...RETIRED_VOICES }, { cedar: 'atelier', sage: 'atelier' });
  for (const [old, now] of Object.entries(RETIRED_VOICES)) {
    assert.ok(VOICES.some((v) => v.id === now), `${old} → ${now}, a voice that exists`);
    assert.ok(!VOICES.some((v) => v.id === old), `${old} is no longer offered`);
    assert.deepEqual(normalizeReadAloud({ voice: old, speed: 1.1 }), { voice: 'atelier', speed: 1.1 }, old);
    assert.equal(validateTts({ voice: old, text: 'Hi.' }).voiceId, now, 'the server reads an old client id the same way');
  }
  // anything else unknown still falls back to the default
  for (const voice of ['marin', 'alloy', 'Cedar', '', null, 7, '__proto__', 'toString']) assert.equal(normalizeReadAloud({ voice }).voice, 'atelier', String(voice));
  assert.equal(normalizeReadAloud({ voice: 'sulafat' }).voice, 'sulafat');
  assert.equal(normalizeReadAloud({ voice: 'device' }).voice, 'device');
  assert.deepEqual(VOICES.map((v) => [v.id, v.provider]), [['atelier', 'gemini'], ['sulafat', 'gemini'], ['device', 'device']]);
  assert.match(AI_CAPTION, /answer text is sent to Google./);
});

// ── speakable ──
test('speakable keeps hyphens, dates and negative numbers', () => {
  const s = speakable('A state-of-the-art plan, due 2026-09-30, at -5 °C.');
  assert.equal(s, 'A state-of-the-art plan, due 2026-09-30, at -5 °C.');
});

test('speakable skips code blocks (saying so once) and reads only short inline code', () => {
  const s = speakable('Install it first.\n\n```bash\nnpm i atelier\n```\n\nThen run `npm start` or `node scripts/a-very-long-script-name.mjs --flag`.\n\n```js\nconst x = 1;\n```\n\nThat is all there is to it, really.');
  assert.equal(s.split(NOTES.code).length - 1, 1, 'the code notice is said once');
  assert.ok(!s.includes('npm i atelier') && !s.includes('const x'));
  assert.match(s, /Then run npm start or the code on screen\./, 'long inline code is named, so the sentence stays whole');
  assert.ok(!s.includes('a-very-long-script-name'));
});

test('speakable reads link text, names the domain of a bare URL and drops emoji, math and footnote markers', () => {
  const s = speakable('See [the guide](https://example.com/guide) or https://www.bare.org/path, mail <ada@example.com>. Great 🎉👍🏽 work 👨‍👩‍👧 🇺🇸[1] — $x^2 + y_1$ costs $5 and $10, A → B, 1920×1080.');
  assert.match(s, /See the guide or a link to bare\.org, mail ada@example\.com\./);
  assert.ok(!/https?:|www\./.test(s));
  assert.ok(!/[\u{1F300}-\u{1FAFF}‍️\u{1F1E6}-\u{1F1FF}]/u.test(s), 'no emoji, joiners or flags left');
  assert.ok(!s.includes('[1]') && !s.includes('x^2'));
  assert.match(s, /costs \$5 and \$10/);
  assert.match(s, /A then B, 1920 by 1080\./);
});

test('speakable turns headings and list items into sentences', () => {
  const s = speakable('# Getting started\n\nTwo steps:\n\n- install it\n- run it\n  1. nested step\n\n## Done');
  assert.deepEqual(s.split('\n\n'), ['Getting started.', 'Two steps:', 'install it.', 'run it.', 'nested step.', 'Done.']);
});

test('speakable reads small tables row by row and summarizes large ones', () => {
  const small = speakable('| Plan | Price |\n|---|---|\n| Free | $0 |\n| Pro | $12 |');
  assert.deepEqual(small.split('\n\n'), ['Plan: Free, Price: $0.', 'Plan: Pro, Price: $12.']);
  const rows = Array.from({ length: 7 }, (_, i) => `| r${i} | ${i} |`).join('\n');
  assert.equal(speakable(`| a | b |\n|---|---|\n${rows}`), NOTES.table(7));
  assert.equal(speakable('| a | b | c | d | e |\n|---|---|---|---|---|\n| 1 | 2 | 3 | 4 | 5 |'), NOTES.table(1));
});

test('speakable says "mostly code" instead of reading fragments', () => {
  assert.equal(speakable(`Here:\n\n\`\`\`js\n${'const a = 1;\n'.repeat(80)}\`\`\``), NOTES.mostlyCode);
  // Real prose around code is still read.
  const s = speakable(`${paragraph(0, 4)}\n\n\`\`\`js\n${'x();\n'.repeat(200)}\`\`\``);
  assert.ok(s.startsWith('Sentence a') && s.endsWith(NOTES.code));
  // A short but real explanation next to a long fix is read (with the code notice), not dropped as "mostly code".
  const fix = 'The bug is an off-by-one in the loop: it reads one item past the end of the list.\n\n'
    + `\`\`\`python\n${'for i in range(len(items)):\n    total += items[i]  # keep a running sum\n'.repeat(45)}\`\`\`\n\n`
    + 'Change `range(len(items) + 1)` to `range(len(items))` and the IndexError goes away. Everything else can stay as it is.';
  const read = speakable(fix);
  assert.notEqual(read, NOTES.mostlyCode);
  assert.match(read, /^The bug is an off-by-one in the loop: it reads one item past the end of the list\./);
  assert.match(read, /the IndexError goes away\. Everything else can stay as it is\.$/);
  assert.equal(read.split(NOTES.code).length - 1, 1);
  // Fragments next to a lot of code are still summed up.
  assert.equal(speakable(`Fixed version:\n\n\`\`\`js\n${'run();\n'.repeat(400)}\`\`\``), NOTES.mostlyCode);
  assert.equal(speakable(''), '');
});

test('speakable caps an answer at a sentence end (owner 24,000; testers 8,000)', () => {
  const md = Array.from({ length: 40 }, (_, i) => paragraph(i * 6, 6)).join('\n\n');
  assert.ok(md.length > 30_000);
  const t = speakable(md, { max: READ_LIMITS.tester });
  assert.ok(t.length <= READ_LIMITS.tester && t.length > READ_LIMITS.tester * 0.9);
  assert.match(t, /\.$/);
  assert.ok(speakable(md).length <= READ_LIMITS.owner);
});

test('without marked, speakable falls back to a line-by-line pass over the same rules', () => {
  const m = globalThis.marked;
  delete globalThis.marked;
  try {
    const s = speakable('# Title 🚀\n\nRead [this](https://x.dev/a), not https://www.bare.org/p, on 2026-09-30.\n\n- one\n- two\n\n```js\nx()\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |');
    assert.deepEqual(s.split('\n\n'), ['Title.', 'Read this, not a link to bare.org, on 2026-09-30.', 'one. two.', NOTES.code, 'A, B. 1, 2.']);
  } finally { globalThis.marked = m; }
});

// ── segments ──
test('segments: a short first piece, then paragraph-sized ones, never over 1,000 chars or mid-word', () => {
  const segs = segments(LONG, 'en');
  assert.ok(segs.length >= 4);
  assert.ok(segs[0].length <= READ_LIMITS.first);
  assert.equal(segs[0], sentenceOf(0), 'two 128-char sentences don’t fit in 220');
  assert.equal(segments(`It works well enough now. It also scales well. ${paragraph(0, 3)}`, 'en')[0], 'It works well enough now. It also scales well.', 'at most two sentences');
  assert.equal(segments(`Yes. It works. ${paragraph(0, 3)}`, 'en')[0], `Yes. It works. ${sentenceOf(0)}`, 'sentences under 15 characters don’t count toward the two');
  assert.equal(segments(`${sentenceOf(0, 5)}\n\n${sentenceOf(1, 5)}`, 'en').length, 1, 'a short answer is one request');
  for (const s of segs) assert.ok(s.length <= 1000, `${s.length} chars`);
  assert.deepEqual(segs.join(' ').split(/\s+/), LONG.split(/\s+/), 'every word, in order, none split');
  assert.ok(segs.slice(1, -1).every((s) => s.endsWith('.')), 'later pieces end at a sentence');
});

test('segments split a 3,000-char single sentence at clause breaks or spaces', () => {
  const one = Array.from({ length: 450 }, (_, i) => `term${i}`).join(' ').padEnd(3000, ' z').trim();
  assert.ok(one.length >= 2990);
  const segs = segments(one, 'en');
  assert.ok(segs[0].length <= READ_LIMITS.first && segs.length >= 4);
  for (const s of segs) assert.ok(s.length <= READ_LIMITS.target);
  assert.equal(segs.join(' '), one);
  const clauses = Array.from({ length: 60 }, (_, i) => `clause number ${i} goes here`).join('; ');
  const cut = segments(clauses, 'en');
  assert.ok(cut.slice(0, -1).every((s) => s.endsWith(';')), 'prefers a clause break');
  assert.deepEqual(segments('', 'en'), []);
  assert.deepEqual(segments('Short.', 'not a language tag!'), ['Short.']);
});

// ── cache keys, LRU, device voice ──
test('cacheKey changes with the brief version, the voice and the text', async () => {
  const a = await cacheKey('atelier', 'Hello there.');
  assert.match(a, /^\/__tts\/[0-9a-f]{64}$/);
  assert.equal(await cacheKey('atelier', 'Hello there.', TTS_BRIEF_V), a);
  assert.notEqual(await cacheKey('atelier', 'Hello there.', TTS_BRIEF_V + 1), a);
  assert.notEqual(await cacheKey('sulafat', 'Hello there.'), a);
  assert.notEqual(await cacheKey('atelier', 'Hello there!'), a);
  assert.equal(previewKey('sulafat'), `/__tts/preview/v${TTS_BRIEF_V}/${PREVIEW_ID}/sulafat`);
  assert.notEqual(previewKey('sulafat', TTS_BRIEF_V, previewId('Another line.')), previewKey('sulafat'));
  assert.notEqual(previewKey('atelier'), previewKey('atelier', 1), 'v80 moved the brief version: old Atelier clips are never replayed');
});

test('lruAdd evicts the oldest clips past the count or byte cap; lruTouch moves a hit to the end', () => {
  const cap = { clips: 3, bytes: 100 };
  let { list, evicted } = lruAdd([], 'a', 10, cap);
  ({ list, evicted } = lruAdd(list, 'b', 10, cap));
  ({ list, evicted } = lruAdd(list, 'c', 10, cap));
  assert.deepEqual(evicted, []);
  list = lruTouch(list, 'a');
  ({ list, evicted } = lruAdd(list, 'd', 10, cap));
  assert.deepEqual(evicted, ['b'], 'b is the least recently used after a was touched');
  ({ list, evicted } = lruAdd(list, 'e', 95, cap));
  assert.deepEqual(list.map((e) => e[0]), ['e']);
  assert.deepEqual(evicted, ['c', 'a', 'd']);
  assert.deepEqual(lruAdd(list, 'huge', 10 ** 9, cap).list.map((e) => e[0]), ['huge'], 'the newest clip always stays');
  assert.deepEqual(lruAdd([['x', 1], 'junk'], 'x', 2, CACHE_CAP).list, [['x', 2]]);
});

test('pickDeviceVoice prefers a Natural/Enhanced voice in the language and never a novelty voice', () => {
  const V = (name, lang, extra = {}) => ({ name, lang, localService: true, default: false, ...extra });
  const voices = [V('Fred', 'en-US', { default: true }), V('Zarvox', 'en-US'), V('Samantha', 'en-US'), V('Daniel (Enhanced)', 'en-GB'),
    V('Microsoft Ava Online (Natural) - English (United States)', 'en-US', { localService: false }), V('Amélie', 'fr-CA')];
  assert.equal(pickDeviceVoice(voices, 'en-US').name, 'Microsoft Ava Online (Natural) - English (United States)');
  assert.equal(pickDeviceVoice(voices.filter((v) => !/Natural/.test(v.name)), 'en-US').name, 'Daniel (Enhanced)');
  assert.equal(pickDeviceVoice([V('Fred', 'en-US', { default: true }), V('Samantha', 'en_US')], 'en-US').name, 'Samantha');
  assert.equal(pickDeviceVoice(voices, 'fr-FR').name, 'Amélie');
  assert.equal(pickDeviceVoice(voices, 'de-DE'), null);
  assert.equal(pickDeviceVoice([], 'en'), null);
});

test('silentWav is a valid tiny RIFF/WAVE data URL', () => {
  const url = silentWav();
  assert.match(url, /^data:audio\/wav;base64,/);
  const b = Buffer.from(url.split(',')[1], 'base64');
  assert.equal(b.subarray(0, 4).toString(), 'RIFF');
  assert.equal(b.subarray(8, 12).toString(), 'WAVE');
  assert.equal(b.readUInt32LE(40), b.length - 44);
  assert.ok(b.subarray(44).every((x) => x === 128));
});

// ── the player ──
function rig(over = {}) {
  const calls = [], toasts = [], states = [], refusals = [], refusalOpts = [], signouts = [], responses = [], audios = [], spoken = [];
  let urls = 0;
  class FakeAudio extends EventTarget {
    constructor() { super(); audios.push(this); Object.assign(this, { paused: true, ended: false, currentTime: 0, playbackRate: 1, defaultPlaybackRate: 1, preservesPitch: false, plays: [], s: '' }); }
    get src() { return this.s; }
    set src(v) { this.s = v; this.currentTime = 0; this.ended = false; }
    removeAttribute(n) { if (n === 'src') this.s = ''; }
    load() {}
    play() {
      this.plays.push(this.s);
      if (over.denyPlay && !this.s.startsWith('data:')) return Promise.reject(new DOMException('no gesture', 'NotAllowedError'));
      this.paused = false;
      queueMicrotask(() => { if (!over.stuck) this.currentTime += 0.5; this.dispatchEvent(new Event('playing')); });
      return Promise.resolve();
    }
    pause() { if (this.paused) return; this.paused = true; this.dispatchEvent(new Event('pause')); }
    finish() { this.ended = true; this.paused = true; this.dispatchEvent(new Event('pause')); this.dispatchEvent(new Event('ended')); }
  }
  const voices = over.voices || [{ name: 'Fred', lang: 'en-US', default: true }, { name: 'Ava (Natural)', lang: 'en-US' }];
  const speech = { cancels: 0, getVoices: () => voices, speak: (u) => spoken.push(u), cancel() { this.cancels++; } };
  class Utterance { constructor(text) { this.text = text; } }
  const session = { handlers: {}, metadata: null, playbackState: 'none', setActionHandler(a, h) { this.handlers[a] = h; } };
  class Meta { constructor(o) { Object.assign(this, o); } }
  const store = new Map();
  const storage = over.storage || { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const ok = (i) => new Response(new Uint8Array([i + 1, 2, 3]), { headers: { 'content-type': 'audio/wav', 'x-tester-allowance': '{"dayLeft":1,"monthLeft":2}' } });
  const reader = createReader({
    apiHeaders: () => ({ 'content-type': 'application/json', 'x-app-pass': 'pw' }),
    getSettings: () => over.settings || { voice: 'atelier', speed: 1.1 },
    isTester: () => Boolean(over.tester),
    toast: (m) => toasts.push(m),
    onState: (id, s) => states.push(`${id}:${s}`),
    onResponse: (r) => responses.push(r.status),
    ...(over.noRefusal ? {} : { onRefusal: (e, o) => { refusals.push(e); refusalOpts.push(o); } }),
    // onSignedOut(e, reader): what app.js does for a tester's 401 (it signs them out, which stops the read)
    ...(over.onSignedOut ? { onSignedOut: (e) => { signouts.push(e); over.onSignedOut(e, reader); } } : {}),
    ...('signedIn' in over ? { signedIn: () => over.signedIn } : {}),
    allowedVoices: over.allowed ? () => over.allowed : undefined,
    fetch: async (url, init) => {
      const c = { url, method: init.method, headers: new Headers(init.headers), body: JSON.parse(init.body) };
      calls.push(c);
      return (over.respond || ok)(calls.length - 1, c);
    },
    Audio: FakeAudio,
    URL: { createObjectURL: () => `blob:fake/${++urls}`, revokeObjectURL() {} },
    speech, Utterance, caches: over.caches ?? null, storage, mediaSession: session, MediaMetadata: Meta,
    online: () => !over.offline, lang: () => 'en-US', stallMs: over.stallMs ?? 25,
  });
  return { reader, calls, toasts, states, refusals, refusalOpts, signouts, responses, audios, spoken, speech, session, storage, el: () => audios[0] };
}
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const clip = (bytes) => new Response(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), { headers: { 'content-type': 'audio/wav' } });

test('a tap starts the AI voice inside the gesture, streams segments in order and prefetches two ahead', async () => {
  const r = rig();
  const segs = segments(speakable(LONG), 'en-US');
  r.reader.toggle('e1', LONG, null, { title: 'What is Atelier?', album: 'A thread' });
  // Synchronously, before any await: the element exists and play() was called on the silent unlock clip.
  assert.equal(r.reader.stateFor('e1'), 'preparing');
  assert.equal(r.el().plays.length, 1);
  assert.match(r.el().plays[0], /^data:audio\/wav;base64,/);
  assert.equal(r.el().playbackRate, 1.1);
  assert.deepEqual(r.toasts, [SAY.first]);
  await until(() => r.reader.stateFor('e1') === 'playing', 'playing');
  assert.equal(r.el().src, r.el().plays.at(-1));
  assert.match(r.el().src, /^blob:fake\//);
  await until(() => r.calls.length === 3, 'two prefetches');
  await wait(20);
  assert.equal(r.calls.length, 3, 'never more than two segments ahead');
  const c = r.calls[0];
  assert.equal(c.url, '/api/tts');
  assert.equal(c.method, 'POST');
  assert.equal(c.headers.get('x-app-pass'), 'pw');
  assert.equal(c.headers.get('content-type'), 'application/json');
  assert.deepEqual(r.calls.map((x) => x.body), segs.slice(0, 3).map((text) => ({ voice: 'atelier', text })), 'only {voice, text}');
  assert.deepEqual(r.responses, [200, 200, 200]);
  // Media Session: lock-screen metadata and controls.
  assert.equal(r.session.metadata.title, 'What is Atelier?');
  assert.equal(r.session.metadata.artist, 'Atelier · Read aloud');
  assert.deepEqual(r.session.metadata.artwork.map((a) => a.src), ['/icons/atelier-v2-512.png', '/icons/atelier-v2-192.png']);
  assert.equal(r.session.playbackState, 'playing');
  // The segment ends: the next one plays and one more is prefetched.
  r.el().finish();
  await until(() => r.calls.length === 4, 'next prefetch');
  await until(() => r.el().plays.length === 3, 'second segment plays');
  assert.equal(r.reader.stateFor('e1'), 'playing');
  // Same entry: pause, resume. The lock-screen buttons do the same.
  r.reader.toggle('e1', LONG);
  assert.equal(r.reader.stateFor('e1'), 'paused');
  assert.equal(r.el().paused, true);
  assert.equal(r.session.playbackState, 'paused');
  r.session.handlers.play();
  assert.equal(r.reader.stateFor('e1'), 'playing');
  r.session.handlers.pause();
  assert.equal(r.reader.stateFor('e1'), 'paused');
  r.reader.toggle('e1', LONG);
  assert.equal(r.reader.stateFor('e1'), 'playing');
  // Play every remaining segment to the end.
  for (let i = 2; i < segs.length; i++) {
    const prev = r.el().src;
    r.el().finish();
    await until(() => r.el().src !== prev, `segment ${i + 1}`);
  }
  r.el().finish();
  await until(() => r.reader.stateFor('e1') === 'idle', 'idle at the end');
  assert.equal(r.calls.length, segs.length, 'each segment fetched once');
  assert.equal(r.session.metadata, null);
  assert.equal(r.session.handlers.play, null);
  assert.deepEqual(r.states.filter((s, i, a) => s !== a[i - 1]).slice(0, 3), ['e1:preparing', 'e1:playing', 'e1:paused']);
  assert.equal(r.states.at(-1), 'e1:idle');
});

test('a second answer stops the first; stop() requests nothing new; a tap while preparing cancels', async () => {
  const r = rig();
  r.reader.toggle('e1', LONG);
  await until(() => r.calls.length === 3, 'first read fetching');
  r.reader.toggle('e2', 'Just one short sentence here.');
  assert.equal(r.reader.stateFor('e1'), 'idle');
  assert.equal(r.reader.stateFor('e2'), 'preparing');
  await until(() => r.reader.stateFor('e2') === 'playing', 'second read plays');
  r.reader.stop();
  assert.equal(r.reader.stateFor('e2'), 'idle');
  assert.equal(r.el().src, '');
  const n = r.calls.length;
  r.el().finish();
  await wait(30);
  assert.equal(r.calls.length, n, 'nothing new is fetched after stop');
  r.reader.toggle('e3', LONG);
  r.reader.toggle('e3', LONG);
  assert.equal(r.reader.stateFor('e3'), 'idle');
  r.reader.toggle('e4', '```js\nx\n```');
  assert.equal(r.reader.stateFor('e4'), 'preparing', 'a code-only answer still says so');
  r.reader.stop();
  r.reader.toggle('e5', '');
  assert.equal(r.toasts.at(-1), SAY.nothing);
  assert.equal(r.reader.stateFor('e5'), 'idle');
});

test('every AI voice plays whole clips; a system pause and the lock-screen next button are honored', async () => {
  const r = rig();
  r.reader.toggle('e1', LONG);
  await until(() => r.el().src.startsWith('blob:') && r.reader.stateFor('e1') === 'playing', 'blob path');
  const first = r.el().src;
  r.el().pause(); // e.g. headphones unplugged
  assert.equal(r.reader.stateFor('e1'), 'paused');
  r.session.handlers.play();
  assert.equal(r.reader.stateFor('e1'), 'playing');
  r.session.handlers.nexttrack();
  await until(() => r.el().src !== first, 'next segment');
  r.session.handlers.stop();
  assert.equal(r.reader.stateFor('e1'), 'idle');
});

test('the device voice: chosen in Settings, sentence by sentence, best local voice, rate 0.95 × speed', async () => {
  const r = rig({ settings: { voice: 'device', speed: 1.25 } });
  r.reader.toggle('e1', '# Hello\n\nFirst sentence here. Second one follows!');
  assert.equal(r.calls.length, 0);
  assert.deepEqual(r.spoken.map((u) => u.text), ['Hello.'], 'the first utterance starts inside the tap');
  assert.equal(r.spoken[0].voice.name, 'Ava (Natural)');
  assert.equal(r.spoken[0].rate, DEVICE_RATE * 1.25);
  assert.equal(r.reader.stateFor('e1'), 'playing');
  r.spoken[0].onend();
  assert.equal(r.spoken.at(-1).text, 'First sentence here.');
  r.reader.toggle('e1');
  assert.equal(r.reader.stateFor('e1'), 'paused');
  assert.equal(r.speech.cancels, 1);
  r.spoken.at(-1).onerror({ error: 'interrupted' }); // what cancel() causes: ignored
  assert.equal(r.spoken.length, 2);
  r.reader.toggle('e1');
  assert.equal(r.spoken.at(-1).text, 'First sentence here.', 'resume restarts the sentence');
  r.spoken.at(-1).onend();
  r.spoken.at(-1).onend();
  assert.equal(r.reader.stateFor('e1'), 'idle');
  assert.deepEqual(r.toasts, [], 'no AI-voice toast for the device voice');
});

test('offline: the device voice reads it, with a gentle toast and no request', () => {
  const r = rig({ offline: true });
  r.reader.toggle('e1', 'One. Two.');
  assert.deepEqual(r.toasts, [SAY.offline]);
  assert.equal(r.calls.length, 0);
  assert.equal(r.spoken[0].text, 'One.');
});

test('a tester refusal (402) hands over to the device voice at the failed segment', async () => {
  const r = rig({ tester: true, respond: (i) => (i === 1 ? json(402, { error: 'Today’s allowance is used up.', code: 'tester_budget', scope: 'day' }) : new Response(new Uint8Array([9]), { headers: { 'content-type': 'audio/mpeg' } })) });
  const segs = segments(speakable(LONG, { max: READ_LIMITS.tester }), 'en-US');
  r.reader.toggle('e1', LONG);
  await until(() => r.reader.stateFor('e1') === 'playing', 'first segment plays');
  assert.equal(r.spoken.filter((u) => u.text.trim()).length, 0);
  r.el().finish();
  await until(() => r.refusals.length === 1, 'refusal reported');
  assert.equal(r.refusals[0].status, 402);
  assert.equal(r.refusals[0].code, 'tester_budget');
  assert.equal(r.refusals[0].scope, 'day');
  assert.ok(!r.toasts.includes(SAY.budget), 'app.js shows its own budget message');
  const said = r.spoken.filter((u) => u.text.trim());
  assert.ok(segs[1].startsWith(said[0].text), 'reading resumes at segment 2');
  assert.equal(r.reader.stateFor('e1'), 'playing');
  assert.equal(r.el().src, '', 'the audio element is released');
  for (const c of r.calls) assert.ok(spokenUnits(c.body.text) <= TTS_LIMITS.testerChars && validateTts({ voice: 'atelier', text: c.body.text }, { tester: true }).ok);
  r.reader.stop();
  assert.equal(r.reader.stateFor('e1'), 'idle');
  assert.ok(r.speech.cancels >= 1);
});

test('provider trouble (502) reads with the device voice; 429 is retried once; without onRefusal a 402 toasts', async () => {
  const down = rig({ respond: () => json(502, { error: 'Read aloud is unavailable right now.', code: 'tts_unavailable' }) });
  down.reader.toggle('e1', 'Alpha one. Beta two.');
  await until(() => down.spoken.some((u) => u.text === 'Alpha one.'), 'device voice');
  assert.ok(down.toasts.includes(SAY.down));
  let n = 0;
  const busy = rig({ respond: () => (n++ ? new Response(new Uint8Array([1]), { headers: { 'content-type': 'audio/mpeg' } }) : json(429, { code: 'tts_busy' }, { 'retry-after': '0.5' })) });
  busy.reader.toggle('e1', 'Alpha one.');
  await until(() => busy.reader.stateFor('e1') === 'playing' && busy.el().src.startsWith('blob:'), 'retried and playing');
  assert.equal(busy.calls.length, 2);
  assert.ok(!busy.toasts.includes(SAY.busy));
  const plain = rig({ noRefusal: true, respond: () => json(402, { code: 'tester_budget' }) });
  plain.reader.toggle('e1', 'Alpha one.');
  await until(() => plain.toasts.includes(SAY.budget), 'budget toast');
  const signedOut = rig({ respond: () => json(401, { error: 'Passcode required.' }) });
  signedOut.reader.toggle('e1', 'Alpha one.');
  await until(() => signedOut.toasts.includes(SAY.passcode), 'passcode toast');
});

test('allowedVoices: another allowed AI voice stands in; none → the device voice, said once', async () => {
  const other = rig({ allowed: ['sulafat'] });
  other.reader.toggle('e1', 'Alpha one.');
  await until(() => other.calls.length === 1, 'request');
  assert.equal(other.calls[0].body.voice, 'sulafat');
  // a saved retired voice (cedar) reads as the Atelier voice
  const old = rig({ settings: { voice: 'cedar', speed: 1 }, allowed: ['atelier', 'sulafat'] });
  old.reader.toggle('e1', 'Alpha one.');
  await until(() => old.calls.length === 1, 'request');
  assert.equal(old.calls[0].body.voice, 'atelier');
  const none = rig({ allowed: [] });
  none.reader.toggle('e1', 'Alpha one.');
  none.reader.stop();
  none.reader.toggle('e2', 'Alpha one.');
  assert.deepEqual(none.toasts, [SAY.plan]);
  assert.equal(none.calls.length, 0);
});

test('previews: {voice, preview: true}, a second tap stops; the device preview speaks locally', async () => {
  const r = rig();
  r.reader.preview('sulafat');
  assert.equal(r.reader.stateFor('preview:sulafat'), 'preparing');
  await until(() => r.reader.stateFor('preview:sulafat') === 'playing', 'preview plays');
  assert.deepEqual(r.calls[0].body, { voice: 'sulafat', preview: true });
  assert.equal(r.session.metadata, null, 'previews leave the lock screen alone');
  r.reader.preview('sulafat');
  assert.equal(r.reader.stateFor('preview:sulafat'), 'idle');
  r.reader.preview('device');
  assert.equal(r.reader.stateFor('preview:device'), 'playing');
  assert.match(r.spoken.at(-1).text, /device’s own voice/);
  r.reader.preview('atelier'); // switching voices stops the device preview
  assert.equal(r.reader.stateFor('preview:device'), 'idle');
  assert.deepEqual(r.toasts, [], 'no first-read toast for previews');
});

test('clips are cached on the device (Cache Storage + LRU index) and clearCache removes them', async () => {
  const buckets = new Map(), deleted = [];
  const caches = {
    async open(name) {
      if (!buckets.has(name)) buckets.set(name, new Map());
      const m = buckets.get(name);
      return { match: async (k) => m.get(k)?.clone(), put: async (k, res) => { m.set(k, res); }, delete: async (k) => m.delete(k) };
    },
    async delete(name) { deleted.push(name); return buckets.delete(name); },
  };
  const a = rig({ caches });
  a.reader.toggle('e1', 'Alpha one. Beta two.');
  await until(() => buckets.get(TTS_CACHE)?.size === 1, 'clip cached');
  const key = await cacheKey('atelier', 'Alpha one. Beta two.');
  assert.ok(buckets.get(TTS_CACHE).has(key));
  assert.equal(buckets.get(TTS_CACHE).get(key).headers.get('content-type'), 'audio/wav');
  assert.deepEqual(JSON.parse(a.storage.getItem('atelier.ttsIndex')), [[key, 3]]);
  a.reader.stop();
  // Another page load (a new reader) replays it from the cache with no request.
  const b = rig({ caches, storage: a.storage });
  b.reader.toggle('e1', 'Alpha one. Beta two.');
  await until(() => b.reader.stateFor('e1') === 'playing' && b.el().src.startsWith('blob:'), 'cached replay');
  assert.equal(b.calls.length, 0);
  await b.reader.clearCache();
  assert.equal(b.reader.stateFor('e1'), 'idle');
  assert.ok(deleted.includes(TTS_CACHE));
  assert.equal(b.storage.getItem('atelier.ttsIndex'), null);
  assert.equal(buckets.has(TTS_CACHE), false);
});

test('iOS guards: a silent play() gets its source set again once, then asks for a tap; NotAllowedError pauses', async () => {
  const r = rig({ stuck: true });
  r.reader.toggle('e1', 'Alpha one.');
  await until(() => r.el().plays.length === 2, 'segment play');
  const url = r.el().plays[1];
  await until(() => r.el().plays.length === 3, 'source set again');
  assert.equal(r.el().plays[2], url);
  await until(() => r.reader.stateFor('e1') === 'paused', 'tap to resume');
  assert.equal(r.toasts.at(-1), SAY.resume);
  r.reader.toggle('e1', 'Alpha one.');
  assert.equal(r.reader.stateFor('e1'), 'playing');
  assert.equal(r.el().plays.at(-1), url);
  r.reader.stop();
  const denied = rig({ denyPlay: true });
  denied.reader.toggle('e1', 'Alpha one.');
  await until(() => denied.reader.stateFor('e1') === 'paused', 'paused after NotAllowedError');
  assert.equal(denied.toasts.at(-1), SAY.resume);
  denied.reader.stop();
});

test('the first-read note is shown once per device; setSpeed applies to the playing clip', async () => {
  const r = rig();
  r.reader.toggle('e1', 'Alpha one.');
  r.reader.setSpeed(1.25);
  assert.equal(r.el().playbackRate, 1.25);
  r.reader.setSpeed(7);
  assert.equal(r.el().playbackRate, 1);
  r.reader.stop();
  r.reader.toggle('e1', 'Alpha one.');
  assert.deepEqual(r.toasts, [SAY.first]);
  assert.equal(r.storage.getItem('atelier.ttsNoted'), '1');
  r.reader.stop();
});

// ── review fixes: the text ──
test('speakable leaves out \\( \\) and \\[ \\] math (marked drops the backslash) and reads a lone $x$ as its letter', () => {
  assert.equal(speakable('The area is \\(A = \\pi r^2\\) for a circle.'), 'The area is the formula on screen for a circle.');
  const display = speakable('A display block\n\\[\n\\frac{a}{b} = \\sqrt{x_1^2 + x_2^2}\n\\]\nand after.');
  assert.equal(display, 'A display block the formula on screen and after.');
  const own = speakable('Solve it:\n\n\\[\n\\frac{a}{b} = \\sqrt{x_1^2 + x_2^2}\n\\]\n\nThen check.\n\n$$E = mc^2$$');
  assert.deepEqual(own.split('\n\n'), ['Solve it:', NOTES.formula, 'Then check.'], 'a formula on its own is said once');
  assert.equal(speakable('Let $x$ be small and $n$ large.'), 'Let x be small and n large.');
  assert.ok(!/[\\^{}]/.test(speakable('Use \\(x_1 + x_2\\) and \\[y^2\\] here.')));
  assert.match(speakable('Prices: $5 and $10.'), /\$5 and \$10/);
  const m = globalThis.marked;
  delete globalThis.marked;
  try { assert.equal(speakable('The area is \\(A = \\pi r^2\\) for a circle.'), 'The area is the formula on screen for a circle.'); } finally { globalThis.marked = m; }
});

test('long inline code becomes "the code on screen"; struck-out text and ASCII arrows', () => {
  assert.equal(speakable('To fix it, run `npm install --save-dev @types/node`.'), 'To fix it, run the code on screen.');
  assert.equal(speakable('Set `process.env.ATELIER_TTS_DEFAULT_VOICE` to marin.'), 'Set the code on screen to marin.');
  assert.equal(speakable('Run `a-very-long-command --with flags` `and-another-long-command --too` now, then restart the app.'), 'Run the code on screen now, then restart the app.');
  assert.equal(speakable('Now ~~$49~~ **$29** for the first year.'), 'Now $29 for the first year.');
  assert.equal(speakable('The meeting is ~~Tuesday~~ Wednesday.'), 'The meeting is Wednesday.');
  assert.equal(speakable('Open Settings -> General -> Read aloud. Also a => b, File --> Save.'), 'Open Settings then General then Read aloud. Also a then b, File then Save.');
  assert.equal(speakable('Open `Settings -> General`.'), 'Open Settings then General.');
  assert.equal(speakable('A -> then B.'), 'A then B.', 'no "then then"');
  assert.equal(speakable('Primero → luego.', { lang: 'es' }), 'Primero, luego.');
});

test('the fallback pass (no marked) handles inline code, rules and "--" lines like the marked pass', () => {
  const m = globalThis.marked;
  delete globalThis.marked;
  try {
    assert.equal(speakable('Then run `node scripts/a-very-long-script-name.mjs --flag` now.'), 'Then run the code on screen now.');
    assert.equal(speakable('Run `npm start` first.'), 'Run npm start first.');
    assert.equal(speakable('-- not a rule\n--flag is an option'), '-- not a rule --flag is an option');
    assert.equal(speakable('Use the --flag option.\n--verbose prints more.'), 'Use the --flag option. --verbose prints more.');
    assert.deepEqual(speakable('Before.\n\n---\n\n| A | B |\n|:-|-:|\n| 1 | 2 |').split('\n\n'), ['Before.', 'A, B. 1, 2.']);
    assert.equal(speakable('Now ~~$49~~ $29.'), 'Now $29.');
  } finally { globalThis.marked = m; }
});

test('capText cuts CJK at a sentence end, and hard at the cap when there is none', () => {
  const zh = '这是一个很长的中文句子，用来测试朗读的长度限制。'.repeat(700); // 24 chars a sentence, no spaces
  const t = speakable(zh, { lang: 'zh-CN', max: 8_000 });
  assert.ok(t.length > 7_900 && t.length <= 8_000, String(t.length));
  assert.ok(t.endsWith('。'));
  const run = '今日はいい天気'.repeat(1_400); // no punctuation at all
  assert.equal(speakable(run, { lang: 'ja', max: 8_000 }).length, 8_000);
  assert.ok(speakable(`# 标题\n\n${zh}`, { lang: 'zh-CN', max: 8_000 }).length > 7_900);
});

test('sentence splits: abbreviations and initials stay with their sentence; the fallback keeps decimals and domains', () => {
  assert.deepEqual(segments('Good sleep starts with a routine. Dr. Patel suggests three simple steps that anyone can follow tonight.', 'en-US'),
    ['Good sleep starts with a routine. Dr. Patel suggests three simple steps that anyone can follow tonight.']);
  assert.deepEqual(segments('Short answer: yes. The U.S. Senate still has to vote on it next week.', 'en'), ['Short answer: yes. The U.S. Senate still has to vote on it next week.']);
  const Seg = Intl.Segmenter;
  delete Intl.Segmenter;
  try {
    assert.deepEqual(segments('Version 2.5 is out. See example.com for details.', 'en-x-fallback1'), ['Version 2.5 is out. See example.com for details.']);
    const segs = segments(`It costs $3.99 and weighs 1.5 kg. ${'Then more text follows here. '.repeat(20)}`, 'en-x-fallback2');
    assert.ok(segs.join(' ').includes('$3.99 and weighs 1.5 kg.'));
    assert.deepEqual(segments('你好。我很好！真的吗？', 'zh-x-fallback3'), ['你好。我很好！真的吗？']);
    const many = segments(`你好。${'我很好！'.repeat(120)}`, 'zh-x-fallback4');
    assert.ok(many.length > 1 && many.every((x) => spokenUnits(x) <= READ_LIMITS.target));
    assert.deepEqual(segments('Dr. Patel came. Then he left.', 'en-x-fallback5'), ['Dr. Patel came. Then he left.']);
  } finally { Intl.Segmenter = Seg; }
});

test('segments are sized in spoken units: number-heavy and CJK pieces are shorter and every one passes the tester cap', () => {
  const nums = Array.from({ length: 120 }, (_, i) => `Account ${987654321987654 + i} owes ${1000 + i}.`).join(' ');
  const zh = '这是一个很长的中文句子，用来测试朗读的长度限制和分段，确保每一段都不会太长。'.repeat(60);
  for (const [text, lang] of [[nums, 'en'], [zh, 'zh-CN'], ['日本語の文章です。'.repeat(300), 'ja']]) {
    const segs = segments(text, lang);
    assert.ok(segs.length > 1);
    assert.ok(spokenUnits(segs[0]) <= READ_LIMITS.first);
    for (const s of segs) {
      assert.ok(spokenUnits(s) <= READ_LIMITS.target, `${spokenUnits(s)} units`);
      assert.ok(validateTts({ voice: 'sulafat', text: s }, { tester: true }).ok);
    }
    assert.equal(segs.join('').replace(/\s/g, ''), text.replace(/\s/g, ''));
  }
});

test('textLang: the answer’s script (and, for Latin text, its common words) picks the reading language', () => {
  assert.equal(textLang('これは日本語の文章です。漢字も含みます。', 'en-US'), 'ja');
  assert.equal(textLang('这是中文的回答，里面有一些 English words。', 'en-US'), 'zh-CN');
  assert.equal(textLang('这是中文的回答。', 'zh-TW'), 'zh-TW', 'the device’s own variant is kept');
  assert.equal(textLang('漢字だけ', 'ja-JP'), 'ja-JP');
  assert.equal(textLang('한국어 답변입니다.', 'en'), 'ko');
  assert.equal(textLang('Привет, как дела?', 'uk-UA'), 'uk-UA');
  assert.equal(textLang('Привет, как дела?', 'en-US'), 'ru');
  assert.equal(textLang('The quick answer is that it works for you and the team.', 'ja-JP'), 'en');
  assert.equal(textLang('Primero abre la puerta y luego mide el espacio para la mesa de la cocina.', 'en-US'), 'es');
  assert.equal(textLang('Hello there, this is the answer for you and it is short.', 'en-GB'), 'en-GB');
  assert.equal(textLang('Bonjour', 'fr-FR'), 'fr-FR');
  assert.equal(textLang('', 'de-DE'), 'de-DE');
});

// ── review fixes: the player ──
test('a Japanese answer read with the device voice uses a Japanese voice and lang; Spanish gets no English "then"', () => {
  const voices = [{ name: 'Microsoft Ava Online (Natural) - English (United States)', lang: 'en-US' }, { name: 'Microsoft Nanami Online (Natural) - Japanese (Japan)', lang: 'ja-JP' }];
  const r = rig({ settings: { voice: 'device', speed: 1 }, voices });
  r.reader.toggle('e1', 'これは日本語の答えです。次の文です。');
  assert.equal(r.spoken[0].lang, 'ja');
  assert.match(r.spoken[0].voice.name, /Nanami/);
  r.reader.stop();
  r.reader.toggle('e2', 'Primero abre la puerta → luego mide el espacio para la mesa de la cocina.');
  assert.ok(!/then/.test(r.spoken.at(-1).text));
  assert.equal(r.spoken.at(-1).lang, 'es');
  r.reader.stop();
  r.reader.toggle('e3', 'Plain English text that is read as it is.', null, { lang: 'fr-CA' });
  assert.equal(r.spoken.at(-1).lang, 'fr-CA', 'app.js may name the language');
  r.reader.stop();
});

test('an <audio> error during a clip hands over to the device voice alone: no AI clip plays alongside it', async () => {
  let ctl;
  const r = rig({ respond: (i) => (i === 1 ? new Response(new ReadableStream({ start(c) { ctl = c; } }), { headers: { 'content-type': 'audio/wav' } }) : clip([i + 1])) });
  const segs = segments(speakable(LONG), 'en-US');
  r.reader.toggle('e1', LONG);
  await until(() => r.reader.stateFor('e1') === 'playing' && ctl, 'segment 1 playing, segment 2 waiting');
  const plays = r.el().plays.length;
  r.el().dispatchEvent(new Event('error')); // e.g. a decode error during playback
  assert.ok(r.toasts.includes(SAY.down));
  const said = r.spoken.filter((u) => u.text.trim());
  assert.equal(said.length, 1, 'the device voice starts');
  assert.ok(segs[0].startsWith(said[0].text), 'at the clip that failed');
  ctl.enqueue(new Uint8Array([2])); ctl.close();
  await wait(30);
  assert.equal(r.el().plays.length, plays, 'no whole clip starts');
  assert.equal(r.el().src, '');
  const n = r.calls.length;
  r.spoken.at(-1).onend();
  assert.equal(r.spoken.filter((u) => u.text.trim()).length, 2, 'the device voice carries on');
  await wait(20);
  assert.equal(r.calls.length, n, 'no more AI segments are fetched');
  r.reader.stop();
});

test('stopping during a 429 backoff sends nothing more', async () => {
  const r = rig({ respond: () => json(429, { code: 'tts_busy' }, { 'retry-after': '0.5' }) });
  r.reader.toggle('e1', 'Alpha one.');
  await until(() => r.calls.length === 1, 'first try');
  r.reader.stop();
  await wait(700);
  assert.equal(r.calls.length, 1);
  assert.equal(r.reader.stateFor('e1'), 'idle');
});

test('clips kept in memory are capped by size as well as count', async () => {
  const big = 5 * 1024 * 1024;
  const text = Array.from({ length: 8 }, (_, k) => paragraph(k * 6, 6)).join('\n\n');
  const r = rig({ respond: () => clip(new Uint8Array(big)) });
  const segs = segments(speakable(text), 'en-US');
  assert.ok(segs.length >= 6);
  r.reader.toggle('e1', text);
  for (let i = 0; i < segs.length; i++) {
    await until(() => r.el().plays.length === i + 2, `segment ${i + 1} plays`, 10_000);
    r.el().finish();
  }
  await until(() => r.reader.stateFor('e1') === 'idle', 'the read ends', 10_000);
  assert.equal(r.calls.length, segs.length);
  r.reader.toggle('e1', text); // the first clips no longer fit in the 24 MB kept in memory: they are asked for again
  await until(() => r.calls.length > segs.length, 'segment 1 fetched again', 10_000);
  assert.deepEqual(r.calls[segs.length].body, { voice: 'atelier', text: segs[0] });
  r.reader.stop();
});

test('requests go out in reading order even when the cache keys (SHA-256) finish out of order', async () => {
  const subtle = globalThis.crypto.subtle, real = subtle.digest.bind(subtle);
  let n = 0; // each digest asked for at once finishes before the one asked for just before it
  Object.defineProperty(subtle, 'digest', { configurable: true, writable: true, value: (alg, data) => { const k = n++; return new Promise((res) => setTimeout(() => res(real(alg, data)), Math.max(0, 45 - 15 * k))); } });
  try {
    const r = rig(), segs = segments(speakable(LONG), 'en-US');
    r.reader.toggle('e1', LONG);
    await until(() => r.calls.length === 3, 'three segments asked for');
    assert.deepEqual(r.calls.map((c) => c.body.text), segs.slice(0, 3));
    r.reader.stop();
  } finally { delete subtle.digest; }
});

test('voiceFor: the chosen voice, else the first AI voice the account may use, else the device voice', () => {
  assert.equal(voiceFor('sulafat', null), 'sulafat');
  assert.equal(voiceFor('sulafat', ['atelier', 'sulafat']), 'sulafat');
  assert.equal(voiceFor('sulafat', ['nope', 'atelier']), 'atelier', 'in the account\'s order, as the reader picks');
  assert.equal(voiceFor('atelier', ['device', 'nope', 'sulafat']), 'sulafat');
  assert.equal(voiceFor('sulafat', []), 'device');
  assert.equal(voiceFor('device', ['atelier']), 'device');
  assert.equal(voiceFor('nope', null), DEFAULT_READ_ALOUD.voice);
  // Retired ids (the OpenAI voices) read as the Atelier voice, whether chosen or in an older allow-list.
  for (const old of ['cedar', 'sage']) {
    assert.equal(voiceFor(old, null), 'atelier', old);
    assert.equal(voiceFor(old, ['atelier', 'sulafat']), 'atelier', old);
    assert.equal(voiceFor(old, ['sulafat']), 'sulafat', `${old}: the account's own voice stands in`);
    assert.equal(voiceFor('atelier', [old]), 'atelier', `an allow-list naming ${old} allows the Atelier voice`);
    assert.equal(voiceFor(old, []), 'device');
  }
  // Settings marks what the reader will use: always one of the voices it lists
  for (const allowed of [null, [], ['sulafat'], ['sulafat', 'cedar'], ['sage'], ['nope']]) {
    for (const v of VOICES) assert.ok(voiceChoices(allowed).some((c) => c.id === voiceFor(v.id, allowed)), `${v.id} with ${JSON.stringify(allowed)}`);
  }
});

test('a refused preview (tester out of allowance) just stops: the app says why, with no device-voice promise', async () => {
  const r = rig({ tester: true, respond: () => json(402, { error: 'Today’s allowance is used up.', code: 'tester_budget', scope: 'day' }) });
  r.reader.preview('sulafat');
  await until(() => r.refusals.length === 1, 'refusal reported');
  assert.equal(r.reader.stateFor('preview:sulafat'), 'idle');
  assert.deepEqual(r.refusalOpts, [{ preview: true }], 'app.js leaves out "reading with the device voice"');
  await wait(20);
  assert.deepEqual(r.toasts, [], 'the reader adds nothing of its own');
  assert.equal(r.spoken.filter((u) => u.text.trim()).length, 0, 'nothing is read with the device voice');
  // a read's refusal still hands over to the device voice, and says so
  const read = rig({ tester: true, respond: () => json(402, { code: 'tester_budget', scope: 'day' }) });
  read.reader.toggle('e1', 'Alpha one.');
  await until(() => read.spoken.some((u) => u.text === 'Alpha one.'), 'device voice');
  assert.deepEqual(read.refusalOpts, [{ preview: false }]);
  // without onRefusal the reader says it, in preview words
  const plain = rig({ tester: true, noRefusal: true, respond: () => json(402, { code: 'tester_paused' }) });
  plain.reader.preview('atelier');
  await until(() => plain.toasts.length === 1, 'toast');
  assert.deepEqual(plain.toasts, [SAY.previewBudget]);
});

test('preview failures say what happened in preview words, never "reading with the device voice"', async () => {
  for (const [respond, want, over] of [
    [() => json(401, { error: 'Enter your passcode to use Atelier.' }), SAY.previewPasscode, {}],
    [() => json(401, { code: 'tester_signin' }), SAY.previewSignin, { tester: true }],
    [() => json(403, { code: 'tester_model' }), SAY.previewPlan, { tester: true }],
    [() => json(502, { code: 'tts_unavailable' }), SAY.previewFailed, {}],
  ]) {
    const r = rig({ respond, ...over });
    r.reader.preview('sulafat');
    await until(() => r.toasts.length === 1, want);
    assert.deepEqual(r.toasts, [want]);
    assert.equal(r.reader.stateFor('preview:sulafat'), 'idle');
    assert.equal(r.spoken.filter((u) => u.text.trim()).length, 0);
  }
  for (const k of Object.keys(SAY).filter((x) => x.startsWith('preview'))) assert.doesNotMatch(SAY[k], /device voice/, k);
});

test('a tester whose session ended (401) is handed to the app, which signs them out: the read stops, nothing promised', async () => {
  // app.js: onSignedOut → testerSignedOut('expired') → setTester(null) → reader.clearCache(), which stops the read
  const r = rig({ tester: true, onSignedOut: (e, reader) => reader.clearCache(), respond: () => json(401, { error: 'Your tester session ended — sign in with LinkedIn again.', code: 'tester_signin' }) });
  r.reader.toggle('e1', 'Alpha one. Beta two.');
  await until(() => r.signouts.length === 1, 'app told');
  assert.equal(r.signouts[0].code, 'tester_signin');
  assert.equal(r.reader.stateFor('e1'), 'idle');
  await wait(20);
  assert.deepEqual(r.toasts, [SAY.first], 'no "Sign in again … reading with the device voice" over the sign-in sheet');
  assert.equal(r.spoken.filter((u) => u.text.trim()).length, 0);
  // the cookie gone altogether (a plain 401) is the same for a tester, and for a preview
  const gone = rig({ tester: true, onSignedOut: (e, reader) => reader.stop(), respond: () => json(401, { error: 'Enter your passcode to use Atelier.' }) });
  gone.reader.preview('sulafat');
  await until(() => gone.signouts.length === 1, 'app told (preview)');
  await wait(20);
  assert.deepEqual(gone.toasts, []);
  // an app that keeps the session: the device voice reads, with the sign-in line
  const kept = rig({ tester: true, onSignedOut: () => {}, respond: () => json(401, { code: 'tester_signin' }) });
  kept.reader.toggle('e1', 'Alpha one.');
  await until(() => kept.spoken.some((u) => u.text === 'Alpha one.'), 'device voice');
  assert.ok(kept.toasts.includes(SAY.signin));
  // the owner's 401 is a passcode matter, never a sign-out
  const owner = rig({ onSignedOut: () => {}, respond: () => json(401, { error: 'Passcode required.' }) });
  owner.reader.toggle('e1', 'Alpha one.');
  await until(() => owner.toasts.includes(SAY.passcode), 'passcode toast');
  assert.equal(owner.signouts.length, 0);
});

test('no passcode and no tester session: the device voice reads with the passcode line, previews ask for it, no request', async () => {
  const o = { signedIn: false, allowed: [] }, r = rig(o);
  r.reader.toggle('e1', 'Alpha one.');
  await until(() => r.spoken.some((u) => u.text === 'Alpha one.'), 'device voice');
  assert.deepEqual(r.toasts, [SAY.passcode], 'not "isn’t available on this account"');
  r.reader.toggle('e2', 'Beta two.');
  assert.deepEqual(r.toasts, [SAY.passcode], 'said once');
  r.reader.preview('sulafat');
  assert.deepEqual(r.toasts, [SAY.passcode, SAY.previewPasscode]);
  assert.equal(r.reader.stateFor('preview:sulafat'), 'idle');
  r.reader.preview('device'); // the device voice needs nothing
  assert.equal(r.reader.stateFor('preview:device'), 'playing');
  r.reader.stop();
  assert.equal(r.calls.length, 0, 'nothing sent that could only come back 401');
  // the passcode comes back: the AI voice reads; it goes again: said again
  Object.assign(o, { signedIn: true, allowed: null });
  r.reader.toggle('e3', 'Gamma three.');
  await until(() => r.calls.length === 1, 'AI voice asked for');
  r.reader.stop();
  Object.assign(o, { signedIn: false, allowed: [] });
  r.reader.toggle('e4', 'Delta four.');
  assert.equal(r.toasts.filter((t) => t === SAY.passcode).length, 2);
  r.reader.stop();
  // a voice this account may not use isn't previewed either; one it may use is
  const plan = rig({ tester: true, allowed: ['sulafat'] });
  plan.reader.preview('atelier');
  assert.deepEqual(plan.toasts, [SAY.previewPlan]);
  assert.equal(plan.calls.length, 0);
  plan.reader.preview('sulafat');
  await until(() => plan.calls.length === 1, 'allowed voice previewed');
  plan.reader.stop();
});
