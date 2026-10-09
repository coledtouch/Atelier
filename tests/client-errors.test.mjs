// POST /api/client-error (public, same-origin, capped, rate-limited) and the owner's GET (passcode), over the real Worker
// and the real Ledger (node:sqlite). src/client-errors.js; the reports come from index.html's boot watchdog.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, api, signIn, PROFILE, resetTesterCaches, ORIGIN } from './tester-env.mjs';
import { cleanReport, reportSig, resetClientErrorCaps, ipKey, CLIENT_ERRORS } from '../src/client-errors.js';

let lines = [];
const realLog = console.log;
beforeEach(() => {
  resetTesterCaches(); resetClientErrorCaps();
  lines = [];
  console.log = (...a) => { if (a[0] === 'client-error') lines.push(a.slice(1).join(' ')); else realLog(...a); };
});
afterEach(() => { console.log = realLog; });

const REPORT = (o = {}) => ({ v: '85', kind: 'boot', name: 'TypeError', file: '/app.js', line: 6290, col: 3, stack: ['/app.js:6290:3', '/sync.js:44:1'], platform: 'ios-standalone', phase: 'starting', online: true, sw: true, ...o });
const post = (env, body, headers = {}, who = {}) => api(env, 'client-error', {
  method: 'POST', body: typeof body === 'string' || body instanceof ReadableStream ? body : JSON.stringify(body),
  headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7', ...headers },
}, who);
const list = async (env, pass = 'pw', who = {}) => api(env, 'client-error', { method: 'GET' }, { pass, ...who });
const limiter = (ok = () => true) => ({ calls: [], async limit({ key }) { this.calls.push(key); return { success: ok(key) }; } });

test('a report is stored, logged as one clean line and listed for the owner, newest first, with a count', async () => {
  const { env, L } = makeEnv({ testers: false, ERR_LIMIT: limiter() });
  const r = await post(env, REPORT());
  assert.equal(r.status, 204);
  assert.equal(await r.text(), '');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual(lines.map((l) => JSON.parse(l)), [REPORT()]);
  assert.deepEqual(env.ERR_LIMIT.calls, ['ip:203.0.113.7'], 'the IP is a rate-limit key only');
  assert.ok(!lines[0].includes('203.0.113.7'));
  assert.ok(L.calls.includes('clientErrorAdd'));
  await post(env, REPORT());
  await post(env, REPORT({ kind: 'load', name: 'LoadError', file: '/data-safety.js', line: undefined, col: undefined, stack: undefined, phase: 'loading' }));
  const g = await list(env);
  assert.equal(g.status, 200);
  const doc = await g.json();
  assert.equal(doc.keep, 50);
  assert.equal(doc.days, 30);
  assert.deepEqual(doc.reports.map((x) => [x.kind, x.file, x.count]), [['load', '/data-safety.js', 1], ['boot', '/app.js', 2]]);
  const boot = doc.reports[1];
  assert.ok(boot.firstAt > 0 && boot.lastAt >= boot.firstAt);
  assert.deepEqual(Object.keys(boot).sort(), ['col', 'count', 'file', 'firstAt', 'kind', 'lastAt', 'line', 'name', 'online', 'phase', 'platform', 'stack', 'sw', 'v']);
});

