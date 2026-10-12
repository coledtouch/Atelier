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
import { problems, htmlText, shownStrings, literals, sentences, words, HUMANIZER_BANNED, HUMANIZER_WARN, MAX_WORDS } from './humanizer-lint.mjs';
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
  'public/app.js': ['EMPTY_NUDGE', 'persona', 'ACCURACY', 'NO_FABRICATION', 'capabilities', 'dateLine', 'voiceBlock', 'SENT_AS_THEM', 'nameRules', 'SYS', 'BROWSER_TOOLS'],
  'public/humanizer.js': ['HUMANIZER'],
  'public/remix.js': ['COMPACT', 'remixSystem', 'remixUser', 'reviseSystem', 'reviseUser', 'shotPrompt', 'CAMERA_TEXT', 'SHOT_NEGATIVE'],
  'public/video.js': ['videoParts'],
  'src/transcribe.js': ['GEMINI_STT_PROMPT'],
  'src/tester/prices.js': ['TABLE'],
};
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
    const file = f.replace(/^public\//, '');
    for (const s of shownStrings(await read(f), { hidden: HIDDEN[f] || [], server: f.startsWith('src/') })) out.push({ file, where: `${f}:${s.line}`, text: s.text });
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
  for (const t of ['I have 25 tester spots. The paid models are on me.', 'I built Atelier for my own work: answers, code, images, video, ideas and small apps.', 'Theme and model choices stay on this device.'])
    assert.ok(blocks.some((b) => b.file === 'index.html' && b.text === t), `index.html: “${t}” is linted`);
  assert.ok(blocks.some((b) => /^I’m Cole Ciprari\. I built Atelier for myself/.test(b.text)), 'the og:description pitch is linted');
  assert.ok(blocks.some((b) => b.where.includes('bootWatch') && /safe on this device/.test(b.text)), 'the recovery screen is linted');
  // shown strings the first extractor skipped: a toast that says JSON, text set inside a listener, an error's fallback
  for (const [f, t] of [['app.js', 'That file isn’t valid JSON. Nothing was imported.'], ['app.js', 'The tester data that was on this device is gone.'], ['feedback.js', 'Couldn’t load this screenshot. Close and reopen to try again.']])
    assert.ok(blocks.some((b) => b.file === f && b.text === t), `${f}: “${t}” is linted`);
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
  // the tokenizer keeps strings, templates and regex literals apart, and knows the call each literal sits in; a ${…}
  // reads as the longest string in it, or X
  const lits = literals('a = b / 2; toast(`x ${f("y")} z ${n}`); c = /"/.test(d) ? "q" : `w`;');
  assert.deepEqual(lits.map((l) => [l.text, l.calls.at(-1) ?? '']), [['y', 'f'], ['x y z X', 'toast'], ['q', ''], ['w', '']]);
  assert.equal(lits[1].shape, 'x X z X');
});

