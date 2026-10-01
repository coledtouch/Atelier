import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
// Static import on purpose: public/video.js must load in node without touching the DOM.
import * as V from '../public/video.js';
const {
  GEMINI_VIDEO_MIMES, CLIP_MAX_BYTES, CLIP_MAX_SECONDS, CHUNK_MAX, GRANULARITY_DEFAULT, FILE_EXPIRY_MARGIN_MS, VIDEO_TIMING, FRAME_MAX_BYTES, POSTER_MAX_BYTES, CHUNK_RETRIES,
  normalizeVideoMime, isVideoFile, cleanName, frameCount, frameTimes, fmtDur, pickFrames, frameCapFor, clipReason, clipEligible, fileValid, toFileRef,
  framesPlan, planFor, videoParts, noteFor, dataUrlBytes, fitSize, storedVideo, validVideo, readVideo, sampleVideo, uploadClip, waitClipActive, deleteClip, startClip,
  sampleOrder,
} = V;

const TIMING = { ...VIDEO_TIMING }, realNow = Date.now;
beforeEach(() => Object.assign(VIDEO_TIMING, { meta: 300, probe: 100, warm: 20, seek: 100, frame: 20, settle: 1, blank: 5, total: 5000, poll: 5, pollMax: 400, retry: 1,
  retryMax: 20, request: 1000, stall: 1000, answer: 1000, offline: 50 }));
afterEach(() => { Object.assign(VIDEO_TIMING, TIMING); globalThis.fetch = realFetch; Date.now = realNow; delete globalThis.document; delete globalThis.XMLHttpRequest; });

const JPEG = n => `data:image/jpeg;base64,${'A'.repeat(n)}`;
const URI = id => `https://generativelanguage.googleapis.com/v1beta/files/${id}`;
const frames = n => Array.from({ length: n }, (_, i) => ({ t: i * 2 + 0.5, src: JPEG(8) }));