test('cleanReport keeps only listed fields, each by pattern: no message, URL, query, foreign frame or free text survives', () => {
  const dirty = {
    ...REPORT(), message: 'my private prompt', url: 'https://atelier.ciprari.ai/?invite=SECRET', prompt: 'hi', thread: { text: 'x' },
    name: 'Error: my private prompt', file: 'https://atelier.ciprari.ai/app.js?v=85', line: 1.5, col: -2, platform: 'my-phone', phase: 'whenever', online: 'yes',
    stack: ['/app.js:1:2', 'https://evil.example/x.js:1:1', '/app.js?v=85:1:2', '/../etc/passwd.js:1:1', '/a/b/c.js:1:1', '<img src=x onerror=alert(1)>:1:1', 42, ...Array(30).fill('/app.js:9:9')],
  };
  const c = cleanReport(dirty);
  assert.deepEqual(c, { v: '85', kind: 'boot', name: 'Error', stack: ['/app.js:1:2', '/app.js:9:9', '/app.js:9:9', '/app.js:9:9', '/app.js:9:9', '/app.js:9:9'], platform: 'unknown', sw: true });
  assert.equal(c.stack.length, CLIENT_ERRORS.frames);
  for (const bad of [null, [], 'x', {}, { ...REPORT(), v: '85a' }, { ...REPORT(), v: 85 }, { ...REPORT(), kind: 'crash' }]) assert.equal(cleanReport(bad), null, JSON.stringify(bad));
  // Line and column only travel with a file they belong to.
  assert.deepEqual(cleanReport({ v: '1', kind: 'stall', name: 'Stall', line: 4, col: 5 }), { v: '1', kind: 'stall', name: 'Stall', platform: 'unknown' });
  assert.equal(reportSig(cleanReport(REPORT())), reportSig(cleanReport({ ...REPORT(), stack: [], phase: 'loading' })), 'the same failure: frames and phase aside');
  // net (a load that saw no server error) is a boolean or nothing.
  assert.equal(cleanReport({ ...REPORT({ kind: 'load', name: 'LoadError' }), net: true }).net, true);
  assert.equal(cleanReport({ ...REPORT({ kind: 'load', name: 'LoadError' }), net: 'yes' }).net, undefined);
});

test('refused: another site (no Origin, or a foreign one), not JSON, too big (said or streamed), malformed, not a report, other methods', async () => {
  const { env, L } = makeEnv({ testers: false });
  const body = JSON.stringify(REPORT());
  assert.equal((await post(env, body, {}, { origin: null })).status, 403, 'no Origin');
  assert.equal((await post(env, body, {}, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(env, body, { 'content-type': 'text/plain' })).status, 415, 'a no-cors form post');
  const big = JSON.stringify({ ...REPORT(), pad: 'x'.repeat(3000) });
  assert.equal((await post(env, big)).status, 413);
  const stream = new ReadableStream({ start(c) { for (let i = 0; i < 5; i++) c.enqueue(new TextEncoder().encode(' '.repeat(600))); c.close(); } });
  assert.equal((await post(env, stream)).status, 413, 'counted as it is read, without a Content-Length');
  assert.equal((await post(env, '{"v":')).status, 400);
  assert.equal((await post(env, new Uint8Array([0xff, 0xfe, 0x7b]))).status, 400, 'not UTF-8');
  assert.equal((await post(env, { hello: 'world' })).status, 400);
  assert.equal((await api(env, 'client-error', { method: 'PUT', body: body, headers: { 'content-type': 'application/json' } })).status, 405);
  assert.deepEqual(lines, [], 'nothing logged');
  assert.ok(!L.calls.includes('clientErrorAdd'), 'nothing stored');
});

test('rate limits: ERR_LIMIT per IP answers 429 (nothing logged or stored); each isolate takes 30 a minute at most', async () => {
  const { env, L } = makeEnv({ testers: false, ERR_LIMIT: limiter((key) => key !== 'ip:198.51.100.1') });
  const r = await post(env, REPORT(), { 'cf-connecting-ip': '198.51.100.1' });
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('retry-after'), '60');
  assert.deepEqual(lines, []);
  assert.ok(!L.calls.includes('clientErrorAdd'));
  const statuses = [];
  for (let i = 0; i < 35; i++) statuses.push((await post(env, REPORT({ line: i }))).status);
  assert.deepEqual(statuses, [...Array(30).fill(204), ...Array(5).fill(429)]);
  assert.equal(lines.length, 30);
});

