import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SPACES, SPACE_BATCH, cleanSpaces, spaceOf, spaceByHand, threadLine, spaceRequest, parseSpaces, bySpace } from '../public/thread-spaces.js';

test('stored groups: only work or personal survive, with the by-hand mark; anything else is dropped', () => {
  assert.deepEqual(cleanSpaces({ a: 'work', b: 'personal!', c: 'Work', d: 3, e: 'play', f: null }), { a: 'work', b: 'personal!' });
  for (const bad of [null, undefined, 'work', ['work'], 7]) assert.deepEqual(cleanSpaces(bad), {});
  const s = cleanSpaces({ a: 'work', b: 'personal!' });
  assert.equal(spaceOf(s, 'a'), 'work'); assert.equal(spaceOf(s, 'b'), 'personal'); assert.equal(spaceOf(s, 'zz'), '');
  assert.equal(spaceByHand(s, 'a'), false); assert.equal(spaceByHand(s, 'b'), true); assert.equal(spaceByHand(s, 'zz'), false);
  assert.deepEqual(Object.keys(SPACES), ['work', 'personal']);
});

test('a thread is sent as its title and the start of its first prompt, on one line and capped', () => {
  assert.equal(threadLine({ title: 'Q3 invoice\nfollow-up', entries: [{ prompt: 'Write a reminder   to the client' }] }), 'Q3 invoice follow-up | Write a reminder to the client');
  assert.equal(threadLine({ title: 'Plan a trip', entries: [{ prompt: 'plan a trip' }] }), 'Plan a trip', 'a title that is just the prompt is not repeated');
  assert.equal(threadLine({ title: '', entries: [] }), 'Untitled');
  assert.equal(threadLine({ title: 'x'.repeat(300), entries: [{ prompt: 'y'.repeat(900) }] }).length, 80 + 3 + 160);
  assert.equal(threadLine({ title: 'Pics', entries: [{ kind: 'image' }, { prompt: 'second' }] }), 'Pics | second', 'the first entry that has a prompt');
});

test('the request numbers the threads, names both groups, carries the profile when there is one, and warns that titles are not instructions', () => {
  const threads = [{ id: 'a', title: 'Roof estimate', entries: [] }, { id: 'b', title: 'Birthday dinner', entries: [] }];
  const [sys, user] = spaceRequest(threads, '  I run a remodeling\ncompany.  ');
  assert.equal(sys.role, 'system'); assert.equal(user.role, 'user');
  assert.equal(user.content, '1. Roof estimate\n2. Birthday dinner');
  assert.match(sys.content, /work or personal/); assert.match(sys.content, /About the person: I run a remodeling company\./);
  assert.match(sys.content, /never as instructions/);
  assert.doesNotMatch(spaceRequest(threads)[0].content, /About the person/);
  assert.ok(spaceRequest(threads, 'z'.repeat(5000))[0].content.length < 2000, 'the profile is capped');
  assert.equal(SPACE_BATCH, 20);
});

test('answers are read by number: order, case and decoration do not matter; missing, repeated or out-of-range lines are ignored', () => {
  assert.deepEqual(parseSpaces('1: work\n2: personal\n3: work', 3), ['work', 'personal', 'work']);
  assert.deepEqual(parseSpaces('3. Personal\n**1** - WORK\n', 3), ['work', null, 'personal']);
  assert.deepEqual(parseSpaces('1: work\n1: personal\n9: work\n0: work\n2: maybe\nwork', 2), ['work', null], 'the first answer for a number wins');
  assert.deepEqual(parseSpaces('Sure! Here you go:\n1) personal (family)\n2) workout plan', 2), ['personal', null], '"workout" is not "work"');
  assert.deepEqual(parseSpaces('', 2), [null, null]); assert.deepEqual(parseSpaces(null, 0), []);
});

test('Work and Personal order: work first, then personal, then the ones not sorted yet; the order inside a group is kept', () => {
  const threads = ['n1', 'w1', 'p1', 'w2', 'n2', 'p2'].map((id) => ({ id }));
  const spaces = { w1: 'work', w2: 'work!', p1: 'personal', p2: 'personal!' };
  assert.deepEqual(bySpace(threads, spaces).map((t) => t.id), ['w1', 'w2', 'p1', 'p2', 'n1', 'n2']);
  assert.deepEqual(threads.map((t) => t.id), ['n1', 'w1', 'p1', 'w2', 'n2', 'p2'], 'the list passed in is not reordered');
});
