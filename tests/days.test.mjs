import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayKey, entryTime, flowDays, flowsOn, daySlice, dayTimeline, dayList, stepDay, kindOf, cleanFlow, flowHint, KIND_DEFAULTS, rolledDay, keepsFlow, handPlan, firstShots } from '../public/days.js';
import { GROUP_SETS } from '../public/thread-spaces.js';

const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const entry = (id, ms) => ({ id, createdAt: ms });

test('dayKey across midnight and DST', () => {
  assert.equal(dayKey(at(2026, 11, 12, 23, 58)), '2026-11-12');
  assert.equal(dayKey(at(2026, 11, 13, 0, 1)), '2026-11-13');
  assert.equal(dayKey(at(2026, 3, 8, 0, 30)), dayKey(at(2026, 3, 8, 3, 30)));
});

test('entryTime prefers at', () => {
  assert.equal(entryTime({ createdAt: 1, at: 2 }), 2);
  assert.equal(entryTime({ createdAt: 1 }), 1);
});

test('carry-over puts a flow on both days', () => {
  const first = entry('a', at(2026, 11, 11)), second = entry('b', at(2026, 11, 13));
  const t = { id: 't', createdAt: at(2026, 11, 11), entries: [first, second] };
  assert.deepEqual([...flowDays(t)].sort(), ['2026-11-11', '2026-11-13']);
  assert.deepEqual(flowsOn([t], '2026-11-13'), [t]);
  assert.deepEqual(daySlice(t, '2026-11-13'), { earlier: 1, entries: [second] });
});

test('empty flow lives on its creation day', () => {
  const t = { id: 't', createdAt: at(2026, 11, 9), entries: [] };
  assert.deepEqual([...flowDays(t)], ['2026-11-09']);
  assert.deepEqual(flowsOn([t], '2026-11-09'), [t]);
  assert.deepEqual(flowsOn([t], '2026-11-10'), []);
});

test('flowsOn orders by latest activity that day', () => {
  const x = { id: 'x', createdAt: 0, entries: [entry('1', at(2026, 11, 13, 9)), entry('2', at(2026, 11, 13, 15))] };
  const y = { id: 'y', createdAt: 0, entries: [entry('3', at(2026, 11, 13, 11))] };
  const z = { id: 'z', createdAt: 0, entries: [entry('4', at(2026, 11, 13, 8)), entry('5', at(2026, 11, 14, 8))] };
  assert.deepEqual(flowsOn([y, z, x], '2026-11-13').map((t) => t.id), ['x', 'y', 'z']);
});

test('dayTimeline interleaves flows by time', () => {
  const e1 = entry('1', at(2026, 11, 13, 9)), e2 = entry('2', at(2026, 11, 13, 10)), e3 = entry('3', at(2026, 11, 13, 11));
  const a = { id: 'a', createdAt: 0, entries: [e1, e3] }, b = { id: 'b', createdAt: 0, entries: [e2] };
  const rows = dayTimeline([a, b], '2026-11-13');
  assert.deepEqual(rows.map((r) => [r.thread.id, r.entry.id]), [['a', '1'], ['b', '2'], ['a', '3']]);
  assert.deepEqual(rows.map((r) => r.at), [e1.createdAt, e2.createdAt, e3.createdAt]);
});

test('dayList newest first, each day once', () => {
  const a = { id: 'a', createdAt: 0, entries: [entry('1', at(2026, 11, 11)), entry('2', at(2026, 11, 13, 9))] };
  const b = { id: 'b', createdAt: 0, entries: [entry('3', at(2026, 11, 13, 10))] };
  assert.deepEqual(dayList([a, b]), [{ day: '2026-11-13', ids: ['b', 'a'] }, { day: '2026-11-11', ids: ['a'] }]);
});

test('stepDay skips empty days and stops at the ends', () => {
  const days = ['2026-11-13', '2026-11-11', '2026-11-05'];
  assert.equal(stepDay(days, '2026-11-12', -1), '2026-11-11');
  assert.equal(stepDay(days, '2026-11-12', 1), '2026-11-13');
  assert.equal(stepDay(days, '2026-11-11', -1), '2026-11-05');
  assert.equal(stepDay(days, '2026-11-05', -1), null);
  assert.equal(stepDay(days, '2026-11-13', 1), null);
});

test('kindOf prefers the synced kind over the guess', () => {
  assert.equal(kindOf({ id: 't', flow: { kind: 'kid' } }, { t: 'coen!' }), 'kid');
  assert.equal(kindOf({ id: 't' }, { t: 'coen!' }), 'coen');
  assert.equal(kindOf({ id: 't' }, {}), '');
});

