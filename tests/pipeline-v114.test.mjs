// v114 (whole-app review, area "pipeline"): the gates that run before a deploy.
//   pipeline #3: `npm run check` parsed 47 of the 63 scripts that ship. A stray brace in the Chrome extension, the
//     tester router or the tools file reached a deploy with nothing to stop it.
//   pipeline #2: bump-version.mjs and sync-humanizer.mjs decided "was I run directly?" by comparing two paths as
//     written. Started through a linked folder they differed: the script did nothing, said nothing and exited 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, symlinkSync, rmdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('pipeline #3: npm run check parses every script that ships (the app, the Mac helper, the Worker, the extension)', () => {
  const check = JSON.parse(read('package.json')).scripts.check;
  const shipped = ['public', 'public/mac', 'src', 'src/tester', 'extension'].flatMap((dir) => readdirSync(join(ROOT, dir)).filter((f) => f.endsWith('.js')).map((f) => `${dir}/${f}`));
  assert.ok(shipped.length >= 63, `found ${shipped.length} scripts`);
  const missing = shipped.filter((f) => !check.split(' && ').includes(`node --check ${f}`));
  assert.deepEqual(missing, [], 'a new module is added to scripts.check in package.json');
  // Nothing vendored (minified third-party builds are not ours to parse), and every name on the line exists.
  assert.doesNotMatch(check, /public\/vendor\//);
  for (const part of check.split(' && ')) { const f = /^node --check (\S+)$/.exec(part)?.[1]; assert.ok(f, part); assert.doesNotThrow(() => read(f), `${f} is on the check line and exists`); }
  assert.ok(check.length < 8000, 'one line, under the Windows command length');
});

test('pipeline #2: bump-version and sync-humanizer do their work when started through a linked folder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-link-'));
  const link = join(dir, 'scripts');
  symlinkSync(join(ROOT, 'scripts'), link, 'junction');
  try {
    const n = /const VERSION = 'atelier-v(\d+)'/.exec(read('public/sw.js'))[1];
    const run = (...args) => spawnSync(process.execPath, args, { encoding: 'utf8' });
    // The current number: the script reports that nothing changes (and changes nothing). It used to print nothing.
    const bump = run(join(link, 'bump-version.mjs'), n);
    assert.equal(bump.status, 0, bump.stderr);
    assert.match(bump.stdout, new RegExp(`Already at atelier-v${n}: nothing to change\\.`));
    // No number: the usage error, exit 1. It used to exit 0.
    assert.notEqual(run(join(link, 'bump-version.mjs')).status, 0);
    // sync-humanizer --check against a file that is not there exits 1. It used to exit 0 without looking.
    const sync = run(join(link, 'sync-humanizer.mjs'), '--check', '--from', join(dir, 'no-such-worker.js'));
    assert.equal(sync.status, 1, sync.stdout + sync.stderr);
  } finally {
    rmdirSync(link); // the link itself, never what it points at (a plain rmdir cannot remove a folder with files in it)
    rmSync(dir, { recursive: true, force: true });
  }
  for (const f of ['scripts/bump-version.mjs', 'scripts/sync-humanizer.mjs']) assert.match(read(f), /try \{ return real\(process\.argv\[1\]\) === real\(fileURLToPath\(import\.meta\.url\)\); \} catch \{ return false; \}/, f);
});
