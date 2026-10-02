// Owner thread sync: the browser engine (sync-spec.json client_spec, merge_spec, ui_spec). Phase 1 syncs text threads;
// entries holding images or videos stay on the device until MEDIA_SYNC (public/sync-merge.js) lets them go.
//   createSync(deps)   the engine, with every browser dependency injected (tests run it in Node against the real
//                      src/sync.js over tests/fake-r2.mjs). Exported as createEngine too.
//   wrapDb / init / verified / pause / kick / flush / on / busy / badge / deleteThread / deleteCopy / pendingCount /
//   wipeWarning / showStatus / firstRunAhead / forget / holdRunLock / noteImported   the browser singleton app.js calls
//                      (about 20 small hooks), plus the Settings → Your data block, Recently deleted, the first-sync
//                      dialog and the nav label.
// Importing this module has no side effects. State lives in its own IndexedDB database "atelier-sync" (version 1,
// one 'kv' store), never in "atelier-data" (opened without a version) or "atelier-kv" (passcode backup; Clear wipes it).
// That store is the one truth every tab shares; a tab's memory only caches it:
//   cfg               {v, deviceId, enabled, asked, mode 'all'|'new', enabledAt, firstDone, paused, lastOkAt, scanAt}:
//                     written field by field (read-modify-write in one transaction), re-read by every tab on a {cfg}
//                     notice and by the leader before each cycle, so no tab's older copy overwrites another's change
//   t:<id>            the thread's sync record (leader tab only): {etag, rev, born, title, titleRev, at, e: {entryId:
//                     {r, f, g, old, pend?}}, dead?, deleted?, tooLarge?, refused?, refetch?, full?, lost?, held?}
//                     (at: the thread's updatedAt when this device last checked everything pushable was on the server)
//   d:<id>            dirty stamp: the outbox (the DB wrapper starts writing it as the thread put starts, and again once
//                     the put landed; the leader keeps notices from other tabs even if their marker never committed)
//   lo:<id>           written while a LinkedIn tester session was active: never uploads
//   del:<id>          a delete-everywhere waiting to be sent {seen: {entryId: rev}, at, title, born?, keep?} — keep: the
//                     entries this device hadn't synced yet; they go up first, so Recently deleted can give them back
//   hide:<id>         removed locally by a non-user path: never downloaded again
//   in:<id>/<entry>   a pulled entry waiting for blobs {rev, h, missing, at}
//   q:<id>/<entry>/<h> quarantine: a pulled entry that failed validation {d, reason, at}
//   b:<sha256>        the server has this blob
//   bf:<sha256>       the server refused this blob (400/411/413/415) {code, at}: not offered again for a day
//   trace             this browser was used in LinkedIn tester mode
// Safety rules the engine keeps (merge_spec): updatedAt never decides a merge; pending, run-locked and recovered
// (r > 0) entries are never pushed; pulled entries are validated with data-safety's validateBackup before they touch
// IndexedDB (failures are quarantined); anything the server lacks is pushed again, never deleted here; only the drawer
// delete sends a server delete; the first 401 pauses sync until the passcode is proven again, and nothing at all is
// sent while it is paused (no lockout feeding); no request outlives a stop or its timeout.
// IndexedDB is the engine's one copy of a thread: every plan reads it and every merge is written into it (in one
// transaction that re-checks the plan). A tab's open thread is a view of it, refreshed in place whenever another tab
// or this engine writes it (refreshOpen: a three-way merge that keeps this tab's unsaved change), so a tab never
// pushes, settles or writes back a copy that is older than what another tab saved.
import {
  FORMAT, MEDIA_SYNC, TRANSIENT, syncId, validDate, isRev, sha256hex, utf8, utf8Length, fromBase64, base64Length, jsonClone, dehydrate,
  hydrate, mediaKinds, gateHeld, refsOf, reborn, bornOf, forkEntry, checkView, checkPulledEntry, newRecord, planPull, planPush, pushBodies,
  planPushResult, applyPlan, quickPrint, snapOf, sameSnap, entryOrder,
} from './sync-merge.js?v=56';
import { validateBackup } from './data-safety.js?v=56';

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
// The owner's choices and the engine's timing, kept together so they are easy to change.
export const SYNC_CLIENT = Object.freeze({
  autoEnable: true, // a verified owner on a browser without tester traces: sync turns itself on (mode 'all')
  pollMs: MIN, // pull while any Atelier tab is visible (the leader polls; a visible follower keeps it polling)
  visibleThrottleMs: 15_000, drawerThrottleMs: 5_000, // a pull on becoming visible / opening the Threads drawer
  pushDebounceMs: 3_000, pushMaxWaitMs: 20_000, // push after the last write, but never later than this
  backoffMinMs: 2_000, backoffMaxMs: 5 * MIN, // network errors and 5xx (and one failing thread, on its own)
  lockoutMs: 15 * MIN, // 429: passcodeGuard locked this network out
  unconfiguredRetryMs: HOUR, // 503 sync_unconfigured / sync_disabled: retried at most hourly (or on Sync now)
  requestTimeoutMs: 30_000, blobBytesPerSec: 50_000, // a request that stalls is abandoned (blobs get time for their size)
  keepaliveMaxBytes: 60 * 1024, // on hidden: one small delta may go with fetch keepalive (UTF-8 bytes, under the 64 KiB cap)
  scanEveryMs: DAY, scanDelayMs: 45_000, // idle re-check of every local thread (catches writers without hooks), daily in full and
  // once a session quickly (threads written since they last synced), this long after a good cycle
  statusEveryMs: 10 * MIN, // GET /api/sync/status for the counts line
  blobRefusedMs: DAY, // a blob the server refused (400/411/413/415) isn't offered again for this long
  capRetryMs: HOUR, // the server's thread cap (413 too_many_threads): new threads wait this long before trying again
  uploadsInFlight: 2, replanTries: 3, pushPasses: 3, memoChars: 32 * 1024 * 1024, // the in-session media hash memo
});
export const SYNC_BASE = '/api/sync/';
const RUN_LOCK = 'atelier-run:', LEADER_LOCK = 'atelier-sync-leader';

// ── copy (ui_spec; the app's curly apostrophe) ──
export const COPY = Object.freeze({
  firstEnable: 'Syncing your threads across your devices — progress is in Settings → Your data.',
  firstDone: 'Your threads are synced across your devices.',
  bringing: 'Bringing in your threads from your other devices…',
  openDeleted: 'This thread was deleted on another device. Restore it from Settings → Your data → Recently deleted.',
  quarantine: 'One synced item couldn’t be opened safely and was set aside.',
  deleteConfirm: 'Delete this thread from all your devices? You can restore it for 30 days from Settings → Your data → Recently deleted.',
  deleteMedia: ' Its images and videos are only on this device and will be deleted.',
  deleteLocal: 'Delete this thread? It’s only on this device, so it can’t be restored.',
  deleteUnsynced: ' Changes made here since it last synced can’t be restored.',
  off: 'Off — new changes stay on this device. Your synced threads stay on your server.',
  passcode: 'Paused — your passcode wasn’t accepted. Re-enter it under General.',
  unconfigured: 'Sync isn’t set up on the server yet.',
  disabled: 'Sync is switched off on the server.',
  upgrade: 'Update Atelier on this device to keep syncing.',
  storage: 'Couldn’t save synced changes on this device — its storage may be full.',
  threadTrouble: 'Some threads couldn’t be downloaded — trying again shortly.',
  footnote: 'Threads you make as the owner sync privately through your Atelier server, behind your passcode. Settings, model choices and theme stay on each device. LinkedIn testers’ threads never leave their device.',
  wipeSynced: 'Clears threads, media, profile and saved sign-in on this device. Your synced threads stay on your server and download again when you sign in with your passcode.',
  wipeConfirm: 'Clear Atelier threads, media, profile and saved sign-in on this device? Your synced threads stay on your Atelier server and download again when you sign in. Connected accounts stay too. This can’t be undone on this device.',
  // …while anything is only on this device (images and videos in phase 1, threads that don't sync, unsynced changes)
  wipeSyncedLocal: 'Clears threads, media, profile and saved sign-in on this device. Export your threads first: images, videos and anything else that’s only on this device can’t be brought back. Synced threads stay on your server and download again when you sign in with your passcode.',
  wipeConfirmLocal: 'Clear Atelier threads, media, profile and saved sign-in on this device? Export your threads first: what’s only on this device can’t be brought back. Your synced threads stay on your Atelier server and download again when you sign in. Connected accounts stay too.',
  navSynced: 'Threads synced across your devices', navPaused: 'Thread sync paused', navLocal: 'Threads saved on this device',
  removeSynced: 'Remove the threads that are already on your server from this browser? They stay on your server and download again when sync resumes. Threads with images, videos or changes that are only on this device stay here.',
  forkNote: 'Edited on two devices at the same time — both versions are kept.',
  forkRecovered: 'From an interrupted retry — the saved answer is just above.',
  trashEmpty: 'Nothing deleted in the last 30 days.', trashOffline: 'Connect to see recently deleted threads.',
  trashFailed: 'Couldn’t load recently deleted threads. Try again.', unreachable: 'Couldn’t reach your server. Try again.',
  mediaHeld: 'Images and videos stay on this device until the next update',
});
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const shortDate = (ms) => new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
// 1536 → "2 KB"; 1.2e9 → "1.1 GB" (binary units, one decimal under 10).
export function sizeText(bytes) {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let n = Math.max(0, Number(bytes) || 0), u = 0;
  while (n >= 1024 && u < units.length - 1) { n /= 1024; u++; }
  return u === 0 ? plural(Math.round(n), 'byte') : `${n < 10 && Math.round(n * 10) % 10 ? n.toFixed(1) : Math.round(n)} ${units[u]}`;
}
export function agoText(at, now = Date.now()) {
  const s = Math.max(0, now - at);
  if (s < MIN) return 'just now';
  if (s < HOUR) return `${Math.floor(s / MIN)} min ago`;
  if (s < DAY) return `${Math.floor(s / HOUR)} h ago`;
  return `on ${shortDate(at)}`;
}
// The Settings status line (one message at a time), from engine.status().
export function statusLine(s, now = Date.now()) {
  if (!s || !s.on) return s?.owner ? COPY.off : '';
  const p = s.paused;
  if (p) {
    if (p.reason === 'passcode') return COPY.passcode;
    if (p.reason === 'lockout') return `Paused — too many wrong passcodes from this network. Trying again at ${clock(p.until || now)}.`;
    if (p.reason === 'unconfigured') return COPY.unconfigured;
    if (p.reason === 'disabled') return COPY.disabled;
    if (p.reason === 'upgrade') return COPY.upgrade;
  }
  const waiting = s.waiting || 0, changes = plural(waiting, 'change');
  if (s.state === 'offline') return waiting ? `Offline · ${changes} waiting to sync` : 'Offline — will sync when you’re back online';
  const pr = s.progress;
  if (s.state === 'syncing') {
    if (pr?.verb === 'download' && pr.total > 1) return `Downloading ${Math.min(pr.done + 1, pr.total)} of ${pr.total} items`;
    if (pr?.verb === 'upload' && pr.total > 1) return `Uploading ${Math.min(pr.done + 1, pr.total)} of ${pr.total} items${pr.left ? ` · ${sizeText(pr.left)} left` : ''}`;
    return pr?.total > 1 ? `Syncing… ${Math.min(pr.done + 1, pr.total)} of ${pr.total} threads` : 'Syncing…';
  }
  if (s.quotaFull) return `Server storage limit reached (${sizeText(s.server?.quota || 0)}). New media stays on this device.`;
  if (s.state === 'error') {
    if (s.errorKind === 'storage') return COPY.storage;
    if (s.errorKind === 'thread') return COPY.threadTrouble;
    return waiting ? `Couldn’t reach your server · ${changes} waiting to sync` : 'Couldn’t reach your server — trying again shortly.';
  }
  if (waiting) return `${changes} waiting to sync`;
  if (s.lastOkAt) return `Up to date · synced ${agoText(s.lastOkAt, now)}`;
  return 'Getting ready to sync…';
}
// The counts line: only the parts that apply, joined with " · ".
export function countsLine(s) {
  if (!s || !s.on) return '';
  const parts = [];
  const stay = (n) => (n === 1 ? 'stays' : 'stay');
  if (s.synced) parts.push(`${plural(s.synced, 'thread')} synced`);
  if (s.server?.bytes) parts.push(`${sizeText(s.server.bytes)} on your server`);
  if (s.waiting) parts.push(`${s.waiting} waiting to sync`);
  if (s.tooLarge) parts.push(`${plural(s.tooLarge, 'thread')} too large to sync ${stay(s.tooLarge)} on this device`);
  if (s.refused) parts.push(`${plural(s.refused, 'thread')} couldn’t be synced and ${stay(s.refused)} on this device`);
  if (s.blobRefused) parts.push(`${plural(s.blobRefused, 'item')} couldn’t be uploaded and ${stay(s.blobRefused)} on this device`);
  if (s.threadCap) parts.push('Your server holds the most threads it can sync, so new threads stay on this device');
  if (s.quarantined) parts.push(`${plural(s.quarantined, 'item')} couldn’t be applied and ${s.quarantined === 1 ? 'was' : 'were'} set aside`);
  if (s.heldMedia && !(s.media?.image && s.media?.video)) parts.push(COPY.mediaHeld);
  return parts.join(' · ');
}
// Something may exist only on this device (Settings' Danger zone hint keeps "Export your threads first" then).
export const deviceOnly = (s) => Boolean(s?.on && (s.waiting || s.heldMedia || s.tooLarge || s.refused || s.blobRefused || s.localOnly || s.mode === 'new'));
// The note above a forked entry (renderEntry), or ''.
export const forkNote = (e) => (e?.forkOf ? (e.recovered ? COPY.forkRecovered : COPY.forkNote) : '');
// Clear this device's first question, from engine.localReport(): '' when everything here is on the server too.
export function wipeText(r) {
  if (!r) return '';
  const { changes = 0, media = 0, other = 0, threads = 0 } = r;
  if (!media && !other && !threads) {
    if (!changes) return '';
    return `${changes === 1 ? '1 change on this device hasn’t' : `${changes} changes on this device haven’t`} reached your other devices yet. Clear anyway? Those changes will be lost.`;
  }
  const parts = [];
  if (changes) parts.push(`${plural(changes, 'change')} not synced yet`);
  if (media) parts.push(`${plural(media, 'entry', 'entries')} with images or videos`);
  if (other) parts.push(`${plural(other, 'entry', 'entries')} that haven’t synced`);
  if (threads) parts.push(`${plural(threads, 'thread')} kept only on this device`);
  return `These are only on this device: ${parts.join(', ')}. Clearing this device deletes them for good, so export your threads first. Clear anyway?`;
}

// ── stores: Map-backed (tests) and IndexedDB "atelier-sync"/'kv' (browser) ──
// API: get(k), set(k, v), del(k), delIf(k, v) (delete only if the value is still v, in one transaction), update(k, fn)
// (fn(current) → the value to store, or undefined to leave it; one transaction), entries(prefix) → [[k, v]] sorted,
// close(), destroy().
export function memoryStore() {
  const map = new Map();
  const copy = (v) => (v === undefined ? undefined : structuredClone(v));
  return {
    map,
    async get(k) { return copy(map.get(k)); },
    async set(k, v) { map.set(k, copy(v)); },
    async del(k) { map.delete(k); },
    async delIf(k, v) { if (map.has(k) && map.get(k) === v) { map.delete(k); return true; } return false; },
    async update(k, fn) { const next = fn(copy(map.get(k))); if (next !== undefined) map.set(k, copy(next)); return copy(next); },
    async entries(prefix) { return [...map].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, copy(v)]); },
    close() {},
    async destroy() { map.clear(); },
  };
}
export function idbStore(name = 'atelier-sync', idb = globalThis.indexedDB) {
  let opening = null, gone = false;
  const open = () => {
    // Deleted by Clear this device in another tab: never re-created from here (this page reloads before it syncs again).
    if (gone) return Promise.reject(new Error('Sync storage was cleared in another tab.'));
    return (opening ??= new Promise((res, rej) => {
      const r = idb.open(name, 1); // version 1 forever: future keys never need an upgrade an old tab could block
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('kv')) r.result.createObjectStore('kv'); };
      r.onsuccess = () => { const db = r.result; db.onversionchange = (ev) => { db.close(); opening = null; if (ev?.newVersion == null) gone = true; }; res(db); };
      r.onerror = () => { opening = null; rej(r.error); };
    }));
  };
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('kv', mode);
      const out = fn(t.objectStore('kv'));
      t.oncomplete = () => res(typeof out === 'function' ? out() : out && typeof out === 'object' && 'readyState' in out ? out.result : out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error('Sync storage was interrupted'));
    });
  };
  const range = (prefix) => IDBKeyRange.bound(prefix, `${prefix}￿`);
  return {
    get: (k) => tx('readonly', (s) => s.get(k)),
    set: (k, v) => tx('readwrite', (s) => { s.put(v, k); }),
    del: (k) => tx('readwrite', (s) => { s.delete(k); }),
    delIf: (k, v) => tx('readwrite', (s) => {
      let hit = false;
      const q = s.get(k);
      q.onsuccess = () => { if (q.result === v) { hit = true; s.delete(k); } };
      return () => hit;
    }),
    update: (k, fn) => tx('readwrite', (s) => {
      let next;
      const q = s.get(k);
      q.onsuccess = () => { next = fn(q.result); if (next !== undefined) s.put(next, k); };
      return () => next;
    }),
    entries: (prefix) => tx('readonly', (s) => { const ks = s.getAllKeys(range(prefix)), vs = s.getAll(range(prefix)); return () => ks.result.map((k, i) => [k, vs.result[i]]); }),
    close() { const o = opening; opening = null; o?.then((db) => db.close(), () => {}); },
    destroy() {
      this.close();
      return new Promise((res, rej) => {
        const r = idb.deleteDatabase(name);
        r.onsuccess = () => res();
        r.onerror = () => rej(r.error);
        r.onblocked = () => rej(new Error('Close other Atelier tabs and try clearing this device again.'));
      });
    },
  };
}

