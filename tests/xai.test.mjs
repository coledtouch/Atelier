import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeEnv, mockFetch, restoreFetch, upstream, reply, sseOf, api, KEYS } from './tester-env.mjs';

// xAI (Grok), owner only: /api/chat with xai: models (worker.js shapeChatBody), /api/xai/* (src/xai.js: Grok Imagine
// image and video), the diag, the client (public/xai.js) and the catalogue in app.js. Every upstream call is mocked —
// nothing here reaches xAI.
const X = await import('../src/xai.js');
const C = await import('../public/xai.js');
const { TESTER_MODELS, TESTER_IMAGE_MODELS, TESTER_VIDEO_MODELS } = await import('../src/tester/prices.js');
const APP = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const KEY = KEYS.XAI_API_KEY;
const PNG = `data:image/png;base64,${'iVBORw0KGgo'.padEnd(64, 'A')}`;
const CHAT = /^POST https:\/\/api\.x\.ai\/v1\/chat\/completions$/;

afterEach(() => restoreFetch());
const owner = (path, init = {}, env = makeEnv({ ledger: null }).env) => api(env, path, init, { pass: 'pw' });
const post = (body) => ({ method: 'POST', body, headers: { 'content-type': 'application/json' } });
const text = async (r) => { const t = await r.text(); assert.ok(!t.includes(KEY), `the key leaked: ${t}`); return t; };
const sent = () => upstream.calls.at(-1).json;
const chatOk = () => [CHAT, () => sseOf(['data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n', 'data: [DONE]\n\n'])];

// ── chat ──

test('chat: xai: models go to api.x.ai’s Chat Completions with the bearer key, the prefix stripped', async () => {
  mockFetch([chatOk()]);
  const r = await owner('chat', post({ model: 'xai:grok-4.7', stream: true, messages: [{ role: 'user', content: 'hi' }] }));
  assert.equal(r.status, 200);
  assert.match(await text(r), /"content":"hi"/);
  const c = upstream.calls[0];
  assert.equal(c.url, 'https://api.x.ai/v1/chat/completions');
  assert.equal(c.headers.get('authorization'), `Bearer ${KEY}`);
  assert.equal(c.json.model, 'grok-4.7');
});

test('chat: the shared body is shaped for Grok — effort per model, max_completion_tokens, no penalties/stop, no search, function tools only', async () => {
  mockFetch([chatOk()]);
  const tools = [{ type: 'function', function: { name: 'gmail_search', description: 'Search mail', parameters: { type: 'object', properties: {} } } }, { type: 'web_search' }, { type: 'x_search' }];
  const body = {
    model: 'xai:grok-4.7', stream: true, temperature: 0.6, top_p: 0.95, max_tokens: 4096, reasoning_effort: 'medium', web_search: true,
    presence_penalty: 0.5, frequency_penalty: 0.5, stop: ['\n\n'], search_parameters: { mode: 'on' }, web_search_options: { search_context_size: 'high' },
    chat_template_kwargs: { enable_thinking: true }, tools, tool_choice: 'auto',
    messages: [{ role: 'system', content: 's' }, { role: 'assistant', content: 'a', reasoning_content: 'r', anthropic_content: [{ type: 'text', text: 'x' }] }, { role: 'user', content: 'q' }],
  };
  await owner('chat', post(body));
  assert.deepEqual(sent(), {
    model: 'grok-4.7', stream: true, temperature: 0.6, max_completion_tokens: 4096, reasoning_effort: 'medium',
    tools: [tools[0]], tool_choice: 'auto',
    messages: [{ role: 'system', content: 's' }, { role: 'assistant', content: 'a' }, { role: 'user', content: 'q' }],
  });
  // reasoning effort per model: Grok 4.7 low…xhigh (max → xhigh), a helper call (thinking off) → low; Grok 4.3 takes
  // none for a helper call and defaults to low; Grok Build gets no effort field (its page lists no levels)
  const effort = async (model, extra) => { await owner('chat', post({ model, messages: [{ role: 'user', content: 'x' }], ...extra })); return sent().reasoning_effort; };
  assert.equal(await effort('xai:grok-4.7', { reasoning_effort: 'max' }), 'xhigh');
  assert.equal(await effort('xai:grok-4.7', {}), 'high');
  assert.equal(await effort('xai:grok-4.7', { chat_template_kwargs: { enable_thinking: false } }), 'low');
  assert.equal(await effort('xai:grok-4.3', { chat_template_kwargs: { enable_thinking: false, thinking: false } }), 'none');
  assert.equal(await effort('xai:grok-4.3', {}), 'low');
  assert.equal(await effort('xai:grok-4.3', { reasoning_effort: 'high' }), 'high');
  assert.equal(await effort('xai:grok-build-0.1', { reasoning_effort: 'high' }), undefined);
  // a body with only non-function tools sends no tools (and no tool_choice) at all
  await owner('chat', post({ model: 'xai:grok-4.7', messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'web_search' }], tool_choice: 'auto' }));
  assert.ok(!('tools' in sent()) && !('tool_choice' in sent()));
});

