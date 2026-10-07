// LinkedIn tester mode: pure helpers shared by app.js and the tests (spec 2026-09-30 §8, addendum A2/A3/A7b).
// Money is integer micro-dollars (µ$) everywhere, as the Worker sends it.

export const VEO_CAP = 1_000_000; // A7b: one Veo call never reserves more than $1.00
export const MAX_IMAGES = 8; // spec §6: at most 8 images in one tester chat request (video frames count)
export const CLIP_MAX_BYTES = 200 * 1024 * 1024, CLIP_MAX_SECONDS = 180; // A2: larger clips go as frames
export const PROFILE_MAX = 300_000; // GET/PUT /api/tester/profile cap (bytes)
// Veo USD per second of video by resolution. Mirrors src/tester/prices.js (a test keeps the two equal).
export const VEO_PER_SECOND = Object.freeze({
  'gemini:veo-3.1-lite-generate-preview': Object.freeze({ '720p': 0.05, '1080p': 0.08 }),
  'gemini:veo-3.1-fast-generate-preview': Object.freeze({ '720p': 0.1, '1080p': 0.12, '4k': 0.3 }),
});
const MARGIN_PCT = 125; // prices.js MARGIN 1.25: reserve = price × 1.25

const int = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0; };
const str = (v, max = 400) => (typeof v === 'string' ? v.slice(0, max) : '');
const ids = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && /^[\w.:/-]{1,120}$/.test(x)) : []);
const httpsUrl = (v) => { try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password ? u.href : ''; } catch { return ''; } };
export const isTesterCode = (code) => typeof code === 'string' && (code.startsWith('tester_') || code === 'owner_only');

/** GET /api/tester/me → a clean tester record (null for anything that isn't one). Features default to on. */
export function normalizeMe(j) {
  if (!j || typeof j !== 'object' || typeof j.sub !== 'string' || !j.sub) return null;
  const m = j.models || {}, f = j.features || {}, a = j.allowance || {}, p = j.pool || {};
  const features = Object.fromEntries(['web', 'video', 'veo', 'helpers', 'profile', 'tts', 'dictation'].map((k) => [k, f[k] !== false]));
  features.sync = f.sync === true; // only a freshly configured server can offer private thread sync
  const period = (x = {}) => ({ spent: int(x.spent), reserved: int(x.reserved), limit: int(x.limit) });
  // tts: Read aloud voice ids ('atelier', 'sulafat', …) the tester may use; allowedIds() stays chat/image/video only.
  // null = not listed (a record cached before v53, before its first /me): unknown, not none, so the reader asks and the
  // server's own allow-list decides. [] = Read aloud's AI voices are off for this tester.
  const models = { chat: ids(m.chat), image: ids(m.image), video: features.veo ? ids(m.video) : [], tts: features.tts ? (Array.isArray(m.tts) ? ids(m.tts) : null) : [] };
  const pool = a.pool && typeof a.pool === 'object' && a.pool.limit != null ? period(a.pool) : null; // when /me reports the pool
  return {
    sub: str(j.sub, 128), name: str(j.name, 120), email: str(j.email, 200), picture: httpsUrl(j.picture), models, features,
    allowance: { day: period(a.day), month: period(a.month) },
    pool: { paused: Boolean(Number(p.paused ?? a.paused)), preview: Boolean(p.preview ?? a.preview), spotsLeft: p.spotsLeft == null ? null : int(p.spotsLeft) },
    // left: from the last x-tester-allowance header (kept in localStorage); poolLeft: the shared pool, when known.
    left: j.left && typeof j.left === 'object' ? parseLeft(j.left) : null,
    poolLeft: pool ? Math.max(0, pool.limit - pool.spent - pool.reserved) : j.poolLeft == null ? null : int(j.poolLeft),
  };
}
/** Every model id the tester may use (chat, image and video). */
export const allowedIds = (t) => new Set(t ? [...t.models.chat, ...t.models.image, ...t.models.video] : []);

