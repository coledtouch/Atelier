// scripts/ship.mjs (npm run ship, and npm run deploy which runs it) and scripts/check-bump.mjs (CI's "version bumped"
// gate): the decisions they make, with fakes only. Nothing here touches the network, a git remote or wrangler.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import {
  parseArgs, strayNpmFlags, confirmShip, confirmRaw, versionIn, appVersionIn, versionGate, parsePorcelainZ, dirtyProblems,
  parseAheadBehind, syncDecision, bumpedFiles, bumpProblems, pathProblems, parseRecord, shipRecord, liveOriginDecision,
  afterWranglerFailure, worktreeAddArgs, parseCatFileBatch, parseTap, isSafeTempDir, waitForLive, main, DEPLOY_COMMANDS,
  SITE, ZIP, RECORD, RAW_ENV, RAW_CONSENT,
} from '../scripts/ship.mjs';
import { needsBump, bumpVerdict, isNullSha, swVersion, baseDecision } from '../scripts/check-bump.mjs';
import { guardDecision } from '../scripts/deploy-guard.mjs';

const z = (...records) => records.map((r) => `${r}\0`).join('');

test('arguments: known flags only; --skip-live-check only with --dry-run; flags npm swallowed still count', () => {
  assert.deepEqual(parseArgs([]), { dryRun: false, skipLiveCheck: false, noPush: false, yes: false, allowUnrecorded: false, help: false, raw: false, npmFlags: [] });
  const o = parseArgs(['--dry-run', '--skip-live-check', '--no-push', '--yes', '--allow-unrecorded-live']);
  assert.ok(o.dryRun && o.skipLiveCheck && o.noPush && o.yes && o.allowUnrecorded && !o.help && !o.raw);
  assert.ok(parseArgs(['--help']).help && parseArgs(['-h']).help);
  assert.ok(parseArgs(['--raw']).raw);
  assert.throws(() => parseArgs(['--warn-raw']), /unknown argument/, 'the old banner-only flag is gone');
  for (const typo of ['--dryrun', '--dryRun', '--dry_run', '-n', '--yes=false']) assert.throws(() => parseArgs([typo]), /unknown argument/, typo);
  assert.throws(() => parseArgs(['--skip-live-check']), /only with --dry-run/);
  assert.throws(() => parseArgs(['--force']), /unknown argument: --force/);
  assert.throws(() => parseArgs(['now']), /unknown argument: now/);
  // `npm run deploy --dry-run` without `--`: npm keeps the flag and still runs the script, so it must still be a dry run
  const npmDry = parseArgs([], { npm_config_dry_run: 'true' });
  assert.ok(npmDry.dryRun);
  assert.deepEqual(npmDry.npmFlags, ['--dry-run']);
  assert.ok(parseArgs([], { npm_config_push: '' }).noPush, '--no-push given to npm');
  assert.ok(parseArgs([], { npm_config_dry_run: 'true', npm_config_skip_live_check: 'true' }).skipLiveCheck);
  assert.throws(() => parseArgs([], { npm_config_skip_live_check: 'true' }), /only with --dry-run/);
  assert.deepEqual(parseArgs(['--dry-run'], { npm_config_dry_run: 'true' }).npmFlags, [], 'no note when the flag also came through');
  assert.ok(!parseArgs([], { npm_config_dry_run: 'false', npm_config_push: 'true' }).dryRun);
});

test('arguments: a ship flag npm took for itself (no --) stops everything; npm\'s own settings and --yes pass', () => {
  // What npm 11 sets for a script run, probed with a scratch package: `npm run p --dryrun` → npm_config_dryrun=true,
  // `-n` → npm_config_yes="", `--yes` → npm_config_yes=true; npm only warns "Unknown cli config" and runs the script.
  const NPM = { npm_config_cache: 'C:\\npm-cache', npm_config_user_agent: 'npm/11.11.0 node/v24.14.1 win32', npm_config_node_gyp: 'x', npm_config_noproxy: '',
    npm_config_prefix: 'C:\\npm', npm_config_local_prefix: 'C:\\a', npm_config_loglevel: 'silent', npm_config_registry: 'https://registry.npmjs.org/' };
  assert.deepEqual(strayNpmFlags(NPM), []);
  assert.deepEqual(parseArgs([], NPM).npmFlags, []);
  for (const [env, flag] of [[{ npm_config_dryrun: 'true' }, '--dryrun'], [{ NPM_CONFIG_DRYRUN: 'true' }, '--dryrun'], [{ npm_config_yes: '' }, '-n (--no-yes)'],
    [{ npm_config_skip_live: 'true' }, '--skip-live'], [{ npm_config_nopush: 'true' }, '--nopush'], [{ npm_config_allow_unrecorded_live: 'true' }, '--allow-unrecorded-live'],
    [{ npm_config_raw: 'true' }, '--raw'], [{ npm_config_dry: 'false' }, '--dry'], [{ npm_config_y: 'true' }, '--y']]) {
    assert.deepEqual(strayNpmFlags({ ...NPM, ...env }), [flag], JSON.stringify(env));
    assert.throws(() => parseArgs([], { ...NPM, ...env }), /npm took .* for itself.*nothing ran.*npm run deploy -- --dry-run/s, JSON.stringify(env));
    assert.throws(() => parseArgs(['--raw'], { ...NPM, ...env }), /for itself/, 'deploy:raw too');
  }
  assert.deepEqual(strayNpmFlags({ npm_config_yes: 'true' }), [], 'npm\'s own --yes is not ours, and never a go-ahead');
  assert.equal(parseArgs([], { npm_config_yes: 'true' }).yes, false);
});

