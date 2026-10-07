// src/anthropic.js request shapes per model: Claude Haiku 5.5 (the fast role since v80) gets adaptive thinking and an
// effort, never sampling parameters (non-default temperature / top_p / top_k are a 400 since Opus 4.7, Haiku 5.5 too),
// and no server-side fallback (Haiku 5.5 has none). The Anthropic API is a fetch mock.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { claudeChat } from '../src/anthropic.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
function capture() {
  const sent = [];
  globalThis.fetch = async (input, init = {}) => {
    const req = input instanceof Request ? input : new Request(input, init);
    sent.push({ url: req.url, headers: req.headers, json: JSON.parse(await req.text()) });
    const usage = { input_tokens: 10, output_tokens: 2 };
    const body = [
      ev('message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [], stop_reason: null, stop_sequence: null, usage } }),
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } }),
      ev('content_block_stop', { index: 0 }), ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage }), ev('message_stop', {}),
    ].join('');
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  };
  return sent;
}
const run = async (body) => { const r = await claudeChat({ messages: [{ role: 'system', content: 'Title it.' }, { role: 'user', content: 'hi' }], ...body }, 'sk-ant-test'); await r.text(); };

test('Claude Haiku 5.5: claude-haiku-5-5 with adaptive thinking and effort; no temperature/top_p/top_k; no fallbacks', async () => {
  const sent = capture();
  await run({ model: 'anthropic:claude-haiku-5-5', temperature: 0.1, top_p: 0.5, top_k: 5, reasoning_effort: 'low', max_tokens: 60 });
  const j = sent[0].json;
  assert.equal(j.model, 'claude-haiku-5-5');
  assert.deepEqual(j.thinking, { type: 'adaptive', display: 'summarized' });
  assert.deepEqual(j.output_config, { effort: 'low' });
  for (const k of ['temperature', 'top_p', 'top_k', 'fallbacks']) assert.equal(j[k], undefined, k);
  assert.equal(j.max_tokens, 1024, 'clamped up so thinking has room');
  assert.ok(!String(sent[0].headers.get('anthropic-beta') || '').includes('server-side-fallback'));
});

test('other current models keep their shapes: Sonnet 5.5 has the default fallback; no model ever gets sampling parameters', async () => {
  const sent = capture();
  await run({ model: 'anthropic:claude-sonnet-5-5', temperature: 0.7 });
  await run({ model: 'anthropic:claude-opus-5-5', temperature: 0, top_p: 1 });
  for (const s of sent) for (const k of ['temperature', 'top_p', 'top_k']) assert.equal(s.json[k], undefined, `${s.json.model} ${k}`);
  assert.equal(sent[0].json.fallbacks, 'default');
  assert.deepEqual(sent[1].json.thinking, { type: 'adaptive', display: 'summarized' });
});
