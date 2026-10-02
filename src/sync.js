// Owner thread sync: /api/sync/* (sync-spec.json api_spec). One private R2 bucket, binding SYNC_BUCKET:
//   t/<id>.json         the thread document (format v1, see public/sync-merge.js), written by compare-and-swap on its
//                       R2 etag; customMetadata {v, rev, at, del, n, snap} feeds the index without reading bodies
//   b/<aa>/<sha256>     content-addressed blobs (media, long text), written once with R2's sha256 check, never deleted
//   x/<id>/<ms>.json    trash: the document just before a delete removed entries (listed/restorable for 30 days)
//   v/<id>/<rev>.json   history: the previous document, at most once per thread per 15 minutes and before a restore
//   u/usage.json        a cached sum of b/ sizes for the SYNC_QUOTA_BYTES cap, with how many are images and videos
// worker.js calls handleSync only after the deny-by-default tester router and its own passOk check, so every request
// here is the owner's. This module never reads cookies, LEDGER or ATELIER_KV, imports nothing but the shared pure
// core, and never answers 429 (to the client that status means passcodeGuard's IP lockout).
import {
  FORMAT, LIMITS, BLOB_TYPES, HASH_RE, normalizeType, canonical, sha256hex, utf8Length, checkPush, checkDelete,
  applyPush, applyDelete, applyRestore, newRefs, docMeta, docView, bornOf, reborn,
} from '../public/sync-merge.js';

const MIN = 60_000, DAY = 86_400_000, GB = 1024 ** 3;
// The owner's choices (sync-spec open_questions), kept together so they're easy to change.
export const SYNC_OPTIONS = Object.freeze({
  quotaBytes: 50 * GB, // default for SYNC_QUOTA_BYTES: new blob uploads stop (507) above it; nothing is ever deleted
  trashDays: 30, // Recently deleted: listed and restorable this long (an optional lifecycle rule expires x/ later)
  history: true, // v/ snapshots of the previous document before overwrites
  historyEveryMs: 15 * MIN, // at most one v/ snapshot per thread per interval (always one before a restore)
  historyDays: 30, // what the optional v/ lifecycle rule keeps (no "Earlier versions" UI in v1)
  usagePutMaxAgeMs: 15 * MIN, usageStatusMaxAgeMs: 60 * MIN, // when u/usage.json is recomputed from list()
  // Real R2 (measured 2026-10-01): a conditional write that loses a race returns null (casLoop re-reads and retries),
  // while concurrent unconditional writes to one key (a blob two uploads send at once, u/usage.json) can throw 10058.
  casAttempts: 5, rateLimitWaitMs: 1100, retryAfterSec: 2,
  trashListMax: 500, headParallel: 25,
});
// Clock and waits, replaceable by tests. jitter(attempt): the wait before compare-and-swap retry n grows with n
// (50-300 ms, then 100-600 ms, …), so writers that keep colliding on one thread spread out.
export const SYNC_TIMING = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), jitter: (attempt = 1) => (50 + Math.random() * 250) * Math.max(1, attempt) };

const THREAD = /^thread\/([\w-]{1,120})$/;
const BLOB = /^blob\/([0-9a-f]{64})$/;
const TRASH_KEY = /^x\/([\w-]{1,120})\/(\d{13})\.json$/;
const docKey = (id) => `t/${id}.json`;
const blobKey = (hash) => `b/${hash.slice(0, 2)}/${hash}`;
const USAGE = 'u/usage.json';
const JSON_TYPE = { contentType: 'application/json' };

