import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// tools.js (waitUntil) and worker.js (the Relay Durable Object) import `cloudflare:workers`; stub it so both load in
// Node. The stub must be registered before either module is imported, hence the dynamic imports below.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export class DurableObject {} export const waitUntil = () => {};', shortCircuit: true };
    return next(specifier, context);
  },
});
const {
  CANVA_SCOPES, CANVA_TIMING, CanvaError, pkceVerifier, pkceChallenge, canvaAuthUrl, canvaTakeState, canvaCompleteAuth,
  removeCanvaAccount, canvaSendImage, parseImageDataUrl, checkPublicUrl, toolStatus, toolList, runTool,
  CANVA_EXPORT_HOSTS, CANVA_FILE_LIMITS, checkCanvaFileUrl, canvaFetchFile,
} = await import('../src/tools.js');
const worker = (await import('../src/worker.js')).default;

// ── fakes ──
function fakeKV(init = {}) {
  const m = new Map();
  const kv = {
    m,
    async get(k, type) {
      const e = m.get(k);
      if (!e || (e.exp && e.exp <= Date.now())) return null;
      return type === 'json' ? JSON.parse(e.value) : e.value;
    },
    async put(k, v, opts = {}) {
      if (opts.expirationTtl != null && opts.expirationTtl < 60) throw new Error('KV: expirationTtl must be at least 60');
      m.set(k, { value: String(v), ttl: opts.expirationTtl, exp: opts.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : 0 });
    },
    async delete(k) { m.delete(k); },
  };
  for (const [k, v] of Object.entries(init)) m.set(k, { value: typeof v === 'string' ? v : JSON.stringify(v) });
  return kv;
}
const ACCOUNT = { id: 'uAbc123', label: 'Jane Doe', team: 'tXyz', refresh: 'r1', scope: CANVA_SCOPES, connectedAt: 1 };
const makeEnv = ({ accounts = [ACCOUNT], access, secrets = true, extra = {} } = {}) => ({
  APP_PASSCODE: 'pw',
  ...(secrets ? { CANVA_CLIENT_ID: 'OC-client', CANVA_CLIENT_SECRET: 'cnvca-secret' } : {}),
  ATELIER_KV: fakeKV({ ...(accounts ? { canva_accounts: accounts } : {}), ...(access ? { [`canva_access:${ACCOUNT.id}`]: access } : {}), ...extra }),
});
const reply = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// Routes `METHOD url` to handlers; records every call.
let calls = [];
const realFetch = globalThis.fetch;
function mockFetch(routes) {
  globalThis.fetch = async (input, init = {}) => {
    const call = { url: String(input), method: init.method || 'GET', headers: new Headers(init.headers), body: init.body, redirect: init.redirect };
    calls.push(call);
    for (const [pattern, handler] of routes) if (pattern.test(`${call.method} ${call.url}`)) return handler(call);
    throw new Error(`unmocked fetch ${call.method} ${call.url}`);
  };
}
const tokenCalls = () => calls.filter((c) => c.url.endsWith('/oauth/token'));
const form = (c) => Object.fromEntries(new URLSearchParams(c.body));
const DESIGN = { id: 'DAF1', title: 'Poster', urls: { edit_url: 'https://www.canva.com/design/DAF1/edit', view_url: 'https://www.canva.com/design/DAF1/view' }, thumbnail: { url: 'https://thumb' }, updated_at: 1700000000, page_count: 2 };
const refreshOk = (n = 2) => [/POST .*\/oauth\/token$/, () => reply(200, { access_token: `a${n}`, refresh_token: `r${n}`, token_type: 'Bearer', expires_in: 14400, scope: CANVA_SCOPES })];

// A tiny but valid-looking PNG (signature + IHDR start).
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 4]);
const pngDataUrl = (mime = 'image/png') => `data:${mime};base64,${Buffer.from(PNG).toString('base64')}`;

const TIMING = { ...CANVA_TIMING };
const FILE_LIMITS = { ...CANVA_FILE_LIMITS };
beforeEach(() => { calls = []; Object.assign(CANVA_TIMING, { pollFirst: 5, pollMax: 10, pollTotal: 400, lockPoll: 5, lockWait: 300 }); });
afterEach(() => { globalThis.fetch = realFetch; Object.assign(CANVA_TIMING, TIMING); Object.assign(CANVA_FILE_LIMITS, FILE_LIMITS); });

