import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeEnv, mockFetch, restoreFetch, upstream, reply, sseOf, api, signIn, PROFILE, resetTesterCaches, allowanceOf } from './tester-env.mjs';
import { PRICES, chatWorstCase, chatActual, imageCost, imageActual, veoCost, maxTokensWithin, TESTER_MODELS, TESTER_IMAGE_MODELS, TESTER_VIDEO_MODELS } from '../src/tester/prices.js';

const { TESTER_ROUTES, PUBLIC_PATHS, matchTesterRoute, LIMITS } = await import('../src/tester/router.js');
const { GEMINI_BASE } = await import('../src/gemini.js');
const { DAILY_UPLOADS, OVERRUN } = await import('../src/tester/ledger.js');

beforeEach(() => resetTesterCaches());
afterEach(() => restoreFetch());

// A signed-in tester. call() checks that no tester-facing error ever mentions a passcode.
async function tester({ config = {} } = {}) {
  const { env, L } = makeEnv();
  const t = await signIn(L, PROFILE());
  if (Object.keys(config).length) L.ledger.setConfig(config);
  const call = async (path, init = {}, who = {}) => {
    const r = await api(env, path, init, { cookie: t.token, ...who });
    if (r.status >= 400) assert.ok(!/passcode/i.test(await r.clone().text()), `${path}: an error mentions the passcode`);
    return r;
  };
  return { env, L, ...t, call, other: async () => (await signIn(L, PROFILE())).token };
}
const post = (body, headers = {}) => ({ method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });
const codeOf = async (r) => (await r.clone().json().catch(() => ({}))).code;
const spent = (L, sub) => L.ledger.allowance(sub).day;
const textTokens = (messages) => Math.ceil(Buffer.byteLength(JSON.stringify(messages, (k, v) => (k === 'url' && typeof v === 'string' ? '' : v))) / 3);

// ── Anthropic SSE as the SDK reads it ──
const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
function claudeStream({ model = 'claude-sonnet-5-5', text = 'Hello', stop = 'end_turn', usage = { input_tokens: 1_200, output_tokens: 80, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } = {}) {
  return sseOf([
    ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } }),
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }),
    ev('content_block_stop', { index: 0 }),
    ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage }),
    ev('message_stop', {}),
  ]);
}
const ANTHROPIC = /^POST https:\/\/api\.anthropic\.com\/v1\/messages/;