test('chat: the passcode gate comes first, and a missing XAI_API_KEY says which secret to set', async () => {
  mockFetch([]);
  let r = await api(makeEnv({ ledger: null }).env, 'chat', post({ model: 'xai:grok-4.7', messages: [{ role: 'user', content: 'x' }] }));
  assert.equal(r.status, 401);
  const { env } = makeEnv({ ledger: null });
  delete env.XAI_API_KEY;
  r = await owner('chat', post({ model: 'xai:grok-4.7', messages: [{ role: 'user', content: 'x' }] }), env);
  assert.equal(r.status, 401);
  assert.deepEqual(JSON.parse(await r.text()), { error: 'No xAI key on the server (set XAI_API_KEY).' });
  r = await owner('xai/image', post({ model: 'grok-imagine-image-2.0', prompt: 'x' }), env);
  assert.equal(r.status, 401);
  assert.equal(upstream.calls.length, 0);
});

test('health and diag: server.xai follows XAI_API_KEY; Check provider keys reads the free /v1/api-key', async () => {
  mockFetch([]);
  const health = async (env) => JSON.parse(await (await api(env, 'health')).text()).server;
  assert.equal((await health(makeEnv({ ledger: null }).env)).xai, true);
  const { env: none } = makeEnv({ ledger: null }); delete none.XAI_API_KEY;
  assert.equal((await health(none)).xai, false);
  // only the xAI key, so the diag calls nothing else
  const only = { APP_PASSCODE: 'pw', XAI_API_KEY: KEY, ATELIER_KV: makeEnv({ ledger: null }).env.ATELIER_KV };
  const info = { redacted_api_key: 'xai-...b14o', team_id: 't', api_key_id: 'k', acls: [], team_blocked: false, api_key_blocked: false, api_key_disabled: false };
  mockFetch([[/^GET https:\/\/api\.x\.ai\/v1\/api-key$/, (c) => { assert.equal(c.headers.get('authorization'), `Bearer ${KEY}`); return reply(200, info); }]]);
  let d = JSON.parse(await text(await owner('diag', {}, only)));
  assert.deepEqual(d, { xai: { ok: true, status: 200, message: 'key active' } });
  mockFetch([[/api-key$/, () => reply(200, { ...info, team_blocked: true })]]);
  d = JSON.parse(await text(await owner('diag', {}, only)));
  assert.equal(d.xai.ok, false);
  assert.match(d.xai.message, /team is blocked/);
  mockFetch([[/api-key$/, () => reply(400, { code: 'Client specified an invalid argument', error: `Incorrect API key provided: ${KEY}. You can obtain an API key from https://console.x.ai.` })]]);
  d = JSON.parse(await text(await owner('diag', {}, only)));
  assert.equal(d.xai.ok, false);
  assert.ok(!JSON.stringify(d).includes('console.x.ai.'), 'links are scrubbed');
});

// ── failures: what xAI says when the money runs out, and how the app reads it ──

