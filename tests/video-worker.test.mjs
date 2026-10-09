import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// worker.js wiring for chat videos: /api/video/* behind the passcode, and /api/chat routing of video_file parts.
// worker.js (the Relay Durable Object) and tools.js (waitUntil) import `cloudflare:workers`; stub it before importing.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export class DurableObject {} export const waitUntil = () => {};', shortCircuit: true };
    return next(specifier, context);
  },
});
const worker = (await import('../src/worker.js')).default;
const { GEMINI_BASE, VIDEO_NEEDS_GEMINI, FILE_GONE_ERROR, CHUNK_MAX, GRANULARITY_DEFAULT } = await import('../src/gemini.js');

// ── fakes ──
const KEY = 'AQ.test-gemini-key-0123456789abcdefXYZ';
const UPLOAD_ID = 'ABCupload-id_secret42';
const SESSION = `${GEMINI_BASE}/upload/v1beta/files?upload_id=${UPLOAD_ID}&upload_protocol=resumable`;
const VIDEO_URI = `${GEMINI_BASE}/v1beta/files/abc123`;
const FILE = { name: 'files/abc123', mimeType: 'video/mp4', sizeBytes: '10', uri: VIDEO_URI, state: 'PROCESSING', expirationTime: '2026-10-02T12:00:00.000Z' };
const NATIVE = (id) => `${GEMINI_BASE}/v1beta/models/${id}:streamGenerateContent?alt=sse`;
const OPENAI_COMPAT = `${GEMINI_BASE}/v1beta/openai/chat/completions`;
const MiB = 1024 * 1024;

