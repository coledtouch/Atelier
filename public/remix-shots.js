// Video Remix: filming the new shots a plan asks for — Gemini Omni Flash through Atelier's /api/omni/* (public/omni.js:
// src/omni.js for the owner, the tester routes with the same paths) and, for the owner, Runway Gen-4.5 / Gen-4 Turbo /
// Veo 3.1 through public/runway.js (/api/runway/*). Resumable: a shot's whole state is {state, op, startedAt, …}, so
// polling can pick up after a reload from the op alone ('omni:<interaction id>' | 'runway:<task uuid>'). Node-tested
// with a mocked fetch (tests/remix-shots.test.mjs); nothing here touches the DOM.
// Veo 3.1 on the Gemini API shuts down 2026-10-22: a saved shot still tied to a Veo operation ('models/…/operations/…')
// ends as expired (its job ends with the shutdown) and is refilmed with Omni after a fresh approval.
//
// The one rule that matters for money: a start request that may have reached the provider is never sent again by
// itself. Only a DEFINITIVE answer (an HTTP status with a body) can be retried: 429 → 'queued' (no video was created,
// nothing billed), tester 402 → 'budget'. A dropped connection or timeout after sending (omni_unconfirmed, status 0)
// or a gateway answer → 'unknown', which needs the user's fresh approval ("retrying may bill twice").
import { createTask, cancelTask, getTask, downloadOutput, failureOf, buildRequest, ratioFor } from './runway.js?v=85';
import { omniStart, omniStatus, omniFetch } from './omni.js?v=85';
import { parseResetsAt } from './tester.js?v=85';
import { shotModel, shotPrompt, SHOT_NEGATIVE, isShotOp, isVeoOp, LIMITS, VEO_RETIRED } from './remix.js?v=85';

export const SHOT_TIMING = { start: 60_000, poll: 5_000, pollSlow: 10_000, slowAfter: 180_000, queuedRetry: 30_000, queuedMax: 600_000, expireAfter: 47 * 3_600_000, request: 30_000, download: 300_000, downloadTries: 3, notReadyTries: 6 };

/** kind: 'definitive' (the provider answered: status + body), 'unknown' (may have started), 'transient' (a poll or
 *  download hiccup: try again next tick). */
export class ShotError extends Error {
  constructor(kind, message, extra = {}) { super(message); this.name = 'ShotError'; this.kind = kind; Object.assign(this, extra); }
}
const abortError = () => new DOMException('Aborted', 'AbortError');
const isAbort = (e) => e?.name === 'AbortError';

export const providerOf = (model) => shotModel(model)?.provider ?? null;
// Gemini Omni ('omni'; 'veo' is the pre-Omni name of the same Gemini path) vs Runway.
const isOmni = (m) => m?.provider === 'omni' || m?.provider === 'veo';
// Runway's Veo 3.1, Grok Imagine and Seedance 2.5 take a 16:9 / 9:16 frame (1280:720, 720:1280) as is, not Gen-4's ratios.
const runwayVeo = (m) => m?.provider === 'runway' && /^(veo|grok|seedance)/.test(m.runway || '');

// ── request bodies ──
/**
 * Pixel size of the still a shot starts from (remix-draw.js padFrame draws the source frame into it): Omni (and Veo 3.1
 * on Runway) take their own 9:16 / 16:9 frame (the source sits centred with blurred bands, outside the later crop);
 * Runway Gen-4 takes the ratio closest to the output (832:1104 for 4:5), so its insert is nearly native.
 */
export function firstFrameShape(model, out = { w: 1080, h: 1350 }) {
  const portrait = out.h >= out.w, m = shotModel(model);
  if (m?.provider === 'runway' && !runwayVeo(m)) { const [w, h] = ratioFor(out.w, out.h, 'image_to_video').split(':').map(Number); return { w, h }; }
  return portrait ? { w: 720, h: 1280 } : { w: 1280, h: 720 };
}
/** The Omni prompt: Omni has no negative-prompt field, so SHOT_NEGATIVE goes in as plain words (within the cap). */
export function omniPrompt(prompt) {
  const avoid = `Avoid: ${SHOT_NEGATIVE}.`;
  const p = String(prompt ?? '').trim().slice(0, LIMITS.shotPromptMax - avoid.length - 1).trim();
  return p ? `${p} ${avoid}` : avoid;
}
const OMNI_IMAGE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z\d+/=]+$/;
/**
 * One shot → the provider request. ctx: {model, res, seconds, look, image (data:image/jpeg|png|webp;base64 first frame
 * or null), out: {w, h}}. → {provider: 'omni', model, omni: {body}} (POST /api/omni/start's body:
 * {prompt, image?, aspect, resolution, seconds}) | {provider: 'runway', model, runway: {kind, body}}.
 */
