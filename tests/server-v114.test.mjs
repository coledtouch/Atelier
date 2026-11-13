// v114 review fixes in the Worker: tester metering (src/tester/router.js, ledger.js), tester session lookups
// (src/tester/auth.js, src/worker.js) and the addendum that specifies them. The real Worker runs against the fakes in
// tests/tester-env.mjs; each test fails on the code as it was before its fix. (The passcode guard's alarm is in
// tests/guard.test.mjs, the Ledger's own rows and words in tests/ledger.test.mjs.)
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeEnv, mockFetch, restoreFetch, upstream, reply, api, signIn, PROFILE, resetTesterCaches, allowanceOf } from './tester-env.mjs';
import { imageCost, veoCost, sttWorstCase, sttActual, STT_MIN_BYTES_PER_SECOND, TESTER_VIDEO_MODELS } from '../src/tester/prices.js';
import { TTS_VOICES, RETIRED_VOICES, GEMINI_MAX_OUTPUT_TOKENS } from '../src/tts.js';
import { STT_MODELS } from '../src/transcribe.js';
import { problems } from './humanizer-lint.mjs';

const { LIMITS } = await import('../src/tester/router.js');
const { OVERRUN, OMNI_JOB_TTL } = await import('../src/tester/ledger.js');

// The Worker logs what it does with a refusal: kept out of the test output, and read by the tests that check a log line.
let logs = [];
const realWarn = console.warn, realError = console.error;
beforeEach(() => {
  resetTesterCaches();
  logs = [];
  console.warn = (...a) => logs.push(a.map(String).join(' '));
  console.error = (...a) => logs.push(a.map(String).join(' '));
});
afterEach(() => { restoreFetch(); console.warn = realWarn; console.error = realError; });

const DAY = 86_400_000;
const post = (body, headers = {}) => ({ method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });
const codeOf = async (r) => (await r.clone().json().catch(() => ({}))).code;
const spent = (L, sub) => L.ledger.allowance(sub).day;
// A signed-in tester. call() checks that no tester-facing error ever mentions a passcode.
async function tester({ config = {}, env: extra = {} } = {}) {
  const { env, L } = makeEnv(extra);
  const t = await signIn(L, PROFILE());
  if (Object.keys(config).length) L.ledger.setConfig(config);
  const call = async (path, init = {}, who = {}) => {
    const r = await api(env, path, init, { cookie: t.token, ...who });
    if (r.status >= 400) assert.ok(!/passcode/i.test(await r.clone().text()), `${path}: an error mentions the passcode`);
    return r;
  };
  return { env, L, ...t, call };
}

// ── testers #1: a gateway's answer, or none, may have been billed ──
const IMAGES = /^POST https:\/\/api\.openai\.com\/v1\/images\/generations$/;
const FOX = { model: 'gpt-image-2.5-flare', prompt: 'a fox', n: 4, size: '1024x1024', quality: 'low' };
const FOX_COST = imageCost({ model: 'openai:gpt-image-2.5-flare', n: 4, size: '1024x1024', quality: 'low', promptTokens: 2 });

test('tester images: a gateway’s 502, 504 or 52x keeps the reservation, as the owner’s record keeps its quote; the provider’s own refusal is $0', async () => {
  for (const [status, kept] of [[502, true], [504, true], [520, true], [524, true], [530, true], [400, false], [401, false], [429, false], [500, false], [503, false]]) {
    const { L, sub, call } = await tester();
    mockFetch([[IMAGES, () => reply(status, status >= 502 && status !== 503 ? '<html>error code: gateway</html>' : { error: { message: 'no' } })]]);
    const r = await call('x/openai/images/generations', post(FOX));
    assert.equal(r.status, status, 'the answer reaches the app as it came');
    assert.deepEqual(spent(L, sub), { spent: kept ? FOX_COST : 0, reserved: 0, limit: 1_000_000 }, `${status}: ${kept ? 'the images may have been made and billed' : 'the provider refused, nothing was made'}`);
    assert.equal(allowanceOf(r).dayLeft, 1_000_000 - FOX_COST, 'the header is the allowance with the reservation held');
  }
});

