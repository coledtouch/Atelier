import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

// v114: fixes from the whole-app review to the accounts agent and its tools (areas app-2 and tools). What they have in
// common: an action that went further than what the owner saw or asked for.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export class DurableObject {} export const waitUntil = () => {};', shortCircuit: true };
    return next(specifier, context);
  },
});
const { runTool } = await import('../src/tools.js');
const APP = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function fnSource(name) {
  let at = APP.indexOf(`\nfunction ${name}(`);
  if (at < 0) at = APP.indexOf(`\nasync function ${name}(`);
  assert.ok(at >= 0, `app.js has function ${name}`);
  return APP.slice(at + 1, APP.indexOf('\n}\n', at + 1) + 2);
}

// ── Stop ──
test('Stop ends a batch of tool calls: the ones still waiting never start, and a card is never left waiting on a stopped run', async () => {
  const loop = /\n    for \(const call of toolCalls\) \{\n[\s\S]*?\n      const def = /.exec(APP)[0];
  assert.match(loop, /if \(signal\?\.aborted\) throw new DOMException\('Aborted', 'AbortError'\);/, 'checked before each call, so call 2 and 3 never run after Stop');
  const approvals = new Map();
  const awaitApproval = new Function('approvals', 'S', '$', 'toast', `${fnSource('awaitApproval')}\nreturn awaitApproval;`)(approvals, { thread: null }, () => null, () => {});
  const stopped = new AbortController(); stopped.abort();
  await assert.rejects(awaitApproval({ id: 's1' }, stopped.signal), (err) => err.name === 'AbortError');
  assert.equal(approvals.size, 0, 'nothing is left waiting for a tap');
  // not stopped: it waits for the tap, and a later Stop still ends it
  const live = new AbortController();
  const waiting = awaitApproval({ id: 's2' }, live.signal);
  approvals.get('s2')(true);
  assert.equal(await waiting, true);
  const later = awaitApproval({ id: 's3' }, live.signal);
  live.abort();
  await assert.rejects(later, (err) => err.name === 'AbortError');
  assert.equal(approvals.has('s3'), false);
  assert.equal(await Promise.race([awaitApproval({ id: 's4' }, undefined), new Promise((r) => setTimeout(r, 5, 'still waiting'))]), 'still waiting', 'no signal: just waits');
});

// ── the approval card's boxes ──
test('Approve reads the card\'s boxes strictly: a number that is no longer a number, or an emptied list, keeps the card open', () => {
  const handler = /\n    if \(act === 'approve'\) \{\n[\s\S]*?\n    approvals\.delete\(st\.id\);/.exec(APP)[0];
  assert.match(handler, /if \(typeof orig === 'number'\) return !f\.value\.trim\(\) \|\| !Number\.isFinite\(Number\(f\.value\)\);/);
  assert.match(handler, /return Array\.isArray\(orig\) && orig\.length > 0 && !isRecipient\(st, f\.dataset\.arg\) && !f\.value\.split\(','\)\.some\(\(x\) => x\.trim\(\)\);/);
  assert.match(handler, /if \(wrong\) \{\n        toast\(/);
  const writeBack = handler.indexOf('.forEach((f) => {\n        const k = f.dataset.arg;');
  assert.ok(writeBack > 0 && handler.indexOf('if (wrong)') < writeBack, 'checked before any box is written back to the step');
  assert.match(handler, /wrong\.focus\(\);\n        return;/, 'and nothing is approved');
  // the cases the review named, through the same expressions
  const badNumber = (v) => !v.trim() || !Number.isFinite(Number(v));
  for (const v of ['$7', '7,50', '', '  ', 'seven', '1 000']) assert.equal(badNumber(v), true, JSON.stringify(v));
  for (const v of ['700', '0', '12.5', ' 42 ']) assert.equal(badNumber(v), false, v);
});

// ── the tools themselves refuse what the card could not have meant ──
const withFetch = async (fn) => {
  const calls = [], real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), method: init.method || 'GET', body: init.body || '' }); return new Response(JSON.stringify({ id: 're_1', amount: 700, currency: 'usd', status: 'succeeded', result: [{ id: 'zone1' }], success: true }), { status: 200, headers: { 'content-type': 'application/json' } }); };
  try { return await fn(calls); } finally { globalThis.fetch = real; }
};
test('stripe_refund: a given amount must be a whole number of cents; only a missing one is a full refund', async () => {
  const env = { STRIPE_API_KEY: 'sk_test_fixture' };
  await withFetch(async (calls) => {
    for (const bad of [null, 0, '', '1,500', '$15', 12.5, -100, 'NaN', {}, []]) {
      const r = await runTool(env, 'stripe_refund', { payment_intent: 'pi_1', amount_cents: bad }, true);
      assert.deepEqual(r, { ok: false, error: 'amount_cents must be a whole number of cents, 1 or more. Leave it out for a full refund.' }, JSON.stringify(bad));
    }
    assert.equal(calls.length, 0, 'Stripe is never asked');
    const partial = await runTool(env, 'stripe_refund', { payment_intent: 'pi_1', amount_cents: 700, reason: 'duplicate' }, true);
    assert.equal(partial.ok, true);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0].body)), { payment_intent: 'pi_1', amount: '700', reason: 'duplicate' });
    await runTool(env, 'stripe_refund', { payment_intent: 'pi_1', amount_cents: '700' }, true);
    assert.equal(new URLSearchParams(calls[1].body).get('amount'), '700', 'a whole number sent as text still counts');
    await runTool(env, 'stripe_refund', { payment_intent: 'pi_2' }, true);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[2].body)), { payment_intent: 'pi_2' }, 'no amount: the whole payment, as the tool says');
    assert.equal((await runTool(env, 'stripe_refund', { payment_intent: 'pi_1', amount_cents: 700 })).ok, false, 'and never without the approval');
  });
});

