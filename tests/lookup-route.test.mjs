// Look up through the real worker (worker.fetch): the owner's passcode branch and the testers' free TESTER_ROUTES
// entries for GET /api/lookup and GET /api/lookup/img. Every test skips itself until src/worker.js and
// src/tester/router.js are wired (docs: the lookup integration patches); no edit is needed here at integration time.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeEnv, mockFetch, restoreFetch, upstream, reply, api, signIn, PROFILE, resetTesterCaches } from './tester-env.mjs';
import { resetLookupState, proxyImageUrl } from '../src/lookup.js';

const source = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const workerSrc = source('../src/worker.js'), routerSrc = source('../src/tester/router.js');
const wired = workerSrc.includes("path === 'lookup'") && routerSrc.includes("match: 'lookup'");
const wiredImg = wired && workerSrc.includes("path === 'lookup/img'") && routerSrc.includes("match: 'lookup/img'");
const SKIP = { skip: !wired && 'integration pending (src/worker.js and src/tester/router.js don’t route lookup yet)' };
const SKIP_IMG = { skip: !wiredImg && 'integration pending (lookup/img is not routed yet)' };

beforeEach(() => resetTesterCaches());
afterEach(() => { restoreFetch(); resetLookupState(); });

const DOMUS = JSON.parse(source('./fixtures/lookup/summary-domus-aurea.json')).body;
const DOMUS_KEY = 'thumb/0/03/Domus_Aurea_pianta_generale.png/330px-Domus_Aurea_pianta_generale.png';
const IMG_PATH = proxyImageUrl(DOMUS_KEY).replace(/^\/api\//, ''); // lookup/img?k=…
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1]);
const SUMMARY = /^GET https:\/\/en\.wikipedia\.org\/api\/rest_v1\/page\/summary\/Domus_Aurea$/;
const UPLOAD = /^GET https:\/\/upload\.wikimedia\.org\/wikipedia\/commons\/thumb\//;
const wikimedia = () => mockFetch([
  [SUMMARY, () => reply(200, DOMUS, { 'set-cookie': 'WMF-Last-Access=01-Oct-2026;Path=/' })],
  [UPLOAD, () => new Response(PNG, { headers: { 'content-type': 'image/png' } })],
  [/./, () => reply(500, { error: 'unexpected upstream' })],
]);
const codeOf = async (r) => (await r.clone().json().catch(() => ({}))).code;
const noPasscode = async (r) => assert.ok(!/passcode/i.test(await r.clone().text()), 'a tester-facing error mentions the passcode');

async function tester(extraEnv = {}) {
  const { env, L } = makeEnv(extraEnv);
  const t = await signIn(L, PROFILE());
  return { env, L, ...t };
}

test('owner without the passcode: 401 for both routes, nothing sent upstream', SKIP, async () => {
  const { env } = makeEnv();
  wikimedia();
  for (const path of ['lookup?q=Domus%20Aurea', IMG_PATH]) {
    if (path === IMG_PATH && !wiredImg) continue;
    const r = await api(env, path);
    assert.equal(r.status, 401, path);
    assert.equal(upstream.calls.length, 0);
  }
});

test('owner with the passcode: the article, wrapped by the /api security headers', SKIP, async () => {
  const { env, L } = makeEnv();
  wikimedia();
  const r = await api(env, 'lookup?q=Domus%20Aurea&lang=en', {}, { pass: 'pw' });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.kind, 'article'); assert.equal(body.title, 'Domus Aurea'); assert.equal(body.description, 'Roman palace');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(r.headers.get('set-cookie'), null);
  assert.equal(upstream.calls.length, 1);
  assert.equal(upstream.calls[0].headers.get('x-app-pass'), null);
  assert.match(upstream.calls[0].headers.get('user-agent'), /^Atelier\/1\.0 \(https:\/\/atelier\.ciprari\.ai\//);
  assert.deepEqual(L.calls, []);
});

test('owner image proxy: the Commons thumbnail as a sniffed, sandboxed, uncacheable same-origin image', SKIP_IMG, async () => {
  const { env } = makeEnv();
  wikimedia();
  const r = await api(env, IMG_PATH, {}, { pass: 'pw' });
  assert.equal(r.status, 200);
  assert.deepEqual(new Uint8Array(await r.arrayBuffer()), PNG);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.equal(r.headers.get('cache-control'), 'private, no-store'); // the wrapper keeps a route's own no-store
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(r.headers.get('content-security-policy') || '', /\bsandbox\b/);
  assert.equal(upstream.calls.length, 1);
  assert.equal(upstream.calls[0].url, `https://upload.wikimedia.org/wikipedia/commons/${DOMUS_KEY}`);
});

test('a tester: the same answer, free (no allowance header), only the session lookup in the Ledger, the KV untouched', SKIP, async () => {
  const { env, L, token } = await tester();
  wikimedia();
  L.calls.length = 0;
  const r = await api(env, 'lookup?q=Domus%20Aurea', {}, { cookie: token });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.title, 'Domus Aurea');
  assert.equal(r.headers.get('x-tester-allowance'), null);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.ok(L.calls.every((m) => m === 'session'), `${L.calls}`);
  assert.deepEqual([...env.ATELIER_KV.m.keys()], []);
  assert.equal(upstream.calls[0].headers.get('cookie'), null);
  const owner = await api(env, 'lookup?q=Domus%20Aurea', {}, { pass: 'pw' });
  assert.deepEqual(await owner.json(), body);
});

