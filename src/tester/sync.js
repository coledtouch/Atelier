// Private tester continuity. Authentication and CSRF stay in the tester router. Every R2 operation is bound to
// the verified LinkedIn subject; client paths, request bodies and passcode headers can never select an account.
// The owner's /api/sync routes and R2 keys are unchanged.
import { handleSync } from '../sync.js';
import { sha256, fail, signedOut } from './auth.js';
import { SUB } from './ledger.js';

export const TESTER_SYNC_QUOTA_BYTES = 1024 ** 3;
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
const encodeCursor = (namespace, cursor) => btoa(JSON.stringify([namespace, cursor])).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function decodeCursor(namespace, cursor) {
  if (cursor == null) return undefined;
  if (typeof cursor !== 'string' || cursor.length > 32_768 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new TypeError('Invalid sync storage cursor');
  let pair;
  try { pair = JSON.parse(atob(cursor.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(cursor.length / 4) * 4, '='))); } catch { throw new TypeError('Invalid sync storage cursor'); }
  if (!Array.isArray(pair) || pair.length !== 2 || pair[0] !== namespace || typeof pair[1] !== 'string') throw new TypeError('Invalid sync storage cursor');
  return pair[1];
}
export async function testerSyncBucket(bucket, sub) {
  if (typeof sub !== 'string' || !SUB.test(sub)) throw new TypeError('Invalid tester identity');
  const namespace = `testers/${await sha256(sub)}/`;
  const keyOf = (key) => namespace + relativeKey(key);
  return Object.freeze({
    // Preserve the native R2ObjectBody receiver and streaming body. handleSync exposes keys only from list(), below.
    get: (key, options) => bucket.get(keyOf(key), options),
    head: (key) => bucket.head(keyOf(key)),
    put: (key, value, options) => bucket.put(keyOf(key), value, options),
    delete: (keys) => bucket.delete(Array.isArray(keys) ? keys.map(keyOf) : keyOf(keys)),
    async list(options = {}) {
      const prefix = relativeKey(options.prefix ?? '', true);
      const page = await bucket.list({
        prefix: namespace + prefix, cursor: decodeCursor(namespace, options.cursor),
        ...(options.limit == null ? {} : { limit: options.limit }),
        ...(options.include == null ? {} : { include: options.include }),
      });
      const owns = (key) => typeof key === 'string' && key.startsWith(namespace + prefix);
      return {
        ...page,
        objects: (page.objects || []).filter((object) => owns(object.key)).map((object) => ({ ...object, key: object.key.slice(namespace.length) })),
        delimitedPrefixes: (page.delimitedPrefixes || []).filter(owns).map((key) => key.slice(namespace.length)),
        cursor: page.truncated && typeof page.cursor === 'string' ? encodeCursor(namespace, page.cursor) : undefined,
      };
    },
  });
}

export async function handleTesterSync(c) {
  if (c.who?.kind !== 'tester' || typeof c.who.sub !== 'string' || !SUB.test(c.who.sub)) return signedOut();
  const suffix = typeof c.path === 'string' && c.path.startsWith('tester/sync/') ? c.path.slice('tester/sync/'.length) : '';
  if (!SUFFIX.test(suffix)) return failPath();
  // handleSync owns validation, compare-and-swap, media checksums, trash/history and retry behavior. A new env view
  // ensures it cannot see the owner's bucket or quota. A missing binding/kill switch still produces its normal 503.
  const env = {
    SYNC_BUCKET: c.env?.SYNC_BUCKET ? await testerSyncBucket(c.env.SYNC_BUCKET, c.who.sub) : undefined,
    SYNC_DISABLED: c.env?.SYNC_DISABLED,
    SYNC_QUOTA_BYTES: TESTER_SYNC_QUOTA_BYTES,
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
