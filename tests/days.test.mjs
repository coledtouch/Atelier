import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayKey, entryTime, flowDays, flowsOn, daySlice, dayTimeline, dayList, stepDay, kindOf, cleanFlow, flowHint, KIND_DEFAULTS, rolledDay, keepsFlow, handPlan } from '../public/days.js';
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
  assert.deepEqual(handPlan([], spaces, new Set()), { write: [], adopt: [] });
  assert.deepEqual(handPlan([null, { id: 'z', entries: e }], spaces, new Set()), { write: [], adopt: [] });
});
