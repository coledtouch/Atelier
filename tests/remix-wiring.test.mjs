// Video Remix wiring in app.js / index.html / data-safety.js (remix-integration.md A1–A18): the Labs gate is owner-only
// and testers never get Remix before the Phase 6 server work; Video mode keeps an attached clip (Phase 0) and says what
// Send will do; imports and backups can't leave anything able to spend. Functions are lifted out of public/app.js and
// run against stubs, as tests/untrusted-turns.test.mjs does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sendMode, REMIX_V, DEFAULT_SHOT_MODEL, validRemix } from '../public/remix.js';
import { validateBackup, prepareImport, recoverThread } from '../public/data-safety.js';
import { normalizeMe } from '../public/tester.js';

const read = async (p) => (await readFile(new URL(`../${p}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const [APP, HTML] = await Promise.all([read('public/app.js'), read('public/index.html')]);

function fnSource(name) {
  let at = APP.indexOf(`\nfunction ${name}(`);
  if (at < 0) at = APP.indexOf(`\nasync function ${name}(`);
  assert.ok(at >= 0, `app.js has function ${name}`);
  at += 1;
  return APP.slice(at, APP.indexOf('\n}\n', at) + 2);
}
function constSource(name) {
  const at = APP.indexOf(`\nconst ${name} = `);
  assert.ok(at >= 0, `app.js has const ${name}`);
  return APP.slice(at + 1, APP.indexOf('\n', at + 1));
}
function scope(vars) {
  return new Proxy(vars, {
    has: (t, k) => typeof k === 'string' && (k in t || !(k in globalThis)),
    get: (t, k) => (k === Symbol.unscopables ? undefined : k in t ? t[k] : () => undefined),
    set: (t, k, v) => { t[k] = v; return true; },
  });
}
const evalIn = (vars, body) => new Function('scope', `with (scope) { ${body} }`)(scope(vars));
const remixOnWith = (vars) => evalIn(vars, `${constSource('remixOn')} return remixOn();`);

test('Labs gate: the owner has Remix on by default and can turn it off; a tester only with features.remix === true', () => {
  const remix = {};
  assert.equal(remixOnWith({ remix, S: { tester: null, settings: {} } }), true, 'an owner whose settings predate Labs');
  assert.equal(remixOnWith({ remix, S: { tester: null, settings: { labs: { remix: true } } } }), true);
  assert.equal(remixOnWith({ remix, S: { tester: null, settings: { labs: { remix: false } } } }), false, 'the Labs toggle off');
  assert.equal(remixOnWith({ remix: null, S: { tester: null, settings: { labs: { remix: true } } } }), false, 'before createRemix (load time)');
  for (const features of [{}, { remix: false }, { remix: 'yes' }, { video: true, veo: true }]) {
    assert.equal(remixOnWith({ remix, S: { tester: { features }, settings: { labs: { remix: true } } } }), false, `tester ${JSON.stringify(features)}`);
  }
  assert.equal(remixOnWith({ remix, S: { tester: { features: { remix: true } }, settings: {} } }), true, 'only an explicit opt-in (Phase 6)');
  // And the server can't opt a tester in yet: normalizeMe keeps a fixed feature list without 'remix'.
  assert.notEqual(normalizeMe({ features: { remix: true } })?.features?.remix, true, 'normalizeMe must not pass features.remix until Phase 6');
  assert.match(APP, /\n {2}labs: \{ remix: true \},/, 'DEFAULT_SETTINGS.labs.remix is on (mergeDeep fills it in for existing installs)');
});

test('the Labs toggle lives in the owner-only Settings section, named for what it does', () => {
  const at = HTML.indexOf('id="labsRemixBtn"');
  assert.ok(at > 0, 'index.html has #labsRemixBtn');
  const section = HTML.slice(HTML.lastIndexOf('<section', at), at);
  assert.match(section, /^<section class="field-group owner-only">/, 'inside the owner-only section (testers never see it)');
  assert.match(HTML.slice(at, HTML.indexOf('</button>', at)), />Remix videos in Video mode$/);
  assert.match(APP, /\$\('#labsRemixBtn'\)\?\.addEventListener\('click'/);
  assert.match(HTML, /<link rel="stylesheet" href="\/remix\.css\?v=\d+" \/>/);
});

test('sendMode: a clip in Video mode remixes only with Remix on; otherwise it is answered in Ask (never a silent Veo clip)', () => {
  assert.equal(sendMode('video', true, true), 'remix');
  assert.equal(sendMode('video', true, false), 'ask');
  assert.equal(sendMode('ask', true, true), 'ask');
  assert.equal(sendMode('code', true, true), 'code');
  assert.equal(sendMode('image', true, true), 'ask');
  assert.equal(sendMode('video', false, true), 'video', 'no clip: Video mode films as before');
  const submit = fnSource('submit');
  assert.match(submit, /const route = video \? sendMode\(mode, true, remixOn\(\)\) : mode;/);
  assert.match(submit, /if \(video && route === 'ask' && mode !== 'ask'\) \{ mode = 'ask'; setMode\('ask'\);/, 'the Ask coercion follows the route');
  assert.match(submit, /if \(!text && route === 'remix'\) \{ await remix\.composer\.gate\('', video, S\.thread\); return; \}/, 'an empty remix send is held, not given made-up words');
  assert.match(submit, /if \(route === 'remix'\) e\.remix = remix\.newRemix\(video, text\);/);
  assert.ok(submit.indexOf("route === 'remix' && (await remix.composer.gate(text") < submit.indexOf('launchSubmitted('), 'the gate runs before anything is marked or cleared');
  assert.match(fnSource('run'), /else if \(e\.kind === 'video'\) await \(e\.remix \? remix\.plan\(e, signal, thread\) : runVideo\(e, signal\)\);/);
});

function attachIn(mode, on) {
  const calls = { setMode: [], toasts: [], attached: [] };
  const S = { mode, video: null };
  const vars = {
    S, LOCAL_MAX_BYTES: 4e9, URL: { createObjectURL: () => 'blob:x' }, cleanName: (n) => n, normalizeVideoMime: () => 'video/mp4',
    chatMode: () => S.mode === 'ask' || S.mode === 'code', setMode: (k) => { calls.setMode.push(k); S.mode = k; }, toast: (m) => calls.toasts.push(m),
    remixOn: () => on, remix: { composer: { attached: (v) => calls.attached.push(v) } },
    renderAttachments() {}, renderOptions() {}, maybeStartClip() {}, input: { focus() {} }, readVideo: () => new Promise(() => {}),
  };
  const attachVideo = evalIn(vars, `return (${fnSource('attachVideo')});`);
  attachVideo({ name: 'clip.mp4', type: 'video/mp4', size: 1000 });
  return { calls, S };
}
test('Phase 0: attaching a video in Video mode stays in Video (Remix on or off); other modes still switch to Ask', () => {
  for (const on of [true, false]) {
    const { calls, S } = attachIn('video', on);
    assert.deepEqual(calls.setMode, [], `Remix ${on ? 'on' : 'off'}: no switch`);
    assert.deepEqual(calls.toasts, []);
    assert.equal(S.mode, 'video');
    assert.equal(calls.attached.length, on ? 1 : 0, 'the probe (no spend) starts at attach only with Remix on');
  }
  for (const mode of ['image', 'ideas', 'build']) {
    const { calls } = attachIn(mode, true);
    assert.deepEqual(calls.setMode, ['ask'], `${mode} → Ask`);
    assert.deepEqual(calls.toasts, ['Switched to Ask to talk about the video']);
  }
  const { calls } = attachIn('ask', true);
  assert.deepEqual(calls.setMode, []);
});

test('Phase 0: the attached-video note says what Send does in Video mode', () => {
  const note = (mode, on) => evalIn({
    S: { mode, tester: null }, chatMode: () => mode === 'ask' || mode === 'code', remixOn: () => on,
    remix: { composer: { note: () => 'Remix · Gemini watches & hears it · fast cut' } },
    modelFor: () => 'gemini:x', clipRoute: () => true, clipOk: () => true, clipWhy: () => null,
  }, `return (${fnSource('videoNote')})({ status: 'ready', clip: { state: 'active' } });`);
  assert.equal(note('video', false), 'Video mode films new clips — sending asks about this video in Ask');
  assert.equal(note('video', true), 'Remix · Gemini watches & hears it · fast cut');
  assert.equal(note('image', true), 'Videos are answered in Ask — sending switches there');
  assert.equal(note('ask', true), 'Gemini will watch & hear it');
  // The Video options strip with a clip and Remix off: a visible way over to Ask, wired in the strip's click handler.
  assert.match(APP, /<button class="chip" data-ask-about>Ask about it<\/button><span class="opt-note keep">Video mode films new clips<\/span>/);
  assert.match(APP, /if \(ev\.target\.closest\('\[data-ask-about\]'\)\) \{ setMode\('ask'\); return; \}/);
  assert.match(APP, /if \(ev\.target\.closest\('\[data-remix-in-video\]'\)\) \{ setMode\('video'\); return; \}/);
});

// ── data-safety ──
const remixOf = (over = {}) => ({
  v: REMIX_V, phase: 'film', rev: 1, opts: {}, plan: { title: 'x', timeline: [] }, issues: [], assets: {},
  shots: { s1: { state: 'filming', model: DEFAULT_SHOT_MODEL, op: 'models/veo-3.1-lite/operations/abc123', startedAt: 1 },
    s2: { state: 'starting', model: DEFAULT_SHOT_MODEL }, s3: { state: 'ready', model: DEFAULT_SHOT_MODEL, blobKey: 'rx:shot:e1:s3', bytes: 10 } },
  approval: { keys: { s1: 'k' }, usd: 0.4, at: 1 },
  ...over,
});
const backup = (remix, extra = {}) => ({ app: 'atelier', v: 1, threads: [{ id: 't1', title: 'T', createdAt: 1, updatedAt: 2, entries: [
  { id: 'e0', kind: 'video', prompt: 'p', createdAt: 1, remix: remixOf({ phase: 'done' }) },
  { id: 'e1', kind: 'video', prompt: 'p', createdAt: 1, remix, ...extra }] }] });

test('validRemix checks the cut poster and the revision ids that build kv keys', () => {
  const poster = 'data:image/jpeg;base64,AAAA';
  const exp = { path: 'webcodecs', mime: 'video/mp4', bytes: 1, w: 2, h: 2, fps: 30, seconds: 1, kbps: 1, at: 1 };
  assert.ok(validRemix(remixOf({ export: { ...exp, poster } })));
  assert.ok(!validRemix(remixOf({ export: { ...exp, poster: 'javascript:alert(1)' } })));
  assert.ok(!validRemix(remixOf({ export: { ...exp, poster: 'data:image/svg+xml;base64,AAAA' } })));
  assert.ok(!validRemix(remixOf({ export: { ...exp, poster: `data:image/jpeg;base64,${'A'.repeat(130_000)}` } })), 'over 120 KB');
  assert.ok(validRemix(remixOf({ reviseOf: 'e0', srcEntry: 'e0' })));
  for (const bad of ['../x', 'a:b', '', 'x'.repeat(121), 5]) {
    assert.ok(!validRemix(remixOf({ reviseOf: bad })), `reviseOf ${JSON.stringify(bad)}`);
    assert.ok(!validRemix(remixOf({ srcEntry: bad })), `srcEntry ${JSON.stringify(bad)}`);
  }
  assert.throws(() => validateBackup(backup(remixOf({ srcEntry: '../../x' }))), /valid Atelier thread backup/);
  assert.throws(() => validateBackup(backup(remixOf(), { remixOf: 'bad id!' })));
});

test('an imported remix can never spend: approval dropped, live shots marked missing, revision ids follow the new ids', () => {
  let n = 0;
  const [t] = prepareImport(backup(remixOf({ reviseOf: 'e0', srcEntry: 'e0' })), () => `n${++n}`);
  const [orig, e] = t.entries;
  assert.equal(e.remix.approval, null);
  assert.equal(e.remix.shots.s1.state, 'missing'); assert.equal(e.remix.shots.s1.op, undefined);
  assert.equal(e.remix.shots.s2.state, 'unknown');
  assert.equal(e.remix.shots.s3.state, 'missing'); assert.equal(e.remix.shots.s3.blobKey, undefined);
  assert.equal(e.remix.phase, 'review', 'film → review: a new Approve is needed');
  assert.equal(e.remix.reviseOf, orig.id, 'reviseOf points at the imported original');
  assert.equal(e.remix.srcEntry, 'e0', 'srcEntry is left alone (it only finds a File on this device)');
});

test('opening a thread (recoverThread) never rewrites remix shots: synced live shots belong to the other device', () => {
  const t = { id: 't1', entries: [{ id: 'e1', kind: 'video', remix: remixOf() }] };
  recoverThread(t);
  const s = t.entries[0].remix.shots;
  assert.deepEqual([s.s1.state, s.s2.state, s.s3.state], ['filming', 'starting', 'ready']);
  assert.ok(t.entries[0].remix.approval, 'approval untouched');
});

test('review: Clear this device stops remix before kvClear; a refused Revise keeps the typed text', () => {
  const wipe = APP.slice(APP.indexOf("$('#wipeBtn').onclick"), APP.indexOf('function applyTheme'));
  assert.ok(wipe.indexOf('remix?.wipe()') > 0 && wipe.indexOf('remix?.wipe()') < wipe.indexOf('DB.kvClear()'), 'jobs and drafts stop before rx:* is cleared');
  const line = APP.split('\n').find((l) => l.includes('c?.revise'));
  assert.match(line, /if \(remix\.revise\(c\.entry, text\)\) \{ input\.value = ''/, 'the composer is cleared only when a revision was made');
});
