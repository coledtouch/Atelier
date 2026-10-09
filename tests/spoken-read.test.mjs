// Read aloud for spoken requests: a turn whose words were said (Atelier Assist, Talk, the mic) is marked e.spoken, and its
// answer is read aloud by itself when its run ends; typed turns stay silent. Covers the spoken rule (readaloud.js
// spokenFrom), the keyed-launch mark (launch.js), the entry check (data-safety.js), what is read (autoReadText, speakable
// with tables as one line), the reader's auto() / unlock() / blocked play ("Tap to listen"), and app.js's wiring (lifted
// functions run against stubs, as tests/untrusted-turns.test.mjs does).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import '../public/vendor/marked.js'; // the UMD bundle sets globalThis.marked, as the app's <script> tag does
import {
  SPOKEN_FROM, SPOKEN_SHARE, spokenShare, spokenFrom, dropSpoken, wordsOf, autoReadText, AUTO_LINES, speakable, segments, NOTES, SAY,
  createReader, normalizeReadAloud, DEFAULT_READ_ALOUD,
} from '../public/readaloud.js';
import { readLaunch, planLaunch, applyLaunch, QUICK_DEFAULTS, NOTES as LAUNCH_NOTES } from '../public/launch.js';
import { validateBackup } from '../public/data-safety.js';
import { stripThink } from '../public/context.js';

