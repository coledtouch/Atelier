import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger, sqlCtx, PROFILE, sha256 } from './tester-env.mjs';
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
const present = (shim, sub) => shim.db.prepare('SELECT * FROM testers WHERE sub = ?').get(sub);

test('the retention alarm removes expired cloud threads and then the record, preserving other users and owner', async () => {
  const { bucket, shim, ledger, old, fresh, freshBucket } = await retentionSetup();
  await ledger.alarm();
  assert.equal(present(shim, old.sub), undefined);
  assert.equal(ledger.getProfile(old.sub), null);
  assert.deepEqual(bucket.keys(`testers/${await sha256(old.sub)}/`), []);
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
  assert.equal(bucket.keys(`testers/${await sha256(old.sub)}/`).length, 5);
  assert.ok(shim.alarm() > Date.now());
  await ledger.alarm();
  assert.equal(present(shim, old.sub), undefined);
  assert.deepEqual(bucket.keys(`testers/${await sha256(old.sub)}/`), []);
});

test('bounded cleanup keeps its record after a partial pass and finishes on the next alarm', async () => {
  const { bucket, shim, ledger, old, oldBucket } = await retentionSetup({ pageSize: 1 });
  for (let i = 0; i < 9; i++) await oldBucket.put(`t/extra-${i}.json`, 'old extra');
  await ledger.alarm();
  assert.ok(present(shim, old.sub));
  assert.equal(bucket.keys(`testers/${await sha256(old.sub)}/`).length, 4);
  await ledger.alarm();
  assert.equal(present(shim, old.sub), undefined);
  assert.deepEqual(bucket.keys(`testers/${await sha256(old.sub)}/`), []);
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
  assert.equal(bucket.keys(`testers/${await sha256(fresh.sub)}/`).length, 1);
});

test('an account renewed before entering the cleanup gate is rechecked and preserved', async () => {
  const { bucket, shim, ledger, old } = await retentionSetup();
  shim.ctx.blockConcurrencyWhile = async (fn) => {
    shim.ctx.storage.sql.exec('UPDATE testers SET last_seen = ? WHERE sub = ?', NOW, old.sub);
    return fn();
  };
  await ledger.alarm();
  assert.ok(present(shim, old.sub));
  assert.equal(bucket.keys(`testers/${await sha256(old.sub)}/`).length, 5);
});

test('a missing R2 binding keeps the expired identifying record until storage returns', async () => {
  const { env, bucket, shim, ledger, old } = await retentionSetup();
  env.SYNC_BUCKET = undefined;
  assert.deepEqual(await purgeTesterSync(env, old.sub), { complete: false, removed: 0 });
  await ledger.alarm();
  assert.ok(present(shim, old.sub));
  assert.equal(bucket.keys(`testers/${await sha256(old.sub)}/`).length, 5);
  env.SYNC_BUCKET = bucket;
  await ledger.alarm();
  assert.equal(present(shim, old.sub), undefined);
  assert.deepEqual(bucket.keys(`testers/${await sha256(old.sub)}/`), []);
});

test('cleanup validates identity and page bounds before touching storage', async () => {
  await assert.rejects(purgeTesterSync({ SYNC_BUCKET: fakeR2() }, '../owner'), /identity/);
  await assert.rejects(purgeTesterSync({ SYNC_BUCKET: fakeR2() }, PROFILE(9014).sub, { maxPages: 0 }), /limit/);
});
