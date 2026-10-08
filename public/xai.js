// xAI's Grok Imagine for Image and Video mode (owner only): the catalogue, prices, request builders and the video
// runner (start → poll every ≥ 5 s → download). The browser only talks to Atelier's /api/xai/* (src/xai.js); the
// XAI_API_KEY and xAI's temporary media links stay on the server. Pure helpers are node-tested (tests/xai.test.mjs);
// nothing touches the DOM at import time. Grok chat models are plain `xai:` ids in app.js's role lists (/api/chat).
// Prices (https://docs.x.ai/developers/pricing, read 2026-10-08) — src/xai.js keeps the same figures and the test
// checks they agree.

export const XAI_IMAGE_USD = 0.04; // grok-imagine-image-2.0, medium quality at 1k (src/xai.js pins both)
export const XAI_IMAGE_MODEL = Object.freeze({ id: 'xai:grok-imagine-image-2.0', model: 'grok-imagine-image-2.0', label: 'Grok Imagine (xAI)' });
// Image-mode shapes → the nearest aspect ratio Grok Imagine takes (it has no 4:5).
export const XAI_IMAGE_ASPECT = Object.freeze({ '1:1': '1:1', '4:5': '3:4', '3:2': '3:2', '16:9': '16:9', '9:16': '9:16' });
// Video: per second of output; 1–15 s (Video mode offers these lengths); 480p / 720p / 1080p (HD).
export const XAI_SECONDS = Object.freeze([4, 6, 8, 10, 15]);
export const XAI_VIDEO = Object.freeze({
  'grok-imagine-video-1.5-lite': Object.freeze({ label: 'Grok Imagine 1.5 Lite', usdPerSecond: 0.02 }),
  'grok-imagine-video-1.5': Object.freeze({ label: 'Grok Imagine 1.5', usdPerSecond: 0.08 }),
});
// Entries for app.js VIDEO_MODELS (after the Runway ones). auto:false — Auto never picks them; only the menu does.
export const XAI_VIDEO_MODELS = Object.freeze([
  Object.freeze({ id: 'xai:grok-imagine-video-1.5-lite', label: 'Grok Imagine 1.5 Lite · xAI', xai: 'grok-imagine-video-1.5-lite', auto: false, note: 'Grok Imagine 1.5 Lite ≈ $0.02/sec with sound · text or image → video' }),
  Object.freeze({ id: 'xai:grok-imagine-video-1.5', label: 'Grok Imagine 1.5 · xAI', xai: 'grok-imagine-video-1.5', auto: false, note: 'Grok Imagine 1.5 ≈ $0.08/sec with sound · text or image → video' }),
]);
export const XAI_TIMING = { poll: 5000, request: 30_000, start: 60_000, download: 5 * 60_000, total: 20 * 60_000, failures: 8, notReady: 6 };

const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const abortError = () => new DOMException('Aborted', 'AbortError');
const usd$ = (n) => `$${n.toFixed(2)}`;

export const isXaiVideo = (id) => typeof id === 'string' && XAI_VIDEO_MODELS.some((m) => m.id === id);
/** A length Grok Imagine takes from the menu: one of XAI_SECONDS (the nearest at or below, else 6). */
export function xaiSeconds(secs) {
  const s = Math.round(Number(secs));
  if (XAI_SECONDS.includes(s)) return s;
  return [...XAI_SECONDS].reverse().find((x) => x <= s) ?? 6;
}
/** USD for `seconds` of `model` by xAI's price list, or null. */
export function xaiQuote(model, seconds) {
  const m = XAI_VIDEO[model];
  if (!Object.hasOwn(XAI_VIDEO, model) || !(Number(seconds) > 0)) return null;
  return Math.round(Math.ceil(Number(seconds)) * m.usdPerSecond * 1e4) / 1e4;
}
// The Video-mode options strip note: 'Grok Imagine 1.5 Lite · 6 s ≈ $0.12 · 720p'.
export function xaiOptNote(entry, { secs, aspect } = {}) {
  const model = entry?.xai;
  if (!Object.hasOwn(XAI_VIDEO, model ?? '')) return '';
  const s = xaiSeconds(secs), q = xaiQuote(model, s);
  return `${XAI_VIDEO[model].label} · ${s} s ≈ ${usd$(q)} · ${aspect === '16:9hd' ? '1080p' : '720p'}`;
}
/** Video-mode params + an optional still → the body for POST /api/xai/video/start. */
export function xaiVideoRequest({ model, prompt, still = null, params = {} } = {}) {
  if (!Object.hasOwn(XAI_VIDEO, model ?? '')) throw fail(400, 'That Grok Imagine model isn’t available in Atelier.');
  const p = String(prompt ?? '').trim().slice(0, 4000);
  if (!p && !still) throw fail(400, 'Describe the video you want Grok to make.');
  const body = { model, seconds: xaiSeconds(params.secs), resolution: params.aspect === '16:9hd' ? '1080p' : '720p', aspect: params.aspect === '9:16' ? '9:16' : '16:9' };
  if (p) body.prompt = p;
  if (still) {
    if (typeof still !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/.test(still)) throw fail(400, 'Grok Imagine takes PNG, JPEG or WebP images.');
    body.image = still;
  }
  return body;
}
/** Image mode → the body for POST /api/xai/image. */
export const xaiImageRequest = (prompt, aspect) => ({ model: XAI_IMAGE_MODEL.model, prompt: String(prompt ?? '').trim(), aspect: XAI_IMAGE_ASPECT[aspect] || '1:1' });

