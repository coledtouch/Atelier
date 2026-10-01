// Quick launch as wired into public/app.js, index.html and the stylesheets (the parts launch.test.mjs can't reach).
// Functions are lifted out of app.js and run against stubs, as tests/lookup-client.test.mjs does for submit().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHold, NOTES, HOLD_MS } from '../public/launch.js';
import { insertText, micHelp, MIC_HELP } from '../public/dictate.js';

const read = async (p) => (await readFile(new URL(`../${p}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const [APP, HTML, APP_CSS, STUDIO_CSS] = await Promise.all(['public/app.js', 'public/index.html', 'public/app.css', 'public/studio.css'].map(read));

// ── lifting ──
// The source of `function name(` up to its closing brace at column 0.
function fnSource(name) {
  const at = APP.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `app.js has function ${name}`);
  return APP.slice(at, APP.indexOf('\n}\n', at) + 2);
}
// A scope where the stubs are the module's variables (reads and writes), and any other name not on globalThis is a no-op.
function scope(vars) {
  return new Proxy(vars, {
    has: (t, k) => typeof k === 'string' && (k in t || !(k in globalThis)),
    get: (t, k) => (k === Symbol.unscopables ? undefined : k in t ? t[k] : () => undefined),
    set: (t, k, v) => { t[k] = v; return true; },
  });
}
const evalIn = (vars, body) => new Function('scope', `with (scope) { ${body} }`)(scope(vars));
const fakeTimers = () => {
  const due = new Map(); let id = 0;
  return { setTimeout: (f, ms) => { due.set(++id, { f, ms }); return id; }, clearTimeout: (t) => due.delete(t), due };
};

// holdThenSend + launchSubmitted with a #toast that knows which toast is up (a newer toast replaces the Cancel button).
function holdRig() {
  const calls = [], timers = fakeTimers();
  const toastEl = { shown: false, msg: '', act: null, contains(x) { return x != null && x === this.act; } };
  const vars = {
    calls, toastEl, timers, sendHold: null, draftT: 0, micSendAfter: false,
    S: { mode: 'ask', busy: false, attachments: [], video: null },
    NOTES, HOLD_MS,
    hasDraft: () => true, micOn: () => false,
    createHold: (o) => createHold({ ...o, timers }),
    $: (sel) => ({ '#sendBtn': { classList: { add() {}, remove() {} }, style: { setProperty() {}, removeProperty() {} } }, '#toast': toastEl,
      '#toast .toast-act': toastEl.act, '#composerSrc': { hidden: true } })[sel] ?? null,
    input: { addEventListener() {}, removeEventListener() {} },
    document: { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' },
    toast: (msg, o = {}) => { calls.push(['toast', msg]); toastEl.shown = true; toastEl.msg = msg; toastEl.act = o.action ? { click: () => { vars.hideToast(); o.action.onClick(); } } : null; },
    hideToast: () => { calls.push(['hideToast']); toastEl.shown = false; },
    armSend: () => calls.push(['armSend']),
    submit: (...a) => calls.push(['submit', ...a]),
    clearArm() {}, clearSource() {}, clearTimeout() {}, drafts: { sent() {} },
  };
  const fns = evalIn(vars, `return { holdThenSend: (${fnSource('holdThenSend')}), launchSubmitted: (${fnSource('launchSubmitted')}) };`);
  vars.holdThenSend = (o) => { calls.push(['holdThenSend', o]); return fns.holdThenSend(o); };
  return { ...fns, vars, calls, toastEl, timers };
}

test('a send that goes out during the hold (Enter, Send after dictation) takes "Sending… Cancel" down with it', () => {
  const r = holdRig();
  r.holdThenSend({ ms: HOLD_MS.link });
  assert.ok(r.vars.sendHold, 'holding');
  assert.deepEqual([r.toastEl.shown, r.toastEl.msg, Boolean(r.toastEl.act)], [true, NOTES.sending, true]);
  r.launchSubmitted(true); // submit() of the composer: cancel('sent')
  assert.equal(r.vars.sendHold, null);
  assert.equal(r.toastEl.shown, false, 'no Cancel left on screen for a prompt that already went');
  assert.equal(r.calls.some((c) => c[0] === 'armSend' || (c[0] === 'toast' && c[1] === NOTES.held)), false, 'nothing is "held"');
  // A newer toast is left alone.
  const n = holdRig();
  n.holdThenSend({ ms: HOLD_MS.voice });
  n.vars.toast('Something else');
  n.launchSubmitted(true);
  assert.deepEqual([n.toastEl.shown, n.toastEl.msg], [true, 'Something else']);
  // Sign-out or Clear this device (cancel('quiet')) takes it down too; Cancel itself still says "Held".
  const q = holdRig();
  q.holdThenSend({ ms: HOLD_MS.link }); q.vars.sendHold.cancel('quiet');
  assert.equal(q.toastEl.shown, false);
  const c = holdRig();
  c.holdThenSend({ ms: HOLD_MS.link }); c.toastEl.act.click();
  assert.deepEqual([c.toastEl.shown, c.toastEl.msg, c.calls.some((x) => x[0] === 'armSend')], [true, NOTES.held, true]);
  assert.equal(c.timers.due.size, 0, 'the hold timer is gone');
});

test('dictatedSend: Send pressed while Talk listened sends once through paintMic, with no hold (or stale toast) on top', () => {
  const r = holdRig();
  const src = /\ndictatedSend = \(\) => \{[\s\S]*?\n\};\n/.exec(APP)?.[0];
  assert.ok(src, 'app.js assigns dictatedSend');
  evalIn(r.vars, src);
  r.vars.micSendAfter = true;
  r.vars.dictatedSend();
  assert.deepEqual(r.calls, [], 'no hold and no pulse: paintMic sends what was said, once');
  r.vars.micSendAfter = false;
  r.vars.dictatedSend();
  assert.deepEqual(r.calls.find((c) => c[0] === 'holdThenSend'), ['holdThenSend', { ms: HOLD_MS.voice }]);
  assert.equal(r.toastEl.msg, NOTES.sending);
});

test('onText: a launch that listens without sending pulses Send after the words; a tapped mic is plain dictation', () => {
  const at = APP.indexOf('  onText: (text, {');
  const src = APP.slice(at + '  onText: '.length, APP.indexOf('\n  },\n', at) + 4);
  const rig = (micSendAfter = false) => {
    const calls = [];
    const vars = {
      calls, micSendAfter, micAt: null, micSel: null, micAdded: '', insertText, COARSE: { matches: true },
      input: { value: '', selectionStart: 0, selectionEnd: 0, setSelectionRange() {}, focus() {}, dispatchEvent() {} },
      document: { activeElement: null }, Event: class { constructor(type) { this.type = type; } },
      dictatedSend: () => calls.push('dictatedSend'), armSend: () => calls.push('armSend'),
    };
    return { onText: evalIn(vars, `return (${src});`), calls, vars };
  };
  const review = rig();
  review.onText('hello there', { final: false, auto: true, autoSend: false });
  assert.deepEqual(review.calls, [], 'not before the words are final');
  review.onText('hello there', { final: true, auto: true, autoSend: false });
  assert.deepEqual(review.calls, ['armSend'], 'Review, ?start=voice&q=…, a restored draft, listen when I open');
  assert.equal(review.vars.input.value, 'hello there');
  const send = rig();
  send.onText('hi', { final: true, auto: true, autoSend: true });
  assert.deepEqual(send.calls, ['dictatedSend']);
  const tapped = rig();
  tapped.onText('hi', { final: true, auto: false, autoSend: false });
  assert.deepEqual(tapped.calls, [], 'a tap on the mic (or an armed launch) is plain dictation');
  const pressed = rig(true);
  pressed.onText('hi', { final: true, auto: true, autoSend: false });
  assert.deepEqual(pressed.calls, [], 'Send was pressed while listening: paintMic sends it');
});

test('toast({ silent }) keeps the message out of #toast’s live region; the next toast is announced again', () => {
  const log = [], attrs = new Map(), timers = fakeTimers();
  const body = { append() {} };
  const t = {
    parentElement: body, classList: { toggle() {}, add() {}, remove() {} }, append() {},
    setAttribute: (k, v) => attrs.set(k, v), removeAttribute: (k) => attrs.delete(k),
    set textContent(v) { log.push([v, attrs.get('aria-hidden') ?? null]); }, get textContent() { return log.at(-1)?.[0] ?? ''; },
  };
  const vars = { $: (sel) => (sel === '#toast' ? t : null), $$: () => [], document: { body, createElement: () => ({}) }, toastT: 0, ...timers };
  const { toast } = evalIn(vars, `return { toast: (${fnSource('toast')}) };`);
  toast(NOTES.listening, { silent: true });
  assert.deepEqual(log.at(-1), [NOTES.listening, 'true'], 'aria-hidden="true" is set before the text changes');
  toast(NOTES.sending);
  assert.deepEqual(log.at(-1), [NOTES.sending, null], 'and removed before the next one');
  assert.equal(HTML.includes('<div class="toast" id="toast" role="status"></div>'), true, '#toast is the polite live region this guards');
});

test('Test the mic gives the same unblock steps as the mic: an Android tab has no Atelier icon to touch and hold', () => {
  const at = APP.indexOf("$('#qlTest')?.addEventListener('click'");
  const handler = APP.slice(at, APP.indexOf('\n});\n', at));
  assert.match(handler, /\? micHelp\(dictation\.platform\) :/);
  assert.doesNotMatch(handler, /MIC_BLOCKED/);
  assert.equal(micHelp({ android: true, standalone: false }), MIC_HELP.android);
  assert.match(MIC_HELP.android, /Tap the icon left of the address/);
  assert.equal(micHelp({ android: true, standalone: true }), MIC_HELP.androidApp);
  assert.equal(micHelp({}), MIC_HELP.desktop);
});

test('the iPhone recipe never starts with a dangling "Or": "Build the Shortcut:" while no Shortcut is published', () => {
  const li = /<li><span id="qlGetHint" hidden>([\s\S]*?)<\/span><span id="qlBuildHint">([^<]*)<\/span>Shortcuts → \+/.exec(HTML);
  assert.ok(li, 'the recipe step has both leads');
  assert.match(li[1], /Get the Shortcut<\/b> and paste your link when it asks\. Or build it yourself: $/);
  assert.equal(li[2], 'Build the Shortcut: ');
  assert.match(APP, /\$\('#qlBuildHint'\)\.hidden = Boolean\(QUICK_SHORTCUT_URL\);/);
  assert.match(APP, /\$\('#qlGet'\)\.hidden = \$\('#qlGetHint'\)\.hidden = !QUICK_SHORTCUT_URL;/);
});

test('the "From a link / From another app or site" note is #input’s description, and is emptied whenever it hides', () => {
  assert.match(HTML, /<textarea id="input"[^>]* aria-describedby="composerSrc"[^>]*><\/textarea>/);
  assert.match(HTML, /<p class="hint composer-src" id="composerSrc" hidden><\/p>/, 'starts hidden and empty');
  assert.match(fnSource('clearSource'), /p\.hidden = true; p\.textContent = '';/);
});

test('one armed ring on the mic, and the hold ring follows Send’s rounded square', () => {
  for (const [name, css] of [['app.css', APP_CSS], ['studio.css', STUDIO_CSS]]) assert.doesNotMatch(css, /#micBtn\.armed::after/, `${name}: no second (pink) armed ring`);
  assert.match(APP_CSS, /#micBtn\.armed \{[^}]*box-shadow: 0 0 0 2px var\(--accent\)/);
  const send = /\n\.send \{ width: (\d+)px; height: (\d+)px; border-radius: (\d+)px; \}/.exec(STUDIO_CSS);
  assert.ok(send, 'studio.css sizes Send');
  const hold = /\.send\.holding::before \{([^}]*)\}/.exec(APP_CSS)?.[1] || '';
  const inset = -Number(/inset: (-?\d+)px/.exec(hold)?.[1]), radius = Number(/border-radius: (\d+)px/.exec(hold)?.[1]), pad = Number(/padding: (\d+)px/.exec(hold)?.[1]);
  assert.equal(radius, Number(send[3]) + inset, 'outer corners concentric with the button’s');
  assert.ok(pad > 0 && pad < inset, 'a band that leaves a gap to the button');
  assert.doesNotMatch(hold, /border-radius: 50%/);
  assert.match(hold, /mask-composite: exclude/);
});
