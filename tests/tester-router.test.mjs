import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeEnv, mockFetch, restoreFetch, upstream, reply, sseOf, api, signIn, PROFILE, resetTesterCaches, allowanceOf } from './tester-env.mjs';
import { PRICES, chatWorstCase, chatActual, imageCost, imageActual, veoCost, omniActual, maxTokensWithin, ttsWorstCase, ttsReserved, ttsActual, TESTER_MODELS, TESTER_IMAGE_MODELS, TESTER_VIDEO_MODELS, PER_CALL_RESERVE_CAP } from '../src/tester/prices.js';
import { TTS_VOICES, spokenUnits, ttsCeilingUnits, GEMINI_MAX_OUTPUT_TOKENS } from '../src/tts.js';

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
  // owner thread sync (src/sync.js): every route shape, so the sweeps prove testers get owner_only on each
  'sync/index', 'sync/status', 'sync/trash', 'sync/thread/abc', `sync/blob/${'a'.repeat(64)}`, 'sync/trash/restore', 'sync/blobs/missing',
  // Runway is owner only (src/runway.js): every route shape must answer a tester 403 owner_only
  'runway/generate/image_to_video', 'runway/generate/text_to_video', 'runway/generate/video_to_video', 'runway/task/00000000-0000-4000-8000-000000000000',
  'runway/output/00000000-0000-4000-8000-000000000000', 'runway/upload', 'runway/account',
])];
const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
const isPublic = (path) => PUBLIC_PATHS.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p));