const read = async (p) => (await readFile(new URL(`../${p}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const [APP, HTML, CSS] = await Promise.all(['public/app.js', 'public/index.html', 'public/app.css'].map(read));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, what, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await wait(2); }
}

// ───────────────────────── the spoken rule ─────────────────────────
test('spokenFrom: a send is spoken when at least 60% of its words came from voice; the first source in priority names it', () => {
  assert.equal(SPOKEN_SHARE, 0.6);
  assert.deepEqual([...SPOKEN_FROM], ['assist', 'shortcut', 'talk', 'dictation']);
  const said = (text, from = 'dictation') => [{ text, from }];
  // dictated, sent as is (any capitalization or punctuation Web Speech or the transcriber chose)
  assert.equal(spokenFrom('What do I need to do today?', said('what do I need to do today')), 'dictation');
  assert.equal(spokenFrom("what's on my calendar", said('What’s on my calendar')), 'dictation', 'apostrophes and case don’t matter');
  // small typed fixes keep it spoken: a name corrected, "please" added
  assert.equal(spokenFrom('Email Katarzyna about the invoice please', said('email Catherine about the invoice')), 'dictation'); // 5 of 6
  // mostly typed, a few dictated words: not spoken
  assert.equal(spokenFrom('Refactor the parser in src/lexer.ts so tokens carry their line and column; then fix this', said('fix this')), '');
  // dictated, then deleted and typed over (the box was never emptied)
  assert.equal(spokenFrom('summarize the quarterly numbers', said('play some music')), '');
  // a word said once covers one use of it
  assert.equal(spokenShare('yes yes yes yes', said('yes')), 0.25);
  // the threshold itself: 3 of 5 words is spoken, 2 of 5 is not
  assert.equal(spokenFrom('one two three four five', said('one two three')), 'dictation');
  assert.equal(spokenFrom('one two three four five', said('one two')), '');
  // nothing said, nothing sent, or an unknown source
  assert.equal(spokenFrom('hello there', []), '');
  assert.equal(spokenFrom('', said('hello')), '');
  assert.equal(spokenFrom('hello there', [{ text: 'hello there', from: 'keyboard' }]), '');
  assert.equal(spokenFrom('hello there', null), '');
  // several pieces add up; the source is the first in SPOKEN_FROM that brought any words
  assert.equal(spokenFrom('what is the weather and the news', [{ text: 'what is the weather', from: 'dictation' }, { text: 'and the news', from: 'talk' }]), 'talk');
  assert.equal(spokenFrom('what do I need to do today', [{ text: 'what do I need to do today', from: 'assist' }, { text: 'today', from: 'dictation' }]), 'assist');
  // Chinese and Japanese count character by character, so editing one character keeps it spoken
  assert.deepEqual(wordsOf('今天天气'), ['今', '天', '天', '气']);
  assert.equal(spokenFrom('今天天气怎么样？', said('今天天气怎么样')), 'dictation');
  assert.equal(spokenFrom('明天天气怎么样', said('今天天气怎么样')), 'dictation', '6 of 7 characters');
});

// ───────────────────────── keyed launches ─────────────────────────
const NOW = 1_800_000_000_000;
const KEY = 'AbCdEfGhIjKlMnOpQrStU_';
const owner = (over = {}) => ({
  signedIn: true, role: 'owner', standalone: true, sr: true, perm: 'prompt', online: true, busy: false, visible: true, now: NOW,
  composer: '', attachments: 0, prefs: { ...QUICK_DEFAULTS, linkSend: true }, keys: { mine: KEY, role: 'owner', confirmed: KEY, lastAutoAt: 0 }, ...over,
});
const booted = (url, ctx = {}) => { const u = new URL(url, 'https://atelier.test'); const i = readLaunch(u.search, u.hash); return planLaunch(i, { ...owner(), composer: i.text, ...ctx }); };

test('launch: #in=voice|typed is read from the fragment only; a keyed Assist launch is spoken unless it says it was typed', () => {
  assert.equal(readLaunch('?start=ask&via=assist', `#k=${KEY}&in=voice&send=1&q=hi`).input, 'voice');
  assert.equal(readLaunch('?start=ask&via=assist', `#k=${KEY}&in=typed&send=1&q=hi`).input, 'typed');
  assert.equal(readLaunch('?start=ask&in=voice', '#q=hi').input, '', 'never from the query (it reaches the server)');
  assert.equal(readLaunch('', `#in=shout&q=hi`).input, '');
  assert.equal(readLaunch('', `#q=hi&in=voice`).input, '', 'after q= it is the prompt’s words');
  assert.equal(readLaunch('', `#q=hi&in=voice`).text, 'hi&in=voice');
  // Atelier Assist 2.0.0 doesn't say: it listens first, so its keyed launches count as said.
  const a = booted(`/?start=ask&via=assist#k=${KEY}&send=1&q=what%20do%20I%20need%20to%20do%20today`);
  assert.deepEqual([a.send, a.via, a.prefill.spoken], ['send', 'assist', 'assist']);
  assert.equal(booted(`/?start=ask&via=assist#k=${KEY}&in=voice&send=1&q=hi`).prefill.spoken, 'assist');
  assert.equal(booted(`/?start=ask&via=assist#k=${KEY}&in=typed&send=1&q=hi`).prefill.spoken, undefined, 'typed on the Assist card');
  // Held keyed launches (busy, a draft): still the owner's spoken words, for when they tap Send.
  assert.equal(booted(`/?start=ask&via=assist#k=${KEY}&send=1&q=hi`, { busy: true }).prefill.spoken, 'assist');
  // Anyone can write via=assist or in=voice: without this browser's key, never spoken.
  for (const url of [`/?start=ask&via=assist#send=1&q=hi`, `/?start=ask&via=assist#k=ZZCdEfGhIjKlMnOpQrStU-&send=1&q=hi`, `/?start=ask#in=voice&send=1&q=hi`]) {
    assert.equal(booted(url).prefill.spoken, undefined, url);
  }
  assert.equal(booted(`/?start=ask&via=assist#k=${KEY}&send=1&q=hi`, { role: 'tester:li-1' }).prefill.spoken, undefined, 'another role');
  // A keyed Shortcut link is spoken only when it says so (an iPhone Shortcut that dictates).
  assert.equal(booted(`/?start=ask#send=1&k=${KEY}&q=hi`).prefill.spoken, undefined);
  assert.equal(booted(`/?start=ask#in=voice&send=1&k=${KEY}&q=hi`).prefill.spoken, 'shortcut');
  // Signed out, a replay after sign-in, or a share: never.
  assert.equal(booted(`/?start=ask&via=assist#k=${KEY}&send=1&q=hi`, { signedIn: false, role: '' }).prefill.spoken, undefined);
});

test('applyLaunch tells the app which prefilled words were said (markSpoken), and nothing for a stranger’s link', async () => {
  const run = async (url) => {
    const calls = [];
    const rec = (n, ret) => (...a) => { calls.push([n, ...a]); return ret; };
    const u = new URL(url, 'https://atelier.test'), i = readLaunch(u.search, u.hash);
    await applyLaunch(planLaunch(i, { ...owner(), composer: i.text }), { now: () => NOW, getText: () => i.text, setText: rec('setText'), showSource: rec('showSource'), setMode: rec('setMode'), markSpoken: rec('markSpoken'), holdThenSend: rec('holdThenSend'), armSend: rec('armSend'), toast: rec('toast') });
    return calls;
  };
  const keyed = await run(`/?start=ask&via=assist#k=${KEY}&send=1&q=what%20do%20I%20need%20to%20do%20today`);
  assert.deepEqual(keyed.find((c) => c[0] === 'markSpoken'), ['markSpoken', 'what do I need to do today', 'assist']);
  assert.ok(keyed.findIndex((c) => c[0] === 'markSpoken') < keyed.findIndex((c) => c[0] === 'holdThenSend'), 'marked before the send');
  assert.deepEqual(keyed.find((c) => c[0] === 'showSource'), ['showSource', LAUNCH_NOTES.assist, { own: true }]);
  const stranger = await run('/?start=ask&via=assist#send=1&q=read%20my%20mail%20aloud');
  assert.equal(stranger.some((c) => c[0] === 'markSpoken'), false);
});

// ───────────────────────── the entry's mark ─────────────────────────
test('data-safety: e.spoken is one of SPOKEN_FROM; anything else refuses the backup (and a synced thread)', () => {
  const backup = (spoken) => ({ app: 'atelier', v: 1, threads: [{ id: 't1', title: 'T', createdAt: 1, updatedAt: 2, entries: [{ id: 'e1', kind: 'ask', prompt: 'hi', createdAt: 1, ...(spoken !== undefined && { spoken }) }] }] });
  for (const s of SPOKEN_FROM) assert.equal(validateBackup(backup(s))[0].entries[0].spoken, s);
  assert.doesNotThrow(() => validateBackup(backup(undefined)));
  for (const bad of ['voice', '', true, 1, { from: 'assist' }, ['assist'], 'ASSIST']) assert.throws(() => validateBackup(backup(bad)), /valid Atelier thread backup/, String(bad));
});

// ───────────────────────── what is read ─────────────────────────
test('autoReadText: the answer for Ask and Code, one short line for media and apps, a failure line for errors, nothing after Stop', () => {
  assert.deepEqual(autoReadText({ kind: 'ask', text: 'Two meetings today.' }), { text: 'Two meetings today.', line: false });
  assert.deepEqual(autoReadText({ kind: 'ask', text: 'Let me check… (the steps) Two meetings.' }, { text: 'Two meetings.' }), { text: 'Two meetings.', line: false }, 'the agent’s final summary');
  assert.deepEqual(autoReadText({ kind: 'code', text: '<think>plan the loop</think>Use a for loop.' }), { text: 'Use a for loop.', line: false }, 'the reasoning trace is never read');
  assert.equal(autoReadText({ kind: 'ask', text: '' }), null);
  assert.equal(autoReadText({ kind: 'ask', text: '<think>only thinking</think>' }), null);
  // errors are never read as speech
  for (const errorKind of ['offline', 'rate', 'model', 'error', 'budget']) assert.deepEqual(autoReadText({ kind: 'ask', text: 'partial', error: 'HTTP 500: upstream exploded', errorKind }), { text: AUTO_LINES.failed, line: true }, errorKind);
  assert.equal(autoReadText({ kind: 'ask', error: 'Stopped.', errorKind: 'stopped' }), null, 'you stopped it');
  assert.equal(autoReadText({ kind: 'ask', text: 'half an ans', cut: 'stopped' }), null, 'stopped partway');
  assert.deepEqual(autoReadText({ kind: 'image', media: [{ type: 'image', src: 'x' }] }), { text: 'Here’s your image.', line: true });
  assert.deepEqual(autoReadText({ kind: 'image', media: [{ type: 'image' }, { type: 'image' }, { type: 'image' }] }), { text: 'Here are your 3 images.', line: true });
  assert.equal(autoReadText({ kind: 'image', media: [] }), null);
  assert.deepEqual(autoReadText({ kind: 'video', media: [{ type: 'video', src: 'x' }], enhanced: 'a long cinematic prompt' }), { text: AUTO_LINES.video, line: true });
  assert.deepEqual(autoReadText({ kind: 'video', remix: { shots: [] } }), { text: AUTO_LINES.plan, line: true });
  assert.deepEqual(autoReadText({ kind: 'build', app: { html: '<html></html>', title: 'Tip calculator' }, text: '' }), { text: AUTO_LINES.build, line: true });
  const ideas = autoReadText({ kind: 'ideas', ideas: [{ title: 'Pop-up studio', pitch: 'p' }, { title: 'Night market', pitch: 'q' }] });
  assert.deepEqual(ideas, { text: 'Here are 2 ideas.\n\n- Pop-up studio\n- Night market', line: false });
  assert.deepEqual(speakable(ideas.text).split(/\s*\n\n\s*/), ['Here are 2 ideas.', 'Pop-up studio.', 'Night market.']);
  assert.equal(autoReadText(null), null);
});

test('speech cleaning for an answer read by itself: code, tables and long links are one line or a domain; prose is read', () => {
  const md = [
    '## Your day', '', 'You have **two** meetings. See https://calendar.google.com/calendar/u/0/r/day/2026/10/8?pli=1&tab=mc for details.', '',
    '| Time | Meeting | Where |', '|---|---|---|', '| 9:00 | Standup | Zoom |', '| 14:00 | Design review | Room 4 |', '',
    '```js', 'const day = await calendar.list({ when: "today" });', '```', '', 'Want me to draft the agenda?',
  ].join('\n');
  const auto = speakable(md, { tables: 'note' });
  assert.match(auto, /^Your day\.\n\nYou have two meetings\. See a link to calendar\.google\.com for details\./);
  assert.match(auto, /There’s a table on screen with 2 rows\./);
  assert.match(auto, /There’s a code block on screen\./);
  assert.match(auto, /Want me to draft the agenda\?$/);
  for (const never of ['Standup', 'Design review', 'calendar.list', 'https', 'pli=1', '|', '```', '##']) assert.ok(!auto.includes(never), never);
  // a read you start yourself still reads a small table row by row (unchanged)
  assert.match(speakable(md), /Time: 9:00, Meeting: Standup, Where: Zoom\./);
  // without marked (the fallback pass), tables are one line the same way
  const m = globalThis.marked;
  delete globalThis.marked;
  try {
    const plain = speakable(md, { tables: 'note' });
    assert.match(plain, /There’s a table on screen with 2 rows\./);
    assert.ok(!plain.includes('Standup'));
    assert.match(speakable(md), /Standup/, 'and are read when you asked for them');
  } finally { globalThis.marked = m; }
  // a long answer is read whole, in segments: a short first one so sound starts fast, then paragraph-sized ones
  const long = Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1} explains one more thing about the plan in plain words.`).join('\n\n');
  const segs = segments(speakable(long, { tables: 'note' }));
  assert.ok(segs.length > 2 && segs[0].length <= 220, 'a short first segment');
  assert.match(segs.at(-1), /Paragraph 30 /, 'read to the end');
});

test('settings: "Read answers to spoken requests" is on unless turned off', () => {
  assert.equal(DEFAULT_READ_ALOUD.auto, true);
  assert.equal(normalizeReadAloud(undefined).auto, true);
  assert.equal(normalizeReadAloud({ voice: 'sulafat' }).auto, true, 'saved by an older build');
  assert.equal(normalizeReadAloud({ auto: false }).auto, false);
  assert.equal(normalizeReadAloud({ auto: 'no' }).auto, true);
  assert.match(APP, /readAloud: \{ voice: 'atelier', speed: 1, auto: true \}/);
  assert.match(HTML, /<input type="checkbox" id="readAuto" checked \/><span><span class="ra-auto-title">Read answers to spoken requests<\/span>/);
});

// ───────────────────────── the reader: auto(), unlock(), blocked play ─────────────────────────
// policy: 'allow' (every play() plays), 'webkit' (only inside a tap, or on an element that already played in one),
// 'chrome' (refused until the page has had any tap). speech: 'ok' | 'deny' (not-allowed without a tap) | 'silent' (no
// event at all without a tap, as iOS can do).
function rig(over = {}) {
  const calls = [], toasts = [], states = [], audios = [], spoken = [];
  let urls = 0, gesture = false, sticky = false;
  class FakeAudio extends EventTarget {
    constructor() { super(); audios.push(this); Object.assign(this, { paused: true, ended: false, currentTime: 0, playbackRate: 1, defaultPlaybackRate: 1, preservesPitch: false, plays: [], refused: [], s: '', unlocked: false }); }
    get src() { return this.s; }
    set src(v) { this.s = v; this.currentTime = 0; this.ended = false; }
    removeAttribute(n) { if (n === 'src') this.s = ''; }
    load() {}
    play() {
      const ok = over.policy === 'webkit' ? gesture || this.unlocked : over.policy === 'chrome' ? sticky : true;
      if (!ok) { this.refused.push(this.s); return Promise.reject(new DOMException('no gesture', 'NotAllowedError')); }
      if (gesture) this.unlocked = true;
      this.plays.push(this.s); this.paused = false;
      queueMicrotask(() => { this.currentTime += 0.5; this.dispatchEvent(new Event('playing')); });
      return Promise.resolve();
    }
    pause() { if (this.paused) return; this.paused = true; this.dispatchEvent(new Event('pause')); }
    finish() { this.ended = true; this.paused = true; this.dispatchEvent(new Event('pause')); this.dispatchEvent(new Event('ended')); }
  }
  const speech = {
    cancels: 0, getVoices: () => [{ name: 'Ava (Natural)', lang: 'en-US' }],
    speak(u) {
      spoken.push(u);
      const allowed = gesture || speech.unlocked || over.speech === undefined || over.speech === 'ok';
      if (gesture) speech.unlocked = true;
      if (allowed) queueMicrotask(() => u.onstart?.());
      else if (over.speech === 'deny') queueMicrotask(() => u.onerror?.({ error: 'not-allowed' }));
    },
    cancel() { this.cancels++; },
  };
  class Utterance { constructor(text) { this.text = text; } }
  const store = new Map();
  const reader = createReader({
    apiHeaders: () => ({ 'x-app-pass': 'pw' }),
    getSettings: () => over.settings || { voice: 'atelier', speed: 1 },
    isTester: () => false, toast: (m) => toasts.push(m),
    onState: (id, s, d) => states.push([id, s, d]),
    fetch: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/wav' } }); },
    Audio: FakeAudio, URL: { createObjectURL: () => `blob:fake/${++urls}`, revokeObjectURL() {} },
    speech, Utterance, caches: null, mediaSession: null,
    storage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    online: () => true, lang: () => 'en-US', stallMs: 25, deviceStartMs: over.deviceStartMs ?? 40,
  });
  // A tap: what runs inside it has a user gesture (and the page has had one from then on).
  const tap = (f) => { gesture = true; sticky = true; try { return f(); } finally { gesture = false; } };
  return { reader, calls, toasts, states, audios, spoken, speech, tap, el: () => audios[0] };
}
const lastDetail = (r, id) => r.states.filter((s) => s[0] === id).at(-1)?.[2];

test('auto(): where the browser allows it, a spoken request’s answer plays by itself, in segments, tables said as one line', async () => {
  const r = rig();
  const md = 'Here is your day.\n\n| Time | What |\n|---|---|\n| 9 | Standup |\n| 11 | Review |\n\nThat is all for today, enjoy it.';
  assert.equal(r.reader.auto('e1', md, { title: 'what do I need to do today' }), true);
  assert.equal(r.reader.stateFor('e1'), 'preparing');
  assert.match(r.el().plays[0], /^data:audio\/wav;base64,/, 'a silent clip asks first');
  await until(() => r.reader.stateFor('e1') === 'playing', 'playing');
  assert.match(r.el().src, /^blob:fake\//);
  const said = r.calls.map((c) => c.body.text).join(' ');
  assert.match(said, /There’s a table on screen with 2 rows\./);
  assert.ok(!said.includes('Standup'));
  assert.deepEqual(r.reader.current(), { id: 'e1', state: 'playing', mode: 'blob', auto: true, blocked: false });
  assert.deepEqual(lastDetail(r, 'e1'), { auto: true, blocked: false, finished: false });
  assert.equal(r.toasts.includes(SAY.resume), false);
  // never over another read
  assert.equal(r.reader.auto('e2', 'Something else.'), false);
  assert.equal(r.reader.stateFor('e1'), 'playing');
  // read to the end: idle, finished
  for (let i = 0; i < 20 && r.reader.current(); i++) { const prev = r.el().src; r.el().finish(); await until(() => r.el().src !== prev || !r.reader.current(), 'next segment'); }
  assert.equal(r.reader.current(), null);
  assert.deepEqual(r.states.at(-1), ['e1', 'idle', { auto: true, blocked: false, finished: true }]);
  // nothing to read: false, and nothing said
  assert.equal(r.reader.auto('e3', '   '), false);
  assert.equal(r.toasts.includes(SAY.nothing), false);
});

test('auto(): blocked autoplay (WebKit, no unlock) waits as "Tap to listen" with its first clip ready; a tap plays it', async () => {
  const r = rig({ policy: 'webkit' });
  const long = Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1} explains one more part of the plan, in plain and simple words.`).join('\n\n');
  assert.ok(segments(speakable(long)).length >= 3);
  r.reader.auto('e1', long);
  await until(() => r.reader.current()?.blocked, 'blocked');
  assert.equal(r.reader.stateFor('e1'), 'paused');
  assert.deepEqual(lastDetail(r, 'e1'), { auto: true, blocked: true, finished: false });
  assert.equal(r.toasts.includes(SAY.resume), false, 'no toast: the app shows Tap to listen');
  await until(() => r.calls.length === 1, 'first clip fetched for the tap');
  await wait(15);
  assert.equal(r.calls.length, 1, 'nothing more is paid for until it can play');
  assert.equal(r.el().plays.length, 0);
  // The tap on "Tap to listen" (or the answer's Resume) unlocks the element inside the gesture and plays the first clip.
  r.tap(() => r.reader.resume());
  assert.equal(r.reader.stateFor('e1'), 'preparing');
  await until(() => r.reader.stateFor('e1') === 'playing', 'playing after the tap');
  assert.match(r.el().src, /^blob:fake\//);
  assert.equal(r.reader.current().blocked, false);
  // later clips play without another tap (the element is unlocked)
  r.el().finish();
  await until(() => r.el().plays.filter((s) => s.startsWith('blob:')).length === 2, 'second clip');
  assert.equal(r.reader.stateFor('e1'), 'playing');
  r.reader.stop();
});

