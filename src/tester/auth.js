// LinkedIn tester sign-in (OpenID Connect), the tester session cookie and identify() (spec §5, addendum A1, A4, A7b).
// Public routes: GET /api/li/start, GET /api/li/callback, GET /api/li/spots, POST /api/li/logout.
// The LinkedIn access token is used once for userinfo and never stored or logged; neither are codes or cookies.

export const COOKIE = '__Host-atelier_tester';
const STATE_COOKIE = '__Host-atelier_li';
export const APP_ORIGIN = 'https://atelier.ciprari.ai';
export const DEV_ORIGIN = 'http://127.0.0.1:8787';
// CSRF: a tester's non-GET request must come from the app itself (spec §5).
export const ALLOWED_ORIGINS = new Set([APP_ORIGIN, DEV_ORIGIN]);
export const LI_SCOPE = 'openid profile email'; // never w_member_social
export const LI_AUTHORIZE = 'https://www.linkedin.com/oauth/v2/authorization';
export const LI_TOKEN = 'https://www.linkedin.com/oauth/v2/accessToken';
export const LI_USERINFO = 'https://api.linkedin.com/v2/userinfo';
const SESSION_SECONDS = 30 * 86400;
const CACHE_MS = 60_000, CACHE_MAX = 1000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };
export const fail = (status, code, error, extra = {}, headers = {}) =>
  new Response(JSON.stringify({ error, code, ...extra }), { status, headers: { ...JSON_HEADERS, ...headers } });

export const ledger = (env) => (env?.LEDGER ? env.LEDGER.get(env.LEDGER.idFromName('main')) : null);

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
export async function sha256(text) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function readCookie(req, name) {
  for (const part of (req.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}
const cookie = (name, value, maxAge, sameSite = 'Strict') => `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=${sameSite}`;
export const sessionCookie = (token) => cookie(COOKIE, token, SESSION_SECONDS);
export const clearSession = () => cookie(COOKIE, '', 0);

// ── identity ──
const identities = new Map(); // sha256(token) → {who, exp}: a 60 s per-isolate cache; revocation lag is bounded by it
let spotsCache = null;
export function resetTesterCaches() { identities.clear(); spotsCache = null; }
export const forgetSession = (hash) => identities.delete(hash);

// owner (passcode, wins over a cookie) → tester (live session cookie) → none. A cookie that no longer matches a session
// gives {kind:'none', stale:true}, so the caller can answer "sign in again" instead of asking for a passcode.
export async function identify(req, env, passOk) {
  if (passOk(req, env)) return { kind: 'owner' };
  const token = readCookie(req, COOKIE);
  if (!token) return { kind: 'none' };
  const stub = ledger(env);
  if (!stub || !TOKEN.test(token)) return { kind: 'none', stale: true };
  const hash = await sha256(token), now = Date.now(), hit = identities.get(hash);
  if (hit && hit.exp > now) return hit.who;
  const t = await stub.session(hash);
  const who = t ? { kind: 'tester', sub: t.sub, name: t.name, email: t.email, picture: t.picture, hash } : { kind: 'none', stale: true };
  if (identities.size >= CACHE_MAX) {
    // A flood of made-up cookies evicts its own misses and expired entries first, never the live testers behind them.
    for (const [k, v] of identities) if (v.who.kind !== 'tester' || v.exp <= now) identities.delete(k);
    if (identities.size >= CACHE_MAX) identities.delete(identities.keys().next().value);
  }
  identities.set(hash, { who, exp: now + CACHE_MS });
  return who;
}

export const signedOut = () => fail(401, 'tester_signin', 'Your tester session ended — sign in with LinkedIn again.', {}, { 'set-cookie': clearSession() });

// ── LinkedIn OpenID Connect ──
// The callback URL LinkedIn returns to (both are registered in the LinkedIn app, A1).
export const redirectUri = (url) => `${url.origin === DEV_ORIGIN ? DEV_ORIGIN : APP_ORIGIN}/api/li/callback`;

// A relative Location keeps dev (127.0.0.1:8787) and production on their own origin.
function back(result, cookies = []) {
  const headers = new Headers({ location: `/?tester=${result}`, 'cache-control': 'no-store' });
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(null, { status: 302, headers });
}

function claimsOf(jwt) {
  try {
    const part = String(jwt).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part.padEnd(Math.ceil(part.length / 4) * 4, '=')), (c) => c.charCodeAt(0))));
  } catch { return null; }
}
const clean = (v, max) => (typeof v === 'string' ? v : '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
function httpsUrl(v) {
  try { const u = new URL(String(v)); return u.protocol === 'https:' && u.href.length <= 1024 ? u.href : ''; } catch { return ''; }
}

// code → {sub, name, email, picture}. The ID token comes straight from LinkedIn's token endpoint over TLS, so its nonce,
// audience, expiry and subject are checked without a signature check (OIDC Core 3.1.3.7).
export async function linkedInProfile(env, code, redirect_uri, nonce) {
  const client_id = env.LINKEDIN_CLIENT_ID;
  const r = await fetch(LI_TOKEN, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id, client_secret: env.LINKEDIN_CLIENT_SECRET, redirect_uri }).toString(),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || typeof j.access_token !== 'string') throw new Error(`token exchange ${r.status} ${clean(j.error, 60)}`);
  const id = claimsOf(j.id_token);
  const aud = Array.isArray(id?.aud) ? id.aud : [id?.aud];
  // LinkedIn leaves nonce out of its ID tokens (it isn't in its claims_supported), so a nonce is checked only when one is
  // present; the single-use state cookie already ties the code to the browser that started. The log names the claim.
  const why = !id ? 'unreadable' : id.nonce !== undefined && id.nonce !== nonce ? 'nonce' : !aud.includes(client_id) ? 'aud'
    : !(Number(id.exp) * 1000 > Date.now()) ? 'exp' : '';
  if (why) throw new Error(`id token rejected: ${why}`);
  const u = await fetch(LI_USERINFO, { headers: { authorization: `Bearer ${j.access_token}`, accept: 'application/json' }, redirect: 'manual' });
  const p = await u.json().catch(() => null);
  if (!u.ok || !p || typeof p.sub !== 'string' || p.sub !== id.sub || !/^[A-Za-z0-9_-]{1,128}$/.test(p.sub)) throw new Error(`userinfo ${u.status}`);
  const email = clean(p.email, 254);
  return {
    sub: p.sub,
    name: clean(p.name, 120) || clean([p.given_name, p.family_name].filter((x) => typeof x === 'string').join(' '), 120),
    email: /^[^\s@]+@[^\s@]+$/.test(email) ? email : '',
    picture: httpsUrl(p.picture),
  };
}

