import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, makeLedger, mockFetch, restoreFetch, upstream, reply, api, signIn, PROFILE, resetTesterCaches } from './tester-env.mjs';

// The owner's spending limits (src/spend.js; Settings → Spending): $25 a video and $200 a month for video and images by
// default, checked in the Worker before any paid owner job reaches a provider, recorded in the Ledger (owner_spend) and
// settled to what the provider reports. No provider is ever called for real: every upstream request goes to a fetch
// mock, and an unmatched one fails (and is counted in upstream.calls, so "nothing was sent" is checked exactly).
const SP = await import('../src/spend.js');
const { TESTER_ROUTES, matchTesterRoute } = await import('../src/tester/router.js');
const { omniActual, veoCost, imageCost, imageActual } = await import('../src/tester/prices.js');
const { RUNWAY_BASE } = await import('../src/runway.js');
const { GEMINI_BASE } = await import('../src/gemini.js');

beforeEach(() => resetTesterCaches());
afterEach(() => restoreFetch());

const RUNWAY_KEY = `key_${'ab12'.repeat(32)}`;
const TASK = '4a7b0c1d-2e3f-4a5b-8c6d-7e8f9a0b1c2d';
const PNG = `data:image/png;base64,${'iVBORw0KGgo'.padEnd(64, 'A')}`;
const OMNI = 'gemini:gemini-omni-1.1-flash';
// The limits live in the Ledger (config 'owner_limits'); setLimits writes them straight in, as PUT /api/owner/limits would.
const ledgers = new WeakMap();
const setup = (extra = {}) => { const made = makeEnv({ RUNWAYML_API_SECRET: RUNWAY_KEY, ...extra }); ledgers.set(made.env, made.L); return made; };
const owner = (env, path, init = {}) => api(env, path, init, { pass: 'pw', origin: null });
const post = (body) => ({ method: 'POST', body, headers: { 'content-type': 'application/json' } });
const put = (body) => ({ method: 'PUT', body, headers: { 'content-type': 'application/json' } });
const setLimits = (env, perVideoUsd, monthlyMediaUsd) => ledgers.get(env).ledger.ownerSetLimits({ perVideoUsd, monthlyMediaUsd, updatedAt: 1 });
const body = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const month = (env, m) => owner(env, `owner/spend${m ? `?month=${m}` : ''}`).then(body);
const rows = (L) => L.shim.db.prepare('SELECT * FROM owner_spend ORDER BY rowid').all().map((r) => ({ ...r }));
const rw = (path) => new RegExp(`^(GET|POST|DELETE) ${RUNWAY_BASE.replace(/[.]/g, '\\.')}/${path}$`);
const OMNI_CREATE = /^POST https:\/\/generativelanguage\.googleapis\.com\/v1beta\/interactions$/;
const omniGet = (id) => new RegExp(`^GET ${GEMINI_BASE.replace(/[.]/g, '\\.')}/v1beta/interactions/${id}$`);
const finished = (id, extra = {}) => ({ id, status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'video', mime_type: 'video/mp4', data: 'AAAA' }] }],
  usage: { total_input_tokens: 900, total_output_tokens: 23_500, output_tokens_by_modality: [{ modality: 'video', tokens: 23_168 }] }, ...extra });

// ── the decision: price → limit, at the boundaries ──