test('cleanFlow rejects junk', () => {
  for (const v of [null, {}, { kind: 'x'.repeat(25) }, { kind: 'A B' }]) assert.equal(cleanFlow(v), null);
  assert.deepEqual(cleanFlow({ kind: 'kid', color: 'x'.repeat(17) }), { kind: 'kid' });
  assert.deepEqual(cleanFlow({ kind: 'kid', color: '#abc' }), { kind: 'kid', color: '#abc' });
});

test('flowHint names the kind in a phrase written for the model, one short line', () => {
  assert.equal(flowHint('coen', GROUP_SETS.owner), 'This flow is about work for Coen Construction.');
  assert.equal(flowHint('edgeball', GROUP_SETS.owner), 'This flow is about work for Edgeball Strategies.');
  assert.equal(flowHint('kid', GROUP_SETS.owner), 'This flow is about their kid.');
  assert.equal(flowHint('linkedin', GROUP_SETS.basic), 'This flow is about a LinkedIn post in their voice.');
  for (const set of [GROUP_SETS.owner, GROUP_SETS.basic]) for (const g of set.groups) {
    const h = flowHint(g.key, set);
    assert.match(h, /^This flow is about [a-z][^.:]{2,70}\.$/, `${set.id} ${g.key}: ${h}`);
    assert.doesNotMatch(h, /Work: |about (Kid|Personal|Work)\./, 'never the list heading');
  }
  assert.equal(flowHint('nope', GROUP_SETS.owner), '');
  assert.equal(flowHint('', GROUP_SETS.owner), '');
});

test('KIND_DEFAULTS: LinkedIn is Ask with As me; every other kind is Ask with the Auto model', () => {
  assert.deepEqual(KIND_DEFAULTS.linkedin, { mode: 'ask', ask: { voice: true } });
  for (const k of ['kid', 'personal', 'work', 'coen', 'edgeball', 'apps']) assert.deepEqual(KIND_DEFAULTS[k], { mode: 'ask', ask: { model: '' } }, k);
  for (const set of [GROUP_SETS.owner, GROUP_SETS.basic]) for (const g of set.groups) assert.ok(KIND_DEFAULTS[g.key], `${g.key} has defaults`);
});

test('rolledDay: a page left on today moves to the new today; a past day he browsed to stays', () => {
  const d12 = '2026-11-12', d13 = '2026-11-13', d10 = '2026-11-10';
  assert.equal(rolledDay(d12, d12, d13), d13, 'left open on the 12th overnight: the 13th');
  assert.equal(rolledDay(d13, d13, d13), null, 'same day: nothing');
  assert.equal(rolledDay(d10, null, d13), null, 'browsing a past day: stays');
  assert.equal(rolledDay(d10, d12, d13), null, 'a day other than the one that was today: stays');
  assert.equal(rolledDay(d12, null, d13), null, 'set to the 12th while it was already the 13th: he chose it');
});

test('keepsFlow: the open flow stays on the new day when it has a turn that day, or nothing yet', () => {
  const d13 = '2026-11-13';
  assert.equal(keepsFlow({ entries: [entry('a', at(2026, 11, 12, 23, 30))] }, d13), false, 'last night only');
  assert.equal(keepsFlow({ entries: [entry('a', at(2026, 11, 12, 23, 30)), entry('b', at(2026, 11, 13, 0, 10))] }, d13), true);
  assert.equal(keepsFlow({ entries: [] }, d13), true, 'a new flow with nothing in it yet');
  assert.equal(keepsFlow(null, d13), false);
});

test('stepDay never steps past today: a future day in the list, or the clock moved back', () => {
  const days = ['2026-11-11', '2026-11-13', '2026-11-15'];
  assert.equal(stepDay(days, '2026-11-11', 1, '2026-11-13'), '2026-11-13');
  assert.equal(stepDay(days, '2026-11-13', 1, '2026-11-13'), null, 'today is the last step forward');
  assert.equal(stepDay(days, '2026-11-15', 1, '2026-11-13'), null, 'never on from a future day');
  assert.equal(stepDay(days, '2026-11-15', -1, '2026-11-13'), '2026-11-13', 'back from a future day lands on today');
  assert.equal(stepDay(days, '2026-11-11', 1, '2026-11-12'), null, 'the clock moved back: the 13th is in the future');
  assert.equal(stepDay(days, '2026-11-12', -1, '2026-11-12'), '2026-11-11');
  assert.equal(stepDay(days, '2026-11-11', 1), '2026-11-13', 'no today given: as before');
});

