// npm run ship (and npm run deploy, which runs this same script): deploys Atelier only when it is safe.
//   1. The working tree is clean (public/atelier-browser.zip and untracked promo/ folders may differ) and HEAD is not
//      behind or diverged from origin/master after a fetch. Ahead is fine: it is pushed at the end.
//   2. public/sw.js VERSION at HEAD is newer than the live one, and the bump is complete (index.html ?v=, every module
//      import ?v= and app.js APP_BUILD agree), so installed phones fetch the new modules instead of keeping cached ones.
//      Every module import, sw.js SHELL/LAZY path and index.html src/href names a file git has in exactly that case
//      (the live site is case-sensitive; Windows and the :8791 fixture are not). The live deploy's record
//      (<site>/ship.json) names a commit that is in HEAD's history, so a deploy never rolls back someone else's.
//   3. A clean, detached worktree of HEAD in the OS temp folder (CRLF on Windows, forced, like a fresh checkout; never
//      a node_modules junction): npm ci, npm run check, then every tests/*.test.mjs, gated on the real exit codes.
//   4. A person types the VERSION at the terminal (or --yes was given), then from that worktree: pack the extension zip,
//      write public/ship.json (this commit), then wrangler deploy with ATELIER_SHIP=1, which wrangler.jsonc's build
//      guard (scripts/deploy-guard.mjs) requires: a plain `wrangler deploy` anywhere else stops before uploading.
//   5. Poll the live sw.js until it reports the new VERSION (about 120 s at most), then check index.html loads it.
//   6. git push origin <deployed commit>:master (--no-push skips it).
//   7. Always remove the worktree, and never delete anything outside the temp folder.
// Flags: --dry-run (steps 1-3 only), --skip-live-check (with --dry-run only, offline), --no-push, --yes,
// --allow-unrecorded-live, --help. --raw is npm run deploy:raw (confirmed, unchecked).
// tests/ship.test.mjs covers the decisions below with fakes; nothing there touches the network, git remotes or wrangler.
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { VERSION_RE, HTML_RE, IMPORT_RE, BUILD_RE } from './bump-version.mjs';

export const SITE = 'https://atelier.ciprari.ai';
export const ZIP = 'public/atelier-browser.zip';
export const TMP_PREFIX = 'atelier-ship-';
export const LIVE_TIMEOUT_MS = 120_000;
export const LIVE_INTERVAL_MS = 3_000;
// What step 4 runs inside the verified worktree; npm run deploy:raw (--raw) runs the same two commands in place.
export const DEPLOY_COMMANDS = ['node scripts/pack-extension.mjs', 'wrangler deploy'];
// The deploy's record, served at <site>/ship.json: written into public/ only in what is being deployed (the ship
// worktree, or around a deploy:raw), never committed (.gitignore). A deploy made any other way has none, and the
// site's single-page fallback answers index.html there instead.
export const RECORD = 'ship.json';
// npm run deploy:raw off a terminal (an agent, a script) needs this variable set to exactly this value.
export const RAW_ENV = 'ATELIER_RAW_DEPLOY';
export const RAW_CONSENT = 'I-UNDERSTAND';
const ROOT = fileURLToPath(new URL('..', import.meta.url));

export const USAGE = `Usage: npm run ship [-- <flags>]      (npm run deploy is the same safe command)
       node scripts/ship.mjs [<flags>]
  --dry-run                steps 1-3 only (tree, versions, clean-worktree tests); never deploys or pushes
  --skip-live-check        with --dry-run only: don't fetch the live sw.js (offline)
  --no-push                deploy, but leave the push to origin/master to you
  --yes                    deploy without the "type the VERSION" prompt (needed when not run from a terminal)
  --allow-unrecorded-live  replace a live deploy that has no ship record (made before ship, or by deploy:raw)
  --help                   this text
Flags go after --: npm run deploy -- --dry-run. A flag npm takes for itself (no --) stops ship before anything runs.
Unchecked escape hatch (no tests, no version check, no push; you type the VERSION, or off a terminal set
${RAW_ENV}=${RAW_CONSENT}): npm run deploy:raw`;

// ── pure decisions (unit-tested) ─────────────────────────────────────────────────────────────────────────────────────

/**
 * npm_config_* variables that look like a ship flag given to npm instead of to ship (`npm run deploy --dryrun`, `-n`,
 * `--skip-live`, …): npm warns "Unknown cli config", sets npm_config_<name>, and still runs the script, which would
 * then deploy for real. The three npm spellings ship honours (dry_run, skip_live_check, push) are left to parseArgs;
 * npm_config_yes="true" is npm's own --yes, never a confirmation. → the flags as typed ('--dryrun', …).
 */
export function strayNpmFlags(env = {}) {
  const out = [];
  for (const [k, v] of Object.entries(env)) {
    const m = /^npm_config_(.+)$/i.exec(k);
    if (!m) continue;
    const name = m[1].toLowerCase(), norm = name.replace(/[-_]/g, '');
    if (name === 'dry_run' || name === 'skip_live_check' || name === 'push') continue;
    if (name === 'yes') { if (v !== 'true') out.push('-n (--no-yes)'); continue; } // -n: "dry run" in git/make, not in npm
    if (/dry|skip|live|push|ship|deploy|raw|confirm|unrecorded/.test(norm) || norm === 'n' || norm === 'y') out.push(`--${name.replace(/_/g, '-')}`);
  }
  return out.sort();
}

