import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { browseUnasked, readUnasked, leavesWithData, approvesAll } from '../public/context.js';

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
  assert.match(app, /const browserUnasked = \(\) => S\.settings\.browserUnasked === true && Boolean\(S\.settings\.passcode\);/);
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
  assert.match(app, /const accountsUnasked = \(\) => S\.settings\.accountsUnasked === true && Boolean\(S\.settings\.passcode\);/);
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
  assert.match(app, /const approveAll = \(\) => S\.settings\.approveAll === true && Boolean\(S\.settings\.passcode\);/);
  assert.match(app, /if \(\(step\.write \|\| step\.confirm\) && !step\.auto\) \{/);
  assert.match(app, /if \(step\.write\) step\.approved = true;/, 'a write is still marked approved before it runs');
  assert.match(app, /if \(on && !confirm\('Atelier will act without asking first: send email, post, change settings, move money, click and type\./);
  assert.doesNotMatch(app, /DEFAULT_SETTINGS = \{[^}]*approveAll/s);
});
