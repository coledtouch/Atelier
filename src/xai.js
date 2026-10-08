// xAI (Grok) — owner only, behind the passcode, with the owner's own XAI_API_KEY (a Worker secret).
// Docs (read 2026-10-08): https://docs.x.ai/developers/models · https://docs.x.ai/developers/pricing
//   https://docs.x.ai/developers/model-capabilities/images/generation · …/video/generation · …/video/overview
//   REST reference: https://docs.x.ai/openapi.json (the same file as https://api.x.ai/api-docs/openapi.json)
//
// Chat goes through worker.js (CHAT_UPSTREAM.xai → POST https://api.x.ai/v1/chat/completions, OpenAI-compatible;
// shapeChatBody's xai block). This module does the rest, all for the owner only:
//   POST xai/image                {model, prompt, aspect?} → {data: [{b64_json, mime_type}], usd}
//   POST xai/video/start          {model, prompt, image?, aspect?, resolution?, seconds?} → {id, seconds, resolution, quote, pollAfterMs}
//   GET  xai/video/status/<id>    → {id, status, done, video, progress?, error?, usd?, pollAfterMs?} (never the link)
//   GET  xai/video/file/<id>      → video/mp4, fetched from xAI's temporary link WITHOUT the key
// Testers never reach any of it: the tester router answers xai/* with 403 owner_only (deny by default), and no xai:
// model is in a tester plan. Nothing here can search the web (Grok's web/X search is a Responses-API tool Atelier
// never sends). The key never leaves the Worker and never reaches a log or an error; prompts are never logged.

export const XAI_BASE = 'https://api.x.ai/v1';
export const XAI_SECRET = 'XAI_API_KEY';
export const XAI_PROVIDER = Object.freeze({ secret: XAI_SECRET, name: 'xAI' }); // PROVIDERS.xai in worker.js

// Grok Imagine image: $0.04 an image (pricing page; the models API names that the default tier, medium quality at 1k).
// Atelier pins quality 'medium' and resolution '1k' so the price is that one figure, and sends no image to edit (an
// edit also bills the input image).
export const XAI_IMAGE_MODELS = Object.freeze({ 'grok-imagine-image-2.0': Object.freeze({ usd: 0.04 }) });
export const XAI_IMAGE_ASPECTS = Object.freeze(['1:1', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2']);
// Grok Imagine video, per second of output (pricing page lists one rate per model).
export const XAI_VIDEO_MODELS = Object.freeze({
  'grok-imagine-video-1.5': Object.freeze({ usdPerSecond: 0.08 }),
  'grok-imagine-video-1.5-lite': Object.freeze({ usdPerSecond: 0.02 }),
});
export const XAI_VIDEO_ASPECTS = Object.freeze(['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3']);
export const XAI_VIDEO_RESOLUTIONS = Object.freeze(['480p', '720p', '1080p']);
export const XAI_SECONDS_MIN = 1, XAI_SECONDS_MAX = 15; // "duration: Range [1, 15]. Default: 8"
export const POLL_MS = 5000;
export const LIMITS = Object.freeze({ body: 8 * 1024 * 1024, image: 5 * 1024 * 1024, prompt: 4000, output: 150 * 1024 * 1024 });
const USD_TICKS = 1e10; // usage.cost_in_usd_ticks: one US cent is 100,000,000 ticks
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const IMAGE_DATA = /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/]+=*$/;
const DONE = new Set(['done', 'failed', 'expired']);

export class XaiError extends Error {
  constructor(message, status = 502, code = 'xai_failed', headers = {}) {
    super(message); this.name = 'XaiError'; this.status = status; this.code = code; this.headers = headers;
  }
}
const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
const bad = (message) => new XaiError(message, 400, 'xai_input');
const isRecord = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => isRecord(o) && Object.hasOwn(o, k);
export const validId = (id) => typeof id === 'string' && ID_RE.test(id);
const round = (usd) => Math.round(usd * 1e4) / 1e4;

// Text that may leave this module: no key, no links, no base64, no control characters, short.
export function scrub(text, key = '', max = 240) {
  let s = String(text ?? '');
  if (key) s = s.split(key).join('…');
  return s.replace(/\bxai-[A-Za-z0-9_-]{8,}/g, 'xai-…').replace(/\bhttps?:\/\/\S+/gi, '[link]').replace(/\bdata:[\w/+.-]*;base64,\S*/gi, 'data:…')
    .replace(/[A-Za-z0-9+/=_-]{200,}/g, '…').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max);
}

