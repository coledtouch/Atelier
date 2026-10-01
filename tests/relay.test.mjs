import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

// relay.js imports `cloudflare:workers`; stub it (see canva.test.mjs). This stub keeps ctx/env like the real base class.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }', shortCircuit: true };
    return next(specifier, context);
  },
});

// ── Workers runtime pieces Node lacks ──
// Node's Response refuses status 101; the Workers one carries the client end of the WebSocket.
const NodeResponse = globalThis.Response;
globalThis.Response = class extends NodeResponse {
  constructor(body, init = {}) {
    const upgrade = init.status === 101;
    super(body, upgrade ? { ...init, status: 200 } : init);
    if (upgrade) { Object.defineProperty(this, 'status', { value: 101 }); this.webSocket = init.webSocket; }
  }
};
globalThis.WebSocketRequestResponsePair = class { constructor(request, response) { Object.assign(this, { request, response }); } };
class FakeSocket {
  constructor() { this.sent = []; this.closed = null; this.attachment = null; }
  send(d) { this.sent.push(d); }
  close(code, reason) { this.closed = { code, reason }; }
  serializeAttachment(a) { this.attachment = structuredClone(a); }
  deserializeAttachment() { return this.attachment; }
}
globalThis.WebSocketPair = class { constructor() { this[0] = new FakeSocket(); this[1] = new FakeSocket(); } };

const { Relay } = await import('../src/relay.js');

function fakeCtx() {
  const store = new Map(), accepted = [];
  return {
    store, accepted,
    storage: { get: async (k) => store.get(k), put: async (k, v) => { store.set(k, v); } },
    acceptWebSocket(ws, tags) { accepted.push({ ws, tags }); },
    getWebSockets(tag) { return accepted.filter((a) => a.tags.includes(tag)).map((a) => a.ws); },
    setWebSocketAutoResponse() {},
  };
}
const TOKEN = 'a'.repeat(64);
async function pairedRelay(token = TOKEN) {
  const ctx = fakeCtx(), relay = new Relay(ctx, {});
  const r = await relay.fetch(new Request('https://relay/token', { method: 'PUT', body: token }));
  assert.equal(r.status, 200);
  return { ctx, relay };
}
// Built like the Worker forwards it: GET https://relay/ws<search> with the upgrade and subprotocol headers.
const upgrade = (search = '', protocol) => new Request(`https://relay/ws${search}`, {
  headers: { upgrade: 'websocket', ...(protocol ? { 'sec-websocket-protocol': protocol } : {}) },
});

// ── WebSocket authentication: the subprotocol only ──
test('a ?token= query string no longer authenticates a browser connection', async () => {
  const { ctx, relay } = await pairedRelay();
  const r = await relay.fetch(upgrade(`?token=${TOKEN}`));
  assert.equal(r.status, 401);
  assert.match(await r.text(), /not paired/);
  assert.equal(ctx.accepted.length, 0);
});

test('?token= is ignored even next to a wrong subprotocol token or a bare "atelier" subprotocol', async () => {
  const { ctx, relay } = await pairedRelay();
  assert.equal((await relay.fetch(upgrade(`?token=${TOKEN}`, `atelier, ${'b'.repeat(64)}`))).status, 401);
  assert.equal((await relay.fetch(upgrade(`?token=${TOKEN}`, 'atelier'))).status, 401);
  assert.equal((await relay.fetch(upgrade(`?token=${TOKEN}`, `${TOKEN}`))).status, 401);
  assert.equal(ctx.accepted.length, 0);
});

test('the subprotocol token still connects, and the reply names the atelier subprotocol', async () => {
  const { ctx, relay } = await pairedRelay();
  const r = await relay.fetch(upgrade('', `atelier, ${TOKEN}`));
  assert.equal(r.status, 101);
  assert.equal(r.headers.get('sec-websocket-protocol'), 'atelier');
  assert.ok(r.webSocket);
  assert.equal(ctx.accepted.length, 1);
  assert.deepEqual(ctx.accepted[0].tags, ['browser']);
  // A stray query string next to the right subprotocol changes nothing.
  assert.equal((await relay.fetch(upgrade('?token=whatever', `atelier, ${TOKEN}`))).status, 101);
});

