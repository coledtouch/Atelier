// v85: every model the owner uses gets its full official output maximum in every user-facing mode, and the background
// helpers keep their small budgets. public/app.js decides the max_tokens (MAX_OUTPUT, roomFor); src/worker.js
// shapeChatBody, src/gemini.js and src/anthropic.js carry it to each provider in that provider's own field, streaming.
// A model whose maximum isn't documented keeps the caller's figure: a max_tokens above a model's limit is refused.
// No provider is ever called: app.js is lifted out of its source, and the Worker runs against a fetch mock.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeEnv, mockFetch, restoreFetch, upstream, reply, sseOf, api, resetTesterCaches } from './tester-env.mjs';

const { CLAUDE_MAX_OUTPUT } = await import('../src/anthropic.js');
const { GEMINI_BASE } = await import('../src/gemini.js');

beforeEach(() => resetTesterCaches());
afterEach(() => restoreFetch());

// ── public/app.js, lifted (as tests/claude-stops.test.mjs does) ──
const APP = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
function constExpr(name) {
  const at = APP.indexOf(`\nconst ${name} = `);
  assert.ok(at >= 0, `app.js has const ${name}`);
  const end = APP.slice(at + 1).search(/\n(?=[^\s})\]])/);
  return APP.slice(at + 1, at + 1 + end).replace(new RegExp(`^const ${name} = `), '').replace(/;\s*(?:\/\/[^\n]*)?$/, '');
}
const vars = { S: { settings: {}, tester: null } };
for (const n of ['EFFORT', 'providerOf', 'MAX_OUTPUT', 'HELPER_ROLES', 'UNLISTED_CLAUDE_ROOM', 'roomFor', 'PREMIUM_MODELS', 'NVIDIA_MODELS']) {
  vars[n] = new Function(...Object.keys(vars), `return (${constExpr(n)});`)(...Object.values(vars));
}
const { MAX_OUTPUT, roomFor, EFFORT } = vars;
const CATALOG = [...new Set([...Object.values(vars.PREMIUM_MODELS), ...Object.values(vars.NVIDIA_MODELS)].flat().map(([id]) => id))];

// The documented maxima (provider docs, read 2026-10-08), and the models with none documented.
const VERIFIED = {
  'anthropic:claude-opus-5-5': 128000, 'anthropic:claude-sonnet-5-5': 128000, 'anthropic:claude-fable-5-1': 128000, 'anthropic:claude-haiku-5-5': 128000,
  'openai:gpt-6-astra': 128000, 'openai:gpt-6-luna': 128000, 'openai:gpt-6.1-sol': 128000,
  'gemini:gemini-3.8-flash': 65536, 'gemini:gemini-3.1-pro-preview': 65536, 'gemini:gemini-3.5-flash-lite': 65536,
  'zai:glm-5.3': 131072, 'zai:glm-5.3-flash': 131072, 'zai:glm-4.7-flash': 128000,
  'deepseek:deepseek-flash': 393216, 'deepseek:deepseek-v4-pro': 393216,
  // NVIDIA's own limits for the models it hosts (its schema); DeepSeek V4.1 Flash: the documented default, since the
  // schema's 1,048,576 is the whole context window
  'deepseek-ai/deepseek-v4.1-flash': 262144, 'moonshotai/kimi-k3': 65536, 'nvidia/nemotron-3-super-120b-a12b': 32768, 'google/gemma-4-31b-it': 32768,
  'nvidia/nemotron-3-ultra-550b-a55b': 32768, 'poolside/laguna-xs-2.1': 16384, 'meta/llama-3.2-90b-vision-instruct': 8192,
  'nvidia/nemotron-3.5-lightning-30b-a3b': 32768, 'openai/gpt-oss-20b': 4096,
};
const UNVERIFIED = ['meta:muse-spark-1.3', 'xai:grok-4.7', 'xai:grok-build-0.1', 'xai:grok-4.3', 'z-ai/glm-5.3', 'z-ai/glm-5.3-flash', 'nvidia/nemotron-nano-3-30b-a3b'];
const USER_ROLES = ['ask', 'smart', 'reason', 'code', 'web', 'vision', 'watch', 'ideas', 'write', 'build', 'agent'];

