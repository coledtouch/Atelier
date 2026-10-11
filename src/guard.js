// Passcode guard: the brute-force lockout in front of every /api request that carries the owner's passcode (x-app-pass).
// src/worker.js runs passcodeGate() before any route; nothing else reads or writes this state.
//
// Where the count lives: the Guard Durable Object (one instance, "main", SQLite storage; wrangler.jsonc binding GUARD).
// A Durable Object runs one request's synchronous code at a time, and attempt() reads the network's record, decides and
// writes the new count inside one transactionSync with no await in between. Parallel guesses therefore queue: the
// counter reaches the true count and the lock engages exactly at the limit. (The ATELIER_KV counter this replaces was a
// read-then-write: 200 parallel wrong guesses all got 401 and the counter ended at 1.)
// Why its own object and not the Ledger: guesses are unauthenticated and unbounded, while the Ledger holds the owner's
// spend record (a paid job's hold goes through it) and the error reports. A flood of guesses must not queue in front of
// those, and a bug here can never touch their tables. The cost is one small class (migration v3; once deployed, a
// rollback to a version without it is refused by Cloudflare, so a problem here is fixed forward, or with GUARD_RELAX).
//
// Shedding first: before a request reaches the Guard, the GUARD_LIMIT ratelimit binding (wrangler.jsonc; per network,
// 30 a minute) answers the excess with the same 429 a lock gets, without comparing anything or touching the object, so
// one address flooding guesses can't queue the single Guard into "overloaded" or bill a write per guess.
//
// Buckets: the network a guess comes from (cf-connecting-ip through client-errors.js ipKey): an IPv4 address (/32) or
// an IPv6 /64 (one subscriber usually holds the whole /64, so rotating addresses inside it stays one bucket). The record
// keeps a keyed hash of that (HMAC under a random key that never leaves this object), never the address, and the alarm
// deletes it once 15 minutes have passed since its last failure and any lock has ended.
//
// Rules, in the order attempt() applies them, all BEFORE the passcode is compared, so a refused guess gets the same 429
// whether it was right or wrong, and its effect (below) doesn't depend on that either:
//   1. locked: 10 failures from one network lock it for 15 minutes (from the 10th);
//   2. sealed: 30 compared wrong passcodes across all networks in the last 15 minutes: no passcode is compared for
//      anyone without a clearance (below) until the rolling count drops under 30;
//   3. strict: from 20 of them, only a network with no failure in the last 15 minutes has its passcode compared (one
//      guess per fresh network, and each wrong one still counts toward the seal);
//   4. otherwise the passcode is compared (SHA-256 digests, constant time): right → allowed; wrong → one failure.
// What counts: a compared wrong passcode is one failure on its network and one toward the global budget. A guess refused
// by a lock (1) is one more failure on that network (the true count; the lock isn't extended, and the record's time
// moves at most once a minute, so a network that keeps going gets one guess per lock). A guess refused by 2 or 3 counts
// nowhere: it learned nothing, and the owner's own app, refused while someone else holds the seal, must not lock the
// owner's own network. So one locked network hammering away can't push everyone into strict or sealed mode either.
//
// GUARD_RELAX (a secret, never a var: `wrangler secret put GUARD_RELAX` with the value 1 takes effect at once, no ship;
// `wrangler secret delete GUARD_RELAX` ends it): the operator's lever when an attacker holds the seal and the owner needs
// to sign in a new device, or when the Guard itself is failing. Rules 2 and 3 are skipped (per-network locks stay), and
// if the Guard can't be reached the request goes on with only GUARD_LIMIT's per-network throttle (the routes compare the
// passcode; no clearance is minted then). Both weaken the cap for as long as it is set: switch it off again afterwards.
//
// Clearance (the owner's own devices): a request this object allowed gets the __Host-atelier_owner cookie: an expiry
// and an HMAC under a key the Worker derives from GUARD_SECRET (a Worker secret; never the passcode alone, or a stolen
// cookie could be guessed against offline) and the passcode's SHA-256, so a new passcode voids every clearance. A
// request carrying a valid clearance AND the right passcode is checked in the Worker alone and never waits on this
// object: no extra round trip on the owner's normal requests, and no lock, seal, flood or Guard outage shuts out a
// device that already signed in. A clearance comes only from a right passcode this object compared, so the race above
// can't mint one. Without GUARD_SECRET no clearance is minted or honoured (scripts/ship.mjs refuses to deploy then).
// A clearance sent with a WRONG passcode is burned: the Worker reports a one-way code of it to this object with that
// guess (counted like any other), and from then on it is no clearance at all, so a copied cookie can't be used to tell a
// right guess (fast path) from refused wrong ones at any rate. The isolate that saw it stops honouring it at once;
// every other isolate syncs the burned list in the background (at most every 15 seconds, never waiting on it), so a
// burned clearance can still pass on an isolate that hasn't synced since: a window of seconds, once per stolen cookie.
//
// The trade-off: while sealed, a device without a clearance (a new phone, cleared site data, a browser that blocks the
// cookie) can't sign in until the attack has been quiet for up to 15 minutes, or the owner sets GUARD_RELAX; devices
// that signed in keep working. In exchange, online guessing is capped at 30 compared guesses per 15 minutes across every
// network the attacker holds (about 2,900 a day), plus one per network at most while strict. Changing APP_PASSCODE
// during a seal signs out every device into that seal: rotate only if the passcode leaked, and set GUARD_RELAX first.
// Clearing the passcode in Settings, or Clear this device, ends the browser's clearance (POST /api/clearance/end, which
// answers only the app's own pages).
import { DurableObject } from 'cloudflare:workers';
import { ipKey } from './client-errors.js';
import { readCookie } from './tester/auth.js';