function fakeKV(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, async get(k, type) { const v = m.get(k); return v == null ? null : type === 'json' ? JSON.parse(v) : v; }, async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); } };
}
const makeEnv = (extra = {}) => ({
  APP_PASSCODE: 'pw', GEMINI_API_KEY: KEY, ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-openai-test', NVIDIA_API_KEY: 'nvapi-test',
  ATELIER_KV: fakeKV(), ...extra,
});
const reply = (status, body, headers = {}) => new Response(body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const sse = (lines) => new Response(new ReadableStream({ start(c) { for (const l of lines) c.enqueue(new TextEncoder().encode(l)); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
const gem = (obj) => `data: ${JSON.stringify(obj)}\r\n\r\n`;
const sseEvents = (text) => text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).map((d) => (d === '[DONE]' ? d : JSON.parse(d)));

// Every call the Worker makes upstream; an unmatched call fails the test.
let calls = [];
const realFetch = globalThis.fetch;
function mockFetch(routes) {
  globalThis.fetch = async (input, init = {}) => {
    const call = { url: String(input), method: init.method || 'GET', headers: new Headers(init.headers), body: init.body };
    calls.push(call);
    for (const [pattern, handler] of routes) if (pattern.test(`${call.method} ${call.url}`)) return handler(call);
    throw new Error(`unmocked fetch ${call.method} ${call.url}`);
  };
}

// The key and the upload session (a bearer capability) must never reach a log or a response body.
let logs = [];
const realWarn = console.warn, realError = console.error;
beforeEach(() => {
  calls = []; logs = [];
  console.warn = (...a) => logs.push(a.map(String).join(' '));
  console.error = (...a) => logs.push(a.map(String).join(' '));
});
afterEach(() => {
  globalThis.fetch = realFetch;
  console.warn = realWarn; console.error = realError;
  for (const l of logs) {
    assert.ok(!l.includes(KEY), `API key leaked to the log: ${l}`);
    assert.ok(!l.includes(UPLOAD_ID), `upload session leaked to the log: ${l}`);
  }
});

// worker.fetch on /api/<path>; pass = null sends no passcode.
const api = (env, path, init = {}, pass = 'pw') =>
  worker.fetch(new Request(`https://atelier.test/api/${path}`, { ...init, headers: { ...(pass ? { 'x-app-pass': pass } : {}), ...(init.headers || {}) } }), env);
const read = async (res) => { const t = await res.text(); assert.ok(!t.includes(KEY), `API key in response: ${t}`); assert.ok(!t.includes(UPLOAD_ID)); return t; };
const secured = (res, type = 'application/json') => {
  assert.equal(res.headers.get('content-type'), type);
  assert.match(res.headers.get('cache-control') || '', /\bno-store\b/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
};
// A body that streams `total` bytes in 1 KiB pieces, counting what was pulled; no content-length is declared.
const counted = (total) => {
  const seen = { pulled: 0 };
  seen.stream = new ReadableStream({ pull(c) { if (seen.pulled >= total) return c.close(); seen.pulled += 1024; c.enqueue(new Uint8Array(1024).fill(7)); } }, { highWaterMark: 0 });
  return seen;
};

// ── /api/video/* ──
const VIDEO_ROUTES = [
  ['POST', 'video/upload/start', JSON.stringify({ name: 'a.mp4', mime: 'video/mp4', size: 10 })],
  ['PUT', 'video/upload/chunk?offset=0&total=10', new Uint8Array(10)],
  ['POST', 'video/upload/query?total=10'],
  ['POST', 'video/upload/cancel'],
  ['GET', 'video/file?name=files/abc123'],
  ['DELETE', 'video/file?name=files/abc123'],
  ['GET', 'video/anything'],
];

test('every /api/video/* route needs the passcode and the Gemini key before anything reaches Google', async () => {
  mockFetch([]);
  const env = makeEnv();
  for (const [method, path, body] of VIDEO_ROUTES) {
    const init = { method, body, headers: { 'x-upload-session': SESSION } };
    let r = await api(env, path, init, null);
    assert.equal(r.status, 401, `${method} ${path} without a passcode`);
    assert.match(JSON.parse(await read(r)).error, /Enter your passcode/);
    secured(r);
    r = await api(env, path, init, 'wrong');
    assert.equal(r.status, 401, `${method} ${path} with a wrong passcode`);
    assert.match(JSON.parse(await read(r)).error, /Wrong passcode/);
    r = await api(makeEnv({ GEMINI_API_KEY: undefined }), path, init);
    assert.equal(r.status, 401, `${method} ${path} without GEMINI_API_KEY`);
    assert.match(JSON.parse(await read(r)).error, /No Gemini key on the server/);
  }
  assert.equal(calls.length, 0, 'nothing reached Google');
  assert.equal(env.ATELIER_KV.m.get('fail:unknown'), String(VIDEO_ROUTES.length), 'wrong passcodes count toward the lockout');
});

test('the passcode lockout covers the video routes', async () => {
  mockFetch([]);
  const env = makeEnv({ ATELIER_KV: fakeKV({ 'fail:unknown': '10' }) });
  const r = await api(env, 'video/upload/start', { method: 'POST', body: VIDEO_ROUTES[0][2] });
  assert.equal(r.status, 429);
  assert.equal(calls.length, 0);
});

test('upload/start through the Worker: resumable start at Google, {session, chunk} back as secured JSON', async () => {
  mockFetch([[/^POST .*\/upload\/v1beta\/files$/, () => reply(200, '', { 'x-goog-upload-url': SESSION, 'x-goog-upload-chunk-granularity': String(GRANULARITY_DEFAULT) })]]);
  const env = makeEnv({ NVIDIA_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined }); // only the Gemini key is needed
  const r = await api(env, 'video/upload/start', { method: 'POST', body: JSON.stringify({ name: 'clip.mp4', mime: 'video/mp4', size: 50 * MiB }) });
  assert.equal(r.status, 200);
  secured(r);
  assert.deepEqual(JSON.parse(await r.text()), { session: SESSION, chunk: 16 * MiB });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.get('x-goog-api-key'), KEY);
  assert.equal(calls[0].headers.get('x-goog-upload-command'), 'start');
  assert.equal(calls[0].headers.get('x-goog-upload-header-content-length'), String(50 * MiB));
  // contract statuses come through the Worker unchanged, before any call to Google
  const code = async (b) => (await api(env, 'video/upload/start', { method: 'POST', body: JSON.stringify(b) })).status;
  assert.equal(await code({ name: 'a.txt', mime: 'text/plain', size: 10 }), 415);
  assert.equal(await code({ name: 'a.mp4', mime: 'video/mp4', size: 2 * 1024 * MiB }), 413);
  assert.equal(await code({ name: 'a.mp4', mime: 'video/mp4', size: 0 }), 400);
  assert.equal(calls.length, 1);
});

test('chunk PUT bodies reach handleVideoApi unread: capped, streamed, forwarded as raw bytes', async () => {
  mockFetch([[/upload_id=/, (c) => (c.headers.get('x-goog-upload-command') === 'upload, finalize' ? reply(200, { file: FILE }) : reply(200, ''))]]);
  const env = makeEnv();
  const put = (qs, body, headers = {}) => api(env, `video/upload/chunk?${qs}`, { method: 'PUT', body, duplex: 'half', headers: { 'x-upload-session': SESSION, ...headers } });
  // a declared length over 32 MiB is refused before a byte is read
  const declared = counted(64 * MiB);
  let r = await put(`offset=0&total=${64 * MiB}`, declared.stream, { 'content-length': String(CHUNK_MAX + 1) });
  assert.equal(r.status, 413);
  assert.equal(declared.pulled, 0);
  // an undeclared body stops being read just past 32 MiB
  const big = counted(CHUNK_MAX + 64 * 1024);
  r = await put(`offset=0&total=${64 * MiB}`, big.stream);
  assert.equal(r.status, 413);
  assert.ok(big.pulled <= CHUNK_MAX + 2048, `read ${big.pulled} bytes`);
  // a bad session never reaches Google
  r = await api(env, 'video/upload/chunk?offset=0&total=10', { method: 'PUT', body: new Uint8Array(10), headers: { 'x-upload-session': 'https://evil.example/upload/v1beta/files?upload_id=x' } });
  assert.equal(r.status, 400);
  assert.equal(calls.length, 0);
  // a streamed 8 MiB middle chunk, then the final 10 bytes
  const mid = counted(GRANULARITY_DEFAULT);
  r = await put(`offset=0&total=${GRANULARITY_DEFAULT + 10}`, mid.stream, { 'content-length': String(GRANULARITY_DEFAULT) });
  assert.equal(r.status, 200);
  secured(r);
  assert.deepEqual(JSON.parse(await read(r)), { received: GRANULARITY_DEFAULT });
  assert.equal(calls[0].url, SESSION);
  assert.equal(calls[0].headers.get('x-goog-upload-command'), 'upload');
  assert.equal(calls[0].headers.get('x-goog-upload-offset'), '0');
  assert.equal(calls[0].body.byteLength, GRANULARITY_DEFAULT);
  r = await put(`offset=${GRANULARITY_DEFAULT}&total=${GRANULARITY_DEFAULT + 10}`, new Uint8Array(10).fill(3), { 'content-length': '10' });
  const j = JSON.parse(await read(r));
  assert.equal(j.done, true);
  assert.equal(j.file.name, 'files/abc123');
  assert.equal(j.file.uri, VIDEO_URI);
  assert.equal(calls[1].headers.get('x-goog-upload-command'), 'upload, finalize');
  assert.equal(calls[1].headers.get('x-goog-upload-offset'), String(GRANULARITY_DEFAULT));
  assert.deepEqual([...calls[1].body], Array(10).fill(3));
});

test('the /api wrapper keeps retry-after and content-type a video route set, and still adds no-store + nosniff', async () => {
  mockFetch([[/upload_id=/, () => reply(429, { error: { message: 'Rate limited' } }, { 'retry-after': '7' })]]);
  const r = await api(makeEnv(), 'video/upload/chunk?offset=0&total=10', { method: 'PUT', body: new Uint8Array(10), headers: { 'x-upload-session': SESSION } });
  assert.equal(r.status, 503);
  assert.equal(r.headers.get('retry-after'), '7');
  secured(r);
  assert.equal(r.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.match(JSON.parse(await read(r)).error, /busy/);
});

test('query, cancel, file status and delete are routed; bad names, methods and paths are refused', async () => {
  mockFetch([
    [/upload_id=/, (c) => c.headers.get('x-goog-upload-command') === 'query'
      ? reply(200, '', { 'x-goog-upload-status': 'active', 'x-goog-upload-size-received': String(GRANULARITY_DEFAULT) }) : reply(200, '')],
    [/^GET .*\/v1beta\/files\/abc123$/, () => reply(200, { ...FILE, state: 'ACTIVE' })],
    [/^GET .*\/v1beta\/files\/old$/, () => reply(404, { error: { message: 'File files/old not found' } })],
    [/^DELETE .*\/v1beta\/files\/abc123$/, () => reply(200, {})],
  ]);
  const env = makeEnv(), h = { 'x-upload-session': SESSION };
  const j = async (r, status = 200) => { assert.equal(r.status, status); secured(r); return JSON.parse(await read(r)); };
  assert.deepEqual(await j(await api(env, `video/upload/query?total=${3 * GRANULARITY_DEFAULT}`, { method: 'POST', headers: h })), { received: GRANULARITY_DEFAULT });
  assert.deepEqual(await j(await api(env, 'video/upload/cancel', { method: 'POST', headers: h })), { ok: true });
  assert.equal(calls.at(-1).headers.get('x-goog-upload-command'), 'cancel');
  const f = await j(await api(env, 'video/file?name=files/abc123'));
  assert.deepEqual({ name: f.name, uri: f.uri, mime: f.mime, state: f.state }, { name: 'files/abc123', uri: VIDEO_URI, mime: 'video/mp4', state: 'ACTIVE' });
  assert.deepEqual(await j(await api(env, 'video/file?name=files/old'), 404), { error: 'gone', state: 'GONE' });
  assert.deepEqual(await j(await api(env, 'video/file?name=files/abc123', { method: 'DELETE' })), { ok: true });
  const before = calls.length;
  assert.equal((await api(env, 'video/file?name=files/../x')).status, 400);
  assert.equal((await api(env, 'video/file')).status, 400);
  assert.equal((await api(env, 'video/upload/start')).status, 404, 'GET on a POST route');
  assert.equal((await api(env, 'video/nope', { method: 'POST' })).status, 404);
  assert.equal(calls.length, before);
});

// ── /api/chat routing ──
const videoTurn = (text = 'What happens in it?') => ({ role: 'user', content: [
  { type: 'text', text: 'The user attached a video ("clip.mp4"), 0:12 long. You can watch it and hear its audio.' },
  { type: 'video_file', video_file: { file_uri: VIDEO_URI, mime_type: 'video/mp4' } },
  { type: 'text', text },
] });
const chat = (env, body, pass) => api(env, 'chat', { method: 'POST', headers: { accept: 'text/event-stream', 'content-type': 'application/json' }, body: JSON.stringify(body) }, pass);
const upstreamRoutes = () => [
  [/:streamGenerateContent\?alt=sse$/, () => sse([
    gem({ candidates: [{ content: { role: 'model', parts: [{ text: 'Looking at the clip.', thought: true }] } }] }),
    gem({ candidates: [{ content: { role: 'model', parts: [{ text: 'A dog runs ' }] } }] }),
    gem({ candidates: [{ content: { role: 'model', parts: [{ text: 'and barks at 0:04.' }] }, finishReason: 'STOP' }] }),
  ])],
  [/\/openai\/chat\/completions$/, () => new Response('data: {"choices":[{"index":0,"delta":{"content":"compat"}}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })],
];

test('a video chat to a gemini: model goes to streamGenerateContent with the body passed through, and streams OpenAI-style SSE', async () => {
  mockFetch(upstreamRoutes());
  const r = await chat(makeEnv(), {
    model: 'gemini:gemini-3.8-flash', stream: true, max_tokens: 6000, temperature: 0.7, top_p: 0.95, reasoning_effort: 'low',
    messages: [{ role: 'system', content: 'You are Atelier.' }, videoTurn()],
  });
  assert.equal(r.status, 200);
  secured(r, 'text/event-stream');
  const events = sseEvents(await read(r));
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.method, 'POST');
  assert.equal(c.url, NATIVE('gemini-3.8-flash'));
  assert.equal(c.headers.get('x-goog-api-key'), KEY);
  assert.equal(c.headers.get('authorization'), null);
  const sent = JSON.parse(c.body);
  assert.deepEqual(sent.systemInstruction, { parts: [{ text: 'You are Atelier.' }] });
  assert.deepEqual(sent.contents[0].parts[1], { file_data: { mime_type: 'video/mp4', file_uri: VIDEO_URI } });
  assert.deepEqual(sent.generationConfig, { maxOutputTokens: 6000, temperature: 0.7, thinkingConfig: { includeThoughts: true, thinkingLevel: 'low' } });
  const d = events.filter((e) => e !== '[DONE]').map((e) => e.choices[0]);
  assert.deepEqual(d.map((x) => x.delta), [{ reasoning_content: 'Looking at the clip.' }, { content: 'A dog runs ' }, { content: 'and barks at 0:04.' }, {}]);
  assert.equal(d.at(-1).finish_reason, 'stop');
  assert.equal(events.at(-1), '[DONE]');
});

test('a text follow-up that replays the video in history also takes the native route', async () => {
  mockFetch(upstreamRoutes());
  const r = await chat(makeEnv(), {
    model: 'gemini:gemini-3.1-pro-preview', stream: true, reasoning_effort: 'high',
    messages: [videoTurn(), { role: 'assistant', content: 'A dog runs.', reasoning_content: 'hmm' }, { role: 'user', content: 'What colour is it?' }],
  });
  assert.equal(r.status, 200);
  await r.text();
  assert.deepEqual(calls.map((c) => c.url), [NATIVE('gemini-3.1-pro-preview')]);
  assert.deepEqual(JSON.parse(calls[0].body).contents.map((t) => t.role), ['user', 'model', 'user']);
});

test('every Gemini chat without a video_file part stays on the OpenAI-compatible endpoint, unchanged', async () => {
  const frame = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
  const bodies = [
    { model: 'gemini:gemini-3.8-flash', stream: true, max_tokens: 4000, temperature: 0.6, top_p: 0.95, reasoning_effort: 'medium', web_search: true, chat_template_kwargs: { enable_thinking: true },
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello', reasoning_content: 'r', anthropic_content: [{ type: 'text', text: 'x' }] }, { role: 'user', content: 'again' }] },
    // frames-only (the video sampled as stills) is an ordinary vision request
    { model: 'gemini:gemini-3.8-flash', stream: true, max_tokens: 6000, reasoning_effort: 'low',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Below are 2 still frames.' }, { type: 'text', text: 'Frame 1 of 2 · 0:01' }, { type: 'image_url', image_url: { url: frame } }, { type: 'text', text: 'Frame 2 of 2 · 0:05' }, { type: 'image_url', image_url: { url: frame } }, { type: 'text', text: 'What happens?' }] }] },
  ];
  for (const body of bodies) {
    calls = [];
    mockFetch(upstreamRoutes());
    const r = await chat(makeEnv(), body);
    assert.equal(r.status, 200);
    secured(r, 'text/event-stream');
    assert.equal(await read(r), 'data: {"choices":[{"index":0,"delta":{"content":"compat"}}]}\n\ndata: [DONE]\n\n');
    assert.equal(calls.length, 1);
    const c = calls[0];
    assert.equal(c.url, OPENAI_COMPAT);
    assert.equal(c.headers.get('authorization'), `Bearer ${KEY}`);
    assert.equal(c.headers.get('x-goog-api-key'), null);
    assert.equal(c.headers.get('accept'), 'text/event-stream');
    // shapeChatBody for gemini: prefix stripped; web_search, chat_template_kwargs, top_p and replay fields removed; the
    // stream asks for its usage (the owner's cache readout reads Gemini's cached tokens there)
    const { web_search, chat_template_kwargs, top_p, ...rest } = body;
    const expected = { ...rest, model: 'gemini-3.8-flash', messages: body.messages.map(({ reasoning_content, anthropic_content, ...m }) => m), stream_options: { include_usage: true } };
    assert.deepEqual(JSON.parse(c.body), expected);
  }
});

test('a video_file part sent to any non-Gemini model is refused with 400 before any upstream call', async () => {
  mockFetch(upstreamRoutes());
  const env = makeEnv();
  for (const model of ['anthropic:claude-opus-5-5', 'openai:gpt-6-astra', 'google/gemma-4-31b-it', 'moonshotai/kimi-k3']) {
    for (const messages of [[videoTurn()], [videoTurn(), { role: 'assistant', content: 'ok' }, { role: 'user', content: 'and then?' }]]) {
      const r = await chat(env, { model, stream: true, messages });
      assert.equal(r.status, 400, model);
      secured(r);
      assert.deepEqual(JSON.parse(await read(r)), { error: VIDEO_NEEDS_GEMINI });
    }
  }
  // the passcode still comes first
  const r = await chat(env, { model: 'gemini:gemini-3.8-flash', stream: true, messages: [videoTurn()] }, null);
  assert.equal(r.status, 401);
  assert.equal(calls.length, 0);
});

test('native-route failures keep their status: expired clip → 409 video_file_gone, bad reference → 400, a 429 passes through', async () => {
  const env = makeEnv(), body = { model: 'gemini:gemini-3.8-flash', stream: true, messages: [videoTurn()] };
  mockFetch([[/:streamGenerateContent/, () => reply(400, { error: { code: 400, message: 'The File abc123 is not in an ACTIVE state and usage is not allowed.', status: 'FAILED_PRECONDITION' } })]]);
  let r = await chat(env, body);
  assert.equal(r.status, 409);
  secured(r);
  assert.deepEqual(JSON.parse(await read(r)), { error: FILE_GONE_ERROR, code: 'video_file_gone' });
  const limited = JSON.stringify({ error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } });
  mockFetch([[/:streamGenerateContent/, () => reply(429, limited)]]);
  r = await chat(env, body);
  assert.equal(r.status, 429);
  secured(r);
  assert.equal(await read(r), limited, 'Google’s JSON reaches the client unchanged, so toApiError can read it');
  calls = [];
  const bad = videoTurn();
  bad.content[1].video_file.file_uri = 'https://evil.example/v1beta/files/abc123';
  r = await chat(env, { ...body, messages: [bad] });
  assert.equal(r.status, 400);
  assert.match(JSON.parse(await read(r)).error, /Bad video reference/);
  assert.equal(calls.length, 0);
});