// ── pure helpers ──
test('module loads without a DOM', () => {
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(typeof readVideo, 'function'); assert.equal(typeof uploadClip, 'function');
});
test('normalizeVideoMime folds aliases, params and extensions', () => {
  assert.equal(normalizeVideoMime('video/quicktime'), 'video/quicktime');
  assert.equal(normalizeVideoMime('video/x-m4v'), 'video/mp4');
  assert.equal(normalizeVideoMime('Video/MP4; codecs=avc1'), 'video/mp4');
  assert.equal(normalizeVideoMime('video/mov'), 'video/quicktime');
  assert.equal(normalizeVideoMime('video/x-msvideo'), 'video/avi');
  assert.equal(normalizeVideoMime('video/x-ms-wmv'), 'video/wmv');
  assert.equal(normalizeVideoMime('', 'clip.MOV'), 'video/quicktime');
  assert.equal(normalizeVideoMime('', 'a.qt'), 'video/quicktime');
  assert.equal(normalizeVideoMime('', 'a.m4v'), 'video/mp4');
  assert.equal(normalizeVideoMime('', 'a.3gp'), 'video/3gpp');
  assert.equal(normalizeVideoMime('', 'a.webm'), 'video/webm');
  assert.equal(normalizeVideoMime('', 'a.avi'), 'video/avi');
  assert.equal(normalizeVideoMime('', 'movie.mkv'), 'video/x-matroska');
  assert.equal(GEMINI_VIDEO_MIMES.has('video/x-matroska'), false);
  assert.equal(normalizeVideoMime('', 'notes.txt'), '');
  assert.equal(normalizeVideoMime(undefined, 'a.constructor'), '');
});
test('isVideoFile uses the type, or the extension when the type is empty', () => {
  assert.equal(isVideoFile({ type: 'video/quicktime', name: 'x' }), true);
  assert.equal(isVideoFile({ type: '', name: 'IMG_1.MOV' }), true);
  assert.equal(isVideoFile({ type: 'image/png', name: 'a.mp4' }), false);
  assert.equal(isVideoFile({ type: '', name: 'a.txt' }), false);
  assert.equal(isVideoFile(null), false);
});
test('cleanName strips control and bidi characters and caps at 120', () => {
  assert.equal(cleanName(' a\u0000b‮c\n.mp4 '), 'abc.mp4');
  assert.equal(cleanName('x'.repeat(300)).length, 120);
  assert.equal(cleanName('x'.repeat(119) + '😀'), 'x'.repeat(119)); // no lone surrogate at the cut
  assert.equal(cleanName(42), '');
});
test('frameCount follows the contract', () => {
  for (const d of [0, NaN, Infinity, -3]) assert.equal(frameCount(d), 8);
  assert.equal(frameCount(1), 4); assert.equal(frameCount(10), 6); assert.equal(frameCount(30), 12); assert.equal(frameCount(3600), 16);
});
test('frameTimes are strictly increasing inside [0, d)', () => {
  for (const d of [0.5, 1, 2, 7.3, 30, 600, 3600]) {
    const n = frameCount(d), ts = frameTimes(d, n);
    assert.equal(ts.length, n);
    ts.forEach((t, i) => { assert.ok(t >= 0 && t < d); if (i) assert.ok(t > ts[i - 1]); });
  }
  assert.deepEqual(frameTimes(10, 2), [2.5, 7.5]);
  assert.ok(frameTimes(0.1, 4).every((t, i, a) => t < 0.1 && (!i || t > a[i - 1])));
  assert.deepEqual(frameTimes(Infinity), []); assert.deepEqual(frameTimes(0), []);
});
test('sampleOrder goes ends first, then midpoints, and covers every slot once', () => {
  assert.deepEqual(sampleOrder(6), [0, 5, 2, 1, 3, 4]);
  assert.deepEqual(sampleOrder(1), [0]); assert.deepEqual(sampleOrder(2), [0, 1]); assert.deepEqual(sampleOrder(0), []);
  for (let n = 1; n <= 16; n++) assert.deepEqual([...sampleOrder(n)].sort((a, b) => a - b), [...Array(n).keys()], String(n));
  const o = sampleOrder(16); // any prefix of 3+ slots reaches both ends and the middle
  assert.deepEqual(o.slice(0, 3), [0, 15, 7]);
});
test('fmtDur formats m:ss and h:mm:ss', () => {
  assert.equal(fmtDur(7), '0:07'); assert.equal(fmtDur(75.4), '1:15'); assert.equal(fmtDur(3725), '1:02:05'); assert.equal(fmtDur(600), '10:00');
  for (const s of [0, NaN, Infinity, -1, undefined]) assert.equal(fmtDur(s), '');
});
test('pickFrames keeps first and last and spaces the rest evenly', () => {
  const all = frames(16), picked = pickFrames(all, 8);
  assert.equal(picked.length, 8); assert.equal(picked[0], all[0]); assert.equal(picked[7], all[15]);
  assert.equal(new Set(picked).size, 8);
  assert.ok(picked.every((f, i) => !i || all.indexOf(f) > all.indexOf(picked[i - 1])));
  assert.deepEqual(pickFrames(frames(5), 8), frames(5));
  assert.deepEqual(pickFrames(all, 1), [all[0]]); assert.deepEqual(pickFrames(null, 8), []);
});
test('frameCapFor', () => {
  for (const p of ['gemini', 'anthropic', 'openai', 'gemini:gemini-3.8-flash']) assert.equal(frameCapFor(p), 16);
  for (const p of ['nvidia', 'zai', 'meta', 'google/gemma-4-31b-it', undefined]) assert.equal(frameCapFor(p), 8);
});
test('clipEligible and clipReason', () => {
  const ok = { mime: 'video/mp4', size: 5e6, duration: 30 };
  assert.equal(clipReason(ok), null); assert.equal(clipEligible(ok), true);
  assert.equal(clipReason({ ...ok, size: CLIP_MAX_BYTES }), null);
  assert.equal(clipReason({ ...ok, size: CLIP_MAX_BYTES + 1 }), 'too-large');
  assert.equal(clipReason({ ...ok, duration: CLIP_MAX_SECONDS }), null);
  assert.equal(clipReason({ ...ok, duration: 601 }), 'too-long');
  assert.equal(clipReason({ ...ok, duration: 0 }), null); assert.equal(clipReason({ ...ok, duration: Infinity }), null);
  assert.equal(clipReason({ ...ok, mime: 'video/x-matroska' }), 'type'); assert.equal(clipEligible({ ...ok, mime: 'video/x-matroska' }), false);
  assert.equal(clipReason({ ...ok, mime: 'video/quicktime' }), null);
  assert.equal(clipReason({ ...ok, size: 0 }), 'empty'); assert.equal(clipReason(null), 'type');
});
test('fileValid needs a Gemini file that has more than the margin left', () => {
  const now = 1_000_000_000_000, f = { name: 'files/abc', uri: URI('abc'), mime: 'video/mp4', expiresAt: now + FILE_EXPIRY_MARGIN_MS + 1 };
  assert.equal(fileValid(f, now), true);
  assert.equal(fileValid({ ...f, expiresAt: now + FILE_EXPIRY_MARGIN_MS }, now), false);
  assert.equal(fileValid({ ...f, uri: 'https://evil.example/v1beta/files/abc' }, now), false);
  assert.equal(fileValid({ ...f, name: '../x' }, now), false);
  assert.equal(fileValid(null, now), false);
});
test('toFileRef trims to {name, uri, mime, expiresAt}', () => {
  const now = 5;
  assert.deepEqual(toFileRef({ name: 'files/a', uri: URI('a'), mimeType: 'video/mp4', expiresAt: 99, state: 'ACTIVE', session: 'x' }, now), { name: 'files/a', uri: URI('a'), mime: 'video/mp4', expiresAt: 99 });
  assert.equal(toFileRef({ name: 'files/a', uri: URI('a') }, now).expiresAt, now + 47 * 3600e3);
  assert.equal(toFileRef({ name: 'files/a', uri: 'https://generativelanguage.googleapis.com/v1beta/files/a/../b' }), null);
});
test('videoParts: clip plan', () => {
  const file = { name: 'files/abc', uri: URI('abc'), mime: 'video/quicktime', expiresAt: 1 };
  assert.deepEqual(videoParts({ name: 'beach.mov', duration: 75, frames: frames(4) }, { kind: 'clip', file }), [
    { type: 'text', text: 'The user attached a video ("beach.mov"), 1:15 long. You can watch it and hear its audio. Refer to moments by timestamp (m:ss).' },
    { type: 'video_file', video_file: { file_uri: URI('abc'), mime_type: 'video/quicktime' } },
  ]);
  assert.equal(videoParts({ name: '', duration: 0 }, { kind: 'clip', file })[0].text, 'The user attached a video. You can watch it and hear its audio. Refer to moments by timestamp (m:ss).');
});
test('videoParts: frames plan interleaves labels and images', () => {
  const video = { name: 'a.mp4', duration: 20, frames: frames(10) };
  const parts = videoParts(video, { kind: 'frames', cap: 8 });
  assert.equal(parts.length, 1 + 8 * 2);
  assert.equal(parts[0].text, 'The user attached a video ("a.mp4"), 0:20 long. You can\'t play it: below are 8 still frames sampled evenly across it, each labeled with its timestamp, and there is no audio. If the answer depends on sound or on motion between frames, say so.');
  assert.deepEqual(parts[1], { type: 'text', text: 'Frame 1 of 8 · 0:01' }); // t 0.5 rounds to 0:01
  assert.deepEqual(parts[2], { type: 'image_url', image_url: { url: video.frames[0].src } });
  assert.deepEqual(parts[15], { type: 'text', text: 'Frame 8 of 8 · 0:19' });
  assert.equal(videoParts({ ...video, frames: [{ t: 0, src: JPEG(4) }] }, { kind: 'frames', cap: 16 })[1].text, 'Frame 1 of 1 · 0:00');
  assert.deepEqual(videoParts({ ...video, frames: [] }, { kind: 'frames', cap: 8 }), []);
  assert.deepEqual(videoParts(video, null), []);
});
test('planFor picks the clip only for Gemini with a file, otherwise frames at the provider cap', () => {
  const file = { name: 'files/a', uri: URI('a'), mime: 'video/mp4', expiresAt: 1 }, video = { frames: frames(12) };
  assert.deepEqual(planFor(video, 'gemini', file), { kind: 'clip', file });
  assert.deepEqual(planFor(video, 'anthropic', file), { kind: 'frames', cap: 16, n: 12 });
  assert.deepEqual(planFor(video, 'nvidia', null), { kind: 'frames', cap: 8, n: 8 });
  assert.deepEqual(planFor(video, 'gemini', null), { kind: 'frames', cap: 16, n: 12 });
  assert.equal(planFor({ frames: [] }, 'openai', null), null);
  assert.deepEqual(framesPlan(video, 8), { kind: 'frames', cap: 8, n: 8 });
});
test('noteFor gives the exact meta.note strings', () => {
  const clip = { kind: 'clip', file: {} }, f12 = { kind: 'frames', cap: 16, n: 12 };
  assert.equal(noteFor(clip), 'video · full clip with audio');
  assert.equal(noteFor(clip, { followUp: true, why: 'expired' }), 'about the video · full clip with audio');
  assert.equal(noteFor(f12), 'video · 12 frames');
  assert.equal(noteFor(f12, { followUp: true }), 'about the video · 12 frames');
  assert.equal(noteFor(f12, { why: 'upload-failed' }), 'video · 12 frames · clip upload failed');
  assert.equal(noteFor(f12, { why: 'expired' }), 'video · 12 frames · clip expired');
  assert.equal(noteFor(f12, { why: 'too-large' }), 'video · 12 frames · over 1 GB for full clip');
  assert.equal(noteFor(f12, { why: 'too-long', followUp: true }), 'about the video · 12 frames · over 10 min for full clip');
  assert.equal(noteFor(f12, { why: 'type' }), 'video · 12 frames');
  assert.equal(noteFor(f12, { why: 'constructor' }), 'video · 12 frames');
  assert.equal(noteFor({ kind: 'frames', cap: 8 }, { count: 5 }), 'video · 5 frames');
  assert.equal(noteFor(null), '');
});
test('dataUrlBytes and fitSize', () => {
  assert.equal(dataUrlBytes('data:image/jpeg;base64,YQ=='), 1); assert.equal(dataUrlBytes('data:image/jpeg;base64,YWI='), 2); assert.equal(dataUrlBytes('data:,'), 0);
  assert.equal(dataUrlBytes(`data:image/jpeg;base64,${Buffer.alloc(9000).toString('base64')}`), 9000);
  assert.deepEqual(fitSize(1920, 1080, 768), { w: 768, h: 432 }); assert.deepEqual(fitSize(1080, 1920, 768), { w: 432, h: 768 });
  assert.deepEqual(fitSize(320, 240, 768), { w: 320, h: 240 }); assert.deepEqual(fitSize(0, 10, 768), { w: 0, h: 0 });
});

// ── persisted shape ──
const goodVideo = () => ({ name: 'clip.mov', mime: 'video/quicktime', size: 1234, duration: 12.5, width: 1080, height: 1920, poster: JPEG(8),
  frames: [{ t: 0.9, src: JPEG(8) }, { t: 11.6, src: 'data:image/webp;base64,AAAA' }],
  file: { name: 'files/abc-1', uri: URI('abc-1'), mime: 'video/quicktime', expiresAt: 1_900_000_000_000 } });
