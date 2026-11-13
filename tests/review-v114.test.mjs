import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { zipSync, unzipSync, strFromU8, strToU8 } from 'fflate';
import * as ClaudeImport from '../public/claude-import.js';
import { configBody } from '../public/tester.js';

// v114: fixes from the whole-app review (areas app-3 and app-4: the composer half and the settings half of app.js).
// Each test names the finding it closes. Functions are lifted out of public/app.js and run against stubs, as
// tests/untrusted-turns.test.mjs does; one-line changes are pinned by their text.
const APP = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function fnSource(name) {
  let at = APP.indexOf(`\nfunction ${name}(`);
  if (at < 0) at = APP.indexOf(`\nasync function ${name}(`);
  assert.ok(at >= 0, `app.js has function ${name}`);
  return APP.slice(at + 1, APP.indexOf('\n}\n', at + 1) + 2);
}
function scope(vars) {
  return new Proxy(vars, {
    has: (t, k) => typeof k === 'string' && (k in t || !(k in globalThis)),
    get: (t, k) => (k === Symbol.unscopables ? undefined : k in t ? t[k] : () => undefined),
    set: (t, k, v) => { t[k] = v; return true; },
  });
}
const lift = (vars, ...names) => Object.assign(vars, new Function('scope', `with (scope) { return { ${names.map((n) => `${n}: (${fnSource(n)})`).join(', ')} }; }`)(scope(vars)));
const fl = { unzipSync, strFromU8 };
const tick = () => new Promise((r) => setTimeout(r, 0));

// ── history imports (You → Import your history) ──
test('the Claude export under You reads what claude.ai sends today: the split zip, and "user" as the sender', async () => {
  const status = [], analyzed = [];
  const vars = lift({ ClaudeImport, loadFflate: async () => fl, impStatus: (t, tone) => status.push([t, tone || '']), toast: (m) => status.push(['toast', m]), importing: false,
    analyzeCorpus: async (label, items) => { analyzed.push([label, items.map((i) => i.text)]); } }, 'claudeTexts', 'chatgptTexts', 'readExport', 'runImport');
  vars.importBusy = () => { if (vars.importing) vars.toast('An import is still running — wait for it to finish'); return vars.importing; };
  const conv = (uuid, ...msgs) => ({ uuid, name: uuid, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', chat_messages: msgs });
  const zip = zipSync({
    'conversations-000.json': strToU8(JSON.stringify([conv('a', { sender: 'human', text: 'First question of mine', created_at: '2026-01-01T00:00:00Z' }, { sender: 'assistant', text: 'An answer' })])),
    'conversations-001.json': strToU8(JSON.stringify([conv('b', { sender: 'user', content: [{ type: 'text', text: 'Second, in the new shape' }, { type: 'tool_use', name: 'x' }], created_at: '2026-01-03T00:00:00Z' })])),
    'users.json': strToU8('[{"uuid":"u"}]'),
  });
  const file = (name, bytes) => ({ name, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), text: async () => strFromU8(bytes) });
  await vars.runImport('Claude', file('conversations-000.zip', zip));
  assert.deepEqual(analyzed, [['Claude history', ['First question of mine', 'Second, in the new shape']]]);
  // The small file the export email links to is explained, not "convs is not iterable".
  status.length = 0;
  await vars.runImport('Claude', file('export-links.json', strToU8(JSON.stringify({ conversations: ['https://claude.ai/files/conversations-000.zip'] }))));
  assert.equal(status.at(-1)[1], 'bad');
  assert.doesNotMatch(status.at(-1)[0], /iterable|undefined|TypeError/);
  // ChatGPT: a list, or { conversations: [...] }; anything else is a plain sentence.
  const gpt = [{ create_time: 5, mapping: { n1: { message: { author: { role: 'user' }, content: { parts: ['Hi from ChatGPT'] }, create_time: 6 } }, n2: { message: { author: { role: 'assistant' }, content: { parts: ['Hello'] } } } } }];
  analyzed.length = 0;
  await vars.runImport('ChatGPT', file('conversations.json', strToU8(JSON.stringify({ conversations: gpt }))));
  await vars.runImport('ChatGPT', file('conversations.json', strToU8(JSON.stringify(gpt))));
  assert.deepEqual(analyzed.map(([l, t]) => [l, t]), [['ChatGPT history', ['Hi from ChatGPT']], ['ChatGPT history', ['Hi from ChatGPT']]]);
  status.length = 0;
  await vars.runImport('ChatGPT', file('conversations.json', strToU8('{"not":"chats"}')));
  assert.deepEqual(status.at(-1), ['Import failed: That file holds no list of chats. Choose the .zip from your ChatGPT export.', 'bad']);
  assert.equal(vars.importing, false, 'the flag is always cleared');
});

test('one history import at a time: a second pick while one runs says so and starts nothing', async () => {
  let release, started = 0;
  const said = [];
  const vars = lift({ ClaudeImport, loadFflate: async () => fl, impStatus() {}, toast: (m) => said.push(m), importing: false,
    readExport: async () => [], chatgptTexts: () => [{ text: 'x', at: 1 }], claudeTexts: () => [], analyzeCorpus: () => { started++; return new Promise((r) => { release = r; }); } }, 'runImport');
  vars.importBusy = () => { if (vars.importing) vars.toast('An import is still running — wait for it to finish'); return vars.importing; };
  const first = vars.runImport('ChatGPT', { name: 'a.json' });
  await tick();
  await vars.runImport('ChatGPT', { name: 'b.json' });
  assert.equal(started, 1);
  assert.deepEqual(said, ['An import is still running — wait for it to finish']);
  release(); await first;
  assert.equal(vars.importing, false);
  // Claude Code goes through the same gate, and the update reload waits for all of them.
  assert.match(fnSource('importClaudeCode'), /^async function importClaudeCode\(dir, incremental\) \{\n  if \(importBusy\(\)\) return;\n  importing = true;/);
  assert.match(fnSource('importClaudeCode'), /finally \{ importing = false; \}\n\}$/);
  assert.match(APP, /\|\| learning \|\| remix\?\.cutting\(\) \|\| claudeJob \|\| importing\) return setTimeout\(reloadWhenIdle, 3000\);/);
});

