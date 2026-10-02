import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// public/remix-shots.js — filming remix inserts with Veo (/api/x/gemini) and Runway (/api/runway/*), against mocked
// responses only. The money rule under test: only a definitive answer is ever retried by itself.
const S = await import('../public/remix-shots.js');
const R = await import('../public/remix.js');
const LITE = 'gemini:veo-3.1-lite-generate-preview';
const OP = 'models/veo-3.1-lite-generate-preview/operations/op123';
const TASK = '4a7b0c1d-2e3f-4a5b-8c6d-7e8f9a0b1c2d';
const URI = 'https://generativelanguage.googleapis.com/v1beta/files/abc123:download?alt=media';
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
const veoReq = () => S.shotRequest({ prompt: 'A walnut desk at dawn', camera: 'static', seconds: 4 }, { model: LITE, res: '720p', seconds: 4, look: 'dark', out: { w: 1080, h: 1350 } });

test('shotRequest: a Veo body like runVeo’s, vertical for a 4:5 cut, with the negative prompt and an optional first frame', () => {
  const r = veoReq();
  assert.equal(r.provider, 'veo');
  assert.equal(r.veo.path, 'gemini/v1beta/models/veo-3.1-lite-generate-preview:predictLongRunning');
  assert.deepEqual(r.veo.body.parameters, { aspectRatio: '9:16', resolution: '720p', durationSeconds: 4, negativePrompt: R.SHOT_NEGATIVE });
  assert.match(r.veo.body.instances[0].prompt, /^Locked-off static camera\. A walnut desk at dawn Look: dark Vertical frame/);
  assert.equal(r.veo.body.instances[0].image, undefined);
  const withFrame = S.shotRequest({ prompt: 'p', camera: 'push_in', seconds: 6 }, { model: LITE, seconds: 6, image: JPEG, out: { w: 1920, h: 1080 } });
  assert.deepEqual(withFrame.veo.body.instances[0].image.inlineData.mimeType, 'image/jpeg');
  assert.equal(withFrame.veo.body.parameters.aspectRatio, '16:9');
  assert.throws(() => S.shotRequest({ prompt: 'p' }, { model: 'openai:sora' }), /can’t film/);
});

test('shotRequest: Runway takes the ratio nearest the cut (832:1104 for 4:5) from a first frame, else vertical text → video', () => {
  const i2v = S.shotRequest({ prompt: 'p', camera: 'static', seconds: 5 }, { model: 'runway:gen4.5', seconds: 5, image: JPEG, out: { w: 1080, h: 1350 } });
  assert.deepEqual([i2v.provider, i2v.runway.kind, i2v.runway.body.ratio, i2v.runway.body.duration, i2v.runway.body.model], ['runway', 'image_to_video', '832:1104', 5, 'gen4.5']);
  assert.deepEqual(S.firstFrameShape('runway:gen4.5', { w: 1080, h: 1350 }), { w: 832, h: 1104 });
  assert.deepEqual(S.firstFrameShape(LITE, { w: 1080, h: 1350 }), { w: 720, h: 1280 });
  const t2v = S.shotRequest({ prompt: 'p', camera: 'static', seconds: 4 }, { model: 'runway:gen4.5', seconds: 4, out: { w: 1080, h: 1350 } });
  assert.deepEqual([t2v.runway.kind, t2v.runway.body.ratio], ['text_to_video', '720:1280']);
  assert.throws(() => S.shotRequest({ prompt: 'p', seconds: 4 }, { model: 'runway:gen4_turbo', seconds: 4 }), /animates a still/);
});

test('veoStart: an operation comes back; the request goes to the proxy as JSON with the app headers', async () => {
  const m = mock(json(200, { name: OP }));
  const r = await S.veoStart({ fetch: m.fetch, apiHeaders: () => ({ 'x-atelier-key': 'k' }) }, veoReq().veo);
  assert.deepEqual(r, { op: OP });
  assert.equal(m.calls[0].url, '/api/x/gemini/v1beta/models/veo-3.1-lite-generate-preview:predictLongRunning');
  assert.equal(m.calls[0].method, 'POST');
  assert.equal(m.calls[0].headers.get('content-type'), 'application/json');
  assert.equal(m.calls[0].headers.get('x-atelier-key'), 'k');
});

const startWith = async (answer, s = { state: 'idle' }, now = 1_000_000) => {
  const m = mock(answer), saved = [];
  const patch = await S.advanceShot({ fetch: m.fetch, request: veoReq(), now: () => now, save: async (p) => { saved.push({ ...p, calls: m.calls.length }); } }, s);
  return { patch, saved, calls: m.calls };
};

test('advanceShot start: "starting" is saved before the POST; an op means filming', async () => {
  const { patch, saved, calls } = await startWith(json(200, { name: OP }));
  assert.deepEqual(saved, [{ state: 'starting', startedAt: 1_000_000, calls: 0 }], 'saved while nothing had been sent');
  assert.deepEqual(patch, { state: 'filming', op: OP, startedAt: 1_000_000, error: null });
  assert.equal(calls.length, 1);
});

