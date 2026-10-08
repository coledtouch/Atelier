import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// public/remix-shots.js — filming remix inserts with Gemini Omni (/api/omni/*, through public/omni.js) and Runway
// (/api/runway/*), against mocked responses only. The money rule under test: only a definitive answer is ever retried
// by itself.
const S = await import('../public/remix-shots.js');
const R = await import('../public/remix.js');
const { RUNWAY_MODELS } = await import('../public/runway.js');
const OMNI_MODEL = 'gemini:gemini-omni-1.1-flash';
const LITE = 'gemini:veo-3.1-lite-generate-preview'; // a retired id a saved shot may still name
const ID = 'int_9f8e7d6c5b';
const OP = `omni:${ID}`;
const VEO_OP = 'models/veo-3.1-lite-generate-preview/operations/op123';
const TASK = '4a7b0c1d-2e3f-4a5b-8c6d-7e8f9a0b1c2d';
const JPEG = `data:image/jpeg;base64,${'/9j/4AAQ'.padEnd(64, 'A')}`;

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
// A scripted fetch: each call takes the next answer (a Response, a function of (url, init), or an Error to throw).
function mock(...answers) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    const a = answers.shift();
    if (!a) throw new Error(`unexpected fetch ${url}`);
    if (a instanceof Error) throw a;
    return typeof a === 'function' ? a(url, init) : a;
  };
  return { fetch, calls };
}
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const started = () => json(200, { id: ID, seconds: 4, pollAfterMs: 10_000 });
const status = (over = {}) => json(200, { id: ID, status: 'in_progress', done: false, video: false, ...over });
const completed = () => status({ status: 'completed', done: true, video: true });
const mp4 = (n = 1234) => new Response(new Blob([new Uint8Array(n)], { type: 'video/mp4' }), { status: 200, headers: { 'content-type': 'video/mp4' } });
const omniReq = (model = OMNI_MODEL) => S.shotRequest({ prompt: 'A walnut desk at dawn', camera: 'static', seconds: 4 }, { model, res: '720p', seconds: 4, look: 'dark', out: { w: 1080, h: 1350 } });

test('shotRequest: the exact /api/omni/start body — vertical for a 4:5 cut, the negative prompt as words, no image without a first frame', () => {
  const r = omniReq();
  assert.deepEqual([r.provider, r.model], ['omni', OMNI_MODEL]);
  const prompt = `${R.shotPrompt({ prompt: 'A walnut desk at dawn', camera: 'static' }, 'dark', 'vertical')} Avoid: ${R.SHOT_NEGATIVE}.`;
  assert.deepEqual(r.omni.body, { prompt, aspect: '9:16', resolution: '720p', seconds: 4 });
  assert.match(r.omni.body.prompt, /^Locked-off static camera\. A walnut desk at dawn Look: dark Vertical frame.* Avoid: text, letters, captions/);
  assert.equal('image' in r.omni.body, false);
  assert.equal('negativePrompt' in r.omni.body, false, 'Omni has no negative-prompt field');
});

