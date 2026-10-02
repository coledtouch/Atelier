import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { planRefine, intendedParent, latestApp, versions, rootOf, composerTarget, restoreBase, hasApp } from '../public/builds.js';
import { validateBackup, prepareImport } from '../public/data-safety.js';

const app = (title) => ({ html: `<!doctype html><html><head><title>${title}</title></head><body></body></html>`, title });
const build = (id, createdAt, over = {}) => ({ id, kind: 'build', prompt: `p-${id}`, createdAt, params: { refine: true, style: 'Refined' }, ...over });
const done = (id, t, over = {}) => build(id, t, { app: app('Timer'), ...over });
const running = (id, t, over = {}) => build(id, t, { pending: true, ...over });

test('a refine with a finished app before it refines that app', () => {
  const v1 = done('a', 1);
  assert.deepEqual(planRefine([v1], build('b', 2)), { prev: v1 });
  assert.deepEqual(planRefine([], build('b', 2)), { prev: null }, 'nothing to refine: a fresh build');
  const ask = { id: 'q', kind: 'ask', prompt: 'hi', createdAt: 1, text: 'x' };
  assert.deepEqual(planRefine([ask], build('b', 2)), { prev: null }, 'other modes never count');
});

test('an edit sent while the build before it is running waits for it, then refines ITS result', () => {
  const v1 = done('a', 1), e1 = running('b', 2, { refineOf: 'a' }), e2 = build('c', 3);
  assert.deepEqual(planRefine([v1, e1], e2), { wait: e1 }, 'waits instead of branching off v1');
  e1.pending = false; e1.app = app('Timer v2');
  assert.deepEqual(planRefine([v1, e1], e2), { prev: e1 });
});

test('three rapid edits chain in order on one lineage', () => {
  const v1 = done('a', 1), e1 = running('b', 2), e2 = running('c', 3), e3 = build('d', 4);
  const prior = [v1, e1, e2];
  assert.equal(planRefine(prior.slice(0, 1), e1).prev, v1);
  assert.equal(planRefine(prior.slice(0, 2), e2).wait, e1);
  assert.equal(planRefine(prior, e3).wait, e2, 'the third waits on the second, not the first');
  e1.pending = false; e1.app = app('v2'); e1.refineOf = 'a';
  assert.equal(planRefine(prior.slice(0, 2), e2).prev, e1);
  e2.pending = false; e2.app = app('v3'); e2.refineOf = 'b';
  assert.equal(planRefine(prior, e3).prev, e2);
});

test('the awaited build failed or was stopped: refine the latest finished app instead', () => {
  const v1 = done('a', 1), e1 = running('b', 2), e2 = build('c', 3);
  assert.ok(planRefine([v1, e1], e2).wait);
  e1.pending = false; e1.error = 'Stopped.'; e1.errorKind = 'stopped';
  assert.deepEqual(planRefine([v1, e1], e2), { prev: v1 }, 'a failed build is never the head');
  // A retry keeps the version it edited (refineOf); when that one has no app now, it falls back and says which failed.
  const r = build('d', 4, { refineOf: 'b' });
  assert.deepEqual(planRefine([v1, e1, r].slice(0, 2), r), { prev: v1, fallback: e1 });
  // No app anywhere: a fresh build.
  const lone = running('x', 1), next = build('y', 2);
  lone.pending = false; lone.error = 'boom';
  assert.deepEqual(planRefine([lone], next), { prev: null });
});

test('Retry / Rebuild of an old version keeps the chain', () => {
  const v1 = done('a', 1), v2 = done('b', 2, { refineOf: 'a' }), v3 = done('c', 3, { refineOf: 'b' });
  // Rebuilding v2 in place keeps its base (v1) — never the newer v3.
  const v2r = { ...v2, app: null, pending: true };
  assert.deepEqual(planRefine([v1], v2r), { prev: v1 });
  // A new edit while v2 is being rebuilt still refines the newest (v3).
  assert.deepEqual(planRefine([v1, v2r, v3], build('d', 4)), { prev: v3 });
  // Retrying v3 while its base v2 is being rebuilt waits for v2.
  assert.deepEqual(planRefine([v1, v2r], { ...v3, app: null, pending: true }), { wait: v2r });
});

test('versions: v1, v2, v3 per lineage in thread order; a new app starts its own lineage', () => {
  const v1 = done('a', 1), v2 = done('b', 2, { refineOf: 'a' }), bad = build('x', 3, { refineOf: 'b', error: 'no' }),
    v3 = done('c', 4, { refineOf: 'b' }), other = done('n', 5, { app: app('Notes') }), q = running('r', 6);
  const v = versions([v1, v2, bad, v3, other, q]);
  assert.deepEqual([v.get('a').n, v.get('b').n, v.get('c').n], [1, 2, 3]);
  assert.deepEqual([v.get('a').newest, v.get('b').newest, v.get('c').newest], [false, false, true]);
  assert.equal(v.get('c').of, 3);
  assert.deepEqual(v.get('n'), { n: 1, of: 1, root: 'n', newest: true });
  assert.equal(v.has('x'), false, 'failed builds get no number');
  assert.equal(v.has('r'), false, 'running builds get no number');
  assert.equal(rootOf([v1, v2, v3], v3).id, 'a');
  // A loop or a missing parent ends the walk instead of hanging.
  assert.ok(['a', 'b', 'c'].includes(rootOf([{ ...v1, refineOf: 'c' }, v2, v3], v3).id));
  assert.equal(rootOf([v2], v2).id, 'b');
});

