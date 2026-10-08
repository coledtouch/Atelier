// Owner spending limits (Settings → Spending): the client half of src/spend.js. Pure helpers (node-tested in
// tests/spend-client.test.mjs) plus the two calls the Spending panel makes; nothing touches the DOM at import time.
// The Worker is the only judge: it refuses an over-limit video or image before the provider is called (402
// owner_cap_video / owner_cap_month). These helpers only word that refusal, and warn in the cost note before a send.
// Testers never see any of it: their allowance has its own UI, and /api/owner/* answers them 403.

export const CAP_CODES = Object.freeze({ video: 'owner_cap_video', month: 'owner_cap_month' });
export const DEFAULT_LIMITS = Object.freeze({ perVideoUsd: 25, monthlyMediaUsd: 200 });
export const LIMIT_BOUNDS = Object.freeze({ perVideoUsd: Object.freeze([0, 500]), monthlyMediaUsd: Object.freeze([0, 5000]) }); // src/spend.js keeps the same
/** A refusal of the owner's spending limits (any owner_cap_* code): never a provider problem, never a fallback. */
export const isCapCode = (code) => typeof code === 'string' && code.startsWith('owner_cap_');
/** owner_cap_video → 'video', owner_cap_month → 'month', else null. */
export const capLimitOf = (code) => (code === CAP_CODES.video ? 'video' : code === CAP_CODES.month ? 'month' : null);

/** 00:00 UTC on the 1st of next month (ms): when the monthly spend starts again from $0. */
export function nextMonthUtc(now = Date.now()) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}
/** $ for display: two decimals; spend rounds UP (never shows less than was used), what's left rounds down. */
export function usd(v, { up = false } = {}) {
  const c = Math.max(0, (up ? Math.ceil : Math.floor)(Math.max(0, Number(v) || 0) * 100 - 1e-6 * (up ? 1 : -1))) || 0; // never "-0"
  return `$${Math.floor(c / 100).toLocaleString('en-US')}.${String(c % 100).padStart(2, '0')}`;
}
/** The day the month's spend resets, as the Worker counts it (00:00 UTC on the 1st): 'Sun, Nov 1'. */
export const resetDay = (ms) => (Number.isFinite(ms) ? new Date(ms).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }) : '');

/** The error card's title for a refused job (e.cap.limit). */
export const capTitle = (limit) => (limit === 'video' ? 'Over your per-video limit' : limit === 'month' ? 'Over this month’s spending limit' : 'Over your spending limit');
/** A thread entry's saved e.cap ({limit, resetsAt}) as it may be rendered (backups are untrusted). null if malformed. */
export function cleanCap(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c) || !['video', 'month'].includes(c.limit)) return null;
  if (Object.keys(c).some((k) => k !== 'limit' && k !== 'resetsAt')) return null;
  if (c.resetsAt != null && !(Number.isFinite(c.resetsAt) && c.resetsAt > 0 && c.resetsAt <= 8.64e15)) return null;
  return { limit: c.limit, ...(c.resetsAt != null ? { resetsAt: c.resetsAt } : {}) };
}
/** A refused job's error → what the entry keeps (e.cap): which limit, and when the month resets (month only). */
export function capOf(err, now = Date.now()) {
  const limit = capLimitOf(err?.code);
  if (!limit) return null;
  const at = typeof err.resetsAt === 'string' ? Date.parse(err.resetsAt) : Number(err.resetsAt);
  return { limit, ...(limit === 'month' ? { resetsAt: Number.isFinite(at) && at > now ? at : nextMonthUtc(now) } : {}) };
}

// ── the cost note's warning (Video and Image mode, owner only) ──
// Image prices as the owner's requests are made (src/spend.js imageQuote, prices.js, no margin), rounded up a little:
// a warning should come a bit early, never late. tests/spend-client.test.mjs checks each is at least the Worker's quote.
export const IMAGE_USD = Object.freeze({
  'openai:gpt-image-2.5-flare': 0.07, // high quality, any of Image mode's sizes
  'gemini:gemini-3-pro-image': 0.25, // 2K + the thinking allowance
  'gemini:gemini-nano-banana-2.1': 0.13, // 2K + the thinking allowance
  'meta:muse-image-1.0': 0.01,
  'xai:grok-imagine-image-2.0': 0.04,
});
// A photo edit (Image mode with a photo attached): GPT Image's goes at size auto, priced as its largest output plus the
// photo's input tokens.
export const IMAGE_EDIT_USD = Object.freeze({ 'openai:gpt-image-2.5-flare': 0.55 });
/** What one image of model `id` is warned at (an edit when `edit`), or null for a free model. */
export const imageUsd = (id, { edit = false } = {}) => (edit && Object.hasOwn(IMAGE_EDIT_USD, id) ? IMAGE_EDIT_USD[id] : Object.hasOwn(IMAGE_USD, id) ? IMAGE_USD[id] : null);
/**
 * One send's cost (USD) against the limits and this month's spend (GET /api/owner/spend's body) → a short warning for
 * the cost note, or '' when it fits (or nothing is known yet). kind 'video' checks the per-video limit too. A video's
 * price is the Worker's own quote; an image's is the upper estimate above, so it only says it "may" go over.
 */
