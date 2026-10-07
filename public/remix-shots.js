// Video Remix: filming the new shots a plan asks for — Veo 3.1 through Atelier's /api/x/gemini proxy (the same paths
// as app.js runVeo, so the owner allow-list and the tester routes both work unchanged) and, for the owner, Runway
// Gen-4.5 / Gen-4 Turbo through public/runway.js (/api/runway/*). Resumable: a shot's whole state is {state, op,
// startedAt, …}, so polling can pick up after a reload from the op alone. Node-tested with a mocked fetch
// (tests/remix-shots.test.mjs); nothing here touches the DOM.
//
// The one rule that matters for money: a start request that may have reached the provider is never sent again by
// itself. Only a DEFINITIVE answer (an HTTP status with a body) can be retried: 429 → 'queued' (no operation was
// created, nothing billed), tester 402 → 'budget'. A dropped connection or timeout after sending → 'unknown', which
// needs the user's fresh approval ("retrying may bill twice").
import { createTask, getTask, downloadOutput, failureOf, buildRequest, ratioFor } from './runway.js?v=73';
import { parseResetsAt } from './tester.js?v=73';
import { shotModel, shotPrompt, SHOT_NEGATIVE, isShotOp } from './remix.js?v=73';

export const SHOT_TIMING = { start: 60_000, poll: 5_000, pollSlow: 10_000, slowAfter: 180_000, queuedRetry: 30_000, queuedMax: 600_000, expireAfter: 47 * 3_600_000, request: 30_000, download: 300_000, downloadTries: 3 };
const OP_RE = /^models\/[\w.-]+\/operations\/[\w.-]+$/;
const FILE_RE = /\/(v1(?:beta)?\/files\/[^?:/]+:download)/;

/** kind: 'definitive' (the provider answered: status + body), 'unknown' (may have started), 'transient' (a poll or
 *  download hiccup: try again next tick). */
export class ShotError extends Error {
  constructor(kind, message, extra = {}) { super(message); this.name = 'ShotError'; this.kind = kind; Object.assign(this, extra); }
}
const abortError = () => new DOMException('Aborted', 'AbortError');
const isAbort = (e) => e?.name === 'AbortError';

export const providerOf = (model) => shotModel(model)?.provider ?? null;

// ── request bodies ──
/**
 * Pixel size of the still a shot starts from (remix-draw.js padFrame draws the source frame into it): Veo takes its own
 * 9:16 / 16:9 frame (the source sits centred with blurred bands, outside the later crop); Runway takes the ratio
 * closest to the output (832:1104 for 4:5), so its insert is nearly native.
 */
export function firstFrameShape(model, out = { w: 1080, h: 1350 }) {
  const portrait = out.h >= out.w;
  if (providerOf(model) === 'runway') { const [w, h] = ratioFor(out.w, out.h, 'image_to_video').split(':').map(Number); return { w, h }; }
  return portrait ? { w: 720, h: 1280 } : { w: 1280, h: 720 };
}
/**
 * One shot → the provider request. ctx: {model, res, seconds, look, image (data:image/jpeg|png;base64 first frame or
 * null), out: {w, h}}. → {provider, model, veo: {path, body}} | {provider, model, runway: {kind, body}}.
 */
export function shotRequest(shot, ctx = {}) {
  const m = shotModel(ctx.model);
  if (!m) throw new ShotError('definitive', 'That model can’t film remix shots.', { status: 400 });
  const out = ctx.out || { w: 1080, h: 1350 }, portrait = out.h >= out.w;
  const prompt = shotPrompt(shot, ctx.look || '', portrait ? 'vertical' : 'wide');
  const seconds = Number(ctx.seconds ?? shot?.seconds);
  if (m.provider === 'veo') {
    const instance = { prompt };
    const img = typeof ctx.image === 'string' && ctx.image.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
    if (img) instance.image = { inlineData: { mimeType: img[1], data: img[2] } };
    return { provider: 'veo', model: m.id, veo: {
      path: `gemini/v1beta/models/${m.id.replace('gemini:', '')}:predictLongRunning`,
      body: { instances: [instance], parameters: { aspectRatio: portrait ? '9:16' : '16:9', resolution: ctx.res || '720p', durationSeconds: seconds, negativePrompt: SHOT_NEGATIVE } },
    } };
  }
  const shape = firstFrameShape(m.id, out);
  const req = buildRequest({ model: m.runway, prompt, still: ctx.image || undefined, stillSize: ctx.image ? shape : undefined, ratio: `${shape.w}:${shape.h}`, aspect: portrait ? '9:16' : '16:9', secs: seconds });
  return { provider: 'runway', model: m.id, runway: { kind: req.kind, body: req.body } };
}