test('auto(): a page opened from another app (Chrome: no tap yet) is blocked too; a stop clears it, finished: false', async () => {
  const r = rig({ policy: 'chrome' });
  r.reader.auto('e1', 'Your answer is ready.');
  await until(() => r.reader.current()?.blocked, 'blocked');
  r.reader.stop();
  assert.equal(r.reader.current(), null);
  assert.deepEqual(r.states.at(-1), ['e1', 'idle', { auto: true, blocked: false, finished: false }]);
});

test('unlock(): inside the mic’s or Send’s tap the one <audio> element is unlocked, so the answer later plays without a tap', async () => {
  const r = rig({ policy: 'webkit' });
  assert.equal(r.tap(() => r.reader.unlock()), true);
  assert.equal(r.el().plays.length, 1);
  assert.match(r.el().plays[0], /^data:audio\/wav/);
  assert.equal(r.spoken.length, 0, 'the device voice is unlocked only when asked');
  await wait(5);
  assert.equal(r.reader.current(), null, 'no read, no state');
  assert.equal(r.reader.auto('e1', 'Here is the answer you asked for.'), true);
  await until(() => r.reader.stateFor('e1') === 'playing', 'playing with no tap');
  assert.equal(r.reader.current().blocked, false);
  assert.equal(r.audios.length, 1, 'the same element');
  assert.equal(r.reader.unlock(), false, 'never while a read is on');
  r.reader.stop();
  // iOS's device voice: one silent utterance, once
  const d = rig({ policy: 'webkit', speech: 'silent' });
  d.tap(() => d.reader.unlock({ speech: true }));
  d.tap(() => d.reader.unlock({ speech: true }));
  assert.equal(d.spoken.length, 1);
  assert.deepEqual([d.spoken[0].text, d.spoken[0].volume], [' ', 0]);
});

test('auto() with the device voice: refused (not-allowed) or never started (iOS) waits for a tap, with no toast', async () => {
  for (const speech of ['deny', 'silent']) {
    const r = rig({ settings: { voice: 'device', speed: 1 }, speech });
    r.reader.auto('e1', 'One sentence here. And another one.');
    await until(() => r.reader.current()?.blocked, `${speech}: blocked`);
    assert.equal(r.reader.stateFor('e1'), 'paused', speech);
    assert.equal(r.reader.current().mode, 'device');
    assert.equal(r.toasts.includes(SAY.resume), false, speech);
    r.tap(() => r.reader.resume());
    assert.equal(r.reader.stateFor('e1'), 'playing', speech);
    assert.equal(r.spoken.at(-1).text, 'One sentence here.', `${speech}: from the first sentence`);
    await wait(60);
    assert.equal(r.reader.stateFor('e1'), 'playing', `${speech}: started this time, so no watchdog`);
    r.reader.stop();
  }
  // a read you start by tap with the device voice keeps the old behavior (no watchdog; not-allowed toasts Resume)
  const m = rig({ settings: { voice: 'device', speed: 1 }, speech: 'deny' });
  m.reader.toggle('e1', 'One sentence here.');
  await until(() => m.reader.stateFor('e1') === 'paused', 'paused');
  assert.equal(m.toasts.at(-1), SAY.resume);
});

