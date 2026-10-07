// Ledger: the LinkedIn tester roster, sessions, job ownership and the spend meter (spec §5-§7, §9; addendum A2-A4, A7b).
// One instance ("main") with SQLite storage. Money is integer micro-dollars; days and months are UTC.
// Every RPC method runs its reads and writes synchronously inside transactionSync, so each call is atomic and
// interleaved callers can never push a tester or the pool past a limit.
import { DurableObject } from 'cloudflare:workers';

export const DEFAULTS = Object.freeze({ cap: 25, paused: 1, day_limit: 1_000_000, month_limit: 10_000_000, pool_limit: 100_000_000, preview_subs: '[]' });
// Owner-settable bounds. The pool can't go above $1,000 without a code change (spec §9).
export const MAX = Object.freeze({ cap: 1000, day_limit: 100_000_000, month_limit: 1_000_000_000, pool_limit: 1_000_000_000, preview_subs: 50 });
export const SUB = /^[A-Za-z0-9_-]{1,128}$/;
export const DAILY_UPLOADS = 10; // video clips a tester may start per UTC day (each is held at Google for 48 hours)
// settle records the provider-reported cost even above the reservation (an estimate gap shows up in the day, month and
// pool totals, so the next reserve sees it), but never more than this many times the reservation.
export const OVERRUN = 4;
const MINUTE = 60_000, DAY = 86_400_000;
const STATE_TTL = 10 * MINUTE, STALE = 15 * MINUTE, TICK = 10 * MINUTE, SESSION_TTL = 30 * DAY, RETAIN = 90 * DAY, JOB_TTL = 7 * DAY;
// The last refused sign-in (A4) names someone who is not a tester (LinkedIn ID, name, photo link): it is kept this long
// for the owner's Testers panel, then dropped when read and deleted by the alarm (privacy page §6).
export const REFUSED_TTL = 7 * DAY;
const SESSIONS_PER_TESTER = 10;
const MAX_STATES = 2000; // sign-ins in flight (10 minutes each); a flood of /api/li/start can't grow the table past it

