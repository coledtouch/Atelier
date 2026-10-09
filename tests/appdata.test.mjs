// Build app data (public/appdata.js): the storage shim, run as the exact script a preview document gets, in its own JS
// context standing in for a sandboxed opaque-origin frame (the browser's localStorage there throws SecurityError); the
// parent's message checks, source binding, caps, debounced writes, clear and workspace scoping; and an app's data
// surviving an Atelier reload, a refine and a restore, with another app never seeing it.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  storageShim, previewDoc, injectFirst, readMessage, readOps, createAppStore, createBridge, idbBackend, appKey, workspaceDb, fmtBytes, validKey,
  MSG, APP_CAP, KEY_MAX, KEYS_MAX, OPS_MAX, VALUE_MAX,
} from '../public/appdata.js';
import { restoreBase } from '../public/builds.js';
import { prepareImport } from '../public/data-safety.js';

const ORIGIN = 'https://atelier.test';
const TOKEN = 'ab'.repeat(16);
const LS_SEP = String.fromCharCode(0x2028);
const settle = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

// ── a sandboxed frame, as far as the shim can tell ──
// window is the context's global; its own localStorage / sessionStorage throw SecurityError (an opaque origin), Storage
// is an interface whose methods throw "Illegal invocation" on anything but a real storage, and parent.postMessage records.
const PRELUDE = `
var window = globalThis;
window.parent = parentWin;
window.location = { href: 'about:srcdoc' };
const et = new EventTarget();
window.addEventListener = (...a) => et.addEventListener(...a);
window.removeEventListener = (...a) => et.removeEventListener(...a);
window.dispatchEvent = (e) => et.dispatchEvent(e);
class StorageEvent extends Event {
  constructor(type, init = {}) { super(type); this._init = init; }
  get key() { return this._init.key ?? null; } get oldValue() { return this._init.oldValue ?? null; } get newValue() { return this._init.newValue ?? null; }
  get url() { return this._init.url ?? ''; } get storageArea() { return this._init.storageArea ?? null; }
}
window.StorageEvent = StorageEvent;
function Storage() { throw new TypeError('Illegal constructor'); }
const illegal = function () { throw new TypeError('Illegal invocation'); };
for (const name of ['key', 'getItem', 'setItem', 'removeItem', 'clear']) Object.defineProperty(Storage.prototype, name, { value: illegal, writable: true, enumerable: true, configurable: true });
Object.defineProperty(Storage.prototype, 'length', { get: illegal, enumerable: true, configurable: true });
Object.defineProperty(Storage.prototype, Symbol.toStringTag, { value: 'Storage', configurable: true });
window.Storage = Storage;
const denied = (name) => ({ get() { throw new DOMException("Failed to read the '" + name + "' property from 'Window': The document is sandboxed and lacks the 'allow-same-origin' flag.", 'SecurityError'); }, enumerable: true, configurable: true });
Object.defineProperty(window, 'localStorage', denied('localStorage'));
Object.defineProperty(window, 'sessionStorage', denied('sessionStorage'));
var document = { currentScript: { removed: false, remove() { this.removed = true; } } };
`;
// The shim script exactly as previewDoc embeds it: everything between <script> and the first </script>.
const SHIM_HEAD = `<script>(${storageShim})(`;
function shimScript(doc) {
  const at = doc.indexOf(SHIM_HEAD);
  assert.ok(at >= 0, 'the document starts with the shim');
  const end = doc.indexOf('</script>', at);
  return doc.slice(at + '<script>'.length, end);
}
function cfgOf(doc) {
  const at = doc.indexOf(SHIM_HEAD) + SHIM_HEAD.length;
  return JSON.parse(doc.slice(at, doc.indexOf(')</script>', at)));
}
// A MessageChannel stand-in: each side records what it sent (at once); the other side gets it a microtask later.
function fakeChannel() {
  const side = () => ({
    onmessage: null, closed: false, sent: [], other: null,
    postMessage(m) {
      const data = structuredClone(m), o = this.other;
      this.sent.push(data);
      if (this.closed || o.closed) return;
      queueMicrotask(() => { if (!o.closed) o.onmessage?.({ data }); });
    },
    close() { this.closed = true; },
  });
  const port1 = side(), port2 = side();
  port1.other = port2; port2.other = port1;
  return { port1, port2 };
}
// port: answer the document's hello with a port at once, as Atelier does (false: the test connects it).
function frame(doc, { deliver, port = true, prelude = '' } = {}) {
  const posts = [];
  const parentWin = { postMessage(msg, origin) { const m = structuredClone(msg); posts.push({ msg: m, origin }); deliver?.(m, origin); } };
  const ctx = vm.createContext({ queueMicrotask, DOMException, EventTarget, Event, structuredClone, parentWin, console });
  vm.runInContext(PRELUDE + prelude, ctx);
  const run = (src) => vm.runInContext(src, ctx);
  run(shimScript(doc));
  // A window message to the frame: from Atelier (or, with `from`, someone else), with `ports` when it carries one.
  const receive = (data, { from = parentWin, origin = ORIGIN, ports } = {}) => {
    const ev = new Event('message');
    Object.assign(ev, { data, source: from, origin, ports: ports || [] });
    ctx.window.dispatchEvent(ev);
  };
  let channel = null;
  const connect = (token = cfgOf(doc).token) => { channel = fakeChannel(); receive({ type: MSG, v: 1, token, kind: 'port' }, { ports: [channel.port2] }); return channel; };
  if (port && cfgOf(doc).persist) connect();
  const sent = () => (channel ? channel.port2.sent : []); // what the frame sent on its port
  const ops = () => sent().flatMap((m) => m.ops);
  const event = (ops, token = cfgOf(doc).token) => channel.port1.postMessage({ type: MSG, v: 1, token, kind: 'event', ops }); // Atelier → frame
  return { ctx, run, posts, ops, sent, receive, connect, event, parentWin, channel: () => channel };
}
const cfg = (over = {}) => ({ type: MSG, token: TOKEN, origin: ORIGIN, persist: true, items: [], quota: APP_CAP, ...over });
const doc = (over = {}, html = '<!doctype html><html><head><title>t</title></head><body></body></html>') => previewDoc(html, cfg(over));

test('the shim replaces the sandbox’s throwing localStorage before any app script, under every name an app uses', async () => {
  const f = frame(doc({ items: [['habits', '[1,2]']] }));
  assert.equal(f.run("typeof localStorage"), 'object');
  assert.equal(f.run('localStorage === window.localStorage && localStorage === globalThis.localStorage'), true);
  assert.equal(f.run("localStorage.getItem('habits')"), '[1,2]', 'the app’s saved items are there at once, synchronously');
  // Typical generated code, unmodified.
  f.run("const x = JSON.parse(localStorage.getItem('habits') || '[]'); x.push(3); localStorage.setItem('habits', JSON.stringify(x));");
  assert.equal(f.run("localStorage.getItem('habits')"), '[1,2,3]');
  assert.equal(f.run("Object.getOwnPropertyDescriptor(window, 'localStorage').configurable"), true);
  assert.equal(f.ctx.document.currentScript.removed, true, 'the script (and the items in it) leave the app’s DOM');
  await settle();
  assert.deepEqual(f.posts, [{ msg: { type: MSG, v: 1, token: TOKEN, kind: 'hello', ok: true }, origin: ORIGIN }], 'its only window message: hello, to Atelier’s origin');
  assert.deepEqual(f.sent(), [{ type: MSG, v: 1, token: TOKEN, kind: 'ops', ops: [['s', 'habits', '[1,2,3]']] }], 'writes go on the port Atelier gave it');
});

test('Storage API semantics: getItem / setItem / removeItem / clear / key / length and the WebIDL conversions', async () => {
  const f = frame(doc({ items: [['a', '1'], ['b', '2']] }));
  const r = (s) => f.run(s);
  assert.equal(r('localStorage.length'), 2);
  assert.equal(r('localStorage.key(0)'), 'a');
  assert.equal(r('localStorage.key(1.9)'), 'b', 'unsigned long: truncated');
  assert.equal(r("localStorage.key('1')"), 'b');
  assert.equal(r('localStorage.key(2)'), null);
  assert.equal(r('localStorage.key(-1)'), null, '-1 wraps to 4294967295');
  assert.equal(r('localStorage.getItem("missing")'), null);
  r('localStorage.setItem("n", 5); localStorage.setItem({ toString() { return "k" } }, null); localStorage.setItem("u", undefined)');
  assert.equal(r('localStorage.getItem("n")'), '5');
  assert.equal(r('localStorage.getItem("k")'), 'null');
  assert.equal(r('localStorage.getItem("u")'), 'undefined');
  assert.equal(r('localStorage.getItem({ toString() { return "n" } })'), '5', 'keys are converted to strings too');
  assert.throws(() => r('localStorage.setItem(Symbol("s"), "x")'), { name: 'TypeError' });
  assert.throws(() => r('localStorage.setItem("only-a-key")'), /2 arguments required, but only 1 present/);
  assert.throws(() => r('localStorage.getItem()'), /1 argument required/);
  assert.throws(() => r('localStorage.key()'), { name: 'TypeError' });
  r('localStorage.removeItem("a")');
  assert.equal(r('localStorage.length'), 4);
  assert.deepEqual(JSON.parse(r('JSON.stringify(Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)))')), ['b', 'n', 'k', 'u'], 'insertion order');
  r('localStorage.clear()');
  assert.equal(r('localStorage.length'), 0);
  await settle();
  assert.deepEqual(f.ops(), [['s', 'n', '5'], ['s', 'k', 'null'], ['s', 'u', 'undefined'], ['r', 'a'], ['c']]);
});