// ───────────────────────── app.js wiring (lifted) ─────────────────────────
// The source of `[async ]function name(` up to its closing brace at column 0, or its own line when it closes there.
function fnSource(name) {
  let at = APP.indexOf(`\nfunction ${name}(`);
  if (at < 0) at = APP.indexOf(`\nasync function ${name}(`);
  assert.ok(at >= 0, `app.js has function ${name}`);
  at += 1;
  const line = APP.slice(at, APP.indexOf('\n', at));
  if (line.split('{').length === line.split('}').length) return line;
  return APP.slice(at, APP.indexOf('\n}\n', at) + 2);
}
function scope(vars) {
  return new Proxy(vars, {
    has: (t, k) => typeof k === 'string' && (k in t || !(k in globalThis)),
    get: (t, k) => (k === Symbol.unscopables ? undefined : k in t ? t[k] : () => undefined),
    set: (t, k, v) => { t[k] = v; return true; },
  });
}
const evalIn = (vars, body) => new Function('scope', `with (scope) { ${body} }`)(scope(vars));
const lift = (vars, ...names) => evalIn(vars, `return { ${names.map((n) => `${n}: (${fnSource(n)})`).join(', ')} };`);

function submitRig({ draft = '', pieces = [], tasks = null } = {}) {
  const calls = { run: [], runTasks: [], stopReading: 0, unlock: 0 };
  const input = { value: draft, focus() {} };
  let id = 0;
  const vars = {
    composerFrom: '', markWas: '', markText: '', input, voicePieces: pieces, autoArmed: new Set(), spokeHere: new Set(), spokenFrom,
    S: { mode: 'ask', video: null, attachments: [], thread: null, opts: { ask: {}, image: {} }, tester: false },
    $: () => ({ value: '', focus() {} }), navigator: { onLine: true }, hasCredentials: () => true,
    feat: () => Boolean(tasks), MULTI_HINT: /./, MULTI_JOIN: /./, running: new Set(), planTasks: async () => tasks,
    runTasks: async (...a) => { calls.runTasks.push(a); }, run: async (e) => { calls.run.push(e); }, newThread: () => ({ entries: [] }),
    uid: () => `e${++id}`, videoSource: () => null, welcome: { classList: { add() {} } }, stream: { append() {} }, renderEntry: () => ({}),
    stopReading: () => { calls.stopReading++; }, unlockReading: () => { calls.unlock++; }, setMark() {},
  };
  Object.assign(vars, lift(vars, 'submit', 'armSpoken'));
  return { vars, calls, input };
}

test('submit(): a composer send that is mostly dictated is marked spoken and armed; a typed one is not; buttons never are', async () => {
  const d = submitRig({ draft: 'What do I need to do today?', pieces: [{ text: 'what do I need to do today', from: 'talk' }] });
  await d.vars.submit();
  const e = d.calls.run[0];
  assert.equal(e.spoken, 'talk');
  assert.ok(d.vars.autoArmed.has(e.id), 'armed: its answer reads when the run ends');
  assert.ok(d.vars.spokeHere.has(e.id), 'sent as spoken from this device (Retry may read it again)');
  assert.deepEqual([d.calls.stopReading, d.calls.unlock], [1, 1], 'a new prompt stops reading; the send’s tap unlocks audio');
  assert.deepEqual(d.vars.voicePieces, [], 'spent with the send');
  // typed: no mark, nothing armed, no unlock (no silent clip interrupting your music), but reading still stops
  const t = submitRig({ draft: 'What do I need to do today?' });
  await t.vars.submit();
  assert.equal(t.calls.run[0].spoken, undefined);
  assert.equal(t.vars.autoArmed.size, 0);
  assert.equal(t.vars.spokeHere.size, 0);
  assert.deepEqual([t.calls.stopReading, t.calls.unlock], [1, 0]);
  // mostly typed around a dictated fragment
  const m = submitRig({ draft: 'Rewrite this paragraph so it is shorter and friendlier, keep the dates: fix this', pieces: [{ text: 'fix this', from: 'dictation' }] });
  await m.vars.submit();
  assert.equal(m.calls.run[0].spoken, undefined);
  // a button's own text (Expand an idea, Vary) is never spoken, whatever the composer holds
  const b = submitRig({ draft: 'hello', pieces: [{ text: 'expand this idea', from: 'dictation' }] });
  await b.vars.submit('Expand this idea', 'ask');
  assert.equal(b.calls.run[0].spoken, undefined);
  assert.deepEqual(b.vars.voicePieces, [{ text: 'expand this idea', from: 'dictation' }], 'the composer keeps its words');
  // Atelier Assist's keyed words, sent by the launch
  const a = submitRig({ draft: 'what do I need to do today', pieces: [{ text: 'what do I need to do today', from: 'assist' }] });
  await a.vars.submit(undefined, 'ask', { launch: true, via: 'assist' });
  assert.deepEqual([a.calls.run[0].spoken, a.calls.run[0].via], ['assist', 'assist']);
  // a spoken request split into tasks passes the mark on
  const s = submitRig({ draft: 'tell me a joke and make an image of a cat', pieces: [{ text: 'tell me a joke and make an image of a cat', from: 'dictation' }], tasks: [{ kind: 'ask', prompt: 'joke' }, { kind: 'image', prompt: 'cat' }] });
  await s.vars.submit();
  assert.equal(s.calls.runTasks[0][3], 'dictation');
  assert.match(fnSource('runTasks'), /\.\.\.\(spoken && \{ spoken \}\),\n  \}\)\);\n  S\.thread\.entries\.push\(\.\.\.entries\);\n  if \(spoken\) for \(const e of entries\) armSpoken\(e\.id\);/);
});

function autoRig({ on = true, visible = 'visible', cur = null } = {}) {
  const reads = [], listeners = new Map();
  const reader = {
    cur, current() { return this.cur; },
    auto: (id, text, meta) => { reads.push({ id, text, meta }); reader.cur = { id, state: 'preparing', auto: true }; return true; },
    stop: () => { reads.push('stop'); reader.cur = null; },
  };
  const document = {
    visibilityState: visible,
    addEventListener: (t, f) => listeners.set(f, t), removeEventListener: (t, f) => listeners.delete(f),
    show() { this.visibilityState = 'visible'; for (const f of [...listeners.keys()]) f(); },
  };
  const thread = { id: 't1', title: 'Today', entries: [] };
  // dictation.state(): 'idle' | 'listening' | 'recording' | 'transcribing' | 'error' (dictate.js STATES)
  const dictation = { st: 'idle', state() { return this.st; } };
  const clock = { now: 1_000_000 }; // Date.now() for the hidden-page window (wall time)
  const vars = {
    reader, document, dictation, Date: { now: () => clock.now }, autoArmed: new Set(), agentFinal: new Map(), autoQueue: [], autoWait: null, autoMic: [],
    AUTO_QUEUE_MAX: 4, AUTO_HIDDEN_MS: 120_000, autoOn: () => on, S: { thread }, stripThink, autoReadText, setTimeout, clearTimeout,
    repaintReadState() {}, paintReadChip() {}, micArm: null, unlockReading() {},
  };
  Object.assign(vars, lift(vars, 'autoReadDone', 'autoRead', 'holdAutoRead', 'micClosed', 'micOpen', 'micStarting', 'stopReading', 'readStateChanged', 'agentSaid'));
  const entry = (over = {}) => { const e = { id: `e${thread.entries.length + 1}`, kind: 'ask', prompt: 'what do I need to do today', text: 'You have two meetings.', spoken: 'assist', ...over }; thread.entries.push(e); return e; };
  return { vars, reads, reader, document, thread, entry, dictation, clock };
}