test('shotRequest: a first frame goes in as the data URL; a landscape cut films 16:9 at the chosen resolution', () => {
  const w = S.shotRequest({ prompt: 'p', camera: 'push_in', seconds: 6 }, { model: OMNI_MODEL, res: '1080p', seconds: 6, image: JPEG, out: { w: 1920, h: 1080 } });
  assert.deepEqual(Object.keys(w.omni.body), ['prompt', 'image', 'aspect', 'resolution', 'seconds']);
  assert.deepEqual([w.omni.body.image, w.omni.body.aspect, w.omni.body.resolution, w.omni.body.seconds], [JPEG, '16:9', '1080p', 6]);
  assert.match(w.omni.body.prompt, /^Slow push-in\. p Wide frame; keep the subject centred\./);
  const portrait = S.shotRequest({ prompt: 'p', camera: 'static', seconds: 4 }, { model: OMNI_MODEL, seconds: 4, image: JPEG, out: { w: 1080, h: 1920 } });
  assert.deepEqual([portrait.omni.body.image, portrait.omni.body.aspect, portrait.omni.body.resolution], [JPEG, '9:16', '720p']);
  const bad = S.shotRequest({ prompt: 'p', seconds: 4 }, { model: OMNI_MODEL, seconds: 4, image: 'data:image/gif;base64,R0lGOD', out: { w: 1080, h: 1350 } });
  assert.equal('image' in bad.omni.body, false, 'only PNG/JPEG/WebP stills');
  assert.deepEqual(S.firstFrameShape(OMNI_MODEL, { w: 1080, h: 1350 }), { w: 720, h: 1280 });
  assert.deepEqual(S.firstFrameShape(OMNI_MODEL, { w: 1920, h: 1080 }), { w: 1280, h: 720 });
  assert.throws(() => S.shotRequest({ prompt: 'p' }, { model: 'openai:sora' }), /can’t film/);
});

test('shotRequest: a saved shot naming a retired Veo id is filmed with Omni', () => {
  const r = omniReq(LITE);
  assert.deepEqual([r.provider, r.model], ['omni', OMNI_MODEL]);
  assert.equal(S.providerOf(LITE), 'omni');
  assert.equal(S.firstFrameShape(LITE).w, 720);
});

test('omniPrompt: the avoid list always fits within the shot prompt cap', () => {
  const long = S.omniPrompt('x'.repeat(5000));
  assert.ok(long.length <= R.LIMITS.shotPromptMax);
  assert.ok(long.endsWith(`Avoid: ${R.SHOT_NEGATIVE}.`));
});

test('omniShotStart: POST /api/omni/start as JSON with the app headers → op "omni:<id>"', async () => {
  const m = mock(started());
  const r = await S.omniShotStart({ fetch: m.fetch, apiHeaders: () => ({ 'x-atelier-key': 'k' }) }, omniReq().omni);
  assert.deepEqual(r, { op: OP });
  assert.ok(R.isShotOp(r.op));
  assert.equal(m.calls[0].url, '/api/omni/start');
  assert.equal(m.calls[0].method, 'POST');
  assert.deepEqual(m.calls[0].body, omniReq().omni.body);
  assert.equal(m.calls[0].headers.get('content-type'), 'application/json');
  assert.equal(m.calls[0].headers.get('x-atelier-key'), 'k');
});

const startWith = async (answer, s = { state: 'idle' }, now = 1_000_000) => {
  const m = mock(answer), saved = [];
  const patch = await S.advanceShot({ fetch: m.fetch, request: omniReq(), now: () => now, save: async (p) => { saved.push({ ...p, calls: m.calls.length }); } }, s);
  return { patch, saved, calls: m.calls };
};

test('advanceShot start: "starting" is saved before the POST; an id means filming', async () => {
  const { patch, saved, calls } = await startWith(started());
  assert.deepEqual(saved, [{ state: 'starting', startedAt: 1_000_000, calls: 0 }], 'saved while nothing had been sent');
  assert.deepEqual(patch, { state: 'filming', op: OP, startedAt: 1_000_000, error: null });
  assert.equal(calls.length, 1);
});

