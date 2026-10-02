import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Owner report 2026-10-02: "What do I need to do today" from Atelier Assist went to plain chat, which said no accounts
// were connected. Day-planning asks reach the accounts agent, and a turn waits for the connected-account list.
const APP = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const HINT = eval(APP.match(/const AGENT_HINT = (\/.*\/i);/)[1]);

test('day-planning requests count as account requests', () => {
  for (const t of ['What do I need to do today', 'what should I do tomorrow', 'what is on my plate', "what's on today", 'my to-do list', 'go through my tasks'])
    assert.ok(HINT.test(t), t);
  for (const t of ['write a poem about today', "what is today's date", 'what is the capital of France', 'explain how to do a backflip'])
    assert.ok(!HINT.test(t), t);
});

test('runChat waits (bounded) for the connected-account list before routing an owner turn', () => {
  assert.match(APP, /if \(!toolsLoaded && !S\.tester && S\.settings\.passcode\) await Promise\.race\(\[\(async \(\) => \{ if \(!server\.nvidia\) await refreshServer\(\); await loadTools\(\); \}\)\(\), sleep\(6000\)\]\)/);
  assert.match(APP, /TOOLS = await r\.json\(\); toolsLoaded = true;/);
});
