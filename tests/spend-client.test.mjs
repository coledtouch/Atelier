import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export class DurableObject {} export const waitUntil = () => {};', shortCircuit: true };
    return next(specifier, context);
  },
});

// The browser half of the owner's spending limits (public/spend.js, app.js's error mapping, the remix and video
// runners): a refusal (402 owner_cap_video / owner_cap_month) is a limit the owner set, never a provider out of credit —
// no fallback to another paid model, no provider marked dead, no motion-still swap, no retry loop. Mocked fetch only.
const C = await import('../public/spend.js');
const W = await import('../src/spend.js');
const { veoCost } = await import('../src/tester/prices.js');
const { VEO_PER_SECOND } = await import('../public/tester.js');
const { xaiQuote } = await import('../public/xai.js');
const { videoQuoteMicros } = await import('../src/xai.js');
const RemixShots = await import('../public/remix-shots.js');
const RW = await import('../public/runway.js');
const OM = await import('../public/omni.js');
const XA = await import('../public/xai.js');
const { validateBackup, ERROR_KINDS } = await import('../public/data-safety.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const APP = read('../public/app.js'), HTML = read('../public/index.html'), CSS = read('../public/app.css');

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const CAP_VIDEO = { error: 'This video would cost about $30.60, over your $25.00 limit per video. Nothing was sent to Runway. Change it in Settings → Spending.', code: 'owner_cap_video', limit: 'video', costUsd: 30.6, perVideoUsd: 25 };
const CAP_MONTH = { error: 'This video (about $5.00) would bring this month’s video and image spending to $201.00, over your $200.00 monthly limit ($196.00 used, resets Nov 1). Nothing was sent to Google. Change it in Settings → Spending.', code: 'owner_cap_month', limit: 'month', resetsAt: '2026-11-01T00:00:00.000Z' };

// app.js's own accountProblem + errorKind, lifted from its source (as tests/runway-client.test.mjs does).
const { accountProblem, errorKind } = (() => {
  const a = APP.match(/\nconst accountProblem = [\s\S]*?\);\n/), k = APP.match(/\nfunction errorKind\([\s\S]*?\n}\n/);
  assert.ok(a && k, 'accountProblem and errorKind are still where this test looks');
  return new Function('isTesterCode', `${a[0]}\n${k[0]}\nreturn { accountProblem, errorKind };`)((c) => typeof c === 'string' && (c.startsWith('tester_') || c === 'owner_only'));
})();

test('app.js: an owner spending-limit 402 is never an account problem (no dead provider, no fallback) and gets its own card', () => {
  for (const body of [CAP_VIDEO, CAP_MONTH]) {
    assert.equal(accountProblem({ status: 402, code: body.code, message: body.error }), false, body.code);
    assert.equal(errorKind(body.error, 402, body.code), 'cap', body.code);
  }
  // even worded like an out-of-credit answer, the code decides
  assert.equal(accountProblem({ status: 402, code: 'owner_cap_month', message: 'credit billing quota spending limit' }), false);
  assert.equal(accountProblem({ status: 503, code: 'owner_cap_unavailable', message: 'x' }), false);
  // a provider's own 402 is still one (Runway / xAI out of credit → the next provider)
  assert.equal(accountProblem({ status: 402, code: 'runway_credits', message: 'Runway says the account is out of credits' }), true);
  assert.equal(accountProblem({ status: 402, message: 'Payment required' }), true);
  assert.equal(errorKind('Runway says the account is out of credits', 402, 'runway_credits'), 'key');
  // a tester's 402 stays the tester's own card
  assert.equal(errorKind('x', 402, 'tester_budget'), 'budget');
  // 'cap' is a kind the card, backups and sync know
  assert.ok(ERROR_KINDS.includes('cap'));
  assert.match(APP, /cap: 'Over your spending limit'/);
});

