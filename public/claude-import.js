// Claude chats import: the claude.ai data export (Settings → Privacy → Export data → an emailed .zip holding
// conversations.json) becomes Atelier threads, read locally — nothing goes to any AI model while importing.
// Pure module (no DOM, no storage): app.js runs it, on the main thread or in claude-worker.js, and tests run it in Node.
//   readConversations  the export's bytes (.zip or .json) → the conversations array
//   toThread           one conversation → a thread { id: 'claude-<uuid>', title, createdAt, updatedAt, entries } or null
//   mergeThread        a re-import into the copy already here: adds new turns, refreshes changed imported ones
//   searchHistory / readHistory / CLAUDE_TOOLS   the accounts agent's read-only "search my Claude history" tools
// Entries are ordinary 'ask' turns: { id: 'c<message uuid>', kind: 'ask', prompt, text, think?, createdAt, params: {},
// via: 'claude', meta: { model: 'claude.ai', note: 'from Claude' } }. Only existing entry keys are used ('via' already
// labels Atelier Assist turns), so data-safety's validateBackup, sync and older app versions take them as they are.
// Stable ids make a newer export update the same threads instead of duplicating them, on any of the owner's devices.

export const PREFIX = 'claude-';
export const VIA = 'claude';
export const MODEL = 'claude.ai';
export const NOTE = 'from Claude';
export const LIMITS = Object.freeze({
  title: 200, prompt: 40_000, text: 120_000, think: 20_000, // characters kept per turn (a longer one says so)
  attach: 1_000, attachments: 5, // extracted text kept per attachment, attachments listed per message
  entries: 2_000, // turns per thread (the newest are kept)
  conversations: 5_000, // per import, newest first (sync holds 10,000 threads per account)
  bytes: 480 * 1024 * 1024, // conversations.json itself: one JavaScript string must hold it
  batch: 25, // threads per step: progress, cancel and storage writes go batch by batch
});
const TRIM = '\n\n_[Trimmed on import from Claude: the rest was too long to keep.]_';