test('tester images: no answer at all (the fetch failed after the request went out) keeps the reservation; so does a gateway’s answer to Gemini and Meta', async () => {
  let t = await tester();
  mockFetch([[IMAGES, () => { throw new TypeError('connection reset by peer'); }]]);
  let r = await t.call('x/openai/images/generations', post(FOX));
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /^Upstream unreachable/);
  assert.deepEqual(spent(t.L, t.sub), { spent: FOX_COST, reserved: 0, limit: 1_000_000 });
  // the other two image routes go through the same code
  t = await tester();
  mockFetch([[/:generateContent$/, () => reply(504, 'upstream request timeout')]]);
  r = await t.call('x/gemini/v1beta/models/gemini-nano-banana-2.1:generateContent', post({ contents: [{ parts: [{ text: 'a fox' }] }] }));
  assert.equal(r.status, 504);
  assert.equal(spent(t.L, t.sub).spent, imageCost({ model: 'gemini:gemini-nano-banana-2.1', size: '1K', promptTokens: 2 }));
  t = await tester();
  mockFetch([[/api\.meta\.ai\/v1\/images\/generations$/, () => reply(502, 'bad gateway')]]);
  r = await t.call('x/meta/images/generations', post({ model: 'muse-image-1.0', prompt: 'a fox', n: 2 }));
  assert.equal(r.status, 502);
  assert.equal(spent(t.L, t.sub).spent, imageCost({ model: 'meta:muse-image-1.0', n: 2, size: '1024x1024' }));
});

const OMNI = 'gemini:gemini-omni-1.1-flash';
const INTERACTIONS = /^POST https:\/\/generativelanguage\.googleapis\.com\/v1beta\/interactions$/;
const clip = (seconds, margin = true) => veoCost({ model: OMNI, seconds, resolution: '720p', margin });

