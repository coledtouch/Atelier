// Owner spending limits (Settings → Spending): a per-video limit and a monthly limit on paid video and images combined,
// checked in the Worker BEFORE any paid owner video or image job reaches a provider. Testers never come here: they are
// metered by the Ledger's tester allowance (src/tester/router.js), and every /api/owner/* path answers them 403
// owner_only (deny by default).
//
// What counts (the owner's own keys; free NVIDIA FLUX / Cosmos and the motion still never do):
//   video  Runway (every model: Gen-4.5, Gen-4 Turbo, Aleph, Veo 3.1, Grok Imagine, Seedance 2.5; src/runway.js),
//          Gemini Omni (src/omni.js), Grok Imagine video direct (src/xai.js) → the per-video limit AND the month
//   image  GPT Image, Nano Banana, Muse (the /api/x/* image passthrough, worker.js) and Grok Imagine images (src/xai.js)
//          → the month only
//
// Storage
//   Limits: the Ledger's config row 'owner_limits' {perVideoUsd, monthlyMediaUsd, updatedAt}; $25 and $200 when unset.
//     Written only by PUT /api/owner/limits, read on every paid start. The Ledger is strongly consistent, so a change
//     applies at once on every device (a KV write can take up to a minute to show in other locations).
//   Spend: the Ledger Durable Object (src/tester/ledger.js, the one "main" instance, SQLite), table owner_spend: one row
//     per paid job {id, month (UTC YYYY-MM of the start), provider, kind, model, amount (the quote), actual (null while
//     the job runs), job ('runway:<task>' | 'omni:<id>' | 'xai:<id>')}. A month's spend is the sum of actual (settled)
//     or amount (still running) over its rows.
//   Why not KV for the spend: KV has no atomic increment or compare-and-swap, a write can take up to a minute to show
//     in other locations, and it takes one write a second per key. Video Remix films several shots at once and the
//     owner may send from two devices: concurrent read-modify-writes of owner:spend:YYYY-MM would both pass the check
//     (going over the limit) and then overwrite each other's update (losing spend for good). The Ledger runs every
//     check-and-hold in one transactionSync, so concurrent starts are serialised and none can push the month past the
//     limit; it already exists, so this needs no new binding or migration.
//
// A paid job's life (micro-dollars, integers, like the tester Ledger)
//   1. quote with the existing price functions (Runway's list, prices.js veoCost / imageCost, xAI's list)
//   2. start(): over the per-video limit → 402 owner_cap_video; this month's spend + the quote over the monthly limit →
//      402 owner_cap_month. Nothing is sent to the provider. Otherwise a hold at the quote is written atomically.
//   3. the provider answers: a refusal (an HTTP error) → the hold settles to $0; no answer at all, or a gateway's 502,
//      504 or 52x (it may have started) → it settles at the quote; accepted → the hold is tied to the provider's job id
//      (attach).
//   4. the job finishes (the status poll, or the download): settle to what the provider reports (Runway cost.credits,
//      Omni usage, xAI cost_in_usd_ticks, image usage), else the quote. Failed or filtered → $0, unless the provider
//      reports a charge (Runway bills some failures). Settling is once per row: a resumed poll, a second device or a
//      repeat download finds the row settled and changes nothing (no double count).
// Runway's RUNWAY_MAX_CREDITS stays a separate hard backstop in src/runway.js.
import { PRICES, imageCost, imageActual, gptImageOutputTokens, OPENAI_EDIT_IMAGE_TOKENS } from './tester/prices.js';
import { ledger } from './tester/auth.js';

