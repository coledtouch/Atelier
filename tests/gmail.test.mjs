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

// v91 review (agent-gmail-draft-crlf): To, Cc and In-Reply-To went into the message as they were, so a steered agent
// could add a hidden Bcc or Reply-To. Line breaks are refused; In-Reply-To must be one <message-id>. (v92: gmail_draft
// needs approval too, so both tools are called approved here; the refusal must come from the header check.)
function mailSink() {
  const sent = [];
  globalThis.fetch = async (url, init = {}) => {
    if (/\/(drafts|messages\/send)$/.test(url)) { sent.push({ url, raw: JSON.parse(init.body).message?.raw ?? JSON.parse(init.body).raw }); return json(200, { id: 'd1' }); }
    throw new Error(`unmocked ${url}`);
  };
  return sent;
}
const decode = (raw) => Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

test('gmail_draft and gmail_send refuse a line break in To, Cc or In-Reply-To (no hidden Bcc or Reply-To), before anything is saved or sent', async () => {
  const sent = mailSink();
  const CR = String.fromCharCode(13), LF = String.fromCharCode(10);
  const bad = [
    { to: `bob@example.com${CR}${LF}Bcc: stranger@evil.example${CR}${LF}Reply-To: stranger@evil.example` },
    { to: 'bob@example.com', cc: `x@example.com${LF}Bcc: stranger@evil.example` },
    { to: 'bob@example.com', in_reply_to: `<a@mail>${CR}${LF}Bcc: stranger@evil.example` },
    { to: `bob@example.com${String.fromCharCode(0)}` },
    { to: 'bob@example.com', in_reply_to: 'not a message id' },
    { to: 'bob@example.com', in_reply_to: '<a@mail> <b@mail>' },
  ];
  for (const args of bad) {
    for (const [tool, approved] of [['gmail_draft', true], ['gmail_send', true]]) {
      const r = await runTool(env([MAIL]), tool, { subject: 'Q3', body: 'Hi', account: MAIL, ...args }, approved);
      assert.equal(r.ok, false, `${tool} ${JSON.stringify(args)}`);
      assert.match(r.error, /can’t contain line breaks|must be the original message’s Message-ID/);
    }
  }
  assert.deepEqual(sent, [], 'nothing reached Gmail');
  // A normal reply still goes: one To, one Cc, In-Reply-To and References from the Message-ID.
  const ok = await runTool(env([MAIL]), 'gmail_draft', { to: 'Bob <bob@example.com>', cc: 'amy@example.com', subject: 'Re: Q3', body: 'Thanks', in_reply_to: ' <CAx1@mail.gmail.com> ', threadId: 't1', account: MAIL }, true);
  assert.equal(ok.ok, true);
  const msg = decode(sent[0].raw);
  assert.match(msg, /^To: Bob <bob@example\.com>\r\nCc: amy@example\.com\r\nSubject: =\?UTF-8\?B\?/);
  assert.match(msg, /\r\nIn-Reply-To: <CAx1@mail\.gmail\.com>\r\nReferences: <CAx1@mail\.gmail\.com>\r\n\r\nThanks$/);
  assert.doesNotMatch(msg, /^(Bcc|Reply-To):/m);
});

// v92 (Cole, 2026-10-11): saving a Gmail draft shows an approval card like sending does. Unapproved, nothing reaches
// Gmail; the tool list marks it write so the app asks.
test('gmail_draft needs the user\u2019s approval: unapproved it saves nothing, approved it saves the draft', async () => {
  const sent = mailSink();
  const args = { to: 'bob@example.com', subject: 'Q3', body: 'Hi', account: MAIL };
  for (const approved of [undefined, false, 'yes', 1]) {
    const r = await runTool(env([MAIL]), 'gmail_draft', args, approved);
    assert.equal(r.ok, false, String(approved));
    assert.match(r.error, /needs the user's approval/);
  }
  assert.deepEqual(sent, [], 'nothing reached Gmail');
  const ok = await runTool(env([MAIL]), 'gmail_draft', args, true);
  assert.equal(ok.ok, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].url, /\/drafts$/);
});

// v91 review (critic-github-outside-taint-gaps b): the repo went into the API path raw, and fetch resolves dot segments,
// so 'me/x/../../stranger/evil' read someone else's repo while the app's outside check saw 'me'.
test('GitHub tools take only owner/name (checked and encoded) and a path without . or .. segments', async () => {
  const urls = [];
  globalThis.fetch = async (url) => { urls.push(String(url)); return json(200, /\/contents\//.test(url) ? { path: 'README.md', size: 2, content: Buffer.from('hi').toString('base64'), html_url: 'https://github.com/me/app/blob/main/README.md' } : []); };
  const store = new Map([['label:github:primary', 'me']]);
  const genv = { GITHUB_TOKEN: 'ghp_test_0123456789abcdef', ATELIER_KV: { get: async (k, t) => (store.has(k) ? (t === 'json' ? JSON.parse(store.get(k)) : store.get(k)) : null), put: async (k, v) => { store.set(k, String(v)); }, delete: async (k) => { store.delete(k); } } };
  for (const repo of ['me/x/../../stranger/evil', '../stranger', 'me/..', 'me/.', 'me/%2e%2e', 'me', '', 'me/x?y', 'me/x#y', 'me x/app', '-me/app']) {
    for (const [tool, args] of [['github_issues', { repo }], ['github_read', { repo, path: 'README.md' }]]) {
      const r = await runTool(genv, tool, args, false);
      assert.equal(r.ok, false, `${tool} ${repo}`);
      assert.match(r.error, /repo must be owner\/name/);
    }
  }
  for (const path of ['../../stranger/evil/contents/x', 'docs/../../x', './x']) {
    const r = await runTool(genv, 'github_read', { repo: 'me/app', path }, false);
    assert.equal(r.ok, false, path);
    assert.match(r.error, /path can’t contain \. or \.\. segments/);
  }
  const w = await runTool(genv, 'github_comment', { repo: 'me/app', number: '1/../../x', body: 'hi' }, true);
  assert.equal(w.ok, false);
  assert.match(w.error, /number must be the issue or PR number/);
  assert.deepEqual(urls, [], 'nothing reached GitHub');
  // Good ones: a dotted repo name, a nested path (each segment encoded), a state outside the list falls back to open.
  assert.equal((await runTool(genv, 'github_read', { repo: 'me/me.github.io', path: '/docs/my file.md' }, false)).ok, true);
  assert.equal((await runTool(genv, 'github_issues', { repo: 'Me/app', state: 'open&per_page=100' }, false)).ok, true);
  assert.deepEqual(urls, ['https://api.github.com/repos/me/me.github.io/contents/docs/my%20file.md', 'https://api.github.com/repos/Me/app/issues?state=open&per_page=25']);
});
