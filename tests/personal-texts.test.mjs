// v131: the owner's personal Android phone, through Google Messages for web (messages.google.com/web) in a browser tab.
// The extension (1.4.6) reads and sends through that page's own data-e2e-* marks; the app offers three tools on it; the
// relay asks each connected computer until one has the tab.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const BACKGROUND = read('extension/background.js').replace(/\r/g, '');
const APP = read('public/app.js');
const RELAY = read('src/relay.js');
const WORKER = read('src/worker.js');

// ── a small stand-in for the Google Messages page ──
const el = (attrs = {}, parts = {}, extra = {}) => ({
  attrs, clicked: 0, disabled: false, innerText: '', ...extra,
  getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; },
  querySelector(sel) { return parts[sel] ?? null; },
  click() { this.clicked++; extra.onClick?.(); },
  focus() { this.focused = true; },
});
const text = (t) => ({ innerText: t });
function page({ path = '/web/conversations', rows = [], messages = [], header = '', draft = '' } = {}) {
  const location = { pathname: path };
  const list = rows.map((r) => el({ href: `/web/conversations/${r.chat}`, 'data-e2e-is-unread': String(r.unread === true) }, {
    '[data-e2e-conversation-name]': text(r.name), '[data-e2e-conversation-snippet]': text(r.last || ''), 'mws-relative-timestamp': text(r.at || ''),
  }, { onClick: () => { location.pathname = `/web/conversations/${r.chat}`; } }));
  const wrappers = messages.map((m) => el({ 'is-outgoing': String(m.out === true) }, {
    'mws-text-message-part': m.text === undefined ? null : el({ 'aria-label': `${m.out ? 'You' : header} said: ${m.text}. ${m.out ? 'Sent' : 'Received'} on ${m.at || 'November 13, 2026 at 4:54 PM'}. Delivered.` }),
    '[data-e2e-text-message-content]': m.text === undefined ? null : text(m.text),
    '[data-e2e-message-image], mws-image-message-part': m.image ? {} : null,
  }));
  const box = { innerText: draft, focus() { this.focused = true; } };
  const send = el({}, {}, { onClick: () => { wrappers.push(el({ 'is-outgoing': 'true' })); box.innerText = ''; } });
  send.disabled = true;
  const document = {
    box, send, wrappers, list,
    querySelectorAll(sel) {
      if (sel === 'a[data-e2e-conversation]') return list;
      if (sel === 'mws-message-wrapper') return wrappers;
      if (sel === 'mws-message-wrapper[is-outgoing="true"]') return wrappers.filter((w) => w.attrs['is-outgoing'] === 'true');
      return [];
    },
    querySelector(sel) {
      if (sel === '[data-e2e-header-title]') return text(header);
      if (sel === '[data-e2e-message-input-box]') return box;
      if (sel === '[data-e2e-send-text-button]') return send;
      return null;
    },
    execCommand(cmd, ui, value) { assert.equal(cmd, 'insertText'); box.innerText += value; send.disabled = false; return true; },
  };
  return { document, location };
}
const fnSrc = /\nfunction pageGMessages\(op, arg = \{\}\) \{\n[\s\S]*?\n\}\n/.exec(BACKGROUND)[0];
const run = (p, op, arg) => new Function('document', 'location', `${fnSrc}; return pageGMessages;`)(p.document, p.location)(op, arg);
const ROWS = [
  { chat: 'CgAAA111', name: 'Work', last: 'testing the new helper', at: '4:54 PM', unread: true },
  { chat: 'CgBBB222', name: 'Pat Example', last: 'see you at 6', at: 'Yesterday' },
  { chat: 'CgCCC333', name: '(617) 555-0142', last: 'your code is 123456', at: 'Mon' },
];

test('personal texts: the conversation list, as the page shows it; a page not yet paired says so', () => {
  const p = page({ rows: ROWS });
  assert.deepEqual(run(p, 'state'), { paired: true, list: 3 });
  assert.deepEqual(run(p, 'recent', { limit: 2 }), [
    { chat: 'CgAAA111', name: 'Work', last: 'testing the new helper', at: '4:54 PM', unread: true },
    { chat: 'CgBBB222', name: 'Pat Example', last: 'see you at 6', at: 'Yesterday', unread: false },
  ]);
  assert.equal(run(page({ path: '/web/welcome' }), 'state').paired, false);
  assert.equal(run(page({ path: '/web/authentication' }), 'state').paired, false);
});