/** argv (+ the npm_config_* env npm sets when a flag is given without `--`) → options. Throws on anything unknown. */
export function parseArgs(argv = [], env = {}) {
  const opts = { dryRun: false, skipLiveCheck: false, noPush: false, yes: false, allowUnrecorded: false, help: false, raw: false, npmFlags: [] };
  for (const a of argv) {
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--skip-live-check') opts.skipLiveCheck = true;
    else if (a === '--no-push') opts.noPush = true;
    else if (a === '--yes') opts.yes = true;
    else if (a === '--allow-unrecorded-live') opts.allowUnrecorded = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--raw') opts.raw = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  const stray = strayNpmFlags(env);
  if (stray.length) {
    throw new Error(`npm took ${stray.join(', ')} for itself (flags without \`--\` go to npm, which still runs the script), so nothing ran. Put ship's flags after --: npm run deploy -- --dry-run`);
  }
  // `npm run deploy --dry-run` (no `--`) gives the flag to npm, not to this script, and npm still runs the script: a
  // real deploy where a dry run was meant. npm reports such flags as npm_config_* variables, so honour them here.
  if (env.npm_config_dry_run === 'true' && !opts.dryRun) { opts.dryRun = true; opts.npmFlags.push('--dry-run'); }
  if (env.npm_config_skip_live_check === 'true' && !opts.skipLiveCheck) { opts.skipLiveCheck = true; opts.npmFlags.push('--skip-live-check'); }
  if ((env.npm_config_push === '' || env.npm_config_push === 'false') && !opts.noPush) { opts.noPush = true; opts.npmFlags.push('--no-push'); }
  if (opts.skipLiveCheck && !opts.dryRun) {
    throw new Error('--skip-live-check works only with --dry-run: a real ship must compare against the live VERSION');
  }
  return opts;
}

/** What a person types to confirm a deploy of atelier-v<n> (the word "deploy" when the VERSION can't be read). */
const consentWord = (n) => (Number.isInteger(n) ? String(n) : 'deploy');
async function typed(word, ask, question) {
  const answer = String((await ask(question)) ?? '').trim();
  return answer === word ? { ok: true, message: `confirmed (${word})` } : { ok: false, message: `${answer ? `"${answer.slice(0, 20)}"` : 'nothing'} typed, not ${word}: nothing was deployed` };
}
/**
 * A real ship deploys only with a person's go-ahead: --yes (scripts, agents), or <n> typed at a terminal. Off a
 * terminal without --yes it refuses (and npm run deploy --yes, which npm keeps for itself, gets a hint).
 * ask(question) → Promise<answer>.
 */
export async function confirmShip({ n, what, yes = false, tty = false, ask, npmYes = false }) {
  if (yes) return { ok: true, message: '--yes: no prompt' };
  if (!tty) {
    return { ok: false, message: `a real deploy needs a go-ahead: run it in a terminal (ship asks you to type ${Number.isInteger(n) ? n : 'the new VERSION'}), or pass --yes: npm run deploy -- --yes${npmYes ? ' (npm kept the --yes given without -- for itself)' : ''}` };
  }
  return typed(consentWord(n), ask, `\nType ${consentWord(n)} to deploy ${what}, or anything else to stop: `);
}
/** npm run deploy:raw: <n> typed at a terminal, or (an agent, a script) ATELIER_RAW_DEPLOY=I-UNDERSTAND. */
export async function confirmRaw({ n, tty = false, ask, consent }) {
  if (consent === RAW_CONSENT) return { ok: true, message: `${RAW_ENV}=${RAW_CONSENT}` };
  if (!tty) return { ok: false, message: `this needs a person at a terminal to type the VERSION, or ${RAW_ENV}=${RAW_CONSENT} in the environment. Nothing was deployed. The checked way: npm run deploy` };
  return typed(consentWord(n), ask, `\nType ${consentWord(n)} to deploy this folder as it is, unchecked, or anything else to stop: `);
}

/** The atelier-v<N> number in a sw.js source, or null. */
export function versionIn(swSource) {
  const m = String(swSource ?? '').match(VERSION_RE);
  return m ? Number(m[2]) : null;
}

/** The ?v= number index.html loads app.js with, or null. */
export function appVersionIn(html) {
  const m = /(?:href|src)="\/app\.js\?v=(\d+)"/.exec(String(html ?? ''));
  return m ? Number(m[1]) : null;
}

/** Ship only a VERSION newer than the live one: an equal one leaves phones on their cached modules. */
export function versionGate(local, live, liveError = '') {
  if (!Number.isInteger(local)) return { ok: false, message: 'could not read the local VERSION from public/sw.js' };
  if (!Number.isInteger(live)) {
    return { ok: false, message: `could not read the live VERSION from ${SITE}/sw.js${liveError ? ` (${liveError})` : ''}; ship needs it (offline, use --dry-run --skip-live-check)` };
  }
  if (local > live) return { ok: true, message: `local atelier-v${local} is newer than live atelier-v${live}` };
  let message = `local VERSION ${local} is not newer than live ${live}: run node scripts/bump-version.mjs ${live + 1}, commit, then ship`;
  if (local < live) message += ` (live is ahead of this checkout: someone shipped atelier-v${live}; pull their commits first)`;
  return { ok: false, message, next: live + 1 };
}

/** `git status --porcelain=v1 -z` → [{x, y, path, orig?}] (renames and copies carry their source path as `orig`). */
export function parsePorcelainZ(text) {
  const parts = String(text ?? '').split('\0');
  const entries = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (rec.length < 4) continue;
    const e = { x: rec[0], y: rec[1], path: rec.slice(3) };
    if (e.x === 'R' || e.x === 'C' || e.y === 'R' || e.y === 'C') e.orig = parts[++i];
    entries.push(e);
  }
  return entries;
}

/** Changes that may stay uncommitted: the zip every deploy regenerates, and untracked promo/ folders. */
export function isAllowedChange(e) {
  if (e.path === ZIP && !e.orig) return true;
  return e.x === '?' && e.y === '?' && e.path.startsWith('promo/');
}

/** → one "XY path" line per change that blocks a ship (empty when the tree is clean enough). */
export function dirtyProblems(entries) {
  return entries.filter((e) => !isAllowedChange(e)).map((e) => `${e.x}${e.y} ${e.orig ? `${e.orig} -> ` : ''}${e.path}`);
}

/** `git rev-list --left-right --count HEAD...origin/master` → { ahead, behind }, or null. */
export function parseAheadBehind(out) {
  const m = /^(\d+)\s+(\d+)$/.exec(String(out ?? '').trim());
  return m ? { ahead: Number(m[1]), behind: Number(m[2]) } : null;
}

/** Behind or diverged would deploy without someone else's pushed work (and roll it back on the live site). */
export function syncDecision(counts) {
  if (!counts || !Number.isInteger(counts.ahead) || !Number.isInteger(counts.behind)) {
    return { ok: false, state: 'unknown', message: 'could not compare HEAD with origin/master' };
  }
  const { ahead, behind } = counts, s = (n) => (n === 1 ? '' : 's');
  if (ahead && behind) {
    return { ok: false, state: 'diverged', message: `HEAD has diverged from origin/master (${ahead} commit${s(ahead)} ahead, ${behind} behind): run git pull --rebase origin master, re-test, then ship` };
  }
  if (behind) {
    return { ok: false, state: 'behind', message: `HEAD is ${behind} commit${s(behind)} behind origin/master: run git pull --ff-only origin master, then ship (deploying now would roll back pushed work)` };
  }
  if (ahead) return { ok: true, state: 'ahead', message: `${ahead} commit${s(ahead)} ahead of origin/master (pushed after the deploy)` };
  return { ok: true, state: 'even', message: 'up to date with origin/master' };
}