test('app.js: no paid fallback after a limit — images don’t move on to the next model, Omni doesn’t become a motion still', () => {
  const skip = APP.match(/const skippable = ([^;]+);/);
  assert.ok(skip, 'runImage’s skippable test');
  const skippable = new Function('err', 'isTesterCode', 'isCapCode', 'accountProblem', `return ${skip[1]};`);
  const isTesterCode = (c) => typeof c === 'string' && c.startsWith('tester_');
  for (const [status, code] of [[402, 'owner_cap_month'], [402, 'owner_cap_video'], [503, 'owner_cap_unavailable'], [400, 'owner_cap_unpriced']]) {
    assert.equal(skippable({ status, code, message: 'x' }, isTesterCode, C.isCapCode, accountProblem), false, code);
  }
  assert.equal(skippable({ status: 429, message: 'busy' }, isTesterCode, C.isCapCode, accountProblem), true, 'a busy provider still moves on');
  // runVideo's Omni → motion still swap only on an account problem or a 429
  assert.match(APP, /if \(err\.name === 'AbortError' \|\| S\.tester \|\| err\.resumable \|\| !\(accountProblem\(err\) \|\| err\.status === 429\)\) throw err;/);
  // toApiError keeps the Worker's words and the code (the image routes' errors)
  assert.match(APP, /if \(isTesterCode\(code\) \|\| code === 'model_no_images' \|\| isCapCode\(code\)\) return new ApiError/);
  // the card: which limit, when the month resets, and "Change limits" (owner only) → Settings → Spending
  assert.match(APP, /kind === 'cap' && !S\.tester \? btn\('spending', '', 'Change limits'\)/);
  assert.match(APP, /case 'spending': return openSpending\(\);/);
  assert.match(APP, /else if \(isCapCode\(err\.code\)\) \{ const cap = capOf\(err\); if \(cap\) e\.cap = cap; \}/);
});

