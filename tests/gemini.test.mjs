import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  GEMINI_BASE, GEMINI_VIDEO_MIMES, CLIP_MAX_BYTES, CHUNK_MAX, GRANULARITY_DEFAULT, VIDEO_NEEDS_GEMINI, FILE_GONE_ERROR, GeminiError,
  normalizeVideoMime, isGeminiFileUri, isFileName, isUploadSession, hasVideoParts, hasVideoPart, chunkProblem,
  geminiUploadStart, geminiUploadChunk, geminiUploadQuery, geminiUploadCancel, geminiFileGet, geminiFileDelete, handleVideoApi,
  toGeminiRequest, geminiSseToOpenAI, geminiNativeChat,
} from '../src/gemini.js';

// ── fakes ──
const KEY = 'AQ.test-gemini-key-0123456789abcdefXYZ';
const UPLOAD_ID = 'ABCupload-id_secret42';
const SESSION = `${GEMINI_BASE}/upload/v1beta/files?upload_id=${UPLOAD_ID}&upload_protocol=resumable`;
const env = { GEMINI_API_KEY: KEY };
const MiB = 1024 * 1024;
const reply = (status, body, headers = {}) => new Response(body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const FILE = { name: 'files/abc123', displayName: 'clip', mimeType: 'video/mp4', sizeBytes: '8388618', uri: `${GEMINI_BASE}/v1beta/files/abc123`, state: 'PROCESSING', expirationTime: '2026-10-02T12:00:00.000Z' };

let calls = [];
const realFetch = globalThis.fetch;
function mockFetch(routes) {
  globalThis.fetch = async (input, init = {}) => {
    const call = { url: String(input), method: init.method || 'GET', headers: new Headers(init.headers), body: init.body, redirect: init.redirect };
    calls.push(call);
    for (const [pattern, handler] of routes) if (pattern.test(`${call.method} ${call.url}`)) return handler(call);
    throw new Error(`unmocked fetch ${call.method} ${call.url}`);
  };
}

// Everything written to console.warn / console.error; checked after every test for the key and the upload session.
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

const rejects = async (p, status, re) => {
  await assert.rejects(p, (err) => {
    assert.ok(err instanceof GeminiError, `expected GeminiError, got ${err}`);
    assert.equal(err.status, status);
    if (re) assert.match(err.message, re);
    assert.ok(!err.message.includes(KEY));
    return true;
  });
};
const body = async (res) => { const t = await res.text(); assert.ok(!t.includes(KEY), `API key in response: ${t}`); assert.ok(!t.includes(UPLOAD_ID)); return JSON.parse(t); };
const stream = (chunks) => new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(typeof x === 'string' ? new TextEncoder().encode(x) : x); c.close(); } });
const sseEvents = (text) => text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).map((d) => (d === '[DONE]' ? d : JSON.parse(d)));
const gem = (obj) => `data: ${JSON.stringify(obj)}\r\n\r\n`;
const cand = (parts, finishReason) => ({ candidates: [{ content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}), index: 0 }] });
async function convert(chunks) {
  const out = await new Response(stream(chunks).pipeThrough(geminiSseToOpenAI())).text();
  return sseEvents(out);
}
const deltas = (events) => events.filter((e) => e !== '[DONE]' && e.choices).map((e) => e.choices[0]);

// ── constants and validators ──
test('normalizeVideoMime handles aliases, params and extension fallback', () => {
  assert.equal(normalizeVideoMime('video/quicktime'), 'video/quicktime');
  assert.equal(normalizeVideoMime('video/x-m4v'), 'video/mp4');
  assert.equal(normalizeVideoMime('Video/MP4; codecs=avc1'), 'video/mp4');
  assert.equal(normalizeVideoMime('video/mov'), 'video/quicktime');
  assert.equal(normalizeVideoMime('video/x-msvideo'), 'video/avi');
  assert.equal(normalizeVideoMime('video/x-ms-wmv'), 'video/wmv');
  assert.equal(normalizeVideoMime('', 'clip.MOV'), 'video/quicktime');
  assert.equal(normalizeVideoMime('', 'a.m4v'), 'video/mp4');
  assert.equal(normalizeVideoMime('', 'a.3gp'), 'video/3gpp');
  assert.equal(normalizeVideoMime('', 'movie.mkv'), 'video/x-matroska');
  assert.equal(normalizeVideoMime('', 'x.constructor'), '');
  assert.equal(normalizeVideoMime(undefined, 'noext'), '');
  assert.ok(!GEMINI_VIDEO_MIMES.has('video/x-matroska'));
  assert.deepEqual([...GEMINI_VIDEO_MIMES].sort(), ['video/3gpp', 'video/avi', 'video/mp4', 'video/mpeg', 'video/mpg', 'video/quicktime', 'video/webm', 'video/wmv', 'video/x-flv']);
  assert.equal(CLIP_MAX_BYTES, 1073741824);
});

test('file names and URIs must be Gemini files', () => {
  assert.ok(isFileName('files/abc-123'));
  for (const n of ['files/../x', 'files/', 'file/abc', 'files/a/b', ' files/a', 5]) assert.ok(!isFileName(n), String(n));
  assert.ok(isGeminiFileUri(`${GEMINI_BASE}/v1beta/files/abc-1`));
  for (const u of ['https://evil.example/v1beta/files/x', `${GEMINI_BASE}/v1/files/x`, `${GEMINI_BASE}/v1beta/files/x?y`, 'http://generativelanguage.googleapis.com/v1beta/files/x', `${GEMINI_BASE}/v1beta/files/../x`]) assert.ok(!isGeminiFileUri(u), u);
});

test('upload sessions are only Google upload URLs with an upload_id', () => {
  assert.ok(isUploadSession(SESSION));
  assert.ok(isUploadSession(`${GEMINI_BASE}:443/upload/v1beta/files?upload_id=x`));
  for (const s of [
    `http://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=x`,
    'https://evil.example/upload/v1beta/files?upload_id=x',
    'https://generativelanguage.googleapis.com.evil.example/upload/v1beta/files?upload_id=x',
    `${GEMINI_BASE}:8443/upload/v1beta/files?upload_id=x`,
    'https://user:pw@generativelanguage.googleapis.com/upload/v1beta/files?upload_id=x',
    `${GEMINI_BASE}/upload/v1beta/files/?upload_id=x`,
    `${GEMINI_BASE}/upload/v1beta/files/abc?upload_id=x`,
    `${GEMINI_BASE}/v1beta/files?upload_id=x`,
    `${GEMINI_BASE}/upload/v1beta/files`,
    `${GEMINI_BASE}/upload/v1beta/files?upload_id=`,
    `${GEMINI_BASE}/upload/v1beta/files?uploadid=x`,
    'https://generativelanguage.googleapis.com\\@evil.example/upload/v1beta/files?upload_id=x',
    'not a url', '', null, 42, `${SESSION}&pad=${'x'.repeat(5000)}`,
  ]) assert.ok(!isUploadSession(s), String(s).slice(0, 80));
});

