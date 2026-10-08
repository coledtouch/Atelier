// Owner thread sync: the pure core shared by the browser engine (public/sync.js) and the Worker (src/sync.js).
// No DOM, no imports, no side effects at import. It is served publicly and holds no secrets.
//   wire form      canonical JSON, SHA-256 entry hashes, strip (drop TRANSIENT keys) + dehydrate (media and long text →
//                  content-addressed blob refs {"$b": sha256, "t": type, "n": bytes}) and hydrate back.
//   validation     validateDehydrated / checkPush / checkDelete / checkView: the server's backstop and the client's
//                  pre-check of pulled documents (full validateBackup runs on the client after hydration).
//   server merges  applyPush / applyDelete / applyRestore over the thread document (per-entry revisions; updatedAt
//                  never decides anything).
//   client plans   planPull / planPush / planPushResult → a plan of slots; applyPlan merges it into a local thread in
//                  place after re-checking each entry's exact snapshot (snapOf), so nothing the user did meanwhile is
//                  clobbered. quickPrint is the portable whole-content print other tabs compare.
// Spec: sync-spec.json (storage_spec, api_spec, merge_spec). Thread documents are format v1:
//   { v, id, createdAt, title, titleRev, rev, changedAt, deletedAt, gone: {entryId: revAtDelete},
//     entries: [{ id, rev, s, h, hh, createdAt, d }] }   (s = document rev of the entry's last change, h = sha256 of
//   canonical(d), hh = up to 3 older h values, d = the stripped, dehydrated entry; entries sorted by (createdAt, id)).

export const FORMAT = 1;
const KB = 1024, MB = 1024 * KB;
export const LIMITS = Object.freeze({
  inline: 32768, // strings longer than this (UTF-16 units) travel as text blobs
  entry: 2 * MB, // one dehydrated entry (canonical JSON, UTF-8); larger ones stay on the device
  doc: 8 * MB, docEntries: 5000, threads: 10000, // one thread document; threads per account (matches validateBackup)
  pushBody: 8 * MB, pushEntries: 200, deleteBody: 1 * MB, restoreBody: 4 * KB, missingBody: 128 * KB, missingHashes: 1000,
  blob: 95 * MB, // one raw blob upload (the zone's 100 MB request-body limit)
  depth: 40, // JSON nesting, as data-safety.js checkObject
  title: 1000, hh: 3, old: 3, dead: 1000, // dead: removed entries a record still remembers
});
export const INLINE_MAX = LIMITS.inline;
// Device-local entry keys that never leave the device. 'recovered' marks a crash-recovered or interrupted entry.
export const TRANSIENT = Object.freeze(['pending', 'stage', 'status', 'startedAt', 'chars', 'recovered']);
// Marks that only ever go onto an entry and never come off it (the app sets them when the entry is made and nothing
// removes them, a retry included): 'untrusted' (its text came from a link or a share) and 'imported' (restored from a
// backup file). Both make later accounts-agent turns in the thread ask before reading (context.js threadTaint). They
// sync like any key; on top of that a pulled version that lacks one the local copy has never takes it off here: the
// mark stays and that copy goes back up (keepMarks), so another device (an old build, a bug) can't unmark it everywhere.
export const STICKY = Object.freeze(['untrusted', 'imported']);
// Identical to the data: branch of data-safety.js safeMediaUrl (tests/sync-merge.test.mjs checks parity).
export const MEDIA_RE = /^data:(image\/(png|jpe?g|webp|gif|avif)|video\/(mp4|webm));base64,[a-z\d+/=\s]+$/i;
const MEDIA_PREFIX = /^data:(image\/(png|jpe?g|webp|gif|avif)|video\/(mp4|webm));base64,/i;
// Phase gate: which media kinds a device uploads. Phase 1 synced text only (entries holding media stayed on the device);
// phase 2 turned on images, phase 3 videos. Pulls hydrate any ref regardless, so devices on different phases interoperate.
export const MEDIA_SYNC = Object.freeze({ image: true, video: true });
// Held reasons that mean "media that exists only on this device" (Clear this device and the delete confirm say so):
// the phase gate, a video waiting for Wi-Fi to upload (the client's holdBlobs), one blob over LIMITS.blob.
export const MEDIA_HELD = Object.freeze(['media', 'wifi', 'blob_too_large']);
export const TEXT_TYPE = 'text/plain;charset=utf-8';
const MEDIA_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif', 'image/avif', 'video/mp4', 'video/webm']);
export const BLOB_TYPES = Object.freeze([...MEDIA_TYPES, TEXT_TYPE]); // PUT /api/sync/blob Content-Types
export const HASH_RE = /^[0-9a-f]{64}$/;
export const ID_RE = /^[\w-]{1,120}$/;
const PROTO = new Set(['__proto__', 'prototype', 'constructor']);
export const FILE_MARGIN_MS = 15 * 60 * 1000; // a Gemini FileRef with less than this left is no longer usable
export const PRODUCED = Object.freeze(['text', 'think', 'media', 'ideas', 'app']); // what a generation produced

const record = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
export const validDate = (v) => Number.isFinite(v) && v >= 0 && v <= 8640000000000000;
export const isRev = (v) => Number.isSafeInteger(v) && v >= 0;
// An id usable as a record key: data-safety's safeId minus the names that would reach Object.prototype.
export const syncId = (v) => typeof v === 'string' && ID_RE.test(v) && !PROTO.has(v);
// Content type of a blob ref's t ('text' or a media type as written in the data: URL), or null if not allowed.
export function refType(t) {
  if (t === 'text') return TEXT_TYPE;
  const lower = typeof t === 'string' ? t.toLowerCase() : '';
  return MEDIA_TYPES.includes(lower) ? lower : null;
}
// A request/stored Content-Type folded for the allow-list ('Text/Plain; charset=UTF-8' → 'text/plain;charset=utf-8').
export const normalizeType = (ct) => String(ct || '').toLowerCase().replace(/\s+/g, '');
export const blobKind = (t) => (t === 'text' ? 'text' : /^image\//i.test(t) ? 'image' : 'video');

// ── canonical JSON + hashing ──
// JSON with object keys sorted recursively; undefined/functions are skipped in objects and null in arrays, non-finite
// numbers are null and toJSON is honoured — exactly what JSON.stringify sends, so a parsed copy hashes the same.
export function canonical(v) {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string': return JSON.stringify(v);
    case 'number': return Number.isFinite(v) ? JSON.stringify(v) : 'null';
    case 'boolean': return v ? 'true' : 'false';
    case 'object': break;
    default: return undefined;
  }
  if (typeof v.toJSON === 'function') return canonical(v.toJSON());
  if (Array.isArray(v)) return `[${v.map((x) => canonical(x) ?? 'null').join(',')}]`;
  let out = '';
  for (const k of Object.keys(v).sort()) {
    const c = canonical(v[k]);
    if (c !== undefined) out += `${out ? ',' : ''}${JSON.stringify(k)}:${c}`;
  }
  return `{${out}}`;
}
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
export const toHex = (bytes) => { let s = ''; for (const b of bytes) s += HEX[b]; return s; };
const enc = new TextEncoder();
export const utf8 = (s) => enc.encode(s);
// Lowercase hex SHA-256 of a string (UTF-8) or bytes, via Web Crypto (browsers, Workers, Node).
export async function sha256hex(data) {
  const bytes = typeof data === 'string' ? utf8(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}
export const entryHash = (d) => sha256hex(canonical(d));
// UTF-8 byte length without encoding (a lone surrogate counts 3, as TextEncoder writes U+FFFD).
export function utf8Length(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; } else n += 3;
  }
  return n;
}
const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
export const wellFormed = (s) => (typeof s.isWellFormed === 'function' ? s.isWellFormed() : !LONE.test(s));

// ── base64 (no fetch(data:): connect-src is 'self') ──
const B64_CHUNK = 4 * MB; // multiple of 4 characters
export function fromBase64(s) {
  const clean = s.replace(/\s+/g, '');
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(clean);
  const parts = [];
  let total = 0;
  for (let i = 0; i < clean.length; i += B64_CHUNK) {
    const bin = atob(clean.slice(i, i + B64_CHUNK));
    const part = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) part[j] = bin.charCodeAt(j);
    parts.push(part); total += part.length;
  }
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
export function toBase64(bytes) {
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
  let out = '';
  for (let i = 0; i < bytes.length; i += 24576) out += btoa(String.fromCharCode.apply(null, bytes.subarray(i, i + 24576))); // 3-byte aligned
  return out;
}
// Decoded length of a base64 payload without decoding it (whitespace ignored).
export function base64Length(payload) {
  const clean = payload.replace(/\s+/g, '');
  const pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(clean.length * 3 / 4) - pad);
}

