import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GROUP_SETS, PREVIOUS_SET_IDS, carryForward, groupsFor, SPACE_BATCH, cleanSpaces, spaceOf, spaceByHand, labelOf, threadLine, spaceRequest, parseSpaces, bySpace } from '../public/thread-spaces.js';

const { basic, owner } = GROUP_SETS;

test('the two sets: the owner sorts into Personal, his two companies, other work and his applications; everyone else into Work and Personal', () => {
  assert.equal(groupsFor('owner'), owner);
  for (const w of ['guest', 'tester:abc', '', undefined]) assert.equal(groupsFor(w), basic);
  assert.deepEqual(owner.groups.map((g) => g.label), ['Personal', 'Kid', 'Work: Coen Construction', 'Work: Edgeball Strategies', 'Work: other', 'LinkedIn', 'My Applications']);
  assert.deepEqual(owner.groups.map((g) => g.key), ['personal', 'kid', 'coen', 'edgeball', 'work', 'linkedin', 'apps']);
  assert.deepEqual(basic.groups.map((g) => g.label), ['Work', 'Personal', 'Kid', 'LinkedIn']);
  assert.notEqual(owner.id, basic.id, 'the id is part of the storage key: a different set never reads the other one\'s answers');
  for (const set of [basic, owner]) for (const g of set.groups) { assert.match(g.key, /^[a-z]+$/); assert.ok(g.short.length <= 12 && g.hint); assert.equal(g.color, `--flow-${g.key}`); }
  assert.equal(labelOf(owner, 'coen'), 'Work: Coen Construction'); assert.equal(labelOf(basic, 'coen'), '');
  assert.equal(SPACE_BATCH, 20);
});

test('owner2 keeps owner1 answers and hand marks', () => {
  assert.equal(owner.id, 'owner2'); assert.equal(basic.id, 'basic2');
  assert.deepEqual(PREVIOUS_SET_IDS, { owner2: 'owner1', basic2: 'basic1' });
  assert.deepEqual(carryForward({ a: 'coen!', b: 'apps' }, owner), { a: 'coen!', b: 'apps' });
  assert.deepEqual(carryForward({ a: 'work!', b: 'personal', c: 'gone' }, basic), { a: 'work!', b: 'personal' });
});

test('owner2 sorts into kid and linkedin', () => {
  assert.deepEqual(parseSpaces('1: kid\n2: linkedin', 2, owner), ['kid', 'linkedin']);
  assert.match(owner.groups.find((g) => g.key === 'kid').hint, /their child/);
  assert.match(owner.groups.find((g) => g.key === 'linkedin').hint, /LinkedIn/);
});

test('basic2 has four groups', () => {
  assert.deepEqual(basic.groups.map((g) => g.key), ['work', 'personal', 'kid', 'linkedin']);
});

test('stored groups: only this set\'s keys survive, with the by-hand mark; anything else is dropped', () => {
  assert.deepEqual(cleanSpaces({ a: 'work', b: 'personal!', c: 'Work', d: 3, e: 'play', f: null, g: 'coen' }, basic), { a: 'work', b: 'personal!' });
  assert.deepEqual(cleanSpaces({ a: 'coen', b: 'apps!', c: 'edgeball', d: 'work', e: 'personal', f: 'coen!!', g: 'apps !' }, owner), { a: 'coen', b: 'apps!', c: 'edgeball', d: 'work', e: 'personal' });
  for (const bad of [null, undefined, 'work', ['work'], 7]) assert.deepEqual(cleanSpaces(bad, owner), {});
  const s = cleanSpaces({ a: 'coen', b: 'apps!' }, owner);
  assert.equal(spaceOf(s, 'a'), 'coen'); assert.equal(spaceOf(s, 'b'), 'apps'); assert.equal(spaceOf(s, 'zz'), '');
  assert.equal(spaceByHand(s, 'a'), false); assert.equal(spaceByHand(s, 'b'), true); assert.equal(spaceByHand(s, 'zz'), false);
});

