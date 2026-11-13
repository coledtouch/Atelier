// v114 review, media: the Gemini Omni and Grok video runners (public/omni.js, public/xai.js). A clip is paid for when
// the provider makes it, not when it is downloaded. So every case here also checks the money side: nothing starts a
// second clip, a finished clip is never cancelled, and a download that was stopped or cut short keeps the clip for
// Try again (resumable, with its id). No provider is called: every request goes to a fake fetch.
// The other media fixes of this review are tested beside their modules: the clip upload's frozen wait in
// tests/video.test.mjs, dictation's kept recording in tests/dictate.test.mjs, the dropped Grok download in tests/xai.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { omniVideo, omniFetch, OMNI_TIMING } from '../public/omni.js';
import { xaiVideo, XAI_TIMING } from '../public/xai.js';

const reply = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const CLIP = [0, 0, 0, 24, 102, 116, 121, 112];
const mp4 = () => new Response(new Uint8Array(CLIP), { headers: { 'content-type': 'video/mp4' } });
// An answer whose body starts and never ends. As with a real fetch, aborting the request's signal errors the body.
const endless = (init, status = 200, type = 'video/mp4') => new Response(new ReadableStream({
  start(c) { c.enqueue(new Uint8Array([1, 2, 3])); init.signal.addEventListener('abort', () => c.error(new DOMException('Aborted', 'AbortError'))); },
}), { status, headers: { 'content-type': type } });
// A job's outcome, or 'pending' when it has not settled in time: a download that hangs must fail its test, not hang it.
function settled(job, ms = 1500) {
  let t;
  return Promise.race([job.then((value) => ({ value }), (error) => ({ error })), new Promise((r) => { t = setTimeout(() => r('pending'), ms); })]).finally(() => clearTimeout(t));
}

const RUNNERS = [
  { name: 'Omni', run: omniVideo, T: OMNI_TIMING, body: { prompt: 'waves', seconds: 6 }, id: 'v1_c',
    start: '/api/omni/start', status: '/api/omni/status/v1_c', file: '/api/omni/video/v1_c', cancel: '/api/omni/cancel/v1_c',
    done: { id: 'v1_c', status: 'completed', done: true, video: true }, busy: { id: 'v1_c', status: 'in_progress', done: false },
    slow: 'omni_slow', notReady: 'omni_not_ready', dropped: 'The Omni video download dropped — tap Try again (it won’t make a new video).' },
  { name: 'Grok', run: xaiVideo, T: XAI_TIMING, body: { model: 'grok-imagine-video-1.5-lite', prompt: 'waves', seconds: 6 }, id: 'vid1',
    start: '/api/xai/video/start', status: '/api/xai/video/status/vid1', file: '/api/xai/video/file/vid1', cancel: null,
    done: { status: 'done', done: true, video: true, usd: 0.12 }, busy: { status: 'pending', done: false, progress: 40 },
    slow: 'xai_slow', notReady: 'xai_not_ready', dropped: 'The Grok video download dropped — tap Try again (it won’t make a new video).' },
];
// A fake Atelier for one runner: start answers with the id, status and file answer as told. seen: every request made.
function server(p, { status = () => reply(200, p.done), file = () => mp4() } = {}) {
  const seen = [];
  const f = async (url, init = {}) => {
    seen.push(`${init.method || 'GET'} ${url}`);
    if (url === p.start) return reply(200, { id: p.id, seconds: 6, quote: 0.12 });
    if (url === p.status) return status(init);
    if (url === p.file) return file(init);
    if (p.cancel && url === p.cancel) return reply(200, { ok: true });
    throw new Error(`unexpected request ${url}`);
  };
  return { f, seen, count: (path) => seen.filter((s) => s.endsWith(` ${path}`)).length };
}
const noWait = async () => {};