// ── small helpers ──
class Halt extends Error {} // paused (401 / 429 / server-side off / upgrade), stopped or cleared: the cycle stops
// network / 5xx / busy: back off. net: the network itself (a timeout, a dropped connection) — not one thread's problem.
class Retry extends Error { constructor(msg, after = 0, net = false) { super(msg); this.after = after; this.net = net; } }
const unptr = (s) => s.replace(/~1/g, '/').replace(/~0/g, '~');
function valueAt(v, path) {
  for (const part of path.split('/').slice(1)) {
    if (v == null || typeof v !== 'object') return undefined;
    const k = unptr(part);
    if (!Object.prototype.hasOwnProperty.call(v, k)) return undefined;
    v = v[k];
  }
  return v;
}
const KEEP_LOCAL = new Set(TRANSIENT.filter((k) => k !== 'recovered'));
const createdAtOf = (t) => (validDate(t?.createdAt) ? t.createdAt : Math.min(...(t?.entries || []).map((e) => (validDate(e?.createdAt) ? e.createdAt : Infinity))));
const validRow = (r) => Array.isArray(r) && syncId(r[0]) && Number.isSafeInteger(r[2]) && r[2] >= 0;
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const stampOf = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0); // tooLarge / refused: the stamp at refusal
// What only a LinkedIn tester session writes into an entry: a usage-limit card, a reply cut at the tester length cap.
const testerMarked = (t) => Array.isArray(t?.entries) && t.entries.some((e) => e && typeof e === 'object' && (e.budget != null || e.cut === 'cap'));
// The in-place refresh of an open thread from what was just written to IndexedDB (a follower tab, or a thread opened
// while the leader merged it): listed entries are replaced (keys absent there deleted, except transient ones) or
// inserted after their nearest earlier neighbour; removed ones go. Pending (generating) entries are never touched.
// prints (the merging tab's quickPrint of each entry before the merge): an entry that no longer matches was changed
// here meanwhile and is left alone (reported in skipped: its record goes back, so that change meets the server's as an
// edit). quickPrint covers every character, so a same-length edit of a long answer is noticed too.
// keep(entry): a target entry never touched (default: a pending one — generating in this tab). exact: the source is a
// whole IndexedDB copy (another tab's save), so its transient keys are taken as they are instead of this copy's kept.
// sorted: a new entry goes before the first one that sorts after it in the order every device and the server agree on
// (entryOrder: createdAt, fork, id) — as a pull places it (sync-merge buildSlots) — instead of after its neighbour. A
// copy holding an entry the source lacks (a run that outlived a delete and a re-import, an unsaved turn) then still
// ends in that order, so it never drifts from what the other devices show.
export function patchInPlace(target, source, ids = [], removed = [], { title = false, prints = null, keep = (e) => e.pending, exact = false, sorted = false } = {}) {
  const info = { replaced: [], added: [], removed: [], skipped: [], closed: false };
  const src = new Map((source?.entries || []).map((e) => [e.id, e]));
  const changedHere = (cur, next) => prints && Object.prototype.hasOwnProperty.call(prints, cur.id) && quickPrint(cur) !== prints[cur.id] && (!next || quickPrint(cur) !== quickPrint(next));
  for (const id of removed) {
    const i = target.entries.findIndex((e) => e.id === id);
    if (i < 0 || keep(target.entries[i])) continue;
    if (changedHere(target.entries[i], null)) { info.skipped.push(id); continue; }
    target.entries.splice(i, 1); info.removed.push(id);
  }
  const order = (source?.entries || []).map((e) => e.id);
  for (const id of ids) {
    const next = src.get(id);
    if (!next) continue;
    const cur = target.entries.find((e) => e.id === id);
    if (cur) {
      if (keep(cur)) continue;
      if (changedHere(cur, next)) { info.skipped.push(id); continue; }
      for (const k of Object.keys(cur)) if (!Object.prototype.hasOwnProperty.call(next, k) && (exact || !KEEP_LOCAL.has(k))) delete cur[k];
      Object.assign(cur, next);
      info.replaced.push(id);
      continue;
    }
    let at = 0;
    if (sorted && validDate(next.createdAt)) { // an entry without a usable createdAt never syncs: it keeps its place
      at = target.entries.findIndex((e) => e && validDate(e.createdAt) && entryOrder(e, next) > 0);
      if (at < 0) at = target.entries.length;
    } else for (let i = order.indexOf(id) - 1; i >= 0; i--) { const j = target.entries.findIndex((e) => e.id === order[i]); if (j >= 0) { at = j + 1; break; } }
    target.entries.splice(at, 0, next);
    info.added.push(id);
  }
  if (title && typeof source?.title === 'string') target.title = source.title;
  if (Number.isFinite(source?.updatedAt)) target.updatedAt = Math.max(target.updatedAt || 0, source.updatedAt);
  return info;
}

