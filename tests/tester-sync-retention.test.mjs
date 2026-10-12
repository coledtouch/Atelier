import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger, sqlCtx, PROFILE, sha256, resetTesterCaches } from './tester-env.mjs';
import { fakeR2 } from './fake-r2.mjs';

const { purgeTesterSync, testerSyncBucket } = await import('../src/tester/sync.js');
const NOW = 1_800_000_000_000, DAY = 86_400_000;
async function retentionSetup({ pageSize = 1000 } = {}) {
  const bucket = fakeR2({ pageSize }), shim = sqlCtx(), env = { SYNC_BUCKET: bucket };
  const ledger = new Ledger(shim.ctx, env);
  ledger.setConfig({ paused: false });
  ledger.clock = () => NOW - 90 * DAY - 1;
  const old = PROFILE(9010), fresh = PROFILE(9011);
  ledger.admit(old, 'old-session'); ledger.putProfile(old.sub, '{"bio":"old"}');
  ledger.addJob(old.sub, 'old-job', 'video');
  ledger.clock = () => NOW;
  ledger.admit(fresh, 'fresh-session'); ledger.putProfile(fresh.sub, '{"bio":"fresh"}');
  const oldBucket = await testerSyncBucket(bucket, old.sub), freshBucket = await testerSyncBucket(bucket, fresh.sub);
  await oldBucket.put('t/thread.json', 'old thread');
  await oldBucket.put('b/aa/aabb', 'old media');
  await oldBucket.put('x/thread/1800000000000.json', 'old trash');
  await oldBucket.put('v/thread/1.json', 'old history');
  await oldBucket.put('u/usage.json', 'old usage');
  await freshBucket.put('t/thread.json', 'fresh thread');
  await bucket.put('t/thread.json', 'owner thread');
  return { env, bucket, shim, ledger, old, fresh, oldBucket, freshBucket };
}
// Every key of one tester: testers/<hash>/ (threads, media, usage) and the dedicated trash and history prefixes.
const accountKeys = async (bucket, sub) => { const h = await sha256(sub); return [`testers/${h}/`, `testers-x/${h}/`, `testers-v/${h}/`].flatMap((p) => bucket.keys(p)); };
const present = (shim, sub) => shim.db.prepare('SELECT * FROM testers WHERE sub = ?').get(sub);

test('the retention alarm removes expired cloud threads and then the record, preserving other users and owner', async () => {
  const { bucket, shim, ledger, old, fresh, freshBucket } = await retentionSetup();
  await ledger.alarm();
  assert.equal(present(shim, old.sub), undefined);
  assert.equal(ledger.getProfile(old.sub), null);
  assert.deepEqual((await accountKeys(bucket, old.sub)), []);
  assert.ok(present(shim, fresh.sub));
  assert.equal(ledger.getProfile(fresh.sub), '{"bio":"fresh"}');
  assert.equal(await (await freshBucket.get('t/thread.json')).text(), 'fresh thread');
  assert.equal(bucket.text('t/thread.json'), 'owner thread');
  assert.ok(shim.alarm() > Date.now());
});

test('failed R2 deletion keeps the identifying record and profile for the next alarm retry', async () => {
  const { bucket, shim, ledger, old } = await retentionSetup();
  const deleteReal = bucket.delete.bind(bucket);
  let fail = true;
  bucket.delete = async (keys) => { if (fail) { fail = false; throw new Error('storage unavailable'); } return deleteReal(keys); };
  await ledger.alarm();
  assert.ok(present(shim, old.sub));
  assert.equal(ledger.getProfile(old.sub), '{"bio":"old"}');
  assert.equal((await accountKeys(bucket, old.sub)).length, 5);
  assert.ok(shim.alarm() > Date.now());
  await ledger.alarm();
  assert.equal(present(shim, old.sub), undefined);
  assert.deepEqual((await accountKeys(bucket, old.sub)), []);
});

