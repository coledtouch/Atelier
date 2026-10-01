import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateBackup, prepareImport, safeMediaUrl, recoverThread, ERROR_KINDS } from '../public/data-safety.js';
const fixture = () => ({ app: 'atelier', v: 1, threads: [{ id: 'thread-1', title: 'Example', createdAt: 1, updatedAt: 2,
  entries: [{ id: 'entry-1', kind: 'ask', prompt: 'Hello', createdAt: 1, text: 'World' }] }] });
test('accepts existing v1 thread backups', () => assert.equal(validateBackup(fixture()).length, 1));
test('rejects unrelated JSON and unsupported backups', () => {
  for (const value of [{}, [], null, { threads: [] }, { ...fixture(), v: 2 }]) assert.throws(() => validateBackup(value));
});
test('validates every entry before allowing an import', () => {
  const data = fixture(); data.threads.push(structuredClone(data.threads[0]));
  data.threads[1].entries[0].kind = 'unknown'; assert.throws(() => validateBackup(data));
});
test('rejects malformed nested content and unsafe media', () => {
  for (const mutate of [e => e.media = [{ type: 'image', src: 'javascript:alert(1)' }], e => e.app = { html: 42 }, e => e.images = {}, e => e.meta = {model: 12}, e => e.ideas = [{ title: 'Title', pitch: 'Pitch', tags: 5 }]]) {
    const data = fixture(); mutate(data.threads[0].entries[0]); assert.throws(() => validateBackup(data));
  }
});
test('blocks prototype pollution and invalid identifiers', () => {
  const data = fixture(); data.threads[0].entries[0].params = JSON.parse('{"__proto__":{"polluted":true}}'); assert.throws(() => validateBackup(data));
  const bad = fixture(); bad.threads[0].id = '\" onclick=\"alert(1)'; assert.throws(() => validateBackup(bad));
});
test('imports as copies and removes stale approvals without changing source', () => {
  const data = fixture(); const entry = data.threads[0].entries[0]; entry.pending = true; entry.steps = [{ status: 'awaiting' }];
  let n = 0; const imported = prepareImport(data, () => `copy-${++n}`);
  assert.notEqual(imported[0].id, data.threads[0].id); assert.notEqual(imported[0].entries[0].id, entry.id);
  assert.equal(imported[0].entries[0].pending, false); assert.deepEqual(imported[0].entries[0].steps, []);
  assert.match(imported[0].entries[0].error, /interrupted/); assert.equal(entry.pending, true);
});
test('accepts supported media and excludes executable protocols and SVG data', () => {
  for (const url of ['https://example.com/a.png', 'data:image/png;base64,YQ==', 'data:video/webm;base64,YQ==']) assert.equal(safeMediaUrl(url), true);
  for (const url of ['javascript:alert(1)', 'data:image/svg+xml;base64,YQ==', 'file:///test', 'https://user:pass@example.com/a.png', 'blob:old-device']) assert.equal(safeMediaUrl(url), false);
});
test('restoring an interrupted generation preserves partial work and offers recovery', () => {
  const thread = fixture().threads[0]; thread.entries[0].pending = true; thread.entries[0].stage = 'Composing';
  recoverThread(thread); assert.equal(thread.entries[0].pending, false); assert.equal(thread.entries[0].text, 'World'); assert.match(thread.entries[0].error, /interrupted/); assert.equal(thread.entries[0].stage, undefined);
});
test('restoring a complete conversation does not modify it', () => {
  const thread = fixture().threads[0]; const copy = structuredClone(thread); recoverThread(thread); assert.deepEqual(thread, copy); assert.equal(recoverThread(null), null);
});
test('rejects markup in the persisted error kind and drops transient timers on import', () => {
  const bad = fixture(); Object.assign(bad.threads[0].entries[0], { error: 'boom', errorKind: '"><img src=x onerror=alert(1)>' }); assert.throws(() => validateBackup(bad));
  const good = fixture(); Object.assign(good.threads[0].entries[0], { error: 'boom', errorKind: 'rate', startedAt: 5 });
  const [t] = prepareImport(good, () => 'copy-1'); assert.equal(t.entries[0].errorKind, 'rate'); assert.equal('startedAt' in t.entries[0], false);
});
// LinkedIn tester refusals: errorKind 'budget' / 'signin', and e.budget = {scope, resetsAt} for the card's reset line.
test('accepts tester budget errors and keeps them through import', () => {
  const data = fixture(); Object.assign(data.threads[0].entries[0], { text: '', error: 'Today’s tester allowance is used up.', errorKind: 'budget', budget: { scope: 'day', resetsAt: 1790000000000 } });
  assert.equal(validateBackup(data).length, 1);
  const [t] = prepareImport(data, () => 'copy-1'); assert.deepEqual(t.entries[0].budget, { scope: 'day', resetsAt: 1790000000000 });
  const plain = fixture(); Object.assign(plain.threads[0].entries[0], { error: 'Sign in again', errorKind: 'signin', budget: { scope: 'paused' } }); assert.equal(validateBackup(plain).length, 1);
  const cleared = fixture(); cleared.threads[0].entries[0].budget = null; assert.equal(validateBackup(cleared).length, 1); // a retried entry
  const short = fixture(); short.threads[0].entries[0].budget = { scope: 'day', resetsAt: 1790000000000, short: true }; assert.equal(validateBackup(short).length, 1); // money was left
  for (const bad of [{ scope: 'week' }, { scope: 'day', resetsAt: 'tomorrow' }, { scope: 'day', resetsAt: -1 }, { scope: 'day', extra: '<b>' }, { scope: 'day', short: 'yes' }, 'day', []]) {
    const d = fixture(); d.threads[0].entries[0].budget = bad; assert.throws(() => validateBackup(d), undefined, JSON.stringify(bad));
  }
});
test('every error kind app.js can render is a known, attribute-safe kind', async () => {
  for (const k of ERROR_KINDS) assert.match(k, /^[a-z]{1,20}$/);
  assert.ok(ERROR_KINDS.includes('budget') && ERROR_KINDS.includes('signin'));
  const src = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const titles = src.match(/const ERROR_TITLE = \{([^}]*)\}/)[1];
  assert.deepEqual([...titles.matchAll(/(\w+):\s*'/g)].map((m) => m[1]).sort(), [...ERROR_KINDS].sort());
});
// Video entries: poster + frames as small image data URLs, a Gemini file reference, never the video itself.
const IMG = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
const videoFixture = () => {
  const data = fixture(), t = data.threads[0];
  Object.assign(t.entries[0], { images: [], meta: { model: 'gemini:gemini-3.8-flash', note: 'video · full clip with audio' },
    video: { name: 'clip.mp4', mime: 'video/mp4', size: 1234567, duration: 12.4, width: 1280, height: 720, poster: IMG,
      frames: [{ t: 1.2, src: IMG }, { t: 11.1, src: IMG }],
      file: { name: 'files/abc-123', uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc-123', mime: 'video/mp4', expiresAt: 1790000000000 } } });
  t.entries.push({ id: 'entry-2', kind: 'ask', prompt: 'And the ending?', createdAt: 2, text: 'It fades out.', videoOf: 'entry-1', meta: { model: 'gemini:gemini-3.8-flash', note: 'about the video · full clip with audio' } });
  return data;
};
test('accepts video entries and their follow-ups; older backups are unaffected', () => {
  assert.equal(validateBackup(videoFixture()).length, 1);
  const clipOnly = videoFixture(); Object.assign(clipOnly.threads[0].entries[0].video, { poster: null, frames: [], clipOnly: true, width: 0, height: 0 });
  assert.equal(validateBackup(clipOnly).length, 1);
  const noFile = videoFixture(); delete noFile.threads[0].entries[0].video.file; assert.equal(validateBackup(noFile).length, 1);
  assert.equal(validateBackup(fixture()).length, 1);
});
test('rejects unsafe or malformed video data', () => {
  const cases = [
    v => v.frames[0].src = 'data:video/mp4;base64,AAAA', v => v.frames[0].src = 'https://example.com/f.jpg', v => v.poster = 'javascript:alert(1)',
    v => v.frames = Array.from({ length: 33 }, (_, i) => ({ t: i, src: IMG })), v => v.duration = NaN, v => v.size = -1,
    v => v.file.uri = 'https://evil.example/v1beta/files/x', v => v.file.name = '../x', v => v.name = 42, v => v.mime = 'text/html',
    v => v.poster = 'data:image/svg+xml;base64,PHN2Zz4=', v => v.frames = {}, v => v.clipOnly = 'yes',
  ];
  for (const mutate of cases) { const data = videoFixture(); mutate(data.threads[0].entries[0].video); assert.throws(() => validateBackup(data), undefined, String(mutate)); }
  for (const bad of ['"><x', 42, '']) { const data = videoFixture(); data.threads[0].entries[1].videoOf = bad; assert.throws(() => validateBackup(data)); }
  const notRecord = videoFixture(); notRecord.threads[0].entries[0].video = 'clip.mp4'; assert.throws(() => validateBackup(notRecord));
});
test('import keeps a follow-up linked to its video under the new IDs', () => {
  let n = 0; const [t] = prepareImport(videoFixture(), () => `copy-${++n}`);
  assert.equal(t.entries[1].videoOf, t.entries[0].id); assert.notEqual(t.entries[0].id, 'entry-1');
  assert.deepEqual(t.entries[0].video.frames.length, 2); assert.equal(t.entries[0].video.file.name, 'files/abc-123');
  const orphan = videoFixture(); orphan.threads[0].entries[1].videoOf = 'missing-entry';
  const [o] = prepareImport(orphan, () => `copy-${++n}`); assert.equal('videoOf' in o.entries[1], false);
});
