// Runway video (owner only) — /api/runway/* behind the passcode. Docs: https://docs.dev.runwayml.com (API 2024-11-06).
//
// Generation is asynchronous. A POST starts a Runway task and returns its id at once; the browser then polls
// GET runway/task/<id> no more often than every 5 s (with jitter, see public/runway.js) and finally downloads the MP4
// through GET runway/output/<id>. The Worker never holds a request open while Runway works, and Runway's signed,
// expiring output links (CloudFront `_jwt` URLs) never leave the Worker.
//
// Owner only for now: Runway's terms need a "Powered by Runway" link and an end-user agreement before end users get
// access, and blocked prompts are billed. The tester router refuses every runway/* path (403 owner_only) before this
// module runs, and handleRunway itself refuses to work without the key the Worker resolved behind the passcode.
//
// Wiring (src/worker.js, after the tester dispatch):
//   if (path.startsWith('runway/')) { const key = resolveKey(req, env, 'runway'); if (!key) return missingKey(req, env, 'runway');
//     return handleRunway(req, env, url, path, { key, spend: ownerSpend(env) }); }
// spend (src/spend.js): the owner's spend record (Settings → Spending). A new video is recorded at its quote (never
// refused), tied to its task once Runway accepts it, and settled to Runway's reported cost when a poll or the download
// sees it finish.
import { isGatewayStatus } from './spend.js';

export const RUNWAY_BASE = 'https://api.dev.runwayml.com/v1'; // not api.runwayml.com
export const RUNWAY_VERSION = '2024-11-06'; // X-Runway-Version, required on every call
export const RUNWAY_SECRET = 'RUNWAYML_API_SECRET'; // the name Runway's own SDKs read
export const RUNWAY_PROVIDER = Object.freeze({ secret: RUNWAY_SECRET, name: 'Runway' }); // PROVIDERS.runway in worker.js
export const USD_PER_CREDIT = 0.01;
export const POLL_MS = 5000; // Runway updates a task at most every 5 s
export const BODY_MAX = 8 * 1024 * 1024; // generate request JSON
export const DATA_URI_MAX = 5_242_880; // Runway's cap on one data: URI string
export const RUNWAY_URI_MAX = 5000;
export const PROMPT_MAX = 1000; // UTF-16 code units
export const UPLOAD_MIN = 512, UPLOAD_MAX = 95 * 1024 * 1024; // Runway: 512 B–200 MB; Cloudflare caps request bodies at 100 MB
export const UPLOAD_TTL_MS = 23 * 3600 * 1000; // runway:// URIs live 24 h; leave an hour of margin
export const OUTPUT_MAX = 150 * 1024 * 1024; // what Atelier will carry back to the browser for one video

