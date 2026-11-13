// The Atelier Messages helper for macOS (public/mac/atelier-messages-host.js) and its installer. The helper runs under
// JavaScript for Automation on a Mac; its pure parts run here in Node (the ObjC side only runs where ObjC exists).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const HOST = readFileSync(new URL('../public/mac/atelier-messages-host.js', import.meta.url), 'utf8');
const INSTALL = readFileSync(new URL('../public/mac/install-messages.sh', import.meta.url), 'utf8');
const NAMES = ['b64Decode', 'b64Encode', 'frameLength', 'lengthBytes', 'attributedText', 'appleDate', 'chatMatch', 'recentSql', 'readSql',
  'chatForSql', 'shapeRecent', 'shapeRead', 'sendArgs', 'friendlyError', 'handle', 'LIMITS'];
const H = vm.runInNewContext(`${HOST}\n;({ ${NAMES.join(', ')} })`, {});
const utf8 = (s) => [...new TextEncoder().encode(s)];
const hex = (bytes) => bytes.map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
// What Messages stores in attributedBody, cut down to the part the helper reads.
const typedstream = (text) => {
  const t = utf8(text);
  const len = t.length < 0x80 ? [t.length] : [0x81, t.length & 255, t.length >> 8];
  return hex([...utf8('\u0004\u000bstreamtyped'), 0x81, 0xe8, 0x03, 0x84, 0x01, 0x40, 0x84, 0x84, 0x84, ...utf8('NSMutableAttributedString'),
    0x00, 0x84, 0x84, ...utf8('NSAttributedString'), 0x00, 0x84, 0x84, ...utf8('NSObject'), 0x00, 0x85, 0x92, 0x84, 0x84, 0x84, ...utf8('NSString'),
    0x01, 0x94, 0x84, 0x01, 0x2b, ...len, ...t, 0x86, 0x84, 0x02]);
};