/** What `seconds` of a Grok Imagine video should cost by xAI's price list (USD), or null. */
export function videoQuote(model, seconds) {
  if (!own(XAI_VIDEO_MODELS, model) || !(Number(seconds) > 0)) return null;
  return round(Math.ceil(Number(seconds)) * XAI_VIDEO_MODELS[model].usdPerSecond);
}

// ── request shaping (pure: the browser's JSON → the exact body sent to xAI, or an XaiError 400) ──
const promptOf = (input, required) => {
  if (input.prompt != null && typeof input.prompt !== 'string') throw bad('prompt must be text.');
  const p = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!p && required) throw bad('Describe what you want Grok to make.');
  if (p.length > LIMITS.prompt) throw bad(`Grok Imagine prompts are limited to ${LIMITS.prompt.toLocaleString('en-US')} characters.`);
  return p;
};

/** {model, prompt, aspect?} → {body, usd}: one image, medium quality, 1k, base64 back. */
export function shapeImage(input) {
  if (!isRecord(input)) throw bad('Bad JSON body');
  const model = typeof input.model === 'string' ? input.model : '';
  if (!own(XAI_IMAGE_MODELS, model)) throw bad(`Atelier doesn’t offer the xAI image model “${model.replace(/[^\w.-]/g, '').slice(0, 40)}”.`);
  const prompt = promptOf(input, true);
  const aspect = input.aspect == null ? '1:1' : input.aspect;
  if (!XAI_IMAGE_ASPECTS.includes(aspect)) throw bad(`aspect must be one of ${XAI_IMAGE_ASPECTS.join(', ')}.`);
  return { body: { model, prompt, n: 1, aspect_ratio: aspect, resolution: '1k', quality: 'medium', response_format: 'b64_json' }, usd: XAI_IMAGE_MODELS[model].usd };
}

/**
 * {model, prompt, image?, aspect?, resolution?, seconds?} → {body, model, seconds, resolution, quote}.
 * Text → video needs a prompt; image → video takes one still (the output follows its shape, so no aspect_ratio is sent).
 * Defaults: 720p, 16:9, 6 s. Only these fields go to xAI: no storage/upload targets, no reference media, no keyframes.
 */
export function shapeVideo(input) {
  if (!isRecord(input)) throw bad('Bad JSON body');
  const model = typeof input.model === 'string' ? input.model : '';
  if (!own(XAI_VIDEO_MODELS, model)) throw bad(`Atelier doesn’t offer the xAI video model “${model.replace(/[^\w.-]/g, '').slice(0, 40)}”.`);
  let image = null;
  if (input.image != null) {
    if (typeof input.image !== 'string' || input.image.length > LIMITS.image + 32 || !IMAGE_DATA.test(input.image)) throw bad('The starting image must be a PNG, JPEG or WebP up to 5 MB.');
    image = input.image;
  }
  const prompt = promptOf(input, !image);
  const resolution = input.resolution == null ? '720p' : input.resolution;
  if (!XAI_VIDEO_RESOLUTIONS.includes(resolution)) throw bad(`resolution must be one of ${XAI_VIDEO_RESOLUTIONS.join(', ')}.`);
  const aspect = input.aspect == null ? '16:9' : input.aspect;
  if (!XAI_VIDEO_ASPECTS.includes(aspect)) throw bad(`aspect must be one of ${XAI_VIDEO_ASPECTS.join(', ')}.`);
  const seconds = input.seconds == null ? 6 : input.seconds;
  if (!Number.isInteger(seconds) || seconds < XAI_SECONDS_MIN || seconds > XAI_SECONDS_MAX) throw bad(`Grok Imagine clips are ${XAI_SECONDS_MIN}–${XAI_SECONDS_MAX} whole seconds.`);
  const body = { model, ...(prompt ? { prompt } : {}), duration: seconds, resolution };
  if (image) body.image = { url: image };
  else body.aspect_ratio = aspect;
  return { body, model, seconds, resolution, quote: videoQuote(model, seconds) };
}