// ── PKCE + authorize URL ──
test('PKCE challenge matches the RFC 7636 test vector', async () => {
  assert.equal(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});
test('PKCE verifiers are 43-128 unreserved characters and unique', () => {
  const a = pkceVerifier();
  assert.match(a, /^[A-Za-z0-9._~-]{43,128}$/);
  assert.notEqual(a, pkceVerifier());
});
test('authorize URL carries every required parameter and stores a single-use state', async () => {
  const env = makeEnv();
  const u = new URL(await canvaAuthUrl(env, 'https://atelier.test/api/oauth/canva/callback'));
  assert.equal(u.origin + u.pathname, 'https://www.canva.com/api/oauth/authorize');
  const p = u.searchParams;
  assert.equal(p.get('client_id'), 'OC-client');
  assert.equal(p.get('redirect_uri'), 'https://atelier.test/api/oauth/canva/callback');
  assert.equal(p.get('response_type'), 'code');
  assert.equal(p.get('scope'), 'design:meta:read design:content:read design:content:write asset:read asset:write profile:read');
  assert.ok(!u.search.includes('+'), 'spaces are encoded as %20');
  assert.equal(p.get('code_challenge_method'), 'S256');
  const state = p.get('state');
  assert.match(state, /^[A-Za-z0-9_-]{43}$/);
  const stored = env.ATELIER_KV.m.get(`oauth:canva:${state}`);
  assert.equal(stored.ttl, 600);
  const { verifier } = JSON.parse(stored.value);
  assert.equal(p.get('code_challenge'), await pkceChallenge(verifier));
  assert.ok(!u.search.includes(verifier), 'the verifier never leaves the server');
  assert.deepEqual(await canvaTakeState(env, state), { verifier });
  assert.equal(await canvaTakeState(env, state), null, 'state is single-use');
  assert.equal(await canvaTakeState(env, 'bad:state'), null);
});
test('authorize URL needs both Canva secrets', async () => {
  await assert.rejects(canvaAuthUrl(makeEnv({ secrets: false }), 'https://x/cb'), (e) => e instanceof CanvaError && e.status === 400 && /CANVA_CLIENT_ID/.test(e.message));
});

// ── status + tool list ──
test('toolStatus reports the canva flags without leaking tokens', async () => {
  let s = await toolStatus(makeEnv({ secrets: false }));
  assert.equal(s.canva, false); assert.equal(s.canvaConfigured, false); assert.deepEqual(s.canvaAccounts, []);
  s = await toolStatus(makeEnv({ accounts: [] }));
  assert.equal(s.canva, false); assert.equal(s.canvaConfigured, true); assert.deepEqual(s.canvaAccounts, []);
  s = await toolStatus(makeEnv());
  assert.equal(s.canva, true); assert.equal(s.canvaConfigured, true); assert.deepEqual(s.canvaAccounts, [{ id: 'uAbc123', label: 'Jane Doe' }]);
  const { list, services } = await toolList(makeEnv());
  assert.ok(!JSON.stringify({ list, services }).includes('r1'));
  const canva = Object.fromEntries(list.filter((t) => t['x-service'] === 'canva').map((t) => [t.function.name, t['x-write']]));
  assert.deepEqual(canva, { canva_designs: false, canva_design: false, canva_export: false, canva_create_design: true, canva_upload_image: true });
  assert.match(list.find((t) => t.function.name === 'canva_designs').function.description, /Connected Canva accounts: Jane Doe/);
});

// ── token refresh ──
test('refresh rotates the stored refresh token and caches the access token', async () => {
  const env = makeEnv();
  mockFetch([refreshOk(2), [/GET .*\/v1\/designs\?/, () => reply(200, { items: [DESIGN] })]]);
  const out = await runTool(env, 'canva_designs', { query: 'poster' });
  assert.equal(out.ok, true, out.error);
  assert.deepEqual(out.result[0], { account: 'Jane Doe', id: 'DAF1', title: 'Poster', edit_url: DESIGN.urls.edit_url, view_url: DESIGN.urls.view_url, thumbnail: 'https://thumb', updated: '2023-11-14T22:13:20.000Z' });
  const [tc] = tokenCalls();
  assert.equal(tc.headers.get('authorization'), `Basic ${btoa('OC-client:cnvca-secret')}`);
  assert.equal(tc.headers.get('content-type'), 'application/x-www-form-urlencoded');
  assert.deepEqual(form(tc), { grant_type: 'refresh_token', refresh_token: 'r1' });
  const api = calls.find((c) => c.url.includes('/v1/designs?'));
  assert.equal(api.headers.get('authorization'), 'Bearer a2');
  assert.equal(new URL(api.url).searchParams.get('query'), 'poster');
  assert.equal((await env.ATELIER_KV.get('canva_accounts', 'json'))[0].refresh, 'r2');
  assert.equal(env.ATELIER_KV.m.get('canva_access:uAbc123').value, 'a2');
  assert.equal(env.ATELIER_KV.m.get('canva_access:uAbc123').ttl, 14340);
  assert.equal(env.ATELIER_KV.m.has('canva_lock:uAbc123'), false, 'lock released');
  await runTool(env, 'canva_designs', {});
  assert.equal(tokenCalls().length, 1, 'the cached access token is reused');
});
test('concurrent calls share one refresh (the single-use token is spent once)', async () => {
  const env = makeEnv();
  mockFetch([[/POST .*\/oauth\/token$/, async () => { await new Promise((r) => setTimeout(r, 20)); return refreshOk(2)[1](); }],
    [/GET .*\/v1\/designs/, () => reply(200, { items: [DESIGN] })]]);
  const outs = await Promise.all([runTool(env, 'canva_designs', {}), runTool(env, 'canva_design', { design_id: 'DAF1' }), runTool(env, 'canva_designs', { query: 'x' })]);
  for (const o of outs) assert.equal(o.ok, true, o.error);
  assert.equal(tokenCalls().length, 1);
  assert.equal((await env.ATELIER_KV.get('canva_accounts', 'json'))[0].refresh, 'r2');
});
test('a refresh already running in another isolate is waited for, not repeated', async () => {
  const env = makeEnv({ extra: { 'canva_lock:uAbc123': 'someone-else' } });
  mockFetch([refreshOk(9), [/GET .*\/v1\/designs/, () => reply(200, { items: [] })]]);
  setTimeout(() => env.ATELIER_KV.put('canva_access:uAbc123', 'a-other', { expirationTtl: 600 }), 30);
  const out = await runTool(env, 'canva_designs', {});
  assert.equal(out.ok, true, out.error);
  assert.equal(tokenCalls().length, 0);
  assert.equal(calls[0].headers.get('authorization'), 'Bearer a-other');
});
test('a stale access token gets one refresh-and-retry', async () => {
  const env = makeEnv({ access: 'a1' });
  mockFetch([refreshOk(2), [/GET .*\/v1\/designs/, (c) => (c.headers.get('authorization') === 'Bearer a1' ? reply(401, { code: 'invalid_access_token', message: 'Access token is invalid' }) : reply(200, { items: [DESIGN] }))]]);
  const out = await runTool(env, 'canva_designs', {});
  assert.equal(out.ok, true, out.error);
  assert.equal(tokenCalls().length, 1);
  assert.equal((await env.ATELIER_KV.get('canva_accounts', 'json'))[0].refresh, 'r2');
});
test('401 from Canva maps to a reconnect message', async () => {
  const env = makeEnv({ access: 'a1' });
  mockFetch([refreshOk(2), [/GET .*\/v1\/designs/, () => reply(401, { code: 'revoked_access_token', message: 'Access token is revoked' })]]);
  const out = await runTool(env, 'canva_designs', {});
  assert.equal(out.ok, false);
  assert.match(out.error, /Reconnect Canva in Settings → Connections/);
  assert.ok(!/a1|a2|r1|r2/.test(out.error.replace('Canva', '')), 'no tokens in the message');
});
test('an expired or revoked refresh token asks the user to reconnect', async () => {
  const env = makeEnv({ access: undefined });
  mockFetch([[/POST .*\/oauth\/token$/, () => reply(400, { error: 'invalid_grant', error_description: 'Refresh token used twice' })]]);
  const out = await runTool(env, 'canva_designs', {});
  assert.equal(out.ok, false);
  assert.match(out.error, /Reconnect Canva in Settings → Connections/);
  assert.equal(env.ATELIER_KV.m.has('canva_lock:uAbc123'), false);
});
test('a refresh that never finishes (cancelled request) does not hang later callers', async () => {
  const stuck = { ...ACCOUNT, id: 'uStuck', label: 'Stuck' };
  const env = makeEnv({ accounts: [stuck] });
  mockFetch([[/POST .*\/oauth\/token$/, () => new Promise(() => {})]]);
  runTool(env, 'canva_designs', {}); // never settles
  await new Promise((r) => setTimeout(r, 10));
  const t0 = Date.now();
  const out = await runTool(env, 'canva_designs', {});
  assert.equal(out.ok, false);
  assert.match(out.error, /try again/);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(tokenCalls().length, 1, 'the second caller never spends the refresh token');
});
test('a failed KV read never drops stored accounts', async () => {
  const env = makeEnv({ accounts: [ACCOUNT] });
  const realGet = env.ATELIER_KV.get;
  env.ATELIER_KV.get = async (k, t) => { if (k === 'canva_accounts') throw new Error('KV unavailable'); return realGet(k, t); };
  mockFetch([
    [/POST .*\/oauth\/token$/, () => reply(200, { access_token: 'n1', refresh_token: 'nr1', expires_in: 14400 })],
    [/GET .*\/v1\/users\/me$/, () => reply(200, { team_user: { user_id: 'uNew', team_id: 't' } })],
    [/GET .*\/v1\/users\/me\/profile$/, () => reply(200, { profile: { display_name: 'New' } })],
    [/POST .*\/oauth\/revoke$/, () => reply(200, {})],
  ]);
  await assert.rejects(canvaCompleteAuth(env, 'c', 'v'.repeat(64), 'https://x/cb'));
  await assert.rejects(removeCanvaAccount(env, 'uAbc123'));
  env.ATELIER_KV.get = realGet;
  assert.deepEqual((await env.ATELIER_KV.get('canva_accounts', 'json')).map((a) => a.id), ['uAbc123']);
  // With the list unreadable we can't tell whether this Canva user is already stored, and revoking would also
  // revoke that user's consent (killing a stored connection) — so the new sign-in is left unused, not revoked.
  assert.equal(calls.filter((c) => c.url.endsWith('/oauth/revoke')).length, 0);
});
test('a failed reconnect never revokes a stored connection for the same Canva user', async () => {
  const connect = () => canvaCompleteAuth(env, 'c', 'v'.repeat(64), 'https://x/cb');
  const exchange = [/POST .*\/oauth\/token$/, () => reply(200, { access_token: 'n1', refresh_token: 'nr1', expires_in: 14400 })];
  const revokes = () => calls.filter((c) => c.url.endsWith('/oauth/revoke'));
  // /users/me fails: the user is unknown and an account is stored → leave the new token unused.
  let env = makeEnv({ accounts: [ACCOUNT] });
  mockFetch([exchange, [/GET .*\/v1\/users\/me$/, () => reply(500, { code: 'internal_error' })], [/POST .*\/oauth\/revoke$/, () => reply(200, {})]]);
  await assert.rejects(connect());
  assert.equal(revokes().length, 0);
  assert.equal((await env.ATELIER_KV.get('canva_accounts', 'json'))[0].refresh, 'r1');
  // …but with nothing stored the new sign-in is a certain orphan and is revoked.
  env = makeEnv({ accounts: [] });
  calls = [];
  await assert.rejects(connect());
  assert.deepEqual(revokes().map(form), [{ token: 'nr1' }]);
  // The same user reconnects but saving the list fails: their stored connection keeps working.
  env = makeEnv({ accounts: [ACCOUNT] });
  const realPut = env.ATELIER_KV.put;
  env.ATELIER_KV.put = async (k, v, o) => { if (k === 'canva_accounts') throw new Error('KV PUT failed: 429'); return realPut(k, v, o); };
  calls = [];
  mockFetch([exchange, [/GET .*\/v1\/users\/me$/, () => reply(200, { team_user: { user_id: 'uAbc123', team_id: 'tXyz' } })],
    [/GET .*\/v1\/users\/me\/profile$/, () => reply(200, { profile: { display_name: 'Jane Doe' } })], [/POST .*\/oauth\/revoke$/, () => reply(200, {})]]);
  await assert.rejects(connect());
  assert.equal(revokes().length, 0);
  assert.equal((await env.ATELIER_KV.get('canva_accounts', 'json'))[0].refresh, 'r1');
});
test('a failed access-token cache write does not fail (or revoke) a connect', async () => {
  const env = makeEnv({ accounts: [] });
  const realPut = env.ATELIER_KV.put;
  env.ATELIER_KV.put = async (k, v, o) => { if (k.startsWith('canva_access:')) throw new Error('KV PUT failed: 429 Too Many Requests'); return realPut(k, v, o); };
  mockFetch([
    [/POST .*\/oauth\/token$/, () => reply(200, { access_token: 'n1', refresh_token: 'nr1', expires_in: 14400 })],
    [/GET .*\/v1\/users\/me$/, () => reply(200, { team_user: { user_id: 'uNew123', team_id: 't' } })],
    [/GET .*\/v1\/users\/me\/profile$/, () => reply(200, { profile: { display_name: 'New' } })],
    [/POST .*\/oauth\/revoke$/, () => reply(200, {})],
  ]);
  assert.equal(await canvaCompleteAuth(env, 'c', 'v'.repeat(64), 'https://x/cb'), 'New');
  assert.deepEqual((await env.ATELIER_KV.get('canva_accounts', 'json')).map((a) => [a.id, a.refresh]), [['uNew123', 'nr1']]);
  assert.equal(calls.filter((c) => c.url.endsWith('/oauth/revoke')).length, 0);
});
test('unauthorized_user from the token endpoint asks for a reconnect and drops the cached token', async () => {
  const env = makeEnv({ access: 'a1' });
  mockFetch([
    [/POST .*\/oauth\/token$/, () => reply(401, { code: 'unauthorized_user', message: 'The user is not authorized' })],
    [/GET .*\/v1\/designs/, () => reply(401, { code: 'invalid_access_token', message: 'Access token is invalid' })],
  ]);
  const out = await runTool(env, 'canva_designs', {});
  assert.equal(out.ok, false);
  assert.match(out.error, /Reconnect Canva in Settings → Connections/);
  assert.doesNotMatch(out.error, /CANVA_CLIENT_ID/);
  assert.equal(env.ATELIER_KV.m.has('canva_access:uAbc123'), false);
  // A bad client secret is still reported as an app-credentials problem.
  mockFetch([[/POST .*\/oauth\/token$/, () => reply(401, { error: 'invalid_client' })]]);
  assert.match((await runTool(makeEnv(), 'canva_designs', {})).error, /CANVA_CLIENT_ID/);
});
test('write tools still need approval', async () => {
  const out = await runTool(makeEnv(), 'canva_create_design', { title: 'x', design_type: 'doc' });
  assert.deepEqual(out, { ok: false, error: 'This action needs the user\'s approval in the app.' });
});

// ── send-image ──
test('send-image rejects bad data URLs and inputs', async () => {
  const env = makeEnv({ access: 'a1' });
  mockFetch([]);
  const bad = [
    undefined, 42, 'https://example.com/x.png', 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', 'data:image/svg+xml;base64,PHN2Zz4=',
    'data:image/png,rawtext', 'data:image/png;base64,***', 'data:image/png;base64,', `data:image/png;base64,${Buffer.from('hello world, not a picture').toString('base64')}`,
    `data:image/png;base64,${'A'.repeat(Math.ceil((25 * 1024 * 1024 + 10) / 3) * 4)}`,
  ];
  for (const image of bad) {
    await assert.rejects(canvaSendImage(env, { image }), (e) => e instanceof CanvaError && e.status === 400, String(image).slice(0, 40));
  }
  await assert.rejects(canvaSendImage(env, { image: pngDataUrl(), title: 5 }), (e) => e.status === 400);
  await assert.rejects(canvaSendImage(env, null), (e) => e.status === 400);
  await assert.rejects(canvaSendImage(makeEnv({ secrets: false }), { image: pngDataUrl() }), (e) => e.status === 400);
  await assert.rejects(canvaSendImage(makeEnv({ accounts: [] }), { image: pngDataUrl() }), (e) => e.status === 401);
  await assert.rejects(canvaSendImage(env, { image: pngDataUrl(), account: 'nobody' }), (e) => e.status === 400);
  assert.equal(calls.length, 0, 'nothing reaches Canva');
  // A JPEG/WebP labelled as PNG (as some providers do) is still accepted: the bytes are sniffed.
  assert.equal(parseImageDataUrl(`data:image/png;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]).toString('base64')}`).mime, 'image/jpeg');
});
test('send-image uploads the bytes, waits for the job and creates a design', async () => {
  const env = makeEnv({ access: 'a1' });
  let polls = 0;
  mockFetch([
    [/POST .*\/v1\/asset-uploads$/, () => reply(200, { job: { id: 'job-1', status: 'in_progress' } })],
    [/GET .*\/v1\/asset-uploads\/job-1$/, () => reply(200, ++polls < 2 ? { job: { id: 'job-1', status: 'in_progress' } } : { job: { id: 'job-1', status: 'success', asset: { id: 'Mast1', name: 'x' } } })],
    [/POST .*\/v1\/designs$/, () => reply(200, { design: { ...DESIGN, title: 'A red fox' } })],
  ]);
  const title = `A red fox ${'in the snow '.repeat(20)}`;
  const out = await canvaSendImage(env, { image: pngDataUrl('image/png'), title });
  assert.deepEqual(out, { design_id: 'DAF1', title: 'A red fox', edit_url: DESIGN.urls.edit_url, view_url: DESIGN.urls.view_url });
  const up = calls[0];
  assert.equal(up.headers.get('content-type'), 'application/octet-stream');
  assert.deepEqual([...up.body], [...PNG]);
  const name = Buffer.from(JSON.parse(up.headers.get('asset-upload-metadata')).name_base64, 'base64').toString('utf8');
  assert.ok([...name].length <= 50 && name.startsWith('A red fox'));
  const create = JSON.parse(calls.find((c) => c.method === 'POST' && c.url.endsWith('/v1/designs')).body);
  assert.equal(create.asset_id, 'Mast1');
  assert.ok([...create.title].length <= 120 && create.title.endsWith('…'));
  assert.equal(polls, 2);
});
test('send-image surfaces Canva rate limits and failed jobs', async () => {
  const env = makeEnv({ access: 'a1' });
  mockFetch([[/POST .*\/v1\/asset-uploads$/, () => reply(429, { code: 'too_many_requests', message: 'Too many requests' })]]);
  await assert.rejects(canvaSendImage(env, { image: pngDataUrl() }), (e) => e.status === 429);
  mockFetch([[/POST .*\/v1\/asset-uploads$/, () => reply(200, { job: { id: 'j', status: 'failed', error: { code: 'import_failed', message: 'Import failed' } } })]]);
  await assert.rejects(canvaSendImage(env, { image: pngDataUrl() }), (e) => e.status === 502 && /Import failed/.test(e.message));
  mockFetch([[/POST .*\/v1\/asset-uploads$/, () => reply(200, { job: { id: 'j', status: 'in_progress' } })], [/GET .*asset-uploads\/j$/, () => reply(200, { job: { id: 'j', status: 'in_progress' } })]]);
  await assert.rejects(canvaSendImage(env, { image: pngDataUrl() }), (e) => e.status === 502 && e.timeout === true);
});

// ── other tools ──
test('canva_export builds the format, polls the job and notes that links expire', async () => {
  const env = makeEnv({ access: 'a1' });
  mockFetch([
    [/POST .*\/v1\/exports$/, () => reply(200, { job: { id: 'ex1', status: 'in_progress' } })],
    [/GET .*\/v1\/exports\/ex1$/, () => reply(200, { job: { id: 'ex1', status: 'success', urls: ['https://export-download.canva.com/1', 'https://export-download.canva.com/2'] } })],
  ]);
  const out = await runTool(env, 'canva_export', { design_id: 'https://www.canva.com/design/DAF1/edit', format: 'jpg', pages: [2, 1, 2], width: 800 });
  assert.equal(out.ok, true, out.error);
  assert.deepEqual(out.result.urls, ['https://export-download.canva.com/1', 'https://export-download.canva.com/2']);
  assert.match(out.result.note, /expire after 24 hours/);
  assert.deepEqual(JSON.parse(calls[0].body), { design_id: 'DAF1', format: { type: 'jpg', pages: [1, 2], width: 800, quality: 90 } });
  const bad = await runTool(env, 'canva_export', { design_id: 'DAF1', format: 'svg' });
  assert.equal(bad.ok, false);
  const badId = await runTool(env, 'canva_export', { design_id: '../users/me', format: 'pdf' });
  assert.match(badId.error, /design id/);
});
test('canva_export supports csv and single-page html exports', async () => {
  const env = makeEnv({ access: 'a1' });
  mockFetch([
    [/POST .*\/v1\/exports$/, () => reply(200, { job: { id: 'ex1', status: 'success', urls: ['https://export-download.canva.com/1'] } })],
  ]);
  let out = await runTool(env, 'canva_export', { design_id: 'DAF1', format: 'csv', export_quality: 'pro' });
  assert.equal(out.ok, true, out.error);
  assert.deepEqual(JSON.parse(calls[0].body).format, { type: 'csv' }, 'csv takes no export_quality');
  out = await runTool(env, 'canva_export', { design_id: 'DAF1', format: 'html_standalone', pages: [2] });
  assert.equal(out.ok, true, out.error);
  assert.deepEqual(JSON.parse(calls[1].body).format, { type: 'html_standalone', pages: [2] });
  out = await runTool(env, 'canva_export', { design_id: 'DAF1', format: 'html_bundle', pages: [1, 2] });
  assert.equal(out.ok, false);
  assert.match(out.error, /one page at a time/);
  assert.equal(calls.length, 2, 'a multi-page html export never reaches Canva');
});
test('canva_design lists only the export formats canva_export can produce', async () => {
  const env = makeEnv({ access: 'a1' });
  mockFetch([
    [/GET .*\/v1\/designs\/DAF1$/, () => reply(200, { design: DESIGN })],
    [/GET .*\/v1\/designs\/DAF1\/export-formats$/, () => reply(200, { formats: { csv: {}, svg: {}, pdf: {}, html_bundle: {} } })],
  ]);
  const out = await runTool(env, 'canva_design', { design_id: 'DAF1' });
  assert.equal(out.ok, true, out.error);
  assert.deepEqual(out.result.export_formats, ['csv', 'pdf', 'html_bundle']);
});
test('a rate-limited export poll backs off and keeps the same job', async () => {
  const env = makeEnv({ access: 'a1' });
  let gets = 0;
  mockFetch([
    [/POST .*\/v1\/exports$/, () => reply(200, { job: { id: 'ex1', status: 'in_progress' } })],
    [/GET .*\/v1\/exports\/ex1$/, () => (++gets === 1 ? reply(429, { code: 'too_many_requests', message: 'Too many requests' })
      : reply(200, { job: { id: 'ex1', status: 'success', urls: ['https://export-download.canva.com/1'] } }))],
  ]);
  const out = await runTool(env, 'canva_export', { design_id: 'DAF1', format: 'png' });
  assert.equal(out.ok, true, out.error);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
  // Rate-limited until the time limit: the error names the running export so it can be resumed, not restarted.
  calls = [];
  mockFetch([
    [/POST .*\/v1\/exports$/, () => reply(200, { job: { id: 'ex1', status: 'in_progress' } })],
    [/GET .*\/v1\/exports\/ex1$/, () => reply(429, { code: 'too_many_requests', message: 'Too many requests' })],
  ]);
  const late = await runTool(env, 'canva_export', { design_id: 'DAF1', format: 'png' });
  assert.equal(late.ok, false);
  assert.match(late.error, /export_id "ex1"/);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
});
test('with several accounts, a license error is final and never starts a second export', async () => {
  const other = { ...ACCOUNT, id: 'uOther', label: 'Other', refresh: 'rw' };
  const env = makeEnv({ accounts: [ACCOUNT, other], access: 'a1', extra: { 'canva_access:uOther': 'aw' } });
  mockFetch([
    [/POST .*\/v1\/exports$/, (c) => (c.headers.get('authorization') === 'Bearer a1' ? reply(200, { job: { id: 'e1', status: 'in_progress' } })
      : reply(403, { code: 'permission_denied', message: 'Not allowed to access design with id DAF1' }))],
    [/GET .*\/v1\/exports\/e1$/, () => reply(200, { job: { id: 'e1', status: 'failed', error: { code: 'license_required', message: 'The design contains premium elements' } } })],
  ]);
  const out = await runTool(env, 'canva_export', { design_id: 'DAF1', format: 'png' });
  assert.equal(out.ok, false);
  assert.match(out.error, /premium elements/);
  assert.equal(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/v1/exports')).length, 1);
  // "No access" on the first account still moves on to the next one.
  calls = [];
  mockFetch([
    [/POST .*\/v1\/exports$/, (c) => (c.headers.get('authorization') === 'Bearer aw' ? reply(200, { job: { id: 'e2', status: 'success', urls: ['https://export-download.canva.com/2'] } })
      : reply(403, { code: 'permission_denied', message: 'Not allowed to access design with id DAF1' }))],
  ]);
  const moved = await runTool(env, 'canva_export', { design_id: 'DAF1', format: 'png' });
  assert.equal(moved.ok, true, moved.error);
  assert.equal(moved.result.account, 'Other');
});
test('canva_create_design validates its shape before calling Canva', async () => {
  const env = makeEnv({ access: 'a1' });
  mockFetch([[/POST .*\/v1\/designs$/, () => reply(200, { design: DESIGN })]]);
  for (const args of [{ title: 't' }, { title: 't', design_type: 'doc', width: 100, height: 100 }, { title: 't', width: 8000, height: 8000 }, { title: 't', width: 10, height: 100 }, { title: 't', design_type: 'poster' }]) {
    const out = await runTool(env, 'canva_create_design', args, true);
    assert.equal(out.ok, false, JSON.stringify(args));
  }
  assert.equal(calls.length, 0);
  const out = await runTool(env, 'canva_create_design', { title: 'Deck', design_type: 'presentation' }, true);
  assert.equal(out.ok, true, out.error);
  assert.deepEqual(JSON.parse(calls[0].body), { title: 'Deck', design_type: { type: 'preset', name: 'presentation' } });
  assert.equal(out.result.edit_url, DESIGN.urls.edit_url);
});
test('uploads from links refuse private and non-https addresses', () => {
  for (const u of ['http://example.com/a.png', 'https://localhost/a.png', 'https://127.0.0.1/a.png', 'https://2130706433/a.png', 'https://10.0.0.8/a.png',
    'https://169.254.169.254/latest', 'https://[::1]/a.png', 'https://metadata.google.internal/x', 'https://user:pw@example.com/a.png', 'https://example.com:8443/a.png', 'ftp://example.com/a.png']) {
    assert.throws(() => checkPublicUrl(u), (e) => e instanceof CanvaError && e.status === 400, u);
  }
  assert.equal(checkPublicUrl('https://images.example.com/cat.png').hostname, 'images.example.com');
});
test('canva_upload_image falls back to a guarded Worker download when URL upload is refused', async () => {
  const env = makeEnv({ access: 'a1' });
  mockFetch([
    [/POST .*\/v1\/url-asset-uploads$/, () => reply(403, { code: 'feature_not_available', message: 'Not available' })],
    [/GET https:\/\/img\.example\.com\/start\.png$/, () => new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/secret.png' } })],
  ]);
  const blocked = await runTool(env, 'canva_upload_image', { url: 'https://img.example.com/start.png' }, true);
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /private address/);
  mockFetch([
    [/POST .*\/v1\/url-asset-uploads$/, () => reply(403, { code: 'feature_not_available', message: 'Not available' })],
    [/GET https:\/\/img\.example\.com\/cat\.png$/, () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } })],
    [/POST .*\/v1\/asset-uploads$/, () => reply(200, { job: { id: 'j2', status: 'success', asset: { id: 'Mcat', name: 'cat.png' } } })],
  ]);
  const out = await runTool(env, 'canva_upload_image', { url: 'https://img.example.com/cat.png' }, true);
  assert.equal(out.ok, true, out.error);
  assert.deepEqual(out.result, { account: 'Jane Doe', asset_id: 'Mcat', name: 'cat.png' });
  assert.ok(!calls.find((c) => c.url.startsWith('https://img.')).headers.has('authorization'), 'the Canva token is never sent to the image host');
});