test('advanceShot start: 429 → queued (not billed, retried in 30 s); tester 402 → budget with resetsAt; 500 with a body → failed', async () => {
  const q = await startWith(json(429, { error: { message: 'Resource exhausted' } }));
  assert.deepEqual([q.patch.state, q.patch.retryAt, q.patch.queuedSince], ['queued', 1_030_000, 1_000_000]);
  const later = await startWith(json(429, { error: { message: 'busy' } }, { 'retry-after': '90' }), { state: 'queued', retryAt: 0, queuedSince: 990_000 });
  assert.deepEqual([later.patch.retryAt, later.patch.queuedSince], [1_090_000, 990_000]);
  const gaveUp = await startWith(json(200, { name: OP }), { state: 'queued', retryAt: 0, queuedSince: 1_000_000 - 11 * 60_000 });
  assert.equal(gaveUp.patch.state, 'failed');
  assert.equal(gaveUp.calls.length, 0, 'ten minutes of 429s: stop without another POST');
  const resetsAt = Date.UTC(2026, 9, 3);
  const b = await startWith(json(402, { error: 'You’ve used today’s allowance.', code: 'tester_budget', scope: 'day', resetsAt }));
  assert.deepEqual([b.patch.state, b.patch.resetsAt, b.patch.error], ['budget', resetsAt, 'You’ve used today’s allowance.']);
  const f = await startWith(json(500, { error: { message: 'Internal error' } }));
  assert.deepEqual([f.patch.state, f.patch.error], ['failed', 'Internal error']);
  const notQueued = await startWith(json(200, { name: OP }), { state: 'queued', retryAt: 2_000_000 });
  assert.equal(notQueued.patch, null, 'a queued shot waits for its retry time');
});

test('advanceShot start: a throw after sending is "unknown" — and an unknown shot is never sent again by itself', async () => {
  const u = await startWith(new TypeError('Failed to fetch'));
  assert.equal(u.patch.state, 'unknown');
  assert.match(u.patch.error, /may have started anyway/);
  const m = mock(json(200, { name: OP }));
  assert.equal(await S.advanceShot({ fetch: m.fetch, request: veoReq(), save: async () => {} }, { state: 'unknown' }), null);
  assert.equal(m.calls.length, 0, 'no second predictLongRunning');
  const noOp = await startWith(json(200, { done: false }));
  assert.equal(noOp.patch.state, 'unknown', 'an answer without an operation can’t be followed: treat as maybe-started');
  for (const st of ['ready', 'failed', 'filtered', 'budget', 'expired', 'missing', 'starting']) {
    assert.equal(await S.advanceShot({ fetch: m.fetch, request: veoReq() }, { state: st }), null, st);
  }
  assert.equal(m.calls.length, 0);
});

test('advanceShot poll: running → filming; done without a video → filtered (not billed); error → failed; gone → expired', async () => {
  const poll = async (answer, s = {}) => {
    const m = mock(answer);
    return { patch: await S.advanceShot({ fetch: m.fetch, now: () => 1e12 }, { state: 'filming', op: OP, startedAt: 1e12 - 60_000, ...s }), calls: m.calls };
  };
  const run = await poll(json(200, { name: OP, done: false }));
  assert.deepEqual(run.patch, { state: 'filming' });
  assert.equal(run.calls[0].url, `/api/x/gemini/v1beta/${OP}`);
  const filtered = await poll(json(200, { done: true, response: { generateVideoResponse: { raiMediaFilteredReasons: ['Blocked by safety'] } } }));
  assert.deepEqual(filtered.patch, { state: 'filtered', error: 'Blocked by safety', op: null });
  const err = await poll(json(200, { done: true, error: { message: 'Quota' } }));
  assert.deepEqual(err.patch, { state: 'failed', error: 'Quota', op: null });
  const gone = await poll(json(404, { error: { message: 'not found' } }));
  assert.equal(gone.patch.state, 'expired');
  const blip = await poll(new TypeError('offline'));
  assert.equal(blip.patch, null, 'a poll that doesn’t get through changes nothing');
  const busy = await poll(json(503, { error: { message: 'busy' } }));
  assert.equal(busy.patch, null);
  const old = await poll(json(200, { done: false }), { startedAt: 1e12 - 48 * 3_600_000 });
  assert.equal(old.patch.state, 'expired');
  assert.equal(old.calls.length, 0, 'past 47 h nothing is asked');
});

