// v85: LinkedIn tester access is switched off by a Worker var (TESTERS_ENABLED; unset or "0" = off, "1" = on), and off
// is the default. Off: every /api/li/* route answers 410 tester_closed, a tester cookie (live, ended or forged) is never
// looked up and is cleared, every tester-only route refuses, the owner's routes are unchanged, and nothing that was
// tester-gated opens up: without the passcode, a request with a tester cookie never reaches an owner route. The app
// hides every tester surface. The code stays, so "1" switches it back on. No provider is ever called (fetch mock).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeEnv, makeLedger, mockFetch, restoreFetch, upstream, reply, sseOf, api, signIn, PROFILE, resetTesterCaches, COOKIE, worker } from './tester-env.mjs';

const { TESTER_ROUTES, PUBLIC_PATHS, matchTesterRoute } = await import('../src/tester/router.js');
const { testersOn } = await import('../src/worker.js');

beforeEach(() => resetTesterCaches());
afterEach(() => restoreFetch());

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8').then((t) => t.replace(/\r\n/g, '\n'));
const [WORKER, GEMINI, APP, HTML, STUDIO, WRANGLER, FIXTURE] = await Promise.all(['src/worker.js', 'src/gemini.js', 'public/app.js', 'public/index.html', 'public/studio.css', 'wrangler.jsonc', 'scripts/review-server.mjs'].map(read));
const codeOf = async (r) => (await r.clone().json().catch(() => ({}))).code;
const cleared = (r) => /__Host-atelier_tester=;[^,]*Max-Age=0/i.test(r.headers.get('set-cookie') || '');

// Off (the default: no TESTERS_ENABLED at all), with a tester admitted while access was on: a real, live session.
async function closed(extra = {}) {
  const made = makeEnv({ testers: false, ...extra });
  const kv = made.env.ATELIER_KV; // + list, so feedback could really be written if a route let it through
  kv.list = async ({ prefix = '', limit = 1000 } = {}) => ({ keys: [...kv.m.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit).map((name) => ({ name })), list_complete: true });
  const t = await signIn(made.L, PROFILE());
  made.L.calls.length = 0;
  return { ...made, ...t };
}

// Every route the owner's router dispatches on, read from its source (as tests/tester-router.test.mjs does), plus every
// tester-table route: a route added later shows up here without anyone editing this test.
const exact = [...WORKER.matchAll(/path === '([^']+)'/g)].map((m) => m[1]);
const prefixes = [...WORKER.matchAll(/path\.startsWith\('([^']+)'\)/g)].map((m) => m[1]);
const regexLeads = [...WORKER.matchAll(/path\.match\(\/\^((?:\\\/|[\w-])+)/g)].map((m) => m[1].replace(/\\\//g, '/'));
const videoRoutes = [...GEMINI.matchAll(/route === '([^']+)'/g)].map((m) => `video/${m[1]}`);
const SAMPLES = [...new Set([
  ...exact, ...prefixes.flatMap((p) => (p.endsWith('/') ? [`${p}probe`, `${p}a/b`] : [p, `${p}/probe`])), ...regexLeads.map((p) => `${p}probe`), ...videoRoutes,
  ...TESTER_ROUTES.map((r) => r.sample ?? r.match), 'tester/me', 'tester/profile', 'tester/sync/index', 'tester/sync/thread/abc', 'owner/spend', 'owner/limits',
  'runway/generate/text_to_video', 'xai/image', 'omni/start', 'x/openai/images/generations', 'sync/index', 'feedback',
])];
const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
const isPublic = (path) => PUBLIC_PATHS.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p));

test('the switch: off unless TESTERS_ENABLED is exactly "1"; wrangler.jsonc ships it "0"; /api/health says which', async () => {
  for (const v of [undefined, '', '0', 'false', 'true', 'yes', '01', 'on']) assert.equal(testersOn(v === undefined ? {} : { TESTERS_ENABLED: v }), false, String(v));
  for (const v of ['1', ' 1 ']) assert.equal(testersOn({ TESTERS_ENABLED: v }), true, v);
  assert.equal(testersOn(undefined), false);
  assert.match(WRANGLER, /"vars": \{[^}]*"TESTERS_ENABLED": "0"[^}]*\}/);
  for (const [env, want] of [[makeEnv({ testers: false }).env, false], [makeEnv({ testers: false, TESTERS_ENABLED: '0' }).env, false], [makeEnv().env, true]]) {
    const j = await (await api(env, 'health')).json();
    assert.equal(j.testers, want);
    assert.equal(j.ok, true);
  }
});