/** Top-level public/*.js files plus public/index.html: exactly what scripts/bump-version.mjs rewrites. */
export function bumpedFiles(names) {
  return names.filter((p) => /^public\/[^/]+\.js$/.test(p) || p === 'public/index.html').sort();
}

/**
 * Everything a bump to <n> moves must already be at <n>: sw.js VERSION, every same-origin ?v= in index.html (and
 * /app.js?v=<n> must be there), app.js APP_BUILD, and every relative import in public/*.js. Uses the regexes
 * scripts/bump-version.mjs rewrites with, so "bumping to <n> again would change nothing" is the definition.
 * `files` maps a public/ file name ('sw.js', 'index.html', 'app.js', …) to its source. → problem lines.
 */
export function bumpProblems(files, n) {
  const out = [], v = `?v=${n}`;
  const sw = files['sw.js'];
  if (sw == null) out.push('public/sw.js is missing');
  else if (versionIn(sw) == null) out.push("public/sw.js has no `const VERSION = 'atelier-v<N>';` line");
  else if (versionIn(sw) !== n) out.push(`public/sw.js VERSION is atelier-v${versionIn(sw)}, not atelier-v${n}`);
  const html = files['index.html'];
  if (html == null) out.push('public/index.html is missing');
  else {
    for (const m of html.matchAll(HTML_RE)) if (m[0] !== `${m[1]}${n}${m[2]}`) out.push(`public/index.html has ${m[0]}, not ?v=${n}`);
    if (appVersionIn(html) !== n) out.push(`public/index.html does not load /app.js${v}`);
  }
  const app = files['app.js'];
  if (app == null) out.push('public/app.js is missing');
  else {
    const build = app.match(BUILD_RE);
    if (!build) out.push("public/app.js has no `const APP_BUILD = '<N>';` line");
    else if (build[0].match(/\d+/)[0] !== String(n)) out.push(`public/app.js has ${build[0]} (APP_BUILD must be '${n}')`);
  }
  for (const name of Object.keys(files).sort()) {
    if (!name.endsWith('.js')) continue;
    for (const m of String(files[name]).matchAll(IMPORT_RE)) {
      if (m[0] === `${m[1]}${v}`) continue;
      const spec = (s) => s.slice(s.indexOf(m[2]) + 1);
      out.push(`public/${name} imports ${spec(m[0])}, not ${spec(m[1])}${v}`);
    }
  }
  return out;
}

// Relative module specifiers (static and dynamic imports, re-exports), the sw.js install and lazy lists, and the
// same-origin src/href in index.html: every file the live site must serve at exactly that name.
const REL_IMPORT_RE = /\b(?:from|import)\s*\(?\s*(['"])(\.\.?\/[^'"?#]+)(?:[?#][^'"]*)?\1/g;
const SW_LIST_RE = /const (SHELL|LAZY) = \[([\s\S]*?)\];/g;
const SW_PATH_RE = /['`](\/[^'`?#]*)/g;
const HTML_PATH_RE = /\b(?:src|href)="(\/(?!\/)[^"?#]*)/g;
/** A site path → the public/ files that would serve it ('/' → index.html, '/privacy' → privacy.html). */
const servedBy = (p) => (p === '/' ? ['public/index.html'] : p.endsWith('/') ? [`public${p}index.html`]
  : path.posix.extname(p) ? [`public${p}`] : [`public${p}.html`, `public${p}/index.html`]);

/**
 * Names the app loads that git doesn't have in exactly that case. Windows (and the :8791 fixture) open public/App.js
 * for public/app.js; the live site serves index.html there (single-page fallback) with a 200, so the module fails to
 * load and the app is a blank screen. `files`: bumpProblems' map; `listing`: `git ls-tree -r --name-only <sha> public/`.
 * An extensionless index.html link with no file at all is a route (/share, /api/…) and is skipped. → problem lines.
 */
export function pathProblems(files, listing) {
  const exact = new Set(listing), lower = new Map(listing.map((p) => [p.toLowerCase(), p]));
  const out = new Set();
  const check = (where, ref, want, required) => {
    if (want.some((p) => exact.has(p))) return;
    const near = want.map((p) => lower.get(p.toLowerCase())).find(Boolean);
    if (near) out.add(`${where} names ${ref}, but git has ${near}: the live site's file names are case-sensitive`);
    else if (required) out.add(`${where} names ${ref}, which git doesn't have at this commit`);
  };
  for (const name of Object.keys(files).sort()) {
    const src = String(files[name] ?? ''), where = `public/${name}`;
    if (name.endsWith('.js')) {
      for (const m of src.matchAll(REL_IMPORT_RE)) check(where, m[2], [path.posix.join('public', path.posix.dirname(name), m[2])], true);
    }
    if (name === 'sw.js') {
      for (const list of src.matchAll(SW_LIST_RE)) for (const m of list[2].matchAll(SW_PATH_RE)) check(`${where} ${list[1]}`, m[1], servedBy(m[1]), true);
    }
    if (name === 'index.html') {
      for (const m of src.matchAll(HTML_PATH_RE)) if (!m[1].startsWith('/api/')) check(where, m[1], servedBy(m[1]), Boolean(path.posix.extname(m[1])));
    }
  }
  return [...out];
}

