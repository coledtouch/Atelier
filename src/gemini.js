// Gemini native adapter for video turns + a stateless proxy for Gemini's Files API resumable uploads.
// Only chat bodies holding a `video_file` part come here; every other Gemini chat keeps the OpenAI-compatible route.
// The chat side mirrors anthropic.js: the app's OpenAI-style body in, OpenAI-style SSE deltas out.
// Upload sessions are Google's resumable upload URLs, handed to the browser as an opaque string and accepted back only
// when they point at Google's upload endpoint. The API key never leaves the Worker and never reaches a log or an error.

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com';
// Shared with public/video.js (a test checks both copies agree).
export const GEMINI_VIDEO_MIMES = new Set(['video/mp4', 'video/mpeg', 'video/quicktime', 'video/avi', 'video/x-flv', 'video/mpg', 'video/webm', 'video/wmv', 'video/3gpp']);
export const CLIP_MAX_BYTES = 1073741824; // 1 GiB
export const CLIP_MAX_SECONDS = 600;
export const CHUNK_NOMINAL = 16777216; // 16 MiB
export const CHUNK_MAX = 33554432; // 32 MiB
export const GRANULARITY_DEFAULT = 8388608; // 8 MiB
export const VIDEO_NEEDS_GEMINI = 'Only Gemini models can watch a video file — send frames to other models.';
export const FILE_GONE_ERROR = 'The uploaded clip isn’t available any more (Gemini keeps uploads for 48 hours).';

const MIME_ALIAS = new Map([['video/x-m4v', 'video/mp4'], ['video/mov', 'video/quicktime'], ['video/x-msvideo', 'video/avi'], ['video/x-ms-wmv', 'video/wmv']]);
const EXT_MIME = new Map([['mp4', 'video/mp4'], ['m4v', 'video/mp4'], ['mov', 'video/quicktime'], ['qt', 'video/quicktime'], ['webm', 'video/webm'],
  ['3gp', 'video/3gpp'], ['avi', 'video/avi'], ['mkv', 'video/x-matroska']]);

// Lowercase, drop ';params', map common aliases; an empty type falls back to the file extension ('' when unknown).
export function normalizeVideoMime(type, fileName = '') {
  const t = String(type || '').split(';')[0].trim().toLowerCase();
  if (t) return MIME_ALIAS.get(t) || t;
  const ext = String(fileName || '').toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1];
  return EXT_MIME.get(ext) || '';
}

export const isGeminiFileUri = (u) => typeof u === 'string' && /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/files\/[\w-]{1,80}$/.test(u);
export const isFileName = (n) => typeof n === 'string' && /^files\/[\w-]{1,80}$/.test(n);
// files/<id> for a Files API URI (the name a tester's ownership is recorded under), else ''.
export const fileNameOf = (uri) => (isGeminiFileUri(uri) ? `files/${uri.slice(uri.lastIndexOf('/') + 1)}` : '');

// A resumable upload URL from Google's start call: https, Google's own origin (no port, no credentials), the files upload
// path and a non-empty upload_id. Anything else is refused before the Worker sends a byte.
export function isUploadSession(s) {
  if (typeof s !== 'string' || s.length > 4096) return false;
  let u;
  try { u = new URL(s); } catch { return false; }
  return u.origin === GEMINI_BASE && !u.username && !u.password && u.pathname === '/upload/v1beta/files' && Boolean(u.searchParams.get('upload_id'));
}
// The upload_id of a valid session (what a tester's ownership of an upload is recorded under), else ''.
export const uploadIdOf = (s) => (isUploadSession(s) ? new URL(s).searchParams.get('upload_id') : '');
// The refusal for a clip over the cap (1 GB for the owner, 200 MB for LinkedIn testers).
const tooBig = (max) => `That video is over ${max >= 1073741824 ? `${max / 1073741824} GB` : `${Math.round(max / 1048576)} MB`} — Atelier will send frames instead.`;