// ── the engine ──
// deps: { db: {get, put, del, keys, update}  (the RAW thread store: sync writes never mark threads dirty),
//   store (memoryStore() / idbStore()), apiHeaders, isOwner, isTester, hasTesterTraces, getOpen (this tab's open thread
//   object: refreshed in place, never planned from), isLive (generating in this tab),
//   onApplied | onThreads ({threadIds, open: {replaced, added, removed, skipped, closed} | null}), onStatus(status), onAsk(n),
//   onCleared() (another tab cleared this device: this tab's sync stopped for good), fetch, locks (navigator.locks-like,
//   or null: this tab leads), channel (BroadcastChannel-like, or null), now, uid, timers {setTimeout, clearTimeout},
//   online(), visible(), toast(msg), dropThumbs(entryIds), persistStorage(), idle(fn), media (MEDIA_SYNC),
//   validate (validateBackup), base ('/api/sync/'), random, debug }
export function createSync(deps = {}) {
  const db = deps.db;
  const store = deps.store || memoryStore();
  const noop = () => {};
  const apiHeaders = deps.apiHeaders || (() => ({}));
  const isOwner = deps.isOwner || (() => true);
  const isTester = deps.isTester || (() => false);
  const getOpen = deps.getOpen || (() => null);
  const isLive = deps.isLive || (() => false);
  const onApplied = deps.onApplied || deps.onThreads || noop;
  const onStatus = deps.onStatus || noop;
  const onCleared = deps.onCleared || noop;
  const fetchImpl = deps.fetch || ((...a) => globalThis.fetch(...a));
  const locks = deps.locks || null, channel = deps.channel || null;
  const now = deps.now || (() => Date.now());
  const random = deps.random || Math.random;
  const uid = deps.uid || (() => now().toString(36) + random().toString(36).slice(2, 7));
  const timers = deps.timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t) };
  const online = deps.online || (() => true), visible = deps.visible || (() => true);
  const toast = deps.toast || noop, dropThumbs = deps.dropThumbs || noop;
  const media = deps.media || MEDIA_SYNC, validate = deps.validate || validateBackup, base = deps.base || SYNC_BASE;
  const idle = deps.idle || ((fn) => timers.setTimeout(fn, 0));
  const warn = (err) => console.warn('[atelier] sync:', err?.message || err);
  const debug = typeof deps.debug === 'function' ? deps.debug : null; // diagnostics: (event, details)
  const safe = (fn) => { try { fn(); } catch (err) { warn(err); } };

  let cfg = null, loaded = null, leader = false, stopped = true, releaseLeader = null, leaderAbort = null;
  let proven = false; // the owner proved the passcode in this tab (verified / enable): it may start when settings say on
  let forgotten = false; // Clear this device ran (here or in another tab): this engine never writes again
  const recs = new Map(), dirty = new Map(), localOnly = new Set(), hidden = new Set(), deleting = new Map(), inbound = new Map(), qKeys = new Set();
  const held = new Map(), deferred = new Set(), pullAfter = new Set(), heldMedia = new Map();
  const mediaMemo = new Map(); // `${thread}\u0001${entry}\u0001${path}` → {s, h}: media hashed this session (exact string)
  const pullFails = new Map(); // threadId → {n, until, local}: that thread's pulls wait their own backoff
  const blobRefused = new Map(); // sha256 → {code, at} ('bf:'): not offered again until blobRefusedMs passed
  const blobBlocked = new Map(); // threadId → entries held back because a blob of theirs was refused (counts line)
  const quotaHeld = new Set(), capped = new Set(); // threads waiting for server room / under the server's thread cap
  const ctrls = new Set(); // every request in flight (stop() and forget() abort them all)
  const touched = new Set(); // threads whose record or outbox changed: followers re-read them (badges, counts)
  let memoChars = 0, traced = false, testerMarks = null, phase = 'idle', progress = null, lastError = null, retryAt = 0, backoff = 0;
  let quotaFull = false, quotaNeed = 0, capUntil = 0, peerSeen = 0, reconciled = false;
  let server = null, serverAt = 0, lastRows = null, indexEtag = null, listWrites = 0, cycling = null, pendingOpts = null, chain = Promise.resolve();
  let toldBringing = false, toldFirst = false, toldQuarantine = false, leaderView = null, statusQueued = false, lastStamp = 0;
  const T = { poll: null, push: null, retry: null, scan: null, pushFirst: 0, lastFull: 0 };
  const HARD = new Set(['passcode', 'lockout', 'upgrade']); // pauses during which nothing at all is sent
  const QUIET = new Set(['lastOkAt', 'scanAt']); // bookkeeping fields: other tabs aren't told
  const PEER_KICKS = new Set(['poll', 'visible', 'now', 'drawer']); // a follower someone is looking at

  // ── state ──
  const newCfg = () => {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return { v: 1, deviceId: hex(bytes), enabled: false, asked: false, mode: 'all', enabledAt: 0, firstDone: false, paused: null, lastOkAt: 0, scanAt: 0, videosOnCellular: false };
  };
  async function load() {
    const [c, trace, ts, ds, los, hs, dels, ins, qs, bfs] = await Promise.all([store.get('cfg'), store.get('trace'), ...['t:', 'd:', 'lo:', 'hide:', 'del:', 'in:', 'q:', 'bf:'].map((p) => store.entries(p))]);
    cfg = c && c.v === 1 ? c : null;
    traced = Boolean(trace);
    recs.clear(); for (const [k, v] of ts) recs.set(k.slice(2), v);
    dirty.clear(); for (const [k, v] of ds) dirty.set(k.slice(2), v);
    localOnly.clear(); for (const [k] of los) localOnly.add(k.slice(3));
    hidden.clear(); for (const [k] of hs) hidden.add(k.slice(5));
    deleting.clear(); for (const [k, v] of dels) deleting.set(k.slice(4), v);
    inbound.clear(); for (const [k, v] of ins) inbound.set(k.slice(3), v);
    qKeys.clear(); for (const [k] of qs) qKeys.add(k.slice(2));
    blobRefused.clear(); for (const [k, v] of bfs) if (v && Number.isFinite(v.at)) blobRefused.set(k.slice(3), v);
    if (isTester() && !traced) { traced = true; store.set('trace', 1).catch(warn); }
  }
  const ready = () => (loaded ??= load().catch((err) => { loaded = null; throw err; }));
  // The shared settings as the store holds them now (another tab may have changed them).
  async function refreshCfg() {
    if (forgotten) return cfg;
    const c = await store.get('cfg').catch(() => undefined);
    if (c && c.v === 1) cfg = c;
    return cfg;
  }
  // Read-modify-write of only the fields given, in one store transaction: a tab's older copy never overwrites what
  // another tab changed. Every other tab is told (except for bookkeeping), and re-reads them.
  async function saveCfg(patch) {
    if (forgotten) return cfg;
    let next = null;
    try { await store.update('cfg', (cur) => (next = { ...(cur && cur.v === 1 ? cur : cfg || newCfg()), ...patch })); } catch (err) { warn(err); next = { ...(cfg || newCfg()), ...patch }; }
    cfg = next;
    if (Object.keys(patch).some((k) => !QUIET.has(k))) post({ cfg: true });
    return cfg;
  }
  // After the shared settings changed (here or in another tab): a tab whose settings say off stops and lets go of the
  // leader lock; a tab where the owner proved the passcode starts when they say on; the leader re-arms a timed pause.
  function applyCfg() {
    if (forgotten) return;
    if (!enabled()) { if (!stopped) stop(); }
    else if (stopped && proven) start();
    const p = pausedNow();
    if (leader && p?.until) armRetry(p.until - now());
    emitSoon();
  }
  async function setRec(id, rec) { recs.set(id, rec); touched.add(id); if (debug) safe(() => debug('record', { id, rec })); await store.set(`t:${id}`, rec); }
  async function delRec(id) { recs.delete(id); touched.add(id); await store.del(`t:${id}`); }
  async function setAt(id, at) { const r = recs.get(id); if (r && Number.isFinite(at) && r.at !== at) await setRec(id, { ...r, at }); }
  // The outbox stamp ('d:' value): an exact integer, ms × 1000 plus a random 0-999 (tabs writing in the same ms rarely
  // collide), strictly increasing in this tab — clearDirty deletes the marker only if it is still the stamp it read.
  const stamp = () => { lastStamp = Math.max(Math.floor(now()) * 1000 + Math.floor(random() * 1000), lastStamp + 1); return lastStamp; };
  async function markDirty(id) { const s = stamp(); dirty.set(id, s); touched.add(id); await store.set(`d:${id}`, s).catch(warn); }
  async function clearDirty(id, s) {
    touched.add(id);
    if (s == null) return;
    if (await store.delIf(`d:${id}`, s).catch(() => false)) { if (dirty.get(id) === s) dirty.delete(id); }
    else { const cur = await store.get(`d:${id}`).catch(() => undefined); if (cur === undefined) dirty.delete(id); else dirty.set(id, cur); }
  }
  const post = (msg) => { if (forgotten && !msg.forget) return; try { channel?.postMessage(msg); } catch {} };
  const enabled = () => Boolean(cfg?.enabled) && isOwner();
  const active = () => !stopped && !forgotten && leader && enabled();
  // The thread as IndexedDB holds it: what every plan reads and every merge writes. (An open copy's unsaved change is
  // saved by the app soon after, which marks the thread again.)
  async function localThread(id) { return (await db.get(id)) ?? null; }
  // Here at all: in IndexedDB, or open in this tab (a new thread before its first save).
  const hasLocal = async (id) => Boolean(await localThread(id).catch(() => null)) || getOpen()?.id === id;
  const inboundOf = (id) => [...inbound.keys()].filter((k) => k.startsWith(`${id}/`)).length;

  // ── this tab's open thread, kept in step with IndexedDB ──
  // seen: per thread object, each entry's snapshot (snapOf) and the title as this tab last knew them to match
  // IndexedDB — taken when this tab loaded the thread (wrapDb.get) or saved it (wrapDb.put), and after every refresh.
  // refreshOpen is a three-way merge against it: what only IndexedDB changed (another tab's save, this engine's merge)
  // is taken in; what only this copy changed (not saved yet) stays.
  const seenOf = new WeakMap();
  const ownRuns = new Set(); // entries generating in this tab (holdRunLock)
  let openChain = Promise.resolve(), openWork = 0, msgWork = 0;
  function snapThread(t) {
    const snaps = new Map();
    for (const e of t.entries) if (e && typeof e === 'object' && syncId(e.id)) snaps.set(e.id, snapOf(e));
    return { snaps, title: t.title };
  }
  // wrapDb: a thread object read from IndexedDB (noteRead: what IndexedDB holds), or about to be written there by this
  // tab's app (noteSaving: what it will hold once that write commits — until then the snapshot is marked saving and
  // counts as unknown, so a save queued before it never takes it for written; confirmed by saved()). A write that
  // failed (storage full, connection lost): noteSaveFailed — what IndexedDB holds is unknown again.
  function noteRead(t) { if (t && typeof t === 'object' && Array.isArray(t.entries)) seenOf.set(t, snapThread(t)); }
  function noteSaving(t) {
    if (!t || typeof t !== 'object' || !Array.isArray(t.entries)) return null;
    const snap = { ...snapThread(t), saving: true };
    seenOf.set(t, snap);
    return snap;
  }
  const saved = (t, snap) => { if (snap && seenOf.get(t) === snap) snap.saving = false; };
  const noteSaveFailed = (t) => { if (t && typeof t === 'object') seenOf.delete(t); };
  // What this tab last knew IndexedDB to hold for this object, or null (unknown, or a write of it not committed yet).
  const seenBase = (t) => { const x = seenOf.get(t); return x && !x.saving ? x : null; };
  // The app saves a thread object (wrapDb.put). One this tab knows (seen) is saved in one readwrite transaction that
  // first takes in what another tab saved since (mergeOpen's rules: only what this copy hasn't changed), so a save never
  // writes an older copy over another tab's work — even one whose notice hasn't arrived yet. Anything else: a plain put.
  // Either way a write that fails (storage full, connection lost) forgets the snapshot: IndexedDB may not hold this
  // copy, so the next save must not treat anything in it as "unchanged since saved" (it would drop or revert it).
  // → the put's promise (the app's object holds what was written; an open thread that took something in is redrawn).
  function saveThread(t) {
    const base = t && typeof t === 'object' ? seenOf.get(t) : null;
    if (!base || !syncId(t.id) || !Array.isArray(t.entries) || typeof db.update !== 'function') {
      const snap = noteSaving(t);
      let put; // started now, like the update below: saves keep the order the app made them in
      try { put = Promise.resolve(db.put(t)); } catch (err) { put = Promise.reject(err); }
      return put.then((r) => { saved(t, snap); return r; }, (err) => { noteSaveFailed(t); throw err; });
    }
    let info = null, snap = null;
    return Promise.resolve(db.update(t.id, (cur) => {
      if (cur && typeof cur === 'object' && Array.isArray(cur.entries)) info = mergeOpen(t, cur, null);
      snap = noteSaving(t); // what this save writes
      return t;
    })).then((r) => {
      saved(t, snap);
      if (info?.changed && getOpen() === t) safe(() => onApplied({ threadIds: [t.id], open: info }));
      return r;
    }, (err) => { noteSaveFailed(t); throw err; });
  }
  // Never touched by a refresh: an entry generating in this tab (its run saves it). Only this tab's own runs count (the
  // app takes holdRunLock before an entry's first save): an entry another tab is generating in the same thread is taken
  // in like any other, so its finished answer arrives here and this tab's saves never write it back as pending.
  const generatingHere = () => (e) => ownRuns.has(e.id);
  // This tab's open copy of a thread, refreshed in place from IndexedDB. Per entry:
  //   only IndexedDB changed → taken (a run in another tab included: it shows as generating here); only this copy
  //   changed → stays (the app saves it next); both → stays, except a copy this tab merely marked interrupted
  //   (recoverThread) while IndexedDB holds a version that isn't pending (another tab's run finished it); with nothing
  //   known about it (no seen) → stays.
  //   In IndexedDB only: added elsewhere → inserted where the agreed entry order puts it (patchInPlace sorted), so a
  //   copy holding an entry IndexedDB lacks still matches every device's order (one this copy removed and hasn't saved
  //   yet stays removed).
  //   In this copy only: removed elsewhere → removed, unless changed here.
  // merge: {ids, removed, prints, title} a sync merge just wrote. One of those this copy changed meanwhile is left alone
  // and reported in skipped (its record goes back, so that change meets the server's as an edit); for a copy with no
  // seen, its print from before the merge decides (prints). → patchInPlace's info plus changed, or null (not open here).
  function refreshOpen(id, merge = null) {
    openWork++;
    const p = openChain.then(() => refreshNow(id, merge)).finally(() => { openWork--; });
    openChain = p.catch(() => {});
    return p;
  }
  async function refreshNow(id, merge) {
    for (let i = 0; i < 3; i++) {
      const o = getOpen();
      if (!o || o.id !== id || !Array.isArray(o.entries) || forgotten) return null;
      const seen0 = seenOf.get(o);
      const s = await db.get(id).catch(() => null);
      if (getOpen() !== o || !s || !Array.isArray(s.entries) || forgotten) return null;
      if (seenOf.get(o) !== seen0) continue; // this tab saved it while that was read: what was read may be older
      return mergeOpen(o, s, merge);
    }
    return null;
  }
  function mergeOpen(o, s, merge) {
    const own = (x, k) => Boolean(x) && Object.prototype.hasOwnProperty.call(x, k);
    const base = seenBase(o), B = base?.snaps || null;
    const keep = generatingHere(o.id);
    const S = new Map(), O = new Map();
    for (const e of s.entries) if (e && typeof e === 'object' && syncId(e.id)) S.set(e.id, e);
    for (const e of o.entries) if (e && typeof e === 'object' && syncId(e.id)) O.set(e.id, e);
    const mIds = new Set(merge?.ids || []), mRemoved = new Set(merge?.removed || []);
    const prints = merge?.prints && typeof merge.prints === 'object' ? merge.prints : null;
    const take = [], drop = [], skipped = [], agree = new Map();
    // Changed in this copy since it last matched IndexedDB? true / false / null (unknown).
    const changedHere = (eid, oe) => (B?.has(eid) ? !sameSnap(oe, B.get(eid)) : own(prints, eid) ? quickPrint(oe) !== prints[eid] : null);
    for (const [eid, oe] of O) {
      if (keep(oe)) continue;
      const se = S.get(eid);
      if (!se) {
        if (mRemoved.has(eid)) { if (changedHere(eid, oe) === true) skipped.push(eid); else drop.push(eid); } else if (B?.has(eid) && changedHere(eid, oe) === false) drop.push(eid);
        continue;
      }
      const so = snapOf(oe);
      if (sameSnap(se, so)) { agree.set(eid, so); continue; }
      const ch = changedHere(eid, oe);
      if (mIds.has(eid)) { if (ch === true) skipped.push(eid); else take.push(eid); continue; }
      if (ch === false || (oe.recovered === true && se.pending !== true)) take.push(eid);
    }
    for (const eid of S.keys()) if (!O.has(eid) && (mIds.has(eid) || !B?.has(eid))) take.push(eid);
    let title = false;
    if (typeof s.title === 'string' && o.title !== s.title) title = merge?.title ? !base || o.title === base.title : Boolean(base) && o.title === base.title;
    const info = take.length || drop.length || title ? patchInPlace(o, s, take, drop, { title, keep, exact: true, sorted: true }) : { replaced: [], added: [], removed: [], skipped: [], closed: false };
    info.skipped.push(...skipped);
    info.changed = Boolean(info.replaced.length || info.added.length || info.removed.length || title);
    // What this copy now has in common with IndexedDB; an entry kept as it is here keeps what it last matched.
    const snaps = new Map(), got = new Set([...info.replaced, ...info.added]);
    for (const e of o.entries) {
      if (!e || typeof e !== 'object' || !syncId(e.id)) continue;
      if (agree.has(e.id)) snaps.set(e.id, agree.get(e.id));
      else if (got.has(e.id)) snaps.set(e.id, snapOf(e));
      else if (B?.has(e.id)) snaps.set(e.id, B.get(e.id));
    }
    seenOf.set(o, { snaps, title: o.title === s.title ? s.title : base?.title });
    return info;
  }
  // Another tab (or this tab, from a copy other than the open one) saved these threads: the open one is refreshed.
  async function openWritten(ids) {
    const o = getOpen();
    if (!o || !ids.includes(o.id)) return;
    const info = await refreshOpen(o.id);
    if (info?.changed) safe(() => onApplied({ threadIds: [o.id], open: info }));
  }

  // ── status ──
  function counts() {
    let waiting = 0, synced = 0, big = 0, refused = 0, withMedia = 0, blobs = 0;
    for (const id of dirty.keys()) { const r = recs.get(id); if (!localOnly.has(id) && !hidden.has(id) && !deleting.has(id) && !r?.tooLarge && !r?.refused) waiting++; }
    waiting += deleting.size;
    for (const [id, r] of recs) {
      if (r.rev > 0 && !r.deleted) synced++;
      if (r.tooLarge) big++;
      if (r.refused) refused++;
      if (r.held || heldMedia.get(id)) withMedia++;
    }
    for (const [id, n] of heldMedia) if (n && !recs.has(id)) withMedia++;
    for (const n of blobBlocked.values()) blobs += n;
    return { waiting, synced, tooLarge: big, refused, quarantined: qKeys.size, heldMedia: withMedia, blobRefused: blobs, threadCap: capUntil > now(), localOnly: localOnly.size };
  }
  // A follower shows what the leader (the tab doing the work) reports: its counts, its pause and its state.
  function status() {
    const lv = !leader && leaderView ? leaderView : null;
    const c = lv?.counts || counts();
    const p = lv && 'paused' in lv ? lv.paused || null : pausedNow();
    const st = !cfg?.enabled ? 'off' : p ? 'paused' : !online() ? 'offline' : (lv?.state || (phase === 'syncing' ? 'syncing' : lastError ? 'error' : 'idle'));
    return {
      owner: isOwner(), tester: isTester(), on: Boolean(cfg?.enabled), asked: Boolean(cfg?.asked), mode: cfg?.mode || 'all', state: st, paused: p,
      errorKind: st === 'error' ? (lv ? lv.errorKind || null : lastError) : null,
      progress: lv ? lv.progress : progress, lastOkAt: Math.max(cfg?.lastOkAt || 0, lv?.lastOkAt || 0), retryAt,
      ...c, server: lv?.server || server, quotaFull: lv ? Boolean(lv.quotaFull) : quotaFull,
      leader, firstDone: Boolean(cfg?.firstDone), media: { image: Boolean(media.image), video: Boolean(media.video) },
    };
  }
  function emit() {
    const s = status();
    safe(() => onStatus(s));
    if (!leader) { touched.clear(); return; }
    const { waiting, synced, tooLarge, refused, quarantined, heldMedia: hm, blobRefused: br, threadCap, localOnly: lo } = s;
    post({ status: { state: s.state === 'paused' || s.state === 'off' ? null : s.state, paused: s.paused, errorKind: s.errorKind, progress: s.progress, lastOkAt: s.lastOkAt, server: s.server, quotaFull: s.quotaFull, counts: { waiting, synced, tooLarge, refused, quarantined, heldMedia: hm, blobRefused: br, threadCap, localOnly: lo } } });
    if (touched.size) { post({ touch: [...touched] }); touched.clear(); }
  }
  const emitSoon = () => { if (statusQueued) return; statusQueued = true; queueMicrotask(() => { statusQueued = false; emit(); }); };

  // ── pauses and timers ──
  function pausedNow() {
    const p = cfg?.paused;
    if (!p) return null;
    if (p.until && p.until <= now() && p.reason !== 'passcode' && p.reason !== 'upgrade') return null; // expired: try again
    return p;
  }
  // The pause is shared through the store: every tab sees it. A passcode refused in a follower tab (its own copy may be
  // stale) doesn't pause the leader on its say-so: the leader checks with one request of its own and pauses everyone
  // only if that is refused too. With no leader running (this tab never started), the pause is recorded directly.
  async function pauseFor(reason, until = 0) {
    if (!cfg || forgotten) return;
    if (reason === 'passcode' && !leader && !stopped && channel) { post({ probe: true }); emit(); return; }
    await saveCfg({ paused: { reason, until: until || null } });
    if (until && leader) armRetry(until - now());
    emit();
  }
  // Someone is looking at Atelier: this tab, or a follower tab that reported in within the last few polls.
  const anyVisible = () => visible() || now() - peerSeen < SYNC_CLIENT.pollMs * 2.5;
  function armRetry(ms) {
    timers.clearTimeout(T.retry);
    T.retry = null;
    if (stopped || forgotten) return;
    T.retry = timers.setTimeout(() => { T.retry = null; if (anyVisible()) run({ pull: true }); }, Math.max(0, ms));
  }
  function armBackoff(after = 0) {
    if (!after) backoff = Math.min(SYNC_CLIENT.backoffMaxMs, backoff ? backoff * 2 : SYNC_CLIENT.backoffMinMs);
    const wait = after || Math.round(backoff * (0.8 + 0.4 * random()));
    retryAt = now() + wait;
    armRetry(wait);
  }
  // Every started tab runs this timer: the leader pulls while any tab is visible; a visible follower reports in (and
  // asks for that pull), so the tab the owner is looking at stays current even when the leader tab is in the background.
  function schedulePoll() {
    timers.clearTimeout(T.poll);
    T.poll = null;
    if (stopped || forgotten) return;
    T.poll = timers.setTimeout(() => {
      T.poll = null;
      if (online()) {
        if (leader) { if (anyVisible()) run({ pull: true }); } else if (visible()) post({ kick: 'poll' });
      }
      schedulePoll();
    }, SYNC_CLIENT.pollMs);
  }
  function schedulePush() {
    if (stopped || !leader || !cfg?.enabled) return;
    const t = now();
    if (!T.pushFirst) T.pushFirst = t;
    const wait = Math.max(0, Math.min(SYNC_CLIENT.pushDebounceMs, T.pushFirst + SYNC_CLIENT.pushMaxWaitMs - t));
    timers.clearTimeout(T.push);
    T.push = timers.setTimeout(() => { T.push = null; T.pushFirst = 0; run({ pull: false }); }, wait);
  }

  // ── leadership: one tab talks to the network and writes records ──
  function campaign() {
    if (leader || leaderAbort || stopped) return;
    if (!locks?.request) { becomeLeader(); return; }
    const ctl = new AbortController();
    leaderAbort = ctl;
    locks.request(LEADER_LOCK, { signal: ctl.signal }, () => {
      if (leaderAbort === ctl) leaderAbort = null;
      if (stopped) return undefined;
      becomeLeader();
      return new Promise((res) => { releaseLeader = res; });
    }).catch(() => { if (leaderAbort === ctl) leaderAbort = null; });
  }
  function becomeLeader() {
    leader = true; leaderView = null;
    // A follower's view of the records may be stale: reload before the first cycle (cycles queue behind it). Settings
    // that say off now (switched off in another tab) mean this tab lets the lock go again.
    serial(async () => { loaded = null; await ready().catch(warn); if (!enabled()) stop(); });
    schedulePoll();
    kick('leader');
  }
  function start() {
    if (!stopped || forgotten) return;
    stopped = false;
    campaign();
    schedulePoll();
  }
  function stop() {
    stopped = true; leader = false;
    releaseLeader?.(); releaseLeader = null;
    leaderAbort?.abort(); leaderAbort = null;
    for (const k of ['poll', 'push', 'retry', 'scan']) { timers.clearTimeout(T[k]); T[k] = null; }
    T.pushFirst = 0;
    for (const c of [...ctrls]) c.abort(); // nothing in flight outlives a stop (a stalled request included)
    ctrls.clear();
  }
  async function onMessage(ev) {
    const m = ev && typeof ev === 'object' && 'data' in ev ? ev.data : ev;
    if (!m || typeof m !== 'object' || forgotten) return;
    if (m.forget) { cleared(); return; }
    // A tester-mode tab's threads never upload: every tab learns it at once (the leader reads 'lo:' again too).
    if (Array.isArray(m.localOnly)) for (const id of m.localOnly) if (syncId(id)) localOnly.add(id);
    // Another tab saved these threads: an open copy of one here takes that in.
    if (Array.isArray(m.wrote)) openWritten(m.wrote.filter(syncId)).catch(warn);
    if (m.cfg) {
      const was = JSON.stringify(cfg ? { e: cfg.enabled, m: cfg.mode, p: cfg.paused } : null);
      await refreshCfg();
      applyCfg();
      if (leader && enabled() && was !== JSON.stringify({ e: cfg.enabled, m: cfg.mode, p: cfg.paused }) && !pausedNow()) kick('cfg');
    }
    if (leader) {
      if (Array.isArray(m.full)) {
        await serial(async () => {
          for (const id of m.full) if (syncId(id)) { const r = recs.get(id); if (r) { const { deleted, ...rest } = r; await setRec(id, { ...rest, full: true }); } pullAfter.add(id); }
        });
      }
      if (m.reload) await serial(async () => { loaded = null; await ready().catch(warn); });
      if (m.rollback && syncId(m.rollback.t) && Array.isArray(m.rollback.ids)) { const r = m.rollback; await serial(() => rollback(r.t, r.ids.filter(syncId), recent.get(r.t))); }
      if (Array.isArray(m.hide)) for (const id of m.hide) if (syncId(id)) hidden.add(id);
      if (Array.isArray(m.changed)) await leaderSaw(m.changed);
      // A fresh stamp of the leader's own: kept (and written back) even if the follower's marker never committed.
      if (Array.isArray(m.dirty)) { for (const id of m.dirty) if (syncId(id)) dirty.set(id, stamp()); schedulePush(); }
      if (m.flush) run({ pull: false, hidden: !visible() });
      if (m.probe) run({ pull: true }); // a follower's passcode was refused: one request with this tab's says whether it's everyone's
      if (typeof m.kick === 'string') { if (PEER_KICKS.has(m.kick)) peerSeen = now(); kick(m.kick); }
      else if (Array.isArray(m.full)) run({ pull: false });
      return;
    }
    if (m.status) { leaderView = m.status; emitSoon(); }
    if (Array.isArray(m.changed)) await followerChanged(m.changed);
    if (Array.isArray(m.touch)) await followerTouch(m.touch);
    if (Array.isArray(m.dirty)) for (const id of m.dirty) if (syncId(id)) dirty.set(id, dirty.get(id) ?? stamp());
  }
  // Notices from other tabs (busy() counts the ones still being handled).
  const heard = (ev) => { msgWork++; onMessage(ev).catch(warn).finally(() => { msgWork--; }); };
  if (channel) {
    if (typeof channel.addEventListener === 'function') channel.addEventListener('message', heard);
    else channel.onmessage = heard;
  }
  // A follower re-reads what the leader wrote for these threads (record, outbox marker, pending delete).
  async function refreshIds(ids) {
    for (const id of ids) {
      if (!syncId(id)) continue;
      const [rec, d, del] = await Promise.all([store.get(`t:${id}`), store.get(`d:${id}`), store.get(`del:${id}`)]).catch(() => []);
      if (rec) recs.set(id, rec); else recs.delete(id);
      if (d === undefined) dirty.delete(id); else dirty.set(id, d);
      if (del) deleting.set(id, del); else deleting.delete(id);
    }
  }
  async function followerTouch(ids) {
    const list = ids.filter(syncId);
    await refreshIds(list);
    emitSoon();
    if (list.length) safe(() => onApplied({ threadIds: list, open: null })); // badges in an open drawer
  }
  // A follower hears the leader's merge (or a delete): its open copy takes in what was written, the same three-way
  // way as any other save (refreshOpen); one it changed meanwhile goes back to the leader as a rollback. A thread
  // deleted on another device closes with the same note the leader's tab shows.
  async function followerChanged(changes) {
    for (const c of changes) {
      if (!c || !syncId(c.t)) continue;
      await refreshIds([c.t]);
      const open = getOpen();
      if (open?.id === c.t) {
        if (c.closed) {
          if (c.deleted) toast(COPY.openDeleted);
          safe(() => onApplied({ threadIds: [c.t], open: { replaced: [], added: [], removed: [], skipped: [], closed: true } }));
          continue;
        }
        const info = await refreshOpen(c.t, { ids: Array.isArray(c.e) ? c.e : [], removed: Array.isArray(c.removed) ? c.removed : [], prints: c.prints && typeof c.prints === 'object' ? c.prints : null, title: Boolean(c.title) });
        if (info?.skipped.length) post({ rollback: { t: c.t, ids: info.skipped } });
        safe(() => onApplied({ threadIds: [c.t], open: info }));
      } else safe(() => onApplied({ threadIds: [c.t], open: null }));
    }
    emitSoon();
  }
  // The leader hears a follower's local change (a delete in that tab): its outbox, delete and hide markers are read
  // back from the store, so this tab never pushes over it or rebuilds the delete from its own older view.
  async function leaderSaw(changes) {
    for (const c of changes) {
      if (!c || !syncId(c.t)) continue;
      const [d, del, hide] = await Promise.all([store.get(`d:${c.t}`), store.get(`del:${c.t}`), store.get(`hide:${c.t}`)]).catch(() => []);
      if (del) deleting.set(c.t, del);
      if (hide) hidden.add(c.t);
      if (d !== undefined) dirty.set(c.t, d); else if (c.closed) dirty.delete(c.t);
      if (c.closed && getOpen()?.id === c.t) safe(() => onApplied({ threadIds: [c.t], open: { replaced: [], added: [], removed: [], closed: true } }));
    }
    emitSoon();
  }

  // A stopped engine (switched off, or forget() for Clear this device) writes nothing more: work in flight ends at the
  // next checkpoint instead of putting threads back after the device was cleared.
  const halted = () => { if (stopped || forgotten) throw new Halt('stopped'); };

  // ── network ──
  // One request. Refused up front while a passcode/lockout/upgrade pause holds (it would only feed the lockout).
  // Abandoned when stop() runs, when signal aborts, or after timeout (the body read included) → Retry (net). Returns
  // {status, ok, headers, json (the parsed body or {}), bytes (Uint8Array, with bytes: true)}. 401 → pause + Halt;
  // 403 owner_only / tester_* (a tester cookie answered for a wrong passcode) → pause + Halt; 429 → lockout pause +
  // Halt; 503 unconfigured/disabled → hourly pause + Halt; other 5xx → Retry unless allowed.
  async function api(method, path, { json, body, type, headers = {}, keepalive = false, allow = null, bytes = false, timeout = SYNC_CLIENT.requestTimeoutMs, signal = null } = {}) {
    if (forgotten) throw new Halt('cleared');
    const p = pausedNow();
    if (p && HARD.has(p.reason)) throw new Halt(p.reason);
    const h = { ...(apiHeaders() || {}), ...headers };
    if (!h['x-app-pass']) { await pauseFor('passcode'); throw new Halt('no passcode'); }
    // A write that can change the thread list (a push, a delete, a restore — even one whose answer never arrives) makes
    // the cached index stale, though the list may later return to exactly what it was (the server losing a thread this
    // device just pushed): the next index read is a full one, so pullAll notices the loss (serverLost) instead of
    // taking a 304 for "nothing changed". Costs nothing: after such a write the list's ETag has changed anyway.
    // listWrites counts them, so an index read already in flight when one starts (a restore from Recently deleted runs
    // outside the cycle) doesn't put back the ETag of a list from before that write.
    if (method !== 'GET' && (path.startsWith('thread/') || path.startsWith('trash/'))) { indexEtag = null; listWrites++; }
    const init = { method, headers: h, cache: 'no-store' };
    if (json !== undefined) { init.body = JSON.stringify(json); h['content-type'] = 'application/json'; }
    else if (body !== undefined) { init.body = body; h['content-type'] = type; }
    else delete h['content-type'];
    if (keepalive) init.keepalive = true;
    const ctl = new AbortController();
    ctrls.add(ctl);
    const abort = () => ctl.abort();
    if (signal?.aborted) abort(); else signal?.addEventListener?.('abort', abort, { once: true });
    const gave = new Promise((_, rej) => {
      const fail = () => rej(new Retry('request abandoned', 0, true));
      if (ctl.signal.aborted) fail(); else ctl.signal.addEventListener('abort', fail, { once: true });
    });
    gave.catch(() => {});
    const timer = timers.setTimeout(abort, timeout);
    init.signal = ctl.signal;
    try {
      let r;
      try { r = await Promise.race([fetchImpl(base + path, init), gave]); } catch (err) { throw err instanceof Retry ? err : new Retry(`network: ${err?.message || err}`, 0, true); }
      if (r.status === 401) { await pauseFor('passcode'); throw new Halt('401'); }
      if (r.status === 429) { await pauseFor('lockout', now() + SYNC_CLIENT.lockoutMs); throw new Halt('429'); }
      let data = null;
      if (bytes && r.ok) {
        try { data = new Uint8Array(await Promise.race([r.arrayBuffer(), gave])); } catch (err) { throw err instanceof Retry ? err : new Retry(`download: ${err?.message || err}`, 0, true); }
      } else if (r.status !== 304 && r.status !== 204) {
        try { data = await Promise.race([r.json(), gave]); } catch (err) { if (err instanceof Retry) throw err; data = null; }
      }
      const j = data && typeof data === 'object' && !(data instanceof Uint8Array) && !Array.isArray(data) ? data : {};
      // A tester session cookie in this browser: the Worker's tester router answers a wrong passcode with 403 owner_only
      // (or a tester_* code) instead of 401. It is the same refusal: pause, never retry into the lockout.
      if (r.status === 403 && (j.code === 'owner_only' || (typeof j.code === 'string' && j.code.startsWith('tester_')))) { await pauseFor('passcode'); throw new Halt('403'); }
      if (r.status === 503 && !allow?.includes(503)) {
        if (j.code === 'sync_unconfigured' || j.code === 'sync_disabled') {
          await pauseFor(j.code === 'sync_disabled' ? 'disabled' : 'unconfigured', now() + SYNC_CLIENT.unconfiguredRetryMs);
          throw new Halt(j.code);
        }
        const after = Number(r.headers.get('retry-after'));
        throw new Retry(`503 ${j.code || ''}`, Number.isFinite(after) && after > 0 ? after * 1000 : 0);
      }
      if (r.status >= 500 && !allow?.includes(r.status)) throw new Retry(`HTTP ${r.status}`);
      return { status: r.status, ok: r.ok, headers: r.headers, json: j, bytes: data instanceof Uint8Array ? data : null };
    } finally {
      timers.clearTimeout(timer);
      ctrls.delete(ctl);
      signal?.removeEventListener?.('abort', abort);
    }
  }
  const blobTimeout = (n) => SYNC_CLIENT.requestTimeoutMs + Math.ceil(((Number(n) || 0) / SYNC_CLIENT.blobBytesPerSec) * 1000);
  async function upgradeCheck(j) {
    if (Number.isFinite(j?.v) && j.v > FORMAT) { await pauseFor('upgrade'); throw new Halt('upgrade'); }
  }
  async function lockedIds() {
    const set = new Set();
    try {
      const q = await locks?.query?.();
      for (const l of [...(q?.held || []), ...(q?.pending || [])]) if (typeof l?.name === 'string' && l.name.startsWith(RUN_LOCK)) set.add(l.name.slice(RUN_LOCK.length));
    } catch {}
    return set;
  }
  // The thread as IndexedDB holds it, with the run locks looked at before and after that read (both kept): a lock let
  // go before the read means its run already saved (the app saves, then lets go), and one taken around the read is in
  // the second look — so a copy read while a run held its entry (another tab's "interrupted" one, say) is never planned
  // as if that run were over. → {thread, locked}
  async function readLocked(id, look = pushLocks) {
    const locked = await look();
    const thread = await localThread(id);
    for (const x of await look()) locked.add(x);
    return { thread, locked };
  }
  async function pushLocks() {
    const set = await lockedIds();
    for (const id of held.keys()) set.add(id);
    return set;
  }

  // ── hash memo (media only, this session) ──
  // A media string hashed once per session. The memo answers only for that exact string (===: the same object in
  // O(1), an identical copy re-read from IndexedDB in one native compare) — never for a sample of it — and long text
  // is never memoized at all (dehydrate hashes it in full). Bounded by memoChars, least recently used first out.
  const memoKey = (tid, eid, path) => `${tid}\u0001${eid}\u0001${path}`;
  function memoGet(tid, eid, path, s) {
    const k = memoKey(tid, eid, path), x = mediaMemo.get(k);
    if (!x || x.s !== s) return undefined;
    mediaMemo.delete(k); mediaMemo.set(k, x);
    return x.h;
  }
  function memoSet(tid, eid, path, s, h) {
    const k = memoKey(tid, eid, path), x = mediaMemo.get(k);
    if (x) { memoChars -= x.s.length; mediaMemo.delete(k); }
    mediaMemo.set(k, { s, h });
    memoChars += s.length;
    for (const [k0, v0] of mediaMemo) {
      if (memoChars <= SYNC_CLIENT.memoChars || mediaMemo.size <= 1) break;
      mediaMemo.delete(k0); memoChars -= v0.s.length;
    }
  }
  const hasher = (tid) => (e) => dehydrate(e, { memo: syncId(e?.id) ? { get: (p, s) => memoGet(tid, e.id, p, s), set: (p, s, h) => memoSet(tid, e.id, p, s, h) } : null });

  // ── pulled entries: blobs, validation, quarantine ──
  async function download(ref) {
    for (let i = 0; i < 2; i++) {
      const r = await api('GET', `blob/${ref.$b}`, { bytes: true, timeout: blobTimeout(ref.n) });
      if (r.status === 404) return null;
      if (!r.ok || !r.bytes) throw new Retry(`blob ${r.status}`);
      if (r.bytes.length === ref.n && (await sha256hex(r.bytes)) === ref.$b) return r.bytes;
    }
    throw new Error('blob checksum mismatch');
  }
  // The local copy at the same place in the same entry saves a download — but only once its SHA-256 matches the ref
  // (the media memo answers for an exact string it already hashed). Anything else: GET blob/<hash>.
  async function blobFor(tid, eid, ref, path, local) {
    const v = local ? valueAt(local, path) : undefined;
    if (typeof v === 'string') {
      if (ref.t === 'text') {
        if (utf8Length(v) === ref.n && (await sha256hex(utf8(v))) === ref.$b) return v;
      } else if (v.startsWith(`data:${ref.t};`)) {
        if (memoGet(tid, eid, path, v) === ref.$b) return v;
        const payload = v.slice(v.indexOf(',') + 1);
        if (base64Length(payload) === ref.n) {
          let h = null;
          try { h = await sha256hex(fromBase64(payload)); } catch {}
          if (h === ref.$b) { memoSet(tid, eid, path, v, h); return v; }
        }
      }
    }
    return download(ref);
  }
  function validEntry(tid, entry, createdAt) {
    try {
      validate({ app: 'atelier', v: 1, threads: [{ id: tid, title: '', createdAt: validDate(createdAt) ? createdAt : 0, updatedAt: 0, entries: [entry] }] });
      return true;
    } catch { return false; }
  }
  async function quarantine(tid, view, reason) {
    const key = `${tid}/${view.id}/${view.h}`;
    if (!qKeys.has(key)) { qKeys.add(key); await store.set(`q:${key}`, { d: view.d, reason, at: now() }).catch(warn); }
    if (!toldQuarantine) { toldQuarantine = true; toast(COPY.quarantine); }
    emitSoon();
  }
  async function park(tid, view, missing) {
    const key = `${tid}/${view.id}`;
    const v = { rev: view.rev, h: view.h, missing, at: now() };
    inbound.set(key, v);
    await store.set(`in:${key}`, v).catch(warn);
  }
  async function unpark(tid, eid) {
    const key = `${tid}/${eid}`;
    if (inbound.delete(key)) await store.del(`in:${key}`).catch(warn);
  }
  // Hydrates every remote slot of a plan → Map(entryId → entry). Invalid entries are quarantined (never applied);
  // entries whose blobs are missing are parked; network trouble aborts the cycle (Retry/Halt propagate).
  async function hydrateSlots(tid, local, plan) {
    const out = new Map();
    const remote = plan.slots.filter((s) => s.from === 'remote');
    if (!remote.length) return out;
    const byId = new Map((local?.entries || []).map((e) => [e.id, e]));
    const many = remote.filter((s) => refsOf(s.r.d).size).length;
    if (many > 2) { progress = { verb: 'download', done: 0, total: many }; emitSoon(); }
    for (const s of remote) {
      halted();
      const why = checkPulledEntry(s.r);
      if (why) { await quarantine(tid, s.r, why); continue; }
      const learned = [];
      let got;
      try {
        got = await hydrate(s.r.d, (ref, path) => { learned.push([path, ref]); return blobFor(tid, s.id, ref, path, byId.get(s.id)); });
      } catch (err) {
        if (err instanceof Halt || err instanceof Retry) throw err;
        await quarantine(tid, s.r, String(err?.message || err).slice(0, 120));
        continue;
      }
      if (many > 2 && progress?.verb === 'download') { progress.done++; emitSoon(); }
      if (!got.entry) { await park(tid, s.r, got.missing); continue; }
      if (got.entry.id !== s.id || !validEntry(tid, got.entry, plan.createdAt)) { await quarantine(tid, s.r, 'invalid'); continue; }
      for (const [path, ref] of learned) { if (ref.t === 'text') continue; const v = valueAt(got.entry, path); if (typeof v === 'string') memoSet(tid, s.id, path, v, ref.$b); }
      out.set(s.id, got.entry);
      await unpark(tid, s.id);
    }
    return out;
  }

  // ── applying a plan to the local thread (never clobbering what changed meanwhile) ──
  // Written into IndexedDB in one readwrite transaction whose function re-checks the plan's snapshots (a tab that saved
  // the thread meanwhile makes the plan stale); then every open copy takes it in place (refreshOpen here, the
  // {changed} notice in other tabs), keeping an entry its tab changed meanwhile. → the applyPlan result, or null
  // (changed meanwhile: plan again).
  async function applyLocal(id, plan, hydrated) {
    halted();
    const before = recs.get(id) || null;
    // Portable prints (every character) of the entries this merge replaces or removes, as IndexedDB held them: a tab
    // with no seen for its open copy compares them with that copy before patching it.
    const src = new Map((plan.before || []).map((e) => [e.id, e]));
    const prints = {};
    for (const x of [...plan.replaced, ...plan.removed]) if (src.has(x)) prints[x] = quickPrint(src.get(x));
    let out = null, closed = false;
    await db.update(id, (cur) => {
      const r = applyPlan(cur ?? null, plan, hydrated);
      if (!r.ok) return undefined;
      out = r;
      if (plan.removeThread || (cur && r.thread.entries.length === 0)) { closed = Boolean(cur); return cur ? null : undefined; }
      if (!cur && !r.thread.entries.length) return undefined;
      return plan.changed || !cur ? r.thread : undefined;
    });
    if (!out) return null;
    if (debug) safe(() => debug(out.forks.length ? 'fork' : plan.removeThread ? 'removed' : 'apply', { id, forks: out.forks, how: plan.how, local: hydrated, plan, out, open: getOpen()?.id === id }));
    let rec = out.record;
    if (closed) {
      // Keep what this device knew of the removed entries: a stale tab putting the thread back is then recognised. Only
      // a server tombstone makes the record "deleted"; a local copy merely emptied (the server's thread lives on) is read
      // whole again next time instead of being taken for deleted.
      const prev = recs.get(id)?.e || {};
      rec = { ...rec, e: { ...prev, ...rec.e }, ...(plan.removeThread ? { deleted: rec.deleted || { at: plan.changedAt || now() } } : { refetch: true }) };
      for (const k of [...inbound.keys()]) if (k.startsWith(`${id}/`)) await unpark(id, k.slice(id.length + 1));
    } else if (!plan.before.length && !out.skipped.length && Number.isFinite(out.thread.updatedAt)) rec = { ...rec, at: out.thread.updatedAt }; // a fresh download: exactly the server's
    await setRec(id, rec);
    if (plan.push && !closed) await markDirty(id);
    if (out.replaced.length) safe(() => dropThumbs(out.replaced));
    const touchedHere = out.added.length || out.replaced.length || out.removed.length || plan.title != null || closed;
    if (closed && plan.removeThread) serverAt = 0; // deleted elsewhere: Recently deleted's count is read again this cycle
    if (touchedHere || plan.changed) {
      let info = null;
      if (getOpen()?.id === id) {
        if (closed) {
          if (plan.removeThread) toast(COPY.openDeleted);
          info = { replaced: [], added: [], removed: [], skipped: [], closed: true };
        } else {
          info = await refreshOpen(id, { ids: [...out.added, ...out.replaced], removed: out.removed, prints, title: plan.title != null });
          if (info?.skipped.length) await rollback(id, info.skipped, before);
        }
      }
      safe(() => onApplied({ threadIds: [id], open: info }));
      recent.set(id, before);
      if (recent.size > 20) recent.delete(recent.keys().next().value);
      post({ changed: [{ t: id, e: [...out.added, ...out.replaced], removed: out.removed, closed, deleted: Boolean(closed && plan.removeThread), title: plan.title != null, prints }] });
    }
    return out;
  }

  // Entries changed in an open copy while a merge replaced them underneath: their record goes back to what this device
  // had before that merge, so the local change is pushed against the server's as a concurrent edit (both kept).
  const recent = new Map(); // threadId → its record before the latest merge (for a follower's rollback)
  async function rollback(id, ids, before) {
    const cur = recs.get(id);
    if (!cur || !ids.length) return;
    const next = { ...cur, e: { ...cur.e }, ...(cur.dead ? { dead: { ...cur.dead } } : {}) };
    delete next.at;
    for (const eid of ids) {
      if (before?.e?.[eid]) { next.e[eid] = before.e[eid]; if (next.dead) delete next.dead[eid]; } else delete next.e[eid];
    }
    await setRec(id, next);
    await markDirty(id);
  }

  // ── pull ──
  // The server lost this thread's document (absence from the index never means deleted: tombstones stay forever). The
  // record stays, flagged lost — its per-entry history still recognises a stale tab's old copy — and every entry goes
  // up again with base 0; the next full pull (a new lineage) settles the record. Nothing is ever deleted here. That
  // holds for a thread deleted everywhere whose tombstone went too: if another device re-creates it, this device's
  // memory of the versions it had is what keeps a stale tab's old copy from being pushed over the newer work.
  async function serverLost(id, rec) {
    await setRec(id, { ...rec, lost: true });
    if (await hasLocal(id)) await markDirty(id); // a deleted thread put back: the push path decides (stale or new)
  }
  // One thread's pull, its failure kept to that thread: a corrupt document, a 500 on one key or a full disk while
  // writing one thread never holds up the others or this device's pushes; that thread waits its own backoff. Network
  // trouble and pauses still end the cycle.
  async function pullOne(id, sum, opts) {
    const f = pullFails.get(id);
    if (f && now() < f.until) { sum.failed++; sum.local ||= f.local; return; }
    try {
      await pullThread(id, sum, opts);
      pullFails.delete(id);
    } catch (err) {
      if (err instanceof Halt || (err instanceof Retry && err.net)) throw err;
      const n = (f?.n || 0) + 1, local = !(err instanceof Retry);
      const wait = err instanceof Retry && err.after ? err.after : Math.min(SYNC_CLIENT.backoffMaxMs, SYNC_CLIENT.backoffMinMs * 2 ** (n - 1));
      pullFails.set(id, { n, until: now() + wait, local });
      sum.failed++; sum.local ||= local;
      if (local) warn(err);
    }
  }
  async function pullAll(sum) {
    const writes0 = listWrites;
    const r = await api('GET', 'index', { headers: lastRows && indexEtag ? { 'if-none-match': indexEtag } : {} });
    let rows = lastRows;
    if (r.status !== 304) {
      if (!r.ok) throw new Retry(`index ${r.status}`);
      const j = r.json;
      await upgradeCheck(j);
      if (!Array.isArray(j?.threads)) throw new Retry('index shape');
      rows = new Map(j.threads.filter(validRow).map((t) => [t[0], t]));
      lastRows = rows; indexEtag = listWrites === writes0 ? r.headers.get('etag') : null; // a write meanwhile: read whole next time
      // Absence from the index never means "deleted" (tombstones stay forever): the server lost it, push it again.
      for (const [id, rec] of [...recs]) if (!rows.has(id) && (rec.rev > 0 || rec.deleted) && !rec.lost) await serverLost(id, rec);
    }
    const want = [];
    for (const [id, etag, rev, changedAt, del, born] of rows.values()) {
      if (deleting.has(id) || hidden.has(id)) continue;
      const rec = recs.get(id);
      if (!rec || !(rec.rev > 0 || rec.deleted)) {
        if (del && !(await hasLocal(id))) { await setRec(id, { ...newRecord(), etag, rev, born: born || 0, title: '', deleted: { at: changedAt } }); continue; }
        want.push({ id, changedAt, full: true });
      } else if (rec.refetch || rec.full || reborn(rec.born, born)) want.push({ id, changedAt, full: true }); // a re-created thread: read it whole
      else if (rev > rec.rev) want.push({ id, changedAt, full: false });
      else if (etag !== rec.etag) want.push({ id, changedAt, full: true });
    }
    want.sort((a, b) => b.changedAt - a.changedAt);
    if (!cfg.firstDone && !toldBringing && !toldFirst && want.some((w) => !recs.get(w.id)?.rev)) { toldBringing = true; toast(COPY.bringing); }
    let done = 0;
    progress = { verb: 'threads', done, total: want.length };
    emitSoon();
    for (const w of want) {
      halted();
      await pullOne(w.id, sum, { full: w.full });
      progress = { verb: 'threads', done: ++done, total: want.length };
      emitSoon();
    }
  }
  // Generating somewhere: in this tab (isLive), or one of its entries is run-locked in any tab. That run saves its own
  // copy of the thread when it settles, over whatever was merged into IndexedDB meanwhile (a fork included), so merges
  // into it wait for a pull after the run (deferred).
  const liveIn = (id, thread, locked) => isLive(id) || Boolean(thread?.entries?.some?.((e) => e && locked.has(e.id)));
  async function pullThread(id, sum = {}, { full = false } = {}) {
    halted();
    if (deleting.has(id) || hidden.has(id)) return;
    for (let attempt = 0; attempt < SYNC_CLIENT.replanTries; attempt++) {
      const rec = recs.get(id) || null;
      const local = await localThread(id);
      const since = !full && local && rec && !rec.refetch && !rec.full && !rec.deleted && rec.rev > 0 ? rec.rev : null;
      const r = await api('GET', `thread/${id}${since != null ? `?since=${since}` : ''}`);
      if (r.status === 404) { if (rec && rec.rev > 0 && !rec.deleted) await serverLost(id, rec); return; }
      if (!r.ok) throw new Retry(`thread ${r.status}`);
      const view = r.json;
      const why = checkView(view, id);
      if (why === 'upgrade') await upgradeCheck({ v: FORMAT + 1 });
      if (why) { warn(`skipped thread ${id} (${why})`); return; }
      if (!view.full && reborn(rec?.born, view.born)) { full = true; attempt--; continue; } // re-created meanwhile: a delta means nothing
      const locked = await lockedIds();
      const plan = await planPull({
        local, record: rec, remote: view, now: now(), uid, locked, live: liveIn(id, local, locked),
        quarantined: (eid, h) => qKeys.has(`${id}/${eid}/${h}`), hashOf: hasher(id),
      });
      if (plan.partial && !view.full) { full = true; attempt--; continue; } // a local copy missing known entries: read it whole
      if (plan.defer) { deferred.add(id); return; }
      const hydrated = await hydrateSlots(id, local, plan);
      const out = await applyLocal(id, plan, hydrated);
      if (!out) continue; // the thread changed while this was planned
      deferred.delete(id);
      sum.pulled = (sum.pulled || 0) + 1;
      return;
    }
  }

  // ── push ──
  // 'lo:' as the store holds it now: a tab in LinkedIn tester mode may have written it since this tab loaded.
  async function syncLocalOnly(id) {
    if (localOnly.has(id)) return true;
    if (!(await store.get(`lo:${id}`).catch(() => undefined))) return false;
    localOnly.add(id);
    return true;
  }
  function skipReason(id, thread, rec) {
    if (localOnly.has(id)) return 'local_only';
    if (hidden.has(id)) return 'hidden';
    if (deleting.has(id)) return 'deleting';
    if (cfg?.mode === 'new' && !(rec && rec.rev > 0) && !(createdAtOf(thread) >= (cfg.enabledAt || 0))) return 'mode_new';
    return null;
  }
  async function pushAll(sum, opts = {}) {
    // The outbox is the store. A notice this tab holds whose marker isn't there (another tab closed before its marker
    // committed) is written back rather than dropped.
    const stored = new Map((await store.entries('d:')).map(([k, v]) => [k.slice(2), v]));
    for (const [id, s] of dirty) if (!stored.has(id)) { await store.set(`d:${id}`, s).catch(warn); stored.set(id, s); }
    dirty.clear();
    for (const [id, s] of stored) dirty.set(id, s);
    const ids = [...dirty].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    if (!ids.length) return;
    let done = 0;
    progress = { verb: 'threads', done, total: ids.length };
    emitSoon();
    for (const id of ids) {
      halted();
      if (opts.hidden) {
        // The page is going away: each thread is a best-effort attempt of its own (one that fails doesn't stop the rest).
        try { await pushThread(id, sum, opts); } catch (err) { if (err instanceof Halt) throw err; }
      } else await pushThread(id, sum, opts);
      progress = { verb: 'threads', done: ++done, total: ids.length };
      emitSoon();
    }
  }
  // Every local entry unchanged since this device last saw it (k.f or k.old)? → a stale re-put of a deleted thread.
  async function allStale(thread, rec, hashOf) {
    for (const e of thread.entries || []) {
      const k = rec.e?.[e.id];
      if (!k || e.pending) return false;
      const x = await hashOf(e);
      if (x.held || (x.h !== k.f && !k.old?.includes(x.h))) return false;
    }
    return true;
  }
  async function dropLocal(id) {
    const open = getOpen();
    await db.del(id);
    safe(() => onApplied({ threadIds: [id], open: open?.id === id ? { replaced: [], added: [], removed: [], closed: true } : null }));
    post({ changed: [{ t: id, e: [], removed: [], closed: true }] });
  }
  // The push is over (nothing left to send, or sent): the thread's updatedAt is what this device checked, and the
  // outbox marker goes unless a newer write landed meanwhile.
  async function settle(id, thread, s0) {
    const r = recs.get(id);
    if (r && r.rev > 0 && Number.isFinite(thread?.updatedAt)) await setAt(id, thread.updatedAt);
    await clearDirty(id, s0);
  }
  async function pushThread(id, sum = {}, { hidden: hiddenFlush = false } = {}) {
    halted();
    const s0 = dirty.get(id) ?? (await store.get(`d:${id}`).catch(() => undefined));
    for (let attempt = 0; attempt < SYNC_CLIENT.replanTries; attempt++) {
      let rec = recs.get(id) || null;
      const { thread, locked } = await readLocked(id);
      if (!thread || !Array.isArray(thread.entries)) { await clearDirty(id, s0); return; }
      await syncLocalOnly(id);
      if (skipReason(id, thread, rec)) { await clearDirty(id, s0); return; }
      // Refused before (413, or an unusable body): tried again only once the thread was written since (or the daily
      // scan re-marks it); until then it stays on this device without a request.
      if (rec?.tooLarge || rec?.refused) {
        if (!(s0 > Math.max(stampOf(rec.tooLarge), stampOf(rec.refused)))) { await clearDirty(id, s0); return; }
        const { tooLarge, refused, ...rest } = rec;
        rec = rest;
        await setRec(id, rec);
      }
      // The server holds the most threads it can sync: a new thread waits (no request) until capRetryMs passed.
      if (!(rec?.rev > 0) && capUntil > now()) { capped.add(id); await clearDirty(id, s0); emitSoon(); return; }
      const hashOf = hasher(id);
      if (rec?.deleted) {
        // Deleted everywhere, and back on this device: a stale tab's re-put goes again; new work revives the thread.
        if (await allStale(thread, rec, hashOf)) { await dropLocal(id); await clearDirty(id, s0); return; }
        const { deleted, ...rest } = rec;
        rec = { ...rest, refetch: true };
        await setRec(id, rec);
      }
      const plan = await planPush({ thread, record: rec, locked, media, hashOf });
      if (debug) safe(() => debug('push', { id, plan, open: getOpen()?.id === id, thread }));
      const mediaHeld = plan.held.filter((h) => h.reason === 'media').length;
      heldMedia.set(id, mediaHeld);
      if (!(rec?.rev > 0) && (rec?.held || 0) !== mediaHeld && (mediaHeld || rec)) { rec = { ...(rec || newRecord()), held: mediaHeld }; await setRec(id, rec); }
      if (plan.refetch) { pullAfter.add(id); if (rec && !rec.refetch) { rec = { ...rec, refetch: true }; await setRec(id, rec); } }
      if (!plan.dirty) { await settle(id, thread, s0); return; }
      if (hiddenFlush && !(await smallEnough(plan))) return; // blob uploads and big deltas wait for a visible session
      await uploadBlobs(plan, id);
      // What's left waits on blobs the server won't take now (quota / refused): it's re-marked when that changes, so
      // the thread isn't pushed again and again for nothing.
      if (!plan.entries.length && !plan.title) { await clearDirty(id, s0); return; }
      let replan = false;
      for (const body of pushBodies(plan)) {
        // Note what is about to go up: if the answer is lost, the next merge recognises the server's copy as ours.
        const cur = recs.get(id) || newRecord(), e = { ...cur.e };
        for (const x of body.entries) { const k = e[x.id] || { r: 0, f: null, g: null, old: [] }; if (!k.pend?.includes(x.h)) e[x.id] = { ...k, pend: [...(k.pend || []), x.h].slice(-3) }; }
        await setRec(id, { ...cur, e });
        const res = await postThread(id, body, plan, hiddenFlush);
        if (res === 'replan') { replan = true; break; }
        if (res === 'too_large' || res === 'refused') {
          await setRec(id, { ...(recs.get(id) || newRecord()), [res === 'too_large' ? 'tooLarge' : 'refused']: stamp() });
          await clearDirty(id, s0);
          emitSoon();
          return;
        }
        if (res === 'cap') { capUntil = now() + SYNC_CLIENT.capRetryMs; capped.add(id); await clearDirty(id, s0); emitSoon(); return; }
        sum.pushed = (sum.pushed || 0) + 1;
        await applyPushResult(id, body, plan, res);
      }
      if (!replan) { await settle(id, (await localThread(id)) || thread, s0); return; }
    }
  }
  async function smallEnough(plan) {
    for (const b of plan.blobs) if (!(await store.get(`b:${b.hash}`).catch(() => null))) return false;
    return pushBodies(plan).reduce((n, b) => n + utf8Length(JSON.stringify(b)), 0) <= SYNC_CLIENT.keepaliveMaxBytes;
  }
  // POST thread/<id> → the answer, or 'replan' (some entry or blob was refused: plan again without it), 'too_large',
  // 'refused' (the body itself was unusable) or 'cap' (the server's thread limit).
  async function postThread(id, body, plan, keepalive) {
    for (let i = 0; i < 2; i++) {
      const r = await api('POST', `thread/${id}`, { json: body, keepalive });
      const j = r.json;
      if (r.ok) { await upgradeCheck(j); return j; }
      if (r.status === 409 && j.code === 'missing_blobs' && Array.isArray(j.missing) && i === 0) {
        for (const h of j.missing) await store.del(`b:${h}`).catch(() => {});
        const failed = await putBlobs(plan.blobs.filter((b) => j.missing.includes(b.hash)), id);
        if (failed.size) return 'replan';
        continue;
      }
      if (r.status === 413) return j.code === 'too_many_threads' ? 'cap' : 'too_large';
      if ((r.status === 422 || r.status === 400) && syncId(j.id)) { held.set(j.id, { code: j.code, t: id }); return 'replan'; }
      if (r.status === 400) return 'refused';
      throw new Retry(`push ${r.status}`);
    }
    throw new Retry('push: blobs still missing');
  }
  async function applyPushResult(id, body, plan, res) {
    for (let attempt = 0; attempt < SYNC_CLIENT.replanTries; attempt++) {
      const { thread, locked } = await readLocked(id, lockedIds);
      const p = await planPushResult({
        thread, record: recs.get(id) || null, sent: plan.sent, title: body.title || null, res, now: now(), uid, locked, hashOf: hasher(id),
        quarantined: (eid, h) => qKeys.has(`${id}/${eid}/${h}`), parked: (eid, h) => inbound.get(`${id}/${eid}`)?.h === h, live: liveIn(id, thread, locked),
      });
      if (p.pull) pullAfter.add(id);
      if (p.deferred) deferred.add(id); // generating: the rest waits for a pull once the run saved its own copy
      if (!thread) {
        // Deleted here (or in another tab) while this push was on the wire: that delete covers what just landed (this
        // device's own work), or the server would keep it and the thread would quietly come back. It is merged into the
        // delete the store holds; a thread that vanished without a drawer delete never gets a server delete from here.
        const recNow = recs.get(id);
        const d = (await store.get(`del:${id}`).catch(() => null)) || deleting.get(id) || null;
        if (d && !recNow?.deleted && res.accepted && Object.keys(res.accepted).length) {
          const seen = { ...d.seen };
          for (const [eid, r] of Object.entries(res.accepted)) if (Number.isSafeInteger(r) && r > (seen[eid] || 0)) seen[eid] = r;
          const next = { ...d, seen, ...(res.born ? { born: res.born } : {}) };
          deleting.set(id, next);
          await store.set(`del:${id}`, next);
        }
        await setRec(id, p.record);
        return true;
      }
      const hydrated = await hydrateSlots(id, thread, p);
      if (await applyLocal(id, p, hydrated)) return true;
    }
    // Kept changing while this was planned: a full pull reconciles with what the server now holds.
    await setRec(id, { ...(recs.get(id) || newRecord()), refetch: true });
    pullAfter.add(id);
    return false;
  }
  // Uploads the plan's blobs the server lacks. Entries whose blobs it won't take now (refused before, or refused now,
  // or no room: 507) leave the plan; refused ones are counted, no-room ones are re-marked once there is room.
  async function uploadBlobs(plan, tid) {
    blobBlocked.delete(tid);
    if (!plan.blobs.length) return;
    const unknown = [], failed = new Map();
    for (const b of plan.blobs) {
      const f = blobRefused.get(b.hash);
      if (f && now() - f.at < SYNC_CLIENT.blobRefusedMs) { failed.set(b.hash, 'refused'); continue; }
      if (!(await store.get(`b:${b.hash}`).catch(() => null))) unknown.push(b);
    }
    if (unknown.length) {
      const missing = new Set();
      for (let i = 0; i < unknown.length; i += 1000) {
        const r = await api('POST', 'blobs/missing', { json: { hashes: unknown.slice(i, i + 1000).map((b) => b.hash) } });
        if (!r.ok) throw new Retry(`blobs/missing ${r.status}`);
        for (const h of r.json.missing || []) missing.add(h);
      }
      for (const b of unknown) if (!missing.has(b.hash)) await store.set(`b:${b.hash}`, 1).catch(warn);
      for (const [h, why] of await putBlobs(unknown.filter((b) => missing.has(b.hash)), tid)) failed.set(h, why);
    }
    if (!failed.size) return;
    const keep = plan.entries.filter((e) => ![...refsOf(e.d)].some((h) => failed.has(h)));
    const refusedHere = plan.entries.filter((e) => [...refsOf(e.d)].some((h) => failed.get(h) === 'refused')).length;
    if ([...failed.values()].includes('quota')) quotaHeld.add(tid);
    if (refusedHere) blobBlocked.set(tid, refusedHere);
    for (const e of plan.entries) if (!keep.includes(e)) delete plan.sent[e.id];
    plan.entries = keep;
    plan.blobs = plan.blobs.filter((b) => !failed.has(b.hash));
    emitSoon();
  }
  async function noteRefused(hash, code) {
    const v = { code, at: now() };
    blobRefused.set(hash, v);
    await store.set(`bf:${hash}`, v).catch(warn);
  }
  // PUT blob/<hash>, text and images before videos, at most uploadsInFlight at a time. → Map(hash → 'quota' |
  // 'refused') of what the server won't take now. While the server is full (507) nothing is uploaded at all. The first
  // failure stops the other upload too (its request is aborted, it takes no next blob) before the error goes up.
  async function putBlobs(list, tid) {
    const failed = new Map();
    if (quotaFull) { for (const b of list) failed.set(b.hash, 'quota'); return failed; }
    const rank = (b) => (b.kind === 'text' ? 0 : b.kind === 'image' ? 1 : 2);
    const order = [...list].sort((a, b) => rank(a) - rank(b));
    const total = order.reduce((n, b) => n + (b.n || 0), 0);
    const ctl = new AbortController();
    let i = 0, sent = 0, stopErr = null;
    if (order.length > 2) { progress = { verb: 'upload', done: 0, total: order.length, left: total }; emitSoon(); }
    const worker = async () => {
      while (i < order.length && !stopErr) {
        if (stopped || forgotten) { stopErr ||= new Halt('stopped'); break; }
        const b = order[i++];
        if (quotaFull) { failed.set(b.hash, 'quota'); continue; }
        let r;
        try { r = await api('PUT', `blob/${b.hash}`, { body: b.bytes(), type: b.type, allow: [507], signal: ctl.signal, timeout: blobTimeout(b.n) }); } catch (err) { if (!stopErr) { stopErr = err; ctl.abort(); } break; }
        sent += b.n || 0;
        if (order.length > 2 && !stopErr) { progress = { verb: 'upload', done: Math.min(order.length, (progress?.done || 0) + 1), total: order.length, left: Math.max(0, total - sent) }; emitSoon(); }
        if (r.ok) { await store.set(`b:${b.hash}`, 1).catch(warn); continue; }
        if (r.status === 507) {
          quotaFull = true;
          quotaNeed = quotaNeed ? Math.min(quotaNeed, b.n || 0) : b.n || 0;
          failed.set(b.hash, 'quota');
          if (tid) quotaHeld.add(tid);
          emitSoon();
          continue;
        }
        if ([400, 411, 413, 415].includes(r.status)) { await noteRefused(b.hash, r.status); failed.set(b.hash, 'refused'); continue; }
        if (!stopErr) { stopErr = new Retry(`blob upload ${r.status}`); ctl.abort(); }
        break;
      }
    };
    await Promise.allSettled(Array.from({ length: Math.min(SYNC_CLIENT.uploadsInFlight, order.length) }, worker));
    if (stopErr) throw stopErr;
    return failed;
  }

  // ── deletes ──
  // The entries of a thread that a push would send now (not on the server yet, or changed since), as they are: a
  // delete keeps them, and they go up right before the server delete so Recently deleted can give them back.
  // bases: each entry's base revision at the moment of the delete (the record may move on before the kept entries are
  // sent — a push answer still on the wire, say — and a later base would turn a concurrent edit into a replace).
  async function unsyncedCopy(id, t, rec, locked = null) {
    const plan = await planPush({ thread: t, record: rec, locked: locked || (await pushLocks()), media, hashOf: hasher(id) });
    if (!plan.entries.length) return null;
    const ids = new Set(plan.entries.map((e) => e.id));
    return {
      createdAt: plan.createdAt, title: typeof t.title === 'string' ? t.title : '', titlePush: plan.title,
      bases: Object.fromEntries(plan.entries.map((e) => [e.id, e.base])), entries: t.entries.filter((e) => ids.has(e.id)).map((e) => jsonClone(e)),
    };
  }
  // A delete's kept entries go up first, each on the base it had when the delete was made. A version another device
  // changed meanwhile (conflict) or one already deleted there (dropped) goes up as a fork, so it too lands in the trash.
  // → the delete with seen covering everything that landed (and born: the lineage those revisions belong to).
  async function pushKept(id, d) {
    const thread = { id, title: d.keep.title, createdAt: d.keep.createdAt, entries: d.keep.entries };
    const bases = d.keep.bases && typeof d.keep.bases === 'object' ? d.keep.bases : {};
    const keepRec = { ...newRecord(), born: validDate(d.born) ? d.born : 0, e: {} };
    for (const e of thread.entries) if (isRev(bases[e?.id]) && bases[e.id] > 0) keepRec.e[e.id] = { r: bases[e.id], f: null, g: null, old: [] };
    const seen = { ...d.seen };
    let born = validDate(d.born) ? d.born : 0;
    const take = (res) => {
      const b = bornOf(res);
      if (b && born && b !== born) { for (const k of Object.keys(seen)) delete seen[k]; } // re-created: the older revisions mean nothing
      if (b) born = b;
      for (const [eid, rev] of Object.entries(res.accepted || {})) if (isRev(rev) && rev > (seen[eid] || 0)) seen[eid] = rev;
    };
    const send = async (plan) => {
      await uploadBlobs(plan, id);
      const out = [];
      for (const body of pushBodies(plan)) {
        const res = await postThread(id, body, plan, false);
        if (typeof res !== 'object' || !res) continue; // refused: nothing more can be done for those entries
        take(res);
        out.push(res);
      }
      return out;
    };
    const plan = await planPush({ thread, record: keepRec, locked: new Set(), media, hashOf: hasher(id) });
    plan.title = d.keep.titlePush && typeof d.keep.titlePush.v === 'string' && isRev(d.keep.titlePush.base) ? d.keep.titlePush : null; // only a title this device hadn't synced
    const answers = plan.entries.length || plan.title ? await send(plan) : [];
    const forks = [];
    for (const res of answers) {
      for (const eid of [...(res.conflicts || []).map((s) => s.id), ...(res.dropped || [])]) {
        const L = thread.entries.find((e) => e.id === eid);
        if (L && !forks.some((f) => f.forkOf === eid)) forks.push(forkEntry(L, uid()));
      }
    }
    if (forks.length) {
      const fplan = await planPush({ thread: { ...thread, entries: forks }, record: null, locked: new Set(), media, hashOf: hasher(id) });
      fplan.title = null;
      fplan.born = born;
      if (fplan.entries.length) await send(fplan);
    }
    const next = { ...d, seen, ...(born ? { born } : {}) };
    delete next.keep;
    deleting.set(id, next);
    await store.set(`del:${id}`, next);
    return next;
  }
  async function sendDeletes(sum) {
    for (const [k, d0] of await store.entries('del:')) {
      halted();
      const id = k.slice(4);
      const d = d0?.keep?.entries?.length ? await pushKept(id, d0) : d0;
      const r = await api('DELETE', `thread/${id}`, { json: { v: FORMAT, seen: d?.seen || {}, ...(validDate(d?.born) && d.born > 0 ? { born: d.born } : {}) } });
      if (r.status === 404 || r.status === 400 || r.status === 413) {
        await store.del(k); deleting.delete(id); touched.add(id);
        // 404: the server lost it before the delete arrived. Deleted here all the same; the record keeps its history
        // (as serverLost) so a stale tab's copy is still recognised.
        if (r.status === 404) { const rec = recs.get(id) || newRecord(); await setRec(id, { ...rec, deleted: { at: now() }, lost: true }); }
        continue;
      }
      if (!r.ok) throw new Retry(`delete ${r.status}`);
      const res = r.json;
      await store.del(k); deleting.delete(id); touched.add(id);
      // Recently deleted gained this one: its count (Settings) follows at once, and is read again at the next pull.
      if (res.trashKey && server) server = { ...server, trash: (server.trash || 0) + 1 };
      serverAt = 0;
      const rec = recs.get(id) || newRecord();
      if (res.kept > 0) {
        toast(`Part of “${d?.title || 'Untitled'}” changed on another device after you deleted it, so that part was kept.`);
        const { deleted, ...rest } = rec;
        await setRec(id, { ...rest, full: true });
        pullAfter.add(id);
      } else await setRec(id, { ...rec, etag: res.etag ?? rec.etag, rev: Number.isSafeInteger(res.rev) ? res.rev : rec.rev, title: '', deleted: { at: now() } });
      if (await hasLocal(id)) await markDirty(id); // put back meanwhile (a stale tab): the push path decides
      sum.deleted = (sum.deleted || 0) + 1;
    }
  }

  // ── first sync and the scans ──
  // Marks threads for the push path. Plain: every eligible thread (the first-sync union). hashed: threads already on
  // the server only when a push would send something. quick (once a session): only threads written since this device
  // last checked them (updatedAt > record.at) are hashed — it finds a write whose outbox marker never committed.
  async function markEligible({ hashed = false, quick = false } = {}) {
    const marked = [];
    for (const id of await db.keys()) {
      if (forgotten) break;
      if (!syncId(id) || (await syncLocalOnly(id)) || hidden.has(id) || deleting.has(id)) continue;
      const rec = recs.get(id);
      if (quick && (rec?.tooLarge || rec?.refused)) continue; // the daily scan tries those again
      const t = await localThread(id);
      if (!t || !t.entries?.length || skipReason(id, t, rec)) continue;
      if (hashed && rec?.rev > 0) {
        if (quick && !maybeChanged(t, rec)) continue;
        const plan = await planPush({ thread: t, record: rec, locked: await pushLocks(), media, hashOf: hasher(id) });
        if (!plan.dirty && !plan.refetch) { if (Number.isFinite(t.updatedAt)) await setAt(id, t.updatedAt); continue; }
        if (plan.refetch) pullAfter.add(id);
      }
      await markDirty(id);
      marked.push(id);
      if (hashed) await new Promise((r) => idle(r));
    }
    return marked;
  }
  // Cheap signs a synced thread may hold something the server lacks: written since this device last checked it, or an
  // entry or title its record doesn't know. (The hashed plan then decides; the daily scan checks everything.)
  const maybeChanged = (t, rec) => !Number.isFinite(rec.at) || t.updatedAt > rec.at || (typeof t.title === 'string' && t.title !== rec.title)
    || t.entries.some((e) => e && !Object.prototype.hasOwnProperty.call(rec.e || {}, e.id) && !gateHeld(mediaKinds(e), media));
  function scheduleScan(quick = false) {
    if (T.scan || stopped) return;
    T.scan = timers.setTimeout(() => {
      T.scan = null;
      idle(() => {
        if (!active() || !anyVisible()) return;
        if (quick) reconciled = true;
        serial(async () => { await markEligible({ hashed: true, quick }); if (!quick) { reconciled = true; await saveCfg({ scanAt: now() }); } }).then(() => run({ pull: false })).catch(warn);
      });
    }, SYNC_CLIENT.scanDelayMs);
  }

  // ── the cycle ──
  function serial(fn) { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; }
  function run(opts = {}) {
    if (!active()) return Promise.resolve(null);
    if (cycling) { pendingOpts = { pull: Boolean(pendingOpts?.pull || opts.pull), hidden: Boolean(pendingOpts?.hidden || opts.hidden) }; return cycling; }
    cycling = serial(async () => {
      let o = opts, out = null;
      for (let i = 0; i < 4 && o; i++) { pendingOpts = null; out = await cycleOnce(o); o = pendingOpts; }
      if (pendingOpts) { const p = pendingOpts; pendingOpts = null; timers.setTimeout(() => run(p), 1000); }
      return out;
    }).finally(() => { cycling = null; });
    return cycling;
  }
  async function cycleOnce({ pull = true, hidden: hiddenFlush = false } = {}) {
    await refreshCfg(); // switched off, re-moded or un-paused in another tab: this cycle sees it
    if (!active()) { if (!stopped && !enabled()) stop(); return null; } // switched off elsewhere: let the leader lock go
    if (pausedNow()) { emit(); return null; }
    if (cfg.paused) await saveCfg({ paused: null }); // an expired pause: try again
    if (!online()) { emit(); return null; }
    if (capped.size && capUntil <= now()) { for (const id of capped) await markDirty(id); capped.clear(); }
    phase = 'syncing'; lastError = null; progress = null;
    emit();
    const sum = { pulled: 0, pushed: 0, deleted: 0, failed: 0, local: false };
    const first = pull && !cfg.firstDone;
    try {
      if (pull) { T.lastFull = now(); await pullAll(sum); }
      if (deferred.size) {
        const locked = await lockedIds();
        for (const id of [...deferred]) if (!liveIn(id, await localThread(id).catch(() => null), locked)) { deferred.delete(id); pullAfter.add(id); }
      }
      if (first) await markEligible();
      await sendDeletes(sum);
      for (let pass = 0; pass < SYNC_CLIENT.pushPasses; pass++) {
        await pushAll(sum, { hidden: hiddenFlush });
        const again = [...pullAfter];
        pullAfter.clear();
        for (const id of again) { halted(); await pullOne(id, sum, { full: Boolean(recs.get(id)?.refetch || recs.get(id)?.full) }); }
        if (hiddenFlush || (!again.length && !dirty.size)) break;
      }
      if (pull && now() - serverAt > SYNC_CLIENT.statusEveryMs) await refreshStatus();
      await saveCfg({ lastOkAt: now(), ...(first ? { firstDone: true } : {}) });
      if (first && (sum.pulled || sum.pushed)) toast(COPY.firstDone);
      backoff = 0; retryAt = 0;
      if (sum.failed) {
        // Some threads couldn't be pulled (each waits its own backoff); everything else went through.
        lastError = sum.local ? 'storage' : 'thread';
        const due = Math.min(...[...pullFails.values()].map((f) => f.until)) - now();
        if (Number.isFinite(due)) armRetry(Math.max(due, SYNC_CLIENT.backoffMinMs));
      }
      if (!cfg.scanAt || now() - cfg.scanAt > SYNC_CLIENT.scanEveryMs) scheduleScan(false);
      else if (!reconciled) scheduleScan(true);
      return sum;
    } catch (err) {
      if (err instanceof Halt) return null;
      lastError = err instanceof Retry ? 'retry' : 'error';
      if (!(err instanceof Retry)) warn(err);
      armBackoff(err instanceof Retry ? err.after : 0);
      return null;
    } finally {
      phase = 'idle'; progress = null;
      emit();
    }
  }
  async function refreshStatus() {
    const r = await api('GET', 'status');
    if (!r.ok) return;
    const j = r.json;
    if (Number.isFinite(j.bytes) && Number.isFinite(j.quota)) {
      server = { bytes: j.bytes, quota: j.quota, trash: Number.isFinite(j.trash) ? j.trash : 0, threads: j.threads };
      serverAt = now();
      // Room again (the owner raised SYNC_QUOTA_BYTES): the threads that waited for it are pushed again.
      if (quotaFull && j.bytes + quotaNeed <= j.quota) {
        quotaFull = false; quotaNeed = 0;
        for (const tid of quotaHeld) await markDirty(tid);
        quotaHeld.clear();
      }
    }
  }

  // ── public API ──
  async function enable(mode = 'all') {
    await ready();
    await refreshCfg();
    if (isOwner()) proven = true;
    const at = mode === 'new' ? now() : cfg?.enabledAt || now();
    await saveCfg({ enabled: true, asked: true, mode, enabledAt: at, firstDone: false, paused: null });
    safe(() => deps.persistStorage?.());
    if (isOwner()) { start(); kick('enable'); }
    emit();
  }
  async function disable() {
    await ready();
    await saveCfg({ enabled: false, asked: true }); // every other tab is told: the leader stops too
    stop();
    emit();
  }
  // The first-sync question (a browser with tester traces). With no thread on this device there is nothing to choose:
  // sync turns on as it would anywhere else. → 'ask' | 'on'
  async function askOwner() {
    const n = (await db.keys().catch(() => [])).length;
    if (n === 0) { await enable('all'); firstToast(); return 'on'; }
    if (deps.onAsk) safe(() => deps.onAsk(n));
    emit();
    return 'ask';
  }
  // The first-run message (once a session): it says where progress is, so "Bringing in…" isn't shown after it.
  function firstToast() { toldFirst = true; toast(COPY.firstEnable); }
  // An owner sign-in about to turn sync on with its first-run message (app.js leaves out its own "You're in" then).
  const firstRunAhead = () => Boolean(SYNC_CLIENT.autoEnable && loaded && !cfg?.asked && !hasTraces() && testerMarks !== true && isOwner());
  // The first-sync question answered here — or closed (only new threads). Another tab may have answered it already:
  // that choice stands. → true when this answer was taken.
  async function answer(mode) {
    await ready();
    await refreshCfg();
    if (cfg?.asked) { emit(); return false; }
    await enable(mode);
    return true;
  }
  async function verified() {
    if (!isOwner() || forgotten) return;
    await ready();
    await refreshCfg();
    proven = true;
    if (!cfg?.asked) {
      if (await tracesFound()) { await askOwner(); return; }
      if (!SYNC_CLIENT.autoEnable) { emit(); return; }
      await enable('all');
      firstToast();
      return;
    }
    if (!cfg.enabled) { emit(); return; }
    if (cfg.paused && HARD.has(cfg.paused.reason)) await saveCfg({ paused: null }); // every tab is told: the leader resumes
    start();
    kick('boot');
    emit();
  }
  // The Settings switch turned on: asks first wherever verified() would (tester traces), else turns sync on.
  async function turnOn() {
    if (!isOwner() || forgotten) return 'no';
    await ready();
    await refreshCfg();
    proven = true;
    if (!cfg?.asked && (await tracesFound())) return askOwner();
    await enable(cfg?.mode || 'all');
    return 'on';
  }
  const hasTraces = () => traced || localOnly.size > 0 || Boolean(deps.hasTesterTraces?.());
  // Tester traces: this engine's own (trace, lo:), the app's (its tester keys, present even after a tester signed
  // out), or a local thread carrying what only a tester session writes. Checked before anything is uploaded.
  async function tracesFound() {
    if (hasTraces()) return true;
    if (testerMarks === null) {
      let found = false;
      for (const id of await db.keys().catch(() => [])) {
        if (testerMarked(await localThread(id).catch(() => null))) { found = true; break; }
      }
      testerMarks = found;
    }
    return testerMarks;
  }
  function kick(reason = 'kick') {
    if (reason === 'offline') { emitSoon(); return null; } // every tab reads its own navigator.onLine: the status says so at once
    if (stopped || forgotten || !cfg?.enabled || !isOwner()) return null;
    if (!leader) { post({ kick: reason }); return null; }
    const t = now();
    if (reason === 'visible') { if (t - T.lastFull < SYNC_CLIENT.visibleThrottleMs) return null; schedulePoll(); }
    if (reason === 'drawer' && t - T.lastFull < SYNC_CLIENT.drawerThrottleMs) return null;
    if (reason === 'poll' && t - T.lastFull < SYNC_CLIENT.pollMs / 2) return null;
    if (reason === 'now' && cfg.paused && ['unconfigured', 'disabled'].includes(cfg.paused.reason)) return saveCfg({ paused: null }).then(() => run({ pull: true }));
    return run({ pull: !['settled', 'push', 'delete'].includes(reason) });
  }
  // The DB wrapper starts this as a thread put starts (not awaited: the app's own save is never delayed), so the outbox
  // marker is on its way before the thread lands; noteWrite writes it again once the put landed.
  async function intent(ids) {
    if (forgotten || isTester() || (cfg && cfg.asked && !cfg.enabled)) return;
    const list = (Array.isArray(ids) ? ids : [ids]).filter(syncId);
    await Promise.all(list.map((id) => store.set(`d:${id}`, stamp()))).catch(warn);
  }
  // A save by this tab's app landed (wrapDb; objs: the thread objects saved, when known). Its outbox marker is written
  // (the leader pushes it) and every other tab is told, so an open copy there takes the save in. In LinkedIn tester
  // mode the thread is marked 'lo:' instead — no outbox marker, nothing for a leader in another tab to push — and every
  // tab learns that at once.
  function noteWrite(ids, objs = null) {
    if (forgotten) return;
    const tester = isTester();
    const list = (Array.isArray(ids) ? ids : [ids]).filter(syncId);
    if (!list.length) return;
    for (const id of list) {
      if (tester) {
        if (!localOnly.has(id)) { localOnly.add(id); store.set(`lo:${id}`, 1).catch(warn); }
        if (!traced) { traced = true; store.set('trace', 1).catch(warn); }
        continue;
      }
      if (cfg && cfg.asked && !cfg.enabled) continue; // switched off: turning it back on re-checks every thread
      const s = stamp();
      dirty.set(id, s);
      store.set(`d:${id}`, s).catch(warn);
      for (const [eid, x] of held) if (x.t === id) held.delete(eid); // a refused entry gets another chance once edited
    }
    if (tester) post({ localOnly: list, wrote: list });
    else if (leader) { schedulePush(); post({ wrote: list }); } else post({ dirty: list, wrote: list });
    // This tab's open thread saved from another object of it (a run's own copy): the open one takes that in too.
    const o = getOpen();
    if (o && list.includes(o.id) && Array.isArray(objs) && !objs.includes(o)) openWritten([o.id]).catch(warn);
    emitSoon();
  }
  async function noteHidden(id) {
    if (!syncId(id) || forgotten) return;
    hidden.add(id);
    await store.set(`hide:${id}`, 1).catch(warn);
    if (!leader) post({ hide: [id] });
  }
  async function deleteThread(id) {
    await ready().catch(() => {});
    if (forgotten) { await db.del(id); return; }
    await refreshCfg();
    const on = enabled();
    const rec = recs.get(id) || (await store.get(`t:${id}`).catch(() => null)) || null;
    const locked = await pushLocks();
    const t = await copyOf(id);
    for (const x of await pushLocks()) locked.add(x);
    const known = Boolean(rec && (rec.rev > 0 || Object.keys(rec.e || {}).length) && !rec.deleted);
    await syncLocalOnly(id);
    const skip = t ? skipReason(id, t, rec) : null;
    // What hasn't reached the server goes with the delete (pushed first, then deleted), so Recently deleted can give
    // it back — offline too. No request is made here.
    const keep = on && t && !skip && !rec?.tooLarge ? await unsyncedCopy(id, t, rec, locked).catch((err) => { warn(err); return null; }) : null;
    if (on && !skip && (known || keep)) {
      const seen = {};
      for (const [eid, k] of Object.entries(rec?.e || {})) if (k && k.r > 0) seen[eid] = k.r;
      for (const [key, v] of inbound) if (key.startsWith(`${id}/`)) seen[key.slice(id.length + 1)] = v.rev;
      const d = { seen, at: now(), title: t?.title || rec?.title || '', ...(rec?.born ? { born: rec.born } : {}), ...(keep ? { keep } : {}) };
      deleting.set(id, d);
      touched.add(id);
      await store.set(`del:${id}`, d);
    } else if (known && !on) await noteHidden(id); // sync is off: it stays on the server, and never comes back here
    await db.del(id);
    dirty.delete(id);
    await store.del(`d:${id}`).catch(() => {});
    for (const k of [...inbound.keys()]) if (k.startsWith(`${id}/`)) await unpark(id, k.slice(id.length + 1));
    post({ changed: [{ t: id, e: [], removed: [], closed: true }] });
    emitSoon();
    if (on) kick('delete');
  }
  // The drawer's confirm text: honest about what Recently deleted can give back.
  // The drawer's confirm text: honest about what Recently deleted can give back. It follows deleteThread's own rule: a
  // server delete (restorable for 30 days) only when the server knows the thread or this device has something to send
  // with the delete; anything else — a thread whose every entry holds images or videos (phase 1), one left out by "Only
  // threads I make from now on", tester-mode or too large — is deleted here only, and the text says so.
  async function deleteCopy(id) {
    await ready().catch(() => {});
    await refreshCfg();
    const t = await copyOf(id);
    const rec = recs.get(id) || null;
    const onServer = rec?.rev > 0 && !rec.deleted;
    const known = Boolean(rec && (rec.rev > 0 || Object.keys(rec.e || {}).length) && !rec.deleted);
    await syncLocalOnly(id);
    const skip = t ? skipReason(id, t, rec) : null;
    const keep = enabled() && t && !skip && !rec?.tooLarge ? await unsyncedCopy(id, t, rec).catch(() => null) : null;
    if (skip || (!onServer && rec?.tooLarge) || !(known || keep)) return COPY.deleteLocal;
    let copy = COPY.deleteConfirm;
    if (onServer && rec.tooLarge) copy += COPY.deleteUnsynced;
    if (t?.entries?.some((e) => gateHeld(mediaKinds(e), media) && !rec?.e?.[e.id])) copy += COPY.deleteMedia;
    return copy;
  }
  // The thread as IndexedDB holds it, or this tab's open copy when it isn't saved yet.
  async function copyOf(id) {
    const t = await localThread(id).catch(() => null);
    if (t) return t;
    const o = getOpen();
    return o?.id === id ? o : null;
  }
  // What exists only on this device (Clear this device asks about it): changes a push would send (entries, titles,
  // waiting deletes); entries held here (images and videos while MEDIA_SYNC keeps them, too large, still generating);
  // whole threads that never sync (left out by "Only threads I make from now on", written in tester mode, too large or
  // refused). Every local thread is checked, not only those with an outbox marker. → {changes, media, other, threads}
  async function localReport() {
    await ready().catch(() => {});
    const r = { changes: 0, media: 0, other: 0, threads: 0 };
    if (!cfg?.enabled) return r;
    r.changes = deleting.size;
    const ids = new Set([...(await store.entries('d:').catch(() => [])).map(([k]) => k.slice(2))]);
    for (const id of await db.keys().catch(() => [])) ids.add(id);
    const locked = await pushLocks();
    for (const id of ids) {
      if (!syncId(id)) continue;
      const thread = await localThread(id).catch(() => null);
      if (!thread || !Array.isArray(thread.entries) || !thread.entries.length) continue;
      const rec = recs.get(id) || null;
      await syncLocalOnly(id);
      const skip = skipReason(id, thread, rec);
      if (skip === 'hidden' || skip === 'deleting') continue;
      if (skip || rec?.tooLarge || rec?.refused) { r.threads++; continue; }
      const heldHere = thread.entries.some((e) => e && (e.pending === true || locked.has(e.id) || gateHeld(mediaKinds(e), media)));
      if (!heldHere && cfg.firstDone && rec?.rev > 0 && !dirty.has(id) && !maybeChanged(thread, rec)) continue;
      const plan = await planPush({ thread, record: rec, locked, media, hashOf: hasher(id) });
      r.changes += plan.entries.length + (plan.title ? 1 : 0);
      for (const h of plan.held) if (h.reason === 'media') r.media++; else r.other++;
      r.other += plan.waiting.length;
    }
    return r;
  }
  // Everything that exists only on this device, as one number (0: Clear this device loses nothing synced elsewhere).
  async function pendingCount() {
    const r = await localReport();
    return r.changes + r.media + r.other + r.threads;
  }
  const hardPaused = () => { const p = pausedNow(); return p && HARD.has(p.reason) ? p : null; };
  const userError = (err, fallback) => (err instanceof Halt ? new Error(['401', '403', 'no passcode'].includes(err.message) ? COPY.passcode : statusLine(status(), now()) || fallback)
    : err instanceof Retry ? new Error(COPY.unreachable) : err instanceof Error ? err : new Error(fallback));
  async function trash() {
    if (!online()) return { offline: true, items: [] };
    if (hardPaused()) throw new Error(statusLine(status(), now())); // nothing is sent with a passcode the server refused
    let r;
    try { r = await api('GET', 'trash'); } catch (err) { throw userError(err, COPY.trashFailed); }
    if (!r.ok) throw new Error(COPY.trashFailed);
    const j = r.json;
    const items = (Array.isArray(j.items) ? j.items : []).filter((x) => x && typeof x.key === 'string' && syncId(x.id) && validDate(x.deletedAt));
    if (server) server = { ...server, trash: items.length };
    emitSoon();
    return { offline: false, items };
  }
  async function restore(key) {
    if (hardPaused()) throw new Error(statusLine(status(), now()));
    let r;
    try { r = await api('POST', 'trash/restore', { json: { key } }); } catch (err) { throw userError(err, 'Couldn’t restore that thread. Try again.'); }
    const j = r.json;
    if (r.status === 404) throw new Error('That thread is no longer in Recently deleted.');
    if (!r.ok || !syncId(j.id)) throw new Error(j.error || 'Couldn’t restore that thread. Try again.');
    const id = j.id;
    if (hidden.delete(id)) await store.del(`hide:${id}`).catch(warn);
    if (deleting.delete(id)) await store.del(`del:${id}`).catch(warn);
    if (leader) {
      const rec = recs.get(id);
      if (rec) { const { deleted, ...rest } = rec; await setRec(id, { ...rest, full: true }); }
      pullAfter.add(id);
      await run({ pull: false });
    } else post({ full: [id] });
    if (server?.trash) server = { ...server, trash: server.trash - 1 };
    emitSoon();
    return { id, title: typeof j.title === 'string' ? j.title : '', restored: j.restored };
  }
  async function flush() {
    if (stopped || forgotten || !cfg?.enabled) return null;
    if (!leader) { post({ flush: true }); return null; }
    return run({ pull: false, hidden: !visible() });
  }
  async function uploadOlder() {
    await saveCfg({ mode: 'all' }); // every tab re-reads it: the leader no longer skips older threads
    const ids = await serial(() => markEligible());
    if (!leader && ids.length) post({ dirty: ids });
    emit();
    return run({ pull: false });
  }
  // "Remove synced threads from this device" (offered while the passcode is refused): removes only threads whose every
  // part is on the server. A thread holding anything that exists only here — images or videos the phase gate keeps,
  // entries or a title not synced yet, an entry being generated, anything refused — stays. → {removed, kept}
  async function removeSynced() {
    await ready();
    const open = getOpen();
    const removed = [];
    let kept = 0;
    for (const [id, r] of [...recs]) {
      if (!(r.rev > 0) || r.deleted) continue;
      const t = await localThread(id).catch(() => null);
      if (!t) continue;
      // The open copy here may hold a change the app hasn't saved yet: it has to be on the server too.
      const copies = getOpen()?.id === id && getOpen() !== t ? [t, getOpen()] : [t];
      let only = r.tooLarge || r.refused || r.lost || (await syncLocalOnly(id)) || inboundOf(id) > 0;
      for (const c of copies) {
        if (only) break;
        const plan = await planPush({ thread: c, record: r, locked: await pushLocks(), media, hashOf: hasher(id) });
        only = Boolean(plan.entries.length || plan.title || plan.held.length || plan.waiting.length);
      }
      if (only) { kept++; continue; }
      await db.del(id);
      await store.del(`d:${id}`).catch(() => {}); dirty.delete(id);
      await store.del(`t:${id}`).catch(() => {}); recs.delete(id);
      removed.push(id);
    }
    await saveCfg({ firstDone: false });
    if (!leader) post({ reload: true });
    if (removed.length) post({ changed: removed.map((t) => ({ t, e: [], removed: [], closed: true })) }); // other tabs close them too
    safe(() => onApplied({ threadIds: removed, open: open && removed.includes(open.id) ? { replaced: [], added: [], removed: [], closed: true } : null }));
    emit();
    return { removed: removed.length, kept };
  }
  function holdRunLock(entryId) {
    if (!syncId(entryId)) return () => {};
    ownRuns.add(entryId); // a refresh of the open copy never touches it while it generates here
    if (!locks?.request) return () => { ownRuns.delete(entryId); };
    let release = null, done = false;
    locks.request(`${RUN_LOCK}${entryId}`, () => (done ? undefined : new Promise((res) => { release = res; }))).catch(() => {});
    return () => { done = true; ownRuns.delete(entryId); release?.(); };
  }
  function dropState() {
    cfg = null; loaded = null;
    for (const m of [recs, dirty, deleting, inbound, held, heldMedia, mediaMemo, pullFails, blobRefused, blobBlocked]) m.clear();
    for (const s of [localOnly, hidden, qKeys, deferred, pullAfter, quotaHeld, capped, touched]) s.clear();
    memoChars = 0;
  }
  // Clear this device. Every other tab is told first (they stop and drop their copy of the sync state, so none of them
  // re-creates it or downloads threads back into the cleared device), then work in flight ends and the store goes.
  async function forget() {
    post({ forget: true });
    forgotten = true;
    stop();
    await chain; // work in flight stops at its next checkpoint (requests are aborted); nothing writes after this
    await store.destroy();
    dropState();
  }
  // Another tab cleared this device: this tab's sync stops for good (until the page reloads).
  function cleared() {
    if (forgotten) return;
    forgotten = true;
    stop();
    dropState();
    emit();
    safe(() => onCleared());
  }

  return {
    load: ready, start, stop, verified, enable, disable, turnOn, answer, hasTraces: tracesFound, firstRunAhead,
    pause: (reason) => pauseFor(reason === 'lockout' ? 'lockout' : reason, reason === 'lockout' ? now() + SYNC_CLIENT.lockoutMs : 0),
    kick, run, cycle: (opts) => run({ pull: true, ...opts }), pullNow: () => run({ pull: true }), pushNow: () => run({ pull: false }),
    pushThread: (id) => serial(() => pushThread(id)), pullThread: (id, opts) => serial(() => pullThread(id, {}, opts)),
    intent, noteWrite, noteHidden, noteRead, noteSaving, noteSaved: saved, noteSaveFailed, saveThread, refreshOpen,
    deleteThread, deleteCopy, restore, trash, flush, uploadOlder, removeSynced, pendingCount, localReport, holdRunLock, forget,
    status, emit, badge, on: enabled, busy: () => Boolean(cycling) || openWork > 0 || msgWork > 0, isLeader: () => leader, config: () => (cfg ? { ...cfg } : null),
    record: (id) => recs.get(id) || null, noteImported, onMessage,
  };

  function badge(t) {
    const id = typeof t === 'string' ? t : t?.id;
    if (!syncId(id) || !cfg?.enabled || !isOwner()) return '';
    const rec = recs.get(id);
    if (deleting.has(id)) return ' · Deleting…';
    if (localOnly.has(id) || rec?.tooLarge || rec?.refused) return ' · This device only';
    const n = inboundOf(id);
    if (n) return ` · Downloading ${plural(n, 'item')}`;
    if (!(rec?.rev > 0)) {
      if (rec?.held && !dirty.has(id)) return ' · This device only';
      if (cfg.mode === 'new' && typeof t === 'object' && !(createdAtOf(t) >= (cfg.enabledAt || 0))) return ' · This device only';
      return ' · Not synced yet';
    }
    return dirty.has(id) ? ' · Not synced yet' : '';
  }
  function noteImported(n) {
    if (!enabled()) return false;
    toast(`Imported ${plural(n, 'thread')}. They’ll sync to your other devices — importing the same backup there too would duplicate them.`);
    return true;
  }
}
export const createEngine = createSync;

