import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergeProfile, factsInUse, factsFor, PROFILE_TEXT, MEMORY_MAX, FACTS_IN_PROMPT, APPROVAL_KEYS } from '../public/context.js';

// v114 (review, app-4: "the You profile is one last-writer-wins blob"). The owner's profile used to be sent whole,
// newest wins. A tab left open since morning then wrote its old copy back: facts learned on the phone were gone, and
// "Approve everything", turned off on the phone, came back on for every device. mergeProfile joins the copies field by
// field against the copy the browser last knew the server to hold.
const APP = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const fact = (id, text, at, src = 'chat') => ({ id, text, src, at });
const NOW = 9_000;

test('the review\'s scenario: a stale tab no longer turns "Approve everything" back on, or drops what the phone learned', () => {
  const morning = { bio: 'Builder', memory: [fact('a', 'Has a Chihuahua', 10)], approvals: { approveAll: true }, updatedAt: 100 };
  // The phone turned the switch off and learned a fact (the server now holds this).
  const server = { bio: 'Builder', memory: [fact('a', 'Has a Chihuahua', 10), fact('p', 'Lives in Boston', 200)], approvals: { approveAll: false }, updatedAt: 200 };
  // The desktop tab, open since morning, learns a fact of its own and saves: its copy is the newest by its clock.
  const tab = { bio: 'Builder', memory: [fact('a', 'Has a Chihuahua', 10), fact('d', 'Prefers short answers', 300)], approvals: { approveAll: true }, updatedAt: 300 };
  const { profile, changed } = mergeProfile(morning, tab, server, NOW);
  assert.equal(profile.approvals.approveAll, false, 'the phone\'s "off" stands: this tab never touched the switch');
  assert.deepEqual(profile.memory.map((f) => f.id), ['a', 'p', 'd'], 'both devices\' facts, oldest first');
  assert.equal(changed, true);
  assert.equal(profile.updatedAt, NOW);
  // The phone then joins the result with its own copy: nothing left to send, and the two hold the same record.
  const phone = mergeProfile(server, server, profile, NOW + 1);
  assert.equal(phone.changed, false);
  assert.deepEqual(phone.profile, profile);
});

test('an approval switch: the side that changed it since the last sync wins, on or off; with no base a disagreement is off', () => {
  const p = (approveAll, extra = {}) => ({ approvals: { approveAll, ...extra }, updatedAt: 1 });
  assert.equal(mergeProfile(p(false), p(true), p(false), NOW).profile.approvals.approveAll, true, 'turned on here');
  assert.equal(mergeProfile(p(true), p(false), p(true), NOW).profile.approvals.approveAll, false, 'turned off here');
  assert.equal(mergeProfile(p(true), p(true), p(false), NOW).profile.approvals.approveAll, false, 'turned off there');
  assert.equal(mergeProfile(p(false), p(false), p(true), NOW).profile.approvals.approveAll, true, 'turned on there');
  for (const [mine, theirs] of [[true, false], [false, true]]) assert.equal(mergeProfile(null, p(mine), p(theirs), NOW).profile.approvals.approveAll, false, 'no base: off');
  assert.equal(mergeProfile(null, p(true), p(true), NOW).profile.approvals.approveAll, true);
  // A switch only one side has ever held is taken from that side (v108: an older device's choice spreads once).
  assert.deepEqual(mergeProfile(null, { approvals: { browserUnasked: true } }, { approvals: { approveAll: false } }, NOW).profile.approvals, { approveAll: false, browserUnasked: true });
  assert.deepEqual(mergeProfile(null, {}, { approvals: { accountsUnasked: true } }, NOW).profile.approvals, { accountsUnasked: true });
  // Only real booleans count: a synced record is only shape-checked.
  assert.deepEqual(mergeProfile(null, { approvals: { approveAll: 'true' } }, { approvals: { approveAll: 1 } }, NOW).profile.approvals, {});
  assert.deepEqual(APPROVAL_KEYS, ['approveAll', 'browserUnasked', 'accountsUnasked']);
});

