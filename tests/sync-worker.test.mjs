// /api/sync/* (src/sync.js) over the in-memory R2 fake. Most checks call handleSync directly; the auth/isolation
// checks go through the real worker.fetch (api() from tester-env.mjs). Those that need the worker.js route block skip
// until it is wired (sync-integration.md, SERVER §1) and then run unchanged.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeEnv, api, signIn, PROFILE, resetTesterCaches, mockFetch, restoreFetch, reply } from './tester-env.mjs';
import { fakeR2, workerRequest, knownLength } from './fake-r2.mjs';
import { handleSync, SYNC_OPTIONS, SYNC_TIMING } from '../src/sync.js';
import { FORMAT, LIMITS, INLINE_MAX, dehydrate, sha256hex, applyPush, TEXT_TYPE } from '../public/sync-merge.js';

const workerSrc = await readFile(new URL('../src/worker.js', import.meta.url), 'utf8');
const syncSrc = await readFile(new URL('../src/sync.js', import.meta.url), 'utf8');
const WIRED = /\bhandleSync\(/.test(workerSrc);
const wired = WIRED ? {} : { skip: 'src/worker.js has no /api/sync route block yet (sync-integration.md, SERVER §1)' };

const NOW = 1_800_000_000_000, MIN = 60_000, DAY = 86_400_000;
const real = { ...SYNC_TIMING };
let clock, sleeps;
beforeEach(() => {
  clock = NOW; sleeps = [];
  Object.assign(SYNC_TIMING, { now: () => clock, sleep: async (ms) => { sleeps.push(ms); }, jitter: () => 100 });
  resetTesterCaches();
});
afterEach(() => { Object.assign(SYNC_TIMING, real); restoreFetch(); });

const syncEnv = (extra = {}) => ({ SYNC_BUCKET: fakeR2(), ...extra });
// handleSync the way worker.js calls it: (req, env, url, 'sync/<sub>').
function call(env, method, sub, { body, headers = {}, query = '' } = {}) {
  const url = new URL(`https://atelier.ciprari.ai/api/sync/${sub}${query}`);
  const init = { method, headers };
  if (body !== undefined) {
    init.body = typeof body === 'string' || body instanceof Uint8Array || body instanceof ReadableStream ? body : JSON.stringify(body);
    if (body instanceof ReadableStream) init.duplex = 'half';
  }
  return handleSync(workerRequest(url, init), env, url, `sync/${sub}`);
}
const bodyOf = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const codeOf = async (r) => (await bodyOf(r.clone())).code;
const ask = (id, createdAt, text = `answer ${id}`, extra = {}) => ({ id, kind: 'ask', prompt: `prompt ${id}`, createdAt, text, ...extra });
async function pushBody(entries, { createdAt = 1, title, bases = {} } = {}) {
  const out = [];
  for (const e of entries) { const x = await dehydrate(e); out.push({ id: e.id, base: bases[e.id] ?? 0, createdAt: e.createdAt, h: x.h, d: x.d }); }
  return { v: FORMAT, createdAt, ...(title ? { title } : {}), entries: out };
}
const push = async (env, id, entries, opts) => call(env, 'POST', `thread/${id}`, { body: await pushBody(entries, opts) });
const putBlob = (env, hash, bytes, type = 'image/png', headers = {}) => call(env, 'PUT', `blob/${hash}`, { body: bytes, headers: { 'content-type': type, 'content-length': String(bytes.byteLength), ...headers } });
// A stream body that records whether anyone read it.
function watchedBody() {
  const seen = { pulled: false };
  const stream = new ReadableStream({ pull(c) { seen.pulled = true; c.enqueue(new TextEncoder().encode('{}')); c.close(); } }, { highWaterMark: 0 }); // pulled only when read
  return { stream, seen };
}
const H = (n) => n.toString(16).padStart(64, '0');
const ROUTES = [
  ['GET', 'index'], ['GET', 'status'], ['GET', 'trash'], ['POST', 'trash/restore'], ['POST', 'blobs/missing'],
  ['GET', 'thread/abc'], ['POST', 'thread/abc'], ['DELETE', 'thread/abc'], ['GET', `blob/${H(1)}`], ['PUT', `blob/${H(1)}`],
];

// ── module rules ──
test('src/sync.js imports only the shared merge core and never touches LEDGER, ATELIER_KV or cookies', () => {
  const imports = [...syncSrc.matchAll(/^\s*import[\s\S]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['../public/sync-merge.js']);
  const code = syncSrc.replace(/\/\/.*$/gm, '');
  assert.ok(!/LEDGER|ATELIER_KV|cookie|cloudflare:workers/i.test(code));
  assert.ok(!/\b429\b/.test(code), 'sync routes never answer 429');
});

// ── availability ──
test('no SYNC_BUCKET → 503 sync_unconfigured on every route; SYNC_DISABLED → 503 sync_disabled before any body read', async () => {
  for (const [method, sub] of [...ROUTES, ['GET', 'nope'], ['PATCH', 'index']]) {
    const r = await call({}, method, sub, method === 'GET' ? {} : { body: '{}' });
    assert.equal(r.status, 503, `${method} ${sub}`);
    assert.equal(await codeOf(r), 'sync_unconfigured');
  }
  for (const v of ['1', 'true', 'yes']) {
    const env = syncEnv({ SYNC_DISABLED: v });
    for (const [method, sub] of ROUTES) {
      const { stream, seen } = watchedBody();
      const r = await call(env, method, sub, method === 'GET' ? {} : { body: stream, headers: { 'content-length': '2', 'content-type': 'image/png' } });
      assert.equal(r.status, 503, `${method} ${sub}`);
      assert.equal(await codeOf(r), 'sync_disabled');
      assert.equal(seen.pulled, false, `${method} ${sub} read the body`);
      assert.equal(r.headers.get('cache-control'), 'private, no-store');
    }
    assert.equal(env.SYNC_BUCKET.totalCalls(), 0);
  }
  for (const v of ['', '0', 'false']) assert.equal((await call(syncEnv({ SYNC_DISABLED: v }), 'GET', 'status')).status, 200, `SYNC_DISABLED=${JSON.stringify(v)}`);
});

// ── routing and validation ──
test('unknown paths and malformed ids or hashes → 404; a known path with the wrong method → 405 with Allow', async () => {
  const env = syncEnv();
  for (const sub of ['', 'thread', 'thread/', 'thread/a/b', `thread/${'a'.repeat(121)}`, 'thread/a.b', 'thread/%2e%2e', 'blob/', `blob/${'a'.repeat(63)}`,
    `blob/${'a'.repeat(65)}`, `blob/${'A'.repeat(64)}`, `blob/${'g'.repeat(64)}`, 'index/x', 'trash/x', 'nope']) {
    const r = await call(env, 'GET', sub);
    assert.equal(r.status, 404, sub);
    assert.equal(await codeOf(r), 'not_found', sub);
  }
  assert.equal((await call(env, 'GET', `thread/${'a'.repeat(120)}`)).status, 404, 'a valid id with no document');
  for (const [method, sub, allow] of [['PUT', 'thread/abc', 'GET, POST, DELETE'], ['POST', 'index', 'GET'], ['GET', 'trash/restore', 'POST'], ['POST', `blob/${H(1)}`, 'GET, PUT'], ['DELETE', 'status', 'GET']]) {
    const r = await call(env, method, sub, method === 'GET' ? {} : { body: '{}' });
    assert.equal(r.status, 405, `${method} ${sub}`);
    assert.equal(r.headers.get('allow'), allow);
  }
  assert.equal(env.SYNC_BUCKET.calls.put, 0);
});

test('every handler fails cleanly (4xx, never 429 or 5xx) on an empty, "{}" or non-JSON body', async () => {
  const env = syncEnv();
  for (const [method, sub] of ROUTES) {
    if (method === 'GET') continue;
    for (const body of ['', '{}', 'not json', '[]', 'null']) {
      const r = await call(env, method, sub, { body });
      assert.ok(r.status >= 400 && r.status < 500 && r.status !== 429, `${method} ${sub} ${JSON.stringify(body)} → ${r.status}`);
      assert.match(r.headers.get('content-type'), /application\/json/);
      assert.ok(typeof (await bodyOf(r)).code === 'string');
    }
  }
  assert.deepEqual(env.SYNC_BUCKET.keys('t/'), []);
});

test('a declared Content-Length over the cap → 413 without reading the body', async () => {
  const env = syncEnv();
  for (const [method, sub, cap] of [['POST', 'thread/abc', LIMITS.pushBody], ['DELETE', 'thread/abc', LIMITS.deleteBody], ['POST', 'trash/restore', LIMITS.restoreBody], ['POST', 'blobs/missing', LIMITS.missingBody], ['PUT', `blob/${H(1)}`, LIMITS.blob]]) {
    const { stream, seen } = watchedBody();
    const r = await call(env, method, sub, { body: stream, headers: { 'content-length': String(cap + 1), 'content-type': 'image/png' } });
    assert.equal(r.status, 413, `${method} ${sub}`);
    assert.equal(seen.pulled, false, `${method} ${sub} pulled the body`);
  }
  // no declared length: the running cap still stops it
  const big = JSON.stringify({ v: 1, createdAt: 1, entries: [], pad: 'x'.repeat(LIMITS.restoreBody) });
  const chunks = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); } });
  assert.equal((await call(env, 'POST', 'trash/restore', { body: chunks })).status, 413);
});

