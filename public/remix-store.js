// Video Remix: what a remix keeps on this device, in the app's key/value IndexedDB ("atelier-kv", the same store
// app.js rawDB.kv* uses). Every key starts with rx: so "Clear this device" (kvClear) wipes it and a prune can find it.
//   rx:ops                 [{entryId, threadId, shotId, op, startedAt, model, seconds, res, tester}] — the shots this
//                          device started and still has to collect (≤ 50). Boot reads only this key, never DB.all().
//   rx:job:<entry>         {threadId, at, shots: {id: {state, op, uri, error, resetsAt, retryAt, queuedSince, blobKey,
//                          bytes, poster, at, …}}} — the job registry's own copy of shot state (the source of truth
//                          while the thread is closed).
//   rx:shot:<entry>:<id>   {blob, at, threadId, bytes} — a filmed shot (video/mp4)
//   rx:img:<entry>:<id>    {blob, …} — a screenshot an image layer uses
//   rx:src:<entry>         {blob, …} — the source video File (owner ≤ 500 MB, tester ≤ 200 MB)
//   rx:cut:<entry>         {blob, …} — the finished cut (the thread keeps only e.remix.export's numbers)
//   rx:plan:<entry>        {plan, shots, opts, assets, at} — the review draft, saved with a 1 s debounce
// db: {kvGet(k), kvSet(k, v), kvDel?(k), kvKeys?()} — kvDel/kvKeys arrive with the app.js A2 patch; without them a
// delete writes null and a prune only reaches the entries rx:ops and the jobs it knows about.
// No DOM; tests/remix-store.test.mjs runs it on memoryKv().

export const OPS_MAX = 50;
export const PRUNE_DAYS = 7;
export const SOURCE_MAX = Object.freeze({ owner: 500 * 1024 * 1024, tester: 200 * 1024 * 1024 });
export const DRAFT_DEBOUNCE = 1000;
const ENTRY_RE = /^[\w-]{1,120}$/;
const ID_RE = /^[a-z][\w-]{0,7}$/;
const BLOB_RE = /^rx:(shot|img|src|cut):([\w-]{1,120})(?::([a-z][\w-]{0,7}))?$/;
const TRIM = new Set(['src', 'cut', 'plan']); // what a week-old entry of a live thread loses (prune)
const KEY_RE = /^rx:(ops|job|shot|img|src|cut|plan)(?::([\w-]{1,120}))?(?::([a-z][\w-]{0,7}))?$/;

const record = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const entryOk = (id) => typeof id === 'string' && ENTRY_RE.test(id);
const need = (ok, what) => { if (!ok) throw new TypeError(`remix-store: bad ${what}`); };

export const keys = Object.freeze({
  ops: 'rx:ops',
  job: (entry) => (need(entryOk(entry), 'entry id'), `rx:job:${entry}`),
  plan: (entry) => (need(entryOk(entry), 'entry id'), `rx:plan:${entry}`),
  src: (entry) => (need(entryOk(entry), 'entry id'), `rx:src:${entry}`),
  cut: (entry) => (need(entryOk(entry), 'entry id'), `rx:cut:${entry}`),
  shot: (entry, id) => (need(entryOk(entry) && ID_RE.test(id), 'shot key'), `rx:shot:${entry}:${id}`),
  img: (entry, id) => (need(entryOk(entry) && ID_RE.test(id), 'image key'), `rx:img:${entry}:${id}`),
});
/** 'rx:shot:e1:s2' → {kind: 'shot', entry: 'e1', id: 's2'} | null (not a remix key). */
export function parseKey(k) {
  const m = typeof k === 'string' ? KEY_RE.exec(k) : null;
  if (!m) return null;
  return { kind: m[1], entry: m[2] || null, id: m[3] || null };
}

/** A Map-backed stand-in for the kv store (tests, and a session-only fallback when IndexedDB is unavailable). */
export function memoryKv(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    map: m,
    kvGet: async (k) => m.get(k),
    kvSet: async (k, v) => { m.set(k, v); },
    kvDel: async (k) => { m.delete(k); },
    kvKeys: async () => [...m.keys()],
  };
}

/**
 * The store. db: see above. opts: {now(), setTimeout, clearTimeout, storage (navigator.storage)}.
 */
