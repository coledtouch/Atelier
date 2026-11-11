import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { storeTx, commitNow } from '../public/data-safety.js';

// v103: a copy of Atelier frozen in the background with a thread save in flight kept the 'threads' store locked, and the
// open copy showed "0 saved threads". A write now commits as soon as its requests are issued.
function fakeDb({ commitThrows = false, noCommit = false } = {}) {
  const log = [];
  const t = { error: null, objectStore: (name) => { log.push(`store:${name}`); return store; } };
  const store = { transaction: t, put: (v) => { log.push(`put:${v}`); return { readyState: 'pending', result: `key-of-${v}` }; }, get: (k) => { log.push(`get:${k}`); return { readyState: 'pending', result: `row-${k}`, onsuccess: null }; } };
  if (!noCommit) t.commit = () => { log.push('commit'); if (commitThrows) throw new Error('InvalidStateError'); };
  const db = { transaction: (name, mode) => { log.push(`tx:${name}:${mode}`); return t; } };
  return { db, t, store, log };
}

test('a plain write commits at once, after its requests are issued and before the page hears back; it resolves to the request result on complete', async () => {
  const { db, t, log } = fakeDb();
  const p = storeTx(db, 'threads', 'readwrite', (s) => s.put('a'));
  assert.deepEqual(log, ['tx:threads:readwrite', 'store:threads', 'put:a', 'commit']);
  let settled = false; p.then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false, 'nothing resolves until the transaction completes');
  t.oncomplete();
  assert.equal(await p, 'key-of-a');
});

test('a read never commits by hand; a write that decides in a callback (late) leaves the commit to that callback', async () => {
  const read = fakeDb();
  const p = storeTx(read.db, 'threads', 'readonly', (s) => s.get('x'));
  assert.ok(!read.log.includes('commit')); read.t.oncomplete(); assert.equal(await p, 'row-x');

  const late = fakeDb();
  const q = storeTx(late.db, 'threads', 'readwrite', (s) => { const r = s.get('id'); r.onsuccess = () => { s.put('next'); commitNow(s); }; late.req = r; return r; }, true);
  assert.ok(!late.log.includes('commit'), 'not before the callback has issued its write');
  late.req.onsuccess();
  assert.deepEqual(late.log.slice(-2), ['put:next', 'commit']);
  late.t.oncomplete(); assert.equal(await q, 'row-id');
});

test('a browser without commit(), or a commit that throws, changes nothing: the transaction still settles on its own', async () => {
  const old = fakeDb({ noCommit: true });
  const p = storeTx(old.db, 'kv', 'readwrite', (s) => { s.put('v'); });
  old.t.oncomplete(); assert.equal(await p, undefined, 'fn returned nothing');
  const bad = fakeDb({ commitThrows: true });
  const q = storeTx(bad.db, 'threads', 'readwrite', (s) => s.put('b'));
  bad.t.oncomplete(); assert.equal(await q, 'key-of-b');
  assert.doesNotThrow(() => { commitNow(null); commitNow({}); commitNow({ transaction: {} }); });
});

test('an error or an abort rejects with the transaction\'s error, or a plain message when it has none', async () => {
  const a = fakeDb(); const p = storeTx(a.db, 'threads', 'readwrite', (s) => s.put('a'));
  a.t.error = new Error('QuotaExceededError'); a.t.onerror();
  await assert.rejects(p, /QuotaExceededError/);
  const b = fakeDb(); const q = storeTx(b.db, 'threads', 'readwrite', (s) => s.put('a'));
  b.t.onabort();
  await assert.rejects(q, /Storage transaction was interrupted/);
});

test('app.js: every thread-store write goes through storeTx; the callback writes are late and commit themselves; a busy store never reads as no threads', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /return storeTx\(db, store, mode, fn, late\)/);
  for (const name of ['update', 'kvClear', 'kvClearTesters']) {
    const line = app.split(/\r?\n/).find((l) => new RegExp(`^\\s*${name}: \\(`).test(l));
    assert.ok(line, name); assert.match(line, /commitNow\(s\)/, `${name} commits in its callback`); assert.match(line, /, true\),\s*$/, `${name} is late`);
  }
  assert.equal((app.match(/db\.transaction\(store, mode\)/g) || []).length, 0, 'no second hand-rolled transaction on the thread store');
  assert.match(app, /if \(saved === null\) \{ out\.busy = true; out\.late = reading; \}\s+return out;/, 'the flag rides on the array that is returned');
  assert.match(app, /const busyNote = storeBusy \? '[^\n]*Your threads are still loading/);
  assert.match(app, /list\.innerHTML = busyNote \+ h;/);
});