test('advanceShot start: 429 omni_busy → queued (not billed, retried in 30 s); tester 402 → budget with resetsAt; 400 → failed', async () => {
  const q = await startWith(json(429, { error: 'Gemini Omni is busy', code: 'omni_busy' }));
  assert.deepEqual([q.patch.state, q.patch.retryAt, q.patch.queuedSince], ['queued', 1_030_000, 1_000_000]);
  const later = await startWith(json(429, { error: 'busy', code: 'omni_busy' }, { 'retry-after': '90' }), { state: 'queued', retryAt: 0, queuedSince: 990_000 });
  assert.deepEqual([later.patch.retryAt, later.patch.queuedSince], [1_090_000, 990_000]);
  const gaveUp = await startWith(started(), { state: 'queued', retryAt: 0, queuedSince: 1_000_000 - 11 * 60_000 });
  assert.equal(gaveUp.patch.state, 'failed');
  assert.equal(gaveUp.calls.length, 0, 'ten minutes of 429s: stop without another POST');
  const resetsAt = Date.UTC(2026, 9, 3);
  const b = await startWith(json(402, { error: 'You’ve used today’s allowance.', code: 'tester_budget', scope: 'day', resetsAt }));
  assert.deepEqual([b.patch.state, b.patch.resetsAt, b.patch.error], ['budget', resetsAt, 'You’ve used today’s allowance.']);
  const f = await startWith(json(400, { error: 'Gemini Omni can’t film that prompt.', code: 'omni_rejected' }));
  assert.deepEqual([f.patch.state, f.patch.error], ['failed', 'Gemini Omni can’t film that prompt.']);
  const notQueued = await startWith(started(), { state: 'queued', retryAt: 2_000_000 });
  assert.equal(notQueued.patch, null, 'a queued shot waits for its retry time');
});

test('advanceShot start: no answer (omni_unconfirmed) is "unknown" — and an unknown shot is never sent again by itself', async () => {
  const u = await startWith(new TypeError('Failed to fetch'));
  assert.equal(u.patch.state, 'unknown');
  assert.match(u.patch.error, /may have started anyway/);
  const m = mock(started());
  assert.equal(await S.advanceShot({ fetch: m.fetch, request: omniReq(), save: async () => {} }, { state: 'unknown' }), null);
  assert.equal(m.calls.length, 0, 'no second Omni start');
  const noId = await startWith(json(200, { seconds: 4 }));
  assert.equal(noId.patch.state, 'unknown', 'an answer without a video id can’t be followed: treat as maybe-started');
  for (const st of ['ready', 'failed', 'filtered', 'budget', 'expired', 'missing', 'starting']) {
    assert.equal(await S.advanceShot({ fetch: m.fetch, request: omniReq() }, { state: st }), null, st);
  }
  assert.equal(m.calls.length, 0);
});

test('advanceShot poll: queued/in_progress → filming; filtered → filtered (not billed); failed → failed; 404 omni_gone → expired', async () => {
  const poll = async (answer, s = {}) => {
    const m = mock(answer);
    return { patch: await S.advanceShot({ fetch: m.fetch, now: () => 1e12 }, { state: 'filming', op: OP, startedAt: 1e12 - 60_000, ...s }), calls: m.calls };
  };
  const run = await poll(status({ status: 'queued' }));
  assert.deepEqual(run.patch, { state: 'filming' });
  assert.deepEqual([run.calls[0].method, run.calls[0].url], ['GET', `/api/omni/status/${ID}`]);
  const filtered = await poll(status({ status: 'completed', done: true, video: false, filtered: true, error: 'Blocked by safety' }));
  assert.deepEqual(filtered.patch, { state: 'filtered', error: 'Blocked by safety', op: null });
  const err = await poll(status({ status: 'failed', done: true, error: 'Quota' }));
  assert.deepEqual(err.patch, { state: 'failed', error: 'Quota', op: null });
  const cancelled = await poll(status({ status: 'cancelled', done: true }));
  assert.equal(cancelled.patch.state, 'failed');
  const gone = await poll(json(404, { error: 'That Omni video is gone.', code: 'omni_gone' }));
  assert.deepEqual([gone.patch.state, gone.patch.op], ['expired', null]);
  const blip = await poll(new TypeError('offline'));
  assert.equal(blip.patch, null, 'a poll that doesn’t get through changes nothing');
  for (const st of [429, 500, 503]) assert.equal((await poll(json(st, { error: 'busy', code: 'omni_busy' }))).patch, null, `${st} is transient`);
  const old = await poll(status(), { startedAt: 1e12 - 48 * 3_600_000 });
  assert.equal(old.patch.state, 'expired');
  assert.equal(old.calls.length, 0, 'past 47 h nothing is asked');
});

