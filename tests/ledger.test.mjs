import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLedger, PROFILE } from './tester-env.mjs';
import { chatWorstCase, chatActual, imageCost, veoCost, WEB_SEARCH_USD, VEO_CALL_RESERVE_CAP } from '../src/tester/prices.js';

const { DEFAULTS, DAILY_UPLOADS, OVERRUN, dayKey, monthKey, resetsAt } = await import('../src/tester/ledger.js'); // after tester-env's module hook

// The real Ledger class on an in-memory SQLite shim; `ledger.clock` is pinned so days and months are deterministic.
const T0 = Date.parse('2026-10-15T12:00:00Z');
function setup({ open = true, ...config } = {}) {
  const L = makeLedger();
  let now = T0;
  L.ledger.clock = () => now;
  L.at = (t) => { now = t; };
  L.later = (ms) => { now += ms; };
  if (open || Object.keys(config).length) L.ledger.setConfig({ ...(open ? { paused: false } : {}), ...config });
  L.join = (profile = PROFILE()) => { assert.equal(L.ledger.admit(profile, null).status, 'admitted'); return profile.sub; };
  return L;
}
const sums = (L, sub) => {
  const a = L.ledger.allowance(sub);
  return { day: a.day.spent + a.day.reserved, month: a.month.spent + a.month.reserved, pool: a.pool.spent + a.pool.reserved };
};

test('a fresh Ledger starts paused with the default limits, and schedules its alarm', async () => {
  const L = makeLedger();
  await Promise.resolve();
  const { config } = L.ledger.roster();
  assert.deepEqual(config, { cap: 25, paused: true, day_limit: 1_000_000, month_limit: 10_000_000, pool_limit: 100_000_000, preview_subs: [] });
  assert.equal(DEFAULTS.paused, 1);
  assert.ok(L.shim.alarm() > Date.now() + 9 * 60_000, 'alarm set ~10 minutes out');
  assert.deepEqual(L.ledger.spots(), { spotsLeft: 25, cap: 25, paused: true });
});

test('while paused only preview subs are admitted and can reserve; the last refused sub is remembered', () => {
  const L = setup({ open: false });
  const stranger = PROFILE(), cole = PROFILE();
  assert.equal(L.ledger.admit(stranger, null).status, 'paused');
  assert.deepEqual(L.ledger.roster().lastRefused, { sub: stranger.sub, name: stranger.name, picture: stranger.picture, at: T0 });
  assert.equal(L.ledger.admit(cole, null).status, 'paused');
  assert.equal(L.ledger.roster().lastRefused.sub, cole.sub);
  assert.equal(L.ledger.setConfig({ preview_subs: [cole.sub] }).ok, true);
  assert.equal(L.ledger.admit(cole, null).status, 'admitted');
  assert.equal(L.ledger.admit(stranger, null).status, 'paused');
  const r = L.ledger.reserve(cole.sub, 1000);
  assert.equal(r.ok, true);
  assert.equal(r.allowance.paused, false, 'not paused for a preview sub');
  assert.equal(r.allowance.preview, true);
  // a tester admitted before the pause can't reserve while paused
  L.ledger.setConfig({ paused: false });
  const other = L.join();
  L.ledger.setConfig({ paused: true });
  assert.deepEqual(L.ledger.reserve(other, 1), { ok: false, scope: 'paused' });
  assert.equal(L.ledger.uploadGate(other).scope, 'paused');
  // preview subs are still held to their own limits and the pool
  assert.equal(L.ledger.reserve(cole.sub, 999_001).scope, 'day');
  L.ledger.setConfig({ pool_limit: 5_000 });
  assert.equal(L.ledger.reserve(cole.sub, 4_001).scope, 'pool');
});

test('admission cap: the 26th is full, a revoked tester is refused and frees the spot, a restored one is admitted', () => {
  const L = setup();
  const people = Array.from({ length: 26 }, () => PROFILE());
  for (const p of people.slice(0, 25)) assert.equal(L.ledger.admit(p, null).status, 'admitted');
  assert.equal(L.ledger.admit(people[25], null).status, 'full');
  assert.equal(L.ledger.spots().spotsLeft, 0);
  assert.equal(L.ledger.admit(people[3], null).status, 'admitted', 'a known tester signs in again when full');
  assert.equal(L.ledger.revoke(people[0].sub), true);
  assert.equal(L.ledger.admit(people[0], null).status, 'revoked');
  assert.equal(L.ledger.roster().lastRefused.sub, people[0].sub);
  assert.equal(L.ledger.admit(people[25], null).status, 'admitted', 'the revoked spot is free');
  assert.equal(L.ledger.restore(people[0].sub), true);
  assert.equal(L.ledger.admit(people[0], null).status, 'admitted');
  assert.equal(L.ledger.revoke('nobody'), false);
  assert.equal(L.ledger.restore('nobody'), false);
  assert.throws(() => L.ledger.admit({ sub: 'bad sub!' }, null));
});