const I2V_RATIOS = Object.freeze(['1280:720', '720:1280', '1104:832', '832:1104', '960:960', '1584:672']);
const T2V_RATIOS = Object.freeze(['1280:720', '720:1280']);
// Google Veo 3.1 through Runway (OpenAPI schema, docs.dev.runwayml.com/openapi.json, read 2026-10-07): text and image →
// video, these four ratios, 4/6/8 s, an `audio` flag (default true; audio doubles the price), no outputFormat field.
const VEO_RATIOS = Object.freeze(['1280:720', '720:1280', '1080:1920', '1920:1080']);
const VEO_DURATIONS = Object.freeze([4, 6, 8]);
// xAI's Grok Imagine Video 1.5 and 1.5 Lite through Runway (OpenAPI schema, docs.dev.runwayml.com/openapi.json, read
// 2026-10-08; changelog 2026-08-07 and 2026-10-01). Both: text and image → video, 1–15 whole seconds, prompts up to 2,500
// characters, no outputFormat, no audio flag (1.5 makes native audio). Text → video needs a prompt; image → video takes
// one first frame and the output follows its shape.
//   grok_imagine_1_5:      text → video takes `ratio` (GROK_T2V_RATIOS) and `resolution`; image → video `resolution` only.
//   grok_imagine_1_5_lite: no `resolution` field — the ratio carries it: width:height sizes for text → video, auto_<res>
//                          for image → video (1080p is made at 720p and upscaled).
// Price by resolution (https://docs.dev.runwayml.com/guides/pricing/): 1.5 10 / 16 / 29 credits a second at 480p / 720p
// / 1080p, Lite 2 / 3 / 14, plus 1 credit for an image → video start frame (Atelier sends no other references).
const GROK_RESOLUTIONS = Object.freeze(['480p', '720p', '1080p']);
const GROK_T2V_RATIOS = Object.freeze(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']);
const GROK_LITE_T2V_RATIOS = Object.freeze(['848:480', '480:848', '480:480', '640:480', '480:640', '720:480', '480:720', '1280:720', '720:1280', '720:720', '960:720',
  '720:960', '1088:720', '720:1088', '1904:1072', '1072:1904', '1424:1424', '1648:1232', '1232:1648', '1744:1152', '1152:1744']);
const GROK_LITE_I2V_RATIOS = Object.freeze(['auto_480p', 'auto_720p', 'auto_1080p']);
const GROK_PROMPT_MAX = 2500;
/** A Grok Imagine Lite ratio → the resolution it is billed at ('auto_720p' → '720p'; '1280:720' → '720p'; 1072+ → '1080p'). */
export function grokLiteResolution(ratio) {
  const a = /^auto_(480p|720p|1080p)$/.exec(String(ratio));
  if (a) return a[1];
  const m = /^(\d+):(\d+)$/.exec(String(ratio));
  if (!m) return null;
  const short = Math.min(+m[1], +m[2]);
  return short <= 480 ? '480p' : short <= 720 ? '720p' : '1080p';
}
// ByteDance's Seedance 2.5 through Runway (OpenAPI schema, docs.dev.runwayml.com/openapi.json, read 2026-10-08; released
// 2026-08-07). Text and image → video (video → video exists too; Atelier doesn't send it), 4–30 whole seconds (or
// "auto", never sent: billed at the maximum up front), prompts up to 15,000 characters, an `audio` flag (default true),
// `seed`; no outputFormat, no contentModeration, no `resolution` field — the ratio carries it (six per tier below).
// No `draft` field is in the schema (additionalProperties: false), although the pricing guide mentions draft previews:
// Atelier never sends one. Price (https://docs.dev.runwayml.com/guides/pricing/): 20 / 30 / 68 credits per output second
// at 480p / 720p / 1080p, audio free, at least 80 credits a generation (input/reference video would add 10 / 15 / 34 a
// second — Atelier sends none; reference images are free).
const SEEDANCE_RATIOS = Object.freeze([
  '992:432', '854:480', '752:560', '640:640', '560:752', '480:854', // 480p
  '1470:630', '1280:720', '1112:834', '960:960', '834:1112', '720:1280', // 720p
  '2206:946', '1920:1080', '1664:1248', '1440:1440', '1248:1664', '1080:1920', // 1080p
]);
const SEEDANCE_PROMPT_MAX = 15000;
/** A Seedance 2.5 ratio → the resolution tier it is billed at (by its place in the schema's list), or null. */
export function seedanceResolution(ratio) {
  const i = SEEDANCE_RATIOS.indexOf(String(ratio));
  return i < 0 ? null : ['480p', '720p', '1080p'][Math.floor(i / 6)];
}
// The only Runway models Atelier sends. kinds: endpoint → allowed ratios (null: the model has no ratio).
// mp4: the model takes outputFormat, which is always forced to 'mp4' (no ProRes/HDR surcharges). durations: the lengths
// the model takes (else DURATION_MIN–DURATION_MAX). creditsNoAudio: the rate when audio: false is sent (Veo 3.1).
// Prices: https://docs.dev.runwayml.com/guides/pricing/ (Veo 3.1: 40 credits/s with audio, 20 without; Fast 15 / 10).
export const RUNWAY_MODELS = Object.freeze({
  'gen4.5': Object.freeze({ creditsPerSecond: 12, minCredits: 0, promptRequired: true, mp4: true, kinds: Object.freeze({ text_to_video: T2V_RATIOS, image_to_video: I2V_RATIOS }) }),
  gen4_turbo: Object.freeze({ creditsPerSecond: 5, minCredits: 0, promptRequired: false, mp4: false, kinds: Object.freeze({ image_to_video: I2V_RATIOS }) }),
  aleph2: Object.freeze({ creditsPerSecond: 28, minCredits: 56, promptRequired: true, mp4: true, kinds: Object.freeze({ video_to_video: null }) }),
  'veo3.1': Object.freeze({ creditsPerSecond: 40, creditsNoAudio: 20, minCredits: 0, promptRequired: true, mp4: false, audio: true, durations: VEO_DURATIONS, kinds: Object.freeze({ text_to_video: VEO_RATIOS, image_to_video: VEO_RATIOS }) }),
  'veo3.1_fast': Object.freeze({ creditsPerSecond: 15, creditsNoAudio: 10, minCredits: 0, promptRequired: true, mp4: false, audio: true, durations: VEO_DURATIONS, kinds: Object.freeze({ text_to_video: VEO_RATIOS, image_to_video: VEO_RATIOS }) }),
  // grok: per-resolution rates (creditsPerSecond is the 720p default), 1–15 s, its own prompt limit and ratio rules.
  grok_imagine_1_5: Object.freeze({ creditsPerSecond: 16, rates: Object.freeze({ '480p': 10, '720p': 16, '1080p': 29 }), stillCredits: 1, minCredits: 0, promptRequired: false, promptMax: GROK_PROMPT_MAX, mp4: false,
    grok: true, resolution: true, durationRange: Object.freeze([1, 15]), kinds: Object.freeze({ text_to_video: GROK_T2V_RATIOS, image_to_video: null }) }),
  grok_imagine_1_5_lite: Object.freeze({ creditsPerSecond: 3, rates: Object.freeze({ '480p': 2, '720p': 3, '1080p': 14 }), stillCredits: 1, minCredits: 0, promptRequired: false, promptMax: GROK_PROMPT_MAX, mp4: false,
    grok: true, resolution: false, durationRange: Object.freeze([1, 15]), kinds: Object.freeze({ text_to_video: GROK_LITE_T2V_RATIOS, image_to_video: GROK_LITE_I2V_RATIOS }) }),
  // seedance: per-resolution rates set by the ratio (creditsPerSecond is 720p's), 4–30 s, an 80-credit minimum.
  seedance2_5: Object.freeze({ creditsPerSecond: 30, rates: Object.freeze({ '480p': 20, '720p': 30, '1080p': 68 }), minCredits: 80, promptRequired: false, promptMax: SEEDANCE_PROMPT_MAX, mp4: false,
    seedance: true, audio: true, durationRange: Object.freeze([4, 30]), kinds: Object.freeze({ text_to_video: SEEDANCE_RATIOS, image_to_video: SEEDANCE_RATIOS }) }),
});
export const KINDS = Object.freeze(['image_to_video', 'text_to_video', 'video_to_video']);
export const TARGET_ASPECTS = Object.freeze(['16:9', '4:3', '3:2', '1:1', '2:3', '3:4', '9:16', '21:9']);
export const DURATION_MIN = 2, DURATION_MAX = 10, DURATION_DEFAULT = 5; // gen4_turbo's default is undocumented: always send one
export const UPLOAD_TYPES = Object.freeze({ 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/x-matroska': 'mkv', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' });
export const STATUSES = Object.freeze(['PENDING', 'THROTTLED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED']);
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_DATA = /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/]+=*$/;
const RUNWAY_URI = /^runway:\/\/[^\s"'<>\\]+$/;

// A failure with the HTTP status and JSON fields ({error, ...extra}) the routes answer with.
export class RunwayError extends Error {
  constructor(message, status = 502, extra = {}, headers = {}) {
    super(message);
    this.name = 'RunwayError';
    this.status = status;
    this.extra = extra;
    this.headers = headers;
  }
}

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
const bad = (message, extra = {}) => new RunwayError(message, 400, { code: 'runway_input', ...extra });
const isRecord = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => isRecord(o) && Object.hasOwn(o, k);
const usd = (credits) => Math.round(credits) / 100;
export const costOf = (credits) => (Number.isFinite(credits) && credits >= 0 ? { credits, usd: usd(credits) } : null);

// What a generation should cost by Runway's price list → {credits, usd}, or null when the length is unknown.
// audio: false only for a model that takes the flag (Veo 3.1's silent rate); anything else quotes with audio.
// opts (Grok Imagine): {resolution} picks the per-resolution rate (else 720p's), {still: true} adds the start frame.
export function quote(model, seconds, audio = true, { resolution, still = false } = {}) {
  const m = RUNWAY_MODELS[model];
  if (!own(RUNWAY_MODELS, model) || !(Number(seconds) > 0)) return null;
  const rate = m.rates && own(m.rates, resolution) ? m.rates[resolution] : audio === false && m.creditsNoAudio ? m.creditsNoAudio : m.creditsPerSecond;
  return costOf(Math.max(m.minCredits, Math.ceil(Number(seconds)) * rate + (still && m.stillCredits ? m.stillCredits : 0)));
}

// Text that may leave this module (responses and logs): no key, no links (signed CloudFront URLs carry a `_jwt`
// bearer token), no runway:// or data: payloads, no control characters, short.
export function scrub(text, key, max = 240) {
  let s = String(text ?? '');
  if (key) s = s.split(key).join('…');
  return s
    .replace(/\bkey_[0-9a-f]{16,}/gi, 'key_…')
    .replace(/\bhttps?:\/\/\S+/gi, '[link]')
    .replace(/\brunway:\/\/\S+/gi, 'runway://…')
    .replace(/\bdata:[\w/+.-]*;base64,\S*/gi, 'data:…')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max);
}