test('memory: a fact forgotten on either device stays forgotten; additions on both sides are kept; the same words are kept once', () => {
  const base = { memory: [fact('a', 'A', 1), fact('b', 'B', 2), fact('c', 'C', 3)] };
  const mine = { memory: [fact('a', 'A', 1), fact('c', 'C', 3), fact('m', 'Mine', 5)], updatedAt: 9 }; // forgot b, added m
  const theirs = { memory: [fact('a', 'A', 1), fact('b', 'B', 2), fact('t', 'Theirs', 4)], updatedAt: 8 }; // forgot c, added t
  const { profile } = mergeProfile(base, mine, theirs, NOW);
  assert.deepEqual(profile.memory.map((f) => f.id), ['a', 't', 'm']);
  // No base: nothing is known to be forgotten, so both sides' facts are kept.
  assert.deepEqual(mergeProfile(null, mine, theirs, NOW).profile.memory.map((f) => f.id), ['a', 'b', 'c', 't', 'm']);
  // The same words under two ids (each device learned it): once, the older one.
  const dup = mergeProfile({ memory: [] }, { memory: [fact('x', 'Likes tea', 7)] }, { memory: [fact('y', ' likes TEA ', 6)] }, NOW).profile.memory;
  assert.deepEqual(dup.map((f) => f.id), ['y']);
  // Malformed facts from a synced record are dropped; the newest MEMORY_MAX stay.
  const many = Array.from({ length: MEMORY_MAX + 5 }, (_, i) => fact(`f${i}`, `fact ${i}`, i));
  const big = mergeProfile(null, { memory: [null, 'x', { id: 1, text: 'n' }, { id: 'ok', text: 'kept', at: 99999 }] }, { memory: many }, NOW).profile.memory;
  assert.equal(big.length, MEMORY_MAX);
  assert.equal(big.at(-1).id, 'ok');
  assert.equal(big[0].id, 'f6');
});

test('text fields: the side that changed one since the last sync wins; when both did, or nothing is known, the newer profile', () => {
  assert.deepEqual(PROFILE_TEXT, ['name', 'bio', 'learned', 'style', 'samples']);
  const base = { bio: 'old bio', style: 'old style', learned: 'old', name: 'Cole' };
  const mine = { bio: 'my bio', style: 'old style', learned: 'mine', name: 'Cole', updatedAt: 5 };
  const theirs = { bio: 'old bio', style: 'their style', learned: 'theirs', name: 'Cole', updatedAt: 6 };
  const { profile } = mergeProfile(base, mine, theirs, NOW);
  assert.deepEqual([profile.bio, profile.style, profile.learned, profile.name], ['my bio', 'their style', 'theirs', 'Cole']);
  assert.equal(mergeProfile(base, { ...mine, updatedAt: 7 }, theirs, NOW).profile.learned, 'mine', 'both changed it: the newer profile');
  assert.equal(mergeProfile(null, { bio: 'local', updatedAt: 2 }, { bio: 'server', updatedAt: 3 }, NOW).profile.bio, 'server', 'no base: newest wins, as before');
  assert.equal(mergeProfile(null, { bio: 'local', updatedAt: 4 }, { bio: 'server', updatedAt: 3 }, NOW).profile.bio, 'local');
  // A name cleared on purpose stays cleared; a field neither side has is not invented.
  assert.equal(mergeProfile(base, { ...base, name: '', updatedAt: 9 }, { ...base, updatedAt: 8 }, NOW).profile.name, '');
  assert.ok(!('name' in mergeProfile(null, { bio: 'x' }, {}, NOW).profile));
});

test('sources, unknown fields and the stamp: nothing to send when the result is what the server holds', () => {
  const theirs = { bio: 'b', memory: [fact('a', 'A', 1)], sources: { ChatGPT: { count: 10, at: 5 } }, future: { kept: true }, updatedAt: 50 };
  const same = mergeProfile(theirs, { ...theirs, updatedAt: 50 }, theirs, NOW);
  assert.equal(same.changed, false);
  assert.equal(same.profile.updatedAt, 50, 'unchanged: the server\'s own stamp');
  assert.deepEqual(same.profile.future, { kept: true }, 'a field a newer version added survives an older tab');
  const src = mergeProfile(theirs, { ...theirs, sources: { ChatGPT: { count: 12, at: 9 }, Claude: { count: 3, at: 2 } } }, theirs, NOW);
  assert.deepEqual(src.profile.sources, { ChatGPT: { count: 12, at: 9 }, Claude: { count: 3, at: 2 } });
  assert.equal(src.changed, true);
  // A fresh device (nothing local, no base) takes the server's profile as it is.
  const fresh = mergeProfile(null, { bio: '', learned: '', style: '', samples: '', memory: [], sources: {}, updatedAt: 0 }, theirs, NOW);
  assert.equal(fresh.changed, false);
  assert.equal(fresh.profile.bio, 'b');
  // Garbage in: an empty profile out, never a throw.
  for (const junk of [null, undefined, 'x', 5, []]) assert.deepEqual(mergeProfile(junk, junk, junk, NOW).profile.memory, []);
});

