// The cannot-lose-data property test for owner thread sync. Three simulated devices, each with an in-memory
// atelier-data store, a Map-backed sync store, its own Web Locks and the REAL engine (public/sync.js) and merge core
// (public/sync-merge.js); every request goes to the REAL src/sync.js over one shared tests/fake-r2.mjs. Each device
// also has a second tab (a follower engine on the device's BroadcastChannel) with its own open copy of a thread: it
// opens threads (one generating in tab 1 shows as interrupted there), adds turns, edits and renames, generates in a
// thread of its own (even one tab 1 is generating in, or deletes meanwhile), and saves its copy when it goes hidden — so
// stale open copies in either tab would clobber the other's work. Runs in both tabs hold their lock through the engine
// (app.js Sync.holdRunLock) and a tab's thread stays live only while that tab's own run in it goes (app.js liveRuns). A seeded PRNG
// drives rounds of random work (new threads, sends, retries, crashes mid-retry, a second tab rendering a generating
// entry as interrupted, renames, Canva imports on several devices, deletes, restores, stale-tab write-backs, Clear
// device, tester-mode threads, offline periods, the server losing a document) with R2 and network faults (failed
// compare-and-swaps, rate limits, lost responses, dropped connections) and user edits landing mid-request. After every
// round all devices quiesce, and the invariants are checked (every open copy, in either tab, must match IndexedDB):
//   1. every device holds identical threads (ids, entry ids, order, content minus transient keys, titles);
//   2. every version of an entry ever written survives somewhere, or was replaced by a later version made on top of
//      it, or was in a thread its device deleted, or was cleared from a device before it was ever pushed;
//   3. no pending or transient state ever reached the server, and no request was refused as invalid (400/422);
//   4. a recovered or second-tab "interrupted" copy never replaced an answer the server already had;
//   5. forks appear only for true concurrent edits (neither version descends from the other);
//   6. no local thread was ever removed except by a delete (here or elsewhere) — never because the server lacked it;
//   7. tester-mode threads never reach the server.
// SYNC_SIM_SEEDS / SYNC_SIM_ROUNDS / SYNC_SIM_OPS scale it up (defaults keep npm test quick).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeR2, workerRequest } from './fake-r2.mjs';
import { handleSync, SYNC_TIMING } from '../src/sync.js';
import { createSync, memoryStore } from '../public/sync.js';
import { canonical, strip, TRANSIENT } from '../public/sync-merge.js';

// SYNC_SIM_OVERLAP=1: devices' background cycles overlap the next ops and each other (closer to real devices, but
// crypto.subtle timing then makes runs irreproducible — failures are diagnosed from the printed trail).
const OVERLAP = Boolean(process.env.SYNC_SIM_OVERLAP);
const SEEDS = Number(process.env.SYNC_SIM_SEEDS || 20), ROUNDS = Number(process.env.SYNC_SIM_ROUNDS || 6), OPS = Number(process.env.SYNC_SIM_OPS || 28);
const T0 = 1_800_000_000_000;
const NO_TIMERS = { setTimeout: () => 0, clearTimeout: () => {} };
const tick = () => new Promise((r) => setImmediate(r));
function prng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const brief = (t) => (t?.entries || []).map((e) => `${e.id}=${vid(e.text) || e.error || ''}${e.recovered ? 'R' : ''}${e.pending ? 'P' : ''}`).join(',');
function memDb(onRemove, log = null) {
  const m = new Map();
  const c = (v) => (v === undefined ? undefined : structuredClone(v));
  return {
    m,
    async get(id) { return c(m.get(id)); },
    async put(t) { if (log && (process.env.SYNC_SIM_TRACE === t.id || process.env.SYNC_SIM_TRACE === '*')) log(`DB put ${t.id} [${brief(t)}]`); m.set(t.id, c(t)); },
    async del(id) { if (m.delete(id)) onRemove(id); },
    async keys() { return [...m.keys()]; },
    async update(id, fn) { const cur = c(m.get(id)); const next = fn(cur); if (log && next && (process.env.SYNC_SIM_TRACE === id || process.env.SYNC_SIM_TRACE === '*')) log(`DB update ${id} [${brief(next)}]`); if (next === null) { if (m.delete(id)) onRemove(id); } else if (next) m.set(id, c(next)); return cur; },
  };
}
function fakeLocks() {
  const held = new Map();
  return {
    async request(name, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {}; }
      while (held.has(name)) await held.get(name).done;
      let release;
      held.set(name, { done: new Promise((r) => { release = r; }) });
      try { return await cb({ name }); } finally { held.delete(name); release(); }
    },
    async query() { return { held: [...held.keys()].map((name) => ({ name })), pending: [] }; },
  };
}
const vid = (text) => (typeof text === 'string' && /^v\d+/.test(text) ? text.split(' ')[0] : null);
// A BroadcastChannel stand-in shared by a device's two tabs.
function bus() {
  const ports = [];
  return () => {
    const port = { listeners: [], addEventListener(_, fn) { this.listeners.push(fn); }, postMessage(data) { for (const p of ports) if (p !== port) for (const fn of p.listeners) queueMicrotask(() => fn({ data: structuredClone(data) })); } };
    ports.push(port);
    return port;
  };
}