test('the extractor reads what a person sees: a toast or error whatever its words, text set in a callback, String.replace’s text, a ${…} at its longest', () => {
  const got = (src, o) => shownStrings(src, o).map((s) => s.text);
  // FOR_MODEL words skip a prompt, never a toast, an error or an element's text
  assert.deepEqual(got(`function a() {
  toast('Exported a JSON file of every thread.');
  throw new ApiError(400, 'You are signed out. Sign in again.');
  el.textContent = 'Saved for the user on this device.';
  const p = 'You are a helper. Return ONLY JSON.';
}`), ['Exported a JSON file of every thread.', 'You are signed out. Sign in again.', 'Saved for the user on this device.']);
  // a hidden call hides its direct arguments, never the text inside a callback it is handed
  assert.deepEqual(got(`$('#go').addEventListener('click', () => { $('#q').textContent = 'The tester data here is gone.'; });
btn.addEventListener('click', () => (note.textContent = ok ? 'Mic works.' : 'No microphone found.'), { once: true });
LS.set('atelier.note', 'Some stored text.');
completeChat({ messages: [{ role: 'system', content: 'Write a short title for this.' }] });
fetch('/api/x', { method: 'POST', body: JSON.stringify({ text: 'Not shown here.' }) });`), ['The tester data here is gone.', 'Mic works.', 'No microphone found.']);
  // String.replace: the pattern is code, the text put in is copy
  assert.deepEqual(got(`note.textContent = base.replace(STAY, 'stay on this device. You can remove them below.');`), ['stay on this device. You can remove them below.']);
  // a ${…} reads as its longest branch: the sentences v91's copy hid behind one "X" (Canva's export note, the Photos
  // Picker error) would fail now
  const canva = got('box.innerHTML = `<p class="cvc-note">${f.length ? `Canva exports this design as ${esc(f.join(\', \'))} only` : \'Canva has no image or video export for this design\'} — open it in Canva to download it.</p>`;');
  assert.ok(canva.includes('Canva has no image or video export for this design — open it in Canva to download it.'), canva.join('\n'));
  assert.deepEqual(canva.flatMap(problems).map((p) => [p.rule, p.words]), [['length', 17]]);
  const photos = got('function f() { msg = `Google says the Photos Picker API isn’t enabled${project ? ` in project ${project}` : \'\'} (the project that owns your OAuth client). If you just enabled it, wait a few minutes.`; }', { server: true });
  assert.ok(photos.flatMap(problems).some((p) => p.rule === 'length' && p.words === 18), photos.join('\n'));
  // a lowercase label still counts as copy when its ${…} shape reads as one (the meta line's "X · tools off …")
  assert.deepEqual(got("const n = on ? `${link ? 'text from a link' : 'shared content'} · accounts off this turn` : '';"), ['text from a link · accounts off this turn']);
  // markup inside a ${…} stays X: an element is a line of its own, linted as its own literal
  assert.deepEqual(got('el.innerHTML = `<p><b>Plan</b>${a ? `<span>Chat · ${a}</span>` : \'\'}<span>Auto picks a model for each request.</span></p>`;'), ['Chat · X', 'Plan X Auto picks a model for each request.']);
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
const PROMPT = ['ACCURACY', 'NO_FABRICATION', 'TZ', 'tzOffset', 'dateLine', 'liveBrowser', 'historyWindow', 'RUN_BROWSER', 'B_TAB', 'B_EL', 'BROWSER_TOOLS', 'agentTools', 'SENT_AS_THEM'];
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
  assert.match(asMe, /## Ghostwriting mode\n[\s\S]*### Their style guide\n[\s\S]*### Samples of their real writing\n[\s\S]*### Their writing rules\nEverything you write as Cole follows these rules\. Where the style guide or the samples disagree with them, the rules win\.\nWRITING RULES \(Cole's humanizer\)/);
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
});

test('the accounts agent: the rules cover the tool arguments sent under his name, never its answer to him; with "As me", once', async () => {
  const r = rig(), t = { id: 'ag', entries: [] };
  const e = turn('g1'); t.entries.push(e);
  await r.v.runAgent(e, null, t);
  assert.equal(e.text, 'Done.');
  const sys = r.system();
  assert.equal(times(sys, HUMANIZER), 1);
  assert.ok(sys.endsWith(HUMANIZER), 'the last section: everything before it is unchanged');
  const lead = /## Text that goes out under their name\nThese tool arguments go out under the user's name: ([^\n]*)\. Write that text by the writing rules below\. The rules cover only what you put in those arguments: "everything you write" means that text\. Your own replies to the user keep your usual style\.\nWRITING RULES/.exec(sys);
  assert.ok(lead, 'the scope comes right before the rules');
  for (const arg of ['the subject and body of gmail_draft and gmail_send', 'the text of slack_post', 'the title and body of github_create_issue', 'the body of github_comment', 'the title and description of calendar_create', 'the title and content of drive_create_doc', 'the text of browser_type when it posts a message, comment, review or reply as them'])
    assert.ok(lead[1].includes(arg), arg);
  assert.match(sys, /call them with complete, final content — written in the user's own voice when it goes out under their name/, 'the v87 rule it extends is still there');
  // "As me" in the agent: voiceBlock already holds the rules, so the agent's section points at them
  const a = turn('g2', { voice: true }); t.entries.push(a);
  await r.v.runAgent(a, null, t);
  const both = r.system();
  assert.equal(times(both, HUMANIZER), 1, 'never twice');
  assert.match(both, /### Their writing rules\n[\s\S]*## Text that goes out under their name\n[^\n]*\. Write them by the writing rules above\.$/);
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