test('Settings → Spending: owner only (needs-owner), never painted or loaded for testers; the cost notes skip testers', () => {
  assert.match(HTML, /<section class="field-group needs-owner" id="spendingSection">\s*<h4>Spending<\/h4>/);
  assert.match(APP, /if \(S\.settings\.passcode && !S\.tester\) \{ loadSpending\(\); loadTesters\(\); \}/);
  assert.match(APP, /async function fetchSpending\([^)]*\) \{\n  const box = \$\('#spendingPanel'\), seq = \+\+SP\.seq;\n  if \(!S\.settings\.passcode \|\| S\.tester\) return null;/);
  assert.match(APP, /function capNote\(costUsd, kind\) \{\n  if \(S\.tester \|\| !S\.settings\.passcode\) return '';/);
  assert.match(APP, /\+ \(fit \? '' : videoCapNote\(vm, o\)\)/, 'a tester’s Omni note (fit) never gets the owner warning');
  assert.match(CSS, /\.tp-limits\.sp-limits \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
});

// ── public/spend.js ──

test('client and Worker agree: codes, defaults and bounds', () => {
  assert.deepEqual(C.CAP_CODES, W.CAP_CODES);
  assert.deepEqual(C.DEFAULT_LIMITS, W.DEFAULT_LIMITS);
  assert.deepEqual(C.LIMIT_BOUNDS, W.LIMIT_BOUNDS);
  assert.equal(C.isCapCode('owner_cap_video') && C.isCapCode('owner_cap_month') && C.isCapCode('owner_cap_unpriced'), true);
  assert.equal(C.isCapCode('owner_only') || C.isCapCode('tester_budget') || C.isCapCode(undefined), false);
  assert.equal(C.capLimitOf('owner_cap_video'), 'video');
  assert.equal(C.capLimitOf('owner_cap_month'), 'month');
  assert.equal(C.capLimitOf('owner_cap_unpriced'), null);
});

test('capWarning: the cost note warns at the same boundaries the Worker refuses at', () => {
  const data = { limits: { perVideoUsd: 25, monthlyMediaUsd: 200 }, totalUsd: 190 };
  assert.equal(C.capWarning(25, { kind: 'video', data: { ...data, totalUsd: 0 } }), '', 'exactly the per-video limit fits');
  assert.equal(C.capWarning(25.01, { kind: 'video', data: { ...data, totalUsd: 0 } }), 'over your $25.00 per-video limit');
  assert.equal(C.capWarning(10, { kind: 'video', data }), '', 'reaches $200 exactly');
  assert.equal(C.capWarning(10.01, { kind: 'video', data }), 'over this month’s limit · $10.00 left');
  assert.equal(C.capWarning(30, { kind: 'image', data: { ...data, totalUsd: 0 } }), '', 'images aren’t held to the per-video limit');
  assert.equal(C.capWarning(0.04, { kind: 'image', data: { ...data, totalUsd: 200 } }), 'this month’s $200.00 limit is used up');
  assert.equal(C.capWarning(0.07, { kind: 'image', data: { ...data, totalUsd: 199.97 } }), 'may go over this month’s limit · $0.03 left', 'an image price is an upper estimate');
  assert.equal(C.capWarning(5, { kind: 'video', data: null }), '', 'nothing known yet: no warning (the Worker still checks)');
  assert.equal(C.capWarning(null, { kind: 'video', data }), '', 'a free model');
});

test('usd, parseUsd, limitsBody: rounding that never under-reports spend, and the Worker’s bounds', () => {
  assert.equal(C.usd(12.341, { up: true }), '$12.35');
  assert.equal(C.usd(0.07, { up: true }), '$0.07', 'no float creep');
  assert.equal(C.usd(0.29), '$0.29');
  assert.equal(C.usd(1234.5), '$1,234.50');
  assert.equal(C.usd(-3), '$0.00');
  for (const [t, v] of [['25', 25], ['$1,200.50', 1200.5], [' 0.5 ', 0.5], ['.75', 0.75], ['abc', NaN], ['-5', NaN], ['', NaN], ['1e3', NaN]]) assert.ok(Object.is(C.parseUsd(t), v) || (Number.isNaN(v) && Number.isNaN(C.parseUsd(t))), t);
  assert.deepEqual(C.limitsBody({ perVideo: '25', monthly: '$200' }), { body: { perVideoUsd: 25, monthlyMediaUsd: 200 } });
  assert.deepEqual(C.limitsBody({ perVideo: '12.345', monthly: '0' }), { body: { perVideoUsd: 12.35, monthlyMediaUsd: 0 } });
  assert.match(C.limitsBody({ perVideo: 'lots', monthly: '200' }).error, /per-video limit must be a dollar amount/);
  assert.match(C.limitsBody({ perVideo: '501', monthly: '200' }).error, /from \$0 to \$500/);
  assert.match(C.limitsBody({ perVideo: '25', monthly: '1000000' }).error, /from \$0 to \$5,000/);
  // whatever limitsBody lets through, the Worker accepts too
  for (const [perVideo, monthly] of [['0', '0'], ['500', '5000'], ['25', '200'], ['0.01', '0.01']]) {
    const b = C.limitsBody({ perVideo, monthly }).body;
    assert.equal(W.cleanLimits(b).ok, true, `${perVideo}/${monthly}`);
  }
});

test('capOf / cleanCap: what an entry keeps about a refusal, and what a backup may bring back', () => {
  const now = Date.UTC(2026, 9, 8);
  assert.deepEqual(C.capOf({ code: 'owner_cap_video' }, now), { limit: 'video' });
  assert.deepEqual(C.capOf({ code: 'owner_cap_month', resetsAt: '2026-11-01T00:00:00.000Z' }, now), { limit: 'month', resetsAt: Date.UTC(2026, 10, 1) });
  assert.deepEqual(C.capOf({ code: 'owner_cap_month' }, now), { limit: 'month', resetsAt: Date.UTC(2026, 10, 1) }, 'the next UTC month when the server sent none');
  assert.deepEqual(C.capOf({ code: 'owner_cap_month', resetsAt: 'garbage' }, Date.UTC(2026, 11, 20)), { limit: 'month', resetsAt: Date.UTC(2027, 0, 1) });
  assert.equal(C.capOf({ code: 'runway_credits' }), null);
  assert.deepEqual(C.cleanCap({ limit: 'month', resetsAt: 5 }), { limit: 'month', resetsAt: 5 });
  for (const bad of [null, [], { limit: 'day' }, { limit: 'video', extra: 1 }, { limit: 'month', resetsAt: 'x' }, { limit: 'month', resetsAt: -1 }]) assert.equal(C.cleanCap(bad), null, JSON.stringify(bad));
  assert.equal(C.capTitle('video'), 'Over your per-video limit');
  assert.equal(C.capTitle('month'), 'Over this month’s spending limit');
  assert.equal(C.capTitle(undefined), 'Over your spending limit');
  // backups: a valid e.cap imports, a malformed one is refused like any bad field
  const entry = (extra) => ({ app: 'atelier', v: 1, threads: [{ id: 't1', title: 'x', createdAt: 1, updatedAt: 1, entries: [{ id: 'e1', kind: 'video', prompt: 'p', createdAt: 1, error: CAP_MONTH.error, errorKind: 'cap', ...extra }] }] });
  assert.equal(validateBackup(entry({ cap: { limit: 'month', resetsAt: Date.UTC(2026, 10, 1) } })).length, 1);
  assert.throws(() => validateBackup(entry({ cap: { limit: 'week' } })));
  assert.throws(() => validateBackup(entry({ cap: { limit: 'video', html: '<img onerror=x>' } })));
});

test('breakdownRows: provider and kind labels, counts, unknown providers keep their own (short) name', () => {
  const rows = C.breakdownRows({ byProvider: [{ provider: 'runway', kind: 'video', usd: 8.4, heldUsd: 1, jobs: 2 }, { provider: 'openai', kind: 'image', usd: 0.0527, heldUsd: 0, jobs: 1 },
    { provider: 'somebody-new'.repeat(5), kind: 'video', usd: 'x', jobs: -1 }, null, { kind: 'image' }] });
  assert.deepEqual(rows.slice(0, 2), [{ label: 'Runway · video', usd: 8.4, held: 1, jobs: 2 }, { label: 'GPT Image · images', usd: 0.0527, held: 0, jobs: 1 }]);
  assert.equal(rows[2].label, `${'somebody-new'.repeat(5).slice(0, 30)} · video`);
  assert.deepEqual([rows[2].usd, rows[2].jobs, rows.length], [0, 0, 3]);
  assert.deepEqual(C.breakdownRows(null), []);
});

test('the cost note’s prices are never below what the Worker holds for the owner’s requests (a warning comes early, not late)', () => {
  const prompt = 'p'.repeat(2000);
  const sizes = { '1:1': '1024x1024', '4:5': '1024x1280', '3:2': '1536x1024', '16:9': '1792x1008', '9:16': '1008x1792' }; // app.js OPENAI_SIZES
  for (const size of Object.values(sizes)) {
    const q = W.imageQuote('openai', 'images/generations', { model: 'gpt-image-2.5-flare', prompt, n: 1, quality: 'high', output_format: 'jpeg', size });
    assert.ok(C.imageUsd('openai:gpt-image-2.5-flare') * 1e6 >= q.amount, `flare ${size}: ${q.amount}`);
  }
  const edit = W.imageQuote('openai', 'images/edits', { model: 'gpt-image-2.5-sunburst', prompt, n: 1, quality: 'high', output_format: 'jpeg', images: [{ image_url: 'data:image/jpeg;base64,AAAA' }] });
  assert.ok(C.imageUsd('openai:gpt-image-2.5-flare', { edit: true }) * 1e6 >= edit.amount, `edit ${edit.amount}`);
  for (const id of ['gemini-3-pro-image', 'gemini-nano-banana-2.1']) {
    for (const withPhoto of [false, true]) {
      const parts = [{ text: prompt }, ...(withPhoto ? [{ inline_data: { mime_type: 'image/jpeg', data: 'AAAA' } }] : [])];
      const q = W.imageQuote('gemini', `v1beta/models/${id}:generateContent`, { contents: [{ parts }], generationConfig: { responseModalities: ['IMAGE'], imageConfig: { imageSize: '2K', ...(withPhoto ? {} : { aspectRatio: '1:1' }) } } });
      assert.ok(C.imageUsd(`gemini:${id}`, { edit: withPhoto }) * 1e6 >= q.amount, `${id}${withPhoto ? ' edit' : ''}: ${q.amount}`);
    }
  }
  assert.ok(C.imageUsd('meta:muse-image-1.0') * 1e6 >= W.imageQuote('meta', 'images/generations', { model: 'muse-image-1.0', prompt, n: 1 }).amount);
  assert.equal(C.imageUsd('xai:grok-imagine-image-2.0'), 0.04);
  assert.equal(C.imageUsd('black-forest-labs/flux.1-dev'), null, 'free FLUX never warns');
  // video: the client's per-clip prices are the Worker's own quotes
  for (const [res, s] of [['720p', 6], ['1080p', 10], ['720p', 4]]) {
    assert.equal(Math.round(VEO_PER_SECOND['gemini:gemini-omni-1.1-flash'][res] * s * 1e6), veoCost({ model: 'gemini:gemini-omni-1.1-flash', seconds: s, resolution: res, margin: false }));
  }
  for (const m of ['grok-imagine-video-1.5', 'grok-imagine-video-1.5-lite']) for (const s of [4, 15]) assert.equal(Math.round(xaiQuote(m, s) * 1e6), videoQuoteMicros(m, s));
});

// ── the runners keep the refusal as it is ──

test('Video Remix: a spending-limit refusal fails the shot with the Worker’s words — never queued for retry, never a tester budget', async () => {
  const now = Date.UTC(2026, 9, 8);
  for (const body of [CAP_VIDEO, CAP_MONTH]) {
    const x = new RemixShots.ShotError('definitive', body.error, { status: 402, code: body.code });
    assert.deepEqual(RemixShots.classify(x, now), { state: 'failed', error: body.error }, body.code);
  }
  // through omniShotStart / runwayStart with the Worker's real 402 body
  globalThis.fetch = async () => json(402, CAP_MONTH);
  await assert.rejects(RemixShots.omniShotStart({ apiHeaders: {} }, { body: { prompt: 'p', aspect: '9:16', resolution: '720p', seconds: 4 } }), (e) => {
    assert.deepEqual([e.kind, e.status, e.code], ['definitive', 402, 'owner_cap_month']);
    assert.equal(RemixShots.classify(e, now).state, 'failed');
    return true;
  });
  globalThis.fetch = async () => json(402, CAP_VIDEO);
  await assert.rejects(RemixShots.runwayStart({ apiHeaders: {} }, { kind: 'text_to_video', body: { model: 'gen4.5', promptText: 'x' } }), (e) => e.kind === 'definitive' && e.code === 'owner_cap_video' && e.status === 402);
});

test('Video mode runners: Runway, Omni and Grok hand the refusal back with its code and words, once, with nothing to resume', async () => {
  let posts = 0;
  globalThis.fetch = async (url, init = {}) => { if ((init.method || 'GET') === 'POST') posts++; return json(402, CAP_VIDEO); };
  const req = RW.buildRequest({ model: 'gen4.5', prompt: 'a boat', secs: 10 });
  await assert.rejects(RW.runwayVideo(req, { apiHeaders: {}, sleep: async () => {} }), (e) => {
    assert.deepEqual([e.status, e.code, e.message, e.resumable, e.task], [402, 'owner_cap_video', CAP_VIDEO.error, undefined, undefined]);
    return true;
  });
  assert.equal(posts, 1, 'no retry');
  posts = 0;
  await assert.rejects(OM.omniVideo({ prompt: 'p', seconds: 6 }, { apiHeaders: {}, sleep: async () => {} }), (e) => e.status === 402 && e.code === 'owner_cap_video' && !e.resumable && !e.id);
  assert.equal(posts, 1);
  posts = 0;
  await assert.rejects(XA.xaiVideo({ model: 'grok-imagine-video-1.5', prompt: 'p', seconds: 6 }, { apiHeaders: {}, sleep: async () => {} }), (e) => e.status === 402 && e.code === 'owner_cap_video' && !e.resumable && !e.id);
  assert.equal(posts, 1);
  // the backstop that couldn't cancel: the task id comes back so the browser retries the cancel
  const cancels = [];
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === 'DELETE') { cancels.push(String(url)); return json(200, { ok: true }); }
    return json(402, { ...CAP_VIDEO, id: '4a7b0c1d-2e3f-4a5b-8c6d-7e8f9a0b1c2d' });
  };
  await assert.rejects(RW.runwayVideo(req, { apiHeaders: {}, sleep: async () => {} }), (e) => e.code === 'owner_cap_video');
  assert.deepEqual(cancels, ['/api/runway/task/4a7b0c1d-2e3f-4a5b-8c6d-7e8f9a0b1c2d']);
});