test('tester Omni start: a gateway’s answer keeps the reservation (Google may have started the clip); Google’s own 500, 503 or 429 refunds it', async () => {
  for (const [status, kept] of [[502, true], [504, true], [524, true], [500, false], [503, false], [429, false], [400, false]]) {
    const { L, sub, call } = await tester();
    mockFetch([[INTERACTIONS, () => reply(status, { error: { code: status, status: 'UNAVAILABLE', message: 'x' } })]]);
    const r = await call('omni/start', post({ prompt: 'waves', seconds: 4 }));
    assert.equal(r.status, status === 429 ? 429 : status === 400 ? 400 : 503, String(status));
    assert.equal(await codeOf(r), status === 400 ? 'omni_rejected' : 'omni_busy');
    assert.deepEqual(spent(L, sub), { spent: kept ? clip(4) : 0, reserved: 0, limit: 1_000_000 }, `${status}`);
    assert.equal(L.shim.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'omni'").get().n, 0, 'no id came back: no job row');
  }
  // no answer at all: as before
  const { L, sub, call } = await tester();
  mockFetch([[INTERACTIONS, () => { throw new TypeError('socket hang up'); }]]);
  const r = await call('omni/start', post({ prompt: 'waves', seconds: 4 }));
  assert.equal(await codeOf(r), 'omni_unreachable');
  assert.equal(spent(L, sub).spent, clip(4));
});

// ── testers #2: an edit keeps the earlier clip's length ──
const OMNI_B64 = Buffer.from(Uint8Array.from({ length: 3_000 }, (_, i) => i % 251)).toString('base64');
const omniDone = (id, usage) => ({ id, status: 'completed', model: 'gemini-omni-1.1-flash', steps: [{ type: 'model_output', content: [{ type: 'video', mime_type: 'video/mp4', data: OMNI_B64 }] }], ...(usage ? { usage } : {}) });
// Google: every start gets the next id; every clip is finished, with a video and no usage report.
function omniGoogle() {
  let n = 0;
  mockFetch([
    [INTERACTIONS, () => reply(200, { id: `v1_e${++n}`, status: 'in_progress' })],
    [/^GET .*\/v1beta\/interactions\/v1_e\d+$/, (c) => reply(200, omniDone(c.url.split('/').at(-1)))],
  ]);
}

test('tester Omni edit: held at the length of the clip it edits when that is longer than the seconds the request names', async () => {
  const { L, sub, call } = await tester({ config: { day_limit: 50_000_000 } });
  omniGoogle();
  const start = (body) => call('omni/start', post({ prompt: 'waves', ...body }));
  // → [the answer, what the start added to today's reservations]
  const held = async (body) => { const before = spent(L, sub).reserved, r = await start(body); return [r, spent(L, sub).reserved - before]; };
  assert.deepEqual([clip(4), clip(6), clip(6, false)], [506_800, 760_200, 608_160]);

  let [r, amount] = await held({ seconds: 6 }); // v1_e1: a 6 s clip
  assert.equal(r.status, 200);
  assert.equal(amount, clip(6));
  // the tester sets the length to 4 s and taps Edit: the app sends seconds: 4 with every start, Google films 6 s
  [r, amount] = await held({ seconds: 4, previous: 'v1_e1', task: 'edit', prompt: 'make it night' }); // v1_e2
  assert.equal(r.status, 200);
  assert.deepEqual(upstream.calls.at(-1).json.response_format, { type: 'video', resolution: '720p' }, 'an edit is sent no duration: it keeps its clip’s length');
  assert.equal(amount, clip(6), 'held at the clip’s 6 s, not the 4 s the request names');
  assert.equal(allowanceOf(r).dayLeft, 50_000_000 - 2 * clip(6));
  // its finish reports no usage: it settles at the 6 s price (it was the 4 s one: a third short)
  const before = spent(L, sub).spent;
  assert.equal((await call('omni/status/v1_e2')).status, 200);
  assert.equal(spent(L, sub).spent - before, clip(6, false));
  // an edit of that edit is the same 6 s clip
  [r, amount] = await held({ seconds: 4, previous: 'v1_e2' }); // v1_e3 (no task: an edit too)
  assert.equal(amount, clip(6));
  // the other way round (a 4 s clip, the setting on 6 s): the longer of the two, as before
  await start({ seconds: 4 }); // v1_e4
  [r, amount] = await held({ seconds: 6, previous: 'v1_e4', task: 'edit' }); // v1_e5
  assert.equal(amount, clip(6));
  // a 4 s edit of a 4 s clip costs what it did
  [r, amount] = await held({ seconds: 4, previous: 'v1_e4', task: 'edit' }); // v1_e6
  assert.equal(amount, clip(4));
  assert.equal(L.ledger.jobActual(sub, 'omni:v1_e6'), clip(4, false));
  // an extension sends its own duration and is held at it
  [r, amount] = await held({ seconds: 4, previous: 'v1_e1', task: 'extend' }); // v1_e7
  assert.equal(upstream.calls.at(-1).json.response_format.duration, '4s');
  assert.equal(amount, clip(4));
  // a clip's row without a recorded price (none is written that way) counts as the longest tester clip: 8 s is over
  // the $1.00 cap, so nothing is reserved or sent
  L.ledger.addJob(sub, 'omni:v1_unpriced', 'omni');
  const sent = upstream.calls.length;
  [r, amount] = await held({ seconds: 4, previous: 'v1_unpriced', task: 'edit' });
  assert.equal(r.status, 402);
  assert.equal((await r.json()).scope, 'call');
  assert.deepEqual([amount, upstream.calls.length], [0, sent]);
  assert.equal(LIMITS.videoSeconds, 8);
});

test('tester Omni edit: an edit that is never polled settles at the clip’s length too (the stale sweep keeps the reservation)', async () => {
  const { L, sub, call } = await tester({ config: { day_limit: 50_000_000 } });
  omniGoogle();
  await call('omni/start', post({ prompt: 'waves', seconds: 6 })); // v1_e1
  await call('omni/status/v1_e1');
  const before = spent(L, sub).spent;
  assert.equal(before, clip(6, false));
  assert.equal((await call('omni/start', post({ prompt: 'at night', seconds: 4, previous: 'v1_e1', task: 'edit' }))).status, 200);
  L.shim.db.prepare('UPDATE reservations SET created_at = created_at - ?').run(16 * 60_000); // 16 minutes go by with no status check
  assert.equal(L.ledger.expireStale(), 1);
  assert.deepEqual(spent(L, sub), { spent: before + clip(6), reserved: 0, limit: 50_000_000 }, 'the 6 s reservation, not the 4 s one');
});

// ── testers #3: the Ledger knows whose Omni clip it is for as long as the clip can be edited ──
test('a tester can still edit their own Omni clip 8 days on, and 54 days on; someone else never can, and nobody after 55 days', async () => {
  const { L, sub, call } = await tester({ config: { day_limit: 50_000_000 } });
  omniGoogle();
  let now = Date.now();
  L.ledger.clock = () => now;
  assert.equal((await call('omni/start', post({ prompt: 'waves', seconds: 4 }))).status, 200); // v1_e1
  await call('omni/status/v1_e1');
  const edit = (who = {}) => call('omni/start', post({ prompt: 'make it night', seconds: 4, previous: 'v1_e1', task: 'edit' }), who);
  const stranger = (await signIn(L, PROFILE())).token;
  for (const days of [8, 54]) {
    now += (days === 8 ? 8 : 46) * DAY;
    await L.ledger.alarm();
    const r = await edit();
    assert.equal(r.status, 200, `day ${days}: ${await codeOf(r)}`);
    assert.equal((await call('omni/status/v1_e1')).status, 200, 'and check on it');
    assert.equal(await codeOf(await edit({ cookie: stranger })), 'tester_owner', 'never someone else’s');
  }
  assert.equal(OMNI_JOB_TTL, 55 * DAY);
  now += DAY; // day 55: Google no longer has the interaction either
  await L.ledger.alarm();
  const gone = await edit();
  assert.deepEqual([gone.status, await codeOf(gone)], [403, 'tester_owner']);
});

// ── testers #4: the text cap's refusal says what can be done ──
test('chat over the 400 KB text cap: one long turn is told to send a shorter file; a long conversation, to start a new thread', async () => {
  const { L, sub, call } = await tester();
  mockFetch([]);
  assert.equal(LIMITS.chatText, 400 * 1024);
  const model = 'gemini:gemini-3.5-flash-lite';
  // One long Chinese file in a new thread: the device cuts a file at 150,000 characters, which are 450,000 bytes here.
  const file = '汉'.repeat(150_000);
  let r = await call('chat', post({ model, messages: [{ role: 'system', content: 'You are Atelier.' }, { role: 'user', content: `Summarise this file.\n\n${file}` }] }));
  assert.equal(r.status, 413);
  let j = await r.json();
  assert.deepEqual(j, { error: 'This message is too long for one tester request. Send a shorter file, or paste the part you need.', code: 'tester_too_large' });
  assert.doesNotMatch(j.error, /new thread/, 'it is a new thread already');
  // …the same when the turn is the newest of a thread: starting over wouldn't help
  r = await call('chat', post({ model, messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Hello.' }, { role: 'user', content: file }] }));
  assert.match((await r.json()).error, /^This message is too long for one tester request\./);
  // Each turn fits alone, the replayed history doesn't: the advice that can be followed is the old one.
  const half = '汉'.repeat(80_000); // 240,000 bytes
  r = await call('chat', post({ model, messages: [{ role: 'user', content: half }, { role: 'assistant', content: 'Read.' }, { role: 'user', content: half }] }));
  assert.equal(r.status, 413);
  j = await r.json();
  assert.deepEqual(j, { error: 'This conversation is too large for a tester request — start a new thread or attach less.', code: 'tester_too_large' });
  for (const text of ['This message is too long for one tester request. Send a shorter file, or paste the part you need.']) assert.deepEqual(problems(text), [], text);
  // a turn just under the cap is still taken (the cap itself didn't move)
  mockFetch([[/generativelanguage\.googleapis\.com\/v1beta\/openai\/chat\/completions$/, () => reply(429, { error: { message: 'slow down' } })]]);
  r = await call('chat', post({ model, messages: [{ role: 'user', content: 'x'.repeat(399 * 1024) }] }));
  assert.equal(r.status, 429, 'reached the provider');
  assert.deepEqual(spent(L, sub), { spent: 0, reserved: 0, limit: 1_000_000 });
});

// ── testers #6: through the owner's route, the refusal the Testers panel toasts ──
test('POST /api/testers/config: a limit over the server’s maximum is refused in dollars, in the panel’s own words', async () => {
  const { env } = makeEnv();
  const save = (body) => api(env, 'testers/config', { method: 'POST', body }, { pass: 'pw' });
  let r = await save({ cap: 25, day_limit: 150_000_000, month_limit: 500_000_000, pool_limit: 1_000_000_000 }); // $150 a day, $500 a month
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: 'The daily limit can’t go above $100.', code: 'bad_config' });
  r = await save({ month_limit: 2_000_000_000 });
  assert.deepEqual(await r.json(), { error: 'The monthly limit can’t go above $1,000.', code: 'bad_config' });
  assert.equal((await save({ day_limit: 100_000_000, month_limit: 500_000_000 })).status, 200, '$100 a day is the most, and saves');
});

// ── testers #0 (the safe part): what the Ledger doesn't record is in the log ──
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const mp4 = (n) => { const b = new Uint8Array(n); b.set([0, 0, 0, 0x1c, ...ascii('ftypiso5'), 0, 0, 2, 0, ...ascii('iso5iso6mp41')]); for (let i = 28; i < n; i++) b[i] = (i * 31 + 7) & 0xff; return b; };
const TRANSCRIPTIONS = /^POST https:\/\/api\.openai\.com\/v1\/audio\/transcriptions$/;
const dictate = (t, bytes) => t.call('transcribe', { method: 'POST', body: bytes, headers: { 'content-type': 'audio/mp4' } });

test('a call billed past 4x its reservation: the Ledger records 4x, and the log names the whole reported cost beside it', async () => {
  // 100 KB of MP4 is reserved as 100 s (its bytes at 1,000 a second); OpenAI reports 1,200 s of audio
  const t = await tester();
  mockFetch([[TRANSCRIPTIONS, () => reply(200, { text: 'x', usage: { type: 'duration', seconds: 1_200 } })]]);
  const r = await dictate(t, mp4(100_000));
  assert.equal(r.status, 200);
  const reserved = sttWorstCase({ model: 'openai:gpt-transcribe', seconds: null, bytes: 100_000 });
  const billed = sttActual({ model: 'openai:gpt-transcribe', usage: { type: 'duration', seconds: 1_200 } });
  assert.deepEqual([STT_MIN_BYTES_PER_SECOND, reserved, billed, OVERRUN], [1_000, 9_375, 90_000, 4]);
  assert.deepEqual(spent(t.L, t.sub), { spent: 37_500, reserved: 0, limit: 1_000_000 }, 'the Ledger’s bound: 4 x the reservation');
  const line = logs.find((l) => l.startsWith('tester call cost more than the Ledger records'));
  assert.equal(line, 'tester call cost more than the Ledger records transcribe reserved 9375 recorded 37500 reported 90000');
  assert.ok(!line.includes(t.sub) && !logs.some((l) => l.includes(t.token)), 'the route and the amounts: never who');
  // inside the bound nothing is dropped: the old line (reserved → charged), never the new one
  logs.length = 0;
  mockFetch([[TRANSCRIPTIONS, () => reply(200, { text: 'x', usage: { type: 'duration', seconds: 300 } })]]);
  await dictate(t, mp4(100_000));
  assert.equal(spent(t.L, t.sub).spent, 37_500 + 22_500);
  assert.deepEqual(logs.filter((l) => /^tester call cost more/.test(l)), ['tester call cost more than its reservation transcribe 9375 → 22500']);
  // under the reservation: neither
  logs.length = 0;
  mockFetch([[TRANSCRIPTIONS, () => reply(200, { text: 'x', usage: { type: 'duration', seconds: 20 } })]]);
  await dictate(t, mp4(100_000));
  assert.deepEqual(logs.filter((l) => /^tester call cost more/.test(l)), []);
});

// ── worker #4: made-up tester cookies and the Ledger ──
// A ratelimit binding like LI_LIMIT: `limit` calls a key may make (a test is well inside the binding's minute).
function limiter(limit = 20) {
  const seen = new Map(), keys = [];
  return { keys, seen, async limit({ key }) { keys.push(key); const n = (seen.get(key) || 0) + 1; seen.set(key, n); return { success: n <= limit }; } };
}
const madeUp = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
const from = (ip) => ({ headers: { 'cf-connecting-ip': ip } });
const SHED = { error: 'Too many sign-in checks from your network right now. Try again in a minute.', code: 'session_busy' };

test('made-up tester cookies: 20 a minute from one network reach the Ledger; the rest are shed with 429, and the cookie is left alone', async () => {
  const lim = limiter();
  const { env, L } = makeEnv({ LI_LIMIT: lim });
  L.calls.length = 0;
  const answers = [];
  for (let i = 0; i < 30; i++) answers.push(await api(env, 'tester/me', from('203.0.113.9'), { cookie: madeUp() }));
  assert.deepEqual(answers.map((r) => r.status), [...Array(20).fill(401), ...Array(10).fill(429)]);
  assert.equal(L.calls.filter((m) => m === 'session').length, 20, 'the Ledger saw 20 lookups, not 30');
  assert.deepEqual(L.calls.filter((m) => m !== 'session'), []);
  const shed = answers[25];
  assert.deepEqual(await shed.json(), SHED);
  assert.equal(shed.headers.get('retry-after'), '30');
  assert.equal(shed.headers.get('set-cookie'), null, 'not "sign in again": a cookie that wasn’t looked up is not cleared');
  assert.equal(shed.headers.get('cache-control'), 'no-store');
  assert.match(answers[0].headers.get('set-cookie'), /^__Host-atelier_tester=; Path=\/; Max-Age=0/, 'one the Ledger doesn’t know still is');
  assert.deepEqual([...new Set(lim.keys)], ['sess:203.0.113.9'], 'counted per network, under its own key');
  assert.deepEqual(problems(SHED.error), [], 'the copy rules');
  assert.doesNotMatch(SHED.error, /passcode/i);
  // another network has its own count, and an IPv6 address counts by its /64
  assert.equal((await api(env, 'tester/me', from('203.0.113.10'), { cookie: madeUp() })).status, 401);
  for (const ip of ['2001:db8:1:2::1', '2001:db8:1:2:ffff::9']) await api(env, 'tester/me', from(ip), { cookie: madeUp() });
  assert.equal(lim.seen.get('sess:2001:db8:1:2::/64'), 2);
  // a made-up cookie seen again within the minute is answered from the isolate's cache: no lookup, no count
  const again = madeUp();
  const counted = lim.keys.length;
  for (let i = 0; i < 3; i++) assert.equal((await api(env, 'tester/me', from('203.0.113.11'), { cookie: again })).status, 401);
  assert.equal(lim.keys.length, counted + 1);
});

test('a live tester is not shed: cached for a minute, and the re-check of a session this isolate last saw live skips the limit', async () => {
  const lim = limiter(1); // one lookup a minute for this network: the tester's first
  const { env, L } = makeEnv({ LI_LIMIT: lim });
  const { token } = await signIn(L, PROFILE());
  const me = () => api(env, 'tester/me', from('198.51.100.7'), { cookie: token });
  assert.equal((await me()).status, 200);
  assert.deepEqual(lim.keys, ['sess:198.51.100.7']);
  // someone on the same network sends made-up cookies: shed, and the tester beside them is untouched
  for (let i = 0; i < 5; i++) assert.equal((await api(env, 'tester/me', from('198.51.100.7'), { cookie: madeUp() })).status, 429);
  L.calls.length = 0;
  for (let i = 0; i < 5; i++) assert.equal((await me()).status, 200);
  assert.ok(!L.calls.includes('session'), 'answered from the cache');
  // 61 s on the cache entry has run out: the session is checked in the Ledger again, and that check isn't counted
  const counted = lim.keys.length, realNow = Date.now;
  try {
    Date.now = () => realNow() + 61_000;
    assert.equal((await me()).status, 200);
  } finally { Date.now = realNow; }
  assert.equal(L.calls.filter((m) => m === 'session').length, 1, 'looked up again (a revoked session would end here)');
  assert.equal(lim.keys.length, counted, 'without the limiter');
});

test('a real tester whose lookup is shed stays signed in: 429 (503 on thread sync) with Retry-After, and the next try works', async () => {
  let allow = false;
  const { env, L } = makeEnv({ LI_LIMIT: { async limit() { return { success: allow }; } } });
  const { token } = await signIn(L, PROFILE());
  const chat = (who) => api(env, 'chat', post({ model: 'openai:gpt-6-luna', messages: [{ role: 'user', content: 'hi' }] }), who);
  mockFetch([]);
  L.calls.length = 0;
  let r = await chat({ cookie: token });
  assert.equal(r.status, 429);
  assert.deepEqual(await r.json(), SHED);
  assert.equal(r.headers.get('set-cookie'), null);
  assert.deepEqual(L.calls, [], 'nothing reached the Ledger');
  // thread sync answers 503: the sync client reads any 429 as the passcode lockout and pauses for 15 minutes
  r = await api(env, 'tester/sync/index', {}, { cookie: token });
  assert.deepEqual([r.status, r.headers.get('retry-after'), await codeOf(r)], [503, '30', 'session_busy']);
  // with a passcode header the request goes on to the owner's answer, as it does for an ended session
  r = await chat({ pass: 'wrong', cookie: token });
  assert.equal(r.status, 401);
  assert.match((await r.json()).error, /Wrong passcode/);
  allow = true;
  assert.equal((await api(env, 'tester/me', {}, { cookie: token })).status, 200, 'the same cookie, once the limit lets it through');
  // a limiter that fails never keeps a tester out
  resetTesterCaches();
  env.LI_LIMIT = { async limit() { throw new Error('down'); } };
  assert.equal((await api(env, 'tester/me', {}, { cookie: token })).status, 200);
});

test('a burst of made-up cookies sent together is counted one by one: no more lookups reach the Ledger than the limit', async () => {
  const lim = limiter();
  const { env, L } = makeEnv({ LI_LIMIT: lim });
  // the Ledger takes a moment to answer, as a Durable Object call does: every request is in flight before one returns
  env.LEDGER = { ...L.ns, get: () => new Proxy(L.stub, { get: (stub, name) => (name === 'session' ? async (...a) => { await new Promise((ok) => setTimeout(ok, 15)); return stub.session(...a); } : stub[name]) }) };
  L.calls.length = 0;
  const one = madeUp(); // the same cookie many times, and many different ones
  const rs = await Promise.all(Array.from({ length: 60 }, (_, i) => api(env, 'tester/me', from('192.0.2.44'), { cookie: i % 2 ? one : madeUp() })));
  const statuses = rs.map((r) => r.status);
  assert.equal(L.calls.filter((m) => m === 'session').length, 20, 'the limit, whatever arrives together');
  assert.ok(statuses.every((s) => s === 401 || s === 429), statuses.join(' '));
  assert.ok(statuses.filter((s) => s === 429).length >= 10, 'the rest are shed (a repeat of a cookie already answered comes from the cache)');
});

test('sign-out: made-up cookies share the lookups’ limit before the Ledger; a tester this isolate knows is always signed out for real', async () => {
  const lim = limiter();
  const { env, L } = makeEnv({ LI_LIMIT: lim });
  const out = (cookie) => api(env, 'li/logout', { method: 'POST', headers: { 'cf-connecting-ip': '203.0.113.50' } }, { cookie });
  L.calls.length = 0;
  const rs = [];
  for (let i = 0; i < 30; i++) rs.push(await out(madeUp()));
  assert.deepEqual(rs.map((r) => r.status), Array(30).fill(204));
  assert.ok(rs.every((r) => /^__Host-atelier_tester=; Path=\/; Max-Age=0/.test(r.headers.get('set-cookie'))), 'the browser is signed out either way');
  assert.equal(L.calls.filter((m) => m === 'logout').length, 20, 'the Ledger saw 20 of them, not 30');
  assert.deepEqual([...new Set(lim.keys)], ['sess:203.0.113.50']);
  // a real tester signs out from that same network, now over its limit: the session is ended in the Ledger all the same
  const { token } = await signIn(L, PROFILE());
  const me = () => api(env, 'tester/me', from('198.51.100.60'), { cookie: token });
  assert.equal((await me()).status, 200);
  const sessions = () => L.shim.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
  assert.equal(sessions(), 1);
  L.calls.length = 0;
  assert.equal((await out(token)).status, 204);
  assert.deepEqual(L.calls, ['logout']);
  assert.equal(sessions(), 0);
  assert.equal((await me()).status, 401, 'and this isolate stops honouring it at once');
});

// ── testers #7: the addendum against the code ──
test('the addendum describes Read aloud, dictation and tester video as the code has them', async () => {
  const doc = (await readFile(new URL('../docs/superpowers/specs/2026-09-30-atelier-tester-access-addendum.md', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const part = (re) => re.exec(doc)?.[1] || '';
  const a2 = part(/## A2\.([\s\S]*?)\n## /), a3 = part(/## A3\.([\s\S]*?)\n## /), a7b = part(/## A7b\.([\s\S]*?)\n## /);
  const a81 = part(/### A8\.1([\s\S]*?)\n### /), a82 = part(/### A8\.2([\s\S]*?)\n### /);
  // Read aloud: every voice the server has with its model, the retired ids, and nothing of the OpenAI path that is gone
  for (const [id, v] of Object.entries(TTS_VOICES)) {
    assert.equal(v.provider, 'gemini');
    assert.ok(a81.includes(`\`${id}\` (Gemini \`${v.model}\`, prebuilt voice ${v.voice})`), `A8.1 names ${id} as the code has it`);
  }
  for (const id of Object.keys(RETIRED_VOICES)) assert.ok(a81.includes(`\`${id}\``), `A8.1 says what becomes of ${id}`);
  assert.doesNotMatch(a81, /gpt-4o-mini-tts-2025|TTS_CUTOFF_FACTOR|speech\.audio\.done|viaOpenAI|goes to OpenAI/, 'the OpenAI speech path is no longer described as live');
  for (const words of ['`ttsCeilingUnits`', '`reserveTokensPerSecond`', '`ttsReserved`', `\`GEMINI_MAX_OUTPUT_TOKENS\`: ${GEMINI_MAX_OUTPUT_TOKENS.toLocaleString('en-US')} tokens`, 'the text read aloud goes to Google'])
    assert.ok(a81.includes(words), `A8.1: ${words}`);
  // dictation: the models, the duration price and the bytes rule; nothing of the token-window rule
  for (const m of Object.values(STT_MODELS)) assert.ok(a82.includes(`\`${m.model}\``), `A8.2 names ${m.model}`);
  for (const words of ['$0.0045 a minute', `${STT_MIN_BYTES_PER_SECOND.toLocaleString('en-US')} bytes a second (\`STT_MIN_BYTES_PER_SECOND\``, `\`maxOutputTokens\`: ${STT_MODELS.gemini.maxOutputTokens.toLocaleString('en-US')} tokens`,
    'an estimate, not a ceiling', '`tester call cost more than the Ledger records`'])
    assert.ok(a82.includes(words), `A8.2: ${words}`);
  assert.doesNotMatch(a82, /gpt-4o-mini-transcribe|16,000-token|context window|chunking_strategy/);
  // video: Gemini Omni on its own routes; Veo's long-running routes are not described as allowed any more
  assert.deepEqual([...TESTER_VIDEO_MODELS], [OMNI]);
  for (const words of ['Gemini Omni Flash (`gemini-omni-1.1-flash`)', '`POST /api/omni/start`', '`OMNI_JOB_TTL`', "the longer of that clip's length and the seconds the request names", "a gateway's 502, 504 or 52x keeps the reservation"])
    assert.ok(a2.includes(words), `A2: ${words}`);
  assert.doesNotMatch(a2, /Veo is allowed|for the allow-listed `veo-\*` models/);
  assert.match(a7b, /tester video from Gemini Omni/);
  assert.match(a7b, /`gemini:gemini-omni-1\.1-flash` is the only tester video model/);
  assert.doesNotMatch(a7b, /veo-3\.1-generate-preview/);
  assert.match(a3, /`LI_LIMIT`, key `sess:<network>`, 20 a minute/, 'the session-lookup limit is recorded with its key');
  assert.doesNotMatch(a3, /stay `v1beta` only/);
});
