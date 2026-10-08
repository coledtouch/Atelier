import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, makeLedger, mockFetch, restoreFetch, upstream, reply, api, signIn, PROFILE, resetTesterCaches } from './tester-env.mjs';

// The owner's spend record (src/spend.js; Settings → Spending → This month's spend). Since v85 there are no spending
// limits: every paid owner video and image reaches its provider, is recorded in the Ledger (owner_spend) at its quote and
// settled to what the provider reports, and nothing refuses a job for its price. No provider is ever called for real:
// every upstream request goes to a fetch mock, and an unmatched one fails (and is counted in upstream.calls).
const SP = await import('../src/spend.js');
const { TESTER_ROUTES, matchTesterRoute } = await import('../src/tester/router.js');
const { Ledger } = await import('../src/tester/ledger.js');
const { omniActual, veoCost, imageCost, imageActual } = await import('../src/tester/prices.js');
const { RUNWAY_BASE } = await import('../src/runway.js');
const { GEMINI_BASE } = await import('../src/gemini.js');

beforeEach(() => resetTesterCaches());
afterEach(() => restoreFetch());

const RUNWAY_KEY = `key_${'ab12'.repeat(32)}`;
const TASK = '4a7b0c1d-2e3f-4a5b-8c6d-7e8f9a0b1c2d';
const PNG = `data:image/png;base64,${'iVBORw0KGgo'.padEnd(64, 'A')}`;
const OMNI = 'gemini:gemini-omni-1.1-flash';
const ledgers = new WeakMap();
// Tester access off (the production default); the owner's routes are the same either way.
const setup = (extra = {}) => { const made = makeEnv({ RUNWAYML_API_SECRET: RUNWAY_KEY, testers: false, ...extra }); ledgers.set(made.env, made.L); return made; };
const owner = (env, path, init = {}) => api(env, path, init, { pass: 'pw', origin: null });
const post = (body) => ({ method: 'POST', body, headers: { 'content-type': 'application/json' } });
const put = (body) => ({ method: 'PUT', body, headers: { 'content-type': 'application/json' } });
// What v83–v84 saved as the owner's limits (the Ledger's config row 'owner_limits'). v85 never reads it: written here at
// $0.01, it must change nothing.
const legacyLimits = (env, perVideoUsd = 0.01, monthlyMediaUsd = 0.01) => ledgers.get(env).shim.db.prepare('INSERT OR REPLACE INTO config (k, v) VALUES (?, ?)')
  .run('owner_limits', JSON.stringify({ perVideoUsd, monthlyMediaUsd, updatedAt: 1 }));
const body = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const month = (env, m) => owner(env, `owner/spend${m ? `?month=${m}` : ''}`).then(body);
const rows = (L) => L.shim.db.prepare('SELECT * FROM owner_spend ORDER BY rowid').all().map((r) => ({ ...r }));
const rw = (path) => new RegExp(`^(GET|POST|DELETE) ${RUNWAY_BASE.replace(/[.]/g, '\\.')}/${path}$`);
const OMNI_CREATE = /^POST https:\/\/generativelanguage\.googleapis\.com\/v1beta\/interactions$/;
const omniGet = (id) => new RegExp(`^GET ${GEMINI_BASE.replace(/[.]/g, '\\.')}/v1beta/interactions/${id}$`);
const finished = (id, extra = {}) => ({ id, status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'video', mime_type: 'video/mp4', data: 'AAAA' }] }],
  usage: { total_input_tokens: 900, total_output_tokens: 23_500, output_tokens_by_modality: [{ modality: 'video', tokens: 23_168 }] }, ...extra });

// ── the decision: price → limit, at the boundaries ──

test('months are UTC: resetsAt is 00:00 UTC on the 1st, December rolls into January', () => {
  assert.equal(SP.monthOf(Date.UTC(2026, 9, 31, 23, 59, 59, 999)), '2026-10');
  assert.equal(SP.monthOf(Date.UTC(2026, 10, 1)), '2026-11');
  assert.equal(SP.resetsAt('2026-10'), '2026-11-01T00:00:00.000Z');
  assert.equal(SP.resetsAt('2026-12'), '2027-01-01T00:00:00.000Z');
  assert.equal(SP.toUsd(52_685), 0.0527);
  assert.equal(SP.toMicros(0.07), 70_000);
});

// ── the readout ──

test('GET /api/owner/spend is a read-only readout: the month, its spend and the breakdown — no limits; /api/owner/limits is gone', async () => {
  const { env, L } = setup();
  let s = await month(env);
  assert.deepEqual(Object.keys(s).sort(), ['byProvider', 'heldUsd', 'jobs', 'month', 'resetsAt', 'settledUsd', 'totalUsd']);
  assert.deepEqual([s.month, s.totalUsd, s.heldUsd, s.jobs, s.byProvider], [SP.monthOf(), 0, 0, 0, []]);
  assert.equal(s.resetsAt, SP.resetsAt(SP.monthOf()));
  for (const k of ['limits', 'leftUsd', 'perVideoUsd', 'monthlyMediaUsd']) assert.equal(k in s, false, k);
  L.ledger.ownerReserve({ provider: 'runway', kind: 'video', model: 'gen4.5', amount: 1_200_000 });
  const b = L.ledger.ownerReserve({ provider: 'xai', kind: 'image', amount: 40_000 });
  L.ledger.ownerSettle(b.id, 35_000);
  s = await month(env);
  assert.deepEqual([s.totalUsd, s.settledUsd, s.heldUsd, s.jobs], [1.235, 0.035, 1.2, 2]);
  assert.deepEqual(s.byProvider, [{ provider: 'runway', kind: 'video', usd: 1.2, heldUsd: 1.2, jobs: 1 }, { provider: 'xai', kind: 'image', usd: 0.035, heldUsd: 0, jobs: 1 }]);
  // the limits route is gone (GET and PUT): 410 with a reason a v83–v84 device shows as is (its Save limits shows
  // j.error), and nothing is written; the readout is read only
  for (const init of [{}, put({ perVideoUsd: 500, monthlyMediaUsd: 5000 }), post({})]) {
    const r = await owner(env, 'owner/limits', init);
    assert.equal(r.status, 410);
    assert.deepEqual(await body(r), { error: 'Spending limits were removed in Atelier v85 — reload the app to update.', code: 'owner_limits_removed' });
  }
  assert.equal((await owner(env, 'owner/limits/x')).status, 404);
  assert.equal((await owner(env, 'owner/spend', post({}))).status, 405);
  assert.equal((await owner(env, 'owner/spend', put({}))).status, 405);
  assert.equal((await owner(env, 'owner/probe')).status, 404);
  assert.deepEqual([(await owner(env, 'owner/spend?month=2026-13')).status, (await body(await owner(env, 'owner/spend?month=2026-13'))).code], [400, 'owner_spend_input']);
  assert.equal(L.shim.db.prepare("SELECT COUNT(*) AS n FROM config WHERE k = 'owner_limits'").get().n, 0, 'nothing writes limits any more');
  assert.equal(env.ATELIER_KV.m.size, 0);
});