test('bounded cleanup keeps its record after a partial pass and finishes on the next alarm', async () => {
  const { bucket, shim, ledger, old, oldBucket } = await retentionSetup({ pageSize: 1 });
  for (let i = 0; i < 9; i++) await oldBucket.put(`t/extra-${i}.json`, 'old extra');
  await ledger.alarm();
  assert.ok(present(shim, old.sub));
  assert.equal((await accountKeys(bucket, old.sub)).length, 4);
  await ledger.alarm();
  assert.equal(present(shim, old.sub), undefined);
  assert.deepEqual((await accountKeys(bucket, old.sub)), []);
});

test('purge uses pages and deletion batches of at most 1,000 without skipping keys after deletion', async () => {
  const bucket = fakeR2(), sub = PROFILE(9012).sub, scoped = await testerSyncBucket(bucket, sub);
  for (let i = 0; i < 1205; i++) await scoped.put(`t/thread-${i}.json`, 'work');
  const deleteReal = bucket.delete.bind(bucket), listReal = bucket.list.bind(bucket), batchSizes = [];
  bucket.delete = async (keys) => { assert.ok(keys.length <= 1000); batchSizes.push(keys.length); return deleteReal(keys); };
  bucket.list = async (options) => { assert.equal(options.limit, 1000); assert.equal(options.cursor, undefined); return listReal(options); };
  assert.deepEqual(await purgeTesterSync({ SYNC_BUCKET: bucket }, sub), { complete: true, removed: 1205 });
  assert.deepEqual(batchSizes, [1000, 205]);
  assert.deepEqual(bucket.keys(), []);
});

test('revocation retains cloud work for restoration until the 90-day inactivity cleanup', async () => {
  const { bucket, shim, ledger, fresh } = await retentionSetup();
  ledger.revoke(fresh.sub);
  await ledger.alarm();
  assert.ok(present(shim, fresh.sub));
  assert.equal((await accountKeys(bucket, fresh.sub)).length, 1);
});

test('an account renewed before entering the cleanup gate is rechecked and preserved', async () => {
  const { bucket, shim, ledger, old } = await retentionSetup();
  shim.ctx.blockConcurrencyWhile = async (fn) => {
    shim.ctx.storage.sql.exec('UPDATE testers SET last_seen = ? WHERE sub = ?', NOW, old.sub);
    return fn();
  };
  await ledger.alarm();
  assert.ok(present(shim, old.sub));
  assert.equal((await accountKeys(bucket, old.sub)).length, 5);
});

test('a missing R2 binding keeps the expired identifying record until storage returns', async () => {
  const { env, bucket, shim, ledger, old } = await retentionSetup();
  env.SYNC_BUCKET = undefined;
  assert.deepEqual(await purgeTesterSync(env, old.sub), { complete: false, removed: 0 });
  await ledger.alarm();
  assert.ok(present(shim, old.sub));
  assert.equal((await accountKeys(bucket, old.sub)).length, 5);
  env.SYNC_BUCKET = bucket;
  await ledger.alarm();
  assert.equal(present(shim, old.sub), undefined);
  assert.deepEqual((await accountKeys(bucket, old.sub)), []);
});

test('cleanup validates identity and page bounds before touching storage', async () => {
  await assert.rejects(purgeTesterSync({ SYNC_BUCKET: fakeR2() }, '../owner'), /identity/);
  await assert.rejects(purgeTesterSync({ SYNC_BUCKET: fakeR2() }, PROFILE(9014).sub, { maxPages: 0 }), /limit/);
});