// ── xAI calls ──
const authHeaders = (key) => ({ authorization: `Bearer ${key}`, accept: 'application/json' });
async function call(key, method, path, body, timeoutMs = 0) {
  const init = { method, headers: authHeaders(key), redirect: 'manual' };
  if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
  if (timeoutMs > 0) init.signal = AbortSignal.timeout(timeoutMs);
  try {
    return await fetch(`${XAI_BASE}/${path}`, init);
  } catch (err) {
    console.warn('xai unreachable', path.split('/')[0], err?.name === 'TimeoutError' ? `no answer in ${timeoutMs} ms` : scrub(err?.message, key, 120));
    throw new XaiError('xAI is unreachable right now — try again in a moment.', 502, 'xai_unreachable');
  }
}
const retryAfterOf = (r) => { const v = String(r.headers.get('retry-after') || '').trim(); return /^\d{1,5}$/.test(v) ? { 'retry-after': v } : {}; };
// xAI's out-of-credit and spending-limit answers (a 403, or a 429 that isn't a rate limit).
export const XAI_CREDIT = /credits?|spending limit|billing|purchase|balance|licen[cs]e/i;
/** A failed xAI answer → XaiError (its status and one scrubbed line; never the raw body). */
export async function upstreamError(r, what, key) {
  const text = await r.text().catch(() => '');
  let j = null;
  try { j = JSON.parse(text.slice(0, 65536)); } catch {}
  const raw = typeof j?.error === 'string' ? j.error : typeof j?.error?.message === 'string' ? j.error.message : typeof j?.message === 'string' ? j.message : '';
  const msg = scrub(raw, key, 240);
  console.warn('xai', what, r.status);
  const s = r.status;
  if ((s === 403 || s === 429) && XAI_CREDIT.test(raw)) return new XaiError(`xAI says the account is out of credits or over its spending limit — top up at console.x.ai.${msg ? ` (${msg})` : ''}`, 402, 'xai_credits');
  if (s === 400 || s === 422) return new XaiError(`xAI didn’t accept that request${msg ? ` — ${msg}` : '.'}`, 400, 'xai_rejected');
  if (s === 401 || s === 403) return new XaiError('xAI rejected the server’s API key (XAI_API_KEY) — run “Check provider keys” in Settings.', 403, 'xai_key');
  if (s === 404) return new XaiError('xAI no longer has that (it may have expired).', 404, 'xai_gone');
  if (s === 429) return new XaiError('xAI is rate limiting this key — try again in a moment.', 429, 'xai_limit', retryAfterOf(r));
  if (s >= 500) return new XaiError('xAI is busy right now — try again in a moment.', 503, 'xai_busy', retryAfterOf(r));
  return new XaiError(`${what} failed (${s}).`, 502, 'xai_failed');
}
const usdOf = (usage) => { const t = Number(usage?.cost_in_usd_ticks); return Number.isSafeInteger(t) && t >= 0 ? round(t / USD_TICKS) : null; };

async function readBody(req) {
  const len = Number(req.headers.get('content-length') || 0);
  if (len > LIMITS.body) throw new XaiError('This request is too large (one image up to 5 MB).', 413, 'xai_too_large');
  const reader = req.body?.getReader(), parts = [];
  let n = 0;
  while (reader) {
    const r = await reader.read();
    if (r.done) break;
    n += r.value.byteLength;
    if (n > LIMITS.body) { reader.cancel().catch(() => {}); throw new XaiError('This request is too large (one image up to 5 MB).', 413, 'xai_too_large'); }
    parts.push(r.value);
  }
  const all = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(all)); } catch { return null; }
}

async function image(req, key) {
  const shaped = shapeImage(await readBody(req));
  const what = 'Making the Grok image';
  const r = await call(key, 'POST', 'images/generations', shaped.body);
  if (!r.ok) throw await upstreamError(r, what, key);
  const j = await r.json().catch(() => null);
  const data = (Array.isArray(j?.data) ? j.data : []).filter((d) => isRecord(d) && typeof d.b64_json === 'string' && d.b64_json)
    .map((d) => ({ b64_json: d.b64_json, mime_type: /^image\/(png|jpeg|webp)$/.test(d.mime_type || '') ? d.mime_type : 'image/jpeg' }));
  if (!data.length) throw new XaiError('Grok returned no image — it may have been filtered. Try rephrasing.', 400, 'xai_filtered');
  return json({ data, usd: usdOf(j?.usage) ?? shaped.usd });
}

