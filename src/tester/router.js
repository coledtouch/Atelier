// Tester router (spec §5-§7, addendum A2, A3, A7b). A LinkedIn tester's request reaches only the routes in
// TESTER_ROUTES; anything else answers 403 owner_only. Each body is rebuilt from a field whitelist, priced at its worst
// case (prices.js), reserved in the Ledger before the provider is called, and settled from the provider's reported
// usage afterwards (the full reservation stands when usage is missing or the stream is cut off).
import { waitUntil } from 'cloudflare:workers';
import { claudeChat } from '../anthropic.js';
import { geminiNativeChat, handleVideoApi, isGeminiFileUri, fileNameOf, normalizeVideoMime, fileGone, GEMINI_BASE, GEMINI_VIDEO_MIMES, VIDEO_NEEDS_GEMINI, FILE_GONE_ERROR } from '../gemini.js';
import {
  PRICES, TESTER_MODELS, TESTER_IMAGE_MODELS, TESTER_VIDEO_MODELS, TESTER_TTS_MODELS, PER_CALL_RESERVE_CAP, WEB_CALL_RESERVE_CAP, VEO_CALL_RESERVE_CAP,
  PriceError, chatWorstCase, chatActual, imageCost, imageActual, veoCost, maxTokensWithin, ttsWorstCase, ttsReserved, ttsActual,
} from './prices.js';
import { handleTts, TTS_VOICES, TTS_VOICE_IDS, ttsPriceId } from '../tts.js';
import { handleTranscribe, STT_MODELS } from '../transcribe.js';
import { TESTER_STT_MODELS, sttWorstCase, sttActual } from './prices.js';
import { ALLOWED_ORIGINS, fail, ledger, sha256, signedOut, resetTesterCaches } from './auth.js';
import { SUB, DAILY_UPLOADS } from './ledger.js';
import { meter, openaiUsage, geminiUsage } from './usage.js';
import { PROFILE_MAX_BYTES, getProfile, putProfile } from './profile.js';
import { handleLookup } from '../lookup.js';
import { TESTER_SYNC_ROUTES, testerSyncReady } from './sync.js';
import { handleFeedback } from '../feedback.js';

const KB = 1024, MB = 1024 * 1024;
export const LIMITS = Object.freeze({
  chatBody: 10 * MB, // a whole chat request, images included
  chatText: 400 * KB, // everything except base64 image data (spec §6)
  image: 5 * MB, // one base64 image
  images: 16, // per chat request: a clip goes to non-Gemini models as up to 16 frames (A2)
  videos: 4, // video_file parts per chat request (the app sends one); each part is priced, repeats included
  messages: 400,
  output: 8192, // max_tokens ceiling before the per-call cap (spec §6)
  minReply: 256, // a call that can't leave room for this much answer is refused instead
  clipBytes: 200 * MB, clipSeconds: 180, // full clips for testers (A2); longer ones go as frames
  imageN: 4, imageRefs: 4, imageBody: 24 * MB, // A3
  veoBody: 8 * MB, veoSeconds: 8,
  prompt: 32_000,
});
const WEB_FALLBACK = 'anthropic:claude-sonnet-5-5'; // A7b: a web call that fits nowhere else runs on Sonnet 5.5
const PRO_VIDEO_FALLBACK = ['gemini:gemini-3.1-pro-preview', 'gemini:gemini-3.8-flash']; // A7b: a video chat Pro can't fit
const IMAGE_DATA = /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/]+=*$/;
const B64 = /^[A-Za-z0-9+/]+=*$/;
const IMAGE_MIME = /^image\/(?:png|jpeg|webp)$/;
const OPERATION = /^models\/[\w.-]+\/operations\/[\w.-]+$/;
const EFFORTS = { minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' }; // A3: up to high
const SAFE = new Set(['GET', 'HEAD']);

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
const providerOf = (id = '') => (id.match(/^(anthropic|openai|gemini|zai|deepseek|meta):/) || [, 'nvidia'])[1];
const utf8 = (s) => new TextEncoder().encode(s).length;
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

const tooLarge = (what) => fail(413, 'tester_too_large', `${what} is too large for a tester request — start a new thread or attach less.`);
const badRequest = (error) => fail(400, 'bad_request', error);
const notTesterModel = (why = 'That model isn’t part of the tester set.') => fail(403, 'tester_model', why);
const notYours = () => fail(403, 'tester_owner', 'That belongs to another tester session.');
const noProvider = (up, provider) => fail(401, 'provider_unavailable', `${up.PROVIDERS[provider].name} isn’t available to testers right now.`);
const BUDGET = {
  day: 'You’ve used today’s tester allowance. It resets at midnight UTC.',
  month: 'You’ve used this month’s tester allowance.',
  pool: 'The testers’ budget for this month is used up. Access reopens next month.',
  call: 'This request is bigger than one tester call allows — start a new thread, attach less or pick a lighter model.',
};

// {"dayLeft","monthLeft","poolLeft"} in micro-dollars, on every metered response.
const left = (x) => Math.max(0, x.limit - x.spent - x.reserved);
export const allowanceHeader = (a) => (a ? { 'x-tester-allowance': JSON.stringify({ dayLeft: left(a.day), monthLeft: left(a.month), poolLeft: left(a.pool) }) } : {});
function withHeaders(res, headers) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  return out;
}

// When money is still left in the refused scope, the request was just bigger than what remains (not "used up").
const SHORT = { day: 'left today', month: 'left this month', pool: 'left in the testers’ budget this month' };
const cents = (micros) => `$${(Math.floor(micros / 10_000) / 100).toFixed(2)}`;
// A refused reservation → 402 tester_budget {scope, resetsAt}, 503 tester_paused or 401 tester_signin.
function refused(r, message) {
  if (r.scope === 'paused') return fail(503, 'tester_paused', 'Tester access is paused right now — try again later.');
  if (r.scope === 'signin') return signedOut();
  const rest = r.allowance?.[r.scope] ? left(r.allowance[r.scope]) : 0;
  const text = message || (SHORT[r.scope] && rest >= 10_000
    ? `This request needs more than the ${cents(rest)} ${SHORT[r.scope]} — pick a lighter model, a shorter clip or attach less.`
    : BUDGET[r.scope] || BUDGET.call);
  return fail(402, 'tester_budget', text, { scope: r.scope, resetsAt: r.resetsAt ?? null }, allowanceHeader(r.allowance));
}