test('Settings → Spending calls: GET /api/owner/spend and PUT /api/owner/limits with the owner’s headers; refusals keep the Worker’s words', async () => {
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    seen.push([init.method || 'GET', String(url), new Headers(init.headers).get('x-app-pass'), init.body ?? null]);
    if (init.method === 'PUT') return JSON.parse(init.body).perVideoUsd < 0 ? json(400, { error: 'The per-video limit can’t be negative.', code: 'owner_limits_input' }) : json(200, { ok: true, perVideoUsd: 10, monthlyMediaUsd: 100 });
    return json(200, { month: '2026-10', totalUsd: 1.5, limits: { perVideoUsd: 25, monthlyMediaUsd: 200 } });
  };
  const apiHeaders = () => ({ 'x-app-pass': 'pw', 'content-type': 'application/json' });
  assert.equal((await C.loadSpend({ apiHeaders })).totalUsd, 1.5);
  assert.equal((await C.saveLimits({ perVideoUsd: 10, monthlyMediaUsd: 100 }, { apiHeaders })).ok, true);
  await assert.rejects(C.saveLimits({ perVideoUsd: -1, monthlyMediaUsd: 100 }, { apiHeaders }), (e) => e.status === 400 && e.code === 'owner_limits_input' && /negative/.test(e.message));
  assert.deepEqual(seen.map(([m, u, p]) => [m, u, p]), [['GET', '/api/owner/spend', 'pw'], ['PUT', '/api/owner/limits', 'pw'], ['PUT', '/api/owner/limits', 'pw']]);
  assert.deepEqual(JSON.parse(seen[1][3]), { perVideoUsd: 10, monthlyMediaUsd: 100 });
});