test('the 90-day purge covers testers/, testers-x/ and testers-v/, including trash and history kept before the split', async () => {
  const bucket = fakeR2({ pageSize: 2 }), sub = PROFILE(9013).sub, other = PROFILE(9014).sub, h = await sha256(sub);
  const scoped = await testerSyncBucket(bucket, sub);
  for (const k of ['t/a.json', 'b/aa/aabb', 'u/usage.json', 'x/a/1800000000000.json', 'v/a/1.json', 'v/a/2.json']) await scoped.put(k, 'work');
  await bucket.put(`testers/${h}/x/a/1700000000000.json`, 'pre-split trash'); await bucket.put(`testers/${h}/v/a/0.json`, 'pre-split history');
  assert.deepEqual([bucket.keys(`testers-x/${h}/`).length, bucket.keys(`testers-v/${h}/`).length], [1, 2]);
  await (await testerSyncBucket(bucket, other)).put('x/b/1800000000000.json', 'another tester');
  await bucket.put('x/owner/1800000000000.json', 'owner trash'); await bucket.put('v/owner/1.json', 'owner history');
  assert.deepEqual(await purgeTesterSync({ SYNC_BUCKET: bucket }, sub), { complete: true, removed: 8 });
  assert.deepEqual(await accountKeys(bucket, sub), []);
  assert.equal((await accountKeys(bucket, other)).length, 1);
  assert.deepEqual([...bucket.keys('x/'), ...bucket.keys('v/')], ['x/owner/1800000000000.json', 'v/owner/1.json']);
});

