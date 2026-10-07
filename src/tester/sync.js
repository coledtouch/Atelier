// Private tester continuity. Authentication and CSRF stay in the tester router. Every R2 operation is bound to
// the verified LinkedIn subject; client paths, request bodies and passcode headers can never select an account.
// The owner's /api/sync routes and R2 keys are unchanged.
import { handleSync } from '../sync.js';
import { sha256, fail, signedOut } from './auth.js';
import { SUB } from './ledger.js';

export const TESTER_SYNC_QUOTA_BYTES = 1024 ** 3;
// Testers' cloud limits (the owner's are unchanged): the quota counts every stored byte (thread documents, media, trash
// and history: SYNC_COUNT_ALL in src/sync.js), and at most this many threads.
export const TESTER_SYNC_MAX_THREADS = 500;
// A per-tester rate limit on what grows or recounts storage (LI_LIMIT, keyed sync:<sub>: the binding's 20 a minute), as
// for read aloud and dictation. Reads (index, a thread, a blob, the trash list, missing-blob checks) are not counted.
// Answered 503 sync_busy with Retry-After, never 429: the sync client reads a 429 as the passcode lockout and pauses.
const SYNC_RATE_RETRY_AFTER = '20';
const throttledRoute = (method, suffix) => (method !== 'GET' && suffix !== 'blobs/missing') || suffix === 'status';
async function syncThrottled(c) {
  if (!c.env?.LI_LIMIT) return false;
  try { return !(await c.env.LI_LIMIT.limit({ key: `sync:${c.who.sub}` })).success; } catch { return false; }
}
const SUFFIX = /^(?:index|status|trash|trash\/restore|blobs\/missing|thread\/[\w-]{1,120}|blob\/[0-9a-f]{64})$/;
const ROOTS = new Set(['t', 'b', 'x', 'v', 'u']);
const SEGMENT = /^[\w.-]+$/;
const failPath = () => fail(404, 'not_found', 'Not found.');
const syncOff = (value) => value != null && !['', '0', 'false', 'off', 'no'].includes(String(value).trim().toLowerCase());
export const testerSyncReady = (env) => Boolean(env?.SYNC_BUCKET) && !syncOff(env?.SYNC_DISABLED);