// ── 1. deny by default, enumerated from the code itself (addendum A5) ──
// Every route literal the owner's router dispatches on (worker.js, plus gemini.js's /api/video/* table) and every
// entry of the tester table. A route added later shows up here without anyone editing this test.
const workerSrc = await readFile(new URL('../src/worker.js', import.meta.url), 'utf8');
const geminiSrc = await readFile(new URL('../src/gemini.js', import.meta.url), 'utf8');
const exact = [...workerSrc.matchAll(/path === '([^']+)'/g)].map((m) => m[1]);
const prefixes = [...workerSrc.matchAll(/path\.startsWith\('([^']+)'\)/g)].map((m) => m[1]);
const regexLeads = [...workerSrc.matchAll(/path\.match\(\/\^((?:\\\/|[\w-])+)/g)].map((m) => m[1].replace(/\\\//g, '/'));
const videoRoutes = [...geminiSrc.matchAll(/route === '([^']+)'/g)].map((m) => `video/${m[1]}`);
const SAMPLES = [...new Set([
  ...exact, ...prefixes.flatMap((p) => (p.endsWith('/') ? [`${p}probe`, `${p}a/b`] : [p, `${p}/probe`])), ...regexLeads.map((p) => `${p}probe`), ...videoRoutes,
  ...TESTER_ROUTES.map((r) => r.sample ?? r.match),
  // owner-only shapes under the tester-allowed prefixes
  'x/openai/images/variations', 'x/meta/images/edits', 'x/gemini/v1/models/veo-3.1-lite-generate-preview:predictLongRunning',
  'x/gemini/v1beta/models/gemini-3.8-flash/operations/x', 'x/gemini/v1beta/files/abc123', 'tester/me/x', 'video/upload',
])];
const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
const isPublic = (path) => PUBLIC_PATHS.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p));

test('the sweep really enumerates the owner router (sanity check on the scan)', () => {
  for (const p of ['me', 'diag', 'models', 'relay/ws', 'relay/pair', 'tools', 'tools/run', 'oauth/google/start', 'oauth/canva/callback', 'canva/send-image', 'canva/file', 'testers', 'chat', 'health']) assert.ok(exact.includes(p), p);
  for (const p of ['relay/', 'tools', 'oauth/', 'accounts/', 'photos/', 'canva/', 'video/', 'genai/', 'fn/', 'status/', 'li/', 'tester/', 'testers/']) assert.ok(prefixes.includes(p), p);
  for (const p of ['x/', 'accounts/', 'photos/', 'canva/designs/']) assert.ok(regexLeads.includes(p), p);
  assert.deepEqual(videoRoutes.sort(), ['video/file', 'video/upload/cancel', 'video/upload/chunk', 'video/upload/query', 'video/upload/start']);
  assert.ok(SAMPLES.length > 50);
});

test('deny by default: every route a tester isn’t allowed answers 403 owner_only, before any upstream or account work', async () => {
  const { env, L, call } = await tester();
  mockFetch([[/./, () => reply(500, { error: 'should not be called' })]]);
  let denied = 0, allowed = 0;
  for (const path of SAMPLES) {
    if (isPublic(path)) continue;
    for (const method of METHODS) {
      const before = upstream.calls.length;
      L.calls.length = 0;
      const r = await call(path, { method, ...(method === 'GET' ? {} : { body: '' }) });
      const code = await codeOf(r);
      if (matchTesterRoute(method, path)) {
        allowed++;
        assert.notEqual(code, 'owner_only', `${method} ${path} is on the tester list`);
      } else {
        denied++;
        assert.equal(r.status, 403, `${method} ${path}`);
        assert.equal(code, 'owner_only', `${method} ${path}`);
        assert.equal(upstream.calls.length, before, `${method} ${path} reached a provider`);
        assert.ok(L.calls.every((m) => m === 'session'), `${method} ${path} touched the Ledger: ${L.calls}`);
      }
    }
  }
  assert.ok(denied > 200 && allowed >= TESTER_ROUTES.length, `${denied} denied, ${allowed} allowed`);
  // the KV holding the owner's profile, accounts and lockouts was never touched
  assert.deepEqual([...env.ATELIER_KV.m.keys()], []);
});

test('every tester-table route is reachable by a tester and keeps the owner/tester split', async () => {
  const { env, L, call } = await tester();
  mockFetch([[/./, () => reply(500, { error: 'stub' })]]);
  for (const route of TESTER_ROUTES) {
    const path = route.sample ?? route.match;
    const r = await call(path, { method: route.method, ...(route.method === 'GET' ? {} : { body: '' }) });
    assert.notEqual(await codeOf(r), 'owner_only', `${route.method} ${path}`);
    assert.notEqual(r.status, 404, `${route.method} ${path}`);
  }
  // the owner keeps every one of them, and never reaches the tester-only ones
  for (const route of TESTER_ROUTES) {
    const path = route.sample ?? route.match;
    const r = await api(env, path, { method: route.method, ...(route.method === 'GET' ? {} : { body: '' }) }, { pass: 'pw' });
    const code = await codeOf(r);
    if (path.startsWith('tester/')) assert.equal(code, 'tester_signin', path);
    else assert.ok(!['owner_only', 'tester_owner', 'tester_model', 'tester_origin'].includes(code), `${route.method} ${path}: ${code}`);
  }
  assert.equal(L.calls.filter((m) => m !== 'session' && m !== 'allowance' && m !== 'ownsJob' && m !== 'uploadGate' && m !== 'dropSlot' && m !== 'getProfile').length, 0, `${L.calls}`);
});

test('with a passcode and a tester cookie, every route takes the owner path exactly as without the cookie', async () => {
  const { env, L, token } = await tester();
  env.RELAY = { idFromName: () => 'main', get: () => ({ fetch: async () => reply(200, { online: false }) }) };
  mockFetch([[/./, () => reply(503, { error: 'stub' })]]);
  for (const path of SAMPLES) {
    if (isPublic(path)) continue;
    for (const method of ['GET', 'POST', 'DELETE']) {
      const init = { method, ...(method === 'POST' ? { body: '{}' } : {}) };
      L.calls.length = 0;
      const withCookie = await api(env, path, init, { pass: 'pw', cookie: token });
      assert.ok(!L.calls.includes('session'), `${method} ${path}: the owner path never looks the cookie up`);
      if (!path.startsWith('testers')) assert.deepEqual(L.calls, [], `${method} ${path}: only the owner's Testers panel reads the Ledger`);
      const plain = await api(env, path, init, { pass: 'pw' });
      assert.equal(withCookie.status, plain.status, `${method} ${path}`);
      assert.notEqual(await codeOf(withCookie), 'owner_only');
    }
  }
});

test('non-GET tester requests need the app Origin (CSRF)', async () => {
  const { call } = await tester();
  for (const origin of [null, 'https://evil.example', 'http://localhost:8787', 'https://atelier.ciprari.ai.evil.example']) {
    const r = await call('chat', post({ model: 'openai:gpt-6-luna', messages: [{ role: 'user', content: 'hi' }] }), { origin });
    assert.equal(r.status, 403);
    assert.equal(await codeOf(r), 'tester_origin');
  }
  const r = await call('tester/profile', { method: 'PUT', body: '{}' }, { origin: 'http://127.0.0.1:8787' });
  assert.equal(r.status, 200, 'the dev origin is allowed');
});

// ── 2. shaping ──
test('chat (OpenAI-compatible): the body is rebuilt from a whitelist; usage passes through and settles the reservation', async () => {
  const { L, sub, call } = await tester();
  const usage = { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 };
  const chunks = ['data: {"choices":[{"index":0,"delta":{"content":"Hi"}}],"usage":null}\n\n', `data: ${JSON.stringify({ choices: [], usage })}\n\n`, 'data: [DONE]\n\n'];
  mockFetch([[/^POST https:\/\/api\.openai\.com\/v1\/chat\/completions$/, () => sseOf(chunks)]]);
  const r = await call('chat', post({
    model: 'openai:gpt-6-luna', stream: false, n: 4, max_tokens: 100_000, temperature: 0.7, top_p: 0.9, reasoning_effort: 'max',
    tools: [{ type: 'function', function: { name: 'gmail_send', parameters: {} } }], tool_choice: 'auto', web_search: true,
    stream_options: { include_usage: false }, modalities: ['audio'], extra_body: { cached_content: 'cachedContents/x' }, logit_bias: { 1: 100 },
    messages: [
      { role: 'system', content: 'You are Atelier.' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi', tool_calls: [{ id: 't1', type: 'function', function: { name: 'x', arguments: '{}' } }], reasoning_content: 'r', anthropic_content: [{ type: 'text', text: 'x' }] },
      { role: 'tool', tool_call_id: 't1', content: 'tool output' },
      { role: 'user', content: [{ type: 'text', text: 'and now?' }, { type: 'input_audio', input_audio: { data: 'x' } }] },
    ],
  }, { accept: 'text/event-stream' }));
  assert.equal(r.status, 200);
  const reservedLeft = allowanceOf(r);
  assert.equal(await r.text(), chunks.join(''), 'the stream reaches the app byte-identical');
  const sent = upstream.calls[0].json;
  assert.deepEqual(Object.keys(sent).sort(), ['max_completion_tokens', 'messages', 'model', 'reasoning_effort', 'stream', 'stream_options']);
  assert.equal(sent.model, 'gpt-6-luna');
  assert.equal(sent.stream, true);
  assert.deepEqual(sent.stream_options, { include_usage: true });
  assert.equal(sent.reasoning_effort, 'high', 'effort capped at high');
  assert.equal(sent.max_completion_tokens, LIMITS.output, 'max_tokens ≤ 8,192');
  assert.deepEqual(sent.messages, [
    { role: 'system', content: 'You are Atelier.' }, { role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' },
    { role: 'user', content: [{ type: 'text', text: 'and now?' }] },
  ]);
  assert.equal(upstream.calls[0].headers.get('authorization'), 'Bearer sk-openai-test');
  const worst = chatWorstCase({ model: 'openai:gpt-6-luna', inputTokens: textTokens(sent.messages), maxTokens: LIMITS.output });
  assert.equal(reservedLeft.dayLeft, 1_000_000 - worst);
  assert.deepEqual(spent(L, sub), { spent: chatActual({ model: 'openai:gpt-6-luna', usage }), reserved: 0, limit: 1_000_000 });
});

test('chat: only known effort levels pass (never an inherited key)', async () => {
  const { call } = await tester();
  mockFetch([[/openai\.com\/v1\/chat\/completions/, () => sseOf(['data: [DONE]\n\n'])]]);
  for (const [effort, sent] of [['__proto__', undefined], ['constructor', undefined], ['minimal', 'low'], ['medium', 'medium'], ['xhigh', 'high']]) {
    const r = await call('chat', post({ model: 'openai:gpt-6-luna', reasoning_effort: effort, messages: [{ role: 'user', content: 'hi' }] }));
    await r.text();
    assert.equal(upstream.calls.at(-1).json.reasoning_effort, sent, effort);
  }
});

test('Meta images: allow-listed model, n ≤ 4, explicit size; settled per image returned', async () => {
  const { L, sub, call } = await tester();
  mockFetch([[/^POST https:\/\/api\.meta\.ai\/v1\/images\/generations$/, () => reply(200, { data: [{ b64_json: 'A' }, { b64_json: 'B' }] })]]);
  let r = await call('x/meta/images/generations', post({ model: 'muse-image-1.0', prompt: 'a fox', n: 3, size: '1536x864', style: 'x' }));
  assert.equal(r.status, 200);
  assert.deepEqual(upstream.calls[0].json, { model: 'muse-image-1.0', prompt: 'a fox', n: 3, size: '1536x864', response_format: 'b64_json' });
  assert.deepEqual(spent(L, sub), { spent: 20_000, reserved: 0, limit: 1_000_000 }, 'two images came back: $0.02');
  r = await call('x/meta/images/generations', post({ model: 'muse-image-2.0', prompt: 'a fox' }));
  assert.equal(await codeOf(r), 'tester_model');
});

test('chat: unknown, NVIDIA and free models are refused with tester_model; oversized requests with tester_too_large', async () => {
  const { L, sub, call } = await tester();
  mockFetch([]);
  for (const model of ['openai:gpt-9', 'moonshotai/kimi-k3', 'z-ai/glm-5.3', 'zai:glm-4.7-flash', 'anthropic:claude-opus-4-8', 'gemini:gemini-3-pro-image', '', undefined]) {
    const r = await call('chat', post({ model, messages: [{ role: 'user', content: 'hi' }] }));
    assert.equal(r.status, 403, String(model));
    assert.equal(await codeOf(r), 'tester_model');
  }
  let r = await call('chat', post({ model: 'openai:gpt-6-luna', messages: [{ role: 'user', content: 'x'.repeat(410 * 1024) }] }));
  assert.equal(r.status, 413);
  assert.equal(await codeOf(r), 'tester_too_large');
  r = await call('chat', { method: 'POST', body: '{}', headers: { 'content-length': String(11 * 1024 * 1024) } });
  assert.equal(r.status, 413, 'a declared body over 10 MB is refused before reading');
  const img = 'data:image/png;base64,iVBORw0KGgo=';
  r = await call('chat', post({ model: 'gemini:gemini-3.8-flash', messages: [{ role: 'user', content: Array.from({ length: 17 }, () => ({ type: 'image_url', image_url: { url: img } })) }] }));
  assert.equal(r.status, 413);
  r = await call('chat', post({ model: 'gemini:gemini-3.8-flash', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/x.png' } }] }] }));
  assert.equal(r.status, 400, 'remote image URLs are refused');
  // PriceError no_vision / unpriced_images → a non-tester_ code so the app's fallback moves on
  for (const model of ['zai:glm-5.3', 'openai:gpt-6-luna', 'deepseek:deepseek-flash']) {
    r = await call('chat', post({ model, messages: [{ role: 'user', content: [{ type: 'text', text: 'what is this?' }, { type: 'image_url', image_url: { url: img } }] }] }));
    assert.equal(r.status, 400, model);
    assert.equal(await codeOf(r), 'model_no_images');
  }
  assert.equal(upstream.calls.length, 0);
  assert.deepEqual(spent(L, sub), { spent: 0, reserved: 0, limit: 1_000_000 }, 'nothing reserved');
});

test('chat: images to OpenAI go as detail:"high" and are priced per image', async () => {
  const { L, sub, call } = await tester();
  mockFetch([[/openai\.com\/v1\/chat\/completions/, () => sseOf(['data: [DONE]\n\n'])]]);
  const img = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
  const r = await call('chat', post({ model: 'openai:gpt-6-astra', max_tokens: 2_000, messages: [{ role: 'user', content: [{ type: 'text', text: 'what?' }, { type: 'image_url', image_url: { url: img, detail: 'auto' } }] }] }));
  assert.equal(r.status, 200);
  const sent = upstream.calls[0].json;
  assert.deepEqual(sent.messages[0].content[1], { type: 'image_url', image_url: { url: img, detail: 'high' } });
  const worst = chatWorstCase({ model: 'openai:gpt-6-astra', inputTokens: textTokens(sent.messages), maxTokens: sent.max_completion_tokens, images: 1, imageDetail: 'high' });
  assert.equal(allowanceOf(r).dayLeft, 1_000_000 - worst);
  await r.text();
  assert.equal(spent(L, sub).spent, worst, 'no usage reported: the full reservation stands');
});

test('chat (Claude): no tools, effort capped at high, max_tokens at the $0.25 cap, fallback priced in, usage settles', async () => {
  const { L, sub, call } = await tester();
  const usage = { input_tokens: 900, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  mockFetch([[ANTHROPIC, () => claudeStream({ model: 'claude-fable-5-1', usage })]]);
  const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'Explain monads' }];
  const r = await call('chat', post({ model: 'anthropic:claude-fable-5-1', max_tokens: 32_000, reasoning_effort: 'max', tools: [{ type: 'function', function: { name: 'gmail_send', description: 'x', parameters: {} } }], messages }));
  assert.equal(r.status, 200);
  const cap = maxTokensWithin({ model: 'anthropic:claude-fable-5-1', inputTokens: textTokens(messages), ceiling: LIMITS.output });
  const worst = chatWorstCase({ model: 'anthropic:claude-fable-5-1', inputTokens: textTokens(messages), maxTokens: cap });
  assert.ok(cap >= 1024 && cap < 3000 && worst <= 250_000);
  assert.equal(allowanceOf(r).dayLeft, 1_000_000 - worst);
  const out = await r.text();
  assert.match(out, /"content":"Hello"/);
  const sent = upstream.calls[0].json;
  assert.equal(sent.model, 'claude-fable-5-1');
  assert.equal(sent.max_tokens, cap);
  assert.deepEqual(sent.output_config, { effort: 'high' });
  assert.equal(sent.tools, undefined);
  assert.equal(sent.fallbacks, 'default', 'non-web calls keep the refusal fallback, priced at the dearest target');
  assert.equal(upstream.calls[0].headers.get('anthropic-beta'), 'server-side-fallback-2026-07-01');
  assert.deepEqual(spent(L, sub), { spent: chatActual({ model: 'anthropic:claude-fable-5-1', usage }), reserved: 0, limit: 1_000_000 });
});

test('chat (Claude web search): max_uses is the largest of 3/2/1 that fits $0.50, fallbacks off, one round only', async () => {
  const { L, sub, call } = await tester();
  const usage = { input_tokens: 30_000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: { web_search_requests: 1 } };
  mockFetch([[ANTHROPIC, () => claudeStream({ model: 'claude-opus-5-5', stop: 'pause_turn', usage })]]);
  const messages = [{ role: 'user', content: 'What happened in the news today?' }];
  const r = await call('chat', post({ model: 'anthropic:claude-opus-5-5', web_search: true, max_tokens: 6_000, messages }));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-tester-model'), null);
  await r.text();
  assert.equal(upstream.calls.length, 1, 'pause_turn is not continued for testers');
  const sent = upstream.calls[0].json;
  const web = sent.tools.find((t) => t.type === 'web_search_20260209');
  const base = { model: 'anthropic:claude-opus-5-5', inputTokens: textTokens(messages), fallbacks: false };
  const fits = (uses) => maxTokensWithin({ ...base, webSearches: uses, budget: 500_000, ceiling: 6_000 }) > 0;
  const expected = [3, 2, 1].find(fits);
  assert.equal(web.max_uses, expected);
  assert.ok(expected < 3 && !fits(expected + 1), 'Opus can’t afford three searches at $0.50');
  assert.equal(sent.fallbacks, undefined);
  assert.equal(upstream.calls[0].headers.get('anthropic-beta'), null);
  assert.equal(sent.max_tokens, maxTokensWithin({ ...base, webSearches: expected, budget: 500_000, ceiling: 6_000 }));
  assert.deepEqual(spent(L, sub), { spent: chatActual({ model: 'anthropic:claude-opus-5-5', usage }), reserved: 0, limit: 1_000_000 });
});

test('chat (Claude web search): a context too big for Opus runs on Sonnet 5.5 and says so; too big for both is a per-call refusal', async () => {
  const { call } = await tester();
  mockFetch([[ANTHROPIC, () => claudeStream()]]);
  const long = 'word '.repeat(20_000); // ~100 KB: ~33K tokens
  let r = await call('chat', post({ model: 'anthropic:claude-opus-5-5', web_search: true, messages: [{ role: 'user', content: long }] }));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-tester-model'), 'anthropic:claude-sonnet-5-5');
  await r.text();
  assert.equal(upstream.calls[0].json.model, 'claude-sonnet-5-5');
  r = await call('chat', post({ model: 'anthropic:claude-opus-5-5', web_search: true, messages: [{ role: 'user', content: 'word '.repeat(70_000) }] }));
  assert.equal(r.status, 402);
  assert.deepEqual(await r.json(), { error: 'This request is bigger than one tester call allows — start a new thread, attach less or pick a lighter model.', code: 'tester_budget', scope: 'call', resetsAt: null });
  assert.equal(upstream.calls.length, 1);
});

test('budget refusals: 402 tester_budget with scope, resetsAt and the allowance header; paused → 503 tester_paused', async () => {
  const { L, call } = await tester({ config: { day_limit: 1_000 } });
  mockFetch([]);
  const body = post({ model: 'anthropic:claude-sonnet-5-5', messages: [{ role: 'user', content: 'hi' }] });
  let r = await call('chat', body);
  assert.equal(r.status, 402);
  const j = await r.json();
  assert.equal(j.code, 'tester_budget');
  assert.equal(j.scope, 'day');
  assert.match(j.resetsAt, /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
  assert.deepEqual(allowanceOf(r), { dayLeft: 1_000, monthLeft: 10_000_000, poolLeft: 100_000_000 });
  assert.match(j.error, /You’ve used today’s tester allowance/, 'less than a cent left reads as used up');
  L.ledger.setConfig({ day_limit: 200_000 });
  r = await call('chat', post({ model: 'anthropic:claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }] }));
  const short = await r.json();
  assert.equal(short.scope, 'day');
  assert.equal(short.error, 'This request needs more than the $0.20 left today — pick a lighter model, a shorter clip or attach less.');
  assert.equal(allowanceOf(r).dayLeft, 200_000);
  L.ledger.setConfig({ day_limit: 1_000_000, pool_limit: 10 });
  r = await call('chat', body);
  assert.equal((await r.json()).scope, 'pool');
  L.ledger.setConfig({ paused: true });
  r = await call('chat', body);
  assert.equal(r.status, 503);
  assert.equal(await codeOf(r), 'tester_paused');
  assert.equal(upstream.calls.length, 0);
});

test('an upstream refusal before any output settles at $0', async () => {
  const { L, sub, call } = await tester();
  mockFetch([[/openai\.com/, () => reply(429, { error: { message: 'Rate limited' } })]]);
  const r = await call('chat', post({ model: 'openai:gpt-6-luna', messages: [{ role: 'user', content: 'hi' }] }));
  assert.equal(r.status, 429);
  assert.ok(allowanceOf(r));
  assert.deepEqual(spent(L, sub), { spent: 0, reserved: 0, limit: 1_000_000 });
});

// ── images ──
test('OpenAI images: allow-listed models, n ≤ 4, explicit size and quality ≤ medium, settled from usage', async () => {
  const { L, sub, call } = await tester();
  const usage = { input_tokens: 40, input_tokens_details: { text_tokens: 20, image_tokens: 20 }, output_tokens: 439 };
  mockFetch([[/^POST https:\/\/api\.openai\.com\/v1\/images\/(generations|edits)$/, () => reply(200, { data: [{ b64_json: 'AAAA' }], usage })]]);
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  let r = await call('x/openai/images/edits', post({ model: 'gpt-image-2.5-sunburst', prompt: 'make it blue', n: 1, quality: 'high', output_format: 'jpeg', images: [{ image_url: png }], input_fidelity: 'high', moderation: 'low', stream: true, partial_images: 3 }));
  assert.equal(r.status, 200);
  assert.deepEqual(upstream.calls[0].json, { model: 'gpt-image-2.5-sunburst', prompt: 'make it blue', n: 1, size: '1024x1024', quality: 'medium', output_format: 'jpeg', images: [{ image_url: png }], input_fidelity: 'high' });
  assert.deepEqual(await r.json(), { data: [{ b64_json: 'AAAA' }], usage });
  const actual = imageActual({ model: 'openai:gpt-image-2.5-sunburst', usage });
  assert.deepEqual(spent(L, sub), { spent: actual, reserved: 0, limit: 1_000_000 });
  assert.equal(allowanceOf(r).dayLeft, 1_000_000 - actual, 'the header reflects the settled cost');
  r = await call('x/openai/images/generations', post({ model: 'gpt-image-2.5-flare', prompt: 'a fox', n: 4, size: '1792x1008', quality: 'low' }));
  assert.equal(r.status, 200);
  assert.equal(upstream.calls[1].json.n, 4);
  assert.equal(upstream.calls[1].json.size, '1792x1008');
  for (const bad of [{ n: 5 }, { n: 0 }, { model: 'dall-e-3' }, { prompt: '' }, { model: 'gpt-image-2.5-flare', n: 1.5 }]) {
    r = await call('x/openai/images/generations', post({ model: 'gpt-image-2.5-flare', prompt: 'a fox', ...bad }));
    assert.ok([400, 403].includes(r.status), JSON.stringify(bad));
  }
  assert.equal(upstream.calls.length, 2);
  assert.ok(imageCost({ model: 'openai:gpt-image-2.5-flare', size: '1792x1008', quality: 'low', n: 4 }) > 0);
});

test('Gemini images: tools and candidateCount > 1 refused; Nano Banana only; output capped; settled from usageMetadata', async () => {
  const { L, sub, call } = await tester();
  const usageMetadata = { promptTokenCount: 12, candidatesTokenCount: 1_120, candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 1_120 }], thoughtsTokenCount: 200, totalTokenCount: 1_332 };
  mockFetch([[/:generateContent$/, () => reply(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }] } }], usageMetadata })]]);
  const body = { contents: [{ parts: [{ text: 'a fox' }] }], generationConfig: { responseModalities: ['IMAGE'], imageConfig: { imageSize: '2K', aspectRatio: '16:9' } } };
  let r = await call('x/gemini/v1beta/models/gemini-3-pro-image:generateContent', post({ ...body, tools: [{ googleSearch: {} }] }));
  assert.equal(r.status, 403);
  assert.equal(await codeOf(r), 'tester_model');
  r = await call('x/gemini/v1beta/models/gemini-3-pro-image:generateContent', post({ ...body, generationConfig: { ...body.generationConfig, candidateCount: 2 } }));
  assert.equal(await codeOf(r), 'tester_model');
  r = await call('x/gemini/v1beta/models/gemini-3.8-flash:generateContent', post(body));
  assert.equal(await codeOf(r), 'tester_model', 'a chat model through the image route');
  assert.equal(upstream.calls.length, 0);
  r = await call('x/gemini/v1beta/models/gemini-3-pro-image:generateContent', post({ ...body, cachedContent: 'cachedContents/x', extra_body: { a: 1 }, safetySettings: [] }));
  assert.equal(r.status, 200);
  assert.equal(upstream.calls[0].url, `${GEMINI_BASE}/v1beta/models/gemini-3-pro-image:generateContent`);
  assert.equal(upstream.calls[0].headers.get('x-goog-api-key'), 'AQ.test-gemini-key-0123456789abcdef');
  assert.deepEqual(upstream.calls[0].json, {
    contents: [{ role: 'user', parts: [{ text: 'a fox' }] }],
    generationConfig: { responseModalities: ['IMAGE'], imageConfig: { imageSize: '2K', aspectRatio: '16:9' }, candidateCount: 1, maxOutputTokens: 1_120 + 8_192 },
  });
  assert.deepEqual(spent(L, sub), { spent: imageActual({ model: 'gemini:gemini-3-pro-image', usage: usageMetadata }), reserved: 0, limit: 1_000_000 });
});

test('Gemini images: always IMAGE-only output; a response over its reservation is recorded, not absorbed', async () => {
  const { L, sub, call } = await tester();
  const usageMetadata = { promptTokenCount: 5, candidatesTokenCount: 3_360, candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 3_360 }], thoughtsTokenCount: 1_000, totalTokenCount: 4_365 };
  mockFetch([[/:generateContent$/, () => reply(200, { candidates: [], usageMetadata })]]);
  const r = await call('x/gemini/v1beta/models/gemini-3-pro-image:generateContent', post({ contents: [{ parts: [{ text: 'a story in pictures' }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } }));
  assert.equal(r.status, 200);
  assert.deepEqual(upstream.calls[0].json.generationConfig.responseModalities, ['IMAGE']);
  const reserve = imageCost({ model: 'gemini:gemini-3-pro-image', size: '1K', promptTokens: 7 }), actual = imageActual({ model: 'gemini:gemini-3-pro-image', usage: usageMetadata });
  assert.ok(actual > reserve, 'three images cost more than the one priced');
  assert.deepEqual(spent(L, sub), { spent: actual, reserved: 0, limit: 1_000_000 });
  assert.equal(allowanceOf(r).dayLeft, 1_000_000 - actual);
  // the provider's output cap, all billed at the image rate, still fits inside the Ledger's overrun bound
  for (const model of TESTER_IMAGE_MODELS.filter((m) => m.startsWith('gemini:'))) {
    const e = PRICES[model];
    for (const size of Object.keys(e.imageTokens)) {
      const out = e.imageTokens[size] + e.thinkingTokens;
      const cap = imageActual({ model, usage: { promptTokenCount: 1, candidatesTokenCount: out, candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: out }] } });
      assert.ok(cap <= OVERRUN * imageCost({ model, size, promptTokens: 1 }), `${model} ${size}`);
    }
  }
});