// ── the browser singleton (app.js) ──
let engine = null, ui = null, bootDeps = null;
const early = [];
const inflight = new Set();
// The DB wrapper: every successful put marks its threads dirty (and localOnly in tester mode) — no hashing on this hot
// path, and the app's own save is never delayed (the marker write starts alongside it). del from any caller but the
// drawer delete (which goes through deleteThread) hides the thread from sync; clear ("Clear this device") stops the
// engine and never sends deletes.
// get tells the engine what each thread object read (noteRead), and put saves through it (saveThread), so the open
// thread is refreshed in place when another tab saves it, and a save never writes an older copy over another tab's work.
export function wrapDb(rawDB) {
  const note = (ids, objs) => { if (engine) engine.noteWrite(ids, objs); else early.push(...ids); };
  const track = (p) => { inflight.add(p); p.then(() => inflight.delete(p), () => inflight.delete(p)); return p; };
  const intent = (ids) => { engine?.intent(ids).catch(() => {}); };
  const saving = (ts) => ts.map((t) => engine?.noteSaving(t)); // committed: each snapshot counts once the write has landed
  const failed = (ts) => (err) => { for (const t of ts) engine?.noteSaveFailed(t); throw err; };
  return {
    ...rawDB,
    get: (id) => rawDB.get(id).then((t) => { engine?.noteRead(t); return t; }),
    put: (t) => { intent([t?.id]); return track((engine ? engine.saveThread(t) : rawDB.put(t)).then((r) => { note([t?.id], [t]); return r; })); },
    putAll: (threads) => { intent(threads.map((t) => t?.id)); const snaps = saving(threads); return track(rawDB.putAll(threads).then((r) => { threads.forEach((t, i) => engine?.noteSaved(t, snaps[i])); note(threads.map((t) => t?.id), threads); return r; }, failed(threads))); },
    del: (id) => rawDB.del(id).then((r) => { engine?.noteHidden(id); return r; }),
    clear: () => { engine?.stop(); return rawDB.clear(); },
  };
}
// Called once at boot. deps: { rawDB, uid, apiHeaders, isOwner, isTester, hasTesterTraces, getOpen, isLive, onApplied,
// onCleared, dropThumbs, toast }. The engine starts only from verified(), after a passcode-proven call.
export function init(deps) {
  if (engine) return engine;
  bootDeps = deps;
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('atelier-sync') : null;
  // The first-run message says where progress is: "synced" never replaces it before it could be read.
  let firstAt = 0;
  const toast = (msg, o) => {
    if (msg === COPY.firstEnable) firstAt = Date.now();
    const wait = msg === COPY.firstDone && firstAt ? firstAt + FIRST_TOAST_MS - Date.now() : 0;
    if (wait > 0) setTimeout(() => deps.toast?.(msg, o), wait); else deps.toast?.(msg, o);
  };
  engine = createSync({
    ...deps, toast, db: deps.rawDB, store: idbStore(), fetch: (...a) => fetch(...a), locks: navigator.locks || null, channel,
    online: () => navigator.onLine !== false, visible: () => document.visibilityState === 'visible',
    persistStorage: () => navigator.storage?.persist?.().catch(() => {}),
    idle: (fn) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(() => fn(), { timeout: 3000 }) : setTimeout(fn, 200)),
    onStatus: (s) => { ui?.render(s); deps.onStatus?.(s); },
    onAsk: (n) => ui?.ask(n),
  });
  if (early.length) engine.noteWrite(early.splice(0));
  ui = bindUi(engine, deps);
  engine.load().then(() => engine.emit(), () => {});
  return engine;
}
const FIRST_TOAST_MS = 6000;
const warnOut = (err) => console.warn('[atelier] sync:', err?.message || err);
export const verified = () => engine?.verified().catch(warnOut);
// Settings opened, or the network changed: the sync block shows the status as it is now.
export const showStatus = () => { engine?.emit(); };
export const firstRunAhead = () => Boolean(engine?.firstRunAhead());
// Clear this device's first question ('' when nothing would be lost), from everything only this device has.
export const wipeWarning = () => (engine ? engine.localReport().then(wipeText, () => '') : Promise.resolve(''));
export const pause = (reason = 'passcode') => engine?.pause(reason)?.catch?.(warnOut);
export const kick = (reason) => { engine?.kick(reason)?.catch?.(warnOut); };
export async function flush() { await Promise.allSettled([...inflight]); return engine?.flush().catch(warnOut); }
export const on = () => Boolean(engine?.on());
export const busy = () => Boolean(engine?.busy());
export const badge = (thread) => engine?.badge(thread) || '';
export const deleteCopy = (id) => (engine ? engine.deleteCopy(id) : Promise.resolve('Delete this thread?'));
export const deleteThread = (id) => (engine ? engine.deleteThread(id) : bootDeps?.rawDB?.del(id));
export const pendingCount = () => (engine ? engine.pendingCount().catch(() => 0) : Promise.resolve(0));
export const forget = () => (engine ? engine.forget() : idbStore().destroy());
export const noteImported = (n) => Boolean(engine?.noteImported(n));
export const status = () => engine?.status() || null;
export function holdRunLock(entryId) {
  if (engine) return engine.holdRunLock(entryId);
  const L = globalThis.navigator?.locks;
  if (!L?.request || !syncId(entryId)) return () => {};
  let release = null, done = false;
  L.request(`${RUN_LOCK}${entryId}`, () => (done ? undefined : new Promise((res) => { release = res; }))).catch(() => {});
  return () => { done = true; release?.(); };
}