test('the sweep really enumerates the owner router (sanity check on the scan)', () => {
  for (const p of ['me', 'diag', 'models', 'relay/ws', 'relay/pair', 'tools', 'tools/run', 'oauth/google/start', 'oauth/canva/callback', 'canva/send-image', 'canva/file', 'testers', 'chat', 'health', 'sync']) assert.ok(exact.includes(p), p);
  for (const p of ['relay/', 'tools', 'oauth/', 'accounts/', 'photos/', 'canva/', 'video/', 'genai/', 'fn/', 'status/', 'li/', 'tester/', 'testers/', 'runway/', 'sync/']) assert.ok(prefixes.includes(p), p);
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

test('thread sync with a wrong passcode answers 401 sync_passcode even with a live tester cookie (the client pauses on it)', async () => {
  const { env, token } = await tester();
  for (const path of ['sync/index', 'sync/status', 'sync/thread/abc', `sync/blob/${'a'.repeat(64)}`]) {
    const r = await api(env, path, { method: 'GET' }, { pass: 'rotated', cookie: token });
    assert.equal(r.status, 401, path);
    assert.equal(await codeOf(r), 'sync_passcode', path);
  }
  const t = await api(env, 'sync/index', { method: 'GET' }, { cookie: token }); // the tester alone: deny by default
  assert.deepEqual([t.status, await codeOf(t)], [403, 'owner_only']);
  const ok = await api(env, 'sync/index', { method: 'GET' }, { pass: 'pw', cookie: token }); // the owner: as always
  assert.notEqual(ok.status, 401);
});

test('relay/ws is dispatched before identity: the extension socket reaches the Relay with no, a live or an ended tester cookie', async () => {
  // The owner may also be signed in as a tester in the browser profile that runs the Atelier extension; its socket
  // carries that cookie. The Relay authenticates the socket by the device token in the subprotocol only.
  const { env, L, token } = await tester();
  const seen = [];
  env.RELAY = { idFromName: (n) => `id:${n}`, get: () => ({ fetch: async (req) => { seen.push({ url: req.url, protocol: req.headers.get('sec-websocket-protocol') }); return new Response('Expected WebSocket', { status: 426 }); } }) };
  const protocol = `atelier, ${'a'.repeat(64)}`;
  for (const who of [{}, { cookie: token }, { cookie: 'x'.repeat(43) }]) {
    L.calls.length = 0;
    const r = await api(env, 'relay/ws?token=abc', { headers: { upgrade: 'websocket', 'sec-websocket-protocol': protocol } }, who);
    assert.equal(r.status, 426, `${JSON.stringify(who)}: the Relay answered, not owner_only or tester_signin`);
    assert.equal(r.headers.get('set-cookie'), null, 'no tester session is looked up or cleared here');
    assert.deepEqual(L.calls, []);
  }
  assert.deepEqual(seen, Array.from({ length: 3 }, () => ({ url: 'https://relay/ws', protocol })), 'no query string is passed on');
  // The rest of /api/relay/* stays owner-only for a tester.
  for (const path of ['relay/pair', 'relay/status', 'relay/probe']) {
    const r = await api(env, path, {}, { cookie: token });
    assert.deepEqual([r.status, await codeOf(r)], [403, 'owner_only'], path);
  }
  assert.equal(seen.length, 3);
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

test('the addendum records the live tester image routes: Meta Muse Image as an owner decision, and the Gemini v1 variants', async () => {
  const addendum = await readFile(new URL('../docs/superpowers/specs/2026-09-30-atelier-tester-access-addendum.md', import.meta.url), 'utf8');
  // The routes as the router has them: if one is closed, drop its record too.
  assert.ok(matchTesterRoute('POST', 'x/meta/images/generations'), 'Meta images is a tester route');
  assert.ok(TESTER_IMAGE_MODELS.includes('meta:muse-image-1.0'));
  assert.deepEqual(PRICES['meta:muse-image-1.0'].sizes, ['1024x1024', '1024x1280', '1536x1024', '1536x864', '864x1536']);
  assert.equal(LIMITS.imageN, 4);
  const a7b = /## A7b\.([\s\S]*?)\n## /.exec(addendum)?.[1] || '';
  assert.match(a7b, /Tester images come from GPT Image, Nano Banana and Meta Muse Image/);
  for (const words of ['owner decision', '`POST /api/x/meta/images/generations`', '`muse-image-1.0`', '`n` 1 to 4', '`1024x1024`, `1024x1280`, `1536x1024`, `1536x864`, `864x1536`', '`b64_json`', '`url`', '$0.01 per image returned'])
    assert.ok(a7b.includes(words), words);
  assert.ok(matchTesterRoute('POST', 'x/gemini/v1/models/gemini-3-pro-image:generateContent') && matchTesterRoute('GET', 'omni/status/v1_abc'));
  // Veo's long-running routes went with the Veo 3.1 shutdown: video is Gemini Omni on omni/* only.
  assert.ok(!matchTesterRoute('POST', 'x/gemini/v1/models/veo-3.1-lite-generate-preview:predictLongRunning'));
  assert.ok(!matchTesterRoute('GET', 'x/gemini/v1beta/models/veo-3.1-lite-generate-preview/operations/op1'));
  assert.ok(!matchTesterRoute('GET', 'x/gemini/v1/files/abc123:download'));
  const a3 = /## A3\.([\s\S]*?)\n## /.exec(addendum)?.[1] || '';
  assert.match(a3, /accept `v1` as well as `v1beta`/);
  assert.match(a3, /Meta Muse Image \(`POST \/api\/x\/meta\/images\/generations`\) is a tester image route/);
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
  assert.deepEqual(upstream.calls[0].json, { model: 'gpt-image-2.5-sunburst', prompt: 'make it blue', n: 1, size: '1024x1024', quality: 'medium', output_format: 'jpeg', images: [{ image_url: png }] }, 'input_fidelity is dropped: gpt-image-2.5-sunburst rejects it');
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
  const r = await call('x/gemini/v1beta/models/gemini-nano-banana-2.1:generateContent', post({ contents: [{ parts: [{ text: 'a fox' }] }] }));
  assert.equal(r.status, 200);
  assert.equal(spent(L, sub).spent, imageCost({ model: 'gemini:gemini-nano-banana-2.1', size: '1K', promptTokens: 2 }));
  // the deprecated Nano Banana 2 id is no longer a tester model
  const old = await call('x/gemini/v1beta/models/gemini-3.1-flash-image:generateContent', post({ contents: [{ parts: [{ text: 'a fox' }] }] }));
  assert.equal(await codeOf(old), 'tester_model');
});

// ── Gemini Omni video ──
const OMNI = 'gemini:gemini-omni-1.1-flash';
const OMNI_B64 = Buffer.from(Uint8Array.from({ length: 3_000 }, (_, i) => i % 251)).toString('base64'); // > 1 KB: cut out before parsing
const omniDone = (id, usage) => ({ id, status: 'completed', model: 'gemini-omni-1.1-flash', object: 'interaction',
  steps: [{ type: 'user_input', content: [{ type: 'text', text: 'waves' }] }, { type: 'thought', content: [{ type: 'thought', text: '…' }] },
    { type: 'model_output', content: [{ type: 'video', mime_type: 'video/mp4', data: OMNI_B64 }] }], usage });
test('Omni: one clip ≤ $1.00 reserved (4/6/8 s, 720p/1080p); status, video and edits only for this tester’s own interactions', async () => {
  const { L, sub, call, other } = await tester();
  let n = 0, done = false;
  const usage = { total_input_tokens: 1_000, total_output_tokens: 4 * 5_792 + 300, output_tokens_by_modality: [{ modality: 'video', tokens: 4 * 5_792 }, { modality: 'text', tokens: 300 }] };
  mockFetch([
    [/^POST https:\/\/generativelanguage\.googleapis\.com\/v1beta\/interactions$/, () => reply(200, { id: `v1_job${++n}`, status: 'in_progress' })],
    [/^GET .*\/v1beta\/interactions\/v1_job1$/, () => reply(200, done ? omniDone('v1_job1', usage) : { id: 'v1_job1', status: 'in_progress' })],
  ]);
  const start = (body) => call('omni/start', post({ prompt: 'waves', ...body }));
  let r = await start({ seconds: 8 });
  assert.equal(r.status, 402);
  assert.equal((await r.json()).scope, 'call', '8 s at 720p reserves $1.0136, over $1.00');
  r = await start({ seconds: 4, resolution: '1080p' });
  assert.equal(r.status, 402, '1080p 4 s reserves $1.0136 too');
  for (const body of [{ seconds: 10 }, { seconds: 3 }, { seconds: 6, resolution: '4k' }, { seconds: 4, aspect: '1:1' }, { prompt: '' }, { seconds: 4, image: 'https://example.com/a.png' }]) {
    r = await start(body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  r = await start({ seconds: 4, previous: 'v1_someone', task: 'edit' });
  assert.equal(await codeOf(r), 'tester_owner', 'an edit names this tester’s own clip');
  assert.equal(upstream.calls.length, 0);
  r = await start({ seconds: 4, aspect: '9:16', image: 'data:image/png;base64,iVBORw0KGgo=', junk: 1, background: false, model: 'veo-3.1-generate-preview' });
  assert.equal(r.status, 200);
  const j0 = await r.json();
  assert.equal(j0.id, 'v1_job1');
  assert.equal(upstream.calls[0].url, `${GEMINI_BASE}/v1beta/interactions`);
  assert.equal(upstream.calls[0].headers.get('x-goog-api-key'), 'AQ.test-gemini-key-0123456789abcdef');
  assert.deepEqual(upstream.calls[0].json, {
    model: 'gemini-omni-1.1-flash',
    input: [{ type: 'image', data: 'iVBORw0KGgo=', mime_type: 'image/png' }, { type: 'text', text: 'waves' }],
    response_format: { type: 'video', aspect_ratio: '9:16', resolution: '720p', duration: '4s' },
    background: true, store: true,
  });
  const cost = veoCost({ model: OMNI, seconds: 4, resolution: '720p' });
  assert.equal(allowanceOf(r).dayLeft, 1_000_000 - cost);
  // another tester can't check, download or cancel it
  const stranger = await other();
  for (const path of ['omni/status/v1_job1', 'omni/video/v1_job1']) assert.equal(await codeOf(await call(path, {}, { cookie: stranger })), 'tester_owner');
  assert.equal(await codeOf(await call('omni/cancel/v1_job1', post({}), { cookie: stranger })), 'tester_owner');
  // still running, then done: settled from the reported usage
  r = await call('omni/status/v1_job1');
  assert.deepEqual(await r.json(), { id: 'v1_job1', status: 'in_progress', done: false, video: false, pollAfterMs: 10_000 });
  assert.equal(spent(L, sub).reserved, cost);
  done = true;
  r = await call('omni/status/v1_job1');
  const j = await r.json();
  assert.deepEqual(j, { id: 'v1_job1', status: 'completed', done: true, video: true }, 'usage stays on the server');
  assert.deepEqual(spent(L, sub), { spent: omniActual({ model: OMNI, usage }), reserved: 0, limit: 1_000_000 });
  assert.ok(allowanceOf(r));
  r = await call('omni/video/v1_job1');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'video/mp4');
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), Buffer.from(OMNI_B64, 'base64'));
  // an edit of the tester's own clip: previous_interaction_id, no duration or aspect ratio
  r = await start({ seconds: 4, previous: 'v1_job1', task: 'edit', prompt: 'make it night' });
  assert.equal(r.status, 200);
  assert.deepEqual(upstream.calls.at(-1).json, { model: 'gemini-omni-1.1-flash', input: 'make it night', response_format: { type: 'video', resolution: '720p' },
    background: true, store: true, previous_interaction_id: 'v1_job1', generation_config: { video_config: { task: 'edit' } } });
});

test('Omni: a filtered or failed clip settles at $0; a Google refusal at start refunds; a vanished interaction keeps the reservation', async () => {
  const { L, sub, call } = await tester();
  let state = 'filtered';
  mockFetch([
    [/^POST .*\/v1beta\/interactions$/, (c) => (c.json.input === 'refuse' ? reply(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'bad prompt' } }) : reply(200, { id: 'v1_f', status: 'queued' }))],
    [/^GET .*\/v1beta\/interactions\/v1_f$/, () => (state === 'gone' ? reply(404, { error: { code: 404 } }) : reply(200, { id: 'v1_f', status: state === 'filtered' ? 'completed' : 'failed', steps: [] }))],
  ]);
  let r = await call('omni/start', post({ prompt: 'refuse', seconds: 4 }));
  assert.equal(r.status, 400);
  assert.equal(await codeOf(r), 'omni_rejected');
  assert.deepEqual(spent(L, sub), { spent: 0, reserved: 0, limit: 1_000_000 });
  r = await call('omni/start', post({ prompt: 'waves', seconds: 4 }));
  assert.equal(r.status, 200);
  r = await call('omni/status/v1_f');
  const j = await r.json();
  assert.equal(j.filtered, true);
  assert.match(j.error, /filtered/);
  assert.deepEqual(spent(L, sub), { spent: 0, reserved: 0, limit: 1_000_000 });
  r = await call('omni/video/v1_f');
  assert.equal(r.status, 404);
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
  // A clip Gemini no longer has, or one it failed to process, is gone (the app re-uploads it or sends frames).
  for (const gone of [reply(404, { error: { code: 404, message: 'File files/clip1 not found.' } }),
    reply(403, { error: { code: 403, message: 'You do not have permission to access the File clip1 or it may not exist.' } }),
    reply(200, { state: 'FAILED', error: { message: 'bad codec' } })]) {
    mockFetch([[/^GET .*\/v1beta\/files\/clip1$/, () => gone.clone()]]);
    r = await send();
    assert.equal(r.status, 409);
    const j = await r.json();
    assert.equal(j.code, 'video_file_gone');
    assert.match(j.error, /isn’t available any more/, 'the app’s re-upload recovery keys on this text');
  }
  assert.deepEqual(spent(L, sub), { spent: 0, reserved: 0, limit: 1_000_000 }, 'still nothing reserved or charged');
  mockFetch([
    [/^GET .*\/v1beta\/files\/clip1$/, () => (file ? reply(200, file) : reply(500, {}))],
    [/:streamGenerateContent/, () => sseOf(['data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}\r\n\r\n'])],
  ]);
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
  assert.deepEqual(j.models, { chat: [...TESTER_MODELS], image: [...TESTER_IMAGE_MODELS], video: [...TESTER_VIDEO_MODELS], tts: ['atelier', 'sulafat'] });
  for (const id of [...j.models.chat, ...j.models.image, ...j.models.video]) assert.match(id, /^(anthropic|openai|gemini|zai|deepseek|meta):/);
  assert.deepEqual(j.features, { web: true, video: true, veo: true, helpers: true, profile: true, sync: false, tts: true, dictation: true });
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

test('tester/me: read-aloud voices (models.tts, features.tts) follow the provider keys', async () => {
  // every voice is Gemini speech now: an OpenAI key alone reads nothing
  for (const [missing, voices] of [[{ OPENAI_API_KEY: undefined }, ['atelier', 'sulafat']], [{ GEMINI_API_KEY: undefined }, []], [{ OPENAI_API_KEY: undefined, GEMINI_API_KEY: undefined }, []]]) {
    const { env, L } = makeEnv(missing);
    const t = await signIn(L, PROFILE());
    const j = await (await api(env, 'tester/me', {}, { cookie: t.token })).json();
    assert.deepEqual(j.models.tts, voices, JSON.stringify(missing));
    assert.equal(j.features.tts, voices.length > 0);
  }
});

// ── read aloud: POST /api/tts ──
// Every voice is Gemini speech: the Atelier voice (and the retired cedar / sage ids) on gemini-3.8-flash-tts, Sulafat on
// gemini-3.8-flash-lite-tts. OpenAI gpt-4o-mini-tts is gone (it retires 2027-01-06).
const { mock } = await import('node:test');
const TTS_UP = /^POST https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-3\.8-flash-tts:generateContent$/;
const TTS_MODEL = 'gemini:gemini-3.8-flash-tts';
const SULAFAT = 'gemini:gemini-3.8-flash-lite-tts';
// A Gemini speech answer: `seconds` of 24 kHz s16le PCM, with usageMetadata unless null.
const spoken = (seconds = 1, usageMetadata = { promptTokenCount: 40, candidatesTokenCount: 32, totalTokenCount: 72 }) => reply(200, {
  candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: Buffer.alloc(Math.round(seconds * 48_000), 7).toString('base64') } }] }, finishReason: 'STOP' }],
  ...(usageMetadata ? { usageMetadata } : {}),
});
// An answer with no audio and no usage: nothing to price it by, so the full reservation stands (and is visible).
const unpriced = () => reply(200, { candidates: [{ finishReason: 'OTHER', content: { parts: [] } }] });
const bytesOf = async (r) => new Uint8Array(await r.arrayBuffer());

