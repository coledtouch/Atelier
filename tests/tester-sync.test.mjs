import { test } from 'node:test';
import assert from 'node:assert/strict';
import { worker, makeEnv, api, signIn, PROFILE, resetTesterCaches, sha256 } from './tester-env.mjs';
import { fakeR2, workerRequest } from './fake-r2.mjs';
import { FORMAT, dehydrate, sha256hex } from '../public/sync-merge.js';
import { SYNC_TIMING } from '../src/sync.js';
import { COOKIE } from '../src/tester/auth.js';

const { TESTER_SYNC_QUOTA_BYTES, TESTER_SYNC_MAX_THREADS, testerSyncBucket, handleTesterSync } = await import('../src/tester/sync.js');

async function setup(extra = {}) {
  resetTesterCaches();
  const bucket = fakeR2({ pageSize: 1 });
  const { env, L } = makeEnv({ SYNC_BUCKET: bucket, ...extra });
  const a = await signIn(L, PROFILE(9001)), b = await signIn(L, PROFILE(9002));
  return { env, L, bucket, a, b };
}
const call = (env, token, method, path, body) => api(env, `tester/sync/${path}`, { method, ...(body === undefined ? {} : { body }) }, { cookie: token });
async function pushBody(text, base = 0) {
  const entry = { id: 'same-entry', kind: 'ask', prompt: 'A prompt', text, createdAt: 1 };
  const x = await dehydrate(entry);
  return { v: FORMAT, createdAt: 1, title: { v: text, base }, entries: [{ id: entry.id, createdAt: entry.createdAt, base, h: x.h, d: x.d }] };
}
function blobCall(env, token, method, hash, bytes) {
  const headers = { cookie: `${COOKIE}=${token}` };
  if (method === 'PUT') Object.assign(headers, { origin: 'https://atelier.ciprari.ai', 'content-type': 'image/png', 'content-length': String(bytes.byteLength) });
  return worker.fetch(workerRequest(`https://atelier.ciprari.ai/api/tester/sync/blob/${hash}`, { method, headers, ...(method === 'PUT' ? { body: bytes } : {}) }), env);
}

test('tester sync uses the validated identity: matching IDs stay private and owner data stays unchanged', async () => {
  const { env, bucket, a, b } = await setup();
  const ownerBody = await pushBody('Owner answer');
  assert.equal((await api(env, 'sync/thread/same-thread', { method: 'POST', body: ownerBody }, { pass: 'pw' })).status, 200);
  const ownerBefore = bucket.text('t/same-thread.json');
  for (const [tester, text] of [[a, 'Tester A answer'], [b, 'Tester B answer']]) {
    const body = await pushBody(text);
    body.sub = b.sub; body.namespace = 't/'; // neither body field can select an account
    assert.equal((await call(env, tester.token, 'POST', 'thread/same-thread', body)).status, 200);
  }
  for (const [tester, text] of [[a, 'Tester A answer'], [b, 'Tester B answer']]) {
    const j = await (await call(env, tester.token, 'GET', 'thread/same-thread')).json();
    assert.equal(j.entries[0].d.text, text);
    const index = await (await call(env, tester.token, 'GET', 'index')).json();
    assert.deepEqual(index.threads.map((row) => row[0]), ['same-thread']);
  }
  assert.equal(bucket.text('t/same-thread.json'), ownerBefore);
  const ownerIndex = await (await api(env, 'sync/index', {}, { pass: 'pw' })).json();
  assert.deepEqual(ownerIndex.threads.map((row) => row[0]), ['same-thread']);
  assert.equal(bucket.keys('testers/').filter((key) => key.endsWith('/t/same-thread.json')).length, 2);
});

