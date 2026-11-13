// Session context for chat turns: what earlier turns a model gets as text (history + compact notes for what it can't
// see), which earlier attachment a text follow-up is about, and where that follow-up goes. Pure — no DOM, no app
// state — so app.js and tests/context.test.mjs both import it.
import { cleanName, fmtDur, framesPlan, videoParts } from './video.js?v=132';

export const CHAT_KINDS = ['ask', 'code'];
// Earlier turns replayed (chat answers and notes alike): every one while a thread has fewer than HISTORY_TURNS +
// HISTORY_BLOCK of them, then always at least the last HISTORY_TURNS (as before) and at most HISTORY_TURNS +
// HISTORY_BLOCK - 1. The oldest leave HISTORY_BLOCK at a time (historyDrop), so the replay starts at the same turn for
// HISTORY_BLOCK requests in a row and every provider's prompt cache (an exact-prefix match) keeps hitting; dropping one
// turn a request changed the front of the history every time.
export const HISTORY_TURNS = 10;
export const HISTORY_BLOCK = 5;
// A tester's window: the same blocks, never more than v86's 10 turns (6 to 10). The tester router reserves every replayed
// token at the cache-write rate with no credit for cache reads (a 5-minute entry may be gone by the next turn), so 11-14
// turns would trip the per-call cap on the bigger models (src/tester/prices.js maxTokensWithin) and switch model.
// filesRoom / filesBytes: a tester's file budget for one request (REPLAY_FILES below), in UTF-8 bytes: the router caps
// the whole conversation at 400 KB of text (src/tester/router.js LIMITS.chatText), and the answers replayed beside the
// files can take half of that.
export const TESTER_HISTORY = Object.freeze({ min: 6, block: HISTORY_BLOCK, filesRoom: 200_000, filesBytes: true });
export const VIDEO_CHAIN_TURNS = 10; // a video stays in view for this many chat turns after it was attached
export const IMAGE_FOLLOW_TURNS = 3; // photos attached to one of the last 3 chat turns are shown again to a follow-up
export const CTX_IMAGES = 6; // frames / photos a follow-up carries to the agent, web or vision path (testers: ≤ MAX_IMAGES)
const PROMPT_MAX = 400, ANSWER_MAX = 12000, THINK_MAX = 8000;

// Reasoning is a run of <think> blocks at the very start, or, with no opening tag, everything up to the last
// </think>. Tags later in the answer are the answer's own text (v114: an answer about the tags lost what sat
// between them). app.js splitThink reads them the same way.
export function stripThink(s) {
  if (!s.includes('<think>')) { const i = s.lastIndexOf('</think>'); return i >= 0 ? s.slice(i + 8) : s; }
  let t = s;
  for (;;) {
    const u = t.trimStart();
    if (!u.startsWith('<think>')) return t;
    const end = u.indexOf('</think>', 7);
    if (end < 0) return '';
    t = u.slice(end + 8);
  }
}
const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const videoName = (v) => [cleanName(v?.name) && `“${cleanName(v.name)}”`, fmtDur(v?.duration)].filter(Boolean).join(', ');

// What a chat turn had attached, for the text history (never the data itself): '' when nothing.
export function attachNote(x) {
  if (x?.video) return `[attached video${videoName(x.video) ? `: ${videoName(x.video)}` : ''}]`;
  const n = Array.isArray(x?.images) ? x.images.length : 0;
  return n ? `[attached ${plural(n, 'image')}]` : '';
}

// An Image / Video / Ideas / Build turn as a user + assistant pair of short notes, or null when it made nothing.
// label(id) names a model id ('gemini:gemini-3-pro-image' → 'Nano Banana Pro').
export function outputNote(x, label = (id) => id) {
  if (!x || x.error || x.pending) return null;
  // A Canva import (cvImport: an image / video entry with meta.model 'canva') was brought in, not made — no model, no length.
  if (x.canva) {
    const n = (x.media || []).filter((m) => m?.type === x.kind).length;
    if (!n || (x.kind !== 'image' && x.kind !== 'video')) return null;
    return { user: `[Imported from Canva] ${clip(x.prompt, PROMPT_MAX)}`,
      assistant: `[imported ${x.kind === 'video' ? (n === 1 ? 'a video' : plural(n, 'video')) : plural(n, 'image')} from Canva]` };
  }
  const by = x.meta?.model ? ` with ${label(x.meta.model)}` : '';
  const user = (mode) => `[${mode} mode] ${clip(x.prompt, PROMPT_MAX)}`;
  if (x.kind === 'image') {
    const n = (x.media || []).filter((m) => m?.type === 'image').length;
    if (!n) return null;
    const how = x.images?.length ? `edited the attached photo into ${plural(n, 'image')}` : `made ${plural(n, 'image')}`;
    return { user: user('Image'), assistant: `[${how}${by}${x.enhanced ? ` · prompt used: “${clip(x.enhanced, 300)}”` : ''}]` };
  }
  if (x.kind === 'video') {
    if (!(x.media || []).some((m) => m?.type === 'video')) return null;
    const motion = /motion-still/.test(x.meta?.model || '');
    // Veo's HD was always 8 s; Gemini Omni films the chosen length at any resolution.
    const omni = /omni/.test(x.meta?.model || '');
    const secs = x.params?.aspect === '16:9hd' && !omni ? 8 : +x.params?.secs || (motion || omni || /veo/.test(x.meta?.model || '') ? 6 : 4);
    return { user: user('Video'), assistant: `[made a ${secs} s ${motion ? 'motion-still video (a camera move over one image)' : 'video'}${x.images?.length ? ' from the attached image' : ''}${motion ? '' : by}]` };
  }
  if (x.kind === 'ideas') {
    const ideas = (x.ideas || []).filter((d) => d?.title);
    if (!ideas.length) return null;
    return { user: user('Ideas'), assistant: `[dealt ${plural(ideas.length, 'idea card')}: ${clip(ideas.map((d) => clip(d.title, 60)).join('; '), 600)}]` };
  }
  if (x.kind === 'build') {
    if (!x.app?.html) return null;
    return { user: user('Build'), assistant: `[${x.refineOf ? 'updated the web app' : 'built a web app'}: “${clip(x.app.title, 80)}”${by}]` };
  }
  return null;
}

