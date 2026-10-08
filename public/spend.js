// The owner's spend readout (Settings → Spending → This month's spend): the client half of src/spend.js. Pure helpers
// (node-tested in tests/spend-client.test.mjs) plus the one call the panel makes; nothing touches the DOM at import time.
// Since v85 there are no spending limits: the Worker records every paid owner video and image and settles it to what the
// provider reports, and refuses nothing for its price. This module only reads and words that record.
// Testers never see it: /api/owner/* answers them 403.

/** $ for display: two decimals; spend rounds UP (never shows less than was used). */
export function usd(v, { up = false } = {}) {
  const c = Math.max(0, (up ? Math.ceil : Math.floor)(Math.max(0, Number(v) || 0) * 100 - 1e-6 * (up ? 1 : -1))) || 0; // never "-0"
  return `$${Math.floor(c / 100).toLocaleString('en-US')}.${String(c % 100).padStart(2, '0')}`;
}
/** The day the month's record starts again from $0, as the Worker counts it (00:00 UTC on the 1st): 'Sun, Nov 1'. */
export const resetDay = (ms) => (Number.isFinite(ms) ? new Date(ms).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }) : '');

const PROVIDER_LABEL = Object.freeze({ runway: 'Runway', omni: 'Gemini Omni', xai: 'Grok Imagine (xAI)', openai: 'GPT Image', gemini: 'Nano Banana', meta: 'Muse Image (Meta)' });
/** byProvider rows → [{label, usd, held, jobs}] for the breakdown list (unknown providers keep their own name). */
export function breakdownRows(data) {
  return (Array.isArray(data?.byProvider) ? data.byProvider : []).filter((x) => x && typeof x.provider === 'string')
    .map((x) => ({
      label: `${PROVIDER_LABEL[x.provider] || x.provider.slice(0, 30)} · ${x.kind === 'image' ? 'images' : 'video'}`,
      usd: Math.max(0, Number(x.usd) || 0), held: Math.max(0, Number(x.heldUsd) || 0), jobs: Math.max(0, Math.floor(Number(x.jobs) || 0)),
    }));
}

// ── talking to /api/owner/spend ──
const headersFor = (apiHeaders) => new Headers(typeof apiHeaders === 'function' ? apiHeaders() : apiHeaders || {});
/** GET /api/owner/spend → this month's spend and its breakdown (read only). */
export async function loadSpend({ apiHeaders, signal, fetch: f = globalThis.fetch } = {}) {
  const r = await f('/api/owner/spend', { method: 'GET', signal, cache: 'no-store', headers: headersFor(apiHeaders) });
  let j = {};
  try { j = await r.json(); } catch {}
  if (!r.ok) throw Object.assign(new Error(typeof j?.error === 'string' && j.error ? j.error.slice(0, 300) : `Couldn’t load your spending (${r.status}).`), { status: r.status, code: j?.code });
  return j && typeof j === 'object' ? j : {};
}
