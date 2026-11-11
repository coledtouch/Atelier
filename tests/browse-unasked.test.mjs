import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { browseUnasked, readUnasked, leavesWithData, approvesAll, standingOn, approvalsToSeed, APPROVAL_KEYS } from '../public/context.js';

// v104: Settings → Connections → Browser → "Open pages unasked". Looks in the owner's browser run without a card.
test('only a look in the browser, with the setting on, on a turn that did not start from outside text', () => {
  const look = { service: 'browser', write: false }, on = { on: true, untrusted: false };
  assert.equal(browseUnasked(look, on), true);
  assert.equal(browseUnasked({ service: 'browser' }, on), true, 'a step with no write flag is a look');
  assert.equal(browseUnasked({ service: 'browser', write: true }, on), false, 'a click or typing still asks');
  for (const service of ['gmail', 'github', 'slack', 'claude', undefined]) assert.equal(browseUnasked({ service, write: false }, on), false, `${service} still asks`);
  assert.equal(browseUnasked(look, { on: true, untrusted: true }), false, 'a link or share turn still asks');
  for (const off of [false, undefined, null, 'true', 1]) assert.equal(browseUnasked(look, { on: off }), false, 'only a real true turns it on');
  assert.equal(browseUnasked(look), false); assert.equal(browseUnasked(null, on), false);
});