test('validVideo accepts the persisted shapes', () => {
  assert.equal(validVideo(goodVideo()), true);
  assert.equal(validVideo({ name: '', mime: 'video/mp4', size: 0, duration: 0, width: 0, height: 0, poster: null, frames: [], clipOnly: true }), true);
  assert.equal(validVideo(storedVideo(goodVideo())), true);
});
test('validVideo rejects unsafe or malformed data', () => {
  const bad = [v => v.frames[0].src = 'data:video/mp4;base64,AAAA', v => v.frames[0].src = 'https://example.com/f.jpg', v => v.poster = 'javascript:alert(1)',
    v => v.frames = Array.from({ length: 33 }, () => ({ t: 1, src: JPEG(4) })), v => v.duration = NaN, v => v.size = -1,
    v => v.file.uri = 'https://evil.example/v1beta/files/x', v => v.file.name = '../x', v => v.name = 5, v => v.mime = 'text/html', v => v.frames = {},
    v => v.clipOnly = 'yes', v => v.width = -2, v => v.frames[0].t = -1, v => v.poster = 'data:image/svg+xml;base64,AAAA', v => v.file.expiresAt = NaN, v => v.name = 'x'.repeat(201)];
  for (const mutate of bad) { const v = goodVideo(); mutate(v); assert.equal(validVideo(v), false, String(mutate)); }
  for (const v of [null, [], 'video']) assert.equal(validVideo(v), false);
});
test('storedVideo keeps only persisted fields', () => {
  const info = { ...goodVideo(), url: 'blob:x', session: 'https://secret', status: 'ready', progress: 1, clip: {}, file: undefined, reason: 'x', clipOnly: false };
  const ref = { name: 'files/z', uri: URI('z'), mime: 'video/quicktime', expiresAt: 42, state: 'ACTIVE' };
  const s = storedVideo(info, ref);
  assert.deepEqual(Object.keys(s).sort(), ['duration', 'file', 'frames', 'height', 'mime', 'name', 'poster', 'size', 'width']);
  assert.deepEqual(s.file, { name: 'files/z', uri: URI('z'), mime: 'video/quicktime', expiresAt: 42 });
  const only = storedVideo({ name: 'a.mov', mime: '', size: 9, duration: Infinity, poster: JPEG(4), frames: frames(2), clipOnly: true });
  assert.deepEqual(only, { name: 'a.mov', mime: 'video/unknown', size: 9, duration: 0, width: 0, height: 0, poster: null, frames: [], clipOnly: true });
  assert.ok(!JSON.stringify(s).includes('blob:') && !JSON.stringify(s).includes('secret'));
});

// ── constants shared with the Worker (src/gemini.js lands in the backend phase) ──
const geminiPath = new URL('../src/gemini.js', import.meta.url);
test('constants match src/gemini.js', { skip: !existsSync(geminiPath) && 'src/gemini.js not written yet' }, async () => {
  registerHooks({ resolve: (s, c, next) => s === 'cloudflare:workers' ? { url: 'data:text/javascript,export class DurableObject {} export const waitUntil = () => {};', shortCircuit: true } : next(s, c) });
  const G = await import(geminiPath.href);
  assert.deepEqual([...G.GEMINI_VIDEO_MIMES].sort(), [...GEMINI_VIDEO_MIMES].sort());
  assert.equal(G.CLIP_MAX_BYTES, CLIP_MAX_BYTES);
  if ('CHUNK_MAX' in G) assert.equal(G.CHUNK_MAX, CHUNK_MAX);
  if ('GRANULARITY_DEFAULT' in G) assert.equal(G.GRANULARITY_DEFAULT, GRANULARITY_DEFAULT);
  for (const [t, n] of [['video/quicktime', ''], ['video/x-m4v', ''], ['VIDEO/MP4; codecs=avc1', ''], ['video/mov', ''], ['video/x-msvideo', ''], ['video/x-ms-wmv', ''],
    ['', 'clip.MOV'], ['', 'a.mp4'], ['', 'a.m4v'], ['', 'a.qt'], ['', 'a.webm'], ['', 'a.3gp'], ['', 'a.avi'], ['', 'movie.mkv'], ['', 'x.txt'], ['video/webm', 'a.mp4']]) {
    assert.equal(G.normalizeVideoMime(t, n), normalizeVideoMime(t, n), `${t} ${n}`);
  }
  if (G.isFileName) for (const n of ['files/abc', 'files/../x', 'files/', 'x/abc']) assert.equal(G.isFileName(n), V.isFileName(n), n);
  if (G.isGeminiFileUri) for (const u of [URI('abc'), 'https://evil.example/v1beta/files/abc', `${URI('abc')}?x=1`]) assert.equal(G.isGeminiFileUri(u), V.isGeminiFileUri(u), u);
});