const authHeaders = (key) => ({ authorization: `Bearer ${key}`, 'x-runway-version': RUNWAY_VERSION, accept: 'application/json' });

// Every call to Runway: no redirects (the bearer key must not follow one), network failures → a clean 502.
// timeoutMs: set only for the account read, which Settings → Connections waits on. A create or an upload is never cut
// short here: Runway may already have started (and billed) a task the Worker would then never report.
async function call(key, method, path, body, what, timeoutMs = 0) {
  const init = { method, headers: authHeaders(key), redirect: 'manual' };
  if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
  if (timeoutMs > 0) init.signal = AbortSignal.timeout(timeoutMs);
  try {
    return await fetch(`${RUNWAY_BASE}/${path}`, init);
  } catch (err) {
    console.warn('runway unreachable', what, err?.name === 'TimeoutError' ? `no answer in ${timeoutMs} ms` : scrub(err?.message, key, 120));
    throw new RunwayError(`${what} failed — Runway is unreachable. Try again in a moment.`, 502, { code: 'runway_unreachable' });
  }
}
// The account read (Settings → Connections, Check provider keys): a slow Runway answers runway_unreachable instead.
export const ACCOUNT_TIMEOUT_MS = 8000;

const retryAfterOf = (r) => { const v = String(r.headers.get('retry-after') || '').trim(); return /^\d{1,5}$/.test(v) ? { 'retry-after': v } : {}; };

// Runway's 400 body {error, docUrl, issues:[{code, path, message}]} → one short, scrubbed line (never the raw body).
function issueText(j, key) {
  const parts = [];
  if (typeof j?.error === 'string') parts.push(j.error);
  const i = Array.isArray(j?.issues) ? j.issues[0] : null;
  if (isRecord(i)) {
    const path = Array.isArray(i.path) ? i.path.filter((p) => typeof p === 'string' || Number.isInteger(p)).join('.') : typeof i.path === 'string' ? i.path : '';
    const msg = typeof i.message === 'string' ? i.message : '';
    if (path || msg) parts.push(`${path ? `${path}: ` : ''}${msg}`);
  }
  return scrub(parts.join(' — '), key, 240);
}

// A failed Runway response → RunwayError. Logs the status, what was being done and Runway's issue codes only — never
// bodies (they can echo the prompt), keys or links.
async function upstreamError(r, what, key) {
  const text = await r.text().catch(() => '');
  let j = null;
  try { j = JSON.parse(text.slice(0, 65536)); } catch {}
  const codes = Array.isArray(j?.issues) ? j.issues.map((i) => (typeof i?.code === 'string' && /^[\w.-]{1,40}$/.test(i.code) ? i.code : '')).filter(Boolean).slice(0, 5) : [];
  console.warn('runway', what, r.status, codes.join(',') || '-');
  const s = r.status;
  if (s === 400 || s === 422) {
    const detail = issueText(j, key);
    return new RunwayError(`Runway didn’t accept that request${detail ? ` — ${detail}` : '.'}`, 400, { code: 'runway_rejected' });
  }
  if (s === 401 || s === 403) return new RunwayError('Runway rejected the server’s API key (RUNWAYML_API_SECRET) — it may be disabled, or the Runway account suspended. Run “Check provider keys” in Settings.', 403, { code: 'runway_key' });
  if (s === 402) return new RunwayError('Runway says the account is out of credits — top up at dev.runway.com.', 402, { code: 'runway_credits' });
  if (s === 413) return new RunwayError('That’s too large for Runway.', 413, { code: 'runway_too_large' });
  if (s === 429) return new RunwayError('Runway is limiting this account right now (its daily or tier limit) — try again later.', 429, { code: 'runway_limit' }, retryAfterOf(r));
  if (s >= 500) return new RunwayError('Runway is busy right now — try again in a moment.', 503, { code: 'runway_busy' }, retryAfterOf(r));
  return new RunwayError(`${what} failed (${s}).`, 502, { code: 'runway_failed' });
}

// ── request shaping (pure: plain object in → the exact body sent to Runway, or a RunwayError 400) ──

function dataOrRunwayUri(v, what) {
  if (typeof v !== 'string') throw bad(`${what} is missing.`);
  if (v.startsWith('runway://')) {
    if (v.length < 13 || v.length > RUNWAY_URI_MAX || !RUNWAY_URI.test(v)) throw bad(`${what} isn’t a usable runway:// upload.`);
    return v;
  }
  if (v.startsWith('data:')) {
    if (v.length > DATA_URI_MAX) throw new RunwayError(`${what} is too large for Runway (5 MB as base64) — use a smaller image.`, 413, { code: 'runway_too_large' });
    if (!IMAGE_DATA.test(v)) throw bad(`${what} must be a JPEG, PNG or WebP image.`);
    return v;
  }
  throw bad(`${what} must be an image sent from Atelier (a data: image or a runway:// upload).`);
}
const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const numIn = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