test('reserve is refused at the day, month and pool limits, and for revoked or unknown testers', () => {
  const L = setup({ day_limit: 1_000, month_limit: 2_500, pool_limit: 3_500 });
  const a = L.join(), b = L.join(), c = L.join();
  assert.equal(L.ledger.reserve(a, 600).ok, true);
  const day = L.ledger.reserve(a, 401);
  assert.equal(day.ok, false);
  assert.equal(day.scope, 'day');
  assert.equal(day.resetsAt, '2026-10-16T00:00:00.000Z');
  assert.deepEqual(day.allowance.day, { spent: 0, reserved: 600, limit: 1_000 });
  assert.equal(L.ledger.reserve(a, 400).ok, true, 'exactly at the limit is fine');
  L.later(86_400_000);
  assert.equal(L.ledger.reserve(a, 1_000).ok, true);
  L.later(86_400_000);
  const month = L.ledger.reserve(a, 600);
  assert.equal(month.scope, 'month');
  assert.equal(month.resetsAt, '2026-11-01T00:00:00.000Z');
  assert.equal(L.ledger.reserve(b, 1_000).ok, true);
  assert.equal(L.ledger.reserve(c, 500).ok, true);
  assert.equal(L.ledger.reserve(c, 1).scope, 'pool', 'pool: 2,000 + 1,000 + 500 reserved of 3,500');
  assert.equal(resetsAt('pool', T0), '2026-11-01T00:00:00.000Z');
  L.ledger.revoke(b);
  assert.deepEqual(L.ledger.reserve(b, 1), { ok: false, scope: 'signin' });
  assert.deepEqual(L.ledger.reserve('ghost', 1), { ok: false, scope: 'signin' });
  assert.equal(L.ledger.allowance(b), null);
  assert.throws(() => L.ledger.reserve(a, 1.5));
  assert.throws(() => L.ledger.reserve(a, -1));
});

test('settle moves the reservation to spent at the reported cost, recording an overrun up to OVERRUN x the reservation', () => {
  const L = setup();
  const sub = L.join();
  const [r1, r2, r3, r4, r5] = Array.from({ length: 5 }, () => L.ledger.reserve(sub, 10_000));
  assert.deepEqual(sums(L, sub), { day: 50_000, month: 50_000, pool: 50_000 });
  assert.equal(L.ledger.settle(r1.id, 2_500.2).charged, 2_501, 'rounded up');
  assert.equal(L.ledger.settle(r2.id, 25_000).charged, 25_000, 'an estimate gap is recorded, not absorbed');
  assert.equal(L.ledger.settle(r3.id, Number.NaN).charged, 10_000, 'unreadable actual keeps the full reservation');
  assert.equal(L.ledger.settle(r4.id, -5).charged, 0);
  assert.equal(OVERRUN, 4);
  assert.equal(L.ledger.settle(r5.id, 1e9).charged, 40_000, 'bounded at OVERRUN x the reservation');
  assert.equal(L.ledger.settle(r1.id, 1), null, 'settles once');
  assert.equal(L.ledger.settle('nope', 1), null);
  const a = L.ledger.allowance(sub);
  assert.deepEqual(a.day, { spent: 77_501, reserved: 0, limit: 1_000_000 });
  assert.deepEqual(a.month, { spent: 77_501, reserved: 0, limit: 10_000_000 });
  assert.deepEqual(a.pool, { spent: 77_501, reserved: 0, limit: 100_000_000 });
});

test('an overrun recorded by settle blocks the next reserve that no longer fits', () => {
  const L = setup({ day_limit: 100_000 });
  const sub = L.join();
  L.ledger.settle(L.ledger.reserve(sub, 30_000).id, 90_000);
  assert.equal(L.ledger.allowance(sub).day.spent, 90_000);
  assert.equal(L.ledger.reserve(sub, 30_000).scope, 'day');
  assert.equal(L.ledger.reserve(sub, 10_000).ok, true);
});