/** public/ship.json's text → {sha, version, source: 'ship' | 'raw', dirty, at}, or null (none, the HTML fallback, garbage). */
export function parseRecord(text) {
  let j = null;
  try { j = JSON.parse(String(text ?? '')); } catch { return null; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  if (typeof j.sha !== 'string' || !/^[0-9a-f]{40}$/.test(j.sha) || !Number.isInteger(j.version) || !['ship', 'raw'].includes(j.source)) return null;
  return { sha: j.sha, version: j.version, source: j.source, dirty: j.dirty === true, at: typeof j.at === 'string' ? j.at.slice(0, 40) : '' };
}
export const shipRecord = ({ sha, version, source = 'ship', dirty = false, at = new Date().toISOString() }) => ({ sha, version, source, dirty, at });

/**
 * Would deploying HEAD (`sha`) roll back what is live? record: the live ship.json (parseRecord), liveVersion: the live
 * sw.js number, exists / ancestor: git knows record.sha / it is in HEAD's history, lost: `git log HEAD..record.sha`
 * lines (whose work would go). A deploy without a record (before ship, an older branch's npm run deploy, a dashboard
 * rollback) or from a dirty deploy:raw can't be checked: refused unless allowUnrecorded. A recorded commit that isn't
 * in HEAD's history is always refused: merge it first. → {ok, state, message}
 */
export function liveOriginDecision({ record, liveVersion, sha, exists = false, ancestor = false, lost = [], allowUnrecorded = false }) {
  const short = String(sha).slice(0, 7), live = Number.isInteger(liveVersion) ? `atelier-v${liveVersion}` : 'the live site';
  const unchecked = (state, why) => (allowUnrecorded
    ? { ok: true, state, message: `${why}; --allow-unrecorded-live: replacing it anyway` }
    : { ok: false, state, message: `${why}, so ship can't tell whether it holds work that isn't in ${short}. Check git log and npx wrangler deployments list, then ship with --allow-unrecorded-live` });
  if (!record) return unchecked('unrecorded', `${live} has no ship record (${SITE}/${RECORD}): it was deployed some other way (before ship, npm run deploy from an older branch, or a rollback)`);
  const from = `${record.sha.slice(0, 7)}${record.at ? ` (${record.at})` : ''}`;
  if (record.version !== liveVersion) return unchecked('unrecorded', `${SITE}/${RECORD} records atelier-v${record.version} from ${from}, but the live sw.js is ${live}: something else deployed after it`);
  if (record.source === 'raw' && record.dirty) return unchecked('raw', `${live} came from npm run deploy:raw of ${from} with uncommitted changes`);
  if (!exists) {
    return { ok: false, state: 'missing', message: `${live} was shipped from ${from}, which isn't in this clone even after fetching origin/master: deploying ${short} would roll it back. Fetch and merge it first (git fetch origin ${record.sha}, then git merge ${record.sha.slice(0, 12)}), or ask whoever shipped it to push it` };
  }
  if (!ancestor) {
    const shown = lost.slice(0, 8).map((l) => `\n            ${l}`).join('') + (lost.length > 8 ? `\n            … and ${lost.length - 8} more` : '');
    return { ok: false, state: 'diverged', message: `${live} was shipped from ${from}, which is not in ${short}'s history: deploying would roll back ${lost.length || 'its'} commit${lost.length === 1 ? '' : 's'}${shown}\n          Merge it first (git merge ${record.sha.slice(0, 12)}), re-test, then ship` };
  }
  return { ok: true, state: 'ancestor', message: `${live} was shipped from ${from}, which is in ${short}'s history` };
}

/** wrangler deploy exited non-zero: it uploads first and updates routes and the custom domain after, so it may be live. */
export function afterWranglerFailure({ live, local, sha, status }) {
  if (live === local) {
    return { live: true, message: `wrangler deploy failed (${status}), but the live sw.js already reports atelier-v${local}: the upload went live and a later step (routes, the custom domain) failed. Going on to the live check and the push, so origin/master matches what is live.` };
  }
  return { live: false, message: `wrangler deploy failed (${status}); the live sw.js reports ${live == null ? 'nothing readable' : `atelier-v${live}`}. Nothing was pushed. If ${SITE}/sw.js reports atelier-v${local} later, it went live after all: git push origin ${sha}:refs/heads/master` };
}

/** git's arguments for the clean worktree. On Windows CRLF is forced, whatever the machine's git config says. */
export const worktreeAddArgs = (wt, sha, platform = process.platform) => [...(platform === 'win32' ? ['-c', 'core.autocrlf=true'] : []), 'worktree', 'add', '--detach', wt, sha];

/** `git cat-file --batch` stdout (a Buffer) → [{ oid, type, content: Buffer } | { missing: true }] in request order. */
export function parseCatFileBatch(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf(0x0a, i);
    if (nl < 0) break;
    const header = buf.subarray(i, nl).toString('utf8');
    i = nl + 1;
    const m = /^([0-9a-f]+) (\w+) (\d+)$/.exec(header);
    if (!m) { out.push({ missing: true, header }); continue; }
    const size = Number(m[3]);
    out.push({ oid: m[1], type: m[2], content: buf.subarray(i, i + size) });
    i += size + 1;
  }
  return out;
}

const unescapeTap = (s) => s.replace(/\\(.)/g, (_, c) => (c === 'n' ? ' ' : c));
const unquoteYaml = (s) => {
  const t = s.trim();
  if (t.startsWith("'") && t.endsWith("'") && t.length > 1) return t.slice(1, -1).replace(/''/g, "'").replace(/\\\\/g, '\\');
  if (t.startsWith('"')) { try { return JSON.parse(t); } catch { return t; } }
  return t;
};

/**
 * node --test's TAP output → { tests, pass, fail, cancelled, failures: [{ name, location, error }] }. A failing suite
 * whose only fault is a failing child is skipped (the child is listed); a test file that fails to load is listed by path.
 */
export function parseTap(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const res = { tests: 0, pass: 0, fail: 0, cancelled: 0, failures: [] };
  const stack = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const sum = /^# (tests|pass|fail|cancelled) (\d+)$/.exec(line);
    if (sum) { res[sum[1]] = Number(sum[2]); continue; }
    const sub = /^( *)# Subtest: (.*)$/.exec(line);
    if (sub) { const d = Math.floor(sub[1].length / 4); stack.length = d; stack[d] = unescapeTap(sub[2]); continue; }
    const no = /^( *)not ok \d+ - (.*?)(?: # (?:SKIP|TODO)\b.*)?$/.exec(line);
    if (!no) continue;
    const indent = no[1].length, depth = Math.floor(indent / 4), info = {};
    if (lines[i + 1]?.trim() === '---') {
      let j = i + 2;
      for (; j < lines.length && lines[j].trim() !== '...'; j++) {
        const kv = /^( *)(failureType|location|error): ?(.*)$/.exec(lines[j]);
        if (!kv || kv[1].length !== indent + 2) continue;
        let value = kv[3];
        if (/^\|[-+]?$/.test(value.trim())) {
          const block = [];
          for (let k = j + 1; k < lines.length && (lines[k].trim() === '' || lines[k].length - lines[k].trimStart().length > indent + 2); k++) {
            if (lines[k].trim()) block.push(lines[k].trim());
          }
          value = block.slice(0, 3).join(' / ');
        } else value = unquoteYaml(value);
        info[kv[2]] = value;
      }
      i = j;
    }
    if (info.failureType === 'subtestsFailed') continue;
    const name = [...stack.slice(0, depth), unescapeTap(no[2])].filter(Boolean).join(' > ');
    res.failures.push({ name, location: info.location ?? '', error: info.error ?? '' });
  }
  return res;
}

/** True only for a folder made by mkdtemp(<temp>/atelier-ship-…): directly inside the temp folder, with our prefix. */
export function isSafeTempDir(dir, root = tmpdir(), platform = process.platform) {
  if (!dir || !root) return false;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const fold = (s) => (platform === 'win32' ? s.toLowerCase() : s);
  const d = p.resolve(dir), r = p.resolve(root);
  return fold(p.dirname(d)) === fold(r) && p.basename(d).startsWith(TMP_PREFIX) && p.basename(d).length > TMP_PREFIX.length;
}

