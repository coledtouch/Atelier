// Build app data (v89): apps made in Build mode keep what they save, without weakening their sandbox.
//
// A Build preview runs in an iframe sandboxed WITHOUT allow-same-origin, so its document has an opaque origin ("null"):
// the browser's own localStorage, sessionStorage, IndexedDB and cookies throw SecurityError there, and generated code can
// never reach Atelier's origin, its storage or the passcode. That stays exactly as it is. Instead:
//   • storageShim (below) is the preview document's FIRST script (previewDoc puts it right after the doctype, ahead of
//     anything the app wrote). WebIDL puts localStorage and sessionStorage on the Window instance as configurable
//     accessors, so Object.defineProperty replaces them before any app script runs: `localStorage.setItem(…)`,
//     `window.localStorage`, `self.localStorage` and property access all reach the shim (checked in sandboxed srcdoc
//     frames in Chromium: an own accessor, configurable: true; WebIDL requires the same of WebKit and Gecko). Should a
//     browser refuse, hello says ok: false and the app runs as it always has here, saving nothing.
//   • Each shim is a Proxy over an in-memory map with the whole Storage API (getItem, setItem, removeItem, clear, key,
//     length, named properties, delete, Object.keys / JSON.stringify / for…in, QuotaExceededError, the WebIDL string
//     conversions and argument checks) on the frame's own Storage.prototype, so instanceof Storage and
//     Storage.prototype.getItem.call(localStorage, k) behave as in a normal page. sessionStorage is memory only: it starts
//     empty and is gone when the document reloads.
//   • localStorage starts with this app's saved items, embedded in the shim's script as JSON with every "<" escaped. The
//     document says { type, v, token, kind: 'hello' } to Atelier when it starts; Atelier answers with a MessagePort, and
//     every write goes over it, batched per microtask: { type, v, token, kind: 'ops', ops: [['s', k, v] | ['r', k] |
//     ['c']] }. (A port also delivers what a document posts while it unloads; a window message then has no source.)
//   • Atelier (createBridge) decides which app the writes belong to: a hello counts only when ev.source is the window of
//     the frame IT mounted with that token, and the port goes to that window alone, so the port is the binding. Nothing
//     in a message names an app. The per-document token tells this document apart from an earlier one in the same frame
//     (a reload, a remount); a document that reloads runs the srcdoc's older items, so it gets no port (its writes are
//     never kept) and the frame gets a fresh document with the current ones.
//   • Messages are validated strictly (readMessage: exact shapes, strings only, size limits), applied to createAppStore's
//     in-memory copy within the caps, and written to IndexedDB at once (one write in flight, the next carries whatever
//     came meanwhile), read-modify-write per app, so two Atelier tabs merge per key as real localStorage would. Every
//     message gets an 'ack' on its port, in order: a write the store refused comes back as the store has that key, and
//     a change from elsewhere to a key the frame still has a write on the way for is ignored (that write lands after it).
//     Nothing a frame sends is evaluated or rendered as markup, and the only data that goes back into a frame is its own
//     app's items (its next srcdoc, acks) and storage events from another frame or Atelier tab showing the SAME app.
// Identity: `${thread id}/${first build of the lineage}` (builds.js rootOf). Refines chain onto that root and Restore only
// moves the head, so every version of an app shares one store, and it survives reloads and reopening the thread; a new
// app (Refine off) or another thread is another store. The store is device-local and per workspace (owner, guest, each
// tester account): it isn't synced, backed up or embedded in a download. Deleting a thread that can't be restored removes
// its apps' data at once; a thread no longer on this device for another reason (in Recently deleted, deleted on another
// device) keeps it 30 days, so a restore finds it, then prune deletes it. Clear this device removes all of this workspace's.
import { rootOf } from './builds.js?v=89';

export const MSG = 'atelier-appdata';
export const APP_CAP = 5 * 1024 * 1024;     // bytes per app: 2 per UTF-16 code unit of keys + values (as browsers count)
export const TOTAL_CAP = 50 * 1024 * 1024;  // bytes for all apps of one workspace on this device
export const KEY_MAX = 1024;                // code units in one key
export const VALUE_MAX = APP_CAP / 2;       // code units in one value (a single value can fill the app's cap)
export const KEYS_MAX = 10_000;             // keys per app
export const OPS_MAX = 512;                 // writes in one message (the shim sends a full batch at once)
export const MSG_MAX = 2 * APP_CAP;         // bytes of keys + values in one message
export const GONE_KEEP_MS = 30 * 24 * 3600 * 1000; // a thread gone from this device keeps its apps' data this long (Recently deleted's 30 days)
const ID = /^[\w-]{1,120}$/;
export const validKey = (k) => typeof k === 'string' && k.length <= 241 && /^[\w-]{1,120}\/[\w-]{1,120}$/.test(k);
export const cost = (k, v) => (k.length + v.length) * 2;

