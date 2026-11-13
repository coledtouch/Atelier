// v114 review of the static pages and stylesheets (ui #0 to #13, files-v113 #13).
// The legal pages are public statements in the owner's name, so every sentence added here is held to the code it rests
// on: the approval settings (public/context.js, Settings → Connections), the extension's own Allow window and its
// saved-password sign-in (extension/), Messages on a Mac (public/mac/) and attached files (public/files.js). A change to
// one of those facts fails here until the page says the new thing. The stylesheet fixes are checked from the CSS text:
// the contrast ratios are recomputed from the tokens, the rest are pinned rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { approvesAll, browseUnasked, readUnasked, standingOn, APPROVAL_KEYS, buildHistory } from '../public/context.js';
import { MAX_FILES, FILES_CHARS } from '../public/files.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const [PRIVACY, TOS, INDEX, APP_CSS, STUDIO_CSS, LEGAL_CSS, APP, EXT, CONFIRM, HOST, RELAY, MERGE] = ['public/privacy.html', 'public/tos.html', 'public/index.html',
  'public/app.css', 'public/studio.css', 'public/legal.css', 'public/app.js', 'extension/background.js', 'extension/confirm.html',
  'public/mac/atelier-messages-host.js', 'src/relay.js', 'public/sync-merge.js'].map(read);
// A page's own text: tags dropped (a link's closing tag leaves a space before the bracket after it: "(see Approvals )").
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const item = (re) => text(re.exec(PRIVACY)?.[1] || '');
const P = text(PRIVACY), T = text(TOS);
// src/relay.js imports cloudflare:workers, so its one pure function is lifted from the source.
const relayNeedsApproval = new Function(`${/export (function relayNeedsApproval\([\s\S]*?\n\})/.exec(RELAY)[1]}; return relayNeedsApproval;`)();

// ── ui #0: approvals are the default, and the owner can turn them off ──
test('privacy #approvals says what asks by default and names the three owner settings as context.js runs them', () => {
  const a = item(/<li id="approvals">([\s\S]*?)<\/li>/);
  for (const words of ['Approvals — this covers connected accounts, the browser and Messages.', 'By default, Atelier asks before it sends or changes anything there.',
    'An approval card shows what it will send, post, pay, change, click or type.', 'It acts only after you approve the card.',
    'Some reads ask too, for example after Atelier has read a web page.', 'The owner can turn these checks off in Settings → Connections.',
    '“Approve everything” lets every step run without a card, sending and paying included.',
    '“Read accounts unasked” lets Atelier read connected accounts without a card.',
    '“Open pages unasked” lets it open and read pages in the browser without a card.',
    'All three are off until the owner turns them on.', 'They then apply on every device where the owner is signed in.',
    'None of them applies to a request that began from a link or a share.']) assert.ok(a.includes(words), words);
  // "All three": the three switches, and the buttons carry the names the page quotes
  assert.deepEqual(APPROVAL_KEYS, ['approveAll', 'browserUnasked', 'accountsUnasked'], 'a setting was added or removed: update #approvals');
  for (const label of ['Approve everything', 'Read accounts unasked', 'Open pages unasked']) assert.ok(APP.includes(`>${label}</button>`), `Settings → Connections has a “${label}” button`);
  // Approve everything: every step. Read accounts unasked: a read outside the browser. Open pages unasked: a look in the
  // browser. The last two never cover a write.
  assert.equal(approvesAll({ on: true }), true);
  assert.equal(approvesAll({ on: false }), false);
  assert.equal(readUnasked({ service: 'gmail', write: false }, { on: true }), true);
  assert.equal(readUnasked({ service: 'messages', write: false }, { on: true }), true, 'reading texts is an account read');
  assert.equal(readUnasked({ service: 'gmail', write: true }, { on: true }), false);
  assert.equal(readUnasked({ service: 'browser', write: false }, { on: true }), false);
  assert.equal(browseUnasked({ service: 'browser', write: false }, { on: true }), true);
  assert.equal(browseUnasked({ service: 'browser', write: true }, { on: true }), false);
  // "None of them applies to a request that began from a link or a share": the switches say so, and such a turn never
  // reaches the accounts agent in the first place
  assert.equal(approvesAll({ on: true, untrusted: true }), false);
  assert.equal(readUnasked({ service: 'gmail', write: false }, { on: true, untrusted: true }), false);
  assert.equal(browseUnasked({ service: 'browser', write: false }, { on: true, untrusted: true }), false);
  assert.match(APP, /const standing = \{ untrusted: Boolean\(e\.untrusted\) \};/);
  assert.match(APP, /agent: agent && !e\.untrusted,/);
  // off until turned on, the owner's only (a passcode), and the synced profile carries them to his other devices
  assert.equal(standingOn(undefined, undefined), false);
  assert.equal(standingOn(true, false), true, 'the profile’s value wins on every device');
  assert.match(APP, /\nconst approvalOn = \(key\) => Boolean\(S\.settings\.passcode\) && standingOn\(ME\?\.approvals\?\.\[key\], S\.settings\[key\]\);\n/);
  assert.doesNotMatch(/\nconst DEFAULT_SETTINGS = \{([\s\S]*?)\n\};/.exec(APP)[1], /approveAll|browserUnasked|accountsUnasked/, 'no switch starts on');
  assert.match(APP, /ME\.approvals = \{ \.\.\.\(ME\.approvals \|\| \{\}\), \[key\]: on \}; saveMe\(\);/);
});