test('owner routes: the passcode only — none and a wrong one get 401; a tester gets 403 owner_only before the KV or the Ledger is touched', async () => {
  const { env, L } = setup();
  for (const [path, init] of [['owner/limits', {}], ['owner/limits', put({ perVideoUsd: 1 })], ['owner/spend', {}]]) {
    assert.equal((await api(env, path, init)).status, 401, `${path}: no passcode`);
    assert.equal((await api(env, path, init, { pass: 'nope' })).status, 401, `${path}: wrong passcode`);
  }
  // with tester access switched on, a live tester session is refused by the deny-by-default router
  const { env: on, L: Lon } = makeEnv({ RUNWAYML_API_SECRET: RUNWAY_KEY });
  const t = await signIn(Lon, PROFILE());
  Lon.calls.length = 0;
  for (const method of ['GET', 'PUT', 'POST', 'DELETE', 'PATCH']) {
    for (const path of ['owner/limits', 'owner/spend', 'owner/spend/x', 'owner/']) {
      const r = await api(on, path, { method, ...(method === 'GET' ? {} : { body: JSON.stringify({ perVideoUsd: 500, monthlyMediaUsd: 5000 }) }) }, { cookie: t.token });
      assert.deepEqual([r.status, (await body(r)).code], [403, 'owner_only'], `${method} ${path}`);
      assert.equal(matchTesterRoute(method, path), null);
    }
  }
  assert.ok(Lon.calls.every((m) => m === 'session'), `${Lon.calls}`);
  // with it off (the default), the same cookie is nobody: 401, and the Ledger is never asked about it
  L.calls.length = 0;
  for (const path of ['owner/spend', 'owner/limits']) assert.equal((await api(env, path, {}, { cookie: t.token })).status, 401, path);
  assert.deepEqual(L.calls, []);
  // the tester table stays deny-by-default: no owner route was added to it
  assert.ok(TESTER_ROUTES.every((r) => !String(r.sample ?? r.match).startsWith('owner')));
});

// ── nothing refuses a paid job for its price ──

const RUNWAY_JOBS = [
  ['text_to_video', { model: 'gen4.5', promptText: 'x', ratio: '1280:720', duration: 10 }, 1.2],
  ['image_to_video', { model: 'gen4_turbo', promptImage: PNG, ratio: '1280:720', duration: 10 }, 0.5],
  ['video_to_video', { model: 'aleph2', promptText: 'snow', videoUri: 'runway://upload/abc123def456' }, 8.4], // length unknown: held at 30 s
  ['text_to_video', { model: 'veo3.1', promptText: 'x', ratio: '1280:720', duration: 8 }, 3.2],
  ['image_to_video', { model: 'veo3.1_fast', promptText: 'x', promptImage: PNG, ratio: '720:1280', duration: 8 }, 1.2],
  ['text_to_video', { model: 'grok_imagine_1_5', promptText: 'x', ratio: '16:9', resolution: '1080p', duration: 15 }, 4.35],
  ['image_to_video', { model: 'grok_imagine_1_5_lite', promptImage: PNG, ratio: 'auto_1080p', duration: 15 }, 2.11],
  ['text_to_video', { model: 'seedance2_5', promptText: 'x', ratio: '1920:1080', duration: 30 }, 20.4],
];
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('no spending refusal on any video or image route: every Runway model (even $20.40 Seedance), Omni 4K, Grok, the image passthrough — each reaches its provider and is recorded', async () => {
  const { env, L } = setup();
  legacyLimits(env); // v83–v84's limits, at $0.01: ignored
  let n = 0;
  mockFetch([
    [rw('(text_to_video|image_to_video|video_to_video)'), () => reply(200, { id: uuid(++n) })],
    [OMNI_CREATE, () => reply(200, { id: `v1_n${++n}`, status: 'queued' })],
    [/x\.ai\/v1\/videos\/generations$/, () => reply(200, { request_id: `vid${++n}` })],
    [/x\.ai\/v1\/images\/generations$/, () => reply(200, { data: [{ b64_json: 'QUJD' }], usage: { cost_in_usd_ticks: 400_000_000 } })],
    [/openai\.com\/v1\/images\/(generations|edits)$/, () => reply(200, { data: [{ b64_json: 'QUJD' }] })],
    [/generateContent$/, () => reply(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'QUJD' } }] } }] })],
    [/meta\.ai\/v1\/images\/generations$/, () => reply(200, { data: [{ b64_json: 'QUJD' }] })],
  ]);
  for (const [kind, b, usd] of RUNWAY_JOBS) {
    const r = await owner(env, `runway/generate/${kind}`, post(b));
    assert.equal(r.status, 200, b.model);
    const j = await body(r);
    assert.equal(j.code, undefined, b.model);
    assert.equal(rows(L).at(-1).amount, Math.round(usd * 1_000_000), `${b.model}: recorded at its quote`);
  }
  const jobs = [
    ['omni/start', { prompt: 'p', seconds: 10, resolution: '4k' }],
    ['omni/start', { prompt: 'p', seconds: 4, resolution: '720p', previous: 'v1_prev', task: 'edit' }],
    ['xai/video/start', { model: 'grok-imagine-video-1.5', prompt: 'waves', seconds: 15 }],
    ['xai/image', { model: 'grok-imagine-image-2.0', prompt: 'a fox' }],
    ['x/openai/images/generations', { model: 'gpt-image-2.5-flare', prompt: 'x', n: 4, quality: 'high', size: '1024x1024' }],
    ['x/openai/images/edits', { model: 'gpt-image-2.5-sunburst', prompt: 'x', n: 1, quality: 'high', images: [{ image_url: PNG }] }],
    ['x/gemini/v1beta/models/gemini-3-pro-image:generateContent', { contents: [{ parts: [{ text: 'x' }] }], generationConfig: { responseModalities: ['IMAGE'], imageConfig: { imageSize: '4K' } } }],
    ['x/gemini/v1/models/gemini-nano-banana-2.1:generateContent', { contents: [{ parts: [{ text: 'x' }] }], generationConfig: { imageConfig: { imageSize: '2K' } } }],
    ['x/meta/images/generations', { model: 'muse-image-1.0', prompt: 'x', n: 1, size: '1024x1024' }],
  ];
  for (const [path, b] of jobs) {
    const r = await owner(env, path, post(b));
    assert.equal(r.status, 200, path);
    assert.ok(!/^owner_cap/.test((await body(r)).code || ''), path);
  }
  assert.equal(upstream.calls.length, RUNWAY_JOBS.length + jobs.length, 'every job reached its provider, once');
  assert.equal(rows(L).length, RUNWAY_JOBS.length + jobs.length, 'and every one is in the record');
  const s = await month(env);
  assert.ok(s.totalUsd > 40, `well past the old $25 / $200 defaults’ per-video limit and the $0.01 legacy row: ${s.totalUsd}`);
  // nothing in the Worker can refuse for a price any more
  for (const k of ['decide', 'capRefusal', 'cleanLimits', 'readLimits', 'normalizeLimits', 'DEFAULT_LIMITS', 'LIMIT_BOUNDS', 'CAP_CODES', 'SpendError']) assert.equal(k in SP, false, k);
  for (const m of ['ownerLimits', 'ownerSetLimits']) assert.equal(typeof Ledger.prototype[m], 'undefined', m);
});

