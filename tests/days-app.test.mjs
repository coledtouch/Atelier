import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { kindOf, cleanFlow, flowHint, flowOpts, globalOptsWrite, KIND_DEFAULTS } from '../public/days.js';
import { groupsFor } from '../public/thread-spaces.js';

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
  assert.match(APP, /S\.thread = recoverThread\(t\); openFlowOpts\(S\.thread\);/, 'the boot resume');
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