// ── sign-in, and what a link can make the app say ──
test('a link cannot put its own words in a toast or the sign-in note; a new tester\'s welcome survives the workspace reload', () => {
  // ?connected=…: only when this device started a sign-in, and the words are kept short
  assert.match(APP, /const via = connected \? LS\.get\('oauthVia', ''\) : '';\n  if \(connected && via\) \{/);
  assert.match(APP, /const word = \(k\) => String\(params\.get\(k\) \|\| ''\)\.replace\(\/\\s\+\/g, ' '\)\.trim\(\)\.slice\(0, 100\);/);
  assert.doesNotMatch(APP, /connected ✓ \$\{params\.get\('account'\)/);
  // ?tester=constructor used to read Object.prototype
  assert.match(APP, /openOnboard\(Object\.hasOwn\(SIGNIN_NOTES, testerResult \|\| ''\) && testerResult !== 'welcome' \? testerResult : signinReason\);/);
  assert.match(APP, /const note = Object\.hasOwn\(SIGNIN_NOTES, noteKey\) \? SIGNIN_NOTES\[noteKey\] : '';/);
  assert.match(APP, /\$\('#onboardMsg'\)\.textContent = Object\.hasOwn\(SIGNIN_REASONS, reason\) \? SIGNIN_REASONS\[reason\] : '';/);
  assert.doesNotMatch(APP, /SIGNIN_NOTES\[testerResult\]|SIGNIN_REASONS\[reason\] \|\|/);
  // the welcome word is kept for the tab across setTester's reload, and dropped once shown or once sign-in fails
  assert.match(APP, /try \{ if \(params\.get\('tester'\) === 'welcome'\) sessionStorage\.setItem\('atelier\.testerWelcome', '1'\); \} catch \{\}\n  if \(params\.toString\(\) \|\| location\.hash\.length > 1\) history\.replaceState\(null, '', '\/'\);/);
  assert.match(APP, /const testerResult = params\.get\('tester'\) \|\| \(welcomeKept\(\) \? 'welcome' : null\);/);
  assert.match(APP, /if \(testerResult === 'welcome'\) \{ welcomeDone\(\); welcomeTester\(\); \} else if \(!cached\) resumeLaunch\(\);/);
  assert.match(APP, /\} else if \(st === 'none' \|\| st === 'closed'\) \{\n        welcomeDone\(\);/);
});

test('the sign-in screen says why: the owner signed out, or the server refused the passcode; neither counts as a tester\'s trace', () => {
  assert.match(APP, /ownerout: 'You’re signed out\. Your threads stay on this device\.',/);
  assert.match(APP, /S\.settings\.passcode = ''; LS\.set\('outReason', 'rejected'\); saveSettings\(\); syncRole\(\);/);
  assert.match(APP, /else if \(Object\.hasOwn\(SIGNIN_NOTES, LS\.get\('outReason', ''\)\) \|\| Object\.hasOwn\(SIGNIN_REASONS, LS\.get\('outReason', ''\)\)\) signinReason = LS\.get\('outReason', ''\);/);
  const trace = /\nconst testerTrace = .*\n/.exec(APP)[0];
  assert.doesNotMatch(trace, /ownerout|rejected/, 'an owner sign-out never makes this a browser a tester used');
});

// ── Claude Code import: only what the person typed ──
test('disconnecting an account that could not be disconnected says so; a syncing tester is not told "this device only"', () => {
  assert.match(APP, /if \(!r\?\.ok\) toast\(!r \? 'Couldn’t reach Atelier — check your connection\.' : \(await r\.json\(\)\.catch\(\(\) => \(\{\}\)\)\)\.error \|\| `Couldn’t remove \$\{b\.dataset\.label\}`, \{ error: true \}\);/);
  assert.match(APP, /if \(!r\?\.ok\) toast\(!r \? 'Couldn’t reach Atelier — check your connection\.' : \(await r\.json\(\)\.catch\(\(\) => \(\{\}\)\)\)\.error \|\| `Couldn’t disconnect \$\{email \|\| 'Gmail'\}`, \{ error: true \}\);/);
  assert.match(APP, /const where = Sync\.on\(\) && \(added \|\| grew\) \? ' They’ll sync to your other devices\.' : S\.tester \? ' Saved on this device only\.' : '';/);
});

// ── Testers panel ──
test('the Testers panel keeps what was typed through a repaint, and an emptied Spots field is an error, not zero spots', () => {
  const paint = fnSource('paintTesters');
  assert.match(paint, /const typed = \['tpCap', 'tpDay', 'tpMonth', 'tpPool', 'tpSub'\]\.map\(/);
  assert.match(paint, /return el && el\.value !== el\.defaultValue \? \{ id, value: el\.value,/);
  assert.match(paint, /el\.value = t\.value; \/\/ defaultValue stays the saved one, so tpEdited still sees the change/);
  assert.ok(paint.indexOf('const typed =') < paint.indexOf('box.innerHTML =') && paint.indexOf('box.innerHTML =') < paint.indexOf('for (const t of typed)'), 'read before the repaint, put back after it');
  assert.deepEqual(configBody({ cap: '', day: '1', month: '10', pool: '100' }), { error: 'Spots must be a whole number from 0 to 1,000.' });
  assert.deepEqual(configBody({ cap: '  ', day: '1', month: '10', pool: '100' }), { error: 'Spots must be a whole number from 0 to 1,000.' });
  assert.deepEqual(configBody({ cap: '0', day: '1', month: '10', pool: '100' }).body.cap, 0, 'a typed 0 still closes the spots on purpose');
  assert.equal(configBody({ cap: '25', day: '1', month: '10', pool: '100' }).body.cap, 25);
});

// ── a slow or held thread store ──
test('allThreads: a read that is still running gives a short list marked busy, and its rows are used when they arrive, not read again', async () => {
  let reads = 0, deliver;
  const toasts = [];
  const vars = lift({ S: { thread: { id: 'open', entries: [{ kind: 'ask' }], updatedAt: 9 } }, ClaudeImport: { listAt: (t) => t.updatedAt || 0 }, toast: (m) => toasts.push(m),
    DB: { all: () => { reads++; return new Promise((r) => { deliver = r; }); } }, sleep: () => Promise.resolve(), busyToastAt: 0 }, 'allThreads');
  const short = await vars.allThreads();
  assert.equal(short.busy, true);
  assert.deepEqual(short.map((t) => t.id), ['open'], 'the thread on screen, and nothing else yet');
  assert.equal(toasts.length, 1);
  deliver([{ id: 'old', entries: [{}], updatedAt: 3 }, { id: 'open', entries: [], updatedAt: 1 }]);
  const rows = await short.late;
  const full = await vars.allThreads(rows);
  assert.equal(full.busy, undefined);
  assert.deepEqual(full.map((t) => t.id), ['open', 'old']);
  assert.equal(reads, 1, 'the delivered rows are used as they are');
  assert.equal(toasts.length, 1, 'and "Storage is busy" is not said twice');
  // The Library, the home screen and the Threads list all wait for those rows instead of drawing "nothing".
  assert.match(fnSource('renderLibrary'), /if \(all\.busy\) \{ all\.late\.then\(\(saved\) => \{ if \(token === libToken\) renderLibrary\(saved\); \}\); return; \}/);
  assert.match(fnSource('renderRecentThreads'), /if \(rows\.busy\) \{ rows\.late\.then\(\(saved\) => \{ if \(seq === recentSeq\) renderRecentThreads\(saved\); \}\); if \(!rows\.length\) return; \}/);
  assert.match(fnSource('renderThreads'), /if \(storeBusy\) all\.late\.then\(\(saved\) => \{ if \(seq === threadsSeq && !\$\('#threadsDrawer'\)\.hidden\) renderThreads\(false, saved\); \}\);/);
  assert.match(fnSource('renderThreads'), /\.\.\.\(Array\.isArray\(e\.files\) \? e\.files\.map\(\(f\) => f\?\.name\) : \[\]\),/, 'search also finds a thread by an attached file\'s name');
});

// ── the composer's context dialog and Google Photos ──
test('the context dialog lists attached documents and can remove them, and says who approves; Google Photos reports what really happened', () => {
  const details = fnSource('renderContextDetails');
  assert.match(details, /S\.files\.length \|\| S\.attachments\.length \? S\.files\.map\(\(f, i\) => `<div class="context-file">/);
  assert.match(details, /data-context-file="\$\{i\}">Remove<\/button>/);
  assert.match(details, /'<p class="hint">Nothing attached\. Use the attachment button to add photos, a video or files\.<\/p>'/);
  assert.match(details, /\$\{available\.length === 1 \? 'is' : 'are'\} available\. \$\{approveAll\(\) \? 'Atelier acts without asking first\. Change that in Settings → Connections\.' : 'External changes still need your approval\.'\}/);
  assert.match(APP, /if \(file\) \{ const doc = S\.files\[\+file\.dataset\.contextFile\]; if \(doc\) dropDoc\(doc\); renderAttachments\(\); renderContextDetails\(\); \}/);
  const photos = fnSource('pickGooglePhotos');
  assert.match(photos, /if \(S\.attachments\.length >= MAX_ATT\) return toast\(`\$\{MAX_ATT\} images max — remove one first`\);[^\n]*\n  const win = window\.open\(/, 'a full tray is refused before Google\'s window opens');
  assert.match(photos, /const said = added \? `Added \$\{added\} photo/);
  assert.match(photos, /: !photos\.length \? `\$\{MAX_ATT\} images max — remove one first` : 'Couldn’t get those photos from Google Photos — try again';/);
  assert.match(photos, /try \{ if \(raw\) \{ S\.attachments\.push\(\{ src: await shrinkDataUrl\(raw, 1280, 1280\) \}\); added\+\+; \} \} catch \{/);
});