test('advanceShot: done with a video downloads it once and stores it — ready, with the filmed content key', async () => {
  const m = mock(json(200, { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: URI } }] } } }), new Response(new Blob([new Uint8Array(1234)]), { status: 200 }));
  const stored = [];
  const patch = await S.advanceShot({ fetch: m.fetch, putBlob: async (b) => { stored.push(b); return { blobKey: 'rx:shot:e1:s1', bytes: b.size }; } }, { state: 'filming', op: OP, startedAt: Date.now(), contentKey: 'abcd1234' });
  assert.deepEqual(patch, { state: 'ready', uri: null, error: null, filmedKey: 'abcd1234', blobKey: 'rx:shot:e1:s1', bytes: 1234 });
  assert.equal(m.calls[1].url, '/api/x/gemini/v1beta/files/abc123:download?alt=media');
  assert.equal(stored[0].type, 'video/mp4');
  // a dropped download keeps the shot (it is paid for) and tries again; after 3 drops it asks for a tap
  const drop = mock(new TypeError('reset'));
  const again = await S.advanceShot({ fetch: drop.fetch }, { state: 'downloading', op: OP, uri: URI, tries: 0 });
  assert.deepEqual(again, { state: 'downloading', tries: 1, uri: URI });
  const drop3 = mock(new TypeError('reset'));
  const stop = await S.advanceShot({ fetch: drop3.fetch }, { state: 'downloading', op: OP, uri: URI, tries: 2 });
  assert.equal(stop.state, 'failed');
  assert.match(stop.error, /won’t film again/);
});

test('classify: the state table', () => {
  const now = 5000;
  assert.equal(S.classify(new S.ShotError('transient', 'x'), now), null);
  assert.equal(S.classify(new DOMException('Aborted', 'AbortError')), null);
  assert.deepEqual(S.classify(new S.ShotError('definitive', 'busy', { status: 429 }), now).state, 'queued');
  assert.deepEqual(S.classify(new S.ShotError('definitive', 'cap', { status: 402, code: 'runway_credits' }), now).state, 'failed', 'Runway out of credits is not a tester budget');
  assert.deepEqual(S.classify({ done: true, uri: URI }), { state: 'downloading', uri: URI });
  assert.deepEqual(S.classify({ done: false, progress: 0.5 }), { state: 'filming', progress: 0.5 });
  assert.equal(S.pollDelay(0, 60_000), 5000);
  assert.equal(S.pollDelay(0, 200_000), 10_000);
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

// ── adversarial review (v61) ──
test('review: a start that a gateway answered (Atelier 502 “Upstream unreachable”, Cloudflare 504/52x, a non-JSON 5xx) is unknown — never a silent retry', async () => {
  const up = await startWith(json(502, { error: 'Upstream unreachable: connection reset' }));
  assert.equal(up.patch.state, 'unknown');
  const cf = await startWith(new Response('<html>Gateway time-out</html>', { status: 504, headers: { 'content-type': 'text/html' } }));
  assert.equal(cf.patch.state, 'unknown');
  const crash = await startWith(new Response('error code: 1101', { status: 500 }));
  assert.equal(crash.patch.state, 'unknown', 'a Worker exception after forwarding: the operation may exist');
  const busy = await startWith(json(503, { error: { message: 'The model is overloaded' } }));
  assert.equal(busy.patch.state, 'failed', 'the provider’s own JSON error is definitive');
  assert.equal(S.ambiguous(502), true);
  assert.equal(S.ambiguous(500, true), false);
});

test('review: the first download dropping keeps the uri — the next tick downloads instead of sticking in "downloading"', async () => {
  const m = mock(json(200, { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: URI } }] } } }), new TypeError('reset'));
  const p = await S.advanceShot({ fetch: m.fetch }, { state: 'filming', op: OP, startedAt: Date.now() });
  assert.equal(p.state, 'downloading');
  assert.equal(p.uri, URI, 'saved with the patch, so a later tick (or a reload) can download it');
  const drop3 = mock(new TypeError('reset'));
  const stop = await S.advanceShot({ fetch: drop3.fetch }, { state: 'downloading', op: OP, uri: URI, tries: 2 });
  assert.equal(stop.uri, URI);
  assert.equal(R.resumeOf({ ...stop, op: OP }), 'downloading', 'Retry downloads again');
});

test('review: a generation the provider finished without a video drops its op (Retry films anew); a refused poll keeps it (Retry polls)', async () => {
  const poll = async (answer) => S.advanceShot({ fetch: mock(answer).fetch, now: () => 1e12 }, { state: 'filming', op: OP, startedAt: 1e12 - 60_000 });
  assert.equal((await poll(json(200, { done: true, error: { message: 'Quota' } }))).op, null);
  assert.equal((await poll(json(200, { done: true, response: { generateVideoResponse: { raiMediaFilteredReasons: ['x'] } } }))).op, null);
  const refused = await poll(json(401, { error: 'Wrong passcode' }));
  assert.equal(refused.state, 'failed');
  assert.equal('op' in refused, false);
  assert.equal(R.resumeOf({ ...refused, op: OP }), 'filming');
});
