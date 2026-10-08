// The owner's spend readout (Settings → Spending → This month's spend): what the owner's paid video and image jobs cost
// this month, recorded in the Worker and settled to what the provider reports. Since v85 there are no spending limits:
// nothing in this file refuses a job, and a job is never held back because its bookkeeping failed (no Ledger, an
// unpriceable request, a Ledger error). Testers never come here: they are metered by the Ledger's tester allowance
// (src/tester/router.js), and every /api/owner/* path answers them 403 owner_only (deny by default).
//
// What is recorded (the owner's own keys; free NVIDIA FLUX / Cosmos and the motion still never are):
//   video  Runway (every model: Gen-4.5, Gen-4 Turbo, Aleph, Veo 3.1, Grok Imagine, Seedance 2.5; src/runway.js),
//          Gemini Omni (src/omni.js), Grok Imagine video direct (src/xai.js)
//   image  GPT Image, Nano Banana, Muse (the /api/x/* image passthrough, worker.js) and Grok Imagine images (src/xai.js)
//
// Storage: the Ledger Durable Object (src/tester/ledger.js, the one "main" instance, SQLite), table owner_spend: one row
// per paid job {id, month (UTC YYYY-MM of the start), provider, kind, model, amount (the quote), actual (null while the
// job runs), job ('runway:<task>' | 'omni:<id>' | 'xai:<id>')}. A month's spend is the sum of actual (settled) or
// amount (still running) over its rows. The Ledger keeps the rows 13 months.
//
// A paid job's life (micro-dollars, integers, like the tester Ledger)
//   1. quote with the existing price functions (Runway's list, prices.js veoCost / imageCost, xAI's list); a request
//      Atelier can't price is recorded at $0 and settles to what the provider reports (or isn't recorded at all, for an
//      image request whose model has no price)
//   2. start(): a row at the quote, never a refusal
//   3. the provider answers: a refusal (an HTTP error) → the row settles to $0; no answer at all, or a gateway's 502,
//      504 or 52x (it may have started) → it settles at the quote; accepted → the row is tied to the provider's job id
//      (attach)
//   4. the job finishes (the status poll, or the download): settle to what the provider reports (Runway cost.credits,
//      Omni usage, xAI cost_in_usd_ticks, image usage), else the quote. Failed or filtered → $0, unless the provider
//      reports a charge (Runway bills some failures). Settling is once per row: a resumed poll, a second device or a
//      repeat download finds the row settled and changes nothing (no double count).
// Runway's RUNWAY_MAX_CREDITS (an optional Worker var, unset) stays a separate hard backstop in src/runway.js.
import { PRICES, imageCost, imageActual, gptImageOutputTokens, OPENAI_EDIT_IMAGE_TOKENS } from './tester/prices.js';
import { ledger } from './tester/auth.js';

const MICROS = 1_000_000;
export const IMAGE_BODY_MAX = 40 * 1024 * 1024; // an owner image request (an edit carries one base64 photo of ≤ ~4 MB)

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
const isRecord = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const utf8 = (s) => new TextEncoder().encode(String(s ?? '')).length;

/**
 * A provider's answer to a create that can't rule out that the job started: a gateway in front of it got no complete
 * answer from the origin (502, 504, Cloudflare's 520–530). Such a row settles at its quote, like no answer at all;
 * the provider's own refusals (4xx, a 500 or 503 from the service) settle to $0. public/remix-shots.js treats the same
 * statuses from the Worker as "it may have started".
 */
export const isGatewayStatus = (s) => s === 502 || s === 504 || (s >= 520 && s <= 530);

// ── money and months ──
export const toMicros = (usd) => Math.round(Number(usd) * MICROS);
export const toUsd = (micros) => Math.round(Number(micros) / 100) / 10_000; // 4 decimals: what the APIs report
export const monthOf = (t = Date.now()) => new Date(t).toISOString().slice(0, 7);
/** When a UTC month's readout starts again from $0: 00:00 UTC on the 1st of the next month (ISO). */
export function resetsAt(month = monthOf()) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString();
}

// ── the meter the paid routes use ──
const noHold = (amount = 0) => {
  const hold = { id: null, amount, attach: async () => null, resize: async (next) => { hold.amount = next; return { ok: true }; }, settle: async () => null, release: async () => null };
  return hold;
};
/**
 * ownerSpend(env) → {start, settleJob}. start({provider, kind, model, amount}) records the job at its quote and never
 * refuses it → a hold {id, amount, attach(job), resize(amount), settle(actual), release()}. amount: micro-dollars; one
 * that isn't a whole, non-negative number (Atelier couldn't price the job) is recorded at $0. settleJob(job, actual)
 * settles a running job by its provider id. actual: micro-dollars, or null for "the quote". Bookkeeping never fails the
 * owner's request: with no Ledger, or when the Ledger can't be reached, the job goes ahead unrecorded.
 */