export function capWarning(costUsd, { kind = 'video', data = null } = {}) {
  const lim = data?.limits, cost = Number(costUsd);
  if (!lim || !(cost > 0)) return '';
  const per = Number(lim.perVideoUsd), month = Number(lim.monthlyMediaUsd), spent = Math.max(0, Number(data.totalUsd) || 0);
  if (kind === 'video' && Number.isFinite(per) && cost > per + 1e-9) return `over your ${usd(per)} per-video limit`;
  if (Number.isFinite(month) && spent + cost > month + 1e-9) {
    const left = Math.max(0, month - spent);
    if (left < 0.005) return `this month’s ${usd(month)} limit is used up`;
    return `${kind === 'video' ? 'over' : 'may go over'} this month’s limit · ${usd(left)} left`;
  }
  return '';
}

/**
 * A ×N image send where some requests were refused by the monthly limit (each image is its own request, so the ones
 * that fit are made) → the entry's note, or '' when nothing is missing.
 */
export function partialCapNote(made, asked) {
  const m = Math.max(0, Math.floor(Number(made) || 0)), a = Math.max(0, Math.floor(Number(asked) || 0));
  return m > 0 && m < a ? `${m} of ${a} made · the rest would go over this month’s spending limit` : '';
}

// ── Settings → Spending ──
/** A typed dollar amount ('$1,200.50', '25') → a number, or NaN. */
export function parseUsd(text) {
  const s = String(text ?? '').trim().replace(/^\$/, '').replace(/,/g, '').trim();
  return /^\d+(\.\d+)?$|^\.\d+$/.test(s) ? Number(s) : NaN;
}
/** The two fields as typed → PUT /api/owner/limits's body, or {error} (the Worker checks the same rules again). */
export function limitsBody({ perVideo, monthly }) {
  const out = {};
  for (const [k, raw, name] of [['perVideoUsd', perVideo, 'The per-video limit'], ['monthlyMediaUsd', monthly, 'The monthly limit']]) {
    const v = parseUsd(raw), [lo, hi] = LIMIT_BOUNDS[k];
    if (!Number.isFinite(v)) return { error: `${name} must be a dollar amount, like 25 or 200.` };
    if (v < lo || v > hi) return { error: `${name} must be from $${lo} to $${hi.toLocaleString('en-US')}.` };
    out[k] = Math.round(v * 100) / 100;
  }
  return { body: out };
}
const PROVIDER_LABEL = Object.freeze({ runway: 'Runway', omni: 'Gemini Omni', xai: 'Grok Imagine (xAI)', openai: 'GPT Image', gemini: 'Nano Banana', meta: 'Muse Image (Meta)' });
/** byProvider rows → [{label, usd, held, jobs}] for the breakdown list (unknown providers keep their own name). */
export function breakdownRows(data) {
  return (Array.isArray(data?.byProvider) ? data.byProvider : []).filter((x) => x && typeof x.provider === 'string')
    .map((x) => ({
      label: `${PROVIDER_LABEL[x.provider] || x.provider.slice(0, 30)} · ${x.kind === 'image' ? 'images' : 'video'}`,
      usd: Math.max(0, Number(x.usd) || 0), held: Math.max(0, Number(x.heldUsd) || 0), jobs: Math.max(0, Math.floor(Number(x.jobs) || 0)),
    }));
}

// ── talking to /api/owner/* ──
const headersFor = (apiHeaders) => new Headers(typeof apiHeaders === 'function' ? apiHeaders() : apiHeaders || {});
async function call(path, { apiHeaders, method = 'GET', body, signal, fetch: f = globalThis.fetch } = {}) {
  const r = await f(path, { method, signal, cache: 'no-store', headers: headersFor(apiHeaders), ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  let j = {};
  try { j = await r.json(); } catch {}
  if (!r.ok) throw Object.assign(new Error(typeof j?.error === 'string' && j.error ? j.error.slice(0, 300) : `Couldn’t load your spending (${r.status}).`), { status: r.status, code: j?.code });
  return j && typeof j === 'object' ? j : {};
}
/** GET /api/owner/spend → this month's spend, its breakdown and the limits. */
export const loadSpend = (opts = {}) => call('/api/owner/spend', opts);
/** PUT /api/owner/limits {perVideoUsd, monthlyMediaUsd} → the saved limits ({clamped: true} when per-video was lowered to the month). */
export const saveLimits = (body, opts = {}) => call('/api/owner/limits', { ...opts, method: 'PUT', body });
