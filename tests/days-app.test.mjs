import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { kindOf, cleanFlow, flowHint, flowOpts, globalOptsWrite, KIND_DEFAULTS, dayKey, tabFlows, earlierCut, daySlice, dayList } from '../public/days.js';
import { groupsFor, spaceRequest, parseSpaces } from '../public/thread-spaces.js';
import { problems } from './humanizer-lint.mjs';

// Days and flows, the app.js half (Task 5): each flow keeps its own kind and composer choices, a retried turn is
// stamped with when it was redone, the run's system prompt names the flow's kind, and lastThread is now lastFlow.
// app.js can't be imported in Node: functions are lifted out of it and run against stubs (as tests/app-v114.test.mjs does).
const APP = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
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
  if (APP[from] === '{' && APP[from + 1] === '\n') return APP.slice(from, APP.indexOf('\n};\n', from) + 2);
  const end = APP.slice(at + 1).search(/\n(?=[^\s})\]])/);
  return APP.slice(from, at + 1 + end).replace(/;\s*(?:\/\/[^\n]*)?$/, '');
}
function scope(vars) {
  return new Proxy(vars, {
    has: (t, k) => typeof k === 'string' && (k in t || !(k in globalThis)),
    get: (t, k) => (k === Symbol.unscopables ? undefined : k in t ? t[k] : () => undefined),
    set: (t, k, v) => { t[k] = v; return true; },
  });
}
const evalIn = (vars, body) => new Function('scope', `with (scope) { ${body} }`)(scope(vars));
const lift = (vars, ...names) => { for (const n of names) vars[n] = evalIn(vars, `return (${fnSource(n)});`); return vars; };

test('retry stamps at: a redone turn counts on the day it was redone', () => {
  const at = APP.indexOf("    case 'retry':\n      if (e.pending || e.canva) return;");
  assert.ok(at > 0, 'app.js has the retry act');
  const body = APP.slice(at, APP.indexOf('      return run(e);\n', at) + '      return run(e);\n'.length);
  assert.match(body, /e\.at = Date\.now\(\);[^\n]*\n(?:.*\n)*?\s*return run\(e\);\n$/, 'e.at is stamped before run(e)');
});

test('runPrompt adds the flow hint line, after the static part, and nothing for a thread with no kind', () => {
  const GROUPS = groupsFor('owner');
  const v = { memoryAnchor: () => 7, heldForRun: () => '', runStart: () => 0, liveBrowser: () => '', historyWindow: () => 0, RUN_BROWSER: {},
    kindOf, flowHint, threadSpaces: { guessed: 'kid' }, GROUPS,
    persona: () => 'PERSONA', ACCURACY: 'ACCURACY', dateLine: () => 'DATE' };
  v.flowLine = evalIn(v, `return (${constExpr('flowLine')});`);
  lift(v, 'runPrompt');
  v.SYS = evalIn(v, `return (${constExpr('SYS')});`);
  const coen = { id: 't1', flow: { kind: 'coen' }, entries: [] };
  const hint = flowHint('coen', GROUPS);
  assert.ok(hint, 'coen has a label in the owner set');
  assert.equal(v.runPrompt({ id: 'e' }, coen).flow, hint);
  assert.equal(v.runPrompt({ id: 'e' }, { id: 'guessed', entries: [] }).flow, flowHint('kid', GROUPS), 'the on-device guess counts');
  for (const k of ['ask', 'code', 'web']) {
    const plain = v.SYS[k](v.runPrompt({ id: 'e' }, { id: 'none', entries: [] }));
    const flowed = v.SYS[k](v.runPrompt({ id: 'e' }, coen));
    assert.ok(plain.endsWith('\nDATE') && !plain.includes('This flow is about'), `${k}: no line without a kind`);
    assert.equal(plain, v.SYS[k]({ anchor: 7, browser: '' }), `${k}: byte-identical to a run with no flow`);
    assert.ok(flowed.endsWith(`\n${hint}\nDATE`), `${k}: one line, just before the date`);
    assert.equal(flowed.replace(`${hint}\n`, ''), plain, `${k}: nothing else moves`);
  }
});

test('flowOpts: own choices, else the kind defaults over the global ones, else the global ones', () => {
  const base = () => ({ ask: { model: '', think: false, voice: false, web: false }, image: { model: '', aspect: '1:1' } });
  // no flow, no opts: exactly the global choices and mode
  assert.deepEqual(flowOpts({ id: 'a' }, base(), 'image'), { opts: base(), mode: 'image' });
  assert.deepEqual(flowOpts(null, base(), 'code'), { opts: base(), mode: 'code' });
  // a kind with defaults, no opts yet: linkedin turns "As me" on, in Ask
  const li = flowOpts({ flow: { kind: 'linkedin' } }, base(), 'image');
  assert.equal(li.mode, 'ask');
  assert.equal(li.opts.ask.voice, true);
  assert.equal(li.opts.image.aspect, '1:1', 'the rest stays global');
  assert.equal(KIND_DEFAULTS.linkedin.ask.voice, true, 'the defaults are never changed');
  li.opts.ask.voice = false;
  assert.equal(KIND_DEFAULTS.linkedin.ask.voice, true);
  // a kind without named defaults: Ask, global choices
  assert.deepEqual(flowOpts({ flow: { kind: 'coen' } }, base(), 'image'), { opts: base(), mode: 'ask' });
  // own opts win, laid over the global shape (a key added by a later build is still there); a copy, never the record's
  const own = { ask: { model: 'x', voice: false }, mode: 'code' };
  const t = { flow: { kind: 'linkedin' }, opts: own };
  const r = flowOpts(t, base(), 'image');
  assert.equal(r.mode, 'code');
  assert.deepEqual(r.opts.ask, { model: 'x', think: false, voice: false, web: false });
  assert.ok(!('mode' in r.opts), 'mode is not an opts key');
  r.opts.ask.model = 'changed';
  assert.equal(own.ask.model, 'x');
  // a cleaner (app.js migrateOpts) runs on the saved choices
  const cleaned = flowOpts({ opts: { image: { model: 'old' } } }, base(), 'ask', (o) => ({ ...o, image: { ...o.image, model: 'new' } }));
  assert.equal(cleaned.opts.image.model, 'new');
  // a stored value that is not an object is ignored
  assert.deepEqual(flowOpts({ opts: 'junk' }, base(), 'ask'), { opts: base(), mode: 'ask' });
  assert.equal(flowOpts({ opts: { mode: 7 } }, base(), 'ask').mode, 'ask');
});