// The app a Build entry belongs to: its thread and the first build of its lineage. '' when it can't be named safely
// (that preview then gets a shim that saves nothing).
export function appKey(threadId, entries, entry) {
  if (typeof threadId !== 'string' || !ID.test(threadId) || !Array.isArray(entries) || !entries.includes(entry)) return '';
  const root = rootOf(entries, entry);
  return root && typeof root.id === 'string' && ID.test(root.id) ? `${threadId}/${root.id}` : '';
}
// Each workspace has its own database, like its threads (app.js threadDbName).
export function workspaceDb(workspace) {
  if (workspace === 'owner') return 'atelier-appdata';
  if (typeof workspace === 'string' && workspace.startsWith('tester:') && workspace.length > 7) return `atelier-appdata-account-${encodeURIComponent(workspace.slice(7))}`;
  return 'atelier-appdata-guest';
}
export function fmtBytes(n) {
  if (!(n > 0)) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

// ───────────────────────── inside the frame ─────────────────────────
// Runs INSIDE the sandboxed preview as `(${storageShim})(cfg)`: it must stay self-contained (no module scope; the tests
// run this exact source in a separate JS context). cfg: { type, token, origin (Atelier's, for postMessage), persist,
// items: [[key, value]…], quota (bytes), keyMax, keysMax, opsMax, msgMax }.
export function storageShim(cfg) {
  'use strict';
  const W = window, D = document, up = W.parent, persist = cfg.persist === true;
  const qm = typeof W.queueMicrotask === 'function' ? W.queueMicrotask.bind(W) : (f) => Promise.resolve().then(f);
  // The port arrives after the app's scripts ran, and they may have patched MessageEvent / MessagePort / Event to catch
  // it (and hand it to a window that outlives this frame). So every native the port's path touches is taken now, before
  // any app script, and called through Reflect.apply: the app never sees the port, the events carrying it or our calls.
  const R = Reflect.apply, own = (C, name) => { try { return Object.getOwnPropertyDescriptor(C && C.prototype, name) || null; } catch { return null; } };
  const evGet = Object.fromEntries(['data', 'source', 'origin', 'ports'].map((n) => [n, own(W.MessageEvent, n)?.get || null]));
  const readEv = (ev, name) => (evGet[name] ? R(evGet[name], ev, []) : ev[name]);
  const stopNow = own(W.Event, 'stopImmediatePropagation')?.value || null;
  const portPost = own(W.MessagePort, 'postMessage')?.value || null, portOnMessage = own(W.MessagePort, 'onmessage')?.set || null;
  const DE = W.DOMException, href = String(W.location && W.location.href);
  const areas = new WeakMap();
  const str = (x) => { if (typeof x === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string'); return String(x); };
  const size = (k, v) => (k.length + v.length) * 2;
  const ARGS = { key: 1, getItem: 1, setItem: 2, removeItem: 1, clear: 0 };
  const short = (k) => (k.length > 60 ? `${k.slice(0, 60)}…` : k);

  // One storage area: the map, its size in bytes and the Storage operations on it.
  function area(items, quota, onWrite) {
    const map = new Map();
    let bytes = 0, list = null;
    for (const it of Array.isArray(items) ? items : []) {
      if (Array.isArray(it) && typeof it[0] === 'string' && typeof it[1] === 'string' && !map.has(it[0])) { map.set(it[0], it[1]); bytes += size(it[0], it[1]); }
    }
    const keys = () => (list || (list = [...map.keys()]));
    return {
      has: (k) => map.has(k), peek: (k) => map.get(k), keys, get size() { return map.size; },
      setQuota(q) { quota = q; },
      key(n) {
        let i = Number(n);
        i = Number.isFinite(i) ? Math.trunc(i) % 4294967296 : 0;
        if (i < 0) i += 4294967296;
        const all = keys();
        return i < all.length ? all[i] : null;
      },
      getItem(k) { k = str(k); return map.has(k) ? map.get(k) : null; },
      setItem(k, v) {
        k = str(k); v = str(v);
        const had = map.has(k), old = had ? map.get(k) : null;
        if (had && old === v) return;
        const next = bytes - (had ? size(k, old) : 0) + size(k, v);
        if (k.length > cfg.keyMax || (next > quota && next > bytes) || (!had && map.size >= cfg.keysMax)) {
          throw new DE(`Failed to execute 'setItem' on 'Storage': Setting the value of '${short(k)}' exceeded the quota.`, 'QuotaExceededError');
        }
        map.set(k, v); bytes = next;
        if (!had) list = null;
        if (onWrite) onWrite(['s', k, v]);
      },
      removeItem(k) {
        k = str(k);
        if (!map.has(k)) return;
        bytes -= size(k, map.get(k)); map.delete(k); list = null;
        if (onWrite) onWrite(['r', k]);
      },
      clear() {
        if (!map.size) return;
        map.clear(); bytes = 0; list = null;
        if (onWrite) onWrite(['c']);
      },
      // A change from Atelier (another frame's or tab's write, or the store's value for a write it refused): → [key,
      // oldValue, newValue] for a storage event, or null. keep(k): this frame has its own write to k on the way, which
      // Atelier applies after this change, so k stays as it is here.
      apply(op, keep) {
        if (!Array.isArray(op)) return null;
        const [t, k, v] = op;
        if ((t === 's' || t === 'r') && (typeof k !== 'string' || keep(k))) return null;
        if (t === 's' && typeof v === 'string') {
          const had = map.has(k), old = had ? map.get(k) : null;
          if (had && old === v) return null;
          map.set(k, v); bytes += size(k, v) - (had ? size(k, old) : 0);
          if (!had) list = null;
          return [k, old, v];
        }
        if (t === 'r') {
          if (!map.has(k)) return null;
          const old = map.get(k);
          bytes -= size(k, old); map.delete(k); list = null;
          return [k, old, null];
        }
        if (t === 'c') {
          let n = 0;
          for (const key of [...map.keys()]) if (!keep(key)) { bytes -= size(key, map.get(key)); map.delete(key); n++; }
          if (!n) return null;
          list = null;
          return [null, null, null];
        }
        return null;
      },
    };
  }

  // The Storage methods and length, defined on `proto` (normally the frame's own Storage.prototype, so an app that wraps
  // Storage.prototype.setItem still sees every write): on one of our areas they act on it, on anything else they do
  // what the browser's own did (here: throw).
  function patch(proto, P) {
    for (const name of Object.keys(ARGS)) {
      const d = P && Object.getOwnPropertyDescriptor(P, name), orig = d && typeof d.value === 'function' ? d.value : null;
      const fn = { [name](...args) {
        const a = areas.get(this);
        if (!a) { if (orig) return orig.apply(this, args); throw new TypeError('Illegal invocation'); }
        if (args.length < ARGS[name]) throw new TypeError(`Failed to execute '${name}' on 'Storage': ${ARGS[name]} argument${ARGS[name] > 1 ? 's' : ''} required, but only ${args.length} present.`);
        return a[name](...args);
      } }[name];
      Object.defineProperty(fn, 'length', { value: ARGS[name] });
      Object.defineProperty(proto, name, { value: fn, writable: true, enumerable: true, configurable: true });
    }
    const ld = P && Object.getOwnPropertyDescriptor(P, 'length');
    Object.defineProperty(proto, 'length', {
      get() { const a = areas.get(this); if (a) return a.size; if (ld && ld.get) return ld.get.call(this); throw new TypeError('Illegal invocation'); },
      enumerable: true, configurable: true,
    });
  }
  const P = typeof W.Storage === 'function' && W.Storage.prototype && typeof W.Storage.prototype === 'object' ? W.Storage.prototype : null;
  let base = P;
  try { if (P) patch(P, P); } catch { base = null; }
  if (!base) { base = Object.create(P || Object.prototype); patch(base, null); }

  // A Storage object: named properties map to keys unless the prototype chain has that name (WebIDL's visibility rule),
  // assigning any string property stores it, and Object.keys / JSON.stringify list the keys.
  function storage(a) {
    const t = Object.create(base);
    const visible = (p) => typeof p === 'string' && a.has(p) && !(p in t);
    const px = new Proxy(t, {
      get: (o, p, r) => (visible(p) ? a.peek(p) : Reflect.get(o, p, r)),
      set: (o, p, v, r) => { if (typeof p === 'string' && r === px) { a.setItem(p, v); return true; } return Reflect.set(o, p, v, r); },
      has: (o, p) => (typeof p === 'string' && a.has(p)) || Reflect.has(o, p),
      deleteProperty: (o, p) => { if (visible(p)) { a.removeItem(p); return true; } return Reflect.deleteProperty(o, p); },
      ownKeys: (o) => [...a.keys().filter((k) => !(k in o)), ...Reflect.ownKeys(o)],
      getOwnPropertyDescriptor: (o, p) => (visible(p) ? { value: a.peek(p), writable: true, enumerable: true, configurable: true } : Reflect.getOwnPropertyDescriptor(o, p)),
      defineProperty: (o, p, d) => {
        if (typeof p !== 'string') return Reflect.defineProperty(o, p, d);
        if (!('value' in d) || 'get' in d || 'set' in d || d.configurable === false) return false;
        a.setItem(p, d.value); return true;
      },
      preventExtensions: () => false,
    });
    areas.set(px, a);
    return px;
  }

  // Writes go to Atelier over the MessagePort it sends back for 'hello' (the shim's only window message): once per
  // microtask, or at once when a batch is full, in messages of at most opsMax ops and msgMax / 2 bytes (one op may be
  // bigger). A port, unlike window messages, still delivers what a document posts as it unloads (a Reset that clears,
  // then reloads), where event.source is already null. Writes made before the port arrives wait for it; past a limit
  // they're dropped for one full copy of the items, sent when it comes.
  let port = null, queue = [], qBytes = 0, resync = false;
  // This frame's writes that Atelier hasn't acknowledged yet (queued, or posted and waiting for the 'ack' Atelier sends
  // for every message, in order), per key and for clears. A change Atelier sends for such a key is older than that write
  // (Atelier applies the write after it), so the frame keeps its own value, as browsers do with another tab's write to a
  // key that has a local change pending; every frame of the app then ends on the value the store kept.
  const pend = new Map(), sent = [];
  let pendClear = 0;
  const mark = (op, n) => {
    if (op[0] === 'c') { pendClear += n; return; }
    const c = (pend.get(op[1]) || 0) + n;
    if (c > 0) pend.set(op[1], c); else pend.delete(op[1]);
  };
  const mine = (k) => pendClear > 0 || pend.has(k);
  const opBytes = (op) => (op[0] === 'c' ? 0 : size(op[1], op.length > 2 ? op[2] : ''));
  const post = (ops) => {
    const msg = { type: cfg.type, v: 1, token: cfg.token, kind: 'ops', ops };
    try { if (portPost) R(portPost, port, [msg]); else port.postMessage(msg); sent.push(ops); } catch { for (const op of ops) mark(op, -1); }
  };
  const flush = () => {
    if (!port || !queue.length) return;
    const all = queue;
    queue = []; qBytes = 0;
    let chunk = [], bytes = 0;
    for (const op of all) {
      const c = opBytes(op);
      if (chunk.length && (chunk.length >= cfg.opsMax || bytes + c > cfg.msgMax / 2)) { post(chunk); chunk = []; bytes = 0; }
      chunk.push(op); bytes += c;
    }
    if (chunk.length) post(chunk);
  };
  const write = (op) => {
    if (resync) return;
    const c = opBytes(op);
    if (port && queue.length && qBytes + c > cfg.msgMax / 2) flush();
    queue.push(op); qBytes += c; mark(op, 1);
    if (!port) { if (queue.length > cfg.opsMax * 4 || qBytes > cfg.msgMax) { resync = true; queue = []; qBytes = 0; pend.clear(); pendClear = 0; } return; }
    if (queue.length >= cfg.opsMax) flush();
    else if (queue.length === 1) qm(flush);
  };
  const localArea = area(cfg.items, cfg.quota, persist ? write : null);
  const local = storage(localArea), session = storage(area([], cfg.quota, null));
  const install = (name, value) => {
    try { Object.defineProperty(W, name, { get: () => value, set: undefined, enumerable: true, configurable: true }); } catch {}
    try { return W[name] === value; } catch { return false; }
  };
  const okLocal = install('localStorage', local), ok = install('sessionStorage', session) && okLocal;

  if (persist) {
    // A write another frame of this app made: apply it and fire 'storage', as another tab's write would.
    const fire = ([key, oldValue, newValue]) => {
      const init = { key, oldValue, newValue, url: href };
      let ev;
      try { ev = new W.StorageEvent('storage', init); } catch { ev = new W.Event('storage'); for (const k of Object.keys(init)) Object.defineProperty(ev, k, { value: init[k] }); }
      try { Object.defineProperty(ev, 'storageArea', { value: local, configurable: true }); } catch {}
      W.dispatchEvent(ev);
    };
    // Atelier's answer to hello: this document's port (from Atelier's own window, to its origin, with this token).
    W.addEventListener('message', (ev) => {
      if (readEv(ev, 'source') !== up || readEv(ev, 'origin') !== cfg.origin) return;
      const d = readEv(ev, 'data');
      if (!d || d.type !== cfg.type || d.token !== cfg.token) return;
      if (stopNow) R(stopNow, ev, []); else ev.stopImmediatePropagation(); // Atelier's own messages: the app never sees them
      const ports = readEv(ev, 'ports');
      if (d.kind !== 'port' || port || !ports || !ports[0]) return;
      port = ports[0];
      const onEvent = (e) => {
        const m = readEv(e, 'data');
        if (!m || m.type !== cfg.type || m.token !== cfg.token) return;
        if (m.kind === 'ack') {
          // Atelier applied the oldest message still waiting. Writes it refused (the workspace filled up since this
          // document was made) come back as the store has them, with the room the app has now.
          const done = sent.shift();
          if (done) for (const op of done) mark(op, -1);
          if (typeof m.quota === 'number' && m.quota >= 0) localArea.setQuota(m.quota);
          if (Array.isArray(m.fix)) for (const op of m.fix) localArea.apply(op, mine);
          return;
        }
        if (m.kind !== 'event' || !Array.isArray(m.ops)) return;
        for (const op of m.ops) { const change = localArea.apply(op, mine); if (change) fire(change); }
      };
      if (portOnMessage) R(portOnMessage, port, [onEvent]); else port.onmessage = onEvent;
      if (resync) {
        resync = false;
        queue = [['c'], ...localArea.keys().map((k) => ['s', k, localArea.peek(k)])];
        for (const op of queue) mark(op, 1);
      }
      flush();
    }, true);
    W.addEventListener('pagehide', flush, true);
    try { up.postMessage({ type: cfg.type, v: 1, token: cfg.token, kind: 'hello', ok }, cfg.origin); } catch {}
  }
  try { if (D.currentScript) D.currentScript.remove(); } catch {} // the items stay out of the app's DOM
}

// JSON for inside a <script>: no "<" (so no "</script>" or "<!--"), no line separators.
const scriptJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
// After a leading doctype (and any comments or whitespace before it), else at the very start: ahead of every script the
// app wrote. A script before <html> lands in an implied <head>; the app's own <html>/<head> tags then merge into it.
// A comment's body can't contain "-->", so each comment matches one way only and a near-miss fails in linear time (a lazy
// [\s\S]*? could run past one "-->" into the next: 2^n ways to split n comments, a frozen page for a few hundred bytes).
const LEAD = /^\uFEFF?(?:\s|<!--(?:[^-]|-(?!->))*-->)*<!doctype[^>]*>/i;
export function injectFirst(html, s) {
  const m = LEAD.exec(html);
  const at = m ? m[0].length : 0;
  return html.slice(0, at) + s + html.slice(at);
}
// The preview document: the shim (cfg null: one that saves nothing), then `head` (app.js's focus guard), then the app.
export function previewDoc(html, cfg = null, head = '') {
  const c = cfg || { type: MSG, token: '', origin: '', persist: false, items: [], quota: APP_CAP };
  const full = { keyMax: KEY_MAX, keysMax: KEYS_MAX, opsMax: OPS_MAX, msgMax: MSG_MAX, ...c };
  return injectFirst(String(html), `<script>(${storageShim})(${scriptJson(full)})</script>${head}`);
}

// ───────────────────────── in Atelier ─────────────────────────
const plain = (o) => o !== null && typeof o === 'object' && Object.getPrototypeOf(o) === Object.prototype;
const isArray = (a) => Array.isArray(a) && Object.getPrototypeOf(a) === Array.prototype;
const TOKEN = /^[0-9a-f]{32}$/;
// A frame's writes, checked: exact shapes, strings only, within the limits. → a fresh array of ops, or null (refused).
export function readOps(list) {
  if (!isArray(list) || list.length < 1 || list.length > OPS_MAX) return null;
  const out = [];
  let bytes = 0;
  for (let i = 0; i < list.length; i++) {
    if (!Object.hasOwn(list, i)) return null;
    const op = list[i];
    if (!isArray(op) || op.length < 1 || op.length > 3) return null;
    for (let j = 0; j < op.length; j++) if (!Object.hasOwn(op, j) || typeof op[j] !== 'string') return null;
    const [t, k, v] = op;
    if (t === 's' && op.length === 3 && k.length <= KEY_MAX && v.length <= VALUE_MAX) { bytes += cost(k, v); out.push(['s', k, v]); }
    else if (t === 'r' && op.length === 2 && k.length <= KEY_MAX) { bytes += cost(k, ''); out.push(['r', k]); }
    else if (t === 'c' && op.length === 1) out.push(['c']);
    else return null;
    if (bytes > MSG_MAX) return null;
  }
  return out;
}
// → { kind: 'hello', token, ok } (a window message) | { kind: 'ops', token, ops } (on a port) | null (not valid).
export function readMessage(d) {
  if (!plain(d) || d.type !== MSG || d.v !== 1 || typeof d.token !== 'string' || !TOKEN.test(d.token)) return null;
  const keys = Object.keys(d).sort().join(',');
  if (d.kind === 'hello') return keys === 'kind,ok,token,type,v' && typeof d.ok === 'boolean' ? { kind: 'hello', token: d.token, ok: d.ok } : null;
  if (d.kind !== 'ops' || keys !== 'kind,ops,token,type,v') return null;
  const ops = readOps(d.ops);
  return ops ? { kind: 'ops', token: d.token, ops } : null;
}

const itemsOf = (rec) => {
  const items = new Map();
  if (!rec || rec.v !== 1 || !Array.isArray(rec.items)) return items;
  for (const it of rec.items) {
    if (Array.isArray(it) && it.length === 2 && typeof it[0] === 'string' && typeof it[1] === 'string' && it[0].length <= KEY_MAX && !items.has(it[0])) items.set(it[0], it[1]);
  }
  return items;
};
const bytesOf = (items) => { let n = 0; for (const [k, v] of items) n += cost(k, v); return n; };
const applyDelta = (items, d) => {
  if (d.cleared) items.clear();
  for (const [k, v] of d.sets) { if (v === null) items.delete(k); else items.set(k, v); }
  return items;
};
// Two deltas in order: everything `b` did happens after `a`.
const combine = (a, b) => (b.cleared ? b : { cleared: a.cleared, sets: new Map([...a.sets, ...b.sets]) });
const recordOf = (items, at) => (items.size ? { v: 1, items: [...items], bytes: bytesOf(items), at } : null);

// What changed from items `a` to items `b`, as ops a frame applies: one clear when `b` is empty, else removes and sets.
const diffOps = (a, b) => {
  if (!b.size) return a.size ? [['c']] : [];
  const ops = [];
  for (const k of a.keys()) if (!b.has(k)) ops.push(['r', k]);
  for (const [k, v] of b) if (a.get(k) !== v) ops.push(['s', k, v]);
  return ops;
};

// IndexedDB for one workspace: "apps" (key → { v: 1, items: [[k, v]…], bytes, at }), "sizes" (key → bytes, so the
// total is known without reading every app) and "gone" (thread id → when this device first found that thread missing
// while it still had app data: see prune). Version 2 adds "gone" to a database made before it.
export function idbBackend(name, idb = globalThis.indexedDB, KeyRange = globalThis.IDBKeyRange) {
  let dbp = null;
  const STORES = ['apps', 'sizes', 'gone'];
  const open = () => (dbp ??= new Promise((res, rej) => {
    const r = idb.open(name, 2);
    r.onupgradeneeded = () => {
      for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s);
    };
    r.onsuccess = () => { const db = r.result; db.onversionchange = () => { db.close(); dbp = null; }; res(db); };
    r.onerror = () => { dbp = null; rej(r.error); };
    r.onblocked = () => {};
  }));
  const range = (threadId) => KeyRange.bound(`${threadId}/`, `${threadId}/￿`);
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(STORES, mode);
      const out = fn(t.objectStore('apps'), t.objectStore('sizes'), t.objectStore('gone'));
      t.oncomplete = () => res(typeof out === 'function' ? out() : undefined);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error('App data couldn’t be saved'));
    });
  };
  return {
    sizes: () => tx('readonly', (_a, s) => { const k = s.getAllKeys(), v = s.getAll(); return () => new Map((k.result || []).map((key, i) => [key, v.result[i]])); }),
    get: (key) => tx('readonly', (a) => { const q = a.get(key); return () => q.result; }),
    // One transaction: fn(stored) → the record to keep (null: none), written with its size.
    update: (key, fn) => tx('readwrite', (a, s) => {
      let next = null;
      const q = a.get(key);
      q.onsuccess = () => {
        next = fn(q.result);
        if (next) { a.put(next, key); s.put(next.bytes, key); } else { a.delete(key); s.delete(key); }
      };
      return () => next;
    }),
    del: (key) => tx('readwrite', (a, s) => { a.delete(key); s.delete(key); }),
    // A thread's apps, all of them.
    delThread: (threadId) => tx('readwrite', (a, s, g) => { const r = range(threadId); a.delete(r); s.delete(r); g.delete(threadId); }),
    // One transaction: every thread with app data that isn't in `live` is marked gone (from `at`, the first time), a mark
    // whose thread is back (a restore) or has no data left goes, and threads gone graceMs or longer lose their apps'
    // data. \u2192 those thread ids.
    prune: (live, at, graceMs) => tx('readwrite', (a, s, g) => {
      const dropped = [];
      const keys = s.getAllKeys(), marked = g.getAllKeys(), when = g.getAll();
      when.onsuccess = () => { // requests complete in order: the other two are done
        const threads = new Set();
        for (const k of keys.result || []) if (validKey(k)) threads.add(k.slice(0, k.indexOf('/')));
        const marks = new Map((marked.result || []).map((t, i) => [t, when.result[i]]));
        for (const t of marks.keys()) if (live.has(t) || !threads.has(t)) g.delete(t);
        for (const t of threads) {
          if (live.has(t)) continue;
          const since = marks.get(t);
          if (!(Number.isFinite(since) && since <= at)) g.put(at, t);
          else if (at - since >= graceMs) { const r = range(t); a.delete(r); s.delete(r); g.delete(t); dropped.push(t); }
        }
      };
      return () => dropped;
    }),
    clear: () => tx('readwrite', (a, s, g) => { a.clear(); s.clear(); g.clear(); }),
  };
}