export const DEFAULT_LIMITS = Object.freeze({ perVideoUsd: 25, monthlyMediaUsd: 200 });
// What the owner can set (dollars, to the cent). Above these is a typo, not a budget: one Runway video costs at most
// $20.40 (Seedance 2.5, 30 s, 1080p). 0 turns paid video (or all paid media) off.
export const LIMIT_BOUNDS = Object.freeze({ perVideoUsd: Object.freeze([0, 500]), monthlyMediaUsd: Object.freeze([0, 5000]) });
export const CAP_CODES = Object.freeze({ video: 'owner_cap_video', month: 'owner_cap_month' });
export const CAP_STATUS = 402;
const MICROS = 1_000_000;
const PROVIDER_NAMES = Object.freeze({ runway: 'Runway', omni: 'Google', gemini: 'Google', openai: 'OpenAI', meta: 'Meta', xai: 'xAI' });
export const IMAGE_BODY_MAX = 40 * 1024 * 1024; // an owner image request (an edit carries one base64 photo of ≤ ~4 MB)

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
const isRecord = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const utf8 = (s) => new TextEncoder().encode(String(s ?? '')).length;

/** A refusal with its HTTP status and JSON body; src/runway.js, src/omni.js, src/xai.js and worker.js answer with it as is. */
export class SpendError extends Error {
  constructor(status, body) {
    super(body?.error || 'Spending limit');
    this.name = 'SpendError';
    this.status = status;
    this.body = body;
  }
}
export const spendResponse = (err) => json(err.body, err.status);
/**
 * A provider's answer to a create that can't rule out that the job started: a gateway in front of it got no complete
 * answer from the origin (502, 504, Cloudflare's 520–530). Such a hold settles at its quote, like no answer at all;
 * the provider's own refusals (4xx, a 500 or 503 from the service) settle to $0. public/remix-shots.js treats the same
 * statuses from the Worker as "it may have started".
 */
export const isGatewayStatus = (s) => s === 502 || s === 504 || (s >= 520 && s <= 530);

// ── money and months ──
export const toMicros = (usd) => Math.round(Number(usd) * MICROS);
export const toUsd = (micros) => Math.round(Number(micros) / 100) / 10_000; // 4 decimals: what the APIs report
const dollars = (micros) => `$${(Math.max(0, Number(micros) || 0) / MICROS).toFixed(2)}`;
export const monthOf = (t = Date.now()) => new Date(t).toISOString().slice(0, 7);
/** When a UTC month's spend resets: 00:00 UTC on the 1st of the next month (ISO). */
export function resetsAt(month = monthOf()) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString();
}
const resetDay = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

// ── limits ──
const inBounds = (k, v) => typeof v === 'number' && Number.isFinite(v) && v >= LIMIT_BOUNDS[k][0] && v <= LIMIT_BOUNDS[k][1];
const cents = (v) => Math.round(v * 100) / 100;
/** Whatever KV holds → limits that are always usable (anything missing or out of range → its default). */
export function normalizeLimits(raw) {
  const r = isRecord(raw) ? raw : {};
  const out = {};
  for (const k of Object.keys(DEFAULT_LIMITS)) out[k] = inBounds(k, r[k]) ? cents(r[k]) : DEFAULT_LIMITS[k];
  if (out.perVideoUsd > out.monthlyMediaUsd) out.perVideoUsd = out.monthlyMediaUsd;
  return { ...out, updatedAt: Number.isSafeInteger(r.updatedAt) && r.updatedAt > 0 ? r.updatedAt : null };
}
// The limits live in the Ledger (config 'owner_limits'), not KV: a KV write can take up to a minute to reach other
// locations, so a raised limit could still refuse (or a lowered one still allow) a start made from another device.
export async function readLimits(env) {
  const stub = ledger(env);
  if (!stub) return normalizeLimits(null); // no Ledger: paid starts are refused anyway (owner_cap_unavailable)
  try { return normalizeLimits(await stub.ownerLimits()); }
  catch { return normalizeLimits(null); } // unreadable: the defaults still guard the spend
}
const LIMIT_NAMES = { perVideoUsd: 'The per-video limit', monthlyMediaUsd: 'The monthly limit' };
/**
 * A PUT body ({perVideoUsd?, monthlyMediaUsd?}, dollars) merged over the current limits → {ok: true, limits, clamped}
 * | {ok: false, error, field}. Only finite numbers within LIMIT_BOUNDS; amounts are kept to the cent; a per-video limit
 * above the monthly one is clamped down to it (one video can never spend more than the month allows).
 */