// kind ∈ KINDS; input: the browser's JSON. → {model, kind, body, seconds} (seconds: the billed length, when known).
export function shapeRequest(kind, input) {
  if (!KINDS.includes(kind)) throw new RunwayError('Unknown Runway route.', 404, { code: 'runway_route' });
  if (!isRecord(input)) throw bad('Bad JSON body');
  const model = typeof input.model === 'string' ? input.model : '';
  if (!own(RUNWAY_MODELS, model)) throw bad(`Atelier doesn’t offer the Runway model “${model.replace(/[^\w.-]/g, '').slice(0, 40)}”.`, { code: 'runway_model' });
  const spec = RUNWAY_MODELS[model];
  if (!own(spec.kinds, kind)) {
    throw bad(model === 'gen4_turbo' ? 'Runway Gen-4 Turbo only animates a still image (image → video).'
      : model === 'aleph2' ? 'Runway Aleph only edits a video (video → video).' : `Runway ${model} can’t do ${kind.replace(/_/g, ' ')}.`);
  }
  const body = { model };

  if (input.promptText != null && typeof input.promptText !== 'string') throw bad('promptText must be text.');
  const prompt = typeof input.promptText === 'string' ? input.promptText.trim() : '';
  const promptMax = spec.promptMax || PROMPT_MAX;
  if (prompt.length > promptMax) throw bad(`Runway prompts are limited to ${promptMax} characters.`);
  if (prompt) body.promptText = prompt;
  else if (spec.promptRequired || ((spec.grok || spec.seedance) && kind === 'text_to_video')) throw bad(kind === 'video_to_video' ? 'Describe the edit you want Runway to make.' : 'Describe the video you want Runway to make.');
  if (spec.grok) return shapeGrok(kind, input, spec, body);
  if (spec.seedance) return shapeSeedance(kind, input, spec, body);

  let seconds = null;
  if (kind === 'video_to_video') {
    const v = input.videoUri;
    // Only clips uploaded through Atelier: Runway never fetches an arbitrary host on our behalf.
    if (typeof v !== 'string' || v.length < 13 || v.length > RUNWAY_URI_MAX || !RUNWAY_URI.test(v)) throw bad('Aleph edits only take a clip uploaded through Atelier (runway://…).');
    body.videoUri = v;
    if (input.keyframes != null) {
      const k = input.keyframes;
      if (!Array.isArray(k) || k.length < 1 || k.length > 5) throw bad('Aleph takes 1 to 5 keyframes.');
      const ranged = k.filter((f) => isRecord(f) && f.range != null).length;
      if (ranged && ranged !== k.length) throw bad('Either every keyframe has a range or none does.');
      body.keyframes = k.map((f, n) => {
        if (!isRecord(f)) throw bad(`Keyframe ${n + 1} is malformed.`);
        const out = { uri: dataOrRunwayUri(f.uri, `Keyframe ${n + 1}`) };
        const hasS = f.seconds != null, hasAt = f.at != null;
        if (hasS === hasAt) throw bad(`Keyframe ${n + 1} needs either seconds or at.`);
        if (hasS) { if (!numIn(f.seconds, 0, 30)) throw bad(`Keyframe ${n + 1}: seconds must be 0–30.`); out.seconds = f.seconds; }
        else { if (!numIn(f.at, 0, 1)) throw bad(`Keyframe ${n + 1}: at must be 0–1.`); out.at = f.at; }
        if (f.range != null) {
          const r = f.range;
          if (!isRecord(r) || !intIn(r.start_seconds, 0, 30) || !intIn(r.end_seconds, 1, 30) || r.end_seconds <= r.start_seconds) throw bad(`Keyframe ${n + 1}: range needs whole seconds with start < end.`);
          out.range = { start_seconds: r.start_seconds, end_seconds: r.end_seconds };
        }
        return out;
      });
    }
    if (input.targetAspectRatio != null) {
      if (!TARGET_ASPECTS.includes(input.targetAspectRatio)) throw bad(`targetAspectRatio must be one of ${TARGET_ASPECTS.join(', ')}.`);
      body.targetAspectRatio = input.targetAspectRatio;
    }
    // (the deprecated `ratio` field is never sent; Aleph has no duration — it bills the clip's own length)
    if (numIn(input.seconds, 0, 30)) seconds = input.seconds; // the browser's clip length, for the quote only
  } else {
    if (kind === 'image_to_video') body.promptImage = dataOrRunwayUri(input.promptImage, 'The image');
    const ratios = spec.kinds[kind];
    const ratio = input.ratio == null ? ratios[0] : input.ratio;
    if (!ratios.includes(ratio)) throw bad(`Runway ${model} (${kind.replace(/_/g, ' ')}) takes the ratios ${ratios.join(', ')}.`);
    body.ratio = ratio;
    const d = input.duration == null ? (spec.durations ? 6 : DURATION_DEFAULT) : input.duration;
    if (spec.durations ? !spec.durations.includes(d) : !intIn(d, DURATION_MIN, DURATION_MAX)) {
      throw bad(spec.durations ? `Runway ${model} clips are ${spec.durations.join(', ')} seconds.` : `Runway clips are ${DURATION_MIN}–${DURATION_MAX} whole seconds.`);
    }
    body.duration = seconds = d;
    if (spec.audio && input.audio != null) {
      if (typeof input.audio !== 'boolean') throw bad('audio must be true or false.');
      body.audio = input.audio;
    }
  }
  if (input.seed != null) {
    if (!intIn(input.seed, 0, 4294967295)) throw bad('seed must be a whole number from 0 to 4294967295.');
    body.seed = input.seed;
  }
  if (input.contentModeration != null) {
    const t = input.contentModeration?.publicFigureThreshold;
    if (!isRecord(input.contentModeration) || (t != null && t !== 'auto' && t !== 'low')) throw bad('contentModeration.publicFigureThreshold must be auto or low.');
    if (t) body.contentModeration = { publicFigureThreshold: t };
  }
  if (spec.mp4) body.outputFormat = 'mp4'; // whatever was asked: ProRes/HDR formats cost +5 to +40 credits a second
  return { model, kind, body, seconds, audio: body.audio !== false };
}

// Grok Imagine (spec.grok): ratio and resolution by its own rules, 1–15 whole seconds, nothing else (no seed, no
// moderation settings, no references). → the same {model, kind, body, seconds, audio} plus {resolution, still}.
function shapeGrok(kind, input, spec, body) {
  const { model } = body;
  if (kind === 'image_to_video') body.promptImage = dataOrRunwayUri(input.promptImage, 'The image');
  const ratios = spec.kinds[kind];
  let resolution;
  if (spec.resolution) { // grok_imagine_1_5: resolution field (default 720p); text → video also a ratio (default 16:9)
    resolution = input.resolution == null ? '720p' : input.resolution;
    if (!GROK_RESOLUTIONS.includes(resolution)) throw bad(`Runway ${model} takes the resolutions ${GROK_RESOLUTIONS.join(', ')}.`);
    if (ratios) {
      const ratio = input.ratio == null ? '16:9' : input.ratio;
      if (!ratios.includes(ratio)) throw bad(`Runway ${model} (${kind.replace(/_/g, ' ')}) takes the ratios ${ratios.join(', ')}.`);
      body.ratio = ratio;
    } else if (input.ratio != null) throw bad(`Runway ${model} takes no ratio for image to video (the output follows the image).`);
    body.resolution = resolution;
  } else { // grok_imagine_1_5_lite: the ratio carries the resolution (default 720p)
    if (input.resolution != null) throw bad(`Runway ${model} takes no resolution field — pick a ratio of that size.`);
    const ratio = input.ratio == null ? (kind === 'image_to_video' ? 'auto_720p' : '1280:720') : input.ratio;
    if (!ratios.includes(ratio)) throw bad(`Runway ${model} (${kind.replace(/_/g, ' ')}) takes the ratios ${ratios.join(', ')}.`);
    body.ratio = ratio;
    resolution = grokLiteResolution(ratio);
  }
  const [lo, hi] = spec.durationRange;
  const d = input.duration == null ? 6 : input.duration;
  if (!intIn(d, lo, hi)) throw bad(`Runway ${model} clips are ${lo}–${hi} whole seconds.`);
  body.duration = d;
  return { model, kind, body, seconds: d, audio: true, resolution, still: kind === 'image_to_video' };
}

