// src/omni.js (Worker) and public/omni.js (browser): Gemini Omni Flash video on the Interactions API, replacing Veo 3.1
// (shut down on the Gemini API 2026-10-22). Google is never called for real: every upstream request goes to a fetch mock.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const W = await import('../src/omni.js');
const C = await import('../public/omni.js');
const { GEMINI_BASE } = await import('../src/gemini.js');

const KEY = 'AQ.test-gemini-key-0123456789abcdef';
const realFetch = globalThis.fetch;
let calls = [];
function mockFetch(routes) {
  calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const call = { url, method: init.method || 'GET', headers: new Headers(init.headers), body: init.body, init };
    if (typeof call.body === 'string') { try { call.json = JSON.parse(call.body); } catch {} }
    calls.push(call);
    for (const [re, fn] of routes) if (re.test(`${call.method} ${url}`)) return fn(call);
    throw new Error(`unmocked fetch ${call.method} ${url}`);
  };
}
afterEach(() => { globalThis.fetch = realFetch; });
const reply = (status, body, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const owner = (path, { method = 'GET', body } = {}) => {
  const req = new Request(`https://atelier.test/api/${path}`, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) });
  return W.handleOmni(req, {}, path, { key: KEY });
};
const B64 = Buffer.from(Uint8Array.from({ length: 5_000 }, (_, i) => (i * 7) % 256)).toString('base64');
const finished = (data = B64, extra = {}) => ({
  id: 'v1_abc', status: 'completed', model: 'gemini-omni-1.1-flash', object: 'interaction',
  steps: [{ type: 'user_input', content: [{ type: 'image', mime_type: 'image/png', data: B64.slice(0, 2000) }, { type: 'text', text: 'waves' }] },
    { type: 'thought', content: [{ type: 'thought', text: '…' }] }, { type: 'model_output', content: [{ type: 'video', mime_type: 'video/mp4', data }] }],
  usage: { total_input_tokens: 900, total_output_tokens: 23_500, output_tokens_by_modality: [{ modality: 'video', tokens: 23_168 }] }, ...extra,
});

test('shapeOmni: Atelier\'s options → the documented Interactions body (text → video, image → video, edit, extend)', () => {
  assert.deepEqual(W.shapeOmni({ prompt: ' A paper boat ', aspect: '16:9', resolution: '720p', seconds: 6 }).body, {
    model: 'gemini-omni-1.1-flash', input: 'A paper boat',
    response_format: { type: 'video', aspect_ratio: '16:9', resolution: '720p', duration: '6s' }, background: true, store: true,
  });
  const i2v = W.shapeOmni({ prompt: 'move', image: 'data:image/jpeg;base64,/9j/AAAA', aspect: '9:16', resolution: '1080p', seconds: 10 });
  assert.deepEqual(i2v.body.input, [{ type: 'image', data: '/9j/AAAA', mime_type: 'image/jpeg' }, { type: 'text', text: 'move' }]);
  assert.deepEqual(i2v.body.response_format, { type: 'video', aspect_ratio: '9:16', resolution: '1080p', duration: '10s' });
  // defaults: 16:9, 720p, 6 s
  assert.deepEqual(W.shapeOmni({ prompt: 'x' }).body.response_format, { type: 'video', aspect_ratio: '16:9', resolution: '720p', duration: '6s' });
  const edit = W.shapeOmni({ prompt: 'make it night', previous: 'v1_abc', task: 'edit' });
  assert.deepEqual(edit.body, { model: 'gemini-omni-1.1-flash', input: 'make it night', response_format: { type: 'video', resolution: '720p' }, background: true, store: true,
    previous_interaction_id: 'v1_abc', generation_config: { video_config: { task: 'edit' } } });
  const ext = W.shapeOmni({ prompt: 'continue', previous: 'v1_abc', task: 'extend', seconds: 8 });
  assert.deepEqual(ext.body.response_format, { type: 'video', aspect_ratio: '16:9', resolution: '720p', duration: '8s' });
  for (const [input, re] of [
    [{ prompt: '' }, /Describe/], [{ prompt: 'x', seconds: 2 }, /3–10/], [{ prompt: 'x', seconds: 11 }, /3–10/], [{ prompt: 'x', seconds: 4.5 }, /3–10/],
    [{ prompt: 'x', aspect: '1:1' }, /16:9 or 9:16/], [{ prompt: 'x', resolution: '8k' }, /resolution/], [{ prompt: 'x', image: 'data:image/gif;base64,R0lG' }, /PNG, JPEG or WebP/],
    [{ prompt: 'x', previous: '../etc' }, /isn’t an Omni video/], [{ prompt: 'x', task: 'edit' }, /needs the earlier clip/], [{ prompt: 'x', previous: 'v1_a', task: 'text_to_video' }, /edited or extended/],
    [{ prompt: 'x'.repeat(8_001) }, /limited/], [null, /Bad JSON/],
  ]) assert.throws(() => W.shapeOmni(input), (e) => e instanceof W.OmniError && e.status === 400 && re.test(e.message), JSON.stringify(input)?.slice(0, 60));
  // the tester router narrows it
  assert.throws(() => W.shapeOmni({ prompt: 'x', seconds: 5 }, { durations: [4, 6, 8] }), /4, 6, 8/);
  assert.throws(() => W.shapeOmni({ prompt: 'x', resolution: '4k' }, { resolutions: ['720p', '1080p'] }), /720p, 1080p/);
});