test('advanceShot: completed with a video downloads it once and stores it — ready, with the filmed content key', async () => {
  const m = mock(completed(), mp4(1234));
  const stored = [];
  const patch = await S.advanceShot({ fetch: m.fetch, putBlob: async (b) => { stored.push(b); return { blobKey: 'rx:shot:e1:s1', bytes: b.size }; } }, { state: 'filming', op: OP, startedAt: Date.now(), contentKey: 'abcd1234' });
  assert.deepEqual(patch, { state: 'ready', uri: null, error: null, filmedKey: 'abcd1234', blobKey: 'rx:shot:e1:s1', bytes: 1234 });
  assert.deepEqual(m.calls.map((c) => c.url), [`/api/omni/status/${ID}`, `/api/omni/video/${ID}`]);
  assert.equal(stored[0].type, 'video/mp4');
  // a dropped download keeps the shot (it is paid for) and tries again; after 3 drops it asks for a tap
  const drop = mock(new TypeError('reset'));
  const again = await S.advanceShot({ fetch: drop.fetch }, { state: 'downloading', op: OP, uri: OP, tries: 0 });
  assert.deepEqual(again, { state: 'downloading', tries: 1, uri: OP });
  const drop3 = mock(new TypeError('reset'));
  const stop = await S.advanceShot({ fetch: drop3.fetch }, { state: 'downloading', op: OP, uri: OP, tries: 2 });
  assert.equal(stop.state, 'failed');
  assert.match(stop.error, /won’t film again/);
  const gone = await S.advanceShot({ fetch: mock(json(404, { error: 'gone', code: 'omni_gone' })).fetch }, { state: 'downloading', op: OP, uri: OP });
  assert.equal(gone.state, 'expired');
});

test('advanceShot download: 409 omni_not_ready is transient — it waits (more patiently than a drop) and then downloads', async () => {
  const notReady = () => json(409, { error: 'Google is still preparing the video.', code: 'omni_not_ready' });
  let s = { state: 'filming', op: OP, startedAt: Date.now(), contentKey: 'k' };
  const first = await S.advanceShot({ fetch: mock(completed(), notReady()).fetch }, s);
  assert.deepEqual(first, { state: 'downloading', tries: 1, uri: OP });
  s = { ...s, ...first };
  for (let i = 2; i < S.SHOT_TIMING.notReadyTries; i++) {
    const p = await S.advanceShot({ fetch: mock(notReady()).fetch }, s);
    assert.deepEqual([p.state, p.tries], ['downloading', i], `409 #${i} keeps waiting`);
    s = { ...s, ...p };
  }
  const m = mock(mp4(77));
  const done = await S.advanceShot({ fetch: m.fetch }, s);
  assert.deepEqual([done.state, done.bytes], ['ready', 77]);
  assert.equal(m.calls[0].url, `/api/omni/video/${ID}`, 'only the download is retried — never a new start');
});

test('pre-Omni: a shot on a Veo operation can’t be followed — it ends expired without a request', async () => {
  const m = mock();
  for (const state of ['filming', 'downloading']) {
    const p = await S.advanceShot({ fetch: m.fetch, now: () => 1e12 }, { state, op: VEO_OP, uri: 'https://generativelanguage.googleapis.com/v1beta/files/x:download', startedAt: 1e12 - 60_000 });
    assert.deepEqual([p.state, p.op, p.uri], ['expired', null, null], state);
    assert.match(p.error, /retired Veo 3\.1/);
  }
  assert.equal(m.calls.length, 0);
  assert.deepEqual(await S.pollShot({}, VEO_OP), { done: true, gone: true, retired: true });
  assert.equal(R.resumeOf({ state: 'failed', op: VEO_OP }), null, 'a failed Veo collect refilms (with Omni) instead');
});