test('Restore makes an older version the base for the next refine, keeping history', () => {
  const v1 = done('a', 1), v2 = done('b', 2, { refineOf: 'a' }), v3 = done('c', 3, { refineOf: 'b' });
  const entries = [v1, v2, v3];
  assert.equal(composerTarget(entries, 10).id, 'c');
  assert.equal(restoreBase(v1, 10), true);
  assert.equal(v1.baseAt, 10);
  assert.equal(composerTarget(entries, 11).id, 'a');
  assert.deepEqual(composerTarget(entries, 11), { title: 'Timer', n: 1, queued: false, id: 'a' });
  const v4 = build('d', 12);
  assert.deepEqual(planRefine(entries, v4), { prev: v1 }, 'the next change refines v1');
  // A refine created before the Restore keeps its own head (the stamp is later than it).
  assert.deepEqual(planRefine(entries, build('early', 9)), { prev: v3 });
  // Once v4 lands it is the head again, numbered after v3 in the same lineage (history kept).
  Object.assign(v4, { app: app('Timer'), refineOf: 'a' });
  const all = [...entries, v4];
  assert.equal(intendedParent(all, { at: 13 }).id, 'd');
  assert.equal(versions(all).get('d').n, 4);
  assert.equal(versions(all).get('d').newest, true);
  assert.equal(restoreBase(build('z', 1), 5), false, 'only a finished app can be restored');
});

test('composer target: queued while the head build is running', () => {
  const v1 = done('a', 1), e1 = running('b', 2);
  assert.equal(composerTarget([]), null);
  assert.deepEqual(composerTarget([v1, e1], 5), { title: 'Timer', n: 1, queued: true, id: 'b' });
  assert.equal(latestApp([v1, e1]).id, 'a');
  assert.equal(hasApp(e1), false);
});

test('data safety: refineOf and baseAt are validated and refineOf follows imported ids', () => {
  const backup = () => ({ app: 'atelier', v: 1, threads: [{ id: 't1', title: 'Timer', createdAt: 1, updatedAt: 2, entries: [
    { id: 'b1', kind: 'build', prompt: 'a timer', createdAt: 1, app: app('Timer'), baseAt: 5 },
    { id: 'b2', kind: 'build', prompt: 'make it blue', createdAt: 2, app: app('Timer'), refineOf: 'b1' },
  ] }] });
  assert.doesNotThrow(() => validateBackup(backup()));
  for (const bad of ['"><x', 42, '']) { const d = backup(); d.threads[0].entries[1].refineOf = bad; assert.throws(() => validateBackup(d)); }
  for (const bad of ['5', -1, Infinity]) { const d = backup(); d.threads[0].entries[0].baseAt = bad; assert.throws(() => validateBackup(d)); }
  let n = 0;
  const [t] = prepareImport(backup(), () => `copy-${++n}`);
  assert.equal(t.entries[1].refineOf, t.entries[0].id);
  assert.equal(t.entries[0].baseAt, 5);
  const orphan = backup(); orphan.threads[0].entries.shift();
  const [o] = prepareImport(orphan, () => `x-${++n}`);
  assert.equal('refineOf' in o.entries[0], false);
});

test('sync: the version fields are plain entry fields (not transient) and survive strip()', async () => {
  const { strip, TRANSIENT, validateDehydrated } = await import('../public/sync-merge.js');
  for (const k of ['refineOf', 'baseAt']) assert.ok(!TRANSIENT.includes(k), `${k} syncs`);
  const e = { id: 'b2', kind: 'build', prompt: 'p', createdAt: 2, refineOf: 'b1', baseAt: 9, app: { html: '<html></html>', title: 'T' }, stage: 'queued' };
  const s = strip(e);
  assert.equal(s.refineOf, 'b1'); assert.equal(s.baseAt, 9); assert.equal('stage' in s, false, 'the queued stage never syncs');
  assert.equal(validateDehydrated(s), null);
});

test('wiring: runBuild chains on the thread it belongs to and waits with its own Stop', async () => {
  const src = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(src, /import \{[^}]*planRefine[^}]*\} from '\.\/builds\.js\?v=\d+';/);
  assert.match(src, /else if \(e\.kind === 'build'\) await runBuild\(e, signal, thread\);/);
  const rb = src.slice(src.indexOf('async function runBuild('), src.indexOf('function extractHtml('));
  assert.ok(!/S\.thread/.test(rb.slice(rb.indexOf('S.thread) {') + 11)), 'runBuild never reads S.thread (a thread switch mid-wait)');
  assert.match(rb, /planRefine\(thread\.entries\.slice\(0, thread\.entries\.indexOf\(e\)\), e\)/);
  assert.match(rb, /await waitForRun\(plan\.wait, signal\)/);
  assert.match(rb, /content: '```html\\n' \+ prev\.app\.html/, 'the refine sends the previous version\'s HTML');
  assert.match(src, /Queued · will apply after the current build/);
  assert.match(src, /case 'stop-entry': return entryRuns\.get\(e\.id\)\?\.abort\(\);/);
  assert.match(src, /case 'ver-restore':/);
  assert.match(src, /Describe a change to \$\{t\.title/);
  assert.match(src, /'New app'/);
  // run() settles the wait and repaints the lineage when a build ends.
  assert.match(src, /runDone\.set\(e\.id, done\)/);
  assert.match(src, /repaintBuilds\(thread, e\)/);
});