export function cleanLimits(input, current = DEFAULT_LIMITS) {
  if (!isRecord(input)) return { ok: false, error: 'Send the limits as a JSON object.' };
  const keys = Object.keys(input);
  const unknown = keys.find((k) => !Object.hasOwn(DEFAULT_LIMITS, k));
  if (unknown !== undefined) return { ok: false, error: `Unknown setting “${String(unknown).slice(0, 40)}”.`, field: null };
  if (!keys.length) return { ok: false, error: 'Send perVideoUsd, monthlyMediaUsd or both.' };
  const out = { perVideoUsd: current.perVideoUsd, monthlyMediaUsd: current.monthlyMediaUsd };
  for (const k of keys) {
    const v = input[k], [lo, hi] = LIMIT_BOUNDS[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, error: `${LIMIT_NAMES[k]} must be a dollar amount.`, field: k };
    if (v < lo) return { ok: false, error: `${LIMIT_NAMES[k]} can’t be negative.`, field: k };
    if (v > hi) return { ok: false, error: `${LIMIT_NAMES[k]} can be at most $${hi.toLocaleString('en-US')}.`, field: k };
    out[k] = cents(v);
  }
  let clamped = false;
  if (out.perVideoUsd > out.monthlyMediaUsd) { out.perVideoUsd = out.monthlyMediaUsd; clamped = true; }
  return { ok: true, limits: out, clamped };
}

// ── the decision ──
/**
 * One job's quote against the limits → {ok: true} | {ok: false, limit: 'video' | 'month'}. Equal to a limit is allowed;
 * a single micro-dollar over is not. kind 'video' is held to both limits, 'image' to the month only. spent: this
 * month's recorded spend (settled plus running holds) before this job.
 */
export function decide({ amount, kind, limits, spent = 0 }) {
  if (!Number.isSafeInteger(amount) || amount < 0) return { ok: false, limit: kind === 'video' ? 'video' : 'month' }; // unpriceable: never sent
  if (kind === 'video' && amount > toMicros(limits.perVideoUsd)) return { ok: false, limit: 'video' };
  if (Number(spent) + amount > toMicros(limits.monthlyMediaUsd)) return { ok: false, limit: 'month' };
  return { ok: true };
}

/** The 402 a refused start answers with (worded for people; app.js shows it on the error card). */
export function capRefusal({ limit, amount, limits, spent = 0, month = monthOf(), provider, kind = 'video' }) {
  const who = PROVIDER_NAMES[provider] || 'the provider', at = resetsAt(month);
  const noun = kind === 'video' ? 'video' : 'image request';
  const error = limit === 'video'
    ? `This ${noun} would cost about ${dollars(amount)}, over your ${dollars(toMicros(limits.perVideoUsd))} limit per video. Nothing was sent to ${who}. Change it in Settings → Spending.`
    : `This ${noun} (about ${dollars(amount)}) would bring this month’s video and image spending to ${dollars(spent + amount)}, over your ${dollars(toMicros(limits.monthlyMediaUsd))} monthly limit (${dollars(spent)} used, resets ${resetDay(at)}). Nothing was sent to ${who}. Change it in Settings → Spending.`;
  return new SpendError(CAP_STATUS, {
    error, code: limit === 'video' ? CAP_CODES.video : CAP_CODES.month, limit, provider: provider || null, kind,
    costUsd: toUsd(amount), perVideoUsd: limits.perVideoUsd, monthlyMediaUsd: limits.monthlyMediaUsd, spentUsd: toUsd(spent),
    leftUsd: toUsd(Math.max(0, toMicros(limits.monthlyMediaUsd) - spent)), month, resetsAt: at,
  });
}
const unavailable = () => new SpendError(503, { error: 'Your spending limits can’t be checked on this server right now (no Ledger), so paid video and images are paused.', code: 'owner_cap_unavailable' });