test('concurrent paid starts through the Worker: every one reaches the provider and is recorded', async () => {
  const { env, L } = setup();
  legacyLimits(env, 25, 2); // a v84 “$2 a month” row: three of these would have fit
  let n = 0;
  mockFetch([[/videos\/generations$/, () => reply(200, { request_id: `v${++n}` })]]);
  const rs = await Promise.all(Array.from({ length: 5 }, () => owner(env, 'xai/video/start', post({ model: 'grok-imagine-video-1.5', prompt: 'x', seconds: 8 }))));
  assert.deepEqual(rs.map((r) => r.status), [200, 200, 200, 200, 200]);
  assert.equal(upstream.calls.length, 5);
  assert.equal(rows(L).length, 5);
  assert.equal((await month(env)).totalUsd, 3.2);
});

test('image passthrough: a request Atelier can’t price still goes out — forwarded byte for byte, just not recorded', async () => {
  const { env, L } = setup();
  mockFetch([
    [/openai\.com\/v1\/images\/generations$/, () => reply(200, { data: [{ b64_json: 'QUJD' }] })],
    [/generateContent$/, () => reply(200, { candidates: [] })],
    [/meta\.ai\/v1\/images\/generations$/, () => reply(200, { data: [] })],
  ]);
  const odd = [['x/openai/images/generations', { model: 'gpt-image-9', prompt: 'x' }], ['x/gemini/v1beta/models/gemini-3.8-flash:generateContent', { contents: [{ parts: [{ text: 'x' }] }] }],
    ['x/meta/images/generations', { model: 'muse-image-9', prompt: 'x' }], ['x/openai/images/generations', { model: 'gpt-image-2.5-flare', prompt: 'x', n: 50 }], ['x/openai/images/generations', 'not json']];
  for (const [path, b] of odd) {
    const r = await owner(env, path, post(b));
    assert.equal(r.status, 200, `${path} ${JSON.stringify(b)}`);
    const sent = upstream.calls.at(-1).body;
    assert.equal(typeof sent === 'string' ? sent : new TextDecoder().decode(sent), typeof b === 'string' ? b : JSON.stringify(b), 'as the owner sent it');
  }
  assert.equal(upstream.calls.length, odd.length);
  assert.deepEqual(rows(L), []);
  for (const [provider, sub, b] of [['openai', 'images/generations', { model: 'gpt-image-9' }], ['meta', 'images/generations', { model: 'muse-image-1.0', n: 0 }], ['gemini', 'v1beta/models/x:generateContent', {}], ['openai', 'images/generations', null], ['nope', 'x', {}]]) {
    assert.equal(SP.imageQuote(provider, sub, b), null, `${provider} ${JSON.stringify(b)}`);
  }
});

test('no Ledger: paid owner media still goes out (unrecorded), and the readout says it can’t be read; chat is untouched', async () => {
  const { env } = setup({ ledger: null });
  mockFetch([
    [rw('text_to_video'), () => reply(200, { id: TASK })],
    [OMNI_CREATE, () => reply(200, { id: 'v1_nl', status: 'queued' })],
    [/x\.ai\/v1\/images\/generations$/, () => reply(200, { data: [{ b64_json: 'QUJD' }] })],
    [/meta\.ai\/v1\/images\/generations$/, () => reply(200, { data: [{ b64_json: 'QUJD' }] })],
  ]);
  for (const [path, b] of [['runway/generate/text_to_video', RUNWAY_JOBS[0][1]], ['omni/start', { prompt: 'p' }], ['xai/image', { model: 'grok-imagine-image-2.0', prompt: 'x' }], ['x/meta/images/generations', { model: 'muse-image-1.0', prompt: 'x' }]]) {
    assert.equal((await owner(env, path, post(b))).status, 200, path);
  }
  assert.equal(upstream.calls.length, 4);
  const r = await owner(env, 'owner/spend');
  assert.deepEqual([r.status, (await body(r)).code], [503, 'owner_spend_unavailable']);
});

test('a Ledger that fails never holds a job back: the job goes out, the record just misses it', async () => {
  const { env, L } = setup();
  const real = L.ledger.ownerReserve;
  L.ledger.ownerReserve = () => { throw new Error('storage down'); };
  mockFetch([[rw('text_to_video'), () => reply(200, { id: TASK })], [rw(`tasks/${TASK}`), () => reply(200, { id: TASK, status: 'SUCCEEDED', cost: { credits: 120 } })]]);
  assert.equal((await owner(env, 'runway/generate/text_to_video', post(RUNWAY_JOBS[0][1]))).status, 200);
  assert.equal((await owner(env, `runway/task/${TASK}`)).status, 200);
  L.ledger.ownerReserve = real;
  assert.deepEqual(rows(L), []);
});

