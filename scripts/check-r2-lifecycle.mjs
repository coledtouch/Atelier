// node scripts/check-r2-lifecycle.mjs [--add-missing] [--bucket <name>]
// Checks the thread-sync bucket's R2 lifecycle rules against what public/privacy.html promises: deleted threads' saved
// copies (trash, x/) and earlier versions (history, v/), the owner's and the testers', are removed 30 days after they
// were saved. Nothing in the Worker deletes those prefixes: only these four rules do, and they were made by hand, so
// npm run ship runs this check (read-only) and warns when one is missing or different. It never fails a ship.
//
// Read-only by default: `wrangler r2 bucket lifecycle list`. With --add-missing it adds a required rule that is wholly
// absent (`wrangler r2 bucket lifecycle add <bucket> <name> <prefix> --expire-days 30`, which keeps every existing
// rule), then lists again. It never deletes, disables or changes a rule: one that exists with other settings, or a rule
// that would expire threads or media, is reported for the owner to fix in the Cloudflare dashboard.
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUCKET = 'atelier-sync';
export const REQUIRED = Object.freeze([
  Object.freeze({ name: 'expire-trash', prefix: 'x/', days: 30, what: 'deleted threads kept for restoring (owner)' }),
  Object.freeze({ name: 'expire-history', prefix: 'v/', days: 30, what: 'earlier versions of threads (owner)' }),
  Object.freeze({ name: 'expire-tester-trash', prefix: 'testers-x/', days: 30, what: 'deleted threads kept for restoring (testers)' }),
  Object.freeze({ name: 'expire-tester-history', prefix: 'testers-v/', days: 30, what: 'earlier versions of threads (testers)' }),
]);
// Keys no rule may ever expire: thread documents and their tombstones (t/), media and long text (b/), the usage cache
// (u/) and the testers' namespaces (src/tester/sync.js). A rule whose prefix starts any of them would delete live data.
export const PROTECTED_KEYS = Object.freeze(['t/thread.json', 'b/aa/0000', 'u/usage.json', 'testers/0000/t/thread.json']);

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/**
 * `wrangler r2 bucket lifecycle list` output → [{name, enabled, prefix, expireDays, action}], or null when the text isn't
 * a listing (an error, a login prompt). wrangler prints each rule as labelled lines (name / enabled / prefix / action)
 * with a blank line between rules, and "There are no lifecycle rules for bucket '…'." when there are none.
 */
export function parseLifecycleList(text) {
  const clean = String(text ?? '').replace(ANSI, '');
  if (/There are no lifecycle rules for bucket/i.test(clean)) return [];
  if (!/Listing lifecycle rules for bucket/i.test(clean)) return null;
  const rules = [];
  let cur = null;
  for (const line of clean.split(/\r?\n/)) {
    const m = /^\s*(name|enabled|prefix|action):\s*(.*?)\s*$/i.exec(line);
    if (!m) continue;
    const k = m[1].toLowerCase();
    if (k === 'name') rules.push((cur = { name: m[2] }));
    else if (cur) cur[k] = m[2];
  }
  return rules.map((r) => {
    // wrangler prints the delete action first: "Expire objects after N days", "Expire objects on YYYY-MM-DD" (a Date
    // rule: everything under the prefix goes that day), or a bare "Expire objects" for a condition it can't show.
    const action = r.action || '';
    const expires = /\bExpire objects\b/i.test(action);
    const days = /Expire objects after (\d+(?:\.\d+)?) days/i.exec(action)?.[1];
    const on = /Expire objects on (\d{4}-\d{2}-\d{2})/i.exec(action)?.[1];
    return { name: r.name, enabled: /^yes$/i.test(r.enabled || ''), prefix: !r.prefix || r.prefix === '(all prefixes)' ? '' : r.prefix,
      expires, expireDays: days ? Number(days) : null, expireOn: on || null, action };
  });
}

// How a rule expires, in words: "after N days", "on YYYY-MM-DD", or "at a time wrangler doesn't show".
const whenOf = (r) => (r.expireDays != null ? `after ${r.expireDays} days` : r.expireOn ? `on ${r.expireOn}` : 'at a time wrangler doesn’t show');
const overlaps = (a, b) => a.startsWith(b) || b.startsWith(a); // two prefixes that share keys ('' covers everything)

/**
 * What is wrong with a bucket's rules: {ok, missing: [required], different: [{need, rules, why}], dangerous: [rule],
 * early: [{rule, need, why}]}. dangerous: an enabled expiring rule (by days, on a date, or any other condition) whose
 * prefix covers thread documents, media, the usage cache or the testers' namespaces. early: any other enabled expiring
 * rule that reaches trash or earlier versions (x/, v/, testers-x/, testers-v/) sooner than 30 days or on a date, even
 * beside the right 30-day rule: whichever rule fires first removes the object, so it breaks the 30-day promise.
 */
export function lifecycleProblems(rules) {
  const missing = [], different = [], early = [];
  for (const need of REQUIRED) {
    if (rules.some((r) => r.enabled && r.prefix === need.prefix && r.expireDays === need.days)) continue;
    const near = rules.filter((r) => r.name === need.name || r.prefix === need.prefix);
    if (!near.length) { missing.push(need); continue; }
    const r = near[0];
    const why = !r.enabled ? 'is disabled' : r.prefix !== need.prefix ? `has prefix "${r.prefix || '(all)'}"` : !r.expires ? `doesn't expire objects (${r.action || 'no action'})` : `expires ${whenOf(r)}`;
    different.push({ need, rules: near, why: `rule "${r.name}" ${why}, not "${need.prefix}" expiring after ${need.days} days` });
  }
  const dangerous = rules.filter((r) => r.enabled && r.expires && PROTECTED_KEYS.some((k) => k.startsWith(r.prefix)));
  const described = new Set(different.map((d) => d.rules[0])); // already named as a required rule that is different
  for (const r of rules) {
    if (!r.enabled || !r.expires || dangerous.includes(r) || described.has(r) || (r.expireDays != null && r.expireDays >= 30)) continue;
    const need = REQUIRED.find((n) => overlaps(r.prefix, n.prefix));
    if (need) early.push({ rule: r, need, why: `rule "${r.name}" expires "${r.prefix || '(all prefixes)'}" ${whenOf(r)}, which removes ${need.what} before ${need.days} days` });
  }
  return { ok: !missing.length && !different.length && !dangerous.length && !early.length, missing, different, dangerous, early };
}