// Reserves `amount` µ$ for the tester → {res} (refused) | {id, amount, headers, settle(actual)}; settle runs once.
// words(refusal) → the caller's own wording for a refused reservation, or undefined for refused()'s usual words.
async function reserve(c, amount, words) {
  const r = await c.stub.reserve(c.who.sub, amount);
  if (!r.ok) return { res: refused(r, words?.(r)) };
  let done = null;
  const settle = (actual) => {
    if (done) return done;
    done = c.stub.settle(r.id, actual).then((s) => {
      if (s?.charged > s.reserved) console.warn('tester call cost more than its reservation', c.path, s.reserved, '→', s.charged); // an estimate gap
      return s;
    }, (err) => { console.warn('tester settle failed', String(err?.message || err).slice(0, 120)); return null; });
    waitUntil(done);
    return done;
  };
  return { id: r.id, amount, headers: allowanceHeader(r.allowance), settle };
}

// Reads at most `cap` bytes of the body → text, or null when it is larger.
async function readText(req, cap) {
  if (Number(req.headers.get('content-length') || 0) > cap) return null;
  const reader = req.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let n = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    n += r.value.byteLength;
    if (n > cap) { reader.cancel().catch(() => {}); return null; }
    chunks.push(r.value);
  }
  const all = new Uint8Array(n);
  let at = 0;
  for (const ch of chunks) { all.set(ch, at); at += ch.byteLength; }
  return new TextDecoder().decode(all);
}
async function readJson(req, cap) {
  const t = await readText(req, cap);
  if (t == null) return { big: true, body: null };
  try {
    const b = JSON.parse(t);
    return { big: false, body: b && typeof b === 'object' && !Array.isArray(b) ? b : null };
  } catch { return { big: false, body: null }; }
}

// ── POST /api/feedback: a per-tester rate limit (LI_LIMIT, keyed fb:<sub>: the binding's 20 a minute), as for read aloud
// and dictation, ahead of src/feedback.js (each submission is a KV write and a list of the inbox).
const FEEDBACK_RATE_RETRY_AFTER = '60';
async function feedback(c) {
  let limited = false;
  if (c.env.LI_LIMIT) { try { limited = !(await c.env.LI_LIMIT.limit({ key: `fb:${c.who.sub}` })).success; } catch {} }
  if (limited) return fail(429, 'feedback_busy', 'You’ve sent a lot of feedback in the last minute. Keep your message and try again shortly.', {}, { 'retry-after': FEEDBACK_RATE_RETRY_AFTER });
  return handleFeedback(c.req, c.env, { role: 'tester', sub: c.who.sub });
}

// ── the allow-list ──
const VIDEO = (method, route) => ({ method, match: `video/${route}`, run: video });
export const TESTER_ROUTES = Object.freeze([
  { method: 'GET', match: 'tester/me', run: me },
  { method: 'GET', match: 'tester/profile', run: profileGet },
  { method: 'PUT', match: 'tester/profile', run: profilePut },
  ...TESTER_SYNC_ROUTES,
  { method: 'POST', match: 'feedback', run: feedback },
  // Look up (src/lookup.js): free — Wikipedia and Wikimedia only, no reserve(), no Ledger, no KV; LOOKUP_LIMIT per tester.
  { method: 'GET', match: 'lookup', run: (c) => handleLookup(c.req, c.env, c.url, { key: `t:${c.who.sub}` }) },
  { method: 'GET', match: 'lookup/img', run: (c) => handleLookup(c.req, c.env, c.url, { key: `t:${c.who.sub}` }) },
  { method: 'POST', match: 'chat', run: chat },
  { method: 'POST', match: 'tts', run: tts },
  { method: 'POST', match: 'transcribe', run: transcribe },
  { method: 'POST', match: /^x\/openai\/images\/(generations|edits)$/, sample: 'x/openai/images/edits', run: openaiImages },
  { method: 'POST', match: /^x\/meta\/images\/generations$/, sample: 'x/meta/images/generations', run: metaImages },
  { method: 'POST', match: /^x\/gemini\/(v1beta|v1)\/models\/([\w.-]+):generateContent$/, sample: 'x/gemini/v1beta/models/gemini-3-pro-image:generateContent', run: geminiImage },
  { method: 'POST', match: /^x\/gemini\/v1beta\/models\/([\w.-]+):predictLongRunning$/, sample: 'x/gemini/v1beta/models/veo-3.1-lite-generate-preview:predictLongRunning', run: veoStart },
  { method: 'GET', match: /^x\/gemini\/v1beta\/(models\/[\w.-]+\/operations\/[\w.-]+)$/, sample: 'x/gemini/v1beta/models/veo-3.1-lite-generate-preview/operations/op1', run: veoPoll },
  { method: 'GET', match: /^x\/gemini\/(v1beta|v1)\/(files\/[\w-]+):download$/, sample: 'x/gemini/v1beta/files/abc123:download', run: veoDownload },
  VIDEO('POST', 'upload/start'), VIDEO('PUT', 'upload/chunk'), VIDEO('POST', 'upload/query'), VIDEO('POST', 'upload/cancel'),
  VIDEO('GET', 'file'), VIDEO('DELETE', 'file'),
]);
// Reached by everyone before identity is checked (worker.js): health, CSP reports, the LinkedIn sign-in routes and the
// extension relay socket (authenticated by its device token only, so a tester cookie in the owner's browser never breaks it).
export const PUBLIC_PATHS = Object.freeze(['health', 'csp-report', 'li/', 'relay/ws']);

