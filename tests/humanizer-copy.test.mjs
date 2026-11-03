// Cole's humanizer (public/humanizer.js, copied from coleos-api/src/worker.js) in Atelier, both halves of the owner's
// choice:
//   1. Atelier's own copy follows the rules: the visible text of /privacy, /tos and index.html (the boot screen's text
//      included), the user-visible strings of every client module and the Worker's error messages pass the mechanical
//      lint — no banned word, no sentence over 16 words, and none of the pattern warnings, short of a small allow-list
//      where each line says why.
//   2. Writing in Cole's name gets the rules in its system prompt: "As me" (voiceBlock, the 'write' role) and the
//      accounts agent's tool arguments that go out under his name (nameRules). Ask, Code, Web, Ideas, Build, the helpers
//      and titles never do, nor a tester. The rules are static, so those system prompts stay byte-identical turn to turn.
// No provider is ever called: /api/chat is a mock that answers with a canned stream.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { HUMANIZER } from '../public/humanizer.js';
import { problems, htmlText, shownStrings, literals, declarations, sentences, words, HUMANIZER_BANNED, HUMANIZER_WARN, MAX_WORDS } from './humanizer-lint.mjs';
import { CANONICAL, canonicalText, moduleSource, currentText, lintDrift, lineDiff } from '../scripts/sync-humanizer.mjs';
import {
  buildHistory, followUpRoute, photoFollowUp, mediaTurn, CTX_IMAGES, threadTaint, ownTaint, taintGates, taintNote, readsPage, pageOrigin,
  worseTaint, withSent, runStart, memoryAnchor, factsFor, heldForRun, TESTER_HISTORY,
} from '../public/context.js';
import { readUsage, addUsage, cacheKey } from '../public/usage.js';
import { isTesterCode } from '../public/tester.js';