test('decide: equal to a limit is allowed, one micro-dollar over is not; images only count toward the month', () => {
  const limits = { perVideoUsd: 25, monthlyMediaUsd: 200 };
  assert.deepEqual(SP.decide({ amount: 25_000_000, kind: 'video', limits }), { ok: true });
  assert.deepEqual(SP.decide({ amount: 25_000_001, kind: 'video', limits }), { ok: false, limit: 'video' });
  assert.deepEqual(SP.decide({ amount: 10_000_000, kind: 'video', limits, spent: 190_000_000 }), { ok: true }, 'exactly reaches $200');
  assert.deepEqual(SP.decide({ amount: 10_000_001, kind: 'video', limits, spent: 190_000_000 }), { ok: false, limit: 'month' });
  assert.deepEqual(SP.decide({ amount: 30_000_000, kind: 'image', limits }), { ok: true }, 'the per-video limit is for videos');
  assert.deepEqual(SP.decide({ amount: 1, kind: 'image', limits, spent: 200_000_000 }), { ok: false, limit: 'month' });
  // the per-video limit is checked first: a $30 video in a full month names the per-video limit
  assert.deepEqual(SP.decide({ amount: 30_000_000, kind: 'video', limits, spent: 200_000_000 }), { ok: false, limit: 'video' });
  // 0 turns paid video (or all paid media) off; a free job still fits
  assert.equal(SP.decide({ amount: 1, kind: 'video', limits: { perVideoUsd: 0, monthlyMediaUsd: 200 } }).ok, false);
  assert.equal(SP.decide({ amount: 0, kind: 'video', limits: { perVideoUsd: 0, monthlyMediaUsd: 0 } }).ok, true);
  // a job that can't be priced is never let through
  for (const amount of [NaN, -1, 1.5, Infinity, '5']) assert.equal(SP.decide({ amount, kind: 'image', limits }).ok, false, String(amount));
});

test('months are UTC: resetsAt is 00:00 UTC on the 1st, December rolls into January', () => {
  assert.equal(SP.monthOf(Date.UTC(2026, 9, 31, 23, 59, 59, 999)), '2026-10');
  assert.equal(SP.monthOf(Date.UTC(2026, 10, 1)), '2026-11');
  assert.equal(SP.resetsAt('2026-10'), '2026-11-01T00:00:00.000Z');
  assert.equal(SP.resetsAt('2026-12'), '2027-01-01T00:00:00.000Z');
  assert.equal(SP.toUsd(52_685), 0.0527);
  assert.equal(SP.toMicros(0.07), 70_000);
});

// ── limits: storage, validation, auth ──

test('limits: cleanLimits rejects negatives, NaN, Infinity, text, absurd amounts and unknown fields; keeps cents; clamps per-video to the month', () => {
  const cur = { perVideoUsd: 25, monthlyMediaUsd: 200 };
  for (const [input, re] of [
    [{ perVideoUsd: -1 }, /can’t be negative/], [{ monthlyMediaUsd: NaN }, /dollar amount/], [{ monthlyMediaUsd: Infinity }, /dollar amount/],
    [{ perVideoUsd: '25' }, /dollar amount/], [{ perVideoUsd: null }, /dollar amount/], [{ monthlyMediaUsd: 1e9 }, /at most \$5,000/], [{ perVideoUsd: 501 }, /at most \$500/],
    [{ budget: 5 }, /Unknown setting/], [{}, /Send perVideoUsd/], [null, /JSON object/], [[25, 200], /JSON object/],
  ]) {
    const r = SP.cleanLimits(input, cur);
    assert.equal(r.ok, false, JSON.stringify(input));
    assert.match(r.error, re, JSON.stringify(input));
  }
  assert.deepEqual(SP.cleanLimits({ perVideoUsd: 12.345 }, cur), { ok: true, limits: { perVideoUsd: 12.35, monthlyMediaUsd: 200 }, clamped: false }, 'merged, to the cent');
  assert.deepEqual(SP.cleanLimits({ perVideoUsd: 0, monthlyMediaUsd: 0 }, cur), { ok: true, limits: { perVideoUsd: 0, monthlyMediaUsd: 0 }, clamped: false });
  assert.deepEqual(SP.cleanLimits({ perVideoUsd: 50, monthlyMediaUsd: 30 }, cur), { ok: true, limits: { perVideoUsd: 30, monthlyMediaUsd: 30 }, clamped: true });
  assert.deepEqual(SP.cleanLimits({ monthlyMediaUsd: 10 }, cur), { ok: true, limits: { perVideoUsd: 10, monthlyMediaUsd: 10 }, clamped: true });
  // whatever KV holds is made usable (garbage → the defaults)
  assert.deepEqual(SP.normalizeLimits(null), { perVideoUsd: 25, monthlyMediaUsd: 200, updatedAt: null });
  assert.deepEqual(SP.normalizeLimits({ perVideoUsd: -3, monthlyMediaUsd: 'x' }), { perVideoUsd: 25, monthlyMediaUsd: 200, updatedAt: null });
  assert.deepEqual(SP.normalizeLimits({ perVideoUsd: 40, monthlyMediaUsd: 30, updatedAt: 5 }), { perVideoUsd: 30, monthlyMediaUsd: 30, updatedAt: 5 });
});

