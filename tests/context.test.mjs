// Session context (public/context.js): history notes, which earlier attachment a follow-up carries, and where it goes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CHAT_KINDS, HISTORY_TURNS, HISTORY_BLOCK, VIDEO_CHAIN_TURNS, IMAGE_FOLLOW_TURNS, CTX_IMAGES, ABOUT_MEDIA, ASKS_WEB,
  stripThink, attachNote, outputNote, buildHistory, videoSource, pickContext, followUpRoute, photoFollowUp, readsImages, mediaTurn,
} from '../public/context.js';
import { MAX_IMAGES } from '../public/tester.js';

const IMG = (c = 'A') => `data:image/jpeg;base64,${c.repeat(12)}`;
const frames = (n) => Array.from({ length: n }, (_, i) => ({ t: i * 2 + 0.5, src: IMG(String.fromCharCode(65 + (i % 26))) }));
const VIDEO = (over = {}) => ({ name: 'beach.mp4', mime: 'video/mp4', size: 1000, duration: 42, width: 640, height: 360, poster: null, frames: frames(12), ...over });
let n = 0;
const ask = (over = {}) => ({ id: `e${++n}`, kind: 'ask', prompt: `question ${n}`, createdAt: n, text: `answer ${n}`, ...over });
const binary = (msgs) => JSON.stringify(msgs).includes('base64');

test('stripThink drops <think> blocks and anything before a closing tag', () => {
  assert.equal(stripThink('<think>hmm</think>Hello'), 'Hello');
  assert.equal(stripThink('reasoning</think>Answer'), 'Answer');
  assert.equal(stripThink('<think>still going'), '');
  assert.equal(stripThink('plain'), 'plain');
});

test('attachNote names attachments without their data', () => {
  assert.equal(attachNote(ask()), '');
  assert.equal(attachNote(ask({ images: [IMG()] })), '[attached 1 image]');
  assert.equal(attachNote(ask({ images: [IMG(), IMG('B')] })), '[attached 2 images]');
  assert.equal(attachNote(ask({ video: VIDEO() })), '[attached video: “beach.mp4”, 0:42]');
  assert.equal(attachNote(ask({ video: VIDEO({ name: '', duration: 0 }) })), '[attached video]');
});