// ── blobs ──
test('blob PUT: allow-listed types, required length, sha256 enforced, idempotent; GET serves an inert attachment', async () => {
  const env = syncEnv();
  const bytes = new TextEncoder().encode('fake png bytes');
  const hash = await sha256hex(bytes);
  const noLength = await call(env, 'PUT', `blob/${hash}`, { body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }), headers: { 'content-type': 'image/png' } });
  assert.equal(noLength.status, 411);
  assert.equal(await codeOf(noLength), 'length_required');
  for (const type of ['image/svg+xml', 'application/octet-stream', 'text/html', '', 'text/plain', 'video/quicktime']) {
    const r = await putBlob(env, hash, bytes, type);
    assert.equal(r.status, 415, type);
    assert.equal(await codeOf(r), 'bad_type');
  }
  const wrong = await putBlob(env, H(7), bytes);
  assert.equal(wrong.status, 400);
  assert.equal(await codeOf(wrong), 'hash_mismatch');
  assert.deepEqual(env.SYNC_BUCKET.keys('b/'), [], 'nothing stored');
  const ok = await putBlob(env, hash, bytes, 'IMAGE/PNG');
  assert.equal(ok.status, 201);
  assert.deepEqual(await bodyOf(ok), { v: 1, created: true });
  assert.deepEqual(env.SYNC_BUCKET.keys('b/'), [`b/${hash.slice(0, 2)}/${hash}`]);
  const again = await putBlob(env, hash, bytes);
  assert.equal(again.status, 200);
  assert.deepEqual(await bodyOf(again), { v: 1, exists: true });
  const got = await call(env, 'GET', `blob/${hash}`);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'image/png');
  assert.equal(got.headers.get('content-length'), String(bytes.byteLength));
  assert.equal(got.headers.get('etag'), `"${hash}"`);
  assert.equal(got.headers.get('content-disposition'), 'attachment');
  assert.equal(got.headers.get('content-security-policy'), 'sandbox');
  assert.equal(got.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(new Uint8Array(await got.arrayBuffer()), bytes);
  assert.equal((await call(env, 'GET', `blob/${H(9)}`)).status, 404);
  // long text travels as text/plain;charset=utf-8 (spacing and case folded)
  const text = new TextEncoder().encode('é'.repeat(20_000));
  const th = await sha256hex(text);
  assert.equal((await putBlob(env, th, text, 'Text/Plain; charset=UTF-8')).status, 201);
  assert.equal((await call(env, 'GET', `blob/${th}`)).headers.get('content-type'), TEXT_TYPE);
  // a stored type outside the allow-list is served as octet-stream
  await env.SYNC_BUCKET.put(`b/${H(3).slice(0, 2)}/${H(3)}`, 'x', { httpMetadata: { contentType: 'text/html' } });
  assert.equal((await call(env, 'GET', `blob/${H(3)}`)).headers.get('content-type'), 'application/octet-stream');
});