async function videoStart(req, key) {
  const shaped = shapeVideo(await readBody(req));
  const r = await call(key, 'POST', 'videos/generations', shaped.body); // never cut short: xAI may already bill
  if (!r.ok) throw await upstreamError(r, 'Starting the Grok video', key);
  const j = await r.json().catch(() => null);
  if (!validId(j?.request_id)) throw new XaiError('xAI didn’t return an id for the new video.', 502, 'xai_failed');
  return json({ id: j.request_id, model: shaped.model, seconds: shaped.seconds, resolution: shaped.resolution, quote: shaped.quote, pollAfterMs: POLL_MS });
}

// GET /v1/videos/{id}: 200 {status: pending | done | failed | expired, progress, video: {url, duration, respect_moderation}, usage}
// (202 while it is still being made). → {status, video: {url, duration} | null, j}.
async function videoGet(key, id) {
  if (!validId(id)) throw bad('Bad video id');
  const r = await call(key, 'GET', `videos/${id}`);
  if (r.status === 202) { const j = await r.json().catch(() => ({})); return { j: isRecord(j) ? { status: 'pending', ...j } : { status: 'pending' } }; }
  if (!r.ok) throw await upstreamError(r, 'Checking the Grok video', key);
  const j = await r.json().catch(() => null);
  if (!isRecord(j)) throw new XaiError('xAI returned an unexpected answer for this video.', 502, 'xai_failed');
  return { j };
}
/** A video poll answer → what the browser may see (never the link). Exported for tests. */
export function summarize(j, id, key = '') {
  const status = typeof j.status === 'string' && /^[a-z_]{1,24}$/.test(j.status) ? j.status : 'unknown';
  const done = DONE.has(status);
  const out = { id, status, done, video: false };
  if (!done && Number.isInteger(j.progress) && j.progress >= 0 && j.progress <= 100) out.progress = j.progress;
  const v = isRecord(j.video) ? j.video : null;
  if (status === 'done') {
    if (v && v.respect_moderation === false) { out.filtered = true; out.error = 'Grok’s moderation held this video back — try rephrasing.'; }
    else if (v && typeof v.url === 'string' && v.url) { out.video = true; if (Number.isInteger(v.duration) && v.duration > 0) out.seconds = v.duration; }
    else out.error = 'Grok finished without a video — try again.';
  } else if (status === 'failed') {
    const m = isRecord(j.error) && typeof j.error.message === 'string' ? scrub(j.error.message, key) : '';
    if (isRecord(j.error) && j.error.code === 'invalid_argument' && /moderat|policy|safety/i.test(m)) out.filtered = true;
    out.error = m || 'Grok couldn’t make this video.';
  } else if (status === 'expired') out.error = 'xAI no longer has this video (it expired).';
  const usd = usdOf(j.usage);
  if (usd != null) out.usd = usd;
  if (!done) out.pollAfterMs = POLL_MS;
  return out;
}

