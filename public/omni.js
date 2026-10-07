// Gemini Omni Flash video for Video mode and Video Remix: the request builder and the start → poll → download runner.
// The browser only talks to Atelier's /api/omni/* (src/omni.js for the owner, src/tester/router.js for testers); the key
// stays on the server. Pure helpers are node-tested (tests/omni-client.test.mjs); nothing touches the DOM.
// Google's Veo 3.1 models on the Gemini API shut down on 2026-10-22; Omni (gemini-omni-1.1-flash) replaces them.

export const OMNI_ID = 'gemini:gemini-omni-1.1-flash';
// The Veo ids saved threads and settings may still name → the model that films their requests now.
export const RETIRED_VIDEO = Object.freeze({
  'gemini:veo-3.1-lite-generate-preview': OMNI_ID,
  'gemini:veo-3.1-fast-generate-preview': OMNI_ID,
  'gemini:veo-3.1-generate-preview': OMNI_ID,
});
/** A saved video model id → the id to use today (a retired Veo pin → Omni; anything else unchanged). */
export const migrateVideoId = (id) => (typeof id === 'string' && Object.hasOwn(RETIRED_VIDEO, id) ? RETIRED_VIDEO[id] : id);
// Video-mode lengths: Omni films 3–10 s. Testers keep 4/6/8 (their $1.00 call cap leaves 4 s and 6 s at 720p).
export const OMNI_SECONDS = Object.freeze([4, 6, 8, 10]);
export const OMNI_TESTER_SECONDS = Object.freeze([4, 6, 8]);
export const OMNI_TIMING = { poll: 10_000, request: 30_000, start: 60_000, download: 5 * 60_000, total: 20 * 60_000, failures: 8, notReady: 6 };

const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const abortError = () => new DOMException('Aborted', 'AbortError');

/** Video-mode params ({aspect: '16:9' | '9:16' | '16:9hd', secs}) → {seconds, resolution, aspect} as Omni takes them. */
export function omniShape(params = {}, { tester = false } = {}) {
  const list = tester ? OMNI_TESTER_SECONDS : OMNI_SECONDS;
  const s = Math.round(Number(params.secs));
  const seconds = list.includes(s) ? s : s > list.at(-1) ? list.at(-1) : 6;
  return { seconds, resolution: params.aspect === '16:9hd' ? '1080p' : '720p', aspect: params.aspect === '9:16' ? '9:16' : '16:9' };
}
/**
 * The body for POST /api/omni/start. still: a data:image (PNG/JPEG/WebP) URL to start from, or null. previous: an earlier
 * Omni clip's interaction id to edit (task 'edit') or continue (task 'extend').
 */
export function omniRequest({ prompt, still = null, params = {}, tester = false, previous = null, task = null } = {}) {
  const p = String(prompt ?? '').trim();
  if (!p) throw fail(400, 'Describe the video you want.');
  const { seconds, resolution, aspect } = omniShape(params, { tester });
  const body = { prompt: p, aspect, resolution, seconds };
  if (still) {
    if (typeof still !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/.test(still)) throw fail(400, 'Omni takes PNG, JPEG or WebP images.');
    body.image = still;
  }
  if (previous) { body.previous = previous; if (task) body.task = task; }
  return body;
}