test('GET/PUT /api/owner/limits: $25 / $200 until set, saved in the Ledger for every device, bad input refused with nothing written', async () => {
  const { env, L } = setup();
  let j = await body(await owner(env, 'owner/limits'));
  assert.deepEqual([j.perVideoUsd, j.monthlyMediaUsd, j.updatedAt], [25, 200, null]);
  assert.deepEqual(j.defaults, { perVideoUsd: 25, monthlyMediaUsd: 200 });
  assert.deepEqual(j.bounds, { perVideoUsd: [0, 500], monthlyMediaUsd: [0, 5000] });
  let r = await owner(env, 'owner/limits', put({ perVideoUsd: 10, monthlyMediaUsd: 150.5 }));
  j = await body(r);
  assert.equal(r.status, 200);
  assert.deepEqual([j.ok, j.perVideoUsd, j.monthlyMediaUsd], [true, 10, 150.5]);
  assert.ok(Number.isSafeInteger(j.updatedAt));
  assert.deepEqual(L.ledger.ownerLimits(), { perVideoUsd: 10, monthlyMediaUsd: 150.5, updatedAt: j.updatedAt });
  assert.equal(env.ATELIER_KV.m.size, 0, 'nothing in KV: a KV write can take a minute to reach other locations');
  assert.equal((await body(await owner(env, 'owner/limits'))).monthlyMediaUsd, 150.5);
  // refused: nothing written
  const saved = JSON.stringify(L.ledger.ownerLimits());
  for (const b of [{ perVideoUsd: -5 }, { monthlyMediaUsd: 'NaN' }, { monthlyMediaUsd: 99_999_999 }, { perVideoUsd: 5, extra: 1 }, 'not json', '[]', JSON.stringify({ perVideoUsd: 'x'.repeat(5000) })]) {
    r = await owner(env, 'owner/limits', put(b));
    assert.equal(r.status, typeof b === 'string' && b.length > 4096 ? 413 : 400, JSON.stringify(b).slice(0, 60));
    assert.equal((await body(r)).code, 'owner_limits_input');
  }
  assert.equal(JSON.stringify(L.ledger.ownerLimits()), saved);
  // a per-video limit above the month is clamped to it, and says so
  j = await body(await owner(env, 'owner/limits', put({ perVideoUsd: 80, monthlyMediaUsd: 60 })));
  assert.deepEqual([j.perVideoUsd, j.monthlyMediaUsd, j.clamped], [60, 60, true]);
  // only GET and PUT
  r = await owner(env, 'owner/limits', { method: 'DELETE' });
  assert.equal(r.status, 405);
  assert.equal((await owner(env, 'owner/spend', post({}))).status, 405);
  assert.equal((await owner(env, 'owner/probe')).status, 404);
});

test('owner routes: the passcode only — none and a wrong one get 401; a tester gets 403 owner_only before the KV or the Ledger is touched', async () => {
  const { env, L } = setup();
  for (const [path, init] of [['owner/limits', {}], ['owner/limits', put({ perVideoUsd: 1 })], ['owner/spend', {}]]) {
    assert.equal((await api(env, path, init)).status, 401, `${path}: no passcode`);
    assert.equal((await api(env, path, init, { pass: 'nope' })).status, 401, `${path}: wrong passcode`);
  }
  const t = await signIn(L, PROFILE());
  L.calls.length = 0;
  for (const method of ['GET', 'PUT', 'POST', 'DELETE', 'PATCH']) {
    for (const path of ['owner/limits', 'owner/spend', 'owner/spend/x', 'owner/']) {
      const r = await api(env, path, { method, ...(method === 'GET' ? {} : { body: JSON.stringify({ perVideoUsd: 500, monthlyMediaUsd: 5000 }) }) }, { cookie: t.token });
      assert.deepEqual([r.status, (await body(r)).code], [403, 'owner_only'], `${method} ${path}`);
      assert.equal(matchTesterRoute(method, path), null);
    }
  }
  assert.ok(L.calls.every((m) => m === 'session'), `${L.calls}`);
  assert.equal(L.ledger.ownerLimits(), null, 'a tester never writes the owner’s limits');
  // the tester table stays deny-by-default: no owner route was added to it
  assert.ok(TESTER_ROUTES.every((r) => !String(r.sample ?? r.match).startsWith('owner')));
});