test('classify: the state table', () => {
  const now = 5000;
  assert.equal(S.classify(new S.ShotError('transient', 'x'), now), null);
  assert.equal(S.classify(new DOMException('Aborted', 'AbortError')), null);
  assert.deepEqual(S.classify(new S.ShotError('definitive', 'busy', { status: 429 }), now).state, 'queued');
  assert.deepEqual(S.classify(new S.ShotError('definitive', 'cap', { status: 402, code: 'runway_credits' }), now).state, 'failed', 'Runway out of credits is not a tester budget');
  assert.deepEqual(S.classify({ done: true, uri: OP }), { state: 'downloading', uri: OP });
  assert.deepEqual(S.classify({ done: false, progress: 0.5 }), { state: 'filming', progress: 0.5 });
  assert.equal(S.pollDelay(0, 60_000), 5000);
  assert.equal(S.pollDelay(0, 200_000), 10_000);
});

test('shotRequest: Runway Gen-4 takes the ratio nearest the cut (832:1104 for 4:5) from a first frame, else vertical text → video', () => {
  const i2v = S.shotRequest({ prompt: 'p', camera: 'static', seconds: 5 }, { model: 'runway:gen4.5', seconds: 5, image: JPEG, out: { w: 1080, h: 1350 } });
  assert.deepEqual([i2v.provider, i2v.runway.kind, i2v.runway.body.ratio, i2v.runway.body.duration, i2v.runway.body.model], ['runway', 'image_to_video', '832:1104', 5, 'gen4.5']);
  assert.deepEqual(S.firstFrameShape('runway:gen4.5', { w: 1080, h: 1350 }), { w: 832, h: 1104 });
  const t2v = S.shotRequest({ prompt: 'p', camera: 'static', seconds: 4 }, { model: 'runway:gen4.5', seconds: 4, out: { w: 1080, h: 1350 } });
  assert.deepEqual([t2v.runway.kind, t2v.runway.body.ratio], ['text_to_video', '720:1280']);
  assert.throws(() => S.shotRequest({ prompt: 'p', seconds: 4 }, { model: 'runway:gen4_turbo', seconds: 4 }), /animates a still/);
});

test('Veo 3.1 on Runway: owner-only alternatives that take Veo’s own 16:9 / 9:16 frames', () => {
  for (const id of ['runway:veo3.1', 'runway:veo3.1_fast']) {
    const m = R.shotModel(id);
    assert.deepEqual([m.provider, m.tester, [...m.seconds]], ['runway', false, [4, 6, 8]], id);
    assert.equal(S.providerOf(id), 'runway');
    assert.deepEqual(S.firstFrameShape(id, { w: 1080, h: 1350 }), { w: 720, h: 1280 });
    assert.deepEqual(S.firstFrameShape(id, { w: 1920, h: 1080 }), { w: 1280, h: 720 });
  }
});

test('Veo 3.1 on Runway: the request goes to Runway with model veo3.1 (once runway.js knows the model)', { skip: !RUNWAY_MODELS['veo3.1'] && 'runway.js has no veo3.1 yet' }, () => {
  const r = S.shotRequest({ prompt: 'p', camera: 'static', seconds: 6 }, { model: 'runway:veo3.1', seconds: 6, image: JPEG, out: { w: 1080, h: 1350 } });
  assert.deepEqual([r.provider, r.runway.body.model, r.runway.body.ratio], ['runway', 'veo3.1', '720:1280']);
});

