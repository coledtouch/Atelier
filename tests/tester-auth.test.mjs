import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { worker, makeEnv, mockFetch, restoreFetch, upstream, reply, api, signIn, PROFILE, resetTesterCaches, sha256 } from './tester-env.mjs';

const { LI_AUTHORIZE, LI_TOKEN, LI_USERINFO } = await import('../src/tester/auth.js');
const b64url = (s) => Buffer.from(s).toString('base64url');
const jwt = (claims) => [JSON.stringify({ alg: 'RS256', kid: 'k' }), JSON.stringify(claims), 'signature'].map(b64url).join('.');
const PERSON = { sub: 'liSub_123-x', name: 'Ada Lovelace', email: 'ada@example.com', picture: 'https://media.licdn.com/dms/image/ada.jpg' };

let logs = [];
const realWarn = console.warn, realError = console.error;
beforeEach(() => {
  resetTesterCaches();
  logs = [];
  console.warn = (...a) => logs.push(a.map(String).join(' '));
  console.error = (...a) => logs.push(a.map(String).join(' '));
});
afterEach(() => {
  restoreFetch();
  console.warn = realWarn; console.error = realError;
  for (const l of logs) for (const secret of ['li-secret-xyz', 'AT-secret', 'code-xyz']) assert.ok(!l.includes(secret), `secret in log: ${l}`);
});

const get = (env, path, headers = {}, base = 'https://atelier.ciprari.ai') => worker.fetch(new Request(`${base}/api/${path}`, { headers }), env);
const setCookies = (res) => res.headers.getSetCookie();
const cookieNamed = (res, name) => setCookies(res).find((c) => c.startsWith(`${name}=`));

// /api/li/start → {state, nonce, stateCookie}
async function start(env, base) {
  const res = await get(env, 'li/start', {}, base);
  assert.equal(res.status, 302);
  const u = new URL(res.headers.get('location'));
  return { res, u, state: u.searchParams.get('state'), nonce: u.searchParams.get('nonce'), stateCookie: `__Host-atelier_li=${u.searchParams.get('state')}` };
}
function linkedIn({ nonce, sub = PERSON.sub, aud = 'li-client', tokenStatus = 200, userinfo = PERSON, exp = Math.floor(Date.now() / 1000) + 3600 } = {}) {
  mockFetch([
    [/^POST https:\/\/www\.linkedin\.com\/oauth\/v2\/accessToken$/, () => reply(tokenStatus, tokenStatus === 200
      ? { access_token: 'AT-secret', expires_in: 3600, scope: 'openid,profile,email', token_type: 'Bearer', id_token: jwt({ iss: 'https://www.linkedin.com/oauth', aud, sub, nonce, exp, iat: exp - 3600 }) }
      : { error: 'invalid_request', error_description: 'bad code' })],
    [/^GET https:\/\/api\.linkedin\.com\/v2\/userinfo$/, () => reply(200, userinfo)],
  ]);
}
const callback = (env, state, cookie, extra = 'code=code-xyz') => get(env, `li/callback?${extra}&state=${encodeURIComponent(state)}`, cookie ? { cookie } : {});