// ── the meter the paid routes use ──
/**
 * ownerSpend(env) → {start, settleJob}. start({provider, kind, model, amount}) checks the limits and holds the quote
 * (throws SpendError when refused) → a hold {id, amount, attach(job), resize(amount), settle(actual), release()}.
 * settleJob(job, actual) settles a running job by its provider id. actual: micro-dollars, or null for "the quote".
 * Bookkeeping after the start never fails the owner's request: a failed settle leaves the hold at its quote.
 */
export function ownerSpend(env) {
  const stub = ledger(env);
  const quiet = async (what, fn) => { try { return await fn(); } catch (err) { console.warn('owner spend', what, 'failed', String(err?.name || 'Error').slice(0, 40)); return null; } };
  return {
    async start({ provider, kind, model = '', amount }) {
      if (!Number.isSafeInteger(amount) || amount < 0) throw new SpendError(400, { error: 'Atelier couldn’t price this job, so it wasn’t sent: your spending limits need a price for every paid video and image.', code: 'owner_cap_unpriced' });
      if (!stub) throw unavailable();
      const limits = await readLimits(env);
      const pre = decide({ amount, kind, limits, spent: 0 });
      if (!pre.ok && pre.limit === 'video') throw capRefusal({ limit: 'video', amount, limits, provider, kind });
      const r = await stub.ownerReserve({ provider, kind, model: String(model).slice(0, 120), amount, monthly: toMicros(limits.monthlyMediaUsd) });
      if (!r?.ok) throw capRefusal({ limit: 'month', amount, limits, spent: r?.spent ?? 0, month: r?.month, provider, kind });
      const hold = {
        id: r.id, amount, month: r.month, limits,
        attach: (job) => quiet('attach', () => stub.ownerAttach(r.id, job)),
        // A new quote for the running hold (Runway's own estimate, Omni without a duration): a larger one must still fit
        // both limits → {ok: true} | {ok: false, error: SpendError}.
        async resize(next) {
          if (kind === 'video' && next > toMicros(limits.perVideoUsd)) return { ok: false, error: capRefusal({ limit: 'video', amount: next, limits, provider, kind }) };
          const z = await quiet('resize', () => stub.ownerResize(r.id, next, toMicros(limits.monthlyMediaUsd)));
          if (z?.ok) { hold.amount = next; return { ok: true }; }
          if (z && z.scope === 'month') return { ok: false, error: capRefusal({ limit: 'month', amount: next, limits, spent: Math.max(0, z.spent - hold.amount), month: r.month, provider, kind }) };
          return { ok: true }; // bookkeeping trouble: the hold keeps its first quote and the job goes on
        },
        settle: (actual = null) => quiet('settle', () => stub.ownerSettle(r.id, actual)),
        release: () => quiet('settle', () => stub.ownerSettle(r.id, 0)),
      };
      return hold;
    },
    settleJob: (job, actual = null) => (stub ? quiet('settle', () => stub.ownerSettle(job, actual)) : null),
  };
}

// ── image quotes for the /api/x/* passthrough (owner) ──
const unpriced = (why) => new SpendError(400, { error: `Atelier can’t price this image request (${why}), so it wasn’t sent: your spending limits need a price for every paid image.`, code: 'owner_cap_unpriced' });
const countOf = (v, max = 10) => { const n = v == null ? 1 : v; if (!Number.isInteger(n) || n < 1 || n > max) throw unpriced(`n must be 1 to ${max}`); return n; };
const promptTokens = (text) => Math.ceil(utf8(text) / 3);
// GPT Image 2.5 with size 'auto' (or a custom size): priced as the largest output it makes (8.29 MP, 3840×2160).
const OPENAI_AUTO_SIZE = Object.freeze([3840, 2160]);
const GEMINI_IMAGE = /^v1(?:beta)?\/models\/([\w.-]+):generateContent$/;

