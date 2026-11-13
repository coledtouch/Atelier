// v115: the agent on Gemini failed its second round with 400 "Function call is missing a thought_signature". Gemini signs
// each tool call (tool_calls[].extra_content.google.thought_signature) and wants it back; the app kept only the id, the
// name and the arguments. The Worker side (kept for Gemini, dropped for everyone else) is in tests/video-worker.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APP = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('v115: the agent keeps each tool call’s extra_content (Gemini’s signature) for the next round', () => {
  const at = APP.indexOf('        for (const tc of tool_calls || []) {');
  assert.ok(at > 0);
  const loop = APP.slice(at, APP.indexOf('\n        }\n', at) + 10);
  // Run the merge as the agent does, over a streamed call in two pieces, the signature on the first.
  const calls = [];
  new Function('tool_calls', 'calls', loop)([
    { index: 0, id: 'c1', function: { name: 'messages_send', arguments: '{"to":' }, extra_content: { google: { thought_signature: 'sig' } } },
    { index: 0, function: { arguments: '"5550100"}' } },
  ], calls);
  assert.deepEqual(calls, [{ id: 'c1', type: 'function', function: { name: 'messages_send', arguments: '{"to":"5550100"}' }, extra_content: { google: { thought_signature: 'sig' } } }]);
  // …and the assistant turn carries the calls whole.
  assert.match(APP, /const toolCalls = calls\.filter\(\(c\) => c && c\.function\.name\)\.map\(\(c\) => \(\{ \.\.\.c, id: c\.id \|\| 'call_' \+ uid\(\) \}\)\);/);
});