test('owner start: POST /v1beta/interactions with the key header, no redirect; a refused duration is retried once without it', async () => {
  let refuse = true;
  mockFetch([[/^POST .*\/v1beta\/interactions$/, (c) => (refuse && c.json.response_format.duration ? reply(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Invalid value at response_format.duration' } }) : reply(200, { id: 'v1_new', status: 'queued' }))]]);
  let r = await owner('omni/start', { method: 'POST', body: { prompt: 'waves', seconds: 4 } });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { id: 'v1_new', status: 'queued', seconds: null, durationIgnored: true, pollAfterMs: 10_000 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `${GEMINI_BASE}/v1beta/interactions`);
  assert.equal(calls[0].headers.get('x-goog-api-key'), KEY);
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[1].json.response_format.duration, undefined);
  refuse = false;
  r = await owner('omni/start', { method: 'POST', body: { prompt: 'waves', seconds: 4 } });
  assert.deepEqual(await r.json(), { id: 'v1_new', status: 'queued', seconds: 4, pollAfterMs: 10_000 });
  // another 400 is not retried; 429 keeps retry-after; 401/403 names the key, never its value
  mockFetch([[/interactions$/, (c) => (c.json.input === 'busy' ? reply(429, { error: { message: 'quota' } }, { 'retry-after': '30' }) : c.json.input === 'key' ? reply(403, { error: { message: `bad key ${KEY}` } }) : reply(400, { error: { message: 'blocked prompt' } }))]]);
  r = await owner('omni/start', { method: 'POST', body: { prompt: 'nope' } });
  assert.equal(r.status, 400); assert.equal((await r.json()).code, 'omni_rejected'); assert.equal(calls.length, 1);
  r = await owner('omni/start', { method: 'POST', body: { prompt: 'busy' } });
  assert.equal(r.status, 429); assert.equal(r.headers.get('retry-after'), '30');
  r = await owner('omni/start', { method: 'POST', body: { prompt: 'key' } });
  const t = await r.text();
  assert.equal(r.status, 403); assert.ok(!t.includes(KEY));
});

test('status: running → poll again; completed → video, never the bytes; filtered and failed say so', async () => {
  let j = { id: 'v1_abc', status: 'in_progress' };
  mockFetch([[/^GET .*\/v1beta\/interactions\/v1_abc$/, () => reply(200, j)]]);
  let r = await owner('omni/status/v1_abc');
  assert.deepEqual(await r.json(), { id: 'v1_abc', status: 'in_progress', done: false, video: false, pollAfterMs: 10_000 });
  j = finished();
  r = await owner('omni/status/v1_abc');
  const text = await r.text();
  assert.ok(!text.includes(B64.slice(0, 100)), 'no video data in a status');
  const s = JSON.parse(text);
  assert.equal(s.done, true); assert.equal(s.video, true);
  assert.deepEqual(s.usage, { total_input_tokens: 900, total_output_tokens: 23_500, output_tokens_by_modality: [{ modality: 'video', tokens: 23_168 }] });
  j = { id: 'v1_abc', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'I can’t make that.' }] }] };
  r = await owner('omni/status/v1_abc');
  assert.equal((await r.json()).filtered, true);
  j = { id: 'v1_abc', status: 'failed', error: { message: 'Internal error' } };
  r = await owner('omni/status/v1_abc');
  assert.deepEqual(await r.json(), { id: 'v1_abc', status: 'failed', done: true, video: false, error: 'Internal error' });
  mockFetch([[/interactions\/v1_gone$/, () => reply(404, { error: { code: 404 } })]]);
  r = await owner('omni/status/v1_gone');
  assert.equal(r.status, 404); assert.equal((await r.json()).code, 'omni_gone');
  r = await owner('omni/status/..%2Fx');
  assert.equal(r.status, 404);
});

