import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clipText, textSize, fitFiles, leftOut } from '../public/files.js';
import { filesBlock, withSent, buildHistory, REPLAY_FILES, TESTER_HISTORY } from '../public/context.js';

// v114: fixes from the whole-app review, the reading half of app.js (areas app-1, app-2, files-v113 and modules).
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

// ── app-1 #0: a code block's Preview ──
// The branch of the stream's click handler, cut out and run with stubs for what it calls.
function previewBranch() {
  const from = APP.indexOf("    const risk = e ? linkRisk(e) : 'outside';");
  const to = APP.indexOf('\n  }\n', from);
  assert.ok(from > 0 && to > from, 'app.js has the Preview branch');
  return APP.slice(from, to);
}
function previewRig({ risk, answer }) {
  const asked = [], opened = [];
  const run = new Function('linkRisk', 'previewAsked', 'confirm', 'openViewer', 'e', 'lang', 'code', previewBranch());
  const previewAsked = new WeakSet();
  const tap = (e, lang = 'html', code = '<p>hi</p>') => run(() => risk, previewAsked, (q) => { asked.push(q); return answer; }, (o) => { opened.push(o); }, e, lang, code);
  return { tap, asked, opened };
}

test('app-1 #0: Preview of a code block asks first where a link would, once per answer, and runs under the strict policy', () => {
  // A thread that read accounts: the question names it; "no" opens nothing.
  const no = previewRig({ risk: 'accounts', answer: false });
  const e = { id: 'a1' };
  no.tap(e);
  assert.deepEqual(no.opened, []);
  assert.equal(no.asked[0], 'The assistant wrote this code after reading your accounts. Running it can send what it read to another site. Run it?');
  no.tap(e);
  assert.equal(no.asked.length, 2, 'a "no" is not remembered');

  // "Yes": the page opens strict, and the same answer is not asked about again. Another answer is.
  const yes = previewRig({ risk: 'outside', answer: true });
  yes.tap(e); yes.tap(e, 'svg', '<svg></svg>');
  assert.equal(yes.asked.length, 1);
  assert.equal(yes.asked[0], 'The assistant wrote this code in a thread with text from outside Atelier. Running it can send that text to another site. Run it?');
  assert.deepEqual(yes.opened.map((o) => [o.title, o.strict]), [['Preview', true], ['Preview', true]]);
  assert.match(yes.opened[1].html, /^<body style="[^"]*"><svg><\/svg><\/body>$/);
  yes.tap({ id: 'a2' });
  assert.equal(yes.asked.length, 2);

  // A clean thread: no question, no policy (a previewed page may load its own images and data, as before).
  const clean = previewRig({ risk: '', answer: false });
  clean.tap(e);
  assert.deepEqual([clean.asked.length, clean.opened.length, clean.opened[0].strict], [0, 1, false]);

  // A block with no entry behind it (never the case today): treated as risky, asked every time.
  const lost = previewRig({ risk: '', answer: true });
  lost.tap(undefined); lost.tap(undefined);
  assert.deepEqual([lost.asked.length, lost.opened.every((o) => o.strict)], [2, true]);
  // The viewer passes strict through to the mount (public/appdata.js honours it without a store; tests/appdata.test.mjs).
  assert.match(APP, /appBridge\.mount\(f, \{ key: app, html, strict \}\)/);
});

// ── app-1 #3, files-v113 #3, modules #5, sync #7, modules #4, testers #4: one budget for a turn's files, and it shows ──
test('clipText never ends on half a pair; a byte budget counts UTF-8; fitFiles shares one total and marks a file with no room', () => {
  const emoji = String.fromCodePoint(0x1f600); // two UTF-16 units, four UTF-8 bytes
  const s = `${'a'.repeat(9)}${emoji}tail`;
  assert.deepEqual(clipText(s, 10), { text: 'a'.repeat(9), cut: true }, 'the cut would have split the pair: it stops before it');
  assert.deepEqual(clipText(s, 11), { text: `${'a'.repeat(9)}${emoji}`, cut: true });
  assert.equal(clipText(s, 10).text.isWellFormed(), true);
  assert.deepEqual(clipText('abc', 0), { text: '', cut: true });
  assert.deepEqual(clipText('', 0), { text: '', cut: false }, 'an empty file is not a cut one');
  // Bytes: 3 per CJK character, 4 per emoji, never a split character.
  const cjk = String.fromCodePoint(0x4e2d).repeat(10);
  assert.equal(textSize(cjk), 10);
  assert.equal(textSize(cjk, true), 30);
  assert.equal(textSize(`a${emoji}`, true), 5);
  assert.deepEqual(clipText(cjk, 10, { bytes: true }), { text: cjk.slice(0, 3), cut: true });
  assert.deepEqual(clipText(`ab${emoji}c`, 5, { bytes: true }), { text: 'ab', cut: true });
  assert.deepEqual(clipText(cjk, 30, { bytes: true }), { text: cjk, cut: false });
  for (const text of [cjk, `ab${emoji}c`, 'plain']) for (let max = 0; max < 34; max++) {
    const got = clipText(text, max, { bytes: true }).text;
    assert.ok(new TextEncoder().encode(got).length <= max && got.isWellFormed(), `${text.length} units within ${max} bytes`);
  }
  // A tester's set: 200,000 bytes in all. Chinese text that fits the character budget is cut to fit the bytes.
  const long = String.fromCodePoint(0x4e2d).repeat(100_000);
  const fit = fitFiles([{ name: 'a.pdf', text: long }, { name: 'b.txt', text: 'tiny' }], { total: 200_000, bytes: true });
  assert.equal(new TextEncoder().encode(fit[0].text).length, 150_000, 'one file: 150,000 of the unit in use');
  assert.deepEqual([fit[0].cut, fit[1].text, fit[1].cut], [true, 'tiny', false]);
  const wide = fitFiles([{ name: 'a.pdf', text: long }, { name: 'b.txt', text: 'tiny' }], { total: 200_000, each: 200_000, bytes: true });
  assert.equal(new TextEncoder().encode(wide[0].text).length, 199_998, 'whole characters, within the total');
  assert.deepEqual([wide[0].cut, wide[1].text, wide[1].cut], [true, 'ti', true], 'the two bytes left go to the next file');
  assert.deepEqual(fitFiles([{ name: 'a', text: 'x'.repeat(9) }, { name: 'b', text: 'yy' }], { total: 9 }).map((f) => [f.text.length, f.cut, leftOut(f)]), [[9, false, false], [0, true, true]]);
  assert.deepEqual(fitFiles([{ name: 'a', text: 'abcdef' }], 4)[0], { name: 'a', text: 'abcd', cut: true }, 'a number is still the total');
  assert.equal(leftOut({ text: '', cut: false }), false, 'a file with nothing to read was not left out');
  assert.equal(leftOut(undefined), false);
});