// ── Veo over /api/x/gemini ──
const headersFor = (deps, json) => {
  const h = new Headers(typeof deps.apiHeaders === 'function' ? deps.apiHeaders() : deps.apiHeaders || {});
  if (json) h.set('content-type', 'application/json'); else h.delete('content-type');
  return h;
};
// fetch with a timeout. A throw here is ambiguous for a POST (it may have arrived), so callers decide what it means.
async function send(deps, path, { method = 'GET', body, timeout = SHOT_TIMING.request } = {}) {
  const f = deps.fetch || globalThis.fetch;
  const ctrl = new AbortController(), outer = deps.signal;
  let late = false;
  const timer = setTimeout(() => { late = true; ctrl.abort(); }, timeout);
  const ab = () => ctrl.abort();
  if (outer?.aborted) { clearTimeout(timer); throw abortError(); }
  outer?.addEventListener('abort', ab, { once: true });
  try {
    const r = await f(`/api/x/${path}`, { method, signal: ctrl.signal, headers: headersFor(deps, body !== undefined), body: body === undefined ? undefined : JSON.stringify(body) });
    try { deps.onResponse?.(r); } catch {}
    return r;
  } catch (err) {
    if (outer?.aborted && !late) throw abortError();
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), { late });
  } finally { clearTimeout(timer); outer?.removeEventListener('abort', ab); }
}
async function bodyOf(r) {
  let text = '';
  try { text = await r.text(); } catch {}
  let j = null;
  try { j = JSON.parse(text); if (Array.isArray(j)) j = j[0] || null; } catch {}
  const msg = (j && (typeof j.error === 'string' ? j.error : j.error?.message || j.message)) || text || `Request failed (${r.status}).`;
  return { j: j && typeof j === 'object' ? j : {}, msg: String(msg).slice(0, 300), parsed: Boolean(j && typeof j === 'object') };
}
const GATEWAY = new Set([502, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530]);
/** A start answer that can't rule out that the job was created (see veoStart / runwayStart). */
export const ambiguous = (status, parsed = true) => GATEWAY.has(status) || (status >= 500 && !parsed);
/**
 * POST predictLongRunning → {op}. Throws ShotError: definitive (HTTP status with a body: status, code, scope,
 * resetsAt, retryAfter) or unknown (no answer: the shot may be filming and billing at Google). deps: {fetch,
 * apiHeaders, onResponse, signal}. Aborting before the request leaves → AbortError (nothing sent).
 */