test('writes that change nothing are not sent; a burst is ONE message per microtask, and a full batch goes at once', async () => {
  const f = frame(doc({ items: [['same', 'v']] }));
  f.run('localStorage.setItem("same", "v"); localStorage.removeItem("nope"); sessionStorage.setItem("s", "1")');
  await settle();
  assert.equal(f.sent().length, 0);
  f.run('localStorage.clear(); localStorage.clear()');
  f.run('for (let i = 0; i < 5; i++) localStorage.setItem("k" + i, String(i))');
  assert.equal(f.sent().length, 0, 'nothing posted synchronously');
  await settle();
  assert.equal(f.sent().length, 1);
  assert.deepEqual(f.sent()[0].ops, [['c'], ['s', 'k0', '0'], ['s', 'k1', '1'], ['s', 'k2', '2'], ['s', 'k3', '3'], ['s', 'k4', '4']]);
  f.sent().length = 0;
  f.run(`for (let i = 0; i < ${OPS_MAX + 88}; i++) localStorage.setItem("x" + i, "v")`);
  assert.equal(f.sent().length, 1, 'a full batch is sent before the loop even ends');
  assert.equal(f.sent()[0].ops.length, OPS_MAX);
  await settle();
  assert.deepEqual(f.sent().map((m) => m.ops.length), [OPS_MAX, 88]);
  // A batch also closes at half the per-message byte limit (one op bigger than that still goes, alone).
  const g = frame(doc({ msgMax: 400 }));
  g.run('for (let i = 0; i < 6; i++) localStorage.setItem("k" + i, "v".repeat(40)); localStorage.setItem("big", "b".repeat(300))');
  await settle();
  const bytes = g.sent().map((m) => m.ops.reduce((n, op) => n + (op[1].length + (op[2] || '').length) * 2, 0));
  assert.deepEqual(bytes, [168, 168, 168, 606], 'two 84-byte writes per message (at most 200 bytes); the 606-byte one on its own');
});

test('writes made before Atelier’s port arrives wait for it; too many become one full copy of the items', async () => {
  const f = frame(doc({ items: [['kept', '1']] }), { port: false });
  f.run('localStorage.setItem("early", "1"); localStorage.removeItem("kept")');
  await settle();
  assert.deepEqual(f.posts.map((p) => p.msg.kind), ['hello']);
  f.connect();
  assert.deepEqual(f.ops(), [['s', 'early', '1'], ['r', 'kept']], 'sent the moment the port comes');
  const g = frame(doc({ items: [['kept', '1']], opsMax: 4 }), { port: false });
  g.run('for (let i = 0; i < 20; i++) localStorage.setItem("n", String(i)); localStorage.setItem("last", "x")');
  g.connect();
  assert.deepEqual(g.ops(), [['c'], ['s', 'kept', '1'], ['s', 'n', '19'], ['s', 'last', 'x']], 'a clear, then every item as it is now');
  assert.deepEqual(g.sent().map((m) => m.ops.length), [4], 'in messages of at most opsMax');
  // Only the first port, only from Atelier's window and origin, only with this document's token.
  const h = frame(doc(), { port: false });
  h.connect('cd'.repeat(16));
  h.run('localStorage.setItem("a", "1")');
  await settle();
  assert.deepEqual(h.ops(), [], 'a port with another token is ignored');
  const real = h.connect();
  const other = fakeChannel();
  h.receive({ type: MSG, v: 1, token: TOKEN, kind: 'port' }, { ports: [other.port2] });
  h.run('localStorage.setItem("b", "2")');
  await settle();
  assert.deepEqual(real.port2.sent.flatMap((m) => m.ops), [['s', 'a', '1'], ['s', 'b', '2']]);
  assert.deepEqual(other.port2.sent, [], 'a second port is never used');
});

// MessageEvent and MessagePort as a browser has them: private state behind prototype getters and methods.
const PORTS = `
class MessageEvent extends Event {
  #i; constructor(type, init) { super(type); this.#i = init; }
  get data() { return this.#i.data; } get source() { return this.#i.source; } get origin() { return this.#i.origin; } get ports() { return this.#i.ports; }
}
class MessagePort {
  #out; #on = null; constructor(out) { this.#out = out; }
  postMessage(m) { this.#out(m); }
  set onmessage(f) { this.#on = f; } get onmessage() { return this.#on; }
}
window.MessageEvent = MessageEvent; window.MessagePort = MessagePort;
`;
test('an app that patches MessageEvent, MessagePort or Event before the port arrives never gets hold of it', async () => {
  const f = frame(doc(), { port: false, prelude: PORTS });
  f.run(`window.stolen = [];
    for (const name of ['data', 'source', 'origin', 'ports']) {
      const g = Object.getOwnPropertyDescriptor(MessageEvent.prototype, name).get;
      Object.defineProperty(MessageEvent.prototype, name, { get() { stolen.push(name); return g.call(this); }, configurable: true });
    }
    const post = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (m) { stolen.push(this); return post.call(this, m); };
    const set = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage').set;
    Object.defineProperty(MessagePort.prototype, 'onmessage', { set(fn) { stolen.push(this); set.call(this, fn); }, configurable: true });
    const stop = Event.prototype.stopImmediatePropagation;
    Event.prototype.stopImmediatePropagation = function () { stolen.push(this); return stop.call(this); };
    addEventListener('message', (e) => stolen.push(e), true);`);
  const out = [];
  const port = f.run('(out) => new MessagePort(out)')((m) => out.push(structuredClone(m)));
  f.run('(data, source, origin, port) => dispatchEvent(new MessageEvent("message", { data, source, origin, ports: [port] }))')({ type: MSG, v: 1, token: TOKEN, kind: 'port' }, f.parentWin, ORIGIN, port);
  f.run('localStorage.setItem("k", "v")');
  await settle();
  assert.deepEqual(out.flatMap((m) => m.ops), [['s', 'k', 'v']], 'the shim still got and used its port');
  assert.equal(f.run('stolen.length'), 0, 'none of the app’s hooks ever ran for it');
});

test('named properties, delete, in, Object.keys, JSON.stringify and for…in behave as on a real Storage', () => {
  const f = frame(doc({ items: [['a', '1']] }));
  const r = (s) => f.run(s);
  r('localStorage.habits = 42');
  assert.equal(r('localStorage.getItem("habits")'), '42');
  assert.equal(r('localStorage.habits'), '42');
  assert.equal(r('localStorage["a"]'), '1');
  assert.equal(r('"habits" in localStorage && !("zzz" in localStorage)'), true);
  assert.deepEqual(JSON.parse(r('JSON.stringify(Object.keys(localStorage))')), ['a', 'habits']);
  assert.equal(r('JSON.stringify(localStorage)'), '{"a":"1","habits":"42"}');
  assert.equal(r('JSON.stringify({ ...localStorage })'), '{"a":"1","habits":"42"}');
  assert.equal(r('localStorage.hasOwnProperty("a")'), true);
  r('delete localStorage.habits');
  assert.equal(r('localStorage.getItem("habits")'), null);
  // A key named like a method is stored, but never hides the method (WebIDL's named-property visibility).
  r('localStorage.getItem = "shadow"');
  assert.equal(r('typeof localStorage.getItem'), 'function');
  assert.equal(r('localStorage.getItem("getItem")'), 'shadow');
  assert.deepEqual(JSON.parse(r('JSON.stringify(Object.keys(localStorage))')), ['a'], 'a hidden key isn’t listed');
  const forIn = JSON.parse(r('const seen = []; for (const k in localStorage) seen.push(k); JSON.stringify(seen)'));
  for (const k of ['a', 'key', 'getItem', 'setItem', 'removeItem', 'clear', 'length']) assert.ok(forIn.includes(k), `for…in lists ${k}`);
  r('Object.defineProperty(localStorage, "d", { value: 7 })');
  assert.equal(r('localStorage.getItem("d")'), '7');
  assert.throws(() => r('Object.defineProperty(localStorage, "g", { get() { return 1 } })'), { name: 'TypeError' });
  assert.throws(() => r('Object.preventExtensions(localStorage)'), { name: 'TypeError' });
  assert.equal(r('localStorage.length'), 3);
});