for (const p of RUNNERS) {
  // ── media #3: Stop was ignored during the download, and a stalled download never ended ──
  test(`${p.name}: Stop during the download ends it at once, cancels nothing, and Try again fetches the same clip`, async () => {
    const ctrl = new AbortController();
    const s = server(p, { file: (init) => { setTimeout(() => ctrl.abort(), 5); return endless(init); } });
    const ids = [], said = [];
    const out = await settled(p.run(p.body, { fetch: s.f, signal: ctrl.signal, sleep: noWait, onId: (id) => ids.push(id), onStatus: (t) => said.push(t) }));
    assert.notEqual(out, 'pending', 'Stop was ignored: the download is still running');
    const e = out.error;
    assert.equal(e?.name, 'AbortError');
    assert.equal(said.at(-1), 'Downloading');
    assert.equal(e.resumable, true, 'the clip is made and paid for: it stays the entry’s');
    assert.equal(e.id, p.id);
    assert.deepEqual(ids, [p.id]);
    assert.equal(s.count(p.start), 1);
    if (p.cancel) assert.equal(s.count(p.cancel), 0, 'a finished clip is never cancelled');
    // Try again resumes that id: one check, one download, no new (paid) start
    const again = server(p);
    const got = await p.run(p.body, { fetch: again.f, sleep: noWait, resume: e.id });
    assert.equal(got.id, p.id);
    assert.deepEqual([...new Uint8Array(await got.blob.arrayBuffer())], CLIP);
    assert.deepEqual(again.seen, [`GET ${p.status}`, `GET ${p.file}`]);
  });

  test(`${p.name}: a download that stalls ends at the download cap as a dropped download, still resumable`, async () => {
    const cap = p.T.download;
    p.T.download = 40;
    try {
      const s = server(p, { file: (init) => endless(init) });
      const out = await settled(p.run(p.body, { fetch: s.f, sleep: noWait }));
      assert.notEqual(out, 'pending', 'the stalled download never ended');
      const e = out.error;
      assert.notEqual(e.name, 'AbortError');
      assert.equal(e.message, p.dropped);
      assert.deepEqual([e.status, e.resumable, e.id], [0, true, p.id]);
      assert.equal(s.count(p.start), 1);
      if (p.cancel) assert.equal(s.count(p.cancel), 0);
    } finally { p.T.download = cap; }
    // a connection that drops part-way is the same dropped download (as before)
    const cut = () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); setTimeout(() => c.error(new TypeError('network error')), 2); } }), { headers: { 'content-type': 'video/mp4' } });
    const e = (await settled(p.run(p.body, { fetch: server(p, { file: cut }).f, sleep: noWait }))).error;
    assert.equal(e.message, p.dropped);
    assert.deepEqual([e.status, e.resumable, e.id], [0, true, p.id]);
  });

  test(`${p.name}: Stop while a refusal’s body is still arriving is a Stop, never that refusal`, async () => {
    const ctrl = new AbortController();
    // a 404 would mean "gone for good" (not resumable): a Stop must not be read as one
    const s = server(p, { file: (init) => { setTimeout(() => ctrl.abort(), 5); return endless(init, 404, 'application/json'); } });
    const out = await settled(p.run(p.body, { fetch: s.f, signal: ctrl.signal, sleep: noWait }));
    assert.notEqual(out, 'pending');
    assert.equal(out.error?.name, 'AbortError');
    assert.deepEqual([out.error.resumable, out.error.id], [true, p.id]);
    // a refusal that does arrive is read as before: not ready yet → it waits and asks again; gone → not resumable
    let n = 0;
    const waits = [];
    const late = server(p, { file: () => (++n < 3 ? reply(409, { error: 'not ready', code: p.notReady }) : mp4()) });
    const got = await p.run(p.body, { fetch: late.f, sleep: async (ms) => { waits.push(ms); } });
    assert.equal(got.blob.size, CLIP.length);
    assert.equal(late.count(p.file), 3);
    assert.equal(waits.length, 3, 'one wait before the status poll, two for the clip');
    const gone = await p.run(p.body, { fetch: server(p, { file: () => reply(404, { error: 'gone' }) }).f, sleep: noWait }).catch((x) => x);
    assert.deepEqual([gone.status, Boolean(gone.resumable), gone.id], [404, false, p.id]);
  });

  // ── media #4: after a frozen wait the runner said "still working after 20 minutes" without checking ──
  test(`${p.name}: a wait the phone froze past the 20 minutes is followed by one more check, and a finished clip comes back`, async () => {
    let clock = 0;
    const frozen = async () => { clock += 30 * 60_000; }; // the timer fired half an hour late: the app was in the background
    const s = server(p);
    const got = await p.run(p.body, { fetch: s.f, now: () => clock, sleep: frozen });
    assert.equal(got.id, p.id);
    assert.equal(got.blob.size, CLIP.length);
    assert.deepEqual(s.seen, [`POST ${p.start}`, `GET ${p.status}`, `GET ${p.file}`]);
    // the first check after waking fails (the connection isn't back yet): it is asked again, as any failed poll is
    clock = 0;
    let n = 0;
    const waking = server(p, { status: () => { if (++n === 1) throw new TypeError('Failed to fetch'); return reply(200, p.done); } });
    assert.equal((await p.run(p.body, { fetch: waking.f, now: () => clock, sleep: frozen })).id, p.id);
    assert.equal(waking.count(p.status), 2);
  });

  test(`${p.name}: a clip that is still not done after the 20 minutes says so once a poll has said it, and stays resumable`, async () => {
    let clock = 0;
    const s = server(p, { status: () => reply(200, p.busy) });
    const e = await p.run(p.body, { fetch: s.f, now: () => clock, sleep: async () => { clock += 30 * 60_000; } }).catch((x) => x);
    assert.deepEqual([e.status, e.code, e.resumable, e.id], [504, p.slow, true, p.id]);
    assert.match(e.message, /is still working on this after 20 minutes\. Tap Try again to keep waiting\. It won’t start a new video\.$/);
    assert.equal(s.count(p.status), 1, 'it asked before it gave up');
    if (p.cancel) assert.equal(s.count(p.cancel), 0, 'a slow clip is left to finish');
    // inside the 20 minutes it keeps polling
    clock = 0;
    let n = 0;
    const waits = [];
    const soon = server(p, { status: () => reply(200, ++n < 4 ? p.busy : p.done) });
    await p.run(p.body, { fetch: soon.f, now: () => clock, sleep: async (ms) => { waits.push(ms); clock += ms; } });
    assert.equal(soon.count(p.status), 4);
    assert.ok(waits.every((ms) => ms >= p.T.poll));
  });
}