test('tts: an empty or invalid body reserves nothing and calls no provider', async () => {
  const { L, sub, call } = await tester();
  mockFetch([]);
  for (const [body, status] of [['', 400], ['{', 400], [{ voice: 'atelier' }, 400], [{ voice: 'device', text: 'hi' }, 400], [{ voice: '__proto__', text: 'hi' }, 400],
    [{ voice: 'atelier', text: '   ' }, 400], [{ voice: 'atelier', text: 'x'.repeat(1_001) }, 413], [{ voice: 'atelier', text: 'x'.repeat(20_000) }, 413]]) {
    L.calls.length = 0;
    const r = await call('tts', post(body));
    assert.equal(r.status, status, JSON.stringify(body).slice(0, 40));
    assert.ok(['bad_request', 'too_large'].includes(await codeOf(r)));
    assert.ok(!L.calls.includes('reserve'), `${JSON.stringify(body).slice(0, 40)} reserved`);
  }
  assert.equal(upstream.calls.length, 0);
  assert.deepEqual(spent(L, sub), { spent: 0, reserved: 0, limit: 1_000_000 });
});

test('tts: a request from another Origin is refused before it is read', async () => {
  const { L, call } = await tester();
  mockFetch([]);
  for (const origin of [null, 'https://evil.example']) {
    L.calls.length = 0;
    const r = await call('tts', post({ voice: 'atelier', text: 'Hello.' }), { origin });
    assert.equal(r.status, 403);
    assert.equal(await codeOf(r), 'tester_origin');
    assert.ok(!L.calls.includes('reserve'));
  }
  assert.equal(upstream.calls.length, 0);
});