test('Gemini image response without usageMetadata keeps the full reservation', async () => {
  const { L, sub, call } = await tester();
  mockFetch([[/:generateContent$/, () => reply(200, { candidates: [] })]]);
  const r = await call('x/gemini/v1beta/models/gemini-3.1-flash-image:generateContent', post({ contents: [{ parts: [{ text: 'a fox' }] }] }));
  assert.equal(r.status, 200);
  assert.equal(spent(L, sub).spent, imageCost({ model: 'gemini:gemini-3.1-flash-image', size: '1K', promptTokens: 2 }));
});

// ── Veo ──
test('Veo: allow-listed models only, one video ≤ 8 s and ≤ $1.00; polls and downloads only for this tester’s own job', async () => {
  const { L, sub, call, other } = await tester();
  const OP = 'models/veo-3.1-lite-generate-preview/operations/op1';
  let done = false;
  mockFetch([
    [/:predictLongRunning$/, () => reply(200, { name: OP })],
    [/\/operations\/op1$/, () => reply(200, done ? { name: OP, done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: `${GEMINI_BASE}/v1beta/files/vid42:download?alt=media` } }] } } } : { name: OP })],
    [/\/files\/vid42:download\?alt=media$/, () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'video/mp4' } })],
  ]);
  const start = (model, parameters, extra = {}) => call(`x/gemini/v1beta/models/${model}:predictLongRunning`, post({ instances: [{ prompt: 'waves' }], parameters, ...extra }));
  let r = await start('veo-3.1-generate-preview', { durationSeconds: 4, resolution: '720p' });
  assert.equal(await codeOf(r), 'tester_model', 'Veo standard is excluded');
  r = await start('veo-3.1-fast-generate-preview', { durationSeconds: 8, resolution: '1080p' });
  assert.equal(r.status, 402);
  assert.equal((await r.json()).scope, 'call', 'over $1.00');
  r = await start('veo-3.1-lite-generate-preview', { durationSeconds: 10 });
  assert.equal(r.status, 400);
  r = await start('veo-3.1-lite-generate-preview', { durationSeconds: 8, numberOfVideos: 2 });
  assert.equal(await codeOf(r), 'tester_model');
  r = await start('veo-3.1-lite-generate-preview', { durationSeconds: 8 }, { tools: [{}] });
  assert.equal(await codeOf(r), 'tester_model');
  assert.equal(upstream.calls.length, 0);
  r = await start('veo-3.1-lite-generate-preview', { aspectRatio: '9:16', resolution: '720p', durationSeconds: 8, personGeneration: 'allow_all', enhancePrompt: false });
  assert.equal(r.status, 200);
  assert.deepEqual(upstream.calls[0].json, { instances: [{ prompt: 'waves' }], parameters: { aspectRatio: '9:16', resolution: '720p', durationSeconds: 8 } });
  const cost = veoCost({ model: 'gemini:veo-3.1-lite-generate-preview', seconds: 8, resolution: '720p' });
  assert.equal(allowanceOf(r).dayLeft, 1_000_000 - cost);
  // another tester can't poll or download it
  const stranger = await other();
  const rs = await call(`x/gemini/v1beta/${OP}`, {}, { cookie: stranger });
  assert.equal(rs.status, 403);
  assert.equal(await codeOf(rs), 'tester_owner');
  // still running, then done
  r = await call(`x/gemini/v1beta/${OP}`);
  assert.equal((await r.json()).done, undefined);
  assert.equal(spent(L, sub).reserved, cost);
  done = true;
  r = await call(`x/gemini/v1beta/${OP}`);
  assert.equal((await r.json()).done, true);
  assert.deepEqual(spent(L, sub), { spent: veoCost({ model: 'gemini:veo-3.1-lite-generate-preview', seconds: 8, resolution: '720p', margin: false }), reserved: 0, limit: 1_000_000 });
  assert.ok(allowanceOf(r));
  r = await call('x/gemini/v1beta/files/vid42:download?alt=media');
  assert.equal(r.status, 200);
  assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [1, 2, 3]);
  assert.ok(allowanceOf(r));
  r = await call('x/gemini/v1beta/files/vid42:download?alt=media', {}, { cookie: stranger });
  assert.equal(await codeOf(r), 'tester_owner');
  r = await call('x/gemini/v1beta/files/someone-else:download?alt=media');
  assert.equal(await codeOf(r), 'tester_owner');
});