export const addArgs = (bucket, need) => ['r2', 'bucket', 'lifecycle', 'add', bucket, need.name, need.prefix, '--expire-days', String(need.days)];
export const listArgs = (bucket) => ['r2', 'bucket', 'lifecycle', 'list', bucket];

/** Plain-language lines for a check: what is fine, what is wrong and how to fix it. */
export function describe(bucket, p) {
  if (p.ok) return [`R2 lifecycle rules on ${bucket}: all ${REQUIRED.length} in place (x/, v/, testers-x/, testers-v/ expire after 30 days)`];
  const out = [];
  for (const need of p.missing) out.push(`missing: "${need.name}" (${need.prefix}, ${need.what}, expire after ${need.days} days)`);
  for (const d of p.different) out.push(`different: ${d.why} (fix it in the Cloudflare dashboard: R2 > ${bucket} > Settings > Object lifecycle rules)`);
  for (const r of p.dangerous) out.push(`DANGER: rule "${r.name}" expires "${r.prefix || '(all prefixes)'}" ${whenOf(r)}, which includes thread documents or media: remove or narrow it in the Cloudflare dashboard now`);
  for (const e of p.early || []) out.push(`too soon: ${e.why} (remove or change it in the Cloudflare dashboard: R2 > ${bucket} > Settings > Object lifecycle rules)`);
  if (p.missing.length) out.push('add the missing ones (nothing else is touched): node scripts/check-r2-lifecycle.mjs --add-missing');
  out.push('Until this is fixed, privacy.html’s promise about trash and earlier versions (restorable for 30 days, then removed) is not kept.');
  return out;
}

const wranglerBin = () => path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
/** Runs wrangler with these arguments → {ok, stdout, stderr}. Never throws. */
export function runWrangler(args, { timeout = 60_000 } = {}) {
  const bin = wranglerBin();
  if (!existsSync(bin)) return { ok: false, stdout: '', stderr: 'wrangler is not installed (npm ci)' };
  const r = spawnSync(process.execPath, [bin, ...args], { cwd: ROOT, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 1 << 24, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' } });
  return { ok: !r.error && r.status === 0, stdout: String(r.stdout ?? ''), stderr: String(r.error?.message ?? r.stderr ?? '') };
}

/**
 * Lists the bucket's rules and checks them. run: (args) → {ok, stdout, stderr} (runWrangler; tests pass a fake).
 * → {ok: true, problems} when the rules could be read (problems.ok says whether they are right), {ok: false, error}
 * when they couldn't (not logged in, offline, an unexpected listing).
 */
export function checkR2Lifecycle({ bucket = BUCKET, run = runWrangler } = {}) {
  const r = run(listArgs(bucket));
  const rules = r.ok ? parseLifecycleList(r.stdout) : null;
  if (!rules) return { ok: false, error: r.ok ? 'wrangler printed something that isn’t a lifecycle listing' : (r.stderr || r.stdout || 'wrangler failed').trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || 'wrangler failed' };
  return { ok: true, rules, problems: lifecycleProblems(rules) };
}

/** --add-missing: adds only rules that are wholly absent (no rule with that name or prefix), then checks again. */
export function addMissing({ bucket = BUCKET, run = runWrangler } = {}) {
  const before = checkR2Lifecycle({ bucket, run });
  if (!before.ok) return { ok: false, error: before.error, added: [] };
  const added = [];
  for (const need of before.problems.missing) {
    const r = run(addArgs(bucket, need));
    if (!r.ok) return { ok: false, error: `adding "${need.name}" failed: ${(r.stderr || r.stdout).trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || 'wrangler failed'}`, added };
    added.push(need.name);
  }
  const after = checkR2Lifecycle({ bucket, run });
  return after.ok ? { ok: true, added, problems: after.problems } : { ok: false, error: after.error, added };
}

async function main(argv = process.argv.slice(2)) {
  const add = argv.includes('--add-missing');
  const at = argv.indexOf('--bucket'), bucket = at >= 0 && argv[at + 1] ? argv[at + 1] : BUCKET;
  if (argv.includes('--help')) { console.log('node scripts/check-r2-lifecycle.mjs [--add-missing] [--bucket <name>]'); return 0; }
  const res = add ? addMissing({ bucket }) : checkR2Lifecycle({ bucket });
  if (!res.ok) { console.error(`Couldn't read the lifecycle rules of ${bucket}: ${res.error}`); return 2; }
  if (add) console.log(res.added.length ? `Added: ${res.added.join(', ')}` : 'Nothing to add.');
  for (const line of describe(bucket, res.problems)) console.log(line);
  return res.problems.ok ? 0 : 1;
}

function isMain() {
  if (!process.argv[1]) return false;
  const real = (p) => { const r = realpathSync(p); return process.platform === 'win32' ? r.toLowerCase() : r; };
  try { return real(process.argv[1]) === real(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (isMain()) process.exitCode = await main();