test('tts (Atelier): reserves the worst case on Flash TTS, sends Achernar held to the reserved audio, settles from usageMetadata', async () => {
  const { L, sub, call } = await tester();
  const usageMetadata = { promptTokenCount: 260, candidatesTokenCount: 2_100, totalTokenCount: 2_360 };
  mockFetch([[TTS_UP, () => spoken(66, usageMetadata)]]);
  const text = 'A calm paragraph to read aloud. '.repeat(25).trim();
  const r = await call('tts', post({ voice: 'atelier', text, instructions: 'Shout every word.', model: 'tts-1', speed: 3, style: 'loud', voice_id: 'Puck' }));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'audio/wav');
  assert.equal(r.headers.get('x-tts-voice'), 'atelier');
  const o = { model: TTS_MODEL, chars: text.length, units: ttsCeilingUnits(text), maxAudioTokens: GEMINI_MAX_OUTPUT_TOKENS };
  const worst = ttsWorstCase(o), held = ttsReserved(o);
  assert.ok(worst > 0 && worst <= 250_000);
  assert.equal(held.audioTokens, Math.ceil(text.length / 8) * 32);
  assert.equal((await bytesOf(r)).length, 44 + 66 * 48_000);
  const call0 = upstream.calls[0];
  assert.equal(call0.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-tts:generateContent');
  assert.equal(call0.headers.get('x-goog-api-key'), 'AQ.test-gemini-key-0123456789abcdef');
  assert.deepEqual(call0.json, {
    contents: [{ role: 'user', parts: [{ text, speech_metadata: { style: TTS_VOICES.atelier.style } }] }],
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { voice: 'Achernar' } }, maxOutputTokens: held.audioTokens },
  });
  const actual = ttsActual({ model: TTS_MODEL, usage: usageMetadata, seconds: 66, chars: text.length, maxAudioTokens: held.audioTokens });
  assert.ok(actual < worst);
  assert.equal(allowanceOf(r).dayLeft, 1_000_000 - actual, 'the header shows the settled cost');
  assert.deepEqual(spent(L, sub), { spent: actual, reserved: 0, limit: 1_000_000 });
  assert.ok(!upstream.calls.some((c) => /api\.openai\.com/.test(c.url)), 'nothing goes to OpenAI');
});

test('tts (Atelier): Flash TTS prices: $0.50 / $9.00 through 2026-12-31, then $1.00 / $18.00 (reserved at the standing price either way)', async () => {
  const usageMetadata = { promptTokenCount: 36, candidatesTokenCount: 388, totalTokenCount: 424 };
  const text = 'A calm sentence to read aloud. '.repeat(4).trim(); // 123 characters: 16 s x 32 = 512 audio tokens reserved
  const o = { model: TTS_MODEL, chars: text.length, units: ttsCeilingUnits(text), maxAudioTokens: GEMINI_MAX_OUTPUT_TOKENS };
  assert.equal(ttsReserved(o).audioTokens, 512);
  // standing: 512 x $18 + (41 + 200) x $1 = 9,216 + 241 → 9,457 x 1.25
  assert.equal(ttsWorstCase(o), Math.ceil(9_457 * 1.25));
  for (const [now, want] of [['2026-11-15T12:00:00Z', 18 + 388 * 9], ['2026-12-31T23:59:00Z', 18 + 388 * 9], ['2027-01-02T12:00:00Z', 36 + 388 * 18]]) {
    mock.timers.enable({ apis: ['Date'], now: new Date(now) });
    try {
      const { L, sub, call } = await tester();
      mockFetch([[TTS_UP, () => spoken(12.2, usageMetadata)]]);
      const r = await call('tts', post({ voice: 'atelier', text }));
      assert.equal(r.status, 200, now);
      await bytesOf(r);
      assert.equal(upstream.calls[0].json.generationConfig.maxOutputTokens, 512, now);
      assert.deepEqual(spent(L, sub), { spent: want, reserved: 0, limit: 1_000_000 }, now);
      assert.equal(want, ttsActual({ model: TTS_MODEL, usage: usageMetadata, seconds: 12.2, date: now }));
    } finally { mock.timers.reset(); }
  }
});

