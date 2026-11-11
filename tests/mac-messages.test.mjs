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
  const script = args.slice(0, -2).filter((a, i) => i % 2 === 1).join('\n');
  assert.doesNotMatch(script, /rm -rf/);
  assert.match(script, /send t to chat id dest/);
  assert.match(script, /service type = iMessage[\s\S]*service type = SMS/);
  assert.ok(args.slice(0, -2).every((a, i) => (i % 2 === 0 ? a === '-e' : true)));
});

test('helper: the errors a person can fix say how; anything else passes through, short', () => {
  assert.match(H.friendlyError('Error: unable to open database "chat.db": authorization denied'), /Full Disk Access/);
  assert.match(H.friendlyError('execution error: Not authorized to send Apple events to Messages. (-1743)'), /Automation/);
  assert.equal(H.friendlyError('x'.repeat(900)).length, 300);
  assert.equal(H.friendlyError(''), 'The Messages helper failed.');
  assert.deepEqual(JSON.parse(JSON.stringify(H.handle({ op: 'ping' }))), { version: '1.0.0' });
  assert.throws(() => H.handle({ op: 'delete' }), /Unknown Messages action/);
  assert.throws(() => H.handle({ op: 'send', to: '+1617', text: '  ' }), /Pass to and text/);
  assert.throws(() => H.handle({ op: 'send', to: '+1617', text: 'x'.repeat(2001) }), /over 2000/);
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
