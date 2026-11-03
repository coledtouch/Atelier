// scripts/sync-humanizer.mjs as a command. --check exits 0 when the copy matches and 1 on drift. A --from or
// COLEOS_WORKER path that isn't there exits 1, and --from with no path exits 2. Only the default path may be missing
// quietly. Each run reads a worker.js from a temp folder (a space in its name, like "Coen Business"); none writes a file.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentText } from '../scripts/sync-humanizer.mjs';
import { HUMANIZER_BANNED, HUMANIZER_WARN } from './humanizer-lint.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/sync-humanizer.mjs', import.meta.url));
const OUT = new URL('../public/humanizer.js', import.meta.url);
const COPY = await readFile(OUT, 'utf8');
const TEXT = currentText(COPY); // the template literal in public/humanizer.js
const PARTS = ['OneDrive', 'Documents', 'Claude', 'Projects', 'Coen Business', 'coleos-api', 'src', 'worker.js'];

// a coleos-api worker.js shaped like the canonical one: the HUMANIZER template, the lint it holds, the 16-word rule
const workerSource = (text, { eol = '\n', banned = HUMANIZER_BANNED } = {}) => [
  '// coleos-api/src/worker.js, a test copy',
  'const A = 1;',
  `const HUMANIZER = \`${text}\`;`,
  `const HUMANIZER_BANNED = ${banned};`,
  'const HUMANIZER_WARN = [',
  ...HUMANIZER_WARN.map(([rx, label]) => `  [${rx}, "${label}"],`),
  '];',
  'const tooLong = (n) => n > 16;',
  '',
].join('\n').replace(/\n/g, eol);

const DIR = await mkdtemp(join(tmpdir(), 'atelier sync-'));
after(() => rm(DIR, { recursive: true, force: true }));
const put = async (name, src) => { const p = join(DIR, name); await writeFile(p, src); return p; };
const GOOD = await put('worker.js', workerSource(TEXT));
const GOOD_CRLF = await put('worker-crlf.js', workerSource(TEXT, { eol: '\r\n' }));
const MISSING = join(DIR, 'coleos-api', 'src', 'worker.js');

// the script in a child process, COLEOS_WORKER unset unless a test sets it
const run = (args, env = {}) => {
  const { COLEOS_WORKER, ...rest } = process.env;
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: DIR, env: { ...rest, ...env }, encoding: 'utf8' });
  assert.equal(r.error, undefined, String(r.error));
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const untouched = async () => assert.equal(await readFile(OUT, 'utf8'), COPY, 'public/humanizer.js is unchanged');

test('--from without a path: a usage error and exit 2, never a file named undefined', async () => {
  for (const args of [['--check', '--from'], ['--from', '--check'], ['--check', '--from', '']]) {
    const r = run(args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.err, /^sync-humanizer: --from needs a path\.\nusage: node scripts\/sync-humanizer\.mjs \[--check\] \[--from <worker\.js>\]\n$/);
    assert.equal(r.out, '');
    assert.doesNotMatch(r.err, /undefined|DEP0187|isn't on this machine/);
  }
  assert.equal(run(['--check', '--from'], { COLEOS_WORKER: GOOD }).code, 2, 'COLEOS_WORKER does not fill in for it');
  await untouched();
});

test('a path asked for by name that isn’t there: "not found" and exit 1, by --from or COLEOS_WORKER', async () => {
  for (const [args, env] of [[['--check', '--from', MISSING], {}], [['--check'], { COLEOS_WORKER: MISSING }], [['--from', MISSING], {}], [['--check', '--from', MISSING], { COLEOS_WORKER: GOOD }]]) {
    const r = run(args, env);
    assert.equal(r.code, 1, args.join(' '));
    assert.equal(r.err, `sync-humanizer: ${MISSING} not found\n`);
    assert.equal(r.out, '', 'not the "isn’t on this machine" note');
  }
  await untouched();
});

test('the default path: missing → the note and exit 0; present → compared, "Coen Business" and all', async () => {
  const home = join(DIR, 'home');
  const env = { HOME: home, USERPROFILE: home }; // os.homedir(): HOME on Linux and macOS, USERPROFILE on Windows
  const missing = run(['--check'], env);
  assert.equal(missing.code, 0);
  assert.equal(missing.out, `sync-humanizer: ${join(home, ...PARTS)} isn't on this machine, so nothing was compared or copied.\n`);
  await mkdir(join(home, ...PARTS.slice(0, -1)), { recursive: true });
  await writeFile(join(home, ...PARTS), workerSource(TEXT));
  const found = run(['--check'], env);
  assert.equal(found.code, 0, found.out + found.err);
  assert.equal(found.out, 'sync-humanizer: public/humanizer.js matches the canonical text.\n');
  await untouched();
});

test('--check against a worker.js whose HUMANIZER matches public/humanizer.js: exit 0, LF or CRLF', async () => {
  for (const [args, env] of [[['--check', '--from', GOOD], {}], [['--check', '--from', GOOD_CRLF], {}], [['--check'], { COLEOS_WORKER: GOOD }], [['--check', '--from', GOOD], { COLEOS_WORKER: MISSING }]]) {
    const r = run(args, env);
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(r.out, 'sync-humanizer: public/humanizer.js matches the canonical text.\n');
    assert.equal(r.err, '');
  }
  await untouched();
});

test('--check on drift: a changed text or a moved lint pattern prints what moved, exits 1 and writes nothing', async () => {
  const changed = await put('worker-changed.js', workerSource(`${TEXT}\n11. One more rule.`, { eol: '\r\n' }));
  const text = run(['--check', '--from', changed]);
  assert.equal(text.code, 1);
  assert.match(text.out, /^sync-humanizer: public\/humanizer\.js differs from the canonical text:\n/);
  assert.match(text.out, /\n\+ 11\. One more rule\.\n/);
  assert.doesNotMatch(text.out, /copied\.|lint moved/);
  const lint = run(['--check'], { COLEOS_WORKER: await put('worker-lint.js', workerSource(TEXT, { banned: /\b(pivotal)\b/gi })) });
  assert.equal(lint.code, 1);
  assert.match(lint.out, /matches the canonical text\.\nsync-humanizer: the canonical lint moved; port it to tests\/humanizer-lint\.mjs by hand:\nHUMANIZER_BANNED moved:\n {2}canonical \/\\b\(pivotal\)\\b\/gi\n/);
  await untouched();
});