// v91 review (privacy-tester-deletion-no-path): the privacy page and terms promise deletion "on request" (within 30 days)
// and no code path could do it before the 90-day alarm. The owner's Delete data: Ledger forgetTester + POST
// /api/testers/forget, which also removes the tester's feedback.
test('forgetTester: revokes and ends sessions, purges the whole cloud namespace, then the record, spend, jobs and profile; others untouched', async () => {
  const { bucket, shim, ledger, old, fresh, oldBucket } = await retentionSetup();
  await oldBucket.put('b/cc/ccdd', 'fresh media for the old one too');
  ledger.setConfig({ preview_subs: [fresh.sub, old.sub] });
  const r0 = ledger.reserve(fresh.sub, 10_000);
  assert.equal(r0.ok, true);
  const out = await ledger.forgetTester(fresh.sub);
  assert.deepEqual(out, { ok: true, found: true, removed: 1, feedback: 0 });
  assert.equal(present(shim, fresh.sub), undefined);
  assert.equal(ledger.getProfile(fresh.sub), null);
  assert.deepEqual(await accountKeys(bucket, fresh.sub), []);
  for (const t of ['sessions', 'spend', 'jobs', 'profiles', 'reservations']) assert.equal(shim.db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE sub = ?`).get(fresh.sub).n, 0, t);
  assert.equal(ledger.roster().pool.reserved, 0, 'its open reservation was settled, so the pool stays right');
  assert.deepEqual(ledger.roster().config.preview_subs, [old.sub]);
  assert.equal(ledger.session('fresh-session'), null);
  // the other tester and the owner keep everything
  assert.ok(present(shim, old.sub));
  assert.equal((await accountKeys(bucket, old.sub)).length, 6);
  assert.equal(await (await bucket.get('t/thread.json')).text(), 'owner thread');
  // again (nothing left), and for someone who was never a tester: ok, found false
  assert.deepEqual(await ledger.forgetTester(fresh.sub), { ok: true, found: false, removed: 0, feedback: 0 });
  assert.deepEqual(await ledger.forgetTester('../owner'), { ok: false });
});

test('forgetTester: a purge that can’t finish keeps the record (revoked, no sessions) and says retry', async () => {
  const { env, shim, ledger, fresh } = await retentionSetup();
  delete env.SYNC_BUCKET; // R2 unreachable from this deployment: not proof there is nothing to delete
  const out = await ledger.forgetTester(fresh.sub);
  assert.deepEqual(out, { ok: false, retry: true, removed: 0 });
  const row = present(shim, fresh.sub);
  assert.ok(row && row.revoked_at > 0, 'revoked meanwhile');
  assert.equal(shim.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE sub = ?').get(fresh.sub).n, 0);
  assert.equal(ledger.getProfile(fresh.sub), '{"bio":"fresh"}', 'nothing identifying is lost before the cloud data is');
});

test('POST /api/testers/forget (passcode): deletes the tester, their cloud data and their feedback; reachable with tester access off', async () => {
  const { makeEnv, makeLedger, api, signIn, fakeKV } = await import('./tester-env.mjs');
  for (const testers of [true, false]) {
    const bucket = fakeR2(), kv = fakeKV();
    // the Ledger Durable Object sees the Worker's bindings (the bucket and the KV namespace included)
    const { env, L } = makeEnv({ testers, SYNC_BUCKET: bucket, ATELIER_KV: kv, ledger: makeLedger({ ...(testers ? { TESTERS_ENABLED: '1' } : {}), SYNC_BUCKET: bucket, ATELIER_KV: kv }) });
    const t = await signIn(L, PROFILE(testers ? 9021 : 9022));
    await (await testerSyncBucket(bucket, t.sub)).put('t/a.json', 'their thread');
    const tag = `tester-${await sha256(t.sub)}`;
    for (const [k, v] of [[`feedback:v1:0001:aaa:${tag}`, '{}'], [`feedback:v1:0002:bbb:${tag}`, '{}'], ['feedback:v1:0003:ccc:owner', '{}'], ['feedback:v1:0004:ddd:tester-someoneelse', '{}']]) await env.ATELIER_KV.put(k, v);
    assert.equal((await api(env, 'testers/forget', { method: 'POST', body: { sub: t.sub } })).status, 401, 'passcode only');
    assert.equal((await api(env, 'testers/forget', { method: 'POST', body: { sub: t.sub } }, { pass: 'nope' })).status, 401);
    const r = await api(env, 'testers/forget', { method: 'POST', body: { sub: t.sub } }, { pass: 'pw' });
    assert.equal(r.status, 200, `testers ${testers}`);
    const j = await r.json();
    assert.deepEqual([j.ok, j.found, j.removed], [true, true, { cloud: 1, feedback: 2 }]);
    assert.ok(!j.testers.some((x) => x.sub === t.sub), 'gone from the roster it returns');
    assert.deepEqual([...env.ATELIER_KV.m.keys()].filter((k) => k.startsWith('feedback:')).sort(), ['feedback:v1:0003:ccc:owner', 'feedback:v1:0004:ddd:tester-someoneelse']);
    assert.deepEqual(await accountKeys(bucket, t.sub), []);
    assert.equal((await api(env, 'testers/forget', { method: 'POST', body: { sub: '../x' } }, { pass: 'pw' })).status, 400);
    assert.equal((await api(env, 'testers/forget', { method: 'GET' }, { pass: 'pw' })).status, 404);
  }
  // R2 unreachable: 503 forget_retry, the tester stays revoked
  const { env, L } = makeEnv({ testers: true });
  const t = await signIn(L, PROFILE(9023));
  const r = await api(env, 'testers/forget', { method: 'POST', body: { sub: t.sub } }, { pass: 'pw' });
  assert.equal(r.status, 503);
  assert.equal((await r.json()).code, 'forget_retry');
  assert.ok(L.ledger.roster().testers.find((x) => x.sub === t.sub)?.revoked_at > 0);
});

// v91 review (tester-privacy): Delete data ended the sessions, but another isolate honours a cookie it identified in the
// last 60 s (auth.js identify), so a still-open tab could push a thread, usage and media after the purge, with no record
// left to find them. The alarm now deletes the cloud data and feedback once more after FORGET_SWEEP.
async function forgetRig() {
  const { makeEnv, makeLedger, signIn, fakeKV } = await import('./tester-env.mjs');
  resetTesterCaches();
  const bucket = fakeR2(), kv = fakeKV();
  const L = makeLedger({ TESTERS_ENABLED: '1', SYNC_BUCKET: bucket, ATELIER_KV: kv });
  const { env } = makeEnv({ SYNC_BUCKET: bucket, ATELIER_KV: kv, ledger: L });
  let now = NOW;
  L.ledger.clock = () => now;
  const t = await signIn(L, PROFILE());
  return { env, L, bucket, kv, t, tick: (ms) => { now += ms; }, at: () => now };
}
const FEEDBACK = async (sub, n) => `feedback:v1:${n}:abc:tester-${await sha256(sub)}`;
test('Delete data: what a still-cached session writes after the purge is deleted by the second pass, and the sub then goes', async () => {
  const { api } = await import('./tester-env.mjs');
  const { FORGET_SWEEP } = await import('../src/tester/ledger.js');
  const { dehydrate, FORMAT } = await import('../public/sync-merge.js');
  const { env, L, bucket, kv, t, tick } = await forgetRig();
  const push = async (id) => {
    const entry = { id: 'e1', kind: 'ask', prompt: 'p', text: 'answer', createdAt: 1 }, x = await dehydrate(entry);
    return api(env, `tester/sync/thread/${id}`, { method: 'POST', body: { v: FORMAT, createdAt: 1, title: { v: 'T', base: 0 }, entries: [{ id: 'e1', createdAt: 1, base: 0, h: x.h, d: x.d }] } }, { cookie: t.token });
  };
  assert.equal((await push('before')).status, 200);
  assert.equal((await api(env, 'tester/sync/index', {}, { cookie: t.token })).status, 200, 'this isolate now holds the identity for 60 s');
  // the owner's Delete data runs in another isolate: this one still honours the cookie
  const out = await L.ledger.forgetTester(t.sub);
  assert.deepEqual([out.ok, out.found], [true, true]);
  assert.deepEqual(await accountKeys(bucket, t.sub), []);
  assert.equal((await push('after-forget')).status, 200, 'the race the second pass is for');
  await kv.put(await FEEDBACK(t.sub, '0009'), '{}');
  assert.ok((await accountKeys(bucket, t.sub)).length > 0);
  const tomb = () => L.shim.db.prepare('SELECT COUNT(*) AS n FROM forgotten WHERE sub = ?').get(t.sub).n;
  assert.equal(tomb(), 1);
  // before FORGET_SWEEP: nothing yet (a request let in before the delete may still be running)
  tick(FORGET_SWEEP - 1000);
  await L.ledger.alarm();
  assert.ok((await accountKeys(bucket, t.sub)).length > 0);
  tick(2000);
  await L.ledger.alarm();
  assert.deepEqual(await accountKeys(bucket, t.sub), [], 'the late thread, usage and reservation records are gone');
  assert.deepEqual([...kv.m.keys()].filter((k) => k.startsWith('feedback:')), [], 'and the late feedback');
  assert.equal(tomb(), 0, 'the sub is not kept once the pass completed');
  for (const table of ['testers', 'sessions', 'spend', 'jobs', 'profiles']) assert.equal(L.shim.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE sub = ?`).get(t.sub).n, 0, table);
});