export const dayKey = (t) => new Date(t).toISOString().slice(0, 10);
export const monthKey = (t) => new Date(t).toISOString().slice(0, 7);
// When a refused budget scope opens again (ISO), or null for a per-call refusal.
export function resetsAt(scope, t = Date.now()) {
  const d = new Date(t);
  if (scope === 'day') return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
  if (scope === 'month' || scope === 'pool') return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
  return null;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS testers (sub TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
    picture TEXT NOT NULL DEFAULT '', joined_at INTEGER NOT NULL, revoked_at INTEGER, last_seen INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS spend (sub TEXT NOT NULL, period TEXT NOT NULL, spent INTEGER NOT NULL DEFAULT 0,
    reserved INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (sub, period))`,
  'CREATE TABLE IF NOT EXISTS pool (month TEXT PRIMARY KEY, spent INTEGER NOT NULL DEFAULT 0, reserved INTEGER NOT NULL DEFAULT 0)',
  `CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, sub TEXT NOT NULL, amount INTEGER NOT NULL, day TEXT NOT NULL,
    month TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS reservations_age ON reservations (created_at)',
  'CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, sub TEXT NOT NULL, exp INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS sessions_sub ON sessions (sub)',
  'CREATE TABLE IF NOT EXISTS oauth_state (state TEXT PRIMARY KEY, nonce TEXT NOT NULL, exp INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS oauth_state_exp ON oauth_state (exp)',
  `CREATE TABLE IF NOT EXISTS jobs (upstream_id TEXT PRIMARY KEY, sub TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL,
    reservation TEXT, actual INTEGER)`,
  'CREATE INDEX IF NOT EXISTS jobs_sub ON jobs (sub, kind, created_at)',
  'CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS profiles (sub TEXT PRIMARY KEY, doc TEXT NOT NULL, updated_at INTEGER NOT NULL)',
];

const str = (v, max) => (typeof v === 'string' ? v : '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
const parseSubs = (v) => { try { const a = JSON.parse(v); return Array.isArray(a) ? a.filter((s) => SUB.test(s)) : []; } catch { return []; } };
const intIn = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v <= hi;

export class Ledger extends DurableObject {
  #syncEnv;
  #cleanupContext;
  constructor(ctx, env) {
    super(ctx, env);
    this.storage = ctx.storage;
    this.#syncEnv = env;
    this.#cleanupContext = ctx;
    this.clock = () => Date.now();
    ctx.blockConcurrencyWhile(async () => {
      for (const s of SCHEMA) this.storage.sql.exec(s);
      // A fresh Ledger starts paused (A7b): the first deploy is safe without a manual step.
      for (const [k, v] of Object.entries(DEFAULTS)) this.storage.sql.exec('INSERT OR IGNORE INTO config (k, v) VALUES (?, ?)', k, String(v));
      if ((await this.storage.getAlarm()) == null) await this.storage.setAlarm(Date.now() + TICK);
    });
  }

  // ── private helpers (never reachable over RPC) ──
  #rows(q, ...b) { return this.storage.sql.exec(q, ...b).toArray(); }
  #row(q, ...b) { return this.#rows(q, ...b)[0] || null; }
  #run(q, ...b) { this.storage.sql.exec(q, ...b); }
  #tx(fn) { return this.storage.transactionSync(fn); }
  #config() {
    const c = Object.fromEntries(this.#rows('SELECT k, v FROM config').map((r) => [r.k, r.v]));
    return {
      cap: Number(c.cap), paused: c.paused === '1', day_limit: Number(c.day_limit), month_limit: Number(c.month_limit),
      pool_limit: Number(c.pool_limit), preview_subs: parseSubs(c.preview_subs),
    };
  }
  #tester(sub) { return typeof sub === 'string' ? this.#row('SELECT * FROM testers WHERE sub = ?', sub) : null; }
  #spend(sub, period) { return this.#row('SELECT spent, reserved FROM spend WHERE sub = ? AND period = ?', sub, period) || { spent: 0, reserved: 0 }; }
  #pool(month) { return this.#row('SELECT spent, reserved FROM pool WHERE month = ?', month) || { spent: 0, reserved: 0 }; }
  #active() { return this.#row('SELECT COUNT(*) AS n FROM testers WHERE revoked_at IS NULL').n; }
  #spotsLeft(c) { return Math.max(0, c.cap - this.#active()); }
  #blocked(sub, c) { return c.paused && !c.preview_subs.includes(sub); }
  #allowance(sub, c = this.#config()) {
    const now = this.clock(), d = this.#spend(sub, dayKey(now)), m = this.#spend(sub, monthKey(now)), p = this.#pool(monthKey(now));
    const preview = c.paused && c.preview_subs.includes(sub);
    return {
      day: { spent: d.spent, reserved: d.reserved, limit: c.day_limit },
      month: { spent: m.spent, reserved: m.reserved, limit: c.month_limit },
      pool: { spent: p.spent, reserved: p.reserved, limit: c.pool_limit },
      paused: c.paused && !preview, preview, spotsLeft: this.#spotsLeft(c),
    };
  }
  #refused(profile, now) {
    const v = JSON.stringify({ sub: profile.sub, name: str(profile.name, 120), picture: str(profile.picture, 1024), at: now });
    this.#run('INSERT INTO config (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v', 'last_refused', v);
  }
  // → the last refused sign-in while it is under REFUSED_TTL old, else null; a stale, undated or unreadable record is
  // deleted on the way (a single statement, so this is safe outside a transaction).
  #lastRefused(now) {
    const row = this.#row("SELECT v FROM config WHERE k = 'last_refused'");
    if (!row) return null;
    let v = null;
    try { v = JSON.parse(row.v); } catch {}
    if (v && typeof v === 'object' && Number.isFinite(v.at) && v.at > now - REFUSED_TTL) return v;
    this.#run("DELETE FROM config WHERE k = 'last_refused'");
    return null;
  }
  #settle(id, actual) {
    const r = this.#row('SELECT * FROM reservations WHERE id = ?', String(id));
    if (!r) return null;
    const a = Number(actual);
    // The reported cost, bounded at OVERRUN x the reservation; anything unreadable keeps the full reservation.
    const charge = Number.isFinite(a) ? Math.min(r.amount * OVERRUN, Math.max(0, Math.ceil(a))) : r.amount;
    for (const period of [r.day, r.month]) {
      this.#run('UPDATE spend SET reserved = MAX(0, reserved - ?), spent = spent + ? WHERE sub = ? AND period = ?', r.amount, charge, r.sub, period);
    }
    this.#run('UPDATE pool SET reserved = MAX(0, reserved - ?), spent = spent + ? WHERE month = ?', r.amount, charge, r.month);
    this.#run('DELETE FROM reservations WHERE id = ?', r.id);
    return { sub: r.sub, charged: charge, reserved: r.amount };
  }
  #forget(sub) {
    for (const t of ['testers', 'sessions', 'spend', 'jobs', 'profiles']) this.#run(`DELETE FROM ${t} WHERE sub = ?`, sub);
  }

  // ── sign-in (OIDC state, admission, sessions) ──
  // → false when MAX_STATES sign-ins are already in flight.
  putState(state, nonce) {
    const now = this.clock();
    return this.#tx(() => {
      this.#run('DELETE FROM oauth_state WHERE exp <= ?', now);
      if (this.#row('SELECT COUNT(*) AS n FROM oauth_state').n >= MAX_STATES) return false;
      this.#run('INSERT OR REPLACE INTO oauth_state (state, nonce, exp) VALUES (?, ?, ?)', String(state), String(nonce), now + STATE_TTL);
      return true;
    });
  }
  // Single use: the state is deleted whether or not it is still valid. → nonce | null
  takeState(state) {
    return this.#tx(() => {
      const r = this.#row('SELECT nonce, exp FROM oauth_state WHERE state = ?', String(state));
      if (!r) return null;
      this.#run('DELETE FROM oauth_state WHERE state = ?', String(state));
      return r.exp > this.clock() ? r.nonce : null;
    });
  }
  // → {status: 'admitted' | 'full' | 'revoked' | 'paused'}; on 'admitted' the session (sha256 of the cookie token) is stored.
  admit(profile, tokenHash) {
    if (!profile || !SUB.test(profile.sub)) throw new Error('admit: bad profile');
    return this.#tx(() => {
      const now = this.clock(), c = this.#config(), t = this.#tester(profile.sub);
      const refuse = (status) => { this.#refused(profile, now); return { status }; };
      if (t?.revoked_at) return refuse('revoked');
      if (this.#blocked(profile.sub, c)) return refuse('paused');
      const name = str(profile.name, 120), email = str(profile.email, 254), picture = str(profile.picture, 1024);
      if (!t) {
        if (this.#active() >= c.cap) return refuse('full');
        this.#run('INSERT INTO testers (sub, name, email, picture, joined_at, revoked_at, last_seen) VALUES (?, ?, ?, ?, ?, NULL, ?)', profile.sub, name, email, picture, now, now);
      } else {
        this.#run('UPDATE testers SET name = ?, email = ?, picture = ?, last_seen = ? WHERE sub = ?', name, email, picture, now, profile.sub);
      }
      if (tokenHash) {
        this.#run('INSERT OR REPLACE INTO sessions (token_hash, sub, exp) VALUES (?, ?, ?)', String(tokenHash), profile.sub, now + SESSION_TTL);
        this.#run(`DELETE FROM sessions WHERE sub = ? AND token_hash NOT IN
          (SELECT token_hash FROM sessions WHERE sub = ? ORDER BY exp DESC LIMIT ${SESSIONS_PER_TESTER})`, profile.sub, profile.sub);
      }
      return { status: 'admitted' };
    });
  }
  // → {sub, name, email, picture} for a live session of a tester who isn't revoked, else null.
  session(tokenHash) {
    return this.#tx(() => {
      const now = this.clock();
      const r = this.#row(`SELECT s.sub, s.exp, t.name, t.email, t.picture, t.revoked_at, t.last_seen FROM sessions s
        JOIN testers t ON t.sub = s.sub WHERE s.token_hash = ?`, String(tokenHash));
      if (!r || r.exp <= now || r.revoked_at != null) return null;
      if (now - r.last_seen > 10 * MINUTE) this.#run('UPDATE testers SET last_seen = ? WHERE sub = ?', now, r.sub);
      return { sub: r.sub, name: r.name, email: r.email, picture: r.picture };
    });
  }
  logout(tokenHash) { this.#run('DELETE FROM sessions WHERE token_hash = ?', String(tokenHash)); return true; }

  // ── the meter ──
  // → {ok: true, id, allowance} | {ok: false, scope: 'signin' | 'paused' | 'day' | 'month' | 'pool', resetsAt?, allowance?}
  reserve(sub, amount) {
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('reserve: amount must be whole micro-dollars');
    return this.#tx(() => {
      const t = this.#tester(sub);
      if (!t || t.revoked_at != null) return { ok: false, scope: 'signin' };
      const c = this.#config();
      if (this.#blocked(sub, c)) return { ok: false, scope: 'paused' };
      const now = this.clock(), day = dayKey(now), month = monthKey(now);
      const over = (row, limit) => row.spent + row.reserved + amount > limit;
      const scope = over(this.#spend(sub, day), c.day_limit) ? 'day' : over(this.#spend(sub, month), c.month_limit) ? 'month'
        : over(this.#pool(month), c.pool_limit) ? 'pool' : null;
      if (scope) return { ok: false, scope, resetsAt: resetsAt(scope, now), allowance: this.#allowance(sub, c) };
      const id = crypto.randomUUID();
      this.#run('INSERT INTO reservations (id, sub, amount, day, month, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, sub, amount, day, month, now);
      for (const period of [day, month]) {
        this.#run(`INSERT INTO spend (sub, period, spent, reserved) VALUES (?, ?, 0, ?)
          ON CONFLICT (sub, period) DO UPDATE SET reserved = reserved + excluded.reserved`, sub, period, amount);
      }
      this.#run('INSERT INTO pool (month, spent, reserved) VALUES (?, 0, ?) ON CONFLICT (month) DO UPDATE SET reserved = reserved + excluded.reserved', month, amount);
      return { ok: true, id, allowance: this.#allowance(sub, c) };
    });
  }
  // Moves a reservation to spent at the actual cost (at most OVERRUN x reserved). Unknown or already-settled ids → null.
  settle(id, actual) {
    return this.#tx(() => {
      const s = this.#settle(id, actual);
      return s && { charged: s.charged, reserved: s.reserved, allowance: this.#allowance(s.sub) };
    });
  }
  // → the allowance for a tester who isn't revoked, else null.
  allowance(sub) {
    const t = this.#tester(sub);
    return t && t.revoked_at == null ? this.#allowance(sub) : null;
  }
  // Reservations older than 15 minutes (aborted streams, crashed isolates, unpolled Veo jobs) settle at the full amount.
  expireStale() {
    return this.#tx(() => {
      const stale = this.#rows('SELECT id, amount FROM reservations WHERE created_at <= ?', this.clock() - STALE);
      for (const r of stale) this.#settle(r.id, r.amount);
      return stale.length;
    });
  }
  async alarm() {
    const now = this.clock();
    this.expireStale();
    this.#tx(() => {
      this.#run('DELETE FROM sessions WHERE exp <= ?', now);
      this.#run('DELETE FROM oauth_state WHERE exp <= ?', now);
      this.#run('DELETE FROM jobs WHERE created_at <= ?', now - JOB_TTL);
      // ...and a refused sign-in goes 7 days after the attempt, whether or not the owner ever looked at it.
      this.#lastRefused(now);
    });
    // Retention includes the new private R2 namespace. Keep the record until its cloud data is gone, so a failed
    // or partial R2 cleanup never becomes an orphan. Revocation alone does not delete work (the owner can restore it).
    const { purgeTesterSync } = await import('./sync.js');
    for (const { sub } of this.#rows('SELECT sub FROM testers WHERE last_seen <= ?', now - RETAIN)) {
      try {
        await this.#cleanupContext.blockConcurrencyWhile(async () => {
          const current = this.#tester(sub);
          if (!current || current.last_seen > now - RETAIN) return;
          try {
            const result = await purgeTesterSync(this.#syncEnv, sub);
            if (result.complete) this.#tx(() => this.#forget(sub));
          } catch {
            // Catch inside the concurrency gate too: a storage outage must not reset the Durable Object.
            console.warn('tester cloud retention cleanup will retry');
          }
        });
      } catch {
        // No subject, profile, path or error payload is logged. The next ten-minute alarm retries this record.
        console.warn('tester cloud retention cleanup will retry');
      }
    }
    await this.storage.setAlarm(Date.now() + TICK);
  }

  // ── ownership of upstream jobs (upload sessions, Gemini files, Veo operations) ──
  // → {ok: true, slot} | {ok: false, scope: 'signin' | 'paused' | 'day', resetsAt?}: may this tester start another clip
  // upload? The check and the slot it takes are one atomic step, so parallel starts can't all pass the count.
  uploadGate(sub) {
    return this.#tx(() => {
      const t = this.#tester(sub);
      if (!t || t.revoked_at != null) return { ok: false, scope: 'signin' };
      const c = this.#config(), now = this.clock();
      if (this.#blocked(sub, c)) return { ok: false, scope: 'paused' };
      const since = Date.parse(`${dayKey(now)}T00:00:00Z`);
      const n = this.#row("SELECT COUNT(*) AS n FROM jobs WHERE sub = ? AND kind = 'upload_slot' AND created_at >= ?", sub, since).n;
      if (n >= DAILY_UPLOADS) return { ok: false, scope: 'day', resetsAt: resetsAt('day', now) };
      const slot = `slot:${crypto.randomUUID()}`;
      this.#run("INSERT INTO jobs (upstream_id, sub, kind, created_at) VALUES (?, ?, 'upload_slot', ?)", slot, sub, now);
      return { ok: true, slot };
    });
  }
  // Gives back an upload slot whose start failed (nothing was created at Google).
  dropSlot(sub, slot) { this.#run("DELETE FROM jobs WHERE upstream_id = ? AND sub = ? AND kind = 'upload_slot'", String(slot), String(sub)); return true; }
  // Records an upstream id for a tester; the first owner keeps it. extra: {reservation, actual} for a Veo operation.
  addJob(sub, id, kind, extra = {}) {
    this.#run('INSERT OR IGNORE INTO jobs (upstream_id, sub, kind, created_at, reservation, actual) VALUES (?, ?, ?, ?, ?, ?)',
      String(id), String(sub), String(kind), this.clock(), extra.reservation ?? null, Number.isSafeInteger(extra.actual) ? extra.actual : null);
    return true;
  }
  ownsJob(sub, id) { return Boolean(this.#row('SELECT 1 AS y FROM jobs WHERE upstream_id = ? AND sub = ?', String(id), String(sub))); }
  // A video job (a Gemini Omni interaction) finished: settle its reservation at the video's price when one was produced,
  // else at $0. actual: the cost from the provider's reported usage, when it reported one (else the price recorded at
  // addJob). Idempotent.
  finishJob(sub, id, produced, actual = null) {
    return this.#tx(() => {
      const j = this.#row('SELECT reservation, actual FROM jobs WHERE upstream_id = ? AND sub = ?', String(id), String(sub));
      if (!j?.reservation) return null;
      this.#run('UPDATE jobs SET reservation = NULL WHERE upstream_id = ?', String(id));
      const s = this.#settle(j.reservation, produced ? (Number.isSafeInteger(actual) && actual >= 0 ? actual : j.actual ?? Infinity) : 0);
      return s && { charged: s.charged, allowance: this.#allowance(sub) };
    });
  }

  // ── per-tester "You" profile (A3) ──
  getProfile(sub) { return this.#row('SELECT doc FROM profiles WHERE sub = ?', String(sub))?.doc ?? null; }
  putProfile(sub, doc) {
    const t = this.#tester(sub);
    if (!t || t.revoked_at != null) return false;
    this.#run('INSERT OR REPLACE INTO profiles (sub, doc, updated_at) VALUES (?, ?, ?)', sub, String(doc), this.clock());
    return true;
  }

  // ── public + owner ──
  spots() {
    const c = this.#config();
    return { spotsLeft: this.#spotsLeft(c), cap: c.cap, paused: c.paused };
  }
  roster() {
    const c = this.#config(), now = this.clock(), day = dayKey(now), month = monthKey(now), p = this.#pool(month);
    const lastRefused = this.#lastRefused(now);
    const testers = this.#rows(`SELECT t.sub, t.name, t.email, t.picture, t.joined_at, t.revoked_at, t.last_seen,
        COALESCE(d.spent, 0) AS day_spent, COALESCE(m.spent, 0) AS month_spent FROM testers t
      LEFT JOIN spend d ON d.sub = t.sub AND d.period = ? LEFT JOIN spend m ON m.sub = t.sub AND m.period = ?
      ORDER BY t.joined_at DESC`, day, month)
      .map(({ day_spent, month_spent, ...t }) => ({ ...t, day: { spent: day_spent }, month: { spent: month_spent } }));
    return { config: c, pool: { month, spent: p.spent, reserved: p.reserved }, lastRefused, testers };
  }
  // revoke: frees the spot and ends every session at once. → false when there is no such tester.
  revoke(sub) {
    return this.#tx(() => {
      if (!this.#tester(sub)) return false;
      this.#run('UPDATE testers SET revoked_at = COALESCE(revoked_at, ?) WHERE sub = ?', this.clock(), sub);
      this.#run('DELETE FROM sessions WHERE sub = ?', sub);
      return true;
    });
  }
  restore(sub) {
    return this.#tx(() => {
      if (!this.#tester(sub)) return false;
      this.#run('UPDATE testers SET revoked_at = NULL, last_seen = ? WHERE sub = ?', this.clock(), sub);
      return true;
    });
  }
  // patch: {cap?, paused?, day_limit?, month_limit?, pool_limit?, preview_subs?} → {ok: true, config} | {ok: false, error}
  setConfig(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: 'Send a JSON object of settings.' };
    const out = {};
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'paused') {
        if (![true, false, 0, 1].includes(v)) return { ok: false, error: 'paused must be true or false.' };
        out.paused = v ? '1' : '0';
      } else if (k === 'preview_subs') {
        if (!Array.isArray(v) || v.length > MAX.preview_subs || !v.every((s) => typeof s === 'string' && SUB.test(s))) {
          return { ok: false, error: `preview_subs must be a list of up to ${MAX.preview_subs} LinkedIn ids.` };
        }
        out.preview_subs = JSON.stringify([...new Set(v)]);
      } else if (Object.hasOwn(MAX, k)) {
        if (!intIn(v, 0, MAX[k])) return { ok: false, error: `${k} must be a whole number from 0 to ${MAX[k]}${k === 'cap' ? '' : ' (micro-dollars)'}.` };
        out[k] = String(v);
      } else return { ok: false, error: `Unknown setting "${String(k).slice(0, 40)}".` };
    }
    this.#tx(() => { for (const [k, v] of Object.entries(out)) this.#run('UPDATE config SET v = ? WHERE k = ?', v, k); });
    return { ok: true, config: this.#config() };
  }
}