test('no page promises an approval in every case any more: each one is stated as the default, with the way it is turned off', () => {
  for (const words of ['By default, opening a page happens only after you approve it.',
    'By default, saving drafts and sending need your approval.',
    'It does so when you tap Send to Canva or approve it on an approval card. With “Approve everything” on, Atelier can do so without a card (see Approvals ).',
    'With “Approve everything” on, the steps that need approval run without asking each time (see Approvals ).',
    'By default, actions that send, post, pay or change something require your explicit approval. The owner can turn that requirement off (see Approvals ).'])
    assert.ok(P.includes(words), `privacy: ${words}`);
  for (const words of ['By default, Atelier shows you each one on an approval card first. It then happens only after you approve it.',
    'The owner can turn these approvals off in Settings → Connections. Such actions then run without a card. The Privacy Policy describes each setting.',
    'You are responsible for reviewing what you approve.']) assert.ok(T.includes(words), `terms: ${words}`);
  // the sentences as they stood through v113, with nothing in front: gone from both pages
  assert.doesNotMatch(P, /(?<!By default, )[Oo]pening a page happens only after you approve it/);
  assert.doesNotMatch(P, /(?<!By default, )[Aa]ctions that send, post, pay or change something require your explicit approval/);
  assert.doesNotMatch(P, /(?<!By default, )[Ss]aving drafts and sending need your approval/);
  assert.doesNotMatch(P, /(?<!With that setting off, )Atelier never sends email on its own/);
  assert.doesNotMatch(T, /(?<!By default, )Atelier shows you each one on an approval card first/);
  // every link to the Approvals item lands on it: four in the privacy page's own text, one from the terms
  assert.equal(PRIVACY.match(/<li id="approvals">/g)?.length, 1);
  assert.ok((PRIVACY.match(/<a href="#approvals">Approvals<\/a>/g) || []).length >= 4);
  assert.match(TOS, /The <a href="\/privacy#approvals">Privacy Policy<\/a> describes each setting\./);
});

