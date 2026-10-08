import { validVideo } from './video.js?v=85';
import { validRemix, recoverRemix } from './remix.js?v=85';

const KINDS = new Set(['ask', 'code', 'image', 'video', 'ideas', 'build']);
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string';
const validDate = value => Number.isFinite(value) && value >= 0 && value <= 8640000000000000;
const safeId = value => text(value) && /^[\w-]{1,120}$/.test(value);
// Error kinds app.js renders (errorBox); 'budget' and 'signin' are LinkedIn tester refusals (402/403/413/503, 401);
// 'cap' is the owner's own spending limits (402 owner_cap_video / owner_cap_month, Settings → Spending).
export const ERROR_KINDS = Object.freeze(['offline', 'passcode', 'key', 'rate', 'model', 'busy', 'filtered', 'stopped', 'interrupted', 'budget', 'signin', 'cap', 'error']);
// What stopped a tester request (e.budget): its scope, when a day/month/pool allowance resets (ms), and short: true when
// money was still left in that scope (the request was just bigger than what remained).
const BUDGET_SCOPES = new Set(['day', 'month', 'pool', 'call', 'paused', 'model', 'owner', 'large', 'origin']);
const validBudget = b => record(b) && BUDGET_SCOPES.has(b.scope) && (b.resetsAt == null || validDate(b.resetsAt)) && (b.short == null || b.short === true)
  && Object.keys(b).every(k => k === 'scope' || k === 'resetsAt' || k === 'short');
// Which owner spending limit stopped a request (e.cap, public/spend.js capOf): 'video' or 'month', and when the month resets.
const validCap = c => record(c) && (c.limit === 'video' || c.limit === 'month') && (c.resetsAt == null || validDate(c.resetsAt))
  && Object.keys(c).every(k => k === 'limit' || k === 'resetsAt');