test('every chat model in the catalogs has a decided budget: its documented maximum, or none documented (the caller’s figure)', () => {
  assert.deepEqual(MAX_OUTPUT, VERIFIED);
  assert.deepEqual(CATALOG.filter((id) => !Object.hasOwn(MAX_OUTPUT, id)).sort(), [...UNVERIFIED].sort(), 'a new model needs its documented maximum, or a place on the unverified list');
  assert.deepEqual(Object.keys(MAX_OUTPUT).filter((id) => !CATALOG.includes(id)), [], 'no stale entries');
  // the Worker's Claude ceiling agrees with the client
  for (const [id, max] of Object.entries(CLAUDE_MAX_OUTPUT)) assert.equal(MAX_OUTPUT[`anthropic:${id}`], max, id);
});

test('per-model budgets: user-facing roles get the model’s maximum; helpers keep their small budget (never above the maximum); unverified models keep the caller’s', () => {
  for (const id of CATALOG) {
    const max = MAX_OUTPUT[id];
    for (const role of USER_ROLES) {
      const want = max ?? (id.startsWith('anthropic:') ? Math.max(6000, vars.UNLISTED_CLAUDE_ROOM[EFFORT[role]] || 0) : 6000);
      assert.equal(roomFor(id, role, 6000), want, `${id} ${role}`);
    }
    // helpers: role 'fast' (titles 800, memory 600, routing 900, prompt polish 1200, Remix repair 8000) and calls marked helper
    for (const base of [600, 800, 900, 1200, 8000]) {
      assert.equal(roomFor(id, 'fast', base), max ? Math.min(base, max) : base, `${id} fast ${base}`);
      assert.equal(roomFor(id, 'write', base, true), max ? Math.min(base, max) : base, `${id} helper ${base}`);
    }
  }
  // a helper on a model with a smaller maximum is held to it (a too-high max_tokens is refused by the provider)
  assert.equal(roomFor('openai/gpt-oss-20b', 'fast', 8000), 4096);
  // testers: the caller's figure, whatever the model (the tester router prices each call from it, ≤ 8,192)
  vars.S.tester = { models: {} };
  try {
    for (const id of ['anthropic:claude-opus-5-5', 'openai:gpt-6-luna', 'gemini:gemini-3.8-flash']) assert.equal(roomFor(id, 'code', 6000), 6000, id);
  } finally { vars.S.tester = null; }
});

