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

// The browser half of the owner's spend readout (public/spend.js, Settings → Spending → This month's spend). Since v85
// there are no spending limits: no limit fields, no Save, no refusal card, no cost-note warnings and no PUT
// /api/owner/limits; the panel only reads GET /api/owner/spend. A provider's own out-of-credit answer is still an account
// problem (the next provider takes over), and RUNWAY_MAX_CREDITS (optional, unset) keeps its own refusal. Mocked fetch only.
const C = await import('../public/spend.js');
const RemixShots = await import('../public/remix-shots.js');
const RW = await import('../public/runway.js');
const { validateBackup, ERROR_KINDS } = await import('../public/data-safety.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const APP = read('../public/app.js'), HTML = read('../public/index.html'), CSS = read('../public/app.css');

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// What v84's Worker answered over a limit: an entry may still hold its words (and e.cap) in a thread or a backup.
const V84_CAP = { error: 'This video would cost about $30.60, over your $25.00 limit per video. Nothing was sent to Runway. Change it in Settings → Spending.', code: 'owner_cap_video' };
const RUNWAY_CAP = { error: 'This Runway video would cost about 2040 credits ($20.40) — over this server’s cap of 1000 (RUNWAY_MAX_CREDITS). Nothing was sent to Runway.', code: 'runway_cap' };

// app.js's own accountProblem + errorKind, lifted from its source (as tests/runway-client.test.mjs does).
const { accountProblem, errorKind } = (() => {
  const a = APP.match(/\nconst accountProblem = [\s\S]*?\);\n/), k = APP.match(/\nfunction errorKind\([\s\S]*?\n}\n/);
  assert.ok(a && k, 'accountProblem and errorKind are still where this test looks');
  return new Function('isTesterCode', `${a[0]}\n${k[0]}\nreturn { accountProblem, errorKind };`)((c) => typeof c === 'string' && (c.startsWith('tester_') || c === 'owner_only'));
})();