test('go-ahead: a real ship needs --yes or the VERSION typed at a terminal; deploy:raw needs it typed or the env consent', async () => {
  const asked = [], ask = (answer) => async (q) => { asked.push(q); return answer; };
  assert.equal((await confirmShip({ n: 83, yes: true, tty: false })).ok, true);
  const off = await confirmShip({ n: 83, tty: false });
  assert.equal(off.ok, false);
  assert.match(off.message, /run it in a terminal.*type 83.*--yes: npm run deploy -- --yes/);
  assert.match((await confirmShip({ n: 83, tty: false, npmYes: true })).message, /npm kept the --yes/);
  assert.equal((await confirmShip({ n: 83, what: 'atelier-v83 (abc1234)', tty: true, ask: ask('83') })).ok, true);
  assert.match(asked.at(-1), /Type 83 to deploy atelier-v83 \(abc1234\)/);
  for (const answer of ['', 'y', 'yes', '82', '833', null]) assert.equal((await confirmShip({ n: 83, tty: true, ask: ask(answer) })).ok, false, String(answer));
  assert.equal((await confirmShip({ n: 83, tty: true, ask: ask(' 83 \r') })).ok, true, 'surrounding spaces are fine');

  assert.equal((await confirmRaw({ n: 83, tty: false, consent: RAW_CONSENT })).ok, true);
  for (const consent of [undefined, '', '1', 'true', 'yes', 'i-understand']) {
    const r = await confirmRaw({ n: 83, tty: false, consent });
    assert.equal(r.ok, false, String(consent));
    assert.match(r.message, new RegExp(`${RAW_ENV}=${RAW_CONSENT}.*Nothing was deployed`));
  }
  assert.equal((await confirmRaw({ n: 83, tty: true, ask: ask('83') })).ok, true);
  assert.equal((await confirmRaw({ n: 83, tty: true, ask: ask('') })).ok, false);
  assert.equal((await confirmRaw({ n: null, tty: true, ask: ask('deploy') })).ok, true, 'no readable VERSION: the word deploy');
});

test('versions: parsed from sw.js and index.html (LF or CRLF), compared as numbers', () => {
  assert.equal(versionIn("// shell\r\nconst VERSION = 'atelier-v82';\r\nconst V = 1;\r\n"), 82);
  assert.equal(versionIn("const VERSION = 'atelier-v9';\n"), 9);
  for (const bad of ['<html>502 Bad Gateway</html>', "const VERSION = 'v82';", '', undefined, null]) assert.equal(versionIn(bad), null);
  assert.equal(appVersionIn('<link href="/app.css?v=81" />\r\n<script src="/app.js?v=82" type="module"></script>'), 82);
  assert.equal(appVersionIn('<script src="/app.js" type="module"></script>'), null);
  assert.equal(appVersionIn('<script src="https://x.test/app.js?v=82"></script>'), null);

  assert.equal(versionGate(83, 82).ok, true);
  assert.equal(versionGate(100, 99).ok, true, 'numeric, not string, order');
  const same = versionGate(82, 82);
  assert.equal(same.ok, false);
  assert.equal(same.message, 'local VERSION 82 is not newer than live 82: run node scripts/bump-version.mjs 83, commit, then ship');
  assert.equal(same.next, 83);
  const older = versionGate(81, 83);
  assert.equal(older.ok, false);
  assert.match(older.message, /bump-version\.mjs 84, commit, then ship/);
  assert.match(older.message, /live is ahead of this checkout/);
  assert.equal(versionGate(99, 100).ok, false);
  const offline = versionGate(83, null, 'fetch failed');
  assert.equal(offline.ok, false);
  assert.match(offline.message, /could not read the live VERSION.*fetch failed.*--skip-live-check/);
  assert.equal(versionGate(null, 82).ok, false);
});

test('dirty tree: only the regenerated zip and untracked promo/ folders may differ', () => {
  const problems = (text) => dirtyProblems(parsePorcelainZ(text));
  assert.deepEqual(problems(''), []);
  assert.deepEqual(problems(z(` M ${ZIP}`, '?? promo/revision-2/', '?? promo/revision-3-testers/', '?? promo/my folder/')), []);
  assert.deepEqual(problems(z(`D  ${ZIP}`)), [], 'any state of the zip');
  assert.deepEqual(problems(z(' M promo/tracked.png')), [' M promo/tracked.png'], 'a tracked promo file is a real change');
  assert.deepEqual(problems(z('?? promotion/x.txt')), ['?? promotion/x.txt']);
  assert.deepEqual(problems(z('?? notes.txt', ' M src/worker.js', 'M  public/app.js', 'UU src/sync.js', 'A  tests/new.test.mjs')),
    ['?? notes.txt', ' M src/worker.js', 'M  public/app.js', 'UU src/sync.js', 'A  tests/new.test.mjs']);
  // -z renames: "R  new\0old\0"; the source path is not a separate entry
  const renamed = parsePorcelainZ(z('R  src/new.js', 'src/old.js', ' M README.md'));
  assert.deepEqual(renamed, [{ x: 'R', y: ' ', path: 'src/new.js', orig: 'src/old.js' }, { x: ' ', y: 'M', path: 'README.md' }]);
  assert.deepEqual(dirtyProblems(renamed), ['R  src/old.js -> src/new.js', ' M README.md']);
  assert.deepEqual(problems(z(`R  ${ZIP}`, 'public/other.zip')), [`R  public/other.zip -> ${ZIP}`], 'a zip renamed into place is a real change');
});