test('autoReadDone: only a spoken turn this device sent, with the setting on, in the open thread; typed turns stay silent', () => {
  const r = autoRig();
  const e = r.entry(); r.vars.autoArmed.add(e.id);
  r.vars.autoReadDone(e, r.thread);
  assert.deepEqual(r.reads, [{ id: e.id, text: 'You have two meetings.', meta: { title: e.prompt, album: 'Today' } }]);
  assert.equal(r.vars.autoArmed.has(e.id), false, 'once');
  // a typed turn (no mark) is never read, armed or not
  const typed = autoRig(), t = typed.entry({ spoken: undefined }); typed.vars.autoArmed.add(t.id);
  typed.vars.autoReadDone(t, typed.thread);
  assert.deepEqual(typed.reads, []);
  // a spoken turn this device didn't send (synced in, restored, opened later): silent
  const synced = autoRig(), s = synced.entry();
  synced.vars.autoReadDone(s, synced.thread);
  assert.deepEqual(synced.reads, []);
  // the setting off
  const off = autoRig({ on: false }), o = off.entry(); off.vars.autoArmed.add(o.id);
  off.vars.autoReadDone(o, off.thread);
  assert.deepEqual(off.reads, []);
  assert.equal(off.vars.autoArmed.has(o.id), false, 'disarmed all the same');
  // you moved to another thread meanwhile
  const away = autoRig(), w = away.entry(); away.vars.autoArmed.add(w.id);
  away.vars.autoReadDone(w, { id: 'other', entries: [w] });
  assert.deepEqual(away.reads, []);
});

test('autoReadDone: the accounts agent’s last words, a failure line for errors, a short line for an image', () => {
  const r = autoRig();
  const e = r.entry({ text: 'Let me check your calendar.\n\nYou have two meetings: standup at 9 and review at 2.' });
  r.vars.autoArmed.add(e.id);
  r.vars.agentSaid(e, 'Let me check your calendar.');
  r.vars.agentSaid(e, '   '); // a round with only tool calls says nothing
  r.vars.agentSaid(e, 'You have two meetings: standup at 9 and review at 2.');
  r.vars.autoReadDone(e, r.thread);
  assert.equal(r.reads[0].text, 'You have two meetings: standup at 9 and review at 2.');
  assert.equal(r.vars.agentFinal.size, 0);
  const f = autoRig(), x = f.entry({ text: '', error: 'Upstream error 529: overloaded_error {"type":"error"}', errorKind: 'busy' }); f.vars.autoArmed.add(x.id);
  f.vars.autoReadDone(x, f.thread);
  assert.equal(f.reads[0].text, AUTO_LINES.failed);
  const i = autoRig(), img = i.entry({ kind: 'image', text: '', media: [{ type: 'image', src: 'data:image/png;base64,AA' }] }); i.vars.autoArmed.add(img.id);
  i.vars.autoReadDone(img, i.thread);
  assert.equal(i.reads[0].text, 'Here’s your image.');
});

test('autoRead: never over a read you started; queued behind one that started by itself, next once it is read to the end', async () => {
  const mine = autoRig({ cur: { id: 'x', state: 'playing', auto: false } });
  const a = mine.entry(); mine.vars.autoRead({ id: a.id, text: 'hi', meta: {} });
  assert.deepEqual(mine.reads, []);
  assert.deepEqual(mine.vars.autoQueue, []);
  const r = autoRig();
  const e1 = r.entry(), e2 = r.entry({ text: 'Second answer.' });
  r.vars.autoRead({ id: e1.id, text: 'First answer.', meta: {} });
  r.vars.autoRead({ id: e2.id, text: 'Second answer.', meta: {} });
  assert.deepEqual(r.reads.map((x) => x.id), [e1.id]);
  assert.equal(r.vars.autoQueue.length, 1);
  r.reader.cur = null;
  r.vars.readStateChanged(e1.id, 'idle', { auto: true, finished: true });
  await wait(5);
  assert.deepEqual(r.reads.map((x) => x.id), [e1.id, e2.id]);
  // stopped instead (the lock screen's Stop, another answer's Read aloud): the rest waits no more
  const s = autoRig(), s1 = s.entry(), s2 = s.entry();
  s.vars.autoRead({ id: s1.id, text: 'a', meta: {} }); s.vars.autoRead({ id: s2.id, text: 'b', meta: {} });
  s.reader.cur = null;
  s.vars.readStateChanged(s1.id, 'idle', { auto: true, finished: false });
  await wait(5);
  assert.deepEqual(s.reads.map((x) => x.id), [s1.id]);
  assert.deepEqual(s.vars.autoQueue, []);
  // its thread was closed meanwhile
  const c = autoRig(); c.vars.autoRead({ id: 'gone', text: 'x', meta: {} });
  assert.deepEqual(c.reads, []);
});

test('autoRead: an answer that finishes while the page is hidden reads when you come back, not in the background', () => {
  const r = autoRig({ visible: 'hidden' });
  const e = r.entry();
  r.vars.autoRead({ id: e.id, text: 'Back again.', meta: {} });
  assert.deepEqual(r.reads, []);
  assert.ok(r.vars.autoWait);
  r.document.show();
  assert.deepEqual(r.reads.map((x) => x.id), [e.id]);
  assert.equal(r.vars.autoWait, null);
  // a stop trigger meanwhile (a new prompt, the mic, another thread) drops it
  const s = autoRig({ visible: 'hidden' }), x = s.entry();
  s.vars.autoRead({ id: x.id, text: 'x', meta: {} });
  s.vars.stopReading();
  s.document.show();
  assert.deepEqual(s.reads, []);
});

test('autoRead (hidden): the 2-minute window is wall time, so an answer parked before the phone slept stays silent', () => {
  // The hidden page's timer never fired (timers stop while the device sleeps or the app is suspended); Date.now moved on.
  const r = autoRig({ visible: 'hidden' }), e = r.entry();
  r.vars.autoRead({ id: e.id, text: 'An hour old.', meta: {} });
  r.clock.now += 60 * 60_000;
  r.document.show();
  assert.deepEqual(r.reads, [], 'too old: its own Read aloud button is there');
  assert.equal(r.vars.autoWait, null, 'and nothing waits any more');
  // just inside the window: read
  const k = autoRig({ visible: 'hidden' }), f = k.entry();
  k.vars.autoRead({ id: f.id, text: 'Back soon.', meta: {} });
  k.clock.now += 120_000;
  k.document.show();
  assert.deepEqual(k.reads.map((x) => x.id), [f.id]);
  // one parked long ago, one just now: only the recent one reads
  const m = autoRig({ visible: 'hidden' }), old = m.entry(), fresh = m.entry();
  m.vars.autoRead({ id: old.id, text: 'old', meta: {} });
  m.clock.now += 10 * 60_000;
  m.vars.autoRead({ id: fresh.id, text: 'fresh', meta: {} });
  m.clock.now += 5_000;
  m.document.show();
  assert.deepEqual(m.reads.map((x) => x.id), [fresh.id]);
});

test('autoRead (hidden): every answer that finished while hidden reads on return, in order; none is dropped', async () => {
  const r = autoRig({ visible: 'hidden' });
  const p1 = r.entry({ text: 'The answer is forty-two.' }), p2 = r.entry({ kind: 'image', text: '', media: [{ type: 'image', src: 'x' }] });
  for (const e of [p1, p2]) { r.vars.autoArmed.add(e.id); r.vars.autoReadDone(e, r.thread); }
  assert.deepEqual(r.reads, []);
  r.document.show();
  assert.deepEqual(r.reads.map((x) => x.id), [p1.id], 'the first reads');
  assert.deepEqual(r.vars.autoQueue.map((x) => x.id), [p2.id], 'the second waits its turn');
  r.reader.cur = null;
  r.vars.readStateChanged(p1.id, 'idle', { auto: true, finished: true });
  await wait(5);
  assert.deepEqual(r.reads.map((x) => x.id), [p1.id, p2.id]);
  assert.equal(r.reads[1].text, 'Here’s your image.');
  // capped like the queue (AUTO_QUEUE_MAX)
  const c = autoRig({ visible: 'hidden' });
  for (let i = 0; i < 7; i++) c.vars.autoRead({ id: c.entry().id, text: `${i}`, meta: {} });
  assert.equal(c.vars.autoWait.reqs.length, 4);
  c.vars.stopReading();
});