export function safeMediaUrl(value) {
  if (!text(value)) return false;
  if (/^data:(image\/(png|jpe?g|webp|gif|avif)|video\/(mp4|webm));base64,[a-z\d+/=\s]+$/i.test(value)) return true;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
}
function assert(condition) { if (!condition) throw new Error('That file isn’t a valid Atelier thread backup. Nothing was imported.'); }
function checkObject(value, depth = 0) {
  assert(depth < 40);
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert(!['__proto__', 'prototype', 'constructor'].includes(key));
    checkObject(child, depth + 1);
  }
}
export function validateBackup(data) {
  assert(record(data) && data.app === 'atelier' && data.v === 1 && Array.isArray(data.threads) && data.threads.length <= 10000);
  checkObject(data);
  for (const t of data.threads) {
    assert(record(t) && safeId(t.id) && text(t.title) && validDate(t.createdAt) && validDate(t.updatedAt) && Array.isArray(t.entries));
    for (const e of t.entries) {
      assert(record(e) && safeId(e.id) && KINDS.has(e.kind) && text(e.prompt) && validDate(e.createdAt));
      for (const key of ['text', 'think', 'enhanced', 'error', 'from']) if (e[key] != null) assert(text(e[key]));
      if (e.errorKind != null) assert(text(e.errorKind) && /^[a-z]{1,20}$/.test(e.errorKind)); // rendered as a data attribute
      if (e.budget != null) assert(validBudget(e.budget));
      if (e.cap != null) assert(validCap(e.cap));
      if (e.params != null) assert(record(e.params));
      if (e.meta != null) assert(record(e.meta) && (e.meta.model == null || text(e.meta.model)));
      if (e.images != null) assert(Array.isArray(e.images) && e.images.every(safeMediaUrl));
      if (e.media != null) assert(Array.isArray(e.media) && e.media.every(m => record(m) && ['image', 'video'].includes(m.type) && safeMediaUrl(m.src)));
      if (e.app != null) assert(record(e.app) && text(e.app.html) && text(e.app.title));
      if (e.ideas != null) assert(Array.isArray(e.ideas) && e.ideas.every(i => record(i) && text(i.title) && text(i.pitch) && (i.tags == null || Array.isArray(i.tags) && i.tags.every(text))));
      if (e.group) assert(text(e.from));
      if (e.video != null) assert(validVideo(e.video)); // poster + frames as image data URLs; the video itself is never stored
      if (e.videoOf != null) assert(safeId(e.videoOf));
      if (e.remix != null) assert(validRemix(e.remix)); // Video Remix: shots, ops, blob keys and posters are checked
      if (e.remixOf != null) assert(safeId(e.remixOf));
      if (e.refineOf != null) assert(safeId(e.refineOf)); // Build: the version this one changed (builds.js)
      if (e.baseAt != null) assert(validDate(e.baseAt)); // Build: when Restore made it the base for the next change
      // What makes a later accounts-agent turn ask first (context.js threadTaint): the mark of link / share text, a live
      // web answer's search count, a restored-from-backup flag. Only these shapes: the app tests them for truth.
      if (e.untrusted != null) assert(text(e.untrusted) && e.untrusted.length <= 20);
      if (e.web != null) assert(Number.isSafeInteger(e.web) && e.web >= 0);
      if (e.imported != null) assert(e.imported === true);
      if (e.untrustedFiles != null) assert(e.untrustedFiles === true); // only the shared photos / video marked it (submit)
    }
  }
  return data.threads;
}
// What an imported entry keeps of its agent steps: a settled record of each (never awaiting or running, so no approval
// card comes back), enough for the agent's rules about the thread — an earlier account read withdraws web search
// (app.js runAgent readBefore), an earlier page read or Claude history read holds back reads (context.js threadTaint).
const STEP_DONE = new Set(['done', 'error', 'declined']);
const short = (v, n) => (text(v) ? v.slice(0, n) : '');
export function importedSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps.filter(record).slice(0, 200).map(st => ({
    id: short(st.id, 120) || 'step', name: short(st.name, 120), label: short(st.label, 200) || short(st.name, 120), ...(text(st.service) ? { service: short(st.service, 40) } : {}),
    args: record(st.args) ? structuredClone(st.args) : {}, write: st.write === true,
    status: STEP_DONE.has(st.status) ? st.status : st.status === 'awaiting' ? 'declined' : 'error',
    ...(text(st.error) ? { error: short(st.error, 500) } : st.status === 'running' ? { error: 'Interrupted.' } : {}),
    ...(text(st.untrusted) && st.untrusted ? { untrusted: st.untrusted === 'link' ? 'link' : 'share' } : {}),
    ...(st.outside === true ? { outside: true } : {}), // GitHub content from outside your accounts (context.js readsPage)
  })).filter(st => st.name);
}
export function prepareImport(data, makeId) {
  // New IDs preserve existing work. Imported approvals must never remain actionable (importedSteps settles them).
  // Every imported entry is marked imported: a backup file can come from anywhere, and an entry without a link / share
  // mark in it is not proof the text was the owner's (older backups predate the mark), so a later accounts-agent turn
  // in that thread asks before reading (context.js threadTaint).
  return validateBackup(data).map(t => {
    const id = makeId(), ids = new Map();
    const entries = t.entries.map(e => {
      const copy = { ...structuredClone(e), id: makeId(), pending: false, steps: importedSteps(e.steps), imported: true,
        ...(e.pending ? { error: 'This response was interrupted before the backup was made. You can try again.', errorKind: 'interrupted' } : {}) };
      delete copy.startedAt; // transient: only meaningful while a generation is live
      recoverRemix(copy, { imported: true }); // shots → missing/unknown/failed, approval dropped: nothing imported can spend
      if (!ids.has(e.id)) ids.set(e.id, copy.id);
      return copy;
    });
    // A video follow-up points at its source entry: keep that link on the new IDs (drop it if the source isn't here).
    for (const e of entries) if (e.videoOf != null) { if (ids.has(e.videoOf)) e.videoOf = ids.get(e.videoOf); else delete e.videoOf; }
    for (const e of entries) if (e.remixOf != null) { if (ids.has(e.remixOf)) e.remixOf = ids.get(e.remixOf); else delete e.remixOf; }
    for (const e of entries) if (e.refineOf != null) { if (ids.has(e.refineOf)) e.refineOf = ids.get(e.refineOf); else delete e.refineOf; }
    // A remix revision names its original: follow the new IDs (a missing original leaves the id: the revision then uses
    // its own basePlan). srcEntry is left alone — it only ever finds a File on this device.
    for (const e of entries) if (e.remix?.reviseOf != null && ids.has(e.remix.reviseOf)) e.remix.reviseOf = ids.get(e.remix.reviseOf);
    return { ...structuredClone(t), id, entries };
  });
}
export function recoverThread(thread) {
  if (!thread) return thread;
  for (const entry of thread.entries || []) {
    // Video Remix shots are NOT recovered here: a thread opened from IndexedDB may have been pulled from another device
    // (its live shots belong there), and this device's own live shots are settled by remix-app's boot() from rx:job.
    if (entry.pending) {
      entry.pending = false;
      entry.recovered = true; // owner thread sync: never pushed over an answer the server already has
      entry.error = 'This response was interrupted when the studio closed. Your partial work is saved; you can try again.';
      delete entry.stage; delete entry.status;
    }
  }
  return thread;
}
// Opens the old "atelier" database for the one-time thread copy (app.js migrateOldThreads), waiting at most ms.
// → the connection, 'none' (it never existed: the upgrade is aborted so it isn't created), 'busy' (still opening after
// ms) or null (the open failed). An open that finishes after we stopped waiting isn't thrown away: onLate(connection)
// gets it, so a phone that is always slower than ms still brings its threads over. open: () => indexedDB.open('atelier').
export function openOldDb(open, ms, onLate) {
  return new Promise((res) => {
    let done = false, timer = null;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); res(v); } };
    timer = setTimeout(() => finish('busy'), ms);
    try {
      const r = open();
      r.onupgradeneeded = () => { finish('none'); r.transaction?.abort(); };
      r.onsuccess = () => { if (!done) finish(r.result); else if (onLate) onLate(r.result); else r.result.close(); };
      r.onerror = () => finish(null);
      r.onblocked = () => {};
    } catch { finish(null); }
  });
}
