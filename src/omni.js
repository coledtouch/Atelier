// Gemini Omni Flash video (Google's replacement for Veo 3.1 on the Gemini API, which shuts down 2026-10-22).
// Docs (read 2026-10-07): https://ai.google.dev/gemini-api/docs/omni
//   https://ai.google.dev/api/interactions-api   https://ai.google.dev/gemini-api/docs/background-execution
//   https://ai.google.dev/gemini-api/docs/deprecations   https://ai.google.dev/gemini-api/docs/pricing
//
// Omni runs on the Interactions API, not Veo's predictLongRunning:
//   POST /v1beta/interactions {model: 'gemini-omni-1.1-flash', input, response_format: {type: 'video', aspect_ratio,
//        resolution, duration}, background: true, store: true[, previous_interaction_id][, generation_config:
//        {video_config: {task}}]} → {id, status: queued | in_progress | …}
//   GET  /v1beta/interactions/{id} → {id, status, steps: [{type: 'model_output', content: [{type: 'video', mime_type,
//        data | uri}]}], usage: {total_input_tokens, total_output_tokens, output_tokens_by_modality}}
//   POST /v1beta/interactions/{id}/cancel
// A background interaction's GET returns the video inline as base64 (the docs' note: even with delivery 'uri'), so a
// finished interaction's JSON holds the whole clip. It is never parsed whole: every long base64 string is cut out by
// position first (scan), and the clip is decoded from the text in slices as it streams to the browser (videoResponse).
//
// Routes for the owner (/api/omni/*, behind the passcode; src/worker.js) — the tester router has its own metered copies:
//   POST omni/start        {prompt, image?, aspect?, resolution?, seconds?, previous?, task?} → {id, status, pollAfterMs}
//   GET  omni/status/<id>  → {id, status, done, error?, filtered?, video, usage?, pollAfterMs?} (never the video bytes)
//   GET  omni/video/<id>   → video/mp4 (the finished clip)
//   POST omni/cancel/<id>  → {ok}
// The API key never leaves the Worker and never reaches a log or an error; prompts and media are never logged.
// The owner's starts go through src/spend.js (opts.spend), the owner's spend record: recorded at the quote (never
// refused), tied to the interaction once Google accepts it, and settled from its reported usage when a status poll sees
// it finish ($0 for a filtered, failed or cancelled one: Google bills only a produced video).
import { GEMINI_BASE } from './gemini.js';
import { veoCost, omniActual } from './tester/prices.js';
import { isGatewayStatus } from './spend.js';