test('RUNWAY_MAX_CREDITS (optional, unset in production) stays a separate hard backstop, checked before anything is recorded', async () => {
  const { env, L } = setup({ RUNWAY_MAX_CREDITS: '100' });
  mockFetch([]);
  const r = await owner(env, 'runway/generate/text_to_video', post(RUNWAY_JOBS[0][1])); // 120 credits, over the server's 100
  assert.deepEqual([r.status, (await body(r)).code], [402, 'runway_cap']);
  assert.deepEqual(rows(L), []);
  assert.equal(upstream.calls.length, 0);
});

// ── recording and settling ──

test('Runway: held at the quote, replaced by Runway’s estimate, settled once to the reported cost — polls, downloads and resumes never double-count', async () => {
  const { env, L } = setup();
  let status = 'RUNNING';
  mockFetch([
    [rw('text_to_video'), () => reply(200, { id: TASK, estimatedCost: { credits: 118 } })],
    [rw(`tasks/${TASK}`), () => reply(200, { id: TASK, status, ...(status === 'SUCCEEDED' ? { cost: { credits: 115 }, output: ['https://dnznrvs05pmza.cloudfront.net/v.mp4'] } : {}), estimatedCost: { credits: 118 } })],
    [/^GET https:\/\/dnznrvs05pmza\.cloudfront\.net\/v\.mp4$/, () => new Response(new Uint8Array(64), { headers: { 'content-type': 'video/mp4' } })],
  ]);
  const r = await owner(env, 'runway/generate/text_to_video', post(RUNWAY_JOBS[0][1]));
  assert.equal(r.status, 200);
  let [row] = rows(L);
  assert.deepEqual([row.provider, row.kind, row.model, row.amount, row.actual, row.job], ['runway', 'video', 'gen4.5', 1_180_000, null, `runway:${TASK}`], 'the estimate replaced the 120-credit quote');
  let s = await month(env);
  assert.deepEqual([s.totalUsd, s.heldUsd, s.jobs], [1.18, 1.18, 1]);
  await owner(env, `runway/task/${TASK}`); // still running: nothing settles
  assert.equal(rows(L)[0].actual, null);
  status = 'SUCCEEDED';
  for (let i = 0; i < 3; i++) await (await owner(env, `runway/task/${TASK}`)).text(); // a resumed poll, another device…
  await (await owner(env, `runway/output/${TASK}`)).arrayBuffer(); // …and the download
  [row] = rows(L);
  assert.equal(row.actual, 1_150_000, 'Runway’s reported cost');
  s = await month(env);
  assert.deepEqual([s.totalUsd, s.settledUsd, s.heldUsd, s.jobs], [1.15, 1.15, 0, 1]);
  assert.deepEqual(s.byProvider, [{ provider: 'runway', kind: 'video', usd: 1.15, heldUsd: 0, jobs: 1 }]);
  // a task Atelier never started (or one started before this) records nothing
  const other = '00000000-0000-4000-8000-000000000000';
  mockFetch([[rw(`tasks/${other}`), () => reply(200, { id: other, status: 'SUCCEEDED', cost: { credits: 999 } })]]);
  await owner(env, `runway/task/${other}`);
  assert.equal(rows(L).length, 1);
});

test('Runway: a refusal settles to $0, no answer at all counts the quote, FAILED settles to $0 unless Runway reports a charge', async () => {
  const { env, L } = setup();
  mockFetch([[rw('text_to_video'), () => reply(400, { error: 'bad prompt' })]]);
  assert.equal((await owner(env, 'runway/generate/text_to_video', post(RUNWAY_JOBS[0][1]))).status, 400);
  assert.deepEqual(rows(L).map((x) => [x.amount, x.actual]), [[1_200_000, 0]]);
  mockFetch([[rw('text_to_video'), () => { throw new TypeError('network down'); }]]);
  assert.equal((await owner(env, 'runway/generate/text_to_video', post(RUNWAY_JOBS[0][1]))).status, 502);
  assert.deepEqual(rows(L).map((x) => x.actual), [0, 1_200_000], 'it may have started: counted at its quote');
  for (const [id, cost, want] of [['11111111-1111-4111-8111-111111111111', undefined, 0], ['22222222-2222-4222-8222-222222222222', 12, 120_000]]) {
    mockFetch([[rw('text_to_video'), () => reply(200, { id })], [rw(`tasks/${id}`), () => reply(200, { id, status: 'FAILED', failureCode: 'SAFETY.INPUT.TEXT', ...(cost ? { cost: { credits: cost } } : {}) })]]);
    await owner(env, 'runway/generate/text_to_video', post(RUNWAY_JOBS[0][1]));
    await owner(env, `runway/task/${id}`);
    assert.equal(rows(L).find((x) => x.job === `runway:${id}`).actual, want);
  }
  // gone at Runway: it can't be read any more, so it settles at its hold
  const gone = '33333333-3333-4333-8333-333333333333';
  mockFetch([[rw('text_to_video'), () => reply(200, { id: gone })], [rw(`tasks/${gone}`), () => reply(404, { error: 'not found' })]]);
  await owner(env, 'runway/generate/text_to_video', post(RUNWAY_JOBS[0][1]));
  assert.equal((await owner(env, `runway/task/${gone}`)).status, 404);
  assert.equal(rows(L).find((x) => x.job === `runway:${gone}`).actual, 1_200_000);
});

test('Runway: its own estimate replaces the quote in the record — a longer Aleph clip than the browser said goes on, never cancelled for its price', async () => {
  const { env, L } = setup();
  legacyLimits(env, 10, 200);
  mockFetch([[rw('video_to_video'), () => reply(200, { id: TASK, estimatedCost: { credits: 1500 } })]]);
  // the browser says 5 s (140 credits); Runway estimates 1,500 ($15)
  const r = await owner(env, 'runway/generate/video_to_video', post({ model: 'aleph2', promptText: 'snow', videoUri: 'runway://upload/abc123def456', seconds: 5 }));
  assert.equal(r.status, 200);
  assert.deepEqual((await body(r)).estimatedCost, { credits: 1500, usd: 15 });
  assert.deepEqual(upstream.calls.map((c) => c.method), ['POST'], 'no DELETE: nothing cancels it');
  assert.deepEqual(rows(L).map((x) => [x.amount, x.actual, x.job]), [[15_000_000, null, `runway:${TASK}`]]);
});