test('a reservation made before midnight settles against the day it was made on', () => {
  const L = setup();
  const sub = L.join();
  L.at(Date.parse('2026-10-31T23:59:00Z'));
  const r = L.ledger.reserve(sub, 5_000);
  L.at(Date.parse('2026-11-01T00:01:00Z'));
  L.ledger.settle(r.id, 3_000);
  assert.deepEqual(L.ledger.allowance(sub).day, { spent: 0, reserved: 0, limit: 1_000_000 }, 'new day is clean');
  assert.equal(L.ledger.roster().pool.month, '2026-11');
  L.at(Date.parse('2026-10-31T23:59:30Z'));
  assert.deepEqual(L.ledger.allowance(sub).day, { spent: 3_000, reserved: 0, limit: 1_000_000 });
  assert.equal(L.ledger.roster().pool.spent, 3_000);
});

test('stale reservations (15 minutes) expire at the full amount; the alarm runs it and reschedules', async () => {
  const L = setup();
  const sub = L.join();
  const old = L.ledger.reserve(sub, 7_000);
  L.later(10 * 60_000);
  const fresh = L.ledger.reserve(sub, 3_000);
  L.later(5 * 60_000);
  assert.equal(L.ledger.expireStale(), 1);
  assert.equal(L.ledger.settle(old.id, 0), null, 'already settled in full');
  assert.deepEqual(L.ledger.allowance(sub).day, { spent: 7_000, reserved: 3_000, limit: 1_000_000 });
  L.later(10 * 60_000);
  await L.ledger.alarm();
  assert.deepEqual(L.ledger.allowance(sub).day, { spent: 10_000, reserved: 0, limit: 1_000_000 });
  assert.equal(L.ledger.settle(fresh.id, 1), null);
  assert.ok(L.shim.alarm() > Date.now());
});

test('concurrent reserves through the RPC stub never exceed the pool', async () => {
  const L = setup({ pool_limit: 1_000_000, cap: 100 });
  const subs = Array.from({ length: 40 }, () => L.join());
  const results = await Promise.all(subs.flatMap((sub) => [L.stub.reserve(sub, 90_000), L.stub.reserve(sub, 90_000)]));
  const ok = results.filter((r) => r.ok);
  assert.equal(ok.length, 11, '11 x 90,000 fits in 1,000,000; the 12th would not');
  assert.ok(results.filter((r) => !r.ok).every((r) => r.scope === 'pool'));
  const pool = L.ledger.roster().pool;
  assert.equal(pool.reserved, 990_000);
  assert.ok(pool.spent + pool.reserved <= 1_000_000);
  await Promise.all(ok.map((r) => L.stub.settle(r.id, 90_000)));
  assert.equal(L.ledger.roster().pool.spent, 990_000);
});

test('video chat: reserved from the clip length, settled from Gemini usageMetadata', () => {
  const L = setup();
  const sub = L.join();
  const amount = chatWorstCase({ model: 'gemini:gemini-3.8-flash', inputTokens: 2_000, maxTokens: 2_048, videoSeconds: 120 });
  const r = L.ledger.reserve(sub, amount);
  assert.equal(r.ok, true);
  const usage = { usageMetadata: { promptTokenCount: 2_000 + 120 * 300, candidatesTokenCount: 900, thoughtsTokenCount: 600, totalTokenCount: 39_500 } };
  const actual = chatActual({ model: 'gemini:gemini-3.8-flash', usage, date: T0 });
  assert.ok(actual < amount);
  assert.equal(L.ledger.settle(r.id, actual).charged, actual);
  // 180 s at the 2027 rate is the ceiling for an unknown clip: still under the $0.25 call cap on Flash
  assert.ok(chatWorstCase({ model: 'gemini:gemini-3.8-flash', inputTokens: 2_000, maxTokens: 2_048, videoSeconds: 180 }) <= 250_000);
});

test('Veo: the job keeps its reservation until the poll sees it finish; no video settles at $0', () => {
  const L = setup();
  const sub = L.join();
  const model = 'gemini:veo-3.1-lite-generate-preview';
  const cost = veoCost({ model, seconds: 8, resolution: '720p' });
  assert.equal(cost, 500_000);
  const r = L.ledger.reserve(sub, cost);
  L.ledger.addJob(sub, 'op:models/veo/operations/a', 'op', { reservation: r.id, actual: veoCost({ model, seconds: 8, resolution: '720p', margin: false }) });
  assert.equal(L.ledger.ownsJob(sub, 'op:models/veo/operations/a'), true);
  assert.equal(L.ledger.ownsJob('someone-else', 'op:models/veo/operations/a'), false);
  assert.equal(L.ledger.finishJob('someone-else', 'op:models/veo/operations/a', true), null, 'only the owner settles it');
  assert.equal(L.ledger.finishJob(sub, 'op:models/veo/operations/a', true).charged, 400_000);
  assert.equal(L.ledger.finishJob(sub, 'op:models/veo/operations/a', true), null, 'once');
  const r2 = L.ledger.reserve(sub, cost);
  L.ledger.addJob(sub, 'op:models/veo/operations/b', 'op', { reservation: r2.id, actual: 400_000 });
  assert.equal(L.ledger.finishJob(sub, 'op:models/veo/operations/b', false).charged, 0, 'filtered or failed: nothing billed');
  // $0.40 spent: one more 8 s 720p reserve fits today's $1.00, a second doesn't; Fast 1080p is over the per-video cap
  assert.equal(L.ledger.reserve(sub, cost).ok, true);
  assert.equal(L.ledger.reserve(sub, cost).scope, 'day');
  assert.ok(veoCost({ model: 'gemini:veo-3.1-fast-generate-preview', seconds: 8, resolution: '1080p' }) > VEO_CALL_RESERVE_CAP);
});