// Per-IP throttle (the LI_LIMIT rate-limit binding) on the routes that write to or read from the Ledger for anyone.
async function throttled(req, env) {
  if (!env.LI_LIMIT) return false;
  try { return !(await env.LI_LIMIT.limit({ key: req.headers.get('cf-connecting-ip') || 'unknown' })).success; } catch { return false; }
}

// /api/li/* for everyone (owner, tester or nobody). path is relative to /api/.
export async function handleLinkedIn(req, env, url, path) {
  const stub = ledger(env);

  // GET /api/li/spots → {spotsLeft, cap, paused}: public, no personal data, cached 60 s per isolate.
  if (path === 'li/spots' && req.method === 'GET') {
    if (!spotsCache || spotsCache.exp <= Date.now()) {
      const value = stub ? await stub.spots() : { spotsLeft: 0, cap: 0, paused: true };
      spotsCache = { value, exp: Date.now() + CACHE_MS };
    }
    return new Response(JSON.stringify(spotsCache.value), { headers: JSON_HEADERS });
  }

  // GET /api/li/start → LinkedIn's consent screen, with a single-use state + nonce (10 minutes) bound to this browser.
  if (path === 'li/start' && req.method === 'GET') {
    if (!env.LINKEDIN_CLIENT_ID || !env.LINKEDIN_CLIENT_SECRET || !stub || (await throttled(req, env))) return back('error');
    const state = randomToken(), nonce = randomToken();
    if (!(await stub.putState(state, nonce))) return back('error');
    const q = new URLSearchParams({ response_type: 'code', client_id: env.LINKEDIN_CLIENT_ID, redirect_uri: redirectUri(url), state, scope: LI_SCOPE, nonce });
    const headers = new Headers({ location: `${LI_AUTHORIZE}?${q.toString().replace(/\+/g, '%20')}`, 'cache-control': 'no-store' });
    headers.append('set-cookie', cookie(STATE_COOKIE, state, 600, 'Lax')); // Lax: it must come back on LinkedIn's redirect
    return new Response(null, { status: 302, headers });
  }

  // GET /api/li/callback → /?tester=welcome|full|revoked|paused|denied|error (+ the session cookie on welcome)
  if (path === 'li/callback' && req.method === 'GET') {
    const done = (result, extra = []) => back(result, [cookie(STATE_COOKIE, '', 0, 'Lax'), ...extra]);
    const state = url.searchParams.get('state') || '';
    if (!stub || !TOKEN.test(state) || (await throttled(req, env))) return done('error');
    const nonce = await stub.takeState(state); // consumed before anything else can fail
    if (!nonce || readCookie(req, STATE_COOKIE) !== state) return done('error');
    const denied = url.searchParams.get('error');
    if (denied) return done(/cancel|denied/i.test(denied) ? 'denied' : 'error');
    const code = url.searchParams.get('code') || '';
    if (!code || code.length > 2048) return done('error');
    let profile;
    try {
      profile = await linkedInProfile(env, code, redirectUri(url), nonce);
    } catch (err) {
      console.warn('linkedin sign-in failed:', String(err?.message || err).slice(0, 120));
      return done('error');
    }
    const token = randomToken();
    const { status } = await stub.admit(profile, await sha256(token));
    return status === 'admitted' ? done('welcome', [sessionCookie(token)]) : done(status);
  }

  // POST /api/li/logout → 204: ends this browser's tester session (if any) and clears the cookie.
  if (path === 'li/logout' && req.method === 'POST') {
    if (!ALLOWED_ORIGINS.has(req.headers.get('origin') || '')) return fail(403, 'tester_origin', 'Sign out from the Atelier app itself.');
    const token = readCookie(req, COOKIE);
    if (stub && TOKEN.test(token)) {
      const hash = await sha256(token);
      await stub.logout(hash);
      forgetSession(hash);
    }
    return new Response(null, { status: 204, headers: { 'set-cookie': clearSession(), 'cache-control': 'no-store' } });
  }
  return fail(404, 'not_found', 'Not found');
}
