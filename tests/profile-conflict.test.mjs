// v114 (whole-app review, sync #0): the owner's profile was last-writer-wins. A tab left open since the morning sent
// its whole copy over what other devices had saved since: "Approve everything", switched off on the phone, came back
// on everywhere, and learned facts were dropped. The app now joins before it writes (tests/profile-merge.test.mjs);
// these run the other half through the real Worker and the app's own syncMe:
//   - PUT /api/me names the copy it was joined against (x-me-base) and is refused with 409 when a newer one is stored;
//   - a build older than the join cannot write the profile at all (the build floor);
//   - syncMe joins again on a 409, and goes by the newer copy when the store answers with an older one.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeEnv, api, restoreFetch } from './tester-env.mjs';
import { mergeProfile } from '../public/context.js';
const { MIN_CLIENT_BUILD } = await import('../src/worker.js');

afterEach(() => restoreFetch());
const APP = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const put = (env, doc, { base, build = String(MIN_CLIENT_BUILD), raw } = {}) => api(env, 'me', {
  method: 'PUT', body: raw ?? JSON.stringify(doc),
  headers: { 'content-type': 'application/json', ...(build == null ? {} : { 'x-atelier-build': build }), ...(base == null ? {} : { 'x-me-base': String(base) }) },
}, { pass: 'pw' });
const stored = async (env) => (await api(env, 'me', {}, { pass: 'pw' })).json();

test('PUT /api/me: a write joined against an older copy than the stored one is refused with that copy (409 me_conflict)', async () => {
  const { env } = makeEnv({ testers: false });
  // Nothing stored yet: the first write names 0.
  assert.equal((await put(env, { bio: 'one', updatedAt: 100 }, { base: 0 })).status, 200);
  assert.deepEqual(await stored(env), { bio: 'one', updatedAt: 100 });
  // The phone read 100 and writes 200. The desktop tab also read 100: its write is refused, and it gets the 200 copy.
  assert.equal((await put(env, { bio: 'phone', approvals: { approveAll: false }, updatedAt: 200 }, { base: 100 })).status, 200);
  const late = await put(env, { bio: 'desktop', approvals: { approveAll: true }, updatedAt: 150 }, { base: 100 });
  assert.equal(late.status, 409);
  assert.deepEqual(await late.json(), { error: 'The profile changed on another device.', code: 'me_conflict', profile: { bio: 'phone', approvals: { approveAll: false }, updatedAt: 200 } });
  assert.equal((await stored(env)).bio, 'phone', 'the refused write stored nothing');
  // Joined against the stored copy: accepted. So is a base newer than the stored copy (the store answered this read
  // with an older copy than the app already held; the app is ahead, not behind).
  assert.equal((await put(env, { bio: 'joined', updatedAt: 300 }, { base: 200 })).status, 200);
  assert.equal((await put(env, { bio: 'ahead', updatedAt: 500 }, { base: 400 })).status, 200);
  assert.equal((await stored(env)).bio, 'ahead');
  // A base that is not a number names no copy: refused, never taken for "0".
  for (const base of ['abc', '-1', '1e3', '12.5', ' ']) assert.equal((await put(env, { bio: 'x', updatedAt: 900 }, { base })).status, 409, JSON.stringify(base));
  assert.equal((await stored(env)).bio, 'ahead');
});

test('PUT /api/me: a profile is a JSON object; the passcode comes first; no base header still writes (not the app)', async () => {
  const { env } = makeEnv({ testers: false });
  for (const raw of ['[]', '"x"', '5', 'null', 'true']) {
    const r = await put(env, null, { raw, base: 0 });
    assert.equal(r.status, 400, raw);
    assert.equal((await r.json()).error, 'A profile is a JSON object.');
  }
  assert.equal((await put(env, null, { raw: '{', base: 0 })).status, 400);
  assert.deepEqual(await stored(env), {}, 'nothing was stored');
  const noPass = await api(env, 'me', { method: 'PUT', body: '{}', headers: { 'content-type': 'application/json', 'x-me-base': '0' } });
  assert.equal(noPass.status, 401);
  assert.equal((await put(env, { bio: 'plain', updatedAt: 5 })).status, 200, 'without x-me-base the write is taken as before');
  assert.equal((await stored(env)).bio, 'plain');
});