test('hasVideoParts / hasVideoPart find a video_file part anywhere', () => {
  const vid = { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'video_file', video_file: { file_uri: FILE.uri, mime_type: 'video/mp4' } }] };
  assert.equal(hasVideoParts([{ role: 'system', content: 's' }, vid]), true);
  assert.equal(hasVideoPart({ messages: [vid] }), true);
  assert.equal(hasVideoPart({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }] }), false);
  assert.equal(hasVideoPart({ messages: [{ role: 'user', content: 'video_file' }] }), false);
  assert.equal(hasVideoPart({}), false);
  assert.equal(hasVideoPart(null), false);
});

// ── upload start ──
test('upload start sends the resumable start headers and returns {session, chunk}', async () => {
  mockFetch([[/^POST https:\/\/generativelanguage\.googleapis\.com\/upload\/v1beta\/files$/, () => reply(200, '', { 'x-goog-upload-url': SESSION, 'x-goog-upload-chunk-granularity': '8388608' })]]);
  const out = await geminiUploadStart(env, { name: 'My "clip"\u0007.mov', mime: 'video/quicktime', size: 50 * MiB });
  assert.deepEqual(out, { session: SESSION, chunk: 16 * MiB });
  const [c] = calls;
  assert.equal(c.headers.get('x-goog-api-key'), KEY);
  assert.equal(c.headers.get('x-goog-upload-protocol'), 'resumable');
  assert.equal(c.headers.get('x-goog-upload-command'), 'start');
  assert.equal(c.headers.get('x-goog-upload-header-content-length'), String(50 * MiB));
  assert.equal(c.headers.get('x-goog-upload-header-content-type'), 'video/quicktime');
  assert.equal(c.headers.get('content-type'), 'application/json');
  assert.equal(c.redirect, 'manual');
  assert.deepEqual(JSON.parse(c.body), { file: { display_name: 'My clip.mov' } });
  assert.ok(!c.url.includes(KEY), 'key goes in a header, not the URL');
});

test('upload start sizes chunks from the granularity header', async () => {
  const chunkFor = async (g) => {
    mockFetch([[/upload\/v1beta\/files$/, () => reply(200, '', { 'x-goog-upload-url': SESSION, ...(g == null ? {} : { 'x-goog-upload-chunk-granularity': g }) })]]);
    return (await geminiUploadStart(env, { name: 'a.mp4', mime: 'video/mp4', size: 100 })).chunk;
  };
  assert.equal(await chunkFor(null), 16 * MiB);
  assert.equal(await chunkFor('262144'), 16 * MiB);
  assert.equal(await chunkFor('8388608'), 16 * MiB);
  assert.equal(await chunkFor('16777216'), 16 * MiB);
  assert.equal(await chunkFor('33554432'), 32 * MiB);
  assert.equal(await chunkFor('garbage'), 16 * MiB);
  for (const g of ['67108864', '3000000']) await rejects(chunkFor(g), 502, /chunk size/);
});

test('upload start validates size and type before calling Google', async () => {
  mockFetch([]);
  await rejects(geminiUploadStart(env, { name: 'a.mp4', mime: 'video/mp4', size: 0 }), 400);
  await rejects(geminiUploadStart(env, { name: 'a.mp4', mime: 'video/mp4', size: '100' }), 400);
  await rejects(geminiUploadStart(env, { name: 'a.mp4', mime: 'video/mp4', size: 2 * 1024 * MiB }), 413, /over 1 GB/);
  await rejects(geminiUploadStart(env, { name: 'a.txt', mime: 'text/plain', size: 10 }), 415);
  await rejects(geminiUploadStart(env, { name: 'a.mkv', mime: '', size: 10 }), 415);
  await rejects(geminiUploadStart({}, { name: 'a.mp4', mime: 'video/mp4', size: 10 }), 401);
  assert.equal(calls.length, 0);
});

test('upload start refuses a session URL that is not Google’s and never hands out the key', async () => {
  mockFetch([[/upload\/v1beta\/files$/, () => reply(200, '', { 'x-goog-upload-url': 'https://evil.example/upload/v1beta/files?upload_id=x' })]]);
  await rejects(geminiUploadStart(env, { name: 'a.mp4', mime: 'video/mp4', size: 10 }), 502, /upload session/);
  mockFetch([[/upload\/v1beta\/files$/, () => reply(200, '')]]);
  await rejects(geminiUploadStart(env, { name: 'a.mp4', mime: 'video/mp4', size: 10 }), 502);
  // A key echoed into the upload URL is stripped before the session reaches the browser.
  mockFetch([[/upload\/v1beta\/files$/, () => reply(200, '', { 'x-goog-upload-url': `${GEMINI_BASE}/upload/v1beta/files?key=${KEY}&upload_id=${UPLOAD_ID}` })]]);
  const { session } = await geminiUploadStart(env, { name: 'a.mp4', mime: 'video/mp4', size: 10 });
  assert.ok(!session.includes(KEY));
  assert.ok(isUploadSession(session));
});

test('upload start maps Google failures to 502 without the key', async () => {
  mockFetch([[/upload\/v1beta\/files$/, () => reply(400, { error: { code: 400, message: `API key ${KEY} not valid. Please pass a valid API key.`, status: 'INVALID_ARGUMENT' } })]]);
  await rejects(geminiUploadStart(env, { name: 'a.mp4', mime: 'video/mp4', size: 10 }), 502, /\(400\).*API key … not valid/);
  mockFetch([[/upload\/v1beta\/files$/, () => { throw new TypeError(`fetch failed for ${GEMINI_BASE}?key=${KEY}`); }]]);
  await rejects(geminiUploadStart(env, { name: 'a.mp4', mime: 'video/mp4', size: 10 }), 502, /unreachable/);
});