function relativeKey(key, prefix = false) {
  if (typeof key !== 'string' || (!prefix && !key) || key.startsWith('/') || key.includes('\\')) throw new TypeError('Invalid sync storage key');
  if (prefix && key === '') return key;
  const parts = key.split('/');
  if (prefix && parts.at(-1) === '') parts.pop();
  if (!ROOTS.has(parts[0]) || parts.some((part) => !SEGMENT.test(part) || part === '.' || part === '..')) throw new TypeError('Invalid sync storage key');
  return key;
}
// A cursor is bound to the account (its namespace) and says which of the list's storage prefixes it continues.
const encodeCursor = (namespace, phase, cursor) => btoa(JSON.stringify([namespace, phase, cursor])).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function decodeCursor(namespace, cursor, phases) {
  if (cursor == null) return [0, undefined];
  if (typeof cursor !== 'string' || cursor.length > 32_768 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new TypeError('Invalid sync storage cursor');
  let triple;
  try { triple = JSON.parse(atob(cursor.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(cursor.length / 4) * 4, '='))); } catch { throw new TypeError('Invalid sync storage cursor'); }
  if (!Array.isArray(triple) || triple.length !== 3 || triple[0] !== namespace || !Number.isInteger(triple[1]) || triple[1] < 0 || triple[1] >= phases || !(triple[2] === null || typeof triple[2] === 'string')) throw new TypeError('Invalid sync storage cursor');
  return [triple[1], triple[2] ?? undefined];
}
// R2 keys of one tester. Threads, media and usage live under testers/<hash>/{t,b,u}/…; trash and history under their own
// top-level prefixes, testers-x/<hash>/x/… and testers-v/<hash>/v/…, so R2 lifecycle rules (which match key prefixes
// only) can expire every tester's trash and history after 30 days without touching threads, media or the owner's keys
// (the owner's are t/, b/, x/, v/, u/ at the bucket root). handleSync sees the same relative keys either way.
// Trash and history written before this split (v76/v77) stay under testers/<hash>/x|v/ until the 90-day purge: get and
// head fall back to them, delete removes both copies, and an x/ or v/ listing includes them, so a trash item from then
// can still be restored. A whole-account listing (prefix '': the purge, the usage recount) covers all three prefixes.
export async function testerSyncBucket(bucket, sub) {
  if (typeof sub !== 'string' || !SUB.test(sub)) throw new TypeError('Invalid tester identity');
  const hash = await sha256(sub);
  const namespace = `testers/${hash}/`;
  const split = { x: `testers-x/${hash}/`, v: `testers-v/${hash}/` };
  const rootOf = (rel) => rel.split('/')[0];
  const keyOf = (key) => { const rel = relativeKey(key); return (split[rootOf(rel)] ?? namespace) + rel; };
  const legacyOf = (key) => { const rel = relativeKey(key); return split[rootOf(rel)] ? namespace + rel : null; };
  // The storage prefixes a listing walks, in order: '' → all three (the first also holds the pre-split x/ and v/);
  // x… / v… → the dedicated prefix, then the pre-split copies; anything else → testers/<hash>/ only.
  const phasesFor = (prefix) => (prefix === '' ? [namespace, split.x, split.v] : split[rootOf(prefix)] ? [split[rootOf(prefix)], namespace] : [namespace]);
  const fallback = (key, read) => { const old = legacyOf(key), first = read(keyOf(key)); return old ? Promise.resolve(first).then((o) => o ?? read(old)) : first; };
  return Object.freeze({
    // Preserve the native R2ObjectBody receiver and streaming body. handleSync exposes keys only from list(), below.
    get: (key, options) => fallback(key, (k) => bucket.get(k, options)),
    head: (key) => fallback(key, (k) => bucket.head(k)),
    put: (key, value, options) => bucket.put(keyOf(key), value, options),
    delete: (keys) => {
      const all = (Array.isArray(keys) ? keys : [keys]).flatMap((key) => [keyOf(key), legacyOf(key)].filter(Boolean));
      if (!Array.isArray(keys) && all.length === 1) return bucket.delete(all[0]);
      // R2 deletes at most 1,000 keys per call; a pre-split x/ or v/ key doubles.
      return (async () => { for (let at = 0; at < all.length; at += 1000) await bucket.delete(all.slice(at, at + 1000)); })();
    },
    async list(options = {}) {
      const prefix = relativeKey(options.prefix ?? '', true), phases = phasesFor(prefix);
      let [phase, cursor] = decodeCursor(namespace, options.cursor, phases.length);
      for (;;) {
        const base = phases[phase];
        const page = await bucket.list({
          prefix: base + prefix, cursor,
          ...(options.limit == null ? {} : { limit: options.limit }),
          ...(options.include == null ? {} : { include: options.include }),
        });
        const owns = (key) => typeof key === 'string' && key.startsWith(base + prefix);
        const objects = (page.objects || []).filter((object) => owns(object.key)).map((object) => ({ ...object, key: object.key.slice(base.length) }));
        const more = Boolean(page.truncated) && typeof page.cursor === 'string';
        // An empty, finished prefix moves straight on to the next one (the purge re-lists from the start each pass).
        if (!objects.length && !more && phase + 1 < phases.length) { phase++; cursor = undefined; continue; }
        const next = more ? [phase, page.cursor] : phase + 1 < phases.length ? [phase + 1, null] : null;
        return {
          ...page, objects,
          delimitedPrefixes: (page.delimitedPrefixes || []).filter(owns).map((key) => key.slice(base.length)),
          truncated: Boolean(next), cursor: next ? encodeCursor(namespace, ...next) : undefined,
        };
      }
    },
  });
}