const parseLeft = (o) => ({ day: int(o.day), month: int(o.month), pool: o.pool == null ? null : int(o.pool) });
/** x-tester-allowance: {"dayLeft","monthLeft","poolLeft"} → {day, month, pool}; null when absent or malformed. */
export function parseAllowanceHeader(v) {
  if (!v) return null;
  let j; try { j = JSON.parse(v); } catch { return null; }
  if (!j || typeof j !== 'object' || ![j.dayLeft, j.monthLeft].every((x) => Number.isFinite(Number(x)) && x !== null && x !== '')) return null;
  return { day: int(j.dayLeft), month: int(j.monthLeft), pool: Number.isFinite(Number(j.poolLeft)) && j.poolLeft !== null ? int(j.poolLeft) : null };
}
/** What the tester can still spend: {day, month, pool (null = unknown)}. */
export function leftOf(t) {
  if (!t) return { day: 0, month: 0, pool: null };
  const { day, month } = t.allowance, fromMe = (p) => Math.max(0, p.limit - p.spent - p.reserved);
  return t.left ? { ...t.left } : { day: fromMe(day), month: fromMe(month), pool: t.poolLeft ?? null };
}
/** The most one call may reserve right now (and which limit binds). */
export function headroom(left, cap = Infinity) {
  const opts = [['day', left.day], ['month', left.month], ['pool', left.pool ?? Infinity], ['call', cap]];
  const [scope, amount] = opts.reduce((a, b) => (b[1] < a[1] ? b : a));
  return { scope, amount };
}

/** $ for display; remaining money rounds DOWN so the line never promises more than is there. */
export const money = (micros, { up = false } = {}) => {
  const c = (up ? Math.ceil : Math.floor)(Math.max(0, Number(micros) || 0) / 10_000);
  return `$${Math.floor(c / 100).toLocaleString('en-US')}.${String(c % 100).padStart(2, '0')}`;
};