// ── chunks ──
test('chunk rules: offsets on 8 MiB, whole blocks until the last, at most 32 MiB', () => {
  const G = GRANULARITY_DEFAULT;
  assert.equal(chunkProblem(0, 10, 10), null);
  assert.equal(chunkProblem(0, 3 * G, 2 * G), null);
  assert.equal(chunkProblem(2 * G, 2 * G + 5, 5), null);
  assert.deepEqual(chunkProblem(0, 3 * G, G + 1)?.[1], 400); // non-final partial block
  assert.deepEqual(chunkProblem(5, 100, 10)?.[1], 400); // offset not on a block
  assert.deepEqual(chunkProblem(0, 10, 11)?.[1], 400); // past the end
  assert.deepEqual(chunkProblem(0, 64 * MiB, CHUNK_MAX + 1)?.[1], 413);
  assert.deepEqual(chunkProblem(0, 10, 0)?.[1], 413);
  assert.deepEqual(chunkProblem(0, CLIP_MAX_BYTES + 1, G)?.[1], 413);
  assert.deepEqual(chunkProblem(-G, 10, 10)?.[1], 400);
  assert.deepEqual(chunkProblem(NaN, 10, 10)?.[1], 400);
});

test('chunk upload sends upload then upload, finalize with the right offsets', async () => {
  const total = GRANULARITY_DEFAULT + 10;
  mockFetch([[/^POST https:\/\/generativelanguage\.googleapis\.com\/upload\/v1beta\/files\?upload_id=/, (c) => (c.headers.get('x-goog-upload-command') === 'upload, finalize'
    ? reply(200, { file: FILE }, { 'x-goog-upload-status': 'final' })
    : reply(200, '', { 'x-goog-upload-status': 'active' }))]]);
  const first = await geminiUploadChunk(env, SESSION, { offset: 0, total, bytes: new Uint8Array(GRANULARITY_DEFAULT) });
  assert.deepEqual(first, { received: GRANULARITY_DEFAULT });
  const last = await geminiUploadChunk(env, SESSION, { offset: GRANULARITY_DEFAULT, total, bytes: new Uint8Array(10) });
  assert.deepEqual(last, { done: true, file: { name: 'files/abc123', uri: FILE.uri, mime: 'video/mp4', state: 'PROCESSING', expiresAt: Date.parse(FILE.expirationTime), size: 8388618 } });
  assert.equal(calls[0].url, SESSION);
  assert.equal(calls[0].headers.get('x-goog-upload-command'), 'upload');
  assert.equal(calls[0].headers.get('x-goog-upload-offset'), '0');
  assert.equal(calls[0].headers.get('content-length'), String(GRANULARITY_DEFAULT));
  assert.equal(calls[0].body.byteLength, GRANULARITY_DEFAULT);
  assert.equal(calls[1].headers.get('x-goog-upload-command'), 'upload, finalize');
  assert.equal(calls[1].headers.get('x-goog-upload-offset'), String(GRANULARITY_DEFAULT));
  assert.equal(calls[1].headers.get('content-length'), '10');
  assert.equal(calls[1].redirect, 'manual');
});

test('finalize checks the returned file and falls back to a 47 h expiry', async () => {
  mockFetch([[/upload\/v1beta\/files\?upload_id=/, () => reply(200, { file: { ...FILE, state: 'ACTIVE', expirationTime: undefined, sizeBytes: undefined } })]]);
  const before = Date.now();
  const { file } = await geminiUploadChunk(env, SESSION, { offset: 0, total: 10, bytes: new Uint8Array(10) });
  assert.equal(file.state, 'ACTIVE');
  assert.equal(file.size, 10);
  assert.ok(file.expiresAt >= before + 47 * 3600e3 - 1000 && file.expiresAt <= Date.now() + 47 * 3600e3);
  for (const bad of [{ ...FILE, uri: 'https://evil.example/v1beta/files/abc123' }, { ...FILE, name: 'files/../x' }, undefined]) {
    mockFetch([[/upload\/v1beta\/files\?upload_id=/, () => reply(200, bad ? { file: bad } : 'not json')]]);
    await rejects(geminiUploadChunk(env, SESSION, { offset: 0, total: 10, bytes: new Uint8Array(10) }), 502, /unexpected file/);
  }
});

test('chunk upload refuses bad sessions and bad ranges without calling Google', async () => {
  mockFetch([]);
  await rejects(geminiUploadChunk(env, 'https://evil.example/upload/v1beta/files?upload_id=x', { offset: 0, total: 10, bytes: new Uint8Array(10) }), 400, /session/);
  await rejects(geminiUploadChunk(env, SESSION, { offset: 0, total: 3 * GRANULARITY_DEFAULT, bytes: new Uint8Array(5) }), 400);
  await rejects(geminiUploadChunk(env, SESSION, { offset: 0, total: 10, bytes: undefined }), 413);
  assert.equal(calls.length, 0);
});