test('omniFetch (Video Remix calls it too): Stop mid-clip is an AbortError; without Stop the clip arrives whole', async () => {
  const ctrl = new AbortController();
  const stopped = await settled(omniFetch({ fetch: async (url, init) => { setTimeout(() => ctrl.abort(), 5); return endless(init); }, signal: ctrl.signal }, 'v1_c'));
  assert.equal(stopped.error?.name, 'AbortError');
  const seen = [];
  const blob = await omniFetch({ fetch: async (url, init) => { seen.push(init.signal.aborted); return new Response(new Uint8Array(CLIP)); }, onResponse: (r) => seen.push(r.status) }, 'v1_c');
  assert.equal(blob.type, 'video/mp4', 'an untyped clip is stored as video/mp4');
  assert.equal(blob.size, CLIP.length);
  assert.deepEqual(seen, [false, 200]);
  await assert.rejects(omniFetch({ fetch: async () => new Response(new Uint8Array(0), { headers: { 'content-type': 'video/mp4' } }) }, 'v1_c'), (e) => e.status === 502 && e.resumable === true && /empty video/.test(e.message));
  await assert.rejects(omniFetch({ fetch: async () => reply(409, { error: 'The Omni video isn’t ready yet.', code: 'omni_not_ready' }) }, 'v1_c'), (e) => e.status === 409 && e.code === 'omni_not_ready' && e.message === 'The Omni video isn’t ready yet.');
  // no answer at all keeps send()'s own words (omniVideo marks it resumable)
  await assert.rejects(omniFetch({ fetch: async () => { throw new TypeError('Failed to fetch'); } }, 'v1_c'), (e) => e.status === 0 && e.message === 'Couldn’t reach Atelier — the connection dropped.');
});

// ── media #5 (the client half): "too large" on a status poll was retried as a passing error ──
test('Omni: a clip too large for the Worker fails on the first status poll, and Try again never starts another', async () => {
  const p = RUNNERS[0];
  const TOO_LARGE = { error: 'This video is too large to bring into Atelier — try 1080p or lower.', code: 'omni_too_large' };
  const waits = [];
  const s = server(p, { status: () => reply(502, TOO_LARGE) });
  const e = await omniVideo(p.body, { fetch: s.f, sleep: async (ms) => { waits.push(ms); } }).catch((x) => x);
  assert.deepEqual([e.status, e.code, e.message], [502, 'omni_too_large', TOO_LARGE.error]);
  assert.equal(s.count(p.status), 1, 'asked once (it was nine times, about seven minutes of waiting)');
  assert.equal(waits.length, 1);
  assert.deepEqual([e.resumable, e.id], [true, p.id], 'the clip stays the entry’s: Try again checks on it');
  assert.equal(s.count(p.cancel), 0);
  // Try again: the same answer at once, and no new (paid) start
  const again = server(p, { status: () => reply(502, TOO_LARGE) });
  const e2 = await omniVideo(p.body, { fetch: again.f, sleep: noWait, resume: e.id }).catch((x) => x);
  assert.equal(e2.code, 'omni_too_large');
  assert.deepEqual(again.seen, [`GET ${p.status}`]);
  // any other 502 is still a passing error: asked again, then given up on as resumable
  const busy = server(p, { status: () => reply(502, { error: 'Google is unreachable right now — try again in a moment.', code: 'omni_unreachable' }) });
  const e3 = await omniVideo(p.body, { fetch: busy.f, sleep: noWait }).catch((x) => x);
  assert.equal(busy.count(p.status), OMNI_TIMING.failures + 1);
  assert.deepEqual([e3.status, e3.resumable, e3.id], [502, true, p.id]);
});