test('wrong, missing or unpaired tokens get 401; a plain GET gets 426', async () => {
  const { relay } = await pairedRelay();
  assert.equal((await relay.fetch(upgrade('', `atelier, ${'b'.repeat(64)}`))).status, 401);
  assert.equal((await relay.fetch(upgrade('', `atelier, ${TOKEN.slice(1)}`))).status, 401);
  assert.equal((await relay.fetch(upgrade('', 'atelier'))).status, 401);
  assert.equal((await relay.fetch(upgrade())).status, 401);
  assert.equal((await relay.fetch(new Request('https://relay/ws'))).status, 426);
  const unpaired = new Relay(fakeCtx(), {});
  assert.equal((await unpaired.fetch(upgrade('', 'atelier, '))).status, 401);
  assert.equal((await unpaired.fetch(upgrade('', `atelier, ${TOKEN}`))).status, 401);
});

test('re-pairing closes the connection made with the old token', async () => {
  const { ctx, relay } = await pairedRelay();
  await relay.fetch(upgrade('', `atelier, ${TOKEN}`));
  const server = ctx.accepted[0].ws;
  await relay.fetch(new Request('https://relay/token', { method: 'PUT', body: 'c'.repeat(64) }));
  assert.deepEqual(server.closed, { code: 4001, reason: 'repaired' });
  assert.equal((await relay.fetch(upgrade('', `atelier, ${TOKEN}`))).status, 401);
});

// ── commands ──
test('a command reaches the browser, and a refusal from the extension comes back to the app as an error', async () => {
  const { ctx, relay } = await pairedRelay();
  await relay.fetch(upgrade('', `atelier, ${TOKEN}`));
  const server = ctx.accepted[0].ws;
  const pending = relay.fetch(new Request('https://relay/cmd', { method: 'POST', body: JSON.stringify({ cmd: 'click', args: { tabId: 3, element: 7 } }) }));
  for (let i = 0; i < 50 && !server.sent.length; i++) await new Promise((r) => setTimeout(r, 1));
  const sent = JSON.parse(server.sent[0]);
  assert.equal(sent.cmd, 'click');
  assert.deepEqual(sent.args, { tabId: 3, element: 7 });
  const error = 'The user declined this click in the Atelier Browser confirmation window, so nothing was clicked.';
  await relay.webSocketMessage(server, JSON.stringify({ id: sent.id, ok: false, error }));
  assert.deepEqual(await (await pending).json(), { ok: false, error });
});

test('a command with no browser connected is a 503', async () => {
  const { relay } = await pairedRelay();
  const r = await relay.fetch(new Request('https://relay/cmd', { method: 'POST', body: JSON.stringify({ cmd: 'tabs' }) }));
  assert.equal(r.status, 503);
  assert.equal((await r.json()).ok, false);
});

// ── Worker-side hardening that ships with the relay change (config files, no runtime) ──
// JSONC → JSON: drops // and /* */ comments outside strings.
function parseJsonc(text) {
  let out = '', inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) { out += c; if (c === '\\') out += text[++i]; else if (c === '"') inString = false; continue; }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i + 2) + 1; continue; }
    out += c;
  }
  return JSON.parse(out);
}