test('/api/li/*: sign-in, the callback, spots and sign-out all answer 410 tester_closed and clear the cookie; LinkedIn and the Ledger are never asked', async () => {
  const { env, L, token } = await closed({ LI_LIMIT: { limit: async () => { throw new Error('the throttle is never reached'); } } });
  mockFetch([]);
  for (const [method, path, who] of [
    ['GET', 'li/start', {}], ['GET', `li/callback?state=${'a'.repeat(43)}&code=abc`, {}], ['GET', 'li/spots', {}], ['POST', 'li/logout', { cookie: token }],
    ['GET', 'li/start', { cookie: token }], ['GET', 'li/anything', {}], ['POST', 'li/start', { pass: 'pw' }],
  ]) {
    const r = await api(env, path, { method, ...(method === 'POST' ? { body: '' } : {}) }, who);
    assert.equal(r.status, 410, `${method} ${path}`);
    assert.deepEqual(await r.json(), { error: 'Tester access is closed.', code: 'tester_closed' }, `${method} ${path}`);
    assert.ok(cleared(r), `${method} ${path}: the cookie is cleared`);
    assert.equal(r.headers.get('location'), null, 'never a redirect to LinkedIn');
  }
  assert.equal(upstream.calls.length, 0);
  assert.deepEqual(L.calls, []);
  assert.deepEqual([...env.ATELIER_KV.m.keys()], []);
});

test('a live, ended or forged tester cookie is a signed-out visitor: never looked up, every tester route refuses (410), tester/* is closed even for the owner', async () => {
  const { env, L, token } = await closed();
  mockFetch([[/./, () => reply(500, { error: 'should not be called' })]]);
  const forged = 'A'.repeat(43), ended = (await signIn(L, PROFILE())).token;
  L.ledger.revoke(PROFILE().sub); // (a different sub: the session below stays live)
  L.calls.length = 0;
  for (const cookie of [token, ended, forged, 'not-a-token']) {
    for (const route of TESTER_ROUTES) {
      const path = route.sample ?? route.match;
      const r = await api(env, path, { method: route.method, ...(route.method === 'GET' ? {} : { body: '' }) }, { cookie });
      assert.deepEqual([r.status, await codeOf(r)], [410, 'tester_closed'], `${route.method} ${path}`);
      assert.ok(cleared(r), `${route.method} ${path}`);
    }
  }
  // tester/*: closed for everyone, the owner included (there is no tester to be)
  for (const [path, who] of [['tester/me', {}], ['tester/me', { pass: 'pw' }], ['tester/profile', { cookie: token }], ['tester/sync/index', { pass: 'pw', cookie: token }], ['tester', {}]]) {
    const r = await api(env, path, {}, who);
    assert.deepEqual([r.status, await codeOf(r)], [410, 'tester_closed'], `${path} ${JSON.stringify(Object.keys(who))}`);
  }
  assert.equal(upstream.calls.length, 0, 'no provider was called');
  assert.deepEqual(L.calls, [], 'the Ledger was never asked who the cookie belongs to');
  assert.deepEqual([...env.ATELIER_KV.m.keys()], [], 'no tester profile, feedback or anything else written');
});

test('the router never falls through to an owner route without the passcode: every route, every method, with a live tester cookie', async () => {
  const { env, L, token } = await closed();
  env.RELAY = { idFromName: () => 'main', get: () => ({ fetch: async () => reply(401, { error: 'relay: device token required' }) }) };
  mockFetch([[/./, () => reply(500, { error: 'should not be called' })]]);
  let checked = 0;
  for (const path of SAMPLES) {
    if (isPublic(path)) continue;
    for (const method of METHODS) {
      const init = { method, ...(method === 'GET' ? {} : { body: '{}' }) };
      const before = upstream.calls.length;
      const withCookie = await api(env, path, init, { cookie: token });
      const without = await api(env, path, init, {});
      const tester = Boolean(matchTesterRoute(method, path)) || path === 'tester' || path.startsWith('tester/');
      assert.ok(withCookie.status >= 300, `${method} ${path}: ${withCookie.status} with a tester cookie and no passcode`);
      if (tester) assert.equal(withCookie.status, 410, `${method} ${path}`);
      else assert.equal(withCookie.status, without.status, `${method} ${path}: the cookie changes nothing`);
      assert.equal(upstream.calls.length, before, `${method} ${path} reached a provider`);
      checked++;
    }
  }
  assert.ok(checked > 250, `${checked} route × method pairs`);
  assert.deepEqual(L.calls, [], 'no cookie was ever looked up');
  assert.deepEqual([...env.ATELIER_KV.m.keys()].filter((k) => !k.startsWith('fail:')), []);
});