test('blob PUT stops at the quota with 507 (cached usage, recounted when stale); status reports it', async () => {
  const env = syncEnv({ SYNC_QUOTA_BYTES: '20' });
  const a = new TextEncoder().encode('0123456789'), b = new TextEncoder().encode('abcdefghij'), c = new TextEncoder().encode('X');
  assert.equal((await putBlob(env, await sha256hex(a), a)).status, 201);
  assert.equal((await putBlob(env, await sha256hex(b), b)).status, 201);
  const full = await putBlob(env, await sha256hex(c), c);
  assert.equal(full.status, 507);
  assert.deepEqual(await bodyOf(full), { error: 'The server’s sync storage is full. New media stays on this device.', code: 'quota', quota: 20, bytes: 20 });
  const status = await bodyOf(await call(env, 'GET', 'status'));
  assert.deepEqual({ blobs: status.blobs, bytes: status.bytes, quota: status.quota }, { blobs: 2, bytes: 20, quota: 20 });
  // the cache is corrected by a recount once it is older than 15 minutes
  await env.SYNC_BUCKET.delete(`b/${(await sha256hex(a)).slice(0, 2)}/${await sha256hex(a)}`);
  assert.equal((await putBlob(env, await sha256hex(c), c)).status, 507, 'still cached');
  clock += SYNC_OPTIONS.usagePutMaxAgeMs + 1;
  assert.equal((await putBlob(env, await sha256hex(c), c)).status, 201);
  assert.equal((await bodyOf(await call(syncEnv(), 'GET', 'status'))).quota, SYNC_OPTIONS.quotaBytes, 'default 50 GiB');
});

// Real R2 (2026-10-01): of 6 simultaneous PUTs of one new blob, one was refused with 10058 and answered 500.
test('blob PUT refused by R2 as a concurrent write (10058): 200 exists when the other upload landed, else 503 sync_busy', async () => {
  const env = syncEnv();
  const r2 = env.SYNC_BUCKET;
  const bytes = new TextEncoder().encode('one blob, two uploads at once');
  const hash = await sha256hex(bytes);
  const key = `b/${hash.slice(0, 2)}/${hash}`;
  // the other upload is still on the wire (nothing stored yet): busy, the client retries after Retry-After
  r2.faults.rateLimitNextPut = 1;
  r2.faults.rateLimitKey = key;
  const busy = await putBlob(env, hash, bytes);
  assert.equal(busy.status, 503);
  assert.equal(await codeOf(busy), 'sync_busy');
  assert.equal(busy.headers.get('retry-after'), String(SYNC_OPTIONS.retryAfterSec));
  assert.equal(r2.faults.rateLimitNextPut, 0, 'the 10058 hit the blob write');
  assert.deepEqual(r2.keys('b/'), []);
  assert.equal(r2.json('u/usage.json').bytes, 0, 'nothing counted');
  // the other upload landed first: this one's 10058 means "already stored"
  r2.faults.rateLimitNextPut = 1;
  r2.faults.beforePut = async (k) => {
    if (k !== key) return;
    r2.faults.beforePut = null;
    const n = r2.faults.rateLimitNextPut;
    r2.faults.rateLimitNextPut = 0;
    await r2.put(key, bytes, { sha256: hash, httpMetadata: { contentType: 'image/png' }, customMetadata: { t: 'image/png' } }); // the other device
    r2.faults.rateLimitNextPut = n;
  };
  const exists = await putBlob(env, hash, bytes);
  assert.equal(exists.status, 200);
  assert.deepEqual(await bodyOf(exists), { v: 1, exists: true });
  assert.equal(r2.faults.rateLimitNextPut, 0, 'the 10058 hit this request’s write');
  assert.deepEqual(r2.keys('b/'), [key]);
  assert.equal(r2.json('u/usage.json').bytes, 0, 'not counted by the request that didn’t store it');
  assert.deepEqual(await bodyOf(await putBlob(env, hash, bytes)), { v: 1, exists: true }, 'a retry finds it as well');
  assert.deepEqual(sleeps, [], 'no waiting inside the request');
});

test('the R2 fake is as strict as real R2: quoted conditional etags and streams of unknown length throw TypeError; a checksum mismatch gives the full 10037 text', async () => {
  const r2 = fakeR2();
  const first = await r2.put('k', 'v1');
  await assert.rejects(r2.put('k', 'v2', { onlyIf: { etagMatches: `"${first.etag}"` } }), (e) => e instanceof TypeError && e.message === `Conditional ETag should not be wrapped in quotes ("${first.etag}").`);
  await assert.rejects(r2.put('k', 'v2', { onlyIf: { etagDoesNotMatch: first.httpEtag } }), TypeError);
  assert.equal(r2.text('k'), 'v1');
  assert.equal(r2.calls.put, 1, 'refused before any request');
  const second = await r2.put('k', 'v2', { onlyIf: { etagMatches: first.etag } });
  assert.ok(second, 'the unquoted R2Object.etag matches');
  assert.equal(await r2.put('k', 'v3', { onlyIf: { etagMatches: first.etag } }), null, 'a stale etag loses with null, not an error');
  const stream = () => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('abc')); c.close(); } });
  await assert.rejects(r2.put('s', stream()), (e) => e instanceof TypeError && e.message === 'Provided readable stream must have a known length (request/response body or readable half of FixedLengthStream)');
  assert.equal(r2.has('s'), false);
  assert.ok(await r2.put('s', knownLength(stream())), 'a stream marked as known-length (FixedLengthStream) is accepted');
  const sized = workerRequest('https://atelier.test/x', { method: 'PUT', body: 'abc', headers: { 'content-length': '3' } });
  assert.ok(await r2.put('r', sized.body), 'a request body with a Content-Length has a known length');
  const chunked = workerRequest('https://atelier.test/x', { method: 'PUT', body: stream(), duplex: 'half' });
  await assert.rejects(r2.put('c', chunked.body), TypeError, 'without a Content-Length it has none');
  const piped = workerRequest('https://atelier.test/x', { method: 'PUT', body: 'abc', headers: { 'content-length': '3' } }).body.pipeThrough(new TransformStream());
  await assert.rejects(r2.put('c', piped), TypeError, 'nor does a request body piped through anything');
  const sha = await sha256hex(new TextEncoder().encode('abc'));
  await assert.rejects(r2.put('h', 'abc', { sha256: '0'.repeat(64) }), (e) => e.message === `put: The SHA-256 checksum you specified did not match what we received.\nYou provided a SHA-256 checksum with value: ${'0'.repeat(64)}\nActual SHA-256 was: ${sha} (10037)`);
  assert.equal(r2.has('h'), false);
  assert.ok(await r2.put('h', 'abc', { sha256: sha.toUpperCase() }), 'R2 accepts an upper-case checksum');
});

