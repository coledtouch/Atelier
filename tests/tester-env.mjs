// Shared fakes for the tester tests (not a test file itself). The Ledger runs as the real class on an in-memory
// SQLite shim (node:sqlite) behind a stub that structured-clones arguments and results like Workers RPC does.
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export class DurableObject {} export const waitUntil = () => {};', shortCircuit: true };
    return next(specifier, context);
  },
});
const emitWarning = process.emitWarning;
process.emitWarning = (w, ...rest) => (/SQLite is an experimental/.test(String(w)) ? undefined : emitWarning.call(process, w, ...rest));
const { DatabaseSync } = await import('node:sqlite');

export const worker = (await import('../src/worker.js')).default;
export const { Ledger } = await import('../src/tester/ledger.js');
export const { resetTesterCaches, sha256, COOKIE } = await import('../src/tester/auth.js');

// ctx.storage for a SQLite-backed Durable Object: sql.exec (one statement), transactionSync, alarms.
export function sqlCtx() {
  const db = new DatabaseSync(':memory:');
  let alarm = null, depth = 0;
  const exec = (query, ...bindings) => {
    for (const b of bindings) if (b === undefined || typeof b === 'boolean') throw new TypeError(`unsupported binding ${b}`);
    const stmt = db.prepare(query);
    const rows = stmt.all(...bindings).map((r) => ({ ...r }));
    return { toArray: () => rows, one: () => { if (rows.length !== 1) throw new Error('expected one row'); return rows[0]; }, [Symbol.iterator]: () => rows[Symbol.iterator]() };
  };
  const transactionSync = (fn) => {
    const sp = `sp${depth++}`;
    db.exec(`SAVEPOINT ${sp}`);
    try { const r = fn(); db.exec(`RELEASE ${sp}`); return r; } catch (e) { db.exec(`ROLLBACK TO ${sp}`); db.exec(`RELEASE ${sp}`); throw e; } finally { depth--; }
  };
  return {
    db, alarm: () => alarm,
    ctx: {
      storage: { sql: { exec }, transactionSync, getAlarm: async () => alarm, setAlarm: async (t) => { alarm = Number(t); }, deleteAlarm: async () => { alarm = null; } },
      blockConcurrencyWhile: (fn) => fn(),
    },
  };
}

// A real Ledger + its namespace binding. ns.calls lists every RPC method called through the binding.
export function makeLedger(env = {}) {
  const shim = sqlCtx();
  const ledger = new Ledger(shim.ctx, env);
  const calls = [];
  const stub = new Proxy({}, {
    get(_, name) {
      if (name === 'then') return undefined;
      return async (...args) => {
        calls.push(name);
        if (typeof ledger[name] !== 'function' || String(name).startsWith('#')) throw new Error(`no RPC method ${String(name)}`);
        const r = await ledger[name](...structuredClone(args));
        return r === undefined ? r : structuredClone(r);
      };
    },
  });
  const ns = { calls, idFromName: (n) => `id:${n}`, get: () => stub };
  return { ledger, ns, stub, shim, calls };
}

export function fakeKV(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, async get(k, type) { const v = m.get(k); return v == null ? null : type === 'json' ? JSON.parse(v) : v; }, async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); } };
}

export const KEYS = {
  APP_PASSCODE: 'pw', ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-openai-test', GEMINI_API_KEY: 'AQ.test-gemini-key-0123456789abcdef',
  ZAI_API_KEY: 'zai-test', DEEPSEEK_API_KEY: 'ds-test', META_API_KEY: 'meta-test', NVIDIA_API_KEY: 'nvapi-test',
  LINKEDIN_CLIENT_ID: 'li-client', LINKEDIN_CLIENT_SECRET: 'li-secret-xyz',
};
// env with every provider key, a fake KV and a real Ledger (pass ledger: null for none).
export function makeEnv({ ledger = makeLedger(), ...extra } = {}) {
  return { env: { ...KEYS, ATELIER_KV: fakeKV(), ...(ledger ? { LEDGER: ledger.ns } : {}), ...extra }, L: ledger };
}

// ── fetch mock: routes [regex on "METHOD url", handler(call)]; an unmatched call throws ──
export const realFetch = globalThis.fetch;
export const upstream = { calls: [] };
export function mockFetch(routes = []) {
  upstream.calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const call = { url: String(input), method: init.method || 'GET', headers: new Headers(init.headers), body: init.body };
    if (typeof call.body === 'string') { try { call.json = JSON.parse(call.body); } catch {} }
    upstream.calls.push(call);
    for (const [pattern, handler] of routes) if (pattern.test(`${call.method} ${call.url}`)) return handler(call);
    throw new Error(`unmocked fetch ${call.method} ${call.url}`);
  };
}
export const restoreFetch = () => { globalThis.fetch = realFetch; };
export const reply = (status, body, headers = {}) => new Response(body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
export const sseOf = (events) => new Response(new ReadableStream({ start(c) { for (const e of events) c.enqueue(new TextEncoder().encode(e)); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } });

export const ORIGIN = 'https://atelier.ciprari.ai';
// worker.fetch on /api/<path>. who: {pass, cookie, origin}. Non-GET tester calls get the app Origin unless origin: null.
export function api(env, path, init = {}, { pass, cookie, origin = ORIGIN } = {}) {
  const headers = { ...(init.headers || {}) };
  if (pass) headers['x-app-pass'] = pass;
  if (cookie) headers.cookie = `${COOKIE}=${cookie}`;
  if (origin && init.method && init.method !== 'GET') headers.origin = origin;
  const body = init.body !== undefined && typeof init.body !== 'string' && !(init.body instanceof Uint8Array) && !(init.body instanceof ReadableStream) ? JSON.stringify(init.body) : init.body;
  return worker.fetch(new Request(`https://atelier.ciprari.ai/api/${path}`, { ...init, body, headers, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) }), env);
}

let n = 0;
export const PROFILE = (i = ++n) => ({ sub: `sub-${i}`, name: `Tester ${i}`, email: `t${i}@example.com`, picture: `https://media.licdn.com/p/${i}.jpg` });
// Admits a tester straight through the Ledger (paused off unless keepPaused) → {token, sub, profile}.
export async function signIn(L, profile = PROFILE(), { keepPaused = false } = {}) {
  if (!keepPaused) L.ledger.setConfig({ paused: false });
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  const r = L.ledger.admit(profile, await sha256(token));
  if (r.status !== 'admitted') throw new Error(`not admitted: ${r.status}`);
  return { token, sub: profile.sub, profile };
}
export const allowanceOf = (res) => JSON.parse(res.headers.get('x-tester-allowance'));
export const bodyOf = async (res) => { const t = await res.text(); try { return JSON.parse(t); } catch { return t; } };