test('tts: the retired voice ids (cedar, sage) are reserved, sent and settled as the Atelier voice', async () => {
  for (const voice of ['cedar', 'sage']) {
    const { L, sub, call } = await tester();
    const usageMetadata = { promptTokenCount: 30, candidatesTokenCount: 40, totalTokenCount: 70 };
    mockFetch([[TTS_UP, () => spoken(1.5, usageMetadata)]]);
    const r = await call('tts', post({ voice, text: 'Hello there.' }));
    assert.equal(r.status, 200, voice);
    assert.equal(r.headers.get('x-tts-voice'), 'atelier');
    await bytesOf(r);
    assert.equal(upstream.calls[0].json.generationConfig.speechConfig.voiceConfig.voice, 'Achernar');
    assert.equal(upstream.calls[0].json.generationConfig.maxOutputTokens, 64);
    assert.deepEqual(spent(L, sub), { spent: ttsActual({ model: TTS_MODEL, usage: usageMetadata, seconds: 1.5, maxAudioTokens: 64 }), reserved: 0, limit: 1_000_000 }, voice);
  }
});

test('tts: an answer without audio or usage keeps the full reservation; one with usage but no audio settles on it', async () => {
  let t = await tester();
  mockFetch([[TTS_UP, unpriced]]);
  let r = await t.call('tts', post({ voice: 'atelier', text: 'Hello there.' }));
  assert.equal(r.status, 502);
  assert.equal(await codeOf(r), 'tts_unavailable');
  const reserved = ttsWorstCase({ model: TTS_MODEL, chars: 12, maxAudioTokens: GEMINI_MAX_OUTPUT_TOKENS });
  assert.deepEqual(spent(t.L, t.sub), { spent: reserved, reserved: 0, limit: 1_000_000 });
  t = await tester();
  mockFetch([[TTS_UP, () => reply(200, { candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }], usageMetadata: { promptTokenCount: 40 } })]]);
  r = await t.call('tts', post({ voice: 'atelier', text: 'Hello there.' }));
  assert.equal(r.status, 502);
  assert.deepEqual(spent(t.L, t.sub), { spent: ttsActual({ model: TTS_MODEL, usage: { promptTokenCount: 40 }, seconds: 0 }), reserved: 0, limit: 1_000_000 });
  // an answer without usage but with audio settles on its seconds (at the published 25 tokens a second)
  t = await tester();
  mockFetch([[TTS_UP, () => spoken(2, null)]]);
  r = await t.call('tts', post({ voice: 'atelier', text: 'Hello there.' }));
  assert.equal(r.status, 200);
  await bytesOf(r);
  assert.deepEqual(spent(t.L, t.sub), { spent: ttsActual({ model: TTS_MODEL, seconds: 2, chars: 12, maxAudioTokens: 64 }), reserved: 0, limit: 1_000_000 });
});

test('tts: a provider refusal settles at $0 and never passes the provider’s error through', async () => {
  const { L, sub, call } = await tester();
  let status = 400;
  mockFetch([[TTS_UP, () => reply(status, { error: { code: status, message: 'API key not valid: AQ.test-gemini-key', status: 'INVALID_ARGUMENT' } }, { 'retry-after': '3', 'x-goog-request-id': 'req_1' })]]);
  let r = await call('tts', post({ voice: 'atelier', text: 'Hi.' }));
  assert.equal(r.status, 502);
  const text = await r.text();
  assert.equal(JSON.parse(text).code, 'tts_unavailable');
  assert.ok(!/AQ\.|INVALID|test-gemini/.test(text));
  assert.equal(r.headers.get('x-goog-request-id'), null);
  status = 429;
  r = await call('tts', post({ voice: 'atelier', text: 'Hi.' }));
  assert.equal(r.status, 429);
  assert.equal(await codeOf(r), 'tts_busy');
  assert.equal(r.headers.get('retry-after'), '3');
  assert.deepEqual(spent(L, sub), { spent: 0, reserved: 0, limit: 1_000_000 });
});

test('tts: a refused reservation is 402 tester_budget; a missing key is 503 tts_unavailable; neither calls a provider', async () => {
  const { call } = await tester({ config: { day_limit: 1_000 } });
  mockFetch([]);
  const r = await call('tts', post({ voice: 'atelier', text: 'Hello there, this is a longer sentence to read.' }));
  assert.equal(r.status, 402);
  const j = await r.json();
  assert.equal(j.code, 'tester_budget');
  assert.equal(j.scope, 'day');
  assert.ok(allowanceOf(r));
  const { env, L } = makeEnv({ GEMINI_API_KEY: undefined });
  const t = await signIn(L, PROFILE());
  L.calls.length = 0;
  for (const voice of ['atelier', 'cedar', 'sulafat']) {
    const r2 = await api(env, 'tts', post({ voice, text: 'Hi.' }), { cookie: t.token });
    assert.equal(r2.status, 503, voice);
    assert.deepEqual(await r2.json(), { error: 'Gemini isn’t available to testers right now.', code: 'tts_unavailable' });
  }
  assert.ok(!L.calls.includes('reserve'));
  assert.equal(upstream.calls.length, 0);
});