test('outputNote summarizes each other mode, and nothing for failed, pending or empty turns', () => {
  const label = (id) => ({ 'gemini:gemini-3-pro-image': 'Nano Banana Pro', 'gemini:veo-3.1-lite-generate-preview': 'Veo 3.1 Lite' }[id] || id);
  const image = { id: 'i', kind: 'image', prompt: 'a lighthouse at dusk', createdAt: 1, meta: { model: 'gemini:gemini-3-pro-image' }, media: [{ type: 'image', src: IMG() }, { type: 'image', src: IMG('B') }] };
  assert.deepEqual(outputNote(image, label), { user: '[Image mode] a lighthouse at dusk', assistant: '[made 2 images with Nano Banana Pro]' });
  assert.match(outputNote({ ...image, enhanced: 'A weathered lighthouse, golden hour' }, label).assistant, /prompt used: “A weathered lighthouse, golden hour”/);
  assert.match(outputNote({ ...image, images: [IMG()], media: [{ type: 'image', src: IMG() }] }, label).assistant, /^\[edited the attached photo into 1 image with Nano Banana Pro\]$/);
  const veo = { id: 'v', kind: 'video', prompt: 'waves', createdAt: 1, params: { aspect: '16:9', secs: 6 }, meta: { model: 'gemini:veo-3.1-lite-generate-preview' }, media: [{ type: 'video', src: 'data:video/mp4;base64,AAAA' }] };
  assert.deepEqual(outputNote(veo, label), { user: '[Video mode] waves', assistant: '[made a 6 s video with Veo 3.1 Lite]' });
  assert.match(outputNote({ ...veo, params: { aspect: '16:9hd', secs: 4 } }, label).assistant, /made a 8 s video/);
  assert.match(outputNote({ ...veo, meta: { model: 'atelier/motion-still' }, params: { secs: 4 } }, label).assistant, /^\[made a 4 s motion-still video \(a camera move over one image\)\]$/);
  const ideas = { id: 'd', kind: 'ideas', prompt: 'bakery names', createdAt: 1, ideas: [{ title: 'Crumb & Co', pitch: 'x' }, { title: 'Rise', pitch: 'y' }] };
  assert.deepEqual(outputNote(ideas), { user: '[Ideas mode] bakery names', assistant: '[dealt 2 idea cards: Crumb & Co; Rise]' });
  const build = { id: 'b', kind: 'build', prompt: 'a timer', createdAt: 1, app: { html: '<!doctype html><title>Pomodoro</title>', title: 'Pomodoro' } };
  assert.deepEqual(outputNote(build), { user: '[Build mode] a timer', assistant: '[built a web app: “Pomodoro”]' });
  assert.match(outputNote({ ...build, refineOf: 'b0' }).assistant, /^\[updated the web app: “Pomodoro”\]$/);
  for (const x of [{ ...image, error: 'boom' }, { ...image, pending: true }, { ...image, media: [] }, { ...veo, media: [] }, { ...ideas, ideas: [] }, { ...build, app: null }, ask()]) assert.equal(outputNote(x), null);
  // Canva imports were brought in, not made: no model ('canva'), no made-up length
  const cv = { id: 'c', kind: 'image', prompt: 'Summer Sale Poster', createdAt: 1, params: { aspect: '4:5' }, meta: { model: 'canva', note: 'From Canva' }, canva: { design_id: 'D1' }, media: [{ type: 'image', src: IMG() }, { type: 'image', src: IMG('B') }] };
  assert.deepEqual(outputNote(cv, label), { user: '[Imported from Canva] Summer Sale Poster', assistant: '[imported 2 images from Canva]' });
  const cvv = { ...cv, kind: 'video', prompt: 'Promo Reel', params: { aspect: '9:16' }, media: [{ type: 'video', src: 'data:video/mp4;base64,AAAA' }] };
  assert.deepEqual(outputNote(cvv, label), { user: '[Imported from Canva] Promo Reel', assistant: '[imported a video from Canva]' });
  assert.ok(!/with canva|\d s video|\[made/.test(JSON.stringify(buildHistory([cv, cvv], { label }))));
  assert.equal(outputNote({ ...cv, media: [] }), null);
  // no binary data, prompts capped
  assert.ok(!JSON.stringify(outputNote(image, label)).includes('base64'));
  assert.ok(outputNote({ ...image, prompt: 'x'.repeat(5000) }, label).user.length < 450);
});

test('buildHistory keeps the existing chat replay and adds notes in the same 10-turn window', () => {
  const vid = ask({ prompt: 'what happens?', video: VIDEO() });
  const photo = ask({ prompt: 'whats this', images: [IMG()] });
  const img = { id: 'img', kind: 'image', prompt: 'a red car', createdAt: 5, meta: { model: 'flux' }, media: [{ type: 'image', src: IMG() }] };
  const failed = ask({ error: 'nope' }), empty = ask({ text: '' });
  const msgs = buildHistory([vid, photo, img, failed, empty]);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
  assert.equal(msgs[0].content, 'what happens?\n\n[attached video: “beach.mp4”, 0:42]');
  assert.equal(msgs[2].content, 'whats this\n\n[attached 1 image]');
  assert.equal(msgs[4].content, '[Image mode] a red car');
  assert.equal(msgs[5].content, '[made 1 image with flux]');
  assert.ok(!binary(msgs), 'notes never carry media data');
  // media(x) still replaces a turn's user content (a replayed video), and only that turn
  const parts = [{ type: 'text', text: 'video parts' }];
  const replay = buildHistory([vid, photo], { media: (x) => (x === vid ? parts : null) });
  assert.equal(replay[0].content, parts);
  assert.equal(replay[2].content, 'whats this\n\n[attached 1 image]');
  // window: at least the last HISTORY_TURNS turns, notes included; the oldest leave HISTORY_BLOCK at a time
  const many = [...Array.from({ length: HISTORY_TURNS + HISTORY_BLOCK }, () => ask()), img];
  const last = buildHistory(many);
  assert.equal(last.length, (HISTORY_TURNS + 1) * 2);
  assert.equal(last.at(-2).content, '[Image mode] a red car');
  assert.equal(last[0].content, many[HISTORY_BLOCK].prompt);
  assert.equal(buildHistory(many.slice(0, HISTORY_TURNS + HISTORY_BLOCK - 1)).length, (HISTORY_TURNS + HISTORY_BLOCK - 1) * 2, 'below a full block: every turn');
  // assistant text is stripped of <think> and capped; Kimi gets its reasoning back
  const kimi = ask({ text: '<think>x</think>' + 'y'.repeat(20000), think: 'z'.repeat(9000), meta: { model: 'moonshotai/kimi-k3' } });
  const [, a] = buildHistory([kimi]);
  assert.equal(a.content.length, 12000); assert.ok(!a.content.includes('<think>'));
  assert.equal(a.reasoning_content.length, 8000);
  assert.equal(buildHistory([ask({ think: 'r', meta: { model: 'gemini:gemini-3.8-flash' } })])[1].reasoning_content, undefined);
  assert.deepEqual(CHAT_KINDS, ['ask', 'code']);
});

test('videoSource chains a follow-up to the video it is about, within the window', () => {
  const v = ask({ video: VIDEO() });
  assert.equal(videoSource([v]), v);
  const f1 = ask({ videoOf: v.id });
  assert.equal(videoSource([v, f1]), v, 'a follow-up of a follow-up keeps the same video');
  assert.equal(videoSource([v, ask()]), null, 'an unrelated turn in between ends the chain');
  const chain = [v, ...Array.from({ length: VIDEO_CHAIN_TURNS - 1 }, () => ask({ videoOf: v.id }))];
  assert.equal(videoSource(chain), v);
  assert.equal(videoSource([...chain, ask({ videoOf: v.id })]), null, 'the video fell out of the last 10 chat turns');
  assert.equal(videoSource([]), null);
});

test('pickContext: the chained video first, else photos from the last 3 chat turns', () => {
  const v = ask({ video: VIDEO() }), p = ask({ images: [IMG()] });
  assert.deepEqual(pickContext([v], ask({ videoOf: v.id })), { kind: 'video', src: v });
  assert.equal(pickContext([], ask({ videoOf: 'gone' })), null);
  assert.deepEqual(pickContext([p], ask()), { kind: 'images', src: p });
  const img = { id: 'gen', kind: 'image', prompt: 'x', createdAt: 1, media: [{ type: 'image', src: IMG() }] };
  assert.deepEqual(pickContext([p, img, ask(), ask()], ask()), { kind: 'images', src: p }, 'other modes don’t count toward the 3 chat turns');
  assert.equal(pickContext([p, ...Array.from({ length: IMAGE_FOLLOW_TURNS }, () => ask())], ask()), null);
  const p2 = ask({ images: [IMG('B')] });
  assert.equal(pickContext([p, p2, ask()], ask()).src, p2, 'the most recent photos win');
  for (const e of [ask({ images: [IMG()] }), ask({ video: VIDEO() }), ask({ group: 'g', from: 'x' })]) assert.equal(pickContext([p], e), null);
  // a photo turn that failed or was stopped is never replayed (its photo may be what failed, or the wrong one)
  const failed = ask({ images: [IMG('F')], text: '', error: 'This image couldn’t be read (400)', errorKind: 'error' });
  const stopped = ask({ images: [IMG('S')], text: '', error: 'Stopped.', errorKind: 'stopped' });
  assert.equal(pickContext([failed], ask()), null);
  assert.equal(pickContext([stopped, ask()], ask()), null);
  assert.equal(pickContext([p, failed], ask()).src, p, 'an earlier good photo in the window still counts');
  assert.equal(pickContext([ask({ images: [IMG()], cut: 'stopped', text: 'partial' })], ask()).kind, 'images', 'stopped after an answer started: kept');
});

test('followUpRoute: agent wins; a video stays on watch unless the Web toggle is on for a question not about the clip', () => {
  assert.equal(followUpRoute({}), 'chat');
  assert.equal(followUpRoute({ web: true }), 'web');
  assert.equal(followUpRoute({ agent: true }), 'agent');
  assert.equal(followUpRoute({ hasImg: true, agent: true, web: true, webToggle: true }), 'vision', 'own photos: as before');
  assert.equal(followUpRoute({ ctx: 'video' }), 'watch');
  assert.equal(followUpRoute({ ctx: 'video', agent: true }), 'agent', 'bug 1: Accounts on');
  assert.equal(followUpRoute({ ctx: 'video', web: true, webToggle: true }), 'web', 'bug 1: Web on');
  assert.equal(followUpRoute({ ctx: 'video', web: true }), 'watch', 'a time-sensitive word alone keeps the full clip');
  assert.equal(followUpRoute({ ctx: 'video', web: true, webToggle: true, about: true }), 'watch');
  assert.equal(followUpRoute({ ctx: 'video', web: true, webToggle: true, about: true, asksWeb: true }), 'web', 'an explicit web request beats a media word');
  assert.equal(followUpRoute({ ctx: 'video', web: true, about: true, asksWeb: true }), 'watch', 'but only with the Web toggle on');
  assert.equal(followUpRoute({ ctx: 'images' }), 'photos');
  assert.equal(followUpRoute({ ctx: 'images', web: true, about: true }), 'web');
  assert.equal(followUpRoute({ ctx: 'images', agent: true }), 'agent');
  for (const q of ['what happens at 0:42?', 'describe the video', 'which scene has the dog', 'what is in this photo', 'who is in the clip']) assert.ok(ABOUT_MEDIA.test(q), q);
  for (const q of ['what is the latest news on this?', 'who won the game today', 'price of bitcoin']) assert.ok(!ABOUT_MEDIA.test(q), q);
  for (const q of ['search the web for the latest videos like this one', 'find similar videos online', 'find pictures of this breed online', 'can you look it up?', 'google that song']) assert.ok(ASKS_WEB.test(q), q);
  for (const q of ['what is the man searching through in the video?', 'what happens at 0:30 in the video?', 'describe the clip']) assert.ok(!ASKS_WEB.test(q), q);
});

test('a video follow-up with the Web toggle off stays on the clip even when it matches FRESH_HINT (app.js wiring)', async () => {
  const src = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const [, body, flags] = src.match(/const FRESH_HINT = \/(.+)\/(\w*);/);
  const FRESH_HINT = new RegExp(body, flags);
  const route = (prompt, toggle) => {
    const web = toggle || FRESH_HINT.test(prompt);
    return followUpRoute({ ctx: 'video', web, webToggle: web && toggle, about: ABOUT_MEDIA.test(prompt), asksWeb: ASKS_WEB.test(prompt) });
  };
  for (const q of ['what is the score at the end?', 'who won?', 'what’s the price on the sign?', 'what song is playing right now?', 'what did he say about the schedule?']) {
    assert.ok(FRESH_HINT.test(q), q);
    assert.equal(route(q, false), 'watch', q);
  }
  assert.equal(route('is this breed popular right now?', true), 'web');
  assert.equal(route('what happens at 0:30 in the video?', true), 'watch');
  assert.equal(route('search the web for the latest videos like this one', true), 'web');
  assert.match(src, /webToggle: wantWeb && Boolean\(e\.params\?\.web\)/);
});

test('photoFollowUp keeps the turn’s own role and model when it reads images, else the Vision model', () => {
  const sees = (id) => readsImages(id, ['deepseek-ai/deepseek-v4.1-flash']);
  const vis = 'gemini:gemini-3.8-flash';
  assert.deepEqual(photoFollowUp({ role: 'code', model: 'anthropic:claude-opus-5-5', visionModel: vis, sees }), { role: 'code', model: 'anthropic:claude-opus-5-5' }, 'Code keeps Opus');
  assert.deepEqual(photoFollowUp({ role: 'reason', model: 'anthropic:claude-opus-5-5', visionModel: vis, sees }), { role: 'reason', model: 'anthropic:claude-opus-5-5' }, 'Deep think kept');
  assert.deepEqual(photoFollowUp({ role: 'smart', model: 'anthropic:claude-sonnet-5-5', visionModel: vis, sees }), { role: 'smart', model: 'anthropic:claude-sonnet-5-5' }, 'escalation kept');
  assert.deepEqual(photoFollowUp({ role: 'write', model: 'openai:gpt-6.1-sol', visionModel: vis, sees }), { role: 'write', model: 'openai:gpt-6.1-sol' }, '"As me" kept');
  assert.deepEqual(photoFollowUp({ role: 'ask', model: 'deepseek:deepseek-v4-pro', visionModel: vis, sees }), { role: 'vision', model: vis }, 'a text-only model hands it to Vision');
  assert.deepEqual(photoFollowUp({ role: 'code', model: 'z-ai/glm-5.3', visionModel: vis, sees }), { role: 'vision', model: vis });
});

test('readsImages: Claude / GPT / Gemini, the listed ids (role lists and the user’s own Vision / Video picks), nothing else', () => {
  const custom = 'meta/llama-4-maverick-17b-128e-instruct';
  for (const id of ['anthropic:claude-opus-5-5', 'openai:gpt-6-astra', 'gemini:gemini-3.8-flash']) assert.ok(readsImages(id), id);
  assert.ok(!readsImages(custom));
  assert.ok(readsImages(custom, ['google/gemma-4-31b-it', custom]), 'a Vision model typed into Settings');
  for (const id of ['deepseek:deepseek-v4-pro', 'zai:glm-5.3', '', undefined]) assert.ok(!readsImages(id, ['google/gemma-4-31b-it']), String(id));
});

test('mediaTurn carries capped frames or photos to a model that reads images, else a text note', () => {
  const v = ask({ video: VIDEO() });
  const t = mediaTurn('what colour is the car?', { kind: 'video', src: v }, { cap: 6 });
  assert.equal(t.n, 6); assert.equal(t.note, '6 video frames');
  assert.equal(t.content.filter((p) => p.type === 'image_url').length, 6);
  assert.deepEqual(t.content.at(-1), { type: 'text', text: 'what colour is the car?' });
  assert.match(t.content[0].text, /attached earlier/);
  assert.match(t.content[1].text, /beach\.mp4/);
  const blind = mediaTurn('what colour?', { kind: 'video', src: v }, { cap: 6, sees: false });
  assert.equal(typeof blind.content, 'string'); assert.ok(!blind.content.includes('base64'));
  assert.match(blind.content, /^\[Earlier in this conversation the user attached a video \(“beach\.mp4”, 0:42\)\. This model can’t see its frames/);
  assert.ok(blind.content.endsWith('\n\nwhat colour?')); assert.equal(blind.note, 'video as a text note');
  const noFrames = mediaTurn('q', { kind: 'video', src: ask({ video: VIDEO({ frames: [] }) }) }, { cap: 6 });
  assert.match(noFrames.content, /Its frames aren’t available/);
  // testers: never more than MAX_IMAGES
  const tester = mediaTurn('q', { kind: 'video', src: v }, { cap: Math.min(MAX_IMAGES, CTX_IMAGES) });
  assert.ok(tester.content.filter((p) => p.type === 'image_url').length <= MAX_IMAGES);
  const p = ask({ images: [IMG(), IMG('B'), IMG('C')] });
  const ti = mediaTurn('and the car?', { kind: 'images', src: p }, { cap: 2 });
  assert.deepEqual(ti.content.filter((x) => x.type === 'image_url').map((x) => x.image_url.url), [IMG(), IMG('B')]);
  assert.equal(ti.note, '2 earlier images');
  const tb = mediaTurn('and the car?', { kind: 'images', src: p }, { sees: false });
  assert.match(tb.content, /attached 3 images\. This model can’t see them/); assert.equal(tb.note, 'earlier images as a text note');
  assert.deepEqual(mediaTurn('plain', null), { content: 'plain', note: '', n: 0 });
});

test('app.js routes every chat path through the shared history and follow-up rules', async () => {
  const src = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  // the old gate that dropped the video whenever Accounts or Web was on is gone
  assert.ok(!/wantsAgent\(e\)[^\n]*e\.videoOf =/.test(src), 'no Accounts / Web gate on the video chain');
  assert.match(src, /if \(src\) e\.videoOf = src\.id;/);
  // every historyFor caller passes the turn's thread
  const calls = [...src.matchAll(/historyFor\(e, \['ask', 'code'\][^\n]*/g)].map((m) => m[0]);
  assert.equal(calls.length, 3, calls.join('\n'));
  for (const c of calls) assert.match(c, /thread\)/, c);
  assert.match(src, /return buildHistory\(/);
  // earlier photos keep the turn's own model (photoFollowUp); the user's Vision / Video picks count as image readers
  assert.match(src, /if \(route === 'photos'\) \(\{ role, model \} = photoFollowUp\(/);
  assert.match(src, /const seesImages = [^\n]*S\.settings\.models\.vision[^\n]*S\.settings\.models\.watch/);
});