// ── connect / disconnect ──
test('completing sign-in identifies the user, stores the account and caches the access token', async () => {
  const env = makeEnv({ accounts: [] });
  mockFetch([
    [/POST .*\/oauth\/token$/, () => reply(200, { access_token: 'a1', refresh_token: 'r1', expires_in: 14400, scope: CANVA_SCOPES })],
    [/GET .*\/v1\/users\/me$/, () => reply(200, { team_user: { user_id: 'uAbc123', team_id: 'tXyz' } })],
    [/GET .*\/v1\/users\/me\/profile$/, () => reply(200, { profile: { display_name: 'Jane Doe' } })],
  ]);
  assert.equal(await canvaCompleteAuth(env, 'code-1', 'v'.repeat(64), 'https://atelier.test/api/oauth/canva/callback'), 'Jane Doe');
  assert.deepEqual(form(tokenCalls()[0]), { grant_type: 'authorization_code', code: 'code-1', code_verifier: 'v'.repeat(64), redirect_uri: 'https://atelier.test/api/oauth/canva/callback' });
  const [acct] = await env.ATELIER_KV.get('canva_accounts', 'json');
  assert.deepEqual({ ...acct, connectedAt: 0 }, { id: 'uAbc123', label: 'Jane Doe', team: 'tXyz', refresh: 'r1', scope: CANVA_SCOPES, connectedAt: 0 });
  assert.equal(env.ATELIER_KV.m.get('canva_access:uAbc123').value, 'a1');
});
test('disconnecting forgets the tokens and revokes the sign-in at Canva', async () => {
  const other = { ...ACCOUNT, id: 'uOther', label: 'Work', refresh: 'rw' };
  const env = makeEnv({ accounts: [ACCOUNT, other], access: 'a1' });
  mockFetch([[/POST .*\/oauth\/revoke$/, () => reply(200, {})]]);
  assert.equal(await removeCanvaAccount(env, 'uAbc123'), 1);
  assert.deepEqual((await env.ATELIER_KV.get('canva_accounts', 'json')).map((a) => a.id), ['uOther']);
  assert.equal(env.ATELIER_KV.m.has('canva_access:uAbc123'), false);
  assert.deepEqual(form(calls[0]), { token: 'r1' });
  assert.equal(calls[0].headers.get('authorization'), `Basic ${btoa('OC-client:cnvca-secret')}`);
});