test('tts (Sulafat): settled from the seconds of audio returned; the header shows the settled cost', async () => {
  const { L, sub, call } = await tester();
  const pcm = new Uint8Array(96_000); // 2 s at 24 kHz
  const usageMetadata = { promptTokenCount: 30, candidatesTokenCount: 50, totalTokenCount: 80 };
  mockFetch([[/gemini-3\.8-flash-lite-tts:generateContent$/, () => reply(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: Buffer.from(pcm).toString('base64') } }] } }], usageMetadata })]]);
  const r = await call('tts', post({ voice: 'sulafat', text: 'Two seconds <laugh> of calm.' }));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'audio/wav');
  assert.equal(upstream.calls[0].url, `${GEMINI_BASE}/v1beta/models/gemini-3.8-flash-lite-tts:generateContent`);
  assert.equal(upstream.calls[0].json.contents[0].parts[0].text, 'Two seconds laugh of calm.');
  const actual = ttsActual({ model: 'gemini:gemini-3.8-flash-lite-tts', usage: usageMetadata, seconds: 2 });
  assert.equal(allowanceOf(r).dayLeft, 1_000_000 - actual);
  assert.equal((await bytesOf(r)).length, 96_044);
  assert.deepEqual(spent(L, sub), { spent: actual, reserved: 0, limit: 1_000_000 });
});

test('tts (Sulafat): billed on the reported audio tokens when they pass seconds x 25 (a live read: 388 for 12.2 s); the seconds floor never passes the bound it was sent', async () => {
  const model = 'gemini:gemini-3.8-flash-lite-tts';
  const answer = (seconds, usageMetadata) => reply(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: Buffer.alloc(Math.round(seconds * 48_000)).toString('base64') } }] } }], ...(usageMetadata ? { usageMetadata } : {}) });
  // The owner's live read (2026-10-01): 36 prompt tokens, 388 audio tokens, 12.2 s of audio (≈ 31.8 tokens a second).
  const live = { promptTokenCount: 36, candidatesTokenCount: 388, totalTokenCount: 424 };
  let t = await tester();
  mockFetch([[/gemini-3\.8-flash-lite-tts:generateContent$/, () => answer(12.2, live)]]);
  const text = 'A calm sentence to read aloud. '.repeat(4).trim(); // 123 characters: 16 s x 32 = 512 audio tokens reserved
  let r = await t.call('tts', post({ voice: 'sulafat', text }));
  assert.equal(r.status, 200);
  await bytesOf(r);
  let held = ttsReserved({ model, chars: text.length, units: spokenUnits(text), maxAudioTokens: TTS_VOICES.sulafat.maxOutputTokens });
  assert.equal(held.audioTokens, 512);
  assert.equal(upstream.calls.at(-1).json.generationConfig.maxOutputTokens, 512, 'Gemini is held to the reserved tokens');
  const billed = ttsActual({ model, usage: live, seconds: 12.2 });
  const bySeconds = ttsActual({ model, usage: { promptTokenCount: 36 }, seconds: 12.2 });
  assert.ok(billed > bySeconds * 1.25, `${billed} vs ${bySeconds}: the reported 388 tokens, not 12.2 s x 25 = 305`);
  assert.deepEqual(spent(t.L, t.sub), { spent: billed, reserved: 0, limit: 1_000_000 });
  assert.ok(billed <= ttsWorstCase({ model, chars: text.length, units: spokenUnits(text), maxAudioTokens: TTS_VOICES.sulafat.maxOutputTokens }));

  // An answer without usage whose audio runs longer than its bound at 25 tokens a second (a slower token rate): the
  // seconds floor is held to the maxOutputTokens Gemini was sent, so the reservation stays a true ceiling.
  t = await tester();
  mockFetch([[/gemini-3\.8-flash-lite-tts:generateContent$/, () => answer(4, null)]]);
  r = await t.call('tts', post({ voice: 'sulafat', text: 'Hello there.' })); // 2 s x 32 reserved: 64 audio tokens
  assert.equal(r.status, 200);
  await bytesOf(r);
  held = ttsReserved({ model, chars: 12, units: spokenUnits('Hello there.'), maxAudioTokens: TTS_VOICES.sulafat.maxOutputTokens });
  assert.equal(held.audioTokens, 64);
  assert.equal(upstream.calls.at(-1).json.generationConfig.maxOutputTokens, 64);
  const capped = ttsActual({ model, seconds: 4, chars: 12, maxAudioTokens: 64 });
  assert.ok(capped < ttsActual({ model, seconds: 4, chars: 12 }), '4 s x 25 = 100 tokens would pass the 64 Gemini was allowed');
  assert.deepEqual(spent(t.L, t.sub), { spent: capped, reserved: 0, limit: 1_000_000 });
  assert.ok(capped <= ttsWorstCase({ model, chars: 12, units: spokenUnits('Hello there.'), maxAudioTokens: TTS_VOICES.sulafat.maxOutputTokens }));
});