// ── every paid route refuses an over-limit job before any upstream fetch ──

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

test('Runway, every model: over the per-video limit → 402 owner_cap_video, nothing sent to Runway, nothing recorded', async () => {
  const { env, L } = setup();
  setLimits(env, 0.4, 200);
  mockFetch([]);
  for (const [kind, b, usd] of RUNWAY_JOBS) {
    const r = await owner(env, `runway/generate/${kind}`, post(b));
    const j = await body(r);
    assert.deepEqual([r.status, j.code, j.limit], [402, 'owner_cap_video', 'video'], b.model);
    assert.equal(j.costUsd, usd, b.model);
    assert.equal(j.perVideoUsd, 0.4);
    assert.match(j.error, /over your \$0\.40 limit per video\. Nothing was sent to Runway\. Change it in Settings → Spending\./);
    assert.ok(!/credit|billing|quota/i.test(j.error), 'never worded like a provider out of credit');
  }
  assert.equal(upstream.calls.length, 0);
  assert.deepEqual(rows(L), []);
});

test('Runway: over the monthly limit → 402 owner_cap_month with what was used and when it resets; Seedance at $20.40 fits the $25 default', async () => {
  const { env, L } = setup();
  setLimits(env, 25, 1);
  L.ledger.ownerReserve({ provider: 'omni', kind: 'video', amount: 900_000, monthly: 1e12 }); // $0.90 already this month
  mockFetch([]);
  const r = await owner(env, 'runway/generate/image_to_video', post(RUNWAY_JOBS[1][1]));
  const j = await body(r);
  assert.deepEqual([r.status, j.code, j.limit, j.costUsd, j.spentUsd, j.leftUsd, j.monthlyMediaUsd], [402, 'owner_cap_month', 'month', 0.5, 0.9, 0.1, 1]);
  assert.equal(j.resetsAt, SP.resetsAt(SP.monthOf()));
  assert.match(j.error, /would bring this month’s video and image spending to \$1\.40, over your \$1\.00 monthly limit \(\$0\.90 used, resets \w{3} 1\)\. Nothing was sent to Runway\./);
  assert.equal(upstream.calls.length, 0);
  assert.equal(rows(L).length, 1);
  // the default limits: the dearest Runway video Atelier sends ($20.40) goes through
  const { env: e2 } = setup();
  mockFetch([[rw('text_to_video'), () => reply(200, { id: TASK, estimatedCost: { credits: 2040 } })]]);
  assert.equal((await owner(e2, 'runway/generate/text_to_video', post(RUNWAY_JOBS[7][1]))).status, 200);
});

test('Gemini Omni, Grok video and Grok images: refused over the limits before Google or xAI is called', async () => {
  const { env, L } = setup();
  mockFetch([]);
  setLimits(env, 1, 200);
  let r = await owner(env, 'omni/start', post({ prompt: 'p', seconds: 10, resolution: '4k' }));
  let j = await body(r);
  assert.deepEqual([r.status, j.code, j.costUsd], [402, 'owner_cap_video', 4.0544]);
  assert.match(j.error, /Nothing was sent to Google/);
  // an edit keeps its clip's length, so it is held at the longest (10 s): 10 × $0.10136 = $1.01 > $1
  r = await owner(env, 'omni/start', post({ prompt: 'p', seconds: 4, resolution: '720p', previous: 'v1_prev', task: 'edit' }));
  assert.deepEqual([r.status, (await body(r)).costUsd], [402, 1.0136]);
  r = await owner(env, 'xai/video/start', post({ model: 'grok-imagine-video-1.5', prompt: 'waves', seconds: 15 }));
  j = await body(r);
  assert.deepEqual([r.status, j.code, j.costUsd], [402, 'owner_cap_video', 1.2]);
  assert.match(j.error, /Nothing was sent to xAI/);
  // images are held to the month only: a $0 per-video limit doesn't stop one, a $0.03 month does
  setLimits(env, 0, 0.03);
  r = await owner(env, 'xai/image', post({ model: 'grok-imagine-image-2.0', prompt: 'a fox' }));
  j = await body(r);
  assert.deepEqual([r.status, j.code, j.limit, j.costUsd], [402, 'owner_cap_month', 'month', 0.04]);
  assert.match(j.error, /^This image request \(about \$0\.04\)/);
  assert.equal(upstream.calls.length, 0);
  assert.deepEqual(rows(L), []);
});