// xAI's temporary media links: https on x.ai hosts only (vidgen.x.ai, files-cdn.x.ai …).
export function mediaUrlOk(u) {
  let x;
  try { x = new URL(u); } catch { return false; }
  const h = x.hostname.toLowerCase();
  return x.protocol === 'https:' && !x.username && !x.password && (x.port === '' || x.port === '443') && (h === 'x.ai' || h.endsWith('.x.ai'));
}
function capped(body, max) {
  let n = 0;
  return body.pipeThrough(new TransformStream({ transform(chunk, c) { n += chunk.byteLength; if (n > max) c.error(new Error('xAI output over the size cap')); else c.enqueue(chunk); } }));
}
async function videoFile(key, id) {
  const { j } = await videoGet(key, id);
  const s = summarize(j, id, key);
  if (!s.done) throw new XaiError('The Grok video isn’t ready yet.', 409, 'xai_not_ready');
  if (!s.video) throw new XaiError(s.error || 'Grok made no video.', 404, 'xai_no_video');
  let link = j.video.url;
  if (!mediaUrlOk(link)) { console.warn('xai video host refused'); throw new XaiError('xAI returned a download link Atelier doesn’t trust.', 502, 'xai_failed'); }
  let res;
  try {
    for (let hop = 0; ; hop++) {
      res = await fetch(link, { method: 'GET', redirect: 'manual' }); // no key on the media request
      const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!loc) break;
      res.body?.cancel().catch(() => {});
      const next = new URL(loc, link).href;
      if (hop >= 2 || !mediaUrlOk(next)) { console.warn('xai video redirect refused'); throw new XaiError('xAI’s download redirected somewhere Atelier doesn’t trust.', 502, 'xai_failed'); }
      link = next;
    }
  } catch (err) {
    if (err instanceof XaiError) throw err;
    console.warn('xai video unreachable', scrub(err?.message, key, 120));
    throw new XaiError('Downloading the Grok video failed — try again.', 502, 'xai_unreachable');
  }
  if (!res.ok || !res.body) { res.body?.cancel().catch(() => {}); throw new XaiError(`Downloading the Grok video failed (${res.status}) — try again.`, 502, 'xai_failed'); }
  const declared = Number(res.headers.get('content-length'));
  if (Number.isSafeInteger(declared) && declared > LIMITS.output) { res.body.cancel().catch(() => {}); throw new XaiError('The Grok video is too big to bring into Atelier.', 502, 'xai_too_large'); }
  const headers = { 'content-type': /^video\/webm\b/i.test(res.headers.get('content-type') || '') ? 'video/webm' : 'video/mp4', 'cache-control': 'private, no-store' };
  if (s.usd != null) headers['x-xai-usd'] = String(s.usd);
  return new Response(capped(res.body, LIMITS.output), { status: 200, headers });
}

const ROUTES = [
  ['POST', /^image$/, (c) => image(c.req, c.key)],
  ['POST', /^video\/start$/, (c) => videoStart(c.req, c.key)],
  ['GET', /^video\/status\/([A-Za-z0-9_-]{1,128})$/, async (c, m) => { const { j } = await videoGet(c.key, m[1]); return json(summarize(j, m[1], c.key)); }],
  ['GET', /^video\/file\/([A-Za-z0-9_-]{1,128})$/, (c, m) => videoFile(c.key, m[1])],
];
/** An XaiError (or anything else) → the JSON error response. */
export function xaiFail(err, key = '') {
  if (err instanceof XaiError) return json({ error: err.message, code: err.code }, err.status, err.headers);
  console.error('xai route failed', scrub(err?.message || err, key, 200));
  return json({ error: 'The xAI request failed — try again.', code: 'xai_failed' }, 502);
}

/** /api/xai/* for the owner. path is relative to /api/ ('xai/video/status/<id>'); key: XAI_API_KEY behind the passcode. */
export async function handleXai(req, env, path, { key } = {}) {
  if (!key) return json({ error: 'No xAI key on the server (set XAI_API_KEY).' }, 401);
  const route = String(path || '').replace(/^\/?(api\/)?xai\//, '');
  try {
    for (const [method, re, fn] of ROUTES) {
      const m = route.match(re);
      if (m && req.method === method) return await fn({ req, env, key }, m);
    }
    return json({ error: 'Not found' }, 404);
  } catch (err) { return xaiFail(err, key); }
}

/** /api/diag: the free GET /v1/api-key → {ok, status, message}. Says whether the key or team is blocked; never echoes ids. */
export async function xaiDiag(key) {
  try {
    const r = await call(key, 'GET', 'api-key', undefined, 8000);
    if (!r.ok) { const e = await upstreamError(r, 'Checking the xAI key', key); return { ok: false, status: r.status, message: e.message }; }
    const j = await r.json().catch(() => null);
    if (!isRecord(j)) return { ok: false, status: 502, message: 'xAI returned an unexpected answer.' };
    if (j.team_blocked === true) return { ok: false, status: 403, message: 'The xAI team is blocked — check billing at console.x.ai.' };
    if (j.api_key_blocked === true || j.api_key_disabled === true) return { ok: false, status: 403, message: 'This xAI key is blocked or disabled — make a new one at console.x.ai.' };
    return { ok: true, status: 200, message: 'key active' };
  } catch (err) {
    return { ok: false, status: err instanceof XaiError ? err.status : 0, message: err instanceof XaiError ? err.message : 'xAI is unreachable.' };
  }
}