export async function handleTesterSync(c) {
  if (c.who?.kind !== 'tester' || typeof c.who.sub !== 'string' || !SUB.test(c.who.sub)) return signedOut();
  const suffix = typeof c.path === 'string' && c.path.startsWith('tester/sync/') ? c.path.slice('tester/sync/'.length) : '';
  if (!SUFFIX.test(suffix)) return failPath();
  if (throttledRoute(c.req?.method, suffix) && await syncThrottled(c)) return fail(503, 'sync_busy', 'Sync is busy. Try again in a moment.', {}, { 'retry-after': SYNC_RATE_RETRY_AFTER });
  // handleSync owns validation, compare-and-swap, media checksums, trash/history and retry behavior. A new env view
  // ensures it cannot see the owner's bucket or quota. A missing binding/kill switch still produces its normal 503.
  const env = {
    SYNC_BUCKET: c.env?.SYNC_BUCKET ? await testerSyncBucket(c.env.SYNC_BUCKET, c.who.sub) : undefined,
    SYNC_DISABLED: c.env?.SYNC_DISABLED,
    SYNC_QUOTA_BYTES: TESTER_SYNC_QUOTA_BYTES,
    SYNC_COUNT_ALL: true,
    SYNC_MAX_THREADS: TESTER_SYNC_MAX_THREADS,
  };
  return handleSync(c.req, env, suffix);
}

// The Ledger's 90-day retention alarm purges cloud threads before forgetting the record that identifies them.
// Re-list from the beginning after every delete: a cursor cannot skip objects because the preceding page vanished.
// Bounded passes keep the Durable Object concurrency gate short; partial failures are safe to retry next alarm.
export async function purgeTesterSync(env, sub, { maxPages = 10 } = {}) {
  if (typeof sub !== 'string' || !SUB.test(sub)) throw new TypeError('Invalid tester identity');
  // A temporarily missing binding is not proof that there is no cloud data. Keep the identifying record until the
  // configured bucket is reachable again; otherwise this deployment could orphan a previous deployment's data.
  if (!env?.SYNC_BUCKET) return { complete: false, removed: 0 };
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new TypeError('Invalid cleanup page limit');
  const scoped = await testerSyncBucket(env.SYNC_BUCKET, sub);
  let removed = 0;
  for (let page = 0; page < maxPages; page++) {
    const listed = await scoped.list({ limit: 1000 });
    const keys = listed.objects.map((object) => object.key);
    // R2 list/delete accept at most 1,000 objects each. Keep the delete bound even with an alternate storage adapter.
    for (let at = 0; at < keys.length; at += 1000) {
      const batch = keys.slice(at, at + 1000);
      await scoped.delete(batch);
      removed += batch.length;
    }
    if (!listed.truncated) return { complete: true, removed };
  }
  return { complete: false, removed };
}

export const TESTER_SYNC_ROUTES = Object.freeze([
  { method: 'GET', match: 'tester/sync/index', run: handleTesterSync },
  { method: 'GET', match: 'tester/sync/status', run: handleTesterSync },
  { method: 'GET', match: 'tester/sync/trash', run: handleTesterSync },
  { method: 'POST', match: 'tester/sync/trash/restore', run: handleTesterSync },
  { method: 'POST', match: 'tester/sync/blobs/missing', run: handleTesterSync },
  ...['GET', 'POST', 'DELETE'].map((method) => ({ method, match: /^tester\/sync\/thread\/[\w-]{1,120}$/, sample: 'tester/sync/thread/example', run: handleTesterSync })),
  ...['GET', 'PUT'].map((method) => ({ method, match: /^tester\/sync\/blob\/[0-9a-f]{64}$/, sample: `tester/sync/blob/${'a'.repeat(64)}`, run: handleTesterSync })),
]);