test('video: the inline base64 clip streams back decoded, in slices; a hosted file comes from Google’s Files API only', async () => {
  mockFetch([[/interactions\/v1_abc$/, () => reply(200, finished())]]);
  let r = await owner('omni/video/v1_abc');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'video/mp4');
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), Buffer.from(B64, 'base64'), 'the model_output clip, not the input image');
  // decodeStream in small slices gives the same bytes
  const text = JSON.stringify(finished()), { blobs } = W.scan(text);
  assert.equal(blobs.length, 2, 'both long data strings are cut out before parsing');
  const parts = []; for await (const ch of W.decodeStream(text, blobs[1], 64)) parts.push(Buffer.from(ch));
  assert.deepEqual(Buffer.concat(parts), Buffer.from(B64, 'base64'));
  // still running → 409
  mockFetch([[/interactions\/v1_run$/, () => reply(200, { id: 'v1_run', status: 'queued' })]]);
  r = await owner('omni/video/v1_run');
  assert.equal(r.status, 409); assert.equal((await r.json()).code, 'omni_not_ready');
  // a uri: only https://generativelanguage.googleapis.com/v1beta/files/<id>, once ACTIVE, fetched with the key
  let state = 'PROCESSING';
  const uriDone = (uri) => finished(undefined, { steps: [{ type: 'model_output', content: [{ type: 'video', mime_type: 'video/mp4', uri }] }] });
  mockFetch([
    [/interactions\/v1_uri$/, () => reply(200, uriDone(`${GEMINI_BASE}/v1beta/files/vid9:download?alt=media`))],
    [/interactions\/v1_evil$/, () => reply(200, uriDone('https://evil.example/files/vid9:download'))],
    [/^GET .*\/v1beta\/files\/vid9$/, () => reply(200, { name: 'files/vid9', state })],
    [/^GET .*\/v1beta\/files\/vid9:download\?alt=media$/, () => new Response(new Uint8Array([7, 8, 9]), { headers: { 'content-type': 'video/mp4' } })],
  ]);
  r = await owner('omni/video/v1_uri');
  assert.equal(r.status, 409);
  state = 'ACTIVE';
  r = await owner('omni/video/v1_uri');
  assert.equal(r.status, 200);
  assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [7, 8, 9]);
  assert.equal(calls.at(-1).headers.get('x-goog-api-key'), KEY);
  r = await owner('omni/video/v1_evil');
  assert.equal(r.status, 502);
  assert.ok(!calls.some((c) => c.url.includes('evil.example')), 'an untrusted host is never fetched');
});

test('cancel: POST /v1beta/interactions/{id}/cancel; a finished or missing one is fine', async () => {
  mockFetch([[/^POST .*\/interactions\/v1_abc\/cancel$/, () => reply(200, {})], [/^POST .*\/interactions\/v1_old\/cancel$/, () => reply(404, {})]]);
  assert.deepEqual(await (await owner('omni/cancel/v1_abc', { method: 'POST', body: {} })).json(), { ok: true });
  assert.deepEqual(await (await owner('omni/cancel/v1_old', { method: 'POST', body: {} })).json(), { ok: true });
});