test('every in-page link on the legal pages lands on an id, and the terms’ links into the privacy page do too', () => {
  const ids = (html) => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const privacyIds = ids(PRIVACY), tosIds = ids(TOS);
  assert.equal(privacyIds.size, [...PRIVACY.matchAll(/\sid="([^"]+)"/g)].length, 'no id twice');
  for (const [, id] of PRIVACY.matchAll(/href="#([^"]+)"/g)) assert.ok(privacyIds.has(id), `privacy #${id}`);
  for (const [, id] of TOS.matchAll(/href="#([^"]+)"/g)) assert.ok(tosIds.has(id), `terms #${id}`);
  for (const [, id] of TOS.matchAll(/href="\/privacy#([^"]+)"/g)) assert.ok(privacyIds.has(id), `terms → privacy #${id}`);
  for (const id of ['files', 'messages', 'approvals']) assert.ok(privacyIds.has(id), `the v114 items can be linked to: #${id}`);
});

// ── ui #0: the Browser extension item ──
test('the Browser extension item: its Allow window, the box that turns it off, and sign-in with a password Chrome saved', () => {
  const b = item(/<li><b>Browser extension<\/b>([\s\S]*?)<\/li>/);
  for (const words of ['By default, opening a page happens only after you approve it. So does loading one by its address to read it. So does every click and typing action.',
    'The extension asks again on the computer before a click or typing.', 'The server and the extension both check that approval.',
    'The owner can turn the approval cards off (see Approvals ).', 'The extension’s own window has a “Don’t ask again on this computer” box.',
    'Ticking it with Allow stops that window on that computer.', '“Ask on this computer” in Atelier’s Settings on that computer brings it back.',
    'The extension never enters passwords or payment details.', 'For a sign-in, it can have Chrome fill the password Chrome saved for that site.',
    'By default that asks first, like a click.', 'The extension then submits the form.', 'About the password, it learns only whether the field was filled.',
    'Atelier never receives the password.']) assert.ok(b.includes(words), words);
  // the server's side of "both check": what the relay refuses without the app's approval flag
  for (const [cmd, args] of [['open', {}], ['click', {}], ['type', {}], ['signin', {}], ['read', { url: 'https://example.com/' }]]) assert.equal(relayNeedsApproval(cmd, args), true, cmd);
  assert.equal(relayNeedsApproval('read', { tabId: 3 }), false, 'reading a tab that is already open needs none');
  assert.match(EXT, /async open\(\{ url, active = false \}, ctx = \{\}\) \{\s*if \(ctx\.approved !== true\) throw new Error\(NEEDS_APPROVAL\);/, 'and the extension’s');
  // the Allow window: before a click, typing or a sign-in, unless its own box was ticked beside an Allow
  for (const action of ['click', 'type', 'signin']) assert.match(EXT, new RegExp(`const ok = await confirmFirst\\('${action}', `), `${action} asks on the computer`);
  assert.match(CONFIRM, /<input type="checkbox" id="always" \/><span>Don’t ask again on this computer\. /);
  assert.match(EXT, /if \(m\.answer === 'allow' && m\.always === true\) \{ try \{ chrome\.storage\.local\.set\(\{ noAsk: true \}\)/, 'only with an Allow, only from that window');
  assert.match(EXT, /if \(await asksNothing\(\)\) \{/, 'ticked: no window');
  // …and the way back: a button in the Atelier tab on that computer, never a relay command
  assert.ok(APP.includes('>Ask on this computer</button>'));
  assert.match(APP, /await extLocal\('askAgain', /, 'extLocal: this browser’s own extension');
  assert.match(EXT, /COMMANDS\.askAgain = async \(\) => \{\s*await chrome\.storage\.local\.set\(\{ noAsk: false \}\);/);
  assert.doesNotMatch(/const REMOTE_COMMANDS = \[([^\]]*)\]/.exec(EXT)[1], /askAgain|pair|status/);
  // typing never goes into a password or payment field
  assert.match(EXT, /if \(op === 'type' && sensitive\) return \{ error: 'Refused: Atelier never types into password, payment or ID fields\./);
  // sign-in: a write in the app (its card first), Chrome's password manager fills, and the page script touches the
  // password field's value once, to say filled or not. Every answer holds a note and the tab's title and address.
  assert.match(APP, /\n {2}\['browser_signin', 'Sign in with saved password', true, /);
  const login = /\nfunction pageLogin\(op, which\) \{\n([\s\S]*?)\n\}\n/.exec(EXT)?.[1] || '';
  assert.match(login, /if \(op === 'filled'\) return \{ filled: String\(q\('pw'\)\?\.value \|\| ''\)\.length > 0 \};/);
  assert.equal((login.match(/q\('pw'\)\?\.value/g) || []).length, 1, 'the one read of the field’s value: is it empty');
  assert.doesNotMatch(login, /\bpw\.value\b/, 'the field found is never read');
  assert.match(EXT, /if \(!\(await filled\(\)\)\) throw new Error\(NO_SAVED\);/, 'nothing filled: nothing submitted');
  const signin = /\n {2}async signin\(args, ctx = \{\}\) \{\n([\s\S]*?)\n {2}\},\n/.exec(EXT)?.[1] || '';
  const answers = signin.split('\n').filter((l) => l.includes('signedIn:'));
  assert.ok(answers.length >= 1, 'the sign-in command’s answers');
  // 1.4.2 (v119): and the account it signed in as (the user name field, never the password).
  for (const a of answers) assert.match(a, /return \{ signedIn: '(?:submitted|unclear)', \.\.\.as, note: (?:FILLED|`\$\{FILLED\} [^`$]*`)(?:, now)? \};$/, `a sign-in answers with a note and the tab, nothing from the form: ${a.trim()}`);
  assert.match(signin, /const as = used \? \{ account: used \} : \{\};/);
  assert.match(signin, /const now = \{ title: t\.title, url: t\.url \};/);
  assert.match(EXT, /\nconst FILLED = 'Chrome filled the password it had saved\. Atelier never saw it\.';/);
  // the terms say the same in short
  for (const words of ['Atelier never enters passwords or payment details in your browser.', 'For a sign-in, it can have Chrome fill a password Chrome already saved.', 'Atelier never receives that password.'])
    assert.ok(T.includes(words), `terms: ${words}`);
});

// ── ui #1: Messages on a Mac ──
test('Messages on a Mac is disclosed as the helper, the extension and the agent run it; the terms name it; testers have none of it', () => {
  const m = item(/<li id="messages">([\s\S]*?)<\/li>/);
  for (const words of ['Messages on a Mac — the owner can install an optional helper on a Mac.', 'Its setup command is in Settings → Connections.',
    'Atelier can then read texts in that Mac’s Messages app when asked.', 'That covers iMessage and SMS conversations: who is in them, their messages and the times.',
    'The helper opens the Messages database read-only.', 'The texts Atelier reads go to the AI provider of the model chosen for that request.',
    'Answers that quote a text, and texts Atelier sent, are saved in the owner’s synced threads.', 'So are web addresses found in the texts it read.',
    'Atelier can also send a text through Messages on that Mac.',
    'By default it asks first on an approval card. The extension then asks again on the Mac.',
    'The settings under Approvals and “Don’t ask again on this computer” can remove those steps.']) assert.ok(m.includes(words), words);
  // the helper: Messages' own database, opened read-only; a conversation's people, words and times
  assert.match(HOST, /const db = `\$\{\$\.NSHomeDirectory\(\)\.js\}\/Library\/Messages\/chat\.db`;\s*const r = run\('\/usr\/bin\/sqlite3', \['-readonly', '-json', db, sql\]\);/);
  assert.match(HOST, /return rows\.map\(\(r\) => \(\{ chat: r\.chat, name: r\.name \|\| '', people: r\.people \|\| r\.id \|\| '', service: r\.service \|\| '', last: \{ at: appleDate\(r\.d\), fromMe: r\.fromMe === 1, text: bodyOf\(r\) \} \}\)\);/);
  assert.match(HOST, /return rows\.slice\(\)\.reverse\(\)\.map\(\(r\) => \(\{ at: appleDate\(r\.d\), from: r\.fromMe === 1 \? 'me' : r\.sender \|\| 'them', text: bodyOf\(r\) \}\)\);/);
  // the setup command is copied from Settings → Connections
  assert.match(APP, /const cmd = `curl -fsSL \$\{location\.origin\}\/mac\/install-messages\.sh \| sh -s \$\{id\}`;/);
  // sending: a write in the app (its card), refused by the relay and by the extension without the app's approval flag,
  // then the extension's own window; reading needs none of that
  assert.match(APP, /\n {2}\['messages_send', 'Send a text', true, /);
  for (const read of ['messages_recent', 'messages_read']) assert.match(APP, new RegExp(`\\n {2}\\['${read}', '[^']+', false, `), `${read} is a read`);
  assert.equal(relayNeedsApproval('messages', { op: 'send' }), true);
  assert.equal(relayNeedsApproval('messages', { op: 'read' }), false);
  assert.match(EXT, /if \(op === 'send'\) \{\s*if \(ctx\.approved !== true\) throw new Error\(SEND_NEEDS_APPROVAL\);/);
  assert.match(EXT, /await confirmFirst\('sms', \{ to, text \}, ctx\.via\);\s*return messagesHost\(\{ op, to, text \}\);/);
  // what the thread keeps: a step's arguments (a sent text's words and who it went to) and the web addresses in what a
  // tool returned (e.toolUrls), never the result itself
  const step = /\n {6}const step = \{ id: uid\(\), name: call\.function\.name, ([^}]*)\};/.exec(APP)?.[1] || '';
  assert.match(step, /\bargs, write: Boolean\(def\?\.\['x-write'\]\)/, 'a step keeps its arguments');
  assert.doesNotMatch(step, /result/, 'and no result');
  assert.match(APP, /messages\.push\(\{ role: 'tool', tool_call_id: call\.id, content: JSON\.stringify\(result\.ok \? result\.result : \{ error: result\.error \}\)/, 'the result goes to the model, in this run’s messages');
  assert.match(APP, /noteToolUrls\(e, result\.result\);/);
  assert.match(APP, /\n {2}if \(have\.size\) e\.toolUrls = \[\.\.\.have\];/);
  // the owner's only: a tester has no tools at all, and no browser
  assert.match(APP, /\nconst agentTools = \(browser = liveBrowser\(\)\) => \(S\.tester \? \[\] : /);
  assert.match(APP, /\nconst browserAvailable = \(\) => !S\.tester && \(EXT\.ready \|\| REMOTE\.online\);/);
  assert.ok(T.includes('It can also work with GitHub, Stripe, Cloudflare and Railway, and with your desktop browser. On a Mac, it can also read and send texts through the Messages app.'));
  assert.ok(T.includes('Testers cannot connect accounts (such as Google, Canva or Slack) or use browser control or Messages.'));
});

// ── ui #2, files-v113 #13: attached files ──
test('attached files are disclosed as files.js reads them and context.js sends them', () => {
  const f = item(/<li id="files">([\s\S]*?)<\/li>/);
  for (const words of ['Attached files — you can attach documents, such as PDF, Word, Excel, PowerPoint and text files.',
    'Atelier reads each one into text in your browser.', 'The file itself is never uploaded.',
    'The text is sent with your message. It goes to the AI provider of the model chosen for that request (see Sharing ).',
    'One message can carry up to 5 files and 250,000 characters of their text.', 'The text is saved in the thread with your message.',
    'A follow-up in that thread can send the text again, as part of the earlier turns.',
    'Some PDFs are scans or mostly pictures. Atelier then also sends their first pages as images.',
    'The thread follows the storage and sync rules in section 6.', 'A file’s text over about 32 KB counts as a long text there.']) assert.ok(f.includes(words), words);
  assert.ok(P.includes('Prompts and conversations — the questions, instructions, text and images you enter, and the files you attach.'));
  assert.equal(MAX_FILES, 5, 'update "up to 5 files"');
  assert.equal(FILES_CHARS, 250_000, 'update "250,000 characters of their text"');
  // the text rides in the turn, the turn is kept in the thread, and a follow-up replays it with its files
  assert.match(APP, /\.\.\.\(docs\.length && \{ files: /, 'the entry keeps the files’ text');
  const turn = { id: 'a', kind: 'ask', prompt: 'What does it say?', text: 'It says hello.', createdAt: Date.UTC(2026, 10, 12), files: [{ name: 'note.txt', kind: 'text', text: 'WORDS ONLY THE FILE HOLDS' }] };
  const replay = buildHistory([turn]);
  assert.ok(replay.some((msg) => msg.role === 'user' && String(msg.content).includes('WORDS ONLY THE FILE HOLDS')), 'a follow-up sends the file’s text again');
  // a scan or a picture-heavy PDF: its first pages as images, beside what text there is
  assert.match(APP, /`Pages 1 to \$\{shot\.pages\} are attached as images\$\{shot\.two \? ', two to an image' : ''\}\.`/);
  assert.match(APP, /made\.push\(\{ src: await shrinkDataUrl\(c\.toDataURL\('image\/jpeg', 0\.85\), max, max\), doc: doc\.id \}\);/);
  // "over about 32 KB counts as a long text": the size past which a string syncs as a blob of its own
  assert.match(MERGE, /inline: 32768, \/\/ strings longer than this/);
  // testers attach files too, so their list points at the item
  const testers = /<h3 id="testers">([\s\S]*?)<\/ul>/.exec(PRIVACY)?.[1] || '';
  assert.match(testers, /<li><b>Attached files<\/b> — read into text in your browser and sent with your message\. See <a href="#files">Attached files<\/a> above\. The text syncs with its thread only if you enabled private thread sync\.<\/li>/);
  assert.ok(testers.indexOf('<b>Video files</b>') < testers.indexOf('<b>Attached files</b>'), 'next to Video files');
});

// ── ui #7, ui #12: index.html ──
test('Settings → Connections: the hint under the list holds whether approvals are on or off', () => {
  assert.match(INDEX, /<ul class="conn-list" id="connList"><\/ul>\s*<p class="hint">Connect an account and Atelier can work in it\. It asks before it sends or changes anything, unless you turn that off under Approvals\.<\/p>/);
  assert.doesNotMatch(INDEX, /It asks you before it sends or changes anything\./, 'the line that was false with Approve everything on');
  // the row it points at, and what that row says once approvals are off
  assert.match(APP, /connRow\(\{ key: 'approvals', on: true, name: 'Approvals', state: approveAll\(\) \? 'Nothing asks' : 'Writes ask',/);
});

test('every segmented control in index.html is a named radio group, and every aria-labelledby points at an id on the page', () => {
  const ids = new Set([...INDEX.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const segs = [...INDEX.matchAll(/<div class="seg"[^>]*>/g)].map((m) => m[0]);
  assert.ok(segs.length >= 6, `${segs.length} segmented controls found`);
  for (const tag of segs) {
    assert.match(tag, / role="radiogroup"/, tag);
    assert.match(tag, / aria-labelledby="[^"]+"| aria-label="[^"]+"/, `${tag} has a name`);
  }
  for (const [, list] of INDEX.matchAll(/\saria-labelledby="([^"]+)"/g)) for (const id of list.split(/\s+/)) assert.ok(ids.has(id), `aria-labelledby="${id}" has its element`);
  // the two that had no name (v114): each takes its section's heading
  assert.match(INDEX, /<h4 id="themeLabel">Appearance<\/h4>\s*<div class="seg" id="themeSeg" role="radiogroup" aria-labelledby="themeLabel">/);
  assert.match(INDEX, /<h4 id="lookupLabel">Look up<\/h4>\s*<p class="hint"[^>]*>[^<]*<\/p>\s*<div class="seg" id="lookupSeg" role="radiogroup" aria-labelledby="lookupLabel">/);
  // Settings sorts its sections by each heading's text (app.js settingsGroups): an id on the heading leaves that alone
  assert.match(APP, /settingsGroups\[\$\('h4', section\)\?\.textContent\]/);
});

// ── the stylesheets ──
// WCAG 2 contrast, from the tokens as the stylesheets hold them.
const hexRgb = (h) => { const m = /^#([0-9a-f]{6})$/i.exec(h.trim()); assert.ok(m, `a 6-digit hex colour: ${h}`); return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)); };
const rgbaOf = (s) => { const m = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(s.trim()); assert.ok(m, `rgba(): ${s}`); return m.slice(1).map(Number); };
const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const blend = (top, under, alpha) => top.map((v, i) => v * alpha + under[i] * (1 - alpha)); // top at alpha over an opaque colour
const vars = (block) => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const AA = 4.5; // small text
const MODES = ['c-ask', 'c-code', 'c-image', 'c-video', 'c-ideas', 'c-build'];
const DARK = vars(/^:root \{([\s\S]*?)\n\}/m.exec(APP_CSS)[1]);
const PAPER_AUTO = vars(/@media \(prefers-color-scheme: light\) \{\n {2}:root:not\(\[data-theme='dark'\]\) \{([\s\S]*?)\n {2}\}\n\}/.exec(APP_CSS)[1]);
const PAPER_SET = vars(/\n:root\[data-theme='light'\] \{([\s\S]*?)\n\}/.exec(APP_CSS)[1]);
// The share of its own colour behind a selected tab's label (.mode-ink) and a selected chip's (.chip.on).
const tintOf = (selector) => Number(new RegExp(`\\n${selector.replace(/\./g, '\\.')} \\{[^}]*background: color-mix\\(in srgb, var\\(--accent\\) (\\d+)%, transparent\\);`).exec(APP_CSS)?.[1]) / 100;

test('Paper theme: small text in --ink-3 and in each mode colour reads at 4.5:1 on every surface it sits on', () => {
  assert.deepEqual(PAPER_SET, PAPER_AUTO, 'the two Paper blocks (system light, and Paper chosen by hand) hold the same values');
  const t = PAPER_SET, bg = hexRgb(t.bg), bg2 = hexRgb(t['bg-2']), bg3 = hexRgb(t['bg-3']);
  const [sr, sg, sb, sa] = rgbaOf(t['surface-2']), [pr, pg, pb, pa] = rgbaOf(t.surface);
  const tab = tintOf('.mode-ink'), chip = tintOf('.chip.on');
  assert.ok(tab > 0 && tab <= 0.2 && chip > 0 && chip <= 0.2, `the selected tints were read from app.css (${tab}, ${chip})`);
  const fails = [];
  const check = (name, colour, under, where) => { const r = ratio(colour, under); if (r < AA) fails.push(`--${name} on ${where}: ${r.toFixed(2)}:1`); };
  for (const name of ['ink-2', 'ink-3', ...MODES]) {
    const c = hexRgb(t[name]);
    check(name, c, bg, '--bg'); check(name, c, bg2, '--bg-2 (sheets, drawers, the composer)'); check(name, c, bg3, '--bg-3 (the Look up card)');
  }
  // hints inside a panel, and counts on a chip: --surface and --surface-2 over a sheet
  const ink3 = hexRgb(t['ink-3']);
  check('ink-3', ink3, blend([pr, pg, pb], bg2, pa), '--surface over --bg-2');
  check('ink-3', ink3, blend([sr, sg, sb], bg2, sa), '--surface-2 over --bg-2');
  for (const name of MODES) {
    const c = hexRgb(t[name]);
    check(name, c, blend(c, bg2, tab), `its own ${tab * 100}% tint over --bg-2 (a selected tab’s label)`);
    check(name, c, blend(c, bg2, chip), `its own ${chip * 100}% tint over --bg-2 (a selected chip)`);
    check('on-accent', hexRgb(t['on-accent']), c, `--${name} (a filled button)`);
  }
  assert.deepEqual(fails, [], `under ${AA}:1 in the Paper theme:\n${fails.join('\n')}`);
  // the two greys stay two greys
  assert.ok(lum(ink3) > lum(hexRgb(t['ink-2'])) && ratio(ink3, hexRgb(t['ink-2'])) > 1.1, '--ink-3 is still the quieter grey');
});

test('dark theme: the same text tokens pass on its three surfaces (nothing here changed in v114)', () => {
  const fails = [];
  for (const name of ['ink-2', 'ink-3', ...MODES]) for (const s of ['bg', 'bg-2', 'bg-3']) { const r = ratio(hexRgb(DARK[name]), hexRgb(DARK[s])); if (r < AA) fails.push(`--${name} on --${s}: ${r.toFixed(2)}:1`); }
  assert.deepEqual(fails, []);
});

test('legal pages: the effective date and the links read at 4.5:1 in both themes, in the app’s own colours', () => {
  const dark = vars(/^:root \{([^}]*)\}/m.exec(LEGAL_CSS)[1]), light = vars(/:root:not\(\[data-theme='dark'\]\) \{([^}]*)\}/.exec(LEGAL_CSS)[1]);
  // the same tokens as app.css, by value: --accent is its --c-ask, --surface its --bg-2
  for (const [mine, theirs] of [['bg', 'bg'], ['surface', 'bg-2'], ['ink', 'ink'], ['ink-2', 'ink-2'], ['ink-3', 'ink-3'], ['accent', 'c-ask']]) {
    assert.equal(dark[mine], DARK[theirs], `legal.css dark --${mine} is app.css --${theirs}`);
    assert.equal(light[mine], PAPER_SET[theirs], `legal.css light --${mine} is app.css Paper --${theirs}`);
  }
  // .eyebrow (the effective date, 11px) is the only text in --ink-3; links sit on the page and inside a .box (--surface)
  assert.match(LEGAL_CSS, /\n\.eyebrow \{[^}]*font: 500 11px\/1 [^}]*color: var\(--ink-3\); \}/);
  assert.match(LEGAL_CSS, /\na \{ color: var\(--accent\);/);
  assert.match(LEGAL_CSS, /\n\.box \{[^}]*background: var\(--surface\);/);
  for (const [name, t] of [['dark', dark], ['light', light]]) {
    const on = (c, s) => ratio(hexRgb(t[c]), hexRgb(t[s]));
    assert.ok(on('ink-3', 'bg') >= AA, `${name}: the effective date, ${on('ink-3', 'bg').toFixed(2)}:1`);
    assert.ok(on('accent', 'bg') >= AA, `${name}: a link on the page, ${on('accent', 'bg').toFixed(2)}:1`);
    assert.ok(on('accent', 'surface') >= AA, `${name}: a link in a box, ${on('accent', 'surface').toFixed(2)}:1`);
    assert.ok(on('ink-2', 'bg') >= AA && on('ink', 'surface') >= AA);
  }
  for (const page of [PRIVACY, TOS]) assert.match(page, /<p class="eyebrow">Effective [A-Z][a-z]+ \d{1,2}, \d{4}<\/p>/, 'the date is the .eyebrow');
});

// ── ui #3: Settings → Connections rows with several buttons ──
test('a connection row’s button group takes a line of its own under the status, at every width', () => {
  // one button stays in the action column; a group (Approvals: two, Browser: up to three) goes under the info, on the
  // first free row, across the info and action columns
  assert.match(APP_CSS, /\n\.conn \{ display: grid; grid-template-columns: 8px 96px minmax\(0, 1fr\) auto; /);
  assert.match(APP_CSS, /\n\.conn > \.chip \{ grid-area: 1 \/ 4; justify-self: end; \}\n/);
  assert.match(APP_CSS, /\n\.conn > \.conn-acts \{ grid-area: auto \/ 3 \/ auto \/ -1; justify-self: start; \}\n/);
  assert.match(APP_CSS, /\n\.conn-acts \{ display: flex; flex-wrap: wrap; gap: 6px; \}/);
  assert.doesNotMatch(APP_CSS, /\.conn > \.conn-acts[^{]*\{[^}]*grid-area: 1 \/ 4/, 'never the action column again: it took the status text’s width');
  // the rows that hold them: info in row 1 column 3, account chips in row 2, so a group lands on row 2 or 3
  assert.match(APP_CSS, /\n\.conn-info \{ grid-area: 1 \/ 3; min-width: 0; /);
  assert.match(APP_CSS, /\n\.conn \.accts \{ grid-area: 2 \/ 3 \/ auto \/ -1; /);
  // phones keep their own stack (higher specificity): name, status, accounts, then the buttons
  const phone = STUDIO_CSS.slice(STUDIO_CSS.indexOf('\n@media (max-width: 640px) {'), STUDIO_CSS.indexOf('\n@media (max-width: 480px) {'));
  assert.match(phone, /\n {2}#connList \.conn > :is\(\.chip, \.conn-acts\) \{ grid-area: 4 \/ 2 \/ auto \/ -1; justify-self: start; margin-top: 6px; \}/);
  // the markup the rules count on: the group is a direct child of the row, before the info
  assert.match(APP, /<b>\$\{name\}<\/b>\$\{action\}<span class="conn-info">/);
  assert.match(APP, /action: `<span class="conn-acts"><button type="button" class="chip\$\{approveAll\(\) \? ' on' : ''\}" data-approve-all /);
});

// ── ui #11: touch targets ──
test('touch: the controls the 44px list missed have a 44px target', () => {
  const coarse = STUDIO_CSS.slice(STUDIO_CSS.indexOf('\n@media (pointer: coarse) {'), STUDIO_CSS.indexOf('\n@media (hover: none) {'));
  assert.ok(coarse.length > 2000, 'the pointer: coarse block');
  // the one hit-area rule: a 44px ::after, and position: relative for the ones that are not placed already
  const area = /\n {2}:is\(([^)]*(?:\([^)]*\)[^)]*)*)\)::after \{\s*content: ''; position: absolute; left: 50%; top: 50%; translate: -50% -50%; width: max\(100%, 44px\); height: max\(100%, 44px\);\s*\}/.exec(coarse);
  const placed = /\n {2}:is\(([^)]*(?:\([^)]*\)[^)]*)*)\) \{ position: relative; \}/.exec(coarse);
  assert.ok(area && placed, 'the HIT-44 pair of rules');
  assert.equal((coarse.match(/::after \{\s*content: ''; position: absolute; left: 50%; top: 50%; translate: -50% -50%;/g) || []).length, 1, 'one hit-area rule, never a second');
  for (const sel of ['.context-chip', '.nav-collapse']) {
    assert.ok(area[1].split(/,\s*/).includes(sel), `${sel} has the 44px area`);
    assert.ok(placed[1].split(/,\s*/).includes(sel), `${sel} is positioned for it`);
  }
  // a context chip keeps its 26px look (a taller one would grow the phone composer), with room for the area under it
  assert.match(STUDIO_CSS, /\n\.context-chip \{ display: inline-flex; align-items: center; gap: 5px; min-height: 26px; /);
  assert.match(STUDIO_CSS, /\n\.composer-context \{ padding: 0 16px 9px; \}/);
  assert.match(APP, /<button type="button" class="context-chip" data-context-open>/);
  // these grow for real
  assert.match(coarse, /\n {2}\.thread-group-btn, \.thread-space \.chip, \.feedback-sheet \.sheet-foot \.chip, \.feedback-remove-shot \{ min-height: 44px; \}/);
  assert.match(read('public/feedback.js'), /<div class="sheet-foot"><button class="chip" type="button" data-close>Cancel<\/button>/);
  // "Reasoning trace": its ::after is the + / − mark, so the tap area is padding that the margins give back
  assert.match(APP_CSS, /\n\.think summary::after \{ content: '\+'; font-size: 14px; \}/);
  const think = /\n {2}\.think summary \{ padding-block: ([\d.]+)px; margin-block: -([\d.]+)px; \}/.exec(coarse);
  assert.ok(think, '.think summary in the pointer: coarse block');
  assert.equal(think[1], think[2], 'the margins give back exactly what the padding adds: nothing moves');
  const line = /\n\.think summary \{[^}]*font: 500 (\d+)px\/([\d.]+) var\(--mono\);/.exec(APP_CSS);
  assert.ok(Number(line[1]) * Number(line[2]) + 2 * Number(think[1]) >= 44, 'one line of the label plus the padding is 44px or more');
});

// ── ui #12: the search box's focus ring ──
test('the search box shows where the keyboard is: with no outline, its border takes the accent on focus', () => {
  assert.match(APP_CSS, /\n\.search \{\n[^}]*border: 1px solid var\(--line\);[^}]*outline: 0;[^}]*\}/, 'no outline of its own');
  assert.match(APP_CSS, /\n\.search:focus \{ border-color: var\(--accent\); \}/);
  assert.doesNotMatch(APP_CSS + STUDIO_CSS, /\.search:focus[^{]*\{ border-color: var\(--line-2\); \}/, 'the border one faint step up from rest');
  // the accent as a line against the drawer (--bg-2): 3:1 or more in both themes (WCAG 1.4.11)
  for (const [name, t] of [['dark', DARK], ['Paper', PAPER_SET]]) for (const mode of MODES) {
    const r = ratio(hexRgb(t[mode]), hexRgb(t['bg-2']));
    assert.ok(r >= 3, `${name} --${mode} on --bg-2: ${r.toFixed(2)}:1`);
  }
  // Threads focuses it on open (a mouse or trackpad)
  assert.match(APP, /\(id === 'threadsDrawer' && matchMedia\('\(pointer: fine\)'\)\.matches \? \$\('#threadSearch'\) : \$\('\[data-close\]', d\)\)\.focus\(/);
  assert.match(INDEX, /<input class="search" id="threadSearch" type="search" /);
});

// ── ui #13: dead CSS ──
test('no stylesheet keeps a rule for something no code makes', () => {
  const sheets = readdirSync(new URL('../public/', import.meta.url)).filter((f) => f.endsWith('.css')).sort();
  assert.deepEqual(sheets, ['app.css', 'feedback.css', 'legal.css', 'remix.css', 'studio.css']);
  const css = sheets.map((f) => read(`public/${f}`)).join('\n');
  const code = readdirSync(new URL('../public/', import.meta.url)).filter((f) => f.endsWith('.js')).map((f) => read(`public/${f}`)).join('\n') + INDEX;
  for (const gone of ['.tile-glyph', '.mini.accent', ':not(.accent)', '@keyframes spin', '330deg']) assert.ok(!css.includes(gone), `${gone} is gone`);
  assert.doesNotMatch(code, /tile-glyph/);
  // every @keyframes has an animation that names it (a stylesheet's, or one a script sets)
  const frames = [...css.matchAll(/@keyframes ([\w-]+)/g)].map((m) => m[1]);
  assert.ok(frames.includes('turn') && frames.includes('pulse') && frames.length >= 15, frames.join(', '));
  for (const name of frames) assert.match(css + code, new RegExp(`animation(?:-name)?:[^;{}]*\\b${name}\\b`), `@keyframes ${name} is used`);
  // the comment that sent a reader to the wrong rule: the busy mark pulses, and the spinner turns
  assert.match(APP_CSS, /\nbody\.busy \.brand-mark \{ animation: pulse 1\.6s ease-in-out infinite; \}/);
  assert.match(APP_CSS, /\n\.spin, \.status::before \{[^}]*animation: turn 0\.8s linear infinite;\n\}/);
  assert.doesNotMatch(APP_CSS, /stays for \.brand-mark/);
  // the shot buttons' pressed state no longer excepts a class nothing sets
  assert.match(STUDIO_CSS, /\n {2}\.shot-acts \.mini:active \{ background: #0e0d0b; \}/);
});