/**
 * Polls the live sw.js until it reports atelier-v<n>, then the live index.html until it loads /app.js?v=<n>, for up to
 * `timeoutMs` (the edge can lag a few seconds). fetchText(url) → Promise<string>; sleep(ms) and now() are injectable.
 */
export async function waitForLive({ n, fetchText, sleep: wait = sleep, now = Date.now, timeoutMs = LIVE_TIMEOUT_MS, intervalMs = LIVE_INTERVAL_MS, onPoll = () => {} }) {
  const start = now();
  let sw = null, app = null, error = '';
  for (;;) {
    try { sw = versionIn(await fetchText(`${SITE}/sw.js`)); error = ''; } catch (e) { sw = null; error = e.message; }
    if (sw === n) {
      try { app = appVersionIn(await fetchText(`${SITE}/`)); } catch (e) { app = null; error = e.message; }
      if (app === n) return { ok: true, sw, app, waitedMs: now() - start };
    }
    const waited = now() - start;
    if (waited >= timeoutMs) return { ok: false, sw, app, waitedMs: waited, error };
    onPoll({ sw, app, waitedMs: waited, error });
    await wait(Math.min(intervalMs, timeoutMs - waited));
  }
}

// ── side effects ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** The environment for every child: no git password prompt, and none of the npm flags meant for ship itself. */
function childEnv(extra = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extra };
  // `npm run ship --dry-run` sets npm_config_dry_run=true, which would turn the worktree's `npm ci` into a no-op.
  for (const k of Object.keys(env)) if (/^npm_config_(dry_run|push|skip_live_check)$/i.test(k)) delete env[k];
  return env;
}

function sh(cmd, args = [], { cwd = ROOT, env = childEnv(), inherit = false, input, buffer = false, shell = false } = {}) {
  const r = spawnSync(cmd, args, {
    cwd, env, shell, windowsHide: true, maxBuffer: 1 << 28, input: input == null ? undefined : Buffer.from(input),
    stdio: inherit ? 'inherit' : 'pipe', ...(buffer ? {} : { encoding: 'utf8' }),
  });
  return {
    ok: !r.error && r.status === 0 && r.signal == null, status: r.status, signal: r.signal,
    stdout: r.stdout ?? (buffer ? Buffer.alloc(0) : ''), stderr: String(r.stderr ?? ''), error: r.error,
  };
}
const git = (args, opts) => sh('git', args, opts);
// npm is npm.cmd on Windows, which needs a shell; the command lines are constants.
const npm = (line, cwd) => sh(`npm ${line}`, [], { cwd, inherit: true, shell: true });
const firstLine = (s) => String(s ?? '').trim().split(/\r?\n/).find(Boolean) ?? '';
const why = (r) => (r.error ? r.error.message : r.signal ? `killed by ${r.signal}` : `exit ${r.status}`);
const secs = (ms) => `${Math.round(ms / 1000)} s`;

/**
 * Every tests/*.test.mjs in the worktree, like `node --test tests/*.test.mjs`: a TAP report to `tapPath` (parsed for the
 * summary and the failing names) and the dot reporter on a pipe, counted into a progress line every 10 s instead of
 * pages of dots. Resolves with the real exit status. A run longer than 15 minutes is killed (a hung test).
 */
