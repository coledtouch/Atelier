import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, mockFetch, restoreFetch, sseOf, api, signIn, PROFILE, resetTesterCaches } from './tester-env.mjs';
import { chatActual, chatWorstCase } from '../src/tester/prices.js';

const { meter, openaiUsage, geminiUsage, sseUsage } = await import('../src/tester/usage.js');
const { claudeChat } = await import('../src/anthropic.js');

beforeEach(() => resetTesterCaches());
afterEach(() => restoreFetch());

const enc = new TextEncoder();
const bytes = (s) => enc.encode(s);
const source = (chunks, { failAt } = {}) => {
  const state = { cancelled: false, pulled: 0 };
  state.stream = new ReadableStream({
    pull(c) {
      if (failAt === state.pulled) return c.error(new Error('upstream reset'));
      if (state.pulled >= chunks.length) return c.close();
      c.enqueue(chunks[state.pulled++]);
    },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 });
  return state;
};
async function drain(stream) {
  const out = [], reader = stream.getReader();
  for (let r = await reader.read(); !r.done; r = await reader.read()) out.push(r.value);
  return out;
}

test('OpenAI SSE tap: chunks pass through as the very same bytes, and the final usage chunk is read', async () => {
  const usage = { prompt_tokens: 1_234, completion_tokens: 56, total_tokens: 1_290, prompt_tokens_details: { cached_tokens: 1_000 } };
  const text = `data: {"choices":[{"index":0,"delta":{"content":"héllo ✓"}}],"usage":null}\n\ndata: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`;
  const all = bytes(text);
  // split at awkward places: inside a multi-byte character and inside the usage JSON
  const cuts = [3, 37, 41, 90, 131, all.length];
  const chunks = cuts.map((end, i) => all.slice(i ? cuts[i - 1] : 0, end));
  const src = source(chunks);
  let got, calls = 0;
  const out = await drain(meter(src.stream, openaiUsage(), (u) => { calls++; got = u; }));
  assert.equal(out.length, chunks.length);
  out.forEach((c, i) => assert.equal(c, chunks[i], `chunk ${i} is the same object`));
  assert.equal(new TextDecoder().decode(Buffer.concat(out)), text);
  assert.deepEqual(got, usage);
  assert.equal(calls, 1);
});

test('a stream without a usage chunk reports null, so the full reservation stands', async () => {
  let got = 'unset';
  await drain(meter(source([bytes('data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n')]).stream, openaiUsage(), (u) => { got = u; }));
  assert.equal(got, null);
  // usage:null chunks and garbage lines are ignored
  const p = sseUsage((j) => j.usage, 'usage');
  p.push(bytes('data: {"usage":null}\n\ndata: {not json "usage"\n\n: comment\n\n'));
  assert.equal(p.result(), null);
});

test('a cancelled or failed stream reports null exactly once and cancels the upstream', async () => {
  let calls = [];
  const src = source([bytes('data: {"usage":{"prompt_tokens":1}}\n\n'), bytes('data: [DONE]\n\n')]);
  const reader = meter(src.stream, openaiUsage(), (u) => { calls.push(u); }).getReader();
  await reader.read();
  await reader.cancel('client went away');
  assert.deepEqual(calls, [null], 'usage seen so far does not count: the stream did not finish');
  assert.equal(src.cancelled, true);
  calls = [];
  const broken = source([bytes('data: {"usage":{"prompt_tokens":1}}\n\n')], { failAt: 1 });
  await assert.rejects(drain(meter(broken.stream, openaiUsage(), (u) => { calls.push(u); })), /upstream reset/);
  assert.deepEqual(calls, [null]);
});

test('Gemini tap keeps the last usageMetadata (the cumulative one) and tolerates array-wrapped events', () => {
  const p = geminiUsage();
  p.push(bytes('data: [{"candidates":[],"usageMetadata":{"promptTokenCount":10}}]\r\n\r\n'));
  p.push(bytes('data: {"candidates":[],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"totalTokenCount":15}}'));
  assert.deepEqual(p.result(), { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }, 'a last line without a newline still counts');
});

// ── Anthropic: usage per round, iterations priced per model ──
const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const claude = (usage, { stop = 'end_turn', cut = false } = {}) => {
  const events = [
    ev('message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input_tokens, output_tokens: 1 } } }),
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'answer' } }),
  ];
  if (!cut) events.push(ev('content_block_stop', { index: 0 }), ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage }), ev('message_stop', {}));
  return sseOf(events);
};

test('claudeChat tester mode reports final.usage including iterations; the router prices each iteration at its own model', async () => {
  const { env, L } = makeEnv();
  const t = await signIn(L, PROFILE());
  const usage = {
    input_tokens: 2_000, output_tokens: 700, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    iterations: [
      { type: 'message', model: 'claude-opus-5-5', input_tokens: 2_000, output_tokens: 150, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 2_000, output_tokens: 700, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    ],
  };
  mockFetch([[/api\.anthropic\.com/, () => claude(usage)]]);
  const r = await api(env, 'chat', { method: 'POST', body: { model: 'anthropic:claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }] } }, { cookie: t.token });
  await r.text();
  const expected = chatActual({ model: 'anthropic:claude-opus-5-5', usage });
  assert.equal(expected, 2_000 * 4 + 150 * 20 + 2_000 * 5 + 700 * 25, 'declined attempt + fallback, each at its own rates');
  assert.equal(L.ledger.allowance(t.sub).day.spent, expected);
  assert.equal(L.ledger.allowance(t.sub).day.reserved, 0);
});

test('claudeChat tester mode: a cut-off stream or a cancelled reader keeps the full reservation', async () => {
  const { env, L } = makeEnv();
  const t = await signIn(L, PROFILE());
  const body = { model: 'anthropic:claude-sonnet-5-5', max_tokens: 2_000, messages: [{ role: 'user', content: 'hi' }] };
  const worst = chatWorstCase({ model: 'anthropic:claude-sonnet-5-5', inputTokens: Math.ceil(Buffer.byteLength(JSON.stringify(body.messages)) / 3), maxTokens: 2_000 });
  mockFetch([[/api\.anthropic\.com/, () => claude({ input_tokens: 10, output_tokens: 10 }, { cut: true })]]);
  let r = await api(env, 'chat', { method: 'POST', body }, { cookie: t.token });
  assert.match(await r.text(), /"error"/);
  assert.deepEqual(L.ledger.allowance(t.sub).day, { spent: worst, reserved: 0, limit: 1_000_000 });
  // the app stops reading mid-answer (the upstream never ends on its own)
  globalThis.fetch = async () => new Response(new ReadableStream({ start(c) { c.enqueue(bytes(ev('message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }))); } }), { headers: { 'content-type': 'text/event-stream' } });
  r = await api(env, 'chat', { method: 'POST', body }, { cookie: t.token });
  assert.equal(r.status, 200);
  await r.body.cancel();
  await new Promise((res) => setTimeout(res, 20));
  assert.deepEqual(L.ledger.allowance(t.sub).day, { spent: 2 * worst, reserved: 0, limit: 1_000_000 });
});

test('claudeChat without a tester is unchanged: up to four pause_turn rounds and no usage callback', async () => {
  let n = 0;
  globalThis.fetch = async () => { n++; return claude({ input_tokens: 1, output_tokens: 1 }, { stop: n < 3 ? 'pause_turn' : 'end_turn' }); };
  const r = await claudeChat({ model: 'anthropic:claude-sonnet-5-5', web_search: true, messages: [{ role: 'user', content: 'news' }] }, 'sk');
  assert.match(await r.text(), /\[DONE\]/);
  assert.equal(n, 3);
});