test('the shim IS a Storage: instanceof, its tag, Storage.prototype methods called on it, and app patches of Storage.prototype', () => {
  const f = frame(doc({ items: [['k', 'v']] }));
  const r = (s) => f.run(s);
  assert.equal(r('localStorage instanceof Storage && sessionStorage instanceof Storage'), true);
  assert.equal(r('Object.prototype.toString.call(localStorage)'), '[object Storage]');
  assert.equal(r('Storage.prototype.getItem.call(localStorage, "k")'), 'v');
  assert.equal(r('Object.getOwnPropertyDescriptor(Storage.prototype, "length").get.call(localStorage)'), 1);
  assert.throws(() => r('Storage.prototype.getItem.call({}, "k")'), /Illegal invocation/, 'anything else still fails as the browser’s own would');
  assert.equal(r('localStorage.setItem.length'), 2);
  // A generated app that wraps setItem to watch its own writes still sees them.
  r('const seen = []; const orig = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { seen.push(k); return orig.call(this, k, v); }; localStorage.setItem("w", "1"); window.seen = seen;');
  assert.deepEqual(JSON.parse(r('JSON.stringify(seen)')), ['w']);
  assert.equal(r('localStorage.getItem("w")'), '1');
});

test('quota: QuotaExceededError past the app’s room, the key limit or the key count; shrinking always works', async () => {
  const f = frame(doc({ items: [['a', 'x'.repeat(40)]], quota: 120 }));
  const r = (s) => f.run(s);
  assert.equal(r('(() => { try { localStorage.setItem("b", "y".repeat(40)); return "ok" } catch (e) { return e.name } })()'), 'QuotaExceededError', '84 + 82 bytes > 120');
  assert.equal(r('localStorage.getItem("b")'), null, 'nothing changed');
  r('localStorage.setItem("a", "short")');
  r('localStorage.setItem("b", "y".repeat(20))');
  assert.equal(r('localStorage.length'), 2);
  assert.equal(r(`(() => { try { localStorage.setItem("k".repeat(${KEY_MAX + 1}), "") } catch (e) { return e.name } })()`), 'QuotaExceededError');
  const g = frame(doc({ keysMax: 2 }));
  g.run('localStorage.setItem("1", ""); localStorage.setItem("2", "")');
  assert.equal(g.run('(() => { try { localStorage.setItem("3", "") } catch (e) { return e.code + " " + e.name } })()'), '22 QuotaExceededError');
  g.run('localStorage.setItem("2", "changed")');
  assert.equal(g.run('localStorage.getItem("2")'), 'changed', 'an existing key can still change');
  // A frame mounted over its quota (another tab grew it) may still shrink.
  const h = frame(doc({ items: [['big', 'z'.repeat(100)]], quota: 50 }));
  h.run('localStorage.setItem("big", "z".repeat(60))');
  assert.equal(h.run('localStorage.getItem("big").length'), 60);
  await settle();
  assert.deepEqual(f.ops(), [['s', 'a', 'short'], ['s', 'b', 'y'.repeat(20)]], 'refused writes are never sent');
});

test('sessionStorage: its own memory, never sent, empty in every new document', async () => {
  const f = frame(doc({ items: [['k', 'local']] }));
  f.run('sessionStorage.setItem("k", "session"); sessionStorage.tab = "1"');
  assert.equal(f.run('sessionStorage.getItem("k") + "/" + localStorage.getItem("k") + "/" + sessionStorage.length'), 'session/local/2');
  await settle();
  assert.deepEqual(f.ops(), []);
  const again = frame(doc({ items: [['k', 'local']] }));
  assert.equal(again.run('sessionStorage.length'), 0, 'a reload starts it empty');
});

test('storage events: another frame’s write (from Atelier) updates the map and fires "storage" with oldValue / newValue / storageArea', async () => {
  const f = frame(doc({ items: [['count', '3']] }));
  f.run('window.events = []; addEventListener("storage", (e) => events.push([e.key, e.oldValue, e.newValue, e.storageArea === localStorage, e.url])); window.appMessages = 0; addEventListener("message", () => appMessages++)');
  f.event([['s', 'count', '4'], ['r', 'gone'], ['s', 'new', 'n'], ['c']]);
  await settle();
  assert.deepEqual(JSON.parse(f.run('JSON.stringify(events)')), [['count', '3', '4', true, 'about:srcdoc'], ['new', null, 'n', true, 'about:srcdoc'], [null, null, null, true, 'about:srcdoc']]);
  assert.equal(f.run('localStorage.length'), 0);
  // Only on its port, only with its token; never as a window message (Atelier's own, with this token, the app doesn't
  // even see), and nothing from anyone else changes the items.
  f.event([['s', 'evil', '1']], 'cd'.repeat(16));
  f.receive({ type: MSG, v: 1, token: TOKEN, kind: 'event', ops: [['s', 'evil', '1']] });
  f.receive({ type: MSG, v: 1, token: TOKEN, kind: 'event', ops: [['s', 'evil', '1']] }, { from: {} });
  f.receive({ type: MSG, v: 1, token: TOKEN, kind: 'event', ops: [['s', 'evil', '1']] }, { origin: 'null' });
  await settle();
  assert.equal(f.run('localStorage.getItem("evil")'), null);
  assert.equal(f.run('appMessages'), 2, 'the app sees only the two that weren’t Atelier’s');
  assert.deepEqual(f.ops(), [], 'applying another frame’s writes never echoes them back');
});

test('pagehide sends what is still queued, on the port; a preview with nothing to keep saves nothing and sends nothing', async () => {
  const f = frame(doc());
  f.run('localStorage.clear(); localStorage.setItem("late", "1"); dispatchEvent(new Event("pagehide"))');
  assert.deepEqual(f.ops(), [['s', 'late', '1']], 'sent during pagehide itself, before any microtask (a Reset that clears, then reloads)');
  assert.deepEqual(f.posts.map((p) => p.msg.kind), ['hello']);
  const plain = frame(previewDoc('<!doctype html><p>code preview</p>'));
  plain.run('localStorage.setItem("a", "1"); dispatchEvent(new Event("pagehide"))');
  assert.equal(plain.run('localStorage.getItem("a")'), '1', 'a code block’s preview can still use localStorage');
  await settle();
  assert.deepEqual(plain.posts, []);
  assert.equal(cfgOf(previewDoc('<p>x</p>')).persist, false);
});

test('previewDoc: the shim is the first script, ahead of the app’s; items can’t break out of it; the focus guard follows it', () => {
  const evil = `</script><script>parent.postMessage('x','*')</script><!-- ${LS_SEP} `;
  const d = previewDoc('<!-- generated --><!DOCTYPE html><html lang="en"><head><script>var appFirst = 1</script></head><body></body></html>', cfg({ items: [[evil, evil]] }), '<script>guard()</script>');
  assert.ok(d.startsWith('<!-- generated --><!DOCTYPE html><script>(function storageShim('), 'right after the doctype: standards mode is kept');
  assert.ok(d.indexOf('</script><script>guard()</script>') < d.indexOf('appFirst'), 'shim, then guard, then the app');
  assert.equal(d.split('</script>').length - 1, 3, 'one </script> each: the shim, the guard, the app — none inside the items');
  const json = shimScript(d).slice(String(storageShim).length + 3);
  assert.ok(!json.includes('<') && !json.includes(LS_SEP), 'the items’ JSON carries no "<" and no line separator');
  assert.ok(!/<\/script|<!--|<script/i.test(shimScript(d)), 'nothing in the shim script can end it or change how it is parsed');
  assert.deepEqual(cfgOf(d).items, [[evil, evil]], 'and the items come back exactly');
  const f = frame(d);
  assert.equal(f.run('localStorage.key(0)'), evil);
  assert.equal(injectFirst('<html><body>x</body></html>', 'S'), 'S<html><body>x</body></html>', 'no doctype: at the very start');
  assert.equal(injectFirst('\n  <!doctype html><p>', 'S'), '\n  <!doctype html>S<p>');
  assert.ok(!String(storageShim).includes('</script'), 'the shim’s own source can be inlined');
});