test('tts: a Sulafat answer longer than one request allows is settled at its real length, not dropped at the reservation', async () => {
  const { L, sub, call } = await tester();
  const usageMetadata = { promptTokenCount: 320, candidatesTokenCount: 4_427, totalTokenCount: 4_747 };
  const body = JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: Buffer.alloc(8_500_000).toString('base64') } }] } }], usageMetadata });
  mockFetch([[/gemini-3\.8-flash-lite-tts:generateContent$/, () => new Response(body, { headers: { 'content-type': 'application/json' } })]]);
  const text = 'A calm paragraph to read aloud. '.repeat(28).trim(); // 895 units: 112 s x 32 = 3,584 audio tokens reserved
  const r = await call('tts', post({ voice: 'sulafat', text }));
  assert.equal(r.status, 502);
  assert.equal(await codeOf(r), 'tts_unavailable');
  const model = 'gemini:gemini-3.8-flash-lite-tts';
  const reserved = ttsWorstCase({ model, chars: text.length, units: spokenUnits(text), maxAudioTokens: TTS_VOICES.sulafat.maxOutputTokens });
  // Settled on what Google reported (4,427 audio tokens, past the 3,584 it was sent: the reported count is never
  // capped); the seconds floor (177 s x 25) is held to that bound.
  const { audioTokens } = ttsReserved({ model, chars: text.length, units: spokenUnits(text), maxAudioTokens: TTS_VOICES.sulafat.maxOutputTokens });
  assert.equal(audioTokens, 3_584);
  const actual = ttsActual({ model, usage: usageMetadata, seconds: 8_500_000 / 48_000, chars: text.length, maxAudioTokens: audioTokens });
  assert.equal(actual, ttsActual({ model, usage: usageMetadata, chars: text.length }));
  assert.notEqual(actual, reserved);
  assert.deepEqual(spent(L, sub), { spent: Math.min(actual, 4 * reserved), reserved: 0, limit: 1_000_000 });
});