// ── Worker routes ──
const call = (env, path, init = {}, origin = 'https://atelier.test') =>
  worker.fetch(new Request(`${origin}${path}`, { ...init, headers: { 'x-app-pass': 'pw', ...(init.headers || {}) } }), env);

test('routes: start, callback and disconnect', { skip: !worker && 'module hooks unavailable' }, async () => {
  let env = makeEnv({ accounts: [] });
  assert.equal((await worker.fetch(new Request('https://atelier.test/api/oauth/canva/start', { method: 'POST' }), env)).status, 401);
  assert.equal((await call(makeEnv({ secrets: false }), '/api/oauth/canva/start', { method: 'POST' })).status, 400);
  const local = await call(env, '/api/oauth/canva/start', { method: 'POST' }, 'http://localhost:8787');
  assert.equal(local.status, 400);
  assert.match((await local.json()).error, /127\.0\.0\.1:8787/);
  const { url } = await (await call(env, '/api/oauth/canva/start', { method: 'POST' })).json();
  const state = new URL(url).searchParams.get('state');
  assert.equal(new URL(url).searchParams.get('redirect_uri'), 'https://atelier.test/api/oauth/canva/callback');

  // The callback has no passcode (it is a browser redirect) — the single-use state authenticates it.
  const cb = (q) => worker.fetch(new Request(`https://atelier.test/api/oauth/canva/callback?${q}`), env);
  let r = await cb('code=abc&state=unknownstate0000000000000000');
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /\/\?connected=error&why=sign-in%20link%20expired/);
  mockFetch([
    [/POST .*\/oauth\/token$/, () => reply(200, { access_token: 'a1', refresh_token: 'r1', expires_in: 14400 })],
    [/GET .*\/v1\/users\/me$/, () => reply(200, { team_user: { user_id: 'uAbc123', team_id: 'tXyz' } })],
    [/GET .*\/v1\/users\/me\/profile$/, () => reply(200, { profile: { display_name: 'Jane Doe' } })],
  ]);
  r = await cb(`code=abc&state=${state}`);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), 'https://atelier.test/?connected=canva&account=Jane%20Doe');
  assert.equal(form(tokenCalls()[0]).redirect_uri, 'https://atelier.test/api/oauth/canva/callback');
  r = await cb(`code=abc&state=${state}`);
  assert.match(r.headers.get('location'), /connected=error/, 'a state works once');

  const { url: url2 } = await (await call(env, '/api/oauth/canva/start', { method: 'POST' })).json();
  r = await cb(`error=access_denied&state=${new URL(url2).searchParams.get('state')}`);
  assert.equal(r.headers.get('location'), 'https://atelier.test/?connected=denied');

  const tools = await (await call(env, '/api/tools')).json();
  assert.equal(tools.services.canva, true);
  assert.deepEqual(tools.services.canvaAccounts, [{ id: 'uAbc123', label: 'Jane Doe' }]);

  assert.equal((await call(env, '/api/oauth/canva?id=', { method: 'DELETE' })).status, 400, 'an empty id never means "all"');
  assert.equal((await call(env, '/api/oauth/canva?id=../x', { method: 'DELETE' })).status, 400);
  mockFetch([[/POST .*\/oauth\/revoke$/, () => reply(200, {})]]);
  r = await call(env, '/api/oauth/canva?id=uAbc123', { method: 'DELETE' });
  assert.deepEqual(await r.json(), { ok: true, accounts: 0 });
  assert.equal(calls.filter((c) => c.url.endsWith('/oauth/revoke')).length, 1);
});
test('routes: send-image validates input and maps Canva errors to status codes', { skip: !worker && 'module hooks unavailable' }, async () => {
  const env = makeEnv({ access: 'a1' });
  const send = (body, headers = {}) => call(env, '/api/canva/send-image', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  assert.equal((await worker.fetch(new Request('https://atelier.test/api/canva/send-image', { method: 'POST', body: '{}' }), env)).status, 401);
  assert.equal((await send('not json')).status, 400);
  const bad = await send({ image: 'data:text/html;base64,PGI+' });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /image\/png/);
  mockFetch([refreshOk(2), [/POST .*\/v1\/asset-uploads$/, () => reply(401, { code: 'invalid_access_token', message: 'Access token is invalid' })]]);
  const expired = await send({ image: pngDataUrl(), title: 'Fox' });
  assert.equal(expired.status, 401);
  assert.match((await expired.json()).error, /Reconnect Canva in Settings → Connections/);
  mockFetch([[/POST .*\/v1\/asset-uploads$/, () => reply(500, { code: 'internal_error', message: 'boom' })]]);
  assert.equal((await send({ image: pngDataUrl() })).status, 502);
  mockFetch([
    [/POST .*\/v1\/asset-uploads$/, () => reply(200, { job: { id: 'j', status: 'success', asset: { id: 'Mx' } } })],
    [/POST .*\/v1\/designs$/, () => reply(200, { design: DESIGN })],
  ]);
  const ok = await send({ image: pngDataUrl(), title: 'Poster', account: 'Jane' });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { design_id: 'DAF1', title: 'Poster', edit_url: DESIGN.urls.edit_url, view_url: DESIGN.urls.view_url });
});