test('blobs/missing reports which hashes have no blob (deduplicated, at most 1000, hashes checked)', async () => {
  const env = syncEnv();
  const bytes = new TextEncoder().encode('present');
  const have = await sha256hex(bytes);
  await putBlob(env, have, bytes);
  const r = await call(env, 'POST', 'blobs/missing', { body: { hashes: [have, H(1), H(1), H(2)] } });
  assert.deepEqual(await bodyOf(r), { v: 1, missing: [H(1), H(2)] });
  for (const hashes of [[H(0xabc).toUpperCase()], [H(1).slice(1)], 'x', Array.from({ length: 1001 }, (_, i) => H(i)), [1]]) {
    assert.equal((await call(env, 'POST', 'blobs/missing', { body: { hashes } })).status, 400);
  }
  assert.deepEqual(await bodyOf(await call(env, 'POST', 'blobs/missing', { body: { hashes: [] } })), { v: 1, missing: [] });
});

// ── push ──
test('push: create, idempotent resend, fast-forward and the response shape', async () => {
  const env = syncEnv();
  const r = await push(env, 't1', [ask('e1', 2), ask('e2', 3)], { title: { v: 'Hello', base: 0 }, createdAt: 2 });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'private, no-store');
  const res = await bodyOf(r);
  assert.deepEqual({ ...res, changedAt: 0, etag: 0 }, { v: 1, rev: 1, prevRev: 0, born: NOW, changedAt: 0, deletedAt: null, revived: false, title: { v: 'Hello', rev: 1 }, accepted: { e1: 1, e2: 1 }, stale: [], conflicts: [], dropped: [], etag: 0 });
  assert.equal(res.changedAt, NOW);
  assert.match(res.etag, /^[0-9a-f]{32}$/);
  const doc = env.SYNC_BUCKET.json('t/t1.json');
  assert.deepEqual([doc.v, doc.id, doc.rev, doc.title, doc.entries.length], [1, 't1', 1, 'Hello', 2]);
  assert.deepEqual(env.SYNC_BUCKET.metaOf('t/t1.json'), { v: '1', rev: '1', at: String(NOW), del: '0', n: '2', snap: '0', born: String(NOW) });
  const puts = env.SYNC_BUCKET.calls.put;
  const again = await bodyOf(await push(env, 't1', [ask('e1', 2), ask('e2', 3)], { title: { v: 'Hello', base: 0 }, createdAt: 2 }));
  assert.deepEqual([again.rev, again.prevRev, again.accepted, again.etag], [1, 1, { e1: 1, e2: 1 }, res.etag]);
  assert.equal(env.SYNC_BUCKET.calls.put, puts, 'nothing written');
  clock += 1000;
  const ff = await bodyOf(await push(env, 't1', [ask('e1', 2, 'edited')], { bases: { e1: 1 }, createdAt: 2 }));
  assert.deepEqual([ff.rev, ff.prevRev, ff.accepted], [2, 1, { e1: 2 }]);
  const conflict = await bodyOf(await push(env, 't1', [ask('e1', 2, 'other')], { bases: { e1: 1 }, createdAt: 2 }));
  assert.deepEqual(conflict.conflicts.map((v) => [v.id, v.rev, v.d.text]), [['e1', 2, 'edited']]);
});

test('push validation: 400 bad shape / bad id / hash mismatch, 422 pending or live steps, 413 entry or thread too large', async () => {
  const env = syncEnv();
  const good = await pushBody([ask('e1', 1)]);
  const variants = [
    [{ ...good, v: 2 }, 400, 'bad_shape'],
    [{ ...good, entries: [{ ...good.entries[0], h: H(5) }] }, 400, 'hash_mismatch'],
    [{ ...good, entries: [{ ...good.entries[0], d: { ...good.entries[0].d, id: 'e2' } }] }, 400, 'bad_id'],
    [{ ...good, entries: [good.entries[0], good.entries[0]] }, 400, 'bad_id'],
    [await pushBody([{ ...ask('e1', 1), images: [] }]).then((b) => ({ ...b, entries: [{ ...b.entries[0], d: { ...b.entries[0].d, images: ['data:image/png;base64,YQ=='] } }] })), 400, 'bad_shape'],
    [await pushBody([ask('e1', 1)]).then((b) => ({ ...b, entries: [{ ...b.entries[0], d: { ...b.entries[0].d, pending: true } }] })), 422, 'pending'],
    [await pushBody([{ ...ask('e1', 1), steps: [{ status: 'awaiting' }] }]), 422, 'live_steps'],
  ];
  for (const [body, status, code] of variants) {
    const r = await call(env, 'POST', 'thread/t1', { body });
    assert.equal(r.status, status, code);
    assert.equal(await codeOf(r), code);
  }
  // hash checked after JSON transport: a body built from the dehydrated d, sent as JSON, verifies
  assert.equal((await call(env, 'POST', 'thread/t1', { body: JSON.stringify(good) })).status, 200);
  // one entry over 2 MiB of canonical JSON → 413 (the client holds such entries; this is the backstop)
  const fat = { ...ask('f1', 1), params: Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`k${i}`, 'z'.repeat(INLINE_MAX - 1)])) };
  const fatBody = { v: 1, createdAt: 1, entries: [{ id: 'f1', base: 0, createdAt: 1, h: H(0), d: fat }] };
  const tooBig = await call(env, 'POST', 'thread/t1', { body: fatBody });
  assert.equal(tooBig.status, 413);
  assert.equal(await codeOf(tooBig), 'too_large');
  // a document over 8 MiB → 413 thread_too_large, nothing written
  const chunk = (i) => ({ ...ask(`c${i}`, 10 + i), params: Object.fromEntries(Array.from({ length: 60 }, (_, j) => [`k${j}`, 'z'.repeat(32_000)])) });
  for (let i = 0; i < 4; i++) assert.equal((await push(env, 'big', [chunk(i)])).status, 200);
  const before = env.SYNC_BUCKET.json('t/big.json').rev;
  const over = await push(env, 'big', [chunk(9)]);
  assert.equal(over.status, 413);
  assert.equal(await codeOf(over), 'thread_too_large');
  assert.equal(env.SYNC_BUCKET.json('t/big.json').rev, before);
});