test('matching media hashes are isolated, including missing checks and sandboxed downloads', async () => {
  const { env, bucket, a, b } = await setup();
  const bytes = new Uint8Array([1, 2, 3, 4]), hash = await sha256hex(bytes);
  assert.equal((await blobCall(env, a.token, 'PUT', hash, bytes)).status, 201);
  assert.equal((await blobCall(env, b.token, 'GET', hash)).status, 404);
  assert.deepEqual((await (await call(env, b.token, 'POST', 'blobs/missing', { hashes: [hash] })).json()).missing, [hash]);
  assert.equal((await blobCall(env, b.token, 'PUT', hash, bytes)).status, 201);
  const r = await blobCall(env, b.token, 'GET', hash);
  assert.equal(r.headers.get('content-security-policy'), 'sandbox');
  assert.deepEqual(new Uint8Array(await r.arrayBuffer()), bytes);
  assert.equal(bucket.keys('testers/').filter((key) => key.endsWith(`/b/${hash.slice(0, 2)}/${hash}`)).length, 2);
  assert.equal((await api(env, `sync/blob/${hash}`, {}, { pass: 'pw' })).status, 404);
});

test('trash restore and history are scoped even when thread IDs match', async () => {
  const { env, bucket, a, b } = await setup();
  await call(env, a.token, 'POST', 'thread/same-thread', await pushBody('Private A'));
  await call(env, b.token, 'POST', 'thread/same-thread', await pushBody('Private B'));
  const aDoc = await (await call(env, a.token, 'GET', 'thread/same-thread')).json();
  const removed = await call(env, a.token, 'DELETE', 'thread/same-thread', { v: FORMAT, seen: { 'same-entry': aDoc.entries[0].rev }, born: aDoc.born });
  assert.equal(removed.status, 200);
  const trash = await (await call(env, a.token, 'GET', 'trash')).json();
  assert.equal(trash.items.length, 1);
  assert.match(trash.items[0].key, /^x\/same-thread\/\d{13}\.json$/);
  assert.deepEqual((await (await call(env, b.token, 'GET', 'trash')).json()).items, []);
  assert.equal((await call(env, b.token, 'POST', 'trash/restore', { key: trash.items[0].key })).status, 404);
  assert.equal((await call(env, a.token, 'POST', 'trash/restore', { key: `testers/${await sha256(a.sub)}/${trash.items[0].key}` })).status, 400);
  assert.equal((await call(env, a.token, 'POST', 'trash/restore', { key: trash.items[0].key })).status, 200);
  assert.equal((await (await call(env, b.token, 'GET', 'thread/same-thread')).json()).entries[0].d.text, 'Private B');
  assert.ok(bucket.keys(`testers-v/${await sha256(a.sub)}/v/same-thread/`).length > 0, 'history under its own lifecycle prefix');
  assert.equal(bucket.keys(`testers/${await sha256(a.sub)}/v/`).length, 0);
  assert.equal(bucket.keys('v/').length, 0);
});

test('tester quota and cached usage are separate from another tester and owner', async () => {
  const { env, bucket, a, b } = await setup({ SYNC_QUOTA_BYTES: 50 * 1024 ** 3 });
  await bucket.put(`testers/${await sha256(a.sub)}/u/usage.json`, JSON.stringify({ bytes: TESTER_SYNC_QUOTA_BYTES, blobs: 1, images: 1, videos: 0, at: SYNC_TIMING.now(), all: 1 }));
  const bytes = new Uint8Array([7]), hash = await sha256hex(bytes);
  const full = await blobCall(env, a.token, 'PUT', hash, bytes);
  assert.equal(full.status, 507);
  assert.equal((await full.json()).quota, TESTER_SYNC_QUOTA_BYTES);
  assert.equal((await blobCall(env, b.token, 'PUT', hash, bytes)).status, 201);
  const aStatus = await (await call(env, a.token, 'GET', 'status')).json();
  const bStatus = await (await call(env, b.token, 'GET', 'status')).json();
  const ownerStatus = await (await api(env, 'sync/status', {}, { pass: 'pw' })).json();
  assert.equal(aStatus.bytes, TESTER_SYNC_QUOTA_BYTES);
  assert.equal(bStatus.bytes, 1);
  assert.equal(ownerStatus.bytes, 0);
  assert.equal(ownerStatus.quota, env.SYNC_QUOTA_BYTES);
});