export async function veoStart(deps, request) {
  if (deps.signal?.aborted) throw abortError();
  let r;
  try { r = await send({ ...deps, signal: null }, request.path, { method: 'POST', body: request.body, timeout: SHOT_TIMING.start }); }
  catch (err) { throw new ShotError('unknown', err.late ? 'Google didn’t confirm the new shot in time — it may have started anyway.' : 'The connection dropped before Google confirmed the new shot — it may have started anyway.'); }
  const { j, msg, parsed } = await bodyOf(r);
  if (!r.ok) {
    // A gateway answer (Atelier's own 'Upstream unreachable' 502, Cloudflare's 504/52x) or a 5xx that isn't the provider's
    // JSON error doesn't say whether the request reached Google: it may be filming, so it is never retried by itself.
    if (ambiguous(r.status, parsed)) throw new ShotError('unknown', 'Google didn’t confirm the new shot — it may have started anyway.', { status: r.status });
    const ra = Number(r.headers?.get?.('retry-after'));
    throw new ShotError('definitive', msg, { status: r.status, code: typeof j.code === 'string' ? j.code : null, scope: typeof j.scope === 'string' ? j.scope : null, resetsAt: j.resetsAt ?? null, ...(ra > 0 ? { retryAfter: ra } : {}) });
  }
  if (typeof j.name !== 'string' || !OP_RE.test(j.name)) throw new ShotError('unknown', 'Google answered without an operation to follow — check usage before filming this again.');
  return { op: j.name };
}
/** Done-operation JSON → {done:true, uri} | {done:true, filtered:true, reason} | {done:true, error}. */
export function readVeoOp(op) {
  if (!op?.done) return { done: false };
  if (op.error) return { done: true, error: String(op.error.message || 'Veo couldn’t make this shot.').slice(0, 300) };
  const res = op.response?.generateVideoResponse;
  const uri = res?.generatedSamples?.[0]?.video?.uri;
  if (typeof uri === 'string' && FILE_RE.test(uri)) return { done: true, uri };
  return { done: true, filtered: true, reason: String(res?.raiMediaFilteredReasons?.[0] || 'Veo returned no video — it may have been filtered.').slice(0, 300) };
}
/** GET the operation → readVeoOp's shape; {done:true, gone:true} on 404. Network trouble / 429 / 5xx → transient. */
export async function veoPoll(deps, op) {
  if (!OP_RE.test(op)) throw new ShotError('definitive', 'Not a Veo operation.', { status: 400 });
  let r;
  try { r = await send(deps, `gemini/v1beta/${op}`); }
  catch (err) { if (isAbort(err)) throw err; throw new ShotError('transient', 'Couldn’t reach Atelier to check on the shot.'); }
  if (r.status === 404) return { done: true, gone: true };
  if (!r.ok) {
    const { msg } = await bodyOf(r);
    if (r.status === 429 || r.status >= 500) throw new ShotError('transient', msg, { status: r.status });
    throw new ShotError('definitive', msg, { status: r.status });
  }
  const { j } = await bodyOf(r);
  return readVeoOp(j);
}
/** The finished MP4 → a video/mp4 Blob. Network trouble → transient (downloading again is free). */
export async function veoFetch(deps, uri) {
  const m = String(uri || '').match(FILE_RE);
  if (!m) throw new ShotError('definitive', 'Unexpected Veo download link.', { status: 502 });
  let r;
  try { r = await send(deps, `gemini/${m[1]}?alt=media`, { timeout: SHOT_TIMING.download }); }
  catch (err) { if (isAbort(err)) throw err; throw new ShotError('transient', 'The shot download dropped — it will try again (no new shot is made).'); }
  if (!r.ok) {
    const { msg } = await bodyOf(r);
    if (r.status === 404 || r.status === 403) throw new ShotError('definitive', msg, { status: r.status, gone: r.status === 404 });
    throw new ShotError('transient', msg, { status: r.status });
  }
  const blob = await r.blob();
  if (!blob.size) throw new ShotError('transient', 'Google sent back an empty shot.');
  return blob.type === 'video/mp4' ? blob : new Blob([blob], { type: 'video/mp4' });
}