// Seedance 2.5 (spec.seedance): one of its 18 ratios (the ratio sets 480p / 720p / 1080p; default 1280:720), 4–30 whole
// seconds (default 6), the audio flag and a seed. Never a resolution, outputFormat, moderation setting, draft or any
// reference (images, video or audio). → {model, kind, body, seconds, audio, resolution, still}.
function shapeSeedance(kind, input, spec, body) {
  const { model } = body;
  if (kind === 'image_to_video') body.promptImage = dataOrRunwayUri(input.promptImage, 'The image');
  if (input.resolution != null) throw bad(`Runway ${model} takes no resolution field — pick a ratio of that size.`);
  const ratios = spec.kinds[kind];
  const ratio = input.ratio == null ? '1280:720' : input.ratio;
  if (!ratios.includes(ratio)) throw bad(`Runway ${model} (${kind.replace(/_/g, ' ')}) takes the ratios ${ratios.join(', ')}.`);
  body.ratio = ratio;
  const [lo, hi] = spec.durationRange;
  const d = input.duration == null ? 6 : input.duration;
  if (!intIn(d, lo, hi)) throw bad(`Runway ${model} clips are ${lo}–${hi} whole seconds.`);
  body.duration = d;
  if (input.audio != null) {
    if (typeof input.audio !== 'boolean') throw bad('audio must be true or false.');
    body.audio = input.audio;
  }
  if (input.seed != null) {
    if (!intIn(input.seed, 0, 4294967295)) throw bad('seed must be a whole number from 0 to 4294967295.');
    body.seed = input.seed;
  }
  return { model, kind, body, seconds: d, audio: body.audio !== false, resolution: seedanceResolution(ratio), still: false };
}

// A task as the browser may see it: status, progress, costs and Runway's failure code — never the output links.
export function cleanTask(t, id) {
  if (!isRecord(t)) throw new RunwayError('Runway returned an unexpected task.', 502, { code: 'runway_failed' });
  const status = STATUSES.includes(t.status) ? t.status : typeof t.status === 'string' && /^[A-Z_]{1,24}$/.test(t.status) ? t.status : 'UNKNOWN';
  const out = { id: typeof t.id === 'string' && UUID.test(t.id) ? t.id : id, status };
  if (typeof t.createdAt === 'string' && Number.isFinite(Date.parse(t.createdAt))) out.createdAt = t.createdAt.slice(0, 40);
  if (status === 'RUNNING' && numIn(t.progress, 0, 1)) out.progress = t.progress;
  const est = costOf(Number(t.estimatedCost?.credits));
  if (t.estimatedCost != null && est) out.estimatedCost = est;
  const cost = costOf(Number(t.cost?.credits));
  if (t.cost != null && cost) out.cost = cost;
  if (status === 'FAILED') {
    out.failure = scrub(t.failure, '', 300);
    out.failureCode = typeof t.failureCode === 'string' && /^[A-Z0-9_.]{1,80}$/i.test(t.failureCode) ? t.failureCode : null;
  }
  out.outputs = Array.isArray(t.output) ? t.output.length : 0;
  if (!TERMINAL.has(status)) out.pollAfterMs = POLL_MS;
  return out;
}

// ── body readers ──
const intParam = (v) => (typeof v === 'string' && /^\d{1,16}$/.test(v.trim()) ? Number(v.trim()) : NaN);
const declaredLength = (req) => { const d = req.headers.get('content-length'); return d == null ? null : intParam(d); };

// The request body as text, refusing more than `cap` bytes (declared or actually sent).
async function readText(req, cap) {
  const len = declaredLength(req);
  if (Number.isNaN(len)) throw new RunwayError('Bad content-length', 400, { code: 'runway_input' });
  if (len != null && len > cap) throw new RunwayError('Request too large for Runway (8 MB max — send big images as uploads).', 413, { code: 'runway_too_large' });
  const reader = req.body?.getReader();
  const parts = [];
  let n = 0;
  while (reader) {
    const r = await reader.read();
    if (r.done) break;
    n += r.value.byteLength;
    if (n > cap) { reader.cancel().catch(() => {}); throw new RunwayError('Request too large for Runway (8 MB max — send big images as uploads).', 413, { code: 'runway_too_large' }); }
    parts.push(r.value);
  }
  const all = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.byteLength; }
  return new TextDecoder().decode(all);
}

const maxCredits = (env) => { const v = intParam(String(env?.RUNWAY_MAX_CREDITS ?? '')); return Number.isSafeInteger(v) && v > 0 ? v : null; };

// ── the owner's spend record (src/spend.js) ──
export const MICROS_PER_CREDIT = 10_000; // 1 credit = $0.01
export const ALEPH_MAX_SECONDS = 30; // an Aleph edit of unknown length is held at its longest clip until Runway estimates it
const jobOf = (id) => `runway:${String(id).toLowerCase()}`;
/** What a shaped request is recorded at in the owner's spend → {credits, usd}: the price list, the longest Aleph clip when its length is unknown. */
export const ownerQuote = (shaped) => quote(shaped.model, shaped.seconds ?? (shaped.kind === 'video_to_video' ? ALEPH_MAX_SECONDS : null), shaped.audio, shaped);
/**
 * A finished task (cleanTask's shape) → what to record in micro-dollars, or null for "its quote": SUCCEEDED at Runway's
 * cost (else its estimate); FAILED or CANCELLED at what Runway says it still charged, else $0.
 */
export function taskCost(t) {
  const paid = Number(t?.cost?.credits), est = Number(t?.estimatedCost?.credits);
  if (t?.status === 'SUCCEEDED') return Number.isFinite(paid) && paid >= 0 ? paid * MICROS_PER_CREDIT : Number.isFinite(est) && est >= 0 ? est * MICROS_PER_CREDIT : null;
  return Number.isFinite(paid) && paid > 0 ? paid * MICROS_PER_CREDIT : 0;
}

// ── routes ──

