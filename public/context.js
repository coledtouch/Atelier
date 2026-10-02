// Session context for chat turns: what earlier turns a model gets as text (history + compact notes for what it can't
// see), which earlier attachment a text follow-up is about, and where that follow-up goes. Pure — no DOM, no app
// state — so app.js and tests/context.test.mjs both import it.
import { cleanName, fmtDur, framesPlan, videoParts } from './video.js?v=59';

export const CHAT_KINDS = ['ask', 'code'];
export const HISTORY_TURNS = 10; // earlier turns replayed (chat answers and notes alike)
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
    const secs = x.params?.aspect === '16:9hd' ? 8 : +x.params?.secs || (motion || /veo/.test(x.meta?.model || '') ? 6 : 4);
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

// The chat history before a turn: kinds (Ask/Code) replay as real turns — their prompt plus an attachment note, or the
// content parts media(x) returns for x (a replayed video) — and every other mode's output as a note pair, so a model
// switched in mid-thread still knows what happened. The last `max` turns of either sort; no binary data except what
// media(x) adds. Kimi gets its own reasoning back (reasoning_content).
export function buildHistory(prior, { kinds = CHAT_KINDS, media, label, max = HISTORY_TURNS } = {}) {
  const notes = new Map(), turns = [];
  for (const x of prior || []) {
    if (!x || x.error) continue;
    if (kinds.includes(x.kind)) { if (x.text) turns.push(x); continue; }
    const n = outputNote(x, label);
    if (n) { notes.set(x, n); turns.push(x); }
  }
  const msgs = [];
  for (const x of turns.slice(-max)) {
    const n = notes.get(x);
    if (n) { msgs.push({ role: 'user', content: n.user }, { role: 'assistant', content: n.assistant }); continue; }
    const att = attachNote(x);
    msgs.push({ role: 'user', content: media?.(x) || (att ? `${x.prompt}\n\n${att}` : x.prompt) });
    const m = { role: 'assistant', content: stripThink(x.text).slice(0, ANSWER_MAX) };
    if (x.think && /kimi/i.test(x.meta?.model || '')) m.reasoning_content = x.think.slice(0, THINK_MAX);
    msgs.push(m);
  }
  return msgs;
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
