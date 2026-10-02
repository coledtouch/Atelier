import { test } from 'node:test';
import assert from 'node:assert/strict';

// public/remix-store.js — the rx:* key/value store, on an in-memory kv (no IndexedDB in node).
const { createRemixStore, memoryKv, keys, parseKey, OPS_MAX } = await import('../public/remix-store.js');

// A controllable clock and timers (drafts debounce 1 s).
function clock(t0 = 1_000_000) {
  let t = t0;
  const timers = [];
  return {
    now: () => t,
    advance(ms) { t += ms; for (const x of timers.splice(0)) if (x.at <= t) x.fn(); else timers.push(x); },
    setTimeout: (fn, ms) => { const x = { fn, at: t + ms }; timers.push(x); return x; },
    clearTimeout: (x) => { const i = timers.indexOf(x); if (i >= 0) timers.splice(i, 1); },
    pending: () => timers.length,
  };
}
const blob = (n, type = 'video/mp4') => new Blob([new Uint8Array(n)], { type });

test('keys: rx:* names, validated ids; parseKey reads them back', () => {
  assert.equal(keys.shot('e1', 's2'), 'rx:shot:e1:s2');
  assert.equal(keys.job('lx3k-9a'), 'rx:job:lx3k-9a');
  assert.throws(() => keys.shot('e1', 'S2'), /bad shot key/);
  assert.throws(() => keys.src('../x'), /bad entry id/);
  assert.deepEqual(parseKey('rx:img:e1:i1'), { kind: 'img', entry: 'e1', id: 'i1' });
  assert.deepEqual(parseKey('rx:ops'), { kind: 'ops', entry: null, id: null });
  assert.equal(parseKey('passcode'), null);
  assert.equal(parseKey('rx:evil:e1'), null);
});

test('blobs: put/get round-trip with bytes and thread; only rx blob keys are accepted', async () => {
  const kv = memoryKv(), st = createRemixStore(kv, { now: () => 5 });
  const b = blob(1234);
  assert.deepEqual(await st.putBlob(keys.shot('e1', 's1'), b, { threadId: 't1' }), { blobKey: 'rx:shot:e1:s1', bytes: 1234 });
  assert.equal(await st.getBlob('rx:shot:e1:s1'), b);
  assert.deepEqual({ ...kv.map.get('rx:shot:e1:s1'), blob: null }, { blob: null, at: 5, bytes: 1234, threadId: 't1' });
  await assert.rejects(st.putBlob('rx:plan:e1', b), /bad blob key/);
  await assert.rejects(st.putBlob('settings', b), /bad blob key/);
  assert.equal(await st.getBlob('rx:shot:e1:nope'), null);
  assert.equal(await st.getBlob('settings'), null);
  kv.map.set('rx:img:e1:i1', b); // a bare Blob from an older build still reads
  assert.equal(await st.getBlob('rx:img:e1:i1'), b);
});

test('ops index: add replaces per (entry, shot), keeps the newest 50, remove by shot or entry', async () => {
  const kv = memoryKv(), st = createRemixStore(kv);
  await st.opsAdd({ entryId: 'e1', threadId: 't1', shotId: 's1', op: null, startedAt: 10 });
  await st.opsAdd({ entryId: 'e1', threadId: 't1', shotId: 's1', op: 'models/veo/operations/a', startedAt: 10 });
  await st.opsAdd({ entryId: 'e1', threadId: 't1', shotId: 's2', op: 'models/veo/operations/b', startedAt: 11 });
  let all = await st.opsAll();
  assert.deepEqual(all.map((o) => [o.shotId, o.op]), [['s1', 'models/veo/operations/a'], ['s2', 'models/veo/operations/b']]);
  await st.opsRemove('e1', 's1');
  assert.deepEqual((await st.opsAll()).map((o) => o.shotId), ['s2']);
  await st.opsRemove('e1');
  assert.deepEqual(await st.opsAll(), []);
  // concurrent adds never lose one another (serialised read-modify-write)
  await Promise.all(Array.from({ length: 60 }, (_, i) => st.opsAdd({ entryId: `e${i}`, shotId: 's1', startedAt: i + 1 })));
  all = await st.opsAll();
  assert.equal(all.length, OPS_MAX);
  assert.equal(all[0].entryId, 'e10', 'the oldest ten went');
  await assert.rejects(st.opsAdd({ entryId: 'e1', shotId: 'BAD' }), /bad op record/);
  kv.map.set('rx:ops', [{ junk: true }, null, { entryId: 'e1', shotId: 's1' }]);
  assert.equal((await st.opsAll()).length, 1, 'malformed records are ignored');
});

test('job state: patches merge per shot, concurrent patches all land, undefined clears a field', async () => {
  const kv = memoryKv(), st = createRemixStore(kv, { now: () => 42 });
  await Promise.all([
    st.jobPatch('e1', 's1', { state: 'starting', startedAt: 1 }, 't1'),
    st.jobPatch('e1', 's2', { state: 'filming', op: 'models/x/operations/y' }),
    st.jobPatch('e1', 's1', { state: 'filming', op: 'models/x/operations/z', error: 'old' }),
  ]);
  let j = await st.jobGet('e1');
  assert.equal(j.threadId, 't1');
  assert.deepEqual(j.shots.s1, { state: 'filming', startedAt: 1, op: 'models/x/operations/z', error: 'old', at: 42 });
  assert.equal(j.shots.s2.state, 'filming');
  await st.jobPatch('e1', 's1', { error: undefined });
  j = await st.jobGet('e1');
  assert.equal('error' in j.shots.s1, false);
  assert.equal(await st.jobGet('e9'), null);
});

