// Build mode's app versions (pure; app.js wires it). A refine edits ONE app: the thread's "head" build.
//   head      — the build a new refine applies to: the latest build that has an app or is still running, unless an older
//               version was restored since (e.baseAt, ms: "Restore" stamps it; a plain persisted entry field that syncs).
//   planRefine — what a new (or retried) refine does now: wait for a running head, refine it once it has an app, or fall
//               back to the latest finished app when the head failed / was stopped. Called again after every wait, so
//               several quick edits apply in order on one lineage (each waits for the one before it).
//   versions  — v1, v2, … per lineage (refineOf chain to its first build), numbered in thread order over builds that
//               have an app; the newest is shown as the full card, earlier ones collapse to a line.

export const isBuild = (x) => Boolean(x) && x.kind === 'build';
// A finished app (a tester's length-capped file still counts: it has HTML).
export const hasApp = (x) => isBuild(x) && !x.pending && typeof x.app?.html === 'string' && x.app.html.length > 0;
const validAt = (v) => Number.isFinite(v) && v > 0;

// How recent x is as a refine base, seen from a request made at `at`: its creation, or a Restore stamped before `at`.
function headKey(x, at) {
  const made = Number(x.createdAt) || 0;
  return validAt(x.baseAt) && x.baseAt <= at ? Math.max(made, x.baseAt) : made;
}
// The latest of the builds in `prior` passing ok(x), by headKey (thread order breaks ties: the later entry wins).
function latest(prior, at, ok) {
  let best = null, key = -Infinity;
  for (const x of prior) {
    if (!isBuild(x) || !ok(x)) continue;
    const k = headKey(x, at);
    if (k >= key) { best = x; key = k; }
  }
  return best;
}

// The build a refine made at `at` (after the entries in `prior`) means to change: the version it already edited (a retry
// keeps its base: e.refineOf), else the head — a running build counts, so a quick second edit waits for the first.
export function intendedParent(prior, { refineOf = null, at = Infinity } = {}) {
  if (refineOf) {
    const own = prior.find((x) => x.id === refineOf && isBuild(x));
    if (own) return own;
  }
  return latest(prior, at, (x) => x.pending || hasApp(x));
}
export const latestApp = (prior, at = Infinity) => latest(prior, at, hasApp);

// → { wait } (the parent is still building: wait for it, then plan again), { prev } (refine prev; null → a fresh build)
// plus fallback: the build it meant to change when that one failed or was stopped (prev is then the latest finished app).
export function planRefine(prior, e = {}) {
  const at = Number(e.createdAt) || Infinity;
  const p = intendedParent(prior, { refineOf: e.refineOf, at });
  if (!p) return { prev: null };
  if (p.pending) return { wait: p };
  if (hasApp(p)) return { prev: p };
  const prev = latestApp(prior, at);
  return { prev, fallback: p };
}

// The first build of x's lineage (follows refineOf through the thread; a missing link or a loop ends it).
export function rootOf(entries, x) {
  const byId = new Map(entries.map((y) => [y.id, y]));
  const seen = new Set();
  let cur = x;
  while (cur?.refineOf && !seen.has(cur.id)) {
    seen.add(cur.id);
    const up = byId.get(cur.refineOf);
    if (!isBuild(up)) break;
    cur = up;
  }
  return cur;
}

// → Map id → { n, of, root, newest } for every build with an app: its version number in its lineage, how many versions
// that lineage has, and whether it is the lineage's newest.
export function versions(entries) {
  const groups = new Map();
  for (const x of entries) {
    if (!hasApp(x)) continue;
    const root = rootOf(entries, x).id;
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(x);
  }
  const out = new Map();
  for (const [root, list] of groups) list.forEach((x, i) => out.set(x.id, { n: i + 1, of: list.length, root, newest: i === list.length - 1 }));
  return out;
}

// What the composer says in Build mode: the app a new refine would change, its version, and whether it waits on a
// running build. null when the thread has no build yet.
export function composerTarget(entries, at = Date.now()) {
  const head = intendedParent(entries, { at });
  if (!head) return null;
  const v = versions(entries);
  if (hasApp(head)) return { title: head.app.title, n: v.get(head.id)?.n || 1, queued: false, id: head.id };
  const app = latestApp(entries, at);
  return { title: app?.app.title || '', n: app ? v.get(app.id)?.n || 1 : 0, queued: true, id: head.id };
}

// Restore: stamp x as the base for the next refine (history is kept; nothing else changes).
export function restoreBase(x, now = Date.now()) {
  if (!hasApp(x)) return false;
  x.baseAt = now;
  return true;
}