// ── review fixes (v83) ──

test('app.js: owner_cap_unpriced and owner_cap_unavailable get the plain "Couldn’t finish" card, never "A provider key needs attention"', () => {
  // the Worker's own words (src/spend.js), which say "spending limits"
  for (const [status, code, message] of [
    [400, 'owner_cap_unpriced', 'Atelier couldn’t price this job, so it wasn’t sent: your spending limits need a price for every paid video and image.'],
    [400, 'owner_cap_unpriced', 'Atelier can’t price this image request (no price for “gpt-image-9”), so it wasn’t sent: your spending limits need a price for every paid image.'],
    [503, 'owner_cap_unavailable', 'Your spending limits can’t be checked on this server right now (no Ledger), so paid video and images are paused.'],
  ]) {
    assert.equal(errorKind(message, status, code), 'error', code);
    assert.equal(accountProblem({ status, message, code }), false, code);
  }
  // the two limits keep their own card; a provider's spending-limit wording without our code is still a key problem
  assert.equal(errorKind(CAP_VIDEO.error, 402, 'owner_cap_video'), 'cap');
  assert.equal(errorKind('You have exceeded your spending limit', 400, undefined), 'key');
});

test('×N images: when the monthly limit refused some of them, the entry says how many were made and why', () => {
  assert.equal(C.partialCapNote(2, 4), '2 of 4 made · the rest would go over this month’s spending limit');
  assert.equal(C.partialCapNote(1, 2), '1 of 2 made · the rest would go over this month’s spending limit');
  for (const [made, asked] of [[4, 4], [0, 4], [3, 2], [NaN, 4], [2, undefined]]) assert.equal(C.partialCapNote(made, asked), '', `${made}/${asked}`);
  // runImage: only a spending-limit refusal among the rejected jobs adds the note (and a "Change limits" toast)
  const run = APP.match(/\nasync function runImage\([\s\S]*?\n}\n/)?.[0] ?? '';
  assert.match(run, /const short = res\.some\(\(r\) => r\.status === 'rejected' && isCapCode\(r\.reason\?\.code\)\) \? partialCapNote\(e\.media\.length, e\.expect\) : '';/);
  assert.match(run, /if \(short\) \{ e\.meta\.note = \[e\.meta\.note, short\]\.filter\(Boolean\)\.join\(' · '\); toast\(short, \{ action: \{ label: 'Change limits', onClick: openSpending \} \}\); \}\n  e\.expect = e\.media\.length;/);
});

