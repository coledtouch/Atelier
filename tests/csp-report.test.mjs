import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, api, signIn, PROFILE, resetTesterCaches, worker } from './tester-env.mjs';

// POST /api/csp-report: Content-Security-Policy violation reports (public/_headers report-uri and report-to). Public,
// answered before identity is checked; each violation is one compact log line with nothing personal in it.
let lines = [];
const realLog = console.log, realNow = Date.now;
beforeEach(() => {
  resetTesterCaches();
  lines = [];
  console.log = (...a) => { if (a[0] === 'csp') lines.push(a.slice(1).join(' ')); else realLog(...a); };
});
afterEach(() => { console.log = realLog; Date.now = realNow; });

const IP = '203.0.113.9', UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) Secret/1.0';
const report = (body, headers = {}, who = {}, env = makeEnv().env) => api(env, 'csp-report', {
  method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
  headers: { 'content-type': 'application/csp-report', 'cf-connecting-ip': IP, 'user-agent': UA, ...headers },
}, { origin: null, ...who });
// What Chrome sends for report-uri (hyphenated keys) and for report-to (an array of reports).
const legacy = (o = {}) => ({ 'csp-report': {
  'document-uri': 'https://atelier.ciprari.ai/?invite=SECRET-CODE#thread-42', referrer: 'https://www.linkedin.com/in/someone?trk=x',
  'violated-directive': 'img-src', 'effective-directive': 'img-src', 'original-policy': "default-src 'self'; img-src 'self'",
  disposition: 'report', 'blocked-uri': 'https://media.licdn.com/dms/image/v2/D4E03AQ/profile-displayphoto?e=1&t=TOKEN',
  'line-number': 412, 'column-number': 17, 'source-file': 'https://atelier.ciprari.ai/app.js?v=52', 'status-code': 200,
  'script-sample': 'alert(document.cookie) my private text', ...o,
} });
const modern = (body = {}) => ({ type: 'csp-violation', age: 3, url: 'https://atelier.ciprari.ai/privacy?x=1', user_agent: UA, body: {
  documentURL: 'https://atelier.ciprari.ai/privacy?x=1', referrer: '', blockedURL: 'inline', effectiveDirective: 'script-src-elem',
  originalPolicy: "script-src 'self'", sourceFile: 'https://atelier.ciprari.ai/privacy', sample: 'console.log("secret")',
  disposition: 'report', statusCode: 200, lineNumber: 9, columnNumber: 3, ...body,
} });
const PRIVATE = [IP, 'iPhone', 'Secret/1.0', 'SECRET-CODE', 'thread-42', 'linkedin.com/in', 'trk=', 'TOKEN', 'dms/image', 'v=52', 'document.cookie', 'private text', 'secret', 'x=1', "default-src"];

test('report-uri: one compact line per violation: directive, blocked origin, page and source as origin + path, line and column', async () => {
  const r = await report(legacy());
  assert.equal(r.status, 204);
  assert.equal(await r.text(), '');
  assert.equal(r.headers.get('set-cookie'), null);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    dir: 'img-src', blocked: 'https://media.licdn.com', page: 'https://atelier.ciprari.ai/', src: 'https://atelier.ciprari.ai/app.js', line: 412, col: 17, mode: 'report',
  });
  for (const p of PRIVATE) assert.ok(!lines[0].includes(p), `${p} is never logged`);
});