test('autoRead: an answer that finishes while the mic is open never plays into it; it reads once the mic closes, unless that is sent', async () => {
  for (const st of ['listening', 'recording']) {
    const r = autoRig({ cur: { id: 'e0', state: 'playing', auto: true } });
    const e = r.entry(); r.vars.autoArmed.add(e.id); // a spoken request still on its way
    r.vars.micStarting(); // the tap that opens the mic for a follow-up: the read stops, the answer stays armed
    assert.deepEqual(r.reads, ['stop']);
    assert.ok(r.vars.autoArmed.has(e.id));
    r.dictation.st = st;
    r.vars.autoReadDone(e, r.thread);
    assert.deepEqual(r.reads, ['stop'], `${st}: nothing plays while the mic is open`);
    assert.deepEqual(r.vars.autoMic.map((x) => x.id), [e.id]);
    r.dictation.st = 'idle';
    r.vars.micClosed(false);
    assert.deepEqual(r.reads.slice(1).map((x) => x.id), [e.id], `${st}: read once it closed`);
    assert.deepEqual(r.vars.autoMic, []);
  }
  // what the mic heard is being sent (Send while it listened, Talk's hold): that request's answer is the one to hear
  const s = autoRig(), x = s.entry(); s.vars.autoArmed.add(x.id);
  s.dictation.st = 'listening';
  s.vars.autoReadDone(x, s.thread);
  s.dictation.st = 'idle';
  s.vars.micClosed(true);
  assert.deepEqual(s.reads, []);
  assert.deepEqual(s.vars.autoMic, []);
  // typing (or a new prompt, another thread, the setting off) while it waits: dropped
  const t = autoRig(), y = t.entry(); t.vars.autoArmed.add(y.id);
  t.dictation.st = 'recording';
  t.vars.autoReadDone(y, t.thread);
  t.vars.stopReading({ autoOnly: true, disarm: true });
  t.dictation.st = 'idle';
  t.vars.micClosed(false);
  assert.deepEqual(t.reads, []);
  // transcribing: the mic has let go, so it reads (the read stops if the transcript is then sent)
  const u = autoRig(), z = u.entry(); u.vars.autoArmed.add(z.id);
  u.dictation.st = 'transcribing';
  u.vars.autoReadDone(z, u.thread);
  assert.deepEqual(u.reads.map((v) => v.id), [z.id]);
  // the queue's next answer is held the same way
  const q = autoRig(), q1 = q.entry(), q2 = q.entry();
  q.vars.autoRead({ id: q1.id, text: 'a', meta: {} }); q.vars.autoRead({ id: q2.id, text: 'b', meta: {} });
  q.reader.cur = null; q.dictation.st = 'listening';
  q.vars.readStateChanged(q1.id, 'idle', { auto: true, finished: true });
  await wait(5);
  assert.deepEqual(q.reads.map((v) => v.id), [q1.id]);
  assert.deepEqual(q.vars.autoMic.map((v) => v.id), [q2.id]);
});

// paintMic (dictation's onState) run against stubs: the mic closing reads what waited, or drops it when it sends.
function micRig() {
  const r = autoRig(), sent = [];
  const node = () => ({ dataset: {}, style: { removeProperty() {}, setProperty() {} }, setAttribute() {}, removeAttribute() {}, toggleAttribute() {}, title: '', textContent: '' });
  Object.assign(r.vars, {
    micBtn: node(), micTime: node(), micStatus: node(), MIC_SAY: { transcribing: 'Transcribing…' }, micAdded: '', micAt: null, micSel: null,
    input: { value: '' }, syncMic() {}, micSendAfter: false, sendHold: null, submit: () => { sent.push(true); },
  });
  Object.assign(r.vars, lift(r.vars, 'paintMic'));
  const mic = (st, detail) => { r.dictation.st = st; r.vars.paintMic(st, detail); };
  return { ...r, sent, mic };
}

test('paintMic: the answer that waited on the mic reads when it closes (idle or error), not while it transcribes; not when it sends', () => {
  const r = micRig(), e = r.entry(); r.vars.autoArmed.add(e.id);
  r.mic('recording');
  r.vars.autoReadDone(e, r.thread);
  r.mic('transcribing');
  assert.deepEqual(r.reads, []);
  r.mic('idle', { reason: 'user' });
  assert.deepEqual(r.reads.map((x) => x.id), [e.id]);
  const er = micRig(), f = er.entry(); er.vars.autoArmed.add(f.id);
  er.mic('listening'); er.vars.autoReadDone(f, er.thread); er.mic('error');
  assert.deepEqual(er.reads.map((x) => x.id), [f.id]);
  // Send pressed while it listened: the dictation is sent, the old answer doesn't start over it
  const s = micRig(), g = s.entry(); s.vars.autoArmed.add(g.id);
  s.mic('listening'); s.vars.autoReadDone(g, s.thread);
  s.vars.micSendAfter = true;
  s.mic('idle', { reason: 'user' });
  assert.deepEqual([s.reads, s.sent.length], [[], 1]);
  // Talk's hold is counting down to send what it heard
  const h = micRig(), k = h.entry(); h.vars.autoArmed.add(k.id);
  h.mic('listening'); h.vars.autoReadDone(k, h.thread);
  h.vars.sendHold = { fire() {} };
  h.mic('idle', { reason: 'end' });
  assert.deepEqual(h.reads, []);
});

test('stopReading: everything for a new prompt, the mic or another thread; only a read that started by itself when you type', () => {
  const mine = autoRig({ cur: { id: 'x', state: 'playing', auto: false } });
  mine.vars.autoQueue.push({ id: 'q' });
  mine.vars.stopReading({ autoOnly: true });
  assert.deepEqual(mine.reads, [], 'typing doesn’t stop a read you started');
  assert.deepEqual(mine.vars.autoQueue, [], 'but nothing waiting reads');
  mine.vars.stopReading();
  assert.deepEqual(mine.reads, ['stop']);
  const auto = autoRig({ cur: { id: 'y', state: 'paused', auto: true, blocked: true } });
  auto.vars.stopReading({ autoOnly: true });
  assert.deepEqual(auto.reads, ['stop'], 'typing drops "Tap to listen" too');
  // disarm (typing, a typed send, another thread, Stop reading): an answer still on its way won't start reading
  const d = autoRig(), late = d.entry(); d.vars.autoArmed.add(late.id);
  d.vars.stopReading();
  assert.ok(d.vars.autoArmed.has(late.id), 'the mic or a spoken send leaves it armed');
  d.vars.stopReading({ autoOnly: true, disarm: true });
  d.vars.autoReadDone(late, d.thread);
  assert.deepEqual(d.reads, []);
});

test('submit(): a typed send disarms answers still on their way; a spoken one leaves them to read in turn', async () => {
  const t = submitRig({ draft: 'now something typed' });
  t.vars.autoArmed.add('pending-spoken');
  t.vars.stopReading = (o) => { t.calls.stopReading++; if (o?.disarm) t.vars.autoArmed.clear(); };
  await t.vars.submit();
  assert.equal(t.vars.autoArmed.size, 0);
  const s = submitRig({ draft: 'and another question', pieces: [{ text: 'and another question', from: 'dictation' }] });
  s.vars.autoArmed.add('pending-spoken');
  s.vars.stopReading = (o) => { s.calls.stopReading++; if (o?.disarm) s.vars.autoArmed.clear(); };
  await s.vars.submit();
  assert.deepEqual([...s.vars.autoArmed], ['pending-spoken', s.calls.run[0].id]);
});

// The stop triggers, run: each handler is lifted from app.js and driven against stubs; the regexes below only check
// that the page wires those very functions to their events.
test('typing: your own (trusted) input stops a read that started by itself and disarms; dictation’s input doesn’t; an emptied box forgets the voice', () => {
  const calls = [];
  const vars = { input: { value: 'hello' }, voicePieces: [{ text: 'hello', from: 'dictation' }], stopReading: (o) => calls.push(o) };
  const { composerTyped } = lift(vars, 'composerTyped');
  composerTyped({ isTrusted: false }); // dictate.js writes with a synthetic 'input'
  assert.deepEqual(calls, []);
  assert.equal(vars.voicePieces.length, 1);
  composerTyped({ isTrusted: true });
  assert.deepEqual(calls, [{ autoOnly: true, disarm: true }]);
  vars.input.value = '  ';
  composerTyped({ isTrusted: false });
  assert.deepEqual(vars.voicePieces, []);
  assert.match(APP, /\ninput\.addEventListener\('input', composerTyped\);\n/);
  assert.match(APP, /\ninput\.addEventListener\('beforeinput', composerReplacing\);\n/);
});