test('Video Remix: a refusal that names a running Runway task (the Worker couldn’t cancel it) retries the cancel, as Video mode does', async () => {
  const TASK = '4a7b0c1d-2e3f-4a5b-8c6d-7e8f9a0b1c2d';
  const calls = [];
  const running = { ...CAP_VIDEO, id: TASK, error: 'Runway estimated $30.60 for this, over your $25.00 limit per video. Atelier couldn’t cancel it at once and is trying again — check at dev.runway.com that it stopped.' };
  globalThis.fetch = async (url, init = {}) => { calls.push([init.method || 'GET', String(url)]); return init.method === 'DELETE' ? json(200, { ok: true }) : json(402, running); };
  await assert.rejects(RemixShots.runwayStart({ apiHeaders: { 'x-app-pass': 'pw' } }, { kind: 'text_to_video', body: { model: 'gen4.5', promptText: 'x' } }),
    (e) => e.kind === 'definitive' && e.code === 'owner_cap_video' && /trying again/.test(e.message));
  assert.deepEqual(calls, [['POST', '/api/runway/generate/text_to_video'], ['DELETE', `/api/runway/task/${TASK}`]]);
  // a refusal without a task id sends nothing more
  calls.length = 0;
  globalThis.fetch = async (url, init = {}) => { calls.push([init.method || 'GET', String(url)]); return json(402, CAP_VIDEO); };
  await assert.rejects(RemixShots.runwayStart({ apiHeaders: {} }, { kind: 'text_to_video', body: { model: 'gen4.5', promptText: 'x' } }));
  assert.deepEqual(calls, [['POST', '/api/runway/generate/text_to_video']]);
});