test('push: a ref to a blob the server lacks → 409 missing_blobs and nothing written; after the upload it lands', async () => {
  const env = syncEnv();
  const e = { ...ask('e1', 1), kind: 'build', app: { html: '<p>'.repeat(20_000), title: 'App' } };
  const x = await dehydrate(e);
  const [blob] = x.blobs;
  const r = await push(env, 't1', [e]);
  assert.equal(r.status, 409);
  assert.deepEqual(await bodyOf(r), { error: 'Some media or long text hasn’t been uploaded yet.', code: 'missing_blobs', missing: [blob.hash] });
  assert.deepEqual(env.SYNC_BUCKET.keys('t/'), []);
  assert.equal((await putBlob(env, blob.hash, blob.bytes(), blob.type)).status, 201);
  assert.equal((await push(env, 't1', [e])).status, 200);
  // later edits that keep the same blob don't need it checked again
  env.SYNC_BUCKET.resetCalls();
  assert.equal((await push(env, 't1', [{ ...e, prompt: 'renamed prompt' }], { bases: { e1: 1 } })).status, 200);
  assert.equal(env.SYNC_BUCKET.calls.head, 0);
});

// ── concurrency ──
test('two pushes to one thread at the same moment both land (the loser re-reads and retries)', async () => {
  const env = syncEnv();
  assert.equal((await push(env, 't1', [ask('e1', 1)])).status, 200);
  let raced = false;
  env.SYNC_BUCKET.faults.beforePut = async (key) => {
    if (key !== 't/t1.json' || raced) return;
    raced = true; // another device's push lands between this request's read and its write
    const other = await push(env, 't1', [ask('e3', 3)]);
    assert.equal(other.status, 200);
  };
  const r = await push(env, 't1', [ask('e2', 2)]);
  assert.equal(r.status, 200);
  const res = await bodyOf(r);
  assert.deepEqual([res.rev, res.prevRev, res.accepted], [3, 2, { e2: 1 }]);
  assert.deepEqual(env.SYNC_BUCKET.json('t/t1.json').entries.map((e) => e.id), ['e1', 'e2', 'e3']);
  assert.deepEqual(sleeps, [100], 'one jittered retry');
  // and a plain race with no hook: both still land
  env.SYNC_BUCKET.faults.beforePut = null;
  const [a, b] = await Promise.all([push(env, 't1', [ask('e4', 4)]), push(env, 't1', [ask('e5', 5)])]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.deepEqual(env.SYNC_BUCKET.json('t/t1.json').entries.map((e) => e.id), ['e1', 'e2', 'e3', 'e4', 'e5']);
});

test('failNextCas forces retries; five failures → 503 sync_busy with Retry-After; a rate limit waits 1.1 s', async () => {
  const env = syncEnv();
  assert.equal((await push(env, 't1', [ask('e1', 1)])).status, 200);
  env.SYNC_BUCKET.faults.failNextCas = 2;
  assert.equal((await push(env, 't1', [ask('e2', 2)])).status, 200);
  assert.deepEqual(sleeps, [100, 100]);
  sleeps.length = 0;
  env.SYNC_BUCKET.faults.failNextCas = SYNC_OPTIONS.casAttempts;
  const busy = await push(env, 't1', [ask('e3', 3)]);
  assert.equal(busy.status, 503);
  assert.equal(await codeOf(busy), 'sync_busy');
  assert.equal(busy.headers.get('retry-after'), '2');
  assert.equal(sleeps.length, SYNC_OPTIONS.casAttempts - 1);
  assert.deepEqual(env.SYNC_BUCKET.json('t/t1.json').entries.map((e) => e.id), ['e1', 'e2']);
  sleeps.length = 0;
  env.SYNC_BUCKET.faults.rateLimitNextPut = 1;
  env.SYNC_BUCKET.faults.rateLimitKey = 't/t1.json';
  assert.equal((await push(env, 't1', [ask('e3', 3)])).status, 200);
  assert.deepEqual(sleeps, [SYNC_OPTIONS.rateLimitWaitMs]);
});

test('compare-and-swap retries wait longer each attempt (the jitter grows with the attempt number)', async () => {
  for (let i = 0; i < 200; i++) {
    const a1 = real.jitter(1), a4 = real.jitter(4), none = real.jitter();
    assert.ok(a1 >= 50 && a1 < 300, `attempt 1: ${a1}`);
    assert.ok(a4 >= 200 && a4 < 1200, `attempt 4: ${a4}`);
    assert.ok(none >= 50 && none < 300, `no attempt number: ${none}`);
  }
  const env = syncEnv();
  const seen = [];
  SYNC_TIMING.jitter = (n) => { seen.push(n); return 100; };
  assert.equal((await push(env, 't1', [ask('e1', 1)])).status, 200);
  env.SYNC_BUCKET.faults.failNextCas = 3;
  assert.equal((await push(env, 't1', [ask('e2', 2)])).status, 200);
  assert.deepEqual(seen, [1, 2, 3], 'casLoop passes the attempt number');
});

test('a write whose response R2 dropped is found applied on the re-read and answered without writing twice', async () => {
  const env = syncEnv();
  assert.equal((await push(env, 't1', [ask('e1', 1)])).status, 200);
  env.SYNC_BUCKET.faults.dropNextPut = 1;
  const r = await push(env, 't1', [ask('e2', 2)]);
  assert.equal(r.status, 200);
  const res = await bodyOf(r);
  assert.deepEqual(res.accepted, { e2: 1 });
  assert.equal(res.rev, 2);
  assert.equal(env.SYNC_BUCKET.json('t/t1.json').rev, 2);
});

// ── reads ──
test('index: one row per thread from list() metadata, ETag 304, pagination across truncated pages', async () => {
  const env = syncEnv();
  env.SYNC_BUCKET = fakeR2({ pageSize: 2 });
  for (const id of ['a1', 'b2', 'c3', 'd4', 'e5']) assert.equal((await push(env, id, [ask(`${id}x`, 1)])).status, 200);
  env.SYNC_BUCKET.resetCalls();
  const r = await call(env, 'GET', 'index');
  const idx = await bodyOf(r);
  assert.equal(idx.v, 1);
  assert.equal(idx.now, NOW);
  assert.deepEqual(idx.threads.map((t) => t[0]), ['a1', 'b2', 'c3', 'd4', 'e5']);
  assert.deepEqual(idx.threads[0].slice(2), [1, NOW, 0, NOW], 'rev, changedAt, deleted, born (the lineage)');
  assert.equal(idx.threads[0][1], env.SYNC_BUCKET.objects.get('t/a1.json').etag);
  assert.equal(env.SYNC_BUCKET.calls.list, 3, 'three pages of two');
  assert.equal(env.SYNC_BUCKET.calls.get, 0, 'no document bodies read');
  const etag = r.headers.get('etag');
  assert.match(etag, /^"[0-9a-f]{32}"$/);
  clock += 5000; // now changes, the list doesn't
  const cached = await call(env, 'GET', 'index', { headers: { 'if-none-match': etag } });
  assert.equal(cached.status, 304);
  assert.equal(await cached.text(), '');
  assert.equal((await call(env, 'GET', 'index', { headers: { 'if-none-match': `W/${etag}` } })).status, 304);
  assert.equal((await push(env, 'c3', [ask('c3y', 2)])).status, 200);
  const fresh = await call(env, 'GET', 'index', { headers: { 'if-none-match': etag } });
  assert.equal(fresh.status, 200);
  assert.notEqual(fresh.headers.get('etag'), etag);
});

test('GET thread: full document, delta since a rev, complete gone map; 400 on a bad since; 404 when absent', async () => {
  const env = syncEnv();
  await push(env, 't1', [ask('e1', 1), ask('e2', 2), ask('e3', 3)], { title: { v: 'T', base: 0 } });
  await push(env, 't1', [ask('e2', 2, 'v2')], { bases: { e2: 1 } });
  await call(env, 'DELETE', 'thread/t1', { body: { v: 1, seen: { e3: 1 } } });
  const full = await bodyOf(await call(env, 'GET', 'thread/t1'));
  assert.deepEqual([full.v, full.id, full.rev, full.full, full.title, full.titleRev], [1, 't1', 3, true, 'T', 1]);
  assert.deepEqual(full.entries.map((e) => [e.id, e.rev, e.s]), [['e1', 1, 1], ['e2', 2, 2]]);
  assert.equal('hh' in full.entries[0], false);
  assert.equal(full.etag, env.SYNC_BUCKET.objects.get('t/t1.json').etag);
  const delta = await bodyOf(await call(env, 'GET', 'thread/t1', { query: '?since=1' }));
  assert.deepEqual([delta.full, delta.entries.map((e) => e.id), delta.gone], [false, ['e2'], { e3: 1 }]);
  assert.deepEqual((await bodyOf(await call(env, 'GET', 'thread/t1', { query: '?since=3' }))).entries, []);
  for (const q of ['?since=-1', '?since=abc', '?since=1.5', '?since=']) assert.equal((await call(env, 'GET', 'thread/t1', { query: q })).status, 400, q);
  assert.equal((await call(env, 'GET', 'thread/none')).status, 404);
});

test('history: a v/ snapshot of the previous document at most once per 15 minutes per thread', async () => {
  const env = syncEnv();
  await push(env, 't1', [ask('e1', 1)]); // create: nothing to snapshot
  clock += MIN; await push(env, 't1', [ask('e2', 2)]); // first overwrite → v/t1/1.json
  clock += MIN; await push(env, 't1', [ask('e3', 3)]); // 1 min later → none
  clock += 15 * MIN; await push(env, 't1', [ask('e4', 4)]); // 16 min after the last → v/t1/3.json
  assert.deepEqual(env.SYNC_BUCKET.keys('v/'), ['v/t1/1.json', 'v/t1/3.json']);
  assert.deepEqual(env.SYNC_BUCKET.json('v/t1/3.json').entries.map((e) => e.id), ['e1', 'e2', 'e3']);
  assert.equal(env.SYNC_BUCKET.metaOf('t/t1.json').snap, String(clock));
  // a failed snapshot never fails the write
  clock += 20 * MIN;
  env.SYNC_BUCKET.faults.beforePut = async (key) => { if (key.startsWith('v/')) throw new Error('snapshot store down'); };
  assert.equal((await push(env, 't1', [ask('e5', 5)])).status, 200);
});

// ── delete, trash, restore ──
test('delete is rev-aware, writes the pre-image to the trash first, and restore brings it back', async () => {
  const env = syncEnv();
  await push(env, 't1', [ask('e1', 1), ask('e2', 2), ask('e3', 3)], { title: { v: 'Holiday “plans”', base: 0 } });
  await push(env, 't1', [ask('e2', 2, 'changed on the phone')], { bases: { e2: 1 } }); // e2 → rev 2
  clock += 1000;
  const first = await bodyOf(await call(env, 'DELETE', 'thread/t1', { body: { v: 1, seen: { e1: 1, e2: 1, e3: 1 } } }));
  assert.deepEqual({ ...first, etag: 0 }, { v: 1, rev: 3, etag: 0, deleted: false, kept: 1, removed: 2, trashKey: `x/t1/${clock}.json` });
  const trashed = env.SYNC_BUCKET.json(first.trashKey);
  assert.deepEqual(trashed.entries.map((e) => e.id), ['e1', 'e2', 'e3'], 'the document as it was');
  assert.equal(env.SYNC_BUCKET.log.findIndex(([op, k]) => op === 'put' && k === first.trashKey) < env.SYNC_BUCKET.log.findLastIndex(([op, k]) => op === 'put' && k === 't/t1.json'), true, 'trash before the write');
  assert.deepEqual(env.SYNC_BUCKET.json('t/t1.json').entries.map((e) => e.id), ['e2'], 'the edit made after the deleter looked is kept');
  const again = await bodyOf(await call(env, 'DELETE', 'thread/t1', { body: { v: 1, seen: { e1: 1, e3: 1 } } }));
  assert.deepEqual([again.removed, again.trashKey, again.rev], [0, null, 3], 'repeat: no-op');
  clock += 1000;
  const second = await bodyOf(await call(env, 'DELETE', 'thread/t1', { body: { v: 1, seen: { e2: 2 } } }));
  assert.deepEqual([second.deleted, second.removed, second.kept], [true, 1, 0]);
  const tomb = env.SYNC_BUCKET.json('t/t1.json');
  assert.deepEqual([tomb.title, tomb.entries.length, tomb.deletedAt, tomb.gone], ['', 0, clock, { e1: 1, e2: 2, e3: 1 }]);
  assert.deepEqual((await bodyOf(await call(env, 'GET', 'index'))).threads.map((t) => [t[0], t[4]]), [['t1', 1]]);
  const trash = await bodyOf(await call(env, 'GET', 'trash'));
  assert.deepEqual(trash.items.map((i) => [i.key, i.id, i.title, i.deletedAt, i.n]), [
    [second.trashKey, 't1', 'Holiday “plans”', clock, 1],
    [first.trashKey, 't1', 'Holiday “plans”', clock - 1000, 2],
  ]);
  // restore the first delete: e1 and e3 come back with bumped revs, the title returns, the thread revives
  clock += 1000;
  const restored = await bodyOf(await call(env, 'POST', 'trash/restore', { body: { key: first.trashKey } }));
  // every snapshot entry that is absent now comes back, e2 (removed by the later delete) included
  assert.deepEqual({ ...restored, etag: 0 }, { v: 1, id: 't1', rev: 5, etag: 0, restored: 3, title: 'Holiday “plans”' });
  const doc = env.SYNC_BUCKET.json('t/t1.json');
  assert.deepEqual([doc.deletedAt, doc.gone, doc.entries.map((e) => [e.id, e.rev, e.s, e.d.text])], [null, {}, [['e1', 2, 5, 'answer e1'], ['e2', 3, 5, 'changed on the phone'], ['e3', 2, 5, 'answer e3']]]);
  assert.equal(env.SYNC_BUCKET.has(first.trashKey), false, 'the trash item is gone');
  assert.ok(env.SYNC_BUCKET.has('v/t1/4.json'), 'a snapshot before the restore');
  assert.equal((await call(env, 'POST', 'trash/restore', { body: { key: first.trashKey } })).status, 404);
  const nothing = await bodyOf(await call(env, 'POST', 'trash/restore', { body: { key: second.trashKey } }));
  assert.deepEqual([nothing.restored, nothing.rev, env.SYNC_BUCKET.has(second.trashKey)], [0, 5, false], 'nothing absent: the item just goes');
  assert.equal((await call(env, 'POST', 'trash/restore', { body: { key: 'x/t1/123.json' } })).status, 400);
  assert.equal((await call(env, 'POST', 'trash/restore', { body: { key: 't/t1.json' } })).status, 400);
  assert.equal((await call(env, 'DELETE', 'thread/none', { body: { v: 1, seen: {} } })).status, 404);
  assert.equal((await call(env, 'DELETE', 'thread/t1', { body: { v: 1, seen: { e1: 'x' } } })).status, 400);
});

test('trash lists only the last 30 days, newest first; older items cannot be restored', async () => {
  const env = syncEnv();
  for (const [i, id] of ['old', 'mid', 'new'].entries()) {
    if (i) clock += 10 * DAY;
    await push(env, id, [ask(`${id}1`, 1)], { title: { v: `Thread ${id}`, base: 0 } });
    await call(env, 'DELETE', `thread/${id}`, { body: { v: 1, seen: { [`${id}1`]: 1 } } });
  }
  clock += 10 * DAY - 1; // 'old' is 1 ms short of 30 days
  const items = (await bodyOf(await call(env, 'GET', 'trash'))).items;
  assert.deepEqual(items.map((i) => i.id), ['new', 'mid', 'old']);
  clock += 1; // 'old' is now exactly 30 days old
  const later = (await bodyOf(await call(env, 'GET', 'trash'))).items;
  assert.deepEqual(later.map((i) => i.id), ['new', 'mid']);
  const oldKey = items[2].key;
  assert.ok(env.SYNC_BUCKET.has(oldKey), 'hidden, not deleted (lifecycle rules tidy up)');
  assert.equal((await call(env, 'POST', 'trash/restore', { body: { key: oldKey } })).status, 404);
  assert.equal((await bodyOf(await call(env, 'GET', 'status'))).trash, 2);
});

test('a delete that can’t land removes its trash object; status counts live and deleted threads', async () => {
  const env = syncEnv();
  await push(env, 't1', [ask('e1', 1)]);
  await push(env, 't2', [ask('f1', 1)]);
  env.SYNC_BUCKET.faults.failNextCas = SYNC_OPTIONS.casAttempts;
  const r = await call(env, 'DELETE', 'thread/t1', { body: { v: 1, seen: { e1: 1 } } });
  assert.equal(r.status, 503);
  assert.deepEqual(env.SYNC_BUCKET.keys('x/'), []);
  assert.equal((await call(env, 'DELETE', 'thread/t1', { body: { v: 1, seen: { e1: 1 } } })).status, 200);
  const s = await bodyOf(await call(env, 'GET', 'status'));
  assert.deepEqual({ ...s, at: 0 }, { v: 1, threads: 1, deleted: 1, trash: 1, blobs: 0, images: 0, videos: 0, bytes: 0, quota: SYNC_OPTIONS.quotaBytes, at: 0 });
});

test('a pushed new entry revives a deleted thread; edits to deleted entries are dropped', async () => {
  const env = syncEnv();
  await push(env, 't1', [ask('e1', 1)], { title: { v: 'T', base: 0 } });
  await call(env, 'DELETE', 'thread/t1', { body: { v: 1, seen: { e1: 1 } } });
  const late = await bodyOf(await push(env, 't1', [ask('e1', 1, 'edited offline')], { bases: { e1: 1 } }));
  assert.deepEqual([late.dropped, late.revived, late.deletedAt != null], [['e1'], false, true]);
  const back = await bodyOf(await push(env, 't1', [ask('e2', 2)], { title: { v: 'T again', base: 0 } }));
  assert.deepEqual([back.revived, back.deletedAt, back.title], [true, null, { v: 'T again', rev: 3 }]);
});

// Review finding: a push's bases are revisions of the lineage the pusher knew; the body says which (born). After the
// server lost a thread and a device re-created it, an older lineage's base never replaces anything.
test('push with born: a base from another lineage is a conflict, never a replace; a malformed born is 400', async () => {
  const env = syncEnv();
  clock = NOW + 2000;
  const made = await bodyOf(await push(env, 't1', [ask('e1', 1, 'pc edit')]));
  assert.deepEqual([made.born, made.accepted], [NOW + 2000, { e1: 1 }]);
  const stale = { ...(await pushBody([ask('e1', 1, 'phone edit')], { bases: { e1: 1 } })), born: NOW };
  const r = await bodyOf(await call(env, 'POST', 'thread/t1', { body: stale }));
  assert.deepEqual([r.conflicts.map((c) => c.id), r.accepted, r.rev], [['e1'], {}, 1]);
  assert.equal(env.SYNC_BUCKET.json('t/t1.json').entries[0].d.text, 'pc edit');
  const same = await bodyOf(await call(env, 'POST', 'thread/t1', { body: { ...stale, born: NOW + 2000 } }));
  assert.deepEqual([same.accepted, env.SYNC_BUCKET.json('t/t1.json').entries[0].d.text], [{ e1: 2 }, 'phone edit']);
  const bad = await call(env, 'POST', 'thread/t1', { body: { ...stale, born: 'yesterday' } });
  assert.deepEqual([bad.status, await codeOf(bad)], [400, 'bad_shape']);
});

// ── through the real worker: auth and tester isolation ──
const SAMPLES = ['sync', 'sync/index', 'sync/status', 'sync/trash', 'sync/trash/restore', 'sync/blobs/missing', 'sync/thread/abc', `sync/blob/${H(1)}`, 'sync/nope'];

test('a tester cookie gets 403 owner_only on every sync route, with no R2 or KV access', async () => {
  const { env, L } = makeEnv({ SYNC_BUCKET: fakeR2() });
  const t = await signIn(L, PROFILE());
  mockFetch([[/./, () => reply(500, { error: 'should not be called' })]]);
  for (const path of SAMPLES) {
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
      const r = await api(env, path, { method, ...(method === 'GET' ? {} : { body: '{}' }) }, { cookie: t.token });
      assert.equal(r.status, 403, `${method} ${path}`);
      assert.equal(await codeOf(r), 'owner_only');
    }
  }
  assert.equal(env.SYNC_BUCKET.totalCalls(), 0);
  assert.deepEqual([...env.ATELIER_KV.m.keys()], []);
});