const HEADERS = { 'content-type': 'application/json', 'cache-control': 'private, no-store' };
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { ...HEADERS, ...headers } });
const MESSAGES = {
  sync_disabled: 'Sync is switched off on the server.',
  sync_unconfigured: 'Sync isn’t set up on the server yet.',
  not_found: 'Not found.',
  method_not_allowed: 'That method isn’t allowed here.',
  bad_shape: 'That sync request isn’t valid.',
  bad_id: 'That sync request has an invalid id.',
  hash_mismatch: 'The data didn’t match its checksum.',
  pending: 'An unfinished response can’t be synced.',
  live_steps: 'A response that is still running can’t be synced.',
  missing_blobs: 'Some media or long text hasn’t been uploaded yet.',
  too_large: 'That request is too large.',
  thread_too_large: 'This thread is too large to sync.',
  too_many_threads: 'The server already holds the most threads it can sync.',
  length_required: 'Uploads need a Content-Length.',
  bad_type: 'That file type can’t be synced.',
  quota: 'The server’s sync storage is full. New media stays on this device.',
  sync_busy: 'Sync is busy. Try again in a moment.',
  sync_error: 'Sync storage failed. Try again shortly.',
};
const fail = (status, code, extra = {}, headers = {}) => json({ error: MESSAGES[code] || MESSAGES.bad_shape, code, ...extra }, status, headers);
const busy = () => fail(503, 'sync_busy', {}, { 'retry-after': String(SYNC_OPTIONS.retryAfterSec) });
// The kill switch: any value but empty/0/false/off/no turns every route into 503 sync_disabled.
const switchedOff = (v) => v != null && !['', '0', 'false', 'off', 'no'].includes(String(v).trim().toLowerCase());
const int = (v) => (Number.isSafeInteger(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
const quotaOf = (env) => { const q = Number(env.SYNC_QUOTA_BYTES); return Number.isFinite(q) && q > 0 ? q : SYNC_OPTIONS.quotaBytes; };
const isRateLimit = (err) => /\b10058\b|too many requests|reduce your concurrent request rate|rate.?limit/i.test(String(err?.message || err));
const isDigestError = (err) => /\b10037\b|checksum|digest/i.test(String(err?.message || err));

// handleSync(req, env, url, path) — url: the request URL; path: the /api-relative path ('sync/…'), as worker.js has
// them. The spec's handleSync(req, env, sub) form (a string third argument: the part after 'sync/') works too.
export async function handleSync(req, env, url, path) {
  // Both 503s come before any body read, so a request answers the same with or without a tester cookie.
  if (switchedOff(env?.SYNC_DISABLED)) return fail(503, 'sync_disabled');
  const bucket = env?.SYNC_BUCKET;
  if (!bucket) return fail(503, 'sync_unconfigured');
  const u = url instanceof URL ? url : new URL(req.url);
  const sub = typeof url === 'string' ? url : typeof path === 'string' ? path.replace(/^sync\/?/, '') : u.pathname.replace(/^\/api\/sync\/?/, '');
  const ctx = { req, env, bucket, url: u, now: SYNC_TIMING.now() };
  let routes, m;
  if (sub === 'index') routes = { GET: getIndex };
  else if (sub === 'status') routes = { GET: getStatus };
  else if (sub === 'trash') routes = { GET: getTrash };
  else if (sub === 'trash/restore') routes = { POST: postRestore };
  else if (sub === 'blobs/missing') routes = { POST: postMissing };
  else if ((m = THREAD.exec(sub))) { ctx.id = m[1]; routes = { GET: getThread, POST: postThread, DELETE: deleteThread }; }
  else if ((m = BLOB.exec(sub))) { ctx.hash = m[1]; routes = { GET: getBlob, PUT: putBlob }; }
  else return fail(404, 'not_found');
  const run = routes[req.method];
  if (!run) return fail(405, 'method_not_allowed', {}, { allow: Object.keys(routes).join(', ') });
  try {
    return await run(ctx);
  } catch (err) {
    console.error('sync route failed', sub.split('/')[0], String(err?.message || err).slice(0, 200));
    return fail(500, 'sync_error');
  }
}

// ── bodies ──
// A declared Content-Length over the cap → too large before a byte is read; otherwise read with a running cap.
async function readText(req, cap) {
  const declared = req.headers.get('content-length');
  if (declared != null && Number(declared) > cap) return null;
  const reader = req.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let n = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    n += r.value.byteLength;
    if (n > cap) { reader.cancel().catch(() => {}); return null; }
    chunks.push(r.value);
  }
  const all = new Uint8Array(n);
  let at = 0;
  for (const ch of chunks) { all.set(ch, at); at += ch.byteLength; }
  return new TextDecoder().decode(all);
}
async function readJson(req, cap) {
  const t = await readText(req, cap);
  if (t == null) return { big: true, body: null };
  try {
    const b = JSON.parse(t);
    return { big: false, body: b && typeof b === 'object' && !Array.isArray(b) ? b : null };
  } catch { return { big: false, body: null }; }
}

// ── R2 helpers ──
async function* listAll(bucket, prefix, withMeta) {
  let cursor;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000, ...(withMeta ? { include: ['customMetadata'] } : {}) });
    for (const o of page.objects) yield o;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