test('image passthrough (GPT Image, Nano Banana, Muse): over the monthly limit → 402 before the provider; unpriced → 400 owner_cap_unpriced', async () => {
  const { env, L } = setup();
  mockFetch([]);
  setLimits(env, 25, 0); // 0: paid images (and video) off
  const jobs = [
    ['x/openai/images/generations', { model: 'gpt-image-2.5-flare', prompt: 'x', n: 1, quality: 'high', size: '1024x1024' }],
    ['x/openai/images/edits', { model: 'gpt-image-2.5-sunburst', prompt: 'x', n: 1, quality: 'high', images: [{ image_url: PNG }] }],
    ['x/gemini/v1beta/models/gemini-3-pro-image:generateContent', { contents: [{ parts: [{ text: 'x' }] }], generationConfig: { responseModalities: ['IMAGE'], imageConfig: { imageSize: '2K' } } }],
    ['x/gemini/v1/models/gemini-nano-banana-2.1:generateContent', { contents: [{ parts: [{ text: 'x' }] }], generationConfig: { imageConfig: { imageSize: '2K' } } }],
    ['x/meta/images/generations', { model: 'muse-image-1.0', prompt: 'x', n: 1, size: '1024x1024' }],
  ];
  for (const [path, b] of jobs) {
    const r = await owner(env, path, post(b));
    const j = await body(r);
    assert.deepEqual([r.status, j.code, j.limit], [402, 'owner_cap_month', 'month'], path);
    assert.match(j.error, /Change it in Settings → Spending/);
  }
  // nothing Atelier can't price is ever sent
  for (const [path, b] of [['x/openai/images/generations', { model: 'gpt-image-9', prompt: 'x' }], ['x/gemini/v1beta/models/gemini-3.8-flash:generateContent', { contents: [{ parts: [{ text: 'x' }] }] }],
    ['x/meta/images/generations', { model: 'muse-image-9', prompt: 'x' }], ['x/openai/images/generations', { model: 'gpt-image-2.5-flare', prompt: 'x', n: 50 }], ['x/openai/images/generations', 'not json']]) {
    const r = await owner(env, path, post(b));
    assert.deepEqual([r.status, (await body(r)).code], [400, 'owner_cap_unpriced'], `${path} ${JSON.stringify(b)}`);
  }
  assert.equal(upstream.calls.length, 0);
  assert.deepEqual(rows(L), []);
});

test('no Ledger: paid owner media is paused (503 owner_cap_unavailable) rather than unmetered; chat is untouched', async () => {
  const { env } = setup({ ledger: null });
  mockFetch([]);
  for (const [path, b] of [['runway/generate/text_to_video', RUNWAY_JOBS[0][1]], ['omni/start', { prompt: 'p' }], ['xai/image', { model: 'grok-imagine-image-2.0', prompt: 'x' }], ['x/meta/images/generations', { model: 'muse-image-1.0', prompt: 'x' }]]) {
    const r = await owner(env, path, post(b));
    assert.deepEqual([r.status, (await body(r)).code], [503, 'owner_cap_unavailable'], path);
  }
  assert.equal((await owner(env, 'owner/spend')).status, 503);
  assert.equal(upstream.calls.length, 0);
});