test('origin/master: ahead ships, behind or diverged refuses', () => {
  assert.deepEqual(parseAheadBehind('2\t0\n'), { ahead: 2, behind: 0 });
  assert.deepEqual(parseAheadBehind('0 0\r\n'), { ahead: 0, behind: 0 });
  assert.equal(parseAheadBehind('fatal: bad revision'), null);
  assert.equal(parseAheadBehind(''), null);
  const even = syncDecision({ ahead: 0, behind: 0 });
  assert.equal(even.ok, true); assert.equal(even.state, 'even');
  const ahead = syncDecision({ ahead: 3, behind: 0 });
  assert.equal(ahead.ok, true); assert.equal(ahead.state, 'ahead'); assert.match(ahead.message, /3 commits ahead/);
  const behind = syncDecision({ ahead: 0, behind: 1 });
  assert.equal(behind.ok, false); assert.equal(behind.state, 'behind'); assert.match(behind.message, /1 commit behind.*git pull --ff-only/);
  const diverged = syncDecision({ ahead: 2, behind: 5 });
  assert.equal(diverged.ok, false); assert.equal(diverged.state, 'diverged'); assert.match(diverged.message, /diverged.*git pull --rebase/);
  assert.equal(syncDecision(null).ok, false);
  assert.equal(syncDecision({ ahead: NaN, behind: 0 }).ok, false);
});

// A complete bump to 83, in CRLF like a Windows checkout.
const complete = () => ({
  'sw.js': "// Offline shell\r\nconst VERSION = 'atelier-v83';\r\nconst V = VERSION.slice('atelier-v'.length);\r\n",
  'index.html': ['<link rel="stylesheet" href="/app.css?v=83" />', '<link rel="manifest" href="/manifest.webmanifest" />',
    '<script src="/vendor/marked.js"></script>', '<a href="https://example.com/?v=3">x</a>', '<script src="/app.js?v=83" type="module"></script>', ''].join('\r\n'),
  'app.js': ["import { a } from './a.js?v=83';", 'import {', '  b,', "} from \"./b.js?v=83\";", "const lazy = () => import('./lazy.js?v=83');",
    "import marked from '/vendor/marked.js';", "const APP_BUILD = '83';", ''].join('\r\n'),
  'a.js': 'export const a = 1;\r\n',
  'b.js': "export { c } from './c.js?v=83';\r\n",
});

test('bump completeness: sw.js, index.html ?v=, APP_BUILD and every module import must agree', () => {
  assert.deepEqual(bumpProblems(complete(), 83), []);
  const with_ = (name, from, to) => { const f = complete(); assert.ok(f[name].includes(from), `${name} has ${from}`); f[name] = f[name].replace(from, to); return f; };
  assert.deepEqual(bumpProblems(with_('sw.js', 'atelier-v83', 'atelier-v82'), 83), ['public/sw.js VERSION is atelier-v82, not atelier-v83']);
  assert.deepEqual(bumpProblems(with_('index.html', 'app.css?v=83', 'app.css?v=82'), 83), ['public/index.html has href="/app.css?v=82", not ?v=83']);
  assert.deepEqual(bumpProblems(with_('index.html', '/app.js?v=83', '/app.js'), 83), ['public/index.html does not load /app.js?v=83']);
  assert.deepEqual(bumpProblems(with_('app.js', "APP_BUILD = '83'", "APP_BUILD = '82'"), 83), ["public/app.js has const APP_BUILD = '82'; (APP_BUILD must be '83')"]);
  assert.deepEqual(bumpProblems(with_('app.js', "const APP_BUILD = '83';", ''), 83), ["public/app.js has no `const APP_BUILD = '<N>';` line"]);
  assert.deepEqual(bumpProblems(with_('b.js', './c.js?v=83', './c.js?v=82'), 83), ['public/b.js imports ./c.js?v=82, not ./c.js?v=83']);
  assert.deepEqual(bumpProblems(with_('app.js', "'./lazy.js?v=83'", "'./lazy.js'"), 83), ['public/app.js imports ./lazy.js, not ./lazy.js?v=83']);
  assert.deepEqual(bumpProblems(with_('app.js', '"./b.js?v=83"', '"./b.js?v=81"'), 83), ['public/app.js imports ./b.js?v=81, not ./b.js?v=83'], 'multi-line import');
  // a module added after the bump, with an unversioned import: bump-version would still change it
  assert.deepEqual(bumpProblems({ ...complete(), 'new.js': "import { a } from './a.js';\n" }, 83), ['public/new.js imports ./a.js, not ./a.js?v=83']);
  assert.deepEqual(bumpProblems({}, 83), ['public/sw.js is missing', 'public/index.html is missing', 'public/app.js is missing']);
  // sw.js, index.html's two ?v= plus "does not load /app.js?v=84", APP_BUILD, and the four relative imports
  assert.equal(bumpProblems(complete(), 84).length, 9, 'every place still at 83 is listed');
  assert.deepEqual(bumpedFiles(['public/sw.js', 'public/app.css', 'public/vendor', 'public/index.html', 'public/app.js', 'public/icons', 'public/privacy.html', 'public/remix.js']),
    ['public/app.js', 'public/index.html', 'public/remix.js', 'public/sw.js']);
});