// Is there a video_file part anywhere in the conversation? (Such bodies must take the native Gemini route.)
export const hasVideoParts = (messages) => Array.isArray(messages) && messages.some((m) => Array.isArray(m?.content) && m.content.some((p) => p?.type === 'video_file'));
export const hasVideoPart = (body) => hasVideoParts(body?.messages);

// A failure with the HTTP status, JSON fields ({error, ...extra}) and extra headers the /api/video/* routes answer with.
export class GeminiError extends Error {
  constructor(message, status = 502, extra = {}, headers = {}) {
    super(message);
    this.name = 'GeminiError';
    this.status = status;
    this.extra = extra;
    this.headers = headers;
  }
}

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
const SYNC_ERROR = 'Upload out of sync — try attaching again.';
const START_MAX = 16384; // upload/start JSON body cap
const DONE = 'data: [DONE]\n\n';
const HOURS_47 = 47 * 3600 * 1000;
const FILE_GONE = /files\/[\w-]+|not in an ACTIVE state|file .*(not found|expired|does not exist)|permission.*file/i;
const THINKING = /think|thought/i;
const STATES = new Set(['PROCESSING', 'ACTIVE', 'FAILED']);

function keyOf(env) {
  const key = env?.GEMINI_API_KEY;
  if (!key) throw new GeminiError('No Gemini key on the server (set GEMINI_API_KEY).', 401);
  return key;
}