async function readDoc(bucket, id) {
  const obj = await bucket.get(docKey(id));
  if (!obj) return null;
  const text = await obj.text();
  return { doc: JSON.parse(text), etag: obj.etag, snap: int(obj.customMetadata?.snap), text };
}
// Hashes with no b/ object (head() 25 at a time). cache: Map(hash → exists) shared across compare-and-swap attempts.
async function missingBlobs(bucket, hashes, cache = new Map()) {
  const todo = hashes.filter((h) => !cache.get(h));
  for (let i = 0; i < todo.length; i += SYNC_OPTIONS.headParallel) {
    const part = todo.slice(i, i + SYNC_OPTIONS.headParallel);
    const found = await Promise.all(part.map((h) => bucket.head(blobKey(h))));
    part.forEach((h, j) => cache.set(h, Boolean(found[j])));
  }
  return hashes.filter((h) => !cache.get(h));
}
async function countThreads(bucket, stopAt) {
  let n = 0;
  for await (const o of listAll(bucket, 't/', false)) { if (o.key.endsWith('.json') && ++n >= stopAt) break; }
  return n;
}
// u/usage.json {bytes, blobs, images, videos, at}: recomputed from list('b/') (customMetadata t: the blob's type) when
// older than maxAge, otherwise trusted.
const kindOf = (t) => (/^image\//.test(t || '') ? 'images' : /^video\//.test(t || '') ? 'videos' : null);
async function getUsage(bucket, now, maxAge) {
  let u = null;
  try { const o = await bucket.get(USAGE); if (o) u = JSON.parse(await o.text()); } catch {}
  if (u && ['bytes', 'blobs', 'images', 'videos', 'at'].every((k) => Number.isFinite(u[k])) && now - u.at < maxAge && now >= u.at) return u;
  let bytes = 0, blobs = 0;
  const kinds = { images: 0, videos: 0 };
  for await (const o of listAll(bucket, 'b/', true)) { bytes += o.size || 0; blobs++; const k = kindOf(o.customMetadata?.t); if (k) kinds[k]++; }
  u = { bytes, blobs, ...kinds, at: now };
  try { await bucket.put(USAGE, JSON.stringify(u), { httpMetadata: JSON_TYPE }); } catch {}
  return u;
}
// Encoded title for trash customMetadata, cut on a character boundary to ≤ 600 characters.
function trashTitle(title) {
  let out = '';
  for (const ch of String(title || '')) {
    let e;
    try { e = encodeURIComponent(ch); } catch { e = '%EF%BF%BD'; }
    if (out.length + e.length > 600) break;
    out += e;
  }
  return out;
}
const decodeTitle = (t) => { try { return decodeURIComponent(t || ''); } catch { return ''; } };

// The compare-and-swap write loop around one document. step(cur) (cur: {doc, etag, snap, text} or null) returns
// {response} to answer without writing, or {write, json, done(etag), before?, snapshot?: 'due' | 'always' | false}.
// A failed precondition re-reads and redoes the step (up to casAttempts, with a jitter that grows each attempt); an R2
// rate-limit error waits 1.1 s; anything left → 503 sync_busy. giveUp({uncertain}) cleans up; uncertain: some write threw, so it may
// have landed with its response lost (the next attempt's re-read then finds it applied and answers as a no-op).
async function casLoop(bucket, id, step, giveUp = async () => {}) {
  let wait = 0, uncertain = false;
  for (let attempt = 0; attempt < SYNC_OPTIONS.casAttempts; attempt++) {
    if (attempt) await SYNC_TIMING.sleep(wait || SYNC_TIMING.jitter(attempt));
    wait = 0;
    const cur = await readDoc(bucket, id);
    const plan = await step(cur);
    if (plan.response) return plan.response;
    const now = SYNC_TIMING.now();
    let snap = cur?.snap || 0;
    const due = plan.snapshot === 'always' || (plan.snapshot !== false && now - snap >= SYNC_OPTIONS.historyEveryMs);
    if (cur && SYNC_OPTIONS.history && due) {
      try {
        await bucket.put(`v/${id}/${cur.doc.rev}.json`, cur.text, { httpMetadata: JSON_TYPE, customMetadata: { rev: String(cur.doc.rev), at: String(now) } });
        snap = now;
      } catch {} // best effort: history is insurance, never a reason to fail a write
    }
    if (plan.before) await plan.before(cur);
    let obj;
    try {
      obj = await bucket.put(docKey(id), plan.json, {
        onlyIf: cur ? { etagMatches: cur.etag } : new Headers({ 'If-None-Match': '*' }),
        httpMetadata: JSON_TYPE, customMetadata: docMeta(plan.write, snap),
      });
    } catch (err) {
      if (isRateLimit(err)) wait = SYNC_OPTIONS.rateLimitWaitMs;
      else { uncertain = true; console.warn('sync write retried', String(err?.message || err).slice(0, 120)); }
      continue;
    }
    if (obj) return plan.done(obj.etag);
  }
  await giveUp({ uncertain });
  return busy();
}

// ── routes ──
// GET index → {v, now, threads: [[id, etag, rev, changedAt, del, born]]}, ETag over the thread list (not now). born is the
// document's lineage (see newDoc): a client whose record has another one re-reads the whole thread.
async function getIndex({ req, bucket, now }) {
  const threads = [];
  for await (const o of listAll(bucket, 't/', true)) {
    if (!o.key.endsWith('.json')) continue;
    const meta = o.customMetadata || {};
    threads.push([o.key.slice(2, -5), o.etag, int(meta.rev), int(meta.at), meta.del === '1' ? 1 : 0, int(meta.born)]);
  }
  const etag = `"${(await sha256hex(JSON.stringify(threads))).slice(0, 32)}"`;
  const inm = req.headers.get('if-none-match');
  if (inm && inm.split(',').map((s) => s.trim().replace(/^W\//, '')).some((s) => s === etag || s === '*')) {
    return new Response(null, { status: 304, headers: { etag, 'cache-control': 'private, no-store' } });
  }
  return json({ v: FORMAT, now, threads }, 200, { etag });
}

// GET thread/:id[?since=rev]
async function getThread({ bucket, id, url }) {
  const raw = url.searchParams.get('since');
  if (raw != null && !/^\d{1,15}$/.test(raw)) return fail(400, 'bad_shape');
  const cur = await readDoc(bucket, id);
  if (!cur) return fail(404, 'not_found');
  return json(docView(cur.doc, cur.etag, raw == null ? null : Number(raw)));
}

// POST thread/:id — push a delta. body.born names the lineage its bases belong to: against a document re-created since
// (another born), no base replaces anything (applyPush answers a conflict; the pusher's restarted rules settle it).
async function postThread({ req, bucket, id }) {
  const { big, body } = await readJson(req, LIMITS.pushBody);
  if (big) return fail(413, 'too_large');
  const bad = checkPush(body);
  if (bad) return fail(bad.status, bad.code, { ...(bad.id ? { id: bad.id } : {}), ...(bad.reason ? { reason: bad.reason } : {}) });
  for (const e of body.entries) {
    const c = canonical(e.d);
    if (utf8Length(c) > LIMITS.entry) return fail(413, 'too_large', { id: e.id });
    if (await sha256hex(c) !== e.h) return fail(400, 'hash_mismatch', { id: e.id });
  }
  const heads = new Map();
  return casLoop(bucket, id, async (cur) => {
    const out = applyPush(cur ? cur.doc : null, body, SYNC_TIMING.now(), id);
    if (out.error) return { response: fail(413, 'thread_too_large') };
    const answer = (etag) => json({ ...out.response, etag });
    if (!out.changed) return { response: answer(cur ? cur.etag : null) };
    if (!cur && (await countThreads(bucket, LIMITS.threads)) >= LIMITS.threads) return { response: fail(413, 'too_many_threads') };
    const missing = await missingBlobs(bucket, newRefs(cur?.doc, out.doc, out.changedIds), heads);
    if (missing.length) return { response: fail(409, 'missing_blobs', { missing }) };
    return { write: out.doc, json: out.json, done: answer };
  });
}

// DELETE thread/:id — {v, seen: {entryId: rev}}. The pre-image goes to x/<id>/<first attempt ms>.json before each
// write that removes anything, so the trash object always matches the delete that landed.
async function deleteThread({ req, bucket, id }) {
  const { big, body } = await readJson(req, LIMITS.deleteBody);
  if (big) return fail(413, 'too_large');
  if (checkDelete(body)) return fail(400, 'bad_shape');
  const first = SYNC_TIMING.now();
  const trashKey = `x/${id}/${String(first).padStart(13, '0')}.json`;
  // The trash object goes again only when no write of this delete can have landed: a no-op re-read (another delete
  // got there first, or ours landed with its response lost) keeps it, since a duplicate pre-image restores nothing twice.
  let trashed = false;
  const dropTrash = async () => { if (trashed) { trashed = false; try { await bucket.delete(trashKey); } catch {} } };
  return casLoop(bucket, id, async (cur) => {
    if (!cur) { await dropTrash(); return { response: fail(404, 'not_found') }; }
    // seen describes the lineage the deleter knew (body.born); revisions of another lineage are unrelated, so a
    // delete across a re-creation removes nothing (kept > 0 tells the deleter to pull the thread back).
    const out = applyDelete(cur.doc, reborn(body.born, bornOf(cur.doc)) ? {} : body.seen, SYNC_TIMING.now());
    if (!out.changed) return { response: json({ v: FORMAT, rev: cur.doc.rev, etag: cur.etag, deleted: out.deleted, kept: out.kept.length, removed: 0, trashKey: null }) };
    const removes = out.removed.length > 0;
    return {
      write: out.doc, json: out.json, snapshot: false,
      before: async () => {
        if (removes) {
          await bucket.put(trashKey, cur.text, { httpMetadata: JSON_TYPE, customMetadata: { title: trashTitle(cur.doc.title), n: String(out.removed.length), rev: String(cur.doc.rev), at: String(first) } });
          trashed = true;
        }
      },
      done: (etag) => json({ v: FORMAT, rev: out.doc.rev, etag, deleted: out.deleted, kept: out.kept.length, removed: out.removed.length, trashKey: removes ? trashKey : null }),
    };
  }, ({ uncertain }) => (uncertain ? null : dropTrash()));
}

// GET trash → {v, items: [{key, id, title, deletedAt, n}]}: younger than trashDays, newest first, at most 500.
async function getTrash({ bucket, now }) {
  const items = [];
  for await (const o of listAll(bucket, 'x/', true)) {
    const m = TRASH_KEY.exec(o.key);
    if (!m || now - Number(m[2]) >= SYNC_OPTIONS.trashDays * DAY) continue;
    items.push({ key: o.key, id: m[1], title: decodeTitle(o.customMetadata?.title), deletedAt: Number(m[2]), n: int(o.customMetadata?.n) });
  }
  items.sort((a, b) => b.deletedAt - a.deletedAt || (a.key < b.key ? -1 : 1));
  return json({ v: FORMAT, items: items.slice(0, SYNC_OPTIONS.trashListMax) });
}

// POST trash/restore {key} → {v, id, rev, restored, title}. A v/ snapshot first, then the write, then the x/ key goes.
async function postRestore({ req, bucket, now }) {
  const { big, body } = await readJson(req, LIMITS.restoreBody);
  if (big) return fail(413, 'too_large');
  const m = typeof body?.key === 'string' ? TRASH_KEY.exec(body.key) : null;
  if (!m) return fail(400, 'bad_shape');
  const [key, id, ms] = m;
  if (now - Number(ms) >= SYNC_OPTIONS.trashDays * DAY) return fail(404, 'not_found');
  const obj = await bucket.get(key);
  if (!obj) return fail(404, 'not_found');
  const snap = JSON.parse(await obj.text());
  const finish = async (doc, restored, etag) => {
    try { await bucket.delete(key); } catch {}
    return json({ v: FORMAT, id, rev: doc.rev, etag, restored: restored.length, title: doc.title });
  };
  return casLoop(bucket, id, async (cur) => {
    if (!cur) return { response: fail(404, 'not_found') };
    const out = applyRestore(cur.doc, snap, SYNC_TIMING.now());
    if (out.error) return { response: fail(413, 'thread_too_large') };
    if (!out.changed) return { response: await finish(cur.doc, [], cur.etag) };
    return { write: out.doc, json: out.json, snapshot: 'always', done: (etag) => finish(out.doc, out.restored, etag) };
  });
}

// POST blobs/missing {hashes} → {v, missing}
async function postMissing({ req, bucket }) {
  const { big, body } = await readJson(req, LIMITS.missingBody);
  if (big) return fail(413, 'too_large');
  const hashes = body?.hashes;
  if (!Array.isArray(hashes) || hashes.length > LIMITS.missingHashes || !hashes.every((h) => typeof h === 'string' && HASH_RE.test(h))) return fail(400, 'bad_shape');
  return json({ v: FORMAT, missing: await missingBlobs(bucket, [...new Set(hashes)]) });
}

// PUT blob/:hash — raw bytes streamed into R2 (never buffered: 128 MB isolate), checked by R2 against the hash. Pass
// req.body itself: Content-Length is required above, which gives it the known length R2's put() insists on (a stream
// piped through anything else has none, and put() throws a TypeError).
async function putBlob({ req, env, bucket, hash, now }) {
  const type = normalizeType(req.headers.get('content-type'));
  if (!BLOB_TYPES.includes(type)) return fail(415, 'bad_type');
  const declared = (req.headers.get('content-length') || '').trim();
  if (!/^\d{1,15}$/.test(declared)) return fail(411, 'length_required');
  const length = Number(declared);
  if (length > LIMITS.blob) return fail(413, 'too_large');
  const key = blobKey(hash);
  if (await bucket.head(key)) return json({ v: FORMAT, exists: true });
  const usage = await getUsage(bucket, now, SYNC_OPTIONS.usagePutMaxAgeMs);
  const quota = quotaOf(env);
  if (usage.bytes + length > quota) return fail(507, 'quota', { quota, bytes: usage.bytes });
  try {
    await bucket.put(key, req.body ?? new Uint8Array(0), { sha256: hash, httpMetadata: { contentType: type }, customMetadata: { t: type } });
  } catch (err) {
    if (isDigestError(err)) return fail(400, 'hash_mismatch');
    // Two uploads of one blob at once (two devices, or a retry racing its first try): R2 can refuse one with 10058.
    // b/ objects are content-addressed and written only with R2's sha256 check, so one there now is this exact blob;
    // otherwise the other upload is still on the wire → 503 sync_busy, and the client retries after Retry-After.
    if (isRateLimit(err)) return (await bucket.head(key).catch(() => null)) ? json({ v: FORMAT, exists: true }) : busy();
    throw err;
  }
  const k = kindOf(type);
  try { await bucket.put(USAGE, JSON.stringify({ ...usage, bytes: usage.bytes + length, blobs: usage.blobs + 1, ...(k ? { [k]: usage[k] + 1 } : {}) }), { httpMetadata: JSON_TYPE }); } catch {} // corrected at the next recount
  return json({ v: FORMAT, created: true }, 201);
}

// GET blob/:hash → the raw bytes, as an attachment in a sandbox.
async function getBlob({ bucket, hash }) {
  const obj = await bucket.get(blobKey(hash));
  if (!obj) return fail(404, 'not_found');
  const stored = normalizeType(obj.httpMetadata?.contentType);
  return new Response(obj.body, {
    status: 200,
    headers: {
      'content-type': BLOB_TYPES.includes(stored) ? stored : 'application/octet-stream', 'content-length': String(obj.size), etag: `"${hash}"`,
      'content-disposition': 'attachment', 'content-security-policy': 'sandbox', 'cache-control': 'private, no-store',
    },
  });
}

// GET status → {v, threads, deleted, trash, blobs, images, videos, bytes, quota, at}: Settings, and the "sync is
// configured" probe.
async function getStatus({ env, bucket, now }) {
  let threads = 0, deleted = 0, trash = 0;
  for await (const o of listAll(bucket, 't/', true)) if (o.key.endsWith('.json')) { if (o.customMetadata?.del === '1') deleted++; else threads++; }
  for await (const o of listAll(bucket, 'x/', false)) { const m = TRASH_KEY.exec(o.key); if (m && now - Number(m[2]) < SYNC_OPTIONS.trashDays * DAY) trash++; }
  const u = await getUsage(bucket, now, SYNC_OPTIONS.usageStatusMaxAgeMs);
  return json({ v: FORMAT, threads, deleted, trash, blobs: u.blobs, images: u.images, videos: u.videos, bytes: u.bytes, quota: quotaOf(env), at: u.at });
}