export const OMNI_MODEL = 'gemini-omni-1.1-flash';
export const OMNI_PRICE_ID = `gemini:${OMNI_MODEL}`;
export const OMNI_ASPECTS = Object.freeze(['16:9', '9:16']);
export const OMNI_RESOLUTIONS = Object.freeze(['360p', '720p', '1080p', '4k']);
export const OMNI_SECONDS_MIN = 3, OMNI_SECONDS_MAX = 10; // "3–10 second" clips (omni guide, changelog)
export const OMNI_TASKS = Object.freeze(['text_to_video', 'image_to_video', 'edit', 'extend']);
export const OMNI_STATUSES = Object.freeze(['queued', 'in_progress', 'requires_action', 'completed', 'failed', 'cancelled', 'incomplete']);
const RUNNING = new Set(['queued', 'in_progress']);
export const POLL_MS = 10_000;
export const LIMITS = Object.freeze({
  body: 8 * 1024 * 1024, // the browser's start request (one image inline)
  image: 5 * 1024 * 1024, // one base64 image
  prompt: 8_000,
  json: 72 * 1024 * 1024, // a finished interaction's JSON (the clip as base64): 1080p 10 s fits; 4K may not
  blob: 1024, // base64 strings this long are cut out of the JSON before it is parsed
  slice: 3 * 1024 * 1024, // base64 characters decoded per chunk (a multiple of 4)
});
const ID_RE = /^[A-Za-z0-9_-]{1,256}$/;
const IMAGE_DATA = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+=*)$/;
const FILE_URI = /^https:\/\/generativelanguage\.googleapis\.com\/(v1(?:beta)?)\/files\/([A-Za-z0-9_-]{1,128})(?::download)?(?:\?[^#\s]*)?$/;

export class OmniError extends Error {
  constructor(message, status = 502, code = 'omni_failed', headers = {}) {
    super(message); this.name = 'OmniError'; this.status = status; this.code = code; this.headers = headers;
  }
}
const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
const bad = (message) => new OmniError(message, 400, 'omni_input');
const isRecord = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
export const validId = (id) => typeof id === 'string' && ID_RE.test(id);

// Text that may leave this module: no key, no links, no base64, no control characters, short.
const SCRUB_IN = 20000; // characters of upstream text looked at (the key is removed from all of it first)
export function scrub(text, key = '', max = 240) {
  let s = String(text ?? '');
  if (key) s = s.split(key).join('…');
  s = s.slice(0, SCRUB_IN); // a counted quantifier like {200,} overflows V8's regex stack on a multi-MB run (an error page, a clip)
  return s.replace(/\bAIza[\w-]+/g, 'AIza…').replace(/\bhttps?:\/\/\S+/gi, '[link]').replace(/[A-Za-z0-9+/=_-]{200,}/g, '…')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max);
}

// ── request shaping (pure: the browser's JSON → the exact body sent to Google, or an OmniError 400) ──
/**
 * input: {prompt, image?: data:image/(png|jpeg|webp);base64,…, aspect?: '16:9' | '9:16', resolution?: '360p' | '720p'
 * | '1080p' | '4k', seconds?: 3–10, previous?: an earlier interaction id (edit or extend it), task?: OMNI_TASKS}.
 * opts: {resolutions, maxSeconds, durations} narrow what is accepted (the tester router passes its own).
 * → {body, seconds, resolution, aspect, previous, task}. Without `seconds` the clip is 6 s.
 * Mapping: aspect → response_format.aspect_ratio; resolution → response_format.resolution; seconds →
 * response_format.duration as a protobuf Duration string ("6s": the field is documented as a string, "The duration for
 * the video output", with no format given). An edit (previous, no task or task 'edit') sends no duration or aspect
 * ratio: the clip it edits has its own.
 */
export function shapeOmni(input, opts = {}) {
  if (!isRecord(input)) throw bad('Bad JSON body');
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!prompt) throw bad('Describe the video you want.');
  if (prompt.length > LIMITS.prompt) throw bad(`Video prompts are limited to ${LIMITS.prompt.toLocaleString('en-US')} characters.`);
  const resolutions = opts.resolutions || OMNI_RESOLUTIONS;
  const resolution = input.resolution == null ? '720p' : input.resolution;
  if (!resolutions.includes(resolution)) throw bad(`resolution must be one of ${resolutions.join(', ')}.`);
  const aspect = input.aspect == null ? '16:9' : input.aspect;
  if (!OMNI_ASPECTS.includes(aspect)) throw bad('aspect must be 16:9 or 9:16.');
  const seconds = input.seconds == null ? 6 : input.seconds;
  const durations = opts.durations || null, max = opts.maxSeconds || OMNI_SECONDS_MAX;
  if (!Number.isInteger(seconds) || seconds < OMNI_SECONDS_MIN || seconds > max || (durations && !durations.includes(seconds))) {
    throw bad(durations ? `seconds must be one of ${durations.join(', ')}.` : `Omni clips are ${OMNI_SECONDS_MIN}–${max} whole seconds.`);
  }
  const previous = input.previous == null ? null : input.previous;
  if (previous != null && !validId(previous)) throw bad('That isn’t an Omni video Atelier can edit.');
  const task = input.task == null ? null : input.task;
  if (task != null && !OMNI_TASKS.includes(task)) throw bad(`task must be one of ${OMNI_TASKS.join(', ')}.`);
  if (previous && task && !['edit', 'extend'].includes(task)) throw bad('An earlier clip can only be edited or extended.');
  if (!previous && (task === 'edit' || task === 'extend')) throw bad('Editing or extending needs the earlier clip.');

  let image = null;
  if (input.image != null) {
    if (typeof input.image !== 'string' || input.image.length > LIMITS.image + 32) throw bad('The starting image must be a PNG, JPEG or WebP up to 5 MB.');
    const m = input.image.match(IMAGE_DATA);
    if (!m) throw bad('The starting image must be a PNG, JPEG or WebP up to 5 MB.');
    image = { type: 'image', data: m[2], mime_type: m[1] };
  }
  const edit = Boolean(previous) && task !== 'extend';
  const body = {
    model: OMNI_MODEL,
    input: image ? [image, { type: 'text', text: prompt }] : prompt,
    response_format: edit ? { type: 'video', resolution } : { type: 'video', aspect_ratio: aspect, resolution, duration: `${seconds}s` },
    background: true, // the browser polls; nothing holds a request open for the minutes a clip takes
    store: true, // required for background runs, and for editing a clip later (previous_interaction_id)
  };
  if (previous) body.previous_interaction_id = previous;
  if (task) body.generation_config = { video_config: { task } };
  return { body, seconds, resolution, aspect, previous, task, edit };
}