test('owner routes unchanged: with the passcode (and a stale tester cookie) chat, the spend readout, profile, feedback and the Testers roster still work', async () => {
  const { env, L, token } = await closed();
  mockFetch([[/^POST https:\/\/api\.openai\.com\/v1\/chat\/completions$/, () => sseOf(['data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n', 'data: [DONE]\n\n'])]]);
  for (const cookie of [undefined, token]) {
    const who = { pass: 'pw', ...(cookie ? { cookie } : {}) };
    let r = await api(env, 'chat', { method: 'POST', body: { model: 'openai:gpt-6-luna', messages: [{ role: 'user', content: 'hi' }], stream: true, max_tokens: 128000 } }, { ...who, origin: null });
    assert.equal(r.status, 200);
    assert.match(await r.text(), /"content":"hi"/);
    r = await api(env, 'owner/spend', {}, who);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).totalUsd, 0);
    assert.equal((await api(env, 'me', {}, who)).status, 200);
    r = await api(env, 'feedback', { method: 'POST', body: { kind: 'bug', message: 'owner note' }, headers: { 'content-type': 'application/json' } }, { ...who, origin: null });
    assert.equal(r.status, 201, 'the owner can still send (and read) feedback');
    assert.equal((await api(env, 'feedback', {}, who)).status, 200);
    r = await api(env, 'testers', {}, who);
    assert.equal(r.status, 200, 'the roster stays readable, so tester access can be switched back on as it was');
    assert.ok(Array.isArray((await r.json()).testers));
  }
  assert.ok(L.calls.every((m) => m === 'roster' || m === 'ownerSpend'), `${L.calls}`); // never 'session': the cookie isn't looked up
  // the passcode still guards it all: a wrong one is 401, never a tester answer
  const r = await api(env, 'chat', { method: 'POST', body: { model: 'openai:gpt-6-luna', messages: [] } }, { pass: 'nope', cookie: token, origin: null });
  assert.equal(r.status, 401);
});

test('a leftover tester cookie is cleared on the way out of any API answer while access is closed — and kept while it is open', async () => {
  const { env, token } = await closed();
  for (const [path, who] of [['health', { cookie: token }], ['me', { pass: 'pw', cookie: token }], ['chat', { cookie: token }]]) {
    const r = await api(env, path, {}, who);
    assert.ok(cleared(r), path);
  }
  assert.ok(!cleared(await api(env, 'health')), 'no cookie, nothing to clear');
  const { env: on, L } = makeEnv();
  const t = await signIn(L, PROFILE());
  const r = await api(on, 'tester/me', {}, { cookie: t.token });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('set-cookie'), null);
});

test('switching it back on ("1") restores the tester flows exactly: spots, sign-in, the tester router', async () => {
  const { env, L } = makeEnv({ LINKEDIN_CLIENT_ID: 'li', LINKEDIN_CLIENT_SECRET: 'sec' });
  assert.equal(env.TESTERS_ENABLED, '1');
  assert.equal((await api(env, 'li/spots')).status, 200);
  const start = await api(env, 'li/start');
  assert.equal(start.status, 302);
  assert.match(start.headers.get('location'), /^https:\/\/www\.linkedin\.com\/oauth\/v2\/authorization\?/);
  const t = await signIn(L, PROFILE());
  assert.equal((await api(env, 'tester/me', {}, { cookie: t.token })).status, 200);
  const r = await api(env, 'owner/spend', {}, { cookie: t.token });
  assert.deepEqual([r.status, await codeOf(r)], [403, 'owner_only'], 'and still deny by default');
});