test('report-to: csp-violation reports only, at most five a request; keywords and schemes kept, nothing personal', async () => {
  const reports = [
    modern(), { type: 'deprecation', body: { id: 'x', message: 'secret' } }, modern({ blockedURL: 'eval', effectiveDirective: 'script-src' }),
    modern({ blockedURL: 'data:image/png;base64,SECRET', effectiveDirective: 'img-src', lineNumber: -1, columnNumber: 'x' }),
    modern({ blockedURL: 'chrome-extension://abcdef/secret.js', effectiveDirective: 'script-src-elem', documentURL: 'about:srcdoc' }),
    modern({ blockedURL: 'wss://evil.example:8443/x?token=secret', effectiveDirective: 'connect-src' }), modern(), modern(),
  ];
  const r = await report(reports, { 'content-type': 'application/reports+json' });
  assert.equal(r.status, 204);
  assert.deepEqual(lines.map((l) => JSON.parse(l)), [
    { dir: 'script-src-elem', blocked: 'inline', page: 'https://atelier.ciprari.ai/privacy', src: 'https://atelier.ciprari.ai/privacy', line: 9, col: 3, mode: 'report' },
    { dir: 'script-src', blocked: 'eval', page: 'https://atelier.ciprari.ai/privacy', src: 'https://atelier.ciprari.ai/privacy', line: 9, col: 3, mode: 'report' },
    { dir: 'img-src', blocked: 'data', page: 'https://atelier.ciprari.ai/privacy', src: 'https://atelier.ciprari.ai/privacy', mode: 'report' },
    { dir: 'script-src-elem', blocked: 'chrome-extension', page: 'about:srcdoc', src: 'https://atelier.ciprari.ai/privacy', line: 9, col: 3, mode: 'report' },
    { dir: 'connect-src', blocked: 'wss', page: 'https://atelier.ciprari.ai/privacy', src: 'https://atelier.ciprari.ai/privacy', line: 9, col: 3, mode: 'report' },
  ]);
  for (const l of lines) for (const p of [...PRIVATE, 'abcdef', 'evil.example', 'token', 'base64']) assert.ok(!l.includes(p), `${p} in ${l}`);
});

test('public and answered before identity: no passcode, a tester cookie (live, ended or forged) changes nothing, the Ledger and KV are untouched', async () => {
  const { env, L } = makeEnv();
  const t = await signIn(L, PROFILE());
  const forged = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  for (const cookie of [undefined, t.token, forged]) {
    L.calls.length = 0;
    const r = await report(legacy(), {}, { cookie }, env);
    assert.equal(r.status, 204, String(cookie));
    assert.equal(r.headers.get('set-cookie'), null, 'an ended session is not cleared here (no identity is looked up)');
    assert.deepEqual(L.calls, [], 'never reads the Ledger');
  }
  assert.deepEqual([...env.ATELIER_KV.m.keys()], [], 'no lockout counter or profile is touched');
  assert.equal(lines.length, 3);
});

test('only POSTs of a real report, at most 16 KB; anything else is refused without logging', async () => {
  const { env } = makeEnv();
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const r = await api(env, 'csp-report', { method, ...(method === 'GET' ? {} : { body: '{}' }) }, { origin: null });
    assert.equal(r.status, 405, method);
  }
  for (const body of ['', 'not json', '[]', '{}', '{"csp-report": "x"}', '[{"type":"deprecation","body":{}}]', 'null', '7']) {
    assert.equal((await report(body, {}, {}, env)).status, 400, body);
  }
  const big = JSON.stringify(legacy({ 'script-sample': 'x'.repeat(17_000) }));
  assert.equal((await report(big, {}, {}, env)).status, 413, 'by Content-Length');
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); } });
  const r = await worker.fetch(new Request('https://atelier.ciprari.ai/api/csp-report', { method: 'POST', body: stream, duplex: 'half', headers: { 'content-type': 'application/csp-report' } }), env);
  assert.equal(r.status, 413, 'by bytes read (no Content-Length)');
  assert.equal(lines.length, 0);
});