// ── public/omni.js ──
test('client: old Veo ids migrate to Omni; Video-mode params map onto Omni’s options', () => {
  for (const id of ['gemini:veo-3.1-lite-generate-preview', 'gemini:veo-3.1-fast-generate-preview', 'gemini:veo-3.1-generate-preview']) assert.equal(C.migrateVideoId(id), C.OMNI_ID);
  assert.equal(C.OMNI_ID, 'gemini:gemini-omni-1.1-flash');
  for (const id of ['runway:gen4.5', 'nvidia/cosmos3-nano', '', undefined]) assert.equal(C.migrateVideoId(id), id);
  assert.deepEqual(C.omniShape({ aspect: '16:9hd', secs: 8 }), { seconds: 8, resolution: '1080p', aspect: '16:9' });
  assert.deepEqual(C.omniShape({ aspect: '9:16', secs: 10 }), { seconds: 10, resolution: '720p', aspect: '9:16' });
  assert.deepEqual(C.omniShape({ secs: 10 }, { tester: true }), { seconds: 8, resolution: '720p', aspect: '16:9' });
  assert.deepEqual(C.omniShape({ secs: 2 }), { seconds: 6, resolution: '720p', aspect: '16:9' });
  assert.deepEqual(C.omniRequest({ prompt: ' waves ', still: 'data:image/png;base64,AAAA', params: { aspect: '16:9', secs: 4 } }),
    { prompt: 'waves', aspect: '16:9', resolution: '720p', seconds: 4, image: 'data:image/png;base64,AAAA' });
  assert.deepEqual(C.omniRequest({ prompt: 'night', params: { secs: 6 }, previous: 'v1_a', task: 'edit' }), { prompt: 'night', aspect: '16:9', resolution: '720p', seconds: 6, previous: 'v1_a', task: 'edit' });
  // whatever the client builds, the Worker accepts
  assert.doesNotThrow(() => W.shapeOmni(C.omniRequest({ prompt: 'waves', still: 'data:image/png;base64,AAAA', params: { aspect: '16:9hd', secs: 10 } })));
  assert.throws(() => C.omniRequest({ prompt: 'x', still: 'data:image/gif;base64,AA' }), /PNG, JPEG or WebP/);
});

test('client omniVideo: start → poll every ≥ 10 s → download; Try again resumes; Stop cancels a running clip', async () => {
  let polls = 0;
  const seen = [];
  const f = async (url, init = {}) => {
    seen.push(`${init.method || 'GET'} ${url}`);
    if (url === '/api/omni/start') return reply(200, { id: 'v1_c', seconds: 6 });
    if (url === '/api/omni/status/v1_c') return reply(200, ++polls < 3 ? { id: 'v1_c', status: 'in_progress', done: false } : { id: 'v1_c', status: 'completed', done: true, video: true });
    if (url === '/api/omni/video/v1_c') return new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'video/mp4' } });
    if (url === '/api/omni/cancel/v1_c') return reply(200, { ok: true });
    throw new Error(url);
  };
  const waits = [], ids = [], status = [];
  const out = await C.omniVideo({ prompt: 'waves', seconds: 6 }, { fetch: f, apiHeaders: { 'x-app-pass': 'p' }, sleep: async (ms) => { waits.push(ms); }, onId: (id) => ids.push(id), onStatus: (t) => status.push(t) });
  assert.equal(out.id, 'v1_c'); assert.equal(out.blob.size, 2); assert.equal(out.seconds, 6);
  assert.deepEqual(ids, ['v1_c']);
  assert.ok(waits.every((ms) => ms >= 10_000));
  assert.deepEqual(seen, ['POST /api/omni/start', 'GET /api/omni/status/v1_c', 'GET /api/omni/status/v1_c', 'GET /api/omni/status/v1_c', 'GET /api/omni/video/v1_c']);
  // resume: no new start
  seen.length = 0; polls = 5;
  await C.omniVideo({ prompt: 'waves' }, { fetch: f, resume: 'v1_c', sleep: async () => {} });
  assert.ok(!seen.includes('POST /api/omni/start'));
  // filtered → 400 with the reason, not resumable
  const g = async (url) => (url === '/api/omni/start' ? reply(200, { id: 'v1_f' }) : reply(200, { id: 'v1_f', done: true, video: false, filtered: true, error: 'filtered by safety' }));
  await assert.rejects(C.omniVideo({ prompt: 'x' }, { fetch: g, sleep: async () => {} }), (e) => e.status === 400 && /filtered/.test(e.message) && !e.resumable && e.id === 'v1_f');
  // Stop while filming: the clip is cancelled
  seen.length = 0; polls = 0;
  const ctrl = new AbortController();
  await assert.rejects(C.omniVideo({ prompt: 'x' }, { fetch: f, signal: ctrl.signal, sleep: async () => { ctrl.abort(); throw new DOMException('Aborted', 'AbortError'); } }), (e) => e.name === 'AbortError');
  assert.ok(seen.includes('POST /api/omni/cancel/v1_c'));
  // a start with no answer may have billed: unconfirmed, never retried
  await assert.rejects(C.omniStart({ fetch: async () => { throw new TypeError('network'); } }, { prompt: 'x' }), (e) => e.status === 0 && e.code === 'omni_unconfirmed');
});