// POST runway/generate/<kind> {model, promptText, promptImage|videoUri, ratio, duration, …} → {id, estimatedCost, quote, pollAfterMs}
async function generate(req, env, key, kind, spend) {
  const text = await readText(req, BODY_MAX);
  let input = null;
  try { input = JSON.parse(text); } catch {}
  const shaped = shapeRequest(kind, input);
  // Optional spending cap (Worker var RUNWAY_MAX_CREDITS; unset = no cap, and the most one request can cost is Seedance
  // 2.5 at 30 s, 1080p: 2,040 credits).
  // Checked BEFORE the paid call from Runway's price list: exact for the per-second models (Gen-4.5, Gen-4 Turbo, Veo 3.1,
  // and Grok Imagine and Seedance 2.5 at the request's resolution; whole seconds), at least Aleph's minimum when the
  // clip length is unknown.
  const cap = maxCredits(env);
  const pre = quote(shaped.model, shaped.seconds, shaped.audio, shaped) || (RUNWAY_MODELS[shaped.model].minCredits > 0 ? costOf(RUNWAY_MODELS[shaped.model].minCredits) : null);
  if (cap != null && pre && pre.credits > cap) {
    throw new RunwayError(`This Runway video would cost about ${pre.credits} credits ($${pre.usd.toFixed(2)}) — over this server’s cap of ${cap} (RUNWAY_MAX_CREDITS). Nothing was sent to Runway.`, 402, { code: 'runway_cap', estimatedCost: pre });
  }
  // The owner's spend record (src/spend.js): the quote is recorded for this month until the task settles (never refused).
  const held = ownerQuote(shaped);
  const hold = spend ? await spend.start({ provider: 'runway', kind: 'video', model: shaped.model, amount: held ? held.credits * MICROS_PER_CREDIT : NaN }) : null;
  const what = 'Starting the Runway video';
  let r;
  try { r = await call(key, 'POST', kind, shaped.body, what); }
  catch (err) { await hold?.settle(null); throw err; } // no answer: Runway may have started (and will bill) it, so it counts at its quote
  if (!r.ok) { // refused: nothing billed; a gateway's 502/504/52x: Runway may have started it, so it counts at its quote
    const refused = await upstreamError(r, what, key);
    await (isGatewayStatus(r.status) ? hold?.settle(null) : hold?.release());
    throw refused;
  }
  const j = await r.json().catch(() => null);
  if (!isRecord(j) || typeof j.id !== 'string' || !UUID.test(j.id)) { await hold?.settle(null); throw new RunwayError('Runway didn’t return a task id.', 502, { code: 'runway_failed' }); }
  await hold?.attach(jobOf(j.id));
  const est = costOf(Number(j.estimatedCost?.credits));
  if (cap != null && est && est.credits > cap) {
    // Backstop: Runway's own estimate is over the cap (e.g. an Aleph clip longer than the browser said). Cancel at once.
    const over = `Runway estimated ${est.credits} credits ($${est.usd.toFixed(2)}) for this — over this server’s cap of ${cap} (RUNWAY_MAX_CREDITS).`;
    const stopped = await cancel(key, j.id).then(() => true, () => false);
    await hold?.settle(stopped ? 0 : est.credits * MICROS_PER_CREDIT);
    if (stopped) throw new RunwayError(`${over} Atelier cancelled it straight away.`, 402, { code: 'runway_cap', estimatedCost: est });
    // The cancel failed: the task may run and bill. Hand back its id so the browser can retry the cancel (and say so).
    console.warn('runway cap cancel failed');
    throw new RunwayError(`${over} Atelier couldn’t cancel it at once and is trying again — check at dev.runway.com that it stopped.`, 402, { code: 'runway_cap_running', id: j.id, estimatedCost: est });
  }
  if (hold && est) await hold.resize(est.credits * MICROS_PER_CREDIT); // Runway's own estimate replaces the quote in the record
  return json({ id: j.id, model: shaped.model, kind, estimatedCost: est, quote: quote(shaped.model, shaped.seconds, shaped.audio, shaped), pollAfterMs: POLL_MS });
}

// GET runway/task/<id> → the cleaned task (see cleanTask); 404 {code:'runway_gone'} once Runway no longer has it.
async function getTask(key, id) {
  const what = 'Checking the Runway video';
  const r = await call(key, 'GET', `tasks/${id}`, undefined, what);
  if (r.status === 404) { r.body?.cancel().catch(() => {}); throw new RunwayError('That Runway task is gone — it was cancelled, deleted or has expired.', 404, { code: 'runway_gone', status: 'GONE' }); }
  if (!r.ok) throw await upstreamError(r, what, key);
  return cleanTask(await r.json().catch(() => null), id);
}

// DELETE upstream: cancels a queued/running task, or deletes a finished one (and its outputs). 404 = already gone.
async function cancel(key, id) {
  const what = 'Cancelling the Runway video';
  const r = await call(key, 'DELETE', `tasks/${id}`, undefined, what);
  r.body?.cancel().catch(() => {});
  if (r.ok || r.status === 404) return { ok: true, gone: r.status === 404 };
  throw await upstreamError(r, what, key);
}

// DELETE runway/task/<id> (Stop): cancels a task that is still queued or running, and leaves a finished one alone —
// Runway's DELETE would also delete a SUCCEEDED task's paid-for output, and a Stop can race the browser's last poll.
// If Runway's status can't be read, Stop still cancels (the browser only sends it for a task it thinks is unfinished).
// spend (the owner's spend record): Stop settles the task's row, since nothing polls a stopped video again. A finished task
// settles to its cost; a cancelled one to what Runway still reports charging, else $0 (also when it is gone or
// unreadable after the cancel); one Runway no longer had before the cancel, at its quote (as a poll would).
async function stop(key, id, spend = null) {
  const settle = (actual) => spend?.settleJob(jobOf(id), actual);
  const r = await call(key, 'GET', `tasks/${id}`, undefined, 'Checking the Runway video');
  if (r.status === 404) { r.body?.cancel().catch(() => {}); await settle(null); return { ok: true, gone: true }; }
  if (r.ok) {
    const t = await r.json().catch(() => null);
    const status = isRecord(t) && typeof t.status === 'string' ? t.status : '';
    if (TERMINAL.has(status)) { await settle(taskCost(cleanTask(t, id))); return { ok: true, gone: false, kept: true, status }; }
  } else r.body?.cancel().catch(() => {});
  const out = await cancel(key, id); // a failed cancel throws: the task may still run and bill, so its hold stays
  if (spend) {
    let after = null;
    try { after = await getTask(key, id); } catch { /* gone (404) or unreadable: cancelled before it finished */ }
    await settle(after && TERMINAL.has(after.status) ? taskCost(after) : 0);
  }
  return out;
}

// Runway's output links: https on its CDN (CloudFront) or its own domains only.
export function outputUrlOk(u) {
  let x;
  try { x = new URL(u); } catch { return false; }
  const h = x.hostname.toLowerCase();
  return x.protocol === 'https:' && !x.username && !x.password && (x.port === '' || x.port === '443')
    && (h.endsWith('.cloudfront.net') || h === 'runwayml.com' || h.endsWith('.runwayml.com') || h === 'runway.com' || h.endsWith('.runway.com'));
}

// Streams `body` through, erroring once more than `max` bytes went by.
function capped(body, max) {
  let n = 0;
  return body.pipeThrough(new TransformStream({
    transform(chunk, c) { n += chunk.byteLength; if (n > max) c.error(new Error('Runway output over the size cap')); else c.enqueue(chunk); },
  }));
}