// ── Library "From Canva": designs, formats, import, file proxy ──
const EXPORT_URL = (n, ext = 'png') => `https://export-download.canva.com/abc/${n}.${ext}?X-Amz-Signature=s${n}&X-Amz-Expires=86400`;
const designsQuery = () => new URL(calls.find((x) => /\/v1\/designs\?/.test(x.url)).url).searchParams;

test('routes: designs lists one account, maps the fields and picks the sort order', async () => {
  const env = makeEnv({ access: 'a1' });
  const items = [
    { ...DESIGN, design_types: ['presentation', 7, ''], thumbnail: { width: 1600, height: 900, url: 'https://document-export.canva.com/t.png?sig=1' } },
    { id: 'DAF2', urls: { edit_url: 'http://insecure.example/edit' }, thumbnail: { url: 'javascript:alert(1)' }, created_at: 1690000000 },
    { id: '../users/me', title: 'bad id' }, null,
  ];
  const cont = 'RkFGMgXlsVTDbMd:MR3L0Qjia+Uzy/cIA=';
  mockFetch([[/GET .*\/v1\/designs\?/, () => reply(200, { items, continuation: cont })]]);
  assert.equal((await worker.fetch(new Request('https://atelier.test/api/canva/designs'), env)).status, 401, 'passcode required');
  const r = await call(env, '/api/canva/designs');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), {
    account: { id: 'uAbc123', label: 'Jane Doe' },
    items: [
      { id: 'DAF1', title: 'Poster', thumbnail: 'https://document-export.canva.com/t.png?sig=1', updated: 1700000000, page_count: 2, types: ['presentation'], edit_url: DESIGN.urls.edit_url },
      { id: 'DAF2', title: 'Untitled design', thumbnail: null, updated: 1690000000, page_count: null, types: [], edit_url: null },
    ],
    continuation: cont,
  });
  let q = designsQuery();
  assert.equal(q.get('limit'), '24');
  assert.equal(q.get('sort_by'), 'modified_descending', 'no query → most recently edited');
  assert.equal(q.has('query'), false);
  assert.equal(calls.at(-1).headers.get('authorization'), 'Bearer a1');

  calls = [];
  await call(env, `/api/canva/designs?query=${encodeURIComponent('  summer poster ')}&continuation=${encodeURIComponent(cont)}`);
  q = designsQuery();
  assert.equal(q.get('sort_by'), 'relevance', 'a query sorts by relevance');
  assert.equal(q.get('query'), 'summer poster');
  assert.equal(q.get('continuation'), cont);

  // A continuation from Canva that this route would refuse is never handed out.
  mockFetch([[/GET .*\/v1\/designs\?/, () => reply(200, { items: [], continuation: 'has spaces & <tags>' })]]);
  assert.equal((await (await call(env, '/api/canva/designs')).json()).continuation, null);
});

