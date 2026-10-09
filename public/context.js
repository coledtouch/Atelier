// Session context for chat turns: what earlier turns a model gets as text (history + compact notes for what it can't
// see), which earlier attachment a text follow-up is about, and where that follow-up goes. Pure — no DOM, no app
// state — so app.js and tests/context.test.mjs both import it.
import { cleanName, fmtDur, framesPlan, videoParts } from './video.js?v=88';

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
export const TESTER_HISTORY = Object.freeze({ min: 6, block: HISTORY_BLOCK });
export const VIDEO_CHAIN_TURNS = 10; // a video stays in view for this many chat turns after it was attached
export const IMAGE_FOLLOW_TURNS = 3; // photos attached to one of the last 3 chat turns are shown again to a follow-up
export const CTX_IMAGES = 6; // frames / photos a follow-up carries to the agent, web or vision path (testers: ≤ MAX_IMAGES)
const PROMPT_MAX = 400, ANSWER_MAX = 12000, THINK_MAX = 8000;

export function stripThink(s) {
  s = s.replace(/<think>[\s\S]*?(<\/think>|$)/g, '');
  const i = s.lastIndexOf('</think>');
  return i >= 0 ? s.slice(i + 8) : s;
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
// A user turn's content with x's send time in front: a first line for text, a first text part for content parts.
export function withSent(content, x) {
  const tag = sentTag(x);
  if (!tag) return content;
  if (typeof content === 'string') return `${tag}\n${content}`;
  return Array.isArray(content) ? [{ type: 'text', text: tag }, ...content] : content;
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
export function buildHistory(prior, { kinds = CHAT_KINDS, media, label, min = HISTORY_TURNS, block = HISTORY_BLOCK } = {}) {
  const { notes, turns } = historyTurns(prior, kinds, label);
  const msgs = [];
  for (const x of turns.slice(historyDrop(turns.length, { min, block }))) {
    const n = notes.get(x);
    if (n) { msgs.push({ role: 'user', content: n.user }, { role: 'assistant', content: n.assistant }); continue; }
    const att = attachNote(x);
    msgs.push({ role: 'user', content: withSent(media?.(x) || (att ? `${x.prompt}\n\n${att}` : x.prompt), x) });
    const m = { role: 'assistant', content: stripThink(x.text).slice(0, ANSWER_MAX) };
    if (x.think && /kimi/i.test(x.meta?.model || '')) m.reasoning_content = x.think.slice(0, THINK_MAX);
    msgs.push(m);
  }
  return msgs;
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
export const TAINTS = Object.freeze(['share', 'link', 'web', 'browser', 'import', 'legacy', 'claude']);
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
  // An imported Claude chat keeps claude.ai's dates: it is Claude text, never 'legacy' (which would hold back Claude history).
  if (x.via === 'claude') return worseTaint(why, 'claude');
  if (Number.isFinite(x.createdAt) && (x.createdAt < MARKS_SINCE || (hasMedia(x) && x.createdAt < MEDIA_MARKS_SINCE))) why = worseTaint(why, 'legacy');
  return why;
}
// Why one entry taints whatever follows it in its thread ('' when it doesn't). Defensive: synced and restored entries
// are only shape-checked (data-safety validateBackup), so steps or meta may be anything.
export function entryTaint(x) {
  if (!x || typeof x !== 'object') return '';
  const steps = Array.isArray(x.steps) ? x.steps.filter((st) => st && typeof st === 'object' && st.status === 'done') : [];
  let why = ownTaint(x);
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
  share: 'This thread contains something shared from another app or site, so reading your accounts waits for your OK. Start a new thread to skip this.',
  link: 'This thread contains text that came from a link, so reading your accounts waits for your OK. Start a new thread to skip this.',
  web: 'This thread contains web search results, and a page can try to steer the assistant, so reading your accounts waits for your OK. Start a new thread to skip this.',
  browser: 'This thread contains a web page or someone else’s GitHub content the assistant read, which can try to steer it, so reading your accounts waits for your OK. Start a new thread to skip this.',
  claude: 'This thread contains text from your Claude chats, which can hold pasted or web text, so reading your accounts waits for your OK. Start a new thread to skip this.',
  import: 'This thread was restored from a backup file, so reading your accounts waits for your OK. Start a new thread to skip this.',
  legacy: 'This thread is older than Atelier’s check for shared text and photos, so reading your accounts waits for your OK. Start a new thread to skip this.',
  page: 'Asked after reading a web page or someone else’s GitHub content in this answer: it can try to steer what the assistant does next, so reading your accounts now waits for your OK.',
  chats: 'Asked after reading your Claude chats in this answer: they can hold pasted or web text, so reading your accounts now waits for your OK.',
  'shared-chat': 'Asked after reading a Claude chat that holds something shared from another app or site, or text from a link: it can try to steer the assistant, so reading your accounts now waits for your OK.',
});
export const taintNote = (why) => (Object.hasOwn(TAINT_NOTES, why) ? TAINT_NOTES[why] : '');