test('a tester’s image proxy call is free too', SKIP_IMG, async () => {
  const { env, L, token } = await tester();
  wikimedia();
  L.calls.length = 0;
  const r = await api(env, IMG_PATH, {}, { cookie: token });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.equal(r.headers.get('x-tester-allowance'), null);
  assert.ok(L.calls.every((m) => m === 'session'), `${L.calls}`);
  assert.deepEqual([...env.ATELIER_KV.m.keys()], []);
});

test('a tester can only GET: other methods are owner_only, before anything is sent', SKIP, async () => {
  const { env, token } = await tester();
  wikimedia();
  for (const path of ['lookup?q=Domus%20Aurea', ...(wiredImg ? [IMG_PATH] : [])]) {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const r = await api(env, path, { method, body: '' }, { cookie: token });
      assert.equal(r.status, 403, `${method} ${path}`);
      assert.equal(await codeOf(r), 'owner_only', `${method} ${path}`);
      await noPasscode(r);
    }
  }
  assert.equal(upstream.calls.length, 0);
});

test('a tester over the per-tester limit gets lookup_rate, keyed by their LinkedIn id; no error mentions a passcode', SKIP, async () => {
  const keys = [];
  const LOOKUP_LIMIT = { limit: async ({ key }) => { keys.push(key); return { success: false }; } };
  const { env, token, sub } = await tester({ LOOKUP_LIMIT });
  wikimedia();
  const r = await api(env, 'lookup?q=Domus%20Aurea', {}, { cookie: token });
  assert.equal(r.status, 429);
  assert.equal(await codeOf(r), 'lookup_rate');
  assert.equal(r.headers.get('retry-after'), '30');
  await noPasscode(r);
  assert.deepEqual(keys, [`t:${sub}`]);
  assert.equal(upstream.calls.length, 0);
  // a bad request is refused before the limit is spent
  for (const path of ['lookup', 'lookup?title=', ...(wiredImg ? ['lookup/img', 'lookup/img?k=..%2Fx'] : [])]) {
    const bad = await api(env, path, {}, { cookie: token });
    assert.equal(bad.status, 400, path);
    assert.equal(await codeOf(bad), 'lookup_query', path);
    await noPasscode(bad);
  }
  assert.equal(keys.length, 1);
});

test('an ended tester session is told to sign in again, and nothing is looked up', SKIP, async () => {
  const { env } = makeEnv();
  wikimedia();
  const stale = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  const r = await api(env, 'lookup?q=Domus%20Aurea', {}, { cookie: stale });
  assert.equal(r.status, 401);
  assert.equal(await codeOf(r), 'tester_signin');
  assert.equal(upstream.calls.length, 0);
});

test('the owner gets the same status with or without a tester cookie (no per-isolate failure state)', SKIP, async () => {
  const { env, L, token } = await tester();
  mockFetch([[/./, () => reply(503, { error: 'stub' })]]);
  const paths = ['lookup', 'lookup?q=Domus%20Aurea', ...(wiredImg ? ['lookup/img', IMG_PATH] : [])];
  for (const path of paths) {
    for (const method of ['GET', 'POST', 'DELETE']) {
      const init = { method, ...(method === 'POST' ? { body: '{}' } : {}) };
      L.calls.length = 0;
      const withCookie = await api(env, path, init, { pass: 'pw', cookie: token });
      assert.deepEqual(L.calls, [], `${method} ${path}`);
      const plain = await api(env, path, init, { pass: 'pw' });
      assert.equal(withCookie.status, plain.status, `${method} ${path}`);
    }
  }
  assert.equal((await api(env, 'lookup', {}, { pass: 'pw' })).status, 400);
  assert.equal((await api(env, 'lookup', { method: 'POST', body: '' }, { pass: 'pw' })).status, 405);
});
