import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { browseUnasked } from '../public/context.js';

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
  assert.match(app, /if \(browseUnasked\(step, \{ on: browserUnasked\(\), untrusted: Boolean\(e\.untrusted\) \}\)\) step\.auto = true;\s+else if \(!step\.write && \(e\.untrusted \|\| why \|\| searched > 0 \|\| asksFirst\(step\.name, args\)\)\) step\.confirm = true;/);
  assert.match(app, /step\.write \|\| step\.confirm === true \|\| step\.auto === true\)/, 'the relay and the extension get approved: true');
  assert.match(app, /!step\.confirm && !step\.auto && known !== undefined/);
  assert.match(app, /if \(on && !confirm\('Atelier will open and read pages in your signed-in browser without asking first\./, 'turning it on asks once, with the risk');
  assert.doesNotMatch(app, /DEFAULT_SETTINGS = \{[^}]*browserUnasked/s, 'off unless the owner turns it on');
});