// ── talking to /api/xai/* ──
const headersFor = (apiHeaders, json) => {
  const h = new Headers(typeof apiHeaders === 'function' ? apiHeaders() : apiHeaders || {});
  if (json) h.set('content-type', 'application/json'); else h.delete('content-type');
  return h;
};
async function send(deps, path, { method = 'GET', body, timeout = XAI_TIMING.request } = {}) {
  const f = deps.fetch || globalThis.fetch;
  const ctrl = new AbortController(), outer = deps.signal;
  let late = false;
  const timer = setTimeout(() => { late = true; ctrl.abort(); }, timeout);
  const ab = () => ctrl.abort();
  if (outer?.aborted) { clearTimeout(timer); throw abortError(); }
  outer?.addEventListener('abort', ab, { once: true });
  try {
    return await f(`/api/xai/${path}`, { method, signal: ctrl.signal, headers: headersFor(deps.apiHeaders, body !== undefined), body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (err) {
    if (outer?.aborted && !late) throw abortError();
    throw fail(0, late ? 'Atelier took too long to answer — check your connection.' : 'Couldn’t reach Atelier — the connection dropped.', { late });
  } finally { clearTimeout(timer); outer?.removeEventListener('abort', ab); }
}
const readJson = async (r) => { try { const j = await r.json(); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; } catch { return {}; } };
function errorFrom(r, j, fallback) {
  const ra = Number(r.headers?.get?.('retry-after'));
  return fail(r.status, typeof j.error === 'string' && j.error ? j.error.slice(0, 400) : fallback, { ...(typeof j.code === 'string' ? { code: j.code } : {}), ...(ra > 0 ? { retryAfter: ra } : {}) });
}
const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** POST /api/xai/image → [{src}] (data: URLs). */
export async function xaiImage(body, { apiHeaders, signal, fetch: f } = {}) {
  const r = await send({ apiHeaders, signal, fetch: f }, 'image', { method: 'POST', body, timeout: 120_000 });
  const j = await readJson(r);
  if (!r.ok) throw errorFrom(r, j, `The Grok image request failed (${r.status}).`);
  const out = (Array.isArray(j.data) ? j.data : []).filter((d) => typeof d?.b64_json === 'string' && d.b64_json)
    .map((d) => ({ src: `data:${/^image\/(png|jpeg|webp)$/.test(d.mime_type || '') ? d.mime_type : 'image/jpeg'};base64,${d.b64_json}` }));
  if (!out.length) throw fail(500, 'Grok returned no image.');
  return out;
}

const sleepFor = (ms, signal) => new Promise((res, rej) => {
  if (signal?.aborted) return rej(abortError());
  const ab = () => { clearTimeout(t); rej(abortError()); };
  const t = setTimeout(() => { signal?.removeEventListener('abort', ab); res(); }, ms);
  signal?.addEventListener('abort', ab, { once: true });
});
const transient = (s) => s === 0 || s === 408 || s === 429 || s >= 500;

/**
 * The whole video job: start (or resume `resume`, an earlier request id) → poll → download → {id, blob, seconds, usd}.
 * onId(id): the video exists (app.js keeps it on the entry, so Try again resumes instead of paying twice). xAI has no
 * cancel: Stop only stops waiting (the video may still be made and billed), and Try again picks it up.
 */
export async function xaiVideo(body, { apiHeaders, signal, onStatus, onId, resume = null, fetch: f, sleep = sleepFor, now = Date.now } = {}) {
  const deps = { apiHeaders, signal, fetch: f };
  const say = (t) => { try { onStatus?.(t); } catch {} };
  let id = typeof resume === 'string' && ID.test(resume) ? resume : null, seconds = body?.seconds ?? null, quote = null;
  try {
    if (!id) {
      say('Sending to xAI');
      let r;
      try { r = await send({ ...deps, signal: null }, 'video/start', { method: 'POST', body, timeout: XAI_TIMING.start }); } // never cut short: it may already bill
      catch { throw fail(0, 'xAI didn’t confirm the new video — it may have started anyway. Check usage at console.x.ai before trying again.', { code: 'xai_unconfirmed' }); }
      const j = await readJson(r);
      if (!r.ok) throw errorFrom(r, j, `The Grok video request failed (${r.status}).`);
      if (!ID.test(j.id || '')) throw fail(502, 'xAI answered without a video id.', { code: 'xai_unconfirmed' });
      id = j.id; seconds = Number.isInteger(j.seconds) ? j.seconds : seconds; quote = typeof j.quote === 'number' ? j.quote : null;
      try { onId?.(id); } catch {}
      if (signal?.aborted) throw abortError();
    } else say('Checking on the earlier Grok video');
    const end = now() + XAI_TIMING.total;
    let failures = 0, first = Boolean(resume), s;
    for (;;) {
      if (!first) await sleep(Math.max(XAI_TIMING.poll, failures ? Math.min(60_000, XAI_TIMING.poll * 2 ** failures) : 0), signal);
      first = false;
      if (now() > end) throw fail(504, 'Grok is still working on this after 20 minutes — tap Try again to keep waiting (it won’t start a new video).', { code: 'xai_slow', resumable: true });
      let r;
      try {
        r = await send(deps, `video/status/${encodeURIComponent(id)}`);
        s = await readJson(r);
        if (!r.ok) throw errorFrom(r, s, `Checking the Grok video failed (${r.status}).`);
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        if (!transient(err.status) || ++failures > XAI_TIMING.failures) throw Object.assign(err, { resumable: transient(err.status) });
        continue;
      }
      failures = 0;
      if (!s.done) { say(Number.isInteger(s.progress) && s.progress > 0 ? `Filming with Grok · ${s.progress}%` : 'Filming with Grok'); continue; }
      if (s.video) break;
      throw fail(s.filtered ? 400 : 500, s.error || 'Grok couldn’t make this video.', { code: s.filtered ? 'xai_filtered' : 'xai_failed' });
    }
    say('Downloading');
    for (let tries = 0; ; tries++) {
      const r = await send(deps, `video/file/${encodeURIComponent(id)}`, { timeout: XAI_TIMING.download });
      if (!r.ok) {
        const err = errorFrom(r, await readJson(r), `Downloading the Grok video failed (${r.status}).`);
        if (err.code === 'xai_not_ready' && tries < XAI_TIMING.notReady) { await sleep(XAI_TIMING.poll, signal); continue; }
        throw Object.assign(err, { resumable: err.status !== 404 && err.code !== 'xai_too_large' });
      }
      let blob;
      try { blob = await r.blob(); } catch { throw fail(0, 'The Grok video download dropped — tap Try again (it won’t make a new video).', { resumable: true }); }
      if (!blob.size) throw fail(502, 'xAI sent back an empty video — try again.', { resumable: true });
      const paid = Number(r.headers.get('x-xai-usd'));
      return { id, blob: /^video\/(mp4|webm)$/.test(blob.type) ? blob : new Blob([blob], { type: 'video/mp4' }), seconds: s.seconds || seconds, usd: Number.isFinite(paid) && paid >= 0 ? paid : (typeof s.usd === 'number' ? s.usd : quote) };
    }
  } catch (err) {
    if (err?.name === 'AbortError' && id) err.resumable = true; // xAI has no cancel: Try again checks on it
    if (id && err && typeof err === 'object' && !err.id) err.id = id;
    throw err;
  }
}