test('the build floor: a build from before the join cannot write the profile (426), and still reads it', async () => {
  const { env } = makeEnv({ testers: false });
  assert.ok(MIN_CLIENT_BUILD >= 114, 'v114 is where the profile is joined before it is written');
  await put(env, { bio: 'kept', approvals: { approveAll: false }, updatedAt: 10 }, { base: 0 });
  const old = await put(env, { bio: 'stale tab', approvals: { approveAll: true }, updatedAt: 99 }, { build: String(MIN_CLIENT_BUILD - 1) });
  assert.equal(old.status, 426);
  assert.equal((await old.json()).code, 'app_outdated');
  assert.deepEqual(await stored(env), { bio: 'kept', approvals: { approveAll: false }, updatedAt: 10 });
  const read = await api(env, 'me', { headers: { 'x-atelier-build': String(MIN_CLIENT_BUILD - 1) } }, { pass: 'pw' });
  assert.equal(read.status, 200);
  const src = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
  assert.match(src, /\|\| \(path === 'me' && method === 'PUT'\)/);
});

// ── the app's syncMe, lifted out and run against the real Worker ──
function liftSync({ env, me, base, onFetch }) {
  const at = APP.indexOf('\nfunction syncMe() {');
  assert.ok(at > 0, 'app.js has syncMe');
  const src = APP.slice(at + 1, APP.indexOf('\n}\n', at + 1) + 2);
  const store = new Map(Object.entries({ me, ...(base === undefined ? {} : { meBase: base }) }).map(([k, v]) => [k, JSON.stringify(v)]));
  const LS = {
    get: (k, d) => (store.has(k) ? JSON.parse(store.get(k)) : d),
    set: (k, v) => { store.set(k, JSON.stringify(v)); return true; },
  };
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push(`${init.method || 'GET'} ${init.headers?.['x-me-base'] ?? ''}`.trim());
    await onFetch?.(calls.length, init);
    return api(env, 'me', { method: init.method, headers: init.headers, ...(init.body === undefined ? {} : { body: init.body }) }, { pass: 'pw' });
  };
  const state = { ME: me };
  const vars = {
    LS, fetch, mergeProfile, ME_DEFAULT: { bio: '', learned: '', style: '', samples: '', memory: [], sources: {}, updatedAt: 0 },
    apiHeaders: (extra = {}) => ({ 'content-type': 'application/json', 'x-atelier-build': String(MIN_CLIENT_BUILD), ...extra }),
    updateKeyState() {}, Sync: { pause() {}, verified() {} }, S: { settings: { name: '' } }, saveSettings() {}, renderWelcome() {}, renderYou() {},
    $: () => ({ hidden: true }), clearTimeout() {}, setTimeout() {}, pushMe() {}, Date, JSON, Number, String, Array,
  };
  const run = new Function('vars', 'state', `with (vars) { let ME = state.ME, meSyncing = null, meAgain = false, meRefused = false, meChecked = 0, meTimer; ${src} return async () => { const how = await syncMe(); state.ME = ME; return how; }; }`)(vars, state);
  return { run, calls, LS, state };
}
const fact = (id, text, at) => ({ id, text, at, src: 'chat' });

test('syncMe: another device writes between this tab’s read and its write: the write is refused, joined again, and nothing is lost', async () => {
  const { env } = makeEnv({ testers: false });
  const morning = { bio: 'me', approvals: { approveAll: true }, memory: [fact('a', 'Likes tea', 1)], updatedAt: 100 };
  await put(env, morning, { base: 0 });
  // This tab learned a fact since the morning. The phone turns "Approve everything" off after this tab has read.
  const mine = { ...morning, memory: [...morning.memory, fact('b', 'Has a dog', 2)], updatedAt: 150 };
  const phone = { ...morning, approvals: { approveAll: false }, memory: [...morning.memory, fact('c', 'Lives in Ohio', 3)], updatedAt: 200 };
  const tab = liftSync({ env, me: mine, base: morning, onFetch: async (n) => { if (n === 2) assert.equal((await put(env, phone, { base: 100 })).status, 200); } });
  assert.equal(await tab.run(), 'synced');
  assert.deepEqual(tab.calls, ['GET', 'PUT 100', 'PUT 200'], 'one read, the refused write, the second write against the newer copy');
  const now = await stored(env);
  assert.equal(now.approvals.approveAll, false, 'the switch the phone turned off stays off');
  assert.deepEqual(now.memory.map((f) => f.id), ['a', 'b', 'c'], 'both devices’ facts are kept');
  assert.ok(now.updatedAt > 200, 'stamped later than the copy it was joined against');
  assert.equal(tab.state.ME.approvals.approveAll, false);
  assert.deepEqual(tab.LS.get('meBase').memory.map((f) => f.id), ['a', 'b', 'c']);
});