test('handPlan: a hand choice beats a guessed flow, whatever arrived first', () => {
  const e = [{ id: 'x', createdAt: 1 }];
  const spaces = { a: 'coen!', b: 'coen!', c: 'coen!', d: 'kid', e: 'coen!', f: 'coen!', g: 'coen!' };
  const threads = [
    { id: 'a', entries: e }, // no flow yet: the hand choice is written
    { id: 'b', entries: e, flow: { kind: 'personal' } }, // a guess got there first (a sync pull, a race): his choice is written again
    { id: 'c', entries: e, flow: { kind: 'coen' } }, // they agree: nothing
    { id: 'd', entries: e, flow: { kind: 'work' } }, // only a guess on this device: nothing
    { id: 'e', entries: [] }, // empty: nothing
    { id: 'f', entries: e, flow: { kind: 'apps' } }, // his one rewrite was spent: a later pick on another device is adopted
    { id: 'g', entries: e, flow: { kind: 'x y' } }, // an invalid flow counts as none
  ];
  const { write, adopt } = handPlan(threads, spaces, new Set(['a', 'b', 'c']));
  assert.deepEqual(write.map(({ thread, flow, spent }) => [thread.id, flow, spent]), [['a', { kind: 'coen' }, false], ['b', { kind: 'coen' }, true], ['g', { kind: 'coen' }, false]]);
  assert.deepEqual(adopt, [{ id: 'f', kind: 'apps' }]);
  assert.deepEqual(handPlan([], spaces, new Set()), { write: [], adopt: [], settled: [] });
  assert.deepEqual(handPlan([null, { id: 'z', entries: e }], spaces, new Set()), { write: [], adopt: [], settled: [] });
});

test('handPlan: a shot is cleared once his choice is seen landed (agrees, nothing unsent)', () => {
  const e = [{ id: 'x', createdAt: 1 }];
  const spaces = { a: 'coen!', b: 'coen!', c: 'coen!' };
  const threads = [
    { id: 'a', entries: e, flow: { kind: 'coen' } }, // agrees and landed: the shot goes
    { id: 'b', entries: e, flow: { kind: 'coen' } }, // agrees but not sent yet: the shot stays
    { id: 'c', entries: e, flow: { kind: 'coen' } }, // agrees, landed, no shot: nothing
  ];
  const landed = (t) => t.id !== 'b';
  assert.deepEqual(handPlan(threads, spaces, new Set(['a', 'b']), landed), { write: [], adopt: [], settled: ['a'] });
  assert.deepEqual(handPlan(threads, spaces, new Set(['a', 'b'])).settled, [], 'with no landed check nothing is cleared');
});

test('firstShots: on the first run only marks whose flow is missing or different get a shot', () => {
  const e = [{ id: 'x', createdAt: 1 }];
  const spaces = { a: 'coen!', b: 'coen!', c: 'coen!', d: 'kid', gone: 'coen!' };
  const threads = [
    { id: 'a', entries: e }, // no flow: a shot
    { id: 'b', entries: e, flow: { kind: 'personal' } }, // differs: a shot
    { id: 'c', entries: e, flow: { kind: 'coen' } }, // agrees: none
    { id: 'd', entries: e, flow: { kind: 'work' } }, // a guess, not a mark: none
  ];
  assert.deepEqual(firstShots(threads, spaces), ['a', 'b']);
  assert.deepEqual(firstShots([null], spaces), []);
});

// Devices that each hold hand marks, sharing one synced flow for thread t, in the app's order:
// - a pull that brings the server's flow is a read of the library, which runs the app's rule (handsWin: handPlan with
//   its shots, landed = its record matches);
// - a push is taken when its base is fresh (the server's CAS). An accepted push changes nothing locally, so no read
//   follows: only sync.js's onFlowLanded clears the shot of a choice that agrees with what landed (shotLanded);
// - a refused push brings the server's copy back, and that read runs the rule.
function fleet(names, serverKind) {
  const server = { flow: serverKind ? { kind: serverKind } : null };
  const devs = Object.fromEntries(names.map((n) => [n, { spaces: {}, shots: null, t: { id: 't', entries: [{ id: 'x' }], flow: server.flow }, rec: server.flow, writes: 0 }]));
  const run = (d) => {
    if (!d.shots) d.shots = new Set(firstShots([d.t], d.spaces));
    const landed = (t) => cleanFlow(t.flow)?.kind === cleanFlow(d.rec)?.kind;
    const { write, adopt, settled } = handPlan([d.t], d.spaces, d.shots, landed);
    for (const id of settled) d.shots.delete(id);
    for (const a of adopt) d.spaces[a.id] = `${a.kind}!`;
    for (const w of write) { d.t = { ...d.t, flow: w.flow }; d.writes++; if (w.spent) d.shots.delete('t'); }
  };
  const kindOfFlow = (f) => cleanFlow(f)?.kind;
  const pull = (n) => { const d = devs[n]; d.t = { ...d.t, flow: server.flow }; d.rec = server.flow; run(d); };
  const push = (n) => {
    const d = devs[n], k = kindOfFlow(d.t.flow);
    if (!k || k === kindOfFlow(d.rec)) return; // nothing unsent
    if (!server.flow || kindOfFlow(d.rec) === kindOfFlow(server.flow)) {
      server.flow = d.t.flow; d.rec = d.t.flow;
      if (d.spaces.t === `${k}!`) d.shots?.delete('t'); // onFlowLanded → shotLanded
    } else pull(n); // stale base: refused, the server's copy comes back
  };
  const pick = (n, kind) => { const d = devs[n]; d.spaces.t = `${kind}!`; d.shots ??= new Set(); d.shots.add('t'); d.t = { ...d.t, flow: { kind } }; };
  const settle = (order) => { for (let i = 0; i < 4; i++) for (const n of order) { pull(n); push(n); } };
  return { server, devs, run, pull, push, pick, settle };
}