// ── talking to /api/omni/* ──
const headersFor = (apiHeaders, json) => {
  const h = new Headers(typeof apiHeaders === 'function' ? apiHeaders() : apiHeaders || {});
  if (json) h.set('content-type', 'application/json'); else h.delete('content-type');
  return h;
};
async function send(deps, path, { method = 'GET', body, timeout = OMNI_TIMING.request } = {}) {
  const f = deps.fetch || globalThis.fetch;
  const ctrl = new AbortController(), outer = deps.signal;
  let late = false;
  const timer = setTimeout(() => { late = true; ctrl.abort(); }, timeout);
  const ab = () => ctrl.abort();
  if (outer?.aborted) { clearTimeout(timer); throw abortError(); }
  outer?.addEventListener('abort', ab, { once: true });
  try {
    const r = await f(`/api/omni/${path}`, { method, signal: ctrl.signal, headers: headersFor(deps.apiHeaders, body !== undefined), body: body === undefined ? undefined : JSON.stringify(body) });
    try { deps.onResponse?.(r); } catch {}
    return r;
  } catch (err) {
    if (outer?.aborted && !late) throw abortError();
    throw fail(0, late ? 'Atelier took too long to answer — check your connection.' : 'Couldn’t reach Atelier — the connection dropped.', { late });
  } finally { clearTimeout(timer); outer?.removeEventListener('abort', ab); }
}
const readJson = async (r) => { try { const j = await r.json(); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; } catch { return {}; } };
function errorFrom(r, j, fallback) {
  const ra = Number(r.headers?.get?.('retry-after'));
  return fail(r.status, typeof j.error === 'string' && j.error ? j.error.slice(0, 400) : fallback, {
    ...(typeof j.code === 'string' ? { code: j.code } : {}), ...(typeof j.scope === 'string' ? { scope: j.scope } : {}),
    ...(j.resetsAt != null ? { resetsAt: j.resetsAt } : {}), ...(ra > 0 ? { retryAfter: ra } : {}),
  });
}
const ID = /^[A-Za-z0-9_-]{1,256}$/;

/** POST /api/omni/start → {id, seconds, durationIgnored?}. No answer at all → Error {status: 0, code: 'omni_unconfirmed'}. */
export async function omniStart(deps, body) {
  let r;
  try { r = await send(deps, 'start', { method: 'POST', body, timeout: OMNI_TIMING.start }); }
  catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw fail(0, 'Google didn’t confirm the new video — it may have started anyway. Check usage in AI Studio before trying again.', { code: 'omni_unconfirmed' });
  }
  const j = await readJson(r);
  if (!r.ok) throw errorFrom(r, j, `The Omni request failed (${r.status}).`);
  if (!ID.test(j.id || '')) throw fail(502, 'Google answered without a video id.', { code: 'omni_unconfirmed' });
  return { id: j.id, seconds: Number.isInteger(j.seconds) ? j.seconds : null, ...(j.durationIgnored ? { durationIgnored: true } : {}) };
}
/** GET /api/omni/status/<id> → {id, status, done, video, error?, filtered?, pollAfterMs?}. */
export async function omniStatus(deps, id) {
  if (!ID.test(id || '')) throw fail(400, 'Not an Omni video.');
  const r = await send(deps, `status/${encodeURIComponent(id)}`);
  const j = await readJson(r);
  if (!r.ok) throw errorFrom(r, j, `Checking the Omni video failed (${r.status}).`);
  return j;
}
/** GET /api/omni/video/<id> → a video/mp4 Blob (409 {code: 'omni_not_ready'} while Google still processes it). */
export async function omniFetch(deps, id) {
  if (!ID.test(id || '')) throw fail(400, 'Not an Omni video.');
  const r = await send(deps, `video/${encodeURIComponent(id)}`, { timeout: OMNI_TIMING.download });
  if (!r.ok) throw errorFrom(r, await readJson(r), `Downloading the Omni video failed (${r.status}).`);
  let blob;
  try { blob = await r.blob(); } catch { throw fail(0, 'The Omni video download dropped — tap Try again (it won’t make a new video).', { resumable: true }); }
  if (!blob.size) throw fail(502, 'Google sent back an empty video — try again.', { resumable: true });
  return /^video\/(mp4|webm)$/.test(blob.type) ? blob : new Blob([blob], { type: 'video/mp4' });
}
/** Fire-and-forget cancel (Stop). Resolves true/false, never rejects. */
export function omniCancel(deps, id) {
  if (!ID.test(id || '')) return Promise.resolve(false);
  // never tied to the caller's (already aborted) signal: a Stop must still reach the server
  return send({ ...deps, signal: null }, `cancel/${encodeURIComponent(id)}`, { method: 'POST', body: {} }).then((r) => r.ok, () => false);
}