test('routes: designs validates query, continuation and account before calling Canva', async () => {
  const other = { ...ACCOUNT, id: 'uOther', label: 'Work Studio', refresh: 'rw' };
  const env = makeEnv({ accounts: [ACCOUNT, other], access: 'a1', extra: { 'canva_access:uOther': 'aw' } });
  mockFetch([[/GET .*\/v1\/designs\?/, () => reply(200, { items: [DESIGN] })]]);
  const bad = [
    `query=${'q'.repeat(256)}`, `continuation=${'a'.repeat(2049)}`, 'continuation=bad%20token', 'continuation=x%25y', 'continuation=a%26b%3Dc',
    'continuation=%3Cscript%3E', 'account=nobody',
  ];
  for (const qs of bad) {
    const r = await call(env, `/api/canva/designs?${qs}`);
    assert.equal(r.status, 400, qs);
    assert.ok((await r.json()).error, qs);
  }
  assert.equal(calls.length, 0, 'nothing invalid reaches Canva');
  assert.equal((await call(env, `/api/canva/designs?query=${'q'.repeat(255)}&continuation=${'a'.repeat(2048)}`)).status, 200, 'limits are inclusive');
  // The named account (by id or name) is used; the default is the first connected one.
  calls = [];
  const byName = await (await call(env, '/api/canva/designs?account=work')).json();
  assert.deepEqual(byName.account, { id: 'uOther', label: 'Work Studio' });
  assert.equal(calls[0].headers.get('authorization'), 'Bearer aw');
  assert.equal((await (await call(env, '/api/canva/designs?account=uOther')).json()).account.id, 'uOther');
  assert.equal((await (await call(env, '/api/canva/designs')).json()).account.id, 'uAbc123');
  // Not connected / not configured / signed out / rate-limited.
  assert.equal((await call(makeEnv({ accounts: [] }), '/api/canva/designs')).status, 401);
  assert.equal((await call(makeEnv({ secrets: false }), '/api/canva/designs')).status, 400);
  mockFetch([refreshOk(2), [/GET .*\/v1\/designs\?/, () => reply(401, { code: 'revoked_access_token', message: 'revoked' })]]);
  const out = await call(makeEnv({ access: 'a1' }), '/api/canva/designs');
  assert.equal(out.status, 401);
  assert.match((await out.json()).error, /Reconnect Canva/);
  mockFetch([[/GET .*\/v1\/designs\?/, () => reply(429, { code: 'too_many_requests', message: 'Slow down' })]]);
  assert.equal((await call(makeEnv({ access: 'a1' }), '/api/canva/designs')).status, 429);
});

test('routes: formats maps Canva export formats to lowercase names the export API can make', async () => {
  const env = makeEnv({ access: 'a1' });
  mockFetch([
    [/GET .*\/v1\/designs\/DAF1$/, () => reply(200, { design: { ...DESIGN, page_count: 12 } })],
    [/GET .*\/v1\/designs\/DAF1\/export-formats$/, () => reply(200, { formats: { pdf: {}, JPG: {}, png: { page_numbers: [1, 2] }, svg: {}, mp4: {}, weird: {} } })],
    [/GET .*\/v1\/designs\/MISSING(\/export-formats)?$/, () => reply(404, { code: 'design_not_found', message: 'Design not found' })],
  ]);
  const r = await call(env, '/api/canva/designs/DAF1/formats');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { title: 'Poster', page_count: 12, formats: ['pdf', 'jpg', 'png', 'mp4'] });
  assert.equal((await call(env, '/api/canva/designs/MISSING/formats')).status, 404);
  calls = [];
  for (const bad of ['/api/canva/designs/a.b/formats', `/api/canva/designs/${'x'.repeat(129)}/formats`, '/api/canva/designs/a%2Fb/formats', '/api/canva/designs/a%20b/formats']) {
    assert.equal((await call(env, bad)).status, 400, bad);
  }
  assert.equal((await call(env, '/api/canva/designs/DAF1/formats?account=nobody')).status, 400);
  assert.equal(calls.length, 0);
  assert.equal((await worker.fetch(new Request('https://atelier.test/api/canva/designs/DAF1/formats'), env)).status, 401);
});