test('opts are saved per flow: every save of S.opts or S.mode goes through saveFlowOpts', () => {
  assert.match(constExpr('saveOpts'), /\(mode = S\.mode\) => \{ if \(S\.opts\[mode\]\) LS\.set\('opts', globalOptsWrite\(LS\.get\('opts', \{\}\), mode, S\.opts\[mode\], S\.thread\?\.flow\?\.kind\)\); saveFlowOpts\(\); \}/, 'saveOpts writes one mode’s slice to the global choices and saves the flow’s');
  const setMode = fnSource('setMode');
  assert.match(setMode, /if \(!load\) \{ LS\.set\('mode', k\); saveFlowOpts\(\); \}/, 'a chosen mode is saved; a loaded one is not');
  assert.equal(APP.match(/LS\.set\('opts'/g).length, 1, 'one save path for opts');
  assert.equal(APP.match(/LS\.set\('mode'/g).length, 1, 'one save path for mode');

  // saveFlowOpts: a copy of S.opts plus mode on the open thread, saved without moving it up the list
  const calls = [];
  const v = { S: { thread: { id: 't', entries: [] }, opts: { ask: { voice: true } }, mode: 'code' }, persist: (...a) => calls.push(a) };
  lift(v, 'saveFlowOpts');
  v.saveFlowOpts();
  assert.deepEqual(v.S.thread.opts, { ask: { voice: true }, mode: 'code' });
  v.S.opts.ask.voice = false;
  assert.equal(v.S.thread.opts.ask.voice, true, 'a copy');
  assert.deepEqual(calls, [[false, { keepTime: true }]]);
  v.S.thread = null; v.saveFlowOpts();
  assert.equal(calls.length, 1, 'no thread: nothing to save');

  // openFlowOpts: loads a flow's choices into S.opts and S.mode without saving them back
  const modes = [];
  const w = { S: { opts: {}, mode: 'image', thread: null }, MODES: { ask: {}, code: {}, image: {} }, flowOpts, cleanOpts: (o) => o,
    globalOpts: () => ({ ask: { voice: false } }), LS: { get: (k, d) => (k === 'mode' ? 'image' : d) },
    setMode: (k, o) => { modes.push([k, o]); w.S.mode = k; } };
  lift(w, 'openFlowOpts');
  w.openFlowOpts({ id: 'li', flow: { kind: 'linkedin' } });
  assert.deepEqual(w.S.opts, { ask: { voice: true } });
  assert.deepEqual(modes, [['ask', { load: true }]]);
  w.openFlowOpts({ id: 'plain' });
  assert.deepEqual(w.S.opts, { ask: { voice: false } }, 'no flow, no opts: the global choices');
  assert.deepEqual(modes.at(-1), ['image', { load: true }], 'and the global mode');
  w.openFlowOpts({ id: 'same' }); // already in that mode: setMode isn't called again
  assert.equal(modes.length, 2);

  // where a flow is opened or left, its choices load
  assert.match(fnSource('openThread'), /S\.thread = t; openFlowOpts\(t\);/);
  assert.match(fnSource('startFresh'), /S\.thread = null;\n\s*openFlowOpts\(null\);/);
  assert.match(fnSource('openToday'), /S\.thread = t; openFlowOpts\(t\);/, 'the boot resume');
  // a turn in a flow with no choices yet keeps the ones it was sent with
  assert.match(fnSource('submit'), /if \(!S\.thread\) S\.thread = newThread\(\);\n\s*if \(!S\.thread\.opts\) saveFlowOpts\(\);/);
});

test('persist keepTime: a composer change saves the flow without stamping it now', () => {
  const src = fnSource('persist');
  assert.match(src, /keepTime = false/);
  assert.match(src, /const changed = \(!flush && !keepTime\) \|\| due \|\|/);
  assert.match(src, /if \(!keepTime\) persistDue = thread;/);
});

test('newThread(flow) and setFlow(thread, kind)', () => {
  const v = { uid: () => 'id1', cleanFlow };
  lift(v, 'newThread');
  const plain = v.newThread();
  assert.ok(!('flow' in plain), 'no flow: the record is as before');
  assert.deepEqual(Object.keys(plain), ['id', 'title', 'createdAt', 'updatedAt', 'entries']);
  assert.deepEqual(v.newThread({ kind: 'coen' }).flow, { kind: 'coen' });
  assert.ok(!('flow' in v.newThread({ kind: 'Bad Kind' })), 'a bad flow is dropped');

  const log = [];
  const w = { S: { thread: null }, cleanFlow, persist: () => log.push('persist'), DB: { put: (t) => { log.push(['put', t.id]); return Promise.resolve(); } },
    storageError: () => {}, openFlowOpts: (t) => log.push(['open', t.id]), saveFlowOpts: () => log.push('save'), renderOptions: () => log.push('draw'), renderFlowTabs: () => log.push('tabs') };
  lift(w, 'setFlow');
  const open = { id: 'o', entries: [] }; w.S.thread = open;
  w.setFlow(open, 'linkedin');
  assert.deepEqual(open.flow, { kind: 'linkedin' });
  assert.deepEqual(log, [['open', 'o'], 'save', 'draw', 'persist', 'tabs'], 'no choices yet: the kind’s defaults load, are kept by the flow and drawn');
  log.length = 0; open.opts = { mode: 'ask' };
  w.setFlow(open, 'coen');
  assert.deepEqual(log, ['persist', 'tabs'], 'its own choices stay');
  log.length = 0;
  const other = { id: 'x', entries: [], flow: { kind: 'work', color: '--c' } };
  w.setFlow(other, 'kid');
  assert.deepEqual(other.flow, { kind: 'kid' });
  assert.deepEqual(log, [['put', 'x'], 'tabs'], 'another flow is saved as it is');
  log.length = 0;
  w.setFlow(other, 'NOT OK');
  assert.deepEqual(other.flow, { kind: 'kid' }, 'a bad kind changes nothing');
  assert.deepEqual(log, []);
  assert.match(APP, /\nfunction renderFlowTabs\(\) \{/, 'the tab redraw hook exists (the Today page fills it in)');
});

test('lastFlow is kept for the owner, and the old lastThread key is read once as a fallback', () => {
  const keep = constExpr('OWNER_LS_KEEP');
  assert.match(keep, /'lastFlow'/);
  assert.match(keep, /'lastThread'/, 'an older build’s key stays the owner’s too');
  assert.doesNotMatch(APP, /LS\.set\(workspaceKey\('lastThread'\)/, 'nothing writes the old key');
  assert.match(fnSource('persist'), /LS\.set\(workspaceKey\('lastFlow'\), thread\.id\)/);
  assert.match(fnSource('openThread'), /LS\.set\(workspaceKey\('lastFlow'\), t\.id\)/);
  assert.match(fnSource('startFresh'), /LS\.set\(workspaceKey\('lastFlow'\), null\)/);
  assert.match(APP, /const lastId = lsHas\(workspaceKey\('lastFlow'\)\) \? LS\.get\(workspaceKey\('lastFlow'\), null\) : LS\.get\(workspaceKey\('lastThread'\), null\);/);
});

test('days.js is imported like thread-spaces.js and precached', () => {
  assert.match(APP, /from '\.\/days\.js\?v=\d+';/);
  const sw = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  assert.match(sw, /`\/days\.js\?v=\$\{V\}`/);
  // thread.opts never syncs: sync only carries title, flow and entries
  const merge = readFileSync(new URL('../public/sync-merge.js', import.meta.url), 'utf8');
  assert.doesNotMatch(merge, /\.opts\b/);
});

test('globalOptsWrite: one mode’s slice reaches the global choices, never a kind’s defaults or other modes', () => {
  const stored = { ask: { model: '', think: false, voice: false, web: false }, image: { aspect: '1:1' } };
  // a chip change in a linkedin flow (voice came from the kind's defaults): web goes global, voice stays as stored
  const out = globalOptsWrite(stored, 'ask', { model: '', think: false, voice: true, web: true }, 'linkedin');
  assert.deepEqual(out.ask, { model: '', think: false, voice: false, web: true });
  assert.deepEqual(out.image, { aspect: '1:1' }, 'other modes keep the global values');
  assert.equal(stored.ask.web, false, 'a new object');
  // nothing stored for the default key: it is left out, so the built-in default holds
  assert.deepEqual(globalOptsWrite({}, 'ask', { voice: true, web: true }, 'linkedin'), { ask: { web: true } });
  // any other kind, or no flow: the whole slice
  assert.equal(globalOptsWrite(stored, 'ask', { voice: true }, 'coen').ask.voice, true);
  assert.equal(globalOptsWrite(stored, 'ask', { voice: true }, undefined).ask.voice, true);
  // only the named mode: a flow's choices for other modes never copy over
  assert.deepEqual(globalOptsWrite(stored, 'build', { refine: false }, ''), { ...stored, build: { refine: false } });
  // a junk stored value or slice
  assert.deepEqual(globalOptsWrite('junk', 'ask', { web: true }), { ask: { web: true } });
  assert.deepEqual(globalOptsWrite(stored, 'ask', null), stored);
});

test('every change to S.opts is saved: Refine, Omni, Runway and the Context toggle name their mode', () => {
  // each line that assigns into a named mode's S.opts saves that mode on the same line; an S.mode one saves within ten lines
  const all = APP.split('\n');
  const at = all.map((l, i) => (/S\.opts(\.\w+|\[[^\]]+\])(\.\w+|\[[^\]]+\])? = /.test(l) ? i : -1)).filter((i) => i >= 0);
  assert.ok(at.length >= 7, 'found the assignments');
  for (const i of at) {
    const l = all[i], named = l.match(/S\.opts\.(ask|code|image|video|ideas|build)\b/);
    if (named) assert.ok(l.includes(`saveOpts('${named[1]}')`), `saves ${named[1]}: ${l.trim().slice(0, 120)}`);
    else assert.match(all.slice(i, i + 10).join('\n'), /saveOpts\(\)/, `saves: ${l.trim().slice(0, 120)}`);
  }
  // the two Refine paths save after refine is set, so a flow switch keeps it
  assert.equal(APP.split("setMode('build'); S.opts.build.refine = true; saveOpts('build'); renderOptions();").length - 1, 2);
});

// ── Task 6: the Today page, flow tabs, the All timeline and the composer's In: picker ──
const HTML = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const tagOf = (src, id) => { const m = new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`).exec(src); assert.ok(m, `index.html has #${id}`); return m[0]; };

test('index.html has the day bar, flow tabs and flow picker', () => {
  const stage = HTML.slice(HTML.indexOf('<main id="stage">'), HTML.indexOf('</main>'));
  const at = (id) => stage.indexOf(`id="${id}"`);
  // the day bar: the date (it opens the days), ◀ ▶ and search, above the welcome
  assert.match(tagOf(stage, 'dayBar'), /^<nav [^>]*aria-label="[^"]+"/);
  for (const id of ['dayDate', 'dayPrev', 'dayNext', 'daySearch']) assert.match(tagOf(stage, id), /^<button type="button"/, `#${id} is a button`);
  assert.match(tagOf(stage, 'dayPrev'), /aria-label="Previous day"/);
  assert.match(tagOf(stage, 'dayNext'), /aria-label="Next day"/);
  assert.match(tagOf(stage, 'daySearch'), /aria-label="Search days"/);
  // the tabs: a tablist (All and the day's flows are drawn into it), then + Flow
  assert.match(tagOf(stage, 'flowTabs'), /role="tablist"/);
  assert.match(tagOf(stage, 'flowTabs'), /aria-label="[^"]+"/);
  assert.match(stage, /id="newFlowBtn"[^>]*>\+ Flow<\/button>/);
  for (const id of ['dayBar', 'flowTabs', 'newFlowBtn']) assert.ok(at(id) >= 0 && at(id) < at('welcome'), `#${id} is above the welcome`);
  // the All timeline and the empty day; the earlier bar right above the conversation
  assert.match(tagOf(stage, 'timeline'), /^<ol [^>]*aria-label="[^"]+"[^>]*hidden/);
  assert.match(stage, /id="dayEmpty"[^>]*>Nothing yet today\. Ask anything below\.<\/p>/);
  assert.match(stage, /<div class="earlier-bar" id="earlierBar" hidden><button type="button" class="earlier-btn">Earlier in this flow<\/button><\/div>\n\s*<ol class="stream" id="stream"/);
  // the composer: In: is the first of the controls, a real button with a menu
  const controls = HTML.slice(HTML.indexOf('id="composerControls"'));
  const first = /^id="composerControls">\s*(<button[^>]*>)/.exec(controls);
  assert.ok(first && first[1].includes('id="flowPick"'), 'the picker leads the controls');
  assert.match(first[1], /type="button"/);
  assert.match(first[1], /aria-haspopup="menu"/);
  assert.match(first[1], /aria-expanded="false"/);
  assert.match(controls.slice(0, controls.indexOf('</button>')), /<span class="flow-pick-in">In:<\/span>/);
  // the essential options are added after it, so it stays first
  assert.match(APP, /\$\('#flowPick'\)\.insertAdjacentHTML\('afterend', '<div class="essential-options" id="essentialOptions"/);
  assert.doesNotMatch(APP, /\$\('#composerControls'\)\.insertAdjacentHTML\('afterbegin'/);
});

test('new copy passes the humanizer lint', () => {
  const copy = ['All', '+ Flow', 'In:', 'Earlier in this flow · 3', 'Nothing yet today. Ask anything below.', 'New flow', 'Search days', 'Previous day', 'Next day', 'Send to flow'];
  for (const t of copy) assert.deepEqual(problems(t), [], t);
  for (const t of ['>All<', "'New flow'", '+ New flow', 'Earlier in this flow · ${', 'Send to flow']) assert.ok(APP.includes(t) || HTML.includes(t), `the copy is in the app: ${t}`);
});

test('tabFlows: the day\'s flows, most recent first, with the open flow in front when it is not one of them', () => {
  const day = (h, d = 13) => new Date(2026, 10, d, h).getTime();
  const today = dayKey(day(12));
  const a = { id: 'a', createdAt: day(8), entries: [{ createdAt: day(9) }] };
  const b = { id: 'b', createdAt: day(8, 12), entries: [{ createdAt: day(9, 12) }] };
  const c = { id: 'c', createdAt: day(10), entries: [{ createdAt: day(8, 12) }, { createdAt: day(11) }] };
  const fresh = { id: 'n', createdAt: day(12), entries: [] };
  assert.deepEqual(tabFlows([a, b, c], today).map((t) => t.id), ['c', 'a']);
  assert.deepEqual(tabFlows([a, b, c], today, fresh).map((t) => t.id), ['n', 'c', 'a'], 'a new flow (not saved yet) is a tab');
  assert.deepEqual(tabFlows([a, b, c], today, b).map((t) => t.id), ['b', 'c', 'a'], 'a flow opened from an earlier day too');
  const a2 = { ...a, entries: [...a.entries, { createdAt: day(13) }] };
  const got = tabFlows([a, b, c], today, a2);
  assert.deepEqual(got.map((t) => t.id), ['a', 'c']);
  assert.equal(got[0], a2, 'the open flow is the record on screen, not the stored copy');
  assert.deepEqual(tabFlows([], today, null), []);
});

test('earlierCut: where a flow\'s part of the day starts', () => {
  const at = (d, h) => new Date(2026, 10, d, h).getTime();
  const d13 = dayKey(at(13, 12));
  const t = { entries: [{ createdAt: at(11, 9) }, { createdAt: at(12, 9) }, { createdAt: at(13, 9) }, { createdAt: at(13, 10) }] };
  assert.equal(earlierCut(t, d13), 2);
  assert.equal(earlierCut(t, dayKey(at(11, 12))), 0);
  assert.equal(earlierCut(t, dayKey(at(10, 12))), 4, 'nothing on that day: all of it is earlier');
  const redone = { entries: [{ createdAt: at(11, 9) }, { createdAt: at(11, 10), at: at(13, 8) }, { createdAt: at(12, 9) }] };
  assert.equal(earlierCut(redone, d13), 1, 'a turn redone that day starts it');
  assert.equal(earlierCut({ entries: [] }, d13), 0);
  // the earlier bar shows that many, the conversation the rest, numbered as in the whole flow
  const render = fnSource('renderThread');
  assert.match(render, /earlierCut\(flow, S\.day\)/);
  assert.match(render, /\.slice\(streamFrom\)\.forEach\(\(e, k\) => stream\.append\(renderEntry\(e, streamFrom \+ k\)\)\)/);
  assert.match(fnSource('paintEarlier'), /`Earlier in this flow · \$\{n\}`/);
});

// submit's rig, as tests/untrusted-turns.test.mjs builds it, with the real intoFlow
function sendRig(S) {
  const calls = { render: [], run: [] };
  let id = 0;
  const input = { value: '', focus() {} };
  const vars = {
    S, dayKey, input, composerFrom: '', $: () => ({ value: '', focus() {} }), navigator: { onLine: true }, hasCredentials: () => true,
    feat: () => false, running: new Set(), run: async (e) => { calls.run.push(e); }, newThread: () => ({ id: 'n1', title: '', entries: [] }),
    uid: () => `e${++id}`, videoSource: () => null, welcome: { classList: { add() {} } }, stream: { append() {} }, renderEntry: () => ({}),
    renderDay: () => { calls.render.push({ view: S.view, thread: S.thread?.id, entries: S.thread?.entries.length }); },
  };
  lift(vars, 'submit', 'intoFlow');
  return { vars, calls };
}
test('the All view never sends: a turn from All goes into the flow the In: picker names, shown before it is added', async () => {
  const coen = { id: 'coen', title: 'Hall kitchen', opts: { mode: 'ask' }, entries: [{ id: 'old', kind: 'ask', prompt: 'earlier' }] };
  const kid = { id: 'kid', title: 'Science fair', opts: { mode: 'ask' }, entries: [{ id: 'k1', kind: 'ask', prompt: 'magnets' }] };
  const S = { mode: 'ask', day: dayKey(Date.now()), view: 'all', thread: coen, video: null, attachments: [], files: [], opts: { ask: {} }, tester: null };
  const { vars, calls } = sendRig(S);
  await vars.submit('Estimate the cabinets');
  assert.equal(S.view, 'coen', 'the send shows the flow it went into');
  assert.deepEqual(coen.entries.map((e) => e.prompt), ['earlier', 'Estimate the cabinets']);
  assert.deepEqual(kid.entries.map((e) => e.id), ['k1'], 'no other flow is touched');
  assert.deepEqual(calls.render, [{ view: 'coen', thread: 'coen', entries: 1 }], 'drawn as that flow before the turn is added');
  assert.equal(calls.run.length, 1);
  // in a flow, a send stays there and draws nothing again
  await vars.submit('And the counters');
  assert.equal(calls.render.length, 1);
  assert.equal(coen.entries.length, 3);
  // All with "New flow" picked (no flow): a new flow, never a turn without one
  S.view = 'all'; S.thread = null;
  await vars.submit('A post about the bid we won');
  assert.equal(S.view, 'n1');
  assert.deepEqual(S.thread.entries.map((e) => e.prompt), ['A post about the bid we won']);
  // every path that adds a turn goes through it
  for (const fn of ['submit', 'runTasks', 'addRemixEntry']) assert.match(fnSource(fn), /if \(!S\.thread\) S\.thread = newThread\(\);\n(?:\s*if \(!S\.thread\.opts\) saveFlowOpts\(\);[^\n]*\n)?\s*intoFlow\(\);/, fn);
});

test('a turn sent while a past day is shown lands on today, never under the Earlier bar', async () => {
  const today = dayKey(Date.now()), yesterday = dayKey(Date.now() - 864e5);
  const old = Date.now() - 3 * 864e5;
  // All on yesterday, In: a flow with nothing that day
  const coen = { id: 'coen', title: 'Hall kitchen', opts: { mode: 'ask' }, entries: [{ id: 'old', kind: 'ask', prompt: 'earlier', at: old }] };
  const S = { mode: 'ask', day: yesterday, view: 'all', thread: coen, video: null, attachments: [], files: [], opts: { ask: {} }, tester: null };
  const { vars, calls } = sendRig(S);
  vars.earlierOpen = null;
  await vars.submit('Estimate the cabinets');
  assert.equal(S.day, today, 'the page moves to today');
  assert.equal(S.view, 'coen');
  assert.deepEqual(calls.render, [{ view: 'coen', thread: 'coen', entries: 1 }]);
  // already in that flow, reading a past day: it moves to today and keeps the whole conversation open
  S.day = yesterday;
  await vars.submit('And the counters');
  assert.equal(S.day, today);
  assert.equal(calls.render.length, 2);
  assert.equal(vars.earlierOpen, 'coen');
  // the fold never hides a turn made today, whichever day is shown
  const t = { id: 'f', entries: [{ id: 'a', at: old }, { id: 'b', at: Date.now() }] };
  assert.equal(earlierCut(t, yesterday), 2, 'yesterday alone would fold all of it');
  assert.match(fnSource('renderThread'), /Math\.min\(earlierCut\(flow, S\.day\), earlierCut\(flow, dayKey\(Date\.now\(\)\)\)\)/);
  assert.match(fnSource('newFlow'), /S\.day = dayKey\(Date\.now\(\)\);/, 'a new flow lives on today');
});

test('a tab redraw puts focus back on the tab that had it (paintTabs, run)', () => {
  const doc = { activeElement: null };
  const mk = (html) => {
    const view = /data-view="([^"]*)"/.exec(html)[1], selected = /aria-selected="true"/.test(html);
    const b = { dataset: { view }, selected, offsetLeft: 0, offsetWidth: 10, focused: 0, focus() { doc.activeElement = b; b.focused++; } };
    return b;
  };
  let kids = [];
  const box = {
    scrollLeft: 0, clientWidth: 500,
    set innerHTML(h) { kids = (h.match(/<button[^>]*>/g) || []).map(mk); },
    contains: (el) => kids.includes(el),
    querySelector: (s) => (s === '[aria-selected="true"]' ? kids.find((k) => k.selected) || null : null),
    querySelectorAll: (s) => (s === '[role="tab"]' ? kids : []),
  };
  const coen = { id: 'coen', title: 'Hall kitchen', entries: [{ prompt: 'x', at: Date.now() }] };
  const kid = { id: 'kid', title: 'Science fair', entries: [{ prompt: 'y', at: Date.now() }] };
  const S = { day: dayKey(Date.now()), view: 'coen', thread: coen };
  const $ = (s, el = doc) => (s === '#flowTabs' ? box : el.querySelector(s));
  const $$ = (s, el = doc) => [...el.querySelectorAll(s)];
  const v = { S, document: doc, $, $$, tabFlows, kindOf, threadSpaces: {}, esc: (x) => String(x), flowColor: () => 'red', flowName: (t) => t?.title || 'New flow', dayPool: () => [coen, kid] };
  lift(v, 'paintTabs');
  v.paintTabs();
  assert.equal(doc.activeElement, null, 'no focus taken when it was elsewhere');
  // focus on the Science fair tab (not the selected one); a sync redraws
  doc.activeElement = kids.find((k) => k.dataset.view === 'kid');
  v.paintTabs();
  assert.equal(doc.activeElement?.dataset.view, 'kid', 'the same tab, newly drawn, has focus');
  assert.ok(kids.includes(doc.activeElement));
  // a tab that is gone: the selected one gets it
  doc.activeElement = kids.find((k) => k.dataset.view === 'kid');
  v.dayPool = () => [coen];
  v.paintTabs();
  assert.equal(doc.activeElement?.dataset.view, 'coen');
});

test('Today review fixes: empty note only today, focus kept on a redraw, a remote delete keeps a past day', () => {
  for (const fn of ['renderTimeline', 'paintView']) assert.match(fnSource(fn), /Boolean\(S\.thread\?\.entries\.length\) \|\| !isToday\(\)/, fn);
  const tabs = fnSource('paintTabs');
  assert.match(tabs, /had = box\.contains\(document\.activeElement\) \? document\.activeElement\.dataset\.view : null/);
  assert.match(tabs, /find\(\(b\) => b\.dataset\.view === had\) \|\| sel\)\.focus\(/);
  assert.match(fnSource('syncApplied'), /if \(!isToday\(\)\) \{ S\.view = 'all'; earlierOpen = null; openFlowOpts\(null\); renderDay\(\); renderOptions\(\); \}\n\s*else startFresh\(\);/);
});

test('a new flow\'s kind: the sorter guesses it after the first answer, unless he picked one', async () => {
  const GROUPS = groupsFor('owner');
  const run = async ({ thread, answer = '1: kid', hand = false, during } = {}) => {
    const set = [], asked = [];
    const v = { feat: () => true, GROUPS, ME: { bio: '' }, threadSpaces: hand ? { [thread.id]: 'coen!' } : {}, spaceByHand: (s, id) => String(s?.[id] || '').endsWith('!'),
      spaceRequest, parseSpaces, modelFor: () => 'fast-model', noThink: {}, accountReloading: false, DB: { get: async () => thread },
      completeChat: async (o) => { asked.push(o); during?.(); return answer; }, setFlow: (t, k) => set.push([t.id, k]) };
    lift(v, 'guessFlow');
    await v.guessFlow(thread);
    return { set, asked };
  };
  const t = { id: 't1', title: 'Science fair', entries: [{ prompt: 'Science fair ideas with magnets' }] };
  const r = await run({ thread: t });
  assert.deepEqual(r.set, [['t1', 'kid']]);
  assert.equal(r.asked[0].model, 'fast-model');
  assert.deepEqual(r.asked[0].messages, spaceRequest([t], GROUPS, ''), 'the same request the sorter makes');
  assert.deepEqual((await run({ thread: { ...t, flow: { kind: 'coen' } } })).set, [], 'a kind he picked stays');
  assert.deepEqual((await run({ thread: { ...t, id: 't2' }, hand: true })).set, [], 'so does a group he chose by hand');
  const late = { ...t, id: 't3' };
  assert.deepEqual((await run({ thread: late, during: () => { late.flow = { kind: 'work' }; } })).set, [], 'or picked while it was asking');
  assert.deepEqual((await run({ thread: { ...t, id: 't4' }, answer: 'no idea' })).set, []);
  // after the first answer, next to the title
  assert.match(APP, /if \(thread\?\.entries\.length === 1 && !e\.error\) \{ nameThread\(e, thread\); guessFlow\(thread\); \}/);
});

test('Today redraws when threads change: sync, a title, a kind', () => {
  assert.match(fnSource('threadsArrived'), /refreshDay\(\);/);
  assert.match(fnSource('setFlow'), /renderFlowTabs\(\);\n\}/);
  assert.match(fnSource('renderFlowTabs'), /paintTabs\(\); paintPicker\(\);\n\s*refreshDay\(\);/);
  assert.match(fnSource('paintTabs'), /role="tab"/);
  assert.match(fnSource('paintTabs'), /aria-selected="\$\{/);
  assert.match(fnSource('nameThread'), /renderFlowTabs\(\)/);
  // All is drawn from the day's timeline; the conversation shows only in a flow
  assert.match(fnSource('renderTimeline'), /dayTimeline\(/);
  assert.match(fnSource('patchStream'), /if \(S\.view === 'all'\) return;/);
});

// ── Task 7: day navigation, the Days list, search by day, boot opens Today ──
const DAY = 864e5;
const at = (daysAgo, h = 12) => { const d = new Date(); d.setDate(d.getDate() - daysAgo); d.setHours(h, 0, 0, 0); return d.getTime(); };

test('boot opens Today: the last flow when it has something today, else the day\'s All', () => {
  const today = dayKey(Date.now());
  const rig = () => {
    const S = { day: dayKey(Date.now() - 3 * DAY), view: 'all', thread: null };
    const calls = { opts: [], options: 0 };
    const vars = { S, dayKey, daySlice, openFlowOpts: (t) => calls.opts.push(t?.id), renderOptions: () => { calls.options++; }, requestAnimationFrame: () => {}, scrollDown: () => {} };
    lift(vars, 'openToday');
    return { S, calls, vars };
  };
  // the last flow had a turn today: it opens on its tab
  let { S, calls, vars } = rig();
  const coen = { id: 'coen', updatedAt: Date.now(), entries: [{ id: 'a', at: at(2) }, { id: 'b', at: Date.now() }] };
  vars.openToday(coen);
  assert.equal(S.day, today);
  assert.equal(S.view, 'coen');
  assert.equal(S.thread, coen);
  assert.deepEqual(calls.opts, ['coen'], 'its own composer choices');
  // touched recently (the old 6-hour rule would resume it) but its turns are from yesterday: All, In: names a new flow
  ({ S, calls, vars } = rig());
  vars.openToday({ id: 'late', updatedAt: Date.now(), entries: [{ id: 'a', at: at(1, 23) }] });
  assert.equal(S.day, today);
  assert.equal(S.view, 'all');
  assert.equal(S.thread, null);
  assert.deepEqual(calls.opts, []);
  // no last flow, or it is gone from this device
  ({ S, vars } = rig());
  vars.openToday(null);
  assert.equal(S.day, today);
  assert.equal(S.view, 'all');
  // the boot calls it, after a launch check, and no longer measures 6 hours
  const boot = APP.slice(APP.indexOf('const lastId = lsHas('), APP.indexOf('renderDay(); // Today'));
  assert.match(boot, /if \(lastId && !shared\) \{\n\s*const t = await Promise\.race\(\[DB\.get\(lastId\)[^\n]*\n\s*openToday\(recoverThread\(t\)\);\n\s*\}/);
  assert.doesNotMatch(boot, /6 \* 36e5/);
  assert.match(APP, /const shared = launch\.text \|\| launch\.share \|\| launch\.voice; \/\/ a launch skips/, 'a launch still skips the resume and goes to the composer');
});

test('the drawer defaults to Days: a Days order first, the others kept, a stored order respected', () => {
  const sorts = evalIn({}, `return (${constExpr('THREAD_SORTS')});`);
  assert.deepEqual(Object.keys(sorts), ['days', 'recent', 'oldest', 'title', 'entries', 'space']);
  const decl = /\nlet threadSort = ([^\n]*);\n/.exec(APP);
  assert.ok(decl, 'app.js has let threadSort');
  const pick = (stored) => evalIn({ THREAD_SORTS: sorts, LS: { get: (k, d) => (stored === undefined ? d : stored) } }, `return (${decl[1]});`);
  assert.equal(pick(undefined), 'days', 'nothing stored: Days');
  assert.equal(pick('title'), 'title', 'an order picked before is kept');
  assert.equal(pick('nonsense'), 'days');
  // index.html: the drawer is Days, and its select offers Days first
  const drawer = HTML.slice(HTML.indexOf('id="threadsDrawer"'), HTML.indexOf('</aside>', HTML.indexOf('id="threadsDrawer"')));
  assert.match(drawer, /^id="threadsDrawer" role="dialog" aria-modal="true" aria-label="Days"/);
  assert.match(drawer, /<h3><em>Days<\/em><\/h3>/);
  assert.match(drawer, /id="threadSortVal" aria-hidden="true">By day<\/span><select id="threadSort" aria-label="[^"]+"><option value="days">By day<\/option><option value="recent">/);
  // the date opens it in the Days order (this visit only), search too with the box ready
  assert.match(APP, /\$\('#dayDate'\)\.onclick = \(\) => openDays\(\);/);
  assert.match(APP, /\$\('#daySearch'\)\.onclick = \(\) => openDays\(true\);/);
  assert.match(fnSource('openDays'), /threadSort = 'days';/);
  assert.doesNotMatch(fnSource('openDays'), /LS\.set\('threadSort'/, 'the stored order is not changed');
  // a row in the Days order opens that flow on that day
  assert.match(APP, /await openThread\(li\.dataset\.id, li\.dataset\.day\);/);
  // the tabs' arrow keys read every tab ($$, not $: querySelector has no indexOf)
  assert.match(APP, /\$\('#flowTabs'\)\.addEventListener\('keydown', \(ev\) => \{[^\n]*\n\s*const tabs = \$\$\('\[role="tab"\]', \$\('#flowTabs'\)\)/);
  for (const t of ['Days', 'By day', 'Unsorted', 'Browse your days, or search every flow.', 'Search your flows…', 'Search flows', 'Sort flows', 'New flow']) assert.deepEqual(problems(t), [], t);
});

test('the Days order: each day newest first, its flows under it with kind chips; search keeps the day headings', () => {
  const coen = { id: 'coen', title: 'Hall kitchen', flow: { kind: 'coen' }, entries: [{ id: 'c1', at: at(2), prompt: 'cabinet estimate' }, { id: 'c2', at: at(0, 9), prompt: 'counters' }] };
  const kid = { id: 'kid', title: 'Science fair', entries: [{ id: 'k1', at: at(0, 10), prompt: 'magnets' }] };
  const old = { id: 'old', title: 'Garden', entries: [{ id: 'o1', at: at(400), prompt: 'tomatoes' }] };
  const pinned = { id: 'pin', title: 'Pinned one', entries: [{ id: 'p1', at: at(0, 8), prompt: 'pinned' }] };
  const v = { dayKey, dayList, daySlice, pinnedThreads: new Set(['pin']), Date };
  v.dayDate = evalIn(v, `return (${constExpr('dayDate')});`);
  lift(v, 'dayHeading', 'daysRows');
  assert.equal(v.dayHeading(dayKey(Date.now())), 'Today');
  assert.equal(v.dayHeading(dayKey(at(1))), 'Yesterday');
  assert.match(v.dayHeading(dayKey(at(400))), /\d{4}/, 'another year shows its year');
  assert.doesNotMatch(v.dayHeading(dayKey(at(2))), /Today|Yesterday/);
  const rows = v.daysRows([pinned, kid, coen, old]);
  assert.deepEqual(rows.map((r) => `${r.g}:${r.t.id}:${r.day}`), [
    'Pinned:pin:',
    `Today:kid:${dayKey(Date.now())}`, `Today:coen:${dayKey(Date.now())}`, // most recent that day first
    `${v.dayHeading(dayKey(at(2)))}:coen:${dayKey(at(2))}`, // a flow on two days is a row under each
    `${v.dayHeading(dayKey(at(400)))}:old:${dayKey(at(400))}`,
  ]);
  // search: a flow shows under the days where something matched
  const rowsQ = v.daysRows([coen], (t, day) => daySlice(t, day).entries.some((e) => e.prompt.includes('cabinet')));
  assert.deepEqual(rowsQ.map((r) => r.day), [dayKey(at(2))]);
  // renderThreads draws the Days rows: a heading per day, a kind chip, the day on the row, and search per day
  const src = fnSource('renderThreads');
  assert.match(src, /threadSort === 'days' \? daysRows\(all, keep\)/);
  assert.match(src, /const keep = q \? \(t, day\) => hit\(\[t\.title\]\) \|\| daySlice\(t, day\)\.entries\.some\(\(e\) => hit\(entryWords\(e\)\)\) : null;/);
  assert.match(src, /data-day="\$\{esc\(day\)\}"/);
  assert.match(src, /class="flow-chip"/);
  assert.match(src, /'Unsorted'/);
});

test('sending from a past day returns to today: a flow opened from the Days list, then a send', async () => {
  const today = dayKey(Date.now()), yesterday = dayKey(at(1));
  const flow = { id: 'coen', title: 'Hall kitchen', opts: { mode: 'ask' }, entries: [{ id: 'c1', kind: 'ask', prompt: 'cabinets', at: at(1) }] };
  const S = { mode: 'ask', day: today, view: 'all', thread: null, video: null, attachments: [], files: [], opts: { ask: {} }, tester: null };
  const { vars, calls } = sendRig(S);
  Object.assign(vars, { persist: () => {}, liveThreads: new Map([['coen', flow]]), DB: { get: async () => null }, recoverThread: (t) => t, stopReading: () => {}, openFlowOpts: () => {},
    earlierCut, closeDrawers: () => {}, renderOptions: () => {}, LS: { set: () => {} }, workspaceKey: (k) => k, requestAnimationFrame: () => {}, toast: () => {}, accountReloading: false });
  lift(vars, 'openThread');
  await vars.openThread('coen', yesterday);
  assert.equal(S.day, yesterday, 'the Days row opens the flow on its day');
  assert.equal(S.view, 'coen');
  assert.equal(vars.earlierOpen, null, 'yesterday\'s part shows, not the whole flow');
  // a row for a flow no longer here changes nothing
  await vars.openThread('gone', dayKey(at(5)));
  assert.equal(S.day, yesterday);
  calls.render.length = 0;
  await vars.submit('And the counters');
  assert.equal(S.day, today, 'the send lands on today');
  assert.equal(S.view, 'coen');
  assert.equal(calls.render.length, 1);
  assert.equal(vars.earlierOpen, 'coen', 'the conversation he was reading stays open');
  assert.deepEqual(flow.entries.map((e) => e.prompt), ['cabinets', 'And the counters']);
});