test('app.js: Omni is the Auto video model, the Google Veo ids are gone, saved pins migrate; Haiku 5.5 leads the fast role', async () => {
  const src = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.ok(!/['"]gemini:veo-3\.1/.test(src), 'no Google Veo 3.1 id in the app catalog');
  assert.ok(!/['"]gemini:gemini-3\.1-flash-image['"],\s*label/.test(src));
  assert.match(src, /\{ id: OMNI_ID, label: 'Gemini Omni Flash', omni: true, veo: true/);
  assert.match(src, /id: 'gemini:gemini-nano-banana-2\.1', label: 'Nano Banana 2\.1/);
  assert.match(src, /fast: \[\['anthropic:claude-haiku-5-5', 'Claude Haiku 5\.5'\]/);
  assert.match(src, /function migrateImageId\(id\) \{ return id === 'gemini:gemini-3\.1-flash-image' \? 'gemini:gemini-nano-banana-2\.1' : id; \}/);
  assert.match(src, /const videoModel = \(id0\) => \{ const id = migrateVideoId\(id0\);/);
  const sw = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
  assert.match(sw, /`\/omni\.js\?v=\$\{V\}`/);
});

test('scan cuts out clips of any size: a regex over the base64 overflowed V8 past ~3 MB (RangeError at 4 MB+)', () => {
  for (const mb of [1, 4, 8, 20]) {
    const b64 = 'QUJD'.repeat(Math.floor((mb * 1024 * 1024 * 4) / 3 / 4));
    const text = JSON.stringify({ id: 'v1_big', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'video', data: b64, mime_type: 'video/mp4' }] }], short: { data: 'QUJD' } });
    const s = W.scan(text);
    assert.ok(s.j, `${mb} MB: parsed`);
    assert.equal(s.blobs.length, 1, `${mb} MB: one clip cut out, the short data string left in`);
    assert.equal(text.slice(...s.blobs[0]), b64, `${mb} MB: the range is exactly the base64`);
    assert.equal(s.j.steps[0].content[0].data, '@omni:0');
    assert.equal(s.j.short.data, 'QUJD');
  }
  // same rules as before: escaped slashes and base64url count; a value that isn't a plain string is left alone
  const odd = `{"a":{"data":"${'A\/'.repeat(600)}"},"b":{"data":"${'A'.repeat(2000)}x y"},"c":{"data" : "${'_-'.repeat(600)}"}}`;
  const o = W.scan(odd);
  assert.equal(o.blobs.length, 2);
  assert.equal(o.j.a.data, '@omni:0'); assert.equal(o.j.c.data, '@omni:1'); assert.ok(o.j.b.data.endsWith('x y'));
});

test('scrub never throws on a huge upstream body (an error page or a clip) and still redacts', () => {
  const huge = `error AIzaSyFAKEFAKEFAKE https://x.example/a ${'A'.repeat(20 * 1024 * 1024)}`;
  const out = W.scrub(huge, KEY);
  assert.ok(out.length <= 240);
  assert.ok(!/AIzaSyFAKE/.test(out) && !/https:/.test(out));
  assert.ok(!/A{200}/.test(out));
});