test('app.js call sites: the user-facing modes go out on user-facing roles, the background helpers as helpers', () => {
  // user-facing: Ask / Code / Deep think / Web / Vision / "As me" / smart (runChat's role), watch, the agent's tool loop, Ideas, Build
  assert.match(APP, /let role = route === 'vision' \? 'vision' : web \? 'web' : think \? 'reason' : voice \? 'write' : escalate \? 'smart' : e\.kind;/);
  assert.match(APP, /model, messages, signal, max_tokens: think \? 12000 : 6000,\n {4}role,/);
  assert.match(APP, /model, role: 'watch', signal, max_tokens: 6000,/);
  assert.match(APP, /model, role: 'agent', messages: forModel \|\| messages, signal, max_tokens: 16000,/);
  assert.match(APP, /model, role: 'ideas', onModel:/);
  assert.match(APP, /model, role: 'build', onModel:/);
  // helpers: thread titles, memory learning, routing, prompt polish (role 'fast', noThink), style learning and a history
  // import's profile (helper: true)
  for (const [what, re] of [
    ['routing', /model: modelFor\('fast'\), role: 'fast', max_tokens: 900, temperature: 0\.1, extra: noThink,/],
    ['prompt polish', /model: modelFor\('fast'\), role: 'fast', signal, temperature: 0\.8, max_tokens: 1200, extra: noThink,/],
    ['thread title', /completeChat\(\{ model: modelFor\('fast'\), role: 'fast', max_tokens: 800, temperature: 0\.3, extra: noThink,/],
    ['memory learning', /model: modelFor\('fast'\), role: 'fast', max_tokens: 600, temperature: 0\.2, extra: noThink,/],
    ['style learning', /completeChat\(\{ model: modelFor\('write'\), role: 'write', helper: true, max_tokens: 2500,/],
    ['history import', /model, role: 'smart', helper: true, max_tokens: 8000,/],
  ]) assert.match(APP, re, what);
  for (const m of APP.matchAll(/extra: noThink/g)) assert.match(APP.slice(Math.max(0, m.index - 200), m.index), /role: 'fast'/, 'every noThink call is a fast helper');
  // the room is decided once, for every call (and every retry or nudge of it)
  assert.match(APP, /max_tokens: roomFor\(model, role, max_tokens, helper\), stream: true,/);
  assert.equal([...APP.matchAll(/const roomFor = /g)].length, 1, 'defined once');
  assert.equal([...APP.matchAll(/roomFor\(/g)].length, 1, 'used once, in streamChatRaw');
  // effort is the role's own: the ceiling moved, effort didn't
  assert.deepEqual(EFFORT, { agent: 'medium', web: 'low', ask: 'low', smart: 'low', reason: 'high', code: 'high', write: 'medium', vision: 'low', watch: 'low', ideas: 'medium', build: 'high', fast: 'low' });
});

// ── the Worker carries it to each provider, in its own field, still streaming ──
const owner = (env, body) => api(env, 'chat', { method: 'POST', body, headers: { 'content-type': 'application/json', accept: 'text/event-stream' } }, { pass: 'pw', origin: null });
const OPENAI_SSE = () => sseOf(['data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n']);
const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const CLAUDE_SSE = () => sseOf([
  ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } }),
  ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }), ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } }),
  ev('content_block_stop', { index: 0 }), ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }), ev('message_stop', {}),
]);
const body = (model, role = 'code', base = 6000) => ({ model, messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'Write the whole app.' }], temperature: 0.3, top_p: 0.95,
  max_tokens: roomFor(model, role, base), stream: true, ...(model.includes(':') ? { reasoning_effort: EFFORT[role] } : {}) });

test('each provider’s request carries the new maximum in its own field, and the answer still streams', async () => {
  const { env } = makeEnv({ testers: false });
  const cases = [
    // [model, upstream URL, field, value, extra checks]
    ['openai:gpt-6.1-sol', /^POST https:\/\/api\.openai\.com\/v1\/chat\/completions$/, 'max_completion_tokens', 128000, (b) => { assert.equal('max_tokens' in b, false); assert.equal('temperature' in b, false); }],
    ['openai:gpt-6-astra', /api\.openai\.com/, 'max_completion_tokens', 128000],
    ['meta:muse-spark-1.3', /^POST https:\/\/api\.meta\.ai\/v1\/chat\/completions$/, 'max_completion_tokens', 6000, (b) => assert.equal('max_tokens' in b, false)], // none documented: the caller's
    ['xai:grok-4.7', /^POST https:\/\/api\.x\.ai\/v1\/chat\/completions$/, 'max_completion_tokens', 6000, (b) => assert.equal('max_tokens' in b, false)], // none documented: the caller's
    ['gemini:gemini-3.1-pro-preview', /^POST https:\/\/generativelanguage\.googleapis\.com\/v1beta\/openai\/chat\/completions$/, 'max_tokens', 65536],
    ['gemini:gemini-3.8-flash', /openai\/chat\/completions$/, 'max_tokens', 65536],
    ['zai:glm-5.3', /^POST https:\/\/api\.z\.ai\/api\/paas\/v4\/chat\/completions$/, 'max_tokens', 131072, (b) => assert.deepEqual(b.thinking, { type: 'enabled' })],
    ['zai:glm-5.3-flash', /api\.z\.ai/, 'max_tokens', 131072],
    ['deepseek:deepseek-v4-pro', /^POST https:\/\/api\.deepseek\.com\/chat\/completions$/, 'max_tokens', 393216, (b) => assert.deepEqual(b.thinking, { type: 'enabled' })],
    ['deepseek:deepseek-flash', /api\.deepseek\.com/, 'max_tokens', 393216],
    ['deepseek-ai/deepseek-v4.1-flash', /^POST https:\/\/integrate\.api\.nvidia\.com\/v1\/chat\/completions$/, 'max_tokens', 262144],
    ['moonshotai/kimi-k3', /integrate\.api\.nvidia\.com/, 'max_tokens', 65536],
    ['nvidia/nemotron-3-super-120b-a12b', /integrate\.api\.nvidia\.com/, 'max_tokens', 32768],
    ['poolside/laguna-xs-2.1', /integrate\.api\.nvidia\.com/, 'max_tokens', 16384],
    ['meta/llama-3.2-90b-vision-instruct', /integrate\.api\.nvidia\.com/, 'max_tokens', 8192],
    ['z-ai/glm-5.3', /integrate\.api\.nvidia\.com/, 'max_tokens', 6000], // none documented on NVIDIA: the caller's
  ];
  for (const [model, url, field, value, more] of cases) {
    mockFetch([[url, () => OPENAI_SSE()]]);
    const r = await owner(env, body(model));
    assert.equal(r.status, 200, model);
    assert.match(r.headers.get('content-type') || '', /event-stream/, `${model}: still a stream`);
    assert.match(await r.text(), /"content":"ok"[\s\S]*\[DONE\]/, model);
    assert.equal(upstream.calls.length, 1, model);
    const sent = upstream.calls[0].json;
    assert.equal(sent[field], value, `${model}: ${field}`);
    assert.equal(sent.stream, true, `${model}: stream`);
    assert.equal(sent.model, model.replace(/^(openai|gemini|zai|deepseek|meta|xai):/, ''));
    more?.(sent);
  }
});