// ── video uploads (A2) ──
const SESSION = (id) => `${GEMINI_BASE}/upload/v1beta/files?upload_id=${id}&upload_protocol=resumable`;
const VIDEO_URI = `${GEMINI_BASE}/v1beta/files/clip1`;
test('video uploads: 200 MB for testers, every session and file tied to the tester who started it', async () => {
  const { L, sub, call, other } = await tester();
  let next = 0;
  mockFetch([
    [/^POST .*\/upload\/v1beta\/files$/, () => reply(200, '', { 'x-goog-upload-url': SESSION(`up${++next}`), 'x-goog-upload-chunk-granularity': '8388608' })],
    [/upload_id=/, (c) => (c.headers.get('x-goog-upload-command') === 'upload, finalize'
      ? reply(200, { file: { name: 'files/clip1', uri: VIDEO_URI, mimeType: 'video/mp4', sizeBytes: '10', state: 'PROCESSING' } }) : reply(200, ''))],
    [/^GET .*\/v1beta\/files\/clip1$/, () => reply(200, { name: 'files/clip1', uri: VIDEO_URI, mimeType: 'video/mp4', state: 'ACTIVE' })],
  ]);
  let r = await call('video/upload/start', post({ name: 'a.mp4', mime: 'video/mp4', size: 201 * 1024 * 1024 }));
  assert.equal(r.status, 413);
  assert.match((await r.json()).error, /over 200 MB — Atelier will send frames instead/);
  r = await call('video/upload/start', post({ name: 'a.mp4', mime: 'video/mp4', size: 10 }));
  assert.equal(r.status, 200);
  assert.ok(allowanceOf(r));
  const { session } = await r.json();
  assert.equal(session, SESSION('up1'));
  const stranger = await other();
  const chunk = (cookie) => call('video/upload/chunk?offset=0&total=10', { method: 'PUT', body: new Uint8Array(10), headers: { 'x-upload-session': session, 'content-length': '10' } }, cookie ? { cookie } : {});
  r = await chunk(stranger);
  assert.equal(r.status, 403);
  assert.equal(await codeOf(r), 'tester_owner');
  r = await call('video/upload/query?total=10', { method: 'POST', headers: { 'x-upload-session': session } }, { cookie: stranger });
  assert.equal(await codeOf(r), 'tester_owner');
  r = await call('video/upload/cancel', { method: 'POST', headers: { 'x-upload-session': session } }, { cookie: stranger });
  assert.equal(await codeOf(r), 'tester_owner');
  r = await chunk();
  assert.equal(r.status, 200);
  assert.equal((await r.json()).file.name, 'files/clip1');
  r = await call('video/file?name=files/clip1');
  assert.equal(r.status, 200);
  r = await call('video/file?name=files/clip1', {}, { cookie: stranger });
  assert.equal(await codeOf(r), 'tester_owner');
  r = await call('video/file?name=files/clip1', { method: 'DELETE' }, { cookie: stranger });
  assert.equal(await codeOf(r), 'tester_owner');
  // the upload_id (a bearer secret) is stored only as a hash
  const ids = L.shim.db.prepare('SELECT upstream_id, kind FROM jobs WHERE sub = ?').all(sub).map((j) => j.upstream_id);
  assert.ok(ids.includes('file:files/clip1'));
  assert.ok(!JSON.stringify(ids).includes('up1'));
});