/**
 * An owner image request on the passthrough (provider, the allow-listed sub-path, the parsed JSON body) → {model, amount,
 * n} with amount in micro-dollars from prices.js (no margin). 'auto' or missing quality/size is priced at the dearest
 * the model makes. Throws SpendError 400 owner_cap_unpriced for anything without a price (it is never sent).
 */
export function imageQuote(provider, sub, body) {
  if (!isRecord(body)) throw unpriced('the body isn’t JSON');
  if (provider === 'openai') {
    const model = `openai:${body.model}`, e = typeof body.model === 'string' ? PRICES[model] : null;
    if (!e || e.kind !== 'image') throw unpriced(`no price for “${String(body.model).replace(/[^\w.:-]/g, '').slice(0, 40)}”`);
    const n = countOf(body.n);
    const quality = e.qualities.includes(body.quality) ? body.quality : e.qualities.at(-1);
    const refs = sub === 'images/edits' ? (Array.isArray(body.images) ? body.images.length : body.image ? 1 : 0) : 0;
    const partial = Number.isInteger(body.partial_images) && body.partial_images > 0 ? Math.min(body.partial_images, 3) : 0;
    const tokens = promptTokens(body.prompt);
    if (e.sizes.includes(body.size)) return { model, n, amount: imageCost({ model, n, size: body.size, quality, promptTokens: tokens, inputImages: refs, partialImages: partial, margin: false }) };
    const [w, h] = OPENAI_AUTO_SIZE, out = gptImageOutputTokens(w, h, quality) + 100 * partial;
    return { model, n, amount: Math.ceil(tokens * e.textInput + refs * OPENAI_EDIT_IMAGE_TOKENS * e.imageInput + n * out * e.imageOutput) };
  }
  if (provider === 'meta') {
    const model = `meta:${body.model}`, e = typeof body.model === 'string' ? PRICES[model] : null;
    if (!e || e.kind !== 'image') throw unpriced(`no price for “${String(body.model).replace(/[^\w.:-]/g, '').slice(0, 40)}”`);
    const n = countOf(body.n);
    return { model, n, amount: imageCost({ model, n, margin: false }) };
  }
  if (provider === 'gemini') {
    const id = String(sub).match(GEMINI_IMAGE)?.[1], model = `gemini:${id}`, e = id ? PRICES[model] : null;
    if (!e || e.kind !== 'image') throw unpriced(`${id ? `“${id.slice(0, 40)}”` : 'that model'} isn’t a priced image model`);
    const g = isRecord(body.generationConfig) ? body.generationConfig : {};
    const n = countOf(g.candidateCount, 4);
    const asked = g.imageConfig?.imageSize, sizes = Object.keys(e.imageTokens);
    const size = asked == null ? '1K' : sizes.includes(asked) ? asked : sizes.at(-1); // Google's default is 1K
    let text = '', refs = 0;
    for (const turn of Array.isArray(body.contents) ? body.contents : []) {
      for (const p of Array.isArray(turn?.parts) ? turn.parts : []) {
        if (typeof p?.text === 'string') text += p.text;
        else if (p?.inline_data || p?.inlineData) refs++;
      }
    }
    return { model, n, amount: imageCost({ model, n, size, promptTokens: promptTokens(text), inputImages: refs, margin: false }) };
  }
  throw unpriced('unknown provider');
}

/**
 * A finished image answer (provider, the parsed JSON, the quote) → what it cost in micro-dollars, or null for "the
 * quote" (an answer with an image but no usage). An answer without an image and without usage costs $0.
 */