test('syncMe: a second refusal ends the exchange as failed; the change is kept here and goes with the next one', async () => {
  const { env } = makeEnv({ testers: false });
  const first = { bio: 'me', memory: [], updatedAt: 100 };
  await put(env, first, { base: 0 });
  let stamp = 1000;
  const other = async () => { const cur = await stored(env); stamp += 1000; await put(env, { ...cur, learned: `other ${stamp}`, updatedAt: stamp }, { base: cur.updatedAt }); };
  const tab = liftSync({ env, me: { ...first, bio: 'changed here', updatedAt: 150 }, base: first, onFetch: async (n) => { if (n >= 2) await other(); } });
  assert.equal(await tab.run(), 'failed');
  assert.deepEqual(tab.calls.map((c) => c.split(' ')[0]), ['GET', 'PUT', 'PUT'], 'two tries, never a loop');
  assert.equal((await stored(env)).bio, 'me', 'nothing was written over the other device');
  assert.equal(tab.state.ME.bio, 'changed here', 'the change made here is still here');
  // The next exchange, with no one else writing, sends it.
  const again = liftSync({ env, me: tab.state.ME, base: tab.LS.get('meBase') });
  assert.equal(await again.run(), 'synced');
  const now = await stored(env);
  assert.equal(now.bio, 'changed here');
  assert.match(now.learned, /^other /, 'and the other device’s text is kept');
});

test('syncMe: an answer older than the copy this browser already saw is the store lagging; nothing is taken for forgotten', async () => {
  const { env } = makeEnv({ testers: false });
  // The store answers with the morning copy, though this browser already synced a newer one (approve-all off, one more fact).
  const lagging = { bio: 'me', approvals: { approveAll: true }, memory: [fact('a', 'Likes tea', 1)], updatedAt: 100 };
  const seen = { bio: 'me', approvals: { approveAll: false }, memory: [fact('a', 'Likes tea', 1), fact('b', 'Has a dog', 2)], updatedAt: 200 };
  await put(env, lagging, { base: 0 });
  const tab = liftSync({ env, me: seen, base: seen });
  assert.equal(await tab.run(), 'synced');
  assert.deepEqual(tab.calls, ['GET'], 'nothing to send: this browser holds what the server is known to hold');
  assert.equal(tab.state.ME.approvals.approveAll, false, 'the lagging copy did not turn the switch back on');
  assert.deepEqual(tab.state.ME.memory.map((f) => f.id), ['a', 'b']);
  // With a change made here, the write names the newer copy, and the Worker takes it.
  const edit = liftSync({ env, me: { ...seen, bio: 'edited', updatedAt: 250 }, base: seen });
  assert.equal(await edit.run(), 'synced');
  assert.deepEqual(edit.calls, ['GET', 'PUT 200']);
  const now = await stored(env);
  assert.deepEqual([now.bio, now.approvals.approveAll, now.memory.length], ['edited', false, 2]);
});

test('mergeProfile stamps a change later than the copy it was joined against, whatever this clock says', () => {
  const theirs = { bio: 'server', memory: [], updatedAt: 5_000_000 };
  const behind = mergeProfile(theirs, { bio: 'mine', updatedAt: 10 }, theirs, 1000);
  assert.equal(behind.changed, true);
  assert.equal(behind.profile.updatedAt, 5_000_001);
  assert.equal(mergeProfile(theirs, { bio: 'mine', updatedAt: 10 }, theirs, 9_000_000).profile.updatedAt, 9_000_000);
  assert.equal(mergeProfile(theirs, theirs, theirs, 1000).profile.updatedAt, 5_000_000, 'unchanged: the stored stamp');
});

test('syncMe: a change made here while the write is out is laid on top of what went, and goes next (it was lost)', async () => {
  const { env } = makeEnv({ testers: false });
  const base = { bio: 'me', approvals: { approveAll: true }, memory: [fact('a', 'Likes tea', 1)], updatedAt: 100 };
  await put(env, base, { base: 0 });
  const me = structuredClone({ ...base, bio: 'edited', updatedAt: 150 });
  // A fact is learned and a forgotten one goes while the PUT is on its way.
  const tab = liftSync({ env, me, base, onFetch: async (n) => { if (n === 2) { me.memory.push(fact('late', 'Learned meanwhile', 5)); me.approvals.approveAll = false; } } });
  assert.equal(await tab.run(), 'synced');
  assert.deepEqual(tab.state.ME.memory.map((f) => f.id), ['a', 'late'], 'the fact learned meanwhile is still here');
  assert.equal(tab.state.ME.approvals.approveAll, false, 'and so is the switch');
  assert.equal(tab.state.ME.bio, 'edited');
  assert.equal((await stored(env)).memory.length, 1, 'the write that was out carried the older copy');
  assert.equal(tab.LS.get('me').memory.length, 2, 'what this browser keeps has it');
  assert.match(APP, /const edited = JSON\.stringify\(ME\) !== mine;\n\s+ME = \{ \.\.\.ME_DEFAULT, \.\.\.\(edited \? mergeProfile\(profile, ME, profile\)\.profile : profile\) \};\n\s+if \(edited\) meAgain = true;/);
});