export function shotRequest(shot, ctx = {}) {
  const m = shotModel(ctx.model);
  if (!m) throw new ShotError('definitive', 'That model can’t film remix shots.', { status: 400 });
  const out = ctx.out || { w: 1080, h: 1350 }, portrait = out.h >= out.w;
  const prompt = shotPrompt(shot, ctx.look || '', portrait ? 'vertical' : 'wide');
  const seconds = Number(ctx.seconds ?? shot?.seconds);
  if (isOmni(m)) {
    const body = { prompt: omniPrompt(prompt) };
    if (typeof ctx.image === 'string' && OMNI_IMAGE.test(ctx.image)) body.image = ctx.image;
    Object.assign(body, { aspect: portrait ? '9:16' : '16:9', resolution: m.res.includes(ctx.res) ? ctx.res : '720p', seconds });
    return { provider: 'omni', model: m.id, omni: { body } };
  }
  const shape = firstFrameShape(m.id, out);
  const req = buildRequest({ model: m.runway, prompt, still: ctx.image || undefined, stillSize: ctx.image ? shape : undefined, ratio: `${shape.w}:${shape.h}`, aspect: portrait ? '9:16' : '16:9', secs: seconds });
  return { provider: 'runway', model: m.id, runway: { kind: req.kind, body: req.body } };
}

const GATEWAY = new Set([502, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530]);
/** A start answer that can't rule out that the job was created (a gateway, or a 5xx that isn't Atelier's own JSON). */
export const ambiguous = (status, parsed = true) => GATEWAY.has(status) || (status >= 500 && !parsed);
const transientStatus = (s) => s === 0 || s === 408 || s === 429 || s >= 500;

// ── Gemini Omni over /api/omni/* ──
const omniId = (op) => (typeof op === 'string' && op.startsWith('omni:') ? op.slice(5) : '');
const omniDeps = (deps, signal = deps.signal) => ({ fetch: deps.fetch, apiHeaders: deps.apiHeaders, onResponse: deps.onResponse, signal });
/**
 * POST /api/omni/start → {op: 'omni:<id>'}. Throws ShotError: definitive (an HTTP status with a body: status, code,
 * scope, resetsAt, retryAfter) or unknown (no answer, omni_unconfirmed, or a gateway: the shot may be filming and
 * billing at Google). Aborting before the request leaves → AbortError (nothing sent); once sent it is never cut short.
 */
export async function omniShotStart(deps, request) {
  if (deps.signal?.aborted) throw abortError();
  let made;
  try { made = await omniStart(omniDeps(deps, null), request.body); }
  catch (err) {
    const status = Number(err?.status) || 0;
    if (status === 0 || err?.code === 'omni_unconfirmed' || ambiguous(status, typeof err?.code === 'string')) {
      throw new ShotError('unknown', err?.message || 'Google didn’t confirm the new shot — it may have started anyway.', { status });
    }
    throw new ShotError('definitive', err?.message || 'Gemini Omni refused the shot.', { status, code: err?.code ?? null, scope: err?.scope ?? null, resetsAt: err?.resetsAt ?? null, ...(err?.retryAfter > 0 ? { retryAfter: err.retryAfter } : {}) });
  }
  const op = `omni:${made.id}`;
  if (!isShotOp(op)) throw new ShotError('unknown', 'Google answered without a video id — check usage in AI Studio before filming this again.');
  return { op };
}
/**
 * GET /api/omni/status/<id> → {done:false} | {done:true, uri: op} (the video is ready to download) | {done:true,
 * filtered:true, reason} | {done:true, error} | {done:true, gone:true} (404). Network trouble / 429 / 5xx → transient.
 */