test('while access is off the Ledger alarm ends every tester session, so switching back on never revives one', async () => {
  // The Worker and the Durable Object share vars: "redeploying" with a new value flips both (and starts fresh isolates).
  const doEnv = { TESTERS_ENABLED: '1' };
  const { env, L } = makeEnv({ ledger: makeLedger(doEnv) });
  const flip = (on) => { env.TESTERS_ENABLED = doEnv.TESTERS_ENABLED = on ? '1' : '0'; resetTesterCaches(); };
  const rows = () => L.shim.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
  const DAY = 86_400_000;
  let now = Date.now();
  L.ledger.clock = () => now;
  const a = await signIn(L, PROFILE()), b = await signIn(L, PROFILE());
  const me = (t) => api(env, 'tester/me', {}, { cookie: t.token });
  // open: the alarm keeps live sessions
  await L.ledger.alarm();
  assert.equal(rows(), 2);
  assert.equal((await me(a)).status, 200);

  flip(false);
  for (const t of [a, b]) assert.deepEqual([(await me(t)).status, await codeOf(await me(t))], [410, 'tester_closed']);
  assert.equal((await api(env, 'li/logout', { method: 'POST', body: '' }, { cookie: b.token })).status, 410);
  now += 10 * 60_000; // the next tick, long before the 30-day session expiry
  await L.ledger.alarm();
  assert.equal(rows(), 0, 'every session is gone');
  assert.ok(L.shim.alarm() > Date.now(), 'the alarm still reschedules');
  const roster = L.ledger.roster().testers;
  assert.deepEqual(roster.map((t) => [t.sub, t.revoked_at ?? null]).sort(), [[a.sub, null], [b.sub, null]].sort(), 'the testers stay on the roster, not revoked');

  // back on within the 30 days: the old cookies are signed out (sign in again), even with the Ledger unpaused
  flip(true);
  now += 20 * DAY;
  L.ledger.setConfig({ paused: false });
  for (const t of [a, b]) {
    const r = await me(t);
    assert.deepEqual([r.status, await codeOf(r)], [401, 'tester_signin']);
    assert.ok(cleared(r));
  }
  // a fresh sign-in works again, and the open alarm leaves it alone
  const c = await signIn(L, a.profile);
  await L.ledger.alarm();
  assert.equal(rows(), 1);
  assert.equal((await me(c)).status, 200);
});

// ── the app hides every tester surface ──

test('client: tester UI is hidden unless /api/health says testers: true (off until it does)', () => {
  // the CSS switch
  assert.match(STUDIO, /body:not\(\.testers-open\) \.tester-ui, body\.testers-open \.tester-closed \{ display: none !important; \}/);
  // every tester surface carries .tester-ui: the sign-in button and spots, the allowance pill, feedback (sidebar and the
  // phone's studio menu), the owner's Testers panel and the feedback inbox
  for (const re of [
    /<a class="li-btn tester-ui" id="liBtn" href="\/api\/li\/start">/,
    /<p class="ob-spots tester-ui" id="spotsLine">/,
    /<p class="allowance tester-ui" id="allowance" hidden><\/p>/,
    /<button class="nav-item nav-feedback tester-ui" id="feedbackBtn"/,
    /<button type="button" class="studio-menu-item tester-ui" data-studio-target="feedback">/,
    /<section class="field-group needs-owner tester-ui">\s*<h4>Testers<\/h4>/,
  ]) assert.match(HTML, re);
  assert.match(APP, /<section class="field-group owner-only tester-ui" id="feedbackSection">/);
  assert.match(HTML, /<p class="ob-spots tester-closed" id="closedLine">Tester sign-in is closed right now\.<\/p>/);
  // the flag: from /api/health only, off by default, kept for the next start
  assert.match(APP, /let testersOpen = LS\.get\('testersOpen', false\) === true;/);
  assert.match(APP, /const syncTesters = \(\) => document\.body\.classList\.toggle\('testers-open', testersOpen\);\nsyncTesters\(\);/);
  assert.match(APP, /const open = h\.testers === true;/);
  // closed: the passcode form opens, no spots are fetched, the Testers roster isn't loaded, LinkedIn notes read “closed”
  assert.match(APP, /if \(reason === 'rejected' \|\| LS\.get\('owner', false\) \|\| !testersOpen\) \$\('#ownerEntry'\)\.open = true;/);
  assert.match(APP, /if \(testersOpen\) loadSpots\(\);/);
  assert.match(APP, /if \(S\.settings\.passcode && !S\.tester\) \{ loadSpending\(\); if \(testersOpen\) loadTesters\(\); \}/);
  assert.match(APP, /const note = SIGNIN_NOTES\[!testersOpen && TESTER_NOTES\.has\(reason\) \? 'closed' : reason\] \|\| '';/);
  // a tester device finds out at boot (410 → signed out, “closed”) and mid-session (tester_closed on any call)
  assert.match(APP, /if \(r\.status === 410\) return 'closed';/);
  assert.match(APP, /else if \(err\.code === 'tester_closed'\) testerSignedOut\('closed'\);/);
  assert.match(APP, /if \(code === 'tester_signin' \|\| code === 'tester_closed'\) return 'signin';/);
});