test('Delete data: the second pass retries while R2 is unreachable, and leaves someone who signed in again alone', async () => {
  const { FORGET_SWEEP } = await import('../src/tester/ledger.js');
  const { signIn } = await import('./tester-env.mjs');
  const { L, bucket, t, tick } = await forgetRig();
  assert.equal((await L.ledger.forgetTester(t.sub)).ok, true);
  await (await testerSyncBucket(bucket, t.sub)).put('t/late.json', 'late');
  const tomb = () => L.shim.db.prepare('SELECT COUNT(*) AS n FROM forgotten WHERE sub = ?').get(t.sub).n;
  const list = bucket.list.bind(bucket);
  bucket.list = async () => { throw new Error('R2 down'); };
  tick(FORGET_SWEEP + 1);
  await L.ledger.alarm();
  assert.equal(tomb(), 1, 'kept for the next alarm');
  bucket.list = list;
  await L.ledger.alarm();
  assert.equal(tomb(), 0);
  assert.deepEqual(await accountKeys(bucket, t.sub), []);
  // signed in again before the second pass: what is there is theirs
  const again = await forgetRig();
  assert.equal((await again.L.ledger.forgetTester(again.t.sub)).ok, true);
  await signIn(again.L, again.t.profile);
  await (await testerSyncBucket(again.bucket, again.t.sub)).put('t/new.json', 'new work');
  again.tick(FORGET_SWEEP + 1);
  await again.L.ledger.alarm();
  assert.equal(again.L.shim.db.prepare('SELECT COUNT(*) AS n FROM forgotten').get().n, 0);
  assert.equal((await accountKeys(again.bucket, again.t.sub)).length, 1);
  assert.ok(again.L.ledger.roster().testers.some((x) => x.sub === again.t.sub));
});