test('personal texts: a conversation is found by its id, its name, a phone number or part of a name, and opened', () => {
  for (const [chat, want] of [['CgBBB222', 'CgBBB222'], ['pat example', 'CgBBB222'], ['Pat', 'CgBBB222'], ['617-555-0142', 'CgCCC333'], ['+1 (617) 555-0142', 'CgCCC333'], ['Work', 'CgAAA111']]) {
    const p = page({ rows: ROWS });
    const hit = run(p, 'open', { chat });
    assert.equal(hit.chat, want, chat);
    assert.equal(p.location.pathname, `/web/conversations/${want}`, 'opened by a click on its own row');
    assert.equal(p.document.list.reduce((n, a) => n + a.clicked, 0), 1);
  }
  const none = page({ rows: ROWS });
  assert.deepEqual(run(none, 'open', { chat: 'Nobody Here' }), { error: 'none' });
  assert.deepEqual(run(none, 'open', { chat: 'xy' }), { error: 'none' }, 'two letters match no name by chance');
  assert.equal(none.document.list.reduce((n, a) => n + a.clicked, 0), 0);
});

test('personal texts: messages oldest first, with who said each and when; none until that conversation is the one showing', () => {
  const messages = [{ text: 'are you free at 6?', at: 'November 12, 2026 at 3:02 PM' }, { out: true, text: 'yes', at: 'November 12, 2026 at 3:05 PM' }, { image: true }, { out: true }];
  const p = page({ path: '/web/conversations/CgBBB222', rows: ROWS, messages, header: 'Pat Example' });
  assert.deepEqual(run(p, 'messages', { chat: 'CgBBB222', limit: 30 }), {
    ready: true, name: 'Pat Example',
    messages: [
      { from: 'Pat Example', at: 'November 12, 2026 at 3:02 PM', text: 'are you free at 6?' },
      { from: 'me', at: 'November 12, 2026 at 3:05 PM', text: 'yes' },
      { from: 'Pat Example', at: '', text: '(image)' },
      { from: 'me', at: '', text: '(attachment)' },
    ],
  });
  assert.equal(run(p, 'messages', { chat: 'CgBBB222', limit: 2 }).messages.length, 2, 'the newest ones');
  assert.deepEqual(run(p, 'messages', { chat: 'CgAAA111', limit: 30 }), { ready: false }, 'another conversation is showing');
  assert.deepEqual(run(page({ path: '/web/conversations/CgBBB222' }), 'messages', { chat: 'CgBBB222', limit: 30 }), { ready: false });
});

test('personal texts: the text is typed into the page’s own box and sent with its own button; a draft left there is never sent', () => {
  const p = page({ path: '/web/conversations/CgBBB222', rows: ROWS, messages: [{ out: true, text: 'yes' }], header: 'Pat Example' });
  assert.deepEqual(run(p, 'outgoing'), { n: 1, here: 'CgBBB222' });
  assert.deepEqual(run(p, 'send'), { error: 'button' }, 'nothing to send yet: the button is off');
  assert.deepEqual(run(p, 'type', { text: 'On my way' }), { typed: true });
  assert.deepEqual(run(p, 'send'), { clicked: true });
  assert.deepEqual(run(p, 'outgoing'), { n: 2, here: 'CgBBB222' });
  const draft = page({ path: '/web/conversations/CgBBB222', draft: 'half a thought' });
  assert.deepEqual(run(draft, 'type', { text: 'On my way' }), { error: 'draft' });
  assert.equal(draft.document.box.innerText, 'half a thought', 'left as it was');
});