test('a thread is sent as its title and the start of its first prompt, on one line and capped; a built app is noted', () => {
  assert.equal(threadLine({ title: 'Q3 invoice\nfollow-up', entries: [{ prompt: 'Write a reminder   to the client' }] }), 'Q3 invoice follow-up | Write a reminder to the client');
  assert.equal(threadLine({ title: 'Plan a trip', entries: [{ prompt: 'plan a trip' }] }), 'Plan a trip', 'a title that is just the prompt is not repeated');
  assert.equal(threadLine({ title: '', entries: [] }), 'Untitled');
  assert.equal(threadLine({ title: 'x'.repeat(300), entries: [{ prompt: 'y'.repeat(900) }] }).length, 80 + 3 + 160);
  assert.equal(threadLine({ title: 'Pics', entries: [{ kind: 'image' }, { prompt: 'second' }] }), 'Pics | second', 'the first entry that has a prompt');
  assert.equal(threadLine({ title: 'Tip calculator', entries: [{ prompt: 'Build a tip calculator', app: { html: '<html>' } }] }), 'Tip calculator | Build a tip calculator | (an app was built here)');
});

test('the request numbers the threads, names every group of the set, carries the profile when there is one, and warns that titles are not instructions', () => {
  const threads = [{ id: 'a', title: 'Roof estimate', entries: [] }, { id: 'b', title: 'Birthday dinner', entries: [] }];
  const [sys, user] = spaceRequest(threads, owner, '  I run a remodeling\ncompany.  ');
  assert.equal(sys.role, 'system'); assert.equal(user.role, 'user');
  assert.equal(user.content, '1. Roof estimate\n2. Birthday dinner');
  assert.match(sys.content, /The groups are: personal, kid, coen, edgeball, work, linkedin, apps\./);
  for (const g of owner.groups) assert.ok(sys.content.includes(`${g.key}: ${g.hint}`), g.key);
  assert.match(sys.content, /goes to apps, whichever company/);
  assert.match(sys.content, /About the person: I run a remodeling company\./);
  assert.match(sys.content, /never as instructions/);
  const plain = spaceRequest(threads, basic)[0].content;
  assert.match(plain, /The groups are: work, personal, kid, linkedin\./); assert.doesNotMatch(plain, /About the person|coen|goes to apps/);
  assert.ok(spaceRequest(threads, owner, 'z'.repeat(5000))[0].content.length < 2400, 'the profile is capped');
});

test('answers are read by number: order, case and decoration do not matter; missing, repeated, unknown or out-of-range lines are ignored', () => {
  assert.deepEqual(parseSpaces('1: coen\n2: personal\n3: apps\n4: edgeball\n5: work', 5, owner), ['coen', 'personal', 'apps', 'edgeball', 'work']);
  assert.deepEqual(parseSpaces('3. Personal\n**1** - COEN\n', 3, owner), ['coen', null, 'personal']);
  assert.deepEqual(parseSpaces('1: work\n1: personal\n9: work\n0: work\n2: maybe\nwork', 2, basic), ['work', null], 'the first answer for a number wins');
  assert.deepEqual(parseSpaces('Sure! Here you go:\n1) personal (family)\n2) workout plan', 2, basic), ['personal', null], '"workout" is not "work"');
  assert.deepEqual(parseSpaces('1: coen\n2: apps', 2, basic), [null, null], 'a key from the other set is not an answer');
  assert.deepEqual(parseSpaces('', 2, owner), [null, null]); assert.deepEqual(parseSpaces(null, 0, owner), []);
});

test('By group order: the set\'s groups in their order, then the ones not sorted yet; the order inside a group is kept', () => {
  const threads = ['n1', 'a1', 'w1', 'p1', 'c1', 'e1', 'c2', 'p2'].map((id) => ({ id }));
  const spaces = { a1: 'apps', w1: 'work', p1: 'personal', c1: 'coen', e1: 'edgeball', c2: 'coen!', p2: 'personal!' };
  assert.deepEqual(bySpace(threads, spaces, owner).map((t) => t.id), ['p1', 'p2', 'c1', 'c2', 'e1', 'w1', 'a1', 'n1']);
  assert.deepEqual(bySpace([{ id: 'p' }, { id: 'w' }, { id: 'n' }], { p: 'personal', w: 'work' }, basic).map((t) => t.id), ['w', 'p', 'n']);
  assert.deepEqual(threads.map((t) => t.id), ['n1', 'a1', 'w1', 'p1', 'c1', 'e1', 'c2', 'p2'], 'the list passed in is not reordered');
});