test('Grok Imagine on Runway: a 16:9 / 9:16 frame as is; a still → auto_720p (Lite) or a resolution (1.5), text → its own ratio', async () => {
  const W = await import('../src/runway.js');
  for (const id of ['runway:grok_imagine_1_5_lite', 'runway:grok_imagine_1_5']) {
    assert.deepEqual(S.firstFrameShape(id, { w: 1080, h: 1350 }), { w: 720, h: 1280 }, id);
    const still = S.shotRequest({ prompt: 'p', camera: 'static', seconds: 6 }, { model: id, seconds: 6, image: JPEG, out: { w: 1080, h: 1350 } });
    const text = S.shotRequest({ prompt: 'p', camera: 'static', seconds: 4 }, { model: id, seconds: 4, out: { w: 1080, h: 1350 } });
    assert.equal(still.runway.kind, 'image_to_video');
    assert.equal(text.runway.kind, 'text_to_video');
    if (id.endsWith('lite')) assert.deepEqual([still.runway.body.ratio, text.runway.body.ratio], ['auto_720p', '720:1280']);
    else assert.deepEqual([still.runway.body.ratio, still.runway.body.resolution, text.runway.body.ratio], [undefined, '720p', '9:16']);
    for (const r of [still, text]) assert.deepEqual(W.shapeRequest(r.runway.kind, r.runway.body).body, r.runway.body, 'the Worker sends it as built');
  }
});

test('Seedance 2.5 on Runway: a 16:9 / 9:16 frame as is; still or text, any whole length 4–10 s, sent as built', async () => {
  const W = await import('../src/runway.js');
  const id = 'runway:seedance2_5';
  assert.equal(S.providerOf(id), 'runway');
  assert.deepEqual(S.firstFrameShape(id, { w: 1080, h: 1350 }), { w: 720, h: 1280 });
  assert.deepEqual(S.firstFrameShape(id, { w: 1920, h: 1080 }), { w: 1280, h: 720 });
  const still = S.shotRequest({ prompt: 'p', camera: 'static', seconds: 5 }, { model: id, seconds: 5, image: JPEG, out: { w: 1080, h: 1350 } });
  const text = S.shotRequest({ prompt: 'p', camera: 'static', seconds: 7 }, { model: id, seconds: 7, out: { w: 1920, h: 1080 } });
  assert.deepEqual([still.runway.kind, still.runway.body.model, still.runway.body.ratio, still.runway.body.duration], ['image_to_video', 'seedance2_5', '720:1280', 5]);
  assert.deepEqual([text.runway.kind, text.runway.body.ratio, text.runway.body.duration], ['text_to_video', '1280:720', 7]);
  for (const r of [still, text]) assert.deepEqual(W.shapeRequest(r.runway.kind, r.runway.body).body, r.runway.body, 'the Worker sends it as built');
});

// ── Runway (owner only) through public/runway.js, so the mock stands in for the global fetch ──
test('runway: create → op "runway:<id>"; a dropped create is unknown; FAILED by safety is filtered; SUCCEEDED downloads', async () => {
  const req = S.shotRequest({ prompt: 'p', camera: 'static', seconds: 5 }, { model: 'runway:gen4.5', seconds: 5, image: JPEG, out: { w: 1080, h: 1350 } });
  let m = mock(json(200, { id: TASK, estimatedCost: { credits: 60 } }));
  globalThis.fetch = m.fetch;
  const started = await S.advanceShot({ request: req, now: () => 1, save: async () => {} }, { state: 'idle' });
  assert.deepEqual([started.state, started.op], ['filming', `runway:${TASK}`]);
  assert.equal(m.calls[0].url, '/api/runway/generate/image_to_video');
  assert.ok(R.isShotOp(started.op));

  globalThis.fetch = mock(new TypeError('Failed to fetch')).fetch;
  const lost = await S.advanceShot({ request: req, save: async () => {} }, { state: 'idle' });
  assert.equal(lost.state, 'unknown');

  globalThis.fetch = mock(json(429, { error: 'Runway is limiting this account right now', code: 'runway_limit' })).fetch;
  assert.equal((await S.advanceShot({ request: req, save: async () => {} }, { state: 'idle' })).state, 'queued');

  globalThis.fetch = mock(json(200, { id: TASK, status: 'FAILED', failureCode: 'SAFETY.INPUT.TEXT', cost: { credits: 60 } })).fetch;
  const f = await S.advanceShot({}, { state: 'filming', op: `runway:${TASK}`, startedAt: Date.now() });
  assert.equal(f.state, 'filtered');
  assert.match(f.error, /safety filter/);

  globalThis.fetch = mock(json(200, { id: TASK, status: 'RUNNING', progress: 0.4 })).fetch;
  assert.deepEqual(await S.advanceShot({}, { state: 'filming', op: `runway:${TASK}`, startedAt: Date.now() }), { state: 'filming', progress: 0.4 });

  m = mock(json(200, { id: TASK, status: 'SUCCEEDED' }), new Response(new Blob([new Uint8Array(900)], { type: 'video/mp4' }), { status: 200 }));
  globalThis.fetch = m.fetch;
  const done = await S.advanceShot({ putBlob: async (b) => ({ blobKey: 'rx:shot:e1:s1', bytes: b.size }) }, { state: 'filming', op: `runway:${TASK}`, startedAt: Date.now(), contentKey: 'k' });
  assert.deepEqual([done.state, done.bytes], ['ready', 900]);
  assert.equal(m.calls[1].url, `/api/runway/output/${TASK}?i=0`);
});