test('tester sync remains authenticated and same-origin; owner passcode cannot enter tester namespace', async () => {
  const { env, L, bucket, a } = await setup();
  assert.equal((await api(env, 'tester/sync/index')).status, 401);
  assert.equal((await api(env, 'tester/sync/index', {}, { pass: 'pw', cookie: a.token })).status, 401);
  assert.equal((await api(env, 'tester/sync/thread/private', { method: 'POST', body: await pushBody('hidden') }, { cookie: a.token, origin: 'https://other.example' })).status, 403);
  assert.equal(bucket.keys().length, 0);
  assert.equal((await api(env, 'tester/sync/index', {}, { pass: 'incorrect', cookie: a.token })).status, 200);
  assert.equal(bucket.keys('t/').length, 0);
  L.ledger.revoke(a.sub); resetTesterCaches();
  assert.equal((await call(env, a.token, 'GET', 'index')).status, 401);
  assert.equal((await handleTesterSync({ env, who: { kind: 'owner', sub: a.sub }, path: 'tester/sync/index' })).status, 401);
});

test('malformed route suffixes and unsupported methods never reach storage', async () => {
  const { env, bucket, a } = await setup();
  for (const suffix of ['index/x', 'thread/a/b', 'thread/%2fowner', `thread/${'x'.repeat(121)}`, `blob/${'A'.repeat(64)}`, 'trash/restores', 'blobs/missing/']) {
    const r = await call(env, a.token, 'GET', suffix);
    assert.equal(r.status, 403, suffix); // deny by default: only exact table routes enter the adapter
    const direct = await handleTesterSync({ env, who: { kind: 'tester', sub: a.sub }, path: `tester/sync/${suffix}` });
    assert.equal(direct.status, 404, suffix);
  }
  assert.equal((await call(env, a.token, 'PATCH', 'index', {})).status, 403);
  assert.equal(bucket.totalCalls(), 0);
});

test('scoped facade validates all keys and binds pagination cursors to the account', async () => {
  const { bucket, a, b } = await setup();
  const aBucket = await testerSyncBucket(bucket, a.sub), bBucket = await testerSyncBucket(bucket, b.sub);
  await aBucket.put('t/a.json', 'A1'); await aBucket.put('t/b.json', 'A2');
  await bBucket.put('t/a.json', 'B1'); await bBucket.put('t/b.json', 'B2');
  const first = await aBucket.list({ prefix: 't/' });
  assert.deepEqual(first.objects.map((o) => o.key), ['t/a.json']);
  assert.equal(first.truncated, true);
  const next = await aBucket.list({ prefix: 't/', cursor: first.cursor });
  assert.deepEqual(next.objects.map((o) => o.key), ['t/b.json']);
  await assert.rejects(bBucket.list({ prefix: 't/', cursor: first.cursor }), /cursor/);
  await assert.rejects(aBucket.list({ prefix: 't/', cursor: 'not-a-cursor' }), /cursor/);
  for (const key of ['../t/a.json', 't/../a.json', '/t/a.json', 't//a.json', 't\\a.json', 'owner/t/a.json']) {
    assert.throws(() => aBucket.get(key), /key/);
    assert.throws(() => aBucket.head(key), /key/);
    assert.throws(() => aBucket.put(key, 'bad'), /key/);
    assert.throws(() => aBucket.delete(key), /key/);
    await assert.rejects(aBucket.list({ prefix: key }), /key/);
  }
  await aBucket.delete(['t/a.json', 't/b.json']);
  assert.deepEqual((await aBucket.list({ prefix: 't/' })).objects, []);
  assert.equal(await (await bBucket.get('t/a.json')).text(), 'B1');
});

