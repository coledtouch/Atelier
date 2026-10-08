// CI's "version bumped" gate: a change to public/ or src/ must move public/sw.js VERSION up. sw.js serves the app
// cache-first and every module URL carries ?v=<VERSION>, so a deploy without a bump leaves installed phones running
// their old cached modules (it happened twice in October 2026, with two commits made by other agents).
// Docs-only and tests-only changes never need a bump, and neither does public/atelier-browser.zip (every deploy
// regenerates it).
// Usage: node scripts/check-bump.mjs [<base> [<head>]]
//   <base>: the PR base commit, or the commit before a push. Missing or all zeros (a new branch): the previous commit.
//   Not in this clone (a force push rewrote the branch): FAIL, since what the push replaced can't be compared. Locally,
//   `node scripts/check-bump.mjs origin/master` checks what a push would add.
//   <head>: default HEAD.
// A shallow clone is refused (exit 2): its "first commit" would pass anything. CI checks out with fetch-depth: 0.
// Exit 0 = fine, 1 = public/ or src/ changed without a bump (or a force push), 2 = git trouble. tests/ship.test.mjs
// covers the rules.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { VERSION_RE } from './bump-version.mjs';

export const BUMP_DIRS = ['public/', 'src/'];
export const NO_BUMP_FILES = new Set(['public/atelier-browser.zip']);

/** The changed paths that need a VERSION bump. */
export const needsBump = (paths) => paths.filter((p) => BUMP_DIRS.some((d) => p.startsWith(d)) && !NO_BUMP_FILES.has(p));

export const isNullSha = (s) => !s || /^0+$/.test(s);

export function swVersion(src) {
  const m = String(src ?? '').match(VERSION_RE);
  return m ? Number(m[2]) : null;
}

/** → { ok, message, touched } for the changed paths and the sw.js VERSION before and after. */
export function bumpVerdict({ paths, baseVersion, headVersion }) {
  const touched = needsBump(paths);
  if (!touched.length) {
    return { ok: true, touched, message: `no public/ or src/ changes in ${paths.length} changed file${paths.length === 1 ? '' : 's'}: no VERSION bump needed` };
  }
  if (headVersion == null) return { ok: false, touched, message: "public/sw.js has no `const VERSION = 'atelier-v<N>';` line" };
  if (baseVersion == null) return { ok: true, touched, message: `public/sw.js had no VERSION at the base: atelier-v${headVersion} is the first` };
  if (headVersion > baseVersion) {
    return { ok: true, touched, message: `VERSION atelier-v${baseVersion} → atelier-v${headVersion} covers ${touched.length} changed file${touched.length === 1 ? '' : 's'} in public/ and src/` };
  }
  const shown = touched.slice(0, 20).map((p) => `  ${p}`).join('\n') + (touched.length > 20 ? `\n  … and ${touched.length - 20} more` : '');
  const head = headVersion < baseVersion
    ? `public/sw.js VERSION went backwards, atelier-v${baseVersion} → atelier-v${headVersion}`
    : `public/sw.js VERSION is still atelier-v${baseVersion}`;
  return {
    ok: false, touched,
    message: `${head}, but this change touches ${touched.length} file${touched.length === 1 ? '' : 's'} in public/ or src/:\n${shown}\n`
      + 'sw.js serves the app cache-first and module URLs carry ?v=, so without a bump installed phones keep the old cached modules.\n'
      + `Fix: node scripts/bump-version.mjs ${Math.max(baseVersion, headVersion) + 1}, commit, push. (Docs-only and tests-only changes need no bump.)`,
  };
}

function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 26, windowsHide: true });
  return { ok: !r.error && r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * Which commit to compare HEAD with. base: as given; shallow: `git rev-parse --is-shallow-repository`; baseExists /
 * parentExists: whether git has <base> / <head>~1. → {base} | {exit, message} (0: the repository's first commit; 1: a
 * force push, which can't be checked; 2: a shallow clone, which can't tell a first commit from a cut-off history).
 */
export function baseDecision({ base, head = 'HEAD', shallow = false, baseExists = false, parentExists = false }) {
  if (shallow) return { exit: 2, message: `check-bump: this is a shallow clone, so ${head}'s history is cut off and can't be compared: fetch the full history (actions/checkout fetch-depth: 0)` };
  if (!isNullSha(base) && !baseExists) {
    return { exit: 1, message: `check-bump: ${base} is not in this clone: a force push replaced it, so what this push changed can't be compared and a missing VERSION bump would go unseen. Check by hand that public/sw.js VERSION is above the live one (npm run deploy -- --dry-run says), then push a new commit: its check compares with this one.` };
  }
  if (!isNullSha(base)) return { base };
  if (!parentExists) return { exit: 0, message: 'check-bump: the first commit has nothing to compare with: ok' };
  return { base: `${head}~1` };
}

export function main(argv = process.argv.slice(2)) {
  let [base, head = 'HEAD'] = argv;
  const exists = (ref) => git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).ok;
  if (!exists(head)) { console.error(`check-bump: ${head} is not a commit here`); return 2; }
  const sh = git(['rev-parse', '--is-shallow-repository']);
  if (!sh.ok) { console.error(`check-bump: git rev-parse --is-shallow-repository failed: ${sh.stderr.trim()}`); return 2; }
  const pick = baseDecision({ base, head, shallow: sh.stdout.trim() === 'true', baseExists: !isNullSha(base) && exists(base), parentExists: exists(`${head}~1`) });
  if (pick.exit != null) {
    (pick.exit ? console.error : console.log)(pick.message);
    if (pick.exit === 1 && process.env.GITHUB_ACTIONS) console.log(`::error title=Force push: VERSION bump not checked::${pick.message.replace(/%/g, '%25').replace(/\r?\n/g, '%0A')}`);
    return pick.exit;
  }
  base = pick.base;
  const diff = git(['diff', '--name-only', '-z', `${base}...${head}`]);
  if (!diff.ok) { console.error(`check-bump: git diff ${base}...${head} failed: ${diff.stderr.trim()}`); return 2; }
  const paths = diff.stdout.split('\0').filter(Boolean);
  const versionAt = (ref) => { const r = git(['show', `${ref}:public/sw.js`]); return r.ok ? swVersion(r.stdout) : null; };
  const verdict = bumpVerdict({ paths, baseVersion: versionAt(base), headVersion: versionAt(head) });
  const range = `${base.slice(0, 12)}...${head}`;
  if (verdict.ok) { console.log(`check-bump (${range}): ok, ${verdict.message}`); return 0; }
  console.error(`check-bump (${range}): FAIL\n${verdict.message}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=VERSION not bumped::${verdict.message.replace(/%/g, '%25').replace(/\r?\n/g, '%0A')}`);
  return 1;
}

function isMain() {
  if (!process.argv[1]) return false;
  const real = (p) => { const r = realpathSync(p); return process.platform === 'win32' ? r.toLowerCase() : r; };
  try { return real(process.argv[1]) === real(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isMain()) process.exitCode = main();