// v91 review (tester-privacy): the feedback was deleted after the Ledger had dropped the roster row, and a failure
// still answered 200, so the owner had nothing left to press Delete data on again.
test('Delete data: feedback that can’t be deleted answers 503 forget_retry and keeps the tester (revoked) to retry from', async () => {
  const { api } = await import('./tester-env.mjs');
  const { env, L, kv, t } = await forgetRig();
  await kv.put(await FEEDBACK(t.sub, '0001'), '{}');
  const del = kv.delete.bind(kv);
  kv.delete = async () => { throw new Error('KV unavailable'); };
  const r = await api(env, 'testers/forget', { method: 'POST', body: { sub: t.sub } }, { pass: 'pw' });
  assert.equal(r.status, 503);
  const j = await r.json();
  assert.equal(j.code, 'forget_retry');
  assert.match(j.error, /try Delete data again/);
  const row = L.ledger.roster().testers.find((x) => x.sub === t.sub);
  assert.ok(row?.revoked_at > 0, 'still on the roster, revoked');
  assert.equal(L.shim.db.prepare('SELECT COUNT(*) AS n FROM forgotten').get().n, 0);
  kv.delete = del;
  const ok = await api(env, 'testers/forget', { method: 'POST', body: { sub: t.sub } }, { pass: 'pw' });
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).removed, { cloud: 0, feedback: 1 });
  assert.deepEqual([...kv.m.keys()].filter((k) => k.startsWith('feedback:')), []);
});

test('client: Delete data on each roster row asks first and posts testers/forget; the Testers panel loads with access on or off', async () => {
  const { readFile } = await import('node:fs/promises');
  const app = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  assert.match(app, /data-tp="forget" data-sub="\$\{esc\(x\.sub\)\}" data-name="\$\{esc\(x\.name \|\| 'this tester'\)\}"\$\{off \? ' data-off="1"' : ''\}>Delete data<\/button>/);
  // v91 review (tester-privacy): deleting the record lifts a revocation (admit refuses only a revoked row), and the
  // confirm says so, on a revoked row as on any other; it also names the second pass
  const ask = /case 'forget':\n\s+if \(!confirm\((`[^`]*`)\)\) return;/.exec(app)?.[1];
  assert.ok(ask, 'the confirm');
  const text = (off) => new Function('b', `return ${ask};`)({ dataset: { name: 'Ada', ...(off ? { off: '1' } : {}) } });
  assert.match(text(true), /This also ends their revocation\. With no record left, they can sign in again as a new tester\. That needs a free spot and open tester access\. To keep them out, leave them revoked instead\.$/);
  assert.match(text(false), /With no record left, they can sign in again as a new tester\. That needs a free spot\.$/);
  assert.match(text(false), /deleted now\. A second pass runs within about 20 minutes for anything a tab of theirs still sends\./);
  assert.match(app, /case 'forget':[^\n]*\n\s+if \(!confirm\(`Delete \$\{b\.dataset\.name\} and all their data on the server\?[^`]*`\)\) return;\n\s+if \(await testersPost\('forget', \{ sub \}, b, 'Deleting…'\)\)/);
  assert.match(app, /if \(S\.settings\.passcode && !S\.tester\) \{ loadSpending\(\); loadTesters\(\); \}/);
});