test('cf_purge_cache: a list that is given but empty is an error, not "everything"', async () => {
  const env = { CLOUDFLARE_API_TOKEN: 'cf-fixture-token-0123456789abcdef', ATELIER_KV: { get: async () => null, put: async () => {}, delete: async () => {}, list: async () => ({ keys: [] }) } };
  await withFetch(async (calls) => {
    for (const urls of [[], [''], ['  '], 'https://a.example/x', null, [7]]) {
      const r = await runTool(env, 'cf_purge_cache', { zone: 'example.com', urls }, true);
      assert.deepEqual(r, { ok: false, error: 'urls must list at least one address. Leave it out to purge everything.' }, JSON.stringify(urls));
    }
    assert.equal(calls.filter((c) => /purge_cache/.test(c.url)).length, 0, 'nothing is purged');
    const some = await runTool(env, 'cf_purge_cache', { zone: 'example.com', urls: ['https://example.com/a.css'] }, true);
    assert.equal(some.ok, true, JSON.stringify(some));
    assert.deepEqual(JSON.parse(calls.find((c) => /purge_cache/.test(c.url)).body), { files: ['https://example.com/a.css'] });
    calls.length = 0;
    const all = await runTool(env, 'cf_purge_cache', { zone: 'example.com' }, true);
    assert.equal(all.ok, true);
    assert.deepEqual(JSON.parse(calls.find((c) => /purge_cache/.test(c.url)).body), { purge_everything: true });
  });
});