test('a list result cannot expose another namespace even if a storage adapter returns foreign keys', async () => {
  const sub = PROFILE(9003).sub, prefix = `testers/${await sha256(sub)}/`;
  const scoped = await testerSyncBucket({ async list(options) {
    assert.equal(options.prefix, `${prefix}t/`);
    return { objects: [{ key: `${prefix}t/yes.json` }, { key: 't/owner.json' }, { key: 'testers/foreign/t/no.json' }], delimitedPrefixes: ['t/owner/', `${prefix}t/own/`], truncated: false };
  } }, sub);
  const page = await scoped.list({ prefix: 't/' });
  assert.deepEqual(page.objects.map((o) => o.key), ['t/yes.json']);
  assert.deepEqual(page.delimitedPrefixes, ['t/own/']);
});

test('sync capability is explicit and follows the existing binding and kill switch', async () => {
  for (const extra of [{}, { SYNC_BUCKET: undefined }, { SYNC_DISABLED: 'true' }]) {
    const { env, a } = await setup(extra);
    const me = await (await api(env, 'tester/me', {}, { cookie: a.token })).json();
    assert.equal(me.features.sync, Boolean(env.SYNC_BUCKET) && !env.SYNC_DISABLED);
    const r = await call(env, a.token, 'GET', 'status');
    assert.equal(r.status, me.features.sync ? 200 : 503);
  }
});

test('feedback routing accepts the verified tester and owner, blocks foreign origins and keeps the inbox owner-only', async () => {
  const { env, a } = await setup();
  env.ATELIER_KV.list = async ({ prefix, limit }) => ({ keys: [...env.ATELIER_KV.m.keys()].filter((key) => key.startsWith(prefix)).sort().slice(0, limit).map((name) => ({ name })) });
  const request = { method: 'POST', headers: { 'content-type': 'application/json' }, body: { kind: 'bug', message: 'The image preview is missing.', role: 'owner', sub: 'foreign-sub' } };
  assert.equal((await api(env, 'feedback', request)).status, 401);
  assert.equal((await api(env, 'feedback', request, { cookie: a.token, origin: 'https://other.example' })).status, 403);
  assert.equal(env.ATELIER_KV.m.size, 0);
  assert.equal((await api(env, 'feedback', request, { cookie: a.token })).status, 201);
  const stored = [...env.ATELIER_KV.m.entries()][0];
  assert.ok(stored[0].endsWith(`:tester-${await sha256(a.sub)}`));
  assert.equal(JSON.parse(stored[1]).role, 'tester');
  assert.ok(!stored[1].includes('foreign-sub'));
  assert.equal((await api(env, 'feedback', {}, { cookie: a.token })).status, 403);
  assert.equal((await api(env, 'feedback', request, { pass: 'pw', cookie: a.token })).status, 201);
  const inbox = await (await api(env, 'feedback', {}, { pass: 'pw' })).json();
  assert.equal(inbox.entries.length, 2);
  assert.deepEqual(inbox.entries.map((item) => item.role).sort(), ['owner', 'tester']);
});

// ── cost limits (testers only): every stored byte counts, reservations hold concurrent writes, 500 threads, a rate limit ──
const usageKey = async (sub) => `testers/${await sha256(sub)}/u/usage.json`;
const setUsage = async (bucket, sub, bytes) => bucket.put(await usageKey(sub), JSON.stringify({ bytes, blobs: 0, images: 0, videos: 0, at: SYNC_TIMING.now(), all: 1 }));
// Bytes a tester stores, from the bucket itself (all three prefixes; u/ bookkeeping excluded).
async function storedBytes(bucket, sub) {
  const h = await sha256(sub);
  return [`testers/${h}/`, `testers-x/${h}/`, `testers-v/${h}/`].flatMap((p) => bucket.keys(p)).filter((k) => !k.startsWith(`testers/${h}/u/`)).reduce((n, k) => n + bucket.objects.get(k).bytes.byteLength, 0);
}