export function ownerSpend(env) {
  const stub = ledger(env);
  const quiet = async (what, fn) => { try { return await fn(); } catch (err) { console.warn('owner spend', what, 'failed', String(err?.name || 'Error').slice(0, 40)); return null; } };
  return {
    async start({ provider, kind, model = '', amount }) {
      const quote = Number.isSafeInteger(amount) && amount >= 0 ? amount : 0;
      if (!stub) return noHold(quote);
      const r = await quiet('start', () => stub.ownerReserve({ provider, kind, model: String(model).slice(0, 120), amount: quote }));
      if (!r?.ok) return noHold(quote);
      const hold = {
        id: r.id, amount: quote, month: r.month,
        attach: (job) => quiet('attach', () => stub.ownerAttach(r.id, job)),
        // A new quote for the running job (Runway's own estimate, Omni without a duration). Never refused.
        async resize(next) {
          if (!Number.isSafeInteger(next) || next < 0) return { ok: true };
          const z = await quiet('resize', () => stub.ownerResize(r.id, next));
          if (z?.ok) hold.amount = next;
          return { ok: true };
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
const countOf = (v, max = 10) => { const n = v == null ? 1 : v; return Number.isInteger(n) && n >= 1 && n <= max ? n : null; };
const promptTokens = (text) => Math.ceil(utf8(text) / 3);
// GPT Image 2.5 with size 'auto' (or a custom size): priced as the largest output it makes (8.29 MP, 3840×2160).
const OPENAI_AUTO_SIZE = Object.freeze([3840, 2160]);
const GEMINI_IMAGE = /^v1(?:beta)?\/models\/([\w.-]+):generateContent$/;

/**
 * An owner image request on the passthrough (provider, the allow-listed sub-path, the parsed JSON body) → {model, amount,
 * n} with amount in micro-dollars from prices.js (no margin), or null when Atelier has no price for it (it is forwarded
 * all the same, just not recorded). 'auto' or missing quality/size is priced at the dearest the model makes.
 */
export function imageQuote(provider, sub, body) {
  if (!isRecord(body)) return null;
  if (provider === 'openai') {
    const model = `openai:${body.model}`, e = typeof body.model === 'string' ? PRICES[model] : null;
    const n = countOf(body.n);
    if (!e || e.kind !== 'image' || n == null) return null;
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
    const n = countOf(body.n);
    if (!e || e.kind !== 'image' || n == null) return null;
    return { model, n, amount: imageCost({ model, n, margin: false }) };
  }
  if (provider === 'gemini') {
    const id = String(sub).match(GEMINI_IMAGE)?.[1], model = `gemini:${id}`, e = id ? PRICES[model] : null;
    const g = isRecord(body.generationConfig) ? body.generationConfig : {};
    const n = countOf(g.candidateCount, 4);
    if (!e || e.kind !== 'image' || n == null) return null;
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
  return null;
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

// ── GET /api/owner/spend (owner passcode only; worker.js checks it) ──
const unavailable = () => json({ error: 'This month’s spend can’t be read on this server right now (no Ledger).', code: 'owner_spend_unavailable' }, 503);

/** This month's spend (or ?month=YYYY-MM) → the GET /api/owner/spend body, or null with no Ledger. */
export async function spendSummary(env, month = monthOf()) {
  const stub = ledger(env);
  if (!stub) return null;
  const s = await stub.ownerSpend(month);
  const total = Number(s?.total) || 0, held = Number(s?.held) || 0;
  return {
    month, resetsAt: resetsAt(month),
    totalUsd: toUsd(total), settledUsd: toUsd(total - held), heldUsd: toUsd(held),
    jobs: Number(s?.jobs) || 0,
    byProvider: (Array.isArray(s?.byProvider) ? s.byProvider : []).map((x) => ({ provider: x.provider, kind: x.kind, usd: toUsd(x.total), heldUsd: toUsd(x.held), jobs: x.jobs })),
  };
}

/** /api/owner/* → GET owner/spend (read only). The caller has already checked the owner passcode. */
export async function handleOwnerApi(req, env, url, path) {
  // A device still running v83–v84 (its Settings → Spending loads, or Save limits) gets the reason and what to do.
  if (path === 'owner/limits') return json({ error: 'Spending limits were removed in Atelier v85 — reload the app to update.', code: 'owner_limits_removed' }, 410);
  if (path !== 'owner/spend') return json({ error: 'Not found' }, 404);
  if (req.method !== 'GET') return json({ error: 'Use GET.' }, 405, { allow: 'GET' });
  const m = url.searchParams.get('month');
  if (m != null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) return json({ error: 'month must be YYYY-MM.', code: 'owner_spend_input' }, 400);
  const s = await spendSummary(env, m || monthOf());
  return s ? json(s) : unavailable();
}