// ── Settings → Your data, Recently deleted, the first-sync dialog, the nav label (index.html markup, see the
// integration notes). Every element is optional: a missing one is skipped. (Exported for tests, with a stand-in doc.) ──
export function bindUi(eng, deps, doc = globalThis.document) {
  const $ = (s) => doc.querySelector(s);
  const el = {
    block: $('#syncBlock'), toggle: $('#syncToggle'), status: $('#syncStatus'), counts: $('#syncCounts'), now: $('#syncNow'),
    trash: $('#syncTrash'), older: $('#syncUploadOld'), forget: $('#syncForget'), nav: $('#navLocal'), wipe: $('#wipeHint'),
    first: $('#syncFirst'), firstBody: $('#syncFirstBody'), firstNew: $('#syncFirstNew'), firstAll: $('#syncFirstAll'), firstExport: $('#syncFirstExport'),
    trashDialog: $('#trashDialog'), trashList: $('#trashList'), trashClose: $('#trashClose'), note: $('#syncNote'),
  };
  const wipeDefault = el.wipe?.textContent || '', navDefault = el.nav?.textContent || COPY.navLocal;
  let last = null, answered = false;
  const toast = deps.toast || (() => {});
  function render(s = eng.status()) {
    last = s;
    const refused = ['passcode', 'lockout'].includes(s.paused?.reason); // nothing is sent until the passcode is proven
    if (el.block) el.block.hidden = s.tester || !(s.owner || s.on);
    if (el.toggle) { el.toggle.checked = s.on; el.toggle.disabled = !s.owner; }
    if (el.status) el.status.textContent = statusLine(s);
    if (el.counts) { const c = countsLine(s); el.counts.textContent = c; el.counts.hidden = !c; }
    if (el.now) { el.now.hidden = !s.on; el.now.disabled = s.state === 'syncing' || s.state === 'offline' || refused; }
    if (el.trash) { el.trash.hidden = !s.on || refused; el.trash.textContent = s.server?.trash ? `Recently deleted (${s.server.trash})` : 'Recently deleted'; }
    if (el.older) el.older.hidden = !(s.on && s.mode === 'new');
    if (el.forget) el.forget.hidden = !(s.on && s.paused?.reason === 'passcode');
    if (el.nav) el.nav.textContent = !s.owner || !s.on || s.tester ? navDefault : s.paused ? COPY.navPaused : COPY.navSynced;
    if (el.wipe) el.wipe.textContent = s.owner && s.on && !s.tester ? (deviceOnly(s) ? COPY.wipeSyncedLocal : COPY.wipeSynced) : wipeDefault;
    if (el.note) el.note.hidden = true; // phase 3: "N items in this thread are still downloading · Waiting for Wi-Fi"
    // The first-sync question was answered in another tab: this tab's copy of it closes (and doesn't answer again).
    if (s.asked && el.first?.open) { answered = true; el.first.close(); }
  }
  // "Up to date · synced 2 min ago" stays true while Settings is open.
  setInterval(() => { if (last && el.block && !el.block.hidden && el.block.offsetParent) render(eng.status()); }, 30_000)?.unref?.();
  el.toggle?.addEventListener('change', () => {
    // On: the engine asks first on a browser with tester traces (the switch stays off until the owner chooses).
    if (el.toggle.checked) eng.turnOn().then(() => render(), warnOut);
    else eng.disable().catch(warnOut);
  });
  el.now?.addEventListener('click', () => { eng.kick('now'); });
  el.older?.addEventListener('click', () => { eng.uploadOlder().catch(warnOut); });
  el.forget?.addEventListener('click', async () => {
    if (!confirm(COPY.removeSynced)) return;
    const r = await eng.removeSynced().catch((err) => { toast(err.message || 'Couldn’t remove them. Try again.', { error: true }); return null; });
    if (!r) return;
    const kept = r.kept ? ` ${plural(r.kept, 'thread')} with work only on this device ${r.kept === 1 ? 'stays' : 'stay'} here.` : '';
    toast(r.removed ? `Removed ${plural(r.removed, 'synced thread')} from this browser.${kept}` : `Nothing to remove.${kept}`);
  });

  // First-sync dialog: shown once, only on a browser with tester traces. Closing it without a choice = new threads only
  // (unless another tab answered it meanwhile: eng.answer leaves that choice alone).
  async function ask(n) {
    if (!el.first) return eng.answer('new');
    answered = false;
    if (el.firstBody) el.firstBody.textContent = `This browser was also used for LinkedIn tester sign-in, so ${n === 1 ? 'the thread here' : `some of the ${n} threads here`} may not be yours. Choose what to upload. Threads from your other devices download either way.`;
    if (el.firstAll) el.firstAll.textContent = n === 1 ? 'Upload the thread' : `Upload all ${n} threads`;
    if (!el.first.open) el.first.showModal();
    el.firstNew?.focus();
  }
  const choose = (mode) => { answered = true; el.first?.close(); eng.answer(mode).catch(warnOut); };
  el.firstNew?.addEventListener('click', () => choose('new'));
  el.firstAll?.addEventListener('click', () => choose('all'));
  el.firstExport?.addEventListener('click', () => { doc.querySelector('#exportBtn')?.click(); });
  el.first?.addEventListener('close', () => { if (!answered) { answered = true; eng.answer('new').catch(warnOut); } });

  // Recently deleted.
  async function openTrash() {
    const d = el.trashDialog, list = el.trashList;
    if (!d || !list) return;
    list.replaceChildren(row('Loading…'));
    if (!d.open) d.showModal();
    let got;
    try { got = await eng.trash(); } catch (err) { list.replaceChildren(row(err.message || COPY.trashFailed)); return; }
    if (got.offline) return list.replaceChildren(row(COPY.trashOffline));
    if (!got.items.length) return list.replaceChildren(row(COPY.trashEmpty));
    list.replaceChildren(...got.items.map((it) => {
      const li = doc.createElement('li');
      li.className = 'trash-row';
      const body = doc.createElement('span');
      body.className = 'trash-body';
      const title = doc.createElement('span');
      title.className = 'trash-title'; title.textContent = it.title || 'Untitled';
      const sub = doc.createElement('span');
      sub.className = 'trash-sub'; sub.textContent = `Deleted ${shortDate(it.deletedAt)} · ${plural(it.n || 0, 'entry', 'entries')}`;
      body.append(title, sub);
      const b = doc.createElement('button');
      b.type = 'button'; b.className = 'chip trash-restore'; b.textContent = 'Restore';
      b.setAttribute('aria-label', `Restore ${it.title || 'Untitled'}`);
      b.addEventListener('click', async () => {
        b.disabled = true; b.setAttribute('aria-busy', 'true');
        try {
          const r = await eng.restore(it.key);
          toast(`Restored “${r.title || it.title || 'Untitled'}”.`);
          li.remove();
          if (!list.children.length) list.replaceChildren(row(COPY.trashEmpty));
        } catch (err) { b.disabled = false; b.removeAttribute('aria-busy'); toast(err.message || 'Couldn’t restore that thread. Try again.', { error: true }); }
      });
      li.append(body, b);
      return li;
    }));
  }
  function row(text) { const li = doc.createElement('li'); li.className = 'trash-empty hint'; li.textContent = text; return li; }
  el.trash?.addEventListener('click', openTrash);
  el.trashClose?.addEventListener('click', () => el.trashDialog?.close());
  el.trashDialog?.addEventListener('click', (ev) => { if (ev.target === el.trashDialog) el.trashDialog.close(); });
  return { render, ask, openTrash };
}