const str = (v) => (typeof v === 'string' ? v : '');
const cut = (s, n) => (s.length > n ? s.slice(0, n) + TRIM : s);
const cleanId = (v) => str(v).replace(/[^\w-]/g, '').slice(0, 100);
const when = (...vs) => { for (const v of vs) { const t = typeof v === 'number' ? v : Date.parse(str(v)); if (Number.isFinite(t) && t >= 0 && t <= 8.64e15) return t; } return 0; };
// A short stable id for a conversation or message without a uuid (FNV-1a over what identifies it).
function hashId(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

// ── reading the export ──
const isZip = (b) => b.length > 3 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
const JSON_RE = /\.jsonl?$/i;
const CONV_RE = /(^|\/)conversations[^/]*\.jsonl?$/i;
// A conversation in any of the shapes claude.ai has exported: chat_messages (classic), or messages with sender/role.
function asConv(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  if (Array.isArray(c.chat_messages)) return c;
  if (Array.isArray(c.messages) && c.messages.some((m) => m && typeof m === 'object' && ('sender' in m || 'role' in m))) {
    const sender = (m) => { const r = String(m.sender ?? m.role ?? ''); return r === 'user' ? 'human' : r; };
    return { ...c, chat_messages: c.messages.map((m) => (m && typeof m === 'object' ? { ...m, sender: sender(m) } : m)) };
  }
  return null;
}
// Every conversation in one parsed JSON value: an array, { conversations: [...] }, or a single conversation.
let emptyExport = false; // set by convsIn when a file held an empty conversations list (an account with no chats)
function convsIn(data) {
  if ((Array.isArray(data) && !data.length) || (Array.isArray(data?.conversations) && !data.conversations.length)) emptyExport = true;
  const list = Array.isArray(data) ? data : Array.isArray(data?.conversations) ? data.conversations : [data];
  return list.map(asConv).filter(Boolean);
}
const isManifest = (d) => d && typeof d === 'object' && !Array.isArray(d) && Array.isArray(d.data_files) && d.data_files.some((f) => f && f.export_url);
const MANIFEST_MSG = 'That’s the export’s list of download links, not the chats themselves. Download conversations-000.zip (and any conversations-001.zip …) from the links in your claude.ai export email, then import that zip here.';
function parseText(text, name = '') {
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (/\.jsonl$/i.test(name)) return t.split('\n').filter((l) => l.trim()).flatMap((l) => { try { return convsIn(JSON.parse(l)); } catch { return []; } });
  let data;
  try { data = JSON.parse(t); } catch { throw new Error('That file isn’t valid JSON. Choose the conversations .zip from your claude.ai export, or the conversations.json inside it.'); }
  if (isManifest(data)) throw new Error(MANIFEST_MSG);
  return convsIn(data);
}
// bytes: the picked file's contents. fflate: { unzipSync, strFromU8 } (vendor/fflate.js in the browser, the fflate
// package in tests). → the conversations array; throws an Error worded for people when it isn't a Claude export.
// Zips: classic exports hold one conversations.json; newer ones (conversations-000.zip) may hold several JSON files.
export function readConversations(bytes, fflate) {
  let convs = [];
  emptyExport = false;
  if (isZip(bytes)) {
    let big = false, total = 0;
    const files = fflate.unzipSync(bytes, { filter: (f) => {
      if (!JSON_RE.test(f.name) || /(^|\/)__MACOSX\//.test(f.name)) return false;
      total += f.originalSize;
      if (f.originalSize > LIMITS.bytes || total > LIMITS.bytes) { big = true; return false; }
      return true;
    } });
    if (big) throw new Error('That export is too large to open in a browser (over 480 MB of chats in one zip).');
    const names = Object.keys(files);
    // conversations*.json first; other JSON files only when they hold conversations (users.json, projects.json don't)
    const ordered = [...names.filter((n) => CONV_RE.test(n)), ...names.filter((n) => !CONV_RE.test(n))];
    for (const n of ordered) {
      try { convs.push(...parseText(fflate.strFromU8(files[n]), n)); } catch (err) { if (err.message === MANIFEST_MSG) throw err; }
    }
    if (!names.length) throw new Error('No chats in that zip — choose conversations-000.zip (or the classic export .zip) from your claude.ai export.');
  } else {
    if (bytes.length > LIMITS.bytes) throw new Error('That file is too large to open in a browser (over 480 MB).');
    convs = parseText(new TextDecoder().decode(bytes));
  }
  if (!convs.length && emptyExport) return [];
  if (!convs.length) throw new Error('No Claude chats found in that file. Choose conversations-000.zip from your claude.ai export (not projects, memories or light_metadata). For ChatGPT, use Your profile → ChatGPT export.');
  // the same conversation in two files (split exports overlap): keep the copy with more messages
  const byId = new Map();
  for (const c of convs) { const k = c.uuid || JSON.stringify([c.created_at, c.name]); const o = byId.get(k); if (!o || c.chat_messages.length > o.chat_messages.length) byId.set(k, c); }
  return [...byId.values()];
}

// Newest first (by updated_at), capped at LIMITS.conversations: → { list, skipped } (skipped: left out by the cap).
export function newestFirst(convs, max = LIMITS.conversations) {
  const list = (convs || []).filter((c) => c && typeof c === 'object' && Array.isArray(c.chat_messages) && c.chat_messages.length)
    .map((c) => ({ c, at: when(c.updated_at, c.created_at) })).sort((a, b) => b.at - a.at).map((x) => x.c);
  return { list: list.slice(0, max), skipped: Math.max(0, list.length - max) };
}

// One message's visible text, reasoning and tool names: content text blocks when present, else the plain text field.
function partsOf(m) {
  const blocks = Array.isArray(m.content) ? m.content.filter((b) => b && typeof b === 'object') : [];
  let text = blocks.filter((b) => b.type === 'text').map((b) => str(b.text)).filter(Boolean).join('\n\n').trim();
  if (!text) text = str(m.text).trim();
  const think = blocks.filter((b) => b.type === 'thinking').map((b) => str(b.thinking) || str(b.text)).filter(Boolean).join('\n\n').trim();
  const tools = [...new Set(blocks.filter((b) => b.type === 'tool_use' && str(b.name)).map((b) => b.name.slice(0, 60)))];
  return { text, think, tools };
}
// Attachments (with extracted text) and files (names only, e.g. images) as a short note under the prompt.
function attachNote(m) {
  const out = [];
  const list = [...(Array.isArray(m.attachments) ? m.attachments : []), ...(Array.isArray(m.files) ? m.files : [])].filter((a) => a && typeof a === 'object');
  for (const a of list.slice(0, LIMITS.attachments)) {
    const name = str(a.file_name).trim().slice(0, 120) || 'file';
    const body = str(a.extracted_content).replace(/\s+/g, ' ').trim();
    out.push(body ? `- ${name}: “${body.slice(0, LIMITS.attach)}${body.length > LIMITS.attach ? '…' : ''}”` : `- ${name}`);
  }
  if (list.length > LIMITS.attachments) out.push(`- and ${list.length - LIMITS.attachments} more`);
  return out.length ? `Attached in Claude:\n${out.join('\n')}` : '';
}
const isUser = (m) => m.sender === 'human' || m.sender === 'user';
const isClaude = (m) => m.sender === 'assistant';

// One conversation → a thread, or null when it holds no text at all. Each of your messages starts a turn; Claude's
// replies after it are its answer (an answer with no message before it gets a "…" prompt).
export function toThread(c) {
  if (!c || typeof c !== 'object' || !Array.isArray(c.chat_messages)) return null;
  const tid = cleanId(c.uuid) || hashId(`${str(c.created_at)}|${str(c.name)}|${c.chat_messages.length}`);
  const id = PREFIX + tid;
  const base = when(c.created_at, c.updated_at);
  const entries = [];
  let cur = null;
  c.chat_messages.forEach((m, i) => {
    if (!m || typeof m !== 'object' || (!isUser(m) && !isClaude(m))) return;
    const { text, think, tools } = partsOf(m);
    const at = when(m.created_at, m.updated_at) || base;
    if (isUser(m)) {
      const note = attachNote(m);
      const prompt = [text, note].filter(Boolean).join('\n\n');
      if (!prompt) return;
      cur = { id: 'c' + (cleanId(m.uuid) || `${tid.slice(0, 60)}-${i}`), kind: 'ask', prompt: cut(prompt, LIMITS.prompt), text: '', createdAt: at, params: {}, via: VIA, meta: { model: MODEL, note: NOTE } };
      entries.push(cur);
      return;
    }
    const answer = [text, tools.length ? `_[Claude used: ${tools.join(', ')}]_` : ''].filter(Boolean).join('\n\n');
    if (!answer && !think) return;
    if (!cur) {
      cur = { id: 'c' + (cleanId(m.uuid) || `${tid.slice(0, 60)}-${i}`), kind: 'ask', prompt: '…', text: '', createdAt: at, params: {}, via: VIA, meta: { model: MODEL, note: NOTE } };
      entries.push(cur);
    }
    cur.text = cut(cur.text ? `${cur.text}\n\n${answer}` : answer, LIMITS.text);
    if (think) cur.think = cut(cur.think ? `${cur.think}\n\n${think}` : think, LIMITS.think);
  });
  if (!entries.length) return null;
  const kept = entries.slice(-LIMITS.entries);
  const first = kept.find((e) => e.prompt !== '…')?.prompt || '';
  const title = (str(c.name).trim() || str(c.summary).trim().split('\n')[0] || first.split('\n')[0] || 'Untitled Claude chat').replace(/\s+/g, ' ').slice(0, LIMITS.title);
  const last = Math.max(...kept.map((e) => e.createdAt));
  return { id, title, createdAt: base || kept[0].createdAt, updatedAt: Math.max(when(c.updated_at), last), entries: kept };
}

// ── re-import ──
// Folds a newer export's copy (incoming, from toThread) into the thread already on this device (existing, changed IN
// PLACE so the sync engine can merge the save against what it read). New turns are added; an imported turn whose text
// changed in Claude (an answer that came later) is refreshed; turns made in Atelier and the thread's title are left alone.
// → 'new' (no existing: save incoming), 'grew' (existing changed: save it) or 'same' (nothing to save).
export function mergeThread(existing, incoming) {
  if (!existing) return 'new';
  const byId = new Map(existing.entries.map((e) => [e.id, e]));
  let changed = false;
  for (const e of incoming.entries) {
    const have = byId.get(e.id);
    if (!have) { existing.entries.push(e); changed = true; continue; }
    if (have.via !== VIA || have.pending) continue; // a turn the user re-ran in Atelier is theirs now
    for (const k of ['prompt', 'text', 'think']) {
      if ((e[k] ?? '') !== (have[k] ?? '')) { if (e[k] == null) delete have[k]; else have[k] = e[k]; changed = true; }
    }
  }
  if (!changed) return 'same';
  existing.entries.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (!existing.title) existing.title = incoming.title;
  existing.updatedAt = Math.max(existing.updatedAt || 0, incoming.updatedAt);
  return 'grew';
}

// ── in the app ──
export const isClaudeThread = (t) => Boolean(t) && ((typeof t.id === 'string' && t.id.startsWith(PREFIX)) || (Array.isArray(t.entries) && t.entries.some((e) => e?.via === VIA)));
// When a thread sorts in the Threads list: an imported chat by its newest turn (the same on every device; a synced copy's
// updatedAt is when it arrived), any other thread by updatedAt.
export function listAt(t) {
  if (!isClaudeThread(t) || !t.entries?.length) return t?.updatedAt || 0;
  let at = 0;
  for (const e of t.entries) if (Number.isFinite(e.createdAt) && e.createdAt > at) at = e.createdAt;
  return at || t.updatedAt || 0;
}
// The IndexedDB key range holding imported chats ('claude-' ids).
export const KEY_RANGE = [PREFIX, PREFIX + '￿'];
// claude-worker.js at this module's own ?v= (app.js imports it at ?v=<VERSION>; sw.js precaches both at that URL).
export const workerUrl = () => new URL(`./claude-worker.js${new URL(import.meta.url).search}`, import.meta.url).href;

// ── the accounts agent's tools (read-only, run in the browser) ──
const tool = (name, label, description, properties, required) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
  'x-write': false, 'x-label': label, 'x-service': 'claude',
});
export const CLAUDE_TOOLS = Object.freeze([
  tool('claude_history_search', 'Search your Claude chats', 'Search the user\'s own past claude.ai conversations (imported into Atelier) by keywords. Returns the best matches: id, title, dates, number of turns and a short snippet. Use a few distinctive words; try other words if nothing matches.',
    { query: { type: 'string', description: 'Keywords to look for' }, limit: { type: 'integer', description: 'Most results to return (1–20, default 8)' } }, ['query']),
  tool('claude_history_read', 'Read a Claude chat', 'Read turns of one imported Claude conversation by its id (from claude_history_search). Turns are numbered from 1; long ones are shortened. Ask for a range to read further.',
    { id: { type: 'string', description: 'Conversation id from claude_history_search' }, from: { type: 'integer', description: 'First turn (default 1)' }, to: { type: 'integer', description: 'Last turn (default: up to 12 turns from "from")' } }, ['id']),
]);
export const TOOL_NAMES = new Set(CLAUDE_TOOLS.map((t) => t.function.name));
const day = (t) => (t ? new Date(t).toISOString().slice(0, 10) : '');
const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
const terms = (q) => [...new Set(str(q).toLowerCase().replace(/["“”]/g, ' ').split(/[^\p{L}\p{N}_'-]+/u).filter((w) => w.length > 1))].slice(0, 12);
function count(hay, w, cap = 20) {
  let n = 0;
  for (let i = hay.indexOf(w); i >= 0 && n < cap; i = hay.indexOf(w, i + w.length)) n++;
  return n;
}
function snippet(text, w, n = 240) {
  const flat = text.replace(/\s+/g, ' ');
  const i = flat.toLowerCase().indexOf(w);
  if (i < 0) return clip(flat, n);
  const start = Math.max(0, i - Math.floor(n / 3));
  return (start ? '…' : '') + clip(flat.slice(start), n);
}
// threads: imported chats (isClaudeThread). Ranks by how many of the query's words a chat has, then by how often
// (a title match counts more), then newest. → { query, results: [{ id, title, created, updated, turns, snippet }] }.
export function searchHistory(threads, query, limit = 8) {
  const ws = terms(query);
  const n = Math.min(20, Math.max(1, Number.isFinite(+limit) ? Math.round(+limit) : 8));
  if (!ws.length) return { query: str(query), results: [], note: 'Give a few keywords to search for.' };
  const scored = [];
  for (const t of threads || []) {
    if (!isClaudeThread(t)) continue;
    const title = str(t.title).toLowerCase();
    const texts = t.entries.map((e) => `${str(e.prompt)}\n${str(e.text)}`);
    const lowers = texts.map((x) => x.toLowerCase());
    let words = 0, score = 0, best = -1, bestHits = 0, bestWord = ws[0];
    for (const w of ws) {
      let hit = title.includes(w) ? 5 : 0;
      lowers.forEach((l, k) => { const c = count(l, w); if (c) { hit += c; if (c > bestHits) { bestHits = c; best = k; bestWord = w; } } });
      if (hit) { words++; score += Math.min(hit, 40); }
    }
    if (!words) continue;
    scored.push({ t, words, score, at: listAt(t), snip: best >= 0 ? snippet(texts[best], bestWord) : clip(texts[0] || '', 240) });
  }
  scored.sort((a, b) => b.words - a.words || b.score - a.score || b.at - a.at);
  return {
    query: str(query), total: scored.length,
    results: scored.slice(0, n).map(({ t, snip }) => ({ id: t.id, title: t.title || 'Untitled', created: day(t.createdAt), updated: day(listAt(t)), turns: t.entries.length, snippet: snip })),
  };
}
// One chat's turns from..to (1-based, at most 12 and about 24,000 characters; each side cut to 4,000).
export function readHistory(thread, from = 1, to) {
  if (!thread || !isClaudeThread(thread)) return { error: 'No imported Claude conversation with that id. Use claude_history_search to find one.' };
  const total = thread.entries.length;
  const a = Math.min(Math.max(1, Math.round(+from) || 1), Math.max(1, total));
  const b = Math.min(total, Math.max(a, Math.round(+to) || a + 11), a + 11);
  const turns = [];
  let budget = 24_000;
  for (let k = a; k <= b && budget > 0; k++) {
    const e = thread.entries[k - 1];
    const you = clip(str(e.prompt), 4000), answer = clip(str(e.text), 4000);
    budget -= you.length + answer.length;
    turns.push({ turn: k, date: day(e.createdAt), you, answer, ...(e.via === VIA ? {} : { madeIn: 'Atelier' }) });
  }
  const last = turns.length ? turns.at(-1).turn : a - 1;
  return { id: thread.id, title: thread.title || 'Untitled', created: day(thread.createdAt), turns: total, from: a, to: last, ...(last < total ? { more: `Turns ${last + 1}–${total} not shown: ask for from=${last + 1}.` } : {}), messages: turns };
}
