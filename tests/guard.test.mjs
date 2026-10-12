// The passcode lockout (src/guard.js), through the real Worker handler with the real Guard Durable Object on SQLite
// (tests/tester-env.mjs makeGuard). Peer review of v56, re-checked at v89 (MEDIUM): the ATELIER_KV counter was a
// read-then-write keyed on the full IP; 200 parallel wrong guesses all got 401 with the counter ending at 1, the correct
// passcode in the same burst got 200, and rotating IPv6 addresses inside one /64 was unbounded.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeEnv, makeGuard, guardFails, api, GUARD, CLEAR_COOKIE, resetGuardCaches, guardSynced, COOKIE, ORIGIN } from './tester-env.mjs';
const { sha256hex, sameDigest } = await import('../src/guard.js');
const { safeEqual } = await import('../src/worker.js');

const read = async (p) => (await readFile(new URL(`../${p}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n'); // ship's checkout is CRLF on Windows
const RIGHT = 'pw'; // tester-env KEYS.APP_PASSCODE
const tick = () => new Promise((r) => setTimeout(r, 1));
async function until(cond, what = 'condition') {
  const end = Date.now() + 5000;
  while (!cond()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await tick(); }
}
// GET /api/me: 200 {} with the passcode, 401 without the right one: a route that reaches no provider.
const me = (env, { pass, ip, cookie } = {}) => api(env, 'me', { headers: { ...(ip ? { 'cf-connecting-ip': ip } : {}), ...(cookie ? { cookie } : {}) } }, { pass });
const clearanceOf = (r) => (r.headers.getSetCookie().find((c) => c.startsWith(`${CLEAR_COOKIE}=`)) || '').split(';')[0] || null;
const locked = (G) => G.shim.db.prepare('SELECT COALESCE(MAX(locked_until), 0) AS t FROM nets').get().t > 0;
const compared = (G) => G.shim.db.prepare('SELECT COALESCE(SUM(n), 0) AS n FROM wrong').get().n;
const statuses = (rs) => rs.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {});
// Guard calls that decide a request (attempt), as opposed to the background sync of burned clearances (burned).
const attempts = (G) => G.calls.filter((n) => n === 'attempt').length;
// A GUARD_LIMIT ratelimit binding: allow(key, n) says whether the n-th request for that key (1-based) is under the limit.
function limiter(allow = (_, n) => n <= GUARD.shedPerMinute) {
  const seen = new Map(), keys = [];
  return { keys, async limit({ key }) { keys.push(key); const n = (seen.get(key) || 0) + 1; seen.set(key, n); return { success: allow(key, n) }; } };
}
afterEach(() => resetGuardCaches());

test('200 parallel wrong guesses: exactly 10 are compared (401), 190 are refused (429), and the counter reaches 200', async () => {
  const { env, G } = makeEnv({ testers: false });
  const rs = await Promise.all(Array.from({ length: 200 }, () => me(env, { pass: 'nope', ip: '203.0.113.9' })));
  assert.deepEqual(statuses(rs), { 401: GUARD.networkLimit, 429: 200 - GUARD.networkLimit });
  assert.equal(guardFails(G), 200, 'the true count: every failure was counted, none lost to a race');
  assert.equal(compared(G), GUARD.networkLimit, 'only the compared ones count toward the global budget');
  assert.ok(locked(G));
  const refused = rs.find((r) => r.status === 429);
  assert.equal((await refused.json()).code, 'passcode_locked');
  assert.ok(Number(refused.headers.get('retry-after')) > 0 && Number(refused.headers.get('retry-after')) <= 900);
  assert.deepEqual([...env.ATELIER_KV.m.keys()], [], 'nothing in KV any more');
});

test('the right passcode inside a burst of 60 wrong ones is refused once the lock has engaged, like a wrong one', async () => {
  const right = await sha256hex(RIGHT);
  // The network delivers the right passcode's request late: after the Guard has locked this network.
  const G = makeGuard({ before: async (name, [, got]) => { if (name === 'attempt' && got === right) await until(() => locked(G), 'the lock'); } });
  const { env } = makeEnv({ testers: false, guard: G });
  const burst = Array.from({ length: 61 }, (_, i) => me(env, { pass: i === 20 ? RIGHT : 'nope', ip: '203.0.113.10' }));
  const rs = await Promise.all(burst);
  assert.equal(rs[20].status, 429, 'refused: the lock is checked before the passcode is compared');
  assert.equal(clearanceOf(rs[20]), null, 'and no clearance for it');
  assert.deepEqual(statuses(rs), { 401: 10, 429: 51 });
  assert.equal(guardFails(G), 61, 'the refused right one counts as a failure too: whether it was right never shows');
  // its answer is the same as a refused wrong one's
  const wrong = rs.find((r, i) => i !== 20 && r.status === 429);
  const [a, b] = await Promise.all([rs[20].json(), wrong.json()]);
  assert.deepEqual({ ...a, retryAfter: 0 }, { ...b, retryAfter: 0 });
  assert.ok(Math.abs(a.retryAfter - b.retryAfter) <= 1);
});

test('whatever order a burst arrives in: never more than 10 compared, the counter is exact, a right passcode wins only before the lock', async () => {
  for (let trial = 0; trial < 6; trial++) {
    const G = makeGuard({ before: () => new Promise((r) => setTimeout(r, Math.random() * 4)) });
    const { env } = makeEnv({ testers: false, guard: G });
    const at = Math.floor(Math.random() * 51);
    const rs = await Promise.all(Array.from({ length: 51 }, (_, i) => me(env, { pass: i === at ? RIGHT : 'nope', ip: '2001:db8:aa:1::7' })));
    const s = statuses(rs), won = rs[at].status === 200;
    assert.equal(s[401], 10, `trial ${trial}: exactly 10 compared wrong`);
    assert.equal(guardFails(G), 50 + (won ? 0 : 1), `trial ${trial}`);
    assert.ok([200, 429].includes(rs[at].status));
    assert.equal(Boolean(clearanceOf(rs[at])), won, 'a clearance only with an allowed right passcode');
  }
});

test('networks: IPv6 by its /64 (rotating inside it doesn’t help), IPv4 by address, an IPv4-mapped address as its IPv4', async () => {
  const { env } = makeEnv({ testers: false });
  for (let i = 1; i <= 10; i++) assert.equal((await me(env, { pass: 'nope', ip: `2001:db8:1:2:${i.toString(16)}::${i}` })).status, 401);
  assert.equal((await me(env, { pass: 'nope', ip: '2001:db8:1:2:ffff:ffff:ffff:ffff' })).status, 429, 'the whole /64 is locked');
  assert.equal((await me(env, { pass: RIGHT, ip: '2001:0db8:0001:0002::abcd' })).status, 429);
  assert.equal((await me(env, { pass: RIGHT, ip: '2001:db8:1:3::1' })).status, 200, 'the next /64 is another network');
  for (let i = 0; i < 10; i++) await me(env, { pass: 'nope', ip: '192.0.2.1' });
  assert.equal((await me(env, { pass: RIGHT, ip: '::ffff:192.0.2.1' })).status, 429, 'the same IPv4 address');
  assert.equal((await me(env, { pass: RIGHT, ip: '192.0.2.2' })).status, 200, 'the next IPv4 address is another network');
});

test('a clearance: the right passcode once, then no Durable Object round trip; a wrong passcode with it is still counted', async () => {
  const { env, G } = makeEnv({ testers: false });
  const first = await me(env, { pass: RIGHT, ip: '198.51.100.7' });
  assert.equal(first.status, 200);
  const set = first.headers.getSetCookie().find((c) => c.startsWith(`${CLEAR_COOKIE}=`));
  assert.match(set, new RegExp(`^${CLEAR_COOKIE}=v1\\.[0-9a-z]{6,12}\\.[A-Za-z0-9_-]{43}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict$`));
  const cookie = clearanceOf(first);
  const n = attempts(G);
  for (let i = 0; i < 5; i++) {
    const r = await me(env, { pass: RIGHT, ip: '198.51.100.7', cookie });
    assert.equal(r.status, 200);
    assert.equal(clearanceOf(r), null, 'renewed at most once a day');
  }
  assert.equal(attempts(G), n, 'the owner’s normal requests never reach the Guard');
  assert.ok(G.calls.filter((c) => c === 'burned').length <= 1, 'only the background sync of burned clearances, at most every 15 s');
  const wrong = await me(env, { pass: 'nope', ip: '198.51.100.7', cookie });
  assert.equal(wrong.status, 401);
  assert.equal(attempts(G), n + 1);
  assert.equal(guardFails(G), 1);
  // a tampered or made-up clearance is just no clearance
  for (const bad of [cookie.slice(0, -2) + (cookie.endsWith('AA') ? 'BB' : 'AA'), `${CLEAR_COOKIE}=v1.zzzzzzzz.${'A'.repeat(43)}`, `${CLEAR_COOKIE}=nope`]) {
    const before = attempts(G);
    assert.equal((await me(env, { pass: RIGHT, ip: '198.51.100.7', cookie: bad })).status, 200);
    assert.ok(attempts(G) > before, `${bad.slice(0, 40)}: checked by the Guard`);
  }
});

test('no lock or seal shuts out a device that signed in: its clearance and the right passcode keep working', async () => {
  const { env, G } = makeEnv({ testers: false });
  const cookie = clearanceOf(await me(env, { pass: RIGHT, ip: '198.51.100.8' }));
  for (let i = 0; i < 12; i++) await me(env, { pass: 'nope', ip: '198.51.100.8' }); // someone on the owner's own network (CGNAT)
  assert.equal((await me(env, { pass: RIGHT, ip: '198.51.100.8' })).status, 429, 'no clearance: locked like anyone');
  const calls = attempts(G);
  assert.equal((await me(env, { pass: RIGHT, ip: '198.51.100.8', cookie })).status, 200, 'the owner’s phone: still in');
  assert.equal(attempts(G), calls);
});

test('the global budget: from 20 compared wrong guesses only fresh networks are compared, from 30 none are; a locked network hammering away moves nothing', async () => {
  const { env, G } = makeEnv({ testers: false });
  const wrongFrom = async (ip, n) => { const out = []; for (let i = 0; i < n; i++) out.push((await me(env, { pass: 'nope', ip })).status); return out; };
  const cookie = clearanceOf(await me(env, { pass: RIGHT, ip: '198.51.100.99' })); // the owner's device, signed in earlier
  await wrongFrom('203.0.113.1', 10); // locked
  assert.deepEqual(await wrongFrom('203.0.113.1', 40), Array(40).fill(429), 'refused unchecked');
  assert.equal(compared(G), 10, 'a locked network’s refused guesses never reach the global budget');
  await wrongFrom('203.0.113.2', 9); // 19 compared; .2 is dirty but not locked
  assert.equal((await me(env, { pass: RIGHT, ip: '203.0.113.2' })).status, 200, 'normal mode: a dirty network with the right passcode is let in');
  await wrongFrom('203.0.113.3', 1); // 20: strict
  let r = await me(env, { pass: RIGHT, ip: '203.0.113.2' });
  assert.equal(r.status, 429, 'strict: a network with a recent failure is refused, right passcode or not');
  assert.equal((await r.json()).code, 'passcode_busy');
  assert.equal((await me(env, { pass: RIGHT, ip: '203.0.113.50' })).status, 200, 'strict: a fresh network with the right passcode is let in');
  for (let i = 0; i < 9; i++) assert.equal((await me(env, { pass: 'nope', ip: `203.0.113.${60 + i}` })).status, 401, 'one compared guess per fresh network');
  assert.equal((await me(env, { pass: 'nope', ip: '203.0.113.60' })).status, 429, 'and only one');
  assert.equal(compared(G), 29);
  assert.equal(guardFails(G), 10 + 40 + 9 + 1 + 9, 'a refusal for the global budget (strict or sealed) counts nowhere');
  await me(env, { pass: 'nope', ip: '203.0.113.70' }); // 30: sealed
  assert.equal(compared(G), 30);
  r = await me(env, { pass: RIGHT, ip: '203.0.113.80' });
  assert.equal(r.status, 429, 'sealed: not even a fresh network is compared');
  assert.match((await r.json()).error, /Devices already signed in keep working/);
  const calls = attempts(G);
  assert.equal((await me(env, { pass: RIGHT, ip: '203.0.113.81', cookie })).status, 200, 'sealed: the owner’s signed-in device still works');
  assert.equal(attempts(G), calls);
  assert.ok(Number(r.headers.get('retry-after')) <= GUARD.windowMs / 1000 + 60, 'at most the window (and the minute it counts by)');
  // 16 minutes later the window has cleared
  const t = Date.now() + GUARD.windowMs + 60_000;
  G.guard.clock = () => t;
  assert.equal((await me(env, { pass: RIGHT, ip: '203.0.113.80' })).status, 200);
  assert.equal((await me(env, { pass: RIGHT, ip: '203.0.113.1' })).status, 200, 'the lock ended with the window');
});

test('the lock lasts 15 minutes from the 10th failure; failures while locked don’t extend it; a network that keeps going gets one guess per lock', async () => {
  const { env, G } = makeEnv({ testers: false });
  let now = Date.now();
  G.guard.clock = () => now;
  for (let i = 0; i < 10; i++) await me(env, { pass: 'nope', ip: '192.0.2.77' });
  now += 10 * 60_000;
  for (let i = 0; i < 5; i++) assert.equal((await me(env, { pass: 'nope', ip: '192.0.2.77' })).status, 429);
  now += 5 * 60_000 + 1000; // 15 min after the 10th failure
  assert.equal((await me(env, { pass: 'nope', ip: '192.0.2.77' })).status, 401, 'compared again once the lock ended');
  assert.equal((await me(env, { pass: RIGHT, ip: '192.0.2.77' })).status, 429, 'it was still busy: locked again at once');
  now += GUARD.windowMs + 1000; // quiet for 15 minutes: forgotten
  assert.equal((await me(env, { pass: RIGHT, ip: '192.0.2.77' })).status, 200);
});

test('a clearance is renewed once it is a day old, ends after 30 days, and dies with the passcode', async () => {
  const { env, G } = makeEnv({ testers: false });
  const cookie = clearanceOf(await me(env, { pass: RIGHT, ip: '198.51.100.20' }));
  const realNow = Date.now;
  try {
    const t0 = realNow();
    Date.now = () => t0 + 2 * 86_400_000;
    let r = await me(env, { pass: RIGHT, ip: '198.51.100.20', cookie });
    assert.equal(r.status, 200);
    assert.ok(clearanceOf(r), 'renewed');
    Date.now = () => t0 + 31 * 86_400_000;
    const calls = attempts(G);
    r = await me(env, { pass: RIGHT, ip: '198.51.100.20', cookie });
    assert.ok(attempts(G) > calls, 'expired: back through the Guard');
  } finally { Date.now = realNow; }
  // a new passcode: the old clearance proves nothing
  env.APP_PASSCODE = 'a much longer new passcode';
  const calls = attempts(G);
  const r = await me(env, { pass: 'a much longer new passcode', ip: '198.51.100.20', cookie });
  assert.equal(r.status, 200);
  assert.ok(attempts(G) > calls, 'checked by the Guard again');
  assert.ok(clearanceOf(r) && clearanceOf(r) !== cookie);
  assert.equal((await me(env, { pass: RIGHT, ip: '198.51.100.20', cookie })).status, 401, 'the old passcode with the old clearance is just wrong');
});

test('no Guard, or a Guard that fails: a passcode request is refused (503) and nothing is compared; requests without one are untouched', async () => {
  for (const GUARD_ of [undefined, { idFromName: () => 'main', get: () => ({ attempt: async () => { throw new Error('overloaded'); }, clearKey: async () => { throw new Error('overloaded'); } }) }]) {
    const { env } = makeEnv({ testers: false, GUARD: GUARD_ });
    const errors = [], realError = console.error;
    console.error = (...a) => errors.push(a.join(' '));
    try {
      for (const pass of [RIGHT, 'nope']) {
        const r = await me(env, { pass });
        assert.equal(r.status, 503);
        assert.deepEqual(await r.json(), { error: 'Atelier couldn’t check the passcode just now — try again in a moment.', code: 'guard_unavailable' });
      }
    } finally { console.error = realError; }
    assert.ok(errors.every((l) => !l.includes(RIGHT) && !/overloaded/.test(l)), 'the log names the error, never its message or the passcode');
    const health = await api(env, 'health');
    assert.equal(health.status, 200);
  }
});

test('the alarm deletes a network’s record 15 minutes after its last failure (and after its lock)', async () => {
  const { env, G } = makeEnv({ testers: false });
  let now = Date.now();
  G.guard.clock = () => now;
  for (let i = 0; i < 3; i++) await me(env, { pass: 'nope', ip: '192.0.2.200' });
  assert.ok(G.shim.alarm() > now && G.shim.alarm() <= now + GUARD.windowMs + 2000, 'an alarm is set for when the record can go');
  const rows = G.shim.db.prepare('SELECT id FROM nets').all();
  assert.equal(rows.length, 1);
  assert.match(rows[0].id, /^[0-9a-f]{32}$/, 'a keyed hash of the network, never the address');
  assert.ok(!JSON.stringify(G.shim.db.prepare('SELECT * FROM nets').all()).includes('192.0.2'), 'no address stored');
  now += GUARD.windowMs + 1000;
  await G.guard.alarm();
  assert.equal(G.shim.db.prepare('SELECT COUNT(*) AS n FROM nets').get().n, 0);
  assert.equal(G.shim.db.prepare('SELECT COUNT(*) AS n FROM wrong').get().n, 0);
});

test('the tester cookie is still cleared when the owner’s clearance is set on the same answer (tester access off)', async () => {
  const { env } = makeEnv({ testers: false });
  const r = await me(env, { pass: RIGHT, cookie: `${COOKIE}=${'a'.repeat(43)}` });
  assert.equal(r.status, 200);
  const cookies = r.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  assert.match(cookies[0], /^__Host-atelier_tester=; Path=\/; Max-Age=0/);
  assert.match(cookies[1], new RegExp(`^${CLEAR_COOKIE}=v1\\.`));
});

test('passOk is constant-time: no early exit on length, the loop runs over the secret, and it still decides right', async () => {
  const SRC = await read('src/worker.js');
  const fn = /export function safeEqual\(a, b\) \{([\s\S]*?)\n\}/.exec(SRC)?.[1] || '';
  assert.doesNotMatch(fn, /length !==|length ===|return false;[^\n]*length/, 'no length short-cut');
  assert.match(fn, /let diff = a\.length \^ b\.length;/);
  assert.match(fn, /for \(let i = 0; i < b\.length; i\+\+\) diff \|= \(a\.charCodeAt\(i\) \| 0\) \^ b\.charCodeAt\(i\);/);
  assert.match(SRC, /const passOk = \(req, env\) => Boolean\(env\.APP_PASSCODE\) && safeEqual\(req\.headers\.get\('x-app-pass'\) \|\| '', env\.APP_PASSCODE\);/);
  const secret = 'correct horse battery staple';
  assert.equal(safeEqual(secret, secret), true);
  for (const guess of ['', 'c', 'correct', secret.slice(0, -1), `${secret}!`, `${secret}\u0000`, secret.toUpperCase(), 'x'.repeat(10_000)]) assert.equal(safeEqual(guess, secret), false, JSON.stringify(guess.slice(0, 20)));
  assert.equal(safeEqual('\u0000', ''), false);
  assert.equal(safeEqual(null, secret), false);
  // the Guard compares SHA-256 digests the same way
  const [a, b] = await Promise.all([sha256hex('pw'), sha256hex('pX')]);
  assert.equal(sameDigest(a, a), true);
  assert.equal(sameDigest(a, b), false);
  assert.equal(sameDigest(a, a.toUpperCase()), false);
  assert.equal(sameDigest('', ''), false);
});

test('wiring: the Guard is bound and migrated, the Worker runs it before every route, and KV holds no lockout counter', async () => {
  const [WORKER, WRANGLER, GUARD_SRC] = await Promise.all([read('src/worker.js'), read('wrangler.jsonc'), read('src/guard.js')]);
  assert.match(WRANGLER, /\{ "name": "GUARD", "class_name": "Guard" \}/);
  assert.match(WRANGLER, /\{ "tag": "v3", "new_sqlite_classes": \["Guard"\] \}/);
  assert.match(WORKER, /export \{ Guard \} from '\.\/guard\.js';/);
  assert.match(WORKER, /async fetch\(req, env, ctx\) \{/);
  assert.match(WORKER, /const gate = await passcodeGate\(req, env, passOk, ctx\);\n\s+const response = gate\.refuse \|\| await handleApi\(req, env, url\);/);
  assert.match(WRANGLER, /\{ "name": "GUARD_LIMIT", "namespace_id": "4715", "simple": \{ "limit": 30, "period": 60 \} \}/);
  assert.equal(GUARD.shedPerMinute, 30, 'the binding’s limit, as src/guard.js describes it');
  assert.doesNotMatch(WORKER, /fail:\$\{|ATELIER_KV\.put\(key, String\(fails/);
  // the decision is one synchronous transaction: nothing awaited between reading the record and writing the count
  const decide = /#decide\(id, got, want, now, relax\) \{([\s\S]*?)\n {2}\}/.exec(GUARD_SRC)?.[1] || '';
  assert.ok(decide.length > 200);
  assert.doesNotMatch(decide, /await|async|\.then\(/);
  const burn = /#burn\(burn, now\) \{([\s\S]*?)\n {2}\}/.exec(GUARD_SRC)?.[1] || '';
  assert.ok(burn.length > 100);
  assert.doesNotMatch(burn, /await|async|\.then\(/);
  assert.match(GUARD_SRC, /const out = this\.storage\.transactionSync\(\(\) => \{\n\s+const burned = this\.#burn\(opts\?\.burn, now\);\n\s+const v = this\.#decide\(id, got, want, now, opts\?\.relax === true\);/);
  // the clearance key is the Worker's own: no RPC fetches it, and the Guard has no method that returns one
  assert.doesNotMatch(GUARD_SRC, /clearKey\(|\.clearKey\b/);
  assert.match(GUARD_SRC, /const raw = new Uint8Array\(await crypto\.subtle\.sign\('HMAC', base, enc\(`atelier-clearance-v1\|\$\{want\}`\)\)\);/);
});

test('privacy.html discloses the owner’s clearance cookie and how long a failed network’s record is kept, as src/guard.js has them', async () => {
  const PRIVACY = await read('public/privacy.html');
  const text = PRIVACY.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.equal(CLEAR_COOKIE, '__Host-atelier_owner');
  assert.equal(GUARD.clearDays, 30);
  assert.equal(GUARD.windowMs, 15 * 60_000);
  for (const words of ['__Host-atelier_owner', 'lasts up to 30 days', 'one-way keyed code for the network', 'Atelier keeps only that code and a count of failures. It never stores the address itself.',
    'deleted 15 minutes after that network’s last failure', 'never used for tracking', 'a cap on wrong attempts from all networks together',
    'If it is ever sent with a wrong passcode, Atelier keeps a one-way code of it. Atelier never keeps the cookie itself. The code is kept until the date the cookie would have expired.'])
    assert.ok(text.includes(words), words);
  assert.doesNotMatch(text, /the only cookies are the tester sign-in cookies/);
});

// Settings → Access: the weak-passcode note (public/app.js), worked out on the device from the field's value only.
test('the weak-passcode note: short, common or patterned passcodes get it; a long, varied one doesn’t; nothing is sent', async () => {
  const APP = (await read('public/app.js')).replace(/\r\n/g, '\n');
  const grab = (start, end) => { const at = APP.indexOf(start); assert.ok(at >= 0, start); return APP.slice(at, APP.indexOf(end, at) + end.length); };
  const src = grab('const COMMON_PASSCODES = new Set([', '\n}\n') ;
  const weakness = new Function(`${src.replace(/^const /gm, 'var ')}; return passcodeWeakness;`)();
  for (const p of ['password', 'Password123!', 'atelier', 'qwerty', '123456', '12345678901234', '00000000000000000', 'aaaa', 'abcdef', 'fedcba', 'letmein', 'zxcvbnm'])
    assert.equal(weakness(p), 'common', p);
  for (const p of ['Tr0ub4dor&3', 'kH8#qz', 'a1b2c3d4']) assert.equal(weakness(p), 'short', p);
  assert.equal(weakness('abababababababab'), 'common', 'long but only two characters');
  for (const p of ['', 'correct horse battery staple', 'Velvet-Orchid-Tram-42', '9f2Kq!mZ7#wLp']) assert.equal(weakness(p), '', p);
  const show = grab('function showPassWeak() {', '\n}\n');
  const all = src + show;
  assert.doesNotMatch(all, /fetch\(|sendBeacon|XMLHttpRequest|LS\.set|localStorage|console\./, 'computed and shown locally, never sent, stored or logged');
  assert.match(show, /box\.textContent = /, 'text only, never HTML');
  assert.match(APP, /\$\('#passcodeField'\)\?\.addEventListener\('input', showPassWeak\);/);
  assert.match(APP, /f\.passcode\.value = s\.passcode;\n  showPassWeak\(\);/);
  const HTML = await read('public/index.html');
  assert.match(HTML, /<p class="hint" id="passResult" role="status"><\/p>\s*<p class="hint pass-weak" id="passWeak" hidden><\/p>/);
});

test('POST /api/clearance/end removes the clearance, even next to the right passcode; the app sends it on sign-out and Clear this device', async () => {
  const { env } = makeEnv({ testers: false });
  const cookie = clearanceOf(await me(env, { pass: RIGHT }));
  // with the clearance; and with the right passcode and no clearance (the guard would hand out a new one); as the app's
  // own fetch sends it: Origin the app, Sec-Fetch-Site same-origin (or no Sec-Fetch-Site at all)
  for (const [pass, headers] of [[undefined, { cookie, 'sec-fetch-site': 'same-origin' }], [RIGHT, {}]]) {
    const r = await api(env, 'clearance/end', { method: 'POST', headers }, { pass });
    assert.equal(r.status, 204);
    assert.deepEqual(r.headers.getSetCookie(), [`${CLEAR_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`], 'only the removal, never a fresh one beside it');
  }
  assert.equal((await api(env, 'clearance/end', { method: 'GET' })).status, 405);
  const APP = (await read('public/app.js'));
  assert.match(APP, /if \(hadPasscode && !s\.passcode\) fetch\('\/api\/clearance\/end', \{ method: 'POST' \}\)\.catch\(\(\) => \{\}\);/);
  assert.match(APP, /else await fetch\('\/api\/clearance\/end', \{ method: 'POST' \}\)\.catch\(\(\) => \{\}\); \/\/ \.\.\.and the owner's passcode-guard clearance/);
  assert.match(await read('public/privacy.html'), /Clearing the passcode in Settings, or Clear this device, removes it\./);
});

// ── v90 review of the guard ──
// [MEDIUM] POST /api/clearance/end had no CSRF check: another site's form POST (a top-level navigation, whose Set-Cookie
// a browser applies whatever SameSite says) stripped the owner's clearance, and with the seal held up the owner's
// signed-in device was then locked out like any other.
test('POST /api/clearance/end answers only the app’s own pages: a cross-site form, no Origin or a null one gets 403 and no Set-Cookie', async () => {
  const { env } = makeEnv({ testers: false });
  const cookie = clearanceOf(await me(env, { pass: RIGHT, ip: '198.51.100.90' }));
  const cases = [
    [{ origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' }, 'a cross-site form POST'],
    [{}, 'no Origin (curl, an old browser)'],
    [{ origin: 'null' }, 'Origin null (a sandboxed frame, a data: page)'],
    [{ origin: 'https://atelier.ciprari.ai.evil.example' }, 'a look-alike origin'],
    [{ origin: ORIGIN, 'sec-fetch-site': 'same-site' }, 'a sibling subdomain'],
    [{ origin: ORIGIN, 'sec-fetch-site': 'cross-site' }, 'the app’s Origin with a cross-site fetch'],
  ];
  for (const [headers, what] of cases) {
    const r = await api(env, 'clearance/end', { method: 'POST', headers: { cookie, ...headers } }, { origin: null });
    assert.equal(r.status, 403, what);
    assert.deepEqual(r.headers.getSetCookie(), [], `${what}: no Set-Cookie at all`);
    assert.equal((await r.json()).code, 'clearance_origin');
  }
  // the right passcode beside a refused end mints nothing either
  const withPass = await api(env, 'clearance/end', { method: 'POST', headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } }, { pass: RIGHT, origin: null });
  assert.equal(withPass.status, 403);
  assert.deepEqual(withPass.headers.getSetCookie(), []);
  // the clearance still works after all of them, and the app's own request ends it
  assert.equal((await me(env, { pass: RIGHT, ip: '198.51.100.90', cookie })).status, 200);
  const own = await api(env, 'clearance/end', { method: 'POST', headers: { cookie, 'sec-fetch-site': 'same-origin' } });
  assert.equal(own.status, 204);
  assert.deepEqual(own.headers.getSetCookie(), [`${CLEAR_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`]);
});

// [MEDIUM + LOW] A signed-in device still needed the Guard once per isolate (the clearance key came from it by RPC), so
// a Guard outage or overload answered 503 to signed-in devices on any fresh isolate. The key is now the Worker's own.
test('a signed-in device never needs the Guard: on a fresh isolate, with the Guard stalled or down, it gets 200', async () => {
  const stalled = makeGuard({ before: (name) => (name === 'burned' ? new Promise(() => {}) : undefined) });
  const { env } = makeEnv({ testers: false, guard: stalled });
  const cookie = clearanceOf(await me(env, { pass: RIGHT, ip: '198.51.100.40' }));
  resetGuardCaches(); // a new isolate: no passcode digest, no key, no burned list
  const r = await me(env, { pass: RIGHT, ip: '198.51.100.40', cookie });
  assert.equal(r.status, 200, 'the burned-list sync never answers, and nothing waits on it');
  assert.equal(attempts(stalled), 1, 'only the sign-in itself went to the Guard');
  assert.equal(stalled.calls.filter((c) => c === 'burned').length, 1, 'one background sync, started and not awaited');
  const down = { idFromName: () => 'main', get: () => ({ attempt: async () => { throw new Error('overloaded'); }, burned: async () => { throw new Error('overloaded'); } }) };
  env.GUARD = down;
  const errors = [], realError = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    for (let i = 0; i < 3; i++) {
      resetGuardCaches();
      const rs = await Promise.all(Array.from({ length: 5 }, () => me(env, { pass: RIGHT, ip: '198.51.100.40', cookie })));
      assert.deepEqual(statuses(rs), { 200: 5 }, `fresh isolate ${i}: the Guard down, every request in`);
      await guardSynced();
    }
    // without the clearance (or with a wrong passcode) nothing is compared while the Guard is down
    assert.equal((await me(env, { pass: RIGHT, ip: '198.51.100.40' })).status, 503);
    assert.equal((await me(env, { pass: 'nope', ip: '198.51.100.40', cookie })).status, 503);
  } finally { console.error = realError; }
  assert.ok(errors.every((l) => !/overloaded/.test(l) && !l.includes(RIGHT)));
});

// [LOW] A copied clearance was an unthrottled oracle: wrong guesses with it got 429 from a locked or sealed Guard, the
// right one 200 through the fast path, at any rate.
test('a clearance sent with a wrong passcode is burned: a copied cookie can’t tell a right guess from refused wrong ones', async () => {
  const { env, G } = makeEnv({ testers: false });
  const cookie = clearanceOf(await me(env, { pass: RIGHT, ip: '198.51.100.30' }));
  // the guard sealed by someone (30 compared wrong guesses from 30 networks)
  for (let i = 0; i < 30; i++) await me(env, { pass: 'nope', ip: `203.0.113.${100 + i}` });
  assert.equal(compared(G), 30);
  // the thief: 200 parallel guesses with the copied cookie, from one address; all refused
  const rs = await Promise.all(Array.from({ length: 200 }, (_, i) => me(env, { pass: `guess-${i}`, ip: '192.0.2.66', cookie })));
  assert.deepEqual(statuses(rs), { 429: 200 });
  // then the right passcode with the same cookie: no fast path any more, the same refusal as every guess
  const right = await me(env, { pass: RIGHT, ip: '192.0.2.66', cookie });
  assert.equal(right.status, 429, 'refused like the wrong ones: the oracle is closed');
  assert.equal((await right.json()).code, 'passcode_busy');
  assert.equal(clearanceOf(right), null);
  // the Guard keeps a one-way code of it until it would have expired, never the cookie itself
  const rows = G.shim.db.prepare('SELECT id, until FROM burned').all();
  assert.equal(rows.length, 1);
  assert.match(rows[0].id, /^[0-9a-f]{32}$/);
  assert.ok(rows[0].until > Date.now() + 29 * 86_400_000 && rows[0].until <= Date.now() + 30 * 86_400_000 + 60_000);
  assert.ok(!JSON.stringify(rows).includes(cookie.split('=')[1].slice(3, 20)));
  // once the seal lifts it is only a passcode again: the Guard compares it, and a right one gets a NEW clearance
  const t = Date.now() + GUARD.windowMs + 60_000;
  G.guard.clock = () => t;
  const n = attempts(G);
  const back = await me(env, { pass: RIGHT, ip: '198.51.100.31', cookie });
  assert.equal(back.status, 200);
  assert.ok(attempts(G) > n, 'through the Guard');
  assert.ok(clearanceOf(back) && clearanceOf(back) !== cookie, 'a fresh clearance replaces the burned one');
  assert.equal((await me(env, { pass: RIGHT, ip: '198.51.100.31', cookie: clearanceOf(back) })).status, 200);
});

test('a burned clearance reaches every isolate: one that never saw the wrong guess stops honouring it once its background sync lands', async () => {
  const { env, G } = makeEnv({ testers: false });
  const cookie = clearanceOf(await me(env, { pass: RIGHT, ip: '198.51.100.32' }));
  for (let i = 0; i < 10; i++) await me(env, { pass: 'nope', ip: '192.0.2.67' }); // the thief's network, locked
  assert.equal((await me(env, { pass: 'nope', ip: '192.0.2.68', cookie })).status, 401, 'one wrong guess with the cookie, elsewhere: burned');
  resetGuardCaches(); // another isolate: it never saw that guess, and hasn't synced
  await me(env, { pass: RIGHT, ip: '192.0.2.67', cookie }); // starts its sync (the bounded window: this one may pass)
  await guardSynced();
  const after = await me(env, { pass: RIGHT, ip: '192.0.2.67', cookie });
  assert.equal(after.status, 429, 'synced: the cookie is no clearance here either, and the locked network is refused');
  assert.equal((await me(env, { pass: RIGHT, ip: '192.0.2.67' })).status, 429, 'exactly as without the cookie');
  // the owner's own device, with its own (unburned) clearance, is untouched by the burn
  resetGuardCaches();
  const mine = clearanceOf(await me(env, { pass: RIGHT, ip: '198.51.100.33' }));
  const n = attempts(G);
  assert.equal((await me(env, { pass: RIGHT, ip: '192.0.2.67', cookie: mine })).status, 200);
  assert.equal(attempts(G), n);
});

// [MEDIUM] Nothing shed load before the single global Guard, and every refusal wrote two rows and scanned the table.
test('GUARD_LIMIT sheds a flood before the Guard: the same 429 for right and wrong, nothing compared, no Durable Object call', async () => {
  const lim = limiter();
  const { env, G } = makeEnv({ testers: false, GUARD_LIMIT: lim });
  const cookie = clearanceOf(await me(env, { pass: RIGHT, ip: '198.51.100.50' })); // 1 of the owner's network's 30
  const rs = await Promise.all(Array.from({ length: 100 }, (_, i) => me(env, { pass: i === 99 ? RIGHT : 'nope', ip: '2001:db8:77:1::5' })));
  assert.equal(attempts(G), 1 + GUARD.shedPerMinute, 'only 30 a minute from one network reach the Guard');
  assert.deepEqual(statuses(rs), { 401: GUARD.networkLimit, 429: 100 - GUARD.networkLimit });
  assert.equal(guardFails(G), GUARD.shedPerMinute, 'shed requests count nowhere: they never reached the Guard');
  const shed = await rs[99].json();
  assert.deepEqual(shed, { error: 'Too many passcode tries from this network — try again in 1 minute.', code: 'passcode_locked', retryAfter: 60 }, 'the right passcode, shed: nothing compared');
  assert.equal(rs[99].headers.get('retry-after'), '60');
  assert.deepEqual([...new Set(lim.keys)], ['pass:198.51.100.50', 'pass:2001:db8:77:1::/64'], 'keyed by network (an IPv6 /64)');
  // the owner's network over the limit too: a signed-in device never reaches the throttle
  for (let i = 0; i < 40; i++) await me(env, { pass: 'nope', ip: '198.51.100.50' });
  const keys = lim.keys.length;
  assert.equal((await me(env, { pass: RIGHT, ip: '198.51.100.50', cookie })).status, 200);
  assert.equal(lim.keys.length, keys);
  // the binding failing: the Guard alone decides
  const broken = makeEnv({ testers: false, GUARD_LIMIT: { async limit() { throw new Error('down'); } } });
  assert.equal((await me(broken.env, { pass: RIGHT, ip: '198.51.100.51' })).status, 200);
  assert.equal(attempts(broken.G), 1);
});

test('a locked network’s refusals: counted one row at a time, its time moved at most once a minute, no scan and no new alarm', async () => {
  const { env, G } = makeEnv({ testers: false });
  let now = Date.now();
  G.guard.clock = () => now;
  for (let i = 0; i < 10; i++) await me(env, { pass: 'nope', ip: '192.0.2.150' });
  const alarm = G.shim.alarm();
  assert.ok(alarm > now);
  const log = [], exec = G.shim.ctx.storage.sql.exec, setAlarm = G.shim.ctx.storage.setAlarm;
  let alarms = 0;
  G.shim.ctx.storage.sql.exec = (q, ...b) => { log.push(q); return exec(q, ...b); };
  G.shim.ctx.storage.setAlarm = async (t) => { alarms++; return setAlarm(t); };
  const rs = await Promise.all(Array.from({ length: 100 }, () => me(env, { pass: 'nope', ip: '192.0.2.150' })));
  assert.deepEqual(statuses(rs), { 429: 100 });
  assert.equal(guardFails(G), 110, 'the true count');
  const writes = log.filter((q) => /^UPDATE nets/.test(q));
  assert.equal(writes.length, 100);
  assert.ok(writes.every((q) => q === 'UPDATE nets SET fails = fails + 1 WHERE id = ?'), 'one unindexed column: last_at stays within the minute');
  assert.equal(log.filter((q) => /MIN\(MAX\(/.test(q)).length, 0, 'no scan for the next expiry while an alarm is set');
  assert.equal(alarms, 0);
  assert.equal(G.shim.alarm(), alarm);
  const before = G.shim.db.prepare('SELECT last_at FROM nets').get().last_at;
  now += 61_000;
  assert.equal((await me(env, { pass: 'nope', ip: '192.0.2.150' })).status, 429);
  assert.equal(G.shim.db.prepare('SELECT last_at FROM nets').get().last_at, now, 'a minute on: moved once');
  assert.ok(now > before);
});

// [MEDIUM] The seal could be held indefinitely, and the owner's own app, refused during it, counted failures until it
// had locked its own network; there was no operator lever.
test('refusals for the global budget count nowhere: the owner’s app, retrying while someone holds the seal, never locks its own network', async () => {
  const { env, G } = makeEnv({ testers: false });
  let now = Date.now();
  G.guard.clock = () => now;
  for (let i = 0; i < 30; i++) await me(env, { pass: 'nope', ip: `2001:db8:${(i + 1).toString(16)}::1` });
  assert.equal(compared(G), 30, 'sealed');
  // a new phone without a clearance retries every minute, and one Ask fans out 17 requests at once
  for (let m = 0; m < 14; m++) {
    const r = await me(env, { pass: RIGHT, ip: '198.51.100.60' });
    assert.equal(r.status, 429);
    assert.equal((await r.json()).code, 'passcode_busy');
    now += 60_000;
  }
  const fan = await Promise.all(Array.from({ length: 17 }, () => me(env, { pass: RIGHT, ip: '198.51.100.60' })));
  assert.deepEqual(statuses(fan), { 429: 17 });
  assert.equal(G.shim.db.prepare('SELECT COUNT(*) AS n FROM nets').get().n, 30, 'no record for the owner’s network: nothing counted');
  now += 2 * 60_000; // quiet: the window has passed since the last compared guess
  const r = await me(env, { pass: RIGHT, ip: '198.51.100.60' });
  assert.equal(r.status, 200, 'in at once: no lock of its own to wait out');
  assert.ok(clearanceOf(r));
});

test('GUARD_RELAX ("1", a secret): the seal lifts and per-network locks stay; with the Guard down it falls back to GUARD_LIMIT alone', async () => {
  const { env, G } = makeEnv({ testers: false });
  for (let i = 0; i < 10; i++) await me(env, { pass: 'nope', ip: '203.0.113.90' }); // locked
  for (let i = 0; i < 20; i++) await me(env, { pass: 'nope', ip: `203.0.114.${i}` }); // 30 compared: sealed
  assert.equal((await me(env, { pass: RIGHT, ip: '198.51.100.70' })).status, 429, 'sealed');
  for (const v of ['true', 'yes', '0', ' 1']) {
    env.GUARD_RELAX = v;
    assert.equal((await me(env, { pass: RIGHT, ip: '198.51.100.70' })).status, 429, `GUARD_RELAX ${JSON.stringify(v)} is not the switch`);
  }
  env.GUARD_RELAX = '1';
  const r = await me(env, { pass: RIGHT, ip: '198.51.100.70' });
  assert.equal(r.status, 200, 'the owner’s new device signs in');
  assert.ok(clearanceOf(r), 'and keeps working once the switch is off again');
  assert.equal((await me(env, { pass: RIGHT, ip: '203.0.113.90' })).status, 429, 'a locked network stays locked');
  assert.equal((await me(env, { pass: 'nope', ip: '203.0.115.1' })).status, 401, 'a wrong guess is still compared and counted');
  assert.equal(compared(G), 31);
  delete env.GUARD_RELAX;
  assert.equal((await me(env, { pass: RIGHT, ip: '198.51.100.71' })).status, 429, 'off again: sealed');
  assert.equal((await me(env, { pass: RIGHT, ip: '198.51.100.71', cookie: clearanceOf(r) })).status, 200);
  // the Guard down
  const down = { idFromName: () => 'main', get: () => ({ attempt: async () => { throw new Error('overloaded'); }, burned: async () => { throw new Error('overloaded'); } }) };
  const realError = console.error;
  console.error = () => {};
  try {
    const lim = limiter();
    const relaxed = makeEnv({ testers: false, GUARD: down, GUARD_RELAX: '1', GUARD_LIMIT: lim }).env;
    const ok = await me(relaxed, { pass: RIGHT, ip: '198.51.100.72' });
    assert.equal(ok.status, 200, 'through on the per-network throttle; the route compares the passcode');
    assert.equal(clearanceOf(ok), null, 'no clearance without the Guard');
    assert.equal((await me(relaxed, { pass: 'nope', ip: '198.51.100.72' })).status, 401);
    for (let i = 0; i < GUARD.shedPerMinute; i++) await me(relaxed, { pass: 'nope', ip: '198.51.100.72' });
    assert.equal((await me(relaxed, { pass: RIGHT, ip: '198.51.100.72' })).status, 429, 'and that throttle holds');
    assert.equal((await me(makeEnv({ testers: false, GUARD: down, GUARD_LIMIT: limiter() }).env, { pass: RIGHT })).status, 503, 'not relaxed: closed');
    assert.equal((await me(makeEnv({ testers: false, GUARD: down, GUARD_RELAX: '1' }).env, { pass: RIGHT })).status, 503, 'no throttle to fall back on: closed');
    assert.equal((await me(makeEnv({ testers: false, GUARD: down, GUARD_RELAX: '1', GUARD_LIMIT: { async limit() { throw new Error('x'); } } }).env, { pass: RIGHT })).status, 503, 'the throttle failing: closed');
  } finally { console.error = realError; }
});

test('without GUARD_SECRET (or a short one) no clearance is minted or honoured, the Guard decides every request, and it is said once', async () => {
  const { env, G } = makeEnv({ testers: false });
  const cookie = clearanceOf(await me(env, { pass: RIGHT, ip: '198.51.100.80' }));
  const warns = [], realWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    for (const secret of [undefined, 'short secret']) {
      if (secret === undefined) delete env.GUARD_SECRET; else env.GUARD_SECRET = secret;
      resetGuardCaches();
      for (let i = 0; i < 2; i++) {
        const n = attempts(G);
        const r = await me(env, { pass: RIGHT, ip: '198.51.100.80', cookie });
        assert.equal(r.status, 200);
        assert.equal(clearanceOf(r), null, 'nothing minted');
        assert.equal(attempts(G), n + 1, 'the cookie isn’t honoured: the Guard decides');
      }
    }
  } finally { console.warn = realWarn; }
  assert.deepEqual(warns, Array(2).fill('passcode guard: GUARD_SECRET is not set, so no clearance is minted or honoured'));
  // a new GUARD_SECRET voids every clearance, like a new passcode
  env.GUARD_SECRET = 'another-guard-secret-0123456789abcdef-0123';
  resetGuardCaches();
  const n = attempts(G);
  assert.equal((await me(env, { pass: RIGHT, ip: '198.51.100.80', cookie })).status, 200);
  assert.equal(attempts(G), n + 1);
});

test('the README has the runbook: GUARD_SECRET, GUARD_RELAX, rotating during a seal, and no rollback past the Guard', async () => {
  const README = (await read('README.md')).replace(/\s+/g, ' ');
  for (const words of ['npx wrangler secret put GUARD_SECRET', 'npx wrangler secret put GUARD_RELAX', 'npx wrangler secret delete GUARD_RELAX',
    'rotate the passcode only if it leaked', 'cannot be rolled back', 'GUARD_LIMIT'])
    assert.ok(README.includes(words), words);
});

test('ship refuses to deploy without GUARD_SECRET: it reads the Worker’s secret names (never values) and only notes an unreadable list', async () => {
  const { workerSecretNames, secretLines, REQUIRED_SECRETS } = await import('../scripts/ship.mjs');
  assert.deepEqual(REQUIRED_SECRETS, ['APP_PASSCODE', 'GUARD_SECRET']);
  const calls = [];
  const fake = (stdout, ok = true) => (args) => { calls.push(args); return { ok, stdout, stderr: ok ? '' : '✘ [ERROR] You are not logged in.' }; };
  const listing = (names) => JSON.stringify(names.map((name) => ({ name, type: 'secret_text' })), null, '  ');
  const all = workerSecretNames({ run: fake(listing(['ANTHROPIC_API_KEY', 'APP_PASSCODE', 'GUARD_SECRET'])) });
  assert.deepEqual(all, { ok: true, names: ['ANTHROPIC_API_KEY', 'APP_PASSCODE', 'GUARD_SECRET'] });
  assert.deepEqual(calls[0], ['secret', 'list', '--format', 'json'], 'a listing only: no put, no delete');
  assert.deepEqual(secretLines(all), { fatal: [], notes: [], ok: ['Worker secrets APP_PASSCODE and GUARD_SECRET are set (names only)'] });
  const missing = secretLines(workerSecretNames({ run: fake(listing(['APP_PASSCODE'])) }));
  assert.equal(missing.fatal.length, 1);
  assert.match(missing.fatal[0], /^Worker secret GUARD_SECRET is not set: npx wrangler secret put GUARD_SECRET/);
  const offline = secretLines(workerSecretNames({ run: fake('', false) }));
  assert.deepEqual(offline.fatal, [], 'an unreadable list never blocks');
  assert.match(offline.notes[0], /Worker secrets not checked \(✘ \[ERROR\] You are not logged in\.\)/);
  assert.equal(workerSecretNames({ run: fake('Not JSON at all') }).ok, false);
  const SHIP = await read('scripts/ship.mjs');
  assert.match(SHIP, /const sec = secretLines\(workerSecretNames\(\)\);[\s\S]{0,200}for \(const m of sec\.fatal\) check\(false, m\);/, 'a missing secret goes on ship’s problem list');
  assert.doesNotMatch(SHIP, /'secret', '(put|delete|bulk)'/, 'ship never sets or deletes a secret');
});