test('the mic opening: the read stops, answers on their way stay armed (and wait for it to close), the tap unlocks audio', () => {
  const r = autoRig({ cur: { id: 'e0', state: 'playing', auto: false } });
  let disarmed = 0, unlocked = 0;
  r.vars.micArm = () => { disarmed++; };
  r.vars.unlockReading = () => { unlocked++; };
  const e = r.entry(); r.vars.autoArmed.add(e.id);
  r.vars.autoQueue.push({ id: 'q' });
  r.vars.micStarting();
  assert.deepEqual([r.reads, disarmed, unlocked, r.vars.autoQueue], [['stop'], 1, 1, []]);
  assert.ok(r.vars.autoArmed.has(e.id));
  // createDictation gets it as its one beforeStart, and paintMic as its onState
  assert.equal(APP.match(/^\s*beforeStart:/gm).length, 1, 'no second beforeStart overrides it');
  assert.match(APP, /\n  beforeStart: micStarting,\n  onState: paintMic,\n/);
});

test('another thread or a new one stops the read and disarms; reopening the same thread doesn’t', async () => {
  const calls = [], t1 = { id: 't1', entries: [] }, t2 = { id: 't2', entries: [] };
  const vars = {
    S: { thread: t1, mode: 'ask' }, liveThreads: new Map([['t1', t1], ['t2', t2]]), accountReloading: false, LS: { set() {} }, requestAnimationFrame() {},
    stopReading: (o) => calls.push([o, vars.S.thread?.id ?? null]), $: () => ({}), input: { focus() {} }, MODES: { ask: { ph: 'Ask' } }, stage: { scrollTo() {} },
  };
  const { openThread, startFresh } = lift(vars, 'openThread', 'startFresh');
  await openThread('t1');
  assert.deepEqual(calls, [], 'the open thread again');
  await openThread('t2');
  assert.deepEqual(calls, [[{ disarm: true }, 't1']], 'before it switches');
  assert.equal(vars.S.thread, t2);
  startFresh();
  assert.deepEqual(calls.at(-1), [{ disarm: true }, 't2']);
  assert.equal(vars.S.thread, null);
});

test('the page hiding pauses the device voice on a phone; a desktop browser keeps speaking (as in v87); the AI voice plays on', () => {
  const run = (PLATFORM, cur, visibilityState = 'hidden') => {
    let paused = 0;
    const vars = { PLATFORM, document: { visibilityState }, reader: { current: () => cur, pause: () => { paused++; } } };
    lift(vars, 'pauseDeviceOnHide').pauseDeviceOnHide();
    return paused;
  };
  const device = { id: 'e1', mode: 'device', state: 'playing', auto: false };
  assert.equal(run('ios', device), 1);
  assert.equal(run('android', { ...device, state: 'preparing', auto: true }), 1);
  assert.equal(run('desktop', device), 0, 'desktop Chrome keeps speechSynthesis going in the background');
  assert.equal(run('desktop', { ...device, auto: true }), 0);
  assert.equal(run('ios', { ...device, mode: 'blob' }), 0, 'the AI voice keeps its lock-screen controls');
  assert.equal(run('ios', { ...device, state: 'paused' }), 0);
  assert.equal(run('ios', device, 'visible'), 0);
  assert.equal(run('ios', null), 0);
  assert.match(APP, /\ndocument\.addEventListener\('visibilitychange', pauseDeviceOnHide\);\n/);
});