// ── Google calls ──
const authHeaders = (key) => ({ 'x-goog-api-key': key, accept: 'application/json' });
async function call(key, method, path, body) {
  const init = { method, headers: authHeaders(key), redirect: 'manual' };
  if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
  try {
    return await fetch(`${GEMINI_BASE}/v1beta/${path}`, init);
  } catch (err) {
    console.warn('omni unreachable', path.split('/')[0], scrub(err?.message, key, 120));
    throw new OmniError('Google is unreachable right now — try again in a moment.', 502, 'omni_unreachable');
  }
}
const retryAfterOf = (r) => { const v = String(r.headers.get('retry-after') || '').trim(); return /^\d{1,5}$/.test(v) ? { 'retry-after': v } : {}; };
// A failed Google answer → OmniError (its status and one scrubbed line; never the raw body).
export async function upstreamError(r, what, key) {
  const text = await r.text().catch(() => '');
  let j = null;
  try { j = JSON.parse(text.slice(0, 65536)); } catch {}
  const e = isRecord(j?.error) ? j.error : {};
  const msg = scrub(typeof e.message === 'string' ? e.message : '', key, 240);
  const tag = [e.status, e.code].filter((v) => (typeof v === 'string' && /^[\w.-]{1,40}$/.test(v)) || Number.isInteger(v)).join('/');
  console.warn('omni', what, r.status, tag || '-');
  const s = r.status;
  if (s === 400 || s === 422) return new OmniError(`Gemini Omni didn’t accept that request${msg ? ` — ${msg}` : '.'}`, 400, 'omni_rejected');
  if (s === 401 || s === 403) return new OmniError('Google refused the server’s Gemini key for Omni (GEMINI_API_KEY) — check billing and model access in AI Studio.', 403, 'omni_key');
  if (s === 404) return new OmniError('Google no longer has that video (interactions are kept 55 days).', 404, 'omni_gone');
  if (s === 429) return new OmniError('Gemini Omni is busy or this key is over its limit — try again in a moment.', 429, 'omni_busy', retryAfterOf(r));
  if (s >= 500) return Object.assign(new OmniError('Gemini Omni is busy right now — try again in a moment.', 503, 'omni_busy', retryAfterOf(r)), { gateway: isGatewayStatus(s) });
  return new OmniError(`${what} failed (${s}).`, 502, 'omni_failed');
}

/** POST /v1beta/interactions with a shaped body → {id, status}. */
export async function omniCreate(key, body) {
  const what = 'Starting the Omni video';
  const r = await call(key, 'POST', 'interactions', body);
  if (!r.ok) throw await upstreamError(r, what, key);
  const { j } = await readInteraction(r);
  if (!validId(j?.id)) throw new OmniError('Google didn’t return an id for the new video.', 502, 'omni_failed');
  return { id: j.id, status: typeof j.status === 'string' ? j.status : 'queued' };
}

