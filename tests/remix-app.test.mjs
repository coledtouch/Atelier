import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// public/remix-app.js — the Video Remix controller as a state machine, with every app.js dependency faked: composer
// gate and choices, planning through a scripted stream, approval, filming through remix-shots advanceShot over a mocked
// fetch, recovery at boot, the cut through a fake render module, and the paint key. No DOM (document: null).
const A = await import('../public/remix-app.js');
const R = await import('../public/remix.js');
const { createRemixStore, memoryKv } = await import('../public/remix-store.js');
const FX = JSON.parse(readFileSync(new URL('./fixtures/remix/remix-plan-promo.json', import.meta.url), 'utf8'));
const LUMA = JSON.parse(readFileSync(new URL('./fixtures/remix/promo-luma.json', import.meta.url), 'utf8'));
// Gemini Omni: POST /api/omni/start → {id}; the shot's op is 'omni:<id>'; GET status → {done, video}; GET video → MP4.
const OMNI = 'int_abc123', OP = `omni:${OMNI}`;
const VEO_OP = 'models/veo-3.1-lite-generate-preview/operations/op123'; // a pre-Omni saved shot
const CLIP = { name: 'files/abc', uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc', mime: 'video/mp4', expiresAt: Date.now() + 864e5 };
const INFO = { name: 'Atelier-promo-4x5.mp4', size: 8290821, duration: 48, width: 1080, height: 1350, rotation: 0, fps: 30, vcodec: 'avc1', vkbps: 1173, audio: 'aac', hasAudio: true, hdr: false, canDecode: true };

// The fixture plan plus one new shot (a b-roll beat) so there is something to approve and film.
const SHOT_PLAN = (() => {
  const p = structuredClone(FX.plan);
  p.shots = [{ id: 's1', prompt: 'A walnut desk at dawn, steam rising from a cup', seconds: 4, camera: 'static' }];
  p.timeline.splice(2, 0, { id: 'v1', type: 'shot', shot: 's1', use_in: 0.5, use_out: 2.5, enter: 'cut' });
  return p;
})();

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// over: deps a test replaces (a counting URL, a small fake document for the Fine-tune sheet, draw functions).
function harness({ answers = [], fetchAnswers = [], tester = null, store: seeded = null, threads = null, over = {} } = {}) {
  let t = 1_700_000_000_000;
  const timers = [];
  const kv = seeded?.kv || memoryKv();
  const store = createRemixStore(kv, { now: () => t });
  const thread = threads?.[0] || { id: 't1', entries: [], updatedAt: t };
  const S = { thread, tester, opts: {} };
  const dbThreads = new Map((threads || [thread]).map((x) => [x.id, x]));
  const log = { toasts: [], repaints: [], persists: 0, streams: [], completes: [], fetches: [], renders: [], added: [], viewer: [], options: 0 };
  const fetchQueue = [...fetchAnswers];
  const fakeRender = {
    platformOf: () => 'desktop',
    probeSource: async () => ({ ...INFO }),
    capabilities: async () => ({ path: 'webcodecs', h264: 'avc1.640028', aacEncode: true, webkit: false, platform: 'desktop', reason: null }),
    analyseSource: async () => ({ luma: LUMA.polished.luma, hist: LUMA.polished.hist, fps: 30, keyframes: LUMA.polished.keyframes }),
    renderCut: async (args) => { log.renders.push(args); return { blob: new Blob([new Uint8Array(2048)], { type: 'video/mp4' }), mime: 'video/mp4', bytes: 2048, w: args.graph.w, h: args.graph.h, fps: args.graph.fps, seconds: args.graph.duration, kbps: args.kbps, path: 'webcodecs', poster: 'data:image/jpeg;base64,QUJD', audio: 'copy' }; },
  };
  const deps = {
    S, store, now: () => t, document: null, navigator: { userAgent: 'node' },
    setTimeout: (fn, ms) => { const x = { fn, ms }; timers.push(x); return x; },
    clearTimeout: (x) => { const i = timers.indexOf(x); if (i >= 0) timers.splice(i, 1); },
    URL: { createObjectURL: () => 'blob:cut', revokeObjectURL() {} },
    DB: { get: async (id) => dbThreads.get(id) || null, put: async (th) => { dbThreads.set(th.id, th); }, keys: async () => [...dbThreads.keys()] },
    persist: () => { log.persists++; }, repaint: (e) => log.repaints.push(e.id), toast: (m) => log.toasts.push(m), renderOptions: () => { log.options++; },
    modelFor: () => 'gemini:gemini-3.8-flash', providerOf: (m) => String(m).split(':')[0],
    ensureClip: async () => ({ file: CLIP, why: null }),
    streamChat: async (o) => {
      const a = answers.shift();
      if (!a) throw new Error('unexpected streamChat');
      const model = o.model;
      const messages = typeof o.messages === 'function' ? o.messages(model) : o.messages;
      log.streams.push({ role: o.role, messages, extra: o.extra });
      o.onModel?.(model);
      const raw = typeof a.raw === 'string' ? a.raw : JSON.stringify(a.raw);
      for (let i = 0; i < raw.length; i += 400) o.onDelta({ content: raw.slice(i, i + 400) });
      o.onDelta({ content: '', finish: a.finish || 'stop' });
      return model;
    },
    completeChat: async (o) => { log.completes.push(o); const a = answers.shift(); return typeof a.raw === 'string' ? a.raw : JSON.stringify(a.raw); },
    fetch: async (url, init = {}) => {
      log.fetches.push({ url: String(url), method: init.method || 'GET', body: typeof init.body === 'string' ? JSON.parse(init.body) : null });
      const a = fetchQueue.shift();
      if (!a) throw new Error(`unexpected fetch ${url}`);
      if (a instanceof Error) throw a;
      return typeof a === 'function' ? a(url, init) : a;
    },
    apiHeaders: () => ({ 'x-app-pass': 'p' }), noteAllowance() {},
    entryById: (id) => S.thread?.entries.find((x) => x.id === id) || null,
    threadIsOpen: (id) => S.thread?.id === id,
    loadRender: () => fakeRender,
    draw: { ensureFonts: async () => 'studio' },
    uid: () => 'e2', addEntry: (e) => { S.thread.entries.push(e); log.added.push(e); },
    openViewer: (o) => log.viewer.push(o), shake() { log.shaken = true; },
    ...over,
  };
  const remix = A.createRemix(deps);
  return { remix, deps, log, kv, store, S, thread, timers, fakeRender, tick: (ms) => { t += ms; }, now: () => t, dbThreads };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const video = () => ({ file: new Blob([new Uint8Array(64)], { type: 'video/mp4' }), name: 'Atelier-promo-4x5.mp4', size: 8290821, duration: 48, width: 1080, height: 1350, frames: [], status: 'done' });
async function planned(h, text = 'Add a b-roll beat of a desk after the opening') {
  const v = video();
  h.remix.composer.attached(v);
  await flush(); await flush();
  const e = { id: 'e1', kind: 'video', prompt: text, images: [], createdAt: h.now(), pending: true, video: { name: v.name, mime: 'video/mp4', size: v.size, duration: 48, width: 1080, height: 1350, frames: [] } };
  e.remix = h.remix.newRemix(v, text);
  h.thread.entries.push(e);
  h.remix.keepSource(e, v.file);
  await h.remix.plan(e, new AbortController().signal, h.thread);
  e.pending = false;
  return e;
}

// ── pure helpers ──
test('helpers: timecodes, footage cycle, fps, shot model choices', () => {
  assert.equal(A.fmtT(24), '0:24.0');
  assert.equal(A.fmtT(65.25), '1:05.3');
  assert.equal(A.nextFootage('ask'), 'off');
  assert.equal(A.nextFootage(24), 'ask');
  assert.equal(A.footageLabel(8), 'up to 8 s');
  assert.deepEqual([24, 25, 30, 50, 60, 29.97, 12].map(A.fpsFor), [24, 25, 30, 25, 30, 30, 30]);
  assert.deepEqual(A.shotChoices({ tester: true }).map((m) => m.id), R.SHOT_MODELS.filter((m) => m.tester).map((m) => m.id));
  assert.ok(!A.shotChoices({}).some((m) => m.provider === 'runway'), 'Runway only when it is set up');
  assert.ok(A.shotChoices({ runway: true }).some((m) => m.id === 'runway:gen4.5'));
});

test('composerNote: reading → checking → ready; can’t-decode and clip-only hold; HDR warns', () => {
  const v = { status: 'reading', done: 6, total: 16 };
  assert.equal(A.composerNote(v, null), 'Reading video · 6 of 16 frames');
  assert.equal(A.composerNote({ status: 'done' }, { status: 'reading' }), A.COPY.checking);
  assert.equal(A.composerNote({ status: 'done' }, { status: 'ready', info: { canDecode: true }, caps: { path: 'webcodecs' } }), 'Remix · Gemini watches & hears it · fast cut');
  assert.equal(A.composerNote({ status: 'done', clip: { state: 'uploading', progress: 0.42 } }, { status: 'ready', info: {}, caps: {} }), 'Remix · uploading for Gemini · 42%');
  assert.equal(A.composerNote({ status: 'done' }, { status: 'ready', info: { canDecode: false } }), A.COPY.cantCut);
  assert.equal(A.composerNote({ clipOnly: true }, null), A.COPY.cantCut);
  assert.match(A.composerNote({ status: 'done' }, { status: 'ready', info: { hdr: true }, caps: {} }), /HDR video will look flat/);
});

test('shotChip: plain words and the right offers per state (unknown never retries silently)', () => {
  assert.deepEqual(A.shotChip({ state: 'unknown' }).acts, ['retry-anyway', 'card']);
  assert.deepEqual(A.shotChip({ state: 'filtered' }).acts, ['edit', 'retry', 'card']);
  assert.equal(A.shotChip({ state: 'filming', startedAt: 1000 }, 73_000).text, 'Filming · 1:12');
  assert.equal(A.shotChip({ state: 'ready' }).text, 'Ready');
  assert.equal(A.shotChip({ state: 'failed', error: 'Nope' }).text, 'Nope');
});

// ── composer ──
test('composer: empty send shakes and holds; an undecodable clip is held before any spend', async () => {
  const h = harness();
  assert.equal(await h.remix.composer.gate('  ', video(), h.thread), 'empty');
  assert.equal(h.log.shaken, true);
  assert.equal(h.log.toasts.at(-1), A.COPY.empty);
  const v = video();
  h.fakeRender.probeSource = async () => ({ ...INFO, canDecode: false });
  h.remix.composer.attached(v);
  await flush(); await flush();
  assert.equal(h.remix.composer.note(v), A.COPY.cantCut);
  assert.equal(await h.remix.composer.gate('make it punchier', v, h.thread), 'held');
  assert.equal(await h.remix.composer.gate('make it punchier', video(), h.thread), 'ok', 'a clip that was never probed is not held (v114: one still being checked is, see below)');
  assert.equal(h.log.fetches.length, 0);
});

test('composer: options cycle footage/model/soundtrack; newRemix carries them', async () => {
  const h = harness();
  const tap = (attr, val) => ({ closest: (sel) => (sel === `[${attr}]` ? { dataset: { [attr === 'data-rx-opt' ? 'rxOpt' : 'rxChoice']: val, entry: 'e1' } } : null) });
  assert.equal(h.remix.composer.onOption(tap('data-rx-opt', 'footage')), true);
  assert.equal(h.remix.composer.opts.footage, 'off');
  h.remix.composer.onOption(tap('data-rx-opt', 'footage'));
  assert.equal(h.remix.composer.opts.footage, 8);
  h.remix.composer.onOption(tap('data-rx-opt', 'keep'));
  assert.equal(h.remix.composer.opts.keep, false);
  assert.equal(h.remix.composer.onOption({ closest: () => null }), false);
  assert.match(h.remix.composer.options(), /New footage: up to 8 s/);
  const r = h.remix.newRemix(video(), 'tighten it');
  assert.equal(r.opts.maxNew, 8);
  assert.equal(r.opts.audioMode, 'follow_cuts');
  assert.equal(r.phase, 'plan');
  assert.equal(R.validRemix(r), true);
});

test('composer: Video mode without a clip in a remix thread must choose Revise or New clip', () => {
  const h = harness();
  assert.equal(h.remix.composer.textChoice('bigger title', h.thread), null, 'no remix in the thread: a normal Video send');
  const e = { id: 'e1', kind: 'video', remix: { ...h.remix.newRemix(video(), 'x'), plan: { title: 'Promo remix' } } };
  h.thread.entries.push(e);
  assert.equal(h.remix.composer.textChoice('bigger title', h.thread), 'hold');
  assert.equal(h.log.toasts.at(-1), A.COPY.choose);
  assert.match(h.remix.composer.choiceChips(h.thread), /Revise ‘Promo remix’/);
  const tap = (c) => ({ closest: (sel) => (sel === '[data-rx-choice]' ? { dataset: { rxChoice: c, entry: 'e1' } } : null) });
  h.remix.composer.onOption(tap('revise'));
  assert.deepEqual(h.remix.composer.textChoice('bigger title', h.thread), { revise: true, entry: e });
  h.remix.composer.onOption(tap('new'));
  assert.equal(h.remix.composer.textChoice('a new clip', h.thread), null);
});

// ── planning ──
test('plan: Gemini watches the clip; the plan is settled, snapped and priced; nothing is billed', async () => {
  const h = harness({ answers: [{ raw: SHOT_PLAN }] });
  const e = await planned(h);
  const msgs = h.log.streams[0].messages;
  assert.equal(h.log.streams[0].role, 'watch');
  assert.match(msgs[0].content, /SOURCE: duration 48 s, 1080×1350 px, 30 fps/);
  assert.match(msgs[0].content, /at most 8 s in total/);
  assert.ok(msgs[1].content.some((p) => p.type === 'video_file' && p.video_file.file_uri === CLIP.uri));
  assert.equal(msgs[1].content.at(-1).text, 'Instructions: Add a b-roll beat of a desk after the opening');
  const r = e.remix;
  assert.equal(r.phase, 'review');
  assert.equal(r.plan.title, SHOT_PLAN.title);
  assert.ok(r.cuts?.hard, 'scene analysis ran locally');
  assert.deepEqual(Object.keys(r.shots), ['s1']);
  assert.equal(r.shots.s1.state, 'idle');
  assert.equal(r.spent.planUsd, A.PLAN_EST_USD);
  assert.equal(e.meta.note, 'remix · full clip with audio');
  assert.equal(R.validRemix(r), true);
  assert.equal(h.log.fetches.length, 0, 'planning never films');
  assert.equal((await h.store.draftLoad('e1')).plan.title, SHOT_PLAN.title, 'the review draft is saved');
  assert.ok(h.kv.map.has('rx:src:e1'), 'the source is kept for the cut');
  const rows = A.storyRows(r);
  assert.deepEqual(rows.map((x) => x.type), ['source', 'card', 'shot', 'source', 'source']);
  assert.match(rows[2].title, /^New shot · A walnut desk/);
});

test('plan: a reply with a syntax slip gets one fast repair; one that adds beats is refused', async () => {
  const raw = JSON.stringify(SHOT_PLAN).slice(0, -1); // the closing brace is missing
  const h = harness({ answers: [{ raw }, { raw: SHOT_PLAN }] });
  const e = await planned(h);
  assert.equal(h.log.completes.length, 1);
  assert.equal(h.log.completes[0].role, 'fast');
  assert.equal(e.remix.plan.timeline.length, 5);
  const bigger = structuredClone(SHOT_PLAN);
  bigger.timeline.push({ id: 'x9', type: 'source', src_in: 1, src_out: 2 });
  const h2 = harness({ answers: [{ raw }, { raw: bigger }] });
  const e2 = await planned(h2);
  assert.ok(e2.remix.issues.some((i) => /formatting slip/.test(i.msg)), 'the salvage stands instead');
});

test('plan: cut short with nothing usable → one compact re-ask at low effort', async () => {
  const h = harness({ answers: [{ raw: '{"v":1,"title":"x","timeline":[{"id":"a","type":"card"', finish: 'length' }, { raw: SHOT_PLAN }] });
  const e = await planned(h);
  assert.equal(h.log.streams.length, 2);
  assert.match(h.log.streams[1].messages[0].content, /COMPACT MODE/);
  assert.deepEqual(h.log.streams[1].extra, { reasoning_effort: 'low' });
  assert.equal(e.remix.phase, 'review');
});

test('plan: nothing usable → the plan error (app.js run shows errorBox + Try again)', async () => {
  const h = harness({ answers: [{ raw: 'Sorry, I can’t.' }] });
  await assert.rejects(planned(h), (err) => err.message === R.PLAN_ERROR && err.status === 502);
});

// ── approval and filming ──
test('approve → film: one POST per shot only after Approve; poll; download; ready → check; ops cleaned up', async () => {
  const h = harness({
    answers: [{ raw: SHOT_PLAN }],
    fetchAnswers: [
      json(200, { id: OMNI, seconds: 4, pollAfterMs: 10_000 }),
      json(200, { id: OMNI, status: 'completed', done: true, video: true }),
      new Response(new Blob([new Uint8Array(4096)], { type: 'video/mp4' }), { status: 200 }),
    ],
  });
  const e = await planned(h);
  assert.equal(h.log.fetches.length, 0);
  assert.equal(R.needsApproval(e.remix).needed, true);
  assert.equal(h.remix.approve(e), true);
  assert.equal(e.remix.phase, 'film');
  assert.deepEqual(h.remix.activeThreads(), new Set(['t1']));
  assert.match(h.remix.deleteWarning('t1'), /still filming/);
  await h.remix.tick('e1');
  assert.deepEqual(h.log.fetches.map((f) => [f.method, f.url]), [['POST', '/api/omni/start']]);
  const body = h.log.fetches[0].body;
  assert.deepEqual(Object.keys(body), ['prompt', 'aspect', 'resolution', 'seconds'], 'no first frame in this plan');
  assert.deepEqual([body.aspect, body.resolution, body.seconds], ['9:16', '720p', 4], 'a 4:5 cut films vertical');
  assert.match(body.prompt, /walnut desk at dawn.*Avoid: text, letters/);
  assert.equal(e.remix.shots.s1.model, 'gemini:gemini-omni-1.1-flash');
  assert.equal(e.remix.shots.s1.state, 'filming');
  assert.equal(e.remix.shots.s1.op, OP);
  assert.deepEqual((await h.store.opsAll()).map((o) => [o.entryId, o.shotId, o.op]), [['e1', 's1', OP]]);
  h.tick(5000);
  await h.remix.tick('e1');
  assert.equal(h.log.fetches.length, 3, 'poll + download, no second POST');
  assert.deepEqual(h.log.fetches.slice(1).map((f) => f.url), [`/api/omni/status/${OMNI}`, `/api/omni/video/${OMNI}`]);
  assert.equal(e.remix.shots.s1.state, 'ready');
  assert.equal(e.remix.shots.s1.blobKey, 'rx:shot:e1:s1');
  assert.ok(h.kv.map.has('rx:shot:e1:s1'));
  assert.equal(e.remix.phase, 'check');
  assert.deepEqual(await h.store.opsAll(), []);
  assert.equal(R.validRemix(e.remix), true);
});

test('a dropped start → unknown, never re-sent; Retry anyway needs a fresh Approve', async () => {
  const h = harness({ answers: [{ raw: SHOT_PLAN }], fetchAnswers: [new TypeError('Failed to fetch')] });
  const e = await planned(h);
  h.remix.approve(e);
  await h.remix.tick('e1');
  assert.equal(e.remix.shots.s1.state, 'unknown');
  await h.remix.tick('e1');
  assert.equal(h.log.fetches.length, 1, 'no second POST');
  h.remix.retryShot(e, 's1', { anyway: true });
  assert.equal(e.remix.phase, 'review');
  assert.equal(e.remix.shots.s1.state, 'idle');
  assert.equal(R.filmQueue(e.remix).length, 0, 'not startable until approved again');
  assert.equal(R.needsApproval(e.remix).needed, true);
});

test('tester: a 429 queues (not billed) and the shot is retried only after its retryAt', async () => {
  const h = harness({ answers: [{ raw: SHOT_PLAN }], tester: { features: { remix: true }, models: {} }, fetchAnswers: [json(429, { error: 'busy' }), json(200, { id: OMNI, seconds: 4, pollAfterMs: 10_000 })] });
  const e = await planned(h);
  e.remix.approval = R.approvalFor(e.remix, null, h.now()); e.remix.phase = 'film';
  h.remix.startJob('e1', 't1');
  await h.remix.tick('e1');
  assert.equal(e.remix.shots.s1.state, 'queued');
  await h.remix.tick('e1');
  assert.equal(h.log.fetches.length, 1, 'not before retryAt');
  h.tick(31_000);
  await h.remix.tick('e1');
  assert.equal(h.log.fetches.length, 2);
  assert.equal(e.remix.shots.s1.state, 'filming');
});

test('Use a card instead replaces the shot with a card of the same length; the plan stays in sync', async () => {
  const h = harness({ answers: [{ raw: SHOT_PLAN }] });
  const e = await planned(h);
  const before = R.outputDuration(e.remix.plan);
  await h.remix.cardInstead(e, 's1');
  assert.equal(e.remix.plan.shots.length, 0);
  assert.deepEqual(Object.keys(e.remix.shots), []);
  assert.equal(e.remix.plan.timeline.find((c) => c.id === 'v1').type, 'card');
  assert.ok(Math.abs(R.outputDuration(e.remix.plan) - before) < 0.05);
  assert.equal(R.planCost(e.remix).usd, 0);
});

// ── boot ──
test('boot: a shot left "starting" becomes unknown (no re-send); a filming one resumes polling only', async () => {
  const kv = memoryKv();
  const st = createRemixStore(kv);
  await st.opsAdd({ entryId: 'e1', threadId: 't1', shotId: 's1', op: null, startedAt: 1 });
  await st.jobPatch('e1', 's1', { state: 'starting', startedAt: 1 }, 't1');
  const T0 = 1_700_000_000_000 - 60_000; // a minute before the harness clock
  await st.opsAdd({ entryId: 'e2', threadId: 't1', shotId: 's1', op: OP, startedAt: T0 });
  await st.jobPatch('e2', 's1', { state: 'filming', op: OP, startedAt: T0 }, 't1');
  const shot = { model: 'gemini:veo-3.1-lite-generate-preview', res: '720p', seconds: 4, enabled: true, contentKey: 'deadbeef' };
  const thread = { id: 't1', entries: [
    { id: 'e1', kind: 'video', remix: { v: 1, phase: 'film', plan: SHOT_PLAN, shots: { s1: { ...shot, state: 'unknown' } }, approval: { at: 1, keys: { s1: 'x' } } } },
    { id: 'e2', kind: 'video', remix: { v: 1, phase: 'film', plan: SHOT_PLAN, shots: { s1: { ...shot, state: 'failed' } }, approval: { at: 1, keys: {} } } },
  ] };
  const h = harness({ store: { kv }, threads: [thread], fetchAnswers: [json(200, { done: false })] });
  await h.remix.boot();
  assert.equal((await h.store.jobGet('e1')).shots.s1.state, 'unknown');
  assert.equal(thread.entries[0].remix.shots.s1.state, 'unknown');
  assert.deepEqual((await h.store.opsAll()).map((o) => o.entryId), ['e2']);
  assert.equal(thread.entries[1].remix.shots.s1.state, 'filming', 'the job store wins over the recovered thread');
  assert.deepEqual(h.remix.activeThreads(), new Set(['t1']));
  await h.remix.tick('e2');
  assert.deepEqual(h.log.fetches.map((f) => f.method), ['GET'], 'polls, never starts');
  assert.equal(h.log.fetches[0].url, `/api/omni/status/${OMNI}`);
  assert.equal(thread.entries[1].remix.shots.s1.model, 'gemini:gemini-omni-1.1-flash', 'the saved Veo Lite id now reads as Omni');
});

test('boot: a pre-Omni shot still filming on a Veo operation ends expired — nothing is polled or started; Approve films it with Omni', async () => {
  const kv = memoryKv();
  const st = createRemixStore(kv);
  const T0 = 1_700_000_000_000 - 60_000;
  await st.opsAdd({ entryId: 'e1', threadId: 't1', shotId: 's1', op: VEO_OP, startedAt: T0 });
  await st.jobPatch('e1', 's1', { state: 'filming', op: VEO_OP, startedAt: T0 }, 't1');
  const LITE = 'gemini:veo-3.1-lite-generate-preview';
  const thread = { id: 't1', entries: [{ id: 'e1', kind: 'video', remix: { v: 1, phase: 'film', plan: SHOT_PLAN, opts: { model: LITE, res: '720p', shotModels: { s1: { model: LITE, res: '720p' } } },
    shots: { s1: { model: LITE, res: '720p', seconds: 4, enabled: true, contentKey: 'deadbeef', state: 'filming', op: VEO_OP, startedAt: T0 } }, approval: { at: 1, keys: { s1: `${LITE}|4|720p` } } } }] };
  assert.equal(R.validRemix(thread.entries[0].remix), true, 'a saved pre-Omni remix still validates');
  const h = harness({ store: { kv }, threads: [thread], fetchAnswers: [json(200, { id: OMNI, seconds: 4, pollAfterMs: 10_000 })] });
  h.S.thread = thread;
  await h.remix.boot();
  await h.remix.tick('e1');
  const r = thread.entries[0].remix;
  assert.equal(h.log.fetches.length, 0, 'a Veo operation is never polled');
  assert.deepEqual([r.shots.s1.state, r.shots.s1.op, r.shots.s1.model], ['expired', undefined, 'gemini:gemini-omni-1.1-flash']);
  assert.match(r.shots.s1.error, /retired Veo 3\.1/);
  assert.equal((await h.store.jobGet('e1')).shots.s1.state, 'expired', 'the job store agrees');
  assert.deepEqual(await h.store.opsAll(), []);
  assert.deepEqual([r.opts.model, r.opts.shotModels.s1.model], ['gemini:gemini-omni-1.1-flash', 'gemini:gemini-omni-1.1-flash']);
  const need = R.needsApproval(r);
  assert.equal(need.needed, true, 'the old Veo approval does not cover an Omni shot');
  assert.equal(need.reasons[0].cause, 'changed');
  assert.equal(h.remix.approve(thread.entries[0]), true);
  await h.remix.tick('e1');
  assert.deepEqual(h.log.fetches.map((f) => [f.method, f.url]), [['POST', '/api/omni/start']]);
  assert.equal(r.shots.s1.op, OP);
});

test('paint: an owner shot Google may have started (unknown) links to AI Studio usage; the shot picker label names Omni', async () => {
  const h = harness({ answers: [{ raw: SHOT_PLAN }], fetchAnswers: [new TypeError('Failed to fetch')] });
  const e = await planned(h);
  h.remix.approve(e);
  await h.remix.tick('e1');
  assert.equal(e.remix.shots.s1.state, 'unknown');
  assert.match(paintHtml(h, e), /aistudio\.google\.com\/usage/);
  h.remix.composer.attached(video());
  assert.match(h.remix.composer.options(), /New shots: Gemini Omni Flash ▾/);
});

// Here the entry can still be loaded (this harness keeps the thread open and in its database). app.js deletes the
// thread first, so the tick can't load it: that path is "v114 #2" below.
test('forgetThread: the thread’s job keeps polling, then its bytes are dropped', async () => {
  const h = harness({
    answers: [{ raw: SHOT_PLAN }],
    fetchAnswers: [json(200, { id: OMNI, seconds: 4, pollAfterMs: 10_000 }), json(200, { id: OMNI, status: 'completed', done: true, video: false, filtered: true, error: 'filtered' })],
  });
  const e = await planned(h);
  h.remix.approve(e);
  await h.remix.tick('e1');
  h.remix.forgetThread('t1');
  h.tick(5000);
  await h.remix.tick('e1');
  assert.equal(e.remix.shots.s1.state, 'filtered');
  assert.equal(h.kv.map.has('rx:src:e1'), false, 'dropped once nothing is live');
  assert.deepEqual(h.remix.activeThreads(), new Set());
});

// ── the cut ──
test('cut: renders with the graph, the filmed shot and the source codec; stores the MP4; done', async () => {
  const h = harness({
    answers: [{ raw: SHOT_PLAN }],
    fetchAnswers: [json(200, { id: OMNI, seconds: 4, pollAfterMs: 10_000 }), json(200, { id: OMNI, status: 'completed', done: true, video: true }), new Response(new Blob([new Uint8Array(10)], { type: 'video/mp4' }))],
  });
  const e = await planned(h);
  h.remix.approve(e);
  await h.remix.tick('e1'); h.tick(5000); await h.remix.tick('e1');
  assert.equal(e.remix.phase, 'check');
  const res = await h.remix.cut(e);
  assert.ok(res);
  const args = h.log.renders[0];
  assert.equal(args.codec, 'avc1.640028');
  assert.equal(args.graph.w, 1080);
  assert.equal(args.graph.fps, 30);
  assert.equal(args.graph.frames, 1440);
  assert.ok(args.shots.s1 instanceof Blob);
  assert.equal(e.remix.phase, 'done');
  assert.equal(e.remix.export.bytes, 2048);
  assert.equal(e.remix.export.fonts, 'studio');
  assert.ok(h.kv.map.has('rx:cut:e1'));
  assert.match(e.meta.note, /48 s · 1080×1350 · H\.264 \+ original audio/);
  assert.equal(R.validRemix(e.remix), true);
  assert.equal(h.remix.cutting(), false);
});

test('cut: a browser that can’t encode keeps the plan and says why; a missing source asks for it', async () => {
  const h = harness({ answers: [{ raw: FX.plan }] });
  const e = await planned(h, 'tighten the close');
  h.fakeRender.capabilities = async () => ({ path: 'none', reason: 'This browser can’t assemble video — your plan and shots are saved; finish on desktop Chrome or Edge.' });
  await h.remix.cut(e);
  assert.equal(e.remix.phase, 'review');
  assert.match(e.remix.renderError, /can’t assemble video/);
  const h2 = harness({ answers: [{ raw: FX.plan }] });
  const e2 = await planned(h2, 'tighten the close');
  h2.kv.map.delete('rx:src:e1');
  const fresh = A.createRemix({ ...h2.deps }); // a reload: no File in memory
  await fresh.cut(e2);
  assert.equal(e2.remix.needSource, true);
  assert.equal(h2.log.renders.length, 0);
});

// ── revise and paint ──
test('revise: a new entry, text-only, reusing the source and unchanged shots', async () => {
  const h = harness({ answers: [{ raw: SHOT_PLAN }, { raw: { ...SHOT_PLAN, title: 'Promo remix · bigger title' } }] });
  const e = await planned(h);
  const ne = h.remix.revise(e, 'make the title bigger');
  assert.equal(h.log.added[0], ne);
  assert.equal(ne.remixOf, 'e1');
  assert.equal(ne.remix.srcEntry, 'e1');
  await h.remix.plan(ne, new AbortController().signal, h.thread);
  assert.equal(h.log.streams[1].role, 'ask');
  assert.match(h.log.streams[1].messages[0].content, /REVISE: you no longer see the video/);
  assert.match(h.log.streams[1].messages[1].content[0].text, /^Previous plan:/);
  assert.equal(ne.remix.plan.title, 'Promo remix · bigger title');
  assert.equal(ne.remix.basePlan, undefined);
  assert.equal(ne.remix.spent.reviseUsd, A.REVISE_EST_USD);
  assert.equal(R.validRemix(ne.remix), true);
});

test('paint: renders the story and cost card once; an unchanged key only patches the status text', async () => {
  const h = harness({ answers: [{ raw: SHOT_PLAN }] });
  const e = await planned(h);
  let writes = 0, html = '';
  const status = { textContent: '' };
  const out = { dataset: {}, get innerHTML() { return html; }, set innerHTML(v) { writes++; html = v; }, querySelector: (s) => (s === '[data-rx-status]' ? status : null) };
  const acts = { innerHTML: '' };
  const li = { classList: { add() {} }, querySelector: (s) => (s === '.out' ? out : s === '.actions' ? acts : null) };
  h.remix.paint(li, e, '<div class="meta-line"></div>');
  assert.equal(writes, 1);
  assert.match(html, /Approve &amp; film · \$0\.41/, 'Omni 4 s at 720p: 4 × $0.10136');
  assert.match(html, /Gemini Omni Flash · 720p/);
  assert.match(html, /rx-beat rx-shot/);
  assert.ok(html.includes(A.COPY.free));
  h.remix.paint(li, e, '<div class="meta-line"></div>');
  assert.equal(writes, 1, 'same key: no rebuild');
  e.remix.shots.s1.state = 'filming';
  h.remix.paint(li, e, '<div class="meta-line"></div>');
  assert.equal(writes, 2);
  // plan strings are escaped
  e.remix.plan.title = '<img src=x onerror=alert(1)>';
  e.remix.rev++;
  h.remix.paint(li, e, '');
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;img src=x'));
});

// ── wiring additions (v61): sync hold, the Library copy, a cut that finishes in another thread ──
const veoDone = () => [json(200, { id: OMNI, seconds: 4, pollAfterMs: 10_000 }), json(200, { id: OMNI, status: 'completed', done: true, video: true }), new Response(new Blob([new Uint8Array(10)], { type: 'video/mp4' }))];
test('holdSync: owner sync never pushes an entry while it films or cuts; the hold is released after', async () => {
  const h = harness({ answers: [{ raw: SHOT_PLAN }], fetchAnswers: veoDone() });
  const holds = [];
  h.deps.holdSync = (id) => { const rec = { id, released: false }; holds.push(rec); return () => { rec.released = true; }; };
  const e = await planned(h);
  assert.equal(holds.length, 0, 'planning is a run(): app.js holds it already');
  h.remix.approve(e);
  assert.deepEqual(holds.map((x) => [x.id, x.released]), [['e1', false]], 'held from Approve');
  await h.remix.tick('e1'); h.tick(5000); await h.remix.tick('e1');
  assert.equal(e.remix.phase, 'check');
  assert.equal(holds[0].released, true, 'released once every shot is collected');
  let during = null;
  const real = h.fakeRender.renderCut;
  h.fakeRender.renderCut = async (args) => { during = holds.filter((x) => !x.released).map((x) => x.id); return real(args); };
  await h.remix.cut(e);
  assert.deepEqual(during, ['e1'], 'held while cutting');
  assert.ok(holds.every((x) => x.released), 'and released after');
});

test('a finished cut joins the Library (e.media) when it is small enough; a bigger one stays in rx:cut only', async () => {
  const had = globalThis.FileReader;
  globalThis.FileReader = class { readAsDataURL(b) { b.arrayBuffer().then((buf) => { this.result = `data:video/mp4;base64,${Buffer.from(buf).toString('base64')}`; this.onload(); }); } };
  try {
    const h = harness({ answers: [{ raw: SHOT_PLAN }], fetchAnswers: veoDone() });
    const e = await planned(h);
    h.remix.approve(e); await h.remix.tick('e1'); h.tick(5000); await h.remix.tick('e1');
    await h.remix.cut(e);
    assert.equal(e.media?.length, 1);
    assert.equal(e.media[0].type, 'video');
    assert.match(e.media[0].src, /^data:video\/mp4;base64,/);
    assert.equal(e.media[0].still, 'data:image/jpeg;base64,QUJD', 'the poster is its Library thumbnail');
    const real = h.fakeRender.renderCut;
    h.fakeRender.renderCut = async (args) => { const r = await real(args); return { ...r, blob: { size: A.LIBRARY_MAX + 1, type: 'video/mp4' } }; };
    h.kv.map.delete('rx:cut:e1');
    h.deps.store.putBlob = async () => ({ blobKey: 'rx:cut:e1', bytes: A.LIBRARY_MAX + 1 });
    e.remix.phase = 'check';
    await h.remix.cut(e);
    assert.equal(e.media, undefined, 'an older, smaller cut never stands in for the new one');
  } finally { globalThis.FileReader = had; }
});

test('a cut that finishes after switching threads is saved into its own thread (not the open one)', async () => {
  const h = harness({ answers: [{ raw: SHOT_PLAN }], fetchAnswers: veoDone() });
  const e = await planned(h);
  h.remix.approve(e); await h.remix.tick('e1'); h.tick(5000); await h.remix.tick('e1');
  h.dbThreads.set('t1', structuredClone(h.thread)); // what IndexedDB holds for t1
  const other = { id: 't2', entries: [], updatedAt: h.now() };
  const real = h.fakeRender.renderCut;
  h.fakeRender.renderCut = async (args) => { h.S.thread = other; return real(args); }; // the user opened another thread mid-cut
  const before = h.log.persists;
  await h.remix.cut(e);
  assert.equal(h.log.persists, before, 'the open thread (t2) is not the one saved');
  const saved = h.dbThreads.get('t1').entries.find((x) => x.id === 'e1');
  assert.equal(saved.remix.phase, 'done');
  assert.equal(saved.remix.export.bytes, 2048);
  assert.equal(h.kv.map.get('rx:cut:e1').threadId, 't1', 'the cut is filed under its own thread (prune keeps it)');
});

// ── adversarial review (v61): money, data and robustness ──
const pollDone = () => json(200, { id: OMNI, status: 'completed', done: true, video: true });
const filmed = async (h) => { const e = await planned(h); h.remix.approve(e); await h.remix.tick('e1'); return e; };
const paintHtml = (h, e) => {
  let html = '';
  const out = { dataset: {}, get innerHTML() { return html; }, set innerHTML(v) { html = v; }, querySelector: () => null };
  const li = { classList: { add() {} }, setAttribute() {}, querySelector: (s) => (s === '.out' ? out : s === '.actions' ? { innerHTML: '' } : null) };
  h.remix.paint(li, e, '');
  return html;
};

test('review: a download that kept dropping is collected again by Retry — never filmed (and billed) a second time', async () => {
  const drop = () => new TypeError('reset');
  const h = harness({ answers: [{ raw: SHOT_PLAN }], fetchAnswers: [json(200, { id: OMNI, seconds: 4, pollAfterMs: 10_000 }), pollDone(), drop(), drop(), drop(), new Response(new Blob([new Uint8Array(10)], { type: 'video/mp4' }))] });
  const e = await filmed(h);
  for (let i = 0; i < 3; i++) { h.tick(5000); await h.remix.tick('e1'); }
  assert.equal(e.remix.shots.s1.state, 'failed');
  assert.match(e.remix.shots.s1.error, /won’t film again/);
  assert.equal(R.planCost(e.remix).usd, 0, 'nothing left to pay for: the shot is already filmed');
  h.remix.retryShot(e, 's1');
  await h.remix.tick('e1');
  assert.equal(h.log.fetches.filter((f) => f.method === 'POST').length, 1, 'no second Omni start');
  assert.equal(e.remix.shots.s1.state, 'ready');
  assert.equal(e.remix.phase, 'check');
});

test('review: a poll refused mid-filming (e.g. 401) → Retry polls the same operation again, it does not refilm', async () => {
  const h = harness({ answers: [{ raw: SHOT_PLAN }], fetchAnswers: [json(200, { id: OMNI, seconds: 4, pollAfterMs: 10_000 }), json(401, { error: 'Wrong passcode — check it in Settings.' }), json(200, { done: false })] });
  const e = await filmed(h);
  h.tick(5000); await h.remix.tick('e1');
  assert.equal(e.remix.shots.s1.state, 'failed');
  h.remix.retryShot(e, 's1');
  await h.remix.tick('e1');
  assert.deepEqual(h.log.fetches.map((f) => f.method), ['POST', 'GET', 'GET']);
  assert.equal(e.remix.shots.s1.state, 'filming');
  assert.deepEqual((await h.store.opsAll()).map((o) => o.op), [OP], 'a reload keeps polling it');
});

test('review: Approve after a failed start really films again (the job store’s old state never undoes the tap)', async () => {
  const h = harness({ answers: [{ raw: SHOT_PLAN }], fetchAnswers: [json(400, { error: { message: 'Prompt rejected' } }), json(200, { id: OMNI, seconds: 4, pollAfterMs: 10_000 })] });
  const e = await filmed(h);
  assert.equal(e.remix.shots.s1.state, 'failed');
  assert.equal(h.remix.approve(e), true);
  await h.remix.tick('e1');
  assert.equal(h.log.fetches.filter((f) => f.method === 'POST').length, 2);
  assert.equal(e.remix.shots.s1.state, 'filming');
});

test('review: a reload between Approve and the first start never leaves a dead "Filming" card', async () => {
  const h = harness({ answers: [{ raw: SHOT_PLAN }] });
  const e = await planned(h);
  e.remix.approval = R.approvalFor(e.remix, null, h.now()); e.remix.phase = 'film'; // saved by Approve, then the tab closed
  const fresh = A.createRemix({ ...h.deps });
  await fresh.boot();
  const html = paintHtml({ remix: fresh }, e);
  assert.match(html, /data-act="rx-approve"/, 'Approve is offered again (a tap, not an automatic start)');
  assert.equal(h.log.fetches.length, 0);
});

test('review: a tester (no features.remix) can’t film or plan a remix that arrived in a backup', async () => {
  const h = harness({ answers: [{ raw: SHOT_PLAN }], fetchAnswers: [json(200, { id: OMNI, seconds: 4, pollAfterMs: 10_000 })] });
  const e = await planned(h);
  h.S.tester = { features: {}, models: {} };
  assert.equal(h.remix.approve(e), false);
  e.remix.approval = R.approvalFor(e.remix, null, h.now()); e.remix.phase = 'film';
  h.remix.startJob('e1', 't1');
  await h.remix.tick('e1');
  assert.equal(h.log.fetches.length, 0, 'never an Omni start');
  assert.equal(h.remix.activeThreads().size, 0, 'and the job ends instead of spinning');
  const again = { ...e, id: 'e9', pending: true, remix: { ...h.remix.newRemix(video(), 'x') } };
  await assert.rejects(h.remix.plan(again, new AbortController().signal, h.thread), (err) => err.status === 403);
});

test('review: Revise waits while shots are filming (the revision would hold a shot nobody collects)', async () => {
  const h = harness({ answers: [{ raw: SHOT_PLAN }], fetchAnswers: [json(200, { id: OMNI, seconds: 4, pollAfterMs: 10_000 })] });
  const e = await filmed(h);
  assert.equal(e.remix.shots.s1.state, 'filming');
  assert.equal(h.remix.revise(e, 'make the title bigger'), null);
  assert.equal(h.log.added.length, 0);
  assert.match(h.log.toasts.at(-1), /finish filming/);
});

test('review: two tabs approving the same remix start each shot once (the start is claimed across tabs)', async () => {
  const h = harness({ answers: [{ raw: SHOT_PLAN }], fetchAnswers: [json(200, { id: OMNI, seconds: 4, pollAfterMs: 10_000 })] });
  const e = await planned(h);
  // the other tab holds the start lock first and films s1 meanwhile
  const locks = { request: async (name, fn) => { await h.store.jobPatch('e1', 's1', { state: 'filming', op: OP, startedAt: h.now() }, 't1'); return fn(); } };
  const tab = A.createRemix({ ...h.deps, navigator: { userAgent: 'node', locks } });
  tab.approve(e);
  await tab.tick('e1');
  assert.equal(h.log.fetches.filter((f) => f.method === 'POST').length, 0);
  assert.equal(e.remix.shots.s1.state, 'filming');
});

test('review: Clear this device — nothing remix writes comes back after the wipe', async () => {
  const h = harness({ answers: [{ raw: SHOT_PLAN }], fetchAnswers: [json(200, { id: OMNI, seconds: 4, pollAfterMs: 10_000 })] });
  const e = await filmed(h);
  await h.remix.editPlan(e, (p) => { p.title = 'Changed'; }); // a debounced draft is pending
  h.remix.wipe();
  h.kv.map.clear(); // DB.kvClear()
  await h.store.draftFlush(); // pagehide
  h.tick(5000);
  for (const t of [...h.timers]) t.fn();
  await flush(); await flush();
  assert.deepEqual([...h.kv.map.keys()], []);
  assert.equal(h.remix.activeThreads().size, 0);
});

test('review: deleting a thread removes its settled remix files now, not at the next start', async () => {
  const h = harness({ answers: [{ raw: FX.plan }] });
  await planned(h, 'tighten the close');
  await h.store.putBlob('rx:cut:e1', new Blob([new Uint8Array(8)]), { threadId: 't1' });
  await h.store.putBlob('rx:src:zz', new Blob([new Uint8Array(8)]), { threadId: 't2' });
  await h.remix.forgetThread('t1');
  assert.deepEqual([...h.kv.map.keys()].filter((k) => k.includes('e1')), []);
  assert.ok(h.kv.map.has('rx:src:zz'), 'another thread’s files stay');
});

test('review: a malformed remix plan (from an old backup) never breaks painting the thread', async () => {
  const h = harness({ answers: [{ raw: SHOT_PLAN }] });
  const e = await planned(h);
  e.remix.plan = { title: 'x', timeline: { 0: 1 }, overlays: 'nope' };
  e.remix.rev++;
  assert.doesNotThrow(() => paintHtml(h, e));
  assert.equal(R.validRemix(e.remix), false);
});

test('review: Fine-tune steps don’t re-probe the encoder each tap (capabilities are read once per session)', async () => {
  const h = harness({ answers: [{ raw: SHOT_PLAN }] });
  const e = await planned(h);
  let n = 0;
  const real = h.fakeRender.capabilities;
  h.fakeRender.capabilities = async (o) => { n++; return real(o); };
  for (let i = 0; i < 3; i++) await h.remix.editPlan(e, (p) => { p.timeline[0].src_out -= 0.1; });
  assert.ok(n <= 1, `capabilities ran ${n} times`);
});

test('review: opening a finished remix on a device without its cut never rewrites the entry (sync would carry that back)', async () => {
  const h = harness({ answers: [{ raw: FX.plan }] });
  const e = await planned(h, 'tighten the close');
  await h.remix.cut(e);
  assert.equal(e.remix.phase, 'done');
  const fresh = A.createRemix({ ...h.deps });
  h.kv.map.delete('rx:cut:e1'); delete e.media; // another device: the cut was too big for the Library copy
  const exp = structuredClone(e.remix.export);
  let html = '';
  const vid = {};
  const out = { dataset: {}, get innerHTML() { return html; }, set innerHTML(v) { html = v; }, querySelector: (s) => (s === '[data-rx-cut]' ? vid : null) };
  const li = { classList: { add() {} }, setAttribute() {}, querySelector: (s) => (s === '.out' ? out : s === '.actions' ? { innerHTML: '' } : null) };
  fresh.paint(li, e, '');
  await flush(); await flush();
  assert.equal(e.remix.phase, 'done');
  assert.deepEqual(e.remix.export, exp);
  fresh.paint(li, e, '');
  assert.match(html, /isn’t on this device/);
  assert.match(html, /data-act="rx-cut"/);
});

// ── v114 review (remix #0 to #11) ──
const OMNI_MODEL = 'gemini:gemini-omni-1.1-flash';
const mp4 = (bytes) => new Response(new Blob([new Uint8Array(bytes)], { type: 'video/mp4' }), { status: 200 });
// A second generation of the same shot (a refilm): its own Omni id, and a file of another size than veoDone()'s 10 bytes.
const refilm = (seconds = 4, bytes = 20) => [json(200, { id: 'int_second', seconds, pollAfterMs: 10_000 }), json(200, { id: 'int_second', status: 'completed', done: true, video: true }), mp4(bytes)];
const ready = async (h) => { const e = await filmed(h); h.tick(5000); await h.remix.tick('e1'); return e; };
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await flush(); };
// planned() for a clip the test attached and probed itself
async function plannedFrom(h, v, text = 'Add a b-roll beat of a desk after the opening') {
  const e = { id: 'e1', kind: 'video', prompt: text, images: [], createdAt: h.now(), pending: true, video: { name: v.name, mime: 'video/mp4', size: v.size, duration: 48, width: v.width, height: v.height, frames: [] } };
  e.remix = h.remix.newRemix(v, text);
  h.thread.entries.push(e);
  h.remix.keepSource(e, v.file);
  await h.remix.plan(e, new AbortController().signal, h.thread);
  e.pending = false;
  return e;
}
// URL.createObjectURL / revokeObjectURL that count: 'blob:1', 'blob:2', … with the Blob each was made from.
function urls() {
  const made = [], revoked = [];
  return { made, revoked, createObjectURL: (blob) => { const url = `blob:${made.length + 1}`; made.push({ url, blob }); return url; }, revokeObjectURL: (url) => { revoked.push(url); } };
}
// Just enough of a document for the Fine-tune sheet: the <dialog> it builds keeps its listeners and its innerHTML.
function fakeDoc() {
  const made = [];
  const createElement = (tag) => {
    const el = {
      tag, dataset: {}, className: '', innerHTML: '', open: false, on: {}, setAttribute() {}, append() {}, click() {}, remove() {}, replaceChildren() {},
      addEventListener(type, fn) { el.on[type] = fn; }, querySelector: () => null, querySelectorAll: () => [], contains: () => false,
      showModal() { el.open = true; }, close() { el.open = false; el.on.close?.(); },
    };
    made.push(el);
    return el;
  };
  return { hidden: false, activeElement: null, body: { append() {} }, createElement, addEventListener() {}, querySelector: () => null, sheet: () => made.find((x) => x.tag === 'dialog') };
}
const DRAW = { ensureFonts: async () => 'studio', grabFrame: async (file, t) => ({ t }), canvasToDataUrl: async () => 'data:image/jpeg;base64,QUJD' };
const tapOn = (sel) => ({ target: { closest: (s) => (s === sel ? { dataset: {} } : null) } });
const pick = (f, id, value) => ({ target: { dataset: { f, id }, value } });

test('v114 #0: a portrait phone clip (stored sideways with a 90° tag) is planned, filmed and cut upright', async () => {
  const h = harness({ answers: [{ raw: SHOT_PLAN }], fetchAnswers: veoDone() });
  // what remix-render.js probeSource returns for it: the upright display size AND the track's rotation
  const PHONE = { ...INFO, width: 1080, height: 1920, codedWidth: 1920, codedHeight: 1080, rotation: 90 };
  const v = { ...video(), width: 1080, height: 1920 };
  const asked = [];
  const caps = h.fakeRender.capabilities;
  h.fakeRender.probeSource = async (f) => (f === v.file ? { ...PHONE } : { ...INFO, width: 720, height: 1280 }); // the filmed shot is 9:16
  h.fakeRender.capabilities = async (o) => { if (o.out) asked.push(o.out); return caps(o); };
  h.remix.composer.attached(v);
  await flush(); await flush();
  assert.deepEqual(asked[0], { w: 1080, h: 1920 }, 'the encoder is asked about the upright size');
  const e = await plannedFrom(h, v);
  assert.deepEqual([e.remix.source.width, e.remix.source.height, e.remix.source.rotation], [1080, 1920, 0], 'upright sizes carry no rotation tag');
  assert.deepEqual(R.outputSize(e.remix.source, 'desktop'), { w: 1080, h: 1920 });
  assert.match(h.log.streams[0].messages[0].content, /SOURCE: duration 48 s, 1080×1920 px, 30 fps, audio: yes, rotation 0°/);
  assert.equal(R.validRemix(e.remix), true);
  h.remix.approve(e);
  await h.remix.tick('e1');
  assert.equal(h.log.fetches[0].body.aspect, '9:16', 'the new shot is filmed vertical, not 16:9');
  h.tick(5000); await h.remix.tick('e1');
  await h.remix.cut(e);
  const g = h.log.renders[0].graph;
  assert.deepEqual([g.w, g.h], [1080, 1920]);
  assert.deepEqual(g.items.find((it) => it.type === 'source').crop, { sx: 0, sy: 0, sw: 1080, sh: 1920, rotation: 0, scale: 1 }, 'the whole upright frame (the crop is in display pixels)');
  assert.deepEqual([e.remix.export.w, e.remix.export.h], [1080, 1920]);

  // a remix saved before v114 still carries the tag beside its upright size: opening it drops the tag
  const h2 = harness({ answers: [{ raw: SHOT_PLAN }], fetchAnswers: [json(200, { id: OMNI, seconds: 4, pollAfterMs: 10_000 })] });
  const v2 = { ...video(), width: 1080, height: 1920 };
  const old = await plannedFrom(h2, v2);
  old.remix.source.rotation = 90;
  assert.match(paintHtml(h2, old), /Approve &amp; film/);
  assert.equal(old.remix.source.rotation, 0);
  old.remix.source.rotation = 90; // and the film tick reads it the same way (a thread that isn't open is never painted)
  h2.remix.approve(old);
  await h2.remix.tick('e1');
  assert.equal(h2.log.fetches[0].body.aspect, '9:16');
});

test('v114 #1: a remix saved in phase "cut" with no cut running here offers the review card again, never a dead Cancel', async () => {
  const h = harness({ answers: [{ raw: FX.plan }] });
  const e = await planned(h, 'tighten the close');
  e.remix.phase = 'cut'; // saved mid-cut: the tab was hidden, then discarded
  const fresh = A.createRemix({ ...h.deps }); // the next open: no render job
  let html = paintHtml({ remix: fresh }, e);
  assert.match(html, /data-act="rx-cut"[^>]*>Cut it · free/, 'nothing to film: the cut is offered');
  assert.match(html, /data-act="rx-preview"/);
  assert.match(html, /data-act="rx-finetune"/);
  assert.doesNotMatch(html, /rx-cancel-cut|rx-cutting/);
  assert.equal(e.remix.phase, 'cut', 'a paint never rewrites the entry (a synced copy would be pushed back)');
  // a Cancel from a paint made before the reload puts the saved phase right
  const saves = h.log.persists;
  assert.equal(await fresh.onAct('rx-cancel-cut', null, e), true);
  assert.equal(e.remix.phase, 'review');
  assert.equal(h.log.persists, saves + 1);
  // a cut started from the leftover state that can't run ends on the review card, with its buttons
  e.remix.phase = 'cut';
  const caps = h.fakeRender.capabilities;
  h.fakeRender.capabilities = async () => ({ path: 'none', reason: 'No encoder here.' });
  await fresh.cut(e);
  assert.equal(e.remix.phase, 'review');
  html = paintHtml({ remix: fresh }, e);
  assert.match(html, /No encoder here\./);
  assert.match(html, /data-act="rx-finetune"/);
  // a cut that is really running still shows Cutting and Cancel, and finishes
  e.remix.phase = 'cut';
  h.fakeRender.capabilities = caps;
  const real = h.fakeRender.renderCut;
  let during = '';
  h.fakeRender.renderCut = async (args) => { during = paintHtml({ remix: fresh }, e); return real(args); };
  await fresh.cut(e);
  assert.match(during, /data-act="rx-cancel-cut"/);
  assert.doesNotMatch(during, /data-act="rx-cut"/);
  assert.equal(e.remix.phase, 'done');

  // with a shot still to film, the same leftover state offers Approve (and nothing is filmed by itself)
  const h2 = harness({ answers: [{ raw: SHOT_PLAN }] });
  const e2 = await planned(h2);
  e2.remix.phase = 'cut';
  const html2 = paintHtml({ remix: A.createRemix({ ...h2.deps }) }, e2);
  assert.match(html2, /data-act="rx-approve"/);
  assert.doesNotMatch(html2, /rx-cancel-cut/);
  assert.equal(h2.log.fetches.length, 0);
});

test('v114 #2: deleting a thread while it films: the job checks the provider from the job store alone, then every file of the entry goes', async () => {
  const h = harness({ answers: [{ raw: SHOT_PLAN }], fetchAnswers: [json(200, { id: OMNI, seconds: 4, pollAfterMs: 10_000 }), json(200, { done: false }), pollDone()] });
  const e = await filmed(h);
  assert.equal(e.remix.shots.s1.state, 'filming');
  assert.ok(h.kv.map.has('rx:src:e1') && h.kv.map.has('rx:job:e1'));
  // what app.js deleteSavedThread does: the open thread is cleared and deleted from the database, then forgetThread
  h.S.thread = null; h.dbThreads.delete('t1');
  await h.remix.forgetThread('t1');
  assert.ok(h.kv.map.has('rx:src:e1'), 'kept while a shot is still at the provider');
  h.tick(5000);
  await h.remix.tick('e1');
  assert.deepEqual(h.log.fetches.map((f) => f.url), ['/api/omni/start', `/api/omni/status/${OMNI}`], 'the shot is still checked');
  assert.deepEqual(h.remix.activeThreads(), new Set(['t1']), 'the job lives until the provider is done');
  assert.equal(h.timers.at(-1).ms, 5000, 'and asks again');
  assert.ok(h.kv.map.has('rx:src:e1'));
  h.tick(5000);
  await h.remix.tick('e1');
  assert.deepEqual(h.log.fetches.map((f) => f.url), ['/api/omni/start', `/api/omni/status/${OMNI}`, `/api/omni/status/${OMNI}`], 'the check that settles the cost; the video is not downloaded');
  assert.deepEqual([...h.kv.map.keys()].filter((k) => k.includes('e1')), [], 'source, job, draft and shots are gone');
  assert.deepEqual(await h.store.opsAll(), [], 'no op is left to resume at the next start');
  assert.deepEqual(h.remix.activeThreads(), new Set());
});

test('v114 #2: a job whose thread was deleted elsewhere (another device, an earlier session) is checked, then its op goes and the next start prunes its files', async () => {
  const kv = memoryKv();
  const st = createRemixStore(kv);
  const T0 = 1_700_000_000_000 - 60_000;
  // what a delete while filming left behind before v114: the op, the job record and the source of a thread that is gone
  await st.opsAdd({ entryId: 'e9', threadId: 'gone', shotId: 's1', op: OP, startedAt: T0 });
  await st.jobPatch('e9', 's1', { state: 'filming', op: OP, startedAt: T0 }, 'gone');
  await st.putBlob('rx:src:e9', new Blob([new Uint8Array(8)]), { threadId: 'gone' });
  const h = harness({ store: { kv }, fetchAnswers: [json(200, { done: false }), pollDone()] });
  await h.remix.boot();
  assert.ok(h.kv.map.has('rx:src:e9'), 'the boot prune leaves an entry whose op is still listed');
  await h.remix.tick('e9');
  assert.deepEqual(h.remix.activeThreads(), new Set(['gone']), 'still filming at the provider: asked again');
  h.tick(10_000);
  await h.remix.tick('e9');
  assert.deepEqual(h.log.fetches.map((f) => f.url), [`/api/omni/status/${OMNI}`, `/api/omni/status/${OMNI}`], 'checked until the provider is done; nothing downloaded');
  assert.deepEqual(await h.store.opsAll(), [], 'the op no longer holds the entry back from prune');
  assert.deepEqual(h.remix.activeThreads(), new Set());
  assert.ok(h.kv.map.has('rx:src:e9'), 'this device never confirmed that delete: the files wait for prune’s own rule');
  await A.createRemix({ ...h.deps }).boot(); // the next start: nothing to resume, and the thread is gone
  assert.equal(h.log.fetches.length, 2);
  assert.deepEqual([...h.kv.map.keys()].filter((k) => k.includes('e9')), []);
});

test('v114 #2: an entry missing from a thread that still exists loses nothing; its op goes only once the provider no longer keeps the shot', async () => {
  const kv = memoryKv();
  const st = createRemixStore(kv);
  const h = harness({ store: { kv } }); // thread t1 is there, without the entry
  const T0 = h.now() - 60_000;
  await st.opsAdd({ entryId: 'e9', threadId: 't1', shotId: 's1', op: OP, startedAt: T0 });
  await st.jobPatch('e9', 's1', { state: 'filming', op: OP, startedAt: T0 }, 't1');
  await st.putBlob('rx:src:e9', new Blob([new Uint8Array(8)]), { threadId: 't1' });
  h.remix.startJob('e9', 't1');
  await h.remix.tick('e9');
  assert.equal(h.log.fetches.length, 0);
  assert.ok(h.kv.map.has('rx:src:e9') && h.kv.map.has('rx:job:e9'), 'nothing is dropped');
  assert.equal((await h.store.opsAll()).length, 1, 'the op stays for the next start to try again');
  assert.equal(h.remix.activeThreads().size, 0);
  h.tick(48 * 3_600_000);
  h.remix.startJob('e9', 't1');
  await h.remix.tick('e9');
  assert.deepEqual(await h.store.opsAll(), [], 'past the provider’s keep time nothing can be collected');
  assert.ok(h.kv.map.has('rx:src:e9'), 'the files stay under the usual prune rules');
});

test('v114 #3: lengthening a filmed shot, then Approve, films the longer shot (the old take never comes back as Ready)', async () => {
  const h = harness({ answers: [{ raw: SHOT_PLAN }], fetchAnswers: [...veoDone(), ...refilm(6)] });
  const e = await ready(h);
  assert.deepEqual([e.remix.shots.s1.state, e.remix.shots.s1.seconds, e.remix.phase], ['ready', 4, 'check']);
  assert.equal(h.kv.map.get('rx:shot:e1:s1').blob.size, 10);
  await h.store.jobPatch('e1', 's1', { take: undefined }); // a take filmed before v114: nothing in the job store says what it was filmed as
  await h.remix.editPlan(e, (p) => { p.timeline.find((c) => c.id === 'v1').use_out = 4.1; });
  await h.remix.editPlan(e, () => {}, { fit: true }); // Fit: the longer beat comes out of the clip after it
  assert.deepEqual([e.remix.shots.s1.state, e.remix.shots.s1.seconds, e.remix.shots.s1.blobKey, e.remix.phase], ['idle', 6, undefined, 'review']);
  assert.match(paintHtml(h, e), /data-act="rx-approve">Approve &amp; film · \$0\.61/);
  assert.equal(h.remix.approve(e), true);
  await h.remix.tick('e1');
  const posts = h.log.fetches.filter((f) => f.method === 'POST');
  assert.equal(posts.length, 2, 'Approve really starts the longer shot');
  assert.equal(posts[1].body.seconds, 6);
  assert.deepEqual([e.remix.shots.s1.state, e.remix.shots.s1.blobKey], ['filming', undefined], 'nothing of the old take is on the new one');
  h.tick(5000); await h.remix.tick('e1');
  assert.deepEqual([e.remix.shots.s1.state, e.remix.shots.s1.seconds, e.remix.phase], ['ready', 6, 'check']);
  assert.equal(h.kv.map.get('rx:shot:e1:s1').blob.size, 20, 'the new take replaced the old bytes');
  assert.equal((await h.store.jobGet('e1')).shots.s1.take, `${OMNI_MODEL}|6|720p`, 'the job store knows what it holds');
  assert.equal(e.remix.shots.s1.take, undefined, 'that mark never goes into the thread');
  assert.equal(R.validRemix(e.remix), true);
});

test('v114 #3: a take whose mark can’t be written to the job store is still known as the old one in this session', async () => {
  const h = harness({ answers: [{ raw: SHOT_PLAN }], fetchAnswers: [...veoDone(), ...refilm(6)] });
  const e = await ready(h);
  await h.store.jobPatch('e1', 's1', { take: undefined }); // filmed before v114
  const write = h.store.jobPatch;
  h.store.jobPatch = async (entry, id, patch, ...rest) => { if (typeof patch?.take === 'string') throw new Error('storage is full'); return write(entry, id, patch, ...rest); };
  await h.remix.editPlan(e, (p) => { p.timeline.find((c) => c.id === 'v1').use_out = 4.1; });
  await h.remix.editPlan(e, () => {}, { fit: true });
  assert.equal((await h.store.jobGet('e1')).shots.s1.take, undefined, 'the job store still says only "ready"');
  assert.equal(h.remix.approve(e), true);
  await h.remix.tick('e1');
  assert.equal(h.log.fetches.filter((f) => f.method === 'POST').length, 2, 'Approve films the longer shot all the same');
  assert.deepEqual([e.remix.shots.s1.state, e.remix.shots.s1.seconds], ['filming', 6]);
});

test('v114 #3: stepping a filmed shot past a length step and back keeps its footage: Approve films nothing new', async () => {
  const h = harness({ answers: [{ raw: SHOT_PLAN }], fetchAnswers: veoDone() });
  const e = await ready(h);
  await h.remix.editPlan(e, (p) => { p.timeline.find((c) => c.id === 'v1').use_out = 4.1; });
  assert.deepEqual([e.remix.shots.s1.state, e.remix.shots.s1.seconds], ['idle', 6]);
  await h.remix.editPlan(e, (p) => { p.timeline.find((c) => c.id === 'v1').use_out = 2.5; });
  assert.deepEqual([e.remix.shots.s1.state, e.remix.shots.s1.seconds], ['idle', 4]);
  assert.equal(h.remix.approve(e), true);
  await h.remix.tick('e1');
  assert.equal(h.log.fetches.filter((f) => f.method === 'POST').length, 1, 'the paid take is used again: no second start');
  assert.deepEqual([e.remix.shots.s1.state, e.remix.shots.s1.blobKey, e.remix.phase], ['ready', 'rx:shot:e1:s1', 'check']);
  assert.equal(h.kv.map.get('rx:shot:e1:s1').blob.size, 10);
  assert.deepEqual(h.remix.activeThreads(), new Set());
});

test('v114 #4: Play after a refilm shows the new take', async () => {
  const U = urls();
  const h = harness({ answers: [{ raw: SHOT_PLAN }], fetchAnswers: [...veoDone(), ...refilm(4, 20)], over: { URL: U } });
  const e = await ready(h);
  const play = async () => { await h.remix.onAct('rx-play-shot', { dataset: { id: 's1' } }, e); await settle(2); return h.log.viewer.at(-1).video; };
  assert.equal(await play(), 'blob:1');
  assert.equal(U.made[0].blob.size, 10);
  h.remix.retryShot(e, 's1', { anyway: true }); // Refilm: back to idle, needs approval
  await settle(2); // the tap's write to the job store lands before the Approve tap
  assert.equal(h.remix.approve(e), true);
  await h.remix.tick('e1'); h.tick(5000); await h.remix.tick('e1');
  assert.equal(h.log.fetches.filter((f) => f.method === 'POST').length, 2);
  assert.equal(e.remix.shots.s1.state, 'ready');
  assert.equal(await play(), 'blob:2');
  assert.equal(U.made[1].blob.size, 20, 'the viewer gets the bytes of the new take');
  assert.deepEqual(U.revoked, ['blob:1'], 'and the first take’s URL is let go');
});

test('v114 #4: a shot synced from another device and refilmed here stops reading “isn’t on this device”', async () => {
  const h = harness({ answers: [{ raw: SHOT_PLAN }], fetchAnswers: veoDone() });
  const e = await planned(h);
  Object.assign(e.remix.shots.s1, { state: 'ready', blobKey: 'rx:shot:e1:s1', filmedKey: e.remix.shots.s1.contentKey }); // filmed elsewhere: no bytes here
  e.remix.phase = 'check';
  paintHtml(h, e); // the paint looks for the bytes
  await settle(2);
  let html = paintHtml(h, e);
  assert.match(html, /This shot isn’t on this device/);
  assert.match(html, /data-act="rx-retry-anyway" data-id="s1">Refilm · \$0\.41/);
  h.remix.retryShot(e, 's1', { anyway: true });
  await settle(2);
  assert.equal(h.remix.approve(e), true);
  await h.remix.tick('e1'); h.tick(5000); await h.remix.tick('e1');
  assert.equal(e.remix.shots.s1.state, 'ready');
  html = paintHtml(h, e);
  assert.doesNotMatch(html, /isn’t on this device/, 'the paid refilm is on this device');
  assert.doesNotMatch(html, /Refilm/);
  assert.match(html, /data-act="rx-play-shot"/);
});

test('v114 #5: Fine-tune can’t relabel a filmed or filming shot with another model', async () => {
  const doc = fakeDoc();
  const h = harness({ answers: [{ raw: SHOT_PLAN }], fetchAnswers: veoDone(), over: { document: doc, draw: DRAW, runwayReady: () => true } });
  const e = await planned(h);
  await h.remix.onAct('rx-finetune', null, e);
  const sheet = doc.sheet();
  assert.match(sheet.innerHTML, /<select data-f="model" data-id="s1">/, 'not filmed yet: the model can change');
  assert.match(sheet.innerHTML, /Runway Gen-4\.5/);
  await sheet.on.change(pick('model', 's1', 'runway:gen4.5'));
  assert.equal(e.remix.shots.s1.model, 'runway:gen4.5');
  await sheet.on.change(pick('model', 's1', OMNI_MODEL));
  assert.deepEqual([e.remix.shots.s1.model, e.remix.shots.s1.seconds], [OMNI_MODEL, 4]);
  // filming: locked
  h.remix.approve(e);
  await h.remix.tick('e1');
  assert.equal(e.remix.shots.s1.state, 'filming');
  await sheet.on.change(pick('model', 's1', 'runway:gen4.5')); // the sheet was painted before the shot started
  assert.equal(e.remix.shots.s1.model, OMNI_MODEL);
  assert.equal(h.log.toasts.at(-1), A.COPY.modelBusy);
  assert.match(sheet.innerHTML, /<select data-f="model" data-id="s1" disabled>/);
  assert.ok(sheet.innerHTML.includes(A.COPY.modelBusy));
  // filmed: locked, and the footage keeps its model and its price
  h.tick(5000); await h.remix.tick('e1'); await settle(2);
  assert.equal(e.remix.shots.s1.state, 'ready');
  const { usd, blobKey } = e.remix.shots.s1;
  await h.remix.onAct('rx-finetune', null, e);
  assert.match(sheet.innerHTML, /<select data-f="model" data-id="s1" disabled>/);
  assert.ok(sheet.innerHTML.includes(A.COPY.modelFilmed));
  await sheet.on.change(pick('model', 's1', 'runway:gen4.5'));
  assert.deepEqual([e.remix.shots.s1.model, e.remix.shots.s1.state, e.remix.shots.s1.usd, e.remix.shots.s1.blobKey], [OMNI_MODEL, 'ready', usd, blobKey]);
  assert.equal(h.log.toasts.at(-1), A.COPY.modelFilmed);
  // Refilm (needs approval) sends it back to idle: then the model can change
  h.remix.retryShot(e, 's1', { anyway: true });
  await sheet.on.change(pick('model', 's1', 'runway:gen4.5'));
  assert.deepEqual([e.remix.shots.s1.model, e.remix.shots.s1.state], ['runway:gen4.5', 'idle']);
  assert.equal(R.needsApproval(e.remix).needed, true);
});

test('v114 #6: a clip with no audio track is planned without a soundtrack to keep, and the strip says so', async () => {
  const h = harness({ answers: [{ raw: FX.plan }] });
  h.fakeRender.probeSource = async () => ({ ...INFO, audio: null, hasAudio: false });
  const v = video();
  h.S.video = v; // app.js keeps the composer's clip in S.video
  h.remix.composer.attached(v);
  await flush(); await flush();
  const strip = h.remix.composer.options();
  assert.match(strip, /No soundtrack in this clip/);
  assert.doesNotMatch(strip, /data-rx-opt="keep"/);
  const e = await plannedFrom(h, v, 'add a title card');
  assert.equal(e.remix.source.hasAudio, false);
  assert.equal(e.remix.opts.audioMode, 'follow_cuts', 'keep mode would cut footage to fit a soundtrack that isn’t there');
  assert.match(h.log.streams[0].messages[0].content, /audio: none/);
  assert.match(h.log.streams[0].messages[0].content, /Audio follows the cuts/);
  assert.doesNotMatch(h.log.streams[0].messages[0].content, /SOUNDTRACK KEPT/);
  assert.equal(e.remix.plan.audio.mode, 'follow_cuts');
  assert.ok(!e.remix.issues.some((i) => /soundtrack/.test(i.msg)), 'nothing was taken out to match a soundtrack');
  assert.equal(R.validRemix(e.remix), true);
  // a clip with sound, or one not probed yet: as before
  const h2 = harness();
  const v2 = video();
  h2.S.video = v2;
  h2.remix.composer.attached(v2);
  await flush(); await flush();
  assert.match(h2.remix.composer.options(), /data-rx-opt="keep"/);
  assert.deepEqual([h2.remix.newRemix(v2, 'x').source.hasAudio, h2.remix.newRemix(v2, 'x').opts.audioMode], [true, 'keep']);
  assert.deepEqual([h2.remix.newRemix(video(), 'x').source.hasAudio, h2.remix.newRemix(video(), 'x').opts.audioMode], [null, 'keep']);
});

test('v114 #7: a preview that can’t run toasts and leaves no error card; Fine-tune’s Preview waits for the shots', async () => {
  const doc = fakeDoc();
  const h = harness({ answers: [{ raw: SHOT_PLAN }], over: { document: doc, draw: DRAW } });
  const e = await planned(h);
  await h.remix.onAct('rx-finetune', null, e);
  const sheet = doc.sheet();
  assert.match(sheet.innerHTML, /data-preview disabled title="Preview after the shots are filmed">/, 'as on the cost card');
  await sheet.on.click(tapOn('[data-preview]')); // a sheet painted before the shot went back to idle
  assert.equal(h.log.toasts.at(-1), A.COPY.previewAfter);
  assert.equal(sheet.open, true);
  assert.equal(h.remix._renders.size, 0, 'no cut was started');
  assert.equal(e.remix.renderError, undefined);
  // a preview that fails for another reason: a toast, never the red card (its Try again is a full cut)
  h.fakeRender.capabilities = async () => ({ path: 'none', reason: 'No encoder here.' });
  assert.equal(await h.remix.cut(e, { preview: true }), null);
  assert.equal(h.log.toasts.at(-1), 'No encoder here.');
  assert.equal(e.remix.renderError, undefined);
  assert.doesNotMatch(paintHtml(h, e), /rx-callout bad/);
  // a cut that fails still shows the card
  await h.remix.cut(e);
  assert.equal(e.remix.renderError, 'No encoder here.');
  assert.match(paintHtml(h, e), /rx-callout bad/);

  // nothing to film: the sheet's Preview runs
  const doc2 = fakeDoc();
  const h2 = harness({ answers: [{ raw: FX.plan }], over: { document: doc2, draw: DRAW } });
  const e2 = await planned(h2, 'tighten the close');
  await h2.remix.onAct('rx-finetune', null, e2);
  assert.match(doc2.sheet().innerHTML, /<button type="button" class="chip" data-preview>Preview whole cut · free/);
  await doc2.sheet().on.click(tapOn('[data-preview]'));
  for (let i = 0; i < 20 && !h2.log.viewer.length; i++) await flush();
  assert.equal(h2.log.viewer[0].title, 'Preview · half size');
  assert.equal(h2.log.renders[0].preview, true);
});

test('v114 #8: there is no half-working “stop collecting”: the action is not handled and nothing exports it', async () => {
  const h = harness({ answers: [{ raw: SHOT_PLAN }], fetchAnswers: [json(200, { id: OMNI, seconds: 4, pollAfterMs: 10_000 })] });
  const e = await filmed(h);
  assert.equal(await h.remix.onAct('rx-stop-collect', null, e), false);
  assert.equal(e.remix.shots.s1.state, 'filming');
  assert.deepEqual(h.remix.activeThreads(), new Set(['t1']), 'the job keeps collecting');
  assert.equal(h.remix.stopCollecting, undefined);
  assert.equal(A.COPY.stop, undefined);
  assert.doesNotMatch(paintHtml(h, e), /rx-stop-collect/);
});

test('v114 #9: a send while the clip is still being checked is held; the check’s answer then decides, and it never holds for ever', async () => {
  const h = harness();
  let answer;
  h.fakeRender.probeSource = () => new Promise((res) => { answer = res; });
  const v = video();
  h.remix.composer.attached(v);
  await flush();
  assert.equal(h.remix.composer.note(v), A.COPY.checking);
  assert.equal(await h.remix.composer.gate('make it punchier', v, h.thread), 'held');
  assert.equal(h.log.toasts.at(-1), A.COPY.stillChecking);
  answer({ ...INFO, canDecode: false }); // this browser can't decode it: before v114 a quick send got past this
  await flush(); await flush();
  assert.equal(await h.remix.composer.gate('make it punchier', v, h.thread), 'held');
  assert.equal(h.log.toasts.at(-1), A.COPY.cantCut);
  const fine = video();
  h.remix.composer.attached(fine);
  await flush();
  assert.equal(await h.remix.composer.gate('make it punchier', fine, h.thread), 'held');
  answer({ ...INFO });
  await flush(); await flush();
  assert.equal(await h.remix.composer.gate('make it punchier', fine, h.thread), 'ok');
  // a check with no answer lets the send through after CHECK_HOLD_MS, as before v114
  const slow = video();
  h.fakeRender.probeSource = () => new Promise(() => {});
  h.remix.composer.attached(slow);
  await flush();
  assert.equal(await h.remix.composer.gate('make it punchier', slow, h.thread), 'held');
  h.tick(A.CHECK_HOLD_MS);
  assert.equal(await h.remix.composer.gate('make it punchier', slow, h.thread), 'ok');
  assert.equal(h.log.fetches.length, 0);
});

test('v114 #10: a beat’s thumbnail follows a Fine-tune edit (a card’s words, a kept clip’s in point)', async () => {
  const doc = fakeDoc();
  const b64 = (x) => `data:image/jpeg;base64,${Buffer.from(JSON.stringify(x)).toString('base64')}`;
  const draw = { ensureFonts: async () => 'studio', grabFrame: async (file, t) => ({ frame: Math.round(t * 100) / 100 }), cardThumb: (card) => ({ card: card.lines.map((l) => l.text) }), canvasToDataUrl: async (c) => b64(c) };
  const h = harness({ answers: [{ raw: FX.plan }], over: { document: doc, draw } });
  const e = await planned(h, 'tighten the close');
  // the thumbnails a paint shows, read back from their data URLs: {frame: seconds} for a kept clip, {card: [lines]} for a card
  const shown = () => [...paintHtml(h, e).matchAll(/<img src="data:image\/jpeg;base64,([^"]+)"/g)].map((m) => JSON.parse(Buffer.from(m[1], 'base64').toString()));
  const words = () => shown().find((x) => x.card)?.card ?? null;
  shown(); await settle();
  const at = (id) => e.remix.plan.timeline.find((c) => c.id === id);
  assert.deepEqual(shown(), [{ frame: at('open').src_in + 0.05 }, { card: ['Connected to your tools:', 'Gmail, GitHub, Stripe, Slack.'] }, { frame: at('models').src_in + 0.05 }, { frame: at('close').src_in + 0.05 }]);
  await h.remix.editPlan(e, (p) => { p.timeline.find((c) => c.id === 'tools').lines[0].text = 'Works with your tools:'; });
  assert.equal(words(), null, 'the old picture is not shown for the new words');
  await settle();
  assert.deepEqual(words(), ['Works with your tools:', 'Gmail, GitHub, Stripe, Slack.']);
  const was = at('models').src_in;
  await h.remix.editPlan(e, (p) => { p.timeline.find((c) => c.id === 'models').src_in += 2; });
  assert.ok(!shown().some((x) => x.frame === was + 0.05), 'nor the old frame for the new in point');
  await settle();
  assert.ok(shown().some((x) => x.frame === was + 2.05));
  assert.equal(shown().length, 4, 'the beats that didn’t change kept their pictures');
  // one picture per beat is kept: going back makes it again
  await h.remix.editPlan(e, (p) => { p.timeline.find((c) => c.id === 'tools').lines[0].text = 'Connected to your tools:'; });
  assert.equal(words(), null);
  await settle();
  assert.deepEqual(words(), ['Connected to your tools:', 'Gmail, GitHub, Stripe, Slack.']);
});

test('v114 #11: object URLs are let go: one viewer URL at a time, one per cut, and a deleted thread’s cut', async () => {
  const U = urls();
  const h = harness({ answers: [{ raw: FX.plan }], over: { URL: U } });
  const e = await planned(h, 'tighten the close');
  await h.remix.cut(e, { preview: true });
  await h.remix.cut(e, { preview: true });
  assert.deepEqual(h.log.viewer.map((x) => x.video), ['blob:1', 'blob:2']);
  assert.deepEqual(U.revoked, ['blob:1'], 'the first preview goes when the second opens; the one on screen stays');
  await h.remix.cut(e);
  assert.equal(U.made.length, 3, 'the finished cut');
  // another tab's paint of the finished remix: two paints ask for the cut's URL at once, one URL is made
  const tab = A.createRemix({ ...h.deps });
  const vid = {};
  const li = () => {
    const out = { dataset: {}, innerHTML: '', querySelector: (s) => (s === '[data-rx-cut]' ? vid : null) };
    return { classList: { add() {} }, setAttribute() {}, querySelector: (s) => (s === '.out' ? out : s === '.actions' ? { innerHTML: '' } : null) };
  };
  tab.paint(li(), e, ''); tab.paint(li(), e, '');
  await settle(3);
  assert.equal(U.made.length, 4);
  assert.equal(vid.src, 'blob:4');
  // the thread is deleted: both sessions let their cut URL go
  h.S.thread = null; h.dbThreads.delete('t1');
  await tab.forgetThread('t1');
  assert.ok(U.revoked.includes('blob:4'));
  await h.remix.forgetThread('t1'); // its files were dropped by the other session already
  assert.ok(U.revoked.includes('blob:3'));
  assert.deepEqual(U.revoked, ['blob:1', 'blob:4', 'blob:3'], 'the preview on screen is still alive');
  // Clear this device lets the rest go
  h.remix.wipe();
  assert.ok(U.revoked.includes('blob:2'));
});

test('follow-up 7: a Remix retry counts on today (deps.redone) only once it starts', async () => {
  const log = [];
  let offline = true;
  const over = { redone: (e) => log.push(['redone', e.id]), run: (e) => log.push(['run', e.id]), offline: () => offline };
  // a plan that failed, retried offline: nothing runs, nothing is stamped
  const h = harness({ over });
  const failed = { id: 'f1', kind: 'video', error: 'The plan failed', remix: { plan: null } };
  assert.equal(await h.remix.onAct('retry', null, failed), true);
  assert.deepEqual(log, []);
  assert.match(h.log.toasts.at(-1), /offline/);
  // online: stamped, then run
  offline = false;
  await h.remix.onAct('retry', null, failed);
  assert.deepEqual(log, [['redone', 'f1'], ['run', 'f1']]);
  // a cut that failed, after a reload (no source File here): the cut never starts, so no stamp
  log.length = 0; offline = true;
  const h2 = harness({ answers: [{ raw: FX.plan }], over });
  const e = await planned(h2, 'tighten the close');
  e.remix.renderError = 'No encoder here.';
  h2.kv.map.delete('rx:src:e1'); // a reload with the source gone
  const fresh = A.createRemix({ ...h2.deps });
  await fresh.onAct('retry', null, e);
  await flush();
  assert.deepEqual(log, [], 'nothing started');
  assert.equal(e.remix.needSource, true);
  // with the source here it starts (offline is fine: the cut runs on this device), and is stamped as it starts
  delete e.remix.needSource; e.remix.renderError = 'No encoder here.';
  await h2.remix.onAct('retry', null, e);
  assert.deepEqual(log, [['redone', 'e1']]);
  assert.equal(e.remix.renderError, undefined);
});