test('Gemini Omni: held at the per-second price, settled from the interaction’s usage once; filtered, failed and cancelled settle to $0', async () => {
  const { env, L } = setup();
  const usage = finished('v1_a').usage;
  let answer = { id: 'v1_a', status: 'in_progress' };
  mockFetch([[OMNI_CREATE, () => reply(200, { id: 'v1_a', status: 'queued' })], [omniGet('v1_a'), () => reply(200, answer)]]);
  assert.equal((await owner(env, 'omni/start', post({ prompt: 'p', seconds: 6, resolution: '1080p' }))).status, 200);
  assert.deepEqual(rows(L).map((x) => [x.provider, x.model, x.amount, x.actual, x.job]), [['omni', OMNI, veoCost({ model: OMNI, seconds: 6, resolution: '1080p', margin: false }), null, 'omni:v1_a']]);
  await owner(env, 'omni/status/v1_a');
  assert.equal(rows(L)[0].actual, null);
  answer = finished('v1_a');
  await owner(env, 'omni/status/v1_a');
  await owner(env, 'omni/status/v1_a'); // resumed: no double count
  assert.equal(rows(L)[0].actual, omniActual({ model: OMNI, usage }));
  for (const [id, done] of [['v1_f', { id: 'v1_f', status: 'completed', steps: [], usage }], ['v1_x', { id: 'v1_x', status: 'failed', error: { message: 'boom' } }], ['v1_c', { id: 'v1_c', status: 'cancelled' }]]) {
    mockFetch([[OMNI_CREATE, () => reply(200, { id, status: 'queued' })], [omniGet(id), () => reply(200, done)]]);
    await owner(env, 'omni/start', post({ prompt: 'p' }));
    await owner(env, `omni/status/${id}`);
    assert.equal(rows(L).find((x) => x.job === `omni:${id}`).actual, 0, id);
  }
  // Google refuses the start: $0; Google no longer has a running one: its quote
  mockFetch([[OMNI_CREATE, () => reply(400, { error: { message: 'bad' } })]]);
  assert.equal((await owner(env, 'omni/start', post({ prompt: 'p' }))).status, 400);
  assert.equal(rows(L).at(-1).actual, 0);
  mockFetch([[OMNI_CREATE, () => reply(200, { id: 'v1_g', status: 'queued' })], [omniGet('v1_g'), () => reply(404, { error: { message: 'gone' } })]]);
  await owner(env, 'omni/start', post({ prompt: 'p' }));
  await owner(env, 'omni/status/v1_g');
  const g = rows(L).find((x) => x.job === 'omni:v1_g');
  assert.equal(g.actual, g.amount);
});

test('Gemini Omni: when Google refuses the duration, the retry is recorded at the longest clip and always sent', async () => {
  const { env, L } = setup();
  legacyLimits(env, 0.5, 200); // v84's $0.50 a video would have refused the 10 s retry
  let n = 0;
  mockFetch([[OMNI_CREATE, (c) => (++n % 2 === 1 ? reply(400, { error: { message: 'Invalid duration value' } }) : reply(200, { id: `v1_r${n}`, status: 'queued' }))]]);
  for (let i = 0; i < 2; i++) {
    const r = await owner(env, 'omni/start', post({ prompt: 'p', seconds: 4 }));
    assert.equal(r.status, 200);
    assert.equal((await body(r)).durationIgnored, true);
  }
  assert.equal(n, 4, 'each first try and its retry went to Google');
  assert.deepEqual(rows(L).map((x) => [x.amount, x.actual]), [1, 2].map(() => [veoCost({ model: OMNI, seconds: 10, resolution: '720p', margin: false }), null]));
});

test('Grok: an image settles to xAI’s cost (filtered or refused → $0); a video settles once when its poll or download sees it done', async () => {
  const { env, L } = setup();
  mockFetch([[/images\/generations$/, () => reply(200, { data: [{ b64_json: 'QUJD' }], usage: { cost_in_usd_ticks: 350_000_000 } })]]);
  assert.equal((await owner(env, 'xai/image', post({ model: 'grok-imagine-image-2.0', prompt: 'x' }))).status, 200);
  mockFetch([[/images\/generations$/, () => reply(200, { data: [] })]]);
  assert.equal((await owner(env, 'xai/image', post({ model: 'grok-imagine-image-2.0', prompt: 'x' }))).status, 400);
  mockFetch([[/images\/generations$/, () => reply(429, { error: 'Too many requests' })]]);
  assert.equal((await owner(env, 'xai/image', post({ model: 'grok-imagine-image-2.0', prompt: 'x' }))).status, 429);
  assert.deepEqual(rows(L).map((x) => [x.kind, x.amount, x.actual]), [['image', 40_000, 35_000], ['image', 40_000, 0], ['image', 40_000, 0]]);
  const LINK = 'https://vidgen.x.ai/v.mp4';
  let poll = { status: 'pending' };
  mockFetch([[/videos\/generations$/, () => reply(200, { request_id: 'vid1' })], [/videos\/vid1$/, () => reply(200, poll)], [/^GET https:\/\/vidgen\.x\.ai\/v\.mp4$/, () => new Response(new Uint8Array(8), { headers: { 'content-type': 'video/mp4' } })]]);
  await owner(env, 'xai/video/start', post({ model: 'grok-imagine-video-1.5', prompt: 'waves', seconds: 8 }));
  assert.deepEqual(rows(L).at(-1).amount, 640_000);
  await owner(env, 'xai/video/status/vid1');
  assert.equal(rows(L).at(-1).actual, null);
  poll = { status: 'done', video: { url: LINK, duration: 8, respect_moderation: true }, usage: { cost_in_usd_ticks: 6_000_000_000 } };
  await owner(env, 'xai/video/status/vid1');
  await (await owner(env, 'xai/video/file/vid1')).arrayBuffer();
  assert.equal(rows(L).at(-1).actual, 600_000);
  // moderation held it back: $0
  mockFetch([[/videos\/generations$/, () => reply(200, { request_id: 'vid2' })], [/videos\/vid2$/, () => reply(200, { status: 'done', video: { url: LINK, respect_moderation: false } })]]);
  await owner(env, 'xai/video/start', post({ model: 'grok-imagine-video-1.5-lite', prompt: 'x', seconds: 4 }));
  await owner(env, 'xai/video/status/vid2');
  assert.equal(rows(L).at(-1).actual, 0);
});