// Reads a response body as text, refusing more than `cap` bytes.
async function readCappedText(body, cap) {
  if (!body) return '';
  const reader = body.getReader(), parts = [];
  let n = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    n += r.value.byteLength;
    if (n > cap) { reader.cancel().catch(() => {}); return null; }
    parts.push(r.value);
  }
  const all = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.byteLength; }
  return new TextDecoder().decode(all);
}
// Only the key is found by regex; the value is walked a character at a time. A regex over the value itself
// ("…"([A-Za-z0-9+/=_\\-]{1024,})"") overflows V8's stack once a clip passes ~3 MB of base64 (RangeError on 4 MB+).
const DATA_KEY_RE = /"data"\s*:\s*"/g;
const b64ish = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47 || c === 61 || c === 95 || c === 45 || c === 92; // A-Z a-z 0-9 + / = _ - \
/**
 * An interaction's JSON text → {j, text, blobs}: j is the JSON with every long "data" string replaced by '@omni:<n>',
 * and blobs[n] = [start, end) of that string in `text` (decoded later, in slices). Exported for tests.
 */
export function scan(text) {
  const blobs = [];
  let stripped = '', last = 0;
  DATA_KEY_RE.lastIndex = 0;
  for (let m; (m = DATA_KEY_RE.exec(text));) {
    const start = m.index + m[0].length;
    let end = start;
    while (end < text.length && b64ish(text.charCodeAt(end))) end++;
    if (end - start < LIMITS.blob || text.charCodeAt(end) !== 34) continue; // short, or not a plain base64 string: left in
    blobs.push([start, end]);
    stripped += `${text.slice(last, m.index)}"data":"@omni:${blobs.length - 1}"`;
    last = end + 1;
    DATA_KEY_RE.lastIndex = last;
  }
  stripped += text.slice(last);
  let j = null;
  try { j = JSON.parse(stripped); } catch {}
  return { j: isRecord(j) ? j : null, text, blobs };
}
async function readInteraction(r) {
  const text = await readCappedText(r.body, LIMITS.json);
  if (text == null) throw new OmniError('This video is too large to bring into Atelier — try 1080p or lower.', 502, 'omni_too_large');
  const s = scan(text);
  if (!s.j) throw new OmniError('Google returned an unexpected answer for this video.', 502, 'omni_failed');
  return s;
}

// The video item of a finished interaction: a model_output step's {type: 'video'} content (or output_video).
function videoItem(j) {
  const steps = Array.isArray(j.steps) ? j.steps : [];
  for (const st of [...steps].reverse()) {
    if (st?.type !== 'model_output' || !Array.isArray(st.content)) continue;
    const v = st.content.find((c) => c?.type === 'video' && (typeof c.data === 'string' || typeof c.uri === 'string'));
    if (v) return v;
  }
  const o = j.output_video;
  return isRecord(o) && (typeof o.data === 'string' || typeof o.uri === 'string') ? o : null;
}
const errorText = (j) => {
  const e = isRecord(j.error) ? j.error : Array.isArray(j.errors) ? j.errors.find(isRecord) : null;
  return e && typeof e.message === 'string' ? e.message : '';
};
/**
 * An interaction (scan's j) → what the browser may see: {id, status, done, video, error?, filtered?, usage?}.
 * video: true once a finished clip is there. A completed interaction without one was filtered (not billed). Exported.
 */