test('the stop triggers and unlocks are wired: Send, the chip, the answer’s Stop; run() and the agent feed the read', () => {
  // a new prompt
  assert.match(fnSource('submit'), /\n  stopReading\(\{ disarm: !said \}\); \/\/ a new prompt: Read aloud stops[^\n]*\n  if \(said\) unlockReading\(\);/);
  // dictated words are noted as said; Talk (reason 'launch') as 'talk'
  assert.match(APP, /if \(final\) noteVoice\(text, reason === 'launch' \? 'talk' : 'dictation'\);/);
  // the mic closing hands over what waited on it (paintMic → micClosed), before a Send-while-dictating goes out
  assert.match(fnSource('paintMic'), /\n  micClosed\(send \|\| Boolean\(sendHold\)\);[^\n]*\n  if \(send\) submit\(\);/);
  // the chip and the answer's own Stop
  assert.match(APP, /\$\('#readChipMain'\)\.addEventListener\('click', \(ev\) => \{ if \(ev\.currentTarget\.dataset\.act === 'listen'\) \{ micYield\(\); reader\.resume\(\); \} else stopReading\(\{ disarm: true \}\); \}\);/);
  assert.match(APP, /\$\('#readChipStop'\)\.addEventListener\('click', \(\) => stopReading\(\{ disarm: true \}\)\);/);
  assert.match(APP, /case 'speak-stop': return stopReading\(\{ disarm: true \}\);/);
  // run() reads a finished spoken turn; a keyed launch's said words are noted; the Assist label is unchanged
  assert.match(fnSource('run'), /\n    autoReadDone\(e, thread\);/);
  assert.match(APP, /markSpoken: \(text, from\) => noteVoice\(text, from\),/);
  // the agent's last words
  assert.match(fnSource('runAgent'), /\n    agentSaid\(e, text\);/);
  // the chip markup and its 44 px targets
  assert.match(HTML, /<div class="read-chip" id="readChip" role="group" aria-label="Read aloud" hidden>\n {8}<button type="button" class="read-chip-main" id="readChipMain" data-act="stop"><\/button>\n {8}<button type="button" class="read-chip-x" id="readChipStop" aria-label="Stop reading"/);
  assert.match(CSS, /\.read-chip button \{[^}]*min-height: 44px;/);
  assert.match(CSS, /\.read-chip-x \{ width: 44px;/);
});

function chipRig({ coarse = false, speakBtn = true } = {}) {
  const focused = [];
  const el = (name) => ({ name, hidden: true, innerHTML: '', textContent: '', dataset: {}, kids: [], contains(x) { return x === this || this.kids.includes(x); }, focus() { focused.push(name); vars.document.activeElement = this; }, classList: { on: new Set(), toggle(c, v) { v ? this.on.add(c) : this.on.delete(c); } } });
  const nodes = { '#readChip': el('chip'), '#readChipMain': el('main'), '#readChipStop': el('x'), '#activityStatus': el('status') };
  nodes['#readChip'].kids.push(nodes['#readChipMain'], nodes['#readChipStop']);
  const speak = el('speak'), queries = [];
  const vars = {
    reader: { cur: null, current() { return this.cur; } }, $: (s) => nodes[s], ICON: { play: '▶', stop: '■' }, chipFor: '', chipAsked: false,
    document: { activeElement: null }, CSS: { escape: (s) => s }, COARSE: { matches: coarse }, input: el('input'),
    stream: { querySelector: (q) => { queries.push(q); return speakBtn ? speak : null; } },
  };
  Object.assign(vars, lift(vars, 'paintReadChip'));
  return { vars, nodes, focused, queries };
}

test('paintReadChip: Stop reading while it reads; Tap to listen when blocked, Resume when paused; hidden for previews and when idle', () => {
  const { vars, nodes } = chipRig();
  const { paintReadChip } = vars;
  const paint = (cur) => { vars.reader.cur = cur; paintReadChip(); return [nodes['#readChip'].hidden, nodes['#readChipMain'].innerHTML, nodes['#readChipMain'].dataset.act, nodes['#readChipStop'].hidden]; };
  assert.deepEqual(paint({ id: 'e1', state: 'preparing', auto: true }), [false, '■<span>Stop reading</span>', 'stop', true]);
  assert.deepEqual(paint({ id: 'e1', state: 'playing', auto: false }), [false, '■<span>Stop reading</span>', 'stop', true]);
  assert.deepEqual(paint({ id: 'e1', state: 'paused', auto: true, blocked: true }), [false, '▶<span>Tap to listen</span>', 'listen', false]);
  assert.deepEqual(paint({ id: 'e1', state: 'paused', auto: false, blocked: false }), [false, '▶<span>Resume</span>', 'listen', false]);
  assert.equal(paint({ id: 'preview:sulafat', state: 'playing' })[0], true);
  assert.equal(paint(null)[0], true);
});

test('paintReadChip: hiding with focus in it hands focus to the answer’s Read aloud (else the prompt box, not on touch); Tap to listen is announced once', () => {
  const r = chipRig(), { nodes, vars, focused } = r;
  vars.reader.cur = { id: 'e7', state: 'playing', auto: true };
  vars.paintReadChip();
  vars.document.activeElement = nodes['#readChipMain']; // Enter on "Stop reading"
  vars.reader.cur = null;
  vars.paintReadChip();
  assert.equal(nodes['#readChip'].hidden, true);
  assert.deepEqual(focused, ['speak'], 'the answer’s own Read aloud button');
  assert.match(r.queries[0], /\.entry\[data-id="e7"\] \.actions \[data-act="speak"\]/);
  // not focused in the chip: focus is left alone
  const n = chipRig();
  n.vars.reader.cur = { id: 'e1', state: 'playing', auto: true }; n.vars.paintReadChip();
  n.vars.document.activeElement = n.vars.input;
  n.vars.reader.cur = null; n.vars.paintReadChip();
  assert.deepEqual(n.focused, []);
  // no such button on screen: the prompt box with a keyboard and mouse, nothing on a touch screen (no keyboard pop)
  for (const [coarse, want] of [[false, ['input']], [true, []]]) {
    const k = chipRig({ coarse, speakBtn: false });
    k.vars.reader.cur = { id: 'e1', state: 'playing', auto: true }; k.vars.paintReadChip();
    k.vars.document.activeElement = k.nodes['#readChipStop'];
    k.vars.reader.cur = null; k.vars.paintReadChip();
    assert.deepEqual(k.focused, want, `coarse ${coarse}`);
  }
  // "Tap to listen": said once by the status region, again for another answer
  const a = chipRig(), status = a.nodes['#activityStatus'];
  a.vars.reader.cur = { id: 'e1', state: 'preparing', auto: true }; a.vars.paintReadChip();
  assert.equal(status.textContent, '');
  a.vars.reader.cur = { id: 'e1', state: 'paused', auto: true, blocked: true }; a.vars.paintReadChip();
  assert.match(status.textContent, /Tap to listen/);
  status.textContent = '';
  a.vars.paintReadChip();
  assert.equal(status.textContent, '', 'not repeated on every repaint');
  a.vars.reader.cur = { id: 'e2', state: 'paused', auto: true, blocked: true }; a.vars.paintReadChip();
  assert.match(status.textContent, /Tap to listen/);
  // a plain Resume (paused by you) isn't announced
  const p = chipRig();
  p.vars.reader.cur = { id: 'e1', state: 'paused', auto: false, blocked: false }; p.vars.paintReadChip();
  assert.equal(p.nodes['#activityStatus'].textContent, '');
});

test('Retry re-arms only a spoken turn this device sent this session; a mark that synced in or came back in a backup stays silent', () => {
  let unlocks = 0;
  const vars = { autoArmed: new Set(), spokeHere: new Set(), unlockReading: () => { unlocks++; } };
  Object.assign(vars, lift(vars, 'rearmRetry', 'armSpoken'));
  const synced = { id: 'e1', spoken: 'dictation' };
  vars.rearmRetry(synced);
  assert.deepEqual([vars.autoArmed.size, unlocks], [0, 0]);
  const mine = { id: 'e2', spoken: 'talk' };
  vars.armSpoken(mine.id); vars.autoArmed.clear(); // sent here, read once
  vars.rearmRetry(mine);
  assert.deepEqual([[...vars.autoArmed], unlocks], [['e2'], 1]);
  vars.rearmRetry({ id: 'e2' }); // the mark is what counts too
  assert.equal(unlocks, 1);
  assert.match(APP, /\n      rearmRetry\(e\);[^\n]*\n[^\n]*\n      return run\(e\);/);
});

test('type-over: dictation replaced by your own edit no longer counts, even with similar words; a partial edit keeps what is left', () => {
  const said = (text) => [{ text, from: 'dictation' }];
  // the module: words taken out of the pieces, latest first
  assert.deepEqual(dropSpoken(said('how do I make a reservation for tonight'), 'how do I make a reservation for tonight'), []);
  assert.deepEqual(dropSpoken([{ text: 'one two', from: 'talk' }, { text: 'two three', from: 'dictation' }], 'two'), [{ text: 'one two', from: 'talk' }, { text: 'three', from: 'dictation' }]);
  assert.deepEqual(dropSpoken(said('今天天气'), '天'), [{ text: '今 天 气', from: 'dictation' }]);
  assert.deepEqual(wordsOf('今 天 气'), ['今', '天', '气']);
  assert.deepEqual(dropSpoken(said('hello'), '  '), said('hello'));
  // the composer's beforeinput, run: select all and type over it
  const rig = (value, a, b) => {
    const vars = { input: { value, selectionStart: a, selectionEnd: b }, voicePieces: said(value), dropSpoken };
    Object.assign(vars, lift(vars, 'composerReplacing'));
    return vars;
  };
  const all = rig('how do I make a reservation for tonight', 0, 39);
  all.composerReplacing({ isTrusted: true, inputType: 'insertText' });
  assert.equal(spokenFrom('how do I make a cake', all.voicePieces), '', 'typed over');
  const tokyo = rig('what is the weather in Paris today', 0, 34);
  tokyo.composerReplacing({ isTrusted: true, inputType: 'insertFromPaste' });
  assert.equal(spokenFrom('what is the time in Tokyo', tokyo.voicePieces), '');
  // only the end replaced: the dictated start still counts (4 of 6 words said)
  const part = rig('how do I make a reservation for tonight', 13, 39); // "a reservation for tonight"
  part.composerReplacing({ isTrusted: true, inputType: 'insertText' });
  assert.equal(spokenFrom('how do I make a cake', part.voicePieces), 'dictation');
  // a plain keystroke (no selection), dictation's own writes (untrusted) and undo/redo leave it alone
  for (const [a, b, ev] of [[39, 39, { isTrusted: true, inputType: 'insertText' }], [0, 39, { isTrusted: false, inputType: 'insertText' }], [0, 39, { isTrusted: true, inputType: 'historyUndo' }]]) {
    const v = rig('how do I make a reservation for tonight', a, b);
    v.composerReplacing(ev);
    assert.deepEqual(v.voicePieces, said('how do I make a reservation for tonight'), JSON.stringify(ev));
  }
});

test('setComposer: Edit prompt, Animate, Omni edit, Edit image, a remix revise and clearInput forget what voice put in the box', () => {
  const vars = { input: { value: 'make the sky darker' }, voicePieces: [{ text: 'make the sky darker', from: 'dictation' }] };
  Object.assign(vars, lift(vars, 'setComposer'));
  vars.setComposer('');
  assert.deepEqual([vars.input.value, vars.voicePieces], ['', []]);
  assert.equal(spokenFrom('make the sky blue', vars.voicePieces), '', 'typed next: not spoken');
  vars.voicePieces = [{ text: 'make it brighter', from: 'dictation' }];
  vars.setComposer('make it darker');
  assert.deepEqual([vars.input.value, vars.voicePieces], ['make it darker', []]);
  // every path that writes the composer for you goes through it
  assert.match(APP, /case 'edit-prompt': setMode\(e\.kind\); setComposer\(e\.prompt\);/);
  assert.match(APP, /\n      setComposer\(e\.enhanced \|\| e\.prompt\); setMark/); // animate
  assert.match(APP, /\n      setComposer\(''\); setMark\(''\); autosize\(\); input\.focus\(\);\n      return toast\('Describe the change/); // omni-edit
  assert.match(APP, /\n      setComposer\(''\); setMark\(''\); autosize\(\);\n      return input\.focus\(\);/); // edit-image
  assert.match(APP, /if \(remix\.revise\(c\.entry, text\)\) \{ setComposer\(''\); autosize\(\); \}/);
  assert.match(APP, /clearInput: \(\) => \{ setComposer\(''\); autosize\(\); \}/);
});

test('Read aloud right after an answer read itself replays the same words from the clips it has (no new TTS for a small table)', async () => {
  const r = rig();
  const md = 'Here is your day.\n\n| Time | What |\n|---|---|\n| 9 | Standup |\n| 11 | Review |\n\nAfter that you are free for the afternoon, so maybe take a walk.';
  r.reader.auto('e1', md);
  await until(() => r.reader.stateFor('e1') === 'playing', 'auto playing');
  for (let i = 0; i < 20 && r.reader.current(); i++) { const prev = r.el().src; r.el().finish(); await until(() => r.el().src !== prev || !r.reader.current(), 'next segment'); }
  const paid = r.calls.length;
  assert.ok(paid > 0);
  r.reader.toggle('e1', md);
  await until(() => r.reader.stateFor('e1') === 'playing', 'replay playing');
  for (let i = 0; i < 20 && r.reader.current(); i++) { const prev = r.el().src; r.el().finish(); await until(() => r.el().src !== prev || !r.reader.current(), 'next segment'); }
  assert.equal(r.calls.length, paid, 'every clip came from memory');
  // another answer (or this one's new text after Retry) reads its small tables row by row, as before
  r.reader.toggle('e2', md);
  await until(() => r.calls.length > paid, 'new text fetched');
  assert.match(r.calls.slice(paid).map((c) => c.body.text).join(' '), /Time: 9, What: Standup\./);
  r.reader.stop();
});