test('filesBlock: a file with no room says it was left out, not that it could not be read; brief gives a line per file', () => {
  const x = { files: [{ name: 'a.txt', kind: 'text', text: 'ABC' }, { name: 'b.pdf', kind: 'pdf', text: 'part', cut: true }, { name: 'c.docx', kind: 'docx', text: '', cut: true }, { name: 'd.txt', kind: 'text', text: '' }] };
  assert.equal(filesBlock(x), [
    '<attached_file name="a.txt" type="text">\nABC\n</attached_file>',
    '<attached_file name="b.pdf" type="pdf">\npart\n[The file is longer. Only this first part was included.]\n</attached_file>',
    '<attached_file name="c.docx" type="docx">\n[This file was left out. The files before it filled the message.]\n</attached_file>',
    '<attached_file name="d.txt" type="text">\n[No text could be read from this file.]\n</attached_file>',
  ].join('\n\n'));
  const gone = '[Sent earlier in this thread. Its text is not included now. Ask for the file again if you need it.]';
  assert.equal(filesBlock({ files: x.files.slice(0, 2) }, { brief: true }), `<attached_file name="a.txt" type="text">\n${gone}\n</attached_file>\n\n<attached_file name="b.pdf" type="pdf">\n${gone}\n</attached_file>`);
  assert.equal(withSent('Q', { files: [x.files[0]] }, { brief: true }), `<attached_file name="a.txt" type="text">\n${gone}\n</attached_file>\n\nQ`);
  assert.equal(withSent('Q', { files: [x.files[0]] }), '<attached_file name="a.txt" type="text">\nABC\n</attached_file>\n\nQ', 'not brief: as before');
});

test('sync #3: a restored or synced entry of any size is cut to the app’s own limits as it is read; what the app made is untouched', async () => {
  const { FILE_CHARS, FILES_CHARS } = await import('../public/files.js');
  const CTX = readFileSync(new URL('../public/context.js', import.meta.url), 'utf8');
  assert.match(CTX, new RegExp(`const FILE_CAP = ${FILE_CHARS.toLocaleString('en-US').replace(/,/g, '_')}, FILES_CAP = ${FILES_CHARS.toLocaleString('en-US').replace(/,/g, '_')};`), 'the same numbers as files.js');
  // As large as the app ever stores: byte for byte as before.
  const own = { files: fitFiles([{ name: 'a', kind: 'text', text: 'a'.repeat(FILE_CHARS + 50) }, { name: 'b', kind: 'text', text: 'b'.repeat(FILE_CHARS) }, { name: 'c', kind: 'text', text: 'tiny' }]) };
  const block = filesBlock(own);
  assert.equal(block.length, FILES_CHARS + 3 * '<attached_file name="a" type="text">\n\n</attached_file>'.length + 2 * 2 + 2 * '\n[The file is longer. Only this first part was included.]'.length + '[This file was left out. The files before it filled the message.]'.length);
  // A hand-made backup with a 5 MB "file", and a second one: the first is cut and says so, the second has no room.
  const huge = filesBlock({ files: [{ name: 'big.txt', kind: 'text', text: 'Q'.repeat(5_000_000) }, { name: 'more.txt', kind: 'text', text: 'W'.repeat(400_000) }, { name: 'last.txt', kind: 'text', text: 'z' }] });
  assert.ok(huge.length < FILES_CHARS + 600);
  assert.equal(huge.split('Q').length - 1, FILE_CHARS);
  assert.equal(huge.split('W').length - 1, FILES_CHARS - FILE_CHARS);
  assert.equal(huge.split('\n[The file is longer. Only this first part was included.]').length - 1, 2);
  assert.match(huge, /<attached_file name="last\.txt" type="text">\n\[This file was left out\. The files before it filled the message\.\]\n<\/attached_file>$/);
  // The cut never leaves half a pair.
  const pair = filesBlock({ files: [{ name: 'e', text: `${'a'.repeat(FILE_CHARS - 1)}${String.fromCodePoint(0x1f600)}tail` }] });
  assert.equal(pair.isWellFormed(), true);
  assert.ok(pair.includes(`${'a'.repeat(FILE_CHARS - 1)}\n[The file is longer.`));
});