/// The parent store: an in-memory copy per app (authoritative for this tab), written to the backend as soon as it changes:
// the write starts in the task that made the change, because a page that is unloading can't start (or finish) an
// IndexedDB write, so an Atelier reload or a closed tab right after a tap must find it already under way. One write is
// in flight at a time; whatever arrives meanwhile goes in the next, as soon as it ends. Each is a read-modify-write per
// app. A failed write keeps its changes; the retry timer takes them (and anything newer) along.
export function createAppStore({ backend, appCap = APP_CAP, totalCap = TOTAL_CAP, keysMax = KEYS_MAX, setTimer = setTimeout,
  now = Date.now, defer = queueMicrotask, channel = null, onChange = () => {}, onError = () => {}, retryMs = 5000 } = {}) {
  const cache = new Map();   // key → { items: Map, bytes, pending: delta | null, flushing, flushes, reading, reread, epoch, version }
  const loading = new Map(); // key → its load
  const watchers = new Set(); // (key, ops): changes to an app this tab didn't make (another Atelier tab's), for its frames
  let sizes = null, sizesP = null, sizesStale = false, gen = 0;
  let queued = false, retry = null, chain = Promise.resolve();
  const entry = (items) => ({ items, bytes: bytesOf(items), pending: null, flushing: false, flushes: 0, reading: false, reread: false, epoch: 0, version: 0 });
  const delta = (e) => (e.pending ??= { cleared: false, sets: new Map() });
  const total = () => { let n = 0; if (sizes) for (const [k, b] of sizes) n += cache.get(k)?.bytes ?? b; return n; };
  const serial = (fn) => { const run = chain.then(fn); chain = run.catch(() => {}); return run; };
  const setSize = (key, e) => { if (sizes) { if (e.bytes) sizes.set(key, e.bytes); else sizes.delete(key); } };
  // This tab's copy of an app became `items` (another tab's write came in): its frames hear what changed.
  function replace(key, e, items) {
    const ops = diffOps(e.items, items);
    e.items = items; e.bytes = bytesOf(items);
    setSize(key, e);
    if (!ops.length) return;
    e.version++;
    for (const fn of watchers) { try { fn(key, ops); } catch {} }
  }

  function ready() {
    if (sizes && !sizesStale) return Promise.resolve();
    return (sizesP ??= Promise.resolve().then(() => backend.sizes()).then((m) => {
      sizesP = null; sizesStale = false;
      sizes = new Map();
      for (const [k, b] of m || []) if (validKey(k) && Number.isFinite(b) && b > 0) sizes.set(k, b);
      for (const [k, e] of cache) sizes.set(k, e.bytes);
    }, (err) => { sizesP = null; throw err; }));
  }
  function load(key) {
    if (!validKey(key)) return Promise.reject(new Error('Not an app'));
    if (cache.has(key)) return Promise.resolve(cache.get(key));
    if (loading.has(key)) return loading.get(key);
    const g = gen;
    const p = (async () => {
      await ready();
      const rec = await backend.get(key);
      if (cache.has(key)) return cache.get(key);
      const e = entry(g === gen ? itemsOf(rec) : new Map());
      cache.set(key, e);
      if (e.bytes) sizes.set(key, e.bytes); else sizes.delete(key);
      return e;
    })().finally(() => loading.delete(key));
    loading.set(key, p);
    return p;
  }
  const peek = (key) => cache.get(key) || null;
  const bytes = (key) => cache.get(key)?.bytes ?? sizes?.get(key) ?? 0;
  // What a frame mounted now may hold: the app cap, or less when the workspace's total is nearly full.
  const room = (key) => Math.max(0, Math.min(appCap, bytes(key) + Math.max(0, totalCap - total())));

  // A frame's validated writes, in order, within the caps (a write that would grow past them is dropped, its key added to
  // `refused`; shrinking is always allowed). → the ops that changed something (what sibling frames are told).
  function apply(key, ops, refused = null) {
    const e = cache.get(key);
    if (!e || !Array.isArray(ops)) return [];
    const done = [];
    let sum = total();
    for (const op of ops) {
      const [t, k, v] = op;
      if (t === 's') {
        const had = e.items.has(k), old = had ? e.items.get(k) : null;
        if (had && old === v) continue;
        const next = e.bytes - (had ? cost(k, old) : 0) + cost(k, v), grow = next - e.bytes;
        if (k.length > KEY_MAX || v.length > VALUE_MAX || (grow > 0 && (next > appCap || sum + grow > totalCap)) || (!had && e.items.size >= keysMax)) { refused?.push(k); continue; }
        e.items.set(k, v); e.bytes = next; sum += grow; delta(e).sets.set(k, v);
      } else if (t === 'r') {
        if (!e.items.has(k)) continue;
        const gone = cost(k, e.items.get(k));
        e.items.delete(k); e.bytes -= gone; sum -= gone; delta(e).sets.set(k, null);
      } else if (t === 'c') {
        if (!e.items.size) continue;
        sum -= e.bytes; e.items.clear(); e.bytes = 0; e.pending = { cleared: true, sets: new Map() };
      } else continue;
      done.push(op);
    }
    if (done.length) {
      e.version++;
      setSize(key, e);
      schedule(); onChange(key);
    }
    return done;
  }
  function schedule() {
    if (queued || retry) return;
    queued = true;
    defer(() => { flush().catch(() => {}); });
  }
  // Writes every app's pending changes: merged over what is stored (another tab's keys survive), then this tab's copy
  // becomes that result plus whatever arrived meanwhile. A failed write keeps its changes for the next try.
  function flush() {
    return serial(async () => {
      queued = false;
      let failed = null;
      for (const [key, e] of [...cache]) {
        if (!e.pending) continue;
        const d = e.pending, ep = e.epoch;
        e.pending = null; e.flushing = true;
        try {
          const merged = await backend.update(key, (rec) => recordOf(applyDelta(itemsOf(rec), d), now()));
          e.flushes++;
          if (cache.get(key) === e && e.epoch === ep) {
            const items = itemsOf(merged);
            if (e.pending) applyDelta(items, e.pending);
            const before = e.version;
            replace(key, e, items); // keys another tab stored come in with the merge
            if (e.version !== before) onChange(key);
          }
          channel?.postMessage({ key });
        } catch (err) {
          if (cache.get(key) === e && e.epoch === ep) e.pending = e.pending ? combine(d, e.pending) : d;
          failed = err;
        } finally {
          e.flushing = false;
          if (e.reread) { e.reread = false; refresh(key).catch(() => {}); }
        }
      }
      if (failed) {
        onError(failed);
        if (!retry) retry = setTimer(() => { retry = null; flush().catch(() => {}); }, retryMs);
        throw failed;
      }
    });
  }
  // Anything not in IndexedDB yet (Atelier's own reloads wait for flush() while this is true).
  const busy = () => queued || Boolean(retry) || [...cache.values()].some((e) => e.pending || e.flushing);
  // Clear app data: empty at once (frames remounted now start empty), then gone from the database.
  function clear(key) {
    if (!validKey(key)) return Promise.reject(new Error('Not an app'));
    const e = cache.get(key);
    if (e) { e.items = new Map(); e.bytes = 0; e.pending = null; e.epoch++; e.version++; }
    sizes?.delete(key);
    onChange(key);
    return serial(() => backend.del(key)).then(() => { channel?.postMessage({ key }); });
  }
  // Clear this device: every app of this workspace.
  function clearAll() {
    gen++;
    for (const e of cache.values()) { e.epoch++; e.pending = null; }
    cache.clear(); sizes = new Map();
    return serial(() => backend.clear()).then(() => { channel?.postMessage({ all: true }); });
  }
  const evict = (threadId) => {
    const prefix = `${threadId}/`;
    for (const [k, e] of [...cache]) if (k.startsWith(prefix)) { e.epoch++; e.pending = null; cache.delete(k); }
    if (sizes) for (const k of [...sizes.keys()]) if (k.startsWith(prefix)) sizes.delete(k);
  };
  // A thread deleted for good (it can't be restored): its apps' data goes with it.
  function forgetThread(threadId) {
    if (typeof threadId !== 'string' || !ID.test(threadId)) return Promise.resolve();
    evict(threadId);
    return serial(() => backend.delThread(threadId)).then(() => { channel?.postMessage({ prefix: `${threadId}/` }); });
  }
  // At boot, with the ids of the threads on this device: a thread that is gone (deleted here while Recently deleted can
  // still bring it back, deleted on another device, removed until sync brings it back) keeps its apps' data graceMs,
  // counted from when this device first found it gone, so a restore finds it; then it is deleted. → the thread ids pruned.
  async function prune(liveThreadIds, graceMs = GONE_KEEP_MS) {
    const live = new Set([...(liveThreadIds || [])].filter((id) => typeof id === 'string'));
    const dropped = (await serial(() => backend.prune(live, now(), graceMs))) || [];
    for (const t of dropped) { evict(t); channel?.postMessage({ prefix: `${t}/` }); }
    return dropped;
  }
  // Another Atelier tab of this workspace wrote: re-read that app (keeping this tab's unwritten changes on top). One read
  // at a time per app; one that overlaps this tab's own write is done again after it.
  async function refresh(key) {
    const e = cache.get(key);
    if (!e) return;
    if (e.flushing || e.reading) { e.reread = true; return; }
    e.reading = true;
    try {
      const ep = e.epoch, fl = e.flushes, rec = await backend.get(key);
      if (cache.get(key) !== e || e.epoch !== ep) return;
      if (e.flushing || e.flushes !== fl) { e.reread = true; return; }
      const items = itemsOf(rec);
      if (e.pending) applyDelta(items, e.pending);
      replace(key, e, items);
      onChange(key);
    } finally {
      e.reading = false;
      if (e.reread && !e.flushing) { e.reread = false; refresh(key).catch(() => {}); }
    }
  }
  if (channel) {
    channel.onmessage = (ev) => {
      const d = ev?.data;
      if (!plain(d)) return;
      sizesStale = true;
      const keys = typeof d.key === 'string' ? [d.key] : d.all === true || typeof d.prefix === 'string' ? [...cache.keys()].filter((k) => d.all || k.startsWith(d.prefix)) : [];
      for (const k of keys) refresh(k).catch(() => {});
    };
  }
  return { ready, load, peek, bytes, room, total, apply, flush, busy, clear, clearAll, forgetThread, prune, refresh,
    watch: (fn) => { watchers.add(fn); return () => watchers.delete(fn); },
    version: (key) => cache.get(key)?.version ?? 0,
    value: (key, k) => cache.get(key)?.items.get(k) ?? null,
    items: (key) => [...(cache.get(key)?.items || [])] };
}

