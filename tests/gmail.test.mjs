import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// tools.js imports `cloudflare:workers`; stub it so the module loads in Node (see canva.test.mjs).
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export class DurableObject {} export const waitUntil = () => {};', shortCircuit: true };
    return next(specifier, context);
  },
});
const { runTool } = await import('../src/tools.js');

const MAIL = 'me@gmail.com', NOBOX = 'info@coenconstruction.com';
const kv = (accounts) => {
  const m = new Map([['google_accounts', JSON.stringify(accounts.map((email) => ({ email, refresh: `r-${email}` })))]]);
  // Cached access tokens so no refresh call is needed: the token names the account.
  for (const email of accounts) m.set(`google_access:${email}`, JSON.stringify({ token: `t-${email}`, exp: Date.now() + 3600e3 }));
  return { get: async (k, type) => (m.has(k) ? (type === 'json' ? JSON.parse(m.get(k)) : m.get(k)) : null), put: async (k, v) => { m.set(k, String(v)); }, delete: async (k) => { m.delete(k); } };
};
const env = (accounts) => ({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret', ATELIER_KV: kv(accounts) });
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
// Gmail as Google serves it: a normal inbox for MAIL, 400 "Precondition check failed." for an account without a mailbox.
function gmail() {
  globalThis.fetch = async (url, init = {}) => {
    const who = new Headers(init.headers).get('authorization').replace('Bearer t-', '');
    if (who === NOBOX) return json(400, { error: { code: 400, message: 'Precondition check failed.', status: 'FAILED_PRECONDITION' } });
    if (/\/messages\?q=/.test(url)) return json(200, { messages: [{ id: 'm1' }] });
    if (/\/messages\/m1\?format=metadata/.test(url)) return json(200, { threadId: 'th1', snippet: 'Invoice attached', labelIds: ['UNREAD'], internalDate: '1700000000000', payload: { headers: [{ name: 'Subject', value: 'Flush invoice' }, { name: 'From', value: 'Alex <alex@x.com>' }] } });
    throw new Error(`unmocked ${url}`);
  };
}

test('gmail_search keeps the other inboxes when one account has no Gmail mailbox', async () => {
  gmail();
  const r = await runTool(env([MAIL, NOBOX]), 'gmail_search', { query: 'flush invoice' }, false);
  assert.equal(r.ok, true);
  assert.deepEqual(r.result.messages.map((m) => [m.account, m.subject]), [[MAIL, 'Flush invoice']]);
  assert.equal(r.result.skipped.length, 1);
  assert.equal(r.result.skipped[0].account, NOBOX);
  assert.match(r.result.skipped[0].reason, /has no Gmail mailbox/);
});

test('gmail_search reports nothing skipped when every inbox answers', async () => {
  gmail();
  const r = await runTool(env([MAIL]), 'gmail_search', { query: 'flush invoice' }, false);
  assert.equal(r.ok, true);
  assert.equal(r.result.messages.length, 1);
  assert.equal(r.result.skipped, undefined);
});

test('an account without a mailbox gets a plain explanation instead of "Precondition check failed"', async () => {
  gmail();
  const search = await runTool(env([NOBOX]), 'gmail_search', { query: 'x' }, false);
  assert.equal(search.ok, false);
  assert.match(search.error, /info@coenconstruction\.com has no Gmail mailbox/);
  const read = await runTool(env([NOBOX]), 'gmail_read', { id: 'm1', account: NOBOX }, false);
  assert.equal(read.ok, false);
  assert.doesNotMatch(read.error, /Precondition/);
});