test('a wrong passcode counts toward the IP lockout and never reaches R2', async () => {
  const { env } = makeEnv({ SYNC_BUCKET: fakeR2() });
  mockFetch([[/./, () => reply(500, { error: 'should not be called' })]]);
  const r = await api(env, 'sync/index', { method: 'GET' }, { pass: 'nope' });
  assert.equal(r.status, 401);
  assert.equal(env.ATELIER_KV.m.get('fail:unknown'), '1');
  assert.equal(env.SYNC_BUCKET.totalCalls(), 0);
});

test('the owner gets the same status with and without a tester cookie, and the Ledger is never called', async () => {
  const { env, L } = makeEnv({ SYNC_BUCKET: fakeR2() });
  const t = await signIn(L, PROFILE());
  mockFetch([[/./, () => reply(503, { error: 'stub' })]]);
  for (const path of SAMPLES) {
    for (const method of ['GET', 'POST', 'DELETE']) {
      const init = { method, ...(method === 'POST' ? { body: '{}' } : {}) };
      L.calls.length = 0;
      const withCookie = await api(env, path, init, { pass: 'pw', cookie: t.token });
      const plain = await api(env, path, init, { pass: 'pw' });
      assert.equal(withCookie.status, plain.status, `${method} ${path}`);
      assert.deepEqual(L.calls, [], `${method} ${path} touched the Ledger`);
    }
  }
});

