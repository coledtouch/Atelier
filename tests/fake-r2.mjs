// In-memory R2 bucket for the sync tests and the review fixture (a helper, not a test file). It mirrors the parts of
// the Workers R2 binding that src/sync.js relies on:
//   put(key, string | ArrayBuffer | ArrayBufferView | Blob | ReadableStream | null, {onlyIf, sha256, httpMetadata,
//       customMetadata}) → R2Object, or null when onlyIf fails ({etagMatches, etagDoesNotMatch, uploadedBefore,
//       uploadedAfter} or a Headers with If-Match / If-None-Match, '*' included); a sha256 mismatch throws (10037)
//       and stores nothing. The etag is the MD5 of the bytes, as R2's is for a single-part upload.
//   get / head → R2ObjectBody / R2Object or null;  delete(key | keys);
//   list({prefix, cursor, limit, include}) → {objects, truncated, cursor, delimitedPrefixes}; customMetadata and
//       httpMetadata only when include asks for them; pages hold at most pageSize objects, so truncation is exercised.
// As strict as real R2 where the 2026-10-01 compare-and-swap test against R2 showed it is strict (put() throws before
// any request is made, so nothing is counted or stored):
//   - an etagMatches / etagDoesNotMatch wrapped in quotes throws TypeError "Conditional ETag should not be wrapped in
//     quotes (…)." (R2Object.etag is unquoted; httpEtag is the quoted one);
//   - a ReadableStream body without a known length throws TypeError. In Workers only a request/response body with a
//     Content-Length, or the readable half of a FixedLengthStream, has one: build Requests that reach handleSync with
//     workerRequest() below (it marks the body as the runtime would), or mark a stream with knownLength();
//   - a sha256 mismatch throws R2's full multi-line 10037 message (provided and actual checksums).
// Test hooks: calls (per-operation counters), log ([op, key]), and faults:
//   failNextCas: n   the next n conditional puts answer null (as if another writer got there first)
//   rateLimitNextPut: n   the next n puts throw R2's 10058 "Reduce your concurrent request rate for the same object"
//       (real R2 throws it for concurrent unconditional writes to one key); rateLimitKey narrows it to one key
//   dropNextPut: n   the next n puts are stored, then throw (a lost response)
//   beforePut(key, options)   awaited before every put (to slip a concurrent write in)
import { createHash, randomUUID } from 'node:crypto';

const strip = (etag) => String(etag ?? '').trim().replace(/^W\//, '').replace(/^"|"$/g, '');
const etagList = (v) => String(v).split(',').map(strip);

// Streams with a known length (see the header). A WeakSet: marking never keeps a stream alive.
const KNOWN_LENGTH = new WeakSet();
export function knownLength(stream) { if (stream && typeof stream === 'object') KNOWN_LENGTH.add(stream); return stream; }
// new Request(url, init), with its body marked as having a known length when it declares a Content-Length, the way the
// Workers runtime hands an incoming request to the Worker.
export function workerRequest(url, init) {
  const req = new Request(url, init);
  if (req.body && /^\d{1,15}$/.test((req.headers.get('content-length') || '').trim())) KNOWN_LENGTH.add(req.body);
  return req;
}
const isStream = (v) => v != null && typeof v === 'object' && typeof v.getReader === 'function';
// The argument checks R2's binding makes before sending anything (TypeErrors, as on real R2).
function checkPut(value, options) {
  if (isStream(value) && !KNOWN_LENGTH.has(value)) throw new TypeError('Provided readable stream must have a known length (request/response body or readable half of FixedLengthStream)');
  const cond = options?.onlyIf;
  if (cond && typeof cond.get !== 'function') {
    for (const k of ['etagMatches', 'etagDoesNotMatch']) {
      const v = cond[k];
      if (typeof v === 'string' && /^(W\/)?".*"$/s.test(v.trim())) throw new TypeError(`Conditional ETag should not be wrapped in quotes (${v}).`);
    }
  }
}
async function toBytes(value) {
  if (value == null) return new Uint8Array(0);
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  if (typeof value.arrayBuffer === 'function' && typeof value.getReader !== 'function') return new Uint8Array(await value.arrayBuffer());
  if (typeof value.getReader === 'function') {
    const reader = value.getReader(), parts = [];
    let n = 0;
    for (;;) { const r = await reader.read(); if (r.done) break; const c = r.value instanceof Uint8Array ? r.value : new Uint8Array(r.value); parts.push(c); n += c.byteLength; }
    const out = new Uint8Array(n);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.byteLength; }
    return out;
  }
  throw new TypeError('fake R2: unsupported put value');
}
const hexOf = (v) => (typeof v === 'string' ? v.toLowerCase() : Buffer.from(v instanceof ArrayBuffer ? new Uint8Array(v) : v).toString('hex'));