test('image passthrough: priced from prices.js, forwarded byte for byte, settled from the answer’s usage; a refusal settles to $0', async () => {
  const { env, L } = setup();
  const gen = { model: 'gpt-image-2.5-flare', prompt: 'a lighthouse', n: 2, quality: 'high', size: '1536x1024', output_format: 'jpeg' };
  const usage = { input_tokens: 5, input_tokens_details: { text_tokens: 5 }, output_tokens: 2_744 };
  mockFetch([[/openai\.com\/v1\/images\/generations$/, () => reply(200, { data: [{ b64_json: 'QUJD' }, { b64_json: 'REVG' }], usage })]]);
  let r = await owner(env, 'x/openai/images/generations', post(gen));
  assert.equal(r.status, 200);
  assert.equal((await body(r)).data.length, 2);
  assert.deepEqual(JSON.parse(upstream.calls.at(-1).body), gen, 'the owner’s body goes as it was sent');
  let row = rows(L).at(-1);
  assert.equal(row.amount, imageCost({ model: 'openai:gpt-image-2.5-flare', n: 2, size: '1536x1024', quality: 'high', promptTokens: 4, margin: false }));
  assert.equal(row.actual, imageActual({ model: 'openai:gpt-image-2.5-flare', usage }));
  // an edit at size auto is priced as GPT Image's largest output plus the photo
  mockFetch([[/images\/edits$/, () => reply(200, { data: [{ b64_json: 'QUJD' }] })]]);
  await owner(env, 'x/openai/images/edits', post({ model: 'gpt-image-2.5-sunburst', prompt: 'x', n: 1, quality: 'high', images: [{ image_url: PNG }] }));
  row = rows(L).at(-1);
  assert.ok(row.amount > imageCost({ model: 'openai:gpt-image-2.5-sunburst', size: '1792x1008', quality: 'high', promptTokens: 1, inputImages: 1, margin: false }), 'auto ≥ any listed size');
  assert.equal(row.actual, row.amount, 'no usage reported: the quote');
  // Gemini: usageMetadata; Meta: $0.01 an image made
  const meta = { promptTokenCount: 12, candidatesTokenCount: 1_680, candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 1_680 }], thoughtsTokenCount: 300, totalTokenCount: 1_992 };
  mockFetch([[/generateContent$/, () => reply(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'QUJD' } }] } }], usageMetadata: meta })]]);
  await owner(env, 'x/gemini/v1beta/models/gemini-nano-banana-2.1:generateContent', post({ contents: [{ parts: [{ text: 'x' }] }], generationConfig: { responseModalities: ['IMAGE'], imageConfig: { imageSize: '2K', aspectRatio: '1:1' } } }));
  assert.equal(rows(L).at(-1).actual, imageActual({ model: 'gemini:gemini-nano-banana-2.1', usage: meta }));
  mockFetch([[/meta\.ai\/v1\/images\/generations$/, () => reply(200, { data: [{ b64_json: 'QUJD' }] })]]);
  await owner(env, 'x/meta/images/generations', post({ model: 'muse-image-1.0', prompt: 'x', n: 1 }));
  assert.equal(rows(L).at(-1).actual, 10_000);
  mockFetch([[/openai\.com\/v1\/images\/generations$/, () => reply(400, { error: { message: 'Your request was rejected by the safety system' } })]]);
  r = await owner(env, 'x/openai/images/generations', post(gen));
  assert.equal(r.status, 400);
  assert.equal(rows(L).at(-1).actual, 0);
  // the breakdown groups by provider and kind
  const s = await month(env);
  assert.deepEqual(s.byProvider.map((x) => `${x.provider}/${x.kind}/${x.jobs}`).sort(), ['gemini/image/1', 'meta/image/1', 'openai/image/3']);
});

test('month rollover: a job started on Oct 31 (UTC) counts in October even when it settles in November; November starts at $0', async () => {
  const { env, L } = setup();
  L.ledger.clock = () => Date.UTC(2026, 9, 31, 23, 59, 59, 999);
  mockFetch([[/videos\/generations$/, () => reply(200, { request_id: 'late' })], [/videos\/late$/, () => reply(200, { status: 'done', video: { url: 'https://vidgen.x.ai/v.mp4', duration: 15 }, usage: { cost_in_usd_ticks: 12_000_000_000 } })]]);
  await owner(env, 'xai/video/start', post({ model: 'grok-imagine-video-1.5', prompt: 'x', seconds: 15 }));
  L.ledger.clock = () => Date.UTC(2026, 10, 1, 0, 0, 0, 1);
  await owner(env, 'xai/video/status/late');
  const oct = await month(env, '2026-10'), nov = await month(env, '2026-11');
  assert.deepEqual([oct.totalUsd, oct.jobs, oct.resetsAt], [1.2, 1, '2026-11-01T00:00:00.000Z']);
  assert.deepEqual([nov.totalUsd, nov.jobs], [0, 0]);
  assert.equal((await owner(env, 'owner/spend?month=2026-13')).status, 400, 'a bad month is refused');
});

// ── the Ledger's owner_spend rows ──