test('modules #7: a feedback request that never reached the server is said in Atelier’s words, and the form says the message is still there', () => {
  const FB = readFileSync(new URL('../public/feedback.js', import.meta.url), 'utf8');
  assert.match(FB, /if \(err instanceof TypeError\) throw Object\.assign\(new Error\('Couldn’t reach Atelier\. Check your connection, then try again\.'\), \{ offline: true \}\);/);
  assert.match(FB, /showError\(err\.offline \? `\$\{err\.message\} Your message is still here\.` : err\.message \|\| /);
});

const turnWith = (id, chars, at) => ({ id, kind: 'ask', prompt: `q ${id}`, text: `answer ${id}`, createdAt: at, ...(chars && { files: [{ name: `${id}.txt`, kind: 'text', text: id.slice(-1).repeat(chars) }] }) });
const fullIn = (msgs) => msgs.filter((m) => m.role === 'user').map((m) => (/\[Sent earlier in this thread\./.test(m.content) ? 'brief' : /<attached_file/.test(m.content) ? 'full' : '-'));
test('files-v113 #1, modules #0: the files a request carries share one budget, newest first; older turns replay with a line per file', () => {
  assert.equal(REPLAY_FILES, 500_000);
  // Four turns of 200,000 characters each, then a plain question: the newest two fit (400,000), the third would pass 500,000.
  const turns = [turnWith('ta', 200_000, 1), turnWith('tb', 200_000, 2), turnWith('tc', 200_000, 3), turnWith('td', 200_000, 4)];
  const ask = turnWith('te', 0, 5);
  assert.deepEqual(fullIn(buildHistory(turns, { turn: ask })), ['brief', 'brief', 'full', 'full']);
  // The turn being sent counts first: with its own 200,000, only the newest replayed turn still fits.
  const sending = turnWith('tf', 200_000, 6);
  assert.deepEqual(fullIn(buildHistory(turns, { turn: sending })), ['brief', 'brief', 'brief', 'full']);
  // ...and the count is the same on the next request, when that turn is the newest replayed one: the front holds.
  const next = buildHistory([...turns, sending], { turn: turnWith('tg', 0, 7) });
  assert.deepEqual(fullIn(next), ['brief', 'brief', 'brief', 'full', 'full']);
  assert.deepEqual(next.slice(0, 8), buildHistory(turns, { turn: sending }), 'what was sent before is sent again byte for byte');
  // Plain follow-ups never move the choice.
  const more = [...turns, ask, turnWith('th', 0, 8), turnWith('ti', 0, 9)];
  assert.deepEqual(fullIn(buildHistory(more, { turn: turnWith('tj', 0, 10) })).slice(0, 4), ['brief', 'brief', 'full', 'full']);
  // Once one turn does not fit, no older one is put back, however small.
  const mixed = [turnWith('ta', 10, 1), turnWith('tb', 450_000, 2), turnWith('tc', 100_000, 3)];
  assert.deepEqual(fullIn(buildHistory(mixed, { turn: ask })), ['brief', 'brief', 'full']);
  // Under the budget, and with no turn named: everything replays in full, as before.
  assert.deepEqual(fullIn(buildHistory(turns.slice(0, 2))), ['full', 'full']);
  assert.deepEqual(fullIn(buildHistory([turnWith('ta', 0, 1)])), ['-']);
  // A brief turn keeps its question and its answer.
  const [u, a] = buildHistory(turns, { turn: ask });
  assert.match(u.content, /^<attached_file name="ta\.txt" type="text">\n\[Sent earlier in this thread\.[^\n]*\]\n<\/attached_file>\n\nq ta$/);
  assert.equal(a.content, 'answer ta');
});

test('testers #4: a tester’s request counts files in bytes, within what the server takes for a whole conversation', () => {
  assert.deepEqual({ ...TESTER_HISTORY }, { min: 6, block: 5, filesRoom: 200_000, filesBytes: true });
  const zh = (id, chars, at) => ({ ...turnWith(id, 0, at), files: [{ name: `${id}.pdf`, kind: 'pdf', text: String.fromCodePoint(0x4e2d).repeat(chars) }] });
  // 40,000 Chinese characters are 120,000 bytes: two such turns pass 200,000 bytes though they are only 80,000 characters.
  const turns = [zh('ta', 40_000, 1), zh('tb', 40_000, 2)];
  assert.deepEqual(fullIn(buildHistory(turns, { ...TESTER_HISTORY, turn: turnWith('tc', 0, 3) })), ['brief', 'full']);
  assert.deepEqual(fullIn(buildHistory(turns, { turn: turnWith('tc', 0, 3) })), ['full', 'full'], 'the owner counts characters');
  assert.match(APP, /const fileBudget = \(\) => \(S\.tester \? \{ total: TESTER_HISTORY\.filesRoom, bytes: true \} : \{\}\);/);
  assert.match(APP, /\.\.\.historyWindow\(\), turn: e \}\);/);
});