// ── uploader (fetch mocked; node has no XMLHttpRequest, so chunk PUTs use fetch) ──
const realFetch = globalThis.fetch;
const SESSION = 'https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=secret-session';
const EXPIRES = 1_900_000_000_000;
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let calls = [];
function mockFetch(routes) {
  globalThis.fetch = async (input, init = {}) => {
    const call = { url: String(input), method: init.method || 'GET', headers: new Headers(init.headers), body: init.body, keepalive: init.keepalive, signal: init.signal };
    calls.push(call);
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    for (const [pattern, handler] of routes) if (pattern.test(`${call.method} ${call.url}`)) return handler(call);
    throw new Error(`unmocked fetch ${call.method} ${call.url}`);
  };
}
beforeEach(() => { calls = []; });
const bytes = n => Uint8Array.from({ length: n }, (_, i) => i);
const clipFile = (n = 10, type = 'video/quicktime', name = 'clip.mov') => new File([bytes(n)], name, { type });
const q = (c, k) => new URL(c.url, 'http://x').searchParams.get(k);
const doneFile = (state = 'PROCESSING', extra = {}) => ({ done: true, file: { name: 'files/abc', uri: URI('abc'), mime: 'video/quicktime', state, size: 10, expiresAt: EXPIRES, ...extra } });
// A fetch that only ends when its signal aborts (a request the network or the Worker never answers).
const hang = c => new Promise((_, rej) => c.signal?.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError'))));
// server.received: what the fake Google holds (commit() adds a chunk without answering, like a lost response).
function uploadRoutes({ chunk = 4, final = doneFile(), states = ['PROCESSING', 'ACTIVE'], onChunk, onQuery, server = {} } = {}) {
  let polls = 0;
  server.received = 0;
  return [
    [/^POST \/api\/video\/upload\/start$/, () => reply(200, { session: SESSION, chunk })],
    [/^PUT \/api\/video\/upload\/chunk\?/, async c => {
      const off = Number(q(c, 'offset')), total = Number(q(c, 'total')), len = (await c.body.arrayBuffer()).byteLength;
      const commit = () => { server.received = off + len; server.final = off + len === total; };
      const custom = await onChunk?.(c, off, len, commit); if (custom) return custom;
      commit();
      return off + len === total ? reply(200, final) : reply(200, { received: off + len });
    }],
    [/^POST \/api\/video\/upload\/query\?total=\d+$/, c => {
      assert.equal(c.headers.get('x-upload-session'), SESSION);
      return onQuery?.(c) || (server.final ? reply(200, final) : reply(200, { received: server.received }));
    }],
    [/^GET \/api\/video\/file\?name=files%2Fabc$/, () => reply(200, { name: 'files/abc', uri: URI('abc'), mime: 'video/quicktime', state: states[Math.min(polls++, states.length - 1)], expiresAt: EXPIRES })],
    [/^POST \/api\/video\/upload\/cancel$/, () => reply(200, { ok: true })],
    [/^DELETE \/api\/video\/file\?name=files%2Fabc$/, () => reply(200, { ok: true })],
  ];
}
const apiHeaders = (extra = {}) => ({ 'content-type': 'application/json', ...extra, 'x-app-pass': 'pw' });
const byRoute = re => calls.filter(c => re.test(`${c.method} ${c.url}`));

test('uploadClip: start, chunk PUTs, finalize, poll until ACTIVE → FileRef', async () => {
  mockFetch(uploadRoutes());
  const seen = [];
  const ref = await uploadClip(clipFile(), { apiHeaders, onProgress: (p, s) => seen.push([p, s]) });
  assert.deepEqual(ref, { name: 'files/abc', uri: URI('abc'), mime: 'video/quicktime', expiresAt: EXPIRES });
  const [start] = byRoute(/^POST \/api\/video\/upload\/start/);
  assert.deepEqual(JSON.parse(start.body), { name: 'clip.mov', mime: 'video/quicktime', size: 10 });
  assert.equal(start.headers.get('x-app-pass'), 'pw'); assert.equal(start.headers.get('content-type'), 'application/json');
  const chunks = byRoute(/^PUT /);
  assert.deepEqual(chunks.map(c => [q(c, 'offset'), q(c, 'total')]), [['0', '10'], ['4', '10'], ['8', '10']]);
  for (const c of chunks) {
    assert.equal(c.headers.get('x-upload-session'), SESSION); assert.equal(c.headers.get('x-app-pass'), 'pw');
    assert.equal(c.headers.get('content-type'), 'application/octet-stream');
  }
  assert.deepEqual([...new Uint8Array(await chunks[2].body.arrayBuffer())], [8, 9]);
  assert.equal(byRoute(/^GET \/api\/video\/file/).length, 2);
  assert.equal(byRoute(/cancel|DELETE/).length, 0);
  assert.ok(seen.every(([p], i) => p >= 0 && p <= 1 && (!i || p >= seen[i - 1][0])));
  assert.deepEqual(seen.at(-1), [1, 'active']);
  assert.ok(seen.some(([, s]) => s === 'processing') && seen.some(([, s]) => s === 'uploading'));
  assert.ok(!calls.some(c => c.url.includes('secret-session')), 'the session only travels in a header');
});
test('uploadClip accepts a headers object and returns immediately when the file is already ACTIVE', async () => {
  mockFetch(uploadRoutes({ chunk: 16, final: doneFile('ACTIVE') }));
  const ref = await uploadClip(clipFile(10, 'video/mp4', 'a.mp4'), { apiHeaders: { 'x-app-pass': 'pw' } });
  assert.equal(ref.name, 'files/abc'); assert.equal(byRoute(/^GET /).length, 0);
  assert.equal(byRoute(/^PUT /)[0].headers.get('x-app-pass'), 'pw');
});
test('uploadClip wait:false returns right after finalize with the state', async () => {
  mockFetch(uploadRoutes());
  const ref = await uploadClip(clipFile(), { apiHeaders, wait: false });
  assert.equal(ref.state, 'PROCESSING'); assert.equal(byRoute(/^GET /).length, 0);
});
test('uploadClip rejects ineligible files before any request', async () => {
  mockFetch([]);
  await assert.rejects(uploadClip(clipFile(10, 'video/x-matroska', 'a.mkv'), { apiHeaders }), { code: 'type', status: 415 });
  await assert.rejects(uploadClip({ size: CLIP_MAX_BYTES + 1, type: 'video/mp4', name: 'a.mp4' }, { apiHeaders }), { code: 'too-large', status: 413 });
  assert.equal(calls.length, 0);
});
test('uploadClip surfaces start errors from the Worker', async () => {
  mockFetch([[/upload\/start/, () => reply(415, { error: 'Gemini can’t take this video type…' })]]);
  await assert.rejects(uploadClip(clipFile(), { apiHeaders }), { status: 415, code: 'type', message: 'Gemini can’t take this video type…' });
  mockFetch([[/upload\/start/, () => reply(401, { error: 'Wrong passcode' })]]);
  await assert.rejects(uploadClip(clipFile(), { apiHeaders }), { status: 401, message: 'Wrong passcode' });
});
test('uploadClip cancels the session when a chunk is rejected', async () => {
  mockFetch(uploadRoutes({ onChunk: (c, off) => off === 4 && reply(409, { error: 'Upload out of sync — try attaching again.' }) }));
  await assert.rejects(uploadClip(clipFile(), { apiHeaders }), { status: 409, code: 'sync' });
  assert.equal(byRoute(/^PUT /).length, 2);
  const [cancel] = byRoute(/cancel/);
  assert.equal(cancel.headers.get('x-upload-session'), SESSION); assert.equal(cancel.headers.get('x-app-pass'), 'pw');
});
test('uploadClip retries a chunk after a 502 or a dropped connection', async () => {
  let fails = 2;
  mockFetch(uploadRoutes({ onChunk: (c, off) => {
    if (off === 4 && fails === 2) { fails--; return reply(502, { error: 'bad gateway' }); }
    if (off === 4 && fails === 1) { fails--; throw new TypeError('fetch failed'); }
  } }));
  const ref = await uploadClip(clipFile(), { apiHeaders });
  assert.equal(ref.name, 'files/abc');
  assert.deepEqual(byRoute(/^PUT /).map(c => q(c, 'offset')), ['0', '4', '4', '4', '8']);
});
test('uploadClip gives up after the retries and cancels', async () => {
  mockFetch(uploadRoutes({ onChunk: () => reply(503, { error: 'busy' }) }));
  await assert.rejects(uploadClip(clipFile(), { apiHeaders }), { status: 503 });
  assert.equal(byRoute(/^PUT /).length, CHUNK_RETRIES + 1); assert.equal(byRoute(/cancel/).length, 1);
  assert.equal(byRoute(/upload\/query/).length, CHUNK_RETRIES, 'it asks where Google stands before each retry');
});
test('uploadClip retries 408, 429 and 500 too, but not other 4xx', async () => {
  for (const status of [408, 429, 500]) {
    calls = [];
    let n = 0;
    mockFetch(uploadRoutes({ onChunk: (c, off) => off === 4 && n++ === 0 && reply(status, { error: 'x' }) }));
    assert.equal((await uploadClip(clipFile(), { apiHeaders })).name, 'files/abc', String(status));
    assert.deepEqual(byRoute(/^PUT /).map(c => q(c, 'offset')), ['0', '4', '4', '8']);
  }
  calls = [];
  mockFetch(uploadRoutes({ onChunk: (c, off) => off === 4 && reply(400, { error: 'Bad chunk offset' }) }));
  await assert.rejects(uploadClip(clipFile(), { apiHeaders }), { status: 400, message: 'Bad chunk offset' });
  assert.equal(byRoute(/^PUT /).length, 2); assert.equal(byRoute(/cancel/).length, 1);
});
test('a lost answer resumes from what Google holds instead of re-sending or starting over', async () => {
  // Middle chunk committed but the connection dropped before the answer: the query says 8 → carry on at 8.
  let dropped = false;
  mockFetch(uploadRoutes({ onChunk: (c, off, len, commit) => { if (off === 4 && !dropped) { dropped = true; commit(); throw new TypeError('socket hang up'); } } }));
  assert.equal((await uploadClip(clipFile(), { apiHeaders })).name, 'files/abc');
  assert.deepEqual(byRoute(/^PUT /).map(c => q(c, 'offset')), ['0', '4', '8']);
  assert.equal(byRoute(/cancel/).length, 0);
  // Final chunk finalized but its answer lost: the query hands back the file.
  calls = []; dropped = false;
  mockFetch(uploadRoutes({ onChunk: (c, off, len, commit) => { if (off === 8 && !dropped) { dropped = true; commit(); throw new TypeError('socket hang up'); } } }));
  assert.equal((await uploadClip(clipFile(), { apiHeaders })).name, 'files/abc');
  assert.deepEqual(byRoute(/^PUT /).map(c => q(c, 'offset')), ['0', '4', '8']);
  // The query fails too, so the chunk is re-sent; Google already has it (409), and the next query shows it arrived.
  calls = []; dropped = false;
  let queries = 0;
  mockFetch(uploadRoutes({
    onQuery: () => ++queries === 1 && reply(502, { error: 'busy' }),
    onChunk: (c, off, len, commit) => {
      if (off !== 4) return;
      if (!dropped) { dropped = true; commit(); throw new TypeError('socket hang up'); }
      return reply(409, { error: 'Upload out of sync — try attaching again.' });
    },
  }));
  assert.equal((await uploadClip(clipFile(), { apiHeaders })).name, 'files/abc');
  assert.deepEqual(byRoute(/^PUT /).map(c => q(c, 'offset')), ['0', '4', '4', '8']);
  assert.equal(queries, 2);
  // A 409 while Google still sits at this chunk's start is a real mismatch: no blind retry.
  calls = [];
  mockFetch(uploadRoutes({ onChunk: (c, off) => off === 4 && reply(409, { error: 'Upload out of sync — try attaching again.' }) }));
  await assert.rejects(uploadClip(clipFile(), { apiHeaders }), { code: 'sync', status: 409 });
  assert.equal(byRoute(/^PUT /).length, 2); assert.equal(byRoute(/upload\/query/).length, 1); assert.equal(byRoute(/cancel/).length, 1);
});
test('a chunk Google kept part of is finished from that 8 MiB boundary', async () => {
  const size = 2 * GRANULARITY_DEFAULT + 10, server = {};
  let cut = false;
  mockFetch(uploadRoutes({ chunk: 2 * GRANULARITY_DEFAULT, server, final: { ...doneFile('ACTIVE'), file: { ...doneFile('ACTIVE').file, size } }, onChunk: (c, off) => {
    if (off === 0 && !cut) { cut = true; server.received = GRANULARITY_DEFAULT; throw new TypeError('connection reset'); }
  } }));
  const ref = await uploadClip(new File([new Uint8Array(size)], 'big.mp4', { type: 'video/mp4' }), { apiHeaders });
  assert.equal(ref.name, 'files/abc');
  assert.deepEqual(byRoute(/^PUT /).map(c => q(c, 'offset')), ['0', String(GRANULARITY_DEFAULT), String(2 * GRANULARITY_DEFAULT)]);
});
test('connections dropped while the page is hidden don’t use up the retries, and wait for the page to come back', async () => {
  const doc = globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'hidden' });
  let n = 0;
  mockFetch(uploadRoutes({ onChunk: (c, off) => {
    if (off !== 4) return;
    if (++n === CHUNK_RETRIES + 3) { doc.visibilityState = 'visible'; return; } // back in front: this one goes through
    throw new TypeError('Network error');
  } }));
  const t0 = Date.now();
  assert.equal((await uploadClip(clipFile(), { apiHeaders })).name, 'files/abc');
  assert.equal(n, CHUNK_RETRIES + 3);
  assert.ok(Date.now() - t0 >= (CHUNK_RETRIES + 2) * VIDEO_TIMING.offline * 0.9, 'each hidden retry waited (up to T.offline) for the page');
  // Coming back to the page ends the wait at once.
  calls = []; n = 0; doc.visibilityState = 'hidden'; VIDEO_TIMING.offline = 60000;
  mockFetch(uploadRoutes({ onChunk: (c, off) => {
    if (off !== 4 || n++) return;
    setTimeout(() => { doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange')); }, 30);
    throw new TypeError('Network error');
  } }));
  const t1 = Date.now();
  assert.equal((await uploadClip(clipFile(), { apiHeaders })).name, 'files/abc');
  assert.ok(Date.now() - t1 < 2000);
  assert.deepEqual(byRoute(/^PUT /).map(c => q(c, 'offset')), ['0', '4', '4', '8']);
});
test('answers the server sent use up the retries even while the page is hidden', async () => {
  globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'hidden' });
  for (const [status, headers] of [[502, {}], [503, { 'retry-after': '1' }]]) {
    calls = [];
    mockFetch(uploadRoutes({ onChunk: () => new Response(JSON.stringify({ error: 'Google said no' }), { status, headers: { 'content-type': 'application/json', ...headers } }),
      onQuery: () => reply(200, { received: 0 }) }));
    await assert.rejects(uploadClip(clipFile(), { apiHeaders }), { status, message: 'Google said no' });
    assert.equal(byRoute(/^PUT /).length, CHUNK_RETRIES + 1, String(status)); assert.equal(byRoute(/cancel/).length, 1);
  }
});
test('a hidden page whose connection keeps dropping still gives up after a bounded number of attempts', async () => {
  globalThis.document = { visibilityState: 'hidden' }; // no events: nothing to wait for
  mockFetch(uploadRoutes({ onChunk: () => { throw new TypeError('Network error'); } }));
  await assert.rejects(uploadClip(clipFile(), { apiHeaders }), { code: 'network', status: 0 });
  assert.equal(byRoute(/^PUT /).length, CHUNK_RETRIES * 4); assert.equal(byRoute(/cancel/).length, 1);
});
test('a chunk upload that stalls is abandoned and retried, then the job settles', async () => {
  VIDEO_TIMING.stall = 25; VIDEO_TIMING.answer = 25;
  const xhrs = [];
  let routes = uploadRoutes(), stallFirst = 1; // how many sends hang (Infinity: all of them)
  mockFetch(routes);
  globalThis.XMLHttpRequest = class {
    constructor() { this.upload = {}; this.headers = {}; xhrs.push(this); }
    open(method, url) { Object.assign(this, { method, url }); }
    setRequestHeader(k, v) { this.headers[k] = v; }
    getResponseHeader() { return null; }
    abort() { this.aborted = true; this.onabort?.(); }
    send(body) {
      if (stallFirst-- > 0) { setTimeout(() => this.upload.onprogress?.({ loaded: 1 }), 1); return; } // a byte, then nothing
      setTimeout(async () => {
        const r = await routes[1][1]({ url: this.url, method: 'PUT', headers: new Headers(this.headers), body });
        Object.assign(this, { status: r.status, responseText: await r.text() });
        this.onload();
      }, 1);
    }
  };
  assert.equal((await uploadClip(clipFile(), { apiHeaders })).name, 'files/abc');
  assert.equal(xhrs[0].aborted, true);
  assert.deepEqual(xhrs.map(x => new URL(x.url, 'http://x').searchParams.get('offset')), ['0', '0', '4', '8']);
  // Never answering at all: the job fails as a network error (not a hang, not an AbortError) and cancels the session.
  calls = []; xhrs.length = 0; stallFirst = Infinity;
  mockFetch(routes = uploadRoutes());
  const job = startClip(clipFile(), { apiHeaders });
  assert.equal(await job.promise, null);
  assert.equal(job.state, 'failed'); assert.equal(job.error.code, 'network'); assert.notEqual(job.error.name, 'AbortError');
  assert.equal(xhrs.length, CHUNK_RETRIES + 1); assert.equal(byRoute(/cancel/).length, 1);
});
test('an upload start or poll that never answers times out instead of hanging', async () => {
  VIDEO_TIMING.request = 30;
  mockFetch([[/upload\/start/, hang], [/cancel/, () => reply(200, { ok: true })]]);
  const t0 = realNow();
  await assert.rejects(uploadClip(clipFile(), { apiHeaders }), { code: 'timeout', status: 0 });
  assert.ok(realNow() - t0 < 1000); assert.equal(byRoute(/^PUT /).length, 0);
  mockFetch([[/upload\/start/, () => { throw new TypeError('offline'); }]]);
  await assert.rejects(uploadClip(clipFile(), { apiHeaders }), { code: 'network' });
  // each poll is capped by what is left of pollMax, even when T.request is longer
  VIDEO_TIMING.request = 5000; VIDEO_TIMING.pollMax = 60;
  mockFetch([[/^GET \/api\/video\/file/, hang]]);
  const t1 = realNow();
  await assert.rejects(waitClipActive('files/abc', { apiHeaders }), { code: 'timeout' });
  assert.ok(realNow() - t1 < 1000, `${realNow() - t1} ms`);
  // a caller abort still wins over the timeout
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 5);
  await assert.rejects(waitClipActive('files/abc', { apiHeaders, signal: ctrl.signal }), { name: 'AbortError' });
});
test('aborting mid-upload throws AbortError and cancels the session', async () => {
  const ctrl = new AbortController();
  mockFetch(uploadRoutes({ onChunk: (c, off) => { if (off === 4) ctrl.abort(); } }));
  await assert.rejects(uploadClip(clipFile(), { apiHeaders, signal: ctrl.signal }), { name: 'AbortError' });
  assert.equal(byRoute(/cancel/).length, 1); assert.equal(byRoute(/^GET /).length, 0);
});
test('a FAILED or vanished file is deleted and reported', async () => {
  mockFetch(uploadRoutes({ final: doneFile('FAILED') }));
  await assert.rejects(uploadClip(clipFile(), { apiHeaders }), { code: 'failed' });
  assert.equal(byRoute(/^DELETE /).length, 1);
  calls = [];
  mockFetch(uploadRoutes({ states: ['PROCESSING', 'FAILED'] }));
  await assert.rejects(uploadClip(clipFile(), { apiHeaders }), { code: 'failed' });
  assert.equal(byRoute(/^DELETE /).length, 1);
});
test('aborting while Gemini processes deletes the file', async () => {
  const ctrl = new AbortController();
  mockFetch(uploadRoutes({ states: ['PROCESSING'] }));
  const p = uploadClip(clipFile(), { apiHeaders, signal: ctrl.signal, onProgress: (_, s) => { if (s === 'processing') setTimeout(() => ctrl.abort(), 12); } });
  await assert.rejects(p, { name: 'AbortError' });
  assert.equal(byRoute(/^DELETE /).length, 1); assert.equal(byRoute(/cancel/).length, 0);
});
test('waitClipActive: ACTIVE, GONE, timeout and transient errors', async () => {
  let n = 0;
  mockFetch([[/^GET \/api\/video\/file/, () => ++n === 1 ? reply(502, { error: 'x' }) : reply(200, { name: 'files/abc', uri: URI('abc'), mime: 'video/mp4', state: 'ACTIVE', expiresAt: EXPIRES })]]);
  const states = [];
  assert.deepEqual(await waitClipActive('files/abc', { apiHeaders, onState: s => states.push(s) }), { name: 'files/abc', uri: URI('abc'), mime: 'video/mp4', expiresAt: EXPIRES });
  assert.deepEqual(states, ['ACTIVE']);
  mockFetch([[/^GET /, () => reply(404, { error: 'gone', state: 'GONE' })]]);
  await assert.rejects(waitClipActive('files/abc', { apiHeaders }), { code: 'gone', status: 404 });
  mockFetch([[/^GET /, () => reply(200, { name: 'files/abc', uri: URI('abc'), state: 'PROCESSING' })]]);
  VIDEO_TIMING.pollMax = 30;
  await assert.rejects(waitClipActive('files/abc', { apiHeaders }), { code: 'timeout' });
  mockFetch([[/^GET /, () => reply(401, { error: 'Wrong passcode' })]]);
  await assert.rejects(waitClipActive('files/abc', { apiHeaders }), { status: 401, message: 'Wrong passcode' });
  await assert.rejects(waitClipActive('files/../x', { apiHeaders }), { code: 'gone' });
});
test('deleteClip is fire-and-forget and validates the name', async () => {
  mockFetch(uploadRoutes());
  assert.equal(await deleteClip('files/abc', apiHeaders), true);
  const [del] = calls; assert.equal(del.method, 'DELETE'); assert.equal(del.url, '/api/video/file?name=files%2Fabc'); assert.equal(del.headers.get('x-app-pass'), 'pw');
  assert.equal(await deleteClip('../x', apiHeaders), false); assert.equal(calls.length, 1);
  globalThis.fetch = async () => { throw new TypeError('offline'); };
  assert.equal(await deleteClip('files/abc', apiHeaders), false);
});
test('startClip tracks a ClipJob and never rejects', async () => {
  mockFetch(uploadRoutes());
  const changes = [];
  const job = startClip(clipFile(), { apiHeaders, onChange: j => changes.push(j.state) });
  assert.equal(job.state, 'uploading'); assert.equal(job.file, null);
  const ref = await job.promise;
  assert.equal(ref.name, 'files/abc'); assert.equal(job.state, 'active'); assert.equal(job.progress, 1); assert.deepEqual(job.file, ref);
  assert.ok(changes.includes('uploading') && changes.includes('processing') && changes.at(-1) === 'active');
  job.abort(); // no-op once active
  assert.equal(byRoute(/cancel|DELETE/).length, 0);

  calls = [];
  mockFetch(uploadRoutes({ onChunk: () => reply(409, { error: 'out of sync' }) }));
  const bad = startClip(clipFile(), { apiHeaders });
  assert.equal(await bad.promise, null); assert.equal(bad.state, 'failed'); assert.equal(bad.error.status, 409);

  mockFetch(uploadRoutes({ states: ['PROCESSING'] }));
  const stopped = startClip(clipFile(), { apiHeaders });
  setTimeout(() => stopped.abort(), 10);
  assert.equal(await stopped.promise, null); assert.equal(stopped.error.name, 'AbortError');
});
test('chunk PUTs go through XMLHttpRequest in browsers and report byte progress', async () => {
  const routes = uploadRoutes(), xhrs = [];
  mockFetch(routes);
  globalThis.XMLHttpRequest = class {
    constructor() { this.upload = {}; this.headers = {}; xhrs.push(this); }
    open(method, url) { Object.assign(this, { method, url }); }
    setRequestHeader(k, v) { this.headers[k] = v; }
    abort() { this.onabort?.(); }
    send(body) {
      setTimeout(async () => {
        this.upload.onprogress?.({ loaded: Math.floor(body.size / 2) });
        const r = await routes[1][1]({ url: this.url, method: 'PUT', headers: new Headers(this.headers), body });
        Object.assign(this, { status: r.status, responseText: await r.text() });
        this.onload();
      }, 1);
    }
  };
  const seen = [];
  const ref = await uploadClip(clipFile(), { apiHeaders, onProgress: p => seen.push(p) });
  assert.equal(ref.name, 'files/abc');
  assert.equal(xhrs.length, 3); assert.equal(xhrs[0].method, 'PUT'); assert.equal(xhrs[0].headers['x-upload-session'], SESSION);
  assert.equal(xhrs[1].url, '/api/video/upload/chunk?offset=4&total=10');
  assert.ok(seen.includes(0.2) && seen.includes(0.6), 'mid-chunk progress'); // 0 + 2/10, 4 + 2/10
  assert.equal(byRoute(/^PUT /).length, 0);
});
test('progress never steps back when a chunk is retried', async () => {
  mockFetch(uploadRoutes({ chunk: 16, final: doneFile('ACTIVE') }));
  let sends = 0;
  globalThis.XMLHttpRequest = class {
    constructor() { this.upload = {}; }
    open() {} setRequestHeader() {} abort() {}
    send(body) {
      const first = ++sends === 1;
      setTimeout(() => {
        this.upload.onprogress?.({ loaded: first ? body.size : 3 });
        Object.assign(this, first ? { status: 503, responseText: '{"error":"busy"}' } : { status: 200, responseText: JSON.stringify(doneFile('ACTIVE')) });
        this.onload();
      }, 1);
    }
  };
  const seen = [];
  await uploadClip(clipFile(), { apiHeaders, onProgress: p => seen.push(p) });
  assert.equal(sends, 2);
  assert.ok(seen.every((p, i) => !i || p >= seen[i - 1]), seen.join(','));
});