test('Ledger: a row at the quote, never refused; settle happens once, by row id or provider id; resize follows a new quote', () => {
  const { ledger } = makeLedger();
  const a = ledger.ownerReserve({ provider: 'runway', kind: 'video', model: 'gen4.5', amount: 150_000_000 });
  assert.deepEqual([a.ok, a.spent], [true, 150_000_000]);
  const b = ledger.ownerReserve({ provider: 'omni', kind: 'video', amount: 900_000_000, monthly: 1 }); // an older Worker's monthly: ignored
  assert.deepEqual([b.ok, b.spent], [true, 1_050_000_000], 'nothing caps the month');
  assert.equal(ledger.ownerReserve({ provider: 'xai', kind: 'image', amount: 0 }).ok, true, 'a free job too');
  // settle: by provider id after attach; a second settle (a resumed poll) changes nothing
  assert.equal(ledger.ownerAttach(a.id, 'runway:task-1'), true);
  assert.equal(ledger.ownerAttach(b.id, 'runway:task-1'), false, 'one row per provider job');
  assert.equal(ledger.ownerAttach(b.id, 'bad id with spaces'), false);
  assert.deepEqual(ledger.ownerSettle('runway:task-1', 100_000_000), { ok: true, charged: 100_000_000, amount: 150_000_000, month: a.month });
  assert.deepEqual(ledger.ownerSettle('runway:task-1', 1), { ok: false });
  assert.deepEqual(ledger.ownerSettle(a.id, 1), { ok: false });
  // resize: any new quote while it runs, growing or shrinking; a settled row keeps its cost
  assert.deepEqual(ledger.ownerResize(b.id, 2_000_000_000), { ok: true });
  assert.deepEqual(ledger.ownerResize(b.id, 100_000_000), { ok: true });
  assert.deepEqual(ledger.ownerResize(a.id, 1), { ok: false, gone: true });
  assert.throws(() => ledger.ownerResize(b.id, 1.5));
  // settle(null) = its quote; garbage = its quote; negative = $0; a sane ceiling
  assert.equal(ledger.ownerSettle(b.id, null).charged, 100_000_000);
  const c = ledger.ownerReserve({ provider: 'xai', kind: 'image', amount: 40_000 });
  assert.equal(ledger.ownerSettle(c.id, 'x').charged, 40_000);
  const d = ledger.ownerReserve({ provider: 'xai', kind: 'image', amount: 40_000 });
  assert.equal(ledger.ownerSettle(d.id, -5).charged, 0);
  const e = ledger.ownerReserve({ provider: 'xai', kind: 'image', amount: 40_000 });
  assert.equal(ledger.ownerSettle(e.id, 1e20).charged, 10_000_000_000);
  // inputs the Worker never sends are refused outright
  assert.throws(() => ledger.ownerReserve({ provider: 'runway', kind: 'video', amount: 1.5 }));
  assert.throws(() => ledger.ownerReserve({ provider: 'Runway!', kind: 'video', amount: 1 }));
  // the breakdown: biggest first (ties by name); a still-running $0 row counts as $0
  const s = ledger.ownerSpend(a.month);
  assert.deepEqual(s.byProvider.map((x) => [x.provider, x.kind, x.jobs, x.total, x.held]),
    [['xai', 'image', 4, 10_000_040_000, 0], ['omni', 'video', 1, 100_000_000, 0], ['runway', 'video', 1, 100_000_000, 0]]);
  assert.deepEqual([s.jobs, s.total, s.held], [6, 10_200_040_000, 0]);
  assert.equal(ledger.ownerSpend('not a month').month, a.month, 'a bad month reads this one');
  // the limits are gone from the Ledger: no methods, and the Testers panel's config route can't write one either
  assert.equal(typeof ledger.ownerLimits, 'undefined');
  assert.equal(typeof ledger.ownerSetLimits, 'undefined');
  assert.equal(ledger.setConfig({ owner_limits: '{}' }).ok, false);
});

test('Ledger: concurrent starts through the RPC stub are all recorded', async () => {
  const L = makeLedger();
  const results = await Promise.all(Array.from({ length: 30 }, () => L.stub.ownerReserve({ provider: 'runway', kind: 'video', amount: 10_000_000, monthly: 200_000_000 })));
  assert.equal(results.filter((r) => r.ok).length, 30);
  assert.equal(L.ledger.ownerSpend(results[0].month).total, 300_000_000);
});

test('Ledger alarm: owner spend rows are kept 13 months', async () => {
  const L = makeLedger();
  L.ledger.clock = () => Date.UTC(2025, 8, 15);
  L.ledger.ownerReserve({ provider: 'runway', kind: 'video', amount: 1 });
  L.ledger.clock = () => Date.UTC(2025, 9, 15);
  L.ledger.ownerReserve({ provider: 'runway', kind: 'video', amount: 1 });
  L.ledger.clock = () => Date.UTC(2026, 9, 20);
  await L.ledger.alarm();
  assert.deepEqual(rows(L).map((x) => x.month), ['2025-10']);
});

// ── review fixes (v83), still true ──

test('Gemini Omni: a status Atelier doesn’t know (missing, uppercase, requires_action, new) never settles the hold; the real finish does', async () => {
  const { env, L } = setup();
  const usage = finished('v1_u').usage;
  let answer = { id: 'v1_u', status: 'queued' };
  mockFetch([[OMNI_CREATE, () => reply(200, { id: 'v1_u', status: 'queued' })], [omniGet('v1_u'), () => reply(200, answer)]]);
  assert.equal((await owner(env, 'omni/start', post({ prompt: 'p', seconds: 6, resolution: '720p' }))).status, 200);
  for (const status of [undefined, 'IN_PROGRESS', 'requires_action', 'running']) {
    answer = { id: 'v1_u', ...(status ? { status } : {}) };
    assert.equal((await owner(env, 'omni/status/v1_u')).status, 200);
    assert.equal(rows(L)[0].actual, null, String(status));
  }
  answer = finished('v1_u');
  await owner(env, 'omni/status/v1_u');
  assert.equal(rows(L)[0].actual, omniActual({ model: OMNI, usage }));
  // 'incomplete' is a known end: $0 without a video
  mockFetch([[OMNI_CREATE, () => reply(200, { id: 'v1_i', status: 'queued' })], [omniGet('v1_i'), () => reply(200, { id: 'v1_i', status: 'incomplete' })]]);
  await owner(env, 'omni/start', post({ prompt: 'p' }));
  await owner(env, 'omni/status/v1_i');
  assert.equal(rows(L).find((x) => x.job === 'omni:v1_i').actual, 0);
});

test('a gateway’s 502, 504 or 52x answer to a create counts at the quote (the job may have started); the provider’s own 500/503 is $0', async () => {
  const { env, L } = setup();
  const page = (s) => () => reply(s, '<html><body>Bad gateway</body></html>', { 'content-type': 'text/html' });
  const IMG = { model: 'gpt-image-2.5-flare', prompt: 'x', n: 1, quality: 'high', size: '1024x1024' };
  const creates = (answer) => [
    ['runway', () => mockFetch([[rw('text_to_video'), answer]]), () => owner(env, 'runway/generate/text_to_video', post(RUNWAY_JOBS[0][1]))],
    ['omni', () => mockFetch([[OMNI_CREATE, answer]]), () => owner(env, 'omni/start', post({ prompt: 'p' }))],
    ['xai video', () => mockFetch([[/videos\/generations$/, answer]]), () => owner(env, 'xai/video/start', post({ model: 'grok-imagine-video-1.5', prompt: 'x', seconds: 8 }))],
    ['xai image', () => mockFetch([[/x\.ai\/v1\/images\/generations$/, answer]]), () => owner(env, 'xai/image', post({ model: 'grok-imagine-image-2.0', prompt: 'x' }))],
    ['passthrough', () => mockFetch([[/openai\.com\/v1\/images\/generations$/, answer]]), () => owner(env, 'x/openai/images/generations', post(IMG))],
  ];
  for (const s of [502, 504, 520, 524, 530]) {
    for (const [name, mock, go] of creates(page(s))) {
      mock();
      const r = await go();
      assert.ok(r.status >= 500, `${name} ${s}: ${r.status}`);
      const row = rows(L).at(-1);
      assert.deepEqual([row.actual, row.job], [row.amount, null], `${name} ${s}: held at its quote`);
    }
  }
  for (const [s, answer] of [[500, () => reply(500, { error: { message: 'internal' } })], [503, () => reply(503, { error: 'overloaded' })]]) {
    for (const [name, mock, go] of creates(answer)) {
      mock();
      await go();
      assert.equal(rows(L).at(-1).actual, 0, `${name} ${s}: a refusal, nothing billed`);
    }
  }
});