test('placing the shim takes linear time whatever comments lead the html (a code block’s Preview can’t freeze Atelier)', () => {
  // Checked smallest first: the old pattern needed ~0.1 s at 24 empty comments and doubled with each one more.
  for (const n of [24, 40, 2000]) {
    const html = '<!---->'.repeat(n) + '<html>', t0 = performance.now();
    assert.equal(injectFirst(html, 'S'), `S${html}`, 'no doctype after them: at the very start');
    const ms = performance.now() - t0;
    assert.ok(ms < 50, `${n} comments took ${ms.toFixed(1)} ms`);
  }
  const t0 = performance.now();
  const d = previewDoc(`${'<!-- x -->'.repeat(5000)}<!-- unclosed <p>no doctype</p>`);
  assert.ok(d.startsWith('<script>(function storageShim('));
  assert.ok(performance.now() - t0 < 200);
  // Comments before the doctype still keep the shim after it (standards mode).
  assert.equal(injectFirst('<!-- a -- b --> \n<!DOCTYPE html><p>', 'S'), '<!-- a -- b --> \n<!DOCTYPE html>S<p>');
  assert.equal(injectFirst('\uFEFF<!--x--><!---y--->\n<!doctype html>', 'S'), '\uFEFF<!--x--><!---y--->\n<!doctype html>S');
});

// ── Atelier side: message checks ──
test('readMessage accepts exactly the protocol’s shapes and refuses everything else', () => {
  const base = { type: MSG, v: 1, token: TOKEN };
  assert.deepEqual(readMessage({ ...base, kind: 'hello', ok: true }), { kind: 'hello', token: TOKEN, ok: true });
  assert.deepEqual(readMessage({ ...base, kind: 'ops', ops: [['s', 'k', 'v'], ['r', 'k'], ['c']] }).ops, [['s', 'k', 'v'], ['r', 'k'], ['c']]);
  const hello = { ...base, kind: 'hello', ok: true };
  const bad = [
    null, 'atelier-appdata', [], { ...base, kind: 'hello' }, { ...base, kind: 'hello', ok: 'yes' }, { ...base, kind: 'ops', ops: [] },
    { ...base, kind: 'ops', ops: [['s', 'k', 'v']], key: 'thread/other' }, { ...hello, app: 'thread/other' }, // a frame can't name its app
    { ...base, kind: 'event', ops: [['c']] }, { ...base, kind: 'port' }, { ...base, kind: 'bye' }, { ...base, kind: 'eval', code: '1' },
    { ...hello, v: 2 }, { ...hello, token: 'short' }, { ...hello, token: 'AB'.repeat(16) }, { ...hello, type: 'other' },
    Object.assign(Object.create({ inherited: 1 }), hello),
    { ...base, kind: 'ops', ops: [['s', 'k', 5]] }, { ...base, kind: 'ops', ops: [['s', 'k']] }, { ...base, kind: 'ops', ops: [['r', 'k', 'v']] },
    { ...base, kind: 'ops', ops: [['c', 'x']] }, { ...base, kind: 'ops', ops: [['x', 'k', 'v']] }, { ...base, kind: 'ops', ops: [['s', new String('k'), 'v']] },
    { ...base, kind: 'ops', ops: [{ 0: 's', 1: 'k', 2: 'v', length: 3 }] }, { ...base, kind: 'ops', ops: { length: 1, 0: ['c'] } },
    { ...base, kind: 'ops', ops: [['s', 'k'.repeat(KEY_MAX + 1), 'v']] }, { ...base, kind: 'ops', ops: [['s', 'k', 'v'.repeat(VALUE_MAX + 1)]] },
    { ...base, kind: 'ops', ops: Array.from({ length: OPS_MAX + 1 }, () => ['c']) },
  ];
  for (const d of bad) assert.equal(readMessage(d), null, JSON.stringify(d)?.slice(0, 80));
  const holes = [['c']]; holes.length = 2;
  assert.equal(readOps(holes), null, 'no holes');
  const big = 'v'.repeat(VALUE_MAX);
  assert.equal(readOps([['s', 'a', big], ['s', 'b', big], ['s', 'c', big], ['s', 'd', big], ['s', 'e', big]]), null, 'one message carries at most twice the app cap');
});

// ── the store ──
function memoryBackend(rows = new Map()) {
  const calls = [];
  let failNext = 0, gate = null;
  return {
    rows, calls, fail(n = 1) { failNext = n; }, hold() { let open; gate = new Promise((r) => { open = r; }); return () => { gate = null; open(); }; },
    sizes: async () => new Map([...rows].map(([k, r]) => [k, r.bytes])),
    get: async (k) => structuredClone(rows.get(k)),
    update: async (k, fn) => {
      calls.push(['update', k]);
      if (gate) await gate;
      if (failNext > 0) { failNext--; throw new Error('QuotaExceededError (IndexedDB)'); }
      const next = fn(structuredClone(rows.get(k)));
      if (next) rows.set(k, structuredClone(next)); else rows.delete(k);
      return structuredClone(next);
    },
    del: async (k) => { calls.push(['del', k]); rows.delete(k); },
    delThread: async (t) => { calls.push(['delThread', t]); for (const k of [...rows.keys()]) if (k.startsWith(`${t}/`)) rows.delete(k); },
    clear: async () => { calls.push(['clear']); rows.clear(); },
  };
}
function clock() {
  let t = 1000, id = 0;
  const timers = new Map();
  return {
    now: () => t, setTimer: (fn, ms) => { timers.set(++id, { fn, at: t + ms }); return id; }, clearTimer: (i) => timers.delete(i),
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        const next = [...timers].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        t = Math.max(t, next[1].at); timers.delete(next[0]); next[1].fn(); await settle();
      }
      t = end; await settle();
    },
  };
}
const A = 'thread1/rootA', B = 'thread1/rootB', C = 'thread2/rootC';
const storeWith = (over = {}) => {
  const c = over.clock || clock(), backend = over.backend || memoryBackend();
  const store = createAppStore({ backend, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, ...over });
  return { store, backend, c };
};
const items = (rec) => Object.fromEntries(rec?.items || []);

const microtasks = async (n = 50) => { for (let i = 0; i < n; i++) await Promise.resolve(); }; // the rest of this task, no later one

test('a write starts at once, before the task that made it ends; what arrives while one is in flight goes in ONE next write', async () => {
  const { store, backend } = storeWith();
  await store.load(A);
  store.apply(A, [['s', 'n', '0']]);
  assert.equal(store.busy(), true);
  await microtasks();
  assert.deepEqual(backend.calls, [['update', A]], 'under way with no timer: a reload right after the tap finds it started');
  await settle();
  assert.deepEqual(items(backend.rows.get(A)), { n: '0' });
  assert.equal(store.busy(), false, 'nothing left for a reload to wait for');
  // A burst while that write is still in the database's hands: one more write, carrying all of it.
  backend.calls.length = 0;
  const open = backend.hold();
  store.apply(A, [['s', 'n', '1']]);
  await settle();
  for (let i = 2; i < 6; i++) store.apply(A, [['s', 'n', String(i)], ['s', `k${i}`, 'v']]);
  await settle();
  assert.deepEqual(backend.calls, [['update', A]], 'one write in flight at a time');
  assert.equal(store.busy(), true);
  open(); await settle();
  assert.deepEqual(backend.calls, [['update', A], ['update', A]], 'then ONE write for the whole burst');
  assert.deepEqual(items(backend.rows.get(A)), { n: '5', k2: 'v', k3: 'v', k4: 'v', k5: 'v' });
  assert.equal(store.busy(), false);
});

test('an Atelier reload right after a write keeps it: the database has the whole write before the page can unload', async () => {
  const idb = fakeIdb(), c = clock();
  const open = () => storeWith({ backend: idbBackend('atelier-appdata', idb, idb.KeyRange), clock: c }).store;
  const page = open();
  await page.load(A);
  page.apply(A, [['s', 'count', '3']]);
  await microtasks();
  idb.frozen = true; // the page unloads: nothing it issues from here on runs (the old 400 ms debounce lost it here)
  await settle(5);
  idb.frozen = false;
  const next = open(); // the reloaded page, the clock never moved
  await next.load(A);
  assert.deepEqual(next.items(A), [['count', '3']]);
});

test('caps: per app, across all apps, and the key count; a write that would grow past one is dropped, shrinking always lands', async () => {
  const { store } = storeWith({ appCap: 100, totalCap: 150, keysMax: 3 });
  await store.load(A); await store.load(B);
  assert.equal(store.room(A), 100);
  assert.deepEqual(store.apply(A, [['s', 'a', 'x'.repeat(40)], ['s', 'b', 'x'.repeat(20)]]), [['s', 'a', 'x'.repeat(40)]], '82 + 42 bytes > 100');
  assert.equal(store.bytes(A), 82);
  assert.equal(store.room(B), 68, 'B may have what the total has left');
  assert.equal(store.apply(B, [['s', 'b', 'y'.repeat(40)]]).length, 0, 'over the total');
  assert.equal(store.apply(B, [['s', 'b', 'y'.repeat(30)]]).length, 1);
  assert.equal(store.total(), 82 + 62);
  assert.equal(store.apply(A, [['s', 'a', 'x']]).length, 1, 'shrinking frees room');
  assert.equal(store.apply(A, [['s', '1', ''], ['s', '2', ''], ['s', '3', '']]).length, 2, 'three keys at most');
  assert.equal(store.apply(A, [['s', 'a', 'changed']]).length, 1, 'existing keys still change');
  assert.deepEqual(store.apply('thread9/notLoaded', [['s', 'a', 'b']]), [], 'an app nobody loaded takes nothing');
});