export function createRemixStore(db, opts = {}) {
  const now = opts.now || (() => Date.now());
  const setT = opts.setTimeout || ((fn, ms) => setTimeout(fn, ms));
  const clearT = opts.clearTimeout || ((t) => clearTimeout(t));
  const del = (k) => (typeof db.kvDel === 'function' ? db.kvDel(k) : db.kvSet(k, null));
  // One read-modify-write at a time per key, so two shots finishing together never lose each other's patch.
  const chains = new Map();
  const serial = (k, fn) => {
    const prev = chains.get(k) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    chains.set(k, next);
    next.finally(() => { if (chains.get(k) === next) chains.delete(k); }).catch(() => {});
    return next;
  };

  // ── blobs ──
  /** key: a keys.shot/img/src/cut key. meta: {threadId}. → {blobKey, bytes}. */
  async function putBlob(key, blob, meta = {}) {
    need(BLOB_RE.test(key), 'blob key');
    need(blob && typeof blob.size === 'number', 'blob');
    await db.kvSet(key, { blob, at: now(), bytes: blob.size, ...(typeof meta.threadId === 'string' ? { threadId: meta.threadId } : {}) });
    return { blobKey: key, bytes: blob.size };
  }
  /** → the Blob/File, or null. Accepts a bare Blob stored by an older build. */
  async function getBlob(key) {
    if (!BLOB_RE.test(String(key))) return null;
    const v = await db.kvGet(key);
    if (!v) return null;
    if (record(v) && v.blob) return v.blob;
    return typeof v.size === 'number' && typeof v.slice === 'function' ? v : null;
  }
  const dropBlob = (key) => (BLOB_RE.test(String(key)) ? del(key) : Promise.resolve());

  // ── the op index ──
  async function opsAll() {
    const v = await db.kvGet(keys.ops);
    return Array.isArray(v) ? v.filter((o) => record(o) && entryOk(o.entryId) && typeof o.shotId === 'string') : [];
  }
  /** Adds or replaces the record for (entryId, shotId); keeps the newest OPS_MAX. */
  async function opsAdd(rec) {
    need(record(rec) && entryOk(rec.entryId) && ID_RE.test(rec.shotId || ''), 'op record');
    return serial(keys.ops, async () => {
      const list = (await opsAll()).filter((o) => !(o.entryId === rec.entryId && o.shotId === rec.shotId));
      list.push({ ...rec, startedAt: Number(rec.startedAt) || now() });
      list.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
      const kept = list.slice(-OPS_MAX);
      await db.kvSet(keys.ops, kept);
      return kept;
    });
  }
  /** Removes the record for (entryId, shotId), or every record of entryId when shotId is omitted. */
  async function opsRemove(entryId, shotId = null) {
    return serial(keys.ops, async () => {
      const list = await opsAll();
      const kept = list.filter((o) => !(o.entryId === entryId && (shotId == null || o.shotId === shotId)));
      if (kept.length !== list.length) await db.kvSet(keys.ops, kept);
      return kept;
    });
  }

  // ── job state ──
  async function jobGet(entryId) {
    const v = await db.kvGet(keys.job(entryId));
    return record(v) ? { threadId: v.threadId ?? null, at: v.at ?? 0, shots: record(v.shots) ? v.shots : {} } : null;
  }
  /** Merges patch into shots[shotId] (null shotId: patch the job itself, e.g. {threadId}). → the job. */
  async function jobPatch(entryId, shotId, patch = {}, threadId = undefined) {
    const k = keys.job(entryId);
    return serial(k, async () => {
      const cur = (await jobGet(entryId)) || { threadId: null, at: 0, shots: {} };
      if (threadId !== undefined) cur.threadId = threadId;
      if (shotId == null) Object.assign(cur, patch);
      else {
        need(ID_RE.test(shotId), 'shot id');
        const s = { ...(cur.shots[shotId] || {}), ...patch, at: now() };
        for (const [key, val] of Object.entries(s)) if (val === undefined) delete s[key];
        cur.shots = { ...cur.shots, [shotId]: s };
      }
      cur.at = now();
      await db.kvSet(k, cur);
      return cur;
    });
  }
  const jobDrop = (entryId) => del(keys.job(entryId));

  // ── review drafts (1 s debounce; flush on pagehide) ──
  const pending = new Map(); // entry → {timer, value}
  function draftSave(entryId, draft, { now: immediately = false } = {}) {
    const k = keys.plan(entryId);
    const value = { ...draft, at: now() };
    const prev = pending.get(entryId);
    if (prev) clearT(prev.timer);
    if (immediately) { pending.delete(entryId); return db.kvSet(k, value); }
    return new Promise((res, rej) => {
      const timer = setT(() => { pending.delete(entryId); db.kvSet(k, value).then(res, rej); }, DRAFT_DEBOUNCE);
      pending.set(entryId, { timer, value, res });
      prev?.res?.(); // a superseded save resolves: its value is in the newer one
    });
  }
  async function draftFlush() {
    const all = [...pending.entries()];
    pending.clear();
    await Promise.all(all.map(([id, p]) => { clearT(p.timer); return db.kvSet(keys.plan(id), p.value).then(() => p.res?.()); }));
  }
  /** Clear this device: pending drafts are dropped, never written. */
  function draftCancel() {
    for (const p of pending.values()) { clearT(p.timer); p.res?.(); }
    pending.clear();
  }
  async function draftLoad(entryId) {
    const p = pending.get(entryId);
    if (p) return p.value;
    const v = await db.kvGet(keys.plan(entryId));
    return record(v) ? v : null;
  }

  // ── whole entries ──
  /** Every rx:* key of one entry (its source, shots, screenshots, cut, draft, job and op records). */
  async function dropEntry(entryId, { known = [] } = {}) {
    if (!entryOk(entryId)) return 0;
    const p = pending.get(entryId);
    if (p) { clearT(p.timer); pending.delete(entryId); p.res?.(); }
    let list = [];
    if (typeof db.kvKeys === 'function') list = (await db.kvKeys()).filter((k) => parseKey(k)?.entry === entryId);
    else {
      const job = await jobGet(entryId).catch(() => null);
      list = [keys.job(entryId), keys.plan(entryId), keys.src(entryId), keys.cut(entryId),
        ...Object.keys(job?.shots || {}).filter((id) => ID_RE.test(id)).map((id) => keys.shot(entryId, id)), ...known];
    }
    await Promise.all(list.map((k) => del(k)));
    await opsRemove(entryId);
    return list.length;
  }
  /**
   * Drops remix data whose thread is gone, or that nothing touched for maxAgeDays — never an entry with a live op in
   * rx:ops (a shot still filming must be collected). liveThreadIds: a Set or array of thread ids that still exist.
   * A week-old entry whose thread still exists is only trimmed: its bulky, replaceable files go (the source video,
   * which can be attached again; the cut, which is free to make again; the draft, which the thread also holds), but
   * its filmed shots, screenshots and job record stay — they were paid for, and refilming would bill again.
   * → {dropped: [entryIds], trimmed: [entryIds]}.
   */
  async function prune({ liveThreadIds = null, maxAgeDays = PRUNE_DAYS, keep = [] } = {}) {
    const live = liveThreadIds instanceof Set ? liveThreadIds : liveThreadIds ? new Set(liveThreadIds) : null;
    const ops = await opsAll();
    const busy = new Set([...ops.map((o) => o.entryId), ...keep]);
    const cutoff = now() - maxAgeDays * 864e5;
    const entries = new Map(); // entry → {threadId, at}
    const note = (entry, threadId, at) => {
      const e = entries.get(entry) || { threadId: null, at: 0 };
      if (threadId && !e.threadId) e.threadId = threadId;
      e.at = Math.max(e.at, Number(at) || 0);
      entries.set(entry, e);
    };
    if (typeof db.kvKeys === 'function') {
      for (const k of await db.kvKeys()) {
        const p = parseKey(k);
        if (!p?.entry) continue;
        const v = await db.kvGet(k);
        note(p.entry, record(v) ? v.threadId : null, record(v) ? v.at : 0);
      }
    } else {
      for (const o of ops) note(o.entryId, o.threadId, o.startedAt);
    }
    const dropped = [], trimmed = [];
    const all = typeof db.kvKeys === 'function' ? await db.kvKeys() : null;
    for (const [entry, info] of entries) {
      if (busy.has(entry)) continue;
      const orphan = live && info.threadId && !live.has(info.threadId);
      const stale = info.at > 0 && info.at < cutoff;
      if (orphan || (stale && !(live && info.threadId && live.has(info.threadId)))) { await dropEntry(entry); dropped.push(entry); }
      else if (stale) {
        const bulky = all ? all.filter((k) => { const p = parseKey(k); return p?.entry === entry && TRIM.has(p.kind); }) : [keys.src(entry), keys.cut(entry), keys.plan(entry)];
        if (bulky.length) { await Promise.all(bulky.map((k) => del(k))); trimmed.push(entry); }
      }
    }
    return { dropped, trimmed };
  }
  /**
   * A thread was deleted: drop every remix entry filed under it (a record's threadId), except those in keep or with a
   * live op in rx:ops (still filming: collected first, then dropped by the job). → [entryIds].
   */
  async function dropThread(threadId, { keep = [] } = {}) {
    if (typeof threadId !== 'string' || !threadId || typeof db.kvKeys !== 'function') return [];
    const busy = new Set([...(await opsAll()).map((o) => o.entryId), ...keep]);
    const mine = new Set();
    for (const k of await db.kvKeys()) {
      const p = parseKey(k);
      if (!p?.entry || busy.has(p.entry) || mine.has(p.entry)) continue;
      const v = await db.kvGet(k);
      if (record(v) && v.threadId === threadId) mine.add(p.entry);
    }
    for (const entry of mine) await dropEntry(entry);
    return [...mine];
  }
  /** → {usage, quota, rxBytes, persisted} (rxBytes: the bytes of every rx:* blob this store knows of). */
  async function estimate() {
    let usage = null, quota = null, persisted = null, rxBytes = 0;
    const storage = opts.storage ?? globalThis.navigator?.storage;
    try { const e = await storage?.estimate?.(); usage = e?.usage ?? null; quota = e?.quota ?? null; } catch {}
    try { persisted = (await storage?.persisted?.()) ?? null; } catch {}
    if (typeof db.kvKeys === 'function') {
      for (const k of await db.kvKeys()) {
        if (!BLOB_RE.test(k)) continue;
        const v = await db.kvGet(k);
        rxBytes += Number(record(v) ? v.bytes ?? v.blob?.size : v?.size) || 0;
      }
    }
    return { usage, quota, rxBytes, persisted };
  }

  return { keys, putBlob, getBlob, dropBlob, opsAll, opsAdd, opsRemove, jobGet, jobPatch, jobDrop, draftSave, draftFlush, draftCancel, draftLoad, dropEntry, dropThread, prune, estimate };
}