test('a flood is answered 204 but not logged: per IP through LI_LIMIT (key csp:<ip>), and at most 60 lines a minute per isolate', async () => {
  const keys = [];
  let allow = false;
  const { env } = makeEnv({ LI_LIMIT: { async limit({ key }) { keys.push(key); return { success: allow }; } } });
  let now = realNow() + 3_600_000; // a fresh minute
  Date.now = () => now;
  assert.equal((await report(legacy(), {}, {}, env)).status, 204);
  assert.deepEqual(keys, [`csp:${IP}`], 'the IP is only a rate-limit key');
  assert.equal(lines.length, 0, 'over the per-IP limit: not logged');
  allow = true;
  for (let i = 0; i < 14; i++) assert.equal((await report(Array.from({ length: 5 }, () => modern()), { 'content-type': 'application/reports+json' }, {}, env)).status, 204);
  assert.equal(lines.length, 60, '70 reports in a minute, 60 lines');
  now += 60_000;
  await report(legacy(), {}, {}, env);
  assert.equal(lines.length, 61, 'the next minute logs again');
  // A limiter that fails never turns reports away (the isolate cap still holds).
  const down = makeEnv({ LI_LIMIT: { async limit() { throw new Error('down'); } } }).env;
  assert.equal((await report(legacy(), {}, {}, down)).status, 204);
  assert.equal(lines.length, 62);
});

test('every /api response over HTTPS carries Strict-Transport-Security (public/_headers covers static files only)', async () => {
  const { env } = makeEnv();
  for (const [path, init, who] of [['health', {}, {}], ['csp-report', { method: 'POST', body: '{}' }, { origin: null }], ['me', {}, {}], ['me', {}, { pass: 'pw' }], ['tester/me', {}, { cookie: 'x'.repeat(43) }]]) {
    const r = await api(env, path, init, who);
    assert.equal(r.headers.get('strict-transport-security'), 'max-age=31536000', `${path} ${r.status}`);
  }
  // Over plain http (local dev) browsers ignore it, so it isn't sent.
  const r = await worker.fetch(new Request('http://127.0.0.1:8787/api/health'), env);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('strict-transport-security'), null);
});