test('app-1 #3: the chip says what Send will do to each file, and the sent turn keeps the mark', () => {
  const vars = { fitFiles, leftOut, S: { tester: null, files: [] }, TESTER_HISTORY };
  const { docMeta, sendFit, fileBudget } = new Function('scope', `with (scope) { ${/\nconst fileBudget = [^\n]*\n/.exec(APP)[0]} ${/\nconst docMeta = [^\n]*\n/.exec(APP)[0]} ${/\nconst sendFit = [^\n]*\n/.exec(APP)[0]} return { docMeta, sendFit, fileBudget }; }`)(scope(vars));
  const doc = (name, chars) => ({ name, status: 'ready', text: 'x'.repeat(chars), chars, cut: false });
  vars.S.files = [doc('a.txt', 150_000), doc('b.txt', 150_000), doc('c.txt', 2_000), { name: 'd.pdf', status: 'reading', note: 'page 2 of 9' }];
  const fit = sendFit();
  assert.deepEqual(vars.S.files.map((f) => docMeta(f, fit.get(f))), ['150k characters', '150k characters · first part sent', '2k characters · no room left, not sent', 'Reading… page 2 of 9']);
  assert.equal(docMeta(vars.S.files[1]), '150k characters', 'with no fit given, the file as it was read');
  assert.equal(docMeta({ status: 'ready', text: 'x', chars: 1, cut: true }), '1 characters · first part sent');
  vars.S.tester = { sub: 't1' };
  assert.deepEqual(fileBudget(), { total: 200_000, bytes: true });
  vars.S.files = [doc('a.txt', 150_000), doc('b.txt', 150_000)];
  const t = sendFit();
  assert.deepEqual(vars.S.files.map((f) => docMeta(f, t.get(f))), ['150k characters', '150k characters · first part sent']);
  assert.equal(t.get(vars.S.files[1]).text.length, 50_000);
  // The tray works the fit out when it can matter; the sent turn's pill carries the mark.
  assert.match(APP, /const fit = S\.files\.length > 1 \|\| S\.tester \? sendFit\(\) : null;/);
  assert.match(APP, /\$\{f\.cut \? `<span class="file-pill-note"> · \$\{leftOut\(f\) \? 'not sent' : 'first part'\}<\/span>` : ''\}/);
  assert.match(APP, /toast\(out\.length === 1 \? `“\$\{[^\n]*\}” was not sent\. The files before it filled the message\.` : `\$\{out\.length\} files were not sent\. The files before them filled the message\.`, \{ ms: 7000 \}\);/);
});

// ── app-2 #9, #12, #13, #1: the agent's small print ──
test('app-2 #13: an approval card is said aloud, and a run waiting in another thread says where', async () => {
  const said = { textContent: '' }, toasts = [], here = { id: 't1', title: 'Inbox' }, away = { id: 't2', title: 'Refund for order 4411' };
  const vars = lift({ approvals: new Map(), S: { thread: here }, $: (sel) => (sel === '#activityStatus' ? said : null), toast: (m, o) => toasts.push([m, o?.ms]), DOMException }, 'awaitApproval');
  const step = { id: 's1', label: 'Send an email' };
  const waiting = vars.awaitApproval(step, new AbortController().signal, here);
  assert.equal(said.textContent, 'Send an email needs your OK.');
  assert.deepEqual(toasts, [], 'the owner is looking at it: no toast');
  vars.approvals.get('s1')(true);
  assert.equal(await waiting, true);
  const other = vars.awaitApproval({ id: 's2', label: 'Refund a charge' }, new AbortController().signal, away);
  assert.deepEqual(toasts, [['Refund a charge needs your OK. Open “Refund for order 4411” to answer.', 9000]]);
  vars.approvals.get('s2')(false);
  assert.equal(await other, false);
  // Stop already pressed: nothing is announced, nothing waits.
  const stopped = new AbortController(); stopped.abort(); said.textContent = '';
  await assert.rejects(vars.awaitApproval({ id: 's3', label: 'Send' }, stopped.signal, away), (err) => err.name === 'AbortError');
  assert.deepEqual([said.textContent, toasts.length, vars.approvals.has('s3')], ['', 1, false]);
  assert.equal(APP.split('awaitApproval(step, signal, thread)').length - 1, 2, 'both waits name the run’s thread');
});