// ── Runway (owner only) through public/runway.js ──
const runwayId = (op) => (typeof op === 'string' && op.startsWith('runway:') ? op.slice(7) : '');
export async function runwayStart(deps, request) {
  if (deps.signal?.aborted) throw abortError();
  try {
    const made = await createTask(request.kind, request.body, { apiHeaders: deps.apiHeaders });
    const op = `runway:${made.id}`;
    if (!isShotOp(op)) throw new ShotError('unknown', 'Runway answered without a task id — check usage at dev.runway.com before filming this again.');
    return { op };
  } catch (err) {
    if (err instanceof ShotError) throw err;
    if (err?.status === 0 || err?.code === 'runway_unconfirmed' || GATEWAY.has(err?.status)) throw new ShotError('unknown', err.message || 'Runway didn’t confirm the new shot — it may have started anyway.');
    throw new ShotError('definitive', err?.message || 'Runway refused the shot.', { status: err?.status ?? 500, code: err?.code ?? null, ...(err?.retryAfter ? { retryAfter: err.retryAfter } : {}) });
  }
}
export async function runwayPoll(deps, op) {
  const id = runwayId(op);
  if (!id) throw new ShotError('definitive', 'Not a Runway task.', { status: 400 });
  let task;
  try { task = await getTask(id, { apiHeaders: deps.apiHeaders, signal: deps.signal }); }
  catch (err) {
    if (isAbort(err)) throw err;
    if (err?.status === 404 || err?.code === 'runway_gone') return { done: true, gone: true };
    if (err?.status === 0 || err?.status === 429 || err?.status >= 500) throw new ShotError('transient', err.message, { status: err.status });
    throw new ShotError('definitive', err?.message || 'Runway refused.', { status: err?.status ?? 500 });
  }
  if (task?.status === 'SUCCEEDED') return { done: true, uri: op };
  if (task?.status === 'FAILED') {
    const f = failureOf(task);
    return f.status === 400 && /safety/i.test(f.message) ? { done: true, filtered: true, reason: f.message, credits: f.credits } : { done: true, error: f.message, credits: f.credits };
  }
  if (task?.status === 'CANCELLED') return { done: true, error: 'The Runway shot was cancelled.' };
  const p = Number(task?.progress);
  return { done: false, ...(p > 0 && p <= 1 ? { progress: p } : {}) };
}
export async function runwayFetch(deps, op) {
  try { return await downloadOutput(runwayId(op), { apiHeaders: deps.apiHeaders, signal: deps.signal }); }
  catch (err) {
    if (isAbort(err)) throw err;
    if (err?.status === 404 || ['runway_gone', 'runway_no_output', 'runway_too_large'].includes(err?.code)) throw new ShotError('definitive', err.message, { status: err.status || 404, gone: true });
    throw new ShotError('transient', err?.message || 'The Runway download dropped.', { status: err?.status ?? 0 });
  }
}

// ── one interface ──
export const startShot = (deps, req) => (req.provider === 'runway' ? runwayStart(deps, req.runway) : veoStart(deps, req.veo));
export const pollShot = (deps, op) => (runwayId(op) ? runwayPoll(deps, op) : veoPoll(deps, op));
export const fetchShot = (deps, op, uri) => (runwayId(op) ? runwayFetch(deps, op) : veoFetch(deps, uri));

/**
 * An error or a poll result → the shot's next {state, …} patch, or null (no change: a transient hiccup or a Stop).
 *   start errors: definitive 429 → queued (retryAt); tester 402 → budget (resetsAt); other definitive → failed;
 *                 unknown → unknown.
 *   poll results: not done → filming; uri → downloading; no uri → filtered (not billed); error → failed;
 *                 gone → expired.
 */
export function classify(x, now = Date.now()) {
  if (!x || isAbort(x)) return null;
  if (x instanceof ShotError || x?.name === 'ShotError') {
    if (x.kind === 'transient') return null;
    if (x.kind === 'unknown') return { state: 'unknown', error: x.message };
    if (x.status === 429) return { state: 'queued', retryAt: now + Math.max(SHOT_TIMING.queuedRetry, (Number(x.retryAfter) || 0) * 1000), error: 'Google is busy — retrying in 30 s (not billed)' };
    if (x.status === 402 && (x.code === 'tester_budget' || !x.code)) {
      const resetsAt = parseResetsAt(x.resetsAt, x.scope || 'day', now);
      return { state: 'budget', error: x.message, ...(resetsAt ? { resetsAt } : {}) };
    }
    if (x.gone) return { state: 'expired', error: x.message };
    return { state: 'failed', error: x.message };
  }
  if (typeof x === 'object' && 'done' in x) {
    if (!x.done) return { state: 'filming', ...(x.progress ? { progress: x.progress } : {}) };
    if (x.gone) return { state: 'expired', error: 'The provider no longer has this shot (it keeps them about 2 days).' };
    if (x.uri) return { state: 'downloading', uri: x.uri };
    if (x.filtered) return { state: 'filtered', error: x.reason };
    return { state: 'failed', error: x.error || 'The shot couldn’t be made.' };
  }
  return { state: 'failed', error: String(x?.message || x).slice(0, 300) };
}
/** Wait before the next poll of a shot started at startedAt: 5 s, then 10 s after 3 min. */
export const pollDelay = (startedAt, now = Date.now()) => (now - startedAt > SHOT_TIMING.slowAfter ? SHOT_TIMING.pollSlow : SHOT_TIMING.poll);