test('li/start sends the browser to LinkedIn with openid profile email only, and a single-use state bound to it', async () => {
  const { env, L } = makeEnv();
  const { res, u, state, nonce } = await start(env);
  assert.equal(u.origin + u.pathname, LI_AUTHORIZE);
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('client_id'), 'li-client');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://atelier.ciprari.ai/api/li/callback');
  assert.equal(u.searchParams.get('scope'), 'openid profile email');
  assert.ok(u.search.includes('scope=openid%20profile%20email'), 'spaces encoded as %20');
  assert.ok(!res.headers.get('location').includes('w_member_social'));
  assert.match(state, /^[\w-]{43}$/);
  assert.match(nonce, /^[\w-]{43}$/);
  assert.notEqual(state, nonce);
  assert.equal(L.shim.db.prepare('SELECT nonce FROM oauth_state WHERE state = ?').get(state).nonce, nonce);
  const sc = cookieNamed(res, '__Host-atelier_li');
  assert.equal(sc, `__Host-atelier_li=${state}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  // development callback, and no secrets → straight back with an error
  const dev = await start(env, 'http://127.0.0.1:8787');
  assert.equal(dev.u.searchParams.get('redirect_uri'), 'http://127.0.0.1:8787/api/li/callback');
  const none = await get(makeEnv({ LINKEDIN_CLIENT_SECRET: undefined }).env, 'li/start');
  assert.equal(none.headers.get('location'), '/?tester=error');
});

test('callback: admitted → session cookie (HttpOnly, Secure, SameSite=Strict, 30 days) and /?tester=welcome', async () => {
  const { env, L } = makeEnv();
  L.ledger.setConfig({ paused: false });
  const s = await start(env);
  linkedIn({ nonce: s.nonce });
  const res = await callback(env, s.state, s.stateCookie);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/?tester=welcome');
  const session = cookieNamed(res, '__Host-atelier_tester');
  assert.match(session, /^__Host-atelier_tester=[\w-]{43}; Path=\/; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict$/);
  assert.ok(!/domain=/i.test(session));
  assert.equal(cookieNamed(res, '__Host-atelier_li'), '__Host-atelier_li=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax', 'state cookie cleared');
  // the token exchange and userinfo calls
  const [tok, info] = upstream.calls;
  assert.equal(tok.url, LI_TOKEN);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(tok.body)), { grant_type: 'authorization_code', code: 'code-xyz', client_id: 'li-client', client_secret: 'li-secret-xyz', redirect_uri: 'https://atelier.ciprari.ai/api/li/callback' });
  assert.equal(info.url, LI_USERINFO);
  assert.equal(info.headers.get('authorization'), 'Bearer AT-secret');
  // only sha256(token) is stored; the LinkedIn access token is not stored anywhere
  const token = session.split(';')[0].split('=')[1];
  const rows = L.shim.db.prepare('SELECT * FROM sessions').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].token_hash, await sha256(token));
  assert.ok(!JSON.stringify(L.shim.db.prepare("SELECT * FROM testers").all()).includes('AT-secret'));
  const t = L.ledger.roster().testers[0];
  assert.deepEqual([t.sub, t.name, t.email, t.picture], [PERSON.sub, PERSON.name, PERSON.email, PERSON.picture]);
  // the cookie now signs requests in as that tester
  restoreFetch();
  const me = await api(env, 'tester/me', {}, { cookie: token });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).name, 'Ada Lovelace');
});

test('callback: LinkedIn’s real ID token has no nonce claim, and that still signs in (state guards the flow)', async () => {
  const { env, L } = makeEnv();
  L.ledger.setConfig({ paused: false });
  const s = await start(env);
  linkedIn({ nonce: undefined });
  const res = await callback(env, s.state, s.stateCookie);
  assert.equal(res.headers.get('location'), '/?tester=welcome');
  assert.ok(cookieNamed(res, '__Host-atelier_tester'));
  // paused (as live today): no nonce → paused, and the owner sees this sub as last refused
  const p = makeEnv();
  const s2 = await start(p.env);
  linkedIn({ nonce: undefined });
  assert.equal((await callback(p.env, s2.state, s2.stateCookie)).headers.get('location'), '/?tester=paused');
  assert.equal(p.L.ledger.roster().lastRefused.sub, PERSON.sub);
});

test('callback: state is single-use, must match the browser that started, and a wrong state never reaches LinkedIn', async () => {
  const { env, L } = makeEnv();
  L.ledger.setConfig({ paused: false });
  const s = await start(env);
  linkedIn({ nonce: s.nonce });
  assert.equal((await callback(env, s.state, s.stateCookie)).headers.get('location'), '/?tester=welcome');
  const calls = upstream.calls.length;
  const again = await callback(env, s.state, s.stateCookie);
  assert.equal(again.headers.get('location'), '/?tester=error', 'replayed state');
  assert.equal(cookieNamed(again, '__Host-atelier_tester'), undefined);
  for (const st of ['', 'short', 'x'.repeat(43), `${s.state}A`]) assert.equal((await callback(env, st, `__Host-atelier_li=${st}`)).headers.get('location'), '/?tester=error');
  const s2 = await start(env);
  assert.equal((await callback(env, s2.state, null)).headers.get('location'), '/?tester=error', 'no state cookie');
  const s3 = await start(env);
  assert.equal((await callback(env, s3.state, s2.stateCookie)).headers.get('location'), '/?tester=error', 'another browser’s state');
  assert.equal(upstream.calls.length, calls, 'nothing reached LinkedIn');
  assert.equal(L.shim.db.prepare('SELECT COUNT(*) AS n FROM oauth_state WHERE state IN (?, ?)').get(s2.state, s3.state).n, 0, 'both consumed');
});

test('callback outcomes: full, paused, revoked, denied and error', async () => {
  const run = async (env, opts = {}, extra) => {
    const s = await start(env);
    linkedIn({ nonce: s.nonce, ...opts });
    const res = await callback(env, s.state, s.stateCookie, extra);
    assert.equal(cookieNamed(res, '__Host-atelier_tester'), undefined, 'no session unless welcome');
    return res.headers.get('location');
  };
  const paused = makeEnv(); // a fresh Ledger starts paused
  assert.equal(await run(paused.env), '/?tester=paused');
  assert.equal(paused.L.ledger.roster().lastRefused.sub, PERSON.sub, 'the owner can find this sub');
  const full = makeEnv();
  full.L.ledger.setConfig({ paused: false, cap: 1 });
  full.L.ledger.admit(PROFILE(), null);
  assert.equal(await run(full.env), '/?tester=full');
  const revoked = makeEnv();
  revoked.L.ledger.setConfig({ paused: false });
  revoked.L.ledger.admit(PERSON, null);
  revoked.L.ledger.revoke(PERSON.sub);
  assert.equal(await run(revoked.env), '/?tester=revoked');
  const { env, L } = makeEnv();
  L.ledger.setConfig({ paused: false });
  assert.equal(await run(env, {}, 'error=user_cancelled_login&error_description=x'), '/?tester=denied');
  assert.equal(await run(env, {}, 'error=server_error'), '/?tester=error');
  assert.equal(await run(env, {}, 'nocode=1'), '/?tester=error');
  assert.equal(await run(env, { tokenStatus: 400 }), '/?tester=error');
  assert.equal(await run(env, { nonce: 'someone-elses-nonce' }), '/?tester=error', 'nonce mismatch');
  assert.ok(logs.some((l) => /id token rejected: nonce/.test(l)), 'the log names the failed claim');
  assert.equal(await run(env, { aud: 'another-app' }), '/?tester=error', 'audience mismatch');
  assert.equal(await run(env, { exp: Math.floor(Date.now() / 1000) - 10 }), '/?tester=error', 'expired id token');
  assert.equal(await run(env, { userinfo: { ...PERSON, sub: 'other' } }), '/?tester=error', 'userinfo is someone else');
  assert.equal(L.ledger.roster().testers.length, 0);
  assert.ok(logs.some((l) => /linkedin sign-in failed/.test(l)));
});

test('identity order: the passcode wins over a tester cookie; a cookie alone is a tester; an ended session asks to sign in again', async () => {
  const { env, L } = makeEnv();
  env.ATELIER_KV.m.set('me', JSON.stringify({ bio: 'owner bio' }));
  const { token } = await signIn(L, PROFILE());
  // owner + cookie → owner, without even looking the cookie up
  L.calls.length = 0;
  let r = await api(env, 'me', {}, { pass: 'pw', cookie: token });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { bio: 'owner bio' });
  assert.deepEqual(L.calls, []);
  r = await api(env, 'tester/me', {}, { pass: 'pw', cookie: token });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).code, 'tester_signin');
  // cookie only → tester: owner routes refused
  r = await api(env, 'me', {}, { cookie: token });
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), { error: 'That part of Atelier is only for its owner.', code: 'owner_only' });
  // an unknown / ended cookie → 401 tester_signin and the cookie is cleared (never a passcode message)
  for (const bad of ['A'.repeat(43), 'not-a-token']) {
    r = await api(env, 'chat', { method: 'POST', body: {} }, { cookie: bad });
    assert.equal(r.status, 401);
    const j = await r.json();
    assert.equal(j.code, 'tester_signin');
    assert.ok(!/passcode/i.test(j.error));
    assert.match(r.headers.get('set-cookie'), /^__Host-atelier_tester=; Path=\/; Max-Age=0/);
  }
  // …unless the request carries a passcode: then the owner path answers exactly as before
  r = await api(env, 'chat', { method: 'POST', body: { model: 'openai:gpt-6-luna', messages: [] } }, { pass: 'wrong', cookie: 'A'.repeat(43) });
  assert.equal(r.status, 401);
  assert.match((await r.json()).error, /Wrong passcode/);
  // nobody at all → unchanged
  r = await api(env, 'chat', { method: 'POST', body: { model: 'openai:gpt-6-luna', messages: [] } });
  assert.equal(r.status, 401);
  assert.match((await r.json()).error, /Enter your passcode/);
});

test('the identity cache lasts 60 s per isolate, and an owner revoke clears it at once', async () => {
  const { env, L } = makeEnv();
  const { token, sub } = await signIn(L, PROFILE());
  assert.equal((await api(env, 'tester/me', {}, { cookie: token })).status, 200);
  L.calls.length = 0;
  assert.equal((await api(env, 'tester/me', {}, { cookie: token })).status, 200);
  assert.ok(!L.calls.includes('session'), 'cached');
  const r = await api(env, 'testers/revoke', { method: 'POST', body: { sub } }, { pass: 'pw' });
  assert.equal(r.status, 200);
  const after = await api(env, 'tester/me', {}, { cookie: token });
  assert.equal(after.status, 401);
  assert.equal((await after.json()).code, 'tester_signin');
});

test('a flood of made-up cookies never pushes a live tester out of the identity cache', async () => {
  const { env, L } = makeEnv();
  const { token } = await signIn(L, PROFILE());
  assert.equal((await api(env, 'tester/me', {}, { cookie: token })).status, 200);
  for (let i = 0; i < 1100; i++) {
    const fake = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
    assert.equal((await api(env, 'tester/me', {}, { cookie: fake })).status, 401);
  }
  L.calls.length = 0;
  assert.equal((await api(env, 'tester/me', {}, { cookie: token })).status, 200);
  assert.ok(!L.calls.includes('session'), 'the live tester is still cached');
});

test('sign-in routes: a per-IP throttle (LI_LIMIT) ahead of the Ledger, and a bounded table of states in flight', async () => {
  const keys = [];
  let allow = true;
  const LI_LIMIT = { limit: async ({ key }) => { keys.push(key); return { success: allow }; } };
  const { env, L } = makeEnv({ LI_LIMIT });
  await start(env);
  assert.deepEqual(keys, ['unknown']);
  allow = false;
  L.calls.length = 0;
  let r = await get(env, 'li/start', { 'cf-connecting-ip': '203.0.113.9' });
  assert.equal(r.headers.get('location'), '/?tester=error');
  r = await callback(env, 'a'.repeat(43), '__Host-atelier_li=' + 'a'.repeat(43));
  assert.equal(r.headers.get('location'), '/?tester=error');
  assert.deepEqual(L.calls, [], 'throttled before any Ledger call');
  assert.equal(keys.at(-2), '203.0.113.9');
  // without the binding (tests, dev) nothing is throttled; the Ledger caps the states in flight at 2,000
  const plain = makeEnv();
  for (let i = 0; i < 2000; i++) assert.equal(plain.L.ledger.putState(`s${i}`, `n${i}`), true);
  r = await get(plain.env, 'li/start');
  assert.equal(r.headers.get('location'), '/?tester=error');
  assert.equal(plain.L.shim.db.prepare('SELECT COUNT(*) AS n FROM oauth_state').get().n, 2000);
  assert.match(JSON.stringify(plain.L.shim.db.prepare('EXPLAIN QUERY PLAN DELETE FROM oauth_state WHERE exp <= 1').all()), /oauth_state_exp/, 'expiry uses the index');
});

test('logout needs the app Origin, ends the session and clears the cookie', async () => {
  const { env, L } = makeEnv();
  const { token } = await signIn(L, PROFILE());
  let r = await api(env, 'li/logout', { method: 'POST' }, { cookie: token, origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).code, 'tester_origin');
  r = await api(env, 'li/logout', { method: 'POST' }, { cookie: token, origin: null });
  assert.equal(r.status, 403);
  assert.equal((await api(env, 'tester/me', {}, { cookie: token })).status, 200, 'still signed in');
  r = await api(env, 'li/logout', { method: 'POST' }, { cookie: token });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('set-cookie'), '__Host-atelier_tester=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict');
  assert.equal(L.shim.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  assert.equal((await api(env, 'tester/me', {}, { cookie: token })).status, 401);
  r = await api(env, 'li/logout', { method: 'POST' }, { origin: 'http://127.0.0.1:8787' });
  assert.equal(r.status, 204, 'dev origin, no cookie: still fine');
  assert.equal((await api(env, 'li/logout')).status, 404, 'GET is not a logout');
});

test('li/spots: public count with no personal data, cached for 60 s', async () => {
  const { env, L } = makeEnv();
  L.ledger.setConfig({ cap: 25 });
  L.ledger.setConfig({ paused: false });
  L.ledger.admit(PROFILE(), null);
  L.ledger.setConfig({ paused: true });
  let r = await get(env, 'li/spots');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await r.json(), { spotsLeft: 24, cap: 25, paused: true });
  L.calls.length = 0;
  L.ledger.admit({ ...PROFILE(), sub: 'x2' }, null);
  r = await get(env, 'li/spots');
  assert.deepEqual(await r.json(), { spotsLeft: 24, cap: 25, paused: true }, 'cached');
  assert.deepEqual(L.calls, []);
  resetTesterCaches();
  assert.deepEqual(await (await get(makeEnv({ ledger: null }).env, 'li/spots')).json(), { spotsLeft: 0, cap: 0, paused: true });
});

test('owner endpoints: roster, revoke, restore and validated config — passcode only, never for testers', async () => {
  const { env, L } = makeEnv();
  const a = await signIn(L, PROFILE());
  let r = await api(env, 'testers');
  assert.equal(r.status, 401);
  r = await api(env, 'testers', {}, { cookie: a.token });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).code, 'owner_only');
  for (const p of ['testers/revoke', 'testers/config']) {
    r = await api(env, p, { method: 'POST', body: { sub: a.sub, paused: false } }, { cookie: a.token });
    assert.equal((await r.json()).code, 'owner_only', p);
  }
  r = await api(env, 'testers', {}, { pass: 'pw' });
  assert.equal(r.status, 200);
  const roster = await r.json();
  assert.deepEqual(Object.keys(roster).sort(), ['config', 'lastRefused', 'pool', 'testers']);
  assert.deepEqual(Object.keys(roster.config).sort(), ['cap', 'day_limit', 'month_limit', 'paused', 'pool_limit', 'preview_subs']);
  assert.equal(roster.testers[0].sub, a.sub);
  r = await api(env, 'testers/revoke', { method: 'POST', body: { sub: a.sub } }, { pass: 'pw' });
  assert.ok((await r.json()).testers[0].revoked_at > 0);
  r = await api(env, 'testers/restore', { method: 'POST', body: { sub: a.sub } }, { pass: 'pw' });
  assert.equal((await r.json()).testers[0].revoked_at, null);
  assert.equal((await api(env, 'testers/revoke', { method: 'POST', body: { sub: 'nobody' } }, { pass: 'pw' })).status, 404);
  assert.equal((await api(env, 'testers/revoke', { method: 'POST', body: {} }, { pass: 'pw' })).status, 400);
  r = await api(env, 'testers/config', { method: 'POST', body: { pool_limit: 1_000_000_001 } }, { pass: 'pw' });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).code, 'bad_config');
  r = await api(env, 'testers/config', { method: 'POST', body: { paused: true, preview_subs: [a.sub], cap: 30 } }, { pass: 'pw' });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).config, { cap: 30, paused: true, day_limit: 1_000_000, month_limit: 10_000_000, pool_limit: 100_000_000, preview_subs: [a.sub] });
  assert.equal((await api(env, 'testers/nope', { method: 'POST', body: {} }, { pass: 'pw' })).status, 404);
  assert.equal((await api(makeEnv({ ledger: null }).env, 'testers', {}, { pass: 'pw' })).status, 503);
});