// ── sampler (a scripted fake <video>/<canvas>; the real thing is checked in a browser) ──
// spec: w, h, duration, realDuration, error, hangMeta, hangAt(t), blank(t, n), density, hidden, plus
//   errorAfter: n  — the (n+1)th seek raises a decode error
//   staleFrom: x   — seeks to t >= x "complete" but decode nothing: the picture stays, no frame is presented
//   present(t)     — the frame time a seek to t actually shows (default t)
//   mediaTime      — requestVideoFrameCallback reports the presented frame's mediaTime (a function: reports fn(frame time))
//   quality        — getVideoPlaybackQuality() counts decoded frames
//   onSeek(t, video, doc) — runs as each seek starts
function fakeDom(spec) {
  const made = { videos: [], canvases: [] };
  class FakeVideo extends EventTarget {
    constructor() { super(); Object.assign(this, { attrs: {}, style: {}, readyState: 0, videoWidth: 0, videoHeight: 0, duration: NaN, seeking: false, error: null, seeks: [], t: 0, rid: 0, shownT: 0, decodedFrames: 0, goodSeeks: 0, cbs: new Map() }); made.videos.push(this); }
    setAttribute(k, v) { this.attrs[k] = v; }
    removeAttribute(k) { delete this.attrs[k]; if (k === 'src') this._src = ''; }
    get src() { return this._src; }
    set src(u) {
      this._src = u;
      setTimeout(() => {
        if (spec.error) { this.error = { code: 4 }; return this.dispatchEvent(new Event('error')); }
        if (spec.hangMeta) return;
        Object.assign(this, { videoWidth: spec.w, videoHeight: spec.h, duration: spec.duration, readyState: 1 });
        this.dispatchEvent(new Event('loadedmetadata'));
      }, 1);
    }
    get currentTime() { return this.t; }
    set currentTime(t) {
      this.seeks.push(t); this.seeking = true;
      spec.onSeek?.(t, this, globalThis.document);
      setTimeout(() => {
        if (t >= 1e9 && spec.realDuration) { this.duration = spec.realDuration; this.dispatchEvent(new Event('durationchange')); }
        this.t = Math.min(t, Number.isFinite(this.duration) ? this.duration : t); this.seeking = false; this.readyState = 4;
        if (t < 1e9 && spec.errorAfter != null && this.goodSeeks >= spec.errorAfter) { this.error = { code: 3 }; return this.dispatchEvent(new Event('error')); }
        if (spec.hangAt?.(t)) return;
        if (!(spec.staleFrom != null && t >= spec.staleFrom && t < 1e9)) { // a new frame is decoded and presented
          this.goodSeeks++; this.decodedFrames++; this.shownT = spec.present ? spec.present(this.t) : this.t;
          const cbs = [...this.cbs.values()]; this.cbs.clear();
          const meta = !spec.mediaTime ? {} : { mediaTime: typeof spec.mediaTime === 'function' ? spec.mediaTime(this.shownT) : this.shownT };
          setTimeout(() => cbs.forEach(cb => cb(0, meta)), 1);
        }
        this.dispatchEvent(new Event('seeked'));
      }, 1);
    }
    play() { this.played = true; return Promise.resolve(); }
    pause() { this.paused = true; }
    load() { this.loaded = true; }
    remove() { this.removed = true; }
    requestVideoFrameCallback(cb) { const id = ++this.rid; made.rvfc = (made.rvfc || 0) + 1; this.cbs.set(id, cb); return id; }
    cancelVideoFrameCallback(id) { this.cbs.delete(id); }
    get getVideoPlaybackQuality() { return spec.quality ? () => ({ totalVideoFrames: this.decodedFrames }) : undefined; }
  }
  class FakeCanvas {
    constructor() {
      Object.assign(this, { width: 300, height: 150, content: 'empty', pic: 0, encodes: [] }); made.canvases.push(this);
      this.ctx = {
        clearRect: () => { this.content = 'empty'; },
        drawImage: (src) => {
          if (src instanceof FakeCanvas) Object.assign(this, { content: src.content, pic: src.pic });
          else Object.assign(this, { content: spec.blank?.(src.t, (this.draws = (this.draws || 0) + 1)) ? 'empty' : 'frame', pic: src.shownT });
        },
        // Opaque pixels whose colour encodes the picture's time, so different frames have different signatures.
        getImageData: () => ({ data: Uint8ClampedArray.from({ length: 256 }, (_, i) => this.content !== 'frame' ? 0 : i % 4 === 3 ? 255 : Math.round(this.pic * 100) >> (8 * (i % 4)) & 255) }),
      };
    }
    getContext() { return this.ctx; }
    toDataURL(type, q) { const n = Math.round(this.width * this.height * q * (spec.density ?? 0.1)); this.encodes.push([this.width, this.height, q, n]); return `data:image/jpeg;base64,${'A'.repeat(Math.ceil(n / 3) * 4)}`; }
  }
  const doc = Object.assign(new EventTarget(), { hidden: Boolean(spec.hidden), createElement: tag => tag === 'video' ? new FakeVideo() : new FakeCanvas(), body: { append: el => { el.attached = true; } } });
  globalThis.document = doc;
  return made;
}
const vfile = (type = 'video/mp4', name = 'clip.mp4') => new File([bytes(64)], name, { type });