const importCall = (env, body, headers = {}) => call(env, '/api/canva/import', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const exportBodies = () => calls.filter((c) => c.method === 'POST' && c.url.endsWith('/v1/exports')).map((c) => JSON.parse(c.body));
const fileLink = (u) => `/api/canva/file?u=${encodeURIComponent(u)}`;

test('routes: import exports PNG pages, polls the job and returns proxy links in page order', async () => {
  const env = makeEnv({ access: 'a1' });
  let polls = 0;
  const urls = [EXPORT_URL(1), EXPORT_URL(2), EXPORT_URL(3)];
  mockFetch([
    [/GET .*\/v1\/designs\/DAF1$/, () => reply(200, { design: { ...DESIGN, page_count: 3 } })],
    [/POST .*\/v1\/exports$/, () => reply(200, { job: { id: 'ex1', status: 'in_progress' } })],
    [/GET .*\/v1\/exports\/ex1$/, () => reply(200, ++polls < 3 ? { job: { id: 'ex1', status: 'in_progress' } } : { job: { id: 'ex1', status: 'success', urls } })],
  ]);
  assert.equal((await worker.fetch(new Request('https://atelier.test/api/canva/import', { method: 'POST', body: '{}' }), env)).status, 401);
  const r = await importCall(env, { design_id: 'DAF1', format: 'png' });
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.deepEqual(out, { design_id: 'DAF1', title: 'Poster', format: 'png', files: urls.map(fileLink), truncated: false });
  assert.equal(polls, 3);
  assert.deepEqual(exportBodies(), [{ design_id: 'DAF1', format: { type: 'png' } }], 'PNG keeps Canva defaults (lossless) and exports every page');
  // The links round-trip to the original Canva URLs.
  assert.deepEqual(out.files.map((f) => new URL(f, 'https://atelier.test').searchParams.get('u')), urls);

  // Chosen pages are sorted; an empty list means every page.
  calls = []; polls = 5;
  await importCall(env, { design_id: 'DAF1', format: 'png', pages: [3, 1] });
  await importCall(env, { design_id: 'DAF1', format: 'png', pages: [] });
  assert.deepEqual(exportBodies().map((b) => b.format), [{ type: 'png', pages: [1, 3] }, { type: 'png' }]);
});

test('routes: import keeps at most 10 files and says so', async () => {
  const env = makeEnv({ access: 'a1' });
  let pageCount = 14;
  let urls = [];
  mockFetch([
    [/GET .*\/v1\/designs\/DAF1$/, () => reply(200, { design: { ...DESIGN, page_count: pageCount } })],
    [/POST .*\/v1\/exports$/, () => reply(200, { job: { id: 'ex1', status: 'success', urls } })],
  ]);
  // Known to be long: only the first 10 pages are rendered.
  urls = Array.from({ length: 10 }, (_, i) => EXPORT_URL(i + 1));
  let out = await (await importCall(env, { design_id: 'DAF1', format: 'png' })).json();
  assert.deepEqual(exportBodies()[0].format, { type: 'png', pages: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
  assert.equal(out.files.length, 10);
  assert.equal(out.truncated, true);
  // Page count unknown but Canva sends 12 files: the first 10 are kept, in order.
  calls = []; pageCount = undefined;
  urls = Array.from({ length: 12 }, (_, i) => EXPORT_URL(i + 1));
  out = await (await importCall(env, { design_id: 'DAF1', format: 'png' })).json();
  assert.deepEqual(exportBodies()[0].format, { type: 'png' });
  assert.deepEqual(out.files, urls.slice(0, 10).map(fileLink));
  assert.equal(out.truncated, true);
});

test('routes: import exports MP4 at 1080p, portrait when the design is', async () => {
  const env = makeEnv({ access: 'a1' });
  let thumb = { width: 1080, height: 1920, url: 'https://t' };
  mockFetch([
    [/GET .*\/v1\/designs\/DAF1$/, () => reply(200, { design: { ...DESIGN, page_count: 30, thumbnail: thumb } })],
    [/POST .*\/v1\/exports$/, () => reply(200, { job: { id: 'ex1', status: 'success', urls: [EXPORT_URL(1, 'mp4')] } })],
  ]);
  const out = await (await importCall(env, { design_id: 'DAF1', format: 'mp4' })).json();
  assert.equal(out.format, 'mp4');
  assert.equal(out.truncated, false);
  assert.deepEqual(out.files, [fileLink(EXPORT_URL(1, 'mp4'))]);
  thumb = { width: 1920, height: 1080, url: 'https://t' };
  await importCall(env, { design_id: 'DAF1', format: 'mp4' });
  thumb = undefined;
  await importCall(env, { design_id: 'DAF1', format: 'mp4', pages: [2] });
  assert.deepEqual(exportBodies().map((b) => b.format), [
    { type: 'mp4', quality: 'vertical_1080p' }, { type: 'mp4', quality: 'horizontal_1080p' }, { type: 'mp4', pages: [2], quality: 'horizontal_1080p' },
  ], 'a long video is never cut to 10 pages');
});

test('routes: import validates its body before calling Canva', async () => {
  const env = makeEnv({ access: 'a1' });
  mockFetch([]);
  const bad = [
    'not json', [], { format: 'png' }, { design_id: '../x', format: 'png' }, { design_id: 'https://www.canva.com/design/DAF1/edit', format: 'png' },
    { design_id: 'DAF1' }, { design_id: 'DAF1', format: 'jpg' }, { design_id: 'DAF1', format: 'PNG' }, { design_id: 'DAF1', format: 'pdf' },
    { design_id: 'DAF1', format: 'png', pages: 'all' }, { design_id: 'DAF1', format: 'png', pages: [0] }, { design_id: 'DAF1', format: 'png', pages: [501] },
    { design_id: 'DAF1', format: 'png', pages: [1.5] }, { design_id: 'DAF1', format: 'png', pages: ['1'] }, { design_id: 'DAF1', format: 'png', pages: [1, 1] },
    { design_id: 'DAF1', format: 'png', pages: Array.from({ length: 11 }, (_, i) => i + 1) }, { design_id: 'DAF1', format: 'png', account: 5 },
    { design_id: 'DAF1', format: 'png', account: 'nobody' },
  ];
  for (const body of bad) assert.equal((await importCall(env, body)).status, 400, JSON.stringify(body));
  assert.equal((await importCall(env, JSON.stringify({ design_id: 'DAF1', format: 'png', pad: 'x'.repeat(20_000) }))).status, 400, 'oversized body');
  assert.equal(calls.length, 0, 'nothing invalid reaches Canva');
  assert.equal((await importCall(makeEnv({ accounts: [] }), { design_id: 'DAF1', format: 'png' })).status, 401);
});

test('routes: import maps license, approval and unsupported-format refusals to clear messages', async () => {
  const env = makeEnv({ access: 'a1' });
  const design = [/GET .*\/v1\/designs\/DAF1$/, () => reply(200, { design: DESIGN })];
  const failWith = (error) => [design, [/POST .*\/v1\/exports$/, () => reply(200, { job: { id: 'e1', status: 'in_progress' } })],
    [/GET .*\/v1\/exports\/e1$/, () => reply(200, { job: { id: 'e1', status: 'failed', error } })]];
  mockFetch(failWith({ code: 'license_required', message: 'The design contains premium elements' }));
  let r = await importCall(env, { design_id: 'DAF1', format: 'png' });
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /premium Canva elements/);
  mockFetch(failWith({ code: 'approval_required', message: 'Needs approval' }));
  r = await importCall(env, { design_id: 'DAF1', format: 'png' });
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /needs approval in Canva/);
  // license_required straight from the create call (HTTP 403) is mapped the same way.
  mockFetch([design, [/POST .*\/v1\/exports$/, () => reply(403, { code: 'license_required', message: 'premium' })]]);
  r = await importCall(env, { design_id: 'DAF1', format: 'png' });
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /premium Canva elements/);
  mockFetch([design, [/POST .*\/v1\/exports$/, () => reply(400, { code: 'invalid_field', message: 'Export format mp4 is not supported for this design type' })]]);
  r = await importCall(env, { design_id: 'DAF1', format: 'mp4' });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'Canva can’t export this design as a video (MP4).');
  mockFetch(failWith({ code: 'internal_failure', message: 'Something broke' }));
  assert.equal((await importCall(env, { design_id: 'DAF1', format: 'png' })).status, 502);
  mockFetch([[/GET .*\/v1\/designs\/DAF1$/, () => reply(404, { code: 'design_not_found', message: 'Design not found' })]]);
  assert.equal((await importCall(env, { design_id: 'DAF1', format: 'png' })).status, 404);
  // A download link on any other host is refused up front (the file proxy would refuse it anyway).
  mockFetch([design, [/POST .*\/v1\/exports$/, () => reply(200, { job: { id: 'e1', status: 'success', urls: [EXPORT_URL(1), 'https://evil.example/2.png'] } })]]);
  r = await importCall(env, { design_id: 'DAF1', format: 'png' });
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /doesn’t recognise/);
  mockFetch([design, [/POST .*\/v1\/exports$/, () => reply(200, { job: { id: 'e1', status: 'success', urls: [] } })]]);
  assert.equal((await importCall(env, { design_id: 'DAF1', format: 'png' })).status, 502);
});

const fileCall = (env, u, headers) => call(env, `/api/canva/file${u === undefined ? '' : `?u=${encodeURIComponent(u)}`}`, { headers });

test('file proxy only fetches https links on the Canva export host', async () => {
  assert.deepEqual([...CANVA_EXPORT_HOSTS], ['export-download.canva.com']);
  const env = makeEnv();
  mockFetch([[/.*/, () => new Response(PNG, { headers: { 'content-type': 'image/png' } })]]);
  const bad = [
    undefined, '', 'not a url', 'http://export-download.canva.com/a.png', 'https://export-download.canva.com.evil.com/a.png',
    'https://evil.com/export-download.canva.com/a.png', 'https://export-download.canva.com@evil.com/a.png', 'https://user:pw@export-download.canva.com/a.png',
    'https://export-download.canva.com:pw@evil.com/a.png', 'https://evil.com#@export-download.canva.com/a.png', 'https://evil.com?@export-download.canva.com/',
    'https://export-download.canva.com:8443/a.png', 'https://export-download.canva.com./a.png', 'https://sub.export-download.canva.com/a.png',
    'https://canva.com/a.png', 'https://www.canva.com/a.png', 'https://export-download.canva.co/a.png', 'https://xn--export-download-canva-com.evil/a.png',
    'javascript:alert(1)', 'data:image/png;base64,AAAA', 'file:///etc/passwd', 'ftp://export-download.canva.com/a.png', 'https://127.0.0.1/a.png',
    `https://export-download.canva.com/${'a'.repeat(9000)}`,
  ];
  for (const u of bad) {
    const r = await fileCall(env, u);
    assert.equal(r.status, 400, String(u));
    assert.equal(r.headers.get('content-type'), 'application/json');
  }
  assert.equal(calls.length, 0, 'nothing outside the allow-list is ever fetched');
  for (const u of ['https://EXPORT-DOWNLOAD.CANVA.COM/a.png', 'https://export-download.canva.com:443/a.png']) assert.equal(checkCanvaFileUrl(u).hostname, 'export-download.canva.com');
  // Passcode required.
  assert.equal((await worker.fetch(new Request(`https://atelier.test/api/canva/file?u=${encodeURIComponent(EXPORT_URL(1))}`), env)).status, 401);
  assert.equal((await fileCall(env, EXPORT_URL(1), { 'x-app-pass': 'wrong' })).status, 401);
  assert.equal(calls.length, 0);
});