test('Clear app data empties the app at once and in the database; a write already on its way can’t bring it back', async () => {
  const { store, backend, c } = storeWith();
  await store.load(A); await store.load(B);
  store.apply(A, [['s', 'k', 'v']]); store.apply(B, [['s', 'other', 'app']]);
  await c.advance(500);
  store.apply(A, [['s', 'k2', 'v2']]);
  const open = backend.hold();
  const flushing = store.flush();
  await settle();
  const cleared = store.clear(A); // while that write is still in the database's hands
  assert.deepEqual(store.items(A), [], 'empty now: a frame mounted now starts empty');
  open(); await flushing; await cleared;
  assert.equal(backend.rows.has(A), false);
  assert.deepEqual(store.items(A), [], 'the finished write didn’t refill it');
  assert.deepEqual(items(backend.rows.get(B)), { other: 'app' }, 'other apps untouched');
  assert.equal(store.bytes(A), 0);
});

test('a failed write keeps its changes and tries again; a deleted thread takes its apps’ data; Clear this device takes all', async () => {
  const errors = [];
  const { store, backend, c } = storeWith({ onError: (e) => errors.push(e.message) });
  await store.load(A); await store.load(B); await store.load(C);
  store.apply(A, [['s', 'k', '1']]); store.apply(C, [['s', 'k', '3']]);
  backend.fail();
  await c.advance(500);
  assert.equal(errors.length, 1);
  assert.equal(backend.rows.has(A), false);
  store.apply(A, [['s', 'k2', '2']]);
  await c.advance(6000);
  assert.deepEqual(items(backend.rows.get(A)), { k: '1', k2: '2' }, 'nothing was lost');
  store.apply(B, [['s', 'b', '1']]); await c.advance(500);
  await store.forgetThread('thread1');
  assert.deepEqual([...backend.rows.keys()], [C]);
  assert.equal(store.peek(A), null);
  await store.clearAll();
  assert.equal(backend.rows.size, 0);
  assert.equal(store.total(), 0);
});

test('two Atelier tabs merge per key, and a tab hears the other’s writes over its BroadcastChannel', async () => {
  const backend = memoryBackend(), c = clock();
  const chans = []; const channel = () => { const ch = { onmessage: null, postMessage: (d) => chans.filter((o) => o !== ch).forEach((o) => o.onmessage?.({ data: structuredClone(d) })) }; chans.push(ch); return ch; };
  const one = storeWith({ backend, clock: c, channel: channel() }).store, two = storeWith({ backend, clock: c, channel: channel() }).store;
  await one.load(A); await two.load(A);
  one.apply(A, [['s', 'fromOne', '1']]); two.apply(A, [['s', 'fromTwo', '2']]);
  await c.advance(500); await settle();
  assert.deepEqual(items(backend.rows.get(A)), { fromOne: '1', fromTwo: '2' }, 'neither tab overwrote the other');
  assert.deepEqual(Object.fromEntries(one.items(A)), { fromOne: '1', fromTwo: '2' });
  assert.deepEqual(Object.fromEntries(two.items(A)), { fromOne: '1', fromTwo: '2' });
});

test('stored data is checked on the way back in; the store only names apps as thread/root', async () => {
  const backend = memoryBackend(new Map([[A, { v: 1, items: [['ok', 'yes'], ['bad', 5], [7, 'x'], ['ok', 'dup'], 'junk'], bytes: 10 }]]));
  const { store } = storeWith({ backend });
  await store.load(A);
  assert.deepEqual(store.items(A), [['ok', 'yes']]);
  await assert.rejects(store.load('../escape'));
  for (const k of ['a', 'a/b/c', '/b', 'a/', 'a b/c', `${'x'.repeat(121)}/y`]) assert.equal(validKey(k), false, k);
});

// ── IndexedDB backend: per-workspace databases ──
// frozen: the page is unloading — a request it issues from then on never runs (its transaction never completes); what
// it issued before still does.
function fakeIdb() {
  const dbs = new Map();
  const inRange = (k, q) => (q && typeof q === 'object' ? k >= q.lower && k <= q.upper : k === q);
  const sorted = (m) => [...m.keys()].sort();
  const idb = {
    frozen: false,
    dbs, KeyRange: { bound: (lower, upper) => ({ lower, upper }) },
    open(name) {
      const r = {};
      setImmediate(() => {
        let stores = dbs.get(name);
        const fresh = !stores;
        if (fresh) dbs.set(name, (stores = new Map()));
        r.result = {
          objectStoreNames: { contains: (s) => stores.has(s) }, createObjectStore: (s) => stores.set(s, new Map()), close() {},
          transaction(names, mode) {
            const t = {};
            let pending = 0, dead = idb.frozen;
            const op = (fn) => { const q = {}; if (idb.frozen) { dead = true; return q; } pending++; queueMicrotask(() => { q.result = fn(); pending--; q.onsuccess?.(); }); return q; };
            t.objectStore = (s) => {
              assert.ok(names.includes(s));
              const m = stores.get(s), w = (fn) => { assert.equal(mode, 'readwrite'); return fn(); };
              return {
                get: (k) => op(() => structuredClone(m.get(k))),
                put: (v, k) => op(() => w(() => m.set(k, structuredClone(v)) && k)),
                delete: (k) => op(() => w(() => { for (const key of sorted(m)) if (inRange(key, k)) m.delete(key); })),
                clear: () => op(() => w(() => m.clear())),
                getAll: () => op(() => sorted(m).map((k) => structuredClone(m.get(k)))),
                getAllKeys: () => op(() => sorted(m)),
              };
            };
            const done = () => setImmediate(() => (dead ? undefined : pending ? done() : t.oncomplete?.()));
            done();
            return t;
          },
        };
        if (fresh) r.onupgradeneeded?.();
        r.onsuccess?.();
      });
      return r;
    },
  };
  return idb;
}

test('each workspace has its own database; data survives a reload; one workspace’s clear never touches another’s', async () => {
  assert.equal(workspaceDb('owner'), 'atelier-appdata');
  assert.equal(workspaceDb('guest'), 'atelier-appdata-guest');
  assert.equal(workspaceDb('tester:li/a b'), 'atelier-appdata-account-li%2Fa%20b');
  assert.equal(workspaceDb('tester:'), 'atelier-appdata-guest');
  const idb = fakeIdb(), c = clock();
  const open = (ws) => storeWith({ backend: idbBackend(workspaceDb(ws), idb, idb.KeyRange), clock: c }).store;
  const owner = open('owner'), guest = open('guest'), tester = open('tester:person-a');
  for (const [s, v] of [[owner, 'owner'], [guest, 'guest'], [tester, 'tester']]) { await s.load(A); await s.load(C); s.apply(A, [['s', 'who', v]]); s.apply(C, [['s', 'c', v]]); }
  await c.advance(500);
  assert.deepEqual([...idb.dbs.keys()].sort(), ['atelier-appdata', 'atelier-appdata-account-person-a', 'atelier-appdata-guest']);
  // "Reload": new stores over the same databases.
  const owner2 = open('owner');
  await owner2.load(A);
  assert.deepEqual(owner2.items(A), [['who', 'owner']]);
  assert.equal(owner2.total(), 2 * (3 + 5) + 2 * (1 + 5), 'the total comes from the sizes store without reading every app');
  await open('guest').clearAll();
  const owner3 = open('owner'), tester2 = open('tester:person-a'), guest2 = open('guest');
  await owner3.load(A); await tester2.load(A); await guest2.load(A);
  assert.deepEqual(owner3.items(A), [['who', 'owner']]);
  assert.deepEqual(tester2.items(A), [['who', 'tester']]);
  assert.deepEqual(guest2.items(A), []);
  await owner3.forgetThread('thread1');
  const owner4 = open('owner');
  await owner4.load(A); await owner4.load(C);
  assert.deepEqual(owner4.items(A), []);
  assert.deepEqual(owner4.items(C), [['c', 'owner']], 'only that thread’s apps');
});