test('storage can’t grow: one row per failure (counted), 50 at most, nothing older than 30 days', async () => {
  const { env, L } = makeEnv({ testers: false });
  let now = Date.UTC(2026, 9, 8);
  L.ledger.clock = () => now;
  for (let i = 0; i < 3; i++) assert.equal(L.ledger.clientErrorAdd(REPORT()).count, i + 1);
  // 60 more failures over 4 hours (15 an hour, inside the 20 new ones an hour).
  for (let i = 0; i < 60; i++) { now += 4 * 60_000; assert.equal(L.ledger.clientErrorAdd(REPORT({ line: 1000 + i })).ok, true); }
  const rows = L.ledger.clientErrors();
  assert.equal(rows.length, 50);
  assert.equal(rows[0].line, 1059, 'newest first');
  assert.ok(rows.some((r) => r.line === 6290 && r.count === 3), 'seen three times: it outlasts newer ones seen once');
  assert.deepEqual(Array.from({ length: 11 }, (_, i) => 1000 + i).filter((n) => rows.some((r) => r.line === n)), [], 'the oldest seen once went');
  assert.equal(L.shim.db.prepare('SELECT COUNT(*) AS n FROM client_errors').get().n, 50);
  // Seen again: it moves to the top and counts up.
  now += 1000;
  L.ledger.clientErrorAdd(REPORT({ line: 1030 }));
  assert.deepEqual([L.ledger.clientErrors()[0].line, L.ledger.clientErrors()[0].count], [1030, 2]);
  // 30 days on, everything is gone: on read, on the next report and in the alarm.
  now += 30 * 86_400_000;
  assert.deepEqual(L.ledger.clientErrors(), []);
  now -= 1; L.ledger.clientErrorAdd(REPORT({ line: 1 })); now += 30 * 86_400_000 + 1;
  await L.ledger.alarm();
  assert.equal(L.shim.db.prepare('SELECT COUNT(*) AS n FROM client_errors').get().n, 0, 'the alarm deletes it too');
  assert.deepEqual(L.ledger.clientErrorAdd({ v: 'x' }), { ok: false }, 'the Ledger cleans again');
});

test('forged reports can’t sweep out real ones: 20 new failures an hour at most, whoever sends them; one seen once goes before one seen again; the newest 10 always stay', async () => {
  const { env, L } = makeEnv({ testers: false, ERR_LIMIT: limiter() });
  let now = Date.UTC(2026, 9, 8);
  L.ledger.clock = () => now;
  const rows = () => L.ledger.clientErrors();
  // A genuine start-up crash, seen on two launches.
  assert.equal((await post(env, REPORT())).status, 204);
  now += 60_000;
  assert.equal((await post(env, REPORT())).status, 204);
  // The flood: 50 made-up failures in a minute, each from its own IPv6 /64.
  for (let i = 0; i < 50; i++) await post(env, REPORT({ line: 100 + i }), { 'cf-connecting-ip': `2001:db8:${(i + 1).toString(16)}::1` });
  assert.equal(rows().length, 20, 'the hour’s 20 new rows, then no more');
  assert.ok(rows().some((r) => r.line === 6290 && r.count === 2), 'the genuine report is still listed');
  // Hours of it, straight into the Ledger (past every per-minute cap): still 50 rows, and the genuine one is there.
  for (let h = 1; h <= 8; h++) { now += 3_600_000; for (let i = 0; i < 40; i++) L.ledger.clientErrorAdd(REPORT({ line: h * 1000 + i })); }
  const after = rows();
  assert.equal(after.length, 50);
  assert.ok(after.some((r) => r.line === 6290 && r.count === 2), 'a failure seen again outlasts any number seen once');
  assert.deepEqual(after.slice(0, 10).map((r) => r.line), Array.from({ length: 10 }, (_, i) => 8019 - i), 'the newest 10 stay, whatever they are');
  // A repeat is never refused, even with the hour’s new rows used up.
  assert.equal(L.ledger.clientErrorAdd(REPORT()).count, 3);
  assert.deepEqual(L.ledger.clientErrorAdd(REPORT({ line: 99999 })), { ok: false, full: true });
});