test('client: Sign out on a tester device still in tester mode signs it out when the server answers 410 tester_closed', async () => {
  const m = /async function testerSignOut\([\s\S]*?\n\}\n/.exec(APP);
  assert.ok(m, 'app.js defines testerSignOut');
  const run = async (answer) => {
    const seen = { toasts: [], ls: {}, out: [], urls: [] };
    const scope = {
      confirm: () => true, busyBtn: () => () => {},
      fetch: async (url) => { seen.urls.push(url); if (answer === 'offline') throw new TypeError('offline'); return { ok: answer < 300, status: answer }; },
      toast: (msg, o) => seen.toasts.push([msg, o?.error === true]), LS: { set: (k, v) => { seen.ls[k] = v; } }, testerSignedOut: (why) => seen.out.push(why),
    };
    await new Function(...Object.keys(scope), `${m[0]}\nreturn testerSignOut;`)(...Object.values(scope))({});
    return seen;
  };
  for (const [answer, why] of [[204, 'signedout'], [401, 'signedout'], [410, 'closed']]) {
    const s = await run(answer);
    assert.deepEqual(s.urls, ['/api/li/logout'], String(answer));
    assert.deepEqual([s.out, s.ls, s.toasts], [[why], { meTester: null }, []], String(answer));
  }
  for (const answer of ['offline', 500, 403]) {
    const s = await run(answer);
    assert.deepEqual(s.out, [], `${answer}: still signed in`);
    assert.equal(s.toasts.length, 1);
    assert.equal(s.toasts[0][1], true, 'an error toast');
  }
});

test('client: the hidden surfaces really disappear — a tiny cascade check of the switch against each marked element', () => {
  // which rule wins for an element, given the body's classes (the only two rules that mention the switch)
  const hidden = (bodyClasses, el) => (!bodyClasses.includes('testers-open') && el.includes('tester-ui')) || (bodyClasses.includes('testers-open') && el.includes('tester-closed'));
  const marked = [...HTML.matchAll(/class="([^"]*\btester-(?:ui|closed)\b[^"]*)"/g)].map((m) => m[1].split(/\s+/));
  assert.ok(marked.length >= 7, `${marked.length} marked elements`);
  for (const el of marked) {
    assert.equal(hidden(['owner'], el), el.includes('tester-ui'), el.join(' '));
    assert.equal(hidden(['owner', 'testers-open'], el), el.includes('tester-closed'), el.join(' '));
  }
});

test('review fixture mirrors the switch: closed unless REVIEW_TESTER, and the chat log shows each request’s max_tokens', () => {
  assert.match(FIXTURE, /const testersOpen = Boolean\(fixtureTester\);/);
  assert.match(FIXTURE, /if \(!testersOpen && \(url\.pathname\.startsWith\('\/api\/li\/'\) \|\| url\.pathname\.startsWith\('\/api\/tester\/'\)\)\) return testersClosed\(res\);/);
  assert.match(FIXTURE, /JSON\.stringify\(\{ testers: testersOpen, server:/);
  assert.match(FIXTURE, /console\.log\('chat', JSON\.stringify\(\{ model: body\.model, max_tokens: body\.max_tokens, reasoning_effort: body\.reasoning_effort \?\? null/);
  assert.doesNotMatch(FIXTURE, /owner\/limits|cleanLimits|capRefusal|SpendError/);
});