// ── the bridge: frames, tokens, sources, ports ──
function fakeFrame() {
  const win = { posted: [], postMessage(m, o, transfer = []) { this.posted.push({ m: structuredClone(m), o, transfer }); } };
  return { isConnected: true, contentWindow: win, srcdoc: '', win };
}
let tokenN = 0;
const nextToken = () => (++tokenN).toString(16).padStart(32, '0');
async function bridgeWith(over = {}) {
  const { store, backend, c } = storeWith(over);
  const bridge = createBridge({ store, origin: ORIGIN, head: '<script>guard()</script>', makeToken: nextToken, makeChannel: fakeChannel, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, ...over.bridge });
  return { store, backend, c, bridge };
}
const send = (bridge, f, data, { source = f.contentWindow, origin = 'null' } = {}) => bridge.onMessage({ data: structuredClone(data), source, origin });
const hello = (bridge, f, token = cfgOf(f.srcdoc).token, opts) => send(bridge, f, { type: MSG, v: 1, token, kind: 'hello', ok: true }, opts);
// The port Atelier sent this frame's window (the frame's end of it), or null.
const portOf = (f, token = cfgOf(f.srcdoc).token) => f.win.posted.find((p) => p.m.kind === 'port' && p.m.token === token)?.transfer[0] || null;
const write = async (port, ops, token) => { port.postMessage({ type: MSG, v: 1, token, kind: 'ops', ops }); await settle(1); };
// hello, then the port it got: (ops, token?) → writes on it.
async function connect(bridge, f) {
  const token = cfgOf(f.srcdoc).token;
  hello(bridge, f, token);
  const port = portOf(f, token);
  assert.ok(port, 'a port came back');
  return { port, token, write: (ops, t = token) => write(port, ops, t) };
}

test('mount gives a frame its app’s items and a fresh token; only the frame it was mounted in gets a port, and its port writes only that app', async () => {
  const backend = memoryBackend(new Map([[A, { v: 1, items: [['count', '3']], bytes: 12 }], [B, { v: 1, items: [['secret', 'b']], bytes: 14 }]]));
  const { bridge, store } = await bridgeWith({ backend });
  await store.load(A); await store.load(B);
  const fa = fakeFrame(), fb = fakeFrame();
  bridge.mount(fa, { key: A, html: '<!doctype html><p>a</p>' });
  bridge.mount(fb, { key: B, html: '<!doctype html><p>b</p>' });
  const ca = cfgOf(fa.srcdoc), cb = cfgOf(fb.srcdoc);
  assert.deepEqual(ca.items, [['count', '3']]);
  assert.deepEqual(cb.items, [['secret', 'b']], 'each frame carries only its own app’s data');
  assert.equal(ca.origin, ORIGIN); assert.equal(ca.persist, true); assert.match(ca.token, /^[0-9a-f]{32}$/); assert.notEqual(ca.token, cb.token);
  assert.ok(fa.srcdoc.includes('</script><script>guard()</script><p>a</p>'));
  // A hello counts only from the frame's own window, with an opaque origin: anything else gets no port.
  hello(bridge, fa, ca.token, { source: fb.contentWindow });
  hello(bridge, fa, ca.token, { origin: ORIGIN });
  hello(bridge, fa, ca.token, { source: null });
  assert.equal(fa.win.posted.length + fb.win.posted.length, 0);
  // Writes are never taken from window messages, even from the right window.
  send(bridge, fa, { type: MSG, v: 1, token: ca.token, kind: 'ops', ops: [['s', 'count', '9']] });
  assert.deepEqual(store.items(A), [['count', '3']]);
  const a = await connect(bridge, fa), b = await connect(bridge, fb);
  assert.equal(fa.win.posted[0].o, '*', 'to the frame’s own window (an opaque origin can’t be named)');
  await a.write([['s', 'count', '4']]);
  assert.deepEqual(store.items(A), [['count', '4']]);
  // A's port carrying B's token, a malformed message, B's own port writing A's key name: none reach the other app.
  await a.write([['s', 'secret', 'stolen']], cb.token);
  await a.write([['s', 'count', 5]]);
  await b.write([['s', 'count', '666']]);
  assert.deepEqual(store.items(A), [['count', '4']]);
  assert.deepEqual(store.items(B), [['secret', 'b'], ['count', '666']], 'B wrote a key called "count" — in B');
  assert.equal(bridge.onMessage({ data: { __atelier: 'res' }, source: fa.contentWindow, origin: 'null' }), false, 'other messages are left for their own listeners');
});

test('writes reach the other frames of the SAME app as storage events (never another app’s); a frame made before a write is renewed', async () => {
  const { bridge, store } = await bridgeWith();
  await store.load(A); await store.load(B);
  const card = fakeFrame(), full = fakeFrame(), other = fakeFrame();
  bridge.mount(card, { key: A, html: 'a' }); bridge.mount(full, { key: A, html: 'a' }); bridge.mount(other, { key: B, html: 'b' });
  const pc = await connect(bridge, card), pf = await connect(bridge, full), po = await connect(bridge, other);
  await pf.write([['s', 'k', 'v'], ['s', 'k', 'v']]);
  assert.deepEqual(pc.port.other.sent, [{ type: MSG, v: 1, token: pc.token, kind: 'event', ops: [['s', 'k', 'v']] }], 'once: the repeat changed nothing');
  assert.deepEqual(pf.port.other.sent, [{ type: MSG, v: 1, token: pf.token, kind: 'ack', fix: [], quota: APP_CAP }], 'the writer gets its ack, not its own write back');
  assert.deepEqual(po.port.other.sent, []);
  // A frame whose document was made before the write (it hasn't said hello yet) gets a fresh one when it does.
  const late = fakeFrame();
  bridge.mount(late, { key: A, html: 'a' });
  const before = cfgOf(late.srcdoc);
  await pc.write([['s', 'k2', 'v2']]);
  hello(bridge, late, before.token);
  assert.equal(portOf(late, before.token), null, 'no port for the outdated document');
  const after = cfgOf(late.srcdoc);
  assert.notEqual(after.token, before.token);
  assert.deepEqual(after.items, [['k', 'v'], ['k2', 'v2']]);
});

test('a frame that reloads (a second hello with its token) gets a fresh document; the stale document never gets a port', async () => {
  const stalls = [];
  const { bridge, store, c } = await bridgeWith({ bridge: { rebuildLimit: 3, onStall: (k) => stalls.push(k) } });
  await store.load(A);
  const f = fakeFrame();
  bridge.mount(f, { key: A, html: 'a' });
  const one = await connect(bridge, f);
  await one.write([['c'], ['s', 'count', '0']]); // e.g. a Reset that clears, then location.reload()
  hello(bridge, f, one.token); // the reloaded srcdoc: same token, the items from when it was made
  assert.equal(f.win.posted.filter((p) => p.m.kind === 'port').length, 1, 'the reloaded document got no port');
  assert.equal(one.port.other.closed, true, 'and the old port is closed');
  await one.write([['s', 'count', 'stale']]);
  assert.deepEqual(store.items(A), [['count', '0']], 'nothing it writes is kept');
  const second = cfgOf(f.srcdoc);
  assert.notEqual(second.token, one.token);
  assert.deepEqual(second.items, [['count', '0']], 'the fresh document has what was saved');
  const two = await connect(bridge, f);
  await two.write([['s', 'count', '1']]);
  assert.deepEqual(store.items(A), [['count', '1']]);
  // An app that reloads itself faster than rebuildLimit in 10 s (a loop): renewed that often at once, then its next
  // fresh document waits for the window. Meanwhile it saves nothing — and the App data line can say so (paused).
  let tok = two.token, renewed = 0;
  for (let i = 0; i < 6; i++) { hello(bridge, f, tok); const t = cfgOf(f.srcdoc).token; if (t !== tok) { renewed++; tok = t; hello(bridge, f, tok); } }
  assert.equal(renewed, 2, 'with the renewal above: 3 in the window');
  assert.equal(bridge.paused(A), true);
  assert.deepEqual(stalls, [A]);
  await c.advance(9_999);
  assert.equal(cfgOf(f.srcdoc).token, tok, 'not before the window allows it');
  await c.advance(1);
  assert.equal(bridge.paused(A), false, 'never for good: the window passed');
  assert.deepEqual(stalls, [A, A]);
  const back = cfgOf(f.srcdoc);
  assert.notEqual(back.token, tok, 'a fresh document');
  assert.deepEqual(back.items, [['count', '1']], 'with what was saved');
  const three = await connect(bridge, f);
  await three.write([['s', 'count', '2']]);
  assert.deepEqual(store.items(A), [['count', '2']], 'and it saves again');
  // Repainting the card (or Clear app data) while it waits gives it a document at once.
  const g = fakeFrame();
  bridge.mount(g, { key: A, html: 'a' });
  let gt = cfgOf(g.srcdoc).token;
  hello(bridge, g, gt); // loaded: it has its port
  for (let i = 0; i < 4; i++) { hello(bridge, g, gt); gt = cfgOf(g.srcdoc).token; hello(bridge, g, gt); } // reloads itself, 4 times
  assert.equal(bridge.paused(A), true);
  bridge.remount(A);
  assert.equal(bridge.paused(A), false);
  assert.notEqual(cfgOf(g.srcdoc).token, gt);
});