export function fakeR2({ pageSize = 1000 } = {}) {
  const objects = new Map();
  const calls = { put: 0, get: 0, head: 0, delete: 0, list: 0 };
  const log = [];
  const faults = { failNextCas: 0, rateLimitNextPut: 0, rateLimitKey: null, dropNextPut: 0, beforePut: null };
  const meta = (o, include = ['httpMetadata', 'customMetadata']) => ({
    key: o.key, version: o.version, size: o.bytes.byteLength, etag: o.etag, httpEtag: `"${o.etag}"`, uploaded: new Date(o.uploaded),
    checksums: { sha256: o.sha256 }, storageClass: 'Standard',
    ...(include.includes('httpMetadata') ? { httpMetadata: { ...o.httpMetadata } } : {}),
    ...(include.includes('customMetadata') ? { customMetadata: { ...o.customMetadata } } : {}),
    writeHttpMetadata(headers) { for (const [k, v] of Object.entries(o.httpMetadata)) headers.set(k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), v); },
  });
  const withBody = (o) => {
    let used = false;
    const take = () => { if (used) throw new TypeError('fake R2: body already used'); used = true; return o.bytes.slice(); };
    // defineProperties, not Object.assign: assign would run the body getter and use the body up front
    return Object.defineProperties(meta(o), {
      body: { enumerable: true, get() { const bytes = take(); return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }); } },
      bodyUsed: { enumerable: true, get() { return used; } },
      arrayBuffer: { value: async () => take().buffer },
      bytes: { value: async () => take() },
      text: { value: async () => new TextDecoder().decode(take()) },
      json: { value: async () => JSON.parse(new TextDecoder().decode(take())) },
      blob: { value: async () => new Blob([take()], { type: o.httpMetadata.contentType || '' }) },
    });
  };
  const passes = (cond, o) => {
    if (!cond) return true;
    if (typeof cond.get === 'function') {
      const inm = cond.get('if-none-match'), im = cond.get('if-match');
      if (inm != null && (inm.trim() === '*' ? Boolean(o) : Boolean(o) && etagList(inm).includes(o.etag))) return false;
      if (im != null && !(o && (im.trim() === '*' || etagList(im).includes(o.etag)))) return false;
      return true;
    }
    if (cond.etagMatches != null && !(o && strip(cond.etagMatches) === o.etag)) return false;
    if (cond.etagDoesNotMatch != null && o && strip(cond.etagDoesNotMatch) === o.etag) return false;
    if (cond.uploadedBefore != null && o && !(o.uploaded < new Date(cond.uploadedBefore).getTime())) return false;
    if (cond.uploadedAfter != null && o && !(o.uploaded > new Date(cond.uploadedAfter).getTime())) return false;
    return true;
  };
  const bucket = {
    objects, calls, log, faults,
    async put(key, value, options = {}) {
      checkPut(value, options);
      calls.put++; log.push(['put', key]);
      if (faults.beforePut) await faults.beforePut(key, options);
      if (faults.rateLimitNextPut > 0 && (!faults.rateLimitKey || faults.rateLimitKey === key)) {
        faults.rateLimitNextPut--;
        throw new Error('put: Reduce your concurrent request rate for the same object. (10058)');
      }
      const bytes = await toBytes(value);
      if (options.onlyIf) {
        if (faults.failNextCas > 0) { faults.failNextCas--; return null; }
        if (!passes(options.onlyIf, objects.get(key))) return null;
      }
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (options.sha256 != null && hexOf(options.sha256) !== sha256) {
        throw new Error(`put: The SHA-256 checksum you specified did not match what we received.\nYou provided a SHA-256 checksum with value: ${hexOf(options.sha256)}\nActual SHA-256 was: ${sha256} (10037)`);
      }
      const o = {
        key, bytes, sha256, etag: createHash('md5').update(bytes).digest('hex'), version: randomUUID(), uploaded: Date.now(),
        httpMetadata: { ...(options.httpMetadata || {}) }, customMetadata: { ...(options.customMetadata || {}) },
      };
      objects.set(key, o);
      if (faults.dropNextPut > 0) { faults.dropNextPut--; throw new Error('put: network connection lost (fake: stored, response dropped)'); }
      return meta(o);
    },
    async get(key) { calls.get++; log.push(['get', key]); const o = objects.get(key); return o ? withBody(o) : null; },
    async head(key) { calls.head++; log.push(['head', key]); const o = objects.get(key); return o ? meta(o) : null; },
    async delete(keys) { calls.delete++; for (const k of [].concat(keys)) { log.push(['delete', k]); objects.delete(k); } },
    async list({ prefix = '', cursor, limit = 1000, include = [] } = {}) {
      calls.list++; log.push(['list', prefix]);
      const after = cursor ? Buffer.from(cursor, 'base64url').toString() : null;
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix) && (after == null || k > after)).sort();
      const page = keys.slice(0, Math.max(1, Math.min(limit, 1000, pageSize)));
      const truncated = keys.length > page.length;
      return {
        objects: page.map((k) => meta(objects.get(k), include)), truncated, delimitedPrefixes: [],
        ...(truncated ? { cursor: Buffer.from(page.at(-1)).toString('base64url') } : {}),
      };
    },
    // ── test conveniences (not part of the R2 API) ──
    keys: (prefix = '') => [...objects.keys()].filter((k) => k.startsWith(prefix)).sort(),
    has: (key) => objects.has(key),
    text: (key) => (objects.has(key) ? new TextDecoder().decode(objects.get(key).bytes) : null),
    json: (key) => (objects.has(key) ? JSON.parse(new TextDecoder().decode(objects.get(key).bytes)) : null),
    metaOf: (key) => (objects.has(key) ? { ...objects.get(key).customMetadata } : null),
    resetCalls() { for (const k of Object.keys(calls)) calls[k] = 0; log.length = 0; },
    totalCalls: () => Object.values(calls).reduce((a, b) => a + b, 0),
  };
  return bucket;
}