const read = async (p) => (await readFile(new URL(`../${p}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const APP = await read('public/app.js');

// ── public/humanizer.js: the canonical text, byte for byte ──
test('public/humanizer.js holds the canonical HUMANIZER text and names where and when it was copied', async () => {
  const src = await read('public/humanizer.js');
  assert.match(src, /^\/\/ Source: const HUMANIZER in ~\/OneDrive\/Documents\/Claude\/Projects\/Coen Business\/coleos-api\/src\/worker\.js, copied (\d{4}-\d{2}-\d{2})\.$/m);
  const date = /copied (\d{4}-\d{2}-\d{2})\./.exec(src)[1];
  assert.equal(src, moduleSource(HUMANIZER, date), 'exactly what scripts/sync-humanizer.mjs writes');
  // the header names the code that uses it: each name is a function or constant in app.js
  const named = [...src.split('\nexport ')[0].matchAll(/\(([\w, ]+)\)/g)].flatMap((m) => m[1].split(/,\s*/));
  assert.deepEqual(named, ['voiceBlock', 'nameRules', 'SENT_AS_THEM']);
  for (const n of named) assert.match(APP, new RegExp(`^(?:function ${n}\\(|const ${n} = )`, 'm'), `app.js has ${n}`);
  assert.equal(currentText(src), HUMANIZER);
  assert.ok(HUMANIZER.startsWith("WRITING RULES (Cole's humanizer). Everything you write follows them."));
  for (const rule of ['1. No importance sentences', '2. No AI vocabulary', '3. No contrast structures', '4. No vague authority', '5. No summary endings', '6. Specifics over general claims', '7. No sentence over 16 words.', '8. Delete any sentence', '9. No motivational tone', '10. Make it sound like a message sent to one person', 'No formatting tricks and no bold.'])
    assert.ok(HUMANIZER.includes(rule), rule);
  assert.ok(HUMANIZER.endsWith('→ cut it; the facts already said so.'));
  // the checkout is on the owner's machine: the copy is the canonical text and the lint port matches its patterns
  if (existsSync(CANONICAL)) {
    const canon = await readFile(CANONICAL, 'utf8');
    assert.equal(HUMANIZER, canonicalText(canon), `public/humanizer.js drifted from ${CANONICAL}: run node scripts/sync-humanizer.mjs`);
    assert.deepEqual(await lintDrift(canon), [], 'tests/humanizer-lint.mjs ports the canonical patterns as they are');
  }
});

test('scripts/sync-humanizer.mjs: reads the template exactly, refuses one it can’t copy, and diffs by line', () => {
  const worker = 'const A = 1;\nconst HUMANIZER = `RULES\n1. One.\n2. Two.`;\nconst B = 2;\n';
  assert.equal(canonicalText(worker), 'RULES\n1. One.\n2. Two.');
  assert.equal(canonicalText(worker.replace(/\n/g, '\r\n')), 'RULES\n1. One.\n2. Two.', 'CRLF checkouts read the same');
  assert.throws(() => canonicalText('const X = 1;\n'), /no `const HUMANIZER/);
  assert.throws(() => canonicalText('\nconst HUMANIZER = `a ${b}`;\n'), /copy it by hand/);
  assert.equal(currentText(moduleSource('RULES\n1. One.', '2026-10-11')), 'RULES\n1. One.');
  assert.equal(lineDiff('a\nb\nc', 'a\nB\nc'), '  a\n- b\n+ B\n  c');
  assert.equal(lineDiff('1\n2\n3\n4\n5', '1\n2\n3\n4\n6'), '  4\n- 5\n+ 6', 'one line of context');
});

test('the app loads it like every module: imported at ?v=, precached by sw.js, syntax-checked by npm run check', async () => {
  const sw = await read('public/sw.js'), pkg = JSON.parse(await read('package.json'));
  const v = /const VERSION = 'atelier-v(\d+)'/.exec(sw)[1];
  assert.match(APP, new RegExp(`^import \\{ HUMANIZER \\} from '\\./humanizer\\.js\\?v=${v}';$`, 'm'));
  assert.ok(sw.includes('`/humanizer.js?v=${V}`'), 'precached at its ?v= URL');
  assert.match(pkg.scripts.check, /node --check public\/humanizer\.js/);
});

// ── 1. the lint over Atelier's own copy ──
// Declarations whose text only the model or the code reads (prompts, tool descriptions, model notes, the price table's
// sourcing notes), and the humanizer itself (it quotes the misses it fixes): out of the copy lint.
const HIDDEN = {
  'public/app.js': ['EMPTY_NUDGE', 'persona', 'ACCURACY', 'NO_FABRICATION', 'capabilities', 'dateLine', 'AS_GIVEN', 'voiceBlock', 'SENT_AS_THEM', 'nameRules', 'SYS', 'BROWSER_TOOLS'],
  'public/humanizer.js': ['HUMANIZER'],
  'public/remix.js': ['COMPACT', 'remixSystem', 'remixUser', 'reviseSystem', 'reviseUser', 'shotPrompt', 'CAMERA_TEXT', 'SHOT_NEGATIVE'],
  'public/video.js': ['videoParts'],
  'src/transcribe.js': ['GEMINI_STT_PROMPT'],
  'src/tester/prices.js': ['TABLE'],
};
// Hidden declarations that hold shown text too: a BROWSER_TOOLS row is [name, label, write, desc, …], and the label
// becomes the tool's x-label on approval cards and step rows. The rest of the row is for the model.
const LABELS = { 'public/app.js': { BROWSER_TOOLS: /(?:^|\n)\s*\[\s*'\w+',\s*$/ } };
// The only lines that may break a rule, each with its reason. Kept small: anything else gets rewritten.
const ALLOW = [
  { file: 'privacy.html', rule: 'length', text: 'use and transfer to any other app of information received from Google APIs will adhere to the Google API Services User Data Policy',
    reason: 'Google’s prescribed Limited Use disclosure (29 words), kept word for word: OAuth verification checks for this wording, and splitting it could weaken the disclosure.' },
];
const allowed = (file, p) => ALLOW.find((a) => a.file === file && a.rule === p.rule && p.text.includes(a.text));

async function copyBlocks() {
  const out = [];
  for (const page of ['privacy.html', 'tos.html', 'index.html']) {
    const html = await read(`public/${page}`);
    for (const text of htmlText(html)) out.push({ file: page, where: page, text });
    if (page === 'index.html') {
      const boot = /<script id="bootWatch">([\s\S]*?)<\/script>/.exec(html)[1];
      for (const s of shownStrings(boot)) out.push({ file: page, where: `index.html bootWatch +${s.line}`, text: s.text });
    }
  }
  // the client modules, and the Worker's: its error messages and notes reach the app's error cards and approval steps
  const js = async (dir) => (await readdir(new URL(`../${dir}/`, import.meta.url))).filter((f) => f.endsWith('.js')).sort().map((f) => `${dir}/${f}`);
  const mods = [...await js('public'), ...await js('src'), ...await js('src/tester')];
  for (const f of mods) {
    const file = f.replace(/^public\//, ''), src = await read(f);
    for (const s of shownStrings(src, { hidden: HIDDEN[f] || [], server: f.startsWith('src/') })) out.push({ file, where: `${f}:${s.line}`, text: s.text });
    const declOf = declarations(src);
    for (const [decl, row] of Object.entries(LABELS[f] || {}))
      for (const l of literals(src)) if (declOf(l.line) === decl && row.test(l.prefix)) out.push({ file, where: `${f}:${l.line} (${decl} label)`, text: l.text });
  }
  return out;
}

test('Atelier’s own copy passes the humanizer lint: no banned word, no sentence over 16 words, no pattern warning', async () => {
  const blocks = await copyBlocks();
  const count = (f) => blocks.filter((b) => b.file === f).length;
  // the extractors still find the copy (a broken one would pass everything)
  for (const [f, min] of Object.entries({ 'privacy.html': 120, 'tos.html': 40, 'index.html': 280, 'app.js': 1000, 'remix-app.js': 200, 'sync.js': 100, 'runway.js': 80, 'readaloud.js': 40, 'dictate.js': 30, 'launch.js': 30, 'lookup.js': 30, 'src/tools.js': 150, 'src/tester/router.js': 20 }))
    assert.ok(count(f) >= min, `${f}: ${count(f)} blocks of copy found, expected at least ${min}`);
  assert.ok(blocks.some((b) => b.file === 'src/tester/router.js' && /^This request is bigger than one tester call allows\./.test(b.text)), 'a tester’s budget error is linted');
  assert.ok(!blocks.some((b) => b.file === 'src/tools.js' && /^Save an email as a draft in Gmail/.test(b.text)), 'tool descriptions (for the model) are not');
  assert.ok(!blocks.some((b) => b.file === 'src/tools.js' && /approval in the app\.$/.test(b.text)), 'nor a tool result for the model');
  for (const t of ['I have 25 tester spots. The paid models are on me.', 'I built Atelier for my own work: answers, code, images, video, ideas and small apps.', 'Theme and model choices stay on this device.'])
    assert.ok(blocks.some((b) => b.file === 'index.html' && b.text === t), `index.html: “${t}” is linted`);
  assert.ok(blocks.some((b) => /^I’m Cole Ciprari\. I built Atelier for myself/.test(b.text)), 'the og:description pitch is linted');
  assert.ok(blocks.some((b) => b.where.includes('bootWatch') && /safe on this device/.test(b.text)), 'the recovery screen is linted');
  // shown strings the first extractor skipped: a toast that says JSON, text set inside a listener, an error's fallback
  for (const [f, t] of [['app.js', 'That file isn’t valid JSON. Nothing was imported.'], ['app.js', 'The tester data that was on this device is gone.'], ['feedback.js', 'Couldn’t load this screenshot. Close and reopen to try again.']])
    assert.ok(blocks.some((b) => b.file === f && b.text === t), `${f}: “${t}” is linted`);
  // and the v92 review's: the Worker's Response error (the passcode screen shows guard.js's), a lowercase reason a toast
  // shows (the OAuth callback's fail()), and every browser tool's label (BROWSER_TOOLS stays hidden: its descriptions
  // are for the model)
  for (const [f, t] of [['src/guard.js', 'Atelier couldn’t check the passcode'], ['src/worker.js', 'sign-in link expired']])
    assert.ok(blocks.some((b) => b.file === f && b.text.startsWith(t)), `${f}: “${t}…” is linted`);
  // …and the round-2 rework's: copy that starts like SQL (Look up's error, a tool's label), never a passed key check's note
  for (const [f, t] of [['src/lookup.js', 'Select a word or a short name to look up.'], ['src/tools.js', 'Create GitHub issue']])
    assert.ok(blocks.some((b) => b.file === f && b.text === t), `${f}: “${t}” is linted`);
  assert.ok(!blocks.some((b) => b.file === 'src/xai.js' && b.text === 'key active'), 'an ok: true check shows no message');
  const browser = [...APP.matchAll(/^ {2}\['browser_\w+', '([^']+)',/gm)].map((m) => m[1]);
  assert.ok(browser.length >= 7 && browser.includes('Click in your browser'), `BROWSER_TOOLS labels: ${browser.join(', ')}`);
  for (const t of browser) assert.ok(blocks.some((b) => b.where.endsWith('(BROWSER_TOOLS label)') && b.text === t), `the browser label “${t}” is linted`);
  assert.ok(!blocks.some((b) => b.file === 'app.js' && /^Click an element on a page\./.test(b.text)), 'its descriptions are not');
  const used = new Set(), fails = [];
  for (const b of blocks) for (const p of problems(b.text)) {
    const a = allowed(b.file, p);
    if (a) used.add(a); else fails.push(`${b.where} [${p.rule}${p.words ? `, ${p.words} words` : ''}] ${p.text}`);
  }
  assert.deepEqual(fails, [], `copy that breaks the humanizer:\n${fails.join('\n')}`);
  for (const a of ALLOW) {
    assert.ok(used.has(a), `allow-list entry no longer needed (remove it): ${a.file} “${a.text}”`);
    assert.ok(a.reason.length >= 40, 'each allowed line says why');
  }
  assert.ok(ALLOW.length <= 5, 'the allow-list stays small');
});

// The rules the regexes can't check (a concession kept with "still", an unproven "best", a stock phrase, emphasis bold,
// a claim wider than the code): the v92 review's fixes, held in place.
test('copy the lint can’t judge: the review’s fixes stay fixed', async () => {
  const HTML = await read('public/index.html');
  assert.match(APP, /\n {2}expired: 'Your tester session ended\. Sign in with LinkedIn again to continue\.',\n/);
  assert.doesNotMatch(APP + HTML, /pick up where you left off/i);
  assert.match(APP, /<span>Auto picks a model for each request\. The menus above the prompt let you choose\.<\/span>/);
  assert.doesNotMatch(APP, /Auto picks the best/);
  assert.match(APP, / Atelier locks out repeated wrong guesses\. For more safety, use 12 or more characters, like four unrelated words\. /);
  assert.doesNotMatch(APP, /still much safer/);
  assert.match(HTML, /<li>On the iPhone, sign in to Atelier in Safari\.<\/li>/);
  assert.doesNotMatch(HTML, /<b>Safari<\/b>/);
  // the Settings footer shows under every tab, Connections and the server-side tester limits included: it claims only
  // what Save keeps on the device (S.settings in localStorage), as sync.js's footnote does
  assert.match(HTML, /<footer class="sheet-foot">\s*<span class="hint">Theme and model choices stay on this device\.<\/span>/);
  assert.match(APP, /settings: mergeDeep\(structuredClone\(DEFAULT_SETTINGS\), migrateSettings\(LS\.get\('settings', \{\}\)\)\)/);
  assert.match(await read('public/sync.js'), /Settings, model choices and theme stay on each device\./);
  // the Photos Picker error (src/worker.js), both branches rendered: with Google's project number and without one
  const line = (await read('src/worker.js')).split('\n').find((l) => l.includes('Google says the Photos Picker API'));
  const render = new Function('project', `return ${/msg = (`.*`);\s*$/.exec(line)[1]};`);
  for (const project of ['123456789012', undefined]) {
    const msg = render(project);
    assert.match(msg, project ? /^Google says the Photos Picker API is off in project 123456789012\. That project owns your OAuth client\. / : /^Google says the Photos Picker API is off in the project that owns your OAuth client\. /);
    assert.deepEqual(problems(msg), [], msg);
  }
});

test('the lint port: banned words, the 16-word rule and every pattern warning fire; ordinary copy passes', () => {
  const rules = (s) => problems(s).map((p) => p.rule);
  assert.deepEqual(rules('A seamless way to enhance the landscape.'), ['banned', 'banned', 'banned']);
  assert.deepEqual(rules('Turn the phone to landscape mode.'), [], 'landscape mode is a setting');
  const sixteen = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen.';
  assert.deepEqual(rules(sixteen), []);
  assert.deepEqual(rules(sixteen.replace('.', ' seventeen.')), ['length']);
  assert.deepEqual(rules('First line.\nSecond line.'), [], 'blocks split at line breaks');
  const fire = {
    "contrast structure (It's not X, it's Y)": 'It’s not a tool, it’s a studio.',
    "contrast structure (It's not X. It's Y.)": 'This isn’t a chat app. It’s a studio.',
    "contrast structure (I can X. I cannot Y.)": 'I can read it. I can’t send it.',
    'contrast structure (not just X)': 'It does not just answer.',
    'contrast structure (Despite this)': 'Despite this, it works.',
    'contrast structure (Not A. Not B.)': 'Not a toy. Not a demo.',
    'contrast structure (X, not Y)': 'It runs here, not in the cloud.',
    'vague authority': 'Experts say it helps.',
    'summary ending': 'Overall, it works.',
    'importance sentence': 'This matters because it saves time.',
  };
  assert.deepEqual(Object.keys(fire), HUMANIZER_WARN.map(([, label]) => label), 'one example for each canonical warning');
  for (const [label, s] of Object.entries(fire)) assert.ok(rules(s).includes(label), `${label}: ${s}`);
  assert.deepEqual(rules('Saved on this device. Not synced yet, but it will be.'), [], 'a single "not" is fine');
  assert.equal(MAX_WORDS, 16);
  assert.equal(words('Settings → Privacy → Export data.'), 4, 'arrows and dots are not words');
  assert.deepEqual(sentences('e.g. one. Two? “Three.” Four'), ['e.g.', 'one.', 'Two?', '“Three.”', 'Four']);
  assert.ok(HUMANIZER_BANNED.global && HUMANIZER_BANNED.ignoreCase);
});

test('the extractors: a page’s visible text and shown attributes; a module’s copy, never its keys, selectors or prompts', () => {
  const page = htmlText(`<html><head><title>Atelier</title><meta name="description" content="A studio."><style>p{color:red}</style><script>var x = 'Hidden prompt text.';</script></head>
    <body><!-- a note --><p>One <b>bold</b> sentence
    across lines.</p><button title="Open it" aria-label="Open">Go</button><input placeholder="Type here"><svg><text>Not copy</text></svg></body></html>`);
  assert.deepEqual(page, ['Atelier', 'One bold sentence across lines.', 'Go', 'A studio.', 'Open it', 'Open', 'Type here']);
  const src = `
const KEY = 'atelier.settings';
const SYS = { ask: () => \`You are Atelier. Help the user.\` };
function show(n) {
  toast(n > 1 ? \`Saved \${n} threads.\` : 'Saved.');
  $('#x').classList.add('is-on');
  document.querySelector('.thread-list li');
  el.title = 'Copy the link';
  throw new ApiError(400, 'That file is too big.');
  return \`<p class="hint">Tap <b>Send</b> to go.</p>\`;
}
const re = /it's not/g;
const MSG = Object.freeze({ busy: 'Busy right now. Try again soon.' });`;
  const got = shownStrings(src, { hidden: ['SYS'] }).map((s) => s.text);
  assert.deepEqual(got, ['Saved X threads.', 'Saved.', 'Copy the link', 'That file is too big.', 'Tap Send to go.', 'Busy right now. Try again soon.']);
  // a Worker module: its errors count; tool and parameter descriptions and SQL don't
  const worker = `
const tools = { gmail_send: { label: 'Send email', desc: 'Send an email from one of the connected accounts, as a reply when asked.', params: obj({ to: S('Recipient(s)') }),
  run: async () => { throw new ToolError('Gmail isn’t connected. Connect it in Settings.'); } } };
const q = 'SELECT name FROM testers WHERE sub = ?';`;
  assert.deepEqual(shownStrings(worker, { server: true }).map((s) => s.text), ['Send email', 'Gmail isn’t connected. Connect it in Settings.']);
  // its usual error shape counts too: the error in new Response(JSON.stringify({ error })), and a Response's text body.
  // A code, a model id and a provider request's content don't.
  const errors = shownStrings(`const down = () => new Response(JSON.stringify({ error: 'A seamless thing broke.', code: 'guard_down' }), { status: 503 });
const unpaired = () => new Response('Browser not paired — open Atelier to pair it.', { status: 401 });
const ping = JSON.stringify({ model: 'glm-4.7-flash', messages: [{ role: 'user', content: 'Say hi to them.' }] });`, { server: true }).map((s) => s.text);
  assert.deepEqual(errors, ['A seamless thing broke.', 'Browser not paired — open Atelier to pair it.']);
  assert.deepEqual(problems(errors[0]).map((p) => p.rule), ['banned']);
  // …lowercase and unpunctuated too, the way most of the Worker's errors read, and through its json() helper
  const lower = shownStrings(`const a = () => new Response(JSON.stringify({ error: 'seamless sync failed', code: 'guard_down' }), { status: 500 });
const b = () => json({ error: 'seamless sync failed' }, 500);
const c = () => new Response('seamless sync failed', { status: 500 });`, { server: true }).map((s) => s.text);
  assert.deepEqual(lower, ['seamless sync failed', 'seamless sync failed', 'seamless sync failed']);
  assert.deepEqual(problems(lower[0]).map((p) => p.rule), ['banned']);
  // the tokenizer keeps strings, templates and regex literals apart, and knows the call each literal sits in; a ${…}
  // reads as the string in it with the most words (a call's argument too: esc(err.message || 'Couldn’t load.')), or X
  const lits = literals('a = b / 2; toast(`x ${f("y")} z ${n}`); c = /"/.test(d) ? "q" : `w`;');
  assert.deepEqual(lits.map((l) => [l.text, l.calls.at(-1) ?? '']), [['y', 'f'], ['x y z X', 'toast'], ['q', ''], ['w', '']]);
  assert.equal(lits[1].shape, 'x X z X');
  assert.equal(lits[0].outer, lits[1], 'the template whose ${…} holds it');
  assert.equal(lits[0].branch, false, '…as a call’s argument, not as its value');
  // a '+' chain is one literal, after its operands' literals (as a template comes after its ${…}'s), each other operand
  // read as a ${…} is (a call's argument in it too, a group as its string with the most words), and what comes before
  // the first piece is one operand (n + m may be a sum)
  assert.deepEqual(literals("a = 'x ' + n + ' y'; b = n + ' items'; c = 'k ' + f('z') + 'w'; d = ['p' + 'q', 'r'];\ne = 'one ' +\n  'two';").map((l) => l.text), ['x X y', 'X items', 'z', 'k zw', 'pq', 'r', 'one two']);
  assert.deepEqual(literals("f = 'a ' + b + (c ? ' d e' : '') + '.'; g = n + m + ' items';").map((l) => l.text), [' d e', '', 'a X d e.', 'X items']);
  // never a comparand, an array's item, an index or an object's key or value; a lookup's values are what it reads as
  const reads = (src) => literals(src).at(-1).text;
  assert.equal(reads("t = `${e.code === 'quota hit now' ? 'Quota hit' : 'Failed'}, try later`;"), 'Quota hit, try later');
  assert.equal(reads("t = 'Mode: ' + (['sync mode on', 'b'].includes(m) ? 'on' : 'off');"), 'Mode: off');
  assert.equal(reads("t = `Mode: ${labels['sync mode on']}`;"), 'Mode: X');
  assert.equal(reads("t = `${fmt(d, { hour: 'numeric two' })} · back`;"), 'X · back');
  assert.equal(reads("t = `${{ day: 'Used up today', pool: 'Tester budget used up' }[out]} · back`;"), 'Tester budget used up · back');
  assert.equal(reads("t = 'Failed: ' + ({ 'quota hit now': 'quota' })[code];"), 'Failed: quota');
  assert.equal(reads("t = 'Mode: ' + ['sync mode on', 'off'][i];"), 'Mode: sync mode on');
});

test('the extractor reads what a person sees: a toast or error whatever its words, text set in a callback, String.replace’s text, a ${…} or a + chain as one sentence', () => {
  const got = (src, o) => shownStrings(src, o).map((s) => s.text);
  // FOR_MODEL words skip a prompt, never a toast, an error or an element's text
  assert.deepEqual(got(`function a() {
  toast('Exported a JSON file of every thread.');
  throw new ApiError(400, 'You are signed out. Sign in again.');
  el.textContent = 'Saved for the user on this device.';
  const p = 'You are a helper. Return ONLY JSON.';
}`), ['Exported a JSON file of every thread.', 'You are signed out. Sign in again.', 'Saved for the user on this device.']);
  // …nor copy held in a variable first ("JSON" alone is no prompt), put in by a DOM method, or in a ${…} of a template
  // an element shows. A prompt that says what to answer with stays out.
  assert.deepEqual(got(`const done = 'Exported a JSON file of every thread.'; toast(done);
box.insertAdjacentHTML('beforeend', '<p class="hint">You are offline. Atelier syncs when you reconnect.</p>');
note.append('You are signed out of Gmail.');
el.innerHTML = \`<p>\${on ? 'You are signed in on this device.' : 'Sign in to sync.'}</p>\`;
const fix = [{ role: 'system', content: 'You fix JSON syntax only. Return only the corrected JSON object.' }];`), ['Exported a JSON file of every thread.', 'You are offline. Atelier syncs when you reconnect.', 'You are signed out of Gmail.', 'You are signed in on this device.', 'Sign in to sync.', 'You are signed in on this device.']);
  // what a toast, an error or an element shows as written counts lowercase and unpunctuated; a one-token code, or a
  // call's argument in the value set, doesn't
  assert.deepEqual(got("toast('saved with a seamless sync'); throw new Error('sign-in link expired — start again'); el.title = 'is-on'; fail('bad_state'); el.title = fmt('two words', n);"), ['saved with a seamless sync', 'sign-in link expired — start again']);
  assert.deepEqual(problems('saved with a seamless sync').map((p) => p.rule), ['banned']);
  // in a shown template's tag, a title's value counts that way; a class list doesn't
  assert.deepEqual(got('el.innerHTML = `<div class="${on ? \'chip enhanced\' : \'chip\'}" title="${on ? \'turn it off\' : \'turn it on\'}">Go</div>`;'), ['turn it off', 'turn it on', 'Go', 'turn it off']);
  // a '+' chain is one sentence: each piece passes, the whole doesn't
  const chain = got("toast('Your export is done and every thread you saved is now in ' + n + ' files on this device.');");
  assert.deepEqual(chain, ['Your export is done and every thread you saved is now in X files on this device.']);
  assert.deepEqual(chain.flatMap(problems).map((p) => [p.rule, p.words]), [['length', 17]]);
  // a hidden call hides its direct arguments, never the text inside a callback it is handed
  assert.deepEqual(got(`$('#go').addEventListener('click', () => { $('#q').textContent = 'The tester data here is gone.'; });
btn.addEventListener('click', () => (note.textContent = ok ? 'Mic works.' : 'No microphone found.'), { once: true });
LS.set('atelier.note', 'Some stored text.');
completeChat({ messages: [{ role: 'system', content: 'Write a short title for this.' }] });
fetch('/api/x', { method: 'POST', body: JSON.stringify({ text: 'Not shown here.' }) });`), ['The tester data here is gone.', 'Mic works.', 'No microphone found.']);
  // String.replace: the pattern is code, the text put in is copy
  assert.deepEqual(got(`note.textContent = base.replace(STAY, 'stay on this device. You can remove them below.');`), ['stay on this device. You can remove them below.']);
  // a ${…} reads as its branch with the most words, even when it has fewer characters
  const branch = got("el.textContent = `Your threads and notes now sync to ${on ? 'this phone and any other phone or tab you sign in on' : 'Atelier’s private, encrypted, owner-only cloud storage bucket'} from today.`;");
  assert.ok(branch.includes('Your threads and notes now sync to this phone and any other phone or tab you sign in on from today.'), branch.join('\n'));
  assert.deepEqual(branch.flatMap(problems).map((p) => [p.rule, p.words]), [['length', 21]]);
  // the sentences v91's copy hid behind one "X" (Canva's export note, the Photos Picker error) fail now
  const canva = got('box.innerHTML = `<p class="cvc-note">${f.length ? `Canva exports this design as ${esc(f.join(\', \'))} only` : \'Canva has no image or video export for this design\'} — open it in Canva to download it.</p>`;');
  assert.ok(canva.includes('Canva has no image or video export for this design — open it in Canva to download it.'), canva.join('\n'));
  assert.deepEqual(canva.flatMap(problems).map((p) => [p.rule, p.words]), [['length', 17]]);
  const photos = got('function f() { msg = `Google says the Photos Picker API isn’t enabled${project ? ` in project ${project}` : \'\'} (the project that owns your OAuth client). If you just enabled it, wait a few minutes.`; }', { server: true });
  assert.ok(photos.flatMap(problems).some((p) => p.rule === 'length' && p.words === 18), photos.join('\n'));
  // a lowercase label still counts as copy when its ${…} shape reads as one (the meta line's "X · tools off …")
  assert.deepEqual(got("const n = on ? `${link ? 'text from a link' : 'shared content'} · accounts off this turn` : '';"), ['text from a link · accounts off this turn']);
  // markup inside a ${…} stays X: an element is a line of its own, linted as its own literal
  assert.deepEqual(got('el.innerHTML = `<p><b>Plan</b>${a ? `<span>Chat · ${a}</span>` : \'\'}<span>Auto picks a model for each request.</span></p>`;'), ['Chat · X', 'Plan X Auto picks a model for each request.']);
  // a '+' chain's X never lands in markup: a tag after rows.join('') is still read as a tag (its aria-label, not its
  // attributes), and markup added after an inline element adds no word to its sentence
  assert.deepEqual(got("el.innerHTML = rows.join('') + `<input type=\"range\" min=\"0\" max=\"1\" step=\"0.1\" aria-label=\"Volume\" name=\"vol\" form=\"rx\" />`;"), ['Volume']);
  const sixteen = 'One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen.';
  const inline = got(`el.innerHTML = \`<span class="opt-note">${sixteen}</span>\` + (on ? '<button class="chip">Remix</button>' : '');`);
  assert.deepEqual(inline, ['Remix', sixteen]);
  assert.deepEqual(inline.flatMap(problems), []);
  // …nor does an operand that is only an entity: '&nbsp;' reads as it decodes, a space
  assert.deepEqual(got("el.innerHTML = '<span>Removed every thread from this device and from each phone, tab or laptop you own</span>' + (on ? '&nbsp;' : '');"), ['Removed every thread from this device and from each phone, tab or laptop you own']);
  // …but a value beside or between inline tags is a word, as in its template form (`<b>${name}</b> was removed…`)
  const lengths = (src) => got(src).flatMap(problems).map((p) => [p.rule, p.words]);
  assert.deepEqual(got("toast('<b>' + name + '</b> was removed from this device and from every other phone, tab or laptop you use today.');"), ['X was removed from this device and from every other phone, tab or laptop you use today.']);
  assert.deepEqual(lengths("toast('<b>' + name + '</b> was removed from this device and from every other phone, tab or laptop you use today.');"), [['length', 17]]);
  assert.deepEqual(lengths("el.innerHTML = n + '<span> threads were removed from this device and from every phone, tab or laptop that you own.</span>';"), [['length', 17]]);
  assert.deepEqual(got("toast('<b>Error:</b> ' + msg); toast('Open Settings > ' + tab);"), ['Error: X', 'Open Settings > X']);
  assert.deepEqual(got("el.innerHTML = '<span>Saved ' + n + ' threads</span>'; toast('You have ' + n + ' <b>new</b> messages.');"), ['Saved X threads', 'You have X new messages.']);
  // …and so is an inline element that wraps a value, in an operand of its own: it is a value, not markup of its own
  for (const wrap of ["(bold ? '<b>' + n + '</b>' : n)", "(url ? '<a href=\"' + url + '\">' + n + '</a>' : n)", '(bold ? `<b>${n}</b>` : n)'])
    assert.deepEqual(lengths(`el.innerHTML = '<p>' + ${wrap} + ' threads were removed from this device and from every phone, tab or laptop that you own.</p>';`), [['length', 17]], wrap);
  assert.ok(got("toast('Removed ' + (name ? `<b>${esc(name)}</b>` : '') + ' from this device and from every other phone, tab or laptop you use today.');").includes('Removed X from this device and from every other phone, tab or laptop you use today.'));
  // markup of its own reads alike in a chain and a ${…}: an inline element with text as X, a block or an empty one (a
  // <br>, an icon) as a space
  const tap = ["toast('Tap ' + (on ? '<b>Send</b>' : '') + ' to go from this device and from every other phone, tab or laptop you use today.');", "toast(`Tap ${on ? '<b>Send</b>' : ''} to go from this device and from every other phone, tab or laptop you use today.`);"];
  assert.deepEqual(tap.map(lengths), [[['length', 18]], [['length', 18]]]);
  const open = sixteen.slice(0, -1);
  for (const src of [`el.innerHTML = \`<span>${open}</span>\` + (on ? '<button class="chip">Remix</button>' : '');`, `el.innerHTML = \`<span>${open}</span>\${on ? '<button class="chip">Remix</button>' : ''}\`;`])
    assert.deepEqual(got(src), ['Remix', open], src);
  assert.deepEqual(lengths(`el.innerHTML = \`<span>${open}</span>\` + (on ? '<b>Remix</b>' : '');`), [['length', 17]], 'an inline one joins the sentence');
  assert.deepEqual(got("el.innerHTML = '<p>Line one is here' + (wrap ? '<br>' : ' ') + 'and line two</p>'; el.innerHTML = '<li>' + (x ? '<i class=\"ic\"></i>' : '') + 'Saved here</li>';"), ['Line one is here and line two', 'Saved here']);
  // a ternary in a group reads as its branch with the most words, and its branches are shown as written: the chain and
  // its template form read alike
  const synced = got("toast('Synced ' + (on ? 'with a seamless link' : 'here') + '.');");
  assert.deepEqual(synced, ['with a seamless link', 'Synced with a seamless link.']);
  assert.deepEqual(synced, got("toast(`Synced ${on ? 'with a seamless link' : 'here'}.`);"));
  assert.deepEqual(synced.flatMap(problems).map((p) => p.rule), ['banned', 'banned']);
  assert.deepEqual(lengths("toast('Your threads now sync to ' + (on ? 'this phone and any other phone or tab you sign in on' : 'here') + ' from today.');"), [['length', 19]]);
  // …never a comparand, an array's item or an index in it, nor one in a sink's argument or a value set
  assert.deepEqual(got("toast('Mode: ' + (mode === 'seamless sync mode' ? 'on' : 'off'));"), ['Mode: off']);
  assert.deepEqual(got("toast('Mode: ' + (['seamless sync mode', 'other mode'].includes(mode) ? 'on' : 'off'));"), ['Mode: off']);
  assert.deepEqual(got("toast(`${e.code === 'seamless quota hit' ? 'Quota hit' : 'Failed'}, try later`);"), ['Quota hit', 'Failed', 'Quota hit, try later']);
  assert.deepEqual(got("toast(x === 'seamless mode' ? 'on' : 'off'); el.textContent = mode === 'seamless mode' ? 'on' : 'off'; el.title = ['seamless mode', 'x y'].includes(m) ? 'On now' : 'Off now';"), ['On now', 'Off now']);
  // shown as written, a #channel, an @handle or a .folder counts: no mark up front makes it code
  const marks = got("toast(`#${channel} now syncs seamlessly`); toast(`@${handle} was added to the seamless list`); el.title = '#general syncs with a seamless link'; el.textContent = '.atelier folder is missing a seamless key';");
  assert.deepEqual(marks, ['#X now syncs seamlessly', '@X was added to the seamless list', '#general syncs with a seamless link', '.atelier folder is missing a seamless key']);
  assert.ok(marks.every((t) => problems(t).some((p) => p.rule === 'banned')));
  // a template or chain held in a variable that FOR_MODEL skips: its branches are read on their own (a toast may show it)
  for (const src of ["const m = `You are offline. ${q ? 'Seamless sync resumes when you reconnect.' : 'Reconnect.'}`; toast(m);", "const m = 'You are offline. ' + (q ? 'Seamless sync resumes when you reconnect.' : 'Reconnect.'); toast(m);"])
    assert.deepEqual(got(src), ['Seamless sync resumes when you reconnect.', 'Reconnect.'], src);
  // a log's text never counts, new Error(…) in one included; a callback handed to one is a statement of its own
  assert.deepEqual(got("console.warn(new Error('seamless sync failed here')); console.log('x', fmt('Seamless sync failed.')); trace('sync', () => { toast('saved with a seamless sync'); });"), ['saved with a seamless sync']);
});

test('the Worker’s errors: an error, message or detail value as the app shows it, never a log’s, a comparand’s or a tool result’s for the model', () => {
  const got = (src) => shownStrings(src, { server: true }).map((s) => s.text);
  const banned = (texts) => texts.filter((t) => problems(t).some((p) => p.rule === 'banned'));
  // the key is read from the object, not the line: every branch of the value counts, whatever its commas, calls or ${…}
  const values = got(`const a = () => json({ error: on ? \`\${svc} is switched off\` : 'seamless sync failed' });
const b = () => json({ error: cond ? 'gone, try again' : 'seamless sync failed' });
const c = () => json({ error: scrub(err.message, key) || 'seamless sync failed' });
const d = () => json({ error: \`couldn't \${on ? 'save the whole file now' : 'seamless sync broke'}\` });`);
  assert.deepEqual(values, ['X is switched off', 'seamless sync failed', 'gone, try again', 'seamless sync failed', 'seamless sync failed', 'save the whole file now', 'seamless sync broke', "couldn't save the whole file now"]);
  assert.deepEqual(banned(values), ['seamless sync failed', 'seamless sync failed', 'seamless sync failed', 'seamless sync broke']);
  // a response body is shown whatever it says: FOR_MODEL's words don't hide it
  const bodies = got(`const e = () => json({ error: 'You are signed out. Sign in again for a seamless sync.' });
const f = () => new Response('You are not paired. Pair this browser for a seamless link.');`);
  assert.deepEqual(bodies, ['You are signed out. Sign in again for a seamless sync.', 'You are not paired. Pair this browser for a seamless link.']);
  assert.equal(banned(bodies).length, 2);
  // …nor through a helper the module defines like json() (lookup.js's reply)
  assert.deepEqual(got(`const reply = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
function out() { return reply({ error: 'You are signed out. Sign in again for a seamless sync.' }, 401); }`), ['You are signed out. Sign in again for a seamless sync.']);
  // SQL is its keywords in capitals: an error or a body that starts "delete", "update", "Select" or "with" is copy
  const sqlish = got(`function a() { return json({ error: 'delete failed, seamless storage is gone' }, 500); }
function b() { return json({ error: 'update the app first for a seamless sync' }, 426); }
function c() { return json({ error: 'Select a model first. Seamless mode needs one.' }, 400); }
function d() { return new Response('with no passcode set the seamless lock is off', { status: 403 }); }
const q = 'SELECT name FROM testers WHERE sub = ?';`);
  assert.deepEqual(sqlish, ['delete failed, seamless storage is gone', 'update the app first for a seamless sync', 'Select a model first. Seamless mode needs one.', 'with no passcode set the seamless lock is off']);
  assert.equal(banned(sqlish).length, 4);
  // a text body that is code (CSS) isn't copy
  assert.deepEqual(got(`function css() { return new Response('body { margin: 0; font: 16px system-ui; background: #111; color: #eee } a { color: #8cf; text-decoration: none } .card { padding: 12px; border-radius: 8px }', { headers: { 'content-type': 'text/css' } }); }`), []);
  // no value: a comment's "error:", a comparand (an array .includes() checks too), a log (console.error included)
  assert.deepEqual(got(`function g() { // on failure, error: shows below
  const mode = 'seamless mode on'; return mode; }
const h = () => json({ error: e.code === 'seamless quota hit' ? 'Quota hit.' : 'Failed.' });
const k = () => json({ error: ['seamless quota hit', 'rate hit'].includes(code) ? 'Slow down.' : 'Failed.' });
console.log(JSON.stringify({ error: 'seamless sync failed' }));
console.error(JSON.stringify({ error: 'seamless sync failed' }));
console.warn('sync:', describe({ error: 'seamless sync failed' }));`), ['Quota hit.', 'Failed.', 'Slow down.', 'Failed.']);
  // a returned object can be a tool's result for the model (src/tools.js), so FOR_MODEL still applies to it; a check
  // that passed shows no message (app.js shows v.message only when !v.ok), one that failed does
  assert.deepEqual(got(`function run() { if (t.write && approved !== true) return { ok: false, error: 'This action needs the user\\'s approval in the app.' }; }
function check() { if (bad) return { ok: false, status: 401, message: 'key revoked today' }; return { ok: true, status: 200, message: 'key active' }; }`), ['key revoked today']);
  // …and the branches of one stay out with it, in a template or a '+' chain
  assert.deepEqual(got(`function run(t) { return { ok: false, error: \`\${t.write ? 'the write tool you called needs an approval step in the app before it can run against a connected service' : 'this tool is blocked'}. Ask the user to approve it.\` }; }
function deny(t) { return { ok: false, error: \`You are not allowed to run this \${t.write ? 'seamless write tool' : 'tool'} yet.\` }; }
function down() { return { ok: false, error: 'You are offline: ' + (net ? 'the seamless relay is down' : 'no network') }; }`), []);
  // a request's own body is never shown: a commit message under fetch, a model's input, an object built first, what KV
  // stores. A message or detail needs an ok: or an error: beside it to be an error's.
  assert.deepEqual(got(`async function put() { await fetch(api, { method: 'PUT', body: JSON.stringify({ message: 'atelier backup with a seamless sync from the worker', content: b64, sha }) }); }
const body = JSON.stringify({ model: 'command-r', message: 'write a short title for this chat in five words or fewer and nothing else at all please now', stream: false });
const commit = { message: 'atelier backup with a seamless sync from the worker' }; fetch(u, { body: JSON.stringify(commit) });
const refused = { error: 'seamless upload refused' }; await env.KV.put(key, JSON.stringify({ error: 'seamless cache entry' }));
const failed = { error: true, message: 'seamless upload failed' }, done = { ok, message: 'seamless upload done' };`), ['seamless upload refused', 'seamless upload failed', 'seamless upload done']);
  // an error's message nests under error: in a frame sent, a returned object or a stream's JSON line; a data: one doesn't
  const nested = got(`function s() { send({ error: { message: err.message || 'stream failed, seamless retry is off' } }); }
function f() { return { ok: false, error: { message: 'seamless sync failed', code: 'x' } }; }
function t() { const frame = JSON.stringify({ error: { message: 'seamless stream broke' } }); ctrl.enqueue(enc.encode(frame)); }
const n = () => json({ error: on ? { message: 'seamless sync went down' } : null });
const m = () => json({ data: { message: 'seamless sync is fine' } });`);
  assert.deepEqual(nested, ['stream failed, seamless retry is off', 'seamless sync failed', 'seamless stream broke', 'seamless sync went down']);
  assert.equal(banned(nested).length, 4);
  // a comparand in a value, a template's or a '+' chain's, is never read as it; a lookup's value is, never its key
  assert.deepEqual(got(`const h = () => json({ error: (e.code === 'seamless quota hit' ? 'Quota hit' : 'Failed') + ', try later' });
const k = () => json({ error: \`\${e.code === 'seamless quota hit' ? 'Quota hit' : 'Failed'}, try later\` });
const l = () => json({ error: 'Failed: ' + ({ 'seamless quota hit': 'quota' })[code] });`), ['Quota hit', 'Failed', 'Quota hit, try later', 'Quota hit', 'Failed', 'Quota hit, try later', 'Failed: quota']);
  // a tool result is for the model when FOR_MODEL's words sit in a branch only, or the template's are around one
  assert.deepEqual(got(`async function run(w) { return { ok: false, error: 'blocked: ' + (w ? 'the seamless write tool needs the user to approve it' : 'no') }; }
async function run2(w) { return { ok: false, error: \`blocked: \${w ? 'the seamless write tool needs the user to approve it' : 'no'}\` }; }
function run3(w) { return { ok: false, error: \`Ask the user: \${w ? 'Seamless write needs approval.' : 'No.'}\` }; }`), []);
  // a body with a ;, a {…} or an @ up front is still copy; CSS is not
  const marks = got(`json({ error: 'upload failed: timeout; seamless retry is off' }); json({ error: 'seamless mode needs {voice, text}' }); new Response('@atelier relay is seamless now');`);
  assert.deepEqual(marks, ['upload failed: timeout; seamless retry is off', 'seamless mode needs {voice, text}', '@atelier relay is seamless now']);
  assert.equal(banned(marks).length, 3);
  // a helper is json() whatever it hands on: Response.json(data), JSON.stringify(d, null, 2), a bare param
  for (const helper of ['const reply = (data, status = 200) => Response.json(data, { status });', 'const reply = (d, s = 200) => new Response(JSON.stringify(d, null, 2), { status: s });', 'const reply = d => new Response(JSON.stringify(d));', 'function reply(d, s) { return Response.json(d, { status: s }); }'])
    assert.deepEqual(got(`${helper}\nfunction out() { return reply({ message: 'seamless sync failed' }, 500); }`), ['seamless sync failed'], helper);
  // console.error logs an Error it's handed; a stream's c.error(…) errors the stream, which the app shows
  assert.deepEqual(got(`console.error('sync', new Error('seamless sync failed here')); console.warn(new Error('seamless sync broke here'));
function t(c) { c.error(new Error('seamless output over the cap')); }`), ['seamless output over the cap']);
  // a tool's desc is for the model wherever it sits: the first key, its own line, a template's branch
  assert.deepEqual(got(`const tools = { x: { desc: 'Send an email from one of the connected accounts as a reply when asked to by them later on today and tomorrow.' } };
const more = { x: {
  desc: 'Send an email from one of the connected accounts as a reply when asked to by them later on today and tomorrow.' } };
const tpl = { x: { desc: \`Send \${on ? 'it from one of the connected accounts as a reply when they ask today or tomorrow' : ''}.\` } };`), []);
});

// ── 2. the rules in the system prompt, only for writing in Cole's name ──
function fnSource(name) {
  let at = APP.indexOf(`\nfunction ${name}(`);
  if (at < 0) at = APP.indexOf(`\nasync function ${name}(`);
  assert.ok(at >= 0, `app.js has function ${name}`);
  return APP.slice(at + 1, APP.indexOf('\n}\n', at + 1) + 2);
}
function constExpr(name) {
  const at = APP.indexOf(`\nconst ${name} = `);
  assert.ok(at >= 0, `app.js has const ${name}`);
  const from = at + 1 + `const ${name} = `.length;
  if (APP[from] === '`') return APP.slice(from, APP.indexOf('`;\n', from + 1) + 1);
  if (APP[from] === '{' && APP[from + 1] === '\n') return APP.slice(from, APP.indexOf('\n};\n', from) + 2);
  const end = APP.slice(at + 1).search(/\n(?=[^\s})\]])/);
  return APP.slice(from, at + 1 + end).replace(/;\s*(?:\/\/[^\n]*)?$/, '');
}
const scope = (vars) => new Proxy(vars, {
  has: (t, k) => typeof k === 'string' && (k in t || !(k in globalThis)),
  get: (t, k) => (k === Symbol.unscopables ? undefined : k in t ? t[k] : () => undefined),
  set: (t, k, v) => { t[k] = v; return true; },
});
const evalIn = (vars, body) => new Function('scope', `with (scope) { ${body} }`)(scope(vars));

let clock = Date.UTC(2026, 9, 11, 14, 0);
class FakeDate extends Date {
  constructor(...a) { super(...(a.length ? a : [clock])); }
  static now() { return clock; }
}
const GMAIL = { type: 'function', function: { name: 'gmail_draft', description: 'Save a draft', parameters: { type: 'object', properties: { body: { type: 'string' } } } }, 'x-service': 'gmail', 'x-label': 'Save Gmail draft' };
const PROMPT = ['ACCURACY', 'NO_FABRICATION', 'TZ', 'tzOffset', 'dateLine', 'liveBrowser', 'historyWindow', 'RUN_BROWSER', 'B_TAB', 'B_EL', 'BROWSER_TOOLS', 'agentTools', 'SENT_AS_THEM', 'AS_GIVEN'];
const STREAM = ['EMPTY_NUDGE', 'shows', 'THINKING_BLOCKS', 'replayRounds', 'replayable', 'MAX_OUTPUT', 'HELPER_ROLES', 'UNLISTED_CLAUDE_ROOM', 'roomFor', 'SSE_ERRORS', 'EFFORT', 'FIRST_TOKEN_MS', 'providerOf', 'accountProblem', 'sleep', 'asksFirst', 'urlHost'];
const FNS = ['persona', 'capabilities', 'voiceBlock', 'nameRules', 'runPrompt', 'historyFor', 'withoutThinking', 'streamChat', 'streamChatOnce', 'streamChatRaw', 'apiHeaders', 'toApiError', 'extCall', 'runChat', 'runAgent', 'runWatch'];
const sseOf = (events) => new Response(new ReadableStream({ start(c) { for (const e of events) c.enqueue(new TextEncoder().encode(e)); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
const reply = () => sseOf(['data: {"choices":[{"index":0,"delta":{"content":"Done."},"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n']);

// The real prompt builders and request path of app.js, with the app's state stubbed; /api/chat answers "Done.".
function rig({ tester = null } = {}) {
  const bodies = [], roles = [];
  const vars = {
    Date: FakeDate, HUMANIZER,
    S: { settings: { name: 'Cole', about: '', temperature: 0.5, models: {}, passcode: 'p' }, tester },
    ME: { bio: 'Builds Atelier.', learned: '', memory: [], style: 'Short and plain. Signs off "C".', samples: 'Quick one: can we move Friday to 3? C' },
    TOOLS: { services: { gmail: true }, list: [GMAIL] }, EXT: { ready: false }, REMOTE: { online: false }, claudeChats: 0,
    factsFor, runStart, memoryAnchor, heldForRun, TESTER_HISTORY, buildHistory, withSent, readUsage, addUsage, cacheKey, threadTaint, ownTaint,
    taintGates, taintNote, readsPage, pageOrigin, worseTaint, followUpRoute, photoFollowUp, mediaTurn, CTX_IMAGES, isTesterCode,
    fetch: async (url, init) => { assert.equal(url, '/api/chat', 'only the mocked chat route'); bodies.push(JSON.parse(init.body)); return reply(); },
    noteAllowance() {}, modelLabel: (m) => m, toast() {}, navigator: { onLine: true }, repaint() {},
    roleModels: () => [], modelReady: () => true, deadProviders: new Map(), PROVIDER_NAMES: {},
    providerReady: () => true, feat: () => false, wantsAgent: () => false, needsBrains: () => false, contextOf: () => null,
    modelFor: (role) => { roles.push(role); return 'openai:gpt-6-luna'; },
    uid: (() => { let n = 0; return () => `u${++n}`; })(), awaitApproval: async () => true, callTool: async () => ({ ok: true, result: {} }),
    FRESH_HINT: /$^/, ABOUT_MEDIA: /$^/, ASKS_WEB: /$^/,
    geminiUsable: () => false, planFor: () => ({ kind: 'frames', cap: 2 }), videoParts: () => [{ type: 'text', text: '[2 frames]' }], noteFor: () => 'frames',
  };
  for (const n of PROMPT) vars[n] = evalIn(vars, `return (${constExpr(n)});`);
  vars.SYS = evalIn(vars, `return (${constExpr('SYS')});`);
  vars.ApiError = evalIn(vars, `return (${APP.slice(APP.indexOf('\nclass ApiError') + 1, APP.indexOf('\n}\n', APP.indexOf('\nclass ApiError')) + 2)});`);
  for (const n of STREAM) vars[n] = evalIn(vars, `return (${constExpr(n)});`);
  for (const n of FNS) vars[n] = evalIn(vars, `return (${fnSource(n)});`);
  return { v: vars, bodies, roles, system: (k = -1) => { const m = bodies.at(k).messages[0]; assert.equal(m.role, 'system'); return m.content; } };
}
const turn = (id, params = {}, kind = 'ask', extra = {}) => ({ id, kind, prompt: `prompt ${id}`, params, createdAt: clock, sent: 'Sun, Oct 11, 2026, 2:00 PM', ...extra });
const times = (s, part) => s.split(part).length - 1;

test('"As me" (the write role) carries the rules in its system prompt; Ask, Deep think and Code do not; a tester’s "As me" does not', async () => {
  const r = rig(), t = { id: 'th', entries: [] };
  const run = async (e) => { t.entries.push(e); await r.v.runChat(e, null, t); return r.system(); };
  const plain = await run(turn('a1'));
  assert.ok(!plain.includes(HUMANIZER), 'Ask');
  const asMe = await run(turn('a2', { voice: true }));
  assert.equal(r.roles.at(-1), 'write', 'the "As me" turn runs on the write role');
  assert.equal(times(asMe, HUMANIZER), 1, '"As me": the rules, once');
  assert.match(asMe, /## Ghostwriting mode\n[\s\S]*### Their style guide\n[\s\S]*### Samples of their real writing\n[\s\S]*### Their writing rules\nEverything you write as Cole follows these rules\. Where the style guide or the samples disagree with them, the rules win\. Code, commands, logs, links and quoted text stay exactly as given\. [^\n]*\nWRITING RULES \(Cole's humanizer\)/);
  assert.ok(asMe.includes(`the rules win. ${r.v.AS_GIVEN}\n${HUMANIZER}`), 'what stays as given, right before the rules');
  assert.equal(times(asMe, r.v.AS_GIVEN), 1);
  assert.ok(asMe.endsWith(HUMANIZER), 'last, after the samples');
  const thinkAsMe = await run(turn('a3', { voice: true, think: true }));
  assert.equal(r.roles.at(-1), 'reason');
  assert.ok(thinkAsMe.includes(HUMANIZER), 'Deep think + As me still writes as Cole');
  assert.ok(!(await run(turn('a4', { think: true }))).includes(HUMANIZER), 'Deep think');
  assert.ok(!(await run(turn('c1', {}, 'code'))).includes(HUMANIZER), 'Code');
  assert.ok(!(await run(turn('c2', { voice: true }, 'code'))).includes(HUMANIZER), 'Code ignores the As me flag (runChat: voice is Ask only)');
  const tr = rig({ tester: { id: 'tt' } }), tt = { id: 'tt', entries: [] };
  const e = turn('t1', { voice: true }); tt.entries.push(e);
  await tr.v.runChat(e, null, tt);
  assert.match(tr.system(), /## Ghostwriting mode/, 'a tester still gets ghostwriting');
  assert.ok(!tr.system().includes('WRITING RULES'), 'but never Cole’s rules: a tester writes in their own name');
  assert.ok(!tr.system().includes(tr.v.AS_GIVEN), 'nor what they leave as given');
});

test('the accounts agent: the rules cover the tool arguments sent under his name, never its answer to him; with "As me", once', async () => {
  const r = rig(), t = { id: 'ag', entries: [] };
  const e = turn('g1'); t.entries.push(e);
  await r.v.runAgent(e, null, t);
  assert.equal(e.text, 'Done.');
  const sys = r.system();
  assert.equal(times(sys, HUMANIZER), 1);
  assert.ok(sys.endsWith(HUMANIZER), 'the last section: everything before it is unchanged');
  const lead = /## Text that goes out under their name\nThese tool arguments go out under the user's name: ([^\n]*)\. Write that text by the writing rules below\. The rules cover only what you put in those arguments: "everything you write" means that text\. Your own replies to the user keep your usual style\. Code, commands, logs, links and quoted text stay exactly as given\. [^\n]*\nWRITING RULES/.exec(sys);
  assert.ok(lead, 'the scope comes right before the rules');
  assert.ok(sys.includes(`keep your usual style. ${r.v.AS_GIVEN}\n${HUMANIZER}`), 'what stays as given, right before the rules');
  assert.equal(times(sys, r.v.AS_GIVEN), 1);
  // the agent's own report to him keeps its usual close
  assert.ok(sys.includes('If the user declines, acknowledge briefly and stop. Finish with a crisp summary; include links when available.\n'));
  for (const arg of ['the subject and body of gmail_draft and gmail_send', 'the text of slack_post', 'the title and body of github_create_issue', 'the body of github_comment', 'the title and description of calendar_create', 'the title and content of drive_create_doc', 'the text of browser_type when it posts a message, comment, review or reply as them'])
    assert.ok(lead[1].includes(arg), arg);
  assert.match(sys, /call them with complete, final content — written in the user's own voice when it goes out under their name/, 'the v87 rule it extends is still there');
  // "As me" in the agent: voiceBlock already holds the rules, so the agent's section points at them
  const a = turn('g2', { voice: true }); t.entries.push(a);
  await r.v.runAgent(a, null, t);
  const both = r.system();
  assert.equal(times(both, HUMANIZER), 1, 'never twice');
  assert.equal(times(both, r.v.AS_GIVEN), 1, 'what stays as given, once: with the rules in voiceBlock');
  assert.match(both, /### Their writing rules\n[\s\S]*## Text that goes out under their name\n[^\n]*\. Write them by the writing rules above\.$/);
  // review-nov02 (atelier-4): with "As me" the whole answer is his, so it closes by rule 5 (no summary ending)
  assert.ok(both.includes('If the user declines, acknowledge briefly and stop. End with one or two plain lines on what you did, and any links.\n'));
  assert.doesNotMatch(both, /crisp summary/);
});

// review-nov02 (atelier-3): the rules held no exception for code, logs or wording he gives word for word, and "the rules
// win" overrode his greetings and sign-offs. AS_GIVEN, Atelier's own text (public/humanizer.js stays the canonical copy),
// says what stays as given.
test('what the rules leave as given: code, commands, logs, links, quotes, his own wording, an issue’s fences and lists, an email’s greeting and sign-off', () => {
  const { v } = rig();
  for (const part of ['Code, commands, logs, links and quoted text stay exactly as given.', 'So does any wording the user asks you to keep word for word.', 'Code fences and the lists a GitHub issue or Doc needs are not formatting tricks.', 'In an email, keep their usual greeting and sign-off.'])
    assert.ok(v.AS_GIVEN.includes(part), part);
  assert.deepEqual(problems(v.AS_GIVEN), [], 'it follows the rules itself');
  assert.ok(!HUMANIZER.includes('Code fences'), 'added in Atelier, not to the canonical text');
});

test('a video follow-up "As me" carries the rules too (runWatch); without it, none', async () => {
  const r = rig();
  const src = turn('w1', {}, 'ask', { video: { name: 'clip.mp4', frames: ['f1', 'f2'] } });
  const t = { id: 'wt', entries: [src] };
  await r.v.runWatch(src, src, null, t);
  assert.ok(!r.system().includes(HUMANIZER));
  const f = turn('w2', { voice: true }, 'ask', { videoOf: 'w1' }); t.entries.push(f);
  await r.v.runWatch(f, src, null, t);
  assert.equal(times(r.system(), HUMANIZER), 1);
});

test('the system prompt that holds the rules stays byte-identical from turn to turn (v87’s cached prefix): "As me" and the agent', async () => {
  for (const kind of ['chat', 'agent']) {
    const r = rig(), t = { id: `bi-${kind}`, entries: [] };
    for (let i = 0; i < 3; i++) {
      clock = Date.UTC(2026, 9, 11, 14, 0) + i * 7 * 60_000; // turns minutes apart in one run
      const e = turn(`${kind}${i}`, { voice: kind === 'chat' }); t.entries.push(e);
      if (kind === 'chat') await r.v.runChat(e, null, t); else await r.v.runAgent(e, null, t);
    }
    const systems = r.bodies.map((b) => b.messages[0].content);
    assert.equal(systems.length, 3);
    assert.ok(systems[0].includes(HUMANIZER), kind);
    assert.equal(systems[1], systems[0], `${kind}: turn 2 = turn 1`);
    assert.equal(systems[2], systems[0], `${kind}: turn 3 = turn 1`);
    assert.ok(r.bodies.every((b) => b.cache_key === cacheKey(t.id)), `${kind}: a thread turn, cached under its key`);
  }
  clock = Date.UTC(2026, 9, 11, 14, 0);
});

test('Ideas, Build, the helpers and titles never get the rules; only voiceBlock and nameRules hold them, and only "As me" and the agent call those', () => {
  const r = rig();
  const sys = r.v.SYS;
  const prompts = { ask: sys.ask(), code: sys.code(), web: sys.web(), ideas: sys.ideas(6, 'bold'), build: sys.build('editorial'), enhanceImage: sys.enhanceImage(), enhanceVideo: sys.enhanceVideo(), title: sys.title(), plan: sys.plan(), learn: sys.learn(['Builds Atelier']), profile: sys.profile('ChatGPT', ''), styleOnly: sys.styleOnly() };
  for (const [k, p] of Object.entries(prompts)) {
    assert.ok(p.length > 40, k);
    assert.ok(!p.includes('WRITING RULES') && !p.includes("Cole's humanizer"), `${k}: no rules`);
  }
  assert.deepEqual(Object.keys(sys).sort(), Object.keys(prompts).sort(), 'every SYS prompt is checked here');
  // the identifier appears only in the import, voiceBlock and nameRules (comments aside)
  const code = APP.split('\n').filter((l) => !/^\s*\/\//.test(l));
  const voice = fnSource('voiceBlock'), names = fnSource('nameRules');
  for (const l of code.filter((x) => /\bHUMANIZER\b/.test(x))) assert.ok(/^import \{ HUMANIZER \}/.test(l) || voice.includes(l) || names.includes(l), `HUMANIZER used outside voiceBlock / nameRules: ${l.trim()}`);
  // voiceBlock() only where "As me" is on: runChat, runWatch and runAgent, each behind the voice flag
  const calls = (name) => code.filter((l) => l.includes(`${name}(`) && !l.startsWith(`function ${name}(`));
  const where = (l) => ['runChat', 'runWatch', 'runAgent'].find((f) => fnSource(f).includes(l));
  assert.deepEqual(calls('voiceBlock').map(where), ['runChat', 'runWatch', 'runAgent']);
  for (const l of calls('voiceBlock')) assert.match(l, /(?:voice|params\?\.voice) \? '\\n\\n' \+ voiceBlock\(\)/);
  assert.deepEqual(calls('nameRules').map(where), ['runAgent']);
  // the helpers' own requests (title, plan, enhance, learn, profile, style) build their prompts from SYS alone
  for (const m of APP.matchAll(/completeChat\(\{[^\n]*?content: (SYS\.\w+\([^)]*\))/g)) assert.ok(!/voiceBlock|nameRules|HUMANIZER/.test(m[1]), m[1]);
});