test('bump completeness: this repo passes the same check ship runs at step 2', async () => {
  const dir = new URL('../public/', import.meta.url);
  const names = bumpedFiles((await readdir(dir)).map((f) => `public/${f}`));
  const files = {};
  for (const p of names) files[p.slice('public/'.length)] = await readFile(new URL(p.slice('public/'.length), dir), 'utf8');
  const n = versionIn(files['sw.js']);
  assert.ok(Number.isInteger(n), 'public/sw.js has a VERSION');
  assert.deepEqual(bumpProblems(files, n), [], `run node scripts/bump-version.mjs ${n}`);
});

test('file names: every import, sw.js SHELL/LAZY path and index.html src/href must name a file git has, in the same case', () => {
  const listing = ['public/app.js', 'public/a.js', 'public/b.js', 'public/c.js', 'public/lazy.js', 'public/sw.js', 'public/index.html', 'public/app.css',
    'public/privacy.html', 'public/vendor/marked.js', 'public/icons/x.png', 'public/manifest.webmanifest'];
  const sw = (extra) => ["const VERSION = 'atelier-v83';", 'const V = 1;', "const SHELL = ['/', '/index.html', `/app.js?v=${V}`, `/app.css?v=${V}`,",
    `  '/privacy', '/icons/x.png'${extra}];`, "const LAZY = ['/lazy.js'];", ''].join('\r\n');
  const ok = () => ({ ...complete(), 'sw.js': sw(''), 'index.html': `${complete()['index.html']}<a href="/privacy">p</a><a href="/share">s</a><a href="/api/li/start">in</a><link href="//cdn.example/x.css" />` });
  assert.deepEqual(pathProblems(ok(), listing), []);
  const swap = (name, from, to) => { const f = ok(); assert.ok(f[name].includes(from), `${name} has ${from}`); f[name] = f[name].replace(from, to); return f; };
  const cased = (where, ref, real) => [`${where} names ${ref}, but git has ${real}: the live site's file names are case-sensitive`];
  // Windows opens public/A.js for public/a.js; the live site answers index.html (200) there and the module never loads
  assert.deepEqual(pathProblems(swap('app.js', './a.js?v=83', './A.js?v=83'), listing), cased('public/app.js', './A.js', 'public/a.js'));
  assert.deepEqual(pathProblems(swap('sw.js', "'/lazy.js'", "'/Lazy.js'"), listing), cased('public/sw.js LAZY', '/Lazy.js', 'public/lazy.js'));
  assert.deepEqual(pathProblems(swap('sw.js', '/app.css?v=', '/App.css?v='), listing), cased('public/sw.js SHELL', '/App.css', 'public/app.css'));
  assert.deepEqual(pathProblems(swap('index.html', '/vendor/marked.js', '/Vendor/marked.js'), listing), cased('public/index.html', '/Vendor/marked.js', 'public/vendor/marked.js'));
  assert.deepEqual(pathProblems(swap('index.html', 'href="/privacy"', 'href="/Privacy"'), listing), cased('public/index.html', '/Privacy', 'public/privacy.html'));
  // the same miscasing in the import and in SHELL (the case only Linux catches): both reported
  const both = swap('app.js', './a.js?v=83', './A.js?v=83');
  both['sw.js'] = sw(", `/A.js?v=${V}`");
  assert.deepEqual(pathProblems(both, listing), [...cased('public/app.js', './A.js', 'public/a.js'), ...cased('public/sw.js SHELL', '/A.js', 'public/a.js')]);
  // a module (or a precached file) that was never committed
  assert.deepEqual(pathProblems(swap('b.js', './c.js?v=83', './gone.js?v=83'), listing), ["public/b.js names ./gone.js, which git doesn't have at this commit"]);
  assert.deepEqual(pathProblems({ ...ok(), 'sw.js': sw(", '/missing.png'") }, listing), ["public/sw.js SHELL names /missing.png, which git doesn't have at this commit"]);
});

test('file names: this repo\'s public/ passes the check ship runs at step 2 (names as the file system has them)', async () => {
  const listing = [];
  const walk = async (dir, rel) => {
    for (const d of await readdir(dir, { withFileTypes: true })) {
      if (d.isDirectory()) await walk(new URL(`${d.name}/`, dir), `${rel}${d.name}/`);
      else listing.push(`${rel}${d.name}`);
    }
  };
  const dir = new URL('../public/', import.meta.url);
  await walk(dir, 'public/');
  const files = {};
  for (const p of bumpedFiles(listing)) files[p.slice('public/'.length)] = await readFile(new URL(p.slice('public/'.length), dir), 'utf8');
  assert.ok(Object.keys(files).length > 10 && files['sw.js'] && files['index.html']);
  assert.deepEqual(pathProblems(files, listing), []);
});