test('app.js: no spending-limit card any more — no owner_cap code is mapped, and a provider’s own 402 is still an account problem', () => {
  for (const code of ['owner_cap_video', 'owner_cap_month', 'owner_cap_unpriced', 'owner_cap_unavailable']) assert.notEqual(errorKind(V84_CAP.error, 402, code), 'cap', code);
  assert.doesNotMatch(APP, /owner_cap|isCapCode|capOf|cleanCap|capTitle|capWarning|partialCapNote|limitsBody|saveLimits|openSpending|Change limits/);
  assert.doesNotMatch(APP, /\bcap: '/, 'no “Over your spending limit” title');
  assert.equal(ERROR_KINDS.includes('cap'), false);
  // a provider's own 402 is still one (Runway / xAI out of credit → the next provider)
  assert.equal(accountProblem({ status: 402, code: 'runway_credits', message: 'Runway says the account is out of credits' }), true);
  assert.equal(accountProblem({ status: 402, message: 'Payment required' }), true);
  assert.equal(errorKind('Runway says the account is out of credits', 402, 'runway_credits'), 'key');
  assert.equal(errorKind('You have exceeded your spending limit', 400, undefined), 'key', 'a provider’s own spending-limit wording');
  // a tester's 402 stays the tester's own card
  assert.equal(errorKind('x', 402, 'tester_budget'), 'budget');
  // images still move on to the next model on an account problem or a busy provider, and never on a tester refusal
  const skip = APP.match(/const skippable = ([^;]+);/);
  assert.ok(skip, 'runImage’s skippable test');
  const skippable = new Function('err', 'isTesterCode', 'accountProblem', `return ${skip[1]};`);
  const isTesterCode = (c) => typeof c === 'string' && c.startsWith('tester_');
  assert.equal(skippable({ status: 429, message: 'busy' }, isTesterCode, accountProblem), true);
  assert.equal(skippable({ status: 402, code: 'runway_credits', message: 'out of credits' }, isTesterCode, accountProblem), true);
  assert.equal(skippable({ status: 402, code: 'tester_budget', message: 'x' }, isTesterCode, accountProblem), false);
});

test('an entry saved with v84’s spending-limit card still imports, renders as the plain card, and runs again', () => {
  const entry = (extra) => ({ app: 'atelier', v: 1, threads: [{ id: 't1', title: 'x', createdAt: 1, updatedAt: 1, entries: [{ id: 'e1', kind: 'video', prompt: 'p', createdAt: 1, error: V84_CAP.error, errorKind: 'cap', ...extra }] }] });
  assert.equal(validateBackup(entry({ cap: { limit: 'month', resetsAt: Date.UTC(2026, 10, 1) } })).length, 1);
  assert.throws(() => validateBackup(entry({ cap: { limit: 'week' } })), 'a malformed one is still refused');
  assert.throws(() => validateBackup(entry({ cap: { limit: 'video', html: '<img onerror=x>' } })));
  // errorBox: an unknown kind is classified from the entry's text instead (never trusted into markup)
  assert.match(APP, /const kind = typeof e\.errorKind === 'string' && Object\.hasOwn\(ERROR_TITLE, e\.errorKind\) \? e\.errorKind : errorKind\(e\.error\);/);
  assert.equal(errorKind(V84_CAP.error), 'error', '“Couldn’t finish” with Try again');
  // a re-run clears the old field
  assert.match(APP, /delete e\.budget; delete e\.cap;/);
});

test('Settings → Spending: owner only (needs-owner), a read-only readout — no limit inputs, no Save, no PUT', () => {
  assert.match(HTML, /<section class="field-group needs-owner" id="spendingSection">\s*<h4>Spending<\/h4>\s*<div class="testers spending" id="spendingPanel"><\/div>/);
  assert.match(APP, /if \(S\.settings\.passcode && !S\.tester\) \{ loadSpending\(\); if \(testersOpen\) loadTesters\(\); \}/);
  assert.match(APP, /async function loadSpending\(\) \{\n  const box = \$\('#spendingPanel'\), seq = \+\+SP\.seq;\n  if \(!S\.settings\.passcode \|\| S\.tester\) return null;/);
  const panel = APP.slice(APP.indexOf('// ── owner: Settings → General → Spending'), APP.indexOf('// ───────────────────────── You: profile'))
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'); // the code, not its comments
  assert.ok(panel.length > 500, 'the panel code');
  assert.doesNotMatch(panel, /<input|spVideo|spMonth|data-sp="save"|PUT|limit/i);
  assert.doesNotMatch(APP, /\/api\/owner\/limits/);
  // the settings Save no longer carries limit fields
  assert.doesNotMatch(APP, /spEdited|spSave|Spending limits saved/);
  // the cost notes carry no limit warning
  assert.doesNotMatch(APP, /cap-warn|capNote|CapNote|ensureSpend/);
  assert.doesNotMatch(CSS, /cap-warn|sp-limits/);
});

test('the readout paints this month’s spend and its breakdown from GET /api/owner/spend, with nothing to edit', () => {
  const src = APP.match(/\nfunction paintSpending\(\) \{[\s\S]*?\n}\n/)?.[0];
  assert.ok(src, 'paintSpending');
  const box = { innerHTML: '', removeAttribute() {} };
  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const paint = (data) => new Function('$', 'SP', 'esc', 'spendUsd', 'resetDay', 'breakdownRows', `${src}\npaintSpending();`)(() => box, { data }, esc, C.usd, C.resetDay, C.breakdownRows);
  paint({ month: '2026-10', resetsAt: '2026-11-01T00:00:00.000Z', totalUsd: 21.6527, settledUsd: 20.4527, heldUsd: 1.2, jobs: 3,
    byProvider: [{ provider: 'runway', kind: 'video', usd: 21.6, heldUsd: 1.2, jobs: 2 }, { provider: 'openai', kind: 'image', usd: 0.0527, heldUsd: 0, jobs: 1 }] });
  const text = box.innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(text, /This month’s spend · October 2026 \$21\.66/);
  assert.match(text, /\$1\.20 of it for jobs still running/);
  assert.match(text, /Runway · video 2 jobs · \$21\.60/);
  assert.match(text, /GPT Image · images 1 job · \$0\.06/);
  assert.doesNotMatch(box.innerHTML, /<input|<button|limit|left/i, 'read only: no fields, no Save, no “left of a limit”');
  paint({ month: '2026-11', totalUsd: 0, byProvider: [] });
  assert.match(box.innerHTML, /Nothing paid for yet this month\./);
});

// ── public/spend.js ──

test('public/spend.js is the readout only: no limit helpers left', () => {
  assert.deepEqual(Object.keys(C).sort(), ['breakdownRows', 'loadSpend', 'resetDay', 'usd']);
});

test('usd: rounding that never under-reports spend', () => {
  assert.equal(C.usd(12.341, { up: true }), '$12.35');
  assert.equal(C.usd(0.07, { up: true }), '$0.07', 'no float creep');
  assert.equal(C.usd(0.29), '$0.29');
  assert.equal(C.usd(1234.5), '$1,234.50');
  assert.equal(C.usd(-3), '$0.00');
  assert.equal(C.resetDay(NaN), '');
  assert.match(C.resetDay(Date.UTC(2026, 10, 1)), /Nov 1/);
});

test('breakdownRows: provider and kind labels, counts, unknown providers keep their own (short) name', () => {
  const rows = C.breakdownRows({ byProvider: [{ provider: 'runway', kind: 'video', usd: 8.4, heldUsd: 1, jobs: 2 }, { provider: 'openai', kind: 'image', usd: 0.0527, heldUsd: 0, jobs: 1 },
    { provider: 'somebody-new'.repeat(5), kind: 'video', usd: 'x', jobs: -1 }, null, { kind: 'image' }] });
  assert.deepEqual(rows.slice(0, 2), [{ label: 'Runway · video', usd: 8.4, held: 1, jobs: 2 }, { label: 'GPT Image · images', usd: 0.0527, held: 0, jobs: 1 }]);
  assert.equal(rows[2].label, `${'somebody-new'.repeat(5).slice(0, 30)} · video`);
  assert.deepEqual([rows[2].usd, rows[2].jobs, rows.length], [0, 0, 3]);
  assert.deepEqual(C.breakdownRows(null), []);
});

test('Settings → Spending call: GET /api/owner/spend with the owner’s headers; a failure keeps the Worker’s words', async () => {
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    seen.push([init.method || 'GET', String(url), new Headers(init.headers).get('x-app-pass'), init.body ?? null]);
    return seen.length === 1 ? json(200, { month: '2026-10', totalUsd: 1.5 }) : json(503, { error: 'This month’s spend can’t be read on this server right now (no Ledger).', code: 'owner_spend_unavailable' });
  };
  const apiHeaders = () => ({ 'x-app-pass': 'pw' });
  assert.equal((await C.loadSpend({ apiHeaders })).totalUsd, 1.5);
  await assert.rejects(C.loadSpend({ apiHeaders }), (e) => e.status === 503 && e.code === 'owner_spend_unavailable' && /no Ledger/.test(e.message));
  assert.deepEqual(seen, [['GET', '/api/owner/spend', 'pw', null], ['GET', '/api/owner/spend', 'pw', null]]);
});

// ── RUNWAY_MAX_CREDITS (optional, unset) is the only cap left ──

test('Video mode and Remix: a RUNWAY_MAX_CREDITS refusal comes back once with its code and words; one naming a running task retries the cancel', async () => {
  let posts = 0;
  globalThis.fetch = async (url, init = {}) => { if ((init.method || 'GET') === 'POST') posts++; return json(402, RUNWAY_CAP); };
  const req = RW.buildRequest({ model: 'seedance2_5', prompt: 'a boat', aspect: '16:9hd', secs: 30 });
  await assert.rejects(RW.runwayVideo(req, { apiHeaders: {}, sleep: async () => {} }), (e) => {
    assert.deepEqual([e.status, e.code, e.message, e.resumable, e.task], [402, 'runway_cap', RUNWAY_CAP.error, undefined, undefined]);
    return true;
  });
  assert.equal(posts, 1, 'no retry');
  const TASK = '4a7b0c1d-2e3f-4a5b-8c6d-7e8f9a0b1c2d';
  const running = { error: 'Runway estimated 1500 credits ($15.00) for this — over this server’s cap of 1000 (RUNWAY_MAX_CREDITS). Atelier couldn’t cancel it at once and is trying again — check at dev.runway.com that it stopped.', code: 'runway_cap_running', id: TASK };
  const calls = [];
  globalThis.fetch = async (url, init = {}) => { calls.push([init.method || 'GET', String(url)]); return init.method === 'DELETE' ? json(200, { ok: true }) : json(402, running); };
  await assert.rejects(RemixShots.runwayStart({ apiHeaders: { 'x-app-pass': 'pw' } }, { kind: 'text_to_video', body: { model: 'gen4.5', promptText: 'x' } }),
    (e) => e.kind === 'definitive' && e.code === 'runway_cap_running' && /trying again/.test(e.message));
  assert.deepEqual(calls, [['POST', '/api/runway/generate/text_to_video'], ['DELETE', `/api/runway/task/${TASK}`]]);
  calls.length = 0;
  await assert.rejects(RW.runwayVideo(RW.buildRequest({ model: 'gen4.5', prompt: 'x' }), { apiHeaders: {}, sleep: async () => {} }), (e) => e.code === 'runway_cap_running');
  assert.deepEqual(calls.filter(([m]) => m === 'DELETE'), [['DELETE', `/api/runway/task/${TASK}`]]);
});

test('Settings → Spending a11y: the panel is not one big live region (its errors use role="alert")', () => {
  assert.match(HTML, /<div class="testers spending" id="spendingPanel"><\/div>/);
  assert.match(APP, /box\.innerHTML = `<p class="hint bad" role="alert">\$\{esc\(err\?\.name === 'TimeoutError' \? 'Your spending is taking too long to load — try again\.' : netText\(err\)\)\}<\/p><button type="button" class="chip" data-sp="reload">Try again<\/button>`;/);
});