export function runTests(cwd, files, tapPath) {
  const child = spawn(process.execPath, ['--test', '--test-reporter=dot', '--test-reporter-destination=stdout',
    '--test-reporter=tap', `--test-reporter-destination=${tapPath}`, ...files], { cwd, env: childEnv(), stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  let out = '';
  child.stdout.on('data', (b) => { out += b.toString(); });
  // The dot reporter writes '.' per pass and 'X' per failure, 20 to a line, then its failure details.
  const dots = () => { const run = (out.match(/^[.X\r\n]*/)?.[0] ?? '').replace(/[\r\n]/g, ''); return { run: run.length, failed: (run.match(/X/g) ?? []).length }; };
  const tick = setInterval(() => { const d = dots(); say.note(`${d.run} tests run, ${d.failed} failed so far`); }, 10_000);
  const kill = setTimeout(() => { say.fail('the tests ran for 15 minutes: stopping them (a hung test?)'); child.kill(); }, 15 * 60_000);
  return new Promise((resolve) => {
    const done = (r) => { clearInterval(tick); clearTimeout(kill); resolve({ ...r, details: out.replace(/^[.X\r\n]*/, '').trim() }); };
    child.on('error', (error) => done({ ok: false, status: null, signal: null, error }));
    child.on('close', (status, signal) => done({ ok: status === 0 && signal == null, status, signal }));
  });
}

async function fetchText(url) {
  const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}ship=${Date.now()}`, {
    headers: { 'cache-control': 'no-cache', pragma: 'no-cache' }, signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function liveVersion() {
  try { return { version: versionIn(await fetchText(`${SITE}/sw.js`)), error: '' }; } catch (e) { return { version: null, error: e.message }; }
}

/** The live deploy's record against HEAD (liveOriginDecision), after checkSync's fetch of origin/master. */
async function liveOrigin(sha, liveVer, allowUnrecorded) {
  let record = null;
  try { record = parseRecord(await fetchText(`${SITE}/${RECORD}`)); } catch { /* none: unrecorded */ }
  let exists = false, ancestor = false, lost = [];
  if (record) {
    exists = git(['cat-file', '-e', `${record.sha}^{commit}`]).ok;
    if (exists) ancestor = git(['merge-base', '--is-ancestor', record.sha, sha]).ok;
    if (exists && !ancestor) lost = String(git(['log', '--format=%h %an: %s', '-n', '50', `${sha}..${record.sha}`]).stdout).trim().split(/\r?\n/).filter(Boolean);
  }
  return liveOriginDecision({ record, liveVersion: liveVer, sha, exists, ancestor, lost, allowUnrecorded });
}

/** Every file git has under public/ at <sha>, in git's exact case. */
function listingAt(sha) {
  const ls = git(['ls-tree', '-r', '--name-only', '-z', sha, 'public/']);
  if (!ls.ok) throw new Error(`git ls-tree -r failed: ${firstLine(ls.stderr)}`);
  return ls.stdout.split('\0').filter(Boolean);
}

/** One line from the person at this terminal ('' after Ctrl+C). */
async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const stop = new AbortController();
  rl.on('SIGINT', () => stop.abort());
  try { return await rl.question(question, { signal: stop.signal }); } catch { return ''; } finally { rl.close(); }
}
const isTty = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

function checkSync(sha) {
  const f = git(['fetch', '--quiet', 'origin', 'master']);
  if (!f.ok) return { ok: false, message: `git fetch origin master failed: ${firstLine(f.stderr) || why(f)}` };
  const c = git(['rev-list', '--left-right', '--count', `${sha}...origin/master`]);
  return syncDecision(c.ok ? parseAheadBehind(c.stdout) : null);
}

/** The bump-relevant public/ files at <sha>, read from git objects (one cat-file call) → { 'sw.js': src, … }. */
function filesAt(sha) {
  const ls = git(['ls-tree', '--name-only', '-z', sha, 'public/']);
  if (!ls.ok) throw new Error(`git ls-tree failed: ${firstLine(ls.stderr)}`);
  const names = bumpedFiles(ls.stdout.split('\0').filter(Boolean));
  const cat = git(['cat-file', '--batch'], { input: names.map((p) => `${sha}:${p}`).join('\n') + '\n', buffer: true });
  if (!cat.ok) throw new Error(`git cat-file failed: ${firstLine(cat.stderr)}`);
  const blobs = parseCatFileBatch(cat.stdout), files = {};
  names.forEach((p, i) => { if (blobs[i]?.type === 'blob') files[p.slice('public/'.length)] = blobs[i].content.toString('utf8'); });
  return files;
}

const say = {
  head: (title) => console.log(`\n== ${title}`),
  ok: (msg) => console.log(`  ok    ${msg}`),
  fail: (msg) => console.log(`  FAIL  ${msg}`),
  note: (msg) => console.log(`  note  ${msg}`),
  list: (items, max = 15) => items.slice(0, max).map((s) => `          ${s}`).join('\n') + (items.length > max ? `\n          … and ${items.length - max} more` : ''),
};

/**
 * npm run deploy:raw: this folder exactly as it is, after the banner and a confirmation (confirmRaw). Packs the zip,
 * records the deploy in public/ship.json (source 'raw', dirty when anything is uncommitted; removed afterwards), and
 * runs wrangler deploy with ATELIER_SHIP=raw, which the build guard accepts.
 */
async function rawDeploy(env, { tty = isTty(), prompt = ask } = {}) {
  const bar = '!'.repeat(100);
  console.error([
    bar,
    '!!  npm run deploy:raw: UNCHECKED DEPLOY of this folder exactly as it is on disk.',
    '!!  No clean-tree check, no VERSION check, no clean-checkout tests, no live check, no push.',
    '!!  Uncommitted edits go live, and without a VERSION bump installed phones keep running the old cached modules.',
    '!!  Use npm run ship (npm run deploy is the same) unless ship itself is broken.',
    bar,
  ].join('\n'));
  let local = null;
  try { local = versionIn(readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8')); } catch { /* typed as "deploy" */ }
  const ok = await confirmRaw({ n: local, tty, ask: prompt, consent: env[RAW_ENV] });
  if (!ok.ok) { console.error(`deploy:raw: ${ok.message}`); return 1; }
  const head = git(['rev-parse', 'HEAD']), st = git(['status', '--porcelain=v1', '-z']);
  const sha = head.ok ? head.stdout.trim() : '', dirty = !st.ok || dirtyProblems(parsePorcelainZ(st.stdout)).length > 0;
  const denv = childEnv({ ATELIER_SHIP: 'raw' });
  const pack = sh(process.execPath, ['scripts/pack-extension.mjs'], { cwd: ROOT, env: denv, inherit: true });
  if (!pack.ok) { console.error(`deploy:raw: node scripts/pack-extension.mjs failed (${why(pack)}); nothing was deployed`); return 1; }
  const wrangler = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), rec = path.join(ROOT, 'public', RECORD);
  try {
    if (/^[0-9a-f]{40}$/.test(sha) && Number.isInteger(local)) writeFileSync(rec, JSON.stringify(shipRecord({ sha, version: local, source: 'raw', dirty })));
    const dep = sh(process.execPath, [wrangler, 'deploy'], { cwd: ROOT, env: denv, inherit: true });
    console.error(dep.ok ? `deploy:raw: deployed this folder${dirty ? ' (with uncommitted changes)' : ''}; nothing was pushed.` : `deploy:raw: wrangler deploy failed (${why(dep)}).`);
    return dep.ok ? 0 : 1;
  } finally { rmSync(rec, { force: true }); }
}

function cleanup(tmpRoot, wt) {
  say.head('7. Remove the worktree');
  if (!isSafeTempDir(tmpRoot) || path.dirname(wt) !== tmpRoot) { say.note(`not deleting ${tmpRoot}: it is not a ship folder in ${tmpdir()}`); return; }
  if (existsSync(wt)) {
    const r = git(['worktree', 'remove', '--force', wt]);
    if (!r.ok) say.note(`git worktree remove: ${firstLine(r.stderr) || why(r)} (Windows "Permission denied" here is harmless)`);
  }
  try { rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 }); } catch { /* reported below */ }
  git(['worktree', 'prune']);
  if (existsSync(tmpRoot)) say.note(`a few files could not be deleted yet (harmless; safe to delete later): ${tmpRoot}`);
  else say.ok('worktree removed');
}

// io: { tty, prompt } stand in for the terminal in tests.
export async function main(argv = process.argv.slice(2), env = process.env, { tty = isTty(), prompt = ask } = {}) {
  let opts;
  try { opts = parseArgs(argv, env); } catch (e) { console.error(`ship: ${e.message}\n\n${USAGE}`); return 2; }
  if (opts.help) { console.log(USAGE); return 0; }
  if (opts.raw && (opts.dryRun || opts.skipLiveCheck || opts.noPush || opts.yes || opts.allowUnrecorded)) {
    // `npm run deploy:raw --dry-run` and friends: deploy:raw has no checks to adjust, and a dry run must never deploy.
    console.error('deploy:raw takes no flags (it has no dry run): nothing deployed. For a checked dry run: npm run ship -- --dry-run');
    return 1;
  }
  if (opts.raw) return rawDeploy(env, { tty, prompt });
  if (!opts.dryRun) {
    // Fail fast, before the tests: a real deploy needs --yes or a person at this terminal.
    const pre = opts.yes || tty ? { ok: true } : await confirmShip({ n: null, yes: false, tty: false, npmYes: env.npm_config_yes === 'true' });
    if (!pre.ok) { console.error(`ship: ${pre.message}`); return 2; }
  }

  let interrupted = false;
  process.on('SIGINT', () => { interrupted = true; console.error('\nship: interrupted; stopping after this step.'); });
  const via = env.npm_lifecycle_event === 'deploy' ? ' (npm run deploy runs ship; the unchecked path is npm run deploy:raw)' : '';
  console.log(`Atelier ship${opts.dryRun ? ': DRY RUN, steps 1-3 only, never deploys or pushes' : ''}${via}`);
  if (opts.npmFlags.length) say.note(`npm passed ${opts.npmFlags.join(' ')} without \`--\`: applied anyway`);

  const problems = [];
  const check = (ok, msg) => { if (ok) say.ok(msg); else { say.fail(msg); problems.push(msg.split('\n')[0]); } };

  // 1 ── tree and origin/master
  say.head('1. Clean working tree, not behind origin/master');
  const head = git(['rev-parse', 'HEAD']);
  if (!head.ok) { say.fail(`git rev-parse HEAD failed: ${firstLine(head.stderr)}`); return 1; }
  const sha = head.stdout.trim(), short = sha.slice(0, 7);
  const st = git(['status', '--porcelain=v1', '-z']);
  if (!st.ok) check(false, `git status failed: ${firstLine(st.stderr) || why(st)}`);
  else {
    const dirt = dirtyProblems(parsePorcelainZ(st.stdout));
    check(!dirt.length, dirt.length
      ? `uncommitted changes: commit them (or stash) first; only ${ZIP} and untracked promo/ folders may differ\n${say.list(dirt)}`
      : `working tree clean at ${short}`);
    if (dirt.length && opts.dryRun) say.note(`the clean worktree below tests the commit ${short}, not these uncommitted changes`);
  }
  const sync = checkSync(sha);
  check(sync.ok, sync.message);

  // 2 ── versions
  say.head('2. VERSION is newer than live, the bump is complete, file names match git, live is in HEAD\'s history');
  let local = null;
  try {
    const files = filesAt(sha);
    local = versionIn(files['sw.js']);
    if (local == null) check(false, `public/sw.js at ${short} has no VERSION line`);
    else {
      say.ok(`${short} is atelier-v${local}`);
      const bp = bumpProblems(files, local);
      check(!bp.length, bp.length
        ? `the bump to ${local} is incomplete: run node scripts/bump-version.mjs ${local} (it is idempotent), commit, then ship\n${say.list(bp)}`
        : `index.html ?v=, every module import and APP_BUILD are at ${local}`);
    }
    const pp = pathProblems(files, listingAt(sha));
    check(!pp.length, pp.length
      ? `files the app loads don't match git's names at ${short} (fix the name or the reference, commit, then ship)\n${say.list(pp)}`
      : 'every module import, sw.js SHELL/LAZY path and index.html src/href names a file git has, in the same case');
  } catch (e) { check(false, e.message); }
  if (local != null) {
    if (opts.skipLiveCheck) say.note('--skip-live-check: the live VERSION and its ship record were not compared');
    else {
      const live = await liveVersion(), gate = versionGate(local, live.version, live.error);
      check(gate.ok, gate.message);
      const origin = await liveOrigin(sha, live.version, opts.allowUnrecorded);
      check(origin.ok, origin.message);
    }
  }

  if (problems.length && !opts.dryRun) {
    console.log(`\nRefusing to ship ${short}:\n${say.list(problems, 50)}`);
    return 1;
  }
  if (problems.length) say.note('dry run: continuing to the clean-worktree tests anyway');
  if (interrupted) return 130;

  // 3 ── clean worktree: npm ci, check, tests
  say.head(`3. Clean worktree of ${short}: npm ci, npm run check, node --test tests/*.test.mjs`);
  const tmpRoot = mkdtempSync(path.join(tmpdir(), TMP_PREFIX)), wt = path.join(tmpRoot, 'atelier');
  try {
    const add = git(worktreeAddArgs(wt, sha));
    if (!add.ok) { say.fail(`git worktree add failed: ${firstLine(add.stderr) || why(add)}`); return 1; }
    const crlf = readFileSync(path.join(wt, 'public', 'sw.js'), 'utf8').includes('\r\n');
    if (process.platform === 'win32' && !crlf) {
      say.fail(`the worktree at ${wt} has LF line endings although core.autocrlf=true was forced: tests that only pass with LF would slip through (is there a .gitattributes?)`);
      return 1;
    }
    say.ok(`worktree at ${wt} (${crlf ? 'CRLF' : 'LF'} line endings)`);

    let t0 = Date.now();
    const ci = npm('ci --include=dev --no-audit --no-fund', wt);
    if (!ci.ok) { say.fail(`npm ci failed (${why(ci)})`); return 1; }
    say.ok(`npm ci (${secs(Date.now() - t0)})`);
    if (interrupted) return 130;

    const chk = npm('run --silent check', wt);
    if (!chk.ok) { say.fail(`npm run check failed (${why(chk)}): a syntax error at ${short}`); return 1; }
    say.ok('npm run check');

    const testFiles = readdirSync(path.join(wt, 'tests')).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => `tests/${f}`);
    const tapPath = path.join(tmpRoot, 'tests.tap');
    say.note(`node --test: ${testFiles.length} files`);
    t0 = Date.now();
    const run = await runTests(wt, testFiles, tapPath);
    const tap = parseTap(existsSync(tapPath) ? readFileSync(tapPath, 'utf8') : '');
    const passed = run.ok && tap.tests > 0 && tap.fail === 0 && tap.cancelled === 0;
    if (!passed) {
      const clip = (s, n) => (s.length > n ? `${s.slice(0, n)} …` : s);
      if (run.details) console.log(run.details.split(/\r?\n/).slice(0, 120).map((l) => clip(l, 240)).join('\n'));
      say.fail(`tests failed in the clean checkout (${why(run)}; ${tap.fail} failed, ${tap.cancelled} cancelled, ${tap.pass}/${tap.tests} passed)`);
      const wtFold = wt.toLowerCase();
      for (const f of tap.failures) {
        const loc = f.location && f.location.toLowerCase().startsWith(wtFold) ? path.relative(wt, f.location) : f.location;
        console.log(`          ✖ ${f.name}${loc ? `  (${loc})` : ''}${f.error ? `\n              ${clip(f.error, 240)}` : ''}`);
      }
      if (!tap.failures.length) console.log(`          (no failing test names in the TAP output; node exited with ${why(run)})`);
      console.log(`\nNot shipping ${short}. A test that passes in your folder but fails here usually depends on an uncommitted file or on LF line endings.`);
      return 1;
    }
    say.ok(`${tap.pass}/${tap.tests} tests passed in ${testFiles.length} files (${secs(Date.now() - t0)})`);
    if (interrupted) return 130;

    if (opts.dryRun) {
      if (problems.length) {
        console.log(`\nDRY RUN: tests pass in a clean checkout of ${short}, but npm run ship would refuse:\n${say.list(problems, 50)}`);
        return 1;
      }
      console.log(`\nDRY RUN OK: npm run ship would deploy atelier-v${local} (${short}).`);
      return 0;
    }

    // 4 ── deploy from the worktree
    say.head('4. Deploy from the worktree: confirm, pack the extension zip, record the commit, wrangler deploy');
    const go = await confirmShip({ n: local, what: `atelier-v${local} (${short}) to ${SITE}`, yes: opts.yes, tty, ask: prompt });
    if (!go.ok) { say.fail(go.message); return 1; }
    say.ok(go.message);
    if (interrupted) return 130;
    // Re-check what the tests (and the prompt) took time over: someone may have pushed or shipped meanwhile.
    const again = checkSync(sha), live = await liveVersion(), gate = versionGate(local, live.version, live.error);
    const origin = await liveOrigin(sha, live.version, opts.allowUnrecorded);
    if (!again.ok || !gate.ok || !origin.ok) {
      for (const m of [again, gate, origin].filter((x) => !x.ok)) say.fail(m.message);
      console.log(`\nRefusing to ship ${short}: origin/master or the live site changed while the tests ran.`);
      return 1;
    }
    // Same Cloudflare account as the main folder: wrangler caches its account choice in node_modules/.cache.
    const acct = path.join(ROOT, 'node_modules', '.cache', 'wrangler', 'wrangler-account.json');
    if (existsSync(acct)) {
      mkdirSync(path.join(wt, 'node_modules', '.cache', 'wrangler'), { recursive: true });
      copyFileSync(acct, path.join(wt, 'node_modules', '.cache', 'wrangler', 'wrangler-account.json'));
    }
    const wrangler = path.join(wt, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
    if (!existsSync(wrangler)) { say.fail('wrangler is missing from the worktree after npm ci'); return 1; }
    // ATELIER_SHIP=1 from inside this worktree is what wrangler.jsonc's build guard (scripts/deploy-guard.mjs) accepts.
    const denv = childEnv({ ATELIER_SHIP: '1' });
    const pack = sh(process.execPath, ['scripts/pack-extension.mjs'], { cwd: wt, env: denv, inherit: true });
    if (!pack.ok) { say.fail(`node scripts/pack-extension.mjs failed (${why(pack)}); nothing was deployed`); return 1; }
    writeFileSync(path.join(wt, 'public', RECORD), JSON.stringify(shipRecord({ sha, version: local })));
    const dep = sh(process.execPath, [wrangler, 'deploy'], { cwd: wt, env: denv, inherit: true });
    if (!dep.ok) {
      const probe = await liveVersion(), after = afterWranglerFailure({ live: probe.version, local, sha, status: why(dep) });
      say.fail(after.message);
      if (!after.live) return 1;
    } else say.ok(`wrangler deploy of ${short}`);

    // 5 ── live check
    say.head(`5. Live check: ${SITE}/sw.js until atelier-v${local}`);
    let shown = '';
    const res = await waitForLive({
      n: local, fetchText,
      onPoll: ({ sw, app, waitedMs, error }) => {
        const s = `live sw.js ${sw == null ? `unreadable${error ? ` (${error})` : ''}` : `atelier-v${sw}`}${sw === local ? `, index.html /app.js?v=${app ?? '?'}` : ''}`;
        if (s !== shown) { say.note(`${s} after ${secs(waitedMs)}; waiting`); shown = s; }
      },
    });
    if (res.ok) {
      say.ok(`live sw.js is atelier-v${local} and index.html loads /app.js?v=${local} (after ${secs(res.waitedMs)})`);
      let rec = null;
      try { rec = parseRecord(await fetchText(`${SITE}/${RECORD}`)); } catch { /* reported below */ }
      if (rec?.sha === sha) say.ok(`${SITE}/${RECORD} records ${short}`);
      else say.note(`${SITE}/${RECORD} doesn't record ${short} yet (the next ship checks it against its history)`);
    } else {
      const bar = '!'.repeat(100);
      console.log([
        bar,
        `!!  wrangler deploy finished, but after ${secs(res.waitedMs)} the live site still says sw.js ${res.sw == null ? 'unreadable' : `atelier-v${res.sw}`}, /app.js?v=${res.app ?? '?'} (want ${local}).`,
        `!!  1. Re-check in a minute: curl -s "${SITE}/sw.js?nocache=1" | grep "const VERSION"`,
        '!!  2. npx wrangler deployments list: is the newest deployment from just now?',
        '!!  3. If it never moves: Cloudflare dashboard > Workers > atelier > Domains & Routes (atelier.ciprari.ai attached?).',
        '!!  The commit is pushed below anyway, because wrangler accepted the upload: origin/master must match what is live.',
        bar,
      ].join('\n'));
    }

    // 6 ── push
    say.head('6. Push to origin/master');
    let pushed = false;
    if (opts.noPush) say.note(`--no-push: push the deployed commit yourself: git push origin ${sha}:refs/heads/master`);
    else {
      const p = git(['push', 'origin', `${sha}:refs/heads/master`], { inherit: true });
      if (p.ok) { pushed = true; say.ok(`pushed ${short} to origin/master`); }
      else say.fail(`git push failed (${why(p)}): atelier-v${local} is LIVE but not on origin/master. Run git pull --rebase origin master, then git push origin HEAD:master`);
    }
    const now = git(['rev-parse', 'HEAD']).stdout.trim();
    if (now && now !== sha) say.note(`HEAD moved to ${now.slice(0, 7)} during the ship; ${short} is what was deployed${pushed ? ' and pushed' : ''}`);

    const okAll = dep.ok && res.ok && (pushed || opts.noPush);
    console.log(`\n${okAll ? 'Shipped' : 'Deployed, with problems:'} atelier-v${local} (${short}) to ${SITE}: live sw.js reports ${res.sw == null ? 'nothing readable' : `atelier-v${res.sw}`}; ${pushed ? 'pushed to origin/master' : 'NOT pushed'}.`);
    return okAll ? 0 : 1;
  } finally {
    cleanup(tmpRoot, wt);
  }
}

function isMain() {
  if (!process.argv[1]) return false;
  const real = (p) => { const r = realpathSync(p); return process.platform === 'win32' ? r.toLowerCase() : r; };
  try { return real(process.argv[1]) === real(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isMain()) process.exitCode = await main();
