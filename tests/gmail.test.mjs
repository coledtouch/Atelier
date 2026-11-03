import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFile } from 'node:fs/promises';

// tools.js imports `cloudflare:workers`; stub it so the module loads in Node (see canva.test.mjs).
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export class DurableObject {} export const waitUntil = () => {};', shortCircuit: true };
    return next(specifier, context);
  },
});
const { runTool, googleTokenFor } = await import('../src/tools.js');

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

// review-nov03: the approval card showed a short To or Cc in a one-line box, and a phone clipped it, so 40 spaces hid
// the second address while Gmail got both. The card now lists every address; the header holds the string it showed:
// trimmed, each run of spaces one space (public/app.js oneSpace, the same rule).
test('gmail_draft and gmail_send write To and Cc as the approval card shows them: trimmed, each run of spaces one space; line breaks are still refused', async () => {
  const sent = mailSink();
  const pad = ' '.repeat(40), odd = '\t 　  ';
  for (const tool of ['gmail_draft', 'gmail_send']) {
    const r = await runTool(env([MAIL]), tool, { to: `  a@x.com${pad},b@y.com `, cc: `Alex Johnson${odd}<alex.johnson@companyname.com>,${pad}archive@evil.io`, subject: 'Q3', body: 'Hi  there', account: MAIL }, true);
    assert.equal(r.ok, true, tool);
  }
  assert.equal(sent.length, 2);
  for (const { raw } of sent) {
    const msg = decode(raw);
    assert.match(msg, /^To: a@x\.com ,b@y\.com\r\nCc: Alex Johnson <alex\.johnson@companyname\.com>, archive@evil\.io\r\nSubject: /);
    assert.match(msg, /\r\n\r\nHi {2}there$/, 'the body keeps its spaces');
  }
  // the padding never hides a line break: CR, LF and NUL are refused before anything is collapsed
  const CR = String.fromCharCode(13), LF = String.fromCharCode(10);
  for (const args of [{ to: `a@x.com${pad}${CR}${LF}Bcc: e@evil.io` }, { to: 'a@x.com', cc: `b@y.com${pad}${LF}Reply-To: e@evil.io` }, { to: `a@x.com${pad}${String.fromCharCode(0)}` }]) {
    const r = await runTool(env([MAIL]), 'gmail_send', { subject: 'Q3', body: 'Hi', account: MAIL, ...args }, true);
    assert.equal(r.ok, false, JSON.stringify(args));
    assert.match(r.error, /can’t contain line breaks/);
  }
  assert.equal(sent.length, 2, 'nothing more reached Gmail');
});

test('the app’s oneSpace (what the approval card shows and approves) is the string the To header holds', async () => {
  const APP = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const at = APP.indexOf('\nconst oneSpace = ') + 1;
  assert.ok(at > 0, 'app.js has const oneSpace');
  const oneSpace = new Function(`return (${APP.slice(at, APP.indexOf('\n', at)).replace(/^const oneSpace = /, '').replace(/;$/, '')});`)();
  const sent = mailSink();
  const inputs = [`alex@company.com${' '.repeat(40)},evil@attacker.io`, ' Alex Johnson <alex.johnson@companyname.com>,  archive@evil.io ', '\ta@x.com  b@y.com　', 'bob@example.com'];
  for (const to of inputs) await runTool(env([MAIL]), 'gmail_draft', { to, subject: 'Q3', body: 'Hi', account: MAIL }, true);
  assert.deepEqual(sent.map(({ raw }) => /^To: (.*)\r\n/.exec(decode(raw))[1]), inputs.map(oneSpace));
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

// review-nov02 (atelier-1): the approval card names the mailbox a draft or send uses, worked out in the app by
// pickAccount's rule (public/app.js mailFrom). The two must agree, and the full address the app then sends must pick
// exactly that mailbox, even where another address contains it.
test('the app’s mailFrom picks the mailbox pickAccount picks, and the full address it sends picks exactly that one', async () => {
  const APP = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const at = APP.indexOf('\nfunction mailFrom(') + 1;
  assert.ok(at > 0, 'app.js has function mailFrom');
  const mailFrom = new Function(`return (${APP.slice(at, APP.indexOf('\n}\n', at) + 2)});`)();
  const LIST = ['nicole@x.com', 'cole@x.com', NOBOX];
  const used = [];
  globalThis.fetch = async (url, init = {}) => { used.push(new Headers(init.headers).get('authorization').replace('Bearer t-', '')); return json(200, { id: 'd1' }); };
  const draft = (account) => runTool(env(LIST), 'gmail_draft', { to: 'bob@example.com', subject: 'Q3', body: 'Hi', ...(account === undefined ? {} : { account }) }, true);
  for (const account of [undefined, '', 'cole@x.com', ' Cole@X.com ', 'cole', 'COEN', 'x.com', 'le@x.com', '@x.com', 'nobody']) {
    const from = mailFrom(account, LIST);
    used.length = 0;
    const r = await draft(account);
    assert.equal(r.ok ? r.result.account : '', from, `account ${JSON.stringify(account)}`);
    if (!from) { assert.match(r.error, /No connected Gmail account matches/); continue; }
    const pinned = await draft(from); // what the app sends once you approve
    assert.equal(pinned.result.account, from);
    assert.deepEqual(used, [from, from], 'saved with that mailbox’s token');
  }
  assert.equal(mailFrom('x', []), '', 'no account list: none named');
});

// review-nov02 follow-up (r1-atelier-worker-exact): the app pins the address its card names. If that mailbox is removed
// before Approve, the draft or send fails. Before, with cole@x.com gone, it went to nicole@x.com, which holds that text.
test('gmail_draft and gmail_send take an address with @ exactly: a removed mailbox fails, never one that holds it', async () => {
  const used = [];
  globalThis.fetch = async (url, init = {}) => { used.push(new Headers(init.headers).get('authorization').replace('Bearer t-', '')); return json(200, { id: 'd1' }); };
  const left = env(['nicole@x.com']);
  for (const tool of ['gmail_draft', 'gmail_send']) {
    const r = await runTool(left, tool, { to: 'bob@example.com', subject: 'Q3', body: 'Hi', account: 'cole@x.com' }, true);
    assert.equal(r.ok, false, tool);
    assert.match(r.error, /No connected Gmail account matches "cole@x\.com"/);
    const part = await runTool(left, tool, { to: 'bob@example.com', subject: 'Q3', body: 'Hi', account: 'cole' }, true);
    assert.equal(part.ok && (part.result.account || part.result.from), 'nicole@x.com', `${tool}: part of a name, with no @`);
  }
  assert.deepEqual(used, ['nicole@x.com', 'nicole@x.com'], 'only the two with no @ reached Gmail');
  assert.equal((await googleTokenFor(left, 'cole@x.com')).email, 'nicole@x.com', 'other callers keep matching part of an address');
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