test('after a frame is replaced its port closes: writes it posted just before still land, later ones never do', async () => {
  const { bridge, store, c } = await bridgeWith();
  await store.load(A);
  const f = fakeFrame();
  bridge.mount(f, { key: A, html: 'a' });
  const p = await connect(bridge, f);
  f.isConnected = false; f.contentWindow = null; // a repaint removed it
  await p.write([['s', 'inflight', '1']]);
  assert.deepEqual(store.items(A), [['inflight', '1']]);
  await c.advance(6000);
  bridge.sweep();
  assert.equal(p.port.other.closed, true, 'Atelier closed its end');
  await p.write([['s', 'late', '1']]);
  assert.deepEqual(store.items(A), [['inflight', '1']]);
  assert.equal(bridge.bindings().length, 0);
});

test('Clear app data remounts the app’s frames empty; a frame with no nameable app, or whose data can’t be read, saves nothing', async () => {
  const { bridge, store } = await bridgeWith();
  await store.load(A);
  const f = fakeFrame();
  bridge.mount(f, { key: A, html: 'a' });
  const p = await connect(bridge, f);
  await p.write([['s', 'k', 'v']]);
  const cleared = store.clear(A);
  bridge.remount(A);
  await cleared;
  const now = cfgOf(f.srcdoc);
  assert.deepEqual(now.items, []);
  assert.notEqual(now.token, p.token);
  await p.write([['s', 'k', 'zombie']]);
  assert.deepEqual(store.items(A), [], 'the old document can’t write it back');
  const plain = fakeFrame();
  assert.equal(bridge.mount(plain, { key: '', html: 'code' }), null);
  assert.equal(cfgOf(plain.srcdoc).persist, false);
  const broken = await bridgeWith({ backend: { ...memoryBackend(), get: async () => { throw new Error('IndexedDB is unavailable'); } } });
  const g = fakeFrame();
  broken.bridge.mount(g, { key: A, html: 'a' });
  await settle();
  assert.equal(cfgOf(g.srcdoc).persist, false, 'the app runs, saving nothing');
});

test('identity: every version of an app (refines, restores, rebuilds) shares one key; a new app, another thread or an import doesn’t', () => {
  const app = (t) => ({ html: '<!doctype html><title>Habits</title>', title: t });
  const v1 = { id: 'a1', kind: 'build', prompt: 'habits', createdAt: 1, params: {}, app: app('Habits') };
  const v2 = { id: 'b2', kind: 'build', prompt: 'add streaks', createdAt: 2, params: {}, refineOf: 'a1', app: app('Habits v2') };
  const v3 = { id: 'c3', kind: 'build', prompt: 'dark mode', createdAt: 3, params: {}, refineOf: 'b2', app: app('Habits v3') };
  const fresh = { id: 'd4', kind: 'build', prompt: 'a timer', createdAt: 4, params: {}, app: app('Timer') };
  const entries = [v1, { id: 'q', kind: 'ask', prompt: 'hi', createdAt: 1.5 }, v2, v3, fresh];
  for (const e of [v1, v2, v3]) assert.equal(appKey('t1', entries, e), 't1/a1');
  restoreBase(v1, 5);
  const v4 = { id: 'e5', kind: 'build', prompt: 'from v1 again', createdAt: 6, params: {}, refineOf: 'a1', app: app('Habits v4') };
  entries.push(v4);
  assert.equal(appKey('t1', entries, v4), 't1/a1', 'a refine of a restored version stays the same app');
  assert.equal(appKey('t1', entries, fresh), 't1/d4');
  assert.equal(appKey('t2', entries, v2), 't2/a1');
  assert.equal(appKey('t1', entries, { ...v2 }), '', 'not in the thread');
  assert.equal(appKey('bad id', entries, v2), '');
  const [imported] = prepareImport({ app: 'atelier', v: 1, threads: [{ id: 't1', title: 'x', createdAt: 1, updatedAt: 1, entries: [v1, v2] }] }, nextToken);
  const k = appKey(imported.id, imported.entries, imported.entries[1]);
  assert.ok(k && k !== 't1/a1', 'an imported copy is its own app (backups carry no app data)');
});

/// ── end to end: the real shim in its own context, the real bridge and store, a database that outlives the page ──
const COUNTER = `<!doctype html><html><head><title>Counter</title></head><body><script>var n = Number(localStorage.getItem('count')) || 0; function click() { n++; try { localStorage.setItem('count', String(n)); } catch {} }</script></body></html>`;
// One Atelier page over `backend`: its store and bridge; open(key) mounts a frame and runs the document it got (shim,
// then the app's script), as a browser would: the frame's hello goes to Atelier's window, the port comes back to it.
// { start: false }: the document is set but not loaded yet (an off-screen card); start() loads it later.
function atelierPage({ backend, c, html = COUNTER, store: storeOpts = {}, bridge: bridgeOpts = {} }) {
  const store = createAppStore({ backend, now: c.now, setTimer: c.setTimer, ...storeOpts });
  const bridge = createBridge({ store, origin: ORIGIN, makeToken: nextToken, makeChannel: fakeChannel, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, ...bridgeOpts });
  const open = async (key, { start = true } = {}) => {
    await store.load(key);
    const f = fakeFrame(), win = f.contentWindow;
    bridge.mount(f, { key, html });
    let fr = null;
    // Atelier → this frame's window (the port, in answer to hello); the frame → Atelier's window (hello).
    win.postMessage = (m, o, transfer = []) => { assert.equal(o, '*'); fr.receive(structuredClone(m), { ports: transfer }); };
    const run = (src = f.srcdoc) => {
      fr = frame(src, { port: false, deliver: (m) => queueMicrotask(() => bridge.onMessage({ data: m, source: win, origin: 'null' })) });
      fr.run(html.match(/<script>([\s\S]*?)<\/script>/)[1]); // then the app's own script, as its document runs it
      return fr;
    };
    // Loads the frame's document; if Atelier then gives the frame a new one (this one was outdated), that one loads.
    // A location.reload() in the frame is the same: the srcdoc it has runs again. → the first document's context.
    const load = async () => { const before = f.srcdoc, first = run(before); await settle(); if (f.srcdoc !== before) { run(); await settle(); } return first; };
    const app = {
      f, get fr() { return fr; }, count: () => fr.run('n'), click: (k = 1) => { for (let i = 0; i < k; i++) fr.run('click()'); },
      js: (src) => fr.run(src), start: async () => { await load(); return app; }, reload: load,
    };
    if (start) await load();
    return app;
  };
  return { store, bridge, open };
}
const tryJs = (s) => `(() => { try { ${s}; return "ok" } catch (e) { return e.name } })()`;

test('an app’s data survives an Atelier reload, a refine and its own Reset; Clear empties it; another app never sees it', async () => {
  const backend = memoryBackend(), c = clock(), APP = COUNTER;
  const page = () => atelierPage({ backend, c });
  const t = 'thread1';
  const v1 = { id: 'v1', kind: 'build', prompt: 'counter', createdAt: 1, params: {}, app: { html: APP, title: 'Counter' } };
  const entries = [v1];
  const p1 = page();
  const a = await p1.open(appKey(t, entries, v1));
  assert.equal(a.count(), 0);
  a.click(3);
  await settle();
  assert.equal(p1.store.bytes(`${t}/v1`), (5 + 1) * 2);
  // The same app in Full screen at the same time: it starts at 3, and the card hears its writes as storage events.
  const full = await p1.open(`${t}/v1`);
  assert.equal(full.count(), 3);
  a.js('window.heard = []; addEventListener("storage", (e) => heard.push(e.newValue))');
  full.click(2); await settle();
  assert.deepEqual(JSON.parse(a.js('JSON.stringify(heard)')), ['4', '5']);
  assert.deepEqual(items(backend.rows.get(`${t}/v1`)), { count: '5' }, 'already in the database: no timer ran');

  // Reload Atelier, reopen the thread: a new page over the same database.
  const p2 = page();
  assert.equal((await p2.open(appKey(t, entries, v1))).count(), 5);
  // Refine: v2 changes v1; it is the same app.
  const v2 = { id: 'v2', kind: 'build', prompt: 'make it blue', createdAt: 2, params: {}, refineOf: 'v1', app: { html: APP, title: 'Counter v2' } };
  entries.push(v2);
  const b = await p2.open(appKey(t, entries, v2));
  assert.equal(b.count(), 5, 'the refined app keeps the data');
  b.click(); await settle();
  // The app's own Reset: clear, then location.reload() — the clear goes on the port as the document unloads.
  const staleDoc = b.f.srcdoc;
  b.js('localStorage.clear(); dispatchEvent(new Event("pagehide"))');
  const stale = await b.reload();
  assert.equal(stale.run('n'), 5, 'the reloaded srcdoc holds the items from when it was made…');
  assert.deepEqual(p2.store.items(`${t}/v1`), [], '…but the clear was kept');
  assert.notEqual(b.f.srcdoc, staleDoc, 'so Atelier gave the frame a fresh document');
  assert.equal(b.count(), 0, 'which starts empty');
  stale.run('click()'); await settle();
  assert.equal(backend.rows.has(`${t}/v1`), false, 'the stale document has no port: its write went nowhere');
  b.click(4); await settle();
  // Another app (Refine off) in the same thread starts empty and can't see the first one's data.
  const other = { id: 'v3', kind: 'build', prompt: 'another counter', createdAt: 3, params: {}, app: { html: APP, title: 'Other' } };
  entries.push(other);
  const o = await p2.open(appKey(t, entries, other));
  assert.equal(o.count(), 0);
  assert.equal(o.js('localStorage.length'), 0);
  o.click(); await settle();
  assert.deepEqual(items(backend.rows.get(`${t}/v3`)), { count: '1' });
  assert.deepEqual(items(backend.rows.get(`${t}/v1`)), { count: '4' });
  // Clear app data: gone from the open frame (remounted), the database, and the next page.
  await p2.store.clear(`${t}/v1`);
  p2.bridge.remount(`${t}/v1`);
  assert.deepEqual(cfgOf(b.f.srcdoc).items, []);
  assert.equal(backend.rows.has(`${t}/v1`), false);
  assert.equal((await page().open(`${t}/v1`)).count(), 0);
  assert.deepEqual(items(backend.rows.get(`${t}/v3`)), { count: '1' }, 'the other app keeps its own');
});