const MINUTE = 60_000, DAY = 86_400_000;
export const GUARD = Object.freeze({
  networkLimit: 10, lockMs: 15 * MINUTE, windowMs: 15 * MINUTE,
  strictAt: 20, sealAt: 30,
  maxNetworks: 20_000, // records kept at once: past this (a huge distributed attack, long since sealed) new ones aren't stored
  touchMs: MINUTE, // a locked network's last-failure time moves at most this often
  clearDays: 30, clearRefreshMs: DAY, // a clearance lasts 30 days and is renewed at most once a day while it is used
  burnSyncMs: 15_000, // how long an isolate trusts its copy of the burned-clearance list before syncing it again
  maxBurned: 1000, // burned clearances kept at once (each needs a clearance, which only a right passcode mints)
  shedPerMinute: 30, // GUARD_LIMIT in wrangler.jsonc: requests per network per minute that may reach the Guard
});
export const CLEAR_COOKIE = '__Host-atelier_owner';
const HEX64 = /^[0-9a-f]{64}$/;
const BURN_ID = /^[0-9a-f]{32}$/;
const CLEAR_VALUE = /^v1\.([0-9a-z]{6,12})\.([A-Za-z0-9_-]{43})$/;
const SECRET_MIN = 32; // GUARD_SECRET: at least this many characters (a random 32-byte base64url value has 43)