test('helper: the host is plain JXA, with nothing run outside macOS', () => {
  assert.match(HOST, /if \(typeof ObjC !== 'undefined'\) main\(\);\s*$/);
  assert.doesNotMatch(HOST, /\brequire\(|\bimport\s/);
  assert.match(HOST, /run\('\/usr\/bin\/sqlite3', \['-readonly', '-json', db, sql\]\)/, 'chat.db is opened read-only');
  assert.match(HOST, /task\.standardInput = \$\.NSFileHandle\.fileHandleWithNullDevice;/, 'children never read Chrome’s pipe');
});

test('helper: native-messaging frames: base64 both ways and the little-endian length', () => {
  const plain = (v) => JSON.parse(JSON.stringify(v));
  for (const bytes of [[], [0], [1, 2], [255, 254, 253], utf8('Atelier ✆ 👍')]) assert.deepEqual(plain(H.b64Decode(H.b64Encode(bytes))), bytes);
  assert.equal(H.b64Encode(utf8('hi!')), Buffer.from('hi!').toString('base64'));
  assert.equal(H.frameLength([0x10, 0x27, 0, 0]), 10000);
  assert.deepEqual(plain(H.lengthBytes(70000)), [0x70, 0x11, 0x01, 0x00]);
  assert.equal(H.frameLength(H.lengthBytes(4294967295)), 4294967295);
});

test('helper: the words of a message kept only in attributedBody, short, long and with emoji', () => {
  assert.equal(H.attributedText(typedstream('On my way')), 'On my way');
  const long = 'Permit 665 Columbia Rd is approved. '.repeat(12);
  assert.equal(H.attributedText(typedstream(long)), long);
  assert.equal(H.attributedText(typedstream('Sounds good 👍 — café at 6?')), 'Sounds good 👍 — café at 6?');
  for (const junk of ['', null, 'ZZ', hex(utf8('no class name here')), hex([...utf8('NSString'), 0x01, 0x2b, 0x50, 0x41])]) assert.equal(H.attributedText(junk), '', String(junk));
});

test('helper: Messages dates in nanoseconds or seconds since 2001', () => {
  assert.equal(H.appleDate(0), null);
  assert.equal(H.appleDate(757382400), '2025-01-01T00:00:00.000Z');
  assert.equal(H.appleDate(757382400 * 1e9), '2025-01-01T00:00:00.000Z');
  assert.equal(H.appleDate('x'), null);
});

test('helper: what the model passes as a chat is quoted, never SQL; a phone number matches on its last 10 digits', () => {
  const m = H.chatMatch("x' OR 1=1; DROP TABLE message; --");
  assert.match(m, /c\.guid = 'x'' OR 1=1; DROP TABLE message; --'/);
  assert.equal((m.match(/'/g) || []).length % 2, 0, 'every quote is paired');
  assert.match(H.chatMatch('(617) 555-0142'), /c\.chat_identifier LIKE '%6175550142'/);
  assert.match(H.chatMatch('+1 617 555 0142'), /LIKE '%6175550142'/);
  assert.doesNotMatch(H.chatMatch('iMessage;-;+16175550142'), /LIKE/, 'a chat id is matched exactly');
  assert.doesNotMatch(H.chatMatch('pat@example.com'), /LIKE/);
  assert.match(H.recentSql(999), /LIMIT 50;$/);
  assert.match(H.recentSql(), /LIMIT 20;$/);
  assert.match(H.readSql('x', -5), /LIMIT 1;$/);
  assert.match(H.readSql('x'), /ORDER BY m\.date DESC LIMIT 30;$/);
});

test('helper: rows become conversations and oldest-first messages; long texts are cut', () => {
  const recent = H.shapeRecent([{ chat: 'iMessage;-;+16175550142', id: '+16175550142', name: '', people: '+16175550142', service: 'iMessage', text: null, ab: typedstream('See you'), fromMe: 0, d: 757382400 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(recent)), [{ chat: 'iMessage;-;+16175550142', name: '', people: '+16175550142', service: 'iMessage', last: { at: '2025-01-01T00:00:00.000Z', fromMe: false, text: 'See you' } }]);
  const read = H.shapeRead([{ text: 'second', fromMe: 1, d: 757382460 }, { text: 'first', fromMe: 0, sender: '+16175550142', d: 757382400 }, { text: null, ab: null, att: 1, fromMe: 0, d: 1 }]);
  assert.deepEqual(read.map((m) => [m.from, m.text]), [['them', '(attachment)'], ['+16175550142', 'first'], ['me', 'second']]);
  assert.equal(H.shapeRead([{ text: 'x'.repeat(5000), fromMe: 1, d: 1 }])[0].text.length, H.LIMITS.text + 1);
});

test('helper: the text and the destination go to osascript as arguments, never inside the script', () => {
  const evil = '"; do shell script "rm -rf ~" --';
  const args = H.sendArgs(evil, 'iMessage;-;+16175550142');
  assert.deepEqual(JSON.parse(JSON.stringify(args.slice(-2))), [evil, 'iMessage;-;+16175550142']);
  // "--" ends osascript's options, so the text can never be read as one (1.0.1): "- milk" and "-5 out here" used to
  // fail with "illegal option", and "-e <line>" became a line of the script.
  assert.equal(args.at(-3), '--');
  for (const dashed of ['- milk\n- eggs', '-5 out here', '-e do shell script "id"', '--', '-']) {
    const a = H.sendArgs(dashed, '+16175550142');
    assert.deepEqual(JSON.parse(JSON.stringify(a.slice(-3))), ['--', dashed, '+16175550142'], dashed); // (the helper runs in its own realm)
  }
  const script = args.slice(0, -3).filter((a, i) => i % 2 === 1).join('\n');
  assert.match(script, /if \(count of argv\) > 2 and item 1 of argv is "--" then set argv to rest of argv\nset t to item 1 of argv\nset dest to item 2 of argv/);
  assert.doesNotMatch(script, /rm -rf/);
  assert.match(script, /send t to chat id dest/);
  assert.match(script, /service type = iMessage[\s\S]*service type = SMS/);
  assert.ok(args.slice(0, -3).every((a, i) => (i % 2 === 0 ? a === '-e' : true)));
});

test('helper: the errors a person can fix say how; anything else passes through, short', () => {
  assert.match(H.friendlyError('Error: unable to open database "chat.db": authorization denied'), /Full Disk Access/);
  assert.match(H.friendlyError('execution error: Not authorized to send Apple events to Messages. (-1743)'), /Automation/);
  assert.equal(H.friendlyError('x'.repeat(900)).length, 300);
  assert.equal(H.friendlyError(''), 'The Messages helper failed.');
  assert.deepEqual(JSON.parse(JSON.stringify(H.handle({ op: 'ping' }))), { version: '1.0.6' });
  assert.throws(() => H.handle({ op: 'delete' }), /Unknown Messages action/);
  assert.throws(() => H.handle({ op: 'send', to: '+1617', text: '  ' }), /Pass to and text/);
  assert.throws(() => H.handle({ op: 'send', to: '+1617', text: 'x'.repeat(2001) }), /over 2000/);
});

// handle() with the macOS side played: run() answers for sqlite3 and osascript, and every call is kept.
function hostRig(answer) {
  const calls = [];
  const ctx = vm.createContext({});
  vm.runInContext(HOST, ctx);
  ctx.$ = { NSHomeDirectory: () => ({ js: '/Users/cole' }) };
  ctx.delay = () => {}; // JXA's pause: the delivery check waits between looks (1.0.2)
  ctx.run = (path, args) => { calls.push([path.split('/').pop(), JSON.parse(JSON.stringify(args))]); return { code: 0, out: '', err: '', ...answer(path.split('/').pop(), args) }; };
  const full = (msg) => { try { return JSON.parse(JSON.stringify(ctx.handle(msg))); } catch (err) { return { threw: String(err.message) }; } };
  // handle: where it went and how. What the helper saw (1.0.4: history, delivery, note) is checked with full.
  const handle = (msg) => { const r = full(msg); if (r && r.sent) { delete r.history; delete r.delivery; delete r.note; if (r.via === 'iMessage') delete r.via; } return r; };
  return { handle, full, calls, sent: () => calls.filter(([tool]) => tool === 'osascript').map(([, args]) => args.slice(-3)) };
}
const NO_ACCESS = { code: 1, err: 'Error: unable to open database "/Users/cole/Library/Messages/chat.db": authorization denied' };

// v114 review (tools #6): the send looked the conversation up in chat.db first, and without Full Disk Access that
// lookup failed and took the send with it, though the setup says sending only needs Automation.
test('helper: a send without Full Disk Access goes to the address as given; reading still says what is missing', () => {
  const rig = hostRig((tool) => (tool === 'sqlite3' ? NO_ACCESS : {}));
  assert.deepEqual(rig.handle({ op: 'send', to: '+16175550142', text: 'On my way' }), { sent: true, to: '+16175550142' });
  assert.deepEqual(rig.sent(), [['--', 'On my way', '+16175550142']], 'one send, to the number the owner approved');
  assert.deepEqual(rig.calls.map(([tool]) => tool), ['sqlite3', 'osascript', 'sqlite3'], 'the lookup was tried once, then the send, then one look for its outcome (chat.db can’t be read: the send stands)');
  assert.deepEqual(rig.handle({ op: 'send', to: 'pat@example.com', text: 'hi' }), { sent: true, to: 'pat@example.com' });
  // reading can't do without chat.db
  assert.match(rig.handle({ op: 'recent' }).threw, /^Chrome can’t read Messages yet\. Give Google Chrome Full Disk Access/);
  assert.match(rig.handle({ op: 'read', chat: '+16175550142' }).threw, /Full Disk Access/);
  assert.equal(rig.sent().length, 2, 'and a read never sends');
  // a lookup that fails any other way is no reason to drop the send either
  const odd = hostRig((tool) => (tool === 'sqlite3' ? { out: 'not json' } : {}));
  assert.deepEqual(odd.handle({ op: 'send', to: '+16175550142', text: 'x' }), { sent: true, to: '+16175550142' });
});

test('helper: with chat.db readable a send goes to the conversation that number has; a chat id needs no lookup; a failed send is a failure', () => {
  const found = hostRig((tool) => (tool === 'sqlite3' ? { out: '[{"chat":"SMS;-;+16175550142"}]' } : {}));
  assert.deepEqual(found.handle({ op: 'send', to: '(617) 555-0142', text: 'On my way' }), { sent: true, to: 'SMS;-;+16175550142', via: 'SMS' });
  assert.deepEqual(found.sent(), [['--', 'On my way', 'SMS;-;+16175550142']]);
  assert.match(found.calls[0][1].at(-1), /c\.chat_identifier LIKE '%6175550142'/, 'looked up by the number’s last ten digits');
  const none = hostRig(() => ({}));
  assert.deepEqual(none.handle({ op: 'send', to: '+16175550142', text: 'x' }), { sent: true, to: '+16175550142' }, 'no conversation yet: the number as given');
  const chat = hostRig((tool) => (tool === 'sqlite3' ? NO_ACCESS : {}));
  assert.deepEqual(chat.handle({ op: 'send', to: 'iMessage;+;chat8291', text: 'x' }), { sent: true, to: 'iMessage;+;chat8291' });
  assert.deepEqual(chat.calls.map(([tool]) => tool), ['osascript', 'sqlite3'], 'a chat id is sent to as it is (then one look for its outcome)');
  // Messages refused (no Automation yet): nothing claims the text was sent
  const refused = hostRig((tool) => (tool === 'osascript' ? { code: 1, err: 'execution error: Not authorized to send Apple events to Messages. (-1743)' } : NO_ACCESS));
  assert.match(refused.handle({ op: 'send', to: '+16175550142', text: 'x' }).threw, /^Chrome can’t control Messages yet\./);
  assert.equal(refused.sent().length, 1, 'tried once, never twice');
});

test('installer: macOS only, a real extension id, and the helper registered for that id alone', () => {
  assert.match(INSTALL, /^#!\/bin\/sh\n/);
  assert.doesNotMatch(INSTALL, /\r/, 'LF only: sh reads a CR as part of the command');
  assert.match(INSTALL, /\nset -eu\n/);
  assert.match(INSTALL, /\[ "\$\(uname\)" = "Darwin" \] \|\| fail/);
  assert.match(INSTALL, /grep -Eq '\^\[a-p\]\{32\}\$' \|\| fail/);
  assert.match(INSTALL, /"allowed_origins": \["chrome-extension:\/\/\$ID\/"\]/);
  assert.match(INSTALL, /HOST_NAME="ai\.ciprari\.atelier\.messages"/);
  assert.match(INSTALL, /exec \/usr\/bin\/osascript -l JavaScript "\$DIR\/atelier-messages-host\.js"/);
  assert.match(INSTALL, /Full Disk Access/);
  const attrs = readFileSync(new URL('../.gitattributes', import.meta.url), 'utf8');
  assert.match(attrs, /^public\/mac\/\* text eol=lf$/m, 'a Windows checkout still deploys LF');
});

test('app: the Messages row is built with the other rows, after the extension status; the setup button copies the command', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const fn = app.slice(app.indexOf('async function renderConnections'), app.indexOf('\n}\n', app.indexOf('async function renderConnections')));
  const rows = fn.indexOf('const rows = [];'), st = fn.indexOf("const extSt = EXT.ready ? await extLocal('status', {}, 8000)"), row = fn.indexOf('if (extSt?.mac) rows.push(');
  assert.ok(st > 0 && rows > st && row > rows, 'after the status and the rows array, never inside the Runway callback');
  assert.equal(fn.indexOf('if (extSt?.mac)', row + 1), -1, 'once');
  assert.match(app, /const cmd = `curl -fsSL \$\{location\.origin\}\/mac\/install-messages\.sh \| sh -s \$\{id\}`;/);
  assert.match(app, /if \(!\/\^\[a-p\]\{32\}\$\/\.test\(id\)\) return toast/);
});

test('app: asking for texts reaches the agent while a browser is connected, typos included', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const hint = new Function(`return ${/\nconst MESSAGES_HINT = (\/[^\n]+\/i);/.exec(app)[1]};`)();
  for (const p of ['read my most recent sm,s', 'read my sms', "check my sm's", 'any new texts?', 'what did Scott text me', 'show my txts', 'my iMessages', 'S M S from mom']) assert.ok(hint.test(p), p);
  for (const p of ['write a poem about summer', 'small steps', 'the smiths', 'is mom ok', 'some numbers']) assert.ok(!hint.test(p), p);
  assert.match(app, /\(Boolean\(browser\) && \(BROWSER_HINT\.test\(e\.prompt\) \|\| MESSAGES_HINT\.test\(e\.prompt\)\)\)/);
});

// Sending, with the macOS side played (helper 1.0.2 to 1.0.5, v115 to v121).
// 1.0.2: an iMessage to a number that isn't on iMessage is taken by Messages, then fails seconds later ("Not
// Delivered"). osascript never heard of it, so the helper said sent and its carrier try never ran.
// 1.0.3: a number whose last text that got through was a carrier text gets a carrier text straight away.
// 1.0.4: an SMS or RCS chat id asks for a carrier text; the answer says what the helper saw.
// 1.0.5: carrier texts go by RCS or SMS. On the owner's Mac the texts to an Android number that got through were
// "Text Message • RCS"; every plain SMS one ended "Not Delivered".
// lookup: the row chat.db gives for the number. results[i]: what chat.db says of the i-th send that Messages took
// ({ error, sent }; none = it never settles). rcs / sms: false = Messages has no such account (the script fails).
function deliveryRig({ lookup = '[]', results = [], rcs = true, sms = true } = {}) {
  let taken = 0;
  return hostRig((tool, args) => {
    if (tool === 'osascript') {
      const kind = kindOf(args);
      if ((kind === 'RCS' && !rcs) || (kind === 'SMS' && !sms)) return { code: 1, err: `execution error: Can’t get account 1 whose service type = ${kind}. (-1728)` };
      taken++;
      return {};
    }
    const sql = args.at(-1);
    if (!/m\.is_sent AS sent/.test(sql)) return { out: lookup };
    const row = results[taken - 1];
    return { out: JSON.stringify(row ? [row] : []) };
  });
}
const kindOf = (args) => (args.some((a) => /service type = iMessage/.test(a)) ? 'any' : args.some((a) => /service type = RCS/.test(a)) ? 'RCS' : 'SMS');
const kinds = (rig) => rig.calls.filter(([tool]) => tool === 'osascript').map(([, args]) => kindOf(args));
const OK = { error: 0, sent: 1 }, FAILED = { error: 22, sent: 0 };

test('helper 1.0.2: an iMessage that fails to deliver goes once more as a carrier text, to the same number', () => {
  const rig = deliveryRig({ lookup: '[{"chat":"iMessage;-;+15086885824"}]', results: [FAILED, OK] });
  assert.deepEqual(rig.handle({ op: 'send', to: '508-688-5824', text: 'Test message.' }), { sent: true, to: '5086885824', via: 'RCS' });
  assert.deepEqual(kinds(rig), ['any', 'RCS'], 'the iMessage try, then one carrier try');
  const sends = rig.calls.filter(([tool]) => tool === 'osascript').map(([, args]) => args);
  assert.deepEqual(sends[0].slice(-2), ['Test message.', 'iMessage;-;+15086885824']);
  assert.deepEqual(sends[1].slice(-3), ['--', 'Test message.', '5086885824'], 'the same text to the same number');
  // The outcome is looked for in that number's conversations, sent from here since just before the send.
  const look = rig.calls.find(([tool, args]) => tool === 'sqlite3' && /m\.is_sent AS sent/.test(args.at(-1)))[1].at(-1);
  assert.match(look, /m\.is_from_me = 1 AND m\.date >= \d{15,} AND \(\(c\.guid = 'iMessage;-;\+15086885824'/);
  // A Mac with no RCS account: the same, as SMS.
  const old = deliveryRig({ results: [FAILED, OK], rcs: false });
  assert.deepEqual(old.handle({ op: 'send', to: '+15086885824', text: 'x' }), { sent: true, to: '+15086885824', via: 'SMS' });
  assert.deepEqual(kinds(old), ['any', 'RCS', 'SMS']);
});

test('helper 1.0.2: no carrier text on this Mac (no iPhone forwarding) is a plain failure, never "sent"', () => {
  const none = deliveryRig({ results: [FAILED], rcs: false, sms: false });
  assert.match(none.handle({ op: 'send', to: '+15086885824', text: 'x' }).threw, /^Messages couldn’t deliver this over iMessage, and this Mac can’t send it as SMS\. Sending SMS from a Mac needs an iPhone with Text Message Forwarding on\.$/);
  // An email address or a group has no carrier text to fall back to: one try, and the failure says so.
  const mail = deliveryRig({ results: [FAILED] });
  assert.match(mail.handle({ op: 'send', to: 'pat@example.com', text: 'x' }).threw, /^Messages couldn’t deliver this over iMessage\. Check the address/);
  assert.equal(mail.sent().length, 1);
  const group = deliveryRig({ results: [FAILED] });
  assert.match(group.handle({ op: 'send', to: 'iMessage;+;chat8291', text: 'x' }).threw, /Check the address/);
  assert.equal(group.sent().length, 1);
});

test('helper 1.0.2: a delivered iMessage is sent once; an outcome that never settles keeps the old answer', () => {
  const ok = deliveryRig({ results: [OK] });
  assert.deepEqual(ok.handle({ op: 'send', to: '+16175550142', text: 'On my way' }), { sent: true, to: '+16175550142' });
  assert.equal(ok.sent().length, 1);
  assert.equal(ok.calls.filter(([tool, args]) => tool === 'sqlite3' && /is_sent/.test(args.at(-1))).length, 1, 'it stops looking once sent');
  const slow = deliveryRig({});
  assert.deepEqual(slow.handle({ op: 'send', to: '+16175550142', text: 'x' }), { sent: true, to: '+16175550142' });
  assert.equal(slow.sent().length, 1, 'no answer from chat.db is never a reason to send twice');
  assert.match(HOST, /const WATCH = \{ first: 12, again: 10, every: 1 \};/, '12 s and 10 s of looks fit the extension’s 30 s for the helper');
});

test('helper 1.0.3: a number whose last text that got through was SMS gets SMS, with no iMessage try', () => {
  const rig = deliveryRig({ lookup: '[{"chat":"iMessage;-;+15086885824","service":"SMS"}]', results: [OK] });
  assert.deepEqual(rig.handle({ op: 'send', to: '508-688-5824', text: 'Test message from Cole.' }), { sent: true, to: '5086885824', via: 'SMS' });
  assert.deepEqual(kinds(rig), ['SMS'], 'one send, SMS only');
  // The lookup counts only texts that got through: received ones, or sent ones delivered without error.
  const look = rig.calls[0][1].at(-1);
  assert.match(look, /AS chat,\n\(SELECT m\.service FROM message m/);
  assert.match(look, /AND \(m\.is_from_me = 0 OR \(m\.error = 0 AND m\.is_delivered = 1\)\) ORDER BY m\.date DESC LIMIT 1\) AS service;$/);
  // A chat id that ends in a number is looked up by that number, and goes the same way.
  const chatId = deliveryRig({ lookup: '[{"chat":"iMessage;-;+15086885824","service":"SMS"}]', results: [OK] });
  assert.deepEqual(chatId.handle({ op: 'send', to: 'iMessage;-;+15086885824', text: 'x' }), { sent: true, to: '+15086885824', via: 'SMS' });
  assert.match(chatId.calls[0][1].at(-1), /LIKE '%5086885824'/);
});

test('helper 1.0.3: a carrier text that fails says how to fix it; iMessage numbers and unreadable chat.db keep the iMessage road', () => {
  const noFwd = deliveryRig({ lookup: '[{"chat":"SMS;-;+15086885824","service":"SMS"}]', rcs: false, sms: false });
  assert.equal(noFwd.handle({ op: 'send', to: '+15086885824', text: 'x' }).threw, 'Messages couldn’t send this as a text (RCS or SMS). On your iPhone, turn on Text Message Forwarding for this Mac.');
  assert.deepEqual(kinds(noFwd), ['SMS', 'RCS'], 'each tried once');
  const failed = deliveryRig({ lookup: '[{"chat":"SMS;-;+15086885824","service":"SMS"}]', results: [FAILED, FAILED] });
  assert.match(failed.handle({ op: 'send', to: '+15086885824', text: 'x' }).threw, /^Messages couldn’t send this text \(error 22\)\./);
  assert.deepEqual(kinds(failed), ['SMS'], 'a send Messages took and then failed is not sent again');
  // The last text that got through was iMessage: iMessage first, as before.
  const blue = deliveryRig({ lookup: '[{"chat":"iMessage;-;+16175550142","service":"iMessage"}]', results: [OK] });
  assert.deepEqual(blue.handle({ op: 'send', to: '+16175550142', text: 'x' }), { sent: true, to: 'iMessage;-;+16175550142' });
  assert.deepEqual(kinds(blue), ['any']);
  // An email never goes as a carrier text, whatever the lookup says.
  const mail = deliveryRig({ lookup: '[{"chat":"iMessage;-;pat@example.com","service":"SMS"}]', results: [OK] });
  assert.deepEqual(mail.handle({ op: 'send', to: 'pat@example.com', text: 'x' }), { sent: true, to: 'iMessage;-;pat@example.com' });
  const noDb = hostRig((tool) => (tool === 'sqlite3' ? NO_ACCESS : {}));
  assert.deepEqual(noDb.handle({ op: 'send', to: '+16175550142', text: 'x' }), { sent: true, to: '+16175550142' });
});

test('helper 1.0.4: an SMS or RCS chat id sends a carrier text straight away, with or without any history', () => {
  for (const lookup of ['[]', '[{"chat":"iMessage;-;+15086885824","service":"iMessage"}]']) {
    const rig = deliveryRig({ lookup, results: [OK] });
    assert.deepEqual(rig.full({ op: 'send', to: 'SMS;-;+15086885824', text: 'x' }), { sent: true, to: '+15086885824', via: 'RCS', history: lookup === '[]' ? 'none' : 'iMessage', delivery: 'confirmed' });
    assert.deepEqual(kinds(rig), ['RCS'], 'no iMessage try; RCS first when nothing says SMS worked');
  }
  // No Full Disk Access: still a carrier text, since the chat id says so.
  const noDb = hostRig((tool) => (tool === 'sqlite3' ? NO_ACCESS : {}));
  assert.deepEqual(noDb.full({ op: 'send', to: 'RCS;-;+15086885824', text: 'x' }), { sent: true, to: '+15086885824', via: 'RCS', history: 'unreadable', delivery: 'unconfirmed' });
  // A group chat id is never rerouted.
  const group = deliveryRig({ results: [OK] });
  assert.equal(group.full({ op: 'send', to: 'SMS;+;chat8291', text: 'x' }).via, 'SMS', 'an SMS group goes to its chat id, which Messages sends as SMS');
  assert.deepEqual(group.sent().at(-1).slice(-1), ['SMS;+;chat8291']);
});

test('helper 1.0.4: the answer says what the helper saw, and says how to fix a send it could not check', () => {
  const noDb = hostRig((tool) => (tool === 'sqlite3' ? NO_ACCESS : {}));
  const r = noDb.full({ op: 'send', to: '+15086885824', text: 'x' });
  assert.deepEqual(r, { sent: true, to: '+15086885824', via: 'iMessage', history: 'unreadable', delivery: 'unconfirmed', note: 'Atelier couldn’t read this Mac’s texts, so it sent iMessage without checking. If it shows Not Delivered, give Google Chrome Full Disk Access, then quit and reopen Chrome.' });
  // An email has no carrier road, so no note about one.
  assert.equal(noDb.full({ op: 'send', to: 'pat@example.com', text: 'x' }).note, undefined);
  const retried = deliveryRig({ results: [FAILED, OK] });
  assert.deepEqual(retried.full({ op: 'send', to: '+15086885824', text: 'x' }), { sent: true, to: '+15086885824', via: 'RCS', history: 'none', delivery: 'confirmed', note: 'iMessage couldn’t deliver it, so it went again as a carrier text.' });
  const pending = deliveryRig({ lookup: '[{"chat":"iMessage;-;+16175550142","service":"iMessage"}]' });
  assert.deepEqual(pending.full({ op: 'send', to: '+16175550142', text: 'x' }), { sent: true, to: 'iMessage;-;+16175550142', via: 'iMessage', history: 'iMessage', delivery: 'unconfirmed' });
  // Only real texts count as history: no group events or other system rows.
  assert.match(pending.calls[0][1].at(-1), /IFNULL\(m\.item_type, 0\) = 0 AND \(m\.is_from_me = 0/);
});

test('helper 1.0.5: a number whose last text that got through was RCS gets RCS; a Mac with no RCS account uses SMS', () => {
  const rig = deliveryRig({ lookup: '[{"chat":"any;-;+15086885824","service":"RCS"}]', results: [OK] });
  assert.deepEqual(rig.full({ op: 'send', to: '508-688-5824', text: 'Test message from my Mac.' }), { sent: true, to: '5086885824', via: 'RCS', history: 'RCS', delivery: 'confirmed' });
  assert.deepEqual(kinds(rig), ['RCS']);
  const sent = rig.calls.find(([tool]) => tool === 'osascript')[1];
  assert.ok(sent.includes('send t to participant dest of (1st account whose service type = RCS)'));
  assert.deepEqual(sent.slice(-3), ['--', 'Test message from my Mac.', '5086885824'], 'the text and the number are arguments, never part of the script');
  // Messages has no RCS account: nothing was sent by that script, so SMS goes, once.
  const back = deliveryRig({ lookup: '[{"chat":"any;-;+15086885824","service":"RCS"}]', results: [OK], rcs: false });
  assert.equal(back.full({ op: 'send', to: '+15086885824', text: 'x' }).via, 'SMS');
  assert.deepEqual(kinds(back), ['RCS', 'SMS']);
  // Messages refused the script for want of Automation: that is said, and nothing else is tried.
  const refused = hostRig((tool) => (tool === 'osascript' ? { code: 1, err: 'execution error: Not authorized to send Apple events to Messages. (-1743)' } : { out: '[{"chat":"x","service":"RCS"}]' }));
  assert.match(refused.handle({ op: 'send', to: '+15086885824', text: 'x' }).threw, /^Chrome can’t control Messages yet\./);
  assert.equal(refused.sent().length, 1);
});


test('app: the agent is told how to send SMS, to pass on the helper’s note, and never to resend on its own', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /To send as SMS \(the user asks for SMS, or the person uses Android\), set to "SMS;-;" plus the number with its country code, like SMS;-;\+15085550142\. Pass on any note in the send result\. Never send the same text again unless the user asks\./);
  assert.match(app, /For SMS: SMS;-; plus the number, like SMS;-;\+15085550142' \}/);
});

// v122 (helper 1.0.6): chat.db on the owner's Mac showed every failed carrier text with error 4 and never sent, one typed
// by hand in Messages included, and five sends in twelve seconds: a failed try was sent again by the other service.
test('helper 1.0.6: a carrier text that Messages took and failed is final, and the answer names Messages’ error', () => {
  const TIMEOUT = { error: 4, sent: 0 };
  for (const service of ['RCS', 'SMS']) {
    const rig = deliveryRig({ lookup: `[{"chat":"any;-;+15086885824","service":"${service}"}]`, results: [TIMEOUT, OK] });
    assert.equal(rig.handle({ op: 'send', to: '+15086885824', text: 'x' }).threw, 'Messages couldn’t send this text (error 4). The iPhone didn’t take it from this Mac in time. Check that the iPhone is on and unlocked, wait a few minutes, then send once. Don’t send it again unless the user asks.');
    assert.deepEqual(kinds(rig), [service], 'one request, one text');
  }
  const forced = deliveryRig({ results: [TIMEOUT, OK] });
  assert.match(forced.handle({ op: 'send', to: 'SMS;-;+15086885824', text: 'x' }).threw, /\(error 4\)/);
  assert.deepEqual(kinds(forced), ['RCS']);
  // Another code: no guess at the cause.
  const other = deliveryRig({ lookup: '[{"chat":"x","service":"SMS"}]', results: [{ error: 39, sent: 0 }] });
  assert.equal(other.handle({ op: 'send', to: '+15086885824', text: 'x' }).threw, 'Messages couldn’t send this text (error 39). Look at that conversation in Messages on this Mac. Don’t send it again unless the user asks.');
  // An iMessage that fails still gets its one carrier try (1.0.2); that try failing is final too.
  const blue = deliveryRig({ results: [FAILED, TIMEOUT] });
  assert.match(blue.handle({ op: 'send', to: '+15086885824', text: 'x' }).threw, /\(error 4\)/);
  assert.deepEqual(kinds(blue), ['any', 'RCS']);
});