export function summarize(j, id, key = '') {
  const status = OMNI_STATUSES.includes(j.status) ? j.status : typeof j.status === 'string' && /^[a-z_]{1,24}$/.test(j.status) ? j.status : 'unknown';
  const out = { id: validId(j.id) ? j.id : id, status, done: !RUNNING.has(status) };
  const v = out.done ? videoItem(j) : null;
  out.video = Boolean(v);
  if (status === 'completed' && !v) { out.filtered = true; out.error = scrub(errorText(j), key) || 'Omni returned no video — it may have been filtered by its safety checks. Try rephrasing.'; }
  else if (out.done && status !== 'completed') out.error = scrub(errorText(j), key) || (status === 'cancelled' ? 'The video was cancelled.' : 'Gemini Omni couldn’t make this video.');
  const u = j.usage;
  if (isRecord(u)) {
    const n = (x) => (Number.isSafeInteger(x) && x >= 0 ? x : 0);
    out.usage = {
      total_input_tokens: n(u.total_input_tokens), total_output_tokens: n(u.total_output_tokens),
      output_tokens_by_modality: (Array.isArray(u.output_tokens_by_modality) ? u.output_tokens_by_modality : [])
        .filter((x) => isRecord(x) && typeof x.modality === 'string').slice(0, 8).map((x) => ({ modality: x.modality.slice(0, 16), tokens: n(x.tokens) })),
    };
  }
  if (!out.done) out.pollAfterMs = POLL_MS;
  return out;
}

/** GET /v1beta/interactions/{id} → {summary, scanned}. */
export async function omniGet(key, id) {
  if (!validId(id)) throw bad('Bad video id');
  const r = await call(key, 'GET', `interactions/${id}`);
  if (!r.ok) throw await upstreamError(r, 'Checking the Omni video', key);
  const s = await readInteraction(r);
  return { summary: summarize(s.j, id, key), scanned: s };
}