// ── the sign-in card ──
test('a sign-in card names the site from the tab; it no longer carries the warning meant for an unreadable click target', () => {
  assert.match(APP, /if \(step\.name === 'browser_signin'\) step\.target = await extCall\('tabs'\)\.then\(\(tabs\) => \{ const t = \(Array\.isArray\(tabs\) \? tabs : \[\]\)\.find\(\(x\) => x\?\.tabId === args\.tabId\); return t \? \{ page: t\.title, url: t\.url \} : null; \}\)\.catch\(\(\) => null\);\n        else if \(step\.service === 'browser' && step\.write\) step\.target = await extCall\('describe'/);
  const card = /\n          : st\.name === 'browser_signin' \? `[^\n]*\n/.exec(APP)[0];
  assert.match(card, /Signs in on <b>\$\{esc\(urlHost\(st\.target\.url\)\)\}<\/b> with the password Chrome saved\. Atelier never sees it\./);
  assert.match(card, /'<b>Couldn’t find that tab — decline unless you’re sure\.<\/b>'/);
  assert.ok(APP.indexOf(": st.name === 'browser_signin' ? `") < APP.indexOf(": st.service === 'browser' ? `<p class=\"ac-target\">${st.target && !st.target.error"), 'before the click-and-type branch, which is unchanged');
});

// ── Run again keeps what it replaces until the new run has something ──
function scope(vars) {
  return new Proxy(vars, {
    has: (t, k) => typeof k === 'string' && (k in t || !(k in globalThis)),
    get: (t, k) => (k === Symbol.unscopables ? undefined : k in t ? t[k] : () => undefined),
    set: (t, k, v) => { t[k] = v; return true; },
  });
}
function runRig(over = {}) {
  const toasts = [], retryPrev = new WeakMap();
  const vars = {
    $: () => ({}), MODES: { video: { label: 'Video' }, build: { label: 'Build' }, ask: { label: 'Ask' } }, running: new Set(), entryRuns: new Map(), runDone: new Map(), liveThreads: new Map(), liveRuns: new Map(),
    Sync: { holdRunLock: () => () => {}, kick() {} }, DB: { put: async () => {} }, sentText: () => 'now', retryPrev, libThumbs: new Map([['lib:e1:0', 'thumb'], ['lib:other:0', 'keep']]),
    toast: (m, o) => toasts.push([m, Boolean(o?.error)]), errorKind: () => 'other', isTesterCode: () => false, console: { error() {} }, S: { thread: { id: 't', entries: [] }, tester: null }, ...over,
  };
  const run = new Function('scope', `with (scope) { return (${fnSource('run')}); }`)(scope(vars));
  return { run, vars, toasts, retryPrev };
}
const clip = () => ({ id: 'e1', kind: 'video', prompt: 'a dog runs', params: {}, media: [{ type: 'video', src: 'blob:paid-clip' }], meta: { model: 'runway:gen4.5', ms: 900 }, enhanced: 'a dog runs, tracking shot' });
// What the Run again button does before run(): keep the old result aside, then clear the card.
const press = (rig, e) => {
  rig.retryPrev.set(e, { text: e.text, think: e.think, media: e.media, ideas: e.ideas, app: e.app, meta: e.meta, enhanced: e.enhanced });
  Object.assign(e, { text: '', think: '', media: [], ideas: null, app: null, error: null, errorKind: null, cut: null, steps: null, enhanced: null, budget: null });
};

test('Run again that fails or is stopped gives the earlier result back, with a toast; one that makes something replaces it', async () => {
  const failed = runRig({ runVideo: async () => { throw Object.assign(new Error('Runway is out of credits.'), { status: 402 }); } });
  const e = clip(), was = e.media;
  press(failed, e);
  await failed.run(e);
  assert.equal(e.media, was, 'the paid clip is back on the card');
  assert.deepEqual([e.error, e.errorKind, e.enhanced, e.meta.model], [null, null, 'a dog runs, tracking shot', 'runway:gen4.5']);
  assert.deepEqual(failed.toasts, [['Runway is out of credits. Your earlier result is back.', true]]);
  assert.deepEqual([...failed.vars.libThumbs.keys()], ['lib:other:0'], 'its Library thumbs are made again from the clip that is back');
  assert.equal(failed.retryPrev.has(e), false);

  const stopped = runRig({ runVideo: async () => { throw new DOMException('Aborted', 'AbortError'); } });
  const s = clip();
  press(stopped, s);
  await stopped.run(s);
  assert.equal(s.media.length, 1);
  assert.equal(s.error, null);
  assert.deepEqual(stopped.toasts, [['Stopped. Your earlier result is back.', false]]);

  const worked = runRig({ runVideo: async (x) => { x.media = [{ type: 'video', src: 'blob:new-clip' }]; } });
  const w = clip();
  press(worked, w);
  await worked.run(w);
  assert.equal(w.media[0].src, 'blob:new-clip');
  assert.deepEqual(worked.toasts, []);
  assert.equal(worked.retryPrev.has(w), false, 'nothing is kept once the run has ended');
});

test('Run again: a new job that can be picked up again wins over the old result; a first run that fails shows its error as before', async () => {
  const resumable = runRig({ runVideo: async () => { throw Object.assign(new Error('The Grok video download dropped — tap Try again (it won’t make a new video).'), { resumable: true }); } });
  const e = clip();
  press(resumable, e);
  await resumable.run(e);
  assert.deepEqual(e.media, [], 'the old clip is not put back: Try again fetches the new one, which is paid for');
  assert.match(e.error, /download dropped/);
  assert.deepEqual(resumable.toasts, []);
  const first = runRig({ runVideo: async () => { throw new Error('No luck.'); } });
  const f = { id: 'e2', kind: 'video', prompt: 'x', params: {}, media: [] };
  await first.run(f);
  assert.equal(f.error, 'No luck.');
  assert.deepEqual(first.toasts, []);
  // the button keeps the result aside only when there is one, and before the card is cleared
  const retry = /\n    case 'retry':\n[\s\S]*?\n      return run\(e\);/.exec(APP)[0];
  assert.match(retry, /if \(!e\.error && \(e\.text \|\| e\.media\?\.length \|\| e\.ideas \|\| e\.app\)\) retryPrev\.set\(e, \{ text: e\.text, think: e\.think, media: e\.media, ideas: e\.ideas, app: e\.app, meta: e\.meta, enhanced: e\.enhanced \}\);/);
  assert.ok(retry.indexOf('retryPrev.set(') < retry.indexOf("Object.assign(e, { text: ''"));
});

// ── Build: the whole app, even when its own code holds a code fence ──
test('extractHtml takes the app from its first tag to its last </html>, whatever its script holds', () => {
  const extractHtml = new Function(`${fnSource('extractHtml')}\nreturn extractHtml;`)();
  const app = '<!doctype html><html><body><script>\nconst FENCE = /```(\\w*)\\n([\\s\\S]*?)```/g;\nconst sample = "```js\\nhi\\n```";\n</script><p>ok</p></body></html>';
  assert.equal(extractHtml(`Here is your app:\n\n\`\`\`html\n${app}\n\`\`\`\n\nEnjoy!`), app, 'a Markdown previewer is no longer cut at its own ```');
  assert.equal(extractHtml(app), app);
  assert.equal(extractHtml(`\`\`\`html\n<html><body>x</body></HTML>\n\`\`\``), '<html><body>x</body></HTML>');
  assert.equal(extractHtml('```html\n<!doctype html><html><body><p>cut off mid'), '<!doctype html><html><body><p>cut off mid', 'no ending: what there is');
  assert.equal(extractHtml('```html\n<!doctype html><html><body>never closed\n```\nThat is all.'), '<!doctype html><html><body>never closed', 'no ending: up to the fence that closes the block');
  assert.equal(extractHtml('I could not build that.'), null);
  assert.equal(extractHtml(''), null);
  // an app without its ending says so on the card, for the owner too
  assert.match(APP, /if \(!\/<\\\/html>\\s\*\$\/i\.test\(html\)\) e\.cut = S\.tester \? 'cap' : 'short';/);
  assert.match(APP, /else if \(e\.cut === 'short' && !e\.pending\) out\.insertAdjacentHTML\('beforeend', '<p class="cut-note">The app’s code ended early — ask Atelier to finish it<\/p>'\);/);
});