test('Runway Stop settles the hold: cancelled → $0 (or what Runway still charges), finished → its cost; a failed cancel keeps it', async () => {
  const { env, L } = setup();
  const start = async (id) => { mockFetch([[rw('text_to_video'), () => reply(200, { id })]]); assert.equal((await owner(env, 'runway/generate/text_to_video', post(RUNWAY_JOBS[0][1]))).status, 200); };
  const row = (id) => rows(L).find((x) => x.job === `runway:${id}`);
  const stop = (id) => owner(env, `runway/task/${id}`, { method: 'DELETE' });
  // running: the DELETE cancels it, the re-read says CANCELLED
  const cases = [
    ['44444444-4444-4444-8444-444444444441', 'RUNNING', { status: 'CANCELLED' }, 200, 0],
    ['44444444-4444-4444-8444-444444444442', 'PENDING', { status: 'CANCELLED', cost: { credits: 30 } }, 200, 300_000], // Runway reports a charge
    ['44444444-4444-4444-8444-444444444443', 'RUNNING', null, 200, 0], // gone after the cancel (404)
    ['44444444-4444-4444-8444-444444444444', 'THROTTLED', { status: 'RUNNING' }, 200, 0], // the cancel hasn't shown yet
  ];
  for (const [id, before, after, del, want] of cases) {
    await start(id);
    let cancelled = false;
    mockFetch([[rw(`tasks/${id}`), (c) => {
      if (c.method === 'DELETE') { cancelled = true; return reply(del, {}); }
      if (!cancelled) return reply(200, { id, status: before });
      return after ? reply(200, { id, ...after }) : reply(404, { error: 'not found' });
    }]]);
    assert.equal((await stop(id)).status, 200, id);
    assert.equal(row(id).actual, want, id);
  }
  // finished before the Stop: left alone (no DELETE, which would delete its output), settled to its cost
  const done = '55555555-5555-4555-8555-555555555551';
  await start(done);
  mockFetch([[rw(`tasks/${done}`), (c) => { assert.equal(c.method, 'GET'); return reply(200, { id: done, status: 'SUCCEEDED', cost: { credits: 110 } }); }]]);
  assert.deepEqual(await body(await stop(done)), { ok: true, gone: false, kept: true, status: 'SUCCEEDED' });
  assert.equal(row(done).actual, 1_100_000);
  // the cancel fails: the video may still run and bill, so the hold stays at its quote
  const stuck = '55555555-5555-4555-8555-555555555552';
  await start(stuck);
  mockFetch([[rw(`tasks/${stuck}`), (c) => (c.method === 'DELETE' ? reply(500, {}) : reply(200, { id: stuck, status: 'RUNNING' }))]]);
  assert.equal((await stop(stuck)).status, 503);
  assert.equal(row(stuck).actual, null);
  // gone before the Stop: at its quote, as a poll that finds it gone settles it
  const lost = '55555555-5555-4555-8555-555555555553';
  await start(lost);
  mockFetch([[rw(`tasks/${lost}`), () => reply(404, { error: 'not found' })]]);
  assert.deepEqual(await body(await stop(lost)), { ok: true, gone: true });
  assert.equal(row(lost).actual, 1_200_000);
  assert.equal((await month(env)).heldUsd, 1.2, 'only the one whose cancel failed is still held');
});

test('Gemini Omni Stop settles the hold: $0 once Google has the cancel; a clip it had already finished at its usage; a failed cancel keeps it', async () => {
  const { env, L } = setup();
  const usage = finished('v1_t').usage;
  const job = (id) => rows(L).find((x) => x.job === `omni:${id}`);
  const cancelUrl = (id) => new RegExp(`^POST ${GEMINI_BASE.replace(/[.]/g, '\\.')}/v1beta/interactions/${id}/cancel$`);
  mockFetch([[OMNI_CREATE, () => reply(200, { id: 'v1_s', status: 'queued' })], [cancelUrl('v1_s'), () => reply(200, {})], [omniGet('v1_s'), () => reply(200, { id: 'v1_s', status: 'cancelled' })]]);
  await owner(env, 'omni/start', post({ prompt: 'p', seconds: 10, resolution: '1080p' }));
  assert.ok(job('v1_s').amount > 0);
  assert.equal((await owner(env, 'omni/cancel/v1_s', post({}))).status, 200);
  assert.equal(job('v1_s').actual, 0);
  // the cancel landed after Google finished the clip (409): it was made, and billed
  mockFetch([[OMNI_CREATE, () => reply(200, { id: 'v1_t', status: 'queued' })], [cancelUrl('v1_t'), () => reply(409, {})], [omniGet('v1_t'), () => reply(200, finished('v1_t'))]]);
  await owner(env, 'omni/start', post({ prompt: 'p' }));
  assert.equal((await owner(env, 'omni/cancel/v1_t', post({}))).status, 200);
  assert.equal(job('v1_t').actual, omniActual({ model: OMNI, usage }));
  // Google still shows it running (the cancel takes a moment), or can't be read: $0, nothing else will poll it
  mockFetch([[OMNI_CREATE, () => reply(200, { id: 'v1_r', status: 'queued' })], [cancelUrl('v1_r'), () => reply(200, {})], [omniGet('v1_r'), () => reply(500, {})]]);
  await owner(env, 'omni/start', post({ prompt: 'p' }));
  await owner(env, 'omni/cancel/v1_r', post({}));
  assert.equal(job('v1_r').actual, 0);
  // the cancel itself fails: the clip may still be made, so the hold stays
  mockFetch([[OMNI_CREATE, () => reply(200, { id: 'v1_v', status: 'queued' })], [cancelUrl('v1_v'), () => reply(500, {})]]);
  await owner(env, 'omni/start', post({ prompt: 'p' }));
  assert.equal((await owner(env, 'omni/cancel/v1_v', post({}))).status, 503);
  assert.equal(job('v1_v').actual, null);
});
