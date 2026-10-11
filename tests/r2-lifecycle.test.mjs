// scripts/check-r2-lifecycle.mjs: the R2 lifecycle rules behind privacy.html's 30-day removal of trash and earlier
// versions (owner x/ v/, testers testers-x/ testers-v/), which were made by hand. ship runs the check read-only and only
// warns; --add-missing adds a wholly absent rule and never deletes or changes one. wrangler is faked: nothing here
// touches Cloudflare.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { BUCKET, REQUIRED, parseLifecycleList, lifecycleProblems, checkR2Lifecycle, addMissing, addArgs, listArgs, describe } from '../scripts/check-r2-lifecycle.mjs';
import { lifecycleLines } from '../scripts/ship.mjs';

const read = async (p) => (await readFile(new URL(`../${p}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n'); // ship's checkout is CRLF on Windows
// wrangler 4's listing (src/r2/lifecycle.ts: formatLabelledValues per rule, a blank line between rules), with its colours.
const listing = (rules) => [
  ' ⛅️ wrangler 4.144.0', '───────────────────', `Listing lifecycle rules for bucket '${BUCKET}'...`,
  rules.map((r) => [`\x1b[37mname:\x1b[39m     \x1b[90m${r.name}\x1b[39m`, `enabled:  ${r.enabled === false ? 'No' : 'Yes'}`, `prefix:   ${r.prefix || '(all prefixes)'}`,
    `action:   ${r.action ?? `Expire objects after ${r.days ?? 30} days`}`].join('\n')).join('\n\n'),
].join('\n');
const ALL = REQUIRED.map((r) => ({ name: r.name, prefix: r.prefix, days: r.days }));
// A fake wrangler holding a bucket's rules: list prints them, add appends one (as wrangler's add does).
function fakeWrangler(rules, { fail = null } = {}) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (fail && fail(args)) return { ok: false, stdout: '', stderr: '✘ [ERROR] You are not logged in.' };
    if (args.slice(0, 4).join(' ') === 'r2 bucket lifecycle list') return { ok: true, stdout: rules.length ? listing(rules) : `Listing lifecycle rules for bucket '${args[4]}'...\nThere are no lifecycle rules for bucket '${args[4]}'.`, stderr: '' };
    if (args.slice(0, 4).join(' ') === 'r2 bucket lifecycle add') { rules.push({ name: args[5], prefix: args[6], days: Number(args[8]) }); return { ok: true, stdout: `✨ Added lifecycle rule '${args[5]}'`, stderr: '' }; }
    throw new Error(`unexpected wrangler ${args.join(' ')}`);
  };
  return { run, calls, rules };
}

test('the four rules privacy.html rests on, on the bucket the Worker binds', async () => {
  assert.equal(BUCKET, 'atelier-sync');
  assert.match(await read('wrangler.jsonc'), /"binding": "SYNC_BUCKET", "bucket_name": "atelier-sync"/);
  assert.deepEqual(REQUIRED.map((r) => [r.name, r.prefix, r.days]), [
    ['expire-trash', 'x/', 30], ['expire-history', 'v/', 30], ['expire-tester-trash', 'testers-x/', 30], ['expire-tester-history', 'testers-v/', 30]]);
  const [SYNC, TESTER_SYNC] = await Promise.all([read('src/sync.js'), read('src/tester/sync.js')]);
  assert.match(SYNC, /trashDays: 30/);
  assert.match(SYNC, /historyDays: 30/);
  assert.match(TESTER_SYNC, /const split = \{ x: `testers-x\/\$\{hash\}\/`, v: `testers-v\/\$\{hash\}\/` \};/);
});

test('parseLifecycleList reads wrangler’s listing (colours and all), the empty answer, and refuses anything else', () => {
  const rules = parseLifecycleList(listing([...ALL, { name: 'old-uploads', prefix: '', action: 'Abort incomplete multipart uploads after 7 days', enabled: false }]));
  assert.deepEqual(rules.map((r) => [r.name, r.enabled, r.prefix, r.expireDays]), [
    ['expire-trash', true, 'x/', 30], ['expire-history', true, 'v/', 30], ['expire-tester-trash', true, 'testers-x/', 30], ['expire-tester-history', true, 'testers-v/', 30],
    ['old-uploads', false, '', null]]);
  assert.deepEqual(parseLifecycleList(`Listing lifecycle rules for bucket 'atelier-sync'...\nThere are no lifecycle rules for bucket 'atelier-sync'.`), []);
  assert.equal(parseLifecycleList('✘ [ERROR] A request to the Cloudflare API failed. Authentication error [code: 10000]'), null);
  assert.equal(parseLifecycleList(''), null);
});

test('lifecycleProblems: all four right is ok; a missing one, a different one and a dangerous one are each named', () => {
  assert.equal(lifecycleProblems(parseLifecycleList(listing(ALL))).ok, true);
  const missing = lifecycleProblems(parseLifecycleList(listing(ALL.filter((r) => r.prefix !== 'v/'))));
  assert.deepEqual(missing.missing.map((r) => r.name), ['expire-history']);
  assert.equal(missing.ok, false);
  const changed = lifecycleProblems(parseLifecycleList(listing([...ALL.slice(1), { name: 'expire-trash', prefix: 'x/', days: 60 }])));
  assert.deepEqual(changed.missing, []);
  assert.match(changed.different[0].why, /rule "expire-trash" expires after 60 days, not "x\/" expiring after 30 days/);
  const off = lifecycleProblems(parseLifecycleList(listing([...ALL.slice(1), { name: 'expire-trash', prefix: 'x/', enabled: false }])));
  assert.match(off.different[0].why, /is disabled/);
  // a rule that would expire thread documents, media, the usage cache or the testers' namespaces
  for (const prefix of ['', 't', 't/', 'b/', 'u', 'testers', 'testers/']) {
    const p = lifecycleProblems(parseLifecycleList(listing([...ALL, { name: 'oops', prefix, days: 1 }])));
    assert.deepEqual(p.dangerous.map((r) => r.name), ['oops'], `prefix "${prefix}"`);
  }
  for (const prefix of ['x/', 'testers-x/', 'v/old/']) assert.deepEqual(lifecycleProblems(parseLifecycleList(listing([...ALL, { name: 'fine', prefix, days: 90 }]))).dangerous, [], prefix);
});

test('checkR2Lifecycle lists only (read-only); addMissing adds just the absent ones and never touches the rest', async () => {
  const w = fakeWrangler([{ name: 'expire-trash', prefix: 'x/', days: 60 }, { name: 'expire-tester-trash', prefix: 'testers-x/', days: 30 }]);
  const check = checkR2Lifecycle({ run: w.run });
  assert.equal(check.ok, true);
  assert.deepEqual(check.problems.missing.map((r) => r.name), ['expire-history', 'expire-tester-history']);
  assert.deepEqual(w.calls, [listArgs(BUCKET)], 'the check only lists');
  const add = addMissing({ run: w.run });
  assert.equal(add.ok, true);
  assert.deepEqual(add.added, ['expire-history', 'expire-tester-history']);
  assert.deepEqual(w.calls.filter((a) => a[3] !== 'list'), [addArgs(BUCKET, REQUIRED[1]), addArgs(BUCKET, REQUIRED[3])], 'only adds, only the missing');
  assert.deepEqual(addArgs(BUCKET, REQUIRED[1]), ['r2', 'bucket', 'lifecycle', 'add', 'atelier-sync', 'expire-history', 'v/', '--expire-days', '30']);
  assert.equal(add.problems.ok, false, 'the 60-day trash rule is still reported: changing a rule is the owner’s call');
  assert.deepEqual(w.rules.find((r) => r.name === 'expire-trash'), { name: 'expire-trash', prefix: 'x/', days: 60 });
  for (const args of w.calls) assert.ok(!['remove', 'set', 'delete', '--force', '-y'].some((x) => args.includes(x)), args.join(' '));
  // not logged in: the check says so, nothing is added
  const out = fakeWrangler([], { fail: () => true });
  assert.deepEqual(checkR2Lifecycle({ run: out.run }), { ok: false, error: '✘ [ERROR] You are not logged in.' });
  assert.equal(addMissing({ run: out.run }).ok, false);
  assert.equal(out.calls.length, 2, 'two listings, no add');
  assert.doesNotMatch(await read('scripts/check-r2-lifecycle.mjs'), /'remove'|'set'|--force/, 'the script never builds a remove, set or forced command');
});

test('ship: the lifecycle check is a warning with the fix, never a failure; it is skipped offline', async () => {
  assert.deepEqual(lifecycleLines({ ok: true, problems: lifecycleProblems(parseLifecycleList(listing(ALL))) }),
    [['ok', 'R2 lifecycle rules on atelier-sync: all 4 in place (x/, v/, testers-x/, testers-v/ expire after 30 days)']]);
  const warn = lifecycleLines({ ok: true, problems: lifecycleProblems([]) });
  assert.ok(warn.every(([level]) => level === 'note'), 'notes only: nothing goes on ship’s problem list');
  assert.match(warn[0][1], /WARNING \(not a ship blocker\)/);
  assert.ok(warn.some(([, t]) => t.includes('node scripts/check-r2-lifecycle.mjs --add-missing')));
  assert.ok(warn.some(([, t]) => /missing: "expire-trash" \(x\/, deleted threads kept for restoring \(owner\), expire after 30 days\)/.test(t)));
  assert.deepEqual(lifecycleLines({ ok: false, error: 'offline' }), [['note', 'R2 lifecycle rules on atelier-sync not checked (offline): run node scripts/check-r2-lifecycle.mjs']]);
  assert.deepEqual(describe(BUCKET, lifecycleProblems(parseLifecycleList(listing([...ALL, { name: 'oops', prefix: '', days: 1 }])))).filter((l) => /DANGER/.test(l)).length, 1);
  const SHIP = await read('scripts/ship.mjs');
  assert.match(SHIP, /if \(opts\.skipLiveCheck\) say\.note\('--skip-live-check: the R2 lifecycle rules were not checked[^']*'\);\n\s+else for \(const \[level, text\] of lifecycleLines\(checkR2Lifecycle\(\)\)\) say\[level\]\(text\);/);
  assert.doesNotMatch(SHIP, /lifecycleLines\([^)]*\)[^\n]*check\(/, 'never fed to check(), which would block the ship');
});

// v90 review: a rule that expires everything on a date read as no expiry at all (only "after N days" was parsed), and an
// extra rule deleting trash after 1 day beside the right 30-day rule passed, since one matching rule was enough.
test('lifecycleProblems: a date rule is an expiry (dangerous over threads or media), and an extra rule that empties trash or history early is named', () => {
  const parsed = parseLifecycleList(listing([...ALL, { name: 'wipe-all', prefix: '', action: 'Expire objects on 2026-12-31' }, { name: 'move', prefix: 'b/', action: 'Transition to Infrequent Access after 30 days' }]));
  assert.deepEqual(parsed.find((r) => r.name === 'wipe-all'), { name: 'wipe-all', enabled: true, prefix: '', expires: true, expireDays: null, expireOn: '2026-12-31', action: 'Expire objects on 2026-12-31' });
  assert.equal(parsed.find((r) => r.name === 'move').expires, false, 'a storage-class move removes nothing');
  assert.equal(parsed.find((r) => r.name === 'expire-trash').expires, true);
  const check = (extra) => lifecycleProblems(parseLifecycleList(listing([...ALL, ...extra])));
  // a date (or an unshown condition) over thread documents or media: DANGER, like a days rule
  for (const [prefix, action] of [['', 'Expire objects on 2026-12-31'], ['t/', 'Expire objects on 2026-12-31'], ['b/', 'Expire objects'], ['testers/', 'Expire objects on 2027-01-01, Abort incomplete multipart uploads after 7 days']]) {
    const p = check([{ name: 'oops', prefix, action }]);
    assert.equal(p.ok, false, `${prefix} ${action}`);
    assert.deepEqual(p.dangerous.map((r) => r.name), ['oops'], `${prefix} ${action}`);
  }
  // beside the four right rules, anything that removes trash or history sooner than 30 days, or on a date
  for (const [prefix, action] of [['x/', 'Expire objects after 1 days'], ['x', 'Expire objects after 1 days'], ['x/t1/', 'Expire objects after 7 days'], ['v/', 'Expire objects on 2026-10-12'], ['testers-v/', 'Expire objects after 29.5 days'], ['testers-', 'Expire objects after 2 days']]) {
    const p = check([{ name: 'fast', prefix, action }]);
    assert.equal(p.ok, false, `${prefix} ${action}`);
    assert.deepEqual(p.early.map((e) => e.rule.name), ['fast'], `${prefix} ${action}`);
    assert.deepEqual(p.dangerous, []);
  }
  // what stays fine: longer than 30 days, disabled, not an expiry, or a prefix that touches neither trash nor history
  for (const extra of [{ prefix: 'x/', action: 'Expire objects after 60 days' }, { prefix: 'x/', action: 'Expire objects after 1 days', enabled: false },
    { prefix: 'v/', action: 'Abort incomplete multipart uploads after 1 days' }, { prefix: 'promo/', action: 'Expire objects after 1 days' }]) {
    assert.equal(check([{ name: 'other', ...extra }]).ok, true, JSON.stringify(extra));
  }
  // a required rule set to a date is reported once, as different
  const dated = lifecycleProblems(parseLifecycleList(listing([...ALL.slice(1), { name: 'expire-trash', prefix: 'x/', action: 'Expire objects on 2026-10-12' }])));
  assert.match(dated.different[0].why, /rule "expire-trash" expires on 2026-10-12, not "x\/" expiring after 30 days/);
  assert.deepEqual(dated.early, []);
  // and ship's lines say so, never "all 4 in place"
  const lines = describe(BUCKET, check([{ name: 'fast-trash', prefix: 'x/', action: 'Expire objects after 1 days' }, { name: 'wipe-all', prefix: '', action: 'Expire objects on 2026-12-31' }]));
  assert.ok(lines.some((l) => /^DANGER: rule "wipe-all" expires "\(all prefixes\)" on 2026-12-31/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /^too soon: rule "fast-trash" expires "x\/" after 1 days, which removes deleted threads kept for restoring \(owner\) before 30 days/.test(l)), lines.join('\n'));
  assert.ok(!lines.some((l) => /all 4 in place/.test(l)));
  const ship = lifecycleLines({ ok: true, problems: check([{ name: 'fast-trash', prefix: 'x/', action: 'Expire objects after 1 days' }]) });
  assert.match(ship[0][1], /WARNING \(not a ship blocker\)/);
});