test('wired: every sync route answers 401 sync_passcode without the passcode', wired, async () => {
  const { env } = makeEnv({ SYNC_BUCKET: fakeR2() });
  for (const path of SAMPLES) {
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
      const r = await api(env, path, { method, ...(method === 'GET' ? {} : { body: '{}' }) });
      assert.equal(r.status, 401, `${method} ${path}`);
      assert.equal(await codeOf(r), 'sync_passcode');
    }
  }
  assert.equal(env.SYNC_BUCKET.totalCalls(), 0);
});

test('wired: the owner reaches the sync routes; without a bucket they answer 503 sync_unconfigured', wired, async () => {
  const { env } = makeEnv({ SYNC_BUCKET: fakeR2() });
  const r = await api(env, 'sync/status', { method: 'GET' }, { pass: 'pw' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'private, no-store');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  const body = await bodyOf(await api(env, `sync/thread/t1`, { method: 'POST', body: await pushBody([ask('e1', 1)]) }, { pass: 'pw' }));
  assert.deepEqual(body.accepted, { e1: 1 });
  const { env: bare } = makeEnv();
  const off = await api(bare, 'sync/index', { method: 'GET' }, { pass: 'pw' });
  assert.equal(off.status, 503);
  assert.equal(await codeOf(off), 'sync_unconfigured');
  const blob = await api(env, `sync/blob/${H(1)}`, { method: 'GET' }, { pass: 'pw' });
  assert.equal(blob.status, 404);
});

test('status counts images and videos: kept up to date by each upload, and right after a recount', async () => {
  const env = syncEnv();
  const blob = async (s, type) => { const bytes = new TextEncoder().encode(s); return putBlob(env, await sha256hex(bytes), bytes, type); };
  assert.equal((await blob('a picture', 'image/png')).status, 201);
  assert.equal((await blob('another picture', 'image/webp')).status, 201);
  assert.equal((await blob('a clip', 'video/mp4')).status, 201);
  assert.equal((await blob('a long text', 'text/plain;charset=utf-8')).status, 201);
  const s = await bodyOf(await call(env, 'GET', 'status'));
  assert.deepEqual([s.blobs, s.images, s.videos], [4, 2, 1]);
  clock += 61 * 60_000; // the hourly recount reads every blob's type from its customMetadata
  const r = await bodyOf(await call(env, 'GET', 'status'));
  assert.deepEqual([r.blobs, r.images, r.videos, r.bytes], [4, 2, 1, 9 + 15 + 6 + 11]);
});