test('RUNWAY_MAX_CREDITS stays a separate hard backstop, checked before the owner’s limits (no hold is made)', async () => {
  const { env, L } = setup({ RUNWAY_MAX_CREDITS: '100' });
  mockFetch([]);
  const r = await owner(env, 'runway/generate/text_to_video', post(RUNWAY_JOBS[0][1])); // 120 credits, well under $25
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

test('Runway: an estimate over the owner’s limits (an Aleph clip longer than said) is cancelled at once and settles to $0; a failed cancel hands back the id', async () => {
  const { env, L } = setup();
  setLimits(env, 10, 200);
  let del = 200;
  mockFetch([[rw('video_to_video'), () => reply(200, { id: TASK, estimatedCost: { credits: 1500 } })], [rw(`tasks/${TASK}`), (c) => { assert.equal(c.method, 'DELETE'); return reply(del, {}); }]]);
  // the browser says 5 s (140 credits); Runway estimates 1,500 ($15) — over the $10 per-video limit
  const aleph = { model: 'aleph2', promptText: 'snow', videoUri: 'runway://upload/abc123def456', seconds: 5 };
  let r = await owner(env, 'runway/generate/video_to_video', post(aleph));
  let j = await body(r);
  assert.deepEqual([r.status, j.code, j.costUsd, j.id], [402, 'owner_cap_video', 15, undefined]);
  assert.match(j.error, /Runway estimated \$15\.00 for this, over your \$10\.00 limit per video\. Atelier cancelled it straight away\./);
  assert.deepEqual(rows(L).map((x) => [x.amount, x.actual]), [[1_400_000, 0]]);
  del = 500;
  r = await owner(env, 'runway/generate/video_to_video', post(aleph));
  j = await body(r);
  assert.deepEqual([r.status, j.code, j.id], [402, 'owner_cap_video', TASK]);
  assert.match(j.error, /couldn’t cancel it at once/);
  assert.equal(rows(L)[1].actual, 15_000_000, 'it may run: counted at Runway’s estimate');
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

test('Gemini Omni: when Google refuses the duration, the retry is held at the longest clip — and refused if that no longer fits', async () => {
  const { env, L } = setup();
  let n = 0;
  mockFetch([[OMNI_CREATE, (c) => (++n === 1 ? reply(400, { error: { message: 'Invalid duration value' } }) : reply(200, { id: 'v1_r', status: 'queued' }))]]);
  let r = await owner(env, 'omni/start', post({ prompt: 'p', seconds: 4 }));
  assert.equal(r.status, 200);
  assert.deepEqual(rows(L).map((x) => [x.amount, x.job]), [[veoCost({ model: OMNI, seconds: 10, resolution: '720p', margin: false }), 'omni:v1_r']]);
  // $0.50 a video: 4 s (≈ $0.41) fits, the 10 s retry (≈ $1.01) doesn't — refused, released, never sent again
  setLimits(env, 0.5, 200);
  n = 0;
  r = await owner(env, 'omni/start', post({ prompt: 'p', seconds: 4 }));
  assert.deepEqual([r.status, (await body(r)).code], [402, 'owner_cap_video']);
  assert.equal(n, 1, 'the retry without a duration was not sent');
  assert.equal(rows(L).at(-1).actual, 0);
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
  assert.deepEqual([nov.totalUsd, nov.jobs, nov.leftUsd], [0, 0, 200]);
  // a full October doesn't block November
  L.ledger.clock = () => Date.UTC(2026, 9, 15);
  L.ledger.ownerReserve({ provider: 'runway', kind: 'video', amount: 199_000_000, monthly: 200_000_000 });
  L.ledger.clock = () => Date.UTC(2026, 10, 1);
  assert.equal(L.ledger.ownerReserve({ provider: 'runway', kind: 'video', amount: 20_000_000, monthly: 200_000_000 }).ok, true);
  assert.equal((await month(env, '2026-13')).totalUsd, undefined, 'a bad month is refused');
});

// ── the Ledger's owner_spend rows ──

test('Ledger: reserve is all-or-nothing at the boundary; settle happens once, by hold id or provider id; resize must still fit', () => {
  const { ledger } = makeLedger();
  const M = 200_000_000;
  const a = ledger.ownerReserve({ provider: 'runway', kind: 'video', model: 'gen4.5', amount: 150_000_000, monthly: M });
  assert.equal(a.ok, true);
  assert.deepEqual(ledger.ownerReserve({ provider: 'omni', kind: 'video', amount: 50_000_001, monthly: M }), { ok: false, scope: 'month', month: a.month, spent: 150_000_000 });
  const b = ledger.ownerReserve({ provider: 'omni', kind: 'video', amount: 50_000_000, monthly: M });
  assert.deepEqual([b.ok, b.spent], [true, M], 'exactly the limit');
  assert.equal(ledger.ownerReserve({ provider: 'xai', kind: 'image', amount: 1, monthly: M }).ok, false);
  assert.equal(ledger.ownerReserve({ provider: 'xai', kind: 'image', amount: 0, monthly: M }).ok, true, 'a free job always fits');
  // settle: by provider id after attach; a second settle (a resumed poll) changes nothing
  assert.equal(ledger.ownerAttach(a.id, 'runway:task-1'), true);
  assert.equal(ledger.ownerAttach(b.id, 'runway:task-1'), false, 'one row per provider job');
  assert.equal(ledger.ownerAttach(b.id, 'bad id with spaces'), false);
  assert.deepEqual(ledger.ownerSettle('runway:task-1', 100_000_000), { ok: true, charged: 100_000_000, amount: 150_000_000, month: a.month });
  assert.deepEqual(ledger.ownerSettle('runway:task-1', 1), { ok: false });
  assert.deepEqual(ledger.ownerSettle(a.id, 1), { ok: false });
  assert.equal(ledger.ownerSpend(a.month).total, 150_000_000);
  // resize: shrinking always fits, growing must fit the month (with the old quote taken out)
  assert.deepEqual(ledger.ownerResize(b.id, 100_000_000, M), { ok: true }, '100 settled + 100 = 200');
  assert.deepEqual(ledger.ownerResize(b.id, 100_000_001, M), { ok: false, scope: 'month', spent: 200_000_000 });
  assert.deepEqual(ledger.ownerResize(a.id, 1, M), { ok: false, gone: true }, 'a settled row keeps its cost');
  // settle(null) = its quote; garbage = its quote; negative = $0; a sane ceiling
  assert.equal(ledger.ownerSettle(b.id, null).charged, 100_000_000);
  const c = ledger.ownerReserve({ provider: 'xai', kind: 'image', amount: 40_000, monthly: 1e12 });
  assert.equal(ledger.ownerSettle(c.id, 'x').charged, 40_000);
  const d = ledger.ownerReserve({ provider: 'xai', kind: 'image', amount: 40_000, monthly: 1e12 });
  assert.equal(ledger.ownerSettle(d.id, -5).charged, 0);
  const e = ledger.ownerReserve({ provider: 'xai', kind: 'image', amount: 40_000, monthly: 1e12 });
  assert.equal(ledger.ownerSettle(e.id, 1e20).charged, 10_000_000_000);
  // inputs the Worker never sends are refused outright
  assert.throws(() => ledger.ownerReserve({ provider: 'runway', kind: 'video', amount: 1.5, monthly: M }));
  assert.throws(() => ledger.ownerReserve({ provider: 'Runway!', kind: 'video', amount: 1, monthly: M }));
  // the breakdown: biggest first (ties by name); a still-running $0 hold counts as $0
  const s = ledger.ownerSpend(a.month);
  assert.deepEqual(s.byProvider.map((x) => [x.provider, x.kind, x.jobs, x.total, x.held]),
    [['xai', 'image', 4, 10_000_040_000, 0], ['omni', 'video', 1, 100_000_000, 0], ['runway', 'video', 1, 100_000_000, 0]]);
  assert.deepEqual([s.jobs, s.total, s.held], [6, 10_200_040_000, 0]);
  assert.equal(ledger.ownerSpend('not a month').month, a.month, 'a bad month reads this one');
});

test('Ledger: concurrent starts through the RPC stub never take the month past its limit', async () => {
  const L = makeLedger();
  const results = await Promise.all(Array.from({ length: 30 }, () => L.stub.ownerReserve({ provider: 'runway', kind: 'video', amount: 10_000_000, monthly: 200_000_000 })));
  assert.equal(results.filter((r) => r.ok).length, 20);
  assert.equal(L.ledger.ownerSpend(results[0].month).total, 200_000_000);
});

test('concurrent paid starts through the Worker: exactly as many as fit reach the provider', async () => {
  const { env, L } = setup();
  setLimits(env, 25, 2); // $2 a month; each Grok video is 8 s × $0.08 = $0.64 → three fit
  let n = 0;
  mockFetch([[/videos\/generations$/, () => reply(200, { request_id: `v${++n}` })]]);
  const rs = await Promise.all(Array.from({ length: 5 }, () => owner(env, 'xai/video/start', post({ model: 'grok-imagine-video-1.5', prompt: 'x', seconds: 8 }))));
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 200, 200, 402, 402]);
  assert.equal(upstream.calls.length, 3);
  assert.equal(rows(L).length, 3);
});

test('Ledger alarm: owner spend rows are kept 13 months', async () => {
  const L = makeLedger();
  L.ledger.clock = () => Date.UTC(2025, 8, 15);
  L.ledger.ownerReserve({ provider: 'runway', kind: 'video', amount: 1, monthly: 10 });
  L.ledger.clock = () => Date.UTC(2025, 9, 15);
  L.ledger.ownerReserve({ provider: 'runway', kind: 'video', amount: 1, monthly: 10 });
  L.ledger.clock = () => Date.UTC(2026, 9, 20);
  await L.ledger.alarm();
  assert.deepEqual(rows(L).map((x) => x.month), ['2025-10']);
});

// ── review fixes (v83) ──

test('limits live in the Ledger: a PUT applies to the very next start (no KV delay between devices); no Ledger, no saving', async () => {
  const { env, L } = setup();
  mockFetch([[rw('text_to_video'), () => reply(200, { id: TASK })]]);
  assert.equal((await owner(env, 'owner/limits', put({ perVideoUsd: 1, monthlyMediaUsd: 200 }))).status, 200);
  let r = await owner(env, 'runway/generate/text_to_video', post(RUNWAY_JOBS[0][1])); // $1.20
  assert.deepEqual([r.status, (await body(r)).code], [402, 'owner_cap_video']);
  assert.equal((await owner(env, 'owner/limits', put({ perVideoUsd: 2 }))).status, 200);
  r = await owner(env, 'runway/generate/text_to_video', post(RUNWAY_JOBS[0][1]));
  assert.equal(r.status, 200, 'the raised limit applies at once');
  assert.deepEqual(await SP.readLimits(env), { perVideoUsd: 2, monthlyMediaUsd: 200, updatedAt: L.ledger.ownerLimits().updatedAt });
  assert.equal(env.ATELIER_KV.m.size, 0);
  // whatever the row holds is made usable; the Ledger refuses to store garbage
  assert.throws(() => L.ledger.ownerSetLimits({ perVideoUsd: -1, monthlyMediaUsd: 5, updatedAt: 1 }), /bad limits/);
  assert.throws(() => L.ledger.ownerSetLimits({ perVideoUsd: 'x', monthlyMediaUsd: 5, updatedAt: 1 }), /bad limits/);
  L.shim.db.prepare("UPDATE config SET v = '{oops' WHERE k = 'owner_limits'").run();
  assert.deepEqual(await SP.readLimits(env), { perVideoUsd: 25, monthlyMediaUsd: 200, updatedAt: null });
  // the Testers panel's config route can't touch it
  assert.equal(L.ledger.setConfig({ owner_limits: '{}' }).ok, false);
  const { env: none } = setup({ ledger: null });
  r = await owner(none, 'owner/limits', put({ perVideoUsd: 5 }));
  assert.deepEqual([r.status, (await body(r)).code], [503, 'owner_cap_unavailable']);
  assert.equal((await body(await owner(none, 'owner/limits'))).perVideoUsd, 25, 'GET still shows the defaults');
});

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