test('the web-search fee is part of the reserve and of the settle', () => {
  const L = setup();
  const sub = L.join();
  const args = { model: 'anthropic:claude-sonnet-5-5', inputTokens: 2_000, maxTokens: 2_000, fallbacks: false };
  const plain = chatWorstCase({ ...args, margin: false });
  const web = chatWorstCase({ ...args, webSearches: 2, margin: false });
  assert.ok(web - plain >= 2 * WEB_SEARCH_USD * 1e6, 'two $0.01 searches reserved');
  const r = L.ledger.reserve(sub, chatWorstCase({ ...args, webSearches: 2 }));
  const usage = { input_tokens: 30_000, output_tokens: 1_500, server_tool_use: { web_search_requests: 2 } };
  const actual = chatActual({ model: args.model, usage });
  assert.equal(actual, 30_000 * 2 + 1_500 * 10 + 20_000, 'tokens plus $0.02 of searches');
  assert.equal(L.ledger.settle(r.id, actual).charged, actual);
});

test('images: up to four are reserved per image', () => {
  const L = setup();
  const sub = L.join();
  const one = imageCost({ model: 'openai:gpt-image-2.5-flare', size: '1024x1024', quality: 'medium', promptTokens: 100 });
  const four = imageCost({ model: 'openai:gpt-image-2.5-flare', size: '1024x1024', quality: 'medium', promptTokens: 100, n: 4 });
  assert.ok(four > 3 * one && four <= 4 * one);
  assert.equal(L.ledger.reserve(sub, four).ok, true);
  assert.equal(imageCost({ model: 'gemini:gemini-3.1-flash-image', size: '1K', n: 4 }), 4 * imageCost({ model: 'gemini:gemini-3.1-flash-image', size: '1K' }));
});

test('sessions: stored by hash, expire after 30 days, end on revoke and logout; OAuth state is single-use', () => {
  const L = setup();
  const p = PROFILE();
  assert.equal(L.ledger.admit(p, 'hash-a').status, 'admitted');
  assert.deepEqual(L.ledger.session('hash-a'), { sub: p.sub, name: p.name, email: p.email, picture: p.picture });
  assert.equal(L.ledger.session('hash-b'), null);
  L.later(31 * 86_400_000);
  assert.equal(L.ledger.session('hash-a'), null, 'expired');
  L.ledger.admit(p, 'hash-c');
  L.ledger.logout('hash-c');
  assert.equal(L.ledger.session('hash-c'), null);
  L.ledger.admit(p, 'hash-d');
  L.ledger.revoke(p.sub);
  assert.equal(L.ledger.session('hash-d'), null);
  L.ledger.restore(p.sub);
  assert.equal(L.ledger.session('hash-d'), null, 'revocation deleted the sessions');
  // state
  L.ledger.putState('s1', 'n1');
  assert.equal(L.ledger.takeState('s1'), 'n1');
  assert.equal(L.ledger.takeState('s1'), null);
  L.ledger.putState('s2', 'n2');
  L.later(11 * 60_000);
  assert.equal(L.ledger.takeState('s2'), null, 'expired after 10 minutes');
});