/**
 * One step of a shot's life, for the job registry (the only writer of shot state). s: the shot's state record
 * ({state, op, startedAt, contentKey, …}). deps: {fetch, apiHeaders, onResponse, signal, now(), save(patch) — awaited
 * BEFORE the start request so a reload sees 'starting' and never sends it twice — putBlob(blob) → {blobKey, bytes},
 * request: shotRequest(…) for this shot}. → the patch to apply (null: nothing to do now).
 *   idle | queued (retryAt passed) → starting → filming {op, startedAt} | queued | budget | failed | unknown
 *   filming → filming | downloading | filtered | failed | expired (startedAt older than 47 h)
 *   downloading → ready {blobKey, bytes, filmedKey} (a dropped download retries: it is already paid for)
 *   everything else (ready, unknown, failed, filtered, budget, expired, missing, starting) waits for the user.
 */
export async function advanceShot(deps, s) {
  const now = deps.now ? deps.now() : Date.now();
  if (!s) return null;
  if (s.state === 'idle' || (s.state === 'queued' && !(Number(s.retryAt) > now))) {
    if (s.state === 'queued' && Number(s.queuedSince) > 0 && now - s.queuedSince > SHOT_TIMING.queuedMax) return { state: 'failed', error: 'Google stayed busy for 10 minutes — tap Retry (not billed)' };
    if (!deps.request) return null;
    await deps.save?.({ state: 'starting', startedAt: now });
    try {
      const { op } = await startShot(deps, deps.request);
      return { state: 'filming', op, startedAt: now, error: null };
    } catch (err) {
      if (isAbort(err)) return { state: s.state };
      const p = classify(err, now) || { state: 'failed', error: err?.message };
      if (p.state === 'queued') p.queuedSince = Number(s.queuedSince) > 0 ? s.queuedSince : now;
      return p;
    }
  }
  if (s.state === 'filming') {
    if (!isShotOp(s.op)) return { state: 'failed', error: 'This shot lost track of its job.' };
    if (Number(s.startedAt) > 0 && now - s.startedAt > SHOT_TIMING.expireAfter) return { state: 'expired', error: 'The provider no longer keeps this shot (about 2 days).' };
    let res;
    try { res = await pollShot(deps, s.op); } catch (err) { return classify(err, now); }
    const p = classify(res, now);
    // The provider finished this generation without a video: its op is done with, so a Retry films anew (resumeOf).
    if (p && (p.state === 'failed' || p.state === 'filtered' || p.state === 'expired')) p.op = null;
    if (p?.state !== 'downloading') return p;
    return advanceShot(deps, { ...s, ...p });
  }
  if (s.state === 'downloading' && s.uri) {
    try {
      const blob = await fetchShot(deps, s.op, s.uri);
      const stored = deps.putBlob ? await deps.putBlob(blob) : { bytes: blob.size };
      return { state: 'ready', uri: null, error: null, filmedKey: s.contentKey ?? null, ...stored };
    } catch (err) {
      if (isAbort(err)) return null;
      const tries = (Number(s.tries) || 0) + 1;
      // uri travels with every patch: a shot that reached 'downloading' inside this call (filming → done) has it only here
      if (err?.kind === 'definitive') return { state: err.gone ? 'expired' : 'failed', error: err.message, uri: s.uri };
      return tries >= SHOT_TIMING.downloadTries ? { state: 'failed', error: 'The shot download kept dropping — tap Retry download (it won’t film again).', tries, uri: s.uri } : { state: 'downloading', tries, uri: s.uri };
    }
  }
  return null;
}