test('tts: the reservation is priced on spoken units (numbers weigh more), and held to Gemini’s output bound', async () => {
  const { L, sub, call } = await tester();
  mockFetch([[TTS_UP, unpriced]]); // nothing to price it by: the full reservation stands, so it is visible
  const text = '987654321987654 '.repeat(15).trim(); // 239 characters, 15 numbers of 15 digits
  let r = await call('tts', post({ voice: 'atelier', text }));
  await r.arrayBuffer();
  const units = spokenUnits(text);
  assert.equal(units, 239 + 225 * 3);
  const worst = ttsWorstCase({ model: TTS_MODEL, chars: text.length, units: ttsCeilingUnits(text), maxAudioTokens: GEMINI_MAX_OUTPUT_TOKENS });
  assert.ok(worst > 3 * ttsWorstCase({ model: TTS_MODEL, chars: text.length }));
  assert.deepEqual(spent(L, sub), { spent: worst, reserved: 0, limit: 1_000_000 });
  assert.equal(upstream.calls[0].json.generationConfig.maxOutputTokens, ttsReserved({ model: TTS_MODEL, chars: text.length, units: ttsCeilingUnits(text), maxAudioTokens: GEMINI_MAX_OUTPUT_TOKENS }).audioTokens);
  // 1,000 characters of digits is 4,000 units: over a tester's cap, refused before anything is reserved.
  L.calls.length = 0;
  r = await call('tts', post({ voice: 'atelier', text: '7'.repeat(1_000) }));
  assert.equal(r.status, 413);
  assert.ok(!L.calls.includes('reserve'));
  // Sulafat: the reservation is the smaller of the spoken-length estimate and the maxOutputTokens bound, and Gemini is
  // asked for no more audio than it reserved (750 units → 94 s x 32 → 3,008 tokens), so it can't bill past the reservation.
  const pcm = new Uint8Array(48_000);
  mockFetch([[/gemini-3\.8-flash-lite-tts:generateContent$/, () => reply(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;rate=24000', data: Buffer.from(pcm).toString('base64') } }] } }] })]]);
  const g = await tester({ config: { day_limit: 1_000_000 } });
  const zh = '这是一个测试句子。'.repeat(30); // 270 characters, 750 units
  r = await g.call('tts', post({ voice: 'sulafat', text: zh }));
  assert.equal(r.status, 200);
  const held = ttsReserved({ model: SULAFAT, chars: zh.length, units: spokenUnits(zh), maxAudioTokens: TTS_VOICES.sulafat.maxOutputTokens });
  assert.equal(held.audioTokens, 3_008);
  assert.equal(upstream.calls[0].json.generationConfig.maxOutputTokens, held.audioTokens);
  assert.ok(held.audioTokens < TTS_VOICES.sulafat.maxOutputTokens);
  const gWorst = ttsWorstCase({ model: SULAFAT, chars: zh.length, units: spokenUnits(zh), maxAudioTokens: TTS_VOICES.sulafat.maxOutputTokens });
  assert.ok(gWorst > ttsWorstCase({ model: SULAFAT, chars: zh.length }));
  assert.ok(g.L.calls.includes('reserve'));
  // The owner keeps the voice's own bound, for both voices.
  const { env } = makeEnv();
  await (await api(env, 'tts', post({ voice: 'sulafat', text: zh }), { pass: 'pw' })).arrayBuffer();
  assert.equal(upstream.calls.at(-1).json.generationConfig.maxOutputTokens, TTS_VOICES.sulafat.maxOutputTokens);
  mockFetch([[TTS_UP, () => spoken(1)]]);
  await (await api(env, 'tts', post({ voice: 'atelier', text: zh }), { pass: 'pw' })).arrayBuffer();
  assert.equal(upstream.calls.at(-1).json.generationConfig.maxOutputTokens, GEMINI_MAX_OUTPUT_TOKENS);
});

test('tts: symbols and emoji are reserved for their spoken names, held to the output bound; past the allowance nothing is sent', async () => {
  const { L, sub, call } = await tester();
  mockFetch([[TTS_UP, unpriced]]); // nothing to price it by: the full reservation stands, so it is visible
  const text = 'a ≤ b → c 🦒 '.repeat(20).trim();
  const r = await call('tts', post({ voice: 'atelier', text }));
  await r.arrayBuffer();
  const units = ttsCeilingUnits(text);
  assert.ok(units > 4 * spokenUnits(text), `${units} vs ${spokenUnits(text)}`);
  assert.deepEqual(spent(L, sub), { spent: ttsWorstCase({ model: TTS_MODEL, chars: text.length, units, maxAudioTokens: GEMINI_MAX_OUTPUT_TOKENS }), reserved: 0, limit: 1_000_000 });
  // 1,000 "≤" pass the 1,000-unit cap but take about half an hour to say. The output bound (4,369 audio tokens) caps the
  // Atelier voice's reservation at about $0.10, so it is reserved at that bound rather than refused.
  const bounded = ttsWorstCase({ model: TTS_MODEL, chars: 1_000, units: ttsCeilingUnits('≤'.repeat(1_000)), maxAudioTokens: GEMINI_MAX_OUTPUT_TOKENS });
  assert.ok(bounded <= PER_CALL_RESERVE_CAP, String(bounded));
  assert.equal(ttsReserved({ model: TTS_MODEL, chars: 1_000, units: ttsCeilingUnits('≤'.repeat(1_000)), maxAudioTokens: GEMINI_MAX_OUTPUT_TOKENS }).audioTokens, GEMINI_MAX_OUTPUT_TOKENS);
  // Past the per-call cap (a tester with no bound to hold it): refused with no reservation and no provider call.
  assert.ok(ttsWorstCase({ model: TTS_MODEL, chars: 1_000, units: ttsCeilingUnits('≤'.repeat(1_000)) }) > PER_CALL_RESERVE_CAP);
  const low = await tester({ config: { day_limit: 50_000 } });
  low.L.calls.length = 0;
  const before = upstream.calls.length;
  const r2 = await low.call('tts', post({ voice: 'atelier', text: '≤'.repeat(1_000) }));
  assert.equal(r2.status, 402);
  const j = await r2.json();
  assert.deepEqual([j.code, j.scope], ['tester_budget', 'day']);
  assert.equal(upstream.calls.length, before);
});

test('tts: a per-tester rate limit (LI_LIMIT, keyed by sub) answers 429 tts_busy before anything is reserved', async () => {
  const { env, L, sub, call } = await tester();
  const keys = [];
  env.LI_LIMIT = { async limit({ key }) { keys.push(key); return { success: keys.length <= 2 }; } };
  mockFetch([[TTS_UP, () => spoken(1)]]);
  for (let i = 0; i < 2; i++) assert.equal((await call('tts', post({ voice: 'atelier', text: 'Hello there.' }))).status, 200);
  L.calls.length = 0;
  const r = await call('tts', post({ voice: 'atelier', text: 'Hello there.' }));
  assert.equal(r.status, 429);
  assert.equal(await codeOf(r), 'tts_busy');
  assert.equal(r.headers.get('retry-after'), '30');
  assert.ok(!L.calls.includes('reserve'));
  assert.equal(upstream.calls.length, 2);
  assert.deepEqual(keys, [`tts:${sub}`, `tts:${sub}`, `tts:${sub}`]);
  // A limiter that fails never blocks read aloud.
  env.LI_LIMIT = { async limit() { throw new Error('down'); } };
  assert.equal((await call('tts', post({ voice: 'atelier', text: 'Hello there.' }))).status, 200);
});

test('tts preview: a cached clip costs nothing; a miss is reserved and settled like a segment', async () => {
  const store = new Map();
  globalThis.caches = { default: {
    match: async (k) => (store.has(String(k)) ? new Response(store.get(String(k)), { headers: { 'content-type': 'audio/wav' } }) : undefined),
    put: async (k, res) => { store.set(String(k), new Uint8Array(await res.arrayBuffer())); },
  } };
  try {
    const { L, sub, call } = await tester();
    const usageMetadata = { promptTokenCount: 60, candidatesTokenCount: 200, totalTokenCount: 260 };
    mockFetch([[TTS_UP, () => spoken(6, usageMetadata)]]);
    let r = await call('tts', post({ voice: 'atelier', preview: true }));
    assert.equal(r.status, 200);
    const clip = await bytesOf(r);
    assert.equal(clip.length, 44 + 6 * 48_000);
    const actual = ttsActual({ model: TTS_MODEL, usage: usageMetadata, seconds: 6 });
    assert.deepEqual(spent(L, sub), { spent: actual, reserved: 0, limit: 1_000_000 });
    assert.equal(allowanceOf(r).dayLeft, 1_000_000 - actual);
    L.calls.length = 0;
    // the same clip, again and under a retired id: from the cache, nothing reserved
    for (const voice of ['atelier', 'cedar']) {
      r = await call('tts', post({ voice, preview: true }));
      assert.deepEqual(await bytesOf(r), clip, voice);
    }
    assert.equal(upstream.calls.length, 1, 'served from the cache');
    assert.ok(!L.calls.includes('reserve'));
    assert.equal(spent(L, sub).spent, actual);
  } finally { delete globalThis.caches; }
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
test('owner calls are never metered and keep their old shapes (web search 5, fallbacks, raw image bodies, Omni up to 4K, 1 GB clips)', async () => {
  const { env, L } = makeEnv();
  mockFetch([
    [ANTHROPIC, () => claudeStream()],
    [/openai\.com\/v1\/images\/generations$/, () => reply(200, { data: [] })],
    [/^POST .*\/v1beta\/interactions$/, () => reply(200, { id: 'v1_owner', status: 'queued' })],
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
  // the owner's Omni: any length 3–10 s and up to 4K, unmetered; Veo's old proxy routes are gone
  r = await owner('omni/start', post({ prompt: 'p', seconds: 10, resolution: '4k', aspect: '16:9' }));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { id: 'v1_owner', status: 'queued', seconds: 10, pollAfterMs: 10_000 });
  assert.deepEqual(upstream.calls.at(-1).json.response_format, { type: 'video', aspect_ratio: '16:9', resolution: '4k', duration: '10s' });
  r = await owner('x/gemini/v1beta/models/veo-3.1-generate-preview:predictLongRunning', post({ instances: [{ prompt: 'p' }], parameters: { durationSeconds: 8 } }));
  assert.equal(r.status, 404);
  r = await owner('video/upload/start', post({ name: 'big.mp4', mime: 'video/mp4', size: 900 * 1024 * 1024 }));
  assert.equal(r.status, 200, 'the owner keeps 1 GB clips');
  assert.deepEqual(L.calls, [], 'the Ledger was never called');
});