test('app.js: the setting is the owner\'s, the step is sent as approved, and the tab-moved re-ask is skipped only for it', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /const browserUnasked = \(\) => approvalOn\('browserUnasked'\);/);
  assert.match(app, /if \(approvesAll\(\{ \.\.\.standing, on: approveAll\(\) \}\) \|\| \(!leaving && \(browseUnasked\(step, \{ \.\.\.standing, on: browserUnasked\(\) \}\) \|\| readUnasked\(step, \{ \.\.\.standing, on: accountsUnasked\(\) \}\)\)\)\) step\.auto = true;\s+else if \(!step\.write && \(e\.untrusted \|\| why \|\| searched > 0 \|\| asksFirst\(step\.name, args\)\)\) step\.confirm = true;/);
  assert.match(app, /step\.write \|\| step\.confirm === true \|\| step\.auto === true\)/, 'the relay and the extension get approved: true');
  assert.match(app, /!step\.confirm && !step\.auto && known !== undefined/);
  assert.match(app, /if \(on && !confirm\('Atelier will open and read pages in your signed-in browser without asking first\./, 'turning it on asks once, with the risk');
  assert.doesNotMatch(app, /DEFAULT_SETTINGS = \{[^}]*browserUnasked/s, 'off unless the owner turns it on');
});

// v105: Settings → Connections → Approvals → "Read accounts unasked", and the stop both settings keep.
test('an account read runs unasked only with the setting on: never a write, a browser step, or a link or share turn', () => {
  const on = { on: true, untrusted: false };
  for (const service of ['gmail', 'slack', 'github', 'claude', 'stripe']) assert.equal(readUnasked({ service, write: false }, on), true, service);
  assert.equal(readUnasked({ service: 'gmail', write: true }, on), false, 'a send or a draft still asks');
  assert.equal(readUnasked({ service: 'browser', write: false }, on), false, 'the browser has its own setting');
  assert.equal(readUnasked({ write: false }, on), false, 'a tool with no service is not an account read');
  assert.equal(readUnasked({ service: 'gmail' }, { on: true, untrusted: true }), false);
  for (const off of [false, undefined, null, 'true', 1]) assert.equal(readUnasked({ service: 'gmail' }, { on: off }), false);
  assert.equal(readUnasked(null, on), false); assert.equal(readUnasked({ service: 'gmail' }), false);
});

test('a chosen web address still asks when outside text and account data share the context; any one missing lets it run', () => {
  assert.equal(leavesWithData({ wayOut: true, outside: true, data: true }), true);
  for (const miss of ['wayOut', 'outside', 'data']) assert.equal(leavesWithData({ wayOut: true, outside: true, data: true, [miss]: false }), false, `without ${miss}`);
  assert.equal(leavesWithData(), false);
});

test('app.js: the way-out check reads the run and the thread; the account setting is the owner\'s and off by default', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /const leaving = leavesWithData\(\{ wayOut: asksFirst\(step\.name, args\), outside: Boolean\(taint \|\| pageRead \|\| titlesRead \|\| chatsRead \|\| searched > 0\), data: accountRead \|\| dataBefore \}\);/);
  assert.match(app, /const dataBefore = \(thread\?\.entries \|\| \[\]\)\.some\(\(x\) => x !== e && x\.steps\?\.some\(\(st\) => st\.status === 'done' && st\.service !== 'browser'\)\);/);
  assert.match(app, /const accountsUnasked = \(\) => approvalOn\('accountsUnasked'\);/);
  assert.match(app, /if \(on && !confirm\('Atelier will read your connected accounts without asking first/);
  assert.doesNotMatch(app, /DEFAULT_SETTINGS = \{[^}]*accountsUnasked/s);
});

// v106: Settings → Connections → Approvals → "Approve everything": no card for any step, writes included.
test('Approve everything is on only by a real true, and never for a turn that began from a link or a share', () => {
  assert.equal(approvesAll({ on: true, untrusted: false }), true);
  assert.equal(approvesAll({ on: true, untrusted: true }), false);
  for (const off of [false, undefined, null, 'true', 1]) assert.equal(approvesAll({ on: off }), false);
  assert.equal(approvesAll(), false);
});

test('app.js: an approved-everything step skips the card, writes included; the setting is the owner\'s, off by default, and asks once', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /const approveAll = \(\) => approvalOn\('approveAll'\);/);
  assert.match(app, /if \(\(step\.write \|\| step\.confirm\) && !step\.auto\) \{/);
  assert.match(app, /if \(step\.write\) step\.approved = true;/, 'a write is still marked approved before it runs');
  assert.match(app, /if \(on && !confirm\('Atelier will act without asking first: send email, post, change settings, move money, click and type\./);
  assert.doesNotMatch(app, /DEFAULT_SETTINGS = \{[^}]*approveAll/s);
});

// v108: the approval switches follow the owner's account (synced profile), not one device.
test('a synced true or false wins; with none synced, this device\'s old setting counts', () => {
  assert.equal(standingOn(true, false), true);
  assert.equal(standingOn(false, true), false, 'turning it off on another device sticks here');
  assert.equal(standingOn(undefined, true), true);
  for (const local of [false, undefined, 'true', 1]) assert.equal(standingOn(undefined, local), false);
  assert.equal(standingOn('true', false), false, 'only a real boolean in the profile counts');
});

test('a switch only this device has on is copied up once; one the profile already holds is left alone', () => {
  assert.deepEqual(APPROVAL_KEYS, ['approveAll', 'browserUnasked', 'accountsUnasked']);
  assert.deepEqual(approvalsToSeed(undefined, { approveAll: true, browserUnasked: false }), { approveAll: true });
  assert.deepEqual(approvalsToSeed({ approveAll: false }, { approveAll: true }), {}, 'an off from another device is not undone');
  assert.deepEqual(approvalsToSeed({ approveAll: true }, { approveAll: true, accountsUnasked: true }), { accountsUnasked: true });
  assert.deepEqual(approvalsToSeed(null, null), {});
});

test('app.js: the switches read the profile, write both places, and seed after a pull', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /const approvalOn = \(key\) => Boolean\(S\.settings\.passcode\) && standingOn\(ME\?\.approvals\?\.\[key\], S\.settings\[key\]\);/);
  assert.match(app, /ME\.approvals = \{ \.\.\.\(ME\.approvals \|\| \{\}\), \[key\]: on \}; saveMe\(\);/);
  for (const k of ['browserUnasked', 'approveAll', 'accountsUnasked']) {
    assert.match(app, new RegExp(`setApproval\\('${k}', on\\);`));
    assert.doesNotMatch(app, new RegExp(`S\\.settings\\.${k} = on;`), k);
  }
  assert.match(app, /pushMe\(\);\s+seedApprovals\(\);\s+setSync\('synced', true\);/);
});