export function matchTesterRoute(method, path) {
  for (const route of TESTER_ROUTES) {
    if (route.method !== method) continue;
    if (typeof route.match === 'string' ? route.match === path : route.match.test(path)) {
      return { route, m: typeof route.match === 'string' ? [path] : path.match(route.match) };
    }
  }
  return null;
}

// Every /api request from a signed-in tester comes here, and only here (deny by default).
export async function testerRouter(req, env, url, path, who, up) {
  const hit = matchTesterRoute(req.method, path);
  if (!hit) return fail(403, 'owner_only', 'That part of Atelier is only for its owner.');
  if (!SAFE.has(req.method) && !ALLOWED_ORIGINS.has(req.headers.get('origin') || '')) return fail(403, 'tester_origin', 'Open Atelier at atelier.ciprari.ai to use it.');
  const stub = ledger(env);
  if (!stub) return signedOut();
  return hit.route.run({ req, env, url, path, m: hit.m, who, up, stub });
}

// ── GET /api/tester/me, GET/PUT /api/tester/profile ──
async function me(c) {
  const a = await c.stub.allowance(c.who.sub);
  if (!a) return signedOut();
  const ready = (id) => Boolean(c.env[c.up.PROVIDERS[providerOf(id)]?.secret]);
  const voices = testerVoices(ready);
  const dictation = testerStt(ready);
  return json({
    sub: c.who.sub, name: c.who.name, picture: c.who.picture, email: c.who.email,
    models: { chat: TESTER_MODELS.filter(ready), image: TESTER_IMAGE_MODELS.filter(ready), video: TESTER_VIDEO_MODELS.filter(ready), tts: voices },
    features: { web: ready('anthropic:'), video: ready('gemini:'), veo: ready('gemini:'), helpers: true, profile: true, sync: testerSyncReady(c.env), tts: voices.length > 0, dictation: dictation.length > 0 },
    allowance: { day: a.day, month: a.month },
    pool: { paused: a.paused, spotsLeft: a.spotsLeft, ...(a.preview ? { preview: true } : {}) },
  }, 200, allowanceHeader(a));
}
async function profileGet(c) { return json(await getProfile(c.stub, c.who.sub)); }
async function profilePut(c) {
  const text = await readText(c.req, PROFILE_MAX_BYTES);
  if (text == null) return tooLarge('Your profile');
  const r = await putProfile(c.stub, c.who.sub, text);
  if (r === 'gone') return signedOut();
  return r === 'ok' ? json({ ok: true }) : badRequest('Bad JSON');
}

// ── POST /api/chat ──
const textOf = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n') : '');

// The app's messages rebuilt from a whitelist: system/assistant text, and user text, base64 images and video_file parts.
// Tool turns, tool calls, replay fields (anthropic_content, reasoning_content) and any other part type are dropped.
function shapeMessages(list, provider) {
  if (!Array.isArray(list) || !list.length || list.length > LIMITS.messages) return { error: badRequest('messages must be a list of 1 to 400 turns.') };
  const messages = [], videos = new Map(); // file name → parts naming it: Gemini bills every part, so each is priced
  let images = 0, clips = 0;
  for (const m of list) {
    if (!m || !['system', 'user', 'assistant'].includes(m.role)) continue;
    if (m.role !== 'user' || !Array.isArray(m.content)) {
      const t = textOf(m.content);
      if (t) messages.push({ role: m.role, content: t });
      continue;
    }
    const parts = [];
    for (const p of m.content) {
      if (p?.type === 'text' && typeof p.text === 'string') parts.push({ type: 'text', text: p.text });
      else if (p?.type === 'image_url') {
        const u = p.image_url?.url;
        if (typeof u === 'string' && u.length > LIMITS.image) return { error: tooLarge('An attached image') };
        if (typeof u !== 'string' || !IMAGE_DATA.test(u)) return { error: badRequest('Images must be attached as base64 data.') };
        if (++images > LIMITS.images) return { error: tooLarge(`More than ${LIMITS.images} images`) };
        // OpenAI prices detail:"high" at a 2,500-patch ceiling; the default ("original") can cost 12x more.
        parts.push({ type: 'image_url', image_url: { url: u, ...(provider === 'openai' ? { detail: 'high' } : {}) } });
      } else if (p?.type === 'video_file') {
        const uri = p.video_file?.file_uri, mime = normalizeVideoMime(p.video_file?.mime_type);
        if (!isGeminiFileUri(uri) || !GEMINI_VIDEO_MIMES.has(mime)) return { error: badRequest('Bad video reference') };
        if (++clips > LIMITS.videos) return { error: tooLarge(`More than ${LIMITS.videos} video clips`) };
        const name = fileNameOf(uri);
        videos.set(name, (videos.get(name) || 0) + 1);
        parts.push({ type: 'video_file', video_file: { file_uri: uri, mime_type: mime } });
      }
    }
    if (parts.length) messages.push({ role: 'user', content: parts });
  }
  if (!messages.some((m) => m.role === 'user')) return { error: badRequest('Nothing to send') };
  // Spec §6 / A7b: text size and the token estimate leave the base64 image bytes out (images are priced per image).
  const textBytes = utf8(JSON.stringify(messages, (k, v) => (k === 'url' && typeof v === 'string' ? '' : v)));
  if (textBytes > LIMITS.chatText) return { error: tooLarge('This conversation') };
  return { messages, images, videos: [...videos], textBytes };
}

// Seconds of an uploaded clip from Gemini's file record; 'gone' when Gemini no longer has it (or failed to process
// it); otherwise null unless the file is ACTIVE with a readable length. A clip that is still PROCESSING (or whose
// record can't be read) has no trustworthy length yet, and Gemini bills the real length, so the caller refuses it
// rather than guessing (the app only sends ACTIVE clips).
async function clipSeconds(key, name) {
  try {
    const r = await fetch(`${GEMINI_BASE}/v1beta/${name}`, { headers: { 'x-goog-api-key': key }, redirect: 'manual' });
    if (!r.ok) return fileGone(r.status, await r.text().catch(() => '')) ? 'gone' : null;
    const f = await r.json();
    if (f?.state === 'FAILED') return 'gone';
    if (f?.state !== 'ACTIVE') return null;
    const s = parseFloat(f?.videoMetadata?.videoDuration);
    return Number.isFinite(s) && s > 0 ? Math.ceil(s) : null;
  } catch { return null; }
}

