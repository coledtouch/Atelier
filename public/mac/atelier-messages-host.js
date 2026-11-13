// Atelier Messages helper for macOS: a Chrome native-messaging host that lets the Atelier Browser extension read
// Messages (iMessage and SMS) and send a text through Messages.app. It runs as JavaScript for Automation
// (/usr/bin/osascript -l JavaScript) and uses only what ships with macOS: sqlite3 for ~/Library/Messages/chat.db
// (read-only) and osascript for sending. install-messages.sh puts it in ~/Library/Application Support/Atelier and
// registers it for one extension id only. Chrome starts it for each request: one message in, one answer out.
//
// It needs two macOS permissions, both asked of Google Chrome (the app that starts it): Full Disk Access to read
// chat.db, and Automation → Messages to send.

const HOST_VERSION = '1.0.6';
const LIMITS = { recent: 50, read: 100, text: 2000, chat: 200 };
const APPLE_EPOCH_MS = 978307200000; // 2001-01-01, where Messages counts its dates from

// ── pure helpers (tests/mac-messages.test.mjs runs these in Node) ──
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function b64Decode(s) {
  const clean = String(s || '').replace(/[^A-Za-z0-9+/]/g, '');
  const out = [];
  for (let i = 0; i < clean.length; i += 4) {
    const n = [0, 1, 2, 3].map((k) => (i + k < clean.length ? B64.indexOf(clean[i + k]) : -1));
    out.push(((n[0] << 2) | (n[1] >> 4)) & 255);
    if (n[2] >= 0) out.push((((n[1] & 15) << 4) | (n[2] >> 2)) & 255);
    if (n[3] >= 0) out.push((((n[2] & 3) << 6) | n[3]) & 255);
  }
  return out;
}
function b64Encode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b = 0, c = 0] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    s += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
    s += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : '=';
    s += i + 2 < bytes.length ? B64[c & 63] : '=';
  }
  return s;
}
// Native messaging frames: a 4-byte length in the machine's order (little-endian on every Mac), then UTF-8 JSON.
const frameLength = (bytes) => (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
const lengthBytes = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];

function utf8Decode(bytes) {
  try { return decodeURIComponent(bytes.map((b) => `%${b.toString(16).padStart(2, '0')}`).join('')); } catch { return ''; }
}
function hexBytes(hex) {
  const out = [];
  const h = String(hex || '');
  for (let i = 0; i + 1 < h.length; i += 2) out.push(parseInt(h.slice(i, i + 2), 16));
  return out;
}
// Newer macOS keeps a message's words in attributedBody (an NSArchiver "typedstream") and leaves text empty. The
// words follow the NSString class name: a '+' (0x2B), then the length (one byte, or 0x81 + 2 bytes, or 0x82 + 4
// bytes, little-endian), then the UTF-8 text.
function attributedText(hex) {
  const b = hexBytes(hex);
  const mark = [0x4e, 0x53, 0x53, 0x74, 0x72, 0x69, 0x6e, 0x67]; // "NSString"
  let at = -1;
  for (let i = 0; i + mark.length <= b.length && at < 0; i++) if (mark.every((m, k) => b[i + k] === m)) at = i + mark.length;
  if (at < 0) return '';
  const plus = b.indexOf(0x2b, at);
  if (plus < 0 || plus - at > 8) return '';
  let p = plus + 1, len = b[p++];
  if (len === 0x81) { len = b[p] | (b[p + 1] << 8); p += 2; }
  else if (len === 0x82) { len = (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0; p += 4; }
  if (!(len > 0) || p + len > b.length) return '';
  return utf8Decode(b.slice(p, p + len));
}
// Messages dates: nanoseconds since 2001 on current macOS, seconds on old ones.
function appleDate(d) {
  const n = Number(d);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(APPLE_EPOCH_MS + (n > 1e12 ? n / 1e6 : n * 1000)).toISOString();
}
const sqlString = (s) => `'${String(s).replace(/'/g, "''")}'`;
const clampInt = (v, lo, hi, dflt) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };
const cut = (s, n = LIMITS.text) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n)}…` : t; };
const bodyOf = (row) => cut(row.text || attributedText(row.ab) || (row.att ? '(attachment)' : ''));
// A chat id (iMessage;-;+15551234567) or a chat identifier is matched as given; a phone number by its last 10 digits.
function chatMatch(chat) {
  const c = String(chat || '').trim().slice(0, LIMITS.chat);
  const digits = c.replace(/\D/g, '');
  const parts = [`c.guid = ${sqlString(c)}`, `c.chat_identifier = ${sqlString(c)}`];
  if (!c.includes(';') && !c.includes('@') && digits.length >= 7) parts.push(`c.chat_identifier LIKE ${sqlString(`%${digits.slice(-10)}`)}`);
  return `(${parts.join(' OR ')})`;
}
function recentSql(limit) {
  return `SELECT c.guid AS chat, c.chat_identifier AS id, c.display_name AS name, c.service_name AS service,
  (SELECT group_concat(h.id, ', ') FROM chat_handle_join chj JOIN handle h ON h.ROWID = chj.handle_id WHERE chj.chat_id = c.ROWID) AS people,
  m.text AS text, hex(m.attributedBody) AS ab, m.cache_has_attachments AS att, m.is_from_me AS fromMe, m.date AS d