test('live record: a deploy whose commit is not in HEAD\'s history is never replaced; one without a record only on purpose', () => {
  const sha = 'b'.repeat(40), live = 'a'.repeat(40);
  const rec = (over = {}) => parseRecord(JSON.stringify(shipRecord({ sha: live, version: 82, at: '2026-10-08T16:00:00.000Z', ...over })));
  assert.deepEqual(rec(), { sha: live, version: 82, source: 'ship', dirty: false, at: '2026-10-08T16:00:00.000Z' });
  for (const bad of ['', '<!doctype html><html>…index.html, the site\'s fallback</html>', '[]', 'null', '{"sha":"abc","version":82,"source":"ship"}',
    JSON.stringify({ sha: live, version: '82', source: 'ship' }), JSON.stringify({ sha: live, version: 82, source: 'other' }), undefined]) assert.equal(parseRecord(bad), null, String(bad).slice(0, 30));
  assert.equal(RECORD, 'ship.json');

  const ok = liveOriginDecision({ record: rec(), liveVersion: 82, sha, exists: true, ancestor: true });
  assert.deepEqual([ok.ok, ok.state], [true, 'ancestor']);
  // someone shipped a commit that isn't here: refused, with whose work would go
  const lost = ['a1b2c3d coen-gpt: tweak the share sheet', 'e4f5a6b eColi: fix Look up'];
  const div = liveOriginDecision({ record: rec(), liveVersion: 82, sha, exists: true, ancestor: false, lost, allowUnrecorded: true });
  assert.deepEqual([div.ok, div.state], [false, 'diverged'], '--allow-unrecorded-live never covers a known commit');
  assert.match(div.message, /shipped from aaaaaaa \(2026-10-08T16:00:00\.000Z\), which is not in bbbbbbb's history: deploying would roll back 2 commits/);
  assert.match(div.message, /coen-gpt: tweak the share sheet[\s\S]*eColi: fix Look up[\s\S]*git merge aaaaaaaaaaaa/);
  const gone = liveOriginDecision({ record: rec(), liveVersion: 82, sha, exists: false, allowUnrecorded: true });
  assert.deepEqual([gone.ok, gone.state], [false, 'missing']);
  assert.match(gone.message, /isn't in this clone.*git fetch origin a{40}/);
  // no record (an older deploy, an older branch's npm run deploy, a rollback), a stale one, or a dirty deploy:raw
  for (const [record, liveVersion, state, re] of [[null, 82, 'unrecorded', /atelier-v82 has no ship record/], [rec({ version: 81 }), 82, 'unrecorded', /records atelier-v81.*but the live sw\.js is atelier-v82/],
    [rec({ source: 'raw', dirty: true }), 82, 'raw', /deploy:raw of aaaaaaa .* with uncommitted changes/]]) {
    const no = liveOriginDecision({ record, liveVersion, sha });
    assert.deepEqual([no.ok, no.state], [false, state]);
    assert.match(no.message, re);
    assert.match(no.message, /ship with --allow-unrecorded-live/);
    assert.equal(liveOriginDecision({ record, liveVersion, sha, allowUnrecorded: true }).ok, true);
  }
  // a clean deploy:raw is as good as a ship of that commit
  assert.equal(liveOriginDecision({ record: rec({ source: 'raw' }), liveVersion: 82, sha, exists: true, ancestor: true }).ok, true);
});

test('wrangler failing after the upload: a live new VERSION still goes on to the push; otherwise the exact push command', () => {
  const sha = 'c'.repeat(40);
  const live = afterWranglerFailure({ live: 83, local: 83, sha, status: 'exit 1' });
  assert.equal(live.live, true);
  assert.match(live.message, /already reports atelier-v83.*Going on to the live check and the push/);
  for (const v of [82, null]) {
    const not = afterWranglerFailure({ live: v, local: 83, sha, status: 'exit 1' });
    assert.equal(not.live, false);
    assert.match(not.message, new RegExp(`reports ${v == null ? 'nothing readable' : 'atelier-v82'}\\. Nothing was pushed\\..*git push origin c{40}:refs/heads/master`));
  }
});

test('the clean worktree is CRLF on Windows whatever git\'s own config says', () => {
  assert.deepEqual(worktreeAddArgs('C:\\T\\atelier', 'abc', 'win32'), ['-c', 'core.autocrlf=true', 'worktree', 'add', '--detach', 'C:\\T\\atelier', 'abc']);
  assert.deepEqual(worktreeAddArgs('/tmp/atelier', 'abc', 'linux'), ['worktree', 'add', '--detach', '/tmp/atelier', 'abc']);
});

test('deploy guard: wrangler deploy runs only from ship\'s worktree (ATELIER_SHIP=1) or a confirmed deploy:raw; dev and types always', async () => {
  const T = 'C:\\Users\\cole\\AppData\\Local\\Temp', wt = `${T}\\atelier-ship-Ab12Cd\\atelier`, home = 'C:\\Users\\cole\\OneDrive\\Desktop\\Assistant';
  const g = (command, ship, root) => guardDecision({ command, ship, root, tmp: T, platform: 'win32' }).ok;
  assert.equal(g('deploy', '1', wt), true);
  assert.equal(g('versions upload', '1', wt), true);
  assert.equal(g('deploy', 'raw', home), true);
  for (const c of ['dev', 'types']) assert.equal(g(c, undefined, home), true, c);
  assert.equal(g('deploy', undefined, home), false, 'npx wrangler deploy in the main folder');
  assert.equal(g('deploy', '1', home), false, 'ATELIER_SHIP=1 outside the ship worktree');
  assert.equal(g('deploy', undefined, wt), false);
  assert.equal(g('versions upload', undefined, home), false);
  assert.equal(g(undefined, undefined, home), false, 'an unknown command is treated as a deploy');
  assert.equal(g('deploy', '1', `${T}\\atelier-ship-Ab12Cd\\other`), false);
  assert.equal(g('deploy', '1', `${T}\\elsewhere\\atelier`), false);
  assert.equal(g('deploy', 'yes', home), false);
  assert.match(guardDecision({ command: 'deploy', root: home, tmp: T, platform: 'win32' }).message, /Refusing `wrangler deploy`.*npm run deploy/s);
  assert.equal(guardDecision({ command: 'deploy', ship: '1', root: '/tmp/atelier-ship-x/atelier', tmp: '/tmp', platform: 'linux' }).ok, true);
  // wrangler runs the guard: build.command in wrangler.jsonc (full-line comments only, as the other tests parse it)
  const cfg = JSON.parse((await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8')).replace(/^\s*\/\/.*$/gm, ''));
  assert.deepEqual(cfg.build, { command: 'node scripts/deploy-guard.mjs' });
});

test('git cat-file --batch output is split by byte size (CRLF and UTF-8 content intact), missing objects marked', () => {
  const blob = (oid, s) => Buffer.concat([Buffer.from(`${oid} blob ${Buffer.byteLength(s)}\n`), Buffer.from(s), Buffer.from('\n')]);
  const out = parseCatFileBatch(Buffer.concat([blob('abc123', 'hello\nworld'), Buffer.from('deadbeef:public/x.js missing\n'), blob('def456', 'a\r\nb — é\n'), blob('0f0f', '')]));
  assert.equal(out.length, 4);
  assert.deepEqual([out[0].oid, out[0].type, out[0].content.toString()], ['abc123', 'blob', 'hello\nworld']);
  assert.equal(out[1].missing, true);
  assert.equal(out[2].content.toString(), 'a\r\nb — é\n');
  assert.equal(out[3].content.length, 0);
  assert.deepEqual(parseCatFileBatch(Buffer.alloc(0)), []);
});

// What node --test --test-reporter=tap writes: a failing test, a suite with a failing child, a file that doesn't load.
const TAP = [
  'TAP version 13',
  '# Subtest: passes', 'ok 1 - passes', '  ---', '  duration_ms: 0.9', "  type: 'test'", '  ...',
  '# Subtest: fails top', 'not ok 2 - fails top', '  ---', '  duration_ms: 1.3', "  type: 'test'",
  "  location: 'C:\\\\Temp\\\\atelier-ship-x\\\\atelier\\\\tests\\\\a.test.mjs:4:1'", "  failureType: 'testCodeFailure'",
  '  error: |-', '    Expected values to be strictly equal:', '    ', '    1 !== 2', '    ', "  code: 'ERR_ASSERTION'", '  stack: |-', '    at x', '  ...',
  '# Subtest: group',
  '    # Subtest: nested fail', '    not ok 1 - nested fail', '      ---', "      failureType: 'testCodeFailure'", "      error: 'boom'", '      ...',
  '    # Subtest: nested ok', '    ok 2 - nested ok', '      ---', '      ...', '    1..2',
  'not ok 3 - group', '  ---', "  type: 'suite'", "  failureType: 'subtestsFailed'", "  error: '1 subtest failed'", '  ...',
  '# Subtest: skipped', 'ok 4 - skipped # SKIP', '  ---', '  ...',
  '# file:///C:/x/tests/c.test.mjs:2', '# syntax error here', '# SyntaxError: Unexpected identifier',
  '# Subtest: tests\\\\c.test.mjs', 'not ok 3 - tests\\\\c.test.mjs', '  ---', "  failureType: 'testCodeFailure'", '  exitCode: 1', "  error: 'test failed'", '  ...',
  '1..5', '# tests 7', '# suites 1', '# pass 4', '# fail 3', '# cancelled 0', '# skipped 1', '# todo 0', '# duration_ms 166',
];

test('test output: failing test names (suite > test), errors and counts come out of the TAP report, LF or CRLF', () => {
  for (const eol of ['\n', '\r\n']) {
    const r = parseTap(TAP.join(eol));
    assert.deepEqual([r.tests, r.pass, r.fail, r.cancelled], [7, 4, 3, 0]);
    assert.deepEqual(r.failures.map((f) => f.name), ['fails top', 'group > nested fail', 'tests\\c.test.mjs']);
    assert.equal(r.failures[0].error, 'Expected values to be strictly equal: / 1 !== 2');
    assert.equal(r.failures[0].location, 'C:\\Temp\\atelier-ship-x\\atelier\\tests\\a.test.mjs:4:1');
    assert.equal(r.failures[1].error, 'boom');
    assert.equal(r.failures[2].error, 'test failed');
  }
  const green = parseTap('TAP version 13\n# Subtest: a\nok 1 - a\n1..1\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n');
  assert.deepEqual([green.tests, green.pass, green.fail, green.failures.length], [1, 1, 0, 0]);
  assert.deepEqual([parseTap('').tests, parseTap(undefined).failures.length], [0, 0], 'no report = no tests (ship treats that as a failure)');
});

test('cleanup only ever deletes a ship folder directly inside the temp folder', () => {
  const T = 'C:\\Users\\cole\\AppData\\Local\\Temp';
  assert.equal(isSafeTempDir(`${T}\\atelier-ship-AbC123`, T, 'win32'), true);
  assert.equal(isSafeTempDir('c:\\users\\COLE\\appdata\\local\\temp\\atelier-ship-x', T, 'win32'), true, 'Windows paths ignore case');
  assert.equal(isSafeTempDir(`${T}\\`, T, 'win32'), false);
  assert.equal(isSafeTempDir(`${T}\\atelier-ship-`, T, 'win32'), false);
  assert.equal(isSafeTempDir(`${T}\\other\\atelier-ship-x`, T, 'win32'), false, 'one level down only');
  assert.equal(isSafeTempDir(`${T}\\node_modules`, T, 'win32'), false);
  assert.equal(isSafeTempDir('C:\\Users\\cole\\OneDrive\\Desktop\\Assistant', T, 'win32'), false);
  assert.equal(isSafeTempDir(`${T}\\atelier-ship-x\\..\\..\\..\\Desktop`, T, 'win32'), false);
  assert.equal(isSafeTempDir('/tmp/atelier-ship-abc', '/tmp', 'linux'), true);
  assert.equal(isSafeTempDir('/tmp/../home/cole/atelier-ship-abc', '/tmp', 'linux'), false);
  assert.equal(isSafeTempDir('/TMP/atelier-ship-abc', '/tmp', 'linux'), false, 'case matters off Windows');
  assert.equal(isSafeTempDir('', '/tmp', 'linux'), false);
  assert.equal(isSafeTempDir(undefined, '/tmp', 'linux'), false);
});

// A fake clock and a fake site: sleep() just moves the clock.
function fakeSite(script) {
  let t = 0, polls = 0;
  const urls = [];
  return {
    urls, get polls() { return polls; },
    now: () => t,
    sleep: async (ms) => { t += ms; },
    fetchText: async (url) => {
      urls.push(url);
      if (url === `${SITE}/sw.js`) polls++;
      return script(url, polls, t);
    },
  };
}

test('live check: waits for the new sw.js and index.html, and gives up after the timeout', async () => {
  const sw = (n) => `const VERSION = 'atelier-v${n}';`, html = (n) => `<script src="/app.js?v=${n}" type="module"></script>`;
  const lag = fakeSite((url, polls) => (url.endsWith('/sw.js') ? sw(polls < 3 ? 82 : 83) : html(83)));
  const seen = [];
  const ok = await waitForLive({ n: 83, fetchText: lag.fetchText, sleep: lag.sleep, now: lag.now, onPoll: (p) => seen.push(p.sw) });
  assert.deepEqual([ok.ok, ok.sw, ok.app, ok.waitedMs], [true, 83, 83, 6000]);
  assert.deepEqual(seen, [82, 82]);
  assert.ok(lag.urls.every((u) => u === `${SITE}/sw.js` || u === `${SITE}/`), 'only the live site');

  const edge = fakeSite((url, polls) => (url.endsWith('/sw.js') ? sw(83) : html(polls < 2 ? 82 : 83)));
  const late = await waitForLive({ n: 83, fetchText: edge.fetchText, sleep: edge.sleep, now: edge.now });
  assert.deepEqual([late.ok, late.app, late.waitedMs], [true, 83, 3000], 'index.html is checked too');

  const stuck = fakeSite(() => sw(82));
  const never = await waitForLive({ n: 83, fetchText: stuck.fetchText, sleep: stuck.sleep, now: stuck.now });
  assert.deepEqual([never.ok, never.sw, never.waitedMs], [false, 82, 120000]);
  assert.equal(stuck.polls, 41, 'every 3 s for 120 s');

  const down = fakeSite(() => { throw new Error('HTTP 522'); });
  const offline = await waitForLive({ n: 83, fetchText: down.fetchText, sleep: down.sleep, now: down.now, timeoutMs: 9000 });
  assert.deepEqual([offline.ok, offline.sw, offline.error], [false, null, 'HTTP 522']);
});

test('check-bump: public/ and src/ changes need a VERSION bump; docs, tests and the zip do not', () => {
  assert.deepEqual(needsBump(['README.md', 'tests/ship.test.mjs', 'scripts/ship.mjs', '.github/workflows/ci.yml', 'package.json', ZIP, 'docs/x.md']), []);
  assert.deepEqual(needsBump(['public/app.js', 'src/worker.js', 'src/tester/router.js', 'publicity.md', 'srcs/x.js', 'tests/public/x.js', 'public/icons/a.png']),
    ['public/app.js', 'src/worker.js', 'src/tester/router.js', 'public/icons/a.png']);

  assert.equal(bumpVerdict({ paths: ['README.md', 'tests/a.test.mjs'], baseVersion: 82, headVersion: 82 }).ok, true);
  assert.equal(bumpVerdict({ paths: [], baseVersion: 82, headVersion: 82 }).ok, true);
  assert.equal(bumpVerdict({ paths: [ZIP], baseVersion: 82, headVersion: 82 }).ok, true);
  const missed = bumpVerdict({ paths: ['README.md', 'public/app.js', 'src/worker.js'], baseVersion: 82, headVersion: 82 });
  assert.equal(missed.ok, false);
  assert.deepEqual(missed.touched, ['public/app.js', 'src/worker.js']);
  assert.match(missed.message, /VERSION is still atelier-v82, but this change touches 2 files in public\/ or src\//);
  assert.match(missed.message, /public\/app\.js/);
  assert.match(missed.message, /node scripts\/bump-version\.mjs 83, commit, push/);
  assert.equal(bumpVerdict({ paths: ['public/app.js'], baseVersion: 82, headVersion: 83 }).ok, true);
  assert.equal(bumpVerdict({ paths: ['src/worker.js'], baseVersion: 82, headVersion: 90 }).ok, true);
  const back = bumpVerdict({ paths: ['public/sw.js'], baseVersion: 83, headVersion: 82 });
  assert.equal(back.ok, false);
  assert.match(back.message, /went backwards.*bump-version\.mjs 84/s);
  assert.equal(bumpVerdict({ paths: ['public/app.js'], baseVersion: 82, headVersion: null }).ok, false);
  assert.equal(bumpVerdict({ paths: ['public/app.js'], baseVersion: null, headVersion: 1 }).ok, true);

  assert.equal(isNullSha('0000000000000000000000000000000000000000'), true, 'a new branch push');
  assert.equal(isNullSha(''), true);
  assert.equal(isNullSha(undefined), true);
  assert.equal(isNullSha('8bd5e80'), false);
  assert.equal(swVersion("const VERSION = 'atelier-v82';\r\n"), 82);
  assert.equal(swVersion('nothing'), null);
});

test('check-bump: a force push fails (what it replaced can\'t be compared), a shallow clone is refused, a first commit passes', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';
  assert.deepEqual(baseDecision({ base: sha, baseExists: true, parentExists: true }), { base: sha });
  assert.deepEqual(baseDecision({ base: '', parentExists: true }), { base: 'HEAD~1' }, 'no base given: the previous commit');
  assert.deepEqual(baseDecision({ base: '0'.repeat(40), head: 'abc', parentExists: true }), { base: 'abc~1' }, 'a new branch');
  const forced = baseDecision({ base: sha, baseExists: false, parentExists: true });
  assert.equal(forced.exit, 1);
  assert.match(forced.message, /not in this clone: a force push replaced it.*can't be compared/);
  for (const base of [sha, '', undefined]) {
    const shallow = baseDecision({ base, shallow: true, baseExists: true, parentExists: false });
    assert.equal(shallow.exit, 2, String(base));
    assert.match(shallow.message, /shallow clone.*fetch-depth: 0/);
  }
  assert.deepEqual(baseDecision({ base: '', parentExists: false }).exit, 0, 'the repository\'s first commit');
});

test('package.json: deploy is the safe ship; deploy:raw is ship --raw (confirmed); no script runs wrangler deploy itself', async () => {
  const { scripts } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(scripts.ship, 'node scripts/ship.mjs');
  assert.equal(scripts.deploy, 'node scripts/ship.mjs', 'other agents run npm run deploy: it must be the checked path');
  assert.deepEqual(DEPLOY_COMMANDS, ['node scripts/pack-extension.mjs', 'wrangler deploy']);
  // One command, so `npm run deploy:raw -- <flags>` reaches ship (never a wrangler deploy at the end of an && chain).
  assert.equal(scripts['deploy:raw'], 'node scripts/ship.mjs --raw');
  for (const [name, line] of Object.entries(scripts)) assert.doesNotMatch(line, /wrangler (deploy|versions)/, `${name} must not deploy around ship`);
  for (const f of ['src/spend.js', 'public/spend.js']) assert.ok(scripts.check.includes(`node --check ${f}`), `npm run check covers ${f}`);
});

test('the command line: usage errors, a missing go-ahead and deploy:raw without consent stop before any git, network or deploy step', async (t) => {
  const lines = [];
  t.mock.method(console, 'log', (...a) => lines.push(a.join(' ')));
  t.mock.method(console, 'error', (...a) => lines.push(a.join(' ')));
  const never = async () => { throw new Error('no prompt expected'); };
  assert.equal(await main(['--help'], {}), 0);
  assert.equal(await main(['--bogus'], {}), 2);
  assert.equal(await main(['--skip-live-check'], {}), 2);
  // `npm run deploy --dryrun`: npm keeps the (misspelt) flag and still runs ship, which must not deploy
  assert.equal(await main([], { npm_config_dryrun: 'true' }, { tty: false, prompt: never }), 2);
  assert.equal(await main([], { npm_config_yes: '' }, { tty: false, prompt: never }), 2, '-n');
  // a real ship off a terminal without --yes: refused before step 1
  assert.equal(await main([], {}, { tty: false, prompt: never }), 2);
  assert.ok(lines.some((l) => /a real deploy needs a go-ahead/.test(l)));
  // `npm run deploy:raw --dry-run` / `--dryrun`: never a deploy
  assert.equal(await main(['--raw'], { npm_config_dry_run: 'true' }, { tty: false, prompt: never }), 1);
  assert.equal(await main(['--raw'], { npm_config_dryrun: 'true' }, { tty: false, prompt: never }), 2);
  // deploy:raw off a terminal without ATELIER_RAW_DEPLOY=I-UNDERSTAND, and at a terminal with the wrong answer
  assert.equal(await main(['--raw'], { [RAW_ENV]: 'yes' }, { tty: false, prompt: never }), 1);
  assert.equal(await main(['--raw'], {}, { tty: true, prompt: async () => 'y' }), 1);
  assert.ok(lines.some((l) => l.includes('UNCHECKED DEPLOY')));
  assert.ok(lines.some((l) => /typed, not \d+: nothing was deployed/.test(l)));
  assert.ok(!lines.some((l) => l.startsWith('== ')), 'no ship step ran');
});

test('CI runs the checks on Linux and Windows (CRLF), with no secrets and no deploy; pushes to master are never cancelled', async () => {
  const yml = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  for (const s of ['ubuntu-latest', 'windows-latest', 'core.autocrlf true', 'node-version: 24', 'npm ci', 'npm run check',
    'node --test tests/*.test.mjs', 'node scripts/check-bump.mjs', 'pull_request', 'push', 'fetch-depth: 0']) assert.ok(yml.includes(s), `ci.yml has ${s}`);
  assert.doesNotMatch(yml, /secrets\./, 'CI needs no secrets');
  assert.doesNotMatch(yml, /wrangler|npm run (deploy|ship)|scripts\/ship\.mjs/, 'CI never deploys');
  // A cancelled run would hide an unbumped push (check-bump compares only that push's range): one group per pushed
  // commit, and only pull request runs cancel their older ones.
  assert.ok(yml.includes("group: ${{ github.event_name == 'pull_request' && format('ci-pr-{0}', github.ref) || format('ci-push-{0}', github.sha) }}"));
  assert.ok(yml.includes("cancel-in-progress: ${{ github.event_name == 'pull_request' }}"));
  assert.doesNotMatch(yml, /cancel-in-progress: true/);
});
