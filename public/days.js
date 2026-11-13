// Days and flows: a flow is a thread; a day is derived from the times of its entries (local time), never stored.
// Pure helpers the UI uses. No DOM and no network, so tests/days.test.mjs imports it directly.
import { spaceOf, labelOf } from './thread-spaces.js?v=131';

const pad = (n) => String(n).padStart(2, '0');
/** 'YYYY-MM-DD' in local time. */
export const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
/** When an entry happened: its `at`, else when it was created. */
export const entryTime = (e) => e?.at ?? e?.createdAt;

const entriesOf = (t) => (Array.isArray(t?.entries) ? t.entries : []);

/** The days a flow has something on. A flow with no entries lives on the day it was made. */
export function flowDays(t) {
  const es = entriesOf(t);
  return new Set(es.length ? es.map((e) => dayKey(entryTime(e))) : [dayKey(t?.createdAt)]);
}

const onDay = (t, day) => entriesOf(t).filter((e) => dayKey(entryTime(e)) === day);
/** The latest moment a flow was active on `day`, or -Infinity when it was not. */
function lastOn(t, day) {
  const es = onDay(t, day);
  if (es.length) return Math.max(...es.map(entryTime));
  return !entriesOf(t).length && dayKey(t?.createdAt) === day ? t.createdAt : -Infinity;
}

/** The flows with something on `day`, the most recently active that day first. */
export const flowsOn = (threads, day) =>
  threads.map((t) => [t, lastOn(t, day)]).filter(([, at]) => at > -Infinity).sort((a, b) => b[1] - a[1]).map(([t]) => t);

/** One flow's part of a day: its entries that day, and how many came before the first of them. */
export function daySlice(t, day) {
  const entries = onDay(t, day).sort((a, b) => entryTime(a) - entryTime(b));
  if (!entries.length) return { earlier: 0, entries };
  const first = entryTime(entries[0]);
  return { earlier: entriesOf(t).filter((e) => entryTime(e) < first).length, entries };
}

/**
 * The flows a day's tabs show: those with something on `day`, the most recently active first, and the open flow in front
 * when it is not one of them (a new flow not saved yet, or one opened from an earlier day). The open flow is always the
 * record on screen (`open`), never a stored copy of it.
 */
export function tabFlows(threads, day, open = null) {
  const pool = threads.filter((t) => t && t.id !== open?.id);
  if (open) pool.push(open);
  const list = flowsOn(pool, day);
  return open && !list.includes(open) ? [open, ...list] : list;
}

/** Where a flow's part of `day` starts in its conversation: its first entry on that day, or its end when it has none. */
export function earlierCut(t, day) {
  const on = new Set(daySlice(t, day).entries);
  const i = entriesOf(t).findIndex((e) => on.has(e));
  return i < 0 ? entriesOf(t).length : i;
}

/** Every entry of the day across flows, oldest first. */
export function dayTimeline(threads, day) {
  const rows = [];
  for (const thread of threads) for (const entry of onDay(thread, day)) rows.push({ thread, entry, at: entryTime(entry) });
  return rows.sort((a, b) => a.at - b.at);
}

/** Each day that has anything, newest first, with the ids of its flows (most recently active first). */
export function dayList(threads) {
  const days = new Set();
  for (const t of threads) for (const d of flowDays(t)) days.add(d);
  return [...days].sort().reverse().map((day) => ({ day, ids: flowsOn(threads, day).map((t) => t.id) }));
}

/** The nearest day in `days` (any order) before (-1) or after (1) `day`, or null past the ends. */
export function stepDay(days, day, dir) {
  const sorted = [...days].sort();
  return (dir < 0 ? sorted.filter((d) => d < day).pop() : sorted.find((d) => d > day)) ?? null;
}

/** A flow's kind: the synced one, else the on-device guess, else ''. */
export const kindOf = (t, guesses) => t?.flow?.kind || spaceOf(guesses, t?.id) || '';

/** A synced flow field → { kind, color? }, or null when it is not one (a stored value is never trusted). */
export function cleanFlow(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  if (typeof v.kind !== 'string' || !/^[a-z0-9-]{1,24}$/.test(v.kind)) return null;
  const out = { kind: v.kind };
  if (typeof v.color === 'string' && v.color && v.color.length <= 16) out.color = v.color;
  return out;
}

/** The line that tells the model what a flow is about, or '' for a kind the set doesn't have. */
export function flowHint(kind, set) {
  const label = labelOf(set, kind);
  return label ? `This flow is about ${label}.` : '';
}

/** How a kind of flow behaves by default. Kinds not named here are { mode: 'ask' }. */
export const KIND_DEFAULTS = Object.freeze({ linkedin: Object.freeze({ mode: 'ask', ask: Object.freeze({ voice: true }) }) });

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
function overlay(a, b) {
  for (const k in b) {
    if (isObj(b[k]) && isObj(a[k])) overlay(a[k], b[k]);
    else if (b[k] !== undefined) a[k] = b[k];
  }
  return a;
}
/**
 * The composer choices a flow opens with, as { opts, mode }: its own (thread.opts, kept on this device only), else its
 * kind's defaults over the global ones, else the global ones. `base` is a fresh copy of the global choices (changed and
 * returned); `clean` tidies saved choices (app.js migrateOpts). Never shares an object with the thread or KIND_DEFAULTS.
 */
export function flowOpts(t, base, baseMode, clean = (o) => o) {
  if (isObj(t?.opts)) {
    const { mode, ...own } = structuredClone(t.opts);
    return { opts: overlay(base, clean(own)), mode: typeof mode === 'string' && mode ? mode : baseMode };
  }
  const kind = t?.flow?.kind;
  if (!kind) return { opts: base, mode: baseMode };
  const { mode = 'ask', ...defaults } = structuredClone(KIND_DEFAULTS[kind] || {});
  return { opts: overlay(base, defaults), mode };
}

/**
 * The global choices (LS 'opts') after a change to one mode's choices in a flow: `stored` with `slice` laid over its
 * `mode`, and nothing else touched (other modes keep the global values, not this flow's). Keys the flow's kind sets by
 * default (linkedin's ask.voice) stay as stored: they belong to the flow, never to every later chat. Returns a new object.
 */
export function globalOptsWrite(stored, mode, slice, kind) {
  const out = isObj(stored) ? structuredClone(stored) : {};
  if (!isObj(slice)) return out;
  const was = isObj(out[mode]) ? out[mode] : {};
  const own = structuredClone(slice);
  const d = KIND_DEFAULTS[kind]?.[mode];
  if (isObj(d)) for (const k of Object.keys(d)) { if (k in was) own[k] = was[k]; else delete own[k]; }
  out[mode] = { ...was, ...own };
  return out;
}