test('the tester quota counts thread documents, trash and history as well as media, and status shows writes at once', async () => {
  const { env, bucket, a } = await setup();
  assert.equal((await call(env, a.token, 'POST', 'thread/counted', await pushBody('A long enough answer '.repeat(20)))).status, 200);
  const doc = await (await call(env, a.token, 'GET', 'thread/counted')).json();
  assert.equal((await call(env, a.token, 'DELETE', 'thread/counted', { v: FORMAT, seen: { 'same-entry': doc.entries[0].rev }, born: doc.born })).status, 200);
  const bytes = new Uint8Array([1, 2, 3, 4, 5]), hash = await sha256hex(bytes);
  assert.equal((await blobCall(env, a.token, 'PUT', hash, bytes)).status, 201);
  const h = await sha256(a.sub);
  assert.ok(bucket.keys(`testers-x/${h}/x/counted/`).length === 1, 'the trash copy exists');
  const status = await (await call(env, a.token, 'GET', 'status')).json();
  assert.ok(status.bytes >= await storedBytes(bucket, a.sub), 'thread, trash and media all counted');
  assert.ok(status.bytes > bytes.byteLength + 400);
  assert.equal(status.quota, TESTER_SYNC_QUOTA_BYTES);
  // The owner's count is unchanged: media only.
  assert.equal((await api(env, 'sync/thread/owner-doc', { method: 'POST', body: await pushBody('Owner text') }, { pass: 'pw' })).status, 200);
  assert.equal((await (await api(env, 'sync/status', {}, { pass: 'pw' })).json()).bytes, 0);
});

test('near the cap a thread push is refused (507) like media, and reservations count uploads the cached usage hasn’t seen', async () => {
  const { env, a } = await setup();
  await setUsage(env.SYNC_BUCKET, a.sub, TESTER_SYNC_QUOTA_BYTES - 10);
  const push = await call(env, a.token, 'POST', 'thread/too-much', await pushBody('More than ten bytes of text'));
  assert.equal(push.status, 507);
  assert.equal((await push.json()).code, 'quota');
  const four = new Uint8Array([1, 2, 3, 4]), eight = new Uint8Array(8).fill(9);
  assert.equal((await blobCall(env, a.token, 'PUT', await sha256hex(four), four)).status, 201);
  assert.equal((await blobCall(env, a.token, 'PUT', await sha256hex(eight), eight)).status, 507, '4 + 8 > 10 although the cached count still says 10 bytes are free');
  const status = await (await call(env, a.token, 'GET', 'status')).json();
  assert.equal(status.bytes, TESTER_SYNC_QUOTA_BYTES - 6, 'the committed upload shows at once');
});

test('concurrent tester uploads can never pass the cap together', async () => {
  for (let round = 0; round < 5; round++) {
    const { env, bucket, a } = await setup();
    await setUsage(bucket, a.sub, TESTER_SYNC_QUOTA_BYTES - 6);
    const blobs = [new Uint8Array([1, 1, 1, 1]), new Uint8Array([2, 2, 2, 2]), new Uint8Array([3, 3, 3, 3])];
    const results = await Promise.all(blobs.map(async (b) => (await blobCall(env, a.token, 'PUT', await sha256hex(b), b)).status));
    assert.ok(results.filter((st) => st === 201).length <= 1, `round ${round}: ${results}`);
    assert.ok(results.every((st) => st === 201 || st === 507));
    // A refused upload leaves no reservation behind.
    const h = await sha256(a.sub);
    assert.equal(bucket.keys(`testers/${h}/u/r/`).length, results.filter((st) => st === 201).length);
  }
});

test('testers sync at most 500 threads; the owner’s limit is unchanged', async () => {
  const { env, bucket, a } = await setup();
  assert.equal(TESTER_SYNC_MAX_THREADS, 500);
  const scoped = await testerSyncBucket(bucket, a.sub);
  for (let i = 0; i < 500; i++) { await scoped.put(`t/seed-${i}.json`, '{}'); await bucket.put(`t/seed-${i}.json`, '{}'); }
  const r = await call(env, a.token, 'POST', 'thread/one-more', await pushBody('One more'));
  assert.equal(r.status, 413);
  assert.equal((await r.json()).code, 'too_many_threads');
  assert.equal((await api(env, 'sync/thread/one-more', { method: 'POST', body: await pushBody('Owner one more') }, { pass: 'pw' })).status, 200);
});