const sleepFor = (ms, signal) => new Promise((res, rej) => {
  if (signal?.aborted) return rej(abortError());
  const ab = () => { clearTimeout(t); rej(abortError()); };
  const t = setTimeout(() => { signal?.removeEventListener('abort', ab); res(); }, ms);
  signal?.addEventListener('abort', ab, { once: true });
});
const transient = (s) => s === 0 || s === 408 || s === 429 || s >= 500;

/**
 * The whole job: start (or resume `resume`, an earlier interaction id) → poll every ≥ 10 s → download →
 * {id, blob, seconds}. onId(id): the video exists (app.js keeps it on the entry, so Try again resumes instead of paying
 * twice); onStatus(text). Errors carry `id` and `resumable` while Try again should check on that video rather than
 * start a new one. Stop cancels a video that is still being made.
 */
export async function omniVideo(body, { apiHeaders, signal, onStatus, onId, resume = null, fetch: f, sleep = sleepFor, now = Date.now, onResponse } = {}) {
  const deps = { apiHeaders, signal, fetch: f, onResponse };
  const say = (t) => { try { onStatus?.(t); } catch {} };
  let id = typeof resume === 'string' && ID.test(resume) ? resume : null, finished = false, seconds = body?.seconds ?? null;
  try {
    if (!id) {
      say('Sending to Gemini Omni');
      const made = await omniStart({ ...deps, signal: null }, body); // never cut short: the start may already bill
      if (signal?.aborted) { omniCancel(deps, made.id); throw abortError(); }
      id = made.id; seconds = made.seconds ?? seconds;
      try { onId?.(id, made); } catch {}
    } else say('Checking on the earlier Omni video');
    const end = now() + OMNI_TIMING.total;
    let failures = 0, first = Boolean(resume), s;
    for (;;) {
      if (!first) await sleep(Math.max(OMNI_TIMING.poll, failures ? Math.min(60_000, OMNI_TIMING.poll * 2 ** failures) : 0), signal);
      first = false;
      if (now() > end) throw fail(504, 'Gemini Omni is still working on this after 20 minutes — tap Try again to keep waiting (it won’t start a new video).', { code: 'omni_slow', resumable: true });
      try { s = await omniStatus(deps, id); }
      catch (err) {
        if (err?.name === 'AbortError') throw err;
        if (!transient(err.status) || ++failures > OMNI_TIMING.failures) throw Object.assign(err, { resumable: transient(err.status) });
        continue;
      }
      failures = 0;
      if (!s.done) { say(s.status === 'queued' ? 'Queued at Google' : 'Filming with Gemini Omni'); continue; }
      finished = true;
      if (s.video) break;
      throw fail(s.filtered ? 400 : 500, s.error || 'Gemini Omni couldn’t make this video.', { code: s.filtered ? 'omni_filtered' : 'omni_failed' });
    }
    say('Downloading');
    for (let tries = 0; ; tries++) {
      try { return { id, blob: await omniFetch(deps, id), seconds }; }
      catch (err) {
        if (err?.name === 'AbortError') throw err;
        if (err?.code === 'omni_not_ready' && tries < OMNI_TIMING.notReady) { await sleep(OMNI_TIMING.poll, signal); continue; }
        throw Object.assign(err, { resumable: err?.status !== 404 && err?.code !== 'omni_too_large' });
      }
    }
  } catch (err) {
    if (err?.name === 'AbortError' && id) {
      if (!finished) omniCancel(deps, id); // Stop: don't let it run on
      err.resumable = finished;
    }
    if (id && err && typeof err === 'object' && !err.id) err.id = id;
    throw err;
  }
}