// How many of n earlier turns the replay leaves out: none up to HISTORY_TURNS + HISTORY_BLOCK - 1, then whole blocks of
// HISTORY_BLOCK (n = 15…19 drop 5, 20…24 drop 10, …), so between min and min + block - 1 turns stay.
export function historyDrop(n, { min = HISTORY_TURNS, block = HISTORY_BLOCK } = {}) {
  const most = min + Math.max(1, block) - 1;
  return n > most ? Math.ceil((n - most) / Math.max(1, block)) * Math.max(1, block) : 0;
}

// ── a chat turn's send time ──
// The system prompt holds only today's date (app.js dateLine): a clock to the minute at the front of every request
// changed the whole cached prefix each minute. Each Ask / Code turn keeps the time it was sent (e.sent, set by app.js
// run() as text, in the sender's locale), and its user message starts with it — when it is sent and every time it is
// replayed, the same bytes — so the model knows "now" from the latest turn. Entries without one (older ones, notes,
// imported Claude turns) replay as they always did.
const SENT_MAX = 64;
export const sentText = (d = new Date()) => d.toLocaleString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
// '[Sent Thu, Oct 8, 2026, 2:32 PM]' for an entry with a send time, else ''. Synced and restored entries are only
// shape-checked, so the text is flattened (no brackets or line breaks) and capped before it goes into a prompt.
export function sentTag(x) {
  const s = typeof x?.sent === 'string' ? x.sent.replace(/[[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, SENT_MAX).trim() : '';
  return s ? `[Sent ${s}]` : '';
}
// v113: the documents attached to a turn (x.files, read on the device: files.js), as one block of text that goes in
// front of the turn's own words, in this turn and every replay of it. Synced and restored entries are only shape-checked
// (data-safety), so names are flattened and a closing tag inside a file's text can't end its block early.
const FILE_NAME_MAX = 120;
const fileName = (n) => String(n || 'file').replace(/["<>\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, FILE_NAME_MAX) || 'file';
// brief: a line per file in place of its text, for a replayed turn whose files no longer fit the request (buildHistory).
// A file the turn had no room for (files.js fitFiles: cut, with nothing kept) says so. Before v114 it read as "no
// text could be read" and "the file is longer" at once, and the model reported a reading failure for a file it was
// never sent.
const FILE_GONE = '[Sent earlier in this thread. Its text is not included now. Ask for the file again if you need it.]';
// What the app itself ever stores for a turn (files.js FILE_CHARS, FILES_CHARS; tests/app-v114.test.mjs keeps them
// equal). A restored backup or a synced entry is only shape-checked and may hold any length: it is cut to the same
// limits as it is read, so what the app made goes out byte for byte and nothing larger ever does (v114).
const FILE_CAP = 150_000, FILES_CAP = 250_000;
export function filesBlock(x, { brief = false } = {}) {
  const files = Array.isArray(x?.files) ? x.files.filter((f) => f && typeof f.text === 'string') : [];
  let left = FILES_CAP;
  return files.map((f) => {
    const kind = typeof f.kind === 'string' && /^[a-z]{1,8}$/.test(f.kind) ? ` type="${f.kind}"` : '';
    let room = Math.max(0, Math.min(FILE_CAP, left));
    const over = f.text.length > room;
    if (over && room > 0 && f.text.charCodeAt(room - 1) >= 0xd800 && f.text.charCodeAt(room - 1) <= 0xdbff) room--; // never half a pair
    const kept = over ? f.text.slice(0, room) : f.text;
    left -= kept.length;
    const body = kept.replace(/<\/attached_file/gi, '</attached-file');
    const cut = f.cut || over ? '\n[The file is longer. Only this first part was included.]' : '';
    const text = brief ? FILE_GONE : body ? `${body}${cut}` : f.cut || over ? '[This file was left out. The files before it filled the message.]' : '[No text could be read from this file.]';
    return `<attached_file name="${fileName(f.name)}"${kind}>\n${text}\n</attached_file>`;
  }).join('\n\n');
}
// A user turn's content with x's send time in front: a first line for text, a first text part for content parts.
// Its attached documents' text (filesBlock) comes right after the time, before the words that ask about them.
export function withSent(content, x, { brief = false } = {}) {
  const tag = sentTag(x), docs = filesBlock(x, { brief });
  if (!tag && !docs) return content;
  const head = [tag, docs].filter(Boolean).join('\n');
  if (typeof content === 'string') return `${head}${docs ? '\n\n' : '\n'}${content}`;
  return Array.isArray(content) ? [{ type: 'text', text: head }, ...content] : content;
}

// ── which remembered facts a system prompt carries ──
// persona() (app.js) lists the user's memory in the system prompt, the front of every request. A fact memory learning
// picked up after a turn (src 'chat': it runs once each answer is in) would change that front on the very next request
// and miss every provider's cache, so a request leaves out the learned facts newer than its memoryAnchor:
//   - the start of its run of the thread (runStart): back from this turn while the turns before it each started less
//     than SESSION_GAP after the one before (by then every cache this thread wrote has expired anyway, the 1-hour Claude
//     cache included). A fact learned mid-run from this thread is in the replayed history;
//   - and, once the replay has dropped turns (buildHistory trims whole blocks), the send time of the second turn it still
//     replays: a fact learned from a turn that left the window is then back in the system prompt (it would otherwise be in
//     neither). The anchor only moves at a block step, where the history's front changes anyway. (Not the first replayed
//     turn: learning from the last dropped one may finish just after it was sent. A fact from the first replayed turn may
//     then be in both, which costs nothing.)
// Facts the user added or imported themselves (any other src) are never held back: an explicit edit applies at once.
export const SESSION_GAP = 60 * 60_000;
// prior: the entries before e in its thread, oldest first. → when e's run of the thread began (ms).
export function runStart(prior, e, now = Date.now()) {
  let at = Number.isFinite(e?.createdAt) && e.createdAt <= now && now - e.createdAt < SESSION_GAP ? e.createdAt : now; // a retried old turn: now
  for (let i = (prior || []).length - 1; i >= 0; i--) {
    const t = prior[i]?.createdAt;
    if (!Number.isFinite(t) || at - t >= SESSION_GAP) break;
    at = Math.min(at, t);
  }
  return at;
}
// → the time (ms) a learned fact must not be newer than. win: the history window the request replays (buildHistory's
// kinds / min / block; app.js historyWindow).
export function memoryAnchor(prior, e, now = Date.now(), { kinds = CHAT_KINDS, min = HISTORY_TURNS, block = HISTORY_BLOCK } = {}) {
  const at = runStart(prior, e, now);
  const { turns } = historyTurns(prior, kinds);
  const drop = historyDrop(turns.length, { min, block });
  const second = drop ? turns[drop + 1]?.createdAt : undefined;
  return Number.isFinite(second) && second > at ? second : at;
}
// The facts a system prompt with this anchor lists: every one the user gave (src 'you', an import), the learned ones
// up to the anchor (an older fact without a time counts as old). No anchor: all of them.
export const factsFor = (memory, anchor) => (Number.isFinite(anchor) ? (memory || []).filter((m) => !(m?.src === 'chat' && m?.at > anchor)) : memory || []);

// ── a fact the system prompt states that can flip between requests, held for a run ──
// Whether the user's computer's browser is reachable right now (app.js: the relay status, polled before each turn, drops
// on a relay error, a sleeping computer, a network blip) would change the front of the next request each time it
// flipped — and the accounts agent's tool list, which goes first. Held per run of a thread (runStart), it moves only
// off → on (the browser came up: worth one miss for the tools it brings); once on in a run it stays stated and its tools
// stay offered until the run ends, and a call that then finds the computer offline gets the relay's own error back.
// memo: thread id → { run, v } (this tab's memory, the last RUN_MEMO threads; a reload starts again).
const RUN_MEMO = 50;
export function heldForRun(memo, id, run, live) {
  const was = memo.get(id);
  const v = was && was.run === run && was.v ? was.v : live;
  memo.delete(id); memo.set(id, { run, v });
  while (memo.size > RUN_MEMO) memo.delete(memo.keys().next().value);
  return v;
}

// The chat history before a turn: kinds (Ask/Code) replay as real turns — their prompt plus an attachment note, or the
// content parts media(x) returns for x (a replayed video), behind the turn's send time (withSent) — and every other
// mode's output as a note pair, so a model switched in mid-thread still knows what happened. Turns of either sort in
// blocks (historyDrop); no binary data except what media(x) adds. Kimi gets its own reasoning back (reasoning_content).
// A turn whose answer was declined partway (x.refused, app.js: finish 'content_filter') is left out like a failed one:
// the docs say to discard a partial answer a refusal cut off, not treat it as complete, and a refusal before any text is
// already an error.
// turn: the turn being sent, whose own files count against the file budget first (filesRoom, in characters, or in
// UTF-8 bytes with filesBytes: a tester's, TESTER_HISTORY).
export function buildHistory(prior, { kinds = CHAT_KINDS, media, label, min = HISTORY_TURNS, block = HISTORY_BLOCK, turn = null, filesRoom = REPLAY_FILES, filesBytes = false } = {}) {
  const { notes, turns } = historyTurns(prior, kinds, label);
  const replayed = turns.slice(historyDrop(turns.length, { min, block }));
  const brief = filesOver(replayed.filter((x) => !notes.has(x)), filesRoom - filesSize(turn, filesBytes), filesBytes);
  const msgs = [];
  for (const x of replayed) {
    const n = notes.get(x);
    if (n) { msgs.push({ role: 'user', content: n.user }, { role: 'assistant', content: n.assistant }); continue; }
    const att = attachNote(x);
    msgs.push({ role: 'user', content: withSent(media?.(x) || (att ? `${x.prompt}\n\n${att}` : x.prompt), x, { brief: brief.has(x) }) });
    const m = { role: 'assistant', content: stripThink(x.text).slice(0, ANSWER_MAX) };
    if (x.think && /kimi/i.test(x.meta?.model || '')) m.reasoning_content = x.think.slice(0, THINK_MAX);
    msgs.push(m);
  }
  return msgs;
}
// ── one budget for the file text a request carries (v114) ──
// Every follow-up used to send every replayed turn's files again in full: up to 250,000 characters a turn, 14 turns.
// A thread that outgrew the model's window could then not be asked anything more (a failed turn never enters the
// history, so the window never moved). The files of the turn being sent and of the replayed turns now share
// REPLAY_FILES characters, counted from the newest back: once a turn's files don't fit, that turn and every older one
// replay with a line per file in place of its text (filesBlock brief). The choice moves only when a turn with files is
// sent, never between plain follow-ups (the turn being sent counts first, and counts the same once it is the newest
// replayed one), so the cached front of the history holds as it does between block steps.
export const REPLAY_FILES = 500_000;
function filesSize(x, bytes = false) {
  let n = 0;
  for (const f of Array.isArray(x?.files) ? x.files : []) {
    const s = typeof f?.text === 'string' ? f.text : '';
    if (!bytes) { n += s.length; continue; }
    for (let i = 0; i < s.length; i++) { const cp = s.codePointAt(i); n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4; if (cp > 0xffff) i++; }
  }
  return n;
}
// turns: replayed chat turns, oldest first. → the ones whose files no longer fit `room`.
function filesOver(turns, room, bytes) {
  const over = new Set();
  let left = room, full = false;
  for (let i = turns.length - 1; i >= 0; i--) {
    const n = filesSize(turns[i], bytes);
    if (!n) continue;
    if (full || n > left) { full = true; over.add(turns[i]); } else left -= n;
  }
  return over;
}
// The turns buildHistory can replay, oldest first, before the window: answered chat turns, and other modes' work as notes.
function historyTurns(prior, kinds = CHAT_KINDS, label) {
  const notes = new Map(), turns = [];
  for (const x of prior || []) {
    if (!x || x.error || x.refused) continue;
    if (kinds.includes(x.kind)) { if (x.text) turns.push(x); continue; }
    const n = outputNote(x, label);
    if (n) { notes.set(x, n); turns.push(x); }
  }
  return { notes, turns };
}

// Which video a typed follow-up keeps in view: the last chat turn's own video, or the one it was itself following up on,
// while that video is within the last VIDEO_CHAIN_TURNS chat turns. chats: the thread's Ask/Code entries, oldest first.
export function videoSource(chats) {
  const prev = chats.at(-1);
  const src = prev?.video ? prev : prev?.videoOf ? chats.find((x) => x.id === prev.videoOf && x.video) : null;
  return src && chats.slice(-VIDEO_CHAIN_TURNS).includes(src) ? src : null;
}

// The earlier attachment a text follow-up e is about: e.videoOf's video (set at send time, see videoSource), else photos
// attached to one of the last IMAGE_FOLLOW_TURNS chat turns that didn't fail or get stopped (like buildHistory, an
// errored turn is skipped: its photo may be what failed, or the wrong one). null for a turn with its own attachments
// or a task split.
export function pickContext(prior, e) {
  if (!e || e.video || e.images?.length || e.group) return null;
  if (e.videoOf) { const src = (prior || []).find((x) => x.id === e.videoOf && x.video); return src ? { kind: 'video', src } : null; }
  const src = (prior || []).filter((x) => CHAT_KINDS.includes(x.kind)).slice(-IMAGE_FOLLOW_TURNS).findLast((x) => x.images?.length && !x.error);
  return src ? { kind: 'images', src } : null;
}

// The question is plainly about the attachment itself (a timestamp counts).
export const ABOUT_MEDIA = /\b(videos?|clips?|footage|frames?|scenes?|timestamps?|photos?|pictures?|pics?|images?|screenshots?|attach(ed|ments?))\b|\b\d{1,2}:\d{2}\b/i;
// The prompt itself asks for the web ("search the web for…", "…online", "look it up"): beats ABOUT_MEDIA, so "find
// similar videos online" with the Web toggle on still searches.
export const ASKS_WEB = /\b(search (for|the web|the internet|online)|web search|google|look (it|this|that|them|these|those) up|online|on the (web|internet)|internet|websites?)\b/i;

// Where a chat turn goes. hasImg: it has its own photos. ctx: pickContext's kind. agent: wantsAgent. web: live web is
// wanted (the Web toggle or a time-sensitive word, FRESH_HINT) and usable. webToggle: the Web toggle itself is on (and
// web usable). about: ABOUT_MEDIA matches. asksWeb: ASKS_WEB matches. Rules:
// · own photos → 'vision' (as before: no agent, web, deep think or escalation; "As me" still applies).
// · the accounts agent wins whenever it's wanted — it gets the earlier frames / photos with the prompt.
// · an earlier video: 'watch' (Gemini, the full clip with audio) unless the Web toggle is on AND the question isn't
//   plainly about the clip or explicitly asks for the web — then 'web' (Claude + search, with capped silent frames).
//   A time-sensitive word alone ("who won?", "the price on the sign", "what song is playing right now") never pulls a
//   video follow-up off the clip: those are usually questions about what's in it.
// · earlier photos: 'web' whenever web is wanted (Claude sees the photos there in full), else 'photos': runChat keeps
//   the turn's own role and model (Code, Deep think, "As me", escalation, a pin) when that model reads images, and
//   hands it to the Vision model only when it can't (photoFollowUp).
// · nothing attached: 'chat' (plain / web / think / voice / escalate, decided by runChat).
export function followUpRoute({ hasImg = false, ctx = null, agent = false, web = false, webToggle = false, about = false, asksWeb = false } = {}) {
  if (hasImg) return 'vision';
  if (agent) return 'agent';
  if (ctx === 'video') return web && webToggle && (!about || asksWeb) ? 'web' : 'watch';
  if (web) return 'web';
  return ctx === 'images' ? 'photos' : 'chat';
}

// The model an earlier-photos follow-up ('photos') uses: the turn's own role and model when that model reads images
// (sees), so effort, first-token time, escalation and Deep think stay what they'd be without the photos; else the
// Vision role and model.
export function photoFollowUp({ role, model, visionModel, sees }) {
  return sees(model) ? { role, model } : { role: 'vision', model: visionModel };
}

// Whether model id reads images: every Claude / GPT / Gemini model, plus the ids listed (the Vision and Video role
// lists, and the user's own Vision / Video picks from Settings, which were chosen to see images).
export function readsImages(id, listed = []) {
  return Boolean(id) && (/^(anthropic|openai|gemini):/.test(id) || listed.includes(id));
}

// The user turn of a follow-up carrying ctx's frames or photos (at most cap) for a model that reads images (sees),
// else the prompt behind a text note. note: for e.meta.note.
export function mediaTurn(prompt, ctx, { cap = CTX_IMAGES, sees = true } = {}) {
  if (!ctx) return { content: prompt, note: '', n: 0 };
  if (ctx.kind === 'video') {
    const v = ctx.src.video, plan = framesPlan(v, cap), named = videoName(v) ? ` (${videoName(v)})` : '';
    if (sees && plan.n) {
      return { content: [{ type: 'text', text: 'This message follows up on a video the user attached earlier in this conversation.' }, ...videoParts(v, plan), { type: 'text', text: prompt }],
        note: `${plan.n} video frames`, n: plan.n };
    }
    return { content: `[Earlier in this conversation the user attached a video${named}. ${plan.n ? 'This model can’t see its frames' : 'Its frames aren’t available'} — answer from the earlier replies about it, and say so if they don’t cover the question.]\n\n${prompt}`,
      note: 'video as a text note', n: 0 };
  }
  const imgs = (ctx.src.images || []).slice(0, Math.max(0, cap));
  if (sees && imgs.length) {
    return { content: [{ type: 'text', text: `This message follows up on ${imgs.length === 1 ? 'an image' : `${imgs.length} images`} the user attached earlier in this conversation, shown again here.` },
      ...imgs.map((url) => ({ type: 'image_url', image_url: { url } })), { type: 'text', text: prompt }], note: `${plural(imgs.length, 'earlier image')}`, n: imgs.length };
  }
  return { content: `[Earlier in this conversation the user attached ${plural((ctx.src.images || []).length, 'image')}. This model can’t see them — answer from the earlier replies about them, and say so if they don’t cover the question.]\n\n${prompt}`,
    note: 'earlier images as a text note', n: 0 };
}

// ── untrusted text in an accounts-agent turn's context ──
// The accounts agent (app.js runAgent) reads the user's accounts without asking only while everything in its context is
// the user's own: an earlier turn replays as history (buildHistory), and an answer can quote a turn long after that
// turn has left the history window, so the whole thread before the turn counts, not just the replayed part — and so do
// the turn's own words when they may not be the user's (ownTaint: a retried old or restored turn). Reasons, most telling
// first (the approval card names the first that applies):
//   share    e.untrusted 'share' (text or files shared from another app or site: anyone can POST a share), or a Claude
//            history read that returned such a turn (step.untrusted)
//   link     e.untrusted 'link' (an unkeyed or wrong-key link, a restored link draft)
//   web      an answer from a live web search (e.web = searches it ran; older entries: meta.note 'live web')
//   browser  an agent step that read a page in the browser (any browser tool but browser_show; titles count), or GitHub
//            content from outside your accounts (st.outside: another owner's repo; any GitHub search)
//   import   an entry restored from a backup file (e.imported, set by data-safety prepareImport): a file can say anything
//   legacy   an entry from before shares and links were marked (MARKS_SINCE), or photos / a video from before shared
//            files were marked (MEDIA_MARKS_SINCE): an old share looks like your own words
//   claude   a turn imported from claude.ai (via 'claude': pasted articles, documents, Claude's own web results) or a
//            Claude history read (claude_history_*). It holds back account and browser tools, never more Claude history —
//            and it ranks last, so it is the reason only when it is the only one: with any other, Claude history waits too.
// Own words (typed, pasted, dictated, a keyed launch), your own photos, and what your accounts returned (mail, Slack,
// Drive…) never taint: asking before every read in an inbox thread is the cost this avoids.
export const TAINTS = Object.freeze(['share', 'link', 'web', 'browser', 'file', 'import', 'legacy', 'claude']);
// v56 (2026-10-02) began marking link and share turns (e.untrusted); entries made before the next day may be unmarked shares.
export const MARKS_SINCE = Date.UTC(2026, 9, 3);
// v84 began marking photos and videos that came with a share (never marked before): an entry with photos or a video
// made before this day may be an unmarked share. It must not be earlier than the day v84 reached every device.
export const MEDIA_MARKS_SINCE = Date.UTC(2026, 9, 10);
const markOf = (v) => (!v ? '' : v === 'link' ? 'link' : 'share');
const isBrowserStep = (st) => st.service === 'browser' || /^browser_/.test(String(st.name || ''));
const isClaudeStep = (st) => st.service === 'claude' || /^claude_history_/.test(String(st.name || ''));
const hasMedia = (x) => (Array.isArray(x.images) && x.images.length > 0) || Boolean(x.video);
// An agent step whose result put outside text in the context: every browser tool but browser_show (which only brings a
// tab to the front) returns page text, controls or at least titles, all written by whoever made the page; so does a
// GitHub search (it spans all of GitHub) or a GitHub read from a repo none of your accounts owns (st.outside, runAgent).
export const readsPage = (st) => Boolean(st) && ((isBrowserStep(st) && st.name !== 'browser_show') || st.outside === true || st.name === 'github_search');
// GitHub reads that say whose repo they read: from v91 runAgent writes st.outside as a boolean on every one. Before v84
// nothing marked them, and v84–v90 wrote only outside: true. A read without the key in an entry from before every device
// ran v84 (MEDIA_MARKS_SINCE) can't be told apart from someone else's repo: it counts as one.
const GITHUB_READS = new Set(['github_read', 'github_issues']);
const githubLegacy = (st, x) => GITHUB_READS.has(st.name) && !('outside' in st) && Number.isFinite(x?.createdAt) && x.createdAt < MEDIA_MARKS_SINCE;
// The origin of a browser result's address ('' for none, or an opaque one: about:blank, data:, file:). Another look at a
// tab runs unasked only while the tab is still on the origin read before (app.js runAgent).
export function pageOrigin(url) {
  try { const o = new URL(String(url ?? '')).origin; return o && o !== 'null' ? o : ''; } catch { return ''; }
}
// The first of two reasons in TAINTS order ('' counts as none).
export const worseTaint = (a, b) => (!a ? b || '' : !b ? a : TAINTS.indexOf(b) >= 0 && TAINTS.indexOf(b) < TAINTS.indexOf(a) ? b : a);
// Why an entry's own words may not be the user's ('' when they are): its mark, an imported Claude turn, a restored
// entry, one older than the marks. Not what its run did (searches, steps): entryTaint adds those. A turn being run (or
// retried) counts its own (app.js runAgent), and the memory learner skips it (learnFrom).
export function ownTaint(x) {
  if (!x || typeof x !== 'object') return '';
  let why = markOf(x.untrusted);
  if (x.imported) why = worseTaint(why, 'import');
  // v113: an attached document is outside text too (a PDF from anywhere can carry words aimed at the assistant).
  if (Array.isArray(x.files) && x.files.length) why = worseTaint(why, 'file');
  // An imported Claude chat keeps claude.ai's dates: it is Claude text, never 'legacy' (which would hold back Claude history).
  if (x.via === 'claude') return worseTaint(why, 'claude');
  if (Number.isFinite(x.createdAt) && (x.createdAt < MARKS_SINCE || (hasMedia(x) && x.createdAt < MEDIA_MARKS_SINCE))) why = worseTaint(why, 'legacy');
  return why;
}
// Why one entry taints whatever follows it in its thread ('' when it doesn't). Defensive: synced and restored entries
// are only shape-checked (data-safety validateBackup), so steps or meta may be anything.
// x.ranTaint: what an earlier run of this entry read, kept when Retry cleared its steps (app.js; STICKY in sync-merge).
// A GitHub read or issue list written before v84 marked outside repos (no 'outside' key, an entry older than
// MEDIA_MARKS_SINCE) may have been someone else's repo: it counts as one (githubLegacy), since nothing recorded whose.
export function entryTaint(x) {
  if (!x || typeof x !== 'object') return '';
  const steps = Array.isArray(x.steps) ? x.steps.filter((st) => st && typeof st === 'object' && st.status === 'done') : [];
  let why = ownTaint(x);
  if (typeof x.ranTaint === 'string' && TAINTS.includes(x.ranTaint)) why = worseTaint(why, x.ranTaint);
  if (steps.some((st) => githubLegacy(st, x))) why = worseTaint(why, 'browser');
  for (const st of steps) if (st.untrusted) why = worseTaint(why, markOf(st.untrusted));
  if ((Number.isFinite(x.web) && x.web > 0) || /\blive web\b/.test(typeof x.meta?.note === 'string' ? x.meta.note : '')) why = worseTaint(why, 'web');
  if (steps.some(readsPage)) why = worseTaint(why, 'browser');
  if (steps.some(isClaudeStep)) why = worseTaint(why, 'claude');
  return why;
}
// Why an agent turn's context carries untrusted text: any entry before it in the thread (prior), and the earlier video or
// photos a follow-up shows again (ctx, pickContext: its src is one of prior's, counted on its own too). '' when none.
export function threadTaint(prior, ctx = null) {
  let why = '';
  for (const x of prior || []) { why = worseTaint(why, entryTaint(x)); if (why === TAINTS[0]) return why; }
  return worseTaint(why, entryTaint(ctx?.src));
}
// Whether reason why holds back a tool of this service: every reason holds back every tool, except that text from
// Claude chats alone ('claude' ranks last, so it is never the reason when another applies) doesn't hold back reading
// more of the same chats.
export const taintGates = (why, service) => Boolean(why) && !(why === 'claude' && service === 'claude');
// The approval card's sentence for a step that waits because of why (thread reasons, plus reasons from earlier in the
// same answer: 'page' a page read, 'chats' Claude chats read, 'shared-chat' a Claude chat holding a shared or linked
// turn). '' for anything else.
const TAINT_NOTES = Object.freeze({
  share: 'This thread holds something shared from another app or site. So reading your accounts waits for your OK. Start a new thread to skip this.',
  link: 'This thread holds text from a link. So reading your accounts waits for your OK. Start a new thread to skip this.',
  web: 'This thread holds web search results, and a page can try to steer the assistant. So reading your accounts waits for your OK. Start a new thread to skip this.',
  browser: 'The assistant read a web page or someone else’s GitHub content in this thread. That text can try to steer it. So reading your accounts waits for your OK. Start a new thread to skip this.',
  claude: 'This thread holds text from your Claude chats, which can include pasted or web text. So reading your accounts waits for your OK. Start a new thread to skip this.',
  file: 'This thread holds an attached file, and its text can try to steer the assistant. So reading your accounts waits for your OK. Start a new thread to skip this.',
  import: 'This thread was restored from a backup file, so reading your accounts waits for your OK. Start a new thread to skip this.',
  legacy: 'This thread is older than Atelier’s check for shared text and photos. So reading your accounts waits for your OK. Start a new thread to skip this.',
  page: 'Asked after reading a web page or someone else’s GitHub content in this answer. That text can try to steer the assistant. So reading your accounts now waits for your OK.',
  chats: 'Asked after reading your Claude chats in this answer. They can include pasted or web text. So reading your accounts now waits for your OK.',
  'shared-chat': 'Asked after reading a Claude chat that holds a share or text from a link. That text can try to steer the assistant. So reading your accounts now waits for your OK.',
});
export const taintNote = (why) => (Object.hasOwn(TAINT_NOTES, why) ? TAINT_NOTES[why] : '');

// Settings → Connections → Browser → "Open pages unasked" (owner, per device): a look in the owner's browser runs without
// an approval card. That covers opening a page, reading one (open tab or by address), listing tabs and page controls,
// and bringing a tab forward. It never covers a click or typing (a write), any tool outside the browser, or a turn
// that began from a link or a share (untrusted): those ask as before. What a page says still counts as outside text,
// so account tools keep waiting for the OK after one is read.
export const browseUnasked = (step, { on = false, untrusted = false } = {}) =>
  on === true && !untrusted && step?.service === 'browser' && step.write !== true;

// Settings → Connections → Approvals → "Read accounts unasked" (owner, per device): a read in a connected account
// (Gmail, Slack, GitHub, Claude history…) runs without an approval card, even after a page or a web search put outside
// text in the context. Never a write, never a browser step (browseUnasked covers those), never a link or share turn.
export const readUnasked = (step, { on = false, untrusted = false } = {}) =>
  on === true && !untrusted && Boolean(step?.service) && step.service !== 'browser' && step.write !== true;
// The one stop both settings keep. Outside text can try to steer the assistant, and account data is what it could carry
// off; a web address the model chose (browser_open, browser_read by address) is the way out. With all three at once the
// step asks, whatever the settings say. Web search, the other way out, is already withdrawn once account data is read.
export const leavesWithData = ({ wayOut = false, outside = false, data = false } = {}) => Boolean(wayOut && outside && data);

// A thread the accounts agent is already working in: the turn before this one (the latest Ask or Code entry) was the
// agent's. A follow-up with no account or browser word in it ("yes, do that", "open the first one") then stays with the
// tools. Before v106 it went to a plain chat model, which answered as if it had no Gmail or browser at all.
// prior: the thread's entries before this turn.
export function agentThread(prior) {
  for (let i = (prior?.length || 0) - 1; i >= 0; i--) {
    const x = prior[i];
    // An agent turn has steps, or (when it called no tool) its note. An empty steps list alone is not one: every entry
    // of a restored backup carries one (data-safety importedSteps), so each restored chat looked like the agent's, and
    // its first follow-up went to the tools and stayed there (v114).
    if (x?.kind === 'ask' || x?.kind === 'code') return (Array.isArray(x.steps) && x.steps.length > 0) || /accounts agent/.test(x.meta?.note || '');
  }
  return false;
}

// Settings → Connections → Approvals → "Approve everything" (owner, per device): every step the agent takes runs with no
// approval card, writes included (send, post, pay, change, click, type), and the way-out stop is off too. The owner asked
// for this knowing a page or an email can steer the assistant. One thing stays: a turn that began from a link or a share.
export const approvesAll = ({ on = false, untrusted = false } = {}) => on === true && !untrusted;

// v108: the three approval switches follow the owner's account. They ride in the synced "You" profile (ME.approvals),
// so turning one on or off on any signed-in device covers them all. A switch the profile has never held falls back to
// this device's own old setting. A true or false in the profile always wins, so turning one off sticks everywhere.
export const APPROVAL_KEYS = ['approveAll', 'browserUnasked', 'accountsUnasked'];
export const standingOn = (synced, local) => (typeof synced === 'boolean' ? synced : local === true);
// Switches this device has on that the profile has never held: copied up once, so an older device's choice spreads.
export const approvalsToSeed = (synced, local) => {
  const have = synced && typeof synced === 'object' ? synced : {};
  const out = {};
  for (const k of APPROVAL_KEYS) if (typeof have[k] !== 'boolean' && local?.[k] === true) out[k] = true;
  return out;
};

// ── the You profile across devices and tabs (v114) ──
// The owner's profile (bio, style, memory, the three approval switches above) is one record on the server, and every
// device used to send its whole copy, newest wins. A tab left open since morning then wrote its old copy back hours
// later: facts the phone had learned were gone, and "Approve everything", turned off on the phone, came back on for
// every device. mergeProfile joins the two copies field by field instead, against the copy this browser last knew the
// server to hold (base: app.js keeps it beside the profile):
//   - a text field: the side that changed it since base. Both did: the side whose profile is newer.
//   - an approval switch: the side that changed it since base. With no base to say who did, a disagreement is off.
//   - memory: the server's facts, minus the ones forgotten here since base, plus the ones added here since base. A
//     fact forgotten on the other device stays forgotten. The same words are kept once; oldest first, the newest
//     MEMORY_MAX.
//   - import sources: both sides', the later import of each.
// With no base (a browser that has not synced since this shipped) nothing can be called a local change: the newer
// profile's text wins as it did before, and memory is both sides' together.
// The server's copy leads the order of everything, so two devices that hold the same things end with the same record
// and stop sending it to each other.
export const PROFILE_TEXT = Object.freeze(['name', 'bio', 'learned', 'style', 'samples']);
export const MEMORY_MAX = 400;
const record = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const factsOf = (p) => (Array.isArray(p?.memory) ? p.memory.filter((f) => f && typeof f === 'object' && typeof f.id === 'string' && typeof f.text === 'string') : []);
// → { profile, changed }. changed: the result is not what the server holds, so it has to be sent (it carries `now`).
export function mergeProfile(base, mine, theirs, now = Date.now()) {
  const b = base && typeof base === 'object' && !Array.isArray(base) ? base : null, m = record(mine), t = record(theirs);
  const mineNewer = (Number(m.updatedAt) || 0) > (Number(t.updatedAt) || 0);
  const out = { ...t };
  for (const k of PROFILE_TEXT) {
    const mv = typeof m[k] === 'string' ? m[k] : '', tv = typeof t[k] === 'string' ? t[k] : '', bv = typeof b?.[k] === 'string' ? b[k] : '';
    const v = mv === tv ? mv : b && mv !== bv && tv === bv ? mv : b && tv !== bv && mv === bv ? tv : mineNewer ? mv : tv;
    if (v || typeof t[k] === 'string') out[k] = v;
  }
  const is = (x) => typeof x === 'boolean', switches = { ...record(t.approvals) };
  for (const k of APPROVAL_KEYS) {
    const mv = m.approvals?.[k], tv = t.approvals?.[k], bv = b?.approvals?.[k];
    const v = !is(mv) ? tv : !is(tv) ? mv : mv === tv ? mv : is(bv) ? (mv !== bv ? mv : tv) : false;
    if (is(v)) switches[k] = v; else delete switches[k];
  }
  if (Object.keys(switches).length || t.approvals) out.approvals = switches;
  const M = factsOf(m), T = factsOf(t);
  let facts;
  if (b) {
    const known = new Set(factsOf(b).map((f) => f.id)), here = new Set(M.map((f) => f.id)), there = new Set(T.map((f) => f.id));
    facts = T.filter((f) => !(known.has(f.id) && !here.has(f.id))).concat(M.filter((f) => !known.has(f.id) && !there.has(f.id)));
  } else {
    const there = new Set(T.map((f) => f.id));
    facts = T.concat(M.filter((f) => !there.has(f.id)));
  }
  const said = new Set();
  out.memory = facts.map((f, i) => [f, i]).sort((p, q) => (Number(p[0].at) || 0) - (Number(q[0].at) || 0) || p[1] - q[1]).map(([f]) => f)
    .filter((f) => { const words = f.text.trim().toLowerCase(); if (said.has(words)) return false; said.add(words); return true; }).slice(-MEMORY_MAX);
  const sources = { ...record(t.sources) };
  for (const [k, v] of Object.entries(record(m.sources))) if (!sources[k] || (Number(v?.at) || 0) > (Number(sources[k]?.at) || 0)) sources[k] = v;
  if (Object.keys(sources).length || t.sources) out.sources = sources;
  const body = (p) => { const { updatedAt, ...rest } = p; return JSON.stringify(rest); };
  const changed = body(out) !== body(t);
  // A change is stamped later than the copy it was joined against, whatever this device's clock says: the Worker and
  // the app both tell a newer copy from an older one by this number alone.
  out.updatedAt = changed ? Math.max(now, (Number(t.updatedAt) || 0) + 1) : Number(t.updatedAt) || 0;
  return { profile: out, changed };
}

// ── which remembered facts reach a prompt (v114) ──
// The profile keeps up to MEMORY_MAX facts and a system prompt carries FACTS_IN_PROMPT of them. It used to be the
// newest ones, whoever added them: a fact the user typed in by hand ("I am allergic to penicillin") dropped out once
// sixty newer ones had been learned from chats, with nothing to show it had stopped counting. Hand-added facts
// (src 'you') now go first, the newest of them if there are more than fit, then the newest of the rest. The order
// stays the stored one (oldest first): the list sits in the cached front of every request.
export const FACTS_IN_PROMPT = 60;
export function factsInUse(memory, max = FACTS_IN_PROMPT) {
  const list = Array.isArray(memory) ? memory.filter((f) => f && typeof f.text === 'string') : [];
  if (list.length <= max) return list;
  const own = list.filter((f) => f.src === 'you').slice(-max), room = max - own.length;
  const keep = new Set([...own, ...(room > 0 ? list.filter((f) => f.src !== 'you').slice(-room) : [])]); // (slice(-0) would be all of them)
  return list.filter((f) => keep.has(f));
}