// ── strip / dehydrate / hydrate ──
const setOwn = (o, k, v) => {
  if (k === '__proto__') Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
  else o[k] = v;
};
// A deep copy with JSON semantics that shares (immutable) strings, so a 60 MB data: URL isn't copied.
export function jsonClone(v) {
  if (v === null) return null;
  switch (typeof v) {
    case 'string': case 'boolean': return v;
    case 'number': return Number.isFinite(v) ? v : null;
    case 'object': break;
    default: return undefined;
  }
  if (typeof v.toJSON === 'function') return jsonClone(v.toJSON());
  if (Array.isArray(v)) return v.map((x) => { const c = jsonClone(x); return c === undefined ? null : c; });
  const out = {};
  for (const k of Object.keys(v)) { const c = jsonClone(v[k]); if (c !== undefined) setOwn(out, k, c); }
  return out;
}
// The entry as it syncs: a JSON copy without the TRANSIENT keys ('expect', 'cut', 'steps', 'canva', 'forkOf', 'meta',
// 'params'… all sync).
export function strip(entry) {
  const c = jsonClone(entry);
  for (const k of TRANSIENT) delete c[k];
  return c;
}
// Media kinds an entry holds, from a cheap prefix check (no regex over megabytes, no decoding).
export function mediaKinds(entry) {
  const kinds = new Set();
  const walk = (v, depth) => {
    if (depth > LIMITS.depth) return;
    if (typeof v === 'string') { if (v.charCodeAt(0) === 100 && MEDIA_PREFIX.test(v.slice(0, 40))) kinds.add(/^data:image/i.test(v) ? 'image' : 'video'); return; }
    if (!v || typeof v !== 'object') return;
    for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x, depth + 1);
  };
  walk(entry, 0);
  return kinds;
}
// 'media' when the phase gate keeps one of these kinds on the device, else null.
export const gateHeld = (kinds, media = MEDIA_SYNC) => ((kinds.has('image') && !media.image) || (kinds.has('video') && !media.video) ? 'media' : null);
// A 64-bit fingerprint of a WHOLE string (two FNV-style lanes over every UTF-16 unit, about 2 ms per MB) with its
// length. It only detects changes between copies the app wrote; content identity (blob refs, entry hashes) is always
// SHA-256. Nothing here samples: a one-character edit anywhere changes it.
export function fullPrint(s) {
  let a = 0x811c9dc5, b = 0x9e3779b9, i = 0;
  const n = s.length;
  for (; i + 1 < n; i += 2) {
    a = Math.imul(a ^ s.charCodeAt(i), 0x01000193);
    b = Math.imul(b ^ s.charCodeAt(i + 1), 0x01000193);
    a = Math.imul(a ^ (b >>> 13), 0x5bd1e995);
  }
  if (i < n) a = Math.imul(a ^ s.charCodeAt(i), 0x01000193);
  b = Math.imul(b ^ a, 0x01000193);
  return `${n}:${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}
const ptr = (k) => String(k).replace(/~/g, '~0').replace(/\//g, '~1');
const withoutFile = (d) => (record(d?.video) && own(d.video, 'file') ? { ...d, video: Object.fromEntries(Object.entries(d.video).filter(([k]) => k !== 'file')) } : d);
// The wire form of a local entry.
//   → { d, h, g, blobs, kinds, held, size }
//   d: stripped entry with every MEDIA_RE string and every well-formed string over INLINE_MAX replaced by a blob ref;
//   h: sha256(canonical(d)) (the record's f);  g: the same without video.file (the Gemini FileRef rewritten in place);
//   blobs: unique [{hash, t, n, kind, type, path, bytes()}] (bytes() decodes lazily);  size: canonical(d) UTF-8 bytes;
//   held: null | 'ref_key' (a literal "$b" key) | 'bad_media' (undecodable base64) | 'too_large' (> LIMITS.entry) |
//         'blob_too_large' (one media item over LIMITS.blob: it can't go up in one request, so the entry stays here;
//         found from the base64 length, before anything is decoded).
// memo (optional, the client's cache): get(path, string) → hash | undefined (or a promise of one) and set(path, string,
// hash). It is consulted for MEDIA only, and must answer only for exactly that string (the client compares with ===, or
// by length plus a print of every character), so a 60 MB clip is decoded and hashed once. Long text is hashed in full
// every time (cheap, and a same-length edit must never reuse the old blob). The phase gate is separate (gateHeld): media
// is always hashed here.
export async function dehydrate(entry, { memo = null, hash = sha256hex } = {}) {
  const d = strip(entry);
  const jobs = [], kinds = new Set();
  let refKey = false;
  const visit = (holder, key, v, path, depth) => {
    if (typeof v === 'string') {
      if (v.charCodeAt(0) === 100 && MEDIA_RE.test(v)) {
        const t = v.slice(5, v.indexOf(';'));
        kinds.add(blobKind(t));
        jobs.push({ holder, key, v, path, t });
      } else if (v.length > INLINE_MAX && wellFormed(v)) jobs.push({ holder, key, v, path, t: 'text' });
      return;
    }
    if (!v || typeof v !== 'object' || depth > LIMITS.depth + 1) return;
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) visit(v, i, v[i], `${path}/${i}`, depth + 1); return; }
    for (const k of Object.keys(v)) { if (k === '$b') refKey = true; visit(v, k, v[k], `${path}/${ptr(k)}`, depth + 1); }
  };
  visit(null, null, d, '', 0);
  const none = (held) => ({ d: null, h: null, g: null, blobs: [], kinds, held, size: 0 });
  if (refKey) return none('ref_key');
  for (const j of jobs) if (j.t !== 'text' && base64Length(j.v.slice(j.v.indexOf(',') + 1)) > LIMITS.blob) return none('blob_too_large');
  const blobs = new Map();
  for (const j of jobs) {
    let h = j.t === 'text' ? undefined : await memo?.get(j.path, j.v), n, bytes;
    if (j.t === 'text') {
      bytes = () => utf8(j.v);
      n = utf8Length(j.v);
      h = await hash(bytes());
    } else {
      const payload = j.v.slice(j.v.indexOf(',') + 1);
      bytes = () => fromBase64(payload);
      if (h) n = base64Length(payload);
      else {
        let raw;
        try { raw = bytes(); } catch { return none('bad_media'); }
        n = raw.length;
        h = await hash(raw);
      }
      memo?.set(j.path, j.v, h);
    }
    j.holder[j.key] = { $b: h, t: j.t, n };
    if (!blobs.has(h)) blobs.set(h, { hash: h, t: j.t, n, kind: blobKind(j.t), type: refType(j.t), path: j.path, bytes });
  }
  const c = canonical(d), size = utf8Length(c);
  if (size > LIMITS.entry) return { ...none('too_large'), size };
  const h = await hash(c);
  const g = own(d.video, 'file') && record(d.video) ? await hash(canonical(withoutFile(d))) : h;
  return { d, h, g, blobs: [...blobs.values()], kinds, held: null, size };
}
export const isRef = (v) => record(v) && own(v, '$b');
export function validRef(v) {
  if (!record(v)) return false;
  const keys = Object.keys(v).sort();
  return keys.length === 3 && keys[0] === '$b' && keys[1] === 'n' && keys[2] === 't' && typeof v.$b === 'string' && HASH_RE.test(v.$b)
    && refType(v.t) !== null && Number.isSafeInteger(v.n) && v.n >= 0 && v.n <= LIMITS.blob;
}
// Every blob hash a dehydrated value references.
export function refsOf(d, out = new Set()) {
  if (!d || typeof d !== 'object') return out;
  if (isRef(d)) { if (typeof d.$b === 'string') out.add(d.$b); return out; }
  for (const x of Array.isArray(d) ? d : Object.values(d)) refsOf(x, out);
  return out;
}
// The value a ref stands for, from what getBlob returned: a string is used as is (the client reusing a local copy);
// bytes become the UTF-8 text or a data: URL whose type comes only from the allow-list.
export function refValue(ref, got) {
  if (typeof got === 'string') return got;
  const bytes = got instanceof Uint8Array ? got : new Uint8Array(got);
  if (ref.t === 'text') return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!refType(ref.t)) throw new Error('blob type not allowed');
  return `data:${ref.t};base64,${toBase64(bytes)}`;
}
// d → { entry, missing }. getBlob(ref, path) → Uint8Array | ArrayBuffer | string | null. Any null → entry null and
// the missing hashes (the client parks the entry until they arrive).
export async function hydrate(d, getBlob) {
  const out = jsonClone(d), jobs = [];
  const visit = (holder, key, v, path) => {
    if (!v || typeof v !== 'object') return;
    if (holder && isRef(v)) { jobs.push({ holder, key, ref: v, path }); return; }
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) visit(v, i, v[i], `${path}/${i}`); return; }
    for (const k of Object.keys(v)) visit(v, k, v[k], `${path}/${ptr(k)}`);
  };
  visit(null, null, out, '');
  const missing = new Set();
  for (const j of jobs) {
    if (!validRef(j.ref)) throw new Error('bad blob ref');
    const got = await getBlob(j.ref, j.path);
    if (got == null) { missing.add(j.ref.$b); continue; }
    j.holder[j.key] = refValue(j.ref, got);
  }
  return missing.size ? { entry: null, missing: [...missing] } : { entry: out, missing: [] };
}

// ── validation ──
// A dehydrated entry as the server stores it → null, or why not: 'bad_shape' | 'pending' (422) | 'live_steps' (422) |
// 'transient' | 'too_deep' | 'proto_key' | 'inline_media' | 'long_string' | 'bad_ref'. A lone-surrogate string can't
// be a UTF-8 text blob, so it may stay inline at any length (the 2 MiB entry cap still bounds it).
export function validateDehydrated(d) {
  if (!record(d) || !syncId(d.id)) return 'bad_shape';
  if (d.pending === true) return 'pending';
  if (Array.isArray(d.steps) && d.steps.some((s) => record(s) && (s.status === 'running' || s.status === 'awaiting'))) return 'live_steps';
  for (const k of TRANSIENT) if (own(d, k)) return 'transient';
  let bad = null;
  const walk = (v, depth) => {
    if (bad) return;
    if (depth >= LIMITS.depth) { bad = 'too_deep'; return; }
    if (typeof v === 'string') {
      if (v.charCodeAt(0) === 100 && MEDIA_RE.test(v)) bad = 'inline_media';
      else if (v.length > INLINE_MAX && wellFormed(v)) bad = 'long_string';
      return;
    }
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (own(v, '$b')) { if (!validRef(v)) bad = 'bad_ref'; return; }
    for (const k of Object.keys(v)) { if (PROTO.has(k)) { bad = 'proto_key'; return; } walk(v[k], depth + 1); }
  };
  walk(d, 0);
  return bad;
}
const badBody = (code, extra = {}) => ({ status: 400, code, ...extra });
// POST /api/sync/thread/:id body → null, or {status, code, id?, reason?}. h is checked separately (async).
export function checkPush(body) {
  if (!record(body) || body.v !== FORMAT || !validDate(body.createdAt) || !Array.isArray(body.entries) || body.entries.length > LIMITS.pushEntries) return badBody('bad_shape');
  if (!(body.born == null || validDate(body.born))) return badBody('bad_shape');
  if (body.title != null && !(record(body.title) && typeof body.title.v === 'string' && body.title.v.length <= LIMITS.title && isRev(body.title.base))) return badBody('bad_shape');
  const ids = new Set();
  for (const e of body.entries) {
    if (!record(e) || typeof e.h !== 'string' || !HASH_RE.test(e.h) || !isRev(e.base) || !validDate(e.createdAt) || !record(e.d)) return badBody('bad_shape', syncId(e?.id) ? { id: e.id } : {});
    if (!syncId(e.id) || e.d.id !== e.id || ids.has(e.id)) return badBody('bad_id', syncId(e.id) ? { id: e.id } : {});
    ids.add(e.id);
    const why = validateDehydrated(e.d);
    if (why === 'pending' || why === 'live_steps') return { status: 422, code: why, id: e.id };
    if (why) return badBody('bad_shape', { id: e.id, reason: why });
  }
  return null;
}
// DELETE /api/sync/thread/:id body → null or {status, code}.
export function checkDelete(body) {
  if (!record(body) || body.v !== FORMAT || !record(body.seen) || !(body.born == null || validDate(body.born))) return badBody('bad_shape');
  const keys = Object.keys(body.seen);
  if (keys.length > LIMITS.docEntries * 4 || !keys.every((k) => syncId(k) && isRev(body.seen[k]))) return badBody('bad_shape');
  return null;
}
// A pulled thread view (GET /api/sync/thread/:id) → null or why it can't be planned (the client skips that thread).
export function checkView(view, id) {
  if (!record(view)) return 'bad_shape';
  if (Number.isFinite(view.v) && view.v > FORMAT) return 'upgrade';
  if (view.v !== FORMAT || view.id !== id || !syncId(id) || !isRev(view.rev) || !isRev(view.titleRev) || typeof view.title !== 'string'
    || !validDate(view.createdAt) || !validDate(view.changedAt) || !(view.deletedAt === null || validDate(view.deletedAt))
    || !record(view.gone) || !Object.entries(view.gone).every(([k, r]) => syncId(k) && isRev(r)) || !Array.isArray(view.entries)
    || !(view.born == null || validDate(view.born))) return 'bad_shape';
  const ids = new Set();
  for (const e of view.entries) {
    if (!record(e) || !syncId(e.id) || ids.has(e.id) || !isRev(e.rev) || e.rev < 1 || !isRev(e.s) || typeof e.h !== 'string' || !HASH_RE.test(e.h)
      || !validDate(e.createdAt) || !record(e.d) || e.d.id !== e.id) return 'bad_shape';
    ids.add(e.id);
  }
  return null;
}
// Per-entry check of a pulled entry → null or reason; the client quarantines it ('q:') instead of applying it.
export const checkPulledEntry = (e) => validateDehydrated(e.d);

// ── server: document merges (pure; src/sync.js wraps them in a compare-and-swap loop) ──
// born: the server clock when this document was created — its lineage. Revisions only mean something within one
// lineage: a document the server lost and a device re-created starts again at rev 1 with a new born.
export const newDoc = (id, createdAt, now) => ({ v: FORMAT, id, createdAt, born: now, title: '', titleRev: 0, rev: 0, changedAt: now, deletedAt: null, gone: {}, entries: [] });
export const bornOf = (x) => (validDate(x?.born) ? x.born : 0);
// Two lineages that are both known and differ (0 = unknown, treated as the same).
export const reborn = (a, b) => Boolean(a) && Boolean(b) && a !== b;
export const entryView = (e) => ({ id: e.id, rev: e.rev, s: e.s, h: e.h, createdAt: e.createdAt, d: e.d });
// The one entry order every device and the server agree on: (createdAt, fork after non-fork, id). A fork keeps its
// original's createdAt, so this puts it directly after the original everywhere (as on the device that made it).
const isFork = (x) => (record(x?.d) ? x.d.forkOf : x?.forkOf) != null;
export const entryOrder = (a, b) => a.createdAt - b.createdAt || isFork(a) - isFork(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
export const sortEntries = (entries) => entries.sort(entryOrder);
const copyDoc = (doc) => ({ ...doc, gone: { ...doc.gone }, entries: doc.entries.map((e) => ({ ...e, hh: [...(e.hh || [])] })) });
// Serialized document, or 'too_large' over LIMITS.doc bytes / LIMITS.docEntries entries.
export function sealDoc(doc) {
  if (doc.entries.length > LIMITS.docEntries) return { error: 'too_large', json: null };
  const json = JSON.stringify(doc);
  return utf8Length(json) > LIMITS.doc ? { error: 'too_large', json: null } : { error: null, json };
}
// R2 customMetadata for t/<id>.json; GET index and status read only these.
export const docMeta = (doc, snap = 0) => ({ v: String(FORMAT), rev: String(doc.rev), at: String(doc.changedAt), del: doc.deletedAt ? '1' : '0', n: String(doc.entries.length), snap: String(snap || 0), born: String(bornOf(doc)) });
// GET thread view. since → only entries with s > since (full: false); since 0 or beyond rev → the full document.
export function docView(doc, etag, since = null) {
  const full = since == null || since <= 0 || since > doc.rev;
  return {
    v: FORMAT, id: doc.id, createdAt: doc.createdAt, born: bornOf(doc), title: doc.title, titleRev: doc.titleRev, rev: doc.rev, etag, changedAt: doc.changedAt,
    deletedAt: doc.deletedAt, gone: doc.gone, full, entries: (full ? doc.entries : doc.entries.filter((e) => e.s > since)).map(entryView),
  };
}
// One push applied to the stored document (cur, or null when the thread is new). body passed checkPush and every h
// was verified. Per entry: in gone → dropped; new → created (rev 1); same h → no-op (converged or a resend after a lost
// response); base == stored rev → replaced; h among the stored hh → stale; otherwise a conflict (the server keeps its
// version and returns it). The title applies when its base is the current titleRev (or the stored title is empty);
// otherwise the server's stands. createdAt takes the minimum.
// body.born (the lineage the pusher's bases belong to): when it names another lineage than the stored document's (the
// server lost the thread and a device re-created it), no base means anything here — nothing is replaced (a different
// version is a conflict, the pusher's restarted rules settle it) and the title applies only to an empty one.
//   → { doc, changed, error: null | 'too_large', json, changedIds, response: {v, rev, prevRev, changedAt, deletedAt,
//       revived, title: {v, rev}, accepted, stale, conflicts, dropped} } (the server adds etag)
export function applyPush(cur, body, now, id = cur?.id) {
  const prevRev = cur ? cur.rev : 0, nextRev = prevRev + 1;
  const foreign = Boolean(cur) && reborn(validDate(body.born) ? body.born : 0, bornOf(cur));
  const doc = cur ? copyDoc(cur) : newDoc(id, body.createdAt, now);
  const byId = new Map(doc.entries.map((e) => [e.id, e]));
  const accepted = {}, stale = [], conflicts = [], dropped = [], changedIds = [];
  let changed = false, created = 0, revived = false;
  for (const pe of body.entries) {
    if (own(doc.gone, pe.id)) { dropped.push(pe.id); continue; }
    const st = byId.get(pe.id);
    if (!st) {
      const e = { id: pe.id, rev: 1, s: nextRev, h: pe.h, hh: [], createdAt: pe.createdAt, d: pe.d };
      doc.entries.push(e); byId.set(e.id, e);
      accepted[pe.id] = 1; changedIds.push(pe.id); changed = true; created++;
    } else if (st.h === pe.h) accepted[pe.id] = st.rev;
    else if (st.rev === pe.base && !foreign) {
      st.hh = [st.h, ...st.hh.filter((x) => x !== st.h && x !== pe.h)].slice(0, LIMITS.hh);
      Object.assign(st, { rev: st.rev + 1, s: nextRev, h: pe.h, createdAt: pe.createdAt, d: pe.d });
      accepted[pe.id] = st.rev; changedIds.push(pe.id); changed = true;
    } else (st.hh.includes(pe.h) ? stale : conflicts).push(entryView(st));
  }
  if (doc.deletedAt && created) { doc.deletedAt = null; revived = true; }
  const t = body.title;
  if (t && !doc.deletedAt && t.v !== doc.title && ((t.base === doc.titleRev && !foreign) || (doc.title === '' && t.v !== ''))) { doc.title = t.v; doc.titleRev += 1; changed = true; }
  if (cur && validDate(body.createdAt) && body.createdAt < doc.createdAt) { doc.createdAt = body.createdAt; changed = true; }
  let json = null, error = null;
  if (changed) {
    doc.rev = nextRev; doc.changedAt = now;
    sortEntries(doc.entries);
    ({ json, error } = sealDoc(doc));
  }
  const out = changed ? doc : cur;
  return {
    doc: out, changed, error, json, changedIds,
    response: {
      v: FORMAT, rev: out ? out.rev : 0, prevRev, born: bornOf(out), changedAt: out ? out.changedAt : null, deletedAt: out ? out.deletedAt : null, revived,
      title: { v: out ? out.title : '', rev: out ? out.titleRev : 0 }, accepted, stale, conflicts, dropped,
    },
  };
}
// Blob hashes the changed entries reference that no entry of cur already references (those need a head() check).
export function newRefs(cur, doc, changedIds) {
  const known = new Set();
  for (const e of cur?.entries || []) refsOf(e.d, known);
  const fresh = new Set();
  const ids = new Set(changedIds);
  for (const e of doc.entries) if (ids.has(e.id)) for (const h of refsOf(e.d)) if (!known.has(h)) fresh.add(h);
  return [...fresh];
}
// A rev-aware delete: removes only entries whose stored rev ≤ seen[id] (they go into gone); anything changed since
// the deleter looked, or never seen, is kept. With no entries left the document becomes a tombstone (deletedAt, title
// ''), which is kept forever so absence from the index never means "deleted". Repeating it is a no-op.
export function applyDelete(cur, seen, now) {
  const doc = { ...cur, gone: { ...cur.gone }, entries: [] };
  const removed = [], kept = [];
  for (const e of cur.entries) {
    if (own(seen, e.id) && isRev(seen[e.id]) && e.rev <= seen[e.id]) { removed.push(e.id); doc.gone[e.id] = e.rev; } else { kept.push(e.id); doc.entries.push(e); }
  }
  let changed = removed.length > 0;
  if (!doc.entries.length && !doc.deletedAt) { doc.deletedAt = now; changed = true; }
  if (changed) {
    if (!doc.entries.length && doc.title !== '') { doc.title = ''; doc.titleRev += 1; }
    doc.rev += 1; doc.changedAt = now;
  }
  const out = changed ? doc : cur;
  return { doc: out, changed, removed, kept, deleted: Boolean(out.deletedAt), json: changed ? JSON.stringify(doc) : null };
}
// Puts back the trash snapshot's entries that are now absent: out of gone, rev = max(snapshot rev, gone rev) + 1 and
// s = the new document rev, so every device pulls them again. Restores the title if the current one is empty.
export function applyRestore(cur, snap, now) {
  const nextRev = cur.rev + 1;
  const doc = { ...cur, gone: { ...cur.gone }, entries: [...cur.entries] };
  const present = new Set(doc.entries.map((e) => e.id)), restored = [];
  for (const e of Array.isArray(snap?.entries) ? snap.entries : []) {
    if (!record(e) || !syncId(e.id) || present.has(e.id)) continue;
    const rev = Math.max(isRev(e.rev) ? e.rev : 0, own(doc.gone, e.id) ? doc.gone[e.id] : 0) + 1;
    doc.entries.push({ ...e, rev, s: nextRev, hh: [...(e.hh || [])] });
    delete doc.gone[e.id];
    present.add(e.id); restored.push(e.id);
  }
  if (!restored.length) return { doc: cur, changed: false, restored, error: null, json: null };
  if (!doc.title && typeof snap.title === 'string' && snap.title) { doc.title = snap.title; doc.titleRev += 1; }
  doc.deletedAt = null; doc.rev = nextRev; doc.changedAt = now;
  sortEntries(doc.entries);
  const { json, error } = sealDoc(doc);
  return { doc, changed: true, restored, error, json };
}

// ── client: records, FileRefs, forks ──
// The 't:<threadId>' record: { etag, rev, title, titleRev, e: {entryId: {r, f, g, old}}, deleted?, tooLarge?, refetch?,
// full? }. title null = never synced (the server's title is adopted on the first pull).
export const newRecord = () => ({ etag: null, rev: 0, title: null, titleRev: 0, e: {} });
// k of an entry, or of one deleted everywhere that this device still remembers (record.dead): a restore from the trash or
// a stale tab putting the entry back is then still recognised.
const kOf = (base, id) => (own(base.e, id) ? base.e[id] : own(base.dead, id) ? base.dead[id] : undefined);
function bury(rec, id, k) {
  if (!k) return;
  const dead = { ...(rec.dead || {}) };
  delete dead[id];
  setOwn(dead, id, { r: k.r, f: k.f, g: k.g, old: [...(k.old || [])] });
  const keys = Object.keys(dead);
  for (const x of keys.slice(0, Math.max(0, keys.length - LIMITS.dead))) delete dead[x];
  rec.dead = dead;
}
function revive(rec, id) { if (own(rec.dead, id)) { rec.dead = { ...rec.dead }; delete rec.dead[id]; } }
const nextOld = (k, f) => (k?.f && k.f !== f ? [k.f, ...(k.old || [])] : [...(k?.old || [])]).filter((x, i, a) => x !== f && a.indexOf(x) === i).slice(0, LIMITS.old);
export const recordOf = (view, g, k) => ({ r: view.rev, f: view.h, g, old: nextOld(k, view.h) });
const fileOf = (x) => (record(x?.video) && record(x.video.file) ? x.video.file : null);
export const sameRef = (a, b) => canonical(a ?? null) === canonical(b ?? null);
// A Gemini FileRef the app accepts: exactly video.js validVideo's file clause (tests/sync-merge.test.mjs keeps the two
// in step; this module must stay import-free). A server copy failing it is never written into a local entry.
const FILE_NAME_RE = /^files\/[\w-]{1,80}$/, FILE_URI_RE = /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/files\/[\w-]{1,80}$/;
export const validFileRef = (f) => record(f) && typeof f.name === 'string' && FILE_NAME_RE.test(f.name) && typeof f.uri === 'string' && FILE_URI_RE.test(f.uri)
  && Number.isFinite(f.expiresAt) && f.expiresAt >= 0 && f.expiresAt <= 8640000000000000 && (f.mime == null || typeof f.mime === 'string');
// The valid FileRef with the later expiresAt; null when that one has under FILE_MARGIN_MS left (neither is usable).
export function betterFileRef(a, b, now = Date.now()) {
  const ok = validFileRef;
  const pick = ok(a) && ok(b) ? (b.expiresAt > a.expiresAt ? b : a) : ok(a) ? a : ok(b) ? b : null;
  return pick && pick.expiresAt - now > FILE_MARGIN_MS ? pick : null;
}
// A local version kept beside the original: a new id, forkOf the original, the original's createdAt (so it sorts
// right after it). Keeps 'recovered' (the UI notes an interrupted retry); drops the other transient keys.
export function forkEntry(entry, id) {
  const copy = jsonClone(entry);
  for (const k of TRANSIENT) if (k !== 'recovered') delete copy[k];
  return { ...copy, id, forkOf: entry.id, createdAt: entry.createdAt };
}
const producedOf = (d) => canonical(Object.fromEntries(PRODUCED.filter((k) => own(d, k)).map((k) => [k, d[k]])));
const hasProduced = (d) => Boolean(d) && PRODUCED.some((k) => (Array.isArray(d[k]) ? d[k].length > 0 : typeof d[k] === 'string' ? d[k].length > 0 : d[k] != null));
// A device-local version worth keeping: it produced something and that differs from the server's.
export const producedDiffers = (dLocal, dRemote) => hasProduced(dLocal) && producedOf(dLocal) !== producedOf(dRemote || {});
// g of a pulled entry view (its h when it carries no video.file).
export const viewG = async (view) => (record(view.d?.video) && own(view.d.video, 'file') ? sha256hex(canonical(withoutFile(view.d))) : view.h);
const defaultHashOf = (e) => dehydrate(e);
const isLocked = (locked, id) => (typeof locked === 'function' ? locked(id) : Boolean(locked?.has?.(id)));
// Local entry L vs server entry S (a view) with record k → { slots, k, push }. hashed = dehydrate(L) ({h, g, d}).
//   (c) L unchanged since k, a stale write-back (h in k.old), or recovered → adopt S (a recovered L that produced
//       something different is kept as a fork);
//   i/iii only video.file differs, or only L's file changed since k → adopt S with the better FileRef;
//   ii  only S's file changed since k → keep L, rebased on S, with the better FileRef;
//   v   a real concurrent edit → the id adopts S and L survives as a fork right after it.
// If S.rev < k.r the server's history of this entry restarted (it lost the document and another device re-pushed its
// copy, or storage was rolled back): S does not descend from what this device merged, so "unchanged since k" proves
// nothing. A server copy this device already moved past (S.h is k.f or in k.old) is overwritten with L; anything else
// is decided as if this device had never synced it (so a different L is kept as a fork, never dropped).
function resolveEntry(L, S, k, hashed, gS, { uid, now, restarted = false }) {
  const kS = recordOf(S, gS, k);
  // When the id takes S, the local version it held is one this device has moved past: a stale tab writing it back
  // under this id later is recognised (k.old) instead of being pushed over S. (A fork keeps that version, new id.)
  const past = (x) => ({ ...x, old: [hashed.h, ...(x.old || [])].filter((h, i, a) => h && h !== x.f && a.indexOf(h) === i).slice(0, LIMITS.old) });
  const adopt = (file) => ({ id: L.id, from: 'remote', r: S, ...(file !== undefined ? { file } : {}) });
  const fork = () => { const f = forkEntry(L, uid()); return { id: f.id, from: 'fork', entry: f }; };
  if (k && (restarted || (isRev(S.rev) && S.rev < k.r)) && !L.recovered) {
    // the server holds the newest version this device knew, and L is a stale copy of an older one: S wins
    if (S.h === k.f && k.old?.includes(hashed.h)) return { slots: [adopt()], k: { r: S.rev, f: S.h, g: gS, old: [...(k.old || [])] }, push: false, how: 'adopt' };
    if (S.h === k.f || k.old?.includes(S.h)) return { slots: [{ id: L.id, from: 'local' }], k: { r: S.rev, f: S.h, g: gS, old: [] }, push: true, how: 'rewound' };
    k = null;
  }
  if (k && (hashed.h === k.f || k.old?.includes(hashed.h))) return { slots: [adopt()], k: past(kS), push: false, how: 'adopt' };
  if (L.recovered) return producedDiffers(hashed.d, S.d) ? { slots: [adopt(), fork()], k: past(kS), push: true, how: 'recovered_fork' } : { slots: [adopt()], k: past(kS), push: false, how: 'recovered' };
  // S is a version this device pushed whose answer never arrived (k.pend): L was made on top of it, so L goes up
  // over it instead of forking against this device's own earlier write.
  if (Array.isArray(k?.pend) && k.pend.includes(S.h)) return { slots: [{ id: L.id, from: 'local' }], k: { r: S.rev, f: S.h, g: gS, old: nextOld(k, S.h).filter((x) => x !== hashed.h) }, push: true, how: 'own' };
  const fileL = fileOf(L), fileS = fileOf(S.d);
  if (hashed.g === gS || (k && hashed.g === k.g)) {
    const best = betterFileRef(fileL, fileS, now);
    return sameRef(best, fileS) ? { slots: [adopt()], k: past(kS), push: false, how: 'file' } : { slots: [adopt(best)], k: past(kS), push: true, how: 'file' };
  }
  if (k && gS === k.g) {
    const best = betterFileRef(fileL, fileS, now);
    return { slots: [{ id: L.id, from: 'local', ...(sameRef(best, fileL) ? {} : { file: best }) }], k: kS, push: true, how: 'rebase' };
  }
  return { slots: [adopt(), fork()], k: past(kS), push: true, how: 'fork' };
}
// A decision that has local entry L's id take server version S (a 'remote' slot) while S lacks a STICKY mark L has:
// the slot keeps L's marks (applyPlan puts them on the adopted copy), the result is pushed, and its hash (S's d plus
// the marks) leaves k.old so planPush sends it rather than taking it for a stale write-back. Anything else: out as is.
async function keepMarks(out, L, S) {
  const keep = STICKY.filter((k) => L?.[k] && !(record(S?.d) && S.d[k]));
  if (!keep.length || !out.slots.some((s) => s.id === L.id && s.from === 'remote')) return out;
  const d = { ...S.d };
  for (const k of keep) d[k] = jsonClone(L[k]);
  const h = await sha256hex(canonical(d));
  return { ...out, slots: out.slots.map((s) => (s.id === L.id && s.from === 'remote' ? { ...s, keep } : s)),
    k: { ...out.k, old: (out.k.old || []).filter((x) => x !== h) }, push: true, how: `${out.how}+marks` };
}
const keyOf = (s, local) => (s.from === 'remote' ? s.r : s.from === 'fork' ? s.entry : local.get(s.id));
const cmpKey = entryOrder;
// The local order with each decision in place; then every new entry — remote-only ones and this plan's forks — goes
// before the first slot with a larger entryOrder key. Every device (and the server's sort) thus agrees on the order,
// and a fork lands directly after its original.
function buildSlots(local, decisions, inserts) {
  const L = new Map((local?.entries || []).map((e) => [e.id, e]));
  const slots = [], extra = inserts.map((r) => ({ id: r.id, from: 'remote', r }));
  for (const e of local?.entries || []) for (const s of decisions.get(e.id) || [{ id: e.id, from: 'local' }]) (s.from === 'fork' ? extra : slots).push(s);
  for (const s of extra.sort((a, b) => cmpKey(keyOf(a, L), keyOf(b, L)))) {
    const key = keyOf(s, L);
    // A slot with no usable createdAt (a legacy local entry: it never syncs) is passed over, as patchInPlace sorted
    // does for the open copy, instead of being compared as NaN (which fell through to the id).
    let at = slots.findIndex((x) => { const k = keyOf(x, L); return Boolean(k) && validDate(k.createdAt) && cmpKey(k, key) > 0; });
    if (at < 0) at = slots.length;
    slots.splice(at, 0, s);
  }
  return slots;
}
// The thread as a plan sees it — its entry list, title, createdAt and an exact snapshot of every entry (snapOf) — taken
// before the plan's first await. applyPlan re-checks exactly these snapshots, so an entry changed while the plan was
// being computed (a run settling, a retry) makes the plan stale instead of being overwritten by decisions made from its
// older content.
function seen(t) {
  if (!t) return null;
  const entries = [...(t.entries || [])];
  return { id: t.id, title: t.title, createdAt: t.createdAt, entries, snaps: Object.fromEntries(entries.map((e) => [e.id, snapOf(e)])) };
}
// Everything a plan reports besides its slots. before: the local entries the plan was made from (the client takes
// portable quickPrints of the ones it replaces or removes, for other tabs, before applying it).
function finishPlan(local, slots, rec, base, extra) {
  const before = new Set((local?.entries || []).map((e) => e.id)), after = new Set(slots.map((s) => s.id));
  const added = slots.filter((s) => !before.has(s.id)).map((s) => s.id);
  const replaced = slots.filter((s) => before.has(s.id) && (s.from === 'remote' || s.file !== undefined)).map((s) => s.id);
  const removed = [...before].filter((id) => !after.has(id));
  const snaps = local?.snaps ? { ...local.snaps } : {};
  const prevK = {};
  for (const s of slots) if (s.from === 'remote') prevK[s.id] = base.e[s.id] ?? null;
  return {
    slots, snaps, before: local ? local.entries : [], prevK, record: rec, added, replaced, removed, forks: slots.filter((s) => s.from === 'fork').map((s) => s.id),
    localTitle: local ? local.title : null, ...extra,
    changed: Boolean(added.length || replaced.length || removed.length || (extra.title != null && extra.title !== local?.title) || (local && extra.createdAt !== local.createdAt)),
  };
}
// Plans merging a pulled thread view into the local thread (null when this device doesn't have it).
//   record: the 't:' record (null for none); locked: Set or (id) → bool (navigator.locks 'atelier-run:<id>');
//   live: the thread is generating (liveThreads); quarantined(id, h): this exact version was set aside;
//   hashOf(entry) → {h, g, d} (the memoized dehydrate); uid: the app's id maker;
//   orphans: ids of pending entries no tab is generating (no run lock anywhere — the client only says so where it can
//   see every tab's locks): an interrupted run's leftover, decided like a recovered entry instead of holding the whole
//   thread back for good (a tab's run that outlived a delete can save one, and no tab ever settles it).
// → { defer: null | 'busy' | 'live', slots, prints, prevK, record, title, createdAt, changedAt, push, removeThread,
//     changed, added, replaced, removed, forks, localTitle }. Nothing is ever deleted because the server lacks it:
// remote absence never removes a local entry; only gone does, and only when the local copy is unchanged since k.
export async function planPull({ local = null, record: rec0 = null, remote, now = Date.now(), uid, locked = null, live = false, quarantined = () => false, hashOf = defaultHashOf, orphans = null }) {
  local = seen(local);
  const base = rec0 || newRecord();
  const rec = { ...base, e: { ...base.e } };
  delete rec.refetch; delete rec.full; delete rec.deleted; delete rec.lost; delete rec.wait;
  // A new lineage (the server lost this thread and a device re-created it): this device's records describe the old
  // one, so nothing is adopted or removed on their say-so. The caller sends a full view here (never a delta).
  const restarted = reborn(bornOf(base), bornOf(remote));
  if (restarted && !remote.full) throw new Error('planPull: a new lineage needs a full view');
  const L = new Map((local?.entries || []).map((e) => [e.id, e]));
  const R = new Set(remote.entries.map((r) => r.id));
  const gone = remote.gone || {};
  const decisions = new Map(), inserts = [], how = {}; // how: entryId → which rule decided it (diagnostics)
  let push = false, busy = false;
  const orphan = (e) => e.pending === true && Boolean(orphans?.has?.(e.id)) && !isLocked(locked, e.id);
  const isBusy = (e) => (e.pending === true && !orphan(e)) || isLocked(locked, e.id);
  const asSeen = (e) => (e && orphan(e) ? { ...e, recovered: true } : e); // an orphan decides as a recovered entry
  for (const r of remote.entries) {
    if (quarantined(r.id, r.h)) continue;
    const l = asSeen(L.get(r.id)), k = kOf(base, r.id);
    const gR = await viewG(r);
    revive(rec, r.id);
    if (!l) { inserts.push(r); rec.e[r.id] = recordOf(r, gR, k); continue; } // new here, or known but missing: re-add
    const hashed = await hashOf(l);
    if (hashed.h === r.h) { rec.e[r.id] = recordOf(r, gR, k); continue; } // converged
    if (isBusy(l)) { busy = true; continue; }
    const out = await keepMarks(resolveEntry(l, r, k, hashed, gR, { uid, now, restarted }), l, r);
    decisions.set(r.id, out.slots); rec.e[r.id] = out.k; how[r.id] = out.how;
    if (out.push) push = true;
  }
  for (const [id, l0] of L) {
    if (!own(gone, id) || R.has(id)) continue;
    const l = asSeen(l0), k = kOf(base, id);
    bury(rec, id, k);
    delete rec.e[id];
    if (isBusy(l)) { busy = true; continue; }
    const hashed = await hashOf(l);
    if (l.recovered || (!restarted && k && (hashed.h === k.f || k.old?.includes(hashed.h)))) decisions.set(id, []);
    else { const f = forkEntry(l, uid()); decisions.set(id, [{ id: f.id, from: 'fork', entry: f }]); push = true; how[id] = 'gone_fork'; } // a real edit survives the delete
  }
  for (const id of Object.keys(rec.e)) if (own(gone, id)) { bury(rec, id, rec.e[id]); delete rec.e[id]; }
  if (remote.full) {
    for (const [id, l] of L) {
      if (R.has(id) || own(gone, id)) continue;
      const k = base.e[id];
      // the server lost it: push again (base 0), keeping what this device knows of older versions so a stale tab's copy
      // of one is still recognised — the version it last synced (k.f) included when the local copy has moved past it;
      // only the version going up now stays out of old (it must be pushable)
      if (k && k.r > 0) {
        const hl = (await hashOf(l)).h;
        const old = (hl !== k.f && k.f ? [k.f, ...(k.old || [])] : [...(k.old || [])]).filter((h, i, a) => h && h !== hl && a.indexOf(h) === i).slice(0, LIMITS.old);
        rec.e[id] = { r: 0, f: null, g: null, old };
        push = true;
        continue;
      }
      // A stale copy of an entry this device saw deleted everywhere (record.dead), which the server no longer lists
      // (it lost even the tombstone): removed again. A changed copy is real work: planPush sends it.
      const dk = !k && own(base.dead, id) ? base.dead[id] : null;
      if (!dk || isBusy(l)) continue;
      const hashed = await hashOf(l);
      if (asSeen(l).recovered || hashed.h === dk.f || dk.old?.includes(hashed.h)) { decisions.set(id, []); how[id] = 'dead'; }
    }
    // gone from the server and from here: its record goes, but what this device knew of its versions stays (record.dead),
    // so a stale tab's copy of one written back later (after the thread came back here) is still recognised as stale
    for (const id of Object.keys(rec.e)) if (!R.has(id) && !L.has(id)) { bury(rec, id, rec.e[id]); delete rec.e[id]; }
  }
  const slots = buildSlots(local, decisions, inserts);
  const tomb = Boolean(remote.deletedAt) && remote.entries.length === 0;
  const removeThread = tomb && slots.length === 0;
  if (tomb && slots.length) push = true; // unsynced local work revives the thread
  let title = null;
  if (!local) title = remote.title;
  else if (remote.titleRev > (base.titleRev || 0) || base.title == null || restarted) {
    if (remote.title !== '' && remote.title !== local.title) title = remote.title;
  }
  if (remote.titleRev > (base.titleRev || 0) || base.title == null || restarted) { rec.title = remote.title; rec.titleRev = remote.titleRev; }
  const finalTitle = title ?? local?.title ?? '';
  if (!removeThread && rec.title != null && finalTitle !== rec.title) push = true;
  rec.etag = remote.etag ?? rec.etag; rec.rev = remote.rev; rec.born = bornOf(remote) || rec.born || 0;
  if (removeThread) rec.deleted = { at: remote.deletedAt };
  const createdAt = local ? Math.min(local.createdAt, remote.createdAt) : remote.createdAt;
  // partial: a delta can't settle a local copy that lacks entries the record knows (a stale tab's older copy, say):
  // only the whole thread brings them back. The caller fetches the full view and plans again.
  const partial = Boolean(local) && !remote.full && Object.keys(base.e).some((id) => !L.has(id) && !own(gone, id));
  const plan = finishPlan(local, slots, rec, base, { id: remote.id, title, createdAt, changedAt: remote.changedAt, push, removeThread, how, partial });
  if (busy) plan.defer = 'busy';
  else if (live && (plan.changed || removeThread)) plan.defer = 'live';
  else plan.defer = null;
  return plan;
}
// Plans a push for one local thread. The client decides thread-level exclusions first ('lo:', 'hide:', 'del:',
// tooLarge, mode 'new') and passes skip. Never pushed: pending or run-locked entries (waiting), entries the phase gate
// or dehydrate holds (held), live-step entries (waiting), recovered entries with r > 0 and stale write-backs (h in
// k.old) — both set refetch, so a full pull restores the server copy.
// born: the lineage the bases belong to (0 = unknown; every body carries it, so a server that re-created the thread
// meanwhile replaces nothing on the say-so of an older lineage's revisions).
// → { id, skip, entries: [{id, base, createdAt, h, d}], blobs, sent: {id: {h, g, base}}, title: {v, base} | null,
//     createdAt, born, held: [{id, reason}], waiting: [ids], refetch, bytes, dirty }
// holdBlobs(blobs) → a held reason | null: the client keeps an entry here for now because of its blobs (a large video
// on mobile data waits for Wi-Fi: 'wifi').
export async function planPush({ thread, record: rec0 = null, locked = null, media = MEDIA_SYNC, hashOf = defaultHashOf, skip = null, holdBlobs = null }) {
  const base = rec0 || newRecord();
  // A thread without a usable createdAt still syncs: its earliest entry's (the server keeps the minimum anyway).
  const firstAt = Math.min(...(thread.entries || []).map((e) => (validDate(e?.createdAt) ? e.createdAt : Infinity)));
  const createdAt = validDate(thread.createdAt) ? thread.createdAt : Number.isFinite(firstAt) ? firstAt : 0;
  const out = { id: thread.id, skip, entries: [], blobs: [], sent: {}, title: null, createdAt, born: base.lost ? 0 : bornOf(base), held: [], waiting: [], refetch: Boolean(base.refetch), bytes: 0, dirty: false };
  if (skip) return out;
  const blobs = new Map(), present = new Set();
  // Everything decided about an entry comes from one synchronous look at it: its flags here, its content in hashOf
  // (dehydrate copies the entry before its first await). A retry starting while this plan awaits can't make the
  // snapshot of an interrupted copy look like an ordinary edit. (A custom hashOf must snapshot synchronously too.)
  const title0 = thread.title;
  for (const e of [...(thread.entries || [])]) {
    present.add(e?.id);
    if (!record(e) || !syncId(e.id) || !validDate(e.createdAt)) { out.held.push({ id: e?.id, reason: 'bad_shape' }); continue; }
    if (e.pending === true || isLocked(locked, e.id)) { out.waiting.push(e.id); continue; }
    const gate = gateHeld(mediaKinds(e), media);
    if (gate) { out.held.push({ id: e.id, reason: gate }); continue; }
    const recovered = e.recovered === true, createdAt = e.createdAt;
    const x = await hashOf(e);
    if (x.held) { out.held.push({ id: e.id, reason: x.held }); continue; }
    const k = base.e[e.id];
    // already on the server as it is (k.f): nothing to send, so nothing to wait for either
    const hold = holdBlobs && x.blobs.length && !(k && x.h === k.f && !base.lost) ? holdBlobs(x.blobs) : null;
    if (hold) { out.held.push({ id: e.id, reason: hold, bytes: x.blobs.reduce((n, bl) => n + (bl.n || 0), 0) }); continue; }
    // lost: the server lost this document; every entry goes up again (base 0), except copies k.old marks as stale
    if (k && x.h === k.f && !base.lost) continue;
    // a stale copy of an entry deleted everywhere: never pushed back; a full pull removes it again
    const dk = k ? null : kOf(base, e.id);
    if (dk && (x.h === dk.f || dk.old?.includes(x.h))) { out.refetch = true; continue; }
    // (lost: everything goes up with base 0 — the server can only create it or answer a conflict, never replace —
    // and the kept history resolves that conflict; a recovered or stale copy may be the only one left.)
    if (k && !base.lost && ((recovered && k.r > 0) || k.old?.includes(x.h))) { out.refetch = true; continue; }
    const why = validateDehydrated(x.d);
    if (why === 'live_steps' || why === 'pending') { out.waiting.push(e.id); continue; }
    if (why) { out.held.push({ id: e.id, reason: why }); continue; }
    const b = k && !base.lost ? k.r : 0;
    out.entries.push({ id: e.id, base: b, createdAt, h: x.h, d: x.d });
    out.sent[e.id] = { h: x.h, g: x.g, base: b };
    out.bytes += x.size;
    for (const bl of x.blobs) if (!blobs.has(bl.hash)) blobs.set(bl.hash, bl);
  }
  for (const id of Object.keys(base.e)) if (!present.has(id)) out.refetch = true; // known but missing here: a full pull re-adds it
  const title = typeof title0 === 'string' ? title0.slice(0, LIMITS.title) : '';
  if ((base.title == null || base.lost ? title !== '' : title !== base.title) && (out.entries.length || base.rev > 0)) out.title = { v: title, base: base.lost ? 0 : base.titleRev || 0 };
  out.blobs = [...blobs.values()];
  out.dirty = out.entries.length > 0 || out.title !== null;
  return out;
}
// Splits a push plan's entries into request bodies (≤ maxEntries each, ≤ maxBytes of entry JSON); the title rides on
// the first; each carries the plan's born when it is known. → [{v, createdAt, born?, title?, entries}]
export function pushBodies(plan, { maxEntries = LIMITS.pushEntries, maxBytes = LIMITS.pushBody - 512 * KB } = {}) {
  const bodies = [];
  const head = () => ({ v: FORMAT, createdAt: plan.createdAt, ...(validDate(plan.born) && plan.born > 0 ? { born: plan.born } : {}), entries: [] });
  let cur = null, bytes = 0;
  for (const e of plan.entries) {
    const n = utf8Length(JSON.stringify(e)) + 2;
    if (!cur || cur.entries.length >= maxEntries || (cur.entries.length && bytes + n > maxBytes)) { cur = head(); bodies.push(cur); bytes = 0; }
    cur.entries.push(e); bytes += n;
  }
  if (plan.title) { if (!bodies.length) bodies.push(head()); bodies[0].title = plan.title; }
  return bodies;
}
// Plans handling one push response (see applyPush) for the thread as it is now. sent: the plan's sent map (h, g per
// id); title: the {v, base} that was sent, if any. accepted → record; stale → adopt the server copy; conflicts →
// resolveEntry; dropped (deleted everywhere) → a real local edit forks to a new id, anything else is removed;
// prevRev ≠ record.rev → another device wrote too: pull (rev/etag are left for that pull).
// quarantined(id, h) / parked(id, h): a server version this device already set aside (failed validation) or is still
// waiting for blobs of — left unresolved, exactly as planPull leaves it (resolving it would fork the local version
// again on every push). live: the thread is generating (its run will save its own object over whatever is merged into
// IndexedDB now), so only the accepted revisions are recorded; everything else waits for a pull after the run
// (deferred: true), and the record's rev stays where it was so that pull still sees those changes.
// → the same plan shape as planPull, plus pull: boolean and deferred: boolean.
export async function planPushResult({ thread, record: rec0 = null, sent = {}, title = null, res, now = Date.now(), uid, locked = null, hashOf = defaultHashOf, quarantined = () => false, parked = () => false, live = false }) {
  thread = seen(thread);
  const base = rec0 || newRecord();
  const rec = { ...base, e: { ...base.e } };
  const restarted = reborn(bornOf(base), bornOf(res)); // the server re-created this thread since this device last looked
  const L = new Map((thread?.entries || []).map((e) => [e.id, e]));
  const decisions = new Map(), inserts = [], how = {};
  let push = false, pull = false, deferred = false;
  const isBusy = (e) => e.pending === true || isLocked(locked, e.id);
  for (const [id, rev] of Object.entries(res.accepted || {})) {
    const s = sent[id], k0 = base.e[id];
    // A copy this device had already moved past (in k.old) only goes up when the server lost the thread (record.lost:
    // it may be the only copy left). Landing it doesn't make the newer version this device knew (k.f) an older one:
    // that one stays out of old, so when another device puts it back it is never "rewound" over by this stale copy.
    const behind = Boolean(s && k0?.old?.includes(s.h));
    if (s && isRev(rev)) rec.e[id] = { r: rev, f: s.h, g: s.g, old: behind ? k0.old.filter((h) => h !== s.h) : nextOld(k0, s.h) };
  }
  if (live) {
    deferred = Boolean((res.stale || []).length || (res.conflicts || []).length || (res.dropped || []).length);
    const ours = title ? title.v : base.title ?? '';
    const titleOk = !res.title || res.title.v === ours;
    if (res.title && titleOk && isRev(res.title.rev)) { rec.title = res.title.v; rec.titleRev = res.title.rev; }
    if (!titleOk) deferred = true;
    if (!deferred && !restarted && res.prevRev === base.rev && res.etag) { rec.rev = res.rev; rec.etag = res.etag; rec.born = bornOf(res) || rec.born || 0; }
    else pull = true;
    if (!res.deletedAt) delete rec.deleted;
    const slots = buildSlots(thread, new Map(), []);
    return { ...finishPlan(thread, slots, rec, base, { id: thread?.id, title: null, createdAt: thread?.createdAt, changedAt: res.changedAt, push: false, removeThread: false, how }), pull, deferred, defer: null };
  }
  for (const [list, stale] of [[res.stale || [], true], [res.conflicts || [], false]]) {
    for (const S of list) {
      if (quarantined(S.id, S.h) || parked(S.id, S.h)) continue;
      const l = L.get(S.id), k = base.e[S.id], gS = await viewG(S);
      if (!l) { inserts.push(S); rec.e[S.id] = recordOf(S, gS, k); continue; }
      if (isBusy(l)) { pull = true; continue; }
      const hashed = await hashOf(l);
      if (hashed.h === S.h) { rec.e[S.id] = recordOf(S, gS, k); continue; }
      if (stale && (!sent[S.id] || hashed.h === sent[S.id].h)) {
        const kept = await keepMarks({ slots: [{ id: S.id, from: 'remote', r: S }], k: recordOf(S, gS, k), push: false, how: 'stale' }, l, S);
        decisions.set(S.id, kept.slots); rec.e[S.id] = kept.k;
        if (kept.push) { push = true; how[S.id] = kept.how; }
        continue;
      }
      const out = await keepMarks(resolveEntry(l, S, k, hashed, gS, { uid, now, restarted }), l, S);
      decisions.set(S.id, out.slots); rec.e[S.id] = out.k; how[S.id] = out.how;
      if (out.push) push = true;
    }
  }
  for (const id of res.dropped || []) {
    const l = L.get(id), k = kOf(base, id);
    bury(rec, id, k);
    delete rec.e[id];
    if (!l) continue;
    if (isBusy(l)) { pull = true; continue; }
    const hashed = await hashOf(l);
    if (!l.recovered && (restarted || !k || (hashed.h !== k.f && !k.old?.includes(hashed.h)))) { const f = forkEntry(l, uid()); decisions.set(id, [{ id: f.id, from: 'fork', entry: f }]); push = true; how[id] = 'dropped_fork'; } else decisions.set(id, []);
  }
  let newTitle = null;
  if (res.title && typeof res.title.v === 'string' && isRev(res.title.rev)) {
    const unchanged = thread && (title ? thread.title === title.v : base.title == null || thread.title === base.title);
    if (unchanged && thread.title !== res.title.v && res.title.v !== '') newTitle = res.title.v;
    rec.title = res.title.v; rec.titleRev = res.title.rev;
  }
  if (res.prevRev !== base.rev || restarted) pull = true; // a delta pull since base.rev (a full one for a new lineage) picks up both writes
  else if (res.etag) { rec.rev = res.rev; rec.etag = res.etag; rec.born = bornOf(res) || rec.born || 0; }
  if (!res.deletedAt) delete rec.deleted;
  const slots = buildSlots(thread, decisions, inserts);
  return { ...finishPlan(thread, slots, rec, base, { id: thread?.id, title: newTitle, createdAt: thread?.createdAt, changedAt: res.changedAt, push, removeThread: false, how }), pull, deferred, defer: null };
}

// ── client: applying a plan ──
// FNV-1a (two 32-bit lanes) over a sorted walk. Strings up to 4 KB are mixed in as they are; a longer string goes
// through longString(s), which mixes in what it returns.
const LONG = 4096;
function printWalk(v, longString) {
  let a = 0x811c9dc5, b = 0x9e3779b9;
  const mix = (s) => {
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = Math.imul(a ^ c, 0x01000193); b = Math.imul(b ^ (c + 0x5bd1), 0x01000193); }
  };
  const walk = (x) => {
    if (x === null) return mix('z');
    switch (typeof x) {
      case 'string': mix(x.length > LONG ? `l${longString(x)}` : `s${x.length}:${x}`); return;
      case 'number': mix(`n${x}`); return;
      case 'boolean': mix(x ? 't' : 'f'); return;
      case 'object': break;
      default: return;
    }
    if (Array.isArray(x)) { mix(`[${x.length}`); for (const y of x) walk(y); mix(']'); return; }
    mix('{');
    for (const k of Object.keys(x).sort()) { if (x[k] === undefined) continue; mix(`k${k.length}:${k}`); walk(x[k]); }
    mix('}');
  };
  walk(v);
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}
// A portable print of the whole content (every character of every string, long ones through fullPrint): equal
// content → equal print, on any copy in any tab. Tabs compare these when one patches its open thread from another's
// merge. Costs about 2 ms per MB of long strings, so planners use snapOf instead.
export function quickPrint(v) {
  if (v === undefined) return null;
  return printWalk(v, fullPrint);
}
// An exact, cheap snapshot of an entry for applyPlan's "changed meanwhile?" re-check: the print of everything except
// strings over 4 KB, which are kept by reference and compared with === (the same string object compares in O(1), an
// equal copy re-read from IndexedDB in one native compare). Only for the copy it was taken in; never sent anywhere.
export function snapOf(v) {
  const longs = [];
  const p = printWalk(v, (s) => { longs.push(s); return `${s.length}#${longs.length - 1}`; });
  return { p, longs };
}
export function sameSnap(v, snap) {
  if (!snap || !Array.isArray(snap.longs)) return false;
  const x = snapOf(v);
  return x.p === snap.p && x.longs.length === snap.longs.length && x.longs.every((s, i) => s === snap.longs[i]);
}
const KEEP_LOCAL = new Set(TRANSIENT.filter((k) => k !== 'recovered'));
const setFile = (e, file) => {
  if (!record(e?.video)) return;
  if (file) e.video.file = file; else delete e.video.file;
};
// Re-checks the plan against the thread (every entry's snapshot and the title; anything changed → {ok: false} and
// nothing is touched: re-plan). Then rebuilds thread.entries IN PLACE from the slots, so the open thread object is
// never swapped: a replaced entry keeps its object (keys absent remotely are deleted except TRANSIENT ones and the
// STICKY marks a slot keeps, 'recovered' is cleared, then Object.assign). hydrated: Map(entryId → hydrated remote entry); a remote slot without
// one (quarantined, or its blobs not there yet) keeps the local copy (or is left out), its record rolls back, the
// record is flagged refetch, and any fork this plan made of that local copy is left out too (the local version is
// still in place under its own id: a fork would only duplicate it, again on every retry).
// thread null → a new thread object (returned). → { ok, thread, record, skipped, added, replaced, removed, forks }
export function applyPlan(thread, plan, hydrated = new Map()) {
  const entries = thread?.entries || [];
  const snaps = plan.snaps || {};
  if (entries.length !== Object.keys(snaps).length || entries.some((e) => !own(snaps, e.id) || !sameSnap(e, snaps[e.id]))) return { ok: false };
  if (thread && thread.title !== plan.localTitle) return { ok: false };
  const t = thread || { id: plan.id, title: '', createdAt: plan.createdAt, updatedAt: plan.changedAt || 0, entries: [] };
  const byId = new Map(entries.map((e) => [e.id, e]));
  const rec = { ...plan.record, e: { ...plan.record.e } };
  const seq = [], skipped = [], unhydrated = new Set(plan.slots.filter((s) => s.from === 'remote' && !hydrated.get(s.id)).map((s) => s.id));
  for (const s of plan.slots) {
    const cur = byId.get(s.id);
    if (s.from === 'local') { if (s.file !== undefined) setFile(cur, s.file); seq.push(cur); continue; }
    if (s.from === 'fork') { if (!unhydrated.has(s.entry.forkOf)) seq.push(s.entry); continue; }
    const next = hydrated.get(s.id);
    if (!next) {
      skipped.push(s.id);
      if (cur) seq.push(cur);
      if (own(plan.prevK, s.id)) { if (plan.prevK[s.id]) rec.e[s.id] = plan.prevK[s.id]; else delete rec.e[s.id]; }
      continue;
    }
    if (s.file !== undefined) setFile(next, s.file);
    if (cur && Array.isArray(s.keep)) for (const k of s.keep) if (STICKY.includes(k) && cur[k] && !next[k]) next[k] = jsonClone(cur[k]); // keepMarks
    if (cur) {
      for (const k of Object.keys(cur)) if (!own(next, k) && !KEEP_LOCAL.has(k)) delete cur[k];
      delete cur.recovered;
      Object.assign(cur, next);
      seq.push(cur);
    } else seq.push(next);
  }
  t.entries.splice(0, t.entries.length, ...seq);
  if (plan.title != null) t.title = plan.title;
  if (Number.isFinite(plan.createdAt)) t.createdAt = plan.createdAt;
  if (plan.changed && Number.isFinite(plan.changedAt)) t.updatedAt = Math.max(t.updatedAt || 0, plan.changedAt);
  if (skipped.length) rec.refetch = true;
  const ids = new Set(seq.map((e) => e.id));
  return { ok: true, thread: t, record: rec, skipped, added: plan.added.filter((id) => ids.has(id)), replaced: plan.replaced.filter((id) => !skipped.includes(id)), removed: plan.removed, forks: plan.forks.filter((id) => ids.has(id)) };
}