// ── a rate limit is not a dead account ──
test('a 429 that reads as a rate limit never marks the provider dead; one that names money or a key does, for a minute', () => {
  const accountProblem = new Function(`${/\nconst accountProblem = [\s\S]*?\);\n/.exec(APP)[0]}\nreturn accountProblem;`)();
  const lead = 'Rate limited — give it a few seconds. ';
  for (const m of ['Rate limit reached for gpt-5.5 in organization org-abc on tokens per min (TPM): Limit 30000. Please try again in 6s.',
    'This request would exceed the rate limit for your organization of 80,000 input tokens per minute.', 'Too many requests, slow down', 'Requests per day exceeded for this key']) {
    assert.equal(accountProblem({ status: 429, message: lead + m }), false, m);
  }
  for (const m of ['You exceeded your current quota, please check your plan and billing details.', 'Your team has reached its monthly spending limit.', 'Your credit balance is too low.']) {
    assert.equal(accountProblem({ status: 429, message: lead + m }), true, m);
  }
  assert.equal(accountProblem({ status: 429, message: 'Rate limited — give it a few seconds.' }), false, 'the app\'s own lead alone says nothing about the account');
  assert.equal(accountProblem({ status: 400, message: 'Your organization must be verified to use this model.' }), true, 'a 400 keeps every word it had');
  assert.equal(accountProblem({ status: 401, message: 'x' }), true);
  // deadProviders: a 429's entry lasts a minute, any other the session
  const src = /\nconst deadProviders = new \(class extends Map \{[\s\S]*?\n\}\)\(\);\n/.exec(APP)[0];
  let now = 1_000_000;
  const dead = new Function('Date', `${src}\nreturn deadProviders;`)({ now: () => now });
  dead.mark('gemini', 'quota', 60_000);
  dead.mark('openai', 'bad key');
  assert.equal(dead.has('gemini') && dead.has('openai'), true);
  now += 61_000;
  assert.equal(dead.has('gemini'), false, 'the minute is over: Gemini is tried again');
  assert.equal(dead.has('openai'), true, 'a bad key stays out for the session');
  dead.mark('gemini', 'quota', 60_000); dead.mark('gemini', 'key');
  now += 61_000;
  assert.equal(dead.has('gemini'), true, 'a later session-long reason is not ended by an earlier timer');
  dead.clear();
  assert.equal(dead.size, 0);
  assert.match(APP, /deadProviders\.mark\(prov, err\.message, err\.status === 429 \? 60_000 : 0\);/);
});