test('app-2 #9, #12, #1: a dropped write says it may have gone through; the relay check cannot hang a turn; an Omni edit goes out as written', async () => {
  // The tool step's catch, as written.
  assert.match(APP, /const dropped = step\.write && \(err instanceof TypeError \|\| \/failed to fetch\|networkerror\|load failed\|connection was lost\/i\.test\(err\.message \|\| ''\)\);\n\s+return \{ ok: false, error: dropped \? WRITE_DROPPED : err\.message \};/);
  assert.match(APP, /\nconst WRITE_DROPPED = 'The connection dropped while this ran\. It may already have gone through\. Check before trying again\.';\n/);
  assert.match(APP, /if \(err\.name === 'AbortError'\) throw err;\n\s+\/\/ v114: a write whose request dropped/, 'Stop still ends the run');
  // refreshRemote gives its request 2.5 s; a timeout is a check that never reached the server.
  let seen = null;
  const vars = lift({ S: { settings: { passcode: 'p' } }, REMOTE: { online: true, checked: 0 }, apiHeaders: () => ({}), Date, AbortSignal,
    fetch: async (url, init) => { seen = init; throw new DOMException('The operation timed out.', 'TimeoutError'); } }, 'refreshRemote');
  assert.equal(await vars.refreshRemote(true), true, 'the last known state stands');
  assert.ok(seen.signal instanceof AbortSignal);
  assert.ok(vars.REMOTE.checked > 0, 'and the next turn does not wait again at once');
  // An edit of an Omni clip skips "Add detail"; Runway and Grok still polish their prompts.
  assert.match(APP, /const prompt = e\.params\.omniEdit\?\.id \? e\.prompt : await enhance\(e, 'video', signal\);\n  if \(cfg\.omni\) \{/);
  assert.equal(APP.split("const prompt = await enhance(e, 'video', signal);").length - 1, 2);
});

test('app-2 #10: a button on an earlier turn never takes, or clears, the photos waiting in the composer', () => {
  const submit = fnSource('submit');
  assert.match(submit, /const ownSend = textArg == null && !extra\.entry;\n[^\n]*\n[^\n]*\n  const images = video \? \[\] : extra\.images \?\? \(ownSend \? S\.attachments\.map\(\(a\) => a\.src\) : \[\]\);/);
  assert.match(submit, /const sharedFiles = video \? video\.from === 'share' : ownSend && !extra\.images && S\.attachments\.some\(\(a\) => a\.from === 'share'\);/);
  assert.match(submit, /if \(ownSend && !extra\.images\) \{ S\.attachments = \[\]; renderAttachments\(\); \}/);
  // Every send that names its own text comes from a button on an entry (or Look up, which passes its own images).
  const named = [...APP.matchAll(/[^a-zA-Z.]submit\(([^)\n]{1,40})/g)].map((m) => m[1]).filter((a) => a && !/^(undefined|textArg)/.test(a));
  assert.deepEqual(named.map((a) => a.split(',')[0].trim().slice(0, 12)), ['e.prompt', '`Expand this', '`Build a wor', '`${d.title}:', '`Turn this i', 'prompt']);
});

// ── app-4 #7, #8, #11: You and the Testers panel ──
test('app-4 #8: a memory keeps its leading number; a typed one may be short; one that was not added stays in the box', () => {
  let n = 0, saves = 0;
  const vars = lift({ ME: { memory: [] }, uid: () => `m${++n}`, saveMe: () => { saves++; }, Date: { now: () => 1 } }, 'addMemory');
  const add = (texts, src) => vars.addMemory(texts, src).map((m) => m.text);
  assert.deepEqual(add(['2019 was the year I moved to Ohio', '401k is with Fidelity'], 'chat'), ['2019 was the year I moved to Ohio', '401k is with Fidelity']);
  assert.deepEqual(add(['- Likes green tea', '• Has two dogs', '3. Works in roofing', '12) Drives a Tacoma', '* Up at 5 most days'], 'chat'), ['Likes green tea', 'Has two dogs', 'Works in roofing', 'Drives a Tacoma', 'Up at 5 most days']);
  assert.deepEqual(add(['Vegan'], 'chat'), [], 'a model’s scrap is still dropped');
  assert.deepEqual(add(['Vegan', '- '], 'you'), ['Vegan'], 'what the owner types is kept, however short; nothing is nothing');
  assert.deepEqual(add(['vegan', 'x'.repeat(241)], 'you'), [], 'the same words, or too many');
  assert.equal(saves, 3);
  const handler = /\n\$\('#memAdd'\)\.onclick = \(\) => \{\n[\s\S]*?\n\};\n/.exec(APP)[0];
  assert.match(handler, /if \(!addMemory\(\[v\], 'you'\)\.length\) return toast\(v\.length > 240 \? 'That is too long to remember\. Keep it under 240 characters\.' : 'Atelier already remembers that\.'\);\n  box\.value = ''; renderYou\(\);/);
});

test('app-4 #7, #11: an import offers its Style guide instead of writing over yours; limits over the Ledger’s own say so in dollars', async () => {
  const learn = /\n  if \(profile\) ME\.learned = profile;\n[\s\S]*?\n  impStatus\(`Done/.exec(APP)[0];
  assert.match(learn, /const had = \(ME\.style \|\| ''\)\.trim\(\);\n  if \(style && !had\) ME\.style = style;/);
  assert.doesNotMatch(learn, /if \(style\) ME\.style = style;/);
  assert.match(learn, /if \(style && had && style\.trim\(\) !== had\) toast\('This import wrote a new Style guide\. Yours was kept\.', \{ ms: 15000, action: \{ label: 'Use the new one', onClick: \(\) => \{ ME\.style = style; saveMe\(\); renderYou\(\); \} \} \}\);/);
  const { configBody } = await import('../public/tester.js');
  assert.deepEqual(configBody({ cap: '25', day: '101', month: '500', pool: '900' }), { error: 'The daily limit can’t go above $100.' });
  assert.deepEqual(configBody({ cap: '25', day: '50', month: '1000.01', pool: '900' }), { error: 'The monthly limit can’t go above $1,000.' });
  assert.deepEqual(configBody({ cap: '25', day: '100', month: '1000', pool: '1000' }).body, { cap: 25, day_limit: 100_000_000, month_limit: 1_000_000_000, pool_limit: 1_000_000_000 });
});

// ── app-1 #2: looking at a thread is not a change to it ──
test('app-1 #2: a flush on the way out of a thread saves it but keeps its time, unless a change was waiting or it is still generating', () => {
  const at = APP.indexOf('\nlet persistTimer;\n'), end = APP.indexOf('\nfunction storageError', at);
  assert.ok(at > 0 && end > at);
  let now = 1_000, timer = null;
  const puts = [], live = new Map();
  const old = { id: 't-old', updatedAt: 50, entries: [{ id: 'e1', text: 'last month' }] };
  const S = { thread: old };
  const { persist } = new Function('S', 'DB', 'LS', 'workspaceKey', 'liveThreads', 'storageError', 'Date', 'setTimeout', 'clearTimeout', `let accountReloading = false; ${APP.slice(at, end)}\nreturn { persist };`)(
    S, { put: (t) => { puts.push([t.id, t.updatedAt]); return Promise.resolve(); } }, { set() {} }, (k) => k, live, () => {}, { now: () => now }, (fn) => { timer = fn; return 1; }, () => { timer = null; });
  // Opening another thread, New, leaving the app: saved, same time.
  persist(true, { flush: true });
  assert.deepEqual(puts, [['t-old', 50]]);
  // A change that was still waiting for its save: the flush stamps it.
  persist(); now = 2_000;
  persist(true, { flush: true });
  assert.deepEqual(puts.at(-1), ['t-old', 2_000]);
  assert.equal(timer, null, 'and the waiting save is not run twice');
  now = 3_000;
  persist(true, { flush: true });
  assert.deepEqual(puts.at(-1), ['t-old', 2_000], 'nothing waiting any more');
  // Still generating: every flush is a real save (the partial answer changed).
  live.set('t-old', old); now = 4_000;
  persist(true, { flush: true });
  assert.deepEqual(puts.at(-1), ['t-old', 4_000]);
  live.clear();
  // Real saves stamp as they always did: the timer's, and persist(true) after a send.
  persist(); now = 5_000; timer();
  assert.deepEqual(puts.at(-1), ['t-old', 5_000]);
  now = 6_000; persist(true);
  assert.deepEqual(puts.at(-1), ['t-old', 6_000]);
  // A thread that never had a time gets one.
  S.thread = { id: 't-new', entries: [{ id: 'e' }] };
  persist(true, { flush: true });
  assert.deepEqual(puts.at(-1), ['t-new', 6_000]);
  // A save that waited on an empty thread is no change to the next thread flushed (it was one flag for all).
  S.thread = { id: 't-empty', entries: [] }; persist();
  S.thread = old; now = 7_000;
  persist(true, { flush: true });
  assert.deepEqual(puts.at(-1), ['t-old', 6_000]);
  // The five ways out flush; everything else saves.
  for (const line of [/async function openThread\(id(?:, day = null)?\) \{\n  persist\(true, \{ flush: true \}\);/, /function startFresh\(\) \{\n  persist\(true, \{ flush: true \}\);/, /if \(document\.visibilityState === 'hidden'\) \{ persist\(true, \{ flush: true \}\); Sync\.flush\(\); \}/, /const flushed = persist\(true, \{ flush: true \}\);/, /Promise\.resolve\(\)\.then\(\(\) => persist\(true, \{ flush: true \}\)\)/,
    /function flushOpen\(\) \{ persist\(true, \{ flush: true \}\); \}/]) assert.match(APP, line); // Today's ways out (+ Flow, All, ◀ ▶, In:) share flushOpen
  assert.equal(APP.split('persist(true, { flush: true })').length - 1, 6);
});

// ── app-1 #4: the Threads search ──
test('app-1 #4: typing in the Threads search filters the rows already read; "Storage is busy" is not said for every slow read', async () => {
  let reads = 0, slow = false, now = 100_000;
  const toasts = [], rows = [{ id: 'a', entries: [{}], updatedAt: 2 }, { id: 'b', entries: [{}], updatedAt: 1 }];
  const vars = lift({ S: { thread: null }, ClaudeImport: { listAt: (t) => t.updatedAt || 0 }, toast: (m) => toasts.push(m), busyToastAt: 0, Date: { now: () => now },
    DB: { all: () => { reads++; return slow ? new Promise(() => {}) : Promise.resolve(rows); } }, sleep: () => Promise.resolve() }, 'allThreads');
  const first = await vars.allThreads();
  assert.equal(first.saved, rows, 'the rows as read, for the drawer to keep');
  const again = await vars.allThreads(first.saved);
  assert.deepEqual([reads, again.map((t) => t.id)], [1, ['a', 'b']], 'given rows are used: no second read');
  // Three slow reads in a row: one toast. Another after half a minute.
  slow = true;
  for (let i = 0; i < 3; i++) assert.equal((await vars.allThreads()).saved, null);
  assert.equal(toasts.length, 1);
  now += 31_000;
  await vars.allThreads();
  assert.equal(toasts.length, 2);
  // The drawer keeps its rows while it is open, and typing, a new order, Clear and a folded heading draw from them.
  const render = fnSource('renderThreads');
  assert.match(render, /let all = await allThreads\(Array\.isArray\(known\) \? known : fromSorter === true && threadRows \? threadRows : undefined\);/);
  assert.match(render, /if \(all\.saved && !\$\('#threadsDrawer'\)\.hidden\) threadRows = all\.saved;/);
  assert.match(APP, /\$\('#threadSearch'\)\.addEventListener\('input', \(\) => \{ clearTimeout\(searchTimer\); searchTimer = setTimeout\(\(\) => renderThreads\(false, threadRows\), 120\); \}\);/);
  assert.doesNotMatch(APP, /addEventListener\('input', renderThreads\)/, 'never a read per key');
  assert.match(fnSource('closeDrawers'), /clearTimeout\(searchTimer\); threadRows = null;/, 'the rows (every thread’s media) go when the drawer closes');
  assert.match(fnSource('openDrawer'), /if \(id === 'threadsDrawer'\) \{ [^\n]*renderThreads\(\); \}/, 'opening the drawer reads');
  assert.match(fnSource('threadsArrived'), /if \(!\$\('#threadsDrawer'\)\.hidden\) renderThreads\(\);/, 'so does a change that arrives');
});

test('files-v113 #1: a provider’s "too long" answer is said in plain words, with the way forward', async () => {
  class ApiError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; if (extra) Object.assign(this, extra); } }
  const vars = { ApiError, noteAllowance() {}, appOutdated() {}, isTesterCode: () => false, GUARD_CODES: new Set(), S: { tester: null }, TOO_LONG: new Function(`return ${/\nconst TOO_LONG = (\/[^\n]*\/i);\n/.exec(APP)[1]}`)() };
  const { toApiError } = lift(vars, 'toApiError');
  const res = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  const plain = 'This thread is too long for this model. Start a new thread, or attach less.';
  for (const [status, body] of [
    [400, { error: { message: 'prompt is too long: 213456 tokens > 200000 maximum' } }],
    [400, { error: { message: 'input length and `max_tokens` exceed context limit: 190000 + 64000 > 200000, decrease input length or `max_tokens` and try again' } }],
    [400, { error: { message: "This model's maximum context length is 128000 tokens. However, your messages resulted in 301245 tokens. Please reduce the length of the messages.", code: 'context_length_exceeded' } }],
    [400, [{ error: { message: 'The input token count (1205331) exceeds the maximum number of tokens allowed (1048576).' } }]],
    [400, { error: "This model's maximum prompt length is 131072 but the request contains 250000 tokens." }],
    [413, { error: 'The request exceeds the context window of this model.' }],
  ]) {
    const err = await toApiError(res(status, body));
    assert.equal(err.message, plain, JSON.stringify(body).slice(0, 60));
    assert.equal(err.status, status);
  }
  // Not these: a complaint about the answer's room, an ordinary bad request, a too-large image body.
  assert.match((await toApiError(res(400, { error: { message: 'max_tokens: 200000 > 128000, which is the maximum allowed number of output tokens' } }))).message, /^Request failed \(400\)\. max_tokens/);
  assert.match((await toApiError(res(400, { error: { message: 'messages: at least one message is required' } }))).message, /^Request failed \(400\)\./);
  assert.match((await toApiError(res(413, { error: 'This image request is too large.' }))).message, /This image request is too large\./);
  assert.match((await toApiError(res(500, { error: { message: 'prompt is too long' } }))).message, /^The AI provider had a hiccup\./, 'only a 400 or 413');
});


test('app-2 #8: a reloaded extension drops the local link, says to reload the tab, and the relay is tried next time', async () => {
  const toasts = [];
  const vars = lift({ EXT: { ready: true, version: '1.4.0' }, REMOTE: { online: false, checked: 99 }, renderOptions: () => {}, toast: (m) => toasts.push(m),
    extLocal: async () => { throw new Error('Extension error: Extension context invalidated.'); }, fetch: async () => { throw new Error('relay not expected'); } }, 'extCall');
  await assert.rejects(vars.extCall('browser_open', {}), /Reload the Atelier tab to reconnect it\./);
  assert.equal(vars.EXT.ready, false);
  assert.equal(vars.REMOTE.checked, 0, 'the relay status is checked again at once');
  assert.deepEqual(toasts, ['Atelier Browser was reloaded. Reload this tab to reconnect it.']);
  // Any other failure passes through as it was, and the link stays.
  vars.EXT.ready = true; vars.extLocal = async () => { throw new Error('The browser took too long to respond.'); };
  await assert.rejects(vars.extCall('browser_read', {}), /took too long/);
  assert.equal(vars.EXT.ready, true);
  assert.match(APP, /then reload this tab\.`, \{ ms: 15000/);
});

test('app-1 #8: a long prompt opens from the keyboard, and a drag that selects its text leaves it as it was', () => {
  assert.match(APP, /<h2 class="prompt" title="Click to expand" tabindex="0" aria-expanded="false">/);
  const vars = lift({}, 'togglePrompt');
  const attrs = {}, cls = new Set();
  const p = { classList: { toggle: (c) => (cls.has(c) ? (cls.delete(c), false) : (cls.add(c), true)) }, setAttribute: (k, v) => { attrs[k] = v; } };
  vars.togglePrompt(p); assert.equal(attrs['aria-expanded'], 'true');
  vars.togglePrompt(p); assert.equal(attrs['aria-expanded'], 'false');
  assert.match(APP, /\(ev\.key === 'Enter' \|\| ev\.key === ' '\) && ev\.target\.matches\?\.\('\.prompt'\)/);
  assert.match(APP, /if \(p && \(getSelection\(\)\?\.isCollapsed \?\? true\)\) togglePrompt\(p\);/);
});

test('app-1 #7: only <think> blocks at the start are reasoning; an answer that quotes the tags keeps its text', async () => {
  const { splitThink } = lift({}, 'splitThink');
  const { stripThink } = await import('../public/context.js');
  const quoted = 'Strip them with re.sub(r"<think>.*?</think>", "", s).';
  assert.deepEqual(splitThink(quoted), { think: '', text: quoted });
  assert.equal(stripThink(quoted), quoted);
  // Two rounds of reasoning before the answer: both leave the answer, on screen and in Copy.
  assert.deepEqual(splitThink('<think>a</think>\n<think>b</think>\nDone'), { think: 'a\n\nb', text: 'Done', open: false });
  assert.equal(stripThink('<think>a</think>\n<think>b</think>\nDone').trim(), 'Done');
  // Still streaming, and the no-opening-tag form some models send.
  assert.deepEqual(splitThink('<think>still going'), { think: 'still going', text: '', open: true });
  assert.deepEqual(splitThink('reasoning</think>Answer'), { think: 'reasoning', text: 'Answer' });
});

test('app-3 #9: a new Google Photos pick ends the wait of the one before it, which then stays quiet and leaves the window alone', () => {
  const pick = APP.slice(APP.indexOf('async function pickGooglePhotos'), APP.indexOf("$('#fileInput').onchange"));
  assert.ok(pick.length > 500);
  assert.match(APP, /let photosPick = 0;\r?\nasync function pickGooglePhotos\(email\) \{/);
  assert.match(pick, /let session;\r?\n\s+const mine = \+\+photosPick;\r?\n\s+try \{/);
  assert.match(pick, /while \(!st\.mediaItemsSet && Date\.now\(\) < until && mine === photosPick\) \{/);
  assert.match(pick, /if \(mine !== photosPick\) return; \/\/ a newer pick took over[^\n]*\n\s+if \(!st\.mediaItemsSet\) return toast\('Google Photos: nothing picked'\);/);
  assert.match(pick, /\} catch \(err\) \{\r?\n\s+if \(mine !== photosPick\) return;[^\n]*\n\s+win\?\.close\(\);/);
  assert.doesNotMatch(pick, /win\.closed/, 'Google’s page can cut the link to its window, which reads as closed while the owner picks');
});

test('media #6, #1: a failed save of a paid clip rejects as resumable, the job id goes only once the clip is in, and a kept recording offers Send again', async () => {
  const src = /const blobToDataUrl = [^\n]+/.exec(APP)[0];
  class FileReader { readAsDataURL() { queueMicrotask(() => this.onerror()); } }
  const blobToDataUrl = new Function('FileReader', `${src}; return blobToDataUrl;`)(FileReader);
  await assert.rejects(blobToDataUrl({}), (err) => err.resumable === true && /won’t make a new video/.test(err.message));
  assert.match(APP, /e\.media = \[\{ type: 'video', src: await blobToDataUrl\(out\.blob\) \}\];\r?\n\s+delete e\.runway;/);
  assert.match(APP, /e\.media = \[\{ type: 'video', src: await blobToDataUrl\(out\.blob\) \}\];\r?\n\s+delete e\.xaiJob;/);
  assert.match(APP, /const src = await blobToDataUrl\(out\.blob\);[^\n]*\r?\n\s+e\.omni = \{ id: out\.id, at: e\.omni\?\.at \|\| Date\.now\(\), done: true \};/);
  assert.match(APP, /resetsAt: err\.resetsAt, \.\.\.\(err\.resumable \? \{ resumable: true \} : \{\}\) \}\);/);
  assert.match(APP, /o\?\.retry \? \{ \.\.\.o, ms: 9000, action: \{ label: 'Send again', onClick: \(\) => \{ dictation\.retry\(\); \} \} \} : o/);
});

test('ui #4, #12, Messages row: the browser bar follows the chosen theme, the token dialog is named, the Messages row says when it does not ask', () => {
  const metas = [{ media: '(prefers-color-scheme: dark)', content: '' }, { media: '(prefers-color-scheme: light)', content: '' }];
  const S = { settings: { theme: 'light' } };
  const html = { dataset: {} };
  const { applyTheme } = lift({ S, THEME_BG: { dark: '#0e0d0b', light: '#f3eee3' }, document: { documentElement: html, querySelectorAll: () => metas } }, 'applyTheme');
  applyTheme();
  assert.deepEqual(metas.map((m) => m.content), ['#f3eee3', '#f3eee3']);
  S.settings.theme = 'auto'; applyTheme();
  assert.deepEqual(metas.map((m) => m.content), ['#0e0d0b', '#f3eee3']);
  assert.equal(html.dataset.theme, undefined);
  assert.match(APP, /const THEME_BG = \{ dark: '#0e0d0b', light: '#f3eee3' \};/);
  assert.match(APP, /dlg\.setAttribute\('aria-labelledby', 'tokTitle'\);\r?\n\s+dlg\.innerHTML = `<form method="dialog"><h3 id="tokTitle">/);
  assert.match(APP, /approveAll\(\) \? 'Atelier can read your texts here and send them\. Approve everything is on, so it doesn’t ask\.'/);
});