test('Claude: the Messages API request carries max_tokens 128000 for every listed model, streamed, at the role’s effort', async () => {
  const { env } = makeEnv({ testers: false });
  for (const [model, role] of [['anthropic:claude-opus-5-5', 'code'], ['anthropic:claude-sonnet-5-5', 'agent'], ['anthropic:claude-fable-5-1', 'reason'], ['anthropic:claude-haiku-5-5', 'ask']]) {
    mockFetch([[/^POST https:\/\/api\.anthropic\.com\/v1\/messages/, () => CLAUDE_SSE()]]);
    const r = await owner(env, body(model, role));
    assert.equal(r.status, 200, model);
    assert.match(r.headers.get('content-type'), /event-stream/);
    assert.match(await r.text(), /"content":"ok"/);
    const sent = upstream.calls[0].json;
    assert.deepEqual([sent.max_tokens, sent.stream, sent.output_config], [128000, true, { effort: EFFORT[role] }], model);
  }
  // a helper on Haiku keeps its small budget all the way to Anthropic (the Worker's floor is 1,024)
  mockFetch([[/api\.anthropic\.com/, () => CLAUDE_SSE()]]);
  await (await owner(env, { ...body('anthropic:claude-haiku-5-5', 'fast', 800), reasoning_effort: 'low' })).text();
  assert.equal(upstream.calls[0].json.max_tokens, 1024);
});

test('Gemini watching a clip (the native route): maxOutputTokens 65536, streamed', async () => {
  const { env } = makeEnv({ testers: false });
  const VIDEO = { type: 'video_file', video_file: { file_uri: `${GEMINI_BASE}/v1beta/files/abc123`, mime_type: 'video/mp4' } };
  mockFetch([[/^POST https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-3\.8-flash:streamGenerateContent\?alt=sse$/,
    () => sseOf([`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'A cat jumps.' }] }, finishReason: 'STOP' }] })}\n\n`])]]);
  const b = { ...body('gemini:gemini-3.8-flash', 'watch'), messages: [{ role: 'user', content: [{ type: 'text', text: 'What happens?' }, VIDEO] }] };
  assert.equal(b.max_tokens, 65536);
  const r = await owner(env, b);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /event-stream/);
  assert.match(await r.text(), /A cat jumps\./);
  assert.equal(upstream.calls[0].json.generationConfig.maxOutputTokens, 65536);
});