test('jobs and uploads: ownership, the daily upload gate, and the first owner keeps an id', () => {
  const L = setup();
  const a = L.join(), b = L.join();
  L.ledger.addJob(a, 'file:files/x', 'file');
  L.ledger.addJob(b, 'file:files/x', 'file');
  assert.equal(L.ledger.ownsJob(a, 'file:files/x'), true);
  assert.equal(L.ledger.ownsJob(b, 'file:files/x'), false);
  const slots = [];
  for (let i = 0; i < DAILY_UPLOADS; i++) { const g = L.ledger.uploadGate(a); assert.equal(g.ok, true); slots.push(g.slot); } // the gate takes the slot itself
  assert.equal(new Set(slots).size, DAILY_UPLOADS);
  assert.deepEqual(L.ledger.uploadGate(a), { ok: false, scope: 'day', resetsAt: '2026-10-16T00:00:00.000Z' });
  L.ledger.addJob(a, 'upload:abc', 'upload');
  assert.equal(L.ledger.uploadGate(a).ok, false, 'recorded upload sessions are ownership rows, not extra slots');
  L.ledger.dropSlot(b, slots[0]);
  assert.equal(L.ledger.uploadGate(a).ok, false, 'only the tester who took a slot can give it back');
  L.ledger.dropSlot(a, slots[0]);
  assert.equal(L.ledger.uploadGate(a).ok, true, 'a slot whose start failed is given back');
  assert.equal(L.ledger.uploadGate(b).ok, true);
  L.later(86_400_000);
  assert.equal(L.ledger.uploadGate(a).ok, true, 'a new UTC day');
  L.ledger.revoke(b);
  assert.equal(L.ledger.uploadGate(b).scope, 'signin');
});

test('retention: a tester unused for 90 days is deleted with spend, sessions, jobs and profile', async () => {
  const L = setup();
  const p = PROFILE();
  L.ledger.admit(p, 'h1');
  L.ledger.putProfile(p.sub, '{"bio":"x"}');
  L.ledger.addJob(p.sub, 'file:files/q', 'file');
  L.ledger.settle(L.ledger.reserve(p.sub, 100).id, 100);
  const keep = L.join();
  L.later(89 * 86_400_000);
  L.ledger.admit({ ...PROFILE(), sub: keep }, null); // still in use
  L.later(2 * 86_400_000);
  await L.ledger.alarm();
  const subs = L.ledger.roster().testers.map((t) => t.sub);
  assert.deepEqual(subs, [keep]);
  assert.equal(L.ledger.getProfile(p.sub), null);
  assert.equal(L.ledger.ownsJob(p.sub, 'file:files/q'), false);
  assert.equal(L.shim.db.prepare('SELECT COUNT(*) AS n FROM spend WHERE sub = ?').get(p.sub).n, 0);
  assert.equal(L.shim.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE sub = ?').get(p.sub).n, 0);
});

test('setConfig validates every field and caps the pool at $1,000', () => {
  const L = setup();
  const bad = [{ pool_limit: 1_000_000_001 }, { day_limit: -1 }, { cap: 2.5 }, { cap: '25' }, { paused: 'yes' }, { preview_subs: 'abc' },
    { preview_subs: ['ok', 'bad sub'] }, { preview_subs: Array.from({ length: 51 }, (_, i) => `s${i}`) }, { nvidia_daily_requests: 60 }, null, []];
  for (const patch of bad) assert.equal(L.ledger.setConfig(patch).ok, false, JSON.stringify(patch));
  const before = L.ledger.roster().config;
  assert.equal(L.ledger.setConfig({ cap: 10, pool_limit: -2 }).ok, false, 'nothing changes when one field is bad');
  assert.deepEqual(L.ledger.roster().config, before);
  const r = L.ledger.setConfig({ cap: 10, paused: 1, day_limit: 500_000, month_limit: 5_000_000, pool_limit: 1_000_000_000, preview_subs: ['a-1', 'a-1', 'b_2'] });
  assert.deepEqual(r.config, { cap: 10, paused: true, day_limit: 500_000, month_limit: 5_000_000, pool_limit: 1_000_000_000, preview_subs: ['a-1', 'b_2'] });
});

test('roster: every tester with today and this month spend, newest first', () => {
  const L = setup();
  const a = L.join();
  L.later(1000);
  const b = L.join();
  L.ledger.settle(L.ledger.reserve(a, 4_000).id, 1_500);
  L.ledger.revoke(b);
  const r = L.ledger.roster();
  assert.deepEqual(r.testers.map((t) => t.sub), [b, a]);
  const ta = r.testers[1];
  assert.deepEqual(Object.keys(ta).sort(), ['day', 'email', 'joined_at', 'last_seen', 'month', 'name', 'picture', 'revoked_at', 'sub']);
  assert.deepEqual([ta.day, ta.month, ta.revoked_at], [{ spent: 1_500 }, { spent: 1_500 }, null]);
  assert.equal(r.testers[0].revoked_at, T0 + 1000);
  assert.deepEqual(r.pool, { month: monthKey(T0), spent: 1_500, reserved: 0 });
  assert.equal(dayKey(T0), '2026-10-15');
});