test('wrangler.jsonc: custom domain only, no preview URLs, no invocation logs, observability and Canva var kept', () => {
  const cfg = parseJsonc(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(cfg.workers_dev, false);
  assert.equal(cfg.preview_urls, false);
  assert.equal(cfg.observability.enabled, true);
  assert.equal(cfg.observability.logs.invocation_logs, false);
  assert.notEqual(cfg.observability.logs.enabled, false); // our own console logs stay
  assert.deepEqual(cfg.routes, [{ pattern: 'atelier.ciprari.ai', custom_domain: true }]);
  assert.match(cfg.vars.CANVA_CLIENT_ID, /^OC-/);
});

// _headers → { path: { name: value } }, following Cloudflare's rules (# comments, indented "Name: value" lines).
function parseHeadersFile(text) {
  const rules = {};
  let rule = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    assert.ok(line.length <= 2000, `_headers lines are limited to 2,000 characters (got ${line.length})`);
    if (!/^\s/.test(raw)) { rule = rules[line] = {}; continue; }
    const at = line.indexOf(':');
    rule[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return rules;
}
const cspOf = (value) => Object.fromEntries(value.split(';').map((d) => d.trim()).filter(Boolean).map((d) => { const [name, ...src] = d.split(/\s+/); return [name, src]; }));

test('_headers: a report-only CSP for every page, alongside the existing security headers', () => {
  const rules = parseHeadersFile(readFileSync(new URL('../public/_headers', import.meta.url), 'utf8'));
  const all = rules['/*'];
  assert.equal(all['x-content-type-options'], 'nosniff');
  assert.equal(all['x-frame-options'], 'DENY');
  assert.equal(all['referrer-policy'], 'strict-origin-when-cross-origin');
  assert.equal(all['content-security-policy'], undefined, 'report-only first: nothing is enforced yet');
  assert.equal(all['strict-transport-security'], 'max-age=31536000; includeSubDomains', 'HTTPS only (worker.js sends the same on /api)');
  assert.equal(rules['/sw.js']['cache-control'], 'no-cache');
  assert.equal(rules['/index.html']['cache-control'], 'no-cache');

  const csp = cspOf(all['content-security-policy-report-only']);
  // The app itself: own files and /api, Google Fonts, data:/blob: media, Canva thumbnails, LinkedIn photos (testers).
  assert.deepEqual(csp['default-src'], ["'self'"]);
  for (const src of ["'self'", 'https://fonts.googleapis.com']) assert.ok(csp['style-src'].includes(src), src);
  for (const src of ["'self'", 'https://fonts.gstatic.com']) assert.ok(csp['font-src'].includes(src), src);
  for (const src of ["'self'", 'data:', 'blob:', 'https://*.canva.com', 'https://media.licdn.com']) assert.ok(csp['img-src'].includes(src), src);
  for (const src of ["'self'", 'data:', 'blob:']) assert.ok(csp['media-src'].includes(src), src);
  // sw.js fetches the Google Fonts files itself, which is governed by connect-src.
  for (const src of ["'self'", 'https://fonts.googleapis.com', 'https://fonts.gstatic.com']) assert.ok(csp['connect-src'].includes(src), src);
  assert.deepEqual(csp['worker-src'], ["'self'"]);
  // Build previews (srcdoc, inheriting this policy): inline code plus the CDNs the build prompt names.
  for (const src of ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://unpkg.com']) assert.ok(csp['script-src'].includes(src), src);
  assert.ok(csp['style-src'].includes("'unsafe-inline'"));
  // What stays tight, so reports mean something.
  assert.deepEqual(csp['script-src-attr'], ["'none'"]);
  assert.ok(!csp['script-src'].includes("'unsafe-eval'"));
  for (const d of ['img-src', 'connect-src', 'script-src', 'media-src']) {
    assert.ok(!csp[d].some((s) => s === '*' || s === 'https:' || s === 'http:'), `${d} names hosts, not whole schemes`);
  }
  assert.deepEqual(csp['object-src'], ["'none'"]);
  assert.deepEqual(csp['base-uri'], ["'none'"]);
  assert.deepEqual(csp['frame-ancestors'], ["'none'"]);
  assert.deepEqual(csp['form-action'], ["'self'"]);
  // Violations go to POST /api/csp-report: report-uri (older browsers) and report-to → the Reporting-Endpoints "csp".
  // Relative, so a local or preview copy never reports to production.
  assert.deepEqual(csp['report-uri'], ['/api/csp-report']);
  assert.deepEqual(csp['report-to'], ['csp']);
  assert.equal(all['reporting-endpoints'], 'csp="/api/csp-report"');
});

test('_headers: every external stylesheet the pages link to is allowed by the report-only CSP', () => {
  const csp = cspOf(parseHeadersFile(readFileSync(new URL('../public/_headers', import.meta.url), 'utf8'))['/*']['content-security-policy-report-only']);
  const attr = (tag, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
  for (const page of ['index.html', 'privacy.html', 'tos.html']) {
    const html = readFileSync(new URL(`../public/${page}`, import.meta.url), 'utf8');
    const external = [...html.matchAll(/<link\b[^>]*>/g)].map(([tag]) => tag)
      .filter((tag) => attr(tag, 'rel') === 'stylesheet' && /^https:/.test(attr(tag, 'href') || ''));
    assert.ok(external.length > 0, `${page} loads Google Fonts`);
    for (const tag of external) assert.ok(csp['style-src'].includes(new URL(attr(tag, 'href')).origin), `${page}: ${tag}`);
    for (const [, src] of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) assert.ok(src.startsWith('/'), `${page}: scripts are same-origin (${src})`);
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), `${page}: no inline <script>`);
  }
});