test('drafts: saved after a 1 s debounce, the last save wins, load sees a pending save, flush writes now', async () => {
  const c = clock(), kv = memoryKv(), st = createRemixStore(kv, c);
  const p1 = st.draftSave('e1', { plan: { title: 'a' } });
  const p2 = st.draftSave('e1', { plan: { title: 'b' } });
  assert.equal(kv.map.has('rx:plan:e1'), false);
  assert.equal((await st.draftLoad('e1')).plan.title, 'b', 'pending value');
  c.advance(999);
  assert.equal(kv.map.has('rx:plan:e1'), false);
  c.advance(1);
  await Promise.all([p1, p2]);
  assert.equal(kv.map.get('rx:plan:e1').plan.title, 'b');
  st.draftSave('e2', { plan: { title: 'c' } });
  await st.draftFlush();
  assert.equal(kv.map.get('rx:plan:e2').plan.title, 'c');
  assert.equal(c.pending(), 0);
});

test('dropEntry: every rx key of that entry and its ops; other entries untouched', async () => {
  const kv = memoryKv(), st = createRemixStore(kv);
  await st.putBlob(keys.src('e1'), blob(10));
  await st.putBlob(keys.shot('e1', 's1'), blob(10));
  await st.putBlob(keys.cut('e1'), blob(10));
  await st.jobPatch('e1', 's1', { state: 'ready' });
  await st.draftSave('e1', { plan: {} }, { now: true });
  await st.opsAdd({ entryId: 'e1', shotId: 's1' });
  await st.putBlob(keys.shot('e2', 's1'), blob(10));
  kv.map.set('passcode', 'x');
  const n = await st.dropEntry('e1');
  assert.equal(n, 5);
  assert.deepEqual([...kv.map.keys()].sort(), ['passcode', 'rx:ops', 'rx:shot:e2:s1']);
  assert.deepEqual(await st.opsAll(), []);
});

test('dropEntry without kvKeys/kvDel (before the A2 patch): deletes known keys by writing null', async () => {
  const m = memoryKv();
  const kv = { kvGet: m.kvGet, kvSet: m.kvSet }; // no kvDel / kvKeys
  const st = createRemixStore(kv);
  await st.putBlob(keys.shot('e1', 's1'), blob(3));
  await st.jobPatch('e1', 's1', { state: 'ready' });
  await st.dropEntry('e1');
  assert.equal(m.map.get('rx:shot:e1:s1'), null);
  assert.equal(m.map.get('rx:job:e1'), null);
  assert.equal(await st.getBlob('rx:shot:e1:s1'), null);
});

test('prune: drops orphaned entries; a week-old one in a live thread keeps its paid shots; never a live op or keep', async () => {
  const c = clock(10 * 864e5), kv = memoryKv(), st = createRemixStore(kv, c);
  await st.putBlob(keys.src('gone'), blob(5), { threadId: 'deleted-thread' });
  await st.putBlob(keys.src('live'), blob(5), { threadId: 't1' });
  await st.putBlob(keys.shot('live', 's1'), blob(5), { threadId: 't1' });
  await st.putBlob(keys.cut('live'), blob(5), { threadId: 't1' });
  await st.jobPatch('live', 's1', { state: 'ready', blobKey: keys.shot('live', 's1') }, 't1');
  await st.putBlob(keys.src('filming'), blob(5), { threadId: 'deleted-thread' });
  await st.opsAdd({ entryId: 'filming', threadId: 'deleted-thread', shotId: 's1', startedAt: c.now() });
  await st.putBlob(keys.src('kept'), blob(5), { threadId: 'deleted-thread' });
  c.advance(8 * 864e5);
  await st.putBlob(keys.src('fresh'), blob(5), { threadId: 't1' });
  const { dropped, trimmed } = await st.prune({ liveThreadIds: ['t1'], keep: ['kept'] });
  assert.deepEqual(dropped.sort(), ['gone'], 'the orphan');
  assert.deepEqual(trimmed, ['live'], '8 days old, thread still there');
  assert.ok(!kv.map.has('rx:src:live') && !kv.map.has('rx:cut:live'), 'source and cut go (re-attach / cut again, free)');
  assert.ok(kv.map.has('rx:shot:live:s1') && kv.map.has('rx:job:live'), 'the paid shot and its job record stay');
  assert.ok(kv.map.has('rx:src:filming') && kv.map.has('rx:src:kept') && kv.map.has('rx:src:fresh'));
  // without kvKeys (no list of keys) a week-old entry is still dropped whole, as before
  const c2 = clock(10 * 864e5), kv2 = memoryKv(), st2 = createRemixStore({ kvGet: kv2.kvGet, kvSet: kv2.kvSet, kvDel: kv2.kvDel }, c2);
  await st2.opsAdd({ entryId: 'old', threadId: 'gone-thread', shotId: 's1', startedAt: c2.now() });
  await st2.opsRemove('old', 's1');
  assert.deepEqual((await st2.prune({ liveThreadIds: null })).dropped, []);
});

test('estimate: sums rx blob bytes and passes through the storage estimate', async () => {
  const kv = memoryKv(), st = createRemixStore(kv, { storage: { estimate: async () => ({ usage: 9, quota: 99 }), persisted: async () => true } });
  await st.putBlob(keys.shot('e1', 's1'), blob(100));
  await st.putBlob(keys.cut('e1'), blob(50));
  await st.jobPatch('e1', 's1', { state: 'ready' });
  assert.deepEqual(await st.estimate(), { usage: 9, quota: 99, rxBytes: 150, persisted: true });
});