async function simulate(seed) {
  const rnd = prng(seed);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const chance = (p) => rnd() < p;
  const clock = { t: T0 };
  const r2 = fakeR2({ pageSize: 7 });
  const env = { SYNC_BUCKET: r2, SYNC_QUOTA_BYTES: '53687091200' };
  SYNC_TIMING.now = () => clock.t; SYNC_TIMING.sleep = async () => {}; SYNC_TIMING.jitter = () => 0;
  const trail = []; // the op log, printed when an invariant fails
  // A failure inside a fetch or db callback would be caught by the engine (as a network error): latch it and re-throw.
  let broken = null;
  const fail = (msg) => { broken ??= `seed ${seed}: ${msg}\n  last ops: ${trail.slice(-Number(process.env.SYNC_SIM_TRAIL || 40)).join(' | ')}`; throw new Error(broken); };
  const check = () => { if (broken) throw new Error(broken); };
  // versions: version id → { parent }. Accounting sets for invariant 2.
  const versions = new Map(), deletedOk = new Set(), clearedOk = new Set(), supersededOk = new Set(), faultOk = new Set(), partials = new Set();
  const forbidden = []; // [tid, eid, marker, run]: never on the server under eid (invariant 4)
  const deletedTids = new Set(), testerTids = new Set(), lostTids = new Set();
  let seq = 0, faulty = false;
  let where = '';
  const newVersion = (parent, long = false) => { const v = `v${++seq}`; versions.set(v, { parent, where }); return long ? `${v} ${'x'.repeat(40_000)}` : v; };

  // ── devices ──
  const devices = ['pc', 'phone', 'tablet'].map((name) => ({ name, offline: false, tester: false, open: null, live: new Set(), running: null, frozen: new Set(), snaps: [], n: 0, tab2: { open: null, live: new Set(), running: null } }));
  function make(dev) {
    dev.db = dev.db || memDb((id) => { if (!deletedTids.has(id)) fail(`${dev.name} removed thread ${id} that nobody deleted`); }, (msg) => trail.push(`${dev.name}:${msg}`));
    dev.store = memoryStore();
    if (process.env.SYNC_SIM_TRACE) { // SYNC_SIM_TRACE=<threadId>: log that thread's outbox marker changes
      const st = dev.store, id = `d:${process.env.SYNC_SIM_TRACE}`;
      const { set, del, delIf } = st;
      st.set = async (k, v) => { if (k === id) trail.push(`${dev.name}:d+ ${v}`); return set.call(st, k, v); };
      st.del = async (k) => { if (k === id) trail.push(`${dev.name}:d-`); return del.call(st, k); };
      st.delIf = async (k, v) => { const r = await delIf.call(st, k, v); if (k === id) trail.push(`${dev.name}:d-if ${v} ${r}`); return r; };
    }
    dev.locks = dev.locks || fakeLocks();
    const port = bus();
    dev.engine = createSync({
      db: dev.db, store: dev.store, locks: dev.locks, channel: port(),
      apiHeaders: () => ({ 'content-type': 'application/json', 'x-app-pass': 'pw' }),
      isOwner: () => !dev.tester, isTester: () => dev.tester, hasTesterTraces: () => false,
      getOpen: () => dev.open, isLive: (id) => dev.live.has(id), onAsk: () => {},
      onApplied: (x) => { if (x.open?.closed) dev.open = null; }, // app.js syncApplied: S.thread = null, startFresh()
      debug: (ev, x) => { // fork decisions go into the trail, with what they were made from
        if (ev === 'push' && (process.env.SYNC_SIM_TRACE === x.id || process.env.SYNC_SIM_TRACE === '*')) { trail.push(`${dev.name}:PLAN push ${x.id} open=${x.open} from [${brief(x.thread)}] sends [${x.plan.entries.map((e) => `${e.id}@${e.base}=${vid(e.d.text) || e.d.error || ''}#${e.h.slice(0, 6)}`).join(',')}]`); return; }
        if (ev === 'push') return;
        if (ev === 'record') { // SYNC_SIM_TRACE_ENTRY=<entryId>: that entry's record after every write
          const want = process.env.SYNC_SIM_TRACE_ENTRY, k = want && x.rec.e?.[want];
          if (want && (process.env.SYNC_SIM_TRACE === x.id || process.env.SYNC_SIM_TRACE === '*')) trail.push(`${dev.name}:REC ${want} ${k ? `r${k.r} f=${String(k.f).slice(0, 6)} old=[${(k.old || []).map((h) => h.slice(0, 6))}]${k.pend ? ` pend=[${k.pend.map((h) => h.slice(0, 6))}]` : ''}` : 'none'}${x.rec.dead?.[want] ? ' DEAD' : ''} born=${x.rec.born}`);
          return;
        }
        if (process.env.SYNC_SIM_TRACE === x.id || process.env.SYNC_SIM_TRACE === '*') {
          const th = x.out.thread;
          trail.push(`${dev.name}:APPLY ${ev} open=${x.open} slots=[${x.plan.slots.map((q) => `${q.id}:${q.from}`).join(',')}] → [${(th?.entries || []).map((e) => `${e.id}=${vid(e.text) || e.error || ''}${e.recovered ? 'R' : ''}${e.pending ? 'P' : ''}`).join(',')}]`);
        }
        if (ev !== 'fork') return;
        for (const s of x.plan.slots) {
          if (s.from !== 'fork') continue;
          const orig = s.entry.forkOf, rs = x.plan.slots.find((q) => q.id === orig && q.r), k = dev.engine.record(x.id)?.e?.[orig];
          trail.push(`${dev.name}:FORK ${x.id}/${orig}→${s.id} ${x.how?.[orig]} local=${vid(s.entry.text)} server=${rs ? vid(docText(rs.r.d)) + '@' + rs.r.rev : '-'} k=${k ? `${k.r}${k.pend ? ' pend' : ''}` : '-'}`);
          checkFork(dev, x.id, orig, x.how?.[orig], vid(s.entry.text), rs ? vid(docText(rs.r.d)) : null);
        }
      },
      fetch: fetchFor(dev), now: () => clock.t, uid: () => `${dev.name}k${++dev.n}`, timers: NO_TIMERS,
      online: () => !dev.offline, visible: () => true, toast: () => {}, random: rnd,
    });
    // The second tab: a follower (it never starts), so it only hears the leader's merges and tab 1's saves.
    dev.tab2.open = null; dev.tab2.live = new Set(); dev.tab2.running = null;
    dev.tab2.engine = createSync({
      db: dev.db, store: dev.store, locks: dev.locks, channel: port(),
      apiHeaders: () => ({ 'content-type': 'application/json', 'x-app-pass': 'pw' }),
      isOwner: () => !dev.tester, isTester: () => dev.tester, hasTesterTraces: () => false,
      getOpen: () => dev.tab2.open, isLive: (id) => dev.tab2.live.has(id), onAsk: () => {},
      onApplied: (x) => { if (x.open?.closed) dev.tab2.open = null; },
      fetch: fetchFor(dev), now: () => clock.t, uid: () => `${dev.name}j${++dev.n}`, timers: NO_TIMERS,
      online: () => !dev.offline, visible: () => true, toast: () => {}, random: rnd,
    });
  }
  // app.js's wrapped DB: a put saves through the engine (a copy it knows takes in the other tab's saves first), then
  // tells it the save landed; a get tells it what that object read.
  const put = async (dev, t) => { await dev.engine.saveThread(t); dev.engine.noteWrite([t.id], [t]); };
  const put2 = async (dev, t) => { await dev.tab2.engine.saveThread(t); dev.tab2.engine.noteWrite([t.id], [t]); };
  const load = async (eng, dev, id) => { const t = (await dev.db.get(id)) ?? null; eng.noteRead(t); return t; };
  function fetchFor(dev) {
    return async (url, init = {}) => {
      const u = new URL(url, 'https://atelier.test');
      const method = init.method || 'GET', path = u.pathname.slice('/api/sync/'.length);
      if (dev.offline) throw new TypeError('Failed to fetch');
      if (method === 'POST' && path.startsWith('thread/')) {
        for (const e of JSON.parse(init.body).entries) for (const k of TRANSIENT) if (k in e.d) fail(`${dev.name} pushed ${e.id} with ${k}`);
      }
      // Faults and mid-request edits draw from the seeded PRNG, so only on requests made one at a time (blob uploads go
      // two in parallel and finish in any order: drawing there would make a seed irreproducible).
      const draw = faulty && method !== 'PUT';
      if (draw && chance(0.03) && !dev.running) await userEdit(dev, 'mid-request'); // the user keeps working while sync is on the wire
      if (draw && chance(0.04)) throw new TypeError('Failed to fetch');
      if (draw && chance(0.05)) r2.faults.failNextCas = 1 + Math.floor(rnd() * 3);
      if (draw && chance(0.03)) r2.faults.rateLimitNextPut = 1;
      if (draw && chance(0.03)) r2.faults.dropNextPut = 1;
      const headers = new Headers(init.headers || {});
      if (init.body != null) headers.set('content-length', String(typeof init.body === 'string' ? Buffer.byteLength(init.body) : init.body.byteLength));
      const res = await handleSync(workerRequest(u, { method, headers, body: init.body }), env, u, u.pathname.slice('/api/'.length));
      r2.faults.failNextCas = 0; r2.faults.rateLimitNextPut = 0; r2.faults.dropNextPut = 0;
      if (res.status === 400 || res.status === 422) fail(`${dev.name} ${method} ${path} → ${res.status} ${await res.clone().text()}`);
      if (method === 'POST' && path.startsWith('thread/')) {
        checkForbidden(path.slice(7), `${dev.name} pushed [${JSON.parse(init.body).entries.map((e) => `${e.id}@${e.base}=${vid(e.d.text) || e.d.error || ''}`).join(',')}] → ${res.status}`);
        if (process.env.SYNC_SIM_TRAIL) {
          const b = JSON.parse(init.body), j = res.status === 200 ? await res.clone().json() : {};
          trail.push(`${dev.name}:POST ${path.slice(7)} [${b.entries.map((e) => `${e.id}@${e.base}`).join(',')}]${b.title ? ` title "${b.title.v}"@${b.title.base}` : ''} → ${res.status} rev ${j.prevRev}→${j.rev} title "${j.title?.v}"/${j.title?.rev}`);
        }
      }
      if (draw && chance(0.04)) throw new TypeError('network connection lost'); // the server did it; the answer is lost
      return res;
    };
  }
  function checkForbidden(tid, what = '') {
    const doc = r2.json(`t/${tid}.json`);
    if (!doc) return;
    for (const [t, eid, marker] of forbidden) {
      if (t !== tid || lostTids.has(tid)) continue;
      const e = doc.entries.find((x) => x.id === eid);
      if (e && (e.d.error === marker || vid(e.d.text) === marker)) fail(`the interrupted copy ${marker} replaced ${tid}/${eid} on the server (${what})`);
    }
  }
  for (const d of devices) make(d);

  // ── the app's actions ──
  const localOf = async (dev, tid) => (dev.open?.id === tid ? dev.open : dev.db.get(tid));
  const versionsIn = (t) => (t?.entries || []).map((e) => vid(e.text)).filter(Boolean);
  async function openThread(dev, tid) {
    if (dev.open) await put(dev, dev.open);
    dev.open = tid ? await load(dev.engine, dev, tid) : null;
  }
  async function newThread(dev) {
    clock.t += 1000;
    const t = { id: `${dev.name}t${++dev.n}`, title: '', createdAt: clock.t, updatedAt: clock.t, entries: [{ id: `${dev.name}e${++dev.n}`, kind: 'ask', prompt: 'p', createdAt: clock.t, text: newVersion(null, chance(0.05)) }] };
    if (dev.tester) testerTids.add(t.id);
    if (dev.open) await put(dev, dev.open);
    dev.open = t;
    await put(dev, t);
  }
  async function send(dev) {
    const t = dev.open;
    clock.t += 1000;
    const e = { id: `${dev.name}e${++dev.n}`, kind: 'ask', prompt: 'p', createdAt: clock.t, pending: true, stage: 'Composing', startedAt: clock.t };
    t.entries.push(e);
    startRun(dev, t, e, null);
    await put(dev, t);
  }
  async function retry(dev) {
    const t = dev.open;
    const e = pick(t.entries.filter((x) => vid(x.text)));
    if (!e) return;
    const parent = vid(e.text);
    // a retry replaces what this device shows; if that version never reached the server, the retry supersedes it
    const onServer = r2.json(`t/${t.id}.json`)?.entries.find((x) => x.id === e.id && vid(docText(x.d)) === parent);
    if (!onServer) supersededOk.add(parent);
    Object.assign(e, { pending: true, text: '', error: null, stage: 'Composing', startedAt: clock.t });
    delete e.recovered;
    startRun(dev, t, e, parent);
    await put(dev, t);
  }
  function startRun(dev, t, e, parent) {
    const release = dev.engine.holdRunLock(e.id); // app.js run(): Sync.holdRunLock, before the entry's first save
    dev.running = { t, tid: t.id, eid: e.id, parent, release }; // app.js run() keeps its own thread object
    dev.live.add(t.id);
  }
  async function settle(dev) {
    // run()'s finally: this tab's last run in the thread ended, so it is no longer live here (an entry another tab is
    // generating in it never keeps it live); the run's own thread object (the open one, unless sync closed it meanwhile —
    // a delete from another device landing as the user sent) is saved, then the run lock goes, sync is kicked, and the
    // open thread is saved again (persist(true))
    const { t, tid, eid, parent, release } = dev.running;
    const e = t.entries.find((x) => x.id === eid);
    Object.assign(e, { pending: false, text: newVersion(parent, chance(0.05)) });
    for (const k of ['stage', 'startedAt', 'status', 'chars']) delete e[k];
    dev.live.delete(tid);
    const saved = put(dev, t);
    dev.running = null; release();
    await saved;
    dev.engine.kick('settled');
    if (dev.open === t) await put(dev, dev.open);
  }
  async function crash(dev) {
    const { t: own, tid, eid, parent, release } = dev.running;
    const synced = dev.engine.record(tid)?.e?.[eid]?.r > 0;
    if (chance(0.5)) { // a mid-run persist (the run's own object, still pending) had saved partial text before the tab died
      const t = own;
      const e = t.entries.find((x) => x.id === eid);
      e.text = `${newVersion(parent)} partial`;
      versions.get(vid(e.text)).tid = tid;
      partials.add(vid(e.text));
      if (synced) forbidden.push([tid, eid, vid(e.text), null]);
      await put(dev, t);
    }
    // a second tab's copy of a never-synced entry is now a genuine recovered entry (its only copy): it may go up
    if (!synced) for (let i = forbidden.length - 1; i >= 0; i--) if (forbidden[i][3] === dev.running) forbidden.splice(i, 1);
    dev.running = null; dev.live.delete(tid); release(); dev.open = null;
    // the tab reopens: recoverThread marks the interrupted entry (pending → recovered)
    const t = await dev.db.get(tid);
    if (!t) return; // deleted on another device meanwhile
    const marker = `interrupted-${++seq}`;
    for (const e of t.entries) if (e.pending) { e.pending = false; e.recovered = true; e.error = marker; for (const k of ['stage', 'status', 'startedAt', 'chars']) delete e[k]; }
    if (synced) forbidden.push([tid, eid, marker, null]);
    await put(dev, t);
    if (chance(0.6)) dev.open = t;
  }
  async function secondTab(dev) { // another tab renders the generating entry as interrupted while the run lock is held
    const { tid, eid } = dev.running;
    const t = await dev.db.get(tid);
    const e = t?.entries.find((x) => x.id === eid);
    if (!e) return; // deleted on another device meanwhile
    const marker = `tab2-${++seq}`;
    Object.assign(e, { pending: false, recovered: true, error: marker });
    forbidden.push([tid, eid, marker, dev.running]); // never pushed while the run lock is held
    await put(dev, t);
  }
  async function rename(dev, t) { t.title = `title ${++seq}`; await put(dev, t); }
  async function canva(dev) {
    clock.t += 1000;
    if (dev.open?.id === 'canva-imports' || dev.frozen.has('canva-imports')) return;
    const t = (await dev.db.get('canva-imports')) || { id: 'canva-imports', title: 'From Canva', createdAt: clock.t, updatedAt: clock.t, entries: [] };
    t.entries.push({ id: `${dev.name}c${++dev.n}`, kind: 'image', prompt: 'Canva design', createdAt: clock.t, text: newVersion(null), meta: { model: 'canva', note: 'From Canva' }, canva: { design_id: `D${seq}` } });
    await put(dev, t);
  }
  async function userEdit(dev, why) {
    const r = rnd();
    trail.push(`${dev.name}:${why}`);
    if (r < 0.4 && dev.open && !dev.frozen.has(dev.open.id)) {
      clock.t += 10;
      dev.open.entries.push({ id: `${dev.name}e${++dev.n}`, kind: 'ask', prompt: 'p', createdAt: clock.t, text: newVersion(null) });
      await put(dev, dev.open);
    } else if (r < 0.7 && dev.open && !dev.frozen.has(dev.open.id)) await rename(dev, dev.open);
    else if (!dev.tester) await canva(dev);
  }
  // ── the second tab ──
  // It opens a thread as app.js does (a copy of its own; an entry generating in tab 1 shows as interrupted there, and
  // that copy must never reach the server), adds turns, edits a settled answer (a retry that finished), renames, and
  // saves its copy whenever it goes hidden or moves to another thread.
  // Tab 2's own run settles: as settle() — no longer live, its object saved, the lock released, the open thread saved.
  async function tab2Settle(dev) {
    const tab = dev.tab2, run = tab.running;
    if (!run) return;
    trail.push(`${dev.name}:tab2 settle ${run.t.id}/${run.eid}`); where = `${dev.name} tab2 settle`;
    const e = run.t.entries.find((x) => x.id === run.eid);
    Object.assign(e, { pending: false, text: newVersion(null) });
    for (const k of ['stage', 'startedAt', 'status', 'chars']) delete e[k];
    tab.live.delete(run.t.id);
    const saved = put2(dev, run.t);
    tab.running = null; run.release();
    await saved;
    if (tab.open === run.t) await put2(dev, tab.open);
  }
  async function tab2Op(dev) {
    const tab = dev.tab2, r = rnd();
    if (tab.running && chance(0.5)) return tab2Settle(dev);
    if (!tab.running && tab.open && !dev.frozen.has(tab.open.id) && !testerTids.has(tab.open.id) && chance(0.35)) {
      clock.t += 10; // a send in tab 2 (the thread may be generating in tab 1 too)
      const e = { id: `${dev.name}w${++dev.n}`, kind: 'ask', prompt: 'p', createdAt: clock.t, pending: true, stage: 'Composing', startedAt: clock.t };
      trail.push(`${dev.name}:tab2 run ${tab.open.id}/${e.id}`); where = `${dev.name} tab2 run`;
      tab.open.entries.push(e);
      tab.live.add(tab.open.id);
      tab.running = { t: tab.open, eid: e.id, release: tab.engine.holdRunLock(e.id) };
      return put2(dev, tab.open);
    }
    const label = (x) => { trail.push(`${dev.name}:tab2 ${x}`); where = `${dev.name} tab2 ${x} (op ${trail.length})`; };
    const editable = tab.open && !dev.frozen.has(tab.open.id) && !testerTids.has(tab.open.id);
    if (!tab.open || r < 0.25) {
      if (tab.open && chance(0.6)) await put2(dev, tab.open); // persist(true) before the drawer opens another
      const ids = [...dev.db.m.keys()].filter((id) => !testerTids.has(id) && !dev.frozen.has(id));
      if (!ids.length) { tab.open = null; return; }
      const id = pick(ids);
      label(`open ${id}`);
      if (tab.running?.t.id === id) { tab.open = tab.running.t; return; } // liveThreads: its own run's object
      const t = await load(tab.engine, dev, id);
      for (const e of t?.entries || []) {
        if (!e.pending) continue; // recoverThread: generating in tab 1, shown as interrupted here
        const marker = `tab2open-${++seq}`;
        Object.assign(e, { pending: false, recovered: true, error: marker });
        for (const k of ['stage', 'status', 'startedAt', 'chars']) delete e[k];
        forbidden.push([id, e.id, marker, dev.running && dev.running.eid === e.id ? dev.running : null]);
      }
      tab.open = t;
      return;
    }
    if (editable && r < 0.55) {
      clock.t += 10;
      label(`send ${tab.open.id}`);
      tab.open.entries.push({ id: `${dev.name}u${++dev.n}`, kind: 'ask', prompt: 'p', createdAt: clock.t, text: newVersion(null) });
      return put2(dev, tab.open);
    }
    if (editable && r < 0.7) {
      const e = pick(tab.open.entries.filter((x) => vid(x.text) && !x.pending && !x.recovered && !x.error && dev.running?.eid !== x.id));
      if (!e) return;
      const parent = vid(e.text);
      label(`edit ${tab.open.id}/${e.id}`);
      const onServer = r2.json(`t/${tab.open.id}.json`)?.entries.find((x) => x.id === e.id && vid(docText(x.d)) === parent);
      if (!onServer) supersededOk.add(parent);
      e.text = newVersion(parent);
      return put2(dev, tab.open);
    }
    if (editable && r < 0.8) { label(`rename ${tab.open.id}`); tab.open.title = `title ${++seq}`; return put2(dev, tab.open); }
    label(`hidden ${tab.open.id}`); // visibilitychange → persist(true): its copy is saved (whatever it holds)
    await put2(dev, tab.open);
    if (chance(0.5)) tab.open = null;
  }
  async function deleteThread(dev, tid) {
    const t = await localOf(dev, tid);
    for (const v of versionsIn(t)) deletedOk.add(v);
    deletedTids.add(tid);
    if (dev.open?.id === tid) dev.open = null; // the fixed drawer delete: S.thread = null first
    if (dev.tab2.open?.id === tid) for (const v of versionsIn(dev.tab2.open)) deletedOk.add(v);
    await dev.engine.deleteThread(tid);
  }
  async function serverText(v) {
    for (const k of r2.keys('t/')) for (const e of r2.json(k).entries) if (vid(docText(e.d)) === v) return true;
    return false;
  }
  const textOfRef = (ref) => (ref && ref.$b ? r2.text(`b/${ref.$b.slice(0, 2)}/${ref.$b}`) : null);
  const docText = (d) => (typeof d.text === 'string' ? d.text : textOfRef(d.text));
  async function clearDevice(dev) {
    if (dev.tab2.running) await tab2Settle(dev);
    if (dev.open) await put(dev, dev.open);
    if (dev.tab2.open) await put2(dev, dev.tab2.open);
    for (const t of dev.db.m.values()) for (const v of versionsIn(t)) if (!(await serverText(v))) clearedOk.add(v);
    await dev.engine.forget();
    dev.db.m.clear(); dev.open = null; dev.live.clear(); dev.frozen.clear(); dev.snaps = []; dev.tester = false;
    make(dev);
    await dev.engine.verified();
  }

  // crypto.subtle.digest settles on Node's thread pool, so work left running in the background would interleave with
  // the next op differently on every run: let every engine go idle between ops (mid-request edits still interleave).
  async function drain(force = false) {
    if (OVERLAP && !force) return;
    for (let i = 0; i < 200_000 && devices.some((d) => d.engine.busy() || d.tab2.engine.busy()); i++) await tick(); // setImmediate: no timer-tick waits
  }
  async function cycle(dev) {
    if (dev.tester) return;
    for (let i = 0; i < 3; i++) { await dev.engine.run({ pull: true }); await tick(); if (!dev.engine.busy()) return; }
  }
  async function op(dev) {
    const label = (s) => { trail.push(`${dev.name}:${s}`); where = `${dev.name} ${s} (op ${trail.length})`; };
    if (!dev.tester && chance(0.14)) return tab2Op(dev);
    if (dev.running) {
      const r = rnd();
      const at = `${dev.running.tid}/${dev.running.eid}`;
      if (r < 0.5) { label(`settle ${at}`); return settle(dev); }
      if (r < 0.62) { label(`crash ${at}`); return crash(dev); }
      if (r < 0.72) { label(`tab2 ${at}`); return secondTab(dev); }
      if (r < 0.9) { label('sync*'); return cycle(dev); }
      label('canva*'); return canva(dev);
    }
    const r = rnd();
    const editable = dev.open && !dev.frozen.has(dev.open.id) && !testerTids.has(dev.open.id) === !dev.tester;
    if (r < 0.1 || (!dev.open && r < 0.3)) { label(`new ${dev.name}t${dev.n + 1}`); return newThread(dev); }
    if (r < 0.32 && editable) { label(`send ${dev.open.id}`); return send(dev); }
    if (r < 0.46 && editable) { label(`retry ${dev.open.id}`); return retry(dev); }
    if (r < 0.5 && editable) { label(`rename ${dev.open.id}`); return rename(dev, dev.open); }
    if (r < 0.6) { const ids = [...dev.db.m.keys()]; const id = pick(ids); label(`open ${id}`); return openThread(dev, id); }
    if (r < 0.65 && !dev.tester) { label('canva'); return canva(dev); }
    if (r < 0.69 && !dev.tester) { const ids = [...dev.db.m.keys()].filter((id) => !dev.frozen.has(id)); if (ids.length) { const id = pick(ids); label(`delete ${id}`); return deleteThread(dev, id); } }
    if (r < 0.71 && !dev.offline && !dev.tester) {
      const { items } = await dev.engine.trash().catch(() => ({ items: [] }));
      if (items.length) { const it = pick(items); label(`restore ${it.id}`); await dev.engine.restore(it.key).catch(() => {}); }
      return;
    }
    if (r < 0.82) { label('sync'); return cycle(dev); }
    if (r < 0.9) { dev.offline = !dev.offline; label(dev.offline ? 'offline' : 'online'); return; }
    if (r < 0.91) {
      const k = pick(r2.keys('t/'));
      if (!k) return;
      label(`server loses ${k}`);
      // what only the server held (no device has it any more) goes with it: that is the injected fault, not sync's doing
      const here = new Set(devices.flatMap((d) => [...d.db.m.values(), ...(d.open ? [d.open] : []), ...(d.tab2.open ? [d.tab2.open] : [])].flatMap(versionsIn)));
      for (const e of r2.json(k).entries) { const v = vid(docText(e.d)); if (v && !here.has(v)) faultOk.add(v); }
      await r2.delete(k);
      // the server no longer holds an answer for this thread: a device's recovered copy may now be the first one back
      // (every version must still survive: invariant 2 — the others keep theirs, as forks if they differ)
      lostTids.add(k.slice(2, -5));
      return;
    }
    if (r < 0.92 && !dev.tester) { label('clear'); return clearDevice(dev); }
    if (r < 0.95) { // a few threads made in LinkedIn tester mode on this browser, then the owner is back
      label('tester thread'); await openThread(dev, null); dev.tester = true; await newThread(dev); dev.open = null; dev.tester = false;
      await dev.engine.verified();
      return;
    }
    label('idle');
  }

  // ── invariants ──
  const contentOf = (t) => t && { title: t.title, entries: t.entries.map((e) => canonical(strip(e))) };
  function threadsOf(dev) {
    const out = new Map();
    for (const [id, t] of dev.db.m) if (!testerTids.has(id)) out.set(id, id === dev.open?.id ? dev.open : t);
    return out;
  }
  async function converged() {
    const [a, ...rest] = devices.map(threadsOf);
    for (const b of rest) {
      if (a.size !== b.size) return false;
      for (const [id, t] of a) if (canonical(contentOf(t)) !== canonical(contentOf(b.get(id)))) return false;
    }
    for (const d of devices) if ((await d.store.entries('d:')).some(([k]) => !testerTids.has(k.slice(2))) || (await d.store.entries('del:')).length) return false;
    // every open copy (either tab) holds what IndexedDB holds: a stale one would write older work back over newer
    for (const d of devices) {
      for (const o of [d.open, d.tab2.open]) {
        if (!o || testerTids.has(o.id)) continue;
        const stored = d.db.m.get(o.id);
        if (!stored || canonical(contentOf(o)) !== canonical(contentOf(stored))) { staleOpen = `${d.name} ${o === d.open ? 'tab 1' : 'tab 2'} ${o.id}: [${brief(o)}] vs IndexedDB [${brief(stored)}]`; return false; }
      }
    }
    return true;
  }
  let staleOpen = '';
  async function quiesce(round) {
    for (const d of devices) {
      if (d.running) { trail.push(`${d.name}:end ${d.running.tid}/${d.running.eid}`); where = `${d.name} end of round`; await (chance(0.8) ? settle(d) : crash(d)); }
      if (d.tab2.running) await tab2Settle(d);
      d.offline = false; d.tester = false;
    }
    await drain();
    faulty = true;
    const everyone = async () => { if (OVERLAP) await Promise.all(devices.map((d) => cycle(d))); else for (const d of [...devices].sort(() => rnd() - 0.5)) { await cycle(d); check(); } check(); };
    for (let i = 0; i < 3; i++) await everyone();
    faulty = false;
    for (let pass = 0; pass < 12; pass++) {
      await everyone();
      await drain(true);
      if (pass >= 1 && (await converged())) return;
    }
    const show = (t) => `"${t.title}" [${t.entries.map((e) => `${e.id}=${vid(e.text) || (e.error || '')}`).join(',')}]`;
    const all = new Set(devices.flatMap((d) => [...threadsOf(d).keys()]));
    const odd = [...all].filter((id) => new Set(devices.map((d) => canonical(contentOf(threadsOf(d).get(id)) ?? null))).size > 1);
    const lines = [];
    for (const id of odd) {
      const doc = r2.json(`t/${id}.json`);
      lines.push(`server ${id}: ${doc ? `"${doc.title}"/${doc.titleRev} rev ${doc.rev} del ${doc.deletedAt} gone ${JSON.stringify(doc.gone)} [${doc.entries.map((e) => `${e.id}@${e.rev}=${vid(docText(e.d)) || e.d.error}`).join(',')}]` : 'none'}`);
      for (const d of devices) {
        const rec = d.engine.record(id);
        lines.push(`${d.name} ${id}: ${threadsOf(d).get(id) ? show(threadsOf(d).get(id)) : 'absent'} rec ${rec ? JSON.stringify({ ...rec, e: Object.fromEntries(Object.entries(rec.e).map(([k, v]) => [k, v.r])) }) : 'none'} d ${await d.store.get(`d:${id}`)} del ${JSON.stringify(await d.store.get(`del:${id}`))} lo ${await d.store.get(`lo:${id}`)} hide ${await d.store.get(`hide:${id}`)}`);
      }
    }
    fail(`round ${round}: devices did not converge\n  ${lines.join('\n  ')}${staleOpen ? `\n  open copy differs: ${staleOpen}` : ''}`);
  }
  function checkAccounted(round) {
    const ok = new Set([...deletedOk, ...clearedOk, ...supersededOk, ...faultOk]);
    for (const d of devices) for (const t of d.db.m.values()) for (const v of versionsIn(t)) ok.add(v);
    for (const d of devices) for (const o of [d.open, d.tab2.open]) if (o) for (const v of versionsIn(o)) ok.add(v);
    // Recently deleted: a delete removes what the deleting device last synced (its record's revisions), even when that
    // device was showing an interrupted copy; the snapshot keeps it restorable for 30 days (sync-spec "what can still be
    // lost" (2)). Only DELETE requests — deleteThread ops — ever write x/.
    for (const k of r2.keys('x/')) for (const e of r2.json(k).entries) { const v = vid(docText(e.d)); if (v) ok.add(v); }
    // The partial text of an interrupted retry is not a settled answer: when its thread is deleted elsewhere, the
    // recovered entry goes with it (merge_spec: gone removes recovered entries). Anywhere else it must survive.
    for (const v of partials) if (deletedTids.has(versions.get(v)?.tid)) ok.add(v);
    for (const v of [...ok]) { let p = versions.get(v)?.parent; while (p && !ok.has(p)) { ok.add(p); p = versions.get(p)?.parent; } }
    for (const [v, x] of versions) if (!ok.has(v)) fail(`round ${round}: version ${v} (made by ${x.where}, parent ${x.parent}) was lost`);
  }
  const ancestor = (a, b) => { for (let p = versions.get(b)?.parent; p; p = versions.get(p)?.parent) if (p === a) return true; return false; };
  // Invariant 5, checked when each concurrent-edit fork is decided: neither version may descend from the other (then
  // one device simply had the older copy, and the newer one should have won without a fork).
  function checkFork(dev, tid, orig, how, lv, sv) {
    if (how !== 'fork' || !lv || !sv || lostTids.has(tid)) return; // edit-vs-delete and recovered forks are expected
    // after a server loss the entry history is gone: an older copy can't be told from a concurrent edit (kept, not lost)
    let fromPartial = false;
    for (let v = lv; v && !fromPartial; v = versions.get(v)?.parent) fromPartial = partials.has(v);
    if (fromPartial) return;
    if (ancestor(lv, sv) || ancestor(sv, lv)) fail(`spurious fork on ${dev.name} of ${tid}/${orig}: local ${lv} (${versions.get(lv)?.where}, parent ${versions.get(lv)?.parent}) vs server ${sv} (${versions.get(sv)?.where}, parent ${versions.get(sv)?.parent})`);
  }
  function checkTesterThreads() { for (const id of testerTids) if (r2.has(`t/${id}.json`)) fail(`tester-mode thread ${id} reached the server`); }

  // ── run ──
  for (const d of devices) await d.engine.verified();
  for (let round = 1; round <= ROUNDS; round++) {
    trail.push(`== round ${round}`);
    for (const d of devices) d.frozen.clear();
    // a stale tab writes back a copy from two rounds ago (old[] must recognise it); that thread then waits for sync
    for (const d of devices) {
      const snap = d.snaps[0];
      if (round > 2 && snap && chance(0.35)) {
        const t = pick([...snap.values()]);
        if (t && !testerTids.has(t.id) && d.open?.id !== t.id) { trail.push(`${d.name}:stale ${t.id}`); d.frozen.add(t.id); await put(d, structuredClone(t)); }
      }
    }
    for (let i = 0; i < OPS; i++) { clock.t += 1500; await op(pick(devices)); await drain(); check(); }
    await quiesce(round);
    check();
    checkAccounted(round);
    checkTesterThreads();
    for (const d of devices) { d.snaps.push(new Map([...threadsOf(d)].map(([id, t]) => [id, structuredClone(t)]))); if (d.snaps.length > 2) d.snaps.shift(); }
    clock.t += 20 * 60_000; // history snapshots fall due between rounds
  }
  await drain(true);
  for (const d of devices) d.engine.stop();
  return { versions: versions.size, threads: threadsOf(devices[0]).size, docs: r2.keys('t/').length, trash: r2.keys('x/').length, blobs: r2.keys('b/').length };
}

test(`three devices, ${SEEDS} seeds × ${ROUNDS} rounds of random work with faults: nothing is lost, everything converges`, async () => {
  const totals = { versions: 0, threads: 0, trash: 0, blobs: 0 };
  const only = Number(process.env.SYNC_SIM_SEED || 0); // re-run one failing seed
  for (let seed = only || 1; seed <= (only || SEEDS); seed++) {
    const r = await simulate(seed);
    for (const k of Object.keys(totals)) totals[k] += r[k];
  }
  if (only) return;
  // the runs did real work (not vacuous): versions, surviving threads, trash snapshots and long-text blobs
  assert.ok(totals.versions > SEEDS * ROUNDS * 5, JSON.stringify(totals));
  assert.ok(totals.threads > SEEDS, JSON.stringify(totals));
  assert.ok(totals.trash > 0 && totals.blobs > 0, JSON.stringify(totals));
});