const randomToken = () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

// Binds preview frames to apps. mount(frame, { key, html }) gives the frame a document whose shim holds that app's items
// and a fresh token; onMessage(ev) is the window 'message' listener (→ true when the message was this protocol's).
// Which app a write belongs to is Atelier's decision, never the frame's: a 'hello' counts only when ev.source is the
// window of the frame mounted with that token, and is answered with a MessagePort sent to that window alone. The port
// IS the binding: what arrives on it is that app's, still checked (readMessage, the token, the caps). States: loading
// (items not read yet) → new (document set) → live (has its port) → dead (unbound: port closed). A frame removed from
// the page keeps its binding graceMs, for writes it posted just before; then its port is closed.
// onRefused(key): the store refused a frame's write (no room left); onStall(key): a frame of that app started or stopped
// waiting for its next document (paused(key) says whether one is waiting).
export function createBridge({ store, origin, head = '', makeToken = randomToken, makeChannel = () => new MessageChannel(), now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, graceMs = 5000, rebuildLimit = 10, rebuildWindowMs = 10_000,
  warn = () => {}, onRefused = () => {}, onStall = () => {} }) {
  const byToken = new Map(), byFrame = new WeakMap();
  const stalled = new Map(); // frame → { key, html, timer }: an app reloading itself in a loop, until its next document
  const docFor = (b) => previewDoc(b.html, { type: MSG, token: b.token, origin, persist: true, items: store.items(b.key), quota: store.room(b.key) }, head);
  const plainDoc = (html) => previewDoc(html, null, head);
  function unbind(b) {
    byToken.delete(b.token);
    if (byFrame.get(b.frame) === b) byFrame.delete(b.frame);
    b.state = 'dead';
    if (b.port) { try { b.port.onmessage = null; b.port.close(); } catch {} b.port = null; }
  }
  function unstall(frame) {
    const w = stalled.get(frame);
    if (!w) return;
    stalled.delete(frame); clearTimer(w.timer); onStall(w.key);
  }
  function sweep() {
    const t = now();
    for (const b of [...byToken.values()]) {
      if (b.frame.isConnected) b.goneAt = 0;
      else if (!b.goneAt) b.goneAt = t;
      else if (t - b.goneAt > graceMs) unbind(b);
    }
  }
  function mount(frame, { key, html }, rebuilds = []) {
    sweep();
    unstall(frame);
    const old = byFrame.get(frame);
    if (old) unbind(old);
    if (!validKey(key)) { frame.srcdoc = plainDoc(html); return null; }
    const b = { frame, key, html, token: makeToken(), port: null, state: 'loading', goneAt: 0, rebuilds, behind: false, ok: null };
    byToken.set(b.token, b); byFrame.set(frame, b);
    const set = () => { if (byToken.get(b.token) !== b) return; b.state = 'new'; frame.srcdoc = docFor(b); };
    if (store.peek(key)) set();
    else store.load(key).then(set, (err) => {
      if (byToken.get(b.token) !== b) return;
      warn(err); unbind(b); frame.srcdoc = plainDoc(html); // can't read its data: the app runs, saving nothing
    });
    return b;
  }
  // A second hello with a live binding's token (the frame reloaded, or was put back in the page): that document runs the
  // srcdoc's older items, so the binding dies (its port closes; nothing it writes is kept) and the frame gets a fresh
  // document — at once up to rebuildLimit times in rebuildWindowMs. An app reloading itself faster than that (a loop)
  // gets its next one as soon as the window allows: meanwhile the old document saves nothing, and paused(key) says so.
  function rebuild(b) {
    const t = now(), recent = b.rebuilds.filter((x) => t - x < rebuildWindowMs), frame = b.frame;
    unbind(b);
    if (!frame.isConnected) return;
    if (recent.length < rebuildLimit) { mount(frame, { key: b.key, html: b.html }, [...recent, t]); return; }
    const timer = setTimer(() => {
      if (stalled.get(frame)?.timer !== timer) return;
      unstall(frame);
      const at = now();
      if (frame.isConnected && !byFrame.has(frame)) mount(frame, { key: b.key, html: b.html }, [...recent, at].filter((x) => at - x < rebuildWindowMs));
    }, Math.max(0, rebuildWindowMs - (t - recent[0])));
    stalled.set(frame, { key: b.key, html: b.html, timer });
    onStall(b.key);
  }
  function onMessage(ev) {
    const d = ev?.data;
    if (!plain(d) || d.type !== MSG) return false;
    sweep();
    const m = readMessage(d), b = m && m.kind === 'hello' && byToken.get(m.token), src = ev.source;
    if (!b || ev.origin !== 'null' || !src || !b.frame.isConnected || b.frame.contentWindow !== src) return true;
    if (b.state !== 'new' || b.behind) { rebuild(b); return true; }
    const { port1, port2 } = makeChannel();
    b.state = 'live'; b.port = port1; b.ok = m.ok;
    port1.onmessage = (e) => onPort(b, e.data);
    try { src.postMessage({ type: MSG, v: 1, token: b.token, kind: 'port' }, '*', [port2]); } catch { unbind(b); }
    if (!m.ok) warn('this browser didn’t let Atelier give the app its storage');
    return true;
  }
  // Changes to an app that a frame didn't make itself (another frame's write, another Atelier tab's): its live frames
  // hear them as storage events; a frame whose document was made before them (no port yet) is renewed when it says hello.
  function tell(key, ops, except = null) {
    for (const x of byToken.values()) {
      if (x === except || x.key !== key) continue;
      if (x.state === 'new') x.behind = true;
      else if (x.state === 'live' && x.port && x.frame.isConnected) { try { x.port.postMessage({ type: MSG, v: 1, token: x.token, kind: 'event', ops }); } catch {} }
    }
  }
  store.watch?.((key, ops) => tell(key, ops));
  // A message on a frame's port: that frame's app, in order. Each is acknowledged, in order, so the shim knows which of
  // its writes have landed (and ignores older changes to keys it still has a write on the way for). A write the store
  // refused (the workspace filled up after this document was made) goes back as the store has that key, with the room
  // the app has now, so the frame shows what is kept and its next such write throws QuotaExceededError.
  function onPort(b, data) {
    sweep();
    if (byToken.get(b.token) !== b || b.state !== 'live') return;
    const m = readMessage(data), refused = [];
    const applied = m && m.kind === 'ops' && m.token === b.token ? store.apply(b.key, m.ops, refused) : [];
    const fix = [...new Set(refused)].map((k) => { const v = store.value(b.key, k); return v === null ? ['r', k] : ['s', k, v]; });
    try { b.port.postMessage({ type: MSG, v: 1, token: b.token, kind: 'ack', fix, quota: store.room(b.key) }); } catch {}
    if (fix.length) onRefused(b.key);
    if (applied.length) tell(b.key, applied, b);
  }
  // After Clear app data, or when an app's data changed while it was in the viewer: its other frames start over (one
  // waiting out a reload loop too).
  function remount(key, except = null) {
    for (const b of [...byToken.values()]) if (b.key === key && b.frame !== except && b.frame.isConnected && b.state !== 'dead') mount(b.frame, { key, html: b.html });
    for (const [frame, w] of [...stalled]) if (w.key === key && frame !== except && frame.isConnected) mount(frame, { key, html: w.html });
  }
  const paused = (key) => [...stalled].some(([frame, w]) => w.key === key && frame.isConnected);
  return { mount, onMessage, remount, sweep, paused, bindings: () => [...byToken.values()] };
}