/** When a scope's allowance resets (UTC day / UTC calendar month), in ms. */
export function nextReset(scope, now = Date.now()) {
  const d = new Date(now);
  if (scope === 'day') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  if (scope === 'month' || scope === 'pool') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return null;
}
/** A 402 body's resetsAt (ISO string, ms or seconds) → ms; falls back to the scope's next reset. */
export function parseResetsAt(v, scope, now = Date.now()) {
  let ms = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : typeof v === 'string' && v ? (/^\d+$/.test(v) ? Number(v) * (v.length < 13 ? 1000 : 1) : Date.parse(v)) : NaN;
  if (!Number.isFinite(ms) || ms <= 0) ms = nextReset(scope, now) ?? NaN;
  return Number.isFinite(ms) ? ms : null;
}
/** "in 5 h 12 min" / "in 8 min" / "on Nov 1" (local time). */
export function resetIn(ms, now = Date.now()) {
  if (!Number.isFinite(ms)) return '';
  const d = ms - now;
  if (d <= 60_000) return 'in a minute';
  if (d < 3_600_000) return `in ${Math.ceil(d / 60_000)} min`;
  if (d < 86_400_000) { const h = Math.floor(d / 3_600_000), m = Math.floor((d % 3_600_000) / 60_000); return `in ${h} h${m ? ` ${m} min` : ''}`; }
  return `on ${new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

// ── Veo (A7b): offer only the durations and resolutions whose worst case fits ──
/** Reserve for one Veo clip in µ$ (price × seconds × 1.25, rounded up), or null for an unknown model/resolution. */
export function veoCost(model, seconds, resolution) {
  const usd = VEO_PER_SECOND[model]?.[resolution];
  if (usd == null || !(seconds > 0)) return null;
  return Math.ceil((seconds * Math.round(usd * 1e6) * MARGIN_PCT) / 100);
}
/** The app's video params → Veo's request: '16:9hd' is 1080p and always 8 s, everything else 720p. */
export const veoShape = (params = {}) => (params.aspect === '16:9hd' ? { seconds: 8, resolution: '1080p' } : { seconds: +params.secs || 6, resolution: '720p' });
/** Which choices fit: {secs: [4, 6, 8 that fit at 720p], hd: 8 s 1080p fits, cheapest: µ$ of the smallest clip}. */
export function veoChoices(model, left) {
  const room = headroom(left, VEO_CAP).amount;
  const fits = (s, r) => { const c = veoCost(model, s, r); return c != null && c <= room; };
  return { secs: [4, 6, 8].filter((s) => fits(s, '720p')), hd: fits(8, '1080p'), cheapest: veoCost(model, 4, '720p'), room };
}

/** A2: a clip the tester may not send whole (Gemini then gets frames, like any over-limit clip). */
export function testerClipReason(v) {
  if (!v) return null;
  if (v.size > CLIP_MAX_BYTES) return 'tester-large';
  if (Number.isFinite(v.duration) && v.duration > CLIP_MAX_SECONDS) return 'tester-long';
  return null;
}

// ── the tester's own "You" document (GET/PUT /api/tester/profile; src/tester/profile.js keeps the same fields) ──
const MEM_MAX = 400, TEXT_MAX = 100_000;
const memId = (v) => (typeof v === 'string' && /^[\w-]{1,40}$/.test(v) ? v : null);
const sourcesOf = (v) => Object.fromEntries(Object.entries(v && typeof v === 'object' && !Array.isArray(v) ? v : {}).slice(0, 40)
  .filter(([, x]) => x && typeof x === 'object').map(([k, x]) => [k.slice(0, 80), { at: int(x.at), count: int(x.count) }]));
/** ME → the stored document: {name,bio,samples,style,learned,memory:[{id,text,src,at}],sources,updatedAt}, under 300 KB. */
export function profileOut(me, name = '') {
  const memory = (Array.isArray(me?.memory) ? me.memory : []).slice(-MEM_MAX).filter((m) => m && typeof m.text === 'string' && m.text)
    .map((m) => ({ ...(memId(m.id) ? { id: m.id } : {}), text: m.text.slice(0, 500), src: str(m.src, 40), at: int(m.at) }));
  const doc = { name: str(name || me?.name, 120), bio: str(me?.bio, TEXT_MAX), samples: str(me?.samples, TEXT_MAX), style: str(me?.style, TEXT_MAX), learned: str(me?.learned, TEXT_MAX), memory, sources: sourcesOf(me?.sources), updatedAt: int(me?.updatedAt) };
  // Over the cap: raw writing samples give way first, then the oldest memories (down to 100), then the other long fields.
  const fits = () => new TextEncoder().encode(JSON.stringify(doc)).length <= PROFILE_MAX;
  const halve = (k) => { while (!fits() && doc[k]) doc[k] = doc[k].slice(0, Math.floor(doc[k].length / 2)); };
  const shed = (keep) => { while (!fits() && doc.memory.length > keep) doc.memory.splice(0, Math.min(Math.ceil(doc.memory.length / 4), doc.memory.length - keep)); };
  halve('samples'); shed(100); halve('learned'); halve('bio'); halve('style'); shed(0);
  return doc;
}
/** The stored document → ME fields (a memory without an id gets a new one, so it can be forgotten). */
export function profileIn(doc, makeId) {
  const d = doc && typeof doc === 'object' ? doc : {};
  return {
    name: str(d.name, 120), bio: str(d.bio, TEXT_MAX), samples: str(d.samples, TEXT_MAX), style: str(d.style, TEXT_MAX), learned: str(d.learned, TEXT_MAX),
    memory: (Array.isArray(d.memory) ? d.memory : []).filter((m) => m && typeof m.text === 'string' && m.text.trim()).slice(-MEM_MAX)
      .map((m) => ({ id: memId(m.id) || makeId(), text: m.text.slice(0, 500), src: str(m.src, 40), at: int(m.at) })),
    sources: sourcesOf(d.sources), updatedAt: int(d.updatedAt),
  };
}

// ── owner Testers panel ──
/** Seconds, ms or ISO → ms (null when unknown). */
export function toMs(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : /^\d+$/.test(String(v)) ? Number(v) : Date.parse(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}
export const isSub = (s) => typeof s === 'string' && /^[\w-]{1,128}$/.test(s); // the Ledger's SUB rule
/** The Testers panel's config fields (dollars as typed) → POST /api/testers/config body, or {error}. */
export function configBody({ cap, day, month, pool }) {
  const dollars = (v) => { const n = Number(String(v).trim()); return String(v).trim() && Number.isFinite(n) && n > 0 ? Math.round(n * 1e6) : null; };
  const c = Number(String(cap).trim());
  if (!Number.isInteger(c) || c < 0 || c > 1000) return { error: 'Spots must be a whole number from 0 to 1,000.' };
  const body = { cap: c, day_limit: dollars(day), month_limit: dollars(month), pool_limit: dollars(pool) };
  if (!body.day_limit || !body.month_limit || !body.pool_limit) return { error: 'Limits must be dollar amounts above $0.' };
  if (body.pool_limit > 1000 * 1e6) return { error: 'The monthly pool can’t go above $1,000.' };
  if (body.day_limit > body.month_limit) return { error: 'The daily limit can’t be more than the monthly one.' };
  return { body };
}