export function imageSettle(provider, j, q) {
  const has = provider === 'gemini'
    ? (j?.candidates || []).some((c) => (c?.content?.parts || []).some((p) => p?.inlineData || p?.inline_data))
    : Array.isArray(j?.data) && j.data.length > 0;
  try {
    if (provider === 'meta') return has ? imageActual({ model: q.model, n: j.data.length }) : 0; // $0.01 per image made
    if (provider === 'openai' && isRecord(j?.usage)) return imageActual({ model: q.model, usage: j.usage });
    if (provider === 'gemini' && isRecord(j?.usageMetadata)) return imageActual({ model: q.model, usage: j.usageMetadata });
  } catch {}
  return has ? null : 0;
}

// ── /api/owner/limits, /api/owner/spend (owner passcode only; worker.js checks it) ──
async function readSmall(req, cap = 4096) {
  if (Number(req.headers.get('content-length') || 0) > cap) return null;
  const t = await req.text().catch(() => '');
  return t.length > cap ? null : t;
}
const limitsView = (l) => ({ perVideoUsd: l.perVideoUsd, monthlyMediaUsd: l.monthlyMediaUsd, updatedAt: l.updatedAt ?? null, defaults: DEFAULT_LIMITS, bounds: LIMIT_BOUNDS });

/** This month's spend (or ?month=YYYY-MM) with the limits → the GET /api/owner/spend body. */
export async function spendSummary(env, month = monthOf()) {
  const stub = ledger(env);
  if (!stub) throw unavailable();
  const [limits, s] = await Promise.all([readLimits(env), stub.ownerSpend(month)]);
  const total = Number(s?.total) || 0, held = Number(s?.held) || 0;
  return {
    month, resetsAt: resetsAt(month), limits: { perVideoUsd: limits.perVideoUsd, monthlyMediaUsd: limits.monthlyMediaUsd },
    totalUsd: toUsd(total), settledUsd: toUsd(total - held), heldUsd: toUsd(held), leftUsd: toUsd(Math.max(0, toMicros(limits.monthlyMediaUsd) - total)),
    jobs: Number(s?.jobs) || 0,
    byProvider: (Array.isArray(s?.byProvider) ? s.byProvider : []).map((x) => ({ provider: x.provider, kind: x.kind, usd: toUsd(x.total), heldUsd: toUsd(x.held), jobs: x.jobs })),
  };
}

/** /api/owner/* → GET/PUT owner/limits, GET owner/spend. The caller has already checked the owner passcode. */
export async function handleOwnerApi(req, env, url, path) {
  try {
    if (path === 'owner/limits') {
      if (req.method === 'GET') return json(limitsView(await readLimits(env)));
      if (req.method !== 'PUT') return json({ error: 'Use GET or PUT.' }, 405, { allow: 'GET, PUT' });
      const text = await readSmall(req);
      if (text == null) return json({ error: 'Request too large.', code: 'owner_limits_input' }, 413);
      let body = null;
      try { body = JSON.parse(text); } catch {}
      const r = cleanLimits(body, await readLimits(env));
      if (!r.ok) return json({ error: r.error, code: 'owner_limits_input', ...(r.field ? { field: r.field } : {}) }, 400);
      const stub = ledger(env);
      if (!stub) throw unavailable();
      const saved = { ...r.limits, updatedAt: Date.now() };
      await stub.ownerSetLimits(saved);
      return json({ ok: true, ...limitsView(saved), ...(r.clamped ? { clamped: true } : {}) });
    }
    if (path === 'owner/spend') {
      if (req.method !== 'GET') return json({ error: 'Use GET.' }, 405, { allow: 'GET' });
      const m = url.searchParams.get('month');
      if (m != null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) return json({ error: 'month must be YYYY-MM.', code: 'owner_limits_input' }, 400);
      return json(await spendSummary(env, m || monthOf()));
    }
    return json({ error: 'Not found' }, 404);
  } catch (err) {
    if (err instanceof SpendError) return spendResponse(err);
    throw err;
  }
}