test('two devices: his choice beats a guess that synced first, and his later pick on the other device wins', () => {
  const f = fleet(['desk', 'phone'], 'personal'); // a guess reached the server before his choice synced
  f.devs.desk.spaces.t = 'coen!'; // he chose Coen on the desk
  f.pull('desk'); f.push('desk');
  assert.deepEqual(f.server.flow, { kind: 'coen' }, 'his choice replaced the guess');
  f.pull('desk');
  assert.equal(f.devs.desk.shots.size, 0, 'seen landed: the shot is cleared');
  f.pull('phone');
  f.pick('phone', 'work'); f.push('phone'); // later, he picks Work on the phone
  f.settle(['desk', 'phone']);
  assert.deepEqual(f.server.flow, { kind: 'work' }, 'the newer pick stays');
  assert.equal(f.devs.desk.spaces.t, 'work!', 'and the desk takes it as his choice');
  assert.equal(f.devs.desk.writes, 1, 'the desk wrote once, over the guess, never over his pick');
});

test('two devices, the re-review sequence: a shot cleared by its push landing never overwrites his later pick', () => {
  const f = fleet(['desk', 'phone'], 'coen');
  for (const n of ['desk', 'phone']) { f.devs[n].spaces.t = 'coen!'; f.pull(n); }
  f.pick('desk', 'work'); f.push('desk'); // he re-files T to Work on the desk and walks away: no read there after
  assert.equal(f.devs.desk.shots.size, 0, 'the push landed: the desk\'s shot is cleared with no read');
  f.pull('phone');
  assert.equal(f.devs.phone.spaces.t, 'work!', 'the phone adopts Work');
  f.pick('phone', 'kid'); f.push('phone'); // he picks Kid there and sends a turn
  f.pull('desk'); // the desk wakes
  assert.equal(f.devs.desk.spaces.t, 'kid!', 'the desk adopts Kid');
  f.settle(['phone', 'desk']);
  assert.deepEqual(f.server.flow, { kind: 'kid' }, 'his newest pick stays');
  assert.deepEqual([f.devs.desk.writes, f.devs.phone.writes], [0, 0]);
});

test('three devices holding marks: the newest pick survives (review: item 1)', () => {
  const f = fleet(['a', 'b', 'c'], 'coen');
  for (const n of ['a', 'b', 'c']) f.devs[n].spaces.t = 'coen!'; // marks that agree with the flow when this build first runs
  for (const n of ['a', 'b', 'c']) f.pull(n);
  for (const n of ['a', 'b', 'c']) assert.equal(f.devs[n].shots.size, 0, `${n}: an agreeing mark gets no shot`);
  f.pick('b', 'work'); f.push('b');
  f.settle(['a', 'c', 'b']);
  assert.deepEqual(f.server.flow, { kind: 'work' }, 'his newest pick stays on the server');
  for (const n of ['a', 'b', 'c']) assert.equal(f.devs[n].spaces.t, 'work!', `${n} shows Work as his choice`);
  assert.deepEqual(['a', 'c'].map((n) => f.devs[n].writes), [0, 0], 'no stale mark wrote over it');
  // and again later, from another device
  f.pick('c', 'apps'); f.push('c');
  f.settle(['b', 'a', 'c']);
  assert.deepEqual(f.server.flow, { kind: 'apps' });
  for (const n of ['a', 'b', 'c']) assert.equal(f.devs[n].spaces.t, 'apps!');
});
