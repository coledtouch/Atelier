import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { agentThread } from '../public/context.js';

// v106: a follow-up with no account word in it stays with the tools when the turn before it was the agent's.
test('the latest Ask or Code entry decides: an agent turn (its steps, or its meta note) keeps the thread with the tools', () => {
  const agent = { kind: 'ask', steps: [], meta: { note: 'accounts agent' } }, chat = { kind: 'ask', meta: { note: 'web available' } };
  assert.equal(agentThread([agent]), true);
  assert.equal(agentThread([chat, agent]), true);
  assert.equal(agentThread([agent, chat]), false, 'a plain answer since then hands the thread back');
  assert.equal(agentThread([{ kind: 'code', meta: { note: 'accounts agent · live web' } }]), true, 'the note alone is enough');
  assert.equal(agentThread([{ kind: 'ask', steps: [{ status: 'done' }] }]), true, 'so are its steps');
  // v114: an empty list alone is not the agent's turn. Every chat restored from a backup carries one, and each then
  // sent its first follow-up to the tools, for good.
  assert.equal(agentThread([{ kind: 'ask', steps: [] }]), false);
  assert.equal(agentThread([{ kind: 'ask', steps: [], meta: { note: 'accounts agent' } }]), true, 'an agent turn that called no tool still has its note');
  assert.equal(agentThread([agent, { kind: 'image' }, { kind: 'video' }, { kind: 'ideas' }]), true, 'an image, video or ideas turn in between is skipped');
  for (const none of [[], undefined, null, [{ kind: 'image' }], [null, {}]]) assert.equal(agentThread(none), false);
});

test('app.js: routing passes the earlier entries, and Tools off still wins', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /const wantsAgent = \(e, browser = liveBrowser\(\), prior = \[\]\) => e\.params\?\.accountAccess !== 'off' && agentTools\(browser\)\.length > 0 && \(e\.params\?\.tools \|\| agentThread\(prior\) \|\| AGENT_HINT\.test\(e\.prompt\)/);
  assert.match(app, /const agent = !hasImg && wantsAgent\(e, run\.browser, prior\);/);
  assert.ok(app.indexOf('prior = at < 0 ? thread.entries : thread.entries.slice(0, at)') < app.indexOf('wantsAgent(e, run.browser, prior)'), 'prior is defined before it is used');
});