test('factsInUse: every hand-added fact reaches the prompt, then the newest learned ones, in the stored order', () => {
  assert.equal(FACTS_IN_PROMPT, 60);
  const few = [fact('a', 'A', 1, 'you'), fact('b', 'B', 2)];
  assert.deepEqual(factsInUse(few), few, 'under the limit: all of them');
  const list = [fact('mine', 'I am allergic to penicillin', 1, 'you'), ...Array.from({ length: 80 }, (_, i) => fact(`c${i}`, `learned ${i}`, 10 + i))];
  const used = factsInUse(list);
  assert.equal(used.length, 60);
  assert.equal(used[0].id, 'mine', 'the hand-added fact is still in use, and still first');
  assert.deepEqual(used.slice(1).map((f) => f.id), Array.from({ length: 59 }, (_, i) => `c${21 + i}`), 'then the newest 59 learned');
  // More hand-added facts than fit: the newest of them, and no learned ones.
  const own = Array.from({ length: 70 }, (_, i) => fact(`y${i}`, `own ${i}`, i, 'you'));
  const full = factsInUse([...own, fact('z', 'learned', 999)]);
  assert.deepEqual([full.length, full[0].id, full.at(-1).id], [60, 'y10', 'y69']);
  assert.deepEqual(factsInUse(null), []);
  assert.deepEqual(factsInUse(few, 1).map((f) => f.id), ['a']);
  // Still held back until the run's anchor, as before (prompt cache): the window is taken after factsFor.
  assert.deepEqual(factsInUse(factsFor([fact('old', 'x', 5), fact('new', 'y', 50)], 20)).map((f) => f.id), ['old']);
});

test('app.js: sending the profile always reads first and joins; a tab back in view, or another tab\'s save, brings it up to date', () => {
  assert.match(APP, /const was = JSON\.stringify\(ME\), held = LS\.get\('meBase', null\);/);
  assert.match(APP, /let \{ profile, changed \} = mergeProfile\(held, ME, remote\);/);
  assert.match(APP, /if \(kept\) LS\.set\('meBase', sent \? profile : remote\);/);
  // The write names the copy it was joined against; a refusal (409) brings the newer one, joined once more.
  assert.match(APP, /headers: apiHeaders\(\{ 'x-me-base': String\(Number\(against\?\.updatedAt\) \|\| 0\) \}\)/);
  assert.match(APP, /if \(res\?\.status === 409\) \{/);
  // An answer older than the copy already seen here is the store lagging a write: the newer one stands in for it.
  assert.match(APP, /if \(held && \(Number\(remote\?\.updatedAt\) \|\| 0\) < \(Number\(held\.updatedAt\) \|\| 0\)\) remote = held;/);
  assert.doesNotMatch(APP, /body: JSON\.stringify\(ME\) \}\)/, 'the whole local copy is never PUT as it is');
  const push = /\nasync function pushMe\(\) \{[\s\S]*?\n\}\n/.exec(APP)[0], pull = /\nasync function pullMe\(\) \{[\s\S]*?\n\}\n/.exec(APP)[0];
  assert.match(push, /const how = await syncMe\(\);/);
  assert.match(pull, /const how = await syncMe\(\);/);
  assert.match(pull, /seedApprovals\(\);/);
  assert.match(APP, /if \(document\.visibilityState !== 'visible' \|\| S\.tester \|\| !S\.settings\.passcode \|\| meRefused \|\| !navigator\.onLine \|\| Date\.now\(\) - meChecked < 30_000\) return;\n  pullMe\(\);/, 'never while the passcode is being refused: each try counts against the guard');
  assert.match(APP, /if \(ev\.key !== 'atelier\.me' \|\| S\.tester \|\| workspace === 'guest'\) return;/);
  assert.match(APP, /if \(ME\.name && ME\.name !== S\.settings\.name\) \{ S\.settings\.name = ME\.name; saveSettings\(\); renderWelcome\(\); \}/);
  assert.match(APP, /const mem = factsInUse\(factsFor\(ME\.memory, anchor\)\)\.map\(/);
  assert.match(APP, /toast\('Forgotten', \{ ms: 7000, action: \{ label: 'Undo'/);
});