test('chunk upload: offset/session 4xx → 409, 408/429 → 503 (+retry-after), 401/403 and 5xx → 502', async () => {
  const send = () => geminiUploadChunk(env, SESSION, { offset: 0, total: 10, bytes: new Uint8Array(10) });
  for (const status of [400, 404, 409, 410, 412]) {
    mockFetch([[/upload_id=/, () => reply(status, { error: { message: `bad offset for ${SESSION}` } })]]);
    await rejects(send(), 409, /out of sync/);
  }
  mockFetch([[/upload_id=/, () => reply(429, { error: { message: 'Too many requests' } }, { 'retry-after': '7' })]]);
  await assert.rejects(send(), (e) => e.status === 503 && e.headers['retry-after'] === '7');
  mockFetch([[/upload_id=/, () => reply(408, '', { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' })]]);
  await assert.rejects(send(), (e) => e.status === 503 && !('retry-after' in e.headers));
  mockFetch([[/upload_id=/, () => reply(403, { error: { message: `API key ${KEY} was blocked` } })]]);
  await rejects(send(), 502, /\(403\): API key … was blocked/);
  mockFetch([[/upload_id=/, () => reply(503, { error: { message: 'backend unavailable' } })]]);
  await rejects(send(), 502, /503/);
});

test('route: a 429 from the upload server reaches the browser as 503 with retry-after', async () => {
  mockFetch([[/upload_id=/, () => reply(429, { error: { message: 'slow down' } }, { 'retry-after': '3' })]]);
  const r = await api('video/upload/chunk?offset=0&total=10', { method: 'PUT', headers: { 'x-upload-session': SESSION }, body: new Uint8Array(10) });
  assert.equal(r.status, 503);
  assert.equal(r.headers.get('retry-after'), '3');
  assert.equal(r.headers.get('content-type'), 'application/json');
  assert.match((await body(r)).error, /busy/);
});

test('upload query reports how much Google holds, or the file when it was already finalized', async () => {
  mockFetch([[/^POST .*upload_id=/, () => reply(200, '', { 'x-goog-upload-status': 'active', 'x-goog-upload-size-received': String(GRANULARITY_DEFAULT) })]]);
  assert.deepEqual(await geminiUploadQuery(env, SESSION), { received: GRANULARITY_DEFAULT });
  assert.equal(calls[0].headers.get('x-goog-upload-command'), 'query');
  assert.equal(calls[0].headers.get('x-goog-api-key'), KEY);
  assert.equal(calls[0].redirect, 'manual');
  mockFetch([[/upload_id=/, () => reply(200, { file: { ...FILE, sizeBytes: undefined } }, { 'x-goog-upload-status': 'final' })]]);
  assert.deepEqual(await geminiUploadQuery(env, SESSION, 99), { done: true, file: { name: FILE.name, uri: FILE.uri, mime: 'video/mp4', state: 'PROCESSING', expiresAt: Date.parse(FILE.expirationTime), size: 99 } });
  mockFetch([[/upload_id=/, () => reply(200, '', { 'x-goog-upload-status': 'cancelled' })]]);
  await rejects(geminiUploadQuery(env, SESSION), 409, /out of sync/);
  mockFetch([[/upload_id=/, () => reply(404, { error: { message: 'session expired' } })]]);
  await rejects(geminiUploadQuery(env, SESSION), 409);
  mockFetch([[/upload_id=/, () => reply(200, '', { 'x-goog-upload-status': 'active' })]]);
  await rejects(geminiUploadQuery(env, SESSION), 502, /how much/);
  calls = [];
  mockFetch([]);
  await rejects(geminiUploadQuery(env, 'https://evil.example/upload/v1beta/files?upload_id=x'), 400);
  assert.equal(calls.length, 0);
  // through the route, with the total for the final file's size
  mockFetch([[/upload_id=/, () => reply(200, { file: { ...FILE, sizeBytes: undefined } }, { 'x-goog-upload-status': 'final' })]]);
  const r = await api('video/upload/query?total=42', { method: 'POST', headers: { 'x-upload-session': SESSION } });
  assert.equal((await body(r)).file.size, 42);
  assert.equal((await api('video/upload/query', { method: 'GET' })).status, 404);
});

test('cancel sends the cancel command only to a valid session and always answers ok', async () => {
  mockFetch([[/upload_id=/, () => reply(200, '')]]);
  assert.deepEqual(await geminiUploadCancel(env, SESSION), { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.get('x-goog-upload-command'), 'cancel');
  assert.deepEqual(await geminiUploadCancel(env, 'https://evil.example/upload/v1beta/files?upload_id=x'), { ok: true });
  assert.equal(calls.length, 1);
  mockFetch([[/upload_id=/, () => { throw new Error('down'); }]]);
  assert.deepEqual(await geminiUploadCancel(env, SESSION), { ok: true });
});

// ── file state + delete ──
test('file status maps Google’s file record for polling', async () => {
  mockFetch([[/^GET https:\/\/generativelanguage\.googleapis\.com\/v1beta\/files\/abc123$/, () => reply(200, { ...FILE, state: 'ACTIVE' })]]);
  assert.deepEqual(await geminiFileGet(env, 'files/abc123'), { name: 'files/abc123', uri: FILE.uri, mime: 'video/mp4', state: 'ACTIVE', expiresAt: Date.parse(FILE.expirationTime) });
  assert.equal(calls[0].headers.get('x-goog-api-key'), KEY);
  mockFetch([[/files\/abc123$/, () => reply(200, { ...FILE, state: 'FAILED', error: { code: 3, message: 'Video codec not supported' } })]]);
  assert.deepEqual(await geminiFileGet(env, 'files/abc123').then((f) => [f.state, f.error]), ['FAILED', 'Video codec not supported']);
  mockFetch([[/files\/abc123$/, () => reply(200, { ...FILE, state: 'STATE_UNSPECIFIED' })]]);
  assert.equal((await geminiFileGet(env, 'files/abc123')).state, 'PROCESSING');
  mockFetch([[/files\/abc123$/, () => reply(200, { ...FILE, name: 'files/other' })]]);
  await rejects(geminiFileGet(env, 'files/abc123'), 502);
});

test('a missing or expired file is GONE; other failures are 502', async () => {
  mockFetch([[/files\/abc123$/, () => reply(404, { error: { code: 404, message: 'File not found' } })]]);
  await assert.rejects(geminiFileGet(env, 'files/abc123'), (e) => e.status === 404 && e.message === 'gone' && e.extra.state === 'GONE');
  mockFetch([[/files\/abc123$/, () => reply(403, { error: { code: 403, message: 'You do not have permission to access the File abc123 or it may not exist.' } })]]);
  await assert.rejects(geminiFileGet(env, 'files/abc123'), (e) => e.status === 404 && e.extra.state === 'GONE');
  mockFetch([[/files\/abc123$/, () => reply(403, { error: { code: 403, message: 'The caller does not have permission' } })]]);
  await rejects(geminiFileGet(env, 'files/abc123'), 502, /403/);
  mockFetch([]);
  await rejects(geminiFileGet(env, 'files/../x'), 400);
});

test('delete counts 200 and 404 as ok', async () => {
  mockFetch([[/^DELETE .*\/v1beta\/files\/abc123$/, () => reply(200, {})]]);
  assert.deepEqual(await geminiFileDelete(env, 'files/abc123'), { ok: true });
  mockFetch([[/^DELETE .*\/v1beta\/files\/abc123$/, () => reply(404, { error: { message: 'not found' } })]]);
  assert.deepEqual(await geminiFileDelete(env, 'files/abc123'), { ok: true });
  mockFetch([[/^DELETE .*\/v1beta\/files\/abc123$/, () => reply(500, { error: { message: 'oops' } })]]);
  await rejects(geminiFileDelete(env, 'files/abc123'), 502);
  await rejects(geminiFileDelete(env, 'files/a/b'), 400);
});

// ── /api/video/* route handler ──
const api = (path, init = {}) => {
  const url = new URL(`https://atelier.test/api/${path}`);
  return handleVideoApi(new Request(url, init), env, url.pathname.slice(5), url.searchParams);
};

test('route: upload/start answers JSON with the contract statuses', async () => {
  mockFetch([[/upload\/v1beta\/files$/, () => reply(200, '', { 'x-goog-upload-url': SESSION, 'x-goog-upload-chunk-granularity': '8388608' })]]);
  const ok = await api('video/upload/start', { method: 'POST', body: JSON.stringify({ name: 'a.mp4', mime: 'video/mp4', size: 1234 }) });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'application/json');
  assert.deepEqual(JSON.parse(await ok.text()), { session: SESSION, chunk: 16 * MiB });
  const code = async (b) => (await api('video/upload/start', { method: 'POST', body: b })).status;
  assert.equal(await code('{nope'), 400);
  assert.equal(await code('[]'), 400);
  assert.equal(await code(JSON.stringify({ name: 'a.txt', mime: 'text/plain', size: 10 })), 415);
  assert.equal(await code(JSON.stringify({ name: 'a.mp4', mime: 'video/mp4', size: 2 * 1024 * MiB })), 413);
  assert.equal(await code(JSON.stringify({ name: 'a.mp4', mime: 'video/mp4', size: 0 })), 400);
});

// A body that streams `total` bytes in 1 KiB pieces, counting what was pulled; no content-length is declared.
const counted = (total) => {
  const seen = { pulled: 0 };
  seen.stream = new ReadableStream({ pull(c) { if (seen.pulled >= total) return c.close(); seen.pulled += 1024; c.enqueue(new Uint8Array(1024).fill(32)); } }, { highWaterMark: 0 });
  return seen;
};

test('route: upload/start stops reading an oversized body without a content-length', async () => {
  mockFetch([]);
  const big = counted(64 * MiB);
  const r = await handleVideoApi(new Request('https://atelier.test/api/video/upload/start', { method: 'POST', body: big.stream, duplex: 'half' }), env, 'video/upload/start');
  assert.equal(r.status, 413);
  assert.ok(big.pulled <= 16384 + 2048, `read ${big.pulled} bytes`);
  // a declared length over the cap is refused before reading; a short body against its declared length is a 400
  const declared = counted(64 * MiB);
  const d = await handleVideoApi(new Request('https://atelier.test/api/video/upload/start', { method: 'POST', body: declared.stream, duplex: 'half', headers: { 'content-length': String(64 * MiB) } }), env, 'video/upload/start');
  assert.equal(d.status, 413);
  assert.equal(declared.pulled, 0);
  const short = await handleVideoApi(new Request('https://atelier.test/api/video/upload/start', { method: 'POST', body: counted(1024).stream, duplex: 'half', headers: { 'content-length': '2048' } }), env, 'video/upload/start');
  assert.equal(short.status, 400);
  assert.equal(calls.length, 0);
});

test('route: an undeclared chunk body is read into one buffer and cut off past 32 MiB', async () => {
  mockFetch([[/upload_id=/, () => reply(200, '')]]);
  const big = counted(CHUNK_MAX + 64 * 1024);
  const r = await handleVideoApi(new Request(`https://atelier.test/api/video/upload/chunk?offset=0&total=${64 * MiB}`, { method: 'PUT', body: big.stream, duplex: 'half', headers: { 'x-upload-session': SESSION } }),
    env, 'video/upload/chunk', new URLSearchParams(`offset=0&total=${64 * MiB}`));
  assert.equal(r.status, 413);
  assert.ok(big.pulled <= CHUNK_MAX + 2048, `read ${big.pulled} bytes`);
  const ok = counted(GRANULARITY_DEFAULT);
  const r2 = await handleVideoApi(new Request('https://atelier.test/x', { method: 'PUT', body: ok.stream, duplex: 'half', headers: { 'x-upload-session': SESSION } }),
    env, 'video/upload/chunk', new URLSearchParams(`offset=0&total=${2 * GRANULARITY_DEFAULT}`));
  assert.deepEqual(await body(r2), { received: GRANULARITY_DEFAULT });
  const sent = calls.at(-1).body;
  assert.equal(sent.byteLength, GRANULARITY_DEFAULT);
  assert.equal(calls.at(-1).headers.get('content-length'), String(GRANULARITY_DEFAULT));
  assert.equal(sent[0], 32);
});

test('route: upload/chunk validates before reading and forwards with offsets', async () => {
  const put = (qs, headers, bytes) => api(`video/upload/chunk?${qs}`, { method: 'PUT', headers: { 'x-upload-session': SESSION, ...headers }, body: bytes });
  mockFetch([[/upload_id=/, (c) => (c.headers.get('x-goog-upload-command') === 'upload, finalize' ? reply(200, { file: { ...FILE, sizeBytes: '10' } }) : reply(200, ''))]]);
  // bad session host
  let r = await api('video/upload/chunk?offset=0&total=10', { method: 'PUT', headers: { 'x-upload-session': 'https://evil.example/upload/v1beta/files?upload_id=x' }, body: new Uint8Array(10) });
  assert.equal(r.status, 400);
  // non-final length that isn't whole 8 MiB blocks (declared length is checked before the body is read)
  r = await put(`offset=0&total=${3 * GRANULARITY_DEFAULT}`, { 'content-length': String(5 * MiB) }, new Uint8Array(4));
  assert.equal(r.status, 400);
  // over 32 MiB
  r = await put(`offset=0&total=${64 * MiB}`, { 'content-length': String(CHUNK_MAX + 1) }, new Uint8Array(4));
  assert.equal(r.status, 413);
  // offset not on a block / missing numbers
  assert.equal((await put('offset=5&total=100', {}, new Uint8Array(10))).status, 400);
  assert.equal((await put('total=10', {}, new Uint8Array(10))).status, 400);
  // declared length that doesn't match the body (shorter or longer), and an undeclared body over 32 MiB
  assert.equal((await put('offset=0&total=12', { 'content-length': '12' }, new Uint8Array(10))).status, 400);
  assert.equal((await put('offset=0&total=10', { 'content-length': '10' }, new Uint8Array(12))).status, 400);
  assert.equal((await put(`offset=0&total=${64 * MiB}`, {}, new Uint8Array(CHUNK_MAX + 1))).status, 413);
  assert.equal((await put('offset=0&total=10', { 'content-length': 'ten' }, new Uint8Array(10))).status, 400);
  assert.equal(calls.length, 0, 'nothing reached Google');
  // a whole final chunk (no content-length header: read with the 32 MiB cap)
  r = await put('offset=0&total=10', {}, new Uint8Array(10).fill(7));
  assert.equal(r.status, 200);
  const j = await body(r);
  assert.equal(j.done, true);
  assert.equal(j.file.name, 'files/abc123');
  assert.equal(j.file.uri, FILE.uri);
  assert.equal(calls[0].headers.get('x-goog-upload-command'), 'upload, finalize');
  assert.equal(calls[0].headers.get('x-goog-upload-offset'), '0');
  assert.deepEqual([...calls[0].body], Array(10).fill(7));
  // a middle chunk with a declared length
  r = await put(`offset=${GRANULARITY_DEFAULT}&total=${3 * GRANULARITY_DEFAULT}`, { 'content-length': String(GRANULARITY_DEFAULT) }, new Uint8Array(GRANULARITY_DEFAULT));
  assert.deepEqual(await body(r), { received: 2 * GRANULARITY_DEFAULT });
  assert.equal(calls[1].headers.get('x-goog-upload-command'), 'upload');
  assert.equal(calls[1].headers.get('x-goog-upload-offset'), String(GRANULARITY_DEFAULT));
});

test('route: upload/chunk turns Google 4xx into 409 without leaking the session', async () => {
  mockFetch([[/upload_id=/, () => reply(400, { error: { message: `Failed to upload to ${SESSION}` } })]]);
  const r = await api('video/upload/chunk?offset=0&total=10', { method: 'PUT', headers: { 'x-upload-session': SESSION }, body: new Uint8Array(10) });
  assert.equal(r.status, 409);
  assert.deepEqual(await body(r), { error: 'Upload out of sync — try attaching again.' });
});

test('route: cancel, file status, delete and unknown paths', async () => {
  mockFetch([
    [/^POST .*upload_id=/, () => reply(200, '')],
    [/^GET .*\/v1beta\/files\/abc123$/, () => reply(200, { ...FILE, state: 'ACTIVE' })],
    [/^GET .*\/v1beta\/files\/gone1$/, () => reply(404, { error: { message: 'File not found' } })],
    [/^DELETE .*\/v1beta\/files\/abc123$/, () => reply(200, {})],
  ]);
  let r = await api('video/upload/cancel', { method: 'POST', headers: { 'x-upload-session': SESSION } });
  assert.deepEqual(await body(r), { ok: true });
  r = await api('video/file?name=files/abc123');
  assert.equal((await body(r)).state, 'ACTIVE');
  r = await api('video/file?name=files/gone1');
  assert.equal(r.status, 404);
  assert.deepEqual(await body(r), { error: 'gone', state: 'GONE' });
  r = await api(`video/file?name=${encodeURIComponent('files/../x')}`);
  assert.equal(r.status, 400);
  r = await api('video/file?name=files/abc123', { method: 'DELETE' });
  assert.deepEqual(await body(r), { ok: true });
  assert.equal((await api('video/nope')).status, 404);
  assert.equal((await api('video/upload/start')).status, 404); // GET
  assert.equal((await api('video/file?name=files/abc123', { method: 'POST' })).status, 404);
});

// ── request conversion ──
const IMG = 'data:image/png;base64,iVBORw0KGgo=';
const VIDEO = { type: 'video_file', video_file: { file_uri: FILE.uri, mime_type: 'video/mp4' } };

test('toGeminiRequest maps system, roles, text, images and the video file', () => {
  const g = toGeminiRequest({
    model: 'gemini:gemini-3.8-flash', temperature: 0.7, max_tokens: 6000, top_p: 0.95, reasoning_effort: 'low', tools: [{ type: 'function' }],
    messages: [
      { role: 'system', content: 'You are Atelier.' },
      { role: 'system', content: [{ type: 'text', text: 'Be brief.' }] },
      { role: 'user', content: 'Earlier question' },
      { role: 'assistant', content: 'Earlier answer', reasoning_content: 'hmm', anthropic_content: [{ type: 'thinking' }], tool_calls: [{ id: 't', function: { name: 'x', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 't', content: 'tool output' },
      { role: 'user', content: [{ type: 'text', text: 'Intro' }, VIDEO, { type: 'image_url', image_url: { url: IMG } }, { type: 'image_url', image_url: { url: 'https://example.com/x.png' } }, { type: 'input_audio', input_audio: {} }, { type: 'text', text: 'What happens?' }] },
    ],
  });
  assert.deepEqual(g, {
    systemInstruction: { parts: [{ text: 'You are Atelier.\n\nBe brief.' }] },
    contents: [
      { role: 'user', parts: [{ text: 'Earlier question' }] },
      { role: 'model', parts: [{ text: 'Earlier answer' }] },
      { role: 'user', parts: [{ text: 'Intro' }, { file_data: { mime_type: 'video/mp4', file_uri: FILE.uri } }, { inline_data: { mime_type: 'image/png', data: 'iVBORw0KGgo=' } }, { text: 'What happens?' }] },
    ],
    generationConfig: { maxOutputTokens: 6000, temperature: 0.7, thinkingConfig: { includeThoughts: true, thinkingLevel: 'low' } },
  });
  const s = JSON.stringify(g);
  for (const gone of ['reasoning_content', 'anthropic_content', 'tool_calls', 'tool output', 'top_p', 'tools', 'reasoning_effort']) assert.ok(!s.includes(gone), gone);
});

test('toGeminiRequest merges consecutive roles and drops leading model turns', () => {
  const g = toGeminiRequest({ messages: [
    { role: 'assistant', content: 'Welcome!' },
    { role: 'user', content: 'a' },
    { role: 'user', content: [{ type: 'text', text: 'b' }] },
    { role: 'assistant', content: '' },
    { role: 'user', content: 'c' },
    { role: 'assistant', content: [{ type: 'text', text: 'd' }, { type: 'image_url', image_url: { url: IMG } }] },
    { role: 'assistant', content: 'e' },
  ] });
  assert.deepEqual(g.contents, [
    { role: 'user', parts: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] },
    { role: 'model', parts: [{ text: 'd' }, { text: 'e' }] },
  ]);
  assert.equal(g.systemInstruction, undefined);
  assert.throws(() => toGeminiRequest({ messages: [{ role: 'assistant', content: 'x' }] }), (e) => e.status === 400);
});

test('toGeminiRequest clamps tokens, keeps finite temperatures and rejects bad video references', () => {
  const cfg = (b) => toGeminiRequest({ messages: [{ role: 'user', content: 'x' }], ...b }).generationConfig;
  assert.equal(cfg({}).maxOutputTokens, 8192);
  assert.equal(cfg({ max_tokens: 10 }).maxOutputTokens, 256);
  assert.equal(cfg({ max_tokens: 1e6 }).maxOutputTokens, 65536);
  assert.equal(cfg({}).temperature, undefined);
  assert.equal(cfg({ temperature: NaN }).temperature, undefined);
  assert.equal(cfg({ temperature: '0.5' }).temperature, undefined);
  assert.equal(cfg({ temperature: 0 }).temperature, 0);
  assert.equal(cfg({ temperature: 5 }).temperature, 2);
  assert.deepEqual(cfg({}).thinkingConfig, { includeThoughts: true });
  const vid =(video_file) => () => toGeminiRequest({ messages: [{ role: 'user', content: [{ type: 'video_file', video_file }] }] });
  for (const v of [
    { file_uri: 'https://evil.example/v1beta/files/abc', mime_type: 'video/mp4' },
    { file_uri: 'files/abc', mime_type: 'video/mp4' },
    { file_uri: `${GEMINI_BASE}/v1beta/files/abc?x=1`, mime_type: 'video/mp4' },
    { file_uri: FILE.uri, mime_type: 'text/html' },
    undefined,
  ]) assert.throws(vid(v), (e) => e instanceof GeminiError && e.status === 400 && e.message === 'Bad video reference');
  assert.deepEqual(toGeminiRequest({ messages: [{ role: 'user', content: [{ type: 'video_file', video_file: { file_uri: FILE.uri, mime_type: 'video/x-m4v' } }] }] }).contents[0].parts,
    [{ file_data: { mime_type: 'video/mp4', file_uri: FILE.uri } }]);
});

test('toGeminiRequest maps reasoning_effort to thinkingLevel like the OpenAI-compatible route', () => {
  const level = (e) => toGeminiRequest({ messages: [{ role: 'user', content: 'x' }], reasoning_effort: e }).generationConfig.thinkingConfig;
  assert.deepEqual(level('low'), { includeThoughts: true, thinkingLevel: 'low' });
  assert.equal(level('medium').thinkingLevel, 'medium');
  assert.equal(level('high').thinkingLevel, 'high');
  assert.equal(level('xhigh').thinkingLevel, 'high');
  assert.equal(level('minimal').thinkingLevel, 'low'); // 3.8 Flash and 3.1 Pro reject 'minimal'
  for (const e of [undefined, '', 'turbo', 'constructor', 3]) assert.deepEqual(level(e), { includeThoughts: true }, String(e));
});

// ── SSE conversion ──
test('SSE: text and thought parts become content / reasoning_content deltas, split anywhere', async () => {
  const src = gem(cand([{ text: 'Planning…', thought: true }]))
    + gem(cand([{ text: 'The dog — runs ' }, { thoughtSignature: 'c2ln' }]))
    + gem({ ...cand([{ text: 'fast.' }], 'STOP'), usageMetadata: { totalTokenCount: 9 } });
  const bytes = new TextEncoder().encode(src);
  const pieces = [];
  for (let i = 0; i < bytes.length; i += 7) pieces.push(bytes.slice(i, i + 7)); // splits lines, JSON and the multi-byte dash
  const events = await convert(pieces);
  assert.equal(events.at(-1), '[DONE]');
  const d = deltas(events);
  assert.deepEqual(d.map((x) => x.delta), [{ reasoning_content: 'Planning…' }, { content: 'The dog — runs ' }, { content: 'fast.' }, {}]);
  assert.deepEqual(d.map((x) => x.finish_reason), [null, null, null, 'stop']);
  assert.ok(d.every((x) => x.index === 0));
});

test('SSE: MAX_TOKENS finishes with length; a trailing line without a newline is still read', async () => {
  const events = await convert([gem(cand([{ text: 'a' }])), `data: ${JSON.stringify(cand([{ text: 'b' }], 'MAX_TOKENS'))}`]);
  assert.deepEqual(deltas(events).map((x) => [x.delta.content, x.finish_reason]), [['a', null], ['b', null], [undefined, 'length']]);
  assert.equal(events.at(-1), '[DONE]');
});

test('SSE: MAX_TOKENS before any answer (all spent thinking) is an error, so the client falls back', async () => {
  const events = await convert([gem(cand([{ text: 'Long thought…', thought: true }])), gem(cand([{ text: 'more', thought: true }], 'MAX_TOKENS'))]);
  assert.deepEqual(events.slice(-2), [{ error: { message: 'Gemini ran out of tokens while thinking — try again.' } }, '[DONE]']);
  assert.ok(!deltas(events).some((x) => x.finish_reason), 'no finish_reason, only the error');
  assert.deepEqual(await convert([gem(cand([], 'MAX_TOKENS'))]), [{ error: { message: 'Gemini ran out of tokens while thinking — try again.' } }, '[DONE]']);
});

test('SSE: block reasons and safety stops become errors or a note', async () => {
  let events = await convert([gem({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } })]);
  assert.deepEqual(events, [{ error: { message: 'Gemini blocked this request (PROHIBITED_CONTENT) — try rephrasing.' } }, '[DONE]']);
  events = await convert([gem(cand([], 'SAFETY'))]);
  assert.deepEqual(events, [{ error: { message: 'Gemini stopped (SAFETY) — try rephrasing.' } }, '[DONE]']);
  events = await convert([gem(cand([{ text: 'thinking only', thought: true }])), gem(cand([], 'RECITATION'))]);
  assert.equal(events[1].error.message, 'Gemini stopped (RECITATION) — try rephrasing.'); // thoughts aren't content
  events = await convert([gem(cand([{ text: 'Partial answer' }])), gem(cand([], 'SAFETY'))]);
  assert.deepEqual(deltas(events).map((x) => [x.delta.content, x.finish_reason]), [['Partial answer', null], ['\n\n_Gemini stopped early (SAFETY)._', 'content_filter']]);
  events = await convert([gem(cand([{ text: 'x' }])), gem(cand([], 'weird "reason"<b>'))]);
  assert.match(deltas(events).at(-1).delta.content, /\(OTHER\)/);
});

test('SSE: upstream error events pass through; bad JSON and non-data lines are ignored', async () => {
  const events = await convert([
    ': keep-alive\r\n\r\n', 'event: message\r\n', 'data: {not json\r\n\r\n', 'data: 42\r\n\r\n',
    gem(cand([{ text: 'ok' }])),
    gem({ error: { code: 500, message: 'Internal error encountered.', status: 'INTERNAL' } }),
  ]);
  assert.deepEqual(events, [{ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] }, { error: { message: 'Internal error encountered.' } }, '[DONE]']);
  assert.deepEqual(await convert([]), ['[DONE]']);
});

// ── native chat ──
const STREAM_URL = /^POST https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-3\.8-flash:streamGenerateContent\?alt=sse$/;
const chatBody = (extra = {}) => ({ model: 'gemini:gemini-3.8-flash', temperature: 0.5, max_tokens: 6000, stream: true, messages: [{ role: 'user', content: [{ type: 'text', text: 'Intro' }, VIDEO, { type: 'text', text: 'What happens?' }] }], ...extra });
const sseReply = (chunks) => new Response(stream(chunks), { status: 200, headers: { 'content-type': 'text/event-stream' } });

test('native chat streams streamGenerateContent back as OpenAI-style SSE', async () => {
  mockFetch([[STREAM_URL, () => sseReply([gem(cand([{ text: 'Hmm', thought: true }])), gem(cand([{ text: 'A cat jumps.' }], 'STOP'))])]]);
  const res = await geminiNativeChat(chatBody(), KEY);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const events = sseEvents(await res.text());
  assert.deepEqual(deltas(events).map((x) => x.delta), [{ reasoning_content: 'Hmm' }, { content: 'A cat jumps.' }, {}]);
  assert.equal(events.at(-1), '[DONE]');
  const [c] = calls;
  assert.equal(c.headers.get('x-goog-api-key'), KEY);
  assert.equal(c.headers.get('content-type'), 'application/json');
  assert.equal(c.redirect, 'manual');
  assert.ok(!c.url.includes(KEY));
  const sent = JSON.parse(c.body);
  assert.deepEqual(sent.contents[0].parts[1], { file_data: { mime_type: 'video/mp4', file_uri: FILE.uri } });
  assert.deepEqual(sent.generationConfig, { maxOutputTokens: 6000, temperature: 0.5, thinkingConfig: { includeThoughts: true } });
});

test('native chat retries once without thinkingConfig when Google rejects it', async () => {
  let n = 0;
  mockFetch([[STREAM_URL, (c) => (++n === 1
    ? reply(400, { error: { code: 400, message: 'Thinking is not supported for this model.', status: 'INVALID_ARGUMENT' } })
    : sseReply([gem(cand([{ text: 'fine' }], 'STOP'))]))]]);
  const res = await geminiNativeChat(chatBody(), KEY);
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
  assert.ok(JSON.parse(calls[0].body).generationConfig.thinkingConfig);
  assert.equal(JSON.parse(calls[1].body).generationConfig.thinkingConfig, undefined);
  assert.equal(JSON.parse(calls[1].body).generationConfig.maxOutputTokens, 6000);
  assert.equal(deltas(sseEvents(await res.text()))[0].delta.content, 'fine');
  // Only once: a second rejection is returned as-is.
  mockFetch([[STREAM_URL, () => reply(400, { error: { code: 400, message: 'Unknown name "includeThoughts" at generation_config.thinking_config' } })]]);
  calls = [];
  const again = await geminiNativeChat(chatBody(), KEY);
  assert.equal(again.status, 400);
  assert.equal(calls.length, 2);
  // Other 400s are not retried.
  mockFetch([[STREAM_URL, () => reply(400, { error: { code: 400, message: 'Request contains an invalid argument.' } })]]);
  calls = [];
  assert.equal((await geminiNativeChat(chatBody(), KEY)).status, 400);
  assert.equal(calls.length, 1);
});

test('native chat maps an expired or unprocessed file to 409 video_file_gone', async () => {
  for (const [status, message] of [[400, 'File files/abc123 is not in an ACTIVE state and usage is not allowed.'], [403, 'You do not have permission to access the File abc123 or it may not exist.'], [404, 'File files/abc123 not found']]) {
    mockFetch([[STREAM_URL, () => reply(status, { error: { code: status, message } })]]);
    const res = await geminiNativeChat(chatBody(), KEY);
    assert.equal(res.status, 409, message);
    assert.deepEqual(await body(res), { error: FILE_GONE_ERROR, code: 'video_file_gone' });
  }
});

test('native chat passes other upstream errors through unchanged (minus the key)', async () => {
  const err = { error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } };
  mockFetch([[STREAM_URL, () => reply(429, err)]]);
  let res = await geminiNativeChat(chatBody(), KEY);
  assert.equal(res.status, 429);
  assert.deepEqual(await body(res), err);
  mockFetch([[STREAM_URL, () => reply(404, [{ error: { code: 404, message: 'models/gemini-3.8-flash is not found for API version v1beta' } }])]]);
  res = await geminiNativeChat(chatBody(), KEY);
  assert.equal(res.status, 404, 'a missing model is not a missing file');
  mockFetch([[STREAM_URL, () => reply(400, { error: { code: 400, message: `API key not valid: ${KEY}` } })]]);
  res = await geminiNativeChat(chatBody(), KEY);
  assert.equal(res.status, 400);
  assert.match((await body(res)).error.message, /API key not valid: …/);
  mockFetch([[STREAM_URL, () => reply(302, '', { location: 'https://elsewhere.example/' })]]);
  assert.equal((await geminiNativeChat(chatBody(), KEY)).status, 502);
  mockFetch([[STREAM_URL, () => { throw new TypeError(`connect failed ${KEY}`); }]]);
  res = await geminiNativeChat(chatBody(), KEY);
  assert.equal(res.status, 502);
  assert.match((await body(res)).error, /^Upstream unreachable/);
});

test('native chat validates the model and the video reference before calling Google', async () => {
  mockFetch([]);
  let res = await geminiNativeChat(chatBody({ model: 'anthropic:claude-opus-5-5' }), KEY);
  assert.equal(res.status, 400);
  assert.deepEqual(await body(res), { error: VIDEO_NEEDS_GEMINI });
  res = await geminiNativeChat(chatBody({ model: 'gemini:../../files/x' }), KEY);
  assert.equal(res.status, 400);
  res = await geminiNativeChat(chatBody({ messages: [{ role: 'user', content: [{ type: 'video_file', video_file: { file_uri: 'https://evil.example/v1beta/files/x', mime_type: 'video/mp4' } }] }] }), KEY);
  assert.equal(res.status, 400);
  assert.deepEqual(await body(res), { error: 'Bad video reference' });
  assert.equal(calls.length, 0);
});

test('native chat turns a dropped upstream stream into an error event and still ends with [DONE]', async () => {
  const broken = new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(gem(cand([{ text: 'Half' }])) + 'data: {"candi')); },
    pull(c) { c.error(new Error(`socket closed (key ${KEY})`)); },
  });
  mockFetch([[STREAM_URL, () => new Response(broken, { status: 200, headers: { 'content-type': 'text/event-stream' } })]]);
  const res = await geminiNativeChat(chatBody(), KEY);
  const text = await res.text();
  assert.ok(!text.includes(KEY));
  const events = sseEvents(text);
  assert.equal(events[0].choices[0].delta.content, 'Half');
  assert.match(events[1].error.message, /^Gemini stream failed: socket closed \(key …\)/);
  assert.equal(events.at(-1), '[DONE]');
});

test('cancelling the client stream cancels the upstream body', async () => {
  let cancelled = false;
  const endless = new ReadableStream({
    pull(c) { c.enqueue(new TextEncoder().encode(gem(cand([{ text: 'x' }])))); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  mockFetch([[STREAM_URL, () => new Response(endless, { status: 200, headers: { 'content-type': 'text/event-stream' } })]]);
  const res = await geminiNativeChat(chatBody(), KEY);
  const reader = res.body.getReader();
  await reader.read();
  await reader.cancel();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(cancelled, true);
});