// GET runway/output/<id>?i=0 → the video bytes (video/mp4), fetched fresh from the task (links expire in 24–48 h)
// and WITHOUT any credentials. Redirects are followed only onto allowed hosts.
async function output(key, id, params, spend) {
  const iRaw = params.get('i') ?? '0';
  if (!/^\d{1,2}$/.test(iRaw)) throw bad('Bad output index');
  const i = Number(iRaw);
  const what = 'Downloading the Runway video';
  const r = await call(key, 'GET', `tasks/${id}`, undefined, what);
  if (r.status === 404) { r.body?.cancel().catch(() => {}); throw new RunwayError('That Runway task is gone — it was cancelled, deleted or has expired.', 404, { code: 'runway_gone', status: 'GONE' }); }
  if (!r.ok) throw await upstreamError(r, what, key);
  const t = await r.json().catch(() => null);
  if (!isRecord(t)) throw new RunwayError('Runway returned an unexpected task.', 502, { code: 'runway_failed' });
  if (t.status !== 'SUCCEEDED') throw new RunwayError('The Runway video isn’t ready yet.', 409, { code: 'runway_not_ready', status: STATUSES.includes(t.status) ? t.status : 'UNKNOWN' });
  await spend?.settleJob(jobOf(id), taskCost(cleanTask(t, id))); // a no-op once a poll has settled it
  const outs = Array.isArray(t.output) ? t.output : [];
  if (i >= outs.length) throw new RunwayError('Runway has no video at that index.', 404, { code: 'runway_no_output' });
  let link = outs[i];
  if (typeof link !== 'string' || !outputUrlOk(link)) { console.warn('runway output host refused'); throw new RunwayError('Runway returned a download link Atelier doesn’t trust.', 502, { code: 'runway_failed' }); }
  let res;
  try {
    for (let hop = 0; ; hop++) {
      res = await fetch(link, { method: 'GET', redirect: 'manual' }); // no Runway key on the CDN request
      const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!loc) break;
      res.body?.cancel().catch(() => {});
      const next = new URL(loc, link).href;
      if (hop >= 2 || !outputUrlOk(next)) { console.warn('runway output redirect refused'); throw new RunwayError('Runway’s download redirected somewhere Atelier doesn’t trust.', 502, { code: 'runway_failed' }); }
      link = next;
    }
  } catch (err) {
    if (err instanceof RunwayError) throw err;
    console.warn('runway output unreachable', scrub(err?.message, key, 120));
    throw new RunwayError(`${what} failed — try again.`, 502, { code: 'runway_unreachable' });
  }
  if (!res.ok || !res.body) {
    res.body?.cancel().catch(() => {});
    console.warn('runway output', res.status);
    throw new RunwayError(`${what} failed (${res.status}) — try again.`, 502, { code: 'runway_failed' });
  }
  const declared = intParam(res.headers.get('content-length') ?? '');
  if (Number.isSafeInteger(declared) && declared > OUTPUT_MAX) {
    res.body.cancel().catch(() => {});
    throw new RunwayError(`The Runway video is over ${OUTPUT_MAX / 1048576} MB — too big to bring into Atelier.`, 502, { code: 'runway_too_large' });
  }
  const type = /^video\/webm\b/i.test(res.headers.get('content-type') || '') ? 'video/webm' : 'video/mp4'; // mp4 is forced at create
  const headers = { 'content-type': type, 'cache-control': 'private, no-store' };
  const credits = Number(t.cost?.credits);
  if (Number.isSafeInteger(credits) && credits >= 0) headers['x-runway-credits'] = String(credits);
  if (Number.isSafeInteger(declared)) return new Response(res.body, { status: 200, headers: { ...headers, 'content-length': String(declared) } });
  return new Response(capped(res.body, OUTPUT_MAX), { status: 200, headers });
}

// Runway's account → {creditBalance, usd, maxMonthlyCreditSpend, models: {<RUNWAY_MODELS key>: {maxConcurrentGenerations, maxDailyGenerations}}}
async function account(key) {
  const what = 'Reading the Runway account';
  const r = await call(key, 'GET', 'organization', undefined, what, ACCOUNT_TIMEOUT_MS);
  if (!r.ok) throw await upstreamError(r, what, key);
  const j = await r.json().catch(() => null);
  if (!isRecord(j)) throw new RunwayError('Runway returned an unexpected account.', 502, { code: 'runway_failed' });
  const lim = (v) => (v === null ? null : Number.isSafeInteger(v) && v >= 0 ? v : undefined);
  const models = {};
  for (const m of Object.keys(RUNWAY_MODELS)) {
    const t = j.tier?.models?.[m];
    if (isRecord(t)) models[m] = { maxConcurrentGenerations: lim(t.maxConcurrentGenerations) ?? null, maxDailyGenerations: lim(t.maxDailyGenerations) ?? null };
  }
  const balance = Number.isSafeInteger(j.creditBalance) && j.creditBalance >= 0 ? j.creditBalance : null;
  const monthly = Number.isSafeInteger(j.tier?.maxMonthlyCreditSpend) ? j.tier.maxMonthlyCreditSpend : null;
  return { creditBalance: balance, usd: balance == null ? null : usd(balance), maxMonthlyCreditSpend: monthly, models };
}