const enc = (s) => new TextEncoder().encode(s);
const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
export async function sha256hex(text) {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc(String(text)))));
}
// Two SHA-256 hex digests (always 64 characters), compared without an early exit.
export function sameDigest(a, b) {
  if (!HEX64.test(a) || !HEX64.test(b)) return false;
  let diff = 0;
  for (let i = 0; i < 64; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const SCHEMA = [
  // One row per network with a recent failure: id = HMAC(network), fails = failures since the record began.
  `CREATE TABLE IF NOT EXISTS nets (id TEXT PRIMARY KEY, fails INTEGER NOT NULL, since INTEGER NOT NULL, last_at INTEGER NOT NULL,
    locked_until INTEGER NOT NULL DEFAULT 0)`,
  'CREATE INDEX IF NOT EXISTS nets_last ON nets (last_at)',
  // Compared wrong passcodes per minute, all networks together (the global budget).
  'CREATE TABLE IF NOT EXISTS wrong (minute INTEGER PRIMARY KEY, n INTEGER NOT NULL)',
  // Clearances sent with a wrong passcode: id = the first half of SHA-256(cookie value), kept until it would expire.
  'CREATE TABLE IF NOT EXISTS burned (id TEXT PRIMARY KEY, until INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)',
];

export class Guard extends DurableObject {
  #key = null; // HMAC key (this object's random key) for network ids
  #alarmAt = null;
  #ready;
  constructor(ctx, env) {
    super(ctx, env);
    this.storage = ctx.storage;
    this.clock = () => Date.now();
    this.#ready = ctx.blockConcurrencyWhile(async () => {
      for (const s of SCHEMA) this.storage.sql.exec(s);
      this.storage.sql.exec("INSERT OR IGNORE INTO meta (k, v) VALUES ('key', ?)", toHex(crypto.getRandomValues(new Uint8Array(32))));
      const hex = this.#row("SELECT v FROM meta WHERE k = 'key'").v;
      this.#key = await crypto.subtle.importKey('raw', fromHex(hex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      this.#alarmAt = (await this.storage.getAlarm()) ?? null;
    });
  }

  // ── private helpers (never reachable over RPC) ──
  #rows(q, ...b) { return this.storage.sql.exec(q, ...b).toArray(); }
  #row(q, ...b) { return this.#rows(q, ...b)[0] || null; }
  #run(q, ...b) { this.storage.sql.exec(q, ...b); }
  async #mac(text) { return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', this.#key, enc(text)))); }
  #netId(network) { return this.#mac(`net|${String(network ?? '').slice(0, 64) || 'unknown'}`).then((h) => h.slice(0, 32)); }
  // When the rolling count of compared wrong passcodes drops under limit (ms from now).
  #underIn(limit, now) {
    const rows = this.#rows('SELECT minute, n FROM wrong ORDER BY minute');
    let left = rows.reduce((s, r) => s + r.n, 0);
    for (const r of rows) { left -= r.n; if (left < limit) return (r.minute + 1) * MINUTE + GUARD.windowMs - now; }
    return GUARD.windowMs;
  }
  // The whole decision, synchronous: called inside one transactionSync. relax: GUARD_RELAX (rules 2 and 3 skipped).
  #decide(id, got, want, now, relax) {
    const W = GUARD.windowMs;
    this.#run('DELETE FROM nets WHERE last_at <= ? AND locked_until <= ?', now - W, now);
    this.#run('DELETE FROM wrong WHERE minute <= ?', Math.floor((now - W) / MINUTE));
    const net = this.#row('SELECT fails, last_at, locked_until FROM nets WHERE id = ?', id);
    if (net && net.locked_until > now) {
      // 1. locked: one more failure (one row; the indexed last_at moves at most once a minute), the lock unchanged
      const touch = now - net.last_at >= GUARD.touchMs;
      if (touch) this.#run('UPDATE nets SET fails = fails + 1, last_at = ? WHERE id = ?', now, id);
      else this.#run('UPDATE nets SET fails = fails + 1 WHERE id = ?', id);
      return { verdict: 'locked', wait: net.locked_until - now, wrote: touch };
    }
    const compared = relax ? 0 : this.#row('SELECT COALESCE(SUM(n), 0) AS n FROM wrong').n;
    // 2. sealed, 3. strict: refused, and counted nowhere
    if (compared >= GUARD.sealAt) return { verdict: 'busy', wait: this.#underIn(GUARD.sealAt, now), wrote: false };
    if (compared >= GUARD.strictAt && net) return { verdict: 'busy', wait: Math.min(this.#underIn(GUARD.strictAt, now), W), wrote: false };
    // 4. compared only here, after every refusal above
    if (sameDigest(got, want)) return { verdict: 'ok', wrote: false };
    if (net) {
      const fails = net.fails + 1;
      this.#run('UPDATE nets SET fails = ?, last_at = ?, locked_until = ? WHERE id = ?', fails, now, fails >= GUARD.networkLimit ? now + GUARD.lockMs : net.locked_until, id);
    } else if (this.#row('SELECT COUNT(*) AS n FROM nets').n < GUARD.maxNetworks) {
      this.#run('INSERT INTO nets (id, fails, since, last_at, locked_until) VALUES (?, 1, ?, ?, ?)', id, now, now, GUARD.networkLimit <= 1 ? now + GUARD.lockMs : 0);
    }
    this.#run('INSERT INTO wrong (minute, n) VALUES (?, 1) ON CONFLICT (minute) DO UPDATE SET n = n + 1', Math.floor(now / MINUTE));
    return { verdict: 'wrong', wrote: true };
  }
  // A clearance sent with a wrong passcode (the Worker checked both): kept until it would have expired.
  #burn(burn, now) {
    if (!burn || !BURN_ID.test(String(burn.id)) || !Number.isSafeInteger(burn.until) || burn.until <= now) return false;
    this.#run('DELETE FROM burned WHERE until <= ?', now);
    if (this.#row('SELECT COUNT(*) AS n FROM burned').n >= GUARD.maxBurned) return false;
    this.#run('INSERT OR IGNORE INTO burned (id, until) VALUES (?, ?)', burn.id, Math.min(burn.until, now + GUARD.clearDays * DAY + MINUTE));
    return true;
  }
  // The next moment a record can go: a network 15 minutes after its last failure (and after its lock), a minute's
  // wrong count 15 minutes after that minute, a burned clearance when it would have expired.
  #nextExpiry() {
    const n = this.#row('SELECT MIN(MAX(last_at + ?, locked_until)) AS t FROM nets', GUARD.windowMs).t;
    const w = this.#row('SELECT MIN(minute) AS m FROM wrong').m;
    const b = this.#row('SELECT MIN(until) AS t FROM burned').t;
    const times = [n, w == null ? null : (w + 1) * MINUTE + GUARD.windowMs, b].filter((t) => Number.isFinite(t));
    return times.length ? Math.min(...times) : null;
  }
  // An alarm already set is never later than a new record's expiry (every new one ends at least a window from now), so
  // this scans for the next expiry only when none is set: alarm() sets the next one after each run.
  async #armAlarm() {
    if (this.#alarmAt != null) return;
    const next = this.#nextExpiry();
    if (next == null) return;
    this.#alarmAt = next + 1000;
    await this.storage.setAlarm(this.#alarmAt);
  }

  // ── RPC (src/guard.js passcodeGate only) ──
  // network: ipKey(cf-connecting-ip); got: SHA-256 hex of the passcode presented; want: SHA-256 hex of APP_PASSCODE.
  // opts.relax: GUARD_RELAX; opts.burn: {id, until}, a clearance this request carried with a wrong passcode.
  // → {verdict: 'ok'} | {verdict: 'wrong'} | {verdict: 'locked' | 'busy', retryAfter (seconds)}
  async attempt(network, got, want, opts = {}) {
    await this.#ready;
    if (!HEX64.test(String(got)) || !HEX64.test(String(want))) throw new TypeError('attempt: digests must be SHA-256 hex');
    const id = await this.#netId(network);
    const now = this.clock();
    const out = this.storage.transactionSync(() => {
      const burned = this.#burn(opts?.burn, now);
      const v = this.#decide(id, got, want, now, opts?.relax === true);
      return { ...v, wrote: v.wrote || burned };
    });
    if (out.wrote) await this.#armAlarm();
    if (out.verdict === 'ok' || out.verdict === 'wrong') return { verdict: out.verdict };
    return { verdict: out.verdict, retryAfter: Math.max(1, Math.ceil(out.wait / 1000)) };
  }
  // The burned clearances that haven't expired yet (ids only): each Worker isolate keeps a copy (passcodeGate).
  async burned() {
    await this.#ready;
    return this.#rows('SELECT id FROM burned WHERE until > ? ORDER BY until DESC LIMIT ?', this.clock(), GUARD.maxBurned).map((r) => r.id);
  }
  async alarm() {
    await this.#ready;
    const now = this.clock();
    this.storage.transactionSync(() => {
      this.#run('DELETE FROM nets WHERE last_at <= ? AND locked_until <= ?', now - GUARD.windowMs, now);
      this.#run('DELETE FROM wrong WHERE minute <= ?', Math.floor((now - GUARD.windowMs) / MINUTE));
      this.#run('DELETE FROM burned WHERE until <= ?', now);
    });
    this.#alarmAt = null;
    await this.#armAlarm();
  }
}

// ── the Worker's side ──
const guardStub = (env) => {
  if (!env?.GUARD) throw new Error('GUARD binding missing');
  return env.GUARD.get(env.GUARD.idFromName('main'));
};
// Per isolate: the passcode's SHA-256, the clearance key, the burned-clearance list (synced from the Guard: ids, when)
// and the clearances this isolate itself saw burned (id → until), honoured at once whatever the list says.
let wantMemo = null, keyMemo = null, noSecretLogged = false;
let burns = { ids: new Set(), at: 0, pending: null };
const localBurns = new Map();
async function wantOf(env) {
  if (wantMemo?.pass !== env.APP_PASSCODE) wantMemo = { pass: env.APP_PASSCODE, hash: await sha256hex(env.APP_PASSCODE) };
  return wantMemo.hash;
}
// The clearance key: HMAC-SHA256 under GUARD_SECRET of the passcode's SHA-256, made in the Worker (no Durable Object).
// → a CryptoKey, or null without a usable GUARD_SECRET (then no clearance is minted or honoured).
async function clearKeyOf(env, want) {
  const secret = env?.GUARD_SECRET;
  if (typeof secret !== 'string' || secret.length < SECRET_MIN) {
    if (!noSecretLogged) { noSecretLogged = true; console.warn('passcode guard: GUARD_SECRET is not set, so no clearance is minted or honoured'); }
    return null;
  }
  if (keyMemo?.secret === secret && keyMemo.want === want) return keyMemo.key;
  const base = await crypto.subtle.importKey('raw', enc(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const raw = new Uint8Array(await crypto.subtle.sign('HMAC', base, enc(`atelier-clearance-v1|${want}`)));
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  keyMemo = { secret, want, key };
  return key;
}
/** Tests only: forget this isolate's passcode digest, clearance key and burned-clearance lists (a new isolate). */
export function resetGuardCaches() {
  wantMemo = null; keyMemo = null; noSecretLogged = false;
  burns = { ids: new Set(), at: 0, pending: null };
  localBurns.clear();
}
/** Tests only: settles once this isolate's background sync of the burned list (if any) has finished. */
export const guardSynced = () => burns.pending || Promise.resolve();

const isBurned = (id, now) => burns.ids.has(id) || (localBurns.get(id) ?? 0) > now;
function burnLocally(id, until, now) {
  if (localBurns.size >= GUARD.maxBurned) for (const [k, u] of localBurns) if (u <= now || localBurns.size >= GUARD.maxBurned) localBurns.delete(k);
  localBurns.set(id, until);
}
// Refreshes the burned list in the background, at most every burnSyncMs; the request that starts it never waits.
function syncBurns(env, ctx, now) {
  if (burns.pending || now - burns.at < GUARD.burnSyncMs) return;
  burns.at = now;
  const p = Promise.resolve().then(() => guardStub(env).burned())
    .then((ids) => { if (Array.isArray(ids)) burns.ids = new Set(ids.filter((x) => BURN_ID.test(String(x)))); })
    .catch(() => {}) // the Guard unreachable: keep the last copy, try again after burnSyncMs
    .finally(() => { burns.pending = null; });
  burns.pending = p;
  try { ctx?.waitUntil?.(p); } catch {}
}

const CLEAR_MS = GUARD.clearDays * DAY;
// The Set-Cookie that ends this browser's clearance (POST /api/clearance/end: the app sends it when the owner clears the
// passcode in Settings or uses Clear this device). A clearance never opens anything by itself, but with it the right
// passcode skips the lockout, so a device the owner has signed out of shouldn't keep one.
export const endClearance = () => `${CLEAR_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
async function mintClearance(key, now) {
  const exp = (now + CLEAR_MS).toString(36);
  const sig = b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc(`v1.${exp}`))));
  return `${CLEAR_COOKIE}=v1.${exp}.${sig}; Path=/; Max-Age=${CLEAR_MS / 1000}; HttpOnly; Secure; SameSite=Strict`;
}
// The request's clearance → {exp, key, id} when it is well formed, unexpired and signed with this passcode's key (burned
// or not: the caller decides); else null. id: the first half of SHA-256 of the cookie value, what a burn records.
async function clearanceOf(req, env, want, now) {
  const value = readCookie(req, CLEAR_COOKIE);
  const m = CLEAR_VALUE.exec(value);
  if (!m) return null;
  const exp = parseInt(m[1], 36);
  if (!Number.isSafeInteger(exp) || exp <= now || exp > now + CLEAR_MS + MINUTE) return null;
  const key = await clearKeyOf(env, want);
  if (!key || !(await crypto.subtle.verify('HMAC', key, fromB64url(m[2]), enc(`v1.${m[1]}`)))) return null;
  return { exp, key, id: (await sha256hex(value)).slice(0, 32) };
}

// GUARD_LIMIT (ratelimit binding) for this network → 'over' (refuse without touching the Guard), 'ok', or 'none' (no
// binding, or it failed: the Guard alone decides).
async function shed(req, env) {
  if (typeof env?.GUARD_LIMIT?.limit !== 'function') return 'none';
  try { return (await env.GUARD_LIMIT.limit({ key: `pass:${ipKey(req.headers.get('cf-connecting-ip'))}` }))?.success === false ? 'over' : 'ok'; } catch { return 'none'; }
}

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };
function refusal(v) {
  const s = Math.max(1, Math.min(3600, Math.ceil(Number(v?.retryAfter) || GUARD.lockMs / 1000)));
  const m = Math.ceil(s / 60), mins = `${m} minute${m === 1 ? '' : 's'}`;
  const error = v?.verdict === 'locked' ? `Too many wrong passcodes from this network — try again in ${mins}.`
    : v?.verdict === 'shed' ? `Too many passcode tries from this network — try again in ${mins}.`
      : `Too many wrong passcodes are being tried right now — try again in ${mins}. Devices already signed in keep working.`;
  return new Response(JSON.stringify({ error, code: v?.verdict === 'busy' ? 'passcode_busy' : 'passcode_locked', retryAfter: s }),
    { status: 429, headers: { ...JSON_HEADERS, 'retry-after': String(s) } });
}
const unavailable = () => new Response(JSON.stringify({ error: 'Atelier couldn’t check the passcode just now — try again in a moment.', code: 'guard_unavailable' }),
  { status: 503, headers: { ...JSON_HEADERS, 'retry-after': '5' } });
function logGuardError(err) {
  let name = 'Error';
  try { name = String(err?.name || typeof err).replace(/[^\w]/g, '').slice(0, 40) || 'Error'; } catch {}
  console.error('passcode guard unavailable', name);
}

// Runs before every /api route. A request without x-app-pass (or a server without APP_PASSCODE) isn't guarded: it can't
// be the owner's anyway. → {refuse: Response} (429 refused, 503 the guard is unreachable: nothing is compared without
// it) | {cookie?: Set-Cookie value} (go on: the routes then compare the passcode themselves, with the same result).
// ctx: the Worker's execution context (waitUntil for the background sync of burned clearances).
export async function passcodeGate(req, env, passOk, ctx = null) {
  const presented = req.headers.get('x-app-pass');
  if (!presented || !env?.APP_PASSCODE) return {};
  const now = Date.now();
  const relax = env.GUARD_RELAX === '1';
  let want, burn = null;
  try {
    want = await wantOf(env);
    // The owner's device: a valid clearance that isn't burned, and the right passcode, are checked here alone.
    const c = readCookie(req, CLEAR_COOKIE) ? await clearanceOf(req, env, want, now) : null;
    if (c) {
      syncBurns(env, ctx, now);
      if (!isBurned(c.id, now)) {
        if (passOk(req, env)) return { cookie: c.exp - now < CLEAR_MS - GUARD.clearRefreshMs ? await mintClearance(c.key, now) : null };
        burn = { id: c.id, until: c.exp }; // a wrong passcode with it: burned here at once, and reported with this guess
        burnLocally(c.id, c.exp, now);
      }
    }
  } catch (err) { logGuardError(err); return { refuse: unavailable() }; }
  // Everything else goes to the Guard, after the per-network throttle (a burn is always reported).
  const throttle = await shed(req, env);
  if (throttle === 'over' && !burn) return { refuse: refusal({ verdict: 'shed', retryAfter: 60 }) };
  try {
    const v = await guardStub(env).attempt(ipKey(req.headers.get('cf-connecting-ip')), await sha256hex(presented), want, { relax, ...(burn ? { burn } : {}) });
    if (v?.verdict === 'ok') { const key = await clearKeyOf(env, want); return { cookie: key ? await mintClearance(key, now) : null }; }
    if (v?.verdict === 'wrong') return {};
    return { refuse: refusal(v) };
  } catch (err) {
    logGuardError(err);
    // GUARD_RELAX: the Guard down, the per-network throttle above stands alone; the routes compare the passcode.
    if (relax && throttle === 'ok') return {};
    return { refuse: unavailable() };
  }
}