test('only the two types browsers send are read (case and parameters aside); any other Content-Type is 415 and never logged', async () => {
  const { env, L } = makeEnv();
  // CORS-safelisted types (sendBeacon, a no-cors fetch or a form from another site), plain JSON, near misses, none.
  for (const type of ['text/plain;charset=UTF-8', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/json', 'application/csp-reports', 'application/reports+jsonp', 'text/csp-report', '']) {
    const r = await report(legacy(), { 'content-type': type }, {}, env);
    assert.equal(r.status, 415, JSON.stringify(type));
    assert.deepEqual(await r.json(), { error: 'Send CSP reports as application/csp-report or application/reports+json.' });
    assert.equal(r.headers.get('strict-transport-security'), 'max-age=31536000');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  }
  // No Content-Type header at all.
  const bare = await worker.fetch(new Request('https://atelier.ciprari.ai/api/csp-report', { method: 'POST', body: new TextEncoder().encode(JSON.stringify(legacy())) }), env);
  assert.equal(bare.headers.get('content-type'), 'application/json');
  assert.equal(bare.status, 415);
  assert.equal(lines.length, 0, 'nothing logged');
  assert.deepEqual(L.calls, [], 'never reads the Ledger');
  // What browsers send, in any case and with parameters.
  assert.equal((await report(legacy(), { 'content-type': 'Application/CSP-Report; charset=utf-8' }, {}, env)).status, 204);
  assert.equal((await report([modern()], { 'content-type': ' APPLICATION/REPORTS+JSON ;charset=UTF-8' }, {}, env)).status, 204);
  assert.equal(lines.length, 2);
});

test('a field of any JSON type never throws: only strings and finite numbers are read (an object with its own toString or valueOf is skipped)', async () => {
  const { env } = makeEnv();
  let now = realNow() + 7_200_000; // a fresh minute, so the per-isolate line cap doesn't hide the lines checked below
  Date.now = () => now;
  const hostile = [{ toString: 1 }, { valueOf: 1, toString: 1 }, { toString: 'x' }, [{ toString: 1 }], ['img-src'], true, null, {}];
  for (const v of hostile) {
    for (const field of ['effective-directive', 'violated-directive', 'blocked-uri', 'document-uri', 'source-file', 'line-number', 'column-number', 'disposition']) {
      const r = await report(legacy({ [field]: v }), {}, {}, env);
      assert.equal(r.status, 204, `${field}: ${JSON.stringify(v)}`);
    }
    const r = await report([modern({ effectiveDirective: v, blockedURL: v, documentURL: v, sourceFile: v, lineNumber: v, columnNumber: v, disposition: v })], { 'content-type': 'application/reports+json' }, {}, env);
    assert.equal(r.status, 204, `report-to: ${JSON.stringify(v)}`);
  }
  // The report object itself with its own toString, and a field that isn't there.
  assert.equal((await report('{"csp-report":{"toString":1}}', {}, {}, env)).status, 204);
  now += 60_000;
  lines.length = 0;
  await report(legacy({ 'effective-directive': { toString: 1 }, 'line-number': { valueOf: 1, toString: 1 }, disposition: { toString: 'x' }, 'column-number': [7] }), {}, {}, env);
  assert.deepEqual(JSON.parse(lines[0]), { blocked: 'https://media.licdn.com', page: 'https://atelier.ciprari.ai/', src: 'https://atelier.ciprari.ai/app.js' },
    'an unreadable field is left out, never logged as "object"');
  // Strings and finite numbers are still read; a number past the safe range, a negative one or a blank string isn't.
  lines.length = 0;
  await report('{"csp-report":{"effective-directive":"img-src","line-number":"12","column-number":1e400,"disposition":"enforce"}}', {}, {}, env);
  await report(legacy({ 'line-number': -3, 'column-number': ' ', 'effective-directive': 5 }), {}, {}, env);
  assert.deepEqual(lines.map((l) => JSON.parse(l)), [
    { dir: 'img-src', line: 12, mode: 'enforce' },
    { dir: '5', blocked: 'https://media.licdn.com', page: 'https://atelier.ciprari.ai/', src: 'https://atelier.ciprari.ai/app.js', mode: 'report' },
  ]);
});

test('a route that throws answers a generic 500 with no-store, nosniff and HSTS; the log names the route and the error type, never its message', async () => {
  const { env } = makeEnv();
  // An env whose passcode read throws, with a message quoting what someone typed (as a real error message could).
  const broken = new Proxy(env, { get(t, k) { if (k === 'APP_PASSCODE') throw new RangeError('boom: jane@example.com typed "my private note"'); return t[k]; } });
  const errors = [];
  const realError = console.error;
  console.error = (...a) => errors.push(a.map(String).join(' '));
  try {
    const r = await api(broken, 'health?q=private-query');
    assert.equal(r.status, 500);
    assert.deepEqual(await r.json(), { error: 'Something went wrong.' });
    assert.equal(r.headers.get('content-type'), 'application/json');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    assert.equal(r.headers.get('strict-transport-security'), 'max-age=31536000');
    assert.deepEqual(errors, ['api failed /api/health RangeError']);
    // Over plain http (local dev) HSTS isn't sent; the rest is the same.
    const local = await worker.fetch(new Request('http://127.0.0.1:8787/api/health'), broken);
    assert.equal(local.status, 500);
    assert.equal(local.headers.get('strict-transport-security'), null);
    assert.equal(local.headers.get('x-content-type-options'), 'nosniff');
    // Something thrown that isn't an Error is named by its type.
    const odd = new Proxy(env, { get(t, k) { if (k === 'APP_PASSCODE') throw 'a thrown string with secrets'; return t[k]; } });
    assert.equal((await api(odd, 'health')).status, 500);
    assert.equal(errors.at(-1), 'api failed /api/health string');
    for (const e of errors) for (const p of ['boom', 'jane', 'private', 'secrets']) assert.ok(!e.includes(p), `${p} in ${e}`);
  } finally {
    console.error = realError;
  }
});