test('another Atelier tab’s writes reach this tab’s frames: storage events, and a card loaded later starts from them', async () => {
  const backend = memoryBackend(), c = clock();
  const chans = []; const channel = () => { const ch = { onmessage: null, postMessage: (d) => chans.filter((o) => o !== ch).forEach((o) => o.onmessage?.({ data: structuredClone(d) })) }; chans.push(ch); return ch; };
  const tabA = atelierPage({ backend, c, store: { channel: channel() } }), tabB = atelierPage({ backend, c, store: { channel: channel() } });
  const a = await tabA.open(A), b = await tabB.open(A);
  const lazy = await tabB.open(A, { start: false }); // an off-screen card in tab B: its document is set, not loaded yet
  b.js('window.heard = []; addEventListener("storage", (e) => heard.push([e.key, e.oldValue, e.newValue]))');
  a.click(3); await settle(10);
  assert.equal(b.js('localStorage.getItem("count")'), '3', 'tab B’s open frame reads tab A’s value');
  assert.deepEqual(JSON.parse(b.js('JSON.stringify(heard)')), [['count', null, '3']], 'and heard it as a storage event');
  await lazy.start();
  assert.equal(lazy.count(), 3, 'the card that loads later starts from tab A’s save, not the document made before it');
  lazy.click(); await settle(10);
  assert.deepEqual(items(backend.rows.get(A)), { count: '4' }, 'so its write builds on it: nothing of tab A’s is lost');
  assert.equal(a.js('localStorage.getItem("count")'), '4', 'and tab A hears it back');
  // A channel message can be missed: the next write's merge brings the other tab's keys in, and says so too.
  const quiet = memoryBackend(), one = atelierPage({ backend: quiet, c }), two = atelierPage({ backend: quiet, c });
  const x = await one.open(B), y = await two.open(B);
  x.js('localStorage.setItem("fromOne", "1")'); await settle(10);
  y.js('localStorage.setItem("fromTwo", "2")'); await settle(10);
  assert.equal(y.js('localStorage.getItem("fromOne")'), '1');
  assert.deepEqual(items(quiet.rows.get(B)), { fromOne: '1', fromTwo: '2' });
});

test('two frames of one app writing the same key in the same turn end on the same value: the one the store kept', async () => {
  const backend = memoryBackend(), p = atelierPage({ backend, c: clock() });
  const card = await p.open(A), full = await p.open(A);
  card.js('localStorage.setItem("k", "from-card")'); full.js('localStorage.setItem("k", "from-full")');
  await settle(10);
  assert.equal(p.store.value(A, 'k'), 'from-full', 'Atelier applied the card’s write first');
  assert.equal(card.js('localStorage.getItem("k")'), 'from-full');
  assert.equal(full.js('localStorage.getItem("k")'), 'from-full', 'Full screen ignored the card’s older write to a key it had a write on the way for');
  // A clear in one frame while the other has a write on the way: that write survives, everywhere.
  card.js('localStorage.clear()'); full.js('localStorage.setItem("z", "1")');
  await settle(10);
  assert.deepEqual(p.store.items(A), [['z', '1']]);
  assert.equal(card.js('JSON.stringify(localStorage)'), '{"z":"1"}');
  assert.equal(full.js('JSON.stringify(localStorage)'), '{"z":"1"}');
  assert.deepEqual(items(backend.rows.get(A)), { z: '1' });
});

test('a write the store refuses (the workspace filled up after the frame opened) is undone in the frame, said once, and the next throws', async () => {
  const refusals = [];
  const p = atelierPage({ backend: memoryBackend(), c: clock(), store: { appCap: 150, totalCap: 200 }, bridge: { onRefused: (k) => refusals.push(k) } });
  const a = await p.open(A);
  assert.equal(cfgOf(a.f.srcdoc).quota, 150);
  await p.store.load(B);
  p.store.apply(B, [['s', 'b', 'x'.repeat(59)]]); // another app saves 120 bytes: 80 left in all
  assert.equal(a.js(tryJs('localStorage.setItem("a", "y".repeat(49))')), 'ok', '100 bytes: within the room the frame was given');
  await settle(10);
  assert.deepEqual(p.store.items(A), [], 'the store refused it');
  assert.equal(a.js('localStorage.getItem("a")'), null, 'so the frame shows what is kept');
  assert.deepEqual(refusals, [A]);
  assert.equal(a.js(tryJs('localStorage.setItem("a", "y".repeat(49))')), 'QuotaExceededError', 'its room is now what is left');
  a.js('localStorage.setItem("small", "1")'); await settle(10);
  assert.deepEqual(p.store.items(A), [['small', '1']]);
  assert.equal(a.js('localStorage.getItem("small")'), '1');
});

test('a thread gone from this device keeps its apps’ data 30 days (a restore finds it), then prune deletes it', async () => {
  const idb = fakeIdb(), c = clock(), DAY = 24 * 3600 * 1000;
  const open = () => storeWith({ backend: idbBackend('atelier-appdata', idb, idb.KeyRange), clock: c }).store;
  const s = open();
  await s.load(A); await s.load(C);
  s.apply(A, [['s', 'habits', '[1]']]); s.apply(C, [['s', 'c', '1']]);
  await settle();
  assert.deepEqual(await s.prune(['thread1', 'thread2']), [], 'both threads are here');
  assert.deepEqual(await s.prune(['thread2']), [], 'thread1 left (Recently deleted, or deleted on another device): kept');
  await c.advance(29 * DAY);
  assert.deepEqual(await open().prune(['thread2']), []);
  const back = open(); // restored on day 29: the same thread id, and its apps' data is there
  assert.deepEqual(await back.prune(['thread1', 'thread2']), []);
  await back.load(A);
  assert.deepEqual(back.items(A), [['habits', '[1]']]);
  await c.advance(29 * DAY);
  assert.deepEqual(await open().prune(['thread2']), [], 'gone again: 30 days from now, not from the first time');
  await c.advance(30 * DAY);
  const late = open();
  await late.load(A); await late.load(C);
  const before = late.total();
  assert.deepEqual(await late.prune(['thread2']), ['thread1']);
  assert.deepEqual(late.items(A), [], 'deleted');
  assert.equal(late.total(), before - (6 + 3) * 2, 'and no longer counted toward the workspace’s 50 MB');
  assert.deepEqual(late.items(C), [['c', '1']], 'a thread still here keeps its data');
  const after = open();
  await after.load(A);
  assert.deepEqual(after.items(A), []);
  assert.deepEqual([...idb.dbs.get('atelier-appdata').get('gone').keys()], [], 'no marks left behind');
  // A delete that can't be undone takes the data at once (forgetThread).
  await after.load(C);
  await after.forgetThread('thread2');
  const fresh = open();
  await fresh.load(C);
  assert.deepEqual(fresh.items(C), []);
});

test('fmtBytes', () => {
  assert.deepEqual([0, 12, 2150, 20480, 5 * 1048576].map(fmtBytes), ['0 B', '12 B', '2.1 KB', '20 KB', '5.0 MB']);
  assert.equal(KEYS_MAX, 10000);
});