test('readVideo samples evenly, caps sizes, makes a poster and cleans up', async () => {
  const made = fakeDom({ w: 1920, h: 1080, duration: 10, density: 0.4 }); // frames need q 0.6 to fit 90 KB
  const progress = [];
  const r = await readVideo(vfile(), { onProgress: (p, k, n) => progress.push([p, k, n]) });
  assert.equal(r.clipOnly, false); assert.equal(r.name, 'clip.mp4'); assert.equal(r.mime, 'video/mp4'); assert.equal(r.size, 64);
  assert.equal(r.duration, 10); assert.equal(r.width, 1920); assert.equal(r.height, 1080);
  assert.equal(r.frames.length, 6);
  assert.deepEqual(r.frames.map(f => f.t), frameTimes(10, 6).map(t => Math.round(t * 1000) / 1000));
  for (const f of r.frames) assert.ok(dataUrlBytes(f.src) <= FRAME_MAX_BYTES);
  assert.ok(r.poster && dataUrlBytes(r.poster) <= POSTER_MAX_BYTES);
  const [video] = made.videos, [canvas, probe] = made.canvases;
  assert.ok(canvas.encodes.some(([w, h, q]) => w === 768 && h === 432 && q === 0.6));
  assert.ok(canvas.encodes.some(([w, h]) => w === 320 && h === 180));
  assert.deepEqual(progress.at(-1), [1, 6, 6]); assert.equal(progress.length, 6);
  assert.equal(video.played, true); assert.equal(video.attrs.playsinline, ''); assert.equal(video.attrs.muted, ''); assert.equal(video.muted, true);
  assert.equal(video.removed, true); assert.equal(video.attrs.src, undefined); assert.equal(video.loaded, true);
  assert.equal(canvas.width, 1); assert.equal(canvas.height, 1); assert.equal(probe.width, 1);
});
test('waits for a presented frame when visible, but not in a hidden page', async () => {
  const shown = fakeDom({ w: 640, h: 360, duration: 10 });
  await readVideo(vfile());
  assert.ok(shown.rvfc >= 6);
  const hidden = fakeDom({ w: 640, h: 360, duration: 10, hidden: true });
  assert.equal((await readVideo(vfile())).frames.length, 6);
  assert.equal(hidden.rvfc, undefined);
});
test('portrait video keeps its display orientation', async () => {
  const made = fakeDom({ w: 1080, h: 1920, duration: 4 });
  const r = await readVideo(vfile());
  assert.equal(r.width, 1080); assert.equal(r.height, 1920);
  assert.ok(made.canvases[0].encodes.some(([w, h]) => w === 432 && h === 768));
});
test('oversized frames are downscaled until they fit', async () => {
  const made = fakeDom({ w: 1920, h: 1080, duration: 3, density: 0.6 });
  const r = await readVideo(vfile());
  assert.ok(r.frames.length && r.frames.every(f => dataUrlBytes(f.src) <= FRAME_MAX_BYTES));
  assert.ok(made.canvases[0].encodes.some(([w]) => w === 614));
});
test('WebM with Infinity duration is probed by seeking to the end', async () => {
  const made = fakeDom({ w: 640, h: 360, duration: Infinity, realDuration: 12 });
  const r = await readVideo(vfile('video/webm', 'rec.webm'));
  assert.equal(r.duration, 12); assert.equal(r.frames.length, frameCount(12));
  assert.deepEqual(made.videos[0].seeks.slice(0, 2), [1e9, 0]);
  assert.ok(r.frames.every(f => f.t < 12));
});
test('decode failures come back clip-only', async () => {
  fakeDom({ w: 0, h: 0, duration: 42 }); // audio-only / HEVC without a decoder
  const r = await readVideo(vfile('video/quicktime', 'IMG_1.MOV'));
  assert.deepEqual({ ...r }, { name: 'IMG_1.MOV', mime: 'video/quicktime', size: 64, duration: 42, width: 0, height: 0, poster: null, frames: [], clipOnly: true, reason: 'decode' });
  fakeDom({ error: true });
  assert.equal((await readVideo(vfile())).clipOnly, true);
  fakeDom({ w: 640, h: 360, duration: 8, blank: () => true });
  const blank = await readVideo(vfile());
  assert.equal(blank.clipOnly, true); assert.equal(blank.duration, 8); assert.equal(blank.width, 640);
  VIDEO_TIMING.meta = 20; fakeDom({ hangMeta: true });
  assert.equal((await readVideo(vfile())).reason, 'timeout');
  await assert.rejects(sampleVideo(vfile()), { code: 'timeout' });
});
test('a transparent first draw is retried once; a hung seek skips that frame', async () => {
  fakeDom({ w: 640, h: 360, duration: 10, blank: (t, n) => n === 1 });
  const r = await readVideo(vfile());
  assert.equal(r.frames.length, 6); assert.ok(r.poster);
  const skipAt = frameTimes(10, 6)[2];
  fakeDom({ w: 640, h: 360, duration: 10, hangAt: t => t === skipAt });
  const s = await readVideo(vfile());
  assert.equal(s.frames.length, 5); assert.ok(!s.frames.some(f => f.t === Math.round(skipAt * 1000) / 1000));
});
test('readVideo honours abort, reuses a caller URL and refuses huge files', async () => {
  const made = fakeDom({ w: 640, h: 360, duration: 30 });
  const ctrl = new AbortController();
  await assert.rejects(readVideo(vfile(), { signal: ctrl.signal, onProgress: (p, k) => k === 2 && ctrl.abort() }), { name: 'AbortError' });
  assert.equal(made.videos[0].removed, true); assert.equal(made.canvases[0].width, 1);
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
  let created = 0, revoked = 0;
  URL.createObjectURL = () => { created++; return 'blob:x'; }; URL.revokeObjectURL = () => { revoked++; };
  try {
    fakeDom({ w: 640, h: 360, duration: 2 });
    await readVideo(vfile(), { url: 'blob:caller' });
    assert.equal(created, 0); assert.equal(revoked, 0);
    await readVideo(vfile());
    assert.equal(created, 1); assert.equal(revoked, 1);
  } finally { URL.createObjectURL = create; URL.revokeObjectURL = revoke; }
  await assert.rejects(readVideo({ name: 'big.mp4', type: 'video/mp4', size: 2 ** 32 + 1 }), { code: 'size' });
});
test('a decode error part-way keeps the frames read before it', async () => {
  fakeDom({ w: 640, h: 360, duration: 10, errorAfter: 2 });
  const r = await readVideo(vfile());
  assert.equal(r.clipOnly, false); assert.equal(r.partial, true);
  const ts = frameTimes(10, 6).map(t => Math.round(t * 1000) / 1000);
  assert.deepEqual(r.frames.map(f => f.t), [ts[0], ts[5]]); // ends first, so what survives spans the clip
  assert.ok(r.poster);
  fakeDom({ w: 640, h: 360, duration: 10, errorAfter: 0 }); // nothing readable at all is still clip-only
  const none = await readVideo(vfile());
  assert.equal(none.clipOnly, true); assert.equal(none.reason, 'decode');
});
test('seeks past where a file stops decoding are dropped, not labelled with the wrong time', async () => {
  const ts = frameTimes(10, 6).map(t => Math.round(t * 1000) / 1000); // 0.833 2.5 4.167 5.833 7.5 9.167
  for (const hidden of [false, true]) { // visible: no frame is presented; hidden: the decoded-frame count doesn't move
    const made = fakeDom({ w: 640, h: 360, duration: 10, staleFrom: 4, quality: true, hidden });
    const r = await readVideo(vfile());
    assert.deepEqual(r.frames.map(f => f.t), [ts[0], ts[1]], `hidden=${hidden}`);
    assert.equal(r.partial, true);
    assert.ok(!made.videos[0].seeks.includes(frameTimes(10, 6)[3]), 'slots past the stale point are skipped');
  }
  // Without a decoded-frame count the old behaviour stays (every seek that completes gives a frame).
  fakeDom({ w: 640, h: 360, duration: 10, staleFrom: 4, hidden: true });
  assert.equal((await readVideo(vfile())).frames.length, 6);
  // A static picture that really decodes on every seek is not mistaken for a stale one.
  fakeDom({ w: 640, h: 360, duration: 10, quality: true, hidden: true, present: () => 0 });
  const still = await readVideo(vfile());
  assert.equal(still.frames.length, 6); assert.equal(still.partial, undefined);
});
test('frames are labelled with the mediaTime the browser presented when it differs', async () => {
  // Seeks from 5 s on land on the 2.5 s frame (e.g. data the decoder can't reach): one copy, labelled 2.5, no duplicates.
  fakeDom({ w: 640, h: 360, duration: 10, mediaTime: true, present: t => t >= 5 ? 2.5 : t });
  const r = await readVideo(vfile());
  assert.deepEqual(r.frames.map(f => f.t), [0.833, 2.5, 4.167]);
  // Accurate seeks keep the planned labels.
  fakeDom({ w: 640, h: 360, duration: 10, mediaTime: true, present: t => Math.max(0, t - 0.02) });
  assert.deepEqual((await readVideo(vfile())).frames.map(f => f.t), frameTimes(10, 6).map(t => Math.round(t * 1000) / 1000));
  // A browser whose mediaTime is junk (different pictures, one time) is ignored: every frame kept, planned labels.
  fakeDom({ w: 640, h: 360, duration: 10, mediaTime: () => 0 });
  assert.deepEqual((await readVideo(vfile())).frames.map(f => f.t), frameTimes(10, 6).map(t => Math.round(t * 1000) / 1000));
});
test('the time budget stops sampling with frames that still span the clip, marked partial', async () => {
  let skew = 0;
  Date.now = () => realNow() + skew;
  VIDEO_TIMING.total = 60000;
  fakeDom({ w: 640, h: 360, duration: 10, onSeek: () => { skew += 25000; } }); // every seek "takes" 25 s
  const r = await readVideo(vfile());
  const ts = frameTimes(10, 6).map(t => Math.round(t * 1000) / 1000);
  assert.deepEqual(r.frames.map(f => f.t), [ts[0], ts[2], ts[5]]);
  assert.equal(r.partial, true); assert.equal(r.clipOnly, false);
});
test('time spent in the background doesn’t count against the budget', async () => {
  let skew = 0;
  Date.now = () => realNow() + skew;
  VIDEO_TIMING.total = 60000;
  fakeDom({ w: 640, h: 360, duration: 10, onSeek: (t, v, doc) => {
    if (v.seeks.length !== 2) return;
    doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange')); // the owner switches apps for two minutes
    skew += 120000;
    doc.hidden = false; doc.dispatchEvent(new Event('visibilitychange'));
  } });
  const r = await readVideo(vfile());
  assert.equal(r.frames.length, 6); assert.equal(r.partial, undefined);
});