// POST runway/upload (raw bytes; content-type: one of UPLOAD_TYPES; content-length required) → {runwayUri, expiresAt}.
// Runway's two-step ephemeral upload: POST /v1/uploads → {uploadUrl, fields, runwayUri}, then a multipart POST of
// `fields` + `file` to uploadUrl. The file is streamed through with a fixed length (never buffered), and a failed
// upload is never retried: Runway wants a new /uploads call, so the browser just attaches the clip again.
const FIELD_NAME = /^[A-Za-z0-9_.:$-]{1,128}$/;
async function upload(req, key) {
  const type = String(req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!own(UPLOAD_TYPES, type)) throw new RunwayError('Runway takes MP4, MOV, WebM or MKV clips and JPEG, PNG or WebP images.', 415, { code: 'runway_type' });
  const len = declaredLength(req);
  if (len == null) throw new RunwayError('Uploads to Runway need a content-length.', 411, { code: 'runway_input' });
  if (Number.isNaN(len)) throw new RunwayError('Bad content-length', 400, { code: 'runway_input' });
  if (len > UPLOAD_MAX) throw new RunwayError(`That file is over ${UPLOAD_MAX / 1048576} MB — export it smaller (1080p, 30 fps) for Runway.`, 413, { code: 'runway_too_large' });
  if (len < UPLOAD_MIN || !req.body) throw new RunwayError('That file is too small for Runway.', 400, { code: 'runway_input' });

  const filename = `atelier-${crypto.randomUUID().slice(0, 8)}.${UPLOAD_TYPES[type]}`; // the extension must match the bytes
  const what = 'Uploading to Runway';
  const r = await call(key, 'POST', 'uploads', { filename, type: 'ephemeral' }, what);
  if (!r.ok) throw await upstreamError(r, what, key);
  const j = await r.json().catch(() => null);
  let target;
  try { target = new URL(j?.uploadUrl); } catch {}
  const fields = j?.fields;
  if (!target || target.protocol !== 'https:' || target.username || target.password || !isRecord(fields)
    || typeof j.runwayUri !== 'string' || j.runwayUri.length > RUNWAY_URI_MAX || !RUNWAY_URI.test(j.runwayUri)
    || !Object.entries(fields).every(([k, v]) => FIELD_NAME.test(k) && typeof v === 'string' && v.length <= 16384 && !/[\r\n]/.test(v))) {
    req.body.cancel().catch(() => {});
    console.warn('runway', what, 'unexpected /uploads answer');
    throw new RunwayError('Runway didn’t return a usable upload — attach the file again.', 502, { code: 'runway_failed' });
  }

  const enc = new TextEncoder(), boundary = `atelier${crypto.randomUUID().replace(/-/g, '')}`;
  const head = enc.encode(Object.entries(fields).map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join('')
    + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`);
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);
  const total = head.byteLength + len + tail.byteLength;
  // Workers: FixedLengthStream sends a real Content-Length (signed upload endpoints may refuse chunked bodies).
  const { readable, writable } = typeof globalThis.FixedLengthStream === 'function' ? new globalThis.FixedLengthStream(total) : new TransformStream();
  const writer = writable.getWriter(), reader = req.body.getReader();
  let stop = false;
  const pump = (async () => {
    await writer.write(head);
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (stop) throw new Error('upload stopped');
      n += value.byteLength;
      if (n > len) throw new Error('more bytes than the content-length');
      await writer.write(value);
    }
    if (n !== len) throw new Error('fewer bytes than the content-length');
    await writer.write(tail);
    await writer.close();
  })();
  const halt = (why) => { stop = true; reader.cancel(why).catch(() => {}); writer.abort(why).catch(() => {}); };
  pump.catch(halt);
  let res;
  try {
    const init = { method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body: readable, redirect: 'manual' };
    if (typeof globalThis.FixedLengthStream !== 'function') init.duplex = 'half';
    res = await fetch(target.href, init); // no Runway key: the URL and fields are the credential
  } catch (err) {
    halt(err);
    console.warn('runway upload unreachable', scrub(err?.message, key, 120));
    throw new RunwayError('The upload to Runway failed — attach the file again.', 502, { code: 'runway_upload' });
  }
  if (!res.ok) {
    halt(new Error('rejected'));
    res.body?.cancel().catch(() => {});
    console.warn('runway upload', res.status);
    throw new RunwayError('The upload to Runway failed — attach the file again.', 502, { code: 'runway_upload' });
  }
  res.body?.cancel().catch(() => {});
  try { await pump; } catch {
    throw new RunwayError('The upload to Runway didn’t match its size — attach the file again.', 400, { code: 'runway_upload' });
  }
  return { runwayUri: j.runwayUri, expiresAt: Date.now() + UPLOAD_TTL_MS };
}

// GET runway/task/<id> for the owner: a finished task settles its spend (once; later polls change nothing), and one
// Runway no longer has settles at its quote.
async function taskRoute(c, id) {
  let t;
  try { t = await getTask(c.key, id); }
  catch (err) {
    if (err instanceof RunwayError && err.extra?.code === 'runway_gone') await c.spend?.settleJob(jobOf(id), null);
    throw err;
  }
  if (TERMINAL.has(t.status)) await c.spend?.settleJob(jobOf(id), taskCost(t));
  return json(t, 200, t.pollAfterMs ? { 'retry-after': String(t.pollAfterMs / 1000) } : {});
}

const ROUTES = [
  ['POST', /^generate\/(image_to_video|text_to_video|video_to_video)$/, (c, m) => generate(c.req, c.env, c.key, m[1], c.spend)],
  ['GET', /^task\/([0-9a-f-]{36})$/i, (c, m) => taskRoute(c, m[1])],
  ['DELETE', /^task\/([0-9a-f-]{36})$/i, async (c, m) => json(await stop(c.key, m[1], c.spend))],
  ['GET', /^output\/([0-9a-f-]{36})$/i, (c, m) => output(c.key, m[1], c.url.searchParams, c.spend)],
  ['POST', /^upload$/, async (c) => json(await upload(c.req, c.key))],
  ['GET', /^account$/, async (c) => json(await account(c.key))],
];

// /api/runway/* for the owner. path is relative to /api/ ('runway/task/<id>'); opts.key is the RUNWAYML_API_SECRET the
// Worker resolved behind the passcode (resolveKey) — without it nothing here runs. opts.spend: src/spend.js's
// ownerSpend(env), the owner's spend record (worker.js always passes it).
export async function handleRunway(req, env, url, path, { key, spend = null } = {}) {
  const route = String(path || '').replace(/^\/?(api\/)?runway\//, '');
  if (!key) return json({ error: 'No Runway key on the server (set RUNWAYML_API_SECRET).' }, 401);
  try {
    for (const [method, re, fn] of ROUTES) {
      const m = route.match(re);
      if (!m) continue;
      if (req.method !== method) continue;
      if (m[1] && /^[0-9a-f-]{36}$/i.test(m[1]) && !UUID.test(m[1])) break;
      return await fn({ req, env, url: url instanceof URL ? url : new URL(req.url), key, spend }, m);
    }
    return json({ error: 'Not found' }, 404);
  } catch (err) {
    if (err instanceof RunwayError) return json({ error: err.message, ...err.extra }, err.status, err.headers);
    console.error('runway route failed', scrub(err?.message || err, key, 200));
    return json({ error: 'The Runway request failed — try again.' }, 502);
  }
}

// /api/diag: a free GET /v1/organization → {ok, status, message}.
export async function runwayDiag(key) {
  try {
    const a = await account(key);
    const n = (v) => Number(v).toLocaleString('en-US');
    return { ok: true, status: 200, message: `${a.creditBalance == null ? '?' : n(a.creditBalance)} credits${a.usd == null ? '' : ` ($${a.usd.toFixed(2)})`}${a.maxMonthlyCreditSpend == null ? '' : ` · up to ${n(a.maxMonthlyCreditSpend)} credits a month`}` };
  } catch (err) {
    return { ok: false, status: err instanceof RunwayError ? err.status : 0, message: err instanceof RunwayError ? err.message : 'Runway is unreachable.' };
  }
}