export async function omniShotPoll(deps, op) {
  const id = omniId(op);
  if (!id) throw new ShotError('definitive', 'Not an Omni video.', { status: 400 });
  let s;
  try { s = await omniStatus(omniDeps(deps), id); }
  catch (err) {
    if (isAbort(err)) throw err;
    if (err?.status === 404 || err?.code === 'omni_gone') return { done: true, gone: true };
    if (transientStatus(Number(err?.status) || 0)) throw new ShotError('transient', err?.message || 'Couldn’t reach Atelier to check on the shot.', { status: Number(err?.status) || 0 });
    throw new ShotError('definitive', err?.message || 'Checking the Omni shot failed.', { status: err.status });
  }
  if (!s?.done) return { done: false };
  if (s.video) return { done: true, uri: op };
  const reason = typeof s.error === 'string' && s.error ? s.error.slice(0, 300) : '';
  if (s.filtered) return { done: true, filtered: true, reason: reason || 'Gemini Omni returned no video — it may have been filtered.' };
  if (s.status === 'cancelled') return { done: true, error: reason || 'The Omni shot was cancelled.' };
  return { done: true, error: reason || 'Gemini Omni couldn’t make this shot.' };
}
/** GET /api/omni/video/<id> → a video/mp4 Blob. 409 omni_not_ready, network trouble, 5xx → transient (downloading
 *  again is free); 404 → definitive gone. */
export async function omniShotFetch(deps, op) {
  const id = omniId(op);
  if (!id) throw new ShotError('definitive', 'Not an Omni video.', { status: 400 });
  try { return await omniFetch(omniDeps(deps), id); }
  catch (err) {
    if (isAbort(err)) throw err;
    const status = Number(err?.status) || 0;
    if (status === 409 || err?.code === 'omni_not_ready') throw new ShotError('transient', err?.message || 'Google is still preparing the shot.', { status: 409, notReady: true });
    if (status === 404 || err?.code === 'omni_gone') throw new ShotError('definitive', err?.message || 'Google no longer has this shot.', { status: 404, gone: true });
    if (transientStatus(status) || err?.resumable) throw new ShotError('transient', err?.message || 'The shot download dropped — it will try again (no new shot is made).', { status });
    throw new ShotError('definitive', err?.message || 'Downloading the Omni shot failed.', { status });
  }
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
    // A refusal naming a task (runway_cap_running: the Worker's cancel of an estimate over RUNWAY_MAX_CREDITS failed): the
    // task exists and may bill, and the Worker's words promise another try at cancelling it, as Video mode does.
    if (err?.task) cancelTask(err.task, { apiHeaders: deps.apiHeaders });
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
export function startShot(deps, req) {
  if (req?.provider === 'runway') return runwayStart(deps, req.runway);
  if (req?.provider === 'omni') return omniShotStart(deps, req.omni);
  return Promise.reject(new ShotError('definitive', 'That model can’t film remix shots.', { status: 400 }));
}
export async function pollShot(deps, op) {
  if (runwayId(op)) return runwayPoll(deps, op);
  if (omniId(op)) return omniShotPoll(deps, op);
  if (isVeoOp(op)) return { done: true, gone: true, retired: true }; // Veo on the Gemini API: nothing left to follow
  throw new ShotError('definitive', 'This shot lost track of its job.', { status: 400 });
}
export async function fetchShot(deps, op) {
  if (runwayId(op)) return runwayFetch(deps, op);
  if (omniId(op)) return omniShotFetch(deps, op);
  throw new ShotError('definitive', isVeoOp(op) ? VEO_RETIRED : 'This shot lost track of its job.', { status: 404, gone: true });
}

/**
 * An error or a poll result → the shot's next {state, …} patch, or null (no change: a transient hiccup or a Stop).
 *   start errors: definitive 429 → queued (retryAt); tester 402 → budget (resetsAt); other definitive → failed;
 *                 unknown → unknown.
 *   poll results: not done → filming; uri → downloading; no video → filtered (not billed); error → failed;
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
    if (x.gone) return { state: 'expired', error: x.retired ? VEO_RETIRED : 'The provider no longer has this shot (it keeps them about 2 days).' };
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
 *   filming → filming | downloading | filtered | failed | expired (startedAt older than 47 h, or a retired Veo op)
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
  if ((s.state === 'filming' || s.state === 'downloading') && isVeoOp(s.op)) return { state: 'expired', error: VEO_RETIRED, op: null, uri: null };
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
      // Google still preparing the file (409) gets more patience than a dropped download
      const limit = err?.notReady ? SHOT_TIMING.notReadyTries : SHOT_TIMING.downloadTries;
      return tries >= limit ? { state: 'failed', error: 'The shot download kept dropping — tap Retry download (it won’t film again).', tries, uri: s.uri } : { state: 'downloading', tries, uri: s.uri };
    }
  }
  return null;
}