test('Settings → Spending a11y: the panel is not one big live region, and a background spend refresh keeps focus in the options', () => {
  assert.match(HTML, /<div class="testers spending" id="spendingPanel"><\/div>/, 'no aria-live on the whole panel (its errors use role="alert")');
  assert.match(APP, /if \(S\.mode === 'video' \|\| S\.mode === 'image'\) keepOptFocus\(renderOptions\);/);
  const keep = APP.match(/\nfunction keepOptFocus\(render\) \{[\s\S]*?\n}\n/)?.[0];
  assert.ok(keep, 'keepOptFocus');
  // run it against a tiny fake DOM: the focused select is rebuilt, and focus lands on its replacement
  const mk = (attrs, host) => ({ dataset: attrs, isConnected: true, closest: () => host, focus() { focused = this; } });
  let focused = null;
  const host = { id: 'options', isConnected: true };
  const old = mk({ opt: 'secs' }, host), fresh = mk({ opt: 'secs' }, host);
  let live = [old];
  const doc = { get activeElement() { return old; }, contains: (el) => live.includes(el) };
  const $ = (sel, root) => (root === host && sel === '[data-opt="secs"]' ? fresh : null);
  new Function('document', '$', 'render', `${keep}\nkeepOptFocus(render);`)(doc, $, () => { live = [fresh]; });
  assert.equal(focused, fresh);
});