const b64Decode = (s) => {
  const t = s.replace(/\\/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(t);
  const bin = atob(t), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
/** A base64 range of `text` → a stream of its bytes, decoded LIMITS.slice characters at a time. Exported for tests. */
export function decodeStream(text, [start, end], slice = LIMITS.slice) {
  let at = start;
  // Slices on 4-character boundaries. JSON may escape "/" as "\/": then the range is decoded in one piece (rare).
  const bs = text.indexOf('\\', start), escaped = bs !== -1 && bs < end;
  const step = escaped ? end - start : Math.max(4, slice - (slice % 4));
  return new ReadableStream({
    pull(c) {
      if (at >= end) { c.close(); return; }
      const to = Math.min(end, at + step);
      try { c.enqueue(b64Decode(text.slice(at, to))); } catch { c.error(new Error('undecodable video data')); return; }
      at = to;
    },
  });
}

/** The finished clip of interaction `id` → a video/mp4 Response (409 omni_not_ready while it runs). */
export async function omniVideo(key, id, headers = {}) {
  const { summary, scanned } = await omniGet(key, id);
  if (!summary.done) throw new OmniError('The Omni video isn’t ready yet.', 409, 'omni_not_ready');
  if (!summary.video) throw new OmniError(summary.error || 'Omni made no video.', 404, 'omni_no_video');
  const v = videoItem(scanned.j);
  const type = /^video\/(mp4|webm)$/.test(v.mime_type || '') ? v.mime_type : 'video/mp4';
  const out = { ...headers, 'content-type': type, 'cache-control': 'private, no-store' };
  if (typeof v.data === 'string') {
    const m = v.data.match(/^@omni:(\d+)$/);
    if (m && scanned.blobs[+m[1]]) {
      const [s, e] = scanned.blobs[+m[1]];
      return new Response(decodeStream(scanned.text, [s, e]), { status: 200, headers: out });
    }
    if (v.data) return new Response(b64Decode(v.data), { status: 200, headers: out }); // a short clip left inline
  }
  // A hosted file (delivery 'uri'): only Google's own Files API host, fetched with the key, once it is ACTIVE.
  const f = typeof v.uri === 'string' && v.uri.match(FILE_URI);
  if (!f) { console.warn('omni video link refused'); throw new OmniError('Google returned a video link Atelier doesn’t trust.', 502, 'omni_failed'); }
  const meta = await call(key, 'GET', `files/${f[2]}`);
  if (meta.ok) {
    const st = (await meta.json().catch(() => null))?.state;
    if (st === 'FAILED') throw new OmniError('Google couldn’t finish processing this video.', 502, 'omni_failed');
    if (st && st !== 'ACTIVE') throw new OmniError('The Omni video is still being processed.', 409, 'omni_not_ready');
  } else meta.body?.cancel().catch(() => {});
  let res;
  try {
    res = await fetch(`${GEMINI_BASE}/v1beta/files/${f[2]}:download?alt=media`, { headers: { 'x-goog-api-key': key }, redirect: 'manual' });
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (loc) { res.body?.cancel().catch(() => {}); res = await fetch(new URL(loc, GEMINI_BASE).href, { redirect: 'follow' }); } // signed: no key on the hop
  } catch (err) {
    console.warn('omni download unreachable', scrub(err?.message, key, 120));
    throw new OmniError('Downloading the Omni video failed — try again.', 502, 'omni_unreachable');
  }
  if (!res.ok || !res.body) { res.body?.cancel().catch(() => {}); throw new OmniError(`Downloading the Omni video failed (${res.status}) — try again.`, 502, 'omni_failed'); }
  return new Response(res.body, { status: 200, headers: out });
}

/** POST /v1beta/interactions/{id}/cancel. A finished or missing interaction is fine. */
export async function omniCancel(key, id) {
  if (!validId(id)) throw bad('Bad video id');
  const r = await call(key, 'POST', `interactions/${id}/cancel`, {});
  r.body?.cancel().catch(() => {});
  if (r.ok || r.status === 404 || r.status === 400 || r.status === 409) return { ok: true };
  throw await upstreamError(r, 'Cancelling the Omni video', key);
}

// Reads the browser's JSON (at most LIMITS.body).
export async function readBody(req) {
  if (Number(req.headers.get('content-length') || 0) > LIMITS.body) throw new OmniError('This video request is too large (one image up to 5 MB).', 413, 'omni_too_large');
  const text = await readCappedText(req.body, LIMITS.body);
  if (text == null) throw new OmniError('This video request is too large (one image up to 5 MB).', 413, 'omni_too_large');
  try { return JSON.parse(text); } catch { return null; }
}

// ── the owner's spend record (src/spend.js) ──
const jobOf = (id) => `omni:${id}`;
/** What an owner clip is held at (µ$, Google's per-second price, no margin): an edit keeps its clip's length, so it is held at the longest (10 s). */
export const ownerQuote = (shaped, seconds = shaped.edit ? OMNI_SECONDS_MAX : shaped.seconds) => veoCost({ model: OMNI_PRICE_ID, seconds, resolution: shaped.resolution, margin: false });
/** A finished interaction (summarize's shape) → µ$ to record: its usage when it made a video (else null: the quote); $0 without one. */
export function ownerCost(summary) {
  if (!summary?.video) return 0;
  try { return omniActual({ model: OMNI_PRICE_ID, usage: summary.usage }); } catch { return null; }
}
// The statuses an owner hold settles on. Anything else (requires_action, a missing, uppercase or new status) is not known
// to be finished, so the hold stays at its quote and a later poll can still settle it to what Google reports.
export const OMNI_SETTLED = Object.freeze(['completed', 'failed', 'cancelled', 'incomplete']);
// A refused create: Google answered (nothing made, nothing billed) → $0; no answer, a gateway's answer (502, 504, 52x:
// Google may have started it) or a garbled one → the quote.
const settleRefused = (hold, err) => hold?.settle(err instanceof OmniError && err.code !== 'omni_unreachable' && err.code !== 'omni_failed' && !err.gateway ? 0 : null);

// The owner's start: when Google refuses the duration field itself, try once more without it (the clip then has
// Omni's own length, which the browser shows), so a format change on Google's side can't stop every video.
async function ownerStart(req, key, spend) {
  const shaped = shapeOmni(await readBody(req));
  const hold = spend ? await spend.start({ provider: 'omni', kind: 'video', model: OMNI_PRICE_ID, amount: ownerQuote(shaped) }) : null;
  const made = async (body, extra) => {
    const r = await omniCreate(key, body);
    await hold?.attach(jobOf(r.id));
    return { ...r, ...extra };
  };
  try {
    return await made(shaped.body, { seconds: shaped.seconds });
  } catch (err) {
    if (!(err instanceof OmniError) || err.code !== 'omni_rejected' || !/duration/i.test(err.message) || !shaped.body.response_format.duration) { await settleRefused(hold, err); throw err; }
    console.warn('omni: duration refused, retrying without it');
    await hold?.resize(ownerQuote(shaped, OMNI_SECONDS_MAX)); // Omni picks the length now: record the longest clip
    const { duration, ...rf } = shaped.body.response_format;
    try { return await made({ ...shaped.body, response_format: rf }, { seconds: null, durationIgnored: true }); }
    catch (again) { await settleRefused(hold, again); throw again; }
  }
}
// GET omni/status/<id> for the owner: a finished interaction settles its spend once (a resumed poll changes nothing);
// one Google no longer has settles at its quote.
async function ownerStatus(c, id) {
  let summary;
  try { ({ summary } = await omniGet(c.key, id)); }
  catch (err) { if (err instanceof OmniError && err.status === 404) await c.spend?.settleJob(jobOf(id), null); throw err; }
  if (summary.done && OMNI_SETTLED.includes(summary.status)) await c.spend?.settleJob(jobOf(id), ownerCost(summary));
  return json(summary);
}
// POST omni/cancel/<id> for the owner (Stop): once Google has the cancel, the hold settles to what the interaction shows
// (a clip it had already finished counts at its usage; a cancelled or still-unsettled one at $0). Nothing else ever polls
// a stopped video, so without this its quote would stay in the month.
async function ownerCancel(c, id) {
  const out = await omniCancel(c.key, id);
  if (!c.spend) return json(out);
  let summary = null;
  try { ({ summary } = await omniGet(c.key, id)); } catch { /* gone or unreadable: nothing more to bill */ }
  await c.spend.settleJob(jobOf(id), summary?.done && summary.status === 'completed' ? ownerCost(summary) : 0);
  return json(out);
}

const ROUTES = [
  ['POST', /^start$/, async (c) => json({ ...(await ownerStart(c.req, c.key, c.spend)), pollAfterMs: POLL_MS })],
  ['GET', /^status\/([A-Za-z0-9_-]{1,256})$/, (c, m) => ownerStatus(c, m[1])],
  ['GET', /^video\/([A-Za-z0-9_-]{1,256})$/, (c, m) => omniVideo(c.key, m[1])],
  ['POST', /^cancel\/([A-Za-z0-9_-]{1,256})$/, (c, m) => ownerCancel(c, m[1])],
];
/** An OmniError (or anything else) → the JSON error response. */
export function omniFail(err, key = '') {
  if (err instanceof OmniError) return json({ error: err.message, code: err.code }, err.status, err.headers);
  console.error('omni route failed', scrub(err?.message || err, key, 200));
  return json({ error: 'The Omni request failed — try again.', code: 'omni_failed' }, 502);
}

/**
 * /api/omni/* for the owner. path is relative to /api/ ('omni/status/<id>'); key: GEMINI_API_KEY behind the passcode;
 * spend: src/spend.js's ownerSpend(env), the owner's spend record (worker.js always passes it).
 */
export async function handleOmni(req, env, path, { key, spend = null } = {}) {
  if (!key) return json({ error: 'No Gemini key on the server (set GEMINI_API_KEY).' }, 401);
  const route = String(path || '').replace(/^\/?(api\/)?omni\//, '');
  try {
    for (const [method, re, fn] of ROUTES) {
      const m = route.match(re);
      if (m && req.method === method) return await fn({ req, env, key, spend }, m);
    }
    return json({ error: 'Not found' }, 404);
  } catch (err) { return omniFail(err, key); }
}