test('a report must name the deployed version or one of the two before it (read once from the deployed sw.js); refused ones use no allowance', async () => {
  const assets = { paths: [], async fetch(req) { this.paths.push(new URL(req.url).pathname); return new Response("const VERSION = 'atelier-v85';\n"); } };
  const { env, L } = makeEnv({ testers: false, ASSETS: assets, ERR_LIMIT: limiter() });
  const status = async (v) => (await post(env, REPORT({ v }))).status;
  assert.deepEqual([await status('85'), await status('84'), await status('83')], [204, 204, 204]);
  for (const v of ['86', '82', '0', '999999']) {
    const r = await post(env, REPORT({ v }));
    assert.equal(r.status, 400, v);
    assert.match((await r.json()).error, /Not a current Atelier version/);
  }
  assert.deepEqual(assets.paths, ['/sw.js'], 'read once per isolate');
  assert.equal(env.ERR_LIMIT.calls.length, 3, 'a refused version takes nobody’s allowance');
  assert.deepEqual(L.ledger.clientErrors().map((r) => r.v).sort(), ['83', '84', '85']);
  assert.equal(lines.length, 3);
  // When sw.js can't be read, no version is refused (and it is read again next time).
  resetClientErrorCaps();
  const down = { n: 0, async fetch() { this.n++; return new Response('nope', { status: 500 }); } };
  const bare = makeEnv({ testers: false, ASSETS: down }).env;
  assert.equal((await post(bare, REPORT({ v: '7' }))).status, 204);
  assert.equal((await post(bare, REPORT({ v: '8' }))).status, 204);
  assert.equal(down.n, 2);
});