test('tester sync writes and status recounts are rate limited per tester (LI_LIMIT sync:<sub>) with a retryable 503; reads and the owner are not', async () => {
  const { env, bucket, a } = await setup();
  const keys = []; let allow = true;
  env.LI_LIMIT = { async limit({ key }) { keys.push(key); return { success: allow }; } };
  assert.equal((await call(env, a.token, 'POST', 'thread/limited', await pushBody('first'))).status, 200);
  assert.deepEqual(keys, [`sync:${a.sub}`]);
  allow = false;
  const before = bucket.keys().length;
  const r = await call(env, a.token, 'POST', 'thread/limited', await pushBody('second', 0));
  assert.equal(r.status, 503);
  assert.equal(r.headers.get('retry-after'), '20');
  assert.equal((await r.json()).code, 'sync_busy', 'the client retries a 503 sync_busy; a 429 would pause it as a lockout');
  assert.equal(bucket.keys().length, before, 'nothing stored');
  const bytes = new Uint8Array([5]);
  assert.equal((await blobCall(env, a.token, 'PUT', await sha256hex(bytes), bytes)).status, 503);
  assert.equal((await call(env, a.token, 'GET', 'status')).status, 503);
  keys.length = 0;
  assert.equal((await call(env, a.token, 'GET', 'index')).status, 200);
  assert.equal((await call(env, a.token, 'GET', 'thread/limited')).status, 200);
  assert.equal((await call(env, a.token, 'POST', 'blobs/missing', { hashes: [] })).status, 200);
  assert.equal((await api(env, 'sync/thread/owner', { method: 'POST', body: await pushBody('owner') }, { pass: 'pw' })).status, 200);
  assert.deepEqual(keys, [], 'reads and owner sync never consult the tester limit');
  env.LI_LIMIT = { async limit() { throw new Error('down'); } };
  assert.equal((await call(env, a.token, 'POST', 'thread/limited-2', await pushBody('limiter down'))).status, 200, 'a limiter outage fails open, as for read aloud');
});

test('tester feedback is rate limited per tester (LI_LIMIT fb:<sub>) before anything is stored', async () => {
  const { env, a } = await setup();
  env.ATELIER_KV.list = async ({ prefix, limit }) => ({ keys: [...env.ATELIER_KV.m.keys()].filter((key) => key.startsWith(prefix)).sort().slice(0, limit).map((name) => ({ name })) });
  const keys = []; let allow = true;
  env.LI_LIMIT = { async limit({ key }) { keys.push(key); return { success: allow }; } };
  const request = { method: 'POST', headers: { 'content-type': 'application/json' }, body: { kind: 'bug', message: 'Something broke.' } };
  assert.equal((await api(env, 'feedback', request, { cookie: a.token })).status, 201);
  allow = false;
  const r = await api(env, 'feedback', request, { cookie: a.token });
  assert.equal(r.status, 429);
  assert.equal((await r.json()).code, 'feedback_busy');
  assert.ok(r.headers.get('retry-after'));
  assert.deepEqual(keys, [`fb:${a.sub}`, `fb:${a.sub}`]);
  assert.equal(env.ATELIER_KV.m.size, 1);
});