// The largest output (and, for web calls, the most searches) one call can have within its cap → plan | null.
function plan(model, base, want, web) {
  const floor = Math.min(want, LIMITS.minReply);
  const fit = (args, budget) => {
    const m = maxTokensWithin({ ...args, budget, ceiling: want });
    return m > 0 && m >= floor ? { maxTokens: m, worst: chatWorstCase({ ...args, maxTokens: m }) } : null;
  };
  if (web) {
    for (const uses of [3, 2, 1]) {
      const f = fit({ model, ...base, webSearches: uses, fallbacks: false }, WEB_CALL_RESERVE_CAP);
      if (f) return { model, ...f, webUses: uses, fallbacks: false };
    }
    return null;
  }
  const f = fit({ model, ...base }, PER_CALL_RESERVE_CAP);
  return f && { model, ...f, webUses: 0, fallbacks: true };
}

async function chat(c) {
  const { big, body: b } = await readJson(c.req, LIMITS.chatBody);
  if (big) return tooLarge('This conversation');
  if (!b) return badRequest('Bad JSON body');
  const requested = typeof b.model === 'string' ? b.model : '';
  if (!TESTER_MODELS.includes(requested)) return notTesterModel();
  const provider = providerOf(requested);
  const shaped = shapeMessages(b.messages, provider);
  if (shaped.error) return shaped.error;
  const key = c.env[c.up.PROVIDERS[provider].secret];
  if (!key) return noProvider(c.up, provider);

  // A2: a video_file part must name the tester's own upload; every part is priced from the clip's known length.
  let videoSeconds = 0;
  if (shaped.videos.length) {
    if (provider !== 'gemini') return json({ error: VIDEO_NEEDS_GEMINI }, 400);
    for (const [name] of shaped.videos) if (!(await c.stub.ownsJob(c.who.sub, `file:${name}`))) return notYours();
    for (const [name, parts] of shaped.videos) {
      const s = await clipSeconds(key, name);
      // Same answer geminiNativeChat gives for a missing file: the app re-uploads the clip or sends frames.
      if (s === 'gone') return json({ error: FILE_GONE_ERROR, code: 'video_file_gone' }, 409);
      if (s == null) return fail(409, 'tester_video_not_ready', 'Gemini hasn’t finished reading this clip’s length yet — try again in a moment.');
      if (s > LIMITS.clipSeconds) return tooLarge('A clip over 3 minutes');
      videoSeconds += parts * s;
    }
  }

  const want = clamp(Math.floor(Number(b.max_tokens)) || 4096, 1, LIMITS.output);
  const web = provider === 'anthropic' && b.web_search === true;
  const base = { inputTokens: Math.ceil(shaped.textBytes / 3), images: shaped.images, videoSeconds, ...(provider === 'openai' && shaped.images ? { imageDetail: 'high' } : {}) };
  let p;
  try {
    p = plan(requested, base, want, web);
    if (!p && web && requested !== WEB_FALLBACK) p = plan(WEB_FALLBACK, base, want, true);
    if (!p && videoSeconds && requested === PRO_VIDEO_FALLBACK[0]) p = plan(PRO_VIDEO_FALLBACK[1], base, want, false);
  } catch (err) {
    // A7b: not a tester_ code, so the app's fallback chain moves on to a model that can read images.
    if (err instanceof PriceError && (err.code === 'no_vision' || err.code === 'unpriced_images')) {
      return fail(400, 'model_no_images', 'This model can’t take images for testers — try a vision model.');
    }
    throw err;
  }
  if (!p) return refused({ scope: 'call' });

  const mtr = await reserve(c, p.worst);
  if (mtr.res) return mtr.res;
  const headers = { ...mtr.headers, ...(p.model !== requested ? { 'x-tester-model': p.model } : {}) };
  // A complete answer settles at its reported cost. A stopped or failed one settles at no less than the reservation,
  // and at more when the provider had already reported a bigger bill (the Ledger still caps it at OVERRUN x).
  const settleUsage = (usage, complete = true) => {
    let actual = mtr.amount;
    if (usage) {
      try {
        const reported = chatActual({ model: p.model, usage });
        actual = complete ? reported : Math.max(mtr.amount, reported);
      } catch {}
    }
    return mtr.settle(actual);
  };
  const body = { model: p.model, messages: shaped.messages, stream: true, max_tokens: p.maxTokens };
  if (typeof b.temperature === 'number' && Number.isFinite(b.temperature)) body.temperature = clamp(b.temperature, 0, 2);
  if (Object.hasOwn(EFFORTS, b.reasoning_effort)) body.reasoning_effort = EFFORTS[b.reasoning_effort];
  if (b.chat_template_kwargs?.enable_thinking === false) body.chat_template_kwargs = { enable_thinking: false };
  if (p.webUses) body.web_search = true;

  let res;
  try {
    if (videoSeconds) res = await geminiNativeChat(body, key, { tap: (s) => meter(s, geminiUsage(), settleUsage) });
    else if (provider === 'anthropic') {
      res = await claudeChat(body, key, c.env.ANTHROPIC_WORKSPACE_ID, { maxTokens: p.maxTokens, webUses: p.webUses, fallbacks: p.fallbacks, onUsage: settleUsage });
    } else {
      const up = c.up.CHAT_UPSTREAM[provider];
      res = await c.up.forward(up.url, {
        method: 'POST',
        headers: { ...up.auth(key), 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({ ...c.up.shapeChatBody(provider, body), stream_options: { include_usage: true } }),
      });
      if (res.ok && res.body) res = new Response(meter(res.body, openaiUsage(), settleUsage), res);
    }
  } catch (err) {
    await mtr.settle(mtr.amount);
    throw err;
  }
  if (!res.ok) await mtr.settle(0); // refused before generating anything: nothing was billed
  return withHeaders(res, headers);
}

// ── POST /api/tts (read aloud): src/tts.js validates the body and calls the provider; this reserves and settles ──
// Voice ids a tester may use: priced for testers and with the provider's key on the server.
const testerVoices = (ready) => TTS_VOICE_IDS.filter((id) => TESTER_TTS_MODELS.includes(ttsPriceId(TTS_VOICES[id])) && ready(`${TTS_VOICES[id].provider}:`));
let warnedTtsUsage = false;
// A per-tester rate limit on paid speech (the LI_LIMIT binding, keyed by sub, apart from its per-IP sign-in keys): the
// app asks for at most three segments at a time, so a burst past it is a script opening reservations in parallel.
const TTS_RATE_RETRY_AFTER = '30';
async function ttsThrottled(c) {
  if (!c.env.LI_LIMIT) return false;
  try { return !(await c.env.LI_LIMIT.limit({ key: `tts:${c.who.sub}` })).success; } catch { return false; }
}
async function tts(c) {
  return handleTts(c.req, c.env, {
    tester: true,
    // 503, not noProvider's 401: the read-aloud client reads any 401 as "sign in again"; this falls back to the device voice.
    unavailable: (provider) => fail(503, 'tts_unavailable', `${c.up.PROVIDERS[provider].name} isn’t available to testers right now.`),
    async reserve({ voice, chars, units, ceiling }) {
      const model = ttsPriceId(voice);
      if (!TESTER_TTS_MODELS.includes(model)) return { res: notTesterModel('That voice isn’t part of the tester set.') };
      if (await ttsThrottled(c)) return { res: fail(429, 'tts_busy', 'Read aloud is busy right now. Try again in a moment.', {}, { 'retry-after': TTS_RATE_RETRY_AFTER }) };
      // Priced on a ceiling of the reading time (ttsCeilingUnits: symbols and emoji are read as words) and held to it.
      // Gemini: maxOutputTokens is the reserved audio, so its bill can't pass the reservation. OpenAI speech has no
      // output bound: the cut-off (cutoffSeconds) bounds what the tester hears, and the settle bounds what is billed:
      // a stream stopped before its usage pays no less than the audio it timed, at the reserved token rate (src/tts.js
      // viaOpenAI); one stopped after it, no less than that usage (the complete bill).
      const o = { model, chars, units: ceiling ?? units, ...(voice.maxOutputTokens ? { maxAudioTokens: voice.maxOutputTokens } : {}) };
      const worst = ttsWorstCase(o);
      if (worst > PER_CALL_RESERVE_CAP) return { res: refused({ scope: 'call' }) };
      const held = ttsReserved(o);
      const mtr = await reserve(c, worst);
      if (mtr.res) return mtr;
      return {
        headers: mtr.headers,
        limits: voice.provider === 'gemini' ? { outputTokens: held.audioTokens } : { seconds: held.cutoffSeconds },
        // null: keep the full reservation; {billed: false}: $0; {usage, seconds}: the provider's report; {usage,
        // stopped}: an OpenAI stream that stopped (cut off, hung up or broke) after the provider reported, settled at
        // max(reservation, the reported bill); {usage: null, stopped, seconds}: one that stopped before that, or finished
        // without usage (plain audio/mpeg; a speech.audio.done without it), after audio was timed, settled at
        // max(reservation, the timed seconds x 50 tokens/s). ttsActual ignores the seconds
        // of an OpenAI answer that has usage (it comes only in speech.audio.done, the whole bill).
        async settle(r) {
          let actual = mtr.amount;
          if (r?.billed === false) actual = 0;
          else if (r) {
            try {
              // Gemini: the seconds floor (25 tokens/s) is held to the maxOutputTokens it was sent; the reported count rules.
              const reported = ttsActual({ model, usage: r.usage, seconds: r.seconds, chars, ...(voice.provider === 'gemini' ? { maxAudioTokens: held.audioTokens } : {}) });
              actual = r.stopped ? Math.max(mtr.amount, reported) : reported;
            } catch {
              if (!warnedTtsUsage) { warnedTtsUsage = true; console.warn('tts: no usable usage reported, the full reservation stands', model); }
            }
          }
          const s = await mtr.settle(actual);
          return s?.allowance ? allowanceHeader(s.allowance) : null;
        },
      };
    },
  });
}

// ── POST /api/transcribe (dictation): src/transcribe.js checks the recording and calls the provider; this reserves and
// settles. OpenAI is reserved on its whole context window plus its output cap (sttWorstCase: $0.0375); the Gemini fallback
// on its own input bound (the WAV's seconds, else the 3-minute cap, reserved before Gemini's countTokens checks it, so a
// throttled or refused tester never makes the Worker upload the recording) plus its output bound. Each provider that
// runs is reserved and settled on its own; a provider's refusal (or a failed count) costs $0.
// Dictation models a tester may use: priced for testers and with the provider's key on the server.
const testerStt = (ready) => Object.values(STT_MODELS).filter((m) => TESTER_STT_MODELS.includes(m.priceId) && ready(`${m.provider}:`));
let warnedSttUsage = false;
// A per-tester rate limit on paid dictation (LI_LIMIT, keyed stt:<sub>: 20 a minute, the binding's limit). One message
// is one recording, so a burst past it is a script opening reservations in parallel. Checked once per request: the
// fallback to the second provider is the same dictation.
const STT_RATE_RETRY_AFTER = '30';
// Dictation's reservation doesn't shrink with the clip (OpenAI's is its whole context window), so refused()'s advice
// ("a lighter model, a shorter clip") can't help: say what it needs (reserve() passes this to refused(), S21). With
// under $0.01 left, the usual "you've used it" words stand.
const sttBudgetWords = (worst) => (r) => {
  const rest = r.allowance?.[r.scope] ? left(r.allowance[r.scope]) : 0;
  if (!SHORT[r.scope] || rest < 10_000) return undefined;
  const need = `$${(Math.ceil(worst / 10_000) / 100).toFixed(2)}`;
  return `Dictation needs about ${need} of the allowance free, and ${cents(rest)} is ${SHORT[r.scope]}.${r.scope === 'day' ? ' It resets at midnight UTC.' : ''}`;
};
async function sttThrottled(c) {
  if (!c.env.LI_LIMIT) return false;
  try { return !(await c.env.LI_LIMIT.limit({ key: `stt:${c.who.sub}` })).success; } catch { return false; }
}
async function transcribe(c) {
  return handleTranscribe(c.req, c.env, {
    tester: true,
    // 503, not noProvider's 401: the dictation client reads any 401 as "sign in again".
    unavailable: () => fail(503, 'transcribe_unavailable', 'Dictation isn’t available to testers right now.'),
    async reserve({ model, inputTokens, fallback }) {
      if (!TESTER_STT_MODELS.includes(model.priceId)) return { res: notTesterModel('That dictation model isn’t part of the tester set.') };
      if (!fallback && await sttThrottled(c)) return { res: fail(429, 'transcribe_busy', 'Dictation is busy right now. Try again in a moment.', {}, { 'retry-after': STT_RATE_RETRY_AFTER }) };
      const worst = sttWorstCase({ model: model.priceId, inputTokens, maxOutputTokens: model.maxOutputTokens });
      if (worst > PER_CALL_RESERVE_CAP) return { res: refused({ scope: 'call' }) };
      const mtr = await reserve(c, worst, sttBudgetWords(worst));
      if (mtr.res) return mtr;
      return {
        headers: mtr.headers,
        // null: keep the full reservation; {billed: false}: $0; {usage}: the provider's report.
        async settle(r) {
          let actual = mtr.amount;
          if (r?.billed === false) actual = 0;
          else if (r) {
            try { actual = sttActual({ model: model.priceId, usage: r.usage }); } catch {
              if (!warnedSttUsage) { warnedSttUsage = true; console.warn('transcribe: no usable usage reported, the full reservation stands', model.priceId); }
            }
          }
          const s = await mtr.settle(actual);
          return s?.allowance ? allowanceHeader(s.allowance) : null;
        },
      };
    },
  });
}

// ── images: POST /api/x/openai/images/(generations|edits), /api/x/meta/images/generations, Gemini generateContent ──
// Calls an allow-listed provider path with the rebuilt JSON body, then settles from the response's usage.
async function metered(c, provider, path, body, cost, actualOf) {
  const cfg = c.up.PASSTHRU[provider], key = c.env[c.up.PROVIDERS[provider].secret];
  if (!key) return noProvider(c.up, provider);
  const mtr = await reserve(c, cost);
  if (mtr.res) return mtr.res;
  const res = await c.up.forward(`${cfg.base}/${path}`, {
    method: 'POST', headers: { ...cfg.auth(key), 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) { await mtr.settle(0); return withHeaders(res, mtr.headers); }
  const text = await res.text().catch(() => null);
  let actual = mtr.amount;
  try { actual = actualOf(JSON.parse(text)); } catch {}
  const s = await mtr.settle(actual);
  return new Response(text ?? '', { status: res.status, headers: { ...JSON_HEADERS, ...(s?.allowance ? allowanceHeader(s.allowance) : mtr.headers) } });
}
const promptTokens = (text) => Math.ceil(utf8(text) / 3);
const goodPrompt = (p) => typeof p === 'string' && p.trim() && p.length <= LIMITS.prompt;
const countOk = (n) => Number.isInteger(n) && n >= 1 && n <= LIMITS.imageN;

async function openaiImages(c) {
  const kind = c.m[1];
  const { big, body: b } = await readJson(c.req, LIMITS.imageBody);
  if (big) return tooLarge('This image request');
  if (!b) return badRequest('Bad JSON body');
  const model = `openai:${b.model}`;
  if (typeof b.model !== 'string' || !TESTER_IMAGE_MODELS.includes(model)) return notTesterModel();
  const e = PRICES[model];
  if (!goodPrompt(b.prompt)) return badRequest('A prompt of up to 32,000 characters is required.');
  const n = b.n ?? 1;
  if (!countOk(n)) return badRequest(`n must be 1 to ${LIMITS.imageN}.`);
  // A7b: always an explicit size and quality (≤ medium); "auto" can't be priced.
  const out = { model: b.model, prompt: b.prompt, n, size: e.sizes.includes(b.size) ? b.size : '1024x1024', quality: b.quality === 'low' ? 'low' : 'medium' };
  if (['png', 'jpeg', 'webp'].includes(b.output_format)) out.output_format = b.output_format;
  if (Number.isInteger(b.output_compression) && b.output_compression >= 0 && b.output_compression <= 100) out.output_compression = b.output_compression;
  if (['auto', 'opaque', 'transparent'].includes(b.background)) out.background = b.background;
  let refs = 0;
  if (kind === 'edits') {
    const imgs = Array.isArray(b.images) ? b.images : [];
    if (!imgs.length || imgs.length > LIMITS.imageRefs) return badRequest(`An edit takes 1 to ${LIMITS.imageRefs} images.`);
    for (const i of imgs) {
      if (typeof i?.image_url !== 'string' || i.image_url.length > LIMITS.image || !IMAGE_DATA.test(i.image_url)) return badRequest('Edit images must be base64 data up to 5 MB.');
    }
    out.images = imgs.map((i) => ({ image_url: i.image_url }));
    refs = imgs.length;
  }
  const cost = imageCost({ model, n, size: out.size, quality: out.quality, promptTokens: promptTokens(b.prompt), inputImages: refs });
  return metered(c, 'openai', `images/${kind}`, out, cost, (j) => imageActual({ model, usage: j?.usage }));
}

async function metaImages(c) {
  const { big, body: b } = await readJson(c.req, LIMITS.imageBody);
  if (big) return tooLarge('This image request');
  if (!b) return badRequest('Bad JSON body');
  const model = `meta:${b.model}`;
  if (typeof b.model !== 'string' || !TESTER_IMAGE_MODELS.includes(model)) return notTesterModel();
  if (!goodPrompt(b.prompt)) return badRequest('A prompt of up to 32,000 characters is required.');
  const n = b.n ?? 1;
  if (!countOk(n)) return badRequest(`n must be 1 to ${LIMITS.imageN}.`);
  const out = { model: b.model, prompt: b.prompt, n, size: PRICES[model].sizes.includes(b.size) ? b.size : '1024x1024', response_format: b.response_format === 'url' ? 'url' : 'b64_json' };
  const cost = imageCost({ model, n, size: out.size });
  return metered(c, 'meta', 'images/generations', out, cost, (j) => imageActual({ model, n: Array.isArray(j?.data) ? j.data.length : n }));
}

async function geminiImage(c) {
  const [, ver, id] = c.m, model = `gemini:${id}`;
  if (!TESTER_IMAGE_MODELS.includes(model)) return notTesterModel();
  const e = PRICES[model];
  const { big, body: b } = await readJson(c.req, LIMITS.imageBody);
  if (big) return tooLarge('This image request');
  if (!b) return badRequest('Bad JSON body');
  if (b.tools != null || b.toolConfig != null) return notTesterModel('Tools aren’t available on tester image requests.');
  const g = b.generationConfig && typeof b.generationConfig === 'object' ? b.generationConfig : {};
  if (g.candidateCount != null && g.candidateCount !== 1) return notTesterModel('Tester image requests make one image at a time.');
  if (!Array.isArray(b.contents) || !b.contents.length || b.contents.length > 8) return badRequest('contents must be 1 to 8 turns.');
  const contents = [];
  let refs = 0, text = '';
  for (const turn of b.contents) {
    const parts = [];
    for (const p of Array.isArray(turn?.parts) ? turn.parts : []) {
      if (typeof p?.text === 'string') { parts.push({ text: p.text }); text += p.text; continue; }
      const d = p?.inline_data || p?.inlineData;
      if (!d) continue;
      const mime = d.mime_type || d.mimeType;
      if (!IMAGE_MIME.test(mime) || typeof d.data !== 'string' || d.data.length > LIMITS.image || !B64.test(d.data)) return badRequest('Images must be PNG, JPEG or WebP base64 data up to 5 MB.');
      if (++refs > LIMITS.imageRefs) return badRequest(`Up to ${LIMITS.imageRefs} reference images.`);
      parts.push({ inline_data: { mime_type: mime, data: d.data } });
    }
    if (parts.length) contents.push({ role: turn.role === 'model' ? 'model' : 'user', parts });
  }
  if (!goodPrompt(text)) return badRequest('A prompt of up to 32,000 characters is required.');
  const size = Object.hasOwn(e.imageTokens, g.imageConfig?.imageSize) ? g.imageConfig.imageSize : '1K';
  const imageConfig = { imageSize: size };
  if (typeof g.imageConfig?.aspectRatio === 'string' && /^\d{1,2}:\d{1,2}$/.test(g.imageConfig.aspectRatio)) imageConfig.aspectRatio = g.imageConfig.aspectRatio;
  // Always IMAGE only: interleaved TEXT+IMAGE output can hold several images, and only one is priced. The provider
  // enforces the output cap (the image plus the thinking allowance, prices.js); settle records any gap (ledger OVERRUN).
  const generationConfig = { responseModalities: ['IMAGE'], imageConfig, candidateCount: 1, maxOutputTokens: e.imageTokens[size] + e.thinkingTokens };
  if (typeof g.temperature === 'number' && Number.isFinite(g.temperature)) generationConfig.temperature = clamp(g.temperature, 0, 2);
  const cost = imageCost({ model, n: 1, size, promptTokens: promptTokens(text), inputImages: refs });
  return metered(c, 'gemini', `${ver}/models/${id}:generateContent`, { contents, generationConfig }, cost, (j) => {
    if (!j?.usageMetadata) throw new PriceError('no_usage');
    return imageActual({ model, usage: j.usageMetadata });
  });
}

// ── Veo (A2, A7b): one video, ≤ 8 s, ≤ $1.00 reserved; polls and downloads only for this tester's own jobs ──
async function veoStart(c) {
  const id = c.m[1], model = `gemini:${id}`;
  if (!TESTER_VIDEO_MODELS.includes(model)) return notTesterModel();
  const e = PRICES[model];
  const { big, body: b } = await readJson(c.req, LIMITS.veoBody);
  if (big) return tooLarge('This video request');
  if (!b) return badRequest('Bad JSON body');
  if (b.tools != null) return notTesterModel('Tools aren’t available on tester video requests.');
  const inst = Array.isArray(b.instances) && b.instances.length === 1 ? b.instances[0] : null;
  if (!inst || !goodPrompt(inst.prompt)) return badRequest('Send one video request with a prompt.');
  const instance = { prompt: inst.prompt };
  if (inst.image != null) {
    const img = inst.image.inlineData;
    if (!img || !IMAGE_MIME.test(img.mimeType) || typeof img.data !== 'string' || img.data.length > LIMITS.image || !B64.test(img.data)) {
      return badRequest('The starting image must be PNG, JPEG or WebP base64 data up to 5 MB.');
    }
    instance.image = { inlineData: { mimeType: img.mimeType, data: img.data } };
  }
  const q = b.parameters && typeof b.parameters === 'object' ? b.parameters : {};
  if ((q.numberOfVideos ?? 1) !== 1 || (q.sampleCount ?? 1) !== 1) return notTesterModel('Tester requests make one video at a time.');
  const resolution = q.resolution ?? '720p', seconds = q.durationSeconds ?? LIMITS.veoSeconds;
  if (!Object.hasOwn(e.perSecond, resolution)) return badRequest(`resolution must be one of ${Object.keys(e.perSecond).join(', ')}.`);
  if (!e.durations.includes(seconds) || seconds > LIMITS.veoSeconds) return badRequest(`durationSeconds must be one of ${e.durations.join(', ')}.`);
  const parameters = { aspectRatio: q.aspectRatio === '9:16' ? '9:16' : '16:9', resolution, durationSeconds: seconds };
  if (typeof q.negativePrompt === 'string') parameters.negativePrompt = q.negativePrompt.slice(0, 2000);
  const cost = veoCost({ model, seconds, resolution });
  if (cost > VEO_CALL_RESERVE_CAP) return refused({ scope: 'call' }, 'One tester video can cost at most $1.00 — pick a shorter clip or 720p.');
  const key = c.env.GEMINI_API_KEY;
  if (!key) return noProvider(c.up, 'gemini');
  const mtr = await reserve(c, cost);
  if (mtr.res) return mtr.res;
  const res = await c.up.forward(`${GEMINI_BASE}/v1beta/models/${id}:predictLongRunning`, {
    method: 'POST', headers: { 'x-goog-api-key': key, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ instances: [instance], parameters }),
  });
  if (!res.ok) { await mtr.settle(0); return withHeaders(res, mtr.headers); }
  const text = await res.text().catch(() => '');
  let name = '';
  try { name = JSON.parse(text).name; } catch {}
  // The reservation settles when this tester's poll sees the operation finish (at $0 when no video came back).
  if (typeof name === 'string' && OPERATION.test(name)) {
    await c.stub.addJob(c.who.sub, `op:${name}`, 'op', { reservation: mtr.id, actual: veoCost({ model, seconds, resolution, margin: false }) });
  } else await mtr.settle(mtr.amount);
  return new Response(text, { status: res.status, headers: { ...JSON_HEADERS, ...mtr.headers } });
}

async function veoPoll(c) {
  const name = c.m[1];
  if (!(await c.stub.ownsJob(c.who.sub, `op:${name}`))) return notYours();
  const key = c.env.GEMINI_API_KEY;
  if (!key) return noProvider(c.up, 'gemini');
  const res = await c.up.forward(`${GEMINI_BASE}/v1beta/${name}`, { method: 'GET', headers: { 'x-goog-api-key': key, accept: 'application/json' } });
  if (!res.ok) return withHeaders(res, allowanceHeader(await c.stub.allowance(c.who.sub)));
  const text = await res.text().catch(() => '');
  let j = null, allowance = null;
  try { j = JSON.parse(text); } catch {}
  if (j?.done) {
    const samples = j.response?.generateVideoResponse?.generatedSamples;
    const files = (Array.isArray(samples) ? samples : []).map((s) => String(s?.video?.uri || '').match(/\/(files\/[\w-]+)(?::download)?(?:\?|$)/)?.[1]).filter(Boolean);
    for (const f of files) await c.stub.addJob(c.who.sub, `file:${f}`, 'file');
    allowance = (await c.stub.finishJob(c.who.sub, `op:${name}`, !j.error && files.length > 0))?.allowance;
  }
  allowance ??= await c.stub.allowance(c.who.sub);
  return new Response(text, { status: res.status, headers: { ...JSON_HEADERS, ...allowanceHeader(allowance) } });
}

async function veoDownload(c) {
  const [, ver, name] = c.m;
  if (!(await c.stub.ownsJob(c.who.sub, `file:${name}`))) return notYours();
  const key = c.env.GEMINI_API_KEY;
  if (!key) return noProvider(c.up, 'gemini');
  const qs = c.url.searchParams.get('alt') === 'media' ? '?alt=media' : '';
  const res = await c.up.forward(`${GEMINI_BASE}/${ver}/${name}:download${qs}`, { method: 'GET', headers: { 'x-goog-api-key': key, accept: c.req.headers.get('accept') || '*/*' } });
  return withHeaders(res, allowanceHeader(await c.stub.allowance(c.who.sub)));
}

// ── /api/video/* (A2): uploads and files, each tied to the tester who started it ──
const jobId = async (kind, id) => (kind === 'upload' ? `upload:${await sha256(id)}` : `file:${id}`); // upload_ids are bearer secrets
async function video(c) {
  if (!c.env.GEMINI_API_KEY) return noProvider(c.up, 'gemini');
  let slot = null;
  if (c.path === 'video/upload/start') {
    const g = await c.stub.uploadGate(c.who.sub); // takes one of today's slots atomically
    if (!g.ok) return refused(g, `Testers can attach up to ${DAILY_UPLOADS} video clips a day — try again tomorrow.`);
    slot = g.slot;
  }
  const res = await handleVideoApi(c.req, c.env, c.path, c.url.searchParams, {
    maxBytes: LIMITS.clipBytes,
    owns: async (kind, id) => c.stub.ownsJob(c.who.sub, await jobId(kind, id)),
    record: async (kind, id) => { if (id) await c.stub.addJob(c.who.sub, await jobId(kind, id), kind); },
  });
  if (slot && !res.ok) await c.stub.dropSlot(c.who.sub, slot); // a refused start (e.g. over 200 MB) doesn't use up a clip
  return withHeaders(res, allowanceHeader(await c.stub.allowance(c.who.sub)));
}

// ── owner: /api/testers* (the caller has already checked the passcode) ──
export async function testerAdmin(req, env, path) {
  const stub = ledger(env);
  if (!stub) return json({ error: 'Tester access isn’t set up on this server (no LEDGER binding).' }, 503);
  if (path === 'testers' && req.method === 'GET') return json(await stub.roster());
  const action = path.match(/^testers\/(revoke|restore|config)$/)?.[1];
  if (!action || req.method !== 'POST') return json({ error: 'Not found' }, 404);
  const { big, body } = await readJson(req, 16 * KB);
  if (big || !body) return json({ error: 'Bad JSON body' }, 400);
  if (action === 'config') {
    const r = await stub.setConfig(body);
    if (!r.ok) return json({ error: r.error, code: 'bad_config' }, 400);
  } else {
    if (typeof body.sub !== 'string' || !SUB.test(body.sub)) return json({ error: 'sub is required' }, 400);
    if (!(await (action === 'revoke' ? stub.revoke(body.sub) : stub.restore(body.sub)))) return json({ error: 'No such tester' }, 404);
  }
  resetTesterCaches(); // this isolate forgets revoked sessions at once; others within 60 s (and the meter refuses them now)
  return json({ ok: true, ...(await stub.roster()) });
}