FROM chat c JOIN message m ON m.ROWID = (SELECT MAX(cmj.message_id) FROM chat_message_join cmj WHERE cmj.chat_id = c.ROWID)
ORDER BY m.date DESC LIMIT ${clampInt(limit, 1, LIMITS.recent, 20)};`;
}
function readSql(chat, limit) {
  return `SELECT m.text AS text, hex(m.attributedBody) AS ab, m.cache_has_attachments AS att, m.is_from_me AS fromMe, m.date AS d, h.id AS sender, c.guid AS chat
FROM message m JOIN chat_message_join cmj ON cmj.message_id = m.ROWID JOIN chat c ON c.ROWID = cmj.chat_id LEFT JOIN handle h ON h.ROWID = m.handle_id
WHERE ${chatMatch(chat)} ORDER BY m.date DESC LIMIT ${clampInt(limit, 1, LIMITS.read, 30)};`;
}
// The conversation a number already has, and the service its last text that got through used: one the owner received,
// or one sent from here that was delivered (1.0.3, v116). A failed iMessage never counts.
const chatForSql = (to) => `SELECT (SELECT c.guid FROM chat c JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
WHERE ${chatMatch(to)} ORDER BY cmj.message_id DESC LIMIT 1) AS chat,
(SELECT m.service FROM message m JOIN chat_message_join cmj ON cmj.message_id = m.ROWID JOIN chat c ON c.ROWID = cmj.chat_id
WHERE ${chatMatch(to)} AND IFNULL(m.item_type, 0) = 0 AND (m.is_from_me = 0 OR (m.error = 0 AND m.is_delivered = 1)) ORDER BY m.date DESC LIMIT 1) AS service;`;
function shapeRecent(rows) {
  return rows.map((r) => ({ chat: r.chat, name: r.name || '', people: r.people || r.id || '', service: r.service || '', last: { at: appleDate(r.d), fromMe: r.fromMe === 1, text: bodyOf(r) } }));
}
function shapeRead(rows) {
  return rows.slice().reverse().map((r) => ({ at: appleDate(r.d), from: r.fromMe === 1 ? 'me' : r.sender || 'them', text: bodyOf(r) }));
}
// Sends to a chat id when it has one (the conversation that exists), else to the person over iMessage, then SMS.
const SEND_SCRIPT = [
  'on run argv',
  // sendArgs puts "--" before the text (see there). osascript takes it off; should a version ever hand it on, it is
  // dropped here, so the text and the destination are always the last two.
  'if (count of argv) > 2 and item 1 of argv is "--" then set argv to rest of argv',
  'set t to item 1 of argv',
  'set dest to item 2 of argv',
  'tell application "Messages"',
  'if dest contains ";" then',
  'send t to chat id dest',
  'else',
  'try',
  'send t to participant dest of (1st account whose service type = iMessage)',
  'on error',
  'send t to participant dest of (1st account whose service type = SMS)',
  'end try',
  'end if',
  'end tell',
  'end run',
];
// "--" ends osascript's options. Without it a text that starts with a dash was read as one: "- milk" or "-5 out here"
// failed with "illegal option" and nothing was sent, and a text shaped like "-e <line>" became a line of the script,
// which is what passing the text as an argument is meant to rule out (1.0.1, v114).
const sendArgs = (text, dest) => [...SEND_SCRIPT.flatMap((line) => ['-e', line]), '--', String(text), String(dest)];
// SMS only, to a phone number: the second try when iMessage could not deliver (1.0.2, v115).
const SMS_SCRIPT = [
  'on run argv',
  'if (count of argv) > 2 and item 1 of argv is "--" then set argv to rest of argv',
  'set t to item 1 of argv',
  'set dest to item 2 of argv',
  'tell application "Messages"',
  'send t to participant dest of (1st account whose service type = SMS)',
  'end tell',
  'end run',
];
const smsArgs = (text, number) => [...SMS_SCRIPT.flatMap((line) => ['-e', line]), '--', String(text), String(number)];
// The same through the iPhone's RCS account (1.0.5, v121). On the owner's Mac the texts to an Android number that got
// through were "Text Message • RCS"; every plain SMS one ended "Not Delivered". A Mac whose Messages has no RCS account
// fails this script at once, and the SMS one is tried.
const rcsArgs = (text, number) => [...SMS_SCRIPT.map((line) => line.replace('service type = SMS', 'service type = RCS')).flatMap((line) => ['-e', line]), '--', String(text), String(number)];
const CARRIER_ARGS = { SMS: smsArgs, RCS: rcsArgs };
// Messages takes a send at once and delivers it in the background. An iMessage to a number that isn't on iMessage
// fails seconds later ("Not Delivered"), and osascript never hears of it, so the helper said sent and the SMS try never
// ran. chat.db records the outcome: the helper now waits for it (1.0.2, v115).
// 1.0.3 (v116): 8 s was too short. Messages can take longer than that to give up on an iMessage, so the SMS try never ran.
const WATCH = { first: 12, again: 10, every: 1 }; // seconds; the extension gives the helper 30 s in all, and a send can try twice
const appleNs = (ms) => Math.floor((ms / 1000 - 978307200) * 1e9);
const outcomeSql = (chat, since) => `SELECT m.error AS error, m.is_sent AS sent FROM message m
JOIN chat_message_join cmj ON cmj.message_id = m.ROWID JOIN chat c ON c.ROWID = cmj.chat_id
WHERE m.is_from_me = 1 AND m.date >= ${since} AND (${chatMatch(chat)}) ORDER BY m.date DESC LIMIT 1;`;
// 'sent', 'failed', or 'unknown' (chat.db can't be read, or nothing settled in time).
// The code Messages gave the last send that failed (chat.db message.error), for the failure's own words (1.0.6, v122).
let lastError = 0;
// On the owner's Mac every failed carrier text carried error 4 and was never sent, a text typed by hand included: the
// iPhone did not take it from the Mac in time. The helper then sent the same text again by the other service, and five
// went out in twelve seconds. A send that Messages took and then failed is now final: one request, one text.
const sendFailed = (code) => `Messages couldn’t send this text (error ${code}). ${code === 4 ? 'The iPhone didn’t take it from this Mac in time. Check that the iPhone is on and unlocked, wait a few minutes, then send once.' : 'Look at that conversation in Messages on this Mac.'} Don’t send it again unless the user asks.`;
function outcome(chat, since, tries) {
  for (let i = 0; i < tries; i++) {
    delay(WATCH.every);
    let row;
    try { row = query(outcomeSql(chat, since))[0]; } catch { return 'unknown'; }
    if (row && Number(row.error)) { lastError = Number(row.error); return 'failed'; }
    if (row && Number(row.sent) === 1) return 'sent';
  }
  return 'unknown';
}
// The phone number in what the owner approved (a number, or a one-to-one chat id that ends in one); '' for an email or a group.
function phoneOf(to, dest) {
  for (const s of [to, String(dest).split(';').pop()]) {
    const t = String(s || '').trim();
    if (!t.includes('@') && /^\+?[\d\s().-]{7,}$/.test(t) && t.replace(/\D/g, '').length >= 7) return t.replace(/[^\d+]/g, '');
  }
  return '';
}
const NO_SMS = 'Messages couldn’t deliver this over iMessage, and this Mac can’t send it as SMS. Sending SMS from a Mac needs an iPhone with Text Message Forwarding on.';
const NOT_DELIVERED = 'Messages couldn’t deliver this over iMessage. Check the address in Messages on this Mac.';
const SMS_FAILED = 'Messages couldn’t send this as a text (RCS or SMS). On your iPhone, turn on Text Message Forwarding for this Mac.';
const SMS_SERVICE = /^(SMS|RCS)$/i;
const SMS_CHAT = /^(SMS|RCS);-;/i;
const NO_HISTORY = 'Atelier couldn’t read this Mac’s texts, so it sent iMessage without checking. If it shows Not Delivered, give Google Chrome Full Disk Access, then quit and reopen Chrome.';
const RETRIED = 'iMessage couldn’t deliver it, so it went again as a carrier text.';
// The errors a person can fix, in words that say how.
function friendlyError(raw) {
  const s = String(raw || '');
  if (/authorization denied|unable to open database|operation not permitted|not authorized to access/i.test(s)) {
    return 'Chrome can’t read Messages yet. Give Google Chrome Full Disk Access in System Settings → Privacy & Security, then quit and reopen Chrome.';
  }
  if (/-1743|not allowed to send Apple events|Not authorized to send Apple events/i.test(s)) {
    return 'Chrome can’t control Messages yet. Allow it in System Settings → Privacy & Security → Automation, then try again.';
  }
  return s.trim().slice(0, 300) || 'The Messages helper failed.';
}

// ── macOS side ──
function run(path, args) {
  const task = $.NSTask.alloc.init;
  task.launchPath = path;
  task.arguments = args;
  const out = $.NSPipe.pipe, err = $.NSPipe.pipe;
  task.standardOutput = out;
  task.standardError = err;
  task.standardInput = $.NSFileHandle.fileHandleWithNullDevice; // never Chrome's pipe
  task.launch;
  const data = out.fileHandleForReading.readDataToEndOfFile;
  const errData = err.fileHandleForReading.readDataToEndOfFile;
  task.waitUntilExit;
  const str = (d) => $.NSString.alloc.initWithDataEncoding(d, $.NSUTF8StringEncoding).js || '';
  return { code: task.terminationStatus, out: str(data), err: str(errData) };
}
function query(sql) {
  const db = `${$.NSHomeDirectory().js}/Library/Messages/chat.db`;
  const r = run('/usr/bin/sqlite3', ['-readonly', '-json', db, sql]);
  if (r.code !== 0) throw new Error(friendlyError(r.err || r.out));
  return r.out.trim() ? JSON.parse(r.out) : [];
}
function handle(msg) {
  const op = String(msg?.op || '');
  if (op === 'ping') return { version: HOST_VERSION };
  if (op === 'recent') return { conversations: shapeRecent(query(recentSql(msg.limit))) };
  if (op === 'read') {
    const chat = String(msg.chat || '').trim();
    if (!chat) throw new Error('Pass chat: a chat id from messages_recent, or a phone number or email.');
    const rows = query(readSql(chat, msg.limit));
    if (!rows.length) throw new Error(`No Messages conversation matches ${cut(chat, 80)}.`);
    return { chat: rows[0].chat || chat, messages: shapeRead(rows) };
  }
  if (op === 'send') {
    const to = String(msg.to || '').trim().slice(0, LIMITS.chat), text = String(msg.text ?? '');
    if (!to || !text.trim()) throw new Error('Pass to and text.');
    if (text.length > LIMITS.text) throw new Error(`That text is over ${LIMITS.text} characters.`);
    // A phone number or an email goes to the conversation it already has, when chat.db can say which. That lookup is
    // best effort (1.0.1, v114): without Full Disk Access it failed and took every send with it, though sending only
    // needs Automation. The text then goes to the address as given, as it does when no conversation matches.
    // A carrier text (green), by the services in order: the next one is tried only when Messages refuses the script (no
    // such account), so nothing was sent. A send it took and then failed is final (1.0.6, v122). Null: no account took it.
    const carrier = (order, watches) => {
      for (let i = 0; i < order.length; i++) {
        const since = appleNs(Date.now() - 1000);
        const s = run('/usr/bin/osascript', CARRIER_ARGS[order[i]](text, number));
        if (s.code !== 0) { if (/-1743|Apple events/i.test(s.err || s.out)) throw new Error(friendlyError(s.err || s.out)); continue; }
        const o = outcome(number, since, watches[i] ?? 0);
        if (o === 'failed') throw new Error(sendFailed(lastError));
        return { via: order[i], delivery: o === 'sent' ? 'confirmed' : 'unconfirmed' };
      }
      return null;
    };
    let dest = to, service = '', history = 'none', number = '';
    const phone = phoneOf(to, to);
    if (!to.includes(';') || phone) {
      try {
        const row = query(chatForSql(phone || to))[0] || {};
        if (!to.includes(';')) dest = row.chat || to;
        service = String(row.service || '');
        history = SMS_SERVICE.test(service) ? service.toUpperCase() : service ? 'iMessage' : 'none';
      } catch { history = 'unreadable'; /* chat.db can't be read */ }
    }
    number = phoneOf(to, dest);
    // SMS straight away, never an iMessage try first, when (1.0.4, v117) the owner asked for SMS (an SMS or RCS chat id:
    // "SMS;-;+15085550142"), or (1.0.3, v116) the last text with this number that got through was SMS. Messages would
    // otherwise try iMessage, which fails later as "Not Delivered", and catching that in time is not a sure thing.
    // 1.0.5 (v121): by the service that last worked. With no carrier history RCS goes first: it is what reached the
    // owner's Android number, and plain SMS did not.
    if (number && (SMS_CHAT.test(to) || history === 'SMS' || history === 'RCS')) {
      const got = carrier(history === 'SMS' ? ['SMS', 'RCS'] : ['RCS', 'SMS'], [WATCH.first, WATCH.again]);
      if (!got) throw new Error(SMS_FAILED);
      return { sent: true, to: number, via: got.via, history, delivery: got.delivery };
    }
    const since = appleNs(Date.now() - 2000);
    const r = run('/usr/bin/osascript', sendArgs(text, dest));
    if (r.code !== 0) throw new Error(friendlyError(r.err || r.out));
    const o = outcome(dest, since, WATCH.first);
    // What the helper saw goes back with the answer (1.0.4, v117): a blue "Not Delivered" text could not be told apart
    // from a missing Full Disk Access, an iMessage-only history, or a failure that came too late.
    if (o !== 'failed') {
      const done = { sent: true, to: dest, via: /^(SMS|RCS);/i.test(dest) ? 'SMS' : 'iMessage', history, delivery: o === 'sent' ? 'confirmed' : 'unconfirmed' };
      if (number && history === 'unreadable') done.note = NO_HISTORY;
      return done;
    }
    // iMessage could not deliver it: the same text to the same number, once, as SMS (what the script always meant to do).
    if (!number) throw new Error(NOT_DELIVERED);
    const got = carrier(['RCS', 'SMS'], [WATCH.again, 0]);
    if (!got) throw new Error(NO_SMS);
    return { sent: true, to: number, via: got.via, history, delivery: got.delivery, note: RETRIED };
  }
  throw new Error('Unknown Messages action.');
}
function readFrame(stdin) {
  const head = b64Decode(stdin.readDataOfLength(4).base64EncodedStringWithOptions(0).js);
  if (head.length < 4) return null;
  const body = stdin.readDataOfLength(frameLength(head));
  return JSON.parse($.NSString.alloc.initWithDataEncoding(body, $.NSUTF8StringEncoding).js);
}
function writeFrame(stdout, obj) {
  const data = $.NSString.alloc.initWithUTF8String(JSON.stringify(obj)).dataUsingEncoding($.NSUTF8StringEncoding);
  const head = $.NSData.alloc.initWithBase64EncodedStringOptions(b64Encode(lengthBytes(data.length)), 0);
  stdout.writeData(head);
  stdout.writeData(data);
}
function main() {
  ObjC.import('Foundation');
  const stdin = $.NSFileHandle.fileHandleWithStandardInput, stdout = $.NSFileHandle.fileHandleWithStandardOutput;
  let reply;
  try {
    const msg = readFrame(stdin);
    reply = msg ? { ok: true, result: handle(msg) } : { ok: false, error: 'No request.' };
  } catch (err) { reply = { ok: false, error: friendlyError(err?.message || err) }; }
  writeFrame(stdout, reply);
}
if (typeof ObjC !== 'undefined') main();
