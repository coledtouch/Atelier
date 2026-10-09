// App error reports: POST /api/client-error from the boot watchdog in public/index.html (#bootWatch), and GET for the
// owner's list (Settings → Advanced diagnostics → Recent app errors, public/app-errors.js).
//
// A report says where Atelier broke, never what anyone was doing: the app version, the kind of failure, the error's
// name (TypeError, SyntaxError…), the failing file's path inside the app (/app.js, /vendor/marked.js), line and column,
// up to FRAMES same-origin stack frames as path:line:col, a platform class, the start-up phase, and whether the device was
// online and under the service worker (and, for a file that didn't load, net: no server error was seen, most likely the
// connection rather than a broken version). Never the error message, a prompt, thread text, a URL with a query or fragment,
// or anything typed. The watchdog sanitizes on the device; cleanReport below cleans again, because anyone can POST here.
//
// The POST can't ask for the passcode (a start-up crash can come before the passcode is known), so it is held down by:
// - same-origin only: the Origin header must be this site and the body application/json, which no other site's page can
//   send without a CORS preflight (it gets no CORS headers), so a stranger's page can't make visitors' browsers post;
// - a MAX_BYTES body cap, read without trusting Content-Length, and a strict pattern per field (anything else is dropped,
//   a report without a version and a known kind is refused);
// - a version check: v must be the deployed version (read once per isolate from the deployed sw.js) or one of the
//   VERSIONS_BACK before it, so nobody can invent failures for versions that don't exist;
// - ERR_LIMIT (wrangler.jsonc ratelimits) per IP (an IPv6 address counts by its /64: one host usually holds the whole
//   /64), plus PER_MINUTE accepted per isolate, so a flood can't fill the logs;
// - storage that can't grow and that junk can't sweep out: the Ledger (src/tester/ledger.js clientErrorAdd) keeps KEEP
//   distinct reports — an identical one only counts up — takes at most NEW_PER_HOUR new ones an hour whoever sends them,
//   and when full lets a report seen once go before one seen again (the KEEP_NEWEST newest always stay); a report not
//   seen for DAYS days is deleted.
// The IP is only a rate-limit key; it is never logged or stored. Anyone can still send a plausible report, so the owner's
// list says the reports are unverified.

export const CLIENT_ERRORS = Object.freeze({ maxBytes: 2048, keep: 50, days: 30, frames: 6, perMinute: 30, newPerHour: 20, keepNewest: 10, versionsBack: 2 });
export const KINDS = Object.freeze(['load', 'error', 'rejection', 'boot', 'stall']);
export const PLATFORMS = Object.freeze(['ios-standalone', 'ios-browser', 'android-twa', 'android-standalone', 'android-browser', 'desktop-standalone', 'desktop-browser', 'unknown']);
export const PHASES = Object.freeze(['loading', 'starting', 'running']);
// An error class name, as code names it (TypeError, ApiError, DOMException's QuotaExceededError).
const NAME = /^[A-Za-z_$][\w$.]{0,47}$/;
// A file the app serves: /app.js, /sync-merge.js, /vendor/marked.js, /index.html. No query, fragment, '..' or '//'.
export const APP_FILE = /^\/(?:vendor\/)?[a-z0-9][a-z0-9-]{0,40}\.(?:m?js|html)$/;
const FRAME = /^\/(?:vendor\/)?[a-z0-9][a-z0-9-]{0,40}\.(?:m?js|html):\d{1,7}:\d{1,7}$/;
const VERSION = /^\d{1,6}$/;
const intOk = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 9_999_999;
const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Any JSON value → a clean report, or null when it has no version or no known kind. Only listed fields survive. */
export function cleanReport(raw) {
  if (!isObject(raw) || typeof raw.v !== 'string' || !VERSION.test(raw.v) || !KINDS.includes(raw.kind)) return null;
  const doc = { v: raw.v, kind: raw.kind, name: typeof raw.name === 'string' && NAME.test(raw.name) ? raw.name : 'Error' };
  if (typeof raw.file === 'string' && APP_FILE.test(raw.file)) {
    doc.file = raw.file;
    if (intOk(raw.line)) doc.line = raw.line;
    if (intOk(raw.col)) doc.col = raw.col;
  }
  if (Array.isArray(raw.stack)) {
    const frames = raw.stack.slice(0, 20).filter((f) => typeof f === 'string' && FRAME.test(f)).slice(0, CLIENT_ERRORS.frames);
    if (frames.length) doc.stack = frames;
  }
  doc.platform = PLATFORMS.includes(raw.platform) ? raw.platform : 'unknown';
  if (PHASES.includes(raw.phase)) doc.phase = raw.phase;
  for (const k of ['online', 'sw', 'net']) if (typeof raw[k] === 'boolean') doc[k] = raw[k];
  return doc;
}

/** The same failure seen again (same version, kind, name, place and platform) shares one stored row. */
export const reportSig = (doc) => [doc.v, doc.kind, doc.name, doc.file || '', doc.line ?? '', doc.col ?? '', doc.platform].join('|');