test('tester trash and history live under their own lifecycle prefixes (testers-x/, testers-v/), never the owner’s x/ and v/', async () => {
  const { env, bucket, a } = await setup();
  const h = await sha256(a.sub);
  await call(env, a.token, 'POST', 'thread/split', await pushBody('First'));
  const doc = await (await call(env, a.token, 'GET', 'thread/split')).json();
  await call(env, a.token, 'DELETE', 'thread/split', { v: FORMAT, seen: { 'same-entry': doc.entries[0].rev }, born: doc.born });
  const trash = await (await call(env, a.token, 'GET', 'trash')).json();
  assert.equal(trash.items.length, 1);
  assert.equal(bucket.keys(`testers-x/${h}/x/split/`).length, 1);
  assert.equal(bucket.keys(`testers/${h}/x/`).length, 0);
  assert.equal((await call(env, a.token, 'POST', 'trash/restore', { key: trash.items[0].key })).status, 200);
  assert.ok(bucket.keys(`testers-v/${h}/v/split/`).length > 0, 'the snapshot before the restore');
  assert.equal(bucket.keys(`testers-x/${h}/`).length, 0, 'the restored trash item is gone');
  assert.deepEqual([...bucket.keys('x/'), ...bucket.keys('v/')], [], 'nothing at the owner’s root prefixes');
  for (const k of bucket.keys()) assert.ok(/^(testers|testers-x|testers-v)\//.test(k), k);
});

test('trash written before the split (testers/<hash>/x/) is still listed, restored and then removed', async () => {
  const { env, bucket, a } = await setup();
  const h = await sha256(a.sub);
  await call(env, a.token, 'POST', 'thread/old', await pushBody('Written under v77'));
  const doc = await (await call(env, a.token, 'GET', 'thread/old')).json();
  await call(env, a.token, 'DELETE', 'thread/old', { v: FORMAT, seen: { 'same-entry': doc.entries[0].rev }, born: doc.born });
  // Move the trash object to where v76/v77 kept it.
  const [now] = bucket.keys(`testers-x/${h}/`), obj = await bucket.get(now), rel = now.slice(`testers-x/${h}/`.length);
  await bucket.put(`testers/${h}/${rel}`, await obj.text(), { customMetadata: obj.customMetadata });
  await bucket.delete(now);
  const trash = await (await call(env, a.token, 'GET', 'trash')).json();
  assert.deepEqual(trash.items.map((i) => i.key), [rel]);
  assert.equal((await call(env, a.token, 'POST', 'trash/restore', { key: rel })).status, 200);
  assert.equal((await (await call(env, a.token, 'GET', 'thread/old')).json()).entries[0].d.text, 'Written under v77');
  assert.equal(bucket.keys(`testers/${h}/x/`).length, 0, 'the pre-split copy is deleted after the restore');
});

test('a whole-account listing pages across all three prefixes with an account-bound cursor', async () => {
  const { bucket, a, b } = await setup(); // pageSize 1
  const scoped = await testerSyncBucket(bucket, a.sub), other = await testerSyncBucket(bucket, b.sub);
  for (const k of ['t/a.json', 'b/aa/aa', 'x/a/1800000000000.json', 'v/a/1.json']) await scoped.put(k, 'x');
  await bucket.put(`testers/${await sha256(a.sub)}/x/a/1700000000000.json`, 'pre-split'); // v77 trash
  await other.put('t/b.json', 'y'); await bucket.put('x/owner/1.json', 'owner');
  const walk = async (prefix) => {
    const seen = [];
    let page = await scoped.list({ prefix, limit: 1 });
    for (;;) {
      seen.push(...page.objects.map((o) => o.key));
      if (!page.truncated) return seen.sort();
      await assert.rejects(other.list({ prefix, limit: 1, cursor: page.cursor }), /cursor/);
      page = await scoped.list({ prefix, limit: 1, cursor: page.cursor });
    }
  };
  assert.deepEqual(await walk(''), ['b/aa/aa', 't/a.json', 'v/a/1.json', 'x/a/1700000000000.json', 'x/a/1800000000000.json']);
  assert.deepEqual(await walk('x/'), ['x/a/1700000000000.json', 'x/a/1800000000000.json'], 'the new prefix, then the pre-split copies');
  assert.deepEqual(await walk('t/'), ['t/a.json']);
});