test('ERR_LIMIT counts an IPv6 address by its /64 (one host holds the whole /64), IPv4 as it is', async () => {
  assert.equal(ipKey('203.0.113.7'), '203.0.113.7');
  assert.equal(ipKey('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(ipKey('2001:DB8:1:2:ffff:ffff:ffff:ffff'), '2001:db8:1:2::/64');
  assert.equal(ipKey('2001:0db8:0001:0002::'), '2001:db8:1:2::/64');
  assert.equal(ipKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(ipKey('::1'), '0:0:0:0::/64');
  assert.equal(ipKey('::ffff:192.0.2.1'), '192.0.2.1');
  assert.equal(ipKey(''), 'unknown');
  assert.equal(ipKey(null), 'unknown');
  const { env } = makeEnv({ testers: false, ERR_LIMIT: limiter() });
  for (let i = 1; i <= 3; i++) await post(env, REPORT({ line: i }), { 'cf-connecting-ip': `2001:db8:1:2:${i.toString(16)}::${i}` });
  assert.deepEqual(env.ERR_LIMIT.calls, Array(3).fill('ip:2001:db8:1:2::/64'));
});

test('the owner’s GET: passcode only (401 without, with a wrong one, or with a tester cookie); old or corrupt rows come back cleaned, never as HTML', async () => {
  const { env, L } = makeEnv({ testers: true });
  await post(env, REPORT());
  assert.equal((await list(env, null)).status, 401);
  assert.equal((await list(env, 'wrong')).status, 401);
  const t = await signIn(L, PROFILE());
  assert.equal((await list(env, null, { cookie: t.token })).status, 401, 'a tester never sees them');
  // A row written by an older build, or tampered with: re-cleaned on the way out; unreadable ones are skipped.
  const evil = '<img src=x onerror=alert(1)>';
  const ins = L.shim.db.prepare('INSERT INTO client_errors (sig, doc, n, first_at, last_at) VALUES (?, ?, ?, ?, ?)');
  ins.run('a', JSON.stringify({ v: '85', kind: 'error', name: evil, file: `/x.js"><script>alert(1)</script>`, stack: [evil, '/app.js:1:1'], platform: evil, message: 'secret prompt' }), 1, Date.now(), Date.now() + 5);
  ins.run('b', '{not json', 1, Date.now(), Date.now() + 4);
  ins.run('c', JSON.stringify({ v: '<b>', kind: 'error' }), 1, Date.now(), Date.now() + 3);
  const g = await list(env);
  assert.equal(g.status, 200);
  assert.match(g.headers.get('content-type'), /^application\/json/);
  const text = await g.text();
  assert.ok(!text.includes('<') && !text.includes('>') && !text.includes('secret'), text);
  const { reports } = JSON.parse(text);
  assert.equal(reports.length, 2);
  assert.deepEqual(reports[0], { v: '85', kind: 'error', name: 'Error', stack: ['/app.js:1:1'], platform: 'unknown', count: 1, firstAt: reports[0].firstAt, lastAt: reports[0].lastAt });
});

test('public and answered before identity: a tester cookie changes nothing; with no Ledger it still logs (GET says unavailable)', async () => {
  const { env, L } = makeEnv({ testers: true });
  const t = await signIn(L, PROFILE());
  const r = await post(env, REPORT(), {}, { cookie: t.token });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('set-cookie'), null);
  assert.deepEqual([...env.ATELIER_KV.m.keys()], [], 'no lockout counter or profile is touched');
  const bare = makeEnv({ testers: false, ledger: null }).env;
  assert.equal((await post(bare, REPORT())).status, 204);
  assert.equal(lines.length, 2);
  assert.equal((await list(bare)).status, 503);
});

test('the privacy page discloses app error reports: what they hold, what they never hold, and how long they stay', async () => {
  const { readFile } = await import('node:fs/promises');
  const privacy = await readFile(new URL('../public/privacy.html', import.meta.url), 'utf8');
  const item = /<li id="app-errors">([\s\S]*?)<\/li>/.exec(privacy)?.[1];
  assert.ok(item, 'Technical data → App error reports');
  // Everything build() in index.html sends: a slow start (the 20 s stall report), the service-worker flag, the net flag
  // and the extra frames, as well as failures.
  for (const s of ['app version', 'type name', 'file and line', 'never includes the error’s message', 'never linked to your sign-in', 'at most five a session',
    'more than 20 seconds', 'offline copy (its service worker)', 'looked like a dropped connection', 'up to six more places']) assert.ok(item.includes(s), s);
  assert.match(privacy, /<li><b>App error reports:<\/b> at most 50 distinct reports are kept in Atelier’s Cloudflare storage, each until 30 days after/);
  assert.equal(CLIENT_ERRORS.keep, 50);
  assert.equal(CLIENT_ERRORS.days, 30);
});

test('the Settings hint calls the list unverified, not “from your devices”', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const hint = /<h4[^>]*>Recent app errors<\/h4>\s*<p class="hint">([^<]*)<\/p>/.exec(html)?.[1];
  assert.ok(hint);
  assert.ok(!/from your devices/.test(hint));
  assert.match(hint, /any device that opened Atelier/);
  assert.match(hint, /Unverified/);
});

test('wrangler.jsonc binds ERR_LIMIT next to the other rate limits', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const m = /\{ "name": "ERR_LIMIT", "namespace_id": "(\d+)", "simple": \{ "limit": (\d+), "period": (\d+) \} \}/.exec(src);
  assert.ok(m, 'ERR_LIMIT binding');
  assert.equal(m[3], '60');
  const ids = [...src.matchAll(/"namespace_id": "(\d+)"/g)].map((x) => x[1]);
  assert.equal(new Set(ids).size, ids.length, 'its own namespace');
  assert.equal(ORIGIN, 'https://atelier.ciprari.ai');
});