test('file proxy streams allowed files without credentials and never follows redirects off the export host', async () => {
  const env = makeEnv({ access: 'a1' });
  const bytes = new Uint8Array(4096).fill(7);
  bytes.set(PNG);
  mockFetch([
    [/GET https:\/\/export-download\.canva\.com\/abc\/1\.png/, () => new Response(bytes, { headers: { 'content-type': 'image/png', 'content-length': '4096', 'set-cookie': 'a=b' } })],
    [/GET https:\/\/export-download\.canva\.com\/abc\/hop/, () => new Response(null, { status: 302, headers: { location: EXPORT_URL(1) } })],
    [/GET https:\/\/export-download\.canva\.com\/abc\/away/, () => new Response(null, { status: 302, headers: { location: 'https://evil.example/x.png' } })],
    [/GET https:\/\/export-download\.canva\.com\/abc\/loop/, () => new Response(null, { status: 301, headers: { location: 'https://export-download.canva.com/abc/loop' } })],
    [/GET https:\/\/export-download\.canva\.com\/abc\/gone/, () => new Response('<Error>AccessDenied</Error>', { status: 403, headers: { 'content-type': 'application/xml' } })],
  ]);
  const r = await fileCall(env, EXPORT_URL(1));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.equal(r.headers.get('cache-control'), 'private, no-store');
  assert.equal(r.headers.get('content-length'), '4096');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('set-cookie'), null, 'upstream headers are not passed through');
  assert.deepEqual(new Uint8Array(await r.arrayBuffer()), bytes);
  const up = calls[0];
  assert.equal(up.url, EXPORT_URL(1));
  assert.equal(up.redirect, 'manual');
  assert.equal(up.headers.get('authorization'), null, 'no Canva token');
  assert.equal(up.headers.get('x-app-pass'), null, 'no passcode');
  assert.equal(up.headers.get('cookie'), null);

  calls = [];
  assert.equal((await fileCall(env, 'https://export-download.canva.com/abc/hop')).status, 200, 'a hop that stays on the export host is fine');
  assert.deepEqual(calls.map((c) => new URL(c.url).pathname), ['/abc/hop', '/abc/1.png']);
  calls = [];
  const away = await fileCall(env, 'https://export-download.canva.com/abc/away');
  assert.equal(away.status, 502);
  assert.ok(!calls.some((c) => c.url.includes('evil.example')), 'the redirect target is never fetched');
  assert.equal((await fileCall(env, 'https://export-download.canva.com/abc/loop')).status, 502);
  const gone = await fileCall(env, 'https://export-download.canva.com/abc/gone');
  assert.equal(gone.status, 502);
  assert.match((await gone.json()).error, /expired/);
});

test('file proxy passes only PNG, JPEG and MP4 through', async () => {
  const env = makeEnv();
  const MP4 = Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0]);
  const serve = (type, body = PNG) => mockFetch([[/export-download/, () => new Response(body, { headers: type ? { 'content-type': type } : {} })]]);
  for (const [type, want] of [['image/png', 'image/png'], ['image/jpeg; charset=binary', 'image/jpeg'], ['video/mp4', 'video/mp4'], ['IMAGE/PNG', 'image/png']]) {
    serve(type);
    const r = await fileCall(env, EXPORT_URL(1));
    assert.equal(r.status, 200, type);
    assert.equal(r.headers.get('content-type'), want);
  }
  for (const type of ['text/html', 'image/svg+xml', 'application/json', 'application/pdf', 'image/gif', 'application/xml', 'text/plain']) {
    serve(type);
    const r = await fileCall(env, EXPORT_URL(1));
    assert.equal(r.status, 502, type);
    assert.match((await r.json()).error, /PNG, JPEG or MP4/);
  }
  // A generic label is checked against the bytes: real PNG / MP4 files are served with their real type…
  serve('application/octet-stream', PNG);
  let r = await fileCall(env, EXPORT_URL(1));
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.deepEqual(new Uint8Array(await r.arrayBuffer()), PNG, 'the peeked bytes are not lost');
  serve('binary/octet-stream', MP4);
  r = await fileCall(env, EXPORT_URL(1, 'mp4'));
  assert.equal(r.headers.get('content-type'), 'video/mp4');
  assert.deepEqual(new Uint8Array(await r.arrayBuffer()), MP4);
  // …anything else is refused.
  serve('application/octet-stream', new TextEncoder().encode('<html><script>alert(1)</script></html>'));
  assert.equal((await fileCall(env, EXPORT_URL(1))).status, 502);
  serve(null, new TextEncoder().encode('<svg onload=alert(1)>'));
  assert.equal((await fileCall(env, EXPORT_URL(1))).status, 502);
});

test('file proxy refuses files over the size cap and cuts off streams that grow past it', async () => {
  assert.equal(CANVA_FILE_LIMITS.maxBytes, 100 * 1024 * 1024);
  const env = makeEnv();
  // A declared size over 100 MB is refused before any bytes are read.
  let cancelled = false;
  const endless = () => new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(65536)); }, cancel() { cancelled = true; } });
  mockFetch([[/export-download/, () => new Response(endless(), { headers: { 'content-type': 'video/mp4', 'content-length': String(100 * 1024 * 1024 + 1) } })]]);
  const r = await fileCall(env, EXPORT_URL(1, 'mp4'));
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /larger than 100 MB/);
  assert.equal(cancelled, true, 'the upstream download is cancelled');
  // No (or a lying) Content-Length: the stream is aborted once it passes the cap.
  CANVA_FILE_LIMITS.maxBytes = 200_000;
  cancelled = false;
  mockFetch([[/export-download/, () => new Response(endless(), { headers: { 'content-type': 'video/mp4' } })]]);
  const res = await canvaFetchFile(EXPORT_URL(1, 'mp4'));
  assert.equal(res.status, 200);
  await assert.rejects(res.arrayBuffer());
  assert.equal(cancelled, true);
  // Exactly at the limit is fine.
  mockFetch([[/export-download/, () => new Response(new Uint8Array(200_000), { headers: { 'content-type': 'video/mp4', 'content-length': '200000' } })]]);
  assert.equal((await (await canvaFetchFile(EXPORT_URL(1, 'mp4'))).arrayBuffer()).byteLength, 200_000);
});

test('file proxy refuses an empty export file (it would break backup restores)', async () => {
  const env = makeEnv();
  // Declared empty: refused before streaming.
  mockFetch([[/export-download/, () => new Response(new Uint8Array(0), { headers: { 'content-type': 'video/mp4', 'content-length': '0' } })]]);
  const r = await fileCall(env, EXPORT_URL(1, 'mp4'));
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /empty file/);
  // No length, and the stream ends with nothing: the body errors instead of closing as a valid 0-byte file.
  mockFetch([[/export-download/, () => new Response(new ReadableStream({ start(c) { c.close(); } }), { headers: { 'content-type': 'video/mp4' } })]]);
  const res = await canvaFetchFile(EXPORT_URL(1, 'mp4'));
  await assert.rejects(res.arrayBuffer());
});

test('no connected Canva account answers 401 with the stable "Reconnect Canva" text the picker keys on', async () => {
  const env = makeEnv({ accounts: [] });
  mockFetch([]);
  for (const path of ['/api/canva/designs', '/api/canva/designs?account=uAbc123', '/api/canva/designs/DAF1/formats']) {
    const r = await call(env, path);
    assert.equal(r.status, 401, path);
    assert.match((await r.json()).error, /Canva isn’t connected\. Reconnect Canva in Settings → Connections/);
  }
});