test('xAI error messages: out of credit / spending limit → 402 xai_credits on /api/xai; app.js treats them as an account problem (fallback)', async () => {
  const NO_CREDITS = 'Your newly created team doesn\'t have any credits yet. You can purchase credits on https://console.x.ai/team/abc.';
  const LIMIT = 'Your team abc has either used all available credits or reached its monthly spending limit. To continue making API requests, please purchase more credits or raise your spending limit.';
  for (const [status, msg] of [[403, NO_CREDITS], [429, LIMIT]]) {
    mockFetch([[/images\/generations$/, () => reply(status, { code: 'The caller does not have permission to execute the specified operation', error: msg })]]);
    const r = await owner('xai/image', post({ model: 'grok-imagine-image-2.0', prompt: 'a fox' }));
    const j = JSON.parse(await text(r));
    assert.deepEqual([r.status, j.code], [402, 'xai_credits'], msg);
    assert.match(j.error, /out of credits or over its spending limit/);
    assert.ok(!/https?:\/\//.test(j.error), 'no links');
  }
  mockFetch([[/images\/generations$/, () => reply(429, { error: 'Too many requests' })]]);
  assert.deepEqual(JSON.parse(await (await owner('xai/image', post({ model: 'grok-imagine-image-2.0', prompt: 'a fox' }))).text()).code, 'xai_limit');
  mockFetch([[/images\/generations$/, () => reply(401, { error: 'Incorrect API key' })]]);
  assert.deepEqual(JSON.parse(await (await owner('xai/image', post({ model: 'grok-imagine-image-2.0', prompt: 'a fox' }))).text()).code, 'xai_key');
  // app.js's accountProblem + errorKind, lifted from its source (as tests/runway-client.test.mjs does): the chat route
  // passes xAI's own error body through, so these are the messages streamChat sees.
  const a = APP.match(/\nconst accountProblem = [\s\S]*?\);\n/), k = APP.match(/\nfunction errorKind\([\s\S]*?\n}\n/);
  assert.ok(a && k, 'accountProblem and errorKind are still where this test looks');
  const { accountProblem, errorKind } = new Function('isTesterCode', `${a[0]}\n${k[0]}\nreturn { accountProblem, errorKind };`)(() => false);
  assert.equal(accountProblem({ status: 403, message: NO_CREDITS }), true);
  assert.equal(accountProblem({ status: 429, message: LIMIT }), true, 'a spending-limit 429 is not a rate limit: move to the next provider');
  assert.equal(accountProblem({ status: 500, message: 'Your team has reached its monthly spending limit' }), true);
  assert.equal(accountProblem({ status: 500, message: 'Your team does not have any credits' }), true);
  assert.equal(accountProblem({ status: 429, message: 'Too many requests, slow down' }), false);
  assert.equal(errorKind(LIMIT, 429), 'key');
  // the fallback chain marks the provider dead by providerOf: xai: ids must map to 'xai' (named xAI in its toast)
  assert.match(APP, /const providerOf = \(id = ''\) => \(id\.match\(\/\^\(anthropic\|openai\|gemini\|zai\|deepseek\|meta\|runway\|xai\):\//);
  assert.match(APP, /PROVIDER_NAMES = \{[^}]*xai: 'xAI'/);
});

// ── images ──

test('image: one Grok Imagine image at medium quality, 1k, base64 back — exactly these fields go to xAI', async () => {
  mockFetch([[/^POST https:\/\/api\.x\.ai\/v1\/images\/generations$/, () => reply(200, { data: [{ b64_json: 'QUJD', mime_type: 'image/jpeg' }], usage: { cost_in_usd_ticks: 400_000_000 } })]]);
  const r = await owner('xai/image', post({ model: 'grok-imagine-image-2.0', prompt: ' a fox ', aspect: '16:9', n: 10, output: { upload_urls: ['https://evil.example/put'] }, storage_options: { filename: 'x' }, quality: 'high' }));
  const j = JSON.parse(await text(r));
  assert.equal(r.status, 200);
  assert.deepEqual(sent(), { model: 'grok-imagine-image-2.0', prompt: 'a fox', n: 1, aspect_ratio: '16:9', resolution: '1k', quality: 'medium', response_format: 'b64_json' });
  assert.equal(upstream.calls[0].headers.get('authorization'), `Bearer ${KEY}`);
  assert.deepEqual(j, { data: [{ b64_json: 'QUJD', mime_type: 'image/jpeg' }], usd: 0.04 });
  for (const [body, re] of [[{ model: 'grok-imagine-image', prompt: 'x' }, /doesn’t offer/], [{ model: 'grok-imagine-image-2.0', prompt: '' }, /Describe/], [{ model: 'grok-imagine-image-2.0', prompt: 'x', aspect: '4:5' }, /aspect must be/]]) {
    upstream.calls = [];
    const bad = await owner('xai/image', post(body));
    assert.equal(bad.status, 400);
    assert.match(JSON.parse(await bad.text()).error, re);
    assert.equal(upstream.calls.length, 0);
  }
  // a filtered answer (no image) is a 400 the app shows as "Try rephrasing"
  mockFetch([[/images\/generations$/, () => reply(200, { data: [] })]]);
  assert.equal((await owner('xai/image', post({ model: 'grok-imagine-image-2.0', prompt: 'x' }))).status, 400);
});

// ── video ──

test('video: start shapes text → video and image → video for Grok Imagine 1.5 / Lite; status never carries the link', async () => {
  mockFetch([[/^POST https:\/\/api\.x\.ai\/v1\/videos\/generations$/, () => reply(200, { request_id: 'd97415a1-5796-b7ec-379f-4e6819e08fdf' })]]);
  let r = await owner('xai/video/start', post({ model: 'grok-imagine-video-1.5-lite', prompt: 'waves', aspect: '9:16', resolution: '720p', seconds: 10, reference_images: [{ url: 'https://x' }], output: { upload_url: 'https://evil.example' } }));
  let j = JSON.parse(await text(r));
  assert.equal(r.status, 200);
  assert.deepEqual(sent(), { model: 'grok-imagine-video-1.5-lite', prompt: 'waves', duration: 10, resolution: '720p', aspect_ratio: '9:16' });
  assert.deepEqual(j, { id: 'd97415a1-5796-b7ec-379f-4e6819e08fdf', model: 'grok-imagine-video-1.5-lite', seconds: 10, resolution: '720p', quote: 0.2, pollAfterMs: 5000 });
  r = await owner('xai/video/start', post({ model: 'grok-imagine-video-1.5', image: PNG, resolution: '1080p', seconds: 6, aspect: '16:9' }));
  assert.deepEqual(sent(), { model: 'grok-imagine-video-1.5', duration: 6, resolution: '1080p', image: { url: PNG } }, 'a still: no prompt needed, no aspect_ratio (it follows the image)');
  assert.equal(JSON.parse(await r.text()).quote, 0.48);
  for (const [body, re] of [[{ model: 'grok-imagine-video-1.5', prompt: 'x', seconds: 16 }, /1–15 whole seconds/], [{ model: 'grok-imagine-video', prompt: 'x' }, /doesn’t offer/],
    [{ model: 'grok-imagine-video-1.5-lite' }, /Describe/], [{ model: 'grok-imagine-video-1.5-lite', prompt: 'x', resolution: '4k' }, /resolution must be/], [{ model: 'grok-imagine-video-1.5-lite', image: 'https://x/y.png' }, /PNG, JPEG or WebP/]]) {
    upstream.calls = [];
    const bad = await owner('xai/video/start', post(body));
    assert.equal(bad.status, 400, JSON.stringify(body));
    assert.match(JSON.parse(await bad.text()).error, re);
    assert.equal(upstream.calls.length, 0);
  }
  // status: pending (202) → done; the link and the key stay on the server
  const LINK = 'https://vidgen.x.ai/xai-vidgen-bucket/xai-video-abc.mp4';
  mockFetch([[/^GET https:\/\/api\.x\.ai\/v1\/videos\/abc$/, () => reply(202, { status: 'pending', progress: 40 })]]);
  j = JSON.parse(await text(await owner('xai/video/status/abc')));
  assert.deepEqual(j, { id: 'abc', status: 'pending', done: false, video: false, progress: 40, pollAfterMs: 5000 });
  mockFetch([[/videos\/abc$/, () => reply(200, { status: 'done', model: 'grok-imagine-video-1.5', progress: 100, video: { url: LINK, duration: 8, respect_moderation: true }, usage: { cost_in_usd_ticks: 6_400_000_000 } })]]);
  const t = await text(await owner('xai/video/status/abc'));
  assert.ok(!t.includes('vidgen'), 'no link to the browser');
  assert.deepEqual(JSON.parse(t), { id: 'abc', status: 'done', done: true, video: true, seconds: 8, usd: 0.64 });
  assert.deepEqual(X.summarize({ status: 'done', video: { url: LINK, respect_moderation: false } }, 'abc'), { id: 'abc', status: 'done', done: true, video: false, filtered: true, error: 'Grok’s moderation held this video back — try rephrasing.' });
  assert.equal(X.summarize({ status: 'failed', error: { code: 'internal_error', message: 'boom' } }, 'abc').error, 'boom');
  assert.equal(X.summarize({ status: 'expired' }, 'abc').done, true);
});

test('video file: fetched from xAI’s x.ai link WITHOUT the key; other hosts and redirects off x.ai are refused', async () => {
  const LINK = 'https://vidgen.x.ai/xai-vidgen-bucket/xai-video-abc.mp4';
  const done = (url) => [/^GET https:\/\/api\.x\.ai\/v1\/videos\/abc$/, () => reply(200, { status: 'done', video: { url, duration: 6, respect_moderation: true }, usage: { cost_in_usd_ticks: 1_200_000_000 } })];
  mockFetch([done(LINK), [/^GET https:\/\/vidgen\.x\.ai\//, (c) => { assert.equal(c.headers.get('authorization'), null, 'no key on the media request'); return new Response('MP4', { headers: { 'content-type': 'video/mp4' } }); }]]);
  const r = await owner('xai/video/file/abc');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'video/mp4');
  assert.equal(r.headers.get('cache-control'), 'private, no-store');
  assert.equal(r.headers.get('x-xai-usd'), '0.12');
  assert.equal(await r.text(), 'MP4');
  mockFetch([done('https://evil.example/v.mp4')]);
  assert.equal((await owner('xai/video/file/abc')).status, 502);
  mockFetch([done(LINK), [/vidgen/, () => new Response(null, { status: 302, headers: { location: 'https://evil.example/v.mp4' } })]]);
  assert.equal((await owner('xai/video/file/abc')).status, 502);
  mockFetch([[/videos\/abc$/, () => reply(202, { status: 'pending' })]]);
  assert.equal(JSON.parse(await (await owner('xai/video/file/abc')).text()).code, 'xai_not_ready');
  assert.deepEqual(['https://x.ai/a', 'https://files-cdn.x.ai/t/f.mp4', 'http://vidgen.x.ai/a', 'https://x.ai.evil.example/a', 'https://user:pw@vidgen.x.ai/a'].map(X.mediaUrlOk), [true, true, false, false, false]);
});

// ── the client (public/xai.js) ──

test('client: prices match the Worker’s; every request it builds passes src/xai.js unchanged', () => {
  for (const [id, m] of Object.entries(C.XAI_VIDEO)) assert.equal(m.usdPerSecond, X.XAI_VIDEO_MODELS[id].usdPerSecond, id);
  assert.deepEqual(Object.keys(C.XAI_VIDEO).sort(), Object.keys(X.XAI_VIDEO_MODELS).sort());
  assert.equal(C.XAI_IMAGE_USD, X.XAI_IMAGE_MODELS[C.XAI_IMAGE_MODEL.model].usd);
  for (const a of Object.values(C.XAI_IMAGE_ASPECT)) assert.ok(X.XAI_IMAGE_ASPECTS.includes(a), a);
  assert.ok(C.XAI_SECONDS.every((s) => s >= X.XAI_SECONDS_MIN && s <= X.XAI_SECONDS_MAX));
  for (const params of [{ aspect: '16:9', secs: 6 }, { aspect: '9:16', secs: 15 }, { aspect: '16:9hd', secs: 5 }]) {
    for (const still of [null, PNG]) {
      const body = C.xaiVideoRequest({ model: 'grok-imagine-video-1.5-lite', prompt: 'waves', still, params });
      const shaped = X.shapeVideo(body);
      assert.equal(shaped.seconds, body.seconds);
      assert.equal(shaped.resolution, params.aspect === '16:9hd' ? '1080p' : '720p');
      assert.equal(shaped.quote, C.xaiQuote('grok-imagine-video-1.5-lite', body.seconds));
    }
  }
  assert.equal(C.xaiVideoRequest({ model: 'grok-imagine-video-1.5', prompt: 'x', params: { secs: 5 } }).seconds, 4);
  assert.throws(() => C.xaiVideoRequest({ model: 'grok-imagine-video-1.5', prompt: '' }), /Describe/);
  assert.equal(C.xaiOptNote(C.XAI_VIDEO_MODELS[0], { secs: 6, aspect: '16:9' }), 'Grok Imagine 1.5 Lite · 6 s ≈ $0.12 · 720p');
  assert.equal(C.xaiOptNote(C.XAI_VIDEO_MODELS[1], { secs: 10, aspect: '16:9hd' }), 'Grok Imagine 1.5 · 10 s ≈ $0.80 · 1080p');
  assert.deepEqual(X.shapeImage(C.xaiImageRequest('a fox', '4:5')).body.aspect_ratio, '3:4');
  for (const m of C.XAI_VIDEO_MODELS) assert.equal(m.auto, false, m.id);
});

test('client: the video runner starts, polls, downloads, and resumes an earlier id instead of paying twice', async () => {
  const seen = [];
  const f = async (url, init = {}) => {
    seen.push(`${init.method || 'GET'} ${url}`);
    if (url === '/api/xai/video/start') return reply(200, { id: 'vid1', seconds: 6, quote: 0.12 });
    if (url === '/api/xai/video/status/vid1') return reply(200, seen.filter((s) => s.includes('status')).length < 2 ? { status: 'pending', done: false, progress: 50 } : { status: 'done', done: true, video: true, usd: 0.12 });
    if (url === '/api/xai/video/file/vid1') return new Response('MP4', { headers: { 'content-type': 'video/mp4', 'x-xai-usd': '0.12' } });
    throw new Error(url);
  };
  const ids = [], waits = [];
  const out = await C.xaiVideo({ model: 'grok-imagine-video-1.5-lite', prompt: 'x', seconds: 6 }, { fetch: f, sleep: async (ms) => { waits.push(ms); }, onId: (id) => ids.push(id) });
  assert.deepEqual(ids, ['vid1']);
  assert.equal(out.usd, 0.12);
  assert.equal(await out.blob.text(), 'MP4');
  assert.ok(waits.every((ms) => ms >= 5000));
  seen.length = 0;
  await C.xaiVideo({ model: 'grok-imagine-video-1.5-lite', prompt: 'x' }, { fetch: f, sleep: async () => {}, resume: 'vid1' });
  assert.ok(!seen.includes('POST /api/xai/video/start'), 'a resume never starts a new (paid) video');
  // a refused start (402) is not resumable and carries the server's words
  const no = async () => reply(402, { error: 'xAI says the account is out of credits', code: 'xai_credits' });
  await assert.rejects(C.xaiVideo({ model: 'grok-imagine-video-1.5', prompt: 'x' }, { fetch: no, sleep: async () => {} }), (e) => e.status === 402 && e.code === 'xai_credits' && !e.resumable);
});

// ── catalogue (app.js) ──

test('catalogue: Grok in its roles after today’s top choices; image and video entries owner-only and never Auto', () => {
  const block = APP.match(/const PREMIUM_MODELS = \{([\s\S]*?)\n\};/)[1];
  const roles = Object.fromEntries(Object.entries(new Function(`return {${block}\n};`)()).map(([r, list]) => [r, list.map(([id]) => id)])); // plain data
  const grok = Object.fromEntries(Object.entries(roles).map(([r, ids]) => [r, ids.filter((id) => id.startsWith('xai:'))]));
  assert.deepEqual(grok, { ask: ['xai:grok-4.7'], smart: ['xai:grok-4.7'], web: [], reason: ['xai:grok-4.7'], code: ['xai:grok-build-0.1', 'xai:grok-4.7'], write: [], vision: ['xai:grok-4.7'], watch: [], agent: ['xai:grok-4.7'], fast: ['xai:grok-4.3'] });
  for (const [r, ids] of Object.entries(roles)) {
    if (!grok[r].length) continue;
    assert.ok(!ids[0].startsWith('xai:'), `${r}: Auto keeps today's first choice`);
    const first = ids.findIndex((id) => id.startsWith('xai:'));
    assert.ok(ids.slice(first).every((id) => id.startsWith('xai:')), `${r}: Grok comes after the existing models`);
  }
  // the agent never gets Grok's search: web_search is offered to Anthropic models only, and shapeChatBody drops the rest
  assert.match(APP, /web && !accountRead && providerOf\(m\) === 'anthropic' \? \{ web_search: true \}/);
  // Image: after GPT Image, Nano Banana and Muse; Video: after the Runway entries, auto:false
  const images = [...APP.match(/const IMAGE_MODELS = \[([\s\S]*?)\n\];/)[1].matchAll(/id: ([\w.']+|'[^']+')/g)].map((m) => m[1]);
  assert.equal(images.indexOf('XAI_IMAGE_MODEL.id'), 4, images.join(' '));
  assert.match(APP, /\.\.\.RUNWAY_VIDEO_MODELS,\n[^\n]*\n {2}\.\.\.XAI_VIDEO_MODELS,/);
  assert.equal(C.XAI_IMAGE_MODEL.id, 'xai:grok-imagine-image-2.0');
  // Settings: the providers row and the diag names
  assert.match(APP, /\['nvidia', 'anthropic', 'openai', 'gemini', 'zai', 'deepseek', 'meta', 'xai', 'runway'\]\.map\(\(p\) =>/);
  assert.match(APP, /xai: 'xAI \(Grok\)'/);
  // testers: no xai: model in any tester plan
  for (const list of [TESTER_MODELS, TESTER_IMAGE_MODELS, TESTER_VIDEO_MODELS]) assert.ok(list.every((id) => !id.startsWith('xai:')), list.join(' '));
});