/** A stored row (the Ledger's, or an older or corrupt one) → what the owner's GET may return, cleaned again. */
export function cleanStored(row) {
  const doc = cleanReport(row);
  if (!doc) return null;
  const at = (n) => (Number.isSafeInteger(n) && n > 0 ? n : null);
  return { ...doc, count: Number.isSafeInteger(row.count) && row.count > 0 ? row.count : 1, firstAt: at(row.firstAt), lastAt: at(row.lastAt) };
}

const json = (doc, status = 200, extra = {}) => new Response(JSON.stringify(doc), { status, headers: {
  'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra,
} });

// Reads at most `cap` bytes of the body → text, or null when it is larger (Content-Length is a hint, not trusted).
async function readCapped(req, cap) {
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
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(all); } catch { return undefined; }
}

/** A rate-limit key for an IP: IPv4 as it is, IPv6 by its /64 (every address in it is one client). */
export function ipKey(ip) {
  const s = String(ip || '').trim().toLowerCase();
  if (!s) return 'unknown';
  if (!s.includes(':')) return s;
  if (s.includes('.')) return s.slice(s.lastIndexOf(':') + 1); // ::ffff:192.0.2.1 is an IPv4 address
  const [head, tail] = s.split('::'), h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(':')}::/64`;
}

let minute = 0, accepted = 0, deployed = null;
/** Tests only: forget this isolate's per-minute count and the deployed version it read. */
export function resetClientErrorCaps() { minute = 0; accepted = 0; deployed = null; }
async function throttled(req, env) {
  const now = Date.now();
  if (now - minute >= 60_000) { minute = now; accepted = 0; }
  if (accepted >= CLIENT_ERRORS.perMinute) return true;
  if (env?.ERR_LIMIT) {
    try { if (!(await env.ERR_LIMIT.limit({ key: `ip:${ipKey(req.headers.get('cf-connecting-ip'))}` })).success) return true; } catch {}
  }
  accepted++;
  return false;
}
// The deployed app version, from the deployed sw.js (const VERSION = 'atelier-v<N>', which scripts/bump-version.mjs
// moves with every ?v=), read once per isolate; null when it can't be read (then no version is refused).
async function deployedVersion(env, url) {
  if (typeof env?.ASSETS?.fetch !== 'function') return null;
  deployed ||= env.ASSETS.fetch(new Request(new URL('/sw.js', url))).then(async (r) => {
    const m = r.ok ? /const VERSION = 'atelier-v(\d{1,6})';/.exec(await r.text()) : null;
    return m ? Number(m[1]) : null;
  }).catch(() => null);
  const v = await deployed;
  if (v === null) deployed = null; // try again next time
  return v;
}

const storeOf = (env) => (env?.LEDGER ? env.LEDGER.get(env.LEDGER.idFromName('main')) : null);

/** POST: a report from the app (public, same-origin). GET: the newest reports, for the owner only (`owner` = passcode ok). */
export async function handleClientError(req, env, { owner = false } = {}) {
  if (req.method === 'GET') {
    if (!owner) return json({ error: 'Enter your passcode.' }, 401);
    const store = storeOf(env);
    if (!store) return json({ error: 'App error reports aren’t set up on this server.' }, 503);
    let rows = [];
    try { rows = await store.clientErrors(); } catch { return json({ error: 'Couldn’t read app error reports — try again.' }, 503); }
    const reports = (Array.isArray(rows) ? rows : []).map(cleanStored).filter(Boolean).slice(0, CLIENT_ERRORS.keep);
    return json({ reports, keep: CLIENT_ERRORS.keep, days: CLIENT_ERRORS.days });
  }
  if (req.method !== 'POST') return json({ error: 'Send app error reports with POST.' }, 405, { allow: 'GET, POST' });
  if (req.headers.get('origin') !== new URL(req.url).origin) return json({ error: 'App error reports come only from Atelier’s own pages.' }, 403);
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type') || '')) return json({ error: 'Send the report as JSON.' }, 415);
  const text = await readCapped(req, CLIENT_ERRORS.maxBytes);
  if (text === null) return json({ error: 'Report too large.' }, 413);
  let raw = null;
  try { raw = JSON.parse(text); } catch {}
  const doc = cleanReport(raw);
  if (!doc) return json({ error: 'Not an app error report.' }, 400);
  const current = await deployedVersion(env, req.url), v = Number(doc.v);
  if (current !== null && (v > current || v < current - CLIENT_ERRORS.versionsBack)) return json({ error: 'Not a current Atelier version.' }, 400);
  if (await throttled(req, env)) return json({ error: 'Too many reports — try again in a minute.' }, 429, { 'retry-after': '60' });
  console.log('client-error', JSON.stringify(doc));
  const store = storeOf(env);
  if (store) { try { await store.clientErrorAdd(doc); } catch { console.warn('client-error: not stored'); } }
  return new Response(null, { status: 204 });
}