test('personal texts: the command needs approval to send, asks like a text from the Mac, and never says sent on a guess', () => {
  const cmd = /\n {2}async gmessages\(args = \{\}, ctx = \{\}\) \{\n[\s\S]*?\n {2}\},\n/.exec(BACKGROUND)[0];
  assert.match(cmd, /if \(op === 'send'\) \{\n {6}if \(ctx\.approved !== true\) throw new Error\(SEND_NEEDS_APPROVAL\);/);
  assert.match(cmd, /const got = await gmOpen\(page, to, 1\);\n {6}await confirmFirst\('sms', \{ to: got\.name \|\| to, text \}, ctx\.via\);/, 'the confirmation names the conversation found');
  assert.match(cmd, /if \(before\?\.here !== got\.chat\) throw new Error\(GM_NOT_SENT\);/, 'the tab moved on while the user was asked: nothing is typed');
  assert.match(cmd, /if \(now\?\.here === got\.chat && now\.n > before\.n\) return \{ sent: true, to: got\.name \|\| to, chat: got\.chat, via: 'Google Messages' \};/, 'sent only once a new outgoing message shows');
  assert.equal((cmd.match(/return \{ sent: true/g) || []).length, 1);
  assert.match(BACKGROUND, /const REMOTE_COMMANDS = \[[^\]]*'messages', 'gmessages', 'show'\];/);
  assert.match(BACKGROUND, /const tabs = await chrome\.tabs\.query\(\{ url: GM_URL \}\);/);
  assert.match(BACKGROUND, /if \(!tab\) throw new Error\(GM_NOT_OPEN\);/);
  assert.match(BACKGROUND, /if \(!st\?\.paired\) throw new Error\(GM_NOT_PAIRED\);/);
});

test('personal texts: the app’s three tools, their wording to the model, and where a step goes', () => {
  for (const name of ['personal_texts_recent', 'personal_texts_read', 'personal_texts_send']) assert.match(APP, new RegExp(`\\n {2}\\['${name}', `), name);
  assert.match(APP, /\['personal_texts_send', 'Send a personal text', true, /, 'a send is a write: it asks first');
  assert.match(APP, /\['personal_texts_recent', 'Recent personal texts', false, /);
  assert.match(APP, /extCall\(step\.name\.startsWith\('personal_texts_'\) \? 'gmessages' : 'messages', \{ \.\.\.step\.args, op: step\.name\.replace\(\/\^\(messages\|personal_texts\)_\/, ''\) \}, \/_send\$\/\.test\(step\.name\) \? 90000 : 60000,/);
  assert.match(APP, /the text of messages_send and of personal_texts_send;/, 'written as the user: the humanizer rules cover it');
  assert.match(APP, /Use those when the user says personal, or names that phone\. Use the messages_ tools for the work phone, the iPhone, the Mac, or when they don't say\./);
  // This browser has no Google Messages tab: the other computers are asked.
  assert.match(APP, /if \(cmd === 'gmessages' && \/\^Google Messages isn’t \(open\|paired\) in this browser\/\.test\(err\?\.message \|\| ''\)\) return viaRelay\(\);/);
  assert.match(WORKER, /const allowed = \[[^\]]*'messages', 'gmessages', 'show'\];/);
});

test('personal texts: the relay needs approval for a send, and asks each computer until one has the tab', async () => {
  assert.match(RELAY, /if \(cmd === 'messages' \|\| cmd === 'gmessages'\) return args\?\.op === 'send';/);
  assert.match(RELAY, /const order = cmd === 'gmessages' \? this\.ctx\.getWebSockets\('browser'\)\.slice\(\)\.reverse\(\) : \[ws\];/);
  assert.match(RELAY, /if \(!\(cmd === 'gmessages' && last\.ok === false && NO_GM_TAB\.test\(last\.error \|\| ''\)\)\) return Response\.json\(last\);/);
  const NO = new RegExp(/const NO_GM_TAB = (\/[^\n]+\/);/.exec(RELAY)[1].slice(1, -1));
  const said = (k) => new RegExp(`const ${k} = '([^']+)';`).exec(BACKGROUND)[1];
  assert.ok(NO.test(said('GM_NOT_OPEN')) && NO.test(said('GM_NOT_PAIRED')), 'the relay knows both answers of a browser without the tab');
  assert.ok(!NO.test(said('GM_NO_CHAT')) && !NO.test(said('GM_NOT_SENT')), 'any other answer is final: a send is never tried on a second computer');
});