// Text that may leave this module: the key is cut out, upload_id values (bearer capabilities) are masked.
function scrub(text, key) {
  let s = String(text ?? '');
  if (key) s = s.split(key).join('…');
  return s.replace(/upload_id=[^&\s"'<>]*/gi, 'upload_id=…');
}

function upstreamMessage(text) {
  try {
    let j = JSON.parse(text);
    if (Array.isArray(j)) j = j[0] || {};
    return String(j.error?.message || j.message || text);
  } catch { return String(text || ''); }
}

// Every call to Google: no redirects (the key header would follow one), network errors become a clean 502.
async function call(url, init, key, what) {
  try {
    return await fetch(url, { ...init, redirect: 'manual' });
  } catch (err) {
    console.warn('gemini unreachable', what, scrub(err?.message, key).slice(0, 200));
    throw new GeminiError(`${what} failed — Gemini is unreachable.`, 502);
  }
}

// Reads a failed response once: {status, msg} with the message scrubbed; logs status + message only (no URL, no key).
async function failed(r, what, key) {
  const msg = scrub(upstreamMessage(await r.text().catch(() => '')), key).slice(0, 300);
  console.warn('gemini', what, r.status, msg.slice(0, 200));
  return { status: r.status, msg };
}
const failure = ({ status, msg }, what) => new GeminiError(`${what} failed (${status})${msg ? `: ${msg}` : ''}`, 502);
const goneMsg = (status, msg) => status === 404 || (status === 403 && FILE_GONE.test(msg));

// A failed call to an upload session. Offset/session problems → 409 (the browser asks upload/query where Google is);
// 408/429 are transient → 503 (+ retry-after when Google sent seconds) so the browser retries; the rest (401/403, 5xx…)
// → 502 with the scrubbed upstream message.
async function uploadFailure(r, what, key) {
  const ra = String(r.headers.get('retry-after') || '').trim(), f = await failed(r, what, key);
  if ([400, 404, 409, 410, 412].includes(f.status)) return new GeminiError(SYNC_ERROR, 409);
  if (f.status === 408 || f.status === 429) return new GeminiError('Gemini’s upload server is busy — try again shortly.', 503, {}, /^\d{1,5}$/.test(ra) ? { 'retry-after': ra } : {});
  return failure(f, what);
}
const finalFile = async (r, total, key) => {
  const j = await r.json().catch(() => null);
  return { done: true, file: { ...toFileRef(j?.file, key), size: Number(j.file.sizeBytes) || total } };
};

// Upload chunk size for Google's granularity: a multiple of it near 16 MiB. Offsets are checked against 8 MiB, so the
// granularity must divide 8 MiB or be a multiple of it, and one chunk must fit in 32 MiB.
function chunkFor(header) {
  const g = /^\d{1,12}$/.test(String(header ?? '').trim()) ? Number(header) : 0;
  const gran = g > 0 ? g : GRANULARITY_DEFAULT;
  if (gran > CHUNK_MAX || (GRANULARITY_DEFAULT % gran && gran % GRANULARITY_DEFAULT)) throw new GeminiError('Gemini asked for an upload chunk size Atelier can’t send.', 502);
  return gran * Math.max(1, Math.floor(CHUNK_NOMINAL / gran));
}

const cleanName = (name) => (typeof name === 'string' ? name : '').replace(/[\u0000-\u001f\u007f-\u009f"]/g, '').trim().slice(0, 128);

function toFileRef(f, key) {
  if (!f || !isFileName(f.name) || !isGeminiFileUri(f.uri)) throw new GeminiError('Gemini returned an unexpected file record.', 502);
  const ref = {
    name: f.name, uri: f.uri, mime: normalizeVideoMime(f.mimeType), state: STATES.has(f.state) ? f.state : 'PROCESSING',
    expiresAt: Date.parse(f.expirationTime) || Date.now() + HOURS_47,
  };
  if (f.error?.message) ref.error = scrub(f.error.message, key).slice(0, 300);
  return ref;
}

// ── Files API (plain objects in, plain objects out; failures throw GeminiError) ──

// Starts a resumable upload → {session, chunk}. meta: {name, mime, size} from the browser; maxBytes: the clip cap.
export async function geminiUploadStart(env, { name, mime, size } = {}, maxBytes = CLIP_MAX_BYTES) {
  if (!Number.isSafeInteger(size) || size < 1) throw new GeminiError('Bad video size', 400);
  if (size > maxBytes) throw new GeminiError(tooBig(maxBytes), 413);
  const type = normalizeVideoMime(mime, name);
  if (!GEMINI_VIDEO_MIMES.has(type)) throw new GeminiError('Gemini can’t take this video type — Atelier will send frames instead.', 415);
  const key = keyOf(env);
  const what = 'Starting the Gemini upload';
  const r = await call(`${GEMINI_BASE}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': key, 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(size), 'X-Goog-Upload-Header-Content-Type': type, 'content-type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: cleanName(name) || 'video' } }),
  }, key, what);
  if (!r.ok) throw failure(await failed(r, what, key), what);
  r.body?.cancel().catch(() => {});
  let session = r.headers.get('x-goog-upload-url') || '';
  try {
    const u = new URL(session);
    if (u.searchParams.has('key')) { u.searchParams.delete('key'); session = u.href; } // the browser must never see a key
  } catch {}
  if (!isUploadSession(session) || session.includes(key)) throw new GeminiError('Gemini didn’t return a usable upload session.', 502);
  return { session, chunk: chunkFor(r.headers.get('x-goog-upload-chunk-granularity')) };
}

// Stateless checks for one chunk → [message, status] or null. The route runs them on the declared length before
// reading the body; geminiUploadChunk runs them again on the real byte count.
export function chunkProblem(offset, total, len, maxBytes = CLIP_MAX_BYTES) {
  if (!Number.isSafeInteger(len) || len < 1 || len > CHUNK_MAX) return ['A chunk must be 1 byte to 32 MB.', 413];
  if (!Number.isSafeInteger(total) || total < 1) return ['Bad total size', 400];
  if (total > maxBytes) return [tooBig(maxBytes), 413];
  if (!Number.isSafeInteger(offset) || offset < 0 || offset % GRANULARITY_DEFAULT) return ['Bad chunk offset', 400];
  if (offset + len > total) return ['The chunk runs past the end of the file.', 400];
  if (offset + len < total && len % GRANULARITY_DEFAULT) return ['Only the last chunk may be shorter than a whole 8 MB block.', 400];
  return null;
}

// Sends bytes [offset, offset+len) of a `total`-byte upload. Not last → {received}; last (finalizes) → {done, file}.
export async function geminiUploadChunk(env, session, { offset, total, bytes } = {}, maxBytes = CLIP_MAX_BYTES) {
  if (!isUploadSession(session)) throw new GeminiError('Bad upload session', 400);
  const len = bytes?.byteLength;
  const bad = chunkProblem(offset, total, len, maxBytes);
  if (bad) throw new GeminiError(...bad);
  const key = keyOf(env);
  const final = offset + len === total;
  const what = 'Uploading to Gemini';
  const r = await call(new URL(session).href, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'Content-Length': String(len), 'X-Goog-Upload-Offset': String(offset), 'X-Goog-Upload-Command': final ? 'upload, finalize' : 'upload' },
    body: bytes,
  }, key, what);
  if (!r.ok) throw await uploadFailure(r, what, key);
  if (!final) { r.body?.cancel().catch(() => {}); return { received: offset + len }; }
  return finalFile(r, total, key);
}

// Asks Google how much of an upload arrived (after a lost answer or a 409) → {received} while it is open, or
// {done, file} when it was already finalized. A cancelled, expired or unknown session → 409.
export async function geminiUploadQuery(env, session, total = 0) {
  if (!isUploadSession(session)) throw new GeminiError('Bad upload session', 400);
  const key = keyOf(env);
  const what = 'Checking the Gemini upload';
  const r = await call(new URL(session).href, { method: 'POST', headers: { 'x-goog-api-key': key, 'X-Goog-Upload-Command': 'query' } }, key, what);
  if (!r.ok) throw await uploadFailure(r, what, key);
  const status = String(r.headers.get('x-goog-upload-status') || '').toLowerCase();
  if (status === 'final') return finalFile(r, total, key);
  r.body?.cancel().catch(() => {});
  if (status === 'cancelled') throw new GeminiError(SYNC_ERROR, 409);
  const got = String(r.headers.get('x-goog-upload-size-received') ?? '').trim();
  if (!/^\d{1,16}$/.test(got)) throw new GeminiError('Gemini didn’t say how much of the upload arrived.', 502);
  return { received: Number(got) };
}

// Abandons an upload (fire-and-forget at Google; always {ok:true}).
export async function geminiUploadCancel(env, session) {
  if (!isUploadSession(session)) return { ok: true };
  const key = env?.GEMINI_API_KEY;
  try {
    const r = await fetch(new URL(session).href, { method: 'POST', headers: { ...(key ? { 'x-goog-api-key': key } : {}), 'X-Goog-Upload-Command': 'cancel' }, redirect: 'manual' });
    r.body?.cancel().catch(() => {});
  } catch {}
  return { ok: true };
}

// files/<id> → {name, uri, mime, state: PROCESSING|ACTIVE|FAILED, expiresAt, error?}. A missing file throws 404 {state:'GONE'}.
export async function geminiFileGet(env, name) {
  if (!isFileName(name)) throw new GeminiError('Bad file name', 400);
  const key = keyOf(env);
  const what = 'Checking the Gemini file';
  const r = await call(`${GEMINI_BASE}/v1beta/${name}`, { headers: { 'x-goog-api-key': key } }, key, what);
  if (!r.ok) {
    const f = await failed(r, what, key);
    if (goneMsg(f.status, f.msg)) throw new GeminiError('gone', 404, { state: 'GONE' });
    throw failure(f, what);
  }
  const ref = toFileRef(await r.json().catch(() => null), key);
  if (ref.name !== name) throw new GeminiError('Gemini returned an unexpected file record.', 502);
  return ref;
}

// Deletes files/<id>; an already-missing file counts as deleted.
export async function geminiFileDelete(env, name) {
  if (!isFileName(name)) throw new GeminiError('Bad file name', 400);
  const key = keyOf(env);
  const what = 'Deleting the Gemini file';
  const r = await call(`${GEMINI_BASE}/v1beta/${name}`, { method: 'DELETE', headers: { 'x-goog-api-key': key } }, key, what);
  if (r.ok) { r.body?.cancel().catch(() => {}); return { ok: true }; }
  const f = await failed(r, what, key);
  if (goneMsg(f.status, f.msg)) return { ok: true };
  throw failure(f, what);
}

// ── /api/video/* routes (call after the passcode check; `path` is relative to /api/, e.g. 'video/upload/start') ──

const intParam = (v) => (typeof v === 'string' && /^\d{1,16}$/.test(v) ? Number(v) : NaN);

// The declared content-length → number, null when absent, NaN when malformed.
const declaredLength = (req) => { const d = req.headers.get('content-length'); return d == null ? null : intParam(d.trim()); };

// Reads a body into ONE buffer of `len` bytes (declared) or at most `cap` bytes (undeclared), stopping the moment it
// runs past either → Uint8Array | null. Peak memory is that one buffer, never a second copy.
async function readBody(req, len, cap) {
  const out = new Uint8Array(len ?? cap), reader = req.body?.getReader();
  let n = 0;
  for (;;) {
    const r = reader ? await reader.read() : { done: true };
    if (r.done) break;
    if (n + r.value.byteLength > out.length) { reader.cancel().catch(() => {}); return null; }
    out.set(r.value, n);
    n += r.value.byteLength;
  }
  return len == null ? out.subarray(0, n) : n === len ? out : null;
}

// tester (LinkedIn testers only, addendum A2): {maxBytes, owns(kind, id), record(kind, id)}, async hooks backed by the
// Ledger. 'upload' ids are upload_ids, 'file' ids are files/<id> names. Every chunk, query, cancel, file get and delete
// must name the tester's own upload or file (else 403 tester_owner); started and finished uploads are recorded.
const NOT_YOURS = { error: 'That video belongs to another session — attach it again.', code: 'tester_owner' };
export async function handleVideoApi(req, env, path, params = new URLSearchParams(), tester = null) {
  const route = String(path || '').replace(/^\/?(api\/)?video\//, '');
  const maxBytes = tester?.maxBytes || CLIP_MAX_BYTES;
  const mine = async (kind, id) => !tester || (Boolean(id) && await tester.owns(kind, id));
  const keep = async (out) => { if (tester && out?.done && out.file?.name) await tester.record('file', out.file.name); return json(out); };
  try {
    // POST video/upload/start {name, mime, size} → {session, chunk}
    if (route === 'upload/start' && req.method === 'POST') {
      const len = declaredLength(req);
      if (Number.isNaN(len)) return json({ error: 'Bad content-length' }, 400);
      if (len > START_MAX) return json({ error: 'Request too large' }, 413);
      const raw = await readBody(req, len, START_MAX);
      if (!raw) return len == null ? json({ error: 'Request too large' }, 413) : json({ error: 'The body doesn’t match its content-length.' }, 400);
      let body = null;
      try { body = JSON.parse(new TextDecoder().decode(raw)); } catch {}
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Bad JSON body' }, 400);
      const out = await geminiUploadStart(env, body, maxBytes);
      if (tester) await tester.record('upload', uploadIdOf(out.session));
      return json(out);
    }
    // PUT video/upload/chunk?offset=&total=  (x-upload-session header, raw bytes) → {received} | {done, file}
    if (route === 'upload/chunk' && req.method === 'PUT') {
      const session = req.headers.get('x-upload-session') || '';
      if (!isUploadSession(session)) return json({ error: 'Bad upload session' }, 400);
      if (!(await mine('upload', uploadIdOf(session)))) return json(NOT_YOURS, 403);
      const offset = intParam(params.get('offset')), total = intParam(params.get('total'));
      const len = declaredLength(req);
      if (Number.isNaN(len)) return json({ error: 'Bad content-length' }, 400);
      const bad = len == null ? null : chunkProblem(offset, total, len, maxBytes); // undeclared length: checked after reading
      if (bad) return json({ error: bad[0] }, bad[1]);
      const bytes = await readBody(req, len, CHUNK_MAX);
      if (!bytes) return len == null ? json({ error: 'A chunk must be 1 byte to 32 MB.' }, 413) : json({ error: 'The chunk doesn’t match its content-length.' }, 400);
      return keep(await geminiUploadChunk(env, session, { offset, total, bytes }, maxBytes));
    }
    // POST video/upload/query?total=  (x-upload-session header) → {received} | {done, file}
    if (route === 'upload/query' && req.method === 'POST') {
      const total = intParam(params.get('total')), session = req.headers.get('x-upload-session') || '';
      if (tester && !isUploadSession(session)) return json({ error: 'Bad upload session' }, 400);
      if (!(await mine('upload', uploadIdOf(session)))) return json(NOT_YOURS, 403);
      return keep(await geminiUploadQuery(env, session, Number.isSafeInteger(total) ? total : 0));
    }
    // POST video/upload/cancel (x-upload-session header) → {ok:true}
    if (route === 'upload/cancel' && req.method === 'POST') {
      const session = req.headers.get('x-upload-session') || '';
      if (tester && !isUploadSession(session)) return json({ error: 'Bad upload session' }, 400);
      if (!(await mine('upload', uploadIdOf(session)))) return json(NOT_YOURS, 403);
      return json(await geminiUploadCancel(env, session));
    }
    // GET | DELETE video/file?name=files/<id>
    if (route === 'file' && (req.method === 'GET' || req.method === 'DELETE')) {
      const name = params.get('name') || '';
      if (!isFileName(name)) return json({ error: 'Bad file name' }, 400);
      if (!(await mine('file', name))) return json(NOT_YOURS, 403);
      return json(req.method === 'GET' ? await geminiFileGet(env, name) : await geminiFileDelete(env, name));
    }
    return json({ error: 'Not found' }, 404);
  } catch (err) {
    if (err instanceof GeminiError) return json({ error: err.message, ...err.extra }, err.status, err.headers);
    console.error('gemini video route failed', scrub(err?.message || err, env?.GEMINI_API_KEY).slice(0, 200));
    return json({ error: 'The Gemini video request failed — try again.' }, 502);
  }
}

// ── Native chat (streamGenerateContent) ──

const IMAGE_DATA = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=]+)$/;
const textOf = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n') : '');

function toParts(content) {
  if (typeof content === 'string') return content ? [{ text: content }] : [];
  const out = [];
  for (const p of Array.isArray(content) ? content : []) {
    if (typeof p === 'string') { if (p) out.push({ text: p }); continue; }
    if (p?.type === 'text') { if (typeof p.text === 'string' && p.text) out.push({ text: p.text }); continue; }
    if (p?.type === 'image_url') {
      const m = String(p.image_url?.url || '').match(IMAGE_DATA);
      if (m) out.push({ inline_data: { mime_type: m[1] === 'image/jpg' ? 'image/jpeg' : m[1], data: m[2] } });
      continue;
    }
    if (p?.type === 'video_file') {
      const uri = p.video_file?.file_uri, mime = normalizeVideoMime(p.video_file?.mime_type);
      if (!isGeminiFileUri(uri) || !GEMINI_VIDEO_MIMES.has(mime)) throw new GeminiError('Bad video reference', 400);
      out.push({ file_data: { mime_type: mime, file_uri: uri } });
    }
    // anything else (input_audio, remote image URLs, …) is dropped
  }
  return out;
}

// reasoning_effort → thinkingLevel, as the OpenAI-compatible route does. maxOutputTokens covers thinking too, so an
// unmapped effort would think at the model default (high on Pro) and can spend the whole budget before answering.
// 'minimal' is only accepted by older Flash models, so it goes as 'low'.
const THINKING_LEVEL = new Map([['minimal', 'low'], ['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'high'], ['max', 'high']]);

// The app's OpenAI-style body → a streamGenerateContent request. Pure; throws GeminiError(400) on a bad video reference.
// System messages → systemInstruction; assistant → model (text only); tool turns, tool_calls, reasoning_content and
// anthropic_content are dropped; consecutive same-role turns merge; leading model turns are dropped.
export function toGeminiRequest(body) {
  const system = [], contents = [];
  for (const m of Array.isArray(body?.messages) ? body.messages : []) {
    if (m?.role === 'system') { const t = textOf(m.content); if (t) system.push(t); continue; }
    const role = m?.role === 'user' ? 'user' : m?.role === 'assistant' ? 'model' : null;
    if (!role) continue;
    const parts = role === 'model' ? toParts(textOf(m.content)) : toParts(m.content);
    if (!parts.length || (role === 'model' && !contents.length)) continue;
    const last = contents[contents.length - 1];
    if (last?.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  }
  if (!contents.length) throw new GeminiError('Nothing to send', 400);
  const generationConfig = { maxOutputTokens: Math.min(Math.max(Math.round(Number(body.max_tokens) || 8192), 256), 65536) };
  if (typeof body.temperature === 'number' && Number.isFinite(body.temperature)) generationConfig.temperature = Math.min(Math.max(body.temperature, 0), 2);
  const level = THINKING_LEVEL.get(body.reasoning_effort);
  generationConfig.thinkingConfig = { includeThoughts: true, ...(level && { thinkingLevel: level }) };
  return { ...(system.length ? { systemInstruction: { parts: [{ text: system.join('\n\n') }] } } : {}), contents, generationConfig };
}

const OK_FINISH = new Set(['STOP', 'MAX_TOKENS', 'FINISH_REASON_UNSPECIFIED']);
const reasonOf = (r) => (typeof r === 'string' && /^[A-Z_]{1,40}$/.test(r) ? r : 'OTHER');

// Incremental converter: Google SSE bytes in → OpenAI-style SSE text out (never buffers more than one partial line).
function sseConverter() {
  const dec = new TextDecoder();
  let buf = '', sentContent = false, finished = false;
  const frame = (o) => `data: ${JSON.stringify(o)}\n\n`;
  const delta = (d, finish = null) => frame({ choices: [{ index: 0, delta: d, finish_reason: finish }] });
  const fail = (message) => frame({ error: { message } });
  const line = (raw) => {
    const l = raw.trim();
    if (!l.startsWith('data:')) return '';
    let j;
    try { j = JSON.parse(l.slice(5).trim()); } catch { return ''; }
    if (Array.isArray(j)) j = j[0];
    if (!j || typeof j !== 'object') return '';
    if (j.error) return fail(String(j.error.message || j.error.status || 'Gemini stream failed').slice(0, 400));
    if (j.promptFeedback?.blockReason) return fail(`Gemini blocked this request (${reasonOf(j.promptFeedback.blockReason)}) — try rephrasing.`);
    const cand = j.candidates?.[0];
    let out = '';
    for (const p of Array.isArray(cand?.content?.parts) ? cand.content.parts : []) {
      if (typeof p?.text !== 'string' || !p.text) continue; // thoughtSignature-only parts carry nothing to show
      if (p.thought) out += delta({ reasoning_content: p.text });
      else { out += delta({ content: p.text }); sentContent = true; }
    }
    if (cand?.finishReason && !finished) {
      finished = true;
      const r = reasonOf(cand.finishReason);
      // Out of tokens before any answer (all spent thinking): an error, so the client falls back to the next model
      // (app.js streamChat: a watch turn that only streamed thinking still moves on, via onRestart).
      if (r === 'MAX_TOKENS' && !sentContent) out += fail('Gemini ran out of tokens while thinking — try again.');
      else if (OK_FINISH.has(r)) out += delta({}, r === 'MAX_TOKENS' ? 'length' : 'stop');
      else if (!sentContent) out += fail(`Gemini stopped (${r}) — try rephrasing.`);
      else out += delta({ content: `\n\n_Gemini stopped early (${r})._` }, 'content_filter');
    }
    return out;
  };
  return {
    push(bytes) {
      buf += dec.decode(bytes, { stream: true });
      let out = '', i;
      while ((i = buf.indexOf('\n')) >= 0) { out += line(buf.slice(0, i)); buf = buf.slice(i + 1); }
      return out;
    },
    end() {
      buf += dec.decode();
      const out = buf ? line(buf) : '';
      buf = '';
      return out;
    },
  };
}

// TransformStream<Uint8Array, Uint8Array>: Google's streamGenerateContent?alt=sse → the OpenAI-style SSE the client parses
// (choices[0].delta.content / reasoning_content, finish_reason, {error:{message}}), always ending with `data: [DONE]`.
export function geminiSseToOpenAI() {
  const enc = new TextEncoder(), conv = sseConverter();
  return new TransformStream({
    transform(chunk, ctrl) { const s = conv.push(chunk); if (s) ctrl.enqueue(enc.encode(s)); },
    flush(ctrl) { ctrl.enqueue(enc.encode(conv.end() + DONE)); },
  });
}

// Upstream read errors become a Gemini-style error line (then the converter's [DONE]) instead of a broken stream.
function guarded(src, key) {
  const reader = src.getReader();
  return new ReadableStream({
    async pull(ctrl) {
      try {
        const { value, done } = await reader.read();
        if (done) ctrl.close();
        else ctrl.enqueue(value);
      } catch (err) {
        const message = `Gemini stream failed: ${scrub(err?.message || 'connection lost', key).slice(0, 200)}`;
        ctrl.enqueue(new TextEncoder().encode(`\ndata: ${JSON.stringify({ error: { message } })}\n`));
        ctrl.close();
      }
    },
    cancel(reason) { return reader.cancel(reason).catch(() => {}); },
  });
}

// POST /api/chat for a body with a video_file part and a gemini: model. key: the resolved Gemini key.
// Streams OpenAI-style SSE; errors before streaming come back as JSON with the upstream status (409 video_file_gone
// when the clip expired). If Google rejects thinkingConfig, the request is retried once without it.
// opts.tap(stream) → stream sees Google's own SSE bytes before conversion (the tester meter reads usageMetadata there).
export async function geminiNativeChat(body, key, opts = {}) {
  const model = String(body?.model || '');
  if (!model.startsWith('gemini:')) return json({ error: VIDEO_NEEDS_GEMINI }, 400);
  const id = model.slice(7);
  if (!/^[\w.-]{1,80}$/.test(id)) return json({ error: 'Bad Gemini model id' }, 400);
  let payload;
  try { payload = toGeminiRequest(body); } catch (err) { return json({ error: err.message || 'Bad request' }, err.status || 400); }
  const url = `${GEMINI_BASE}/v1beta/models/${id}:streamGenerateContent?alt=sse`;
  const send = (p) => fetch(url, { method: 'POST', headers: { 'x-goog-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify(p), redirect: 'manual' });
  let upstream, text = null;
  try {
    upstream = await send(payload);
    if (upstream.status === 400) {
      text = await upstream.text().catch(() => '');
      const msg = upstreamMessage(text);
      if (THINKING.test(msg) && !FILE_GONE.test(msg)) {
        const { thinkingConfig, ...generationConfig } = payload.generationConfig;
        upstream = await send({ ...payload, generationConfig });
        text = null;
      }
    }
  } catch (err) {
    console.warn('gemini chat unreachable', scrub(err?.message, key).slice(0, 200));
    return json({ error: `Upstream unreachable: ${scrub(err?.message || 'network error', key).slice(0, 200)}` }, 502);
  }
  if (!upstream.ok) {
    if (text == null) text = await upstream.text().catch(() => '');
    const msg = upstreamMessage(text);
    console.warn('gemini chat', upstream.status, `models/${id}`, scrub(msg, key).slice(0, 300));
    if ([400, 403, 404].includes(upstream.status) && FILE_GONE.test(msg)) return json({ error: FILE_GONE_ERROR, code: 'video_file_gone' }, 409);
    if (upstream.status < 400) return json({ error: `Gemini answered unexpectedly (${upstream.status})` }, 502);
    return new Response(scrub(text, key) || JSON.stringify({ error: `Gemini request failed (${upstream.status})` }), { status: upstream.status, headers: JSON_HEADERS });
  }
  if (!upstream.body) return json({ error: 'Gemini sent an empty response' }, 502);
  // The tap reads Google's raw body inside the guard, so an upstream read error reaches it as a failure (a cut-off stream
  // keeps the full tester reservation) before guarded() turns it into an error line for the client.
  const src = guarded(opts.tap ? opts.tap(upstream.body) : upstream.body, key);
  return new Response(src.pipeThrough(geminiSseToOpenAI()), { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
}