test('video uploads: the daily clip limit holds against parallel starts; a refused start gives its slot back', async () => {
  const { L, sub, call } = await tester();
  let next = 0;
  mockFetch([[/^POST .*\/upload\/v1beta\/files$/, async () => {
    await new Promise((ok) => setTimeout(ok, 20));
    return reply(200, '', { 'x-goog-upload-url': SESSION(`par${++next}`), 'x-goog-upload-chunk-granularity': '8388608' });
  }]]);
  let r = await call('video/upload/start', post({ name: 'big.mp4', mime: 'video/mp4', size: 201 * 1024 * 1024 }));
  assert.equal(r.status, 413);
  const start = () => call('video/upload/start', post({ name: 'a.mp4', mime: 'video/mp4', size: 199 * 1024 * 1024 }));
  const all = await Promise.all(Array.from({ length: 30 }, start));
  const codes = await Promise.all(all.map(async (x) => (x.status === 200 ? 200 : `${x.status} ${await codeOf(x)}`)));
  assert.equal(codes.filter((c) => c === 200).length, DAILY_UPLOADS, JSON.stringify(codes));
  assert.ok(codes.every((c) => c === 200 || c === '402 tester_budget'));
  assert.equal(upstream.calls.length, DAILY_UPLOADS, 'refused starts never reach Google');
  r = await start();
  assert.equal(r.status, 402);
  assert.equal(L.shim.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE sub = ? AND kind = 'upload'").get(sub).n, DAILY_UPLOADS);
});

test('video chat: every video_file part is priced (a repeated clip too), and a request holds at most LIMITS.videos of them', async () => {
  const { L, sub, call } = await tester();
  L.ledger.addJob(sub, 'file:files/clip1', 'file');
  mockFetch([
    [/^GET .*\/v1beta\/files\/clip1$/, () => reply(200, { name: 'files/clip1', state: 'ACTIVE', videoMetadata: { videoDuration: '30s' } })],
    [/:streamGenerateContent\?alt=sse$/, () => sseOf(['data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}\r\n\r\n'])],
  ]);
  const part = { type: 'video_file', video_file: { file_uri: VIDEO_URI, mime_type: 'video/mp4' } };
  const ask = (copies) => [{ role: 'user', content: [{ type: 'text', text: 'Compare' }, ...Array(copies).fill(part)] }];
  let r = await call('chat', post({ model: 'gemini:gemini-3.8-flash', max_tokens: 1_000, messages: ask(LIMITS.videos + 1) }));
  assert.equal(r.status, 413);
  assert.equal(await codeOf(r), 'tester_too_large');
  assert.equal(upstream.calls.length, 0);
  const messages = ask(3);
  r = await call('chat', post({ model: 'gemini:gemini-3.8-flash', max_tokens: 1_000, messages }));
  assert.equal(r.status, 200);
  assert.equal(allowanceOf(r).dayLeft, 1_000_000 - chatWorstCase({ model: 'gemini:gemini-3.8-flash', inputTokens: textTokens(messages), maxTokens: 1_000, videoSeconds: 3 * 30 }));
  await r.text();
  assert.equal(upstream.calls.filter((c) => c.method === 'GET').length, 1, 'the clip length is read once');
  assert.equal(upstream.calls.at(-1).json.contents[0].parts.filter((x) => x.file_data).length, 3);
});

test('video chat: a stream that breaks after a usage chunk keeps the full reservation', async () => {
  const { L, sub, call } = await tester();
  L.ledger.addJob(sub, 'file:files/clip1', 'file');
  const enc = new TextEncoder();
  mockFetch([
    [/^GET .*\/v1beta\/files\/clip1$/, () => reply(200, { name: 'files/clip1', state: 'ACTIVE', videoMetadata: { videoDuration: '12.4s' } })],
    [/:streamGenerateContent\?alt=sse$/, () => new Response(new ReadableStream({
      start(c) { c.enqueue(enc.encode(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'A dog' }] } }], usageMetadata: { promptTokenCount: 3_500, candidatesTokenCount: 5 } })}\r\n\r\n`)); },
      pull(c) { c.error(new TypeError('connection reset')); },
    }), { headers: { 'content-type': 'text/event-stream' } })],
  ]);
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'What happens?' }, { type: 'video_file', video_file: { file_uri: VIDEO_URI, mime_type: 'video/mp4' } }] }];
  const r = await call('chat', post({ model: 'gemini:gemini-3.8-flash', max_tokens: 8_000, messages }));
  assert.equal(r.status, 200);
  const worst = 1_000_000 - allowanceOf(r).dayLeft;
  assert.match(await r.text(), /Gemini stream failed: connection reset[\s\S]*\[DONE\]/);
  await new Promise((ok) => setTimeout(ok, 0));
  assert.deepEqual(spent(L, sub), { spent: worst, reserved: 0, limit: 1_000_000 });
});

test('video chat: the clip must be the tester’s own; it is priced from its length and settled from usageMetadata', async () => {
  const { L, sub, call, other } = await tester();
  L.ledger.addJob(sub, 'file:files/clip1', 'file');
  const usageMetadata = { promptTokenCount: 4_500, candidatesTokenCount: 300, thoughtsTokenCount: 200, totalTokenCount: 5_000 };
  const gem = (o) => `data: ${JSON.stringify(o)}\r\n\r\n`;
  mockFetch([
    [/^GET .*\/v1beta\/files\/clip1$/, () => reply(200, { name: 'files/clip1', state: 'ACTIVE', videoMetadata: { videoDuration: '12.4s' } })],
    [/:streamGenerateContent\?alt=sse$/, () => sseOf([
      gem({ candidates: [{ content: { parts: [{ text: 'A dog runs.' }] } }], usageMetadata: { promptTokenCount: 4_500 } }),
      gem({ candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'STOP' }], usageMetadata }),
    ])],
  ]);
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'What happens?' }, { type: 'video_file', video_file: { file_uri: VIDEO_URI, mime_type: 'video/mp4' } }] }];
  let r = await call('chat', post({ model: 'gemini:gemini-3.8-flash', max_tokens: 6_000, messages }), { cookie: await other() });
  assert.equal(r.status, 403);
  assert.equal(await codeOf(r), 'tester_owner');
  r = await call('chat', post({ model: 'anthropic:claude-opus-5-5', messages }));
  assert.equal(r.status, 400, 'only Gemini watches a clip');
  assert.equal(upstream.calls.length, 0);
  r = await call('chat', post({ model: 'gemini:gemini-3.8-flash', max_tokens: 6_000, messages }));
  assert.equal(r.status, 200);
  const worst = chatWorstCase({ model: 'gemini:gemini-3.8-flash', inputTokens: textTokens(messages), maxTokens: 6_000, videoSeconds: 13 });
  assert.equal(allowanceOf(r).dayLeft, 1_000_000 - worst);
  assert.match(await r.text(), /A dog runs/);
  assert.equal(upstream.calls[1].json.generationConfig.maxOutputTokens, 6_000);
  assert.deepEqual(spent(L, sub), { spent: chatActual({ model: 'gemini:gemini-3.8-flash', usage: usageMetadata }), reserved: 0, limit: 1_000_000 });
});

test('a clip over 3 minutes is refused; a clip whose length is unknown or still processing is refused, not guessed', async () => {
  const { L, sub, call } = await tester();
  L.ledger.addJob(sub, 'file:files/clip1', 'file');
  let file = { state: 'ACTIVE', videoMetadata: { videoDuration: '181s' } };
  mockFetch([
    [/^GET .*\/v1beta\/files\/clip1$/, () => (file ? reply(200, file) : reply(500, {}))],
    [/:streamGenerateContent/, () => sseOf(['data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}\r\n\r\n'])],
  ]);
  const messages = [{ role: 'user', content: [{ type: 'video_file', video_file: { file_uri: VIDEO_URI, mime_type: 'video/mp4' } }, { type: 'text', text: 'hi' }] }];
  const send = () => call('chat', post({ model: 'gemini:gemini-3.8-flash', max_tokens: 2_000, messages }));
  let r = await send();
  assert.equal(r.status, 413);
  // Unknown length: the file GET fails, Gemini is still processing, the record has no videoMetadata, or the duration is 0 s.
  for (const f of [null, { state: 'PROCESSING' }, { state: 'PROCESSING', videoMetadata: { videoDuration: '30s' } }, { state: 'ACTIVE' }, { state: 'ACTIVE', videoMetadata: { videoDuration: '0s' } }]) {
    file = f;
    r = await send();
    assert.equal(r.status, 409, JSON.stringify(f));
    assert.equal(await codeOf(r), 'tester_video_not_ready');
  }
  assert.equal(upstream.calls.filter((c) => /:streamGenerateContent/.test(c.url)).length, 0, 'never sent to Gemini');
  assert.deepEqual(spent(L, sub), { spent: 0, reserved: 0, limit: 1_000_000 }, 'nothing reserved or charged');
  // Ready with a readable length: priced from that length.
  file = { state: 'ACTIVE', videoMetadata: { videoDuration: '42.2s' } };
  r = await send();
  assert.equal(r.status, 200);
  assert.equal(allowanceOf(r).dayLeft, 1_000_000 - chatWorstCase({ model: 'gemini:gemini-3.8-flash', inputTokens: textTokens(messages), maxTokens: 2_000, videoSeconds: 43 }));
  await r.text();
});

// ── me + profile ──
test('tester/me: identity, the metered model lists (no NVIDIA, no free models), features, allowance and pool', async () => {
  const { sub, call } = await tester();
  const r = await call('tester/me');
  const j = await r.json();
  assert.equal(j.sub, sub);
  assert.deepEqual(Object.keys(j).sort(), ['allowance', 'email', 'features', 'models', 'name', 'picture', 'pool', 'sub']);
  assert.deepEqual(j.models, { chat: [...TESTER_MODELS], image: [...TESTER_IMAGE_MODELS], video: [...TESTER_VIDEO_MODELS] });
  for (const id of [...j.models.chat, ...j.models.image, ...j.models.video]) assert.match(id, /^(anthropic|openai|gemini|zai|deepseek|meta):/);
  assert.deepEqual(j.features, { web: true, video: true, veo: true, helpers: true, profile: true });
  assert.deepEqual(j.allowance, { day: { spent: 0, reserved: 0, limit: 1_000_000 }, month: { spent: 0, reserved: 0, limit: 10_000_000 } });
  assert.deepEqual(j.pool, { paused: false, spotsLeft: 24 });
});

test('tester/me hides models whose provider key is missing', async () => {
  const { env, L } = makeEnv({ META_API_KEY: undefined, ZAI_API_KEY: undefined });
  const t = await signIn(L, PROFILE());
  const j = await (await api(env, 'tester/me', {}, { cookie: t.token })).json();
  assert.ok(!j.models.chat.some((id) => /^(meta|zai):/.test(id)));
  assert.ok(!j.models.image.includes('meta:muse-image-1.0'));
});

test('tester/profile: per tester, sanitized, 300 KB cap, never the owner’s me key', async () => {
  const { env, call, other } = await tester();
  env.ATELIER_KV.m.set('me', JSON.stringify({ bio: 'OWNER' }));
  let j = await (await call('tester/profile')).json();
  assert.deepEqual(j, { name: '', bio: '', samples: '', style: '', learned: '', memory: [], sources: {}, updatedAt: 0 });
  const doc = { name: 'Ada', bio: 'math', style: 's', samples: 'x', learned: 'l', updatedAt: 5, evil: { a: 1 }, memory: [{ id: 'm1', text: 'likes tea', src: 'chat', at: 3, extra: 1 }, { text: '' }, 7] };
  let r = await call('tester/profile', { method: 'PUT', body: JSON.stringify(doc) });
  assert.equal(r.status, 200);
  j = await (await call('tester/profile')).json();
  assert.deepEqual(j, { name: 'Ada', bio: 'math', samples: 'x', style: 's', learned: 'l', memory: [{ id: 'm1', text: 'likes tea', src: 'chat', at: 3 }], sources: {}, updatedAt: 5 });
  const stranger = await other();
  assert.equal((await (await call('tester/profile', {}, { cookie: stranger })).json()).bio, '');
  r = await call('tester/profile', { method: 'PUT', body: JSON.stringify({ bio: 'x'.repeat(310 * 1024) }) });
  assert.equal(r.status, 413);
  assert.equal(await codeOf(r), 'tester_too_large');
  r = await call('tester/profile', { method: 'PUT', body: 'not json' });
  assert.equal(r.status, 400);
  assert.equal(env.ATELIER_KV.m.get('me'), JSON.stringify({ bio: 'OWNER' }));
  assert.equal((await call('me')).status, 403);
});

// ── owner regression: the owner path is unchanged and never metered ──
test('owner calls are never metered and keep their old shapes (web search 5, fallbacks, raw image bodies, Veo standard, 1 GB clips)', async () => {
  const { env, L } = makeEnv();
  mockFetch([
    [ANTHROPIC, () => claudeStream()],
    [/openai\.com\/v1\/images\/generations$/, () => reply(200, { data: [] })],
    [/:predictLongRunning$/, () => reply(200, { name: 'models/veo-3.1-generate-preview/operations/o' })],
    [/^POST .*\/upload\/v1beta\/files$/, () => reply(200, '', { 'x-goog-upload-url': SESSION('own'), 'x-goog-upload-chunk-granularity': '8388608' })],
    [/openai\.com\/v1\/chat\/completions$/, () => sseOf(['data: [DONE]\n\n'])],
  ]);
  const owner = (path, init) => api(env, path, init, { pass: 'pw', origin: null });
  let r = await owner('chat', post({ model: 'anthropic:claude-opus-5-5', web_search: true, reasoning_effort: 'max', max_tokens: 40_000, messages: [{ role: 'user', content: 'news?' }] }));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-tester-allowance'), null);
  await r.text();
  let sent = upstream.calls.at(-1).json;
  assert.deepEqual(sent.tools, [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }]);
  assert.equal(sent.fallbacks, 'default');
  assert.equal(sent.max_tokens, 40_000);
  assert.deepEqual(sent.output_config, { effort: 'max' });
  r = await owner('chat', post({ model: 'anthropic:claude-sonnet-5-5', tools: [{ type: 'function', function: { name: 'gmail_send', description: 'd', parameters: { type: 'object' } } }], messages: [{ role: 'user', content: 'mail' }] }));
  await r.text();
  assert.equal(upstream.calls.at(-1).json.tools[0].name, 'gmail_send', 'owner tools still reach Claude');
  const raw = { model: 'gpt-6-luna', messages: [{ role: 'user', content: 'hi' }], stream: true, max_tokens: 50_000 };
  r = await owner('chat', post({ ...raw, model: 'openai:gpt-6-luna' }));
  await r.text();
  assert.deepEqual(upstream.calls.at(-1).json, { model: 'gpt-6-luna', messages: [{ role: 'user', content: 'hi' }], stream: true, max_completion_tokens: 50_000 }, 'no stream_options added');
  r = await owner('x/openai/images/generations', post({ model: 'gpt-image-9', prompt: 'x', n: 9, quality: 'max' }));
  assert.equal(r.status, 200);
  assert.equal((await new Response(upstream.calls.at(-1).body).json()).n, 9, 'the owner body passes through raw');
  r = await owner('x/gemini/v1beta/models/veo-3.1-generate-preview:predictLongRunning', post({ instances: [{ prompt: 'p' }], parameters: { durationSeconds: 8 } }));
  assert.equal(r.status, 200);
  r = await owner('video/upload/start', post({ name: 'big.mp4', mime: 'video/mp4', size: 900 * 1024 * 1024 }));
  assert.equal(r.status, 200, 'the owner keeps 1 GB clips');
  assert.deepEqual(L.calls, [], 'the Ledger was never called');
});