// ── adversarial review (v61, carried to Omni) ──
test('review: a start that a gateway answered (Atelier 502 “Upstream unreachable”, Cloudflare 504/52x, a non-JSON 5xx) is unknown — never a silent retry', async () => {
  const up = await startWith(json(502, { error: 'Upstream unreachable: connection reset' }));
  assert.equal(up.patch.state, 'unknown');
  const cf = await startWith(new Response('<html>Gateway time-out</html>', { status: 504, headers: { 'content-type': 'text/html' } }));
  assert.equal(cf.patch.state, 'unknown');
  const crash = await startWith(new Response('error code: 1101', { status: 500 }));
  assert.equal(crash.patch.state, 'unknown', 'a Worker exception after forwarding: the video may exist');
  const busy = await startWith(json(503, { error: 'Gemini Omni is unavailable right now.', code: 'omni_unavailable' }));
  assert.equal(busy.patch.state, 'failed', 'Atelier’s own JSON error (with a code) is definitive');
  assert.equal(S.ambiguous(502), true);
  assert.equal(S.ambiguous(500, true), false);
});

test('review: the first download dropping keeps the uri — the next tick downloads instead of sticking in "downloading"', async () => {
  const m = mock(completed(), new TypeError('reset'));
  const p = await S.advanceShot({ fetch: m.fetch }, { state: 'filming', op: OP, startedAt: Date.now() });
  assert.equal(p.state, 'downloading');
  assert.equal(p.uri, OP, 'saved with the patch, so a later tick (or a reload) can download it');
  const drop3 = mock(new TypeError('reset'));
  const stop = await S.advanceShot({ fetch: drop3.fetch }, { state: 'downloading', op: OP, uri: OP, tries: 2 });
  assert.equal(stop.uri, OP);
  assert.equal(R.resumeOf({ ...stop, op: OP }), 'downloading', 'Retry downloads again');
});

test('review: a generation the provider finished without a video drops its op (Retry films anew); a refused poll keeps it (Retry polls)', async () => {
  const poll = async (answer) => S.advanceShot({ fetch: mock(answer).fetch, now: () => 1e12 }, { state: 'filming', op: OP, startedAt: 1e12 - 60_000 });
  assert.equal((await poll(status({ status: 'failed', done: true, error: 'Quota' }))).op, null);
  assert.equal((await poll(status({ status: 'completed', done: true, filtered: true }))).op, null);
  const refused = await poll(json(401, { error: 'Wrong passcode' }));
  assert.equal(refused.state, 'failed');
  assert.equal('op' in refused, false);
  assert.equal(R.resumeOf({ ...refused, op: OP }), 'filming');
});
