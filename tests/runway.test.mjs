import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';

// src/tester/router.js (and worker.js) import `cloudflare:workers`; stub it before importing them.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export class DurableObject {} export const waitUntil = () => {};', shortCircuit: true };
    return next(specifier, context);
  },
});

// src/runway.js — the owner's /api/runway/* routes. Runway is never called for real: every upstream request goes to a
// fetch mock, and an unmatched one fails the test.
const {
  handleRunway, runwayDiag, shapeRequest, cleanTask, quote, scrub, outputUrlOk, RunwayError, grokLiteResolution, seedanceResolution,
  RUNWAY_BASE, RUNWAY_VERSION, RUNWAY_MODELS, BODY_MAX, DATA_URI_MAX, UPLOAD_MAX, OUTPUT_MAX, PROMPT_MAX,
} = await import('../src/runway.js');

const KEY = `key_${'ab12'.repeat(32)}`;
const ID = '4a7b0c1d-2e3f-4a5b-8c6d-7e8f9a0b1c2d';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.secret-signature';
const CDN = `https://dnznrvs05pmza.cloudfront.net/videos/${ID}.mp4?_jwt=${JWT}`;
const PNG = `data:image/png;base64,${'iVBORw0KGgo'.padEnd(64, 'A')}`;
const RUNWAY_URI = 'runway://upload/abc123def456';

// ── fetch mock ──
let calls = [];
const realFetch = globalThis.fetch;
function mockFetch(routes) {
  calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const call = { url: String(input), method: init.method || 'GET', headers: new Headers(init.headers), body: init.body, init };
    if (typeof call.body === 'string') { try { call.json = JSON.parse(call.body); } catch {} }
    calls.push(call);
    for (const [pattern, handler] of routes) if (pattern.test(`${call.method} ${call.url}`)) return handler(call);
    throw new Error(`unmocked fetch ${call.method} ${call.url}`);
  };
}
const reply = (status, body, headers = {}) => new Response(body === undefined || status === 204 ? null : typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const up = (path) => new RegExp(`^(GET|POST|DELETE) ${RUNWAY_BASE.replace(/[.]/g, '\\.')}/${path}$`);

// The key and Runway's signed links must never reach a log or a response.
let logs = [];
const realWarn = console.warn, realError = console.error;
beforeEach(() => {
  calls = []; logs = [];
  console.warn = (...a) => logs.push(a.map(String).join(' '));
  console.error = (...a) => logs.push(a.map(String).join(' '));
});
afterEach(() => {
  globalThis.fetch = realFetch;
  console.warn = realWarn; console.error = realError;
  for (const l of logs) {
    assert.ok(!l.includes(KEY), `key leaked to the log: ${l}`);
    assert.ok(!l.includes(JWT), `signed link leaked to the log: ${l}`);
  }
});

// handleRunway on /api/<path>, as the Worker calls it after resolveKey.
function rw(path, { method = 'GET', body, headers = {}, env = {}, key = KEY } = {}) {
  const url = new URL(`https://atelier.test/api/${path}`);
  const h = { ...headers };
  let b = body;
  if (b !== undefined && typeof b !== 'string' && !(b instanceof Uint8Array) && !(b instanceof ReadableStream)) { b = JSON.stringify(b); h['content-type'] ??= 'application/json'; }
  if ((typeof b === 'string' || b instanceof Uint8Array) && h['content-length'] === undefined) h['content-length'] = String(typeof b === 'string' ? Buffer.byteLength(b) : b.byteLength);
  const req = new Request(url, { method, headers: h, body: b, ...(b instanceof ReadableStream ? { duplex: 'half' } : {}) });
  return handleRunway(req, env, url, url.pathname.replace(/^\/api\//, ''), { key }); // the Worker's path carries no query
}
const read = async (res) => {
  const t = await res.text();
  assert.ok(!t.includes(KEY), `key in response: ${t}`);
  assert.ok(!t.includes(JWT) && !/cloudfront/i.test(t), `signed link in response: ${t}`);
  try { return JSON.parse(t); } catch { return t; }
};
const created = (credits = 60) => [up('(text|image|video)_to_video'), () => reply(200, { id: ID, estimatedCost: { credits } })];
const t2v = (extra = {}) => ({ model: 'gen4.5', promptText: 'A paper boat on a neon street', ratio: '1280:720', duration: 4, ...extra });

// ── creating a task ──

test('every upstream call goes to api.dev.runwayml.com with the bearer key and X-Runway-Version', async () => {
  mockFetch([created(48), [up(`tasks/${ID}`), () => reply(200, { id: ID, status: 'PENDING', createdAt: '2026-09-30T12:00:00.000Z', estimatedCost: { credits: 48 } })],
    [up('organization'), () => reply(200, { creditBalance: 1000, tier: { maxMonthlyCreditSpend: 10000, models: {} } })]]);
  assert.equal((await rw('runway/generate/text_to_video', { method: 'POST', body: t2v() })).status, 200);
  assert.equal((await rw(`runway/task/${ID}`)).status, 200);
  assert.equal((await rw('runway/account')).status, 200);
  assert.equal(calls.length, 3);
  for (const c of calls) {
    assert.ok(c.url.startsWith('https://api.dev.runwayml.com/v1/'), c.url);
    assert.equal(c.headers.get('authorization'), `Bearer ${KEY}`);
    assert.equal(c.headers.get('x-runway-version'), RUNWAY_VERSION);
    assert.equal(c.init.redirect, 'manual', 'the key must not follow a redirect');
  }
  assert.equal(RUNWAY_VERSION, '2024-11-06');
});

test('generate: text → video sends exactly the whitelisted body and echoes the estimate and a quote', async () => {
  mockFetch([created(48)]);
  const res = await rw('runway/generate/text_to_video', { method: 'POST', body: t2v({ outputFormat: 'hdr_prores', callbackUrl: 'https://evil.example', promptImage: PNG, junk: 1 }) });
  const j = await read(res);
  assert.equal(res.status, 200);
  assert.deepEqual(j, { id: ID, model: 'gen4.5', kind: 'text_to_video', estimatedCost: { credits: 48, usd: 0.48 }, quote: { credits: 48, usd: 0.48 }, pollAfterMs: 5000 });
  assert.equal(calls[0].url, `${RUNWAY_BASE}/text_to_video`);
  assert.deepEqual(calls[0].json, { model: 'gen4.5', promptText: 'A paper boat on a neon street', ratio: '1280:720', duration: 4, outputFormat: 'mp4' });
});

test('generate: image → video for gen4.5 and gen4_turbo (no outputFormat on Turbo; default duration 5)', async () => {
  mockFetch([created()]);
  await rw('runway/generate/image_to_video', { method: 'POST', body: { model: 'gen4.5', promptText: 'slow push in', promptImage: PNG, ratio: '832:1104', duration: 6 } });
  await rw('runway/generate/image_to_video', { method: 'POST', body: { model: 'gen4_turbo', promptImage: PNG, ratio: '832:1104', outputFormat: 'prores' } });
  assert.deepEqual(calls[0].json, { model: 'gen4.5', promptText: 'slow push in', promptImage: PNG, ratio: '832:1104', duration: 6, outputFormat: 'mp4' });
  assert.deepEqual(calls[1].json, { model: 'gen4_turbo', promptImage: PNG, ratio: '832:1104', duration: 5 });
});

test('generate: Veo 3.1 and Veo 3.1 Fast (text and image → video): their four ratios, 4/6/8 s, audio, no outputFormat', async () => {
  mockFetch([created(240)]);
  const res = await rw('runway/generate/text_to_video', { method: 'POST', body: { model: 'veo3.1', promptText: 'A paper boat', ratio: '1920:1080', duration: 6, outputFormat: 'mp4', junk: 1 } });
  const j = await read(res);
  assert.equal(res.status, 200);
  assert.equal(calls[0].url, `${RUNWAY_BASE}/text_to_video`);
  assert.deepEqual(calls[0].json, { model: 'veo3.1', promptText: 'A paper boat', ratio: '1920:1080', duration: 6 });
  assert.deepEqual(j.quote, { credits: 240, usd: 2.4 }); // 40 credits a second with audio (Runway's default)
  await rw('runway/generate/image_to_video', { method: 'POST', body: { model: 'veo3.1_fast', promptText: 'slow push in', promptImage: PNG, ratio: '720:1280', duration: 8, audio: false } });
  assert.equal(calls[1].url, `${RUNWAY_BASE}/image_to_video`);
  assert.deepEqual(calls[1].json, { model: 'veo3.1_fast', promptText: 'slow push in', promptImage: PNG, ratio: '720:1280', duration: 8, audio: false });
  await rw('runway/generate/text_to_video', { method: 'POST', body: { model: 'veo3.1', promptText: 'x' } });
  assert.deepEqual(calls[2].json, { model: 'veo3.1', promptText: 'x', ratio: '1280:720', duration: 6 }, 'defaults: 16:9 720p, 6 s');
  assert.deepEqual(quote('veo3.1', 8), { credits: 320, usd: 3.2 });
  assert.deepEqual(quote('veo3.1', 8, false), { credits: 160, usd: 1.6 });
  assert.deepEqual(quote('veo3.1_fast', 4), { credits: 60, usd: 0.6 });
  assert.deepEqual(quote('veo3.1_fast', 4, false), { credits: 40, usd: 0.4 });
  assert.deepEqual([...RUNWAY_MODELS['veo3.1'].kinds.text_to_video], ['1280:720', '720:1280', '1080:1920', '1920:1080']);
});

test('generate: Grok Imagine 1.5 Lite (Runway 2026-10-01) — size ratios for text, auto_<res> for a still, 1–15 s, nothing else', async () => {
  mockFetch([created(18)]);
  // text → video: the OpenAPI schema's fields only (model, promptText, ratio, duration); no outputFormat, seed or audio
  const res = await rw('runway/generate/text_to_video', { method: 'POST', body: { model: 'grok_imagine_1_5_lite', promptText: 'A paper boat', ratio: '1280:720', duration: 6, outputFormat: 'mp4', seed: 7, audio: false, references: [{ uri: PNG }], junk: 1 } });
  const j = await read(res);
  assert.equal(res.status, 200);
  assert.equal(calls[0].url, `${RUNWAY_BASE}/text_to_video`);
  assert.deepEqual(calls[0].json, { model: 'grok_imagine_1_5_lite', promptText: 'A paper boat', ratio: '1280:720', duration: 6 });
  assert.deepEqual(j.quote, { credits: 18, usd: 0.18 }, '3 credits a second at 720p');
  // image → video: the still, auto_<res>, the prompt optional; +1 credit for the start frame
  await rw('runway/generate/image_to_video', { method: 'POST', body: { model: 'grok_imagine_1_5_lite', promptImage: PNG, ratio: 'auto_1080p', duration: 4 } });
  assert.equal(calls[1].url, `${RUNWAY_BASE}/image_to_video`);
  assert.deepEqual(calls[1].json, { model: 'grok_imagine_1_5_lite', promptImage: PNG, ratio: 'auto_1080p', duration: 4 });
  // defaults: 720p (1280:720 / auto_720p), 6 s
  await rw('runway/generate/text_to_video', { method: 'POST', body: { model: 'grok_imagine_1_5_lite', promptText: 'x' } });
  assert.deepEqual(calls[2].json, { model: 'grok_imagine_1_5_lite', promptText: 'x', ratio: '1280:720', duration: 6 });
  await rw('runway/generate/image_to_video', { method: 'POST', body: { model: 'grok_imagine_1_5_lite', promptImage: PNG } });
  assert.deepEqual(calls[3].json, { model: 'grok_imagine_1_5_lite', promptImage: PNG, ratio: 'auto_720p', duration: 6 });
  // price by resolution (Runway's pricing guide): 2 / 3 / 14 credits a second, +1 for a start frame
  assert.deepEqual(quote('grok_imagine_1_5_lite', 10, true, { resolution: '480p' }), { credits: 20, usd: 0.2 });
  assert.deepEqual(quote('grok_imagine_1_5_lite', 10, true, { resolution: '1080p', still: true }), { credits: 141, usd: 1.41 });
  assert.deepEqual(quote('grok_imagine_1_5_lite', 10), { credits: 30, usd: 0.3 }, 'no resolution: 720p');
  assert.deepEqual([grokLiteResolution('848:480'), grokLiteResolution('1088:720'), grokLiteResolution('1424:1424'), grokLiteResolution('auto_480p')], ['480p', '720p', '1080p', '480p']);
  assert.equal(RUNWAY_MODELS.grok_imagine_1_5_lite.kinds.text_to_video.length, 21);
});

test('generate: Grok Imagine 1.5 — aspect ratio and resolution for text, resolution only for a still, priced per resolution', async () => {
  mockFetch([created(160)]);
  await rw('runway/generate/text_to_video', { method: 'POST', body: { model: 'grok_imagine_1_5', promptText: 'A lighthouse', ratio: '9:16', resolution: '1080p', duration: 15, referenceAudio: [{ type: 'audio', uri: 'https://x.example/a.mp3' }] } });
  assert.deepEqual(calls[0].json, { model: 'grok_imagine_1_5', promptText: 'A lighthouse', ratio: '9:16', resolution: '1080p', duration: 15 });
  const r = await rw('runway/generate/image_to_video', { method: 'POST', body: { model: 'grok_imagine_1_5', promptImage: PNG, resolution: '720p', duration: 6 } });
  assert.deepEqual(calls[1].json, { model: 'grok_imagine_1_5', promptImage: PNG, resolution: '720p', duration: 6 });
  assert.deepEqual((await read(r)).quote, { credits: 97, usd: 0.97 }, '16 credits a second at 720p + 1 for the start frame');
  await rw('runway/generate/text_to_video', { method: 'POST', body: { model: 'grok_imagine_1_5', promptText: 'x' } });
  assert.deepEqual(calls[2].json, { model: 'grok_imagine_1_5', promptText: 'x', ratio: '16:9', resolution: '720p', duration: 6 }, 'defaults: 16:9, 720p, 6 s');
  assert.deepEqual(quote('grok_imagine_1_5', 4, true, { resolution: '480p' }), { credits: 40, usd: 0.4 });
  assert.deepEqual(quote('grok_imagine_1_5', 4, true, { resolution: '1080p' }), { credits: 116, usd: 1.16 });
});

test('generate: Seedance 2.5 (Runway 2026-08-07) — the schema’s fields only, the ratio sets the tier, 4–30 s, priced per tier', async () => {
  mockFetch([created(180)]);
  // text → video: model, promptText, ratio, duration, audio, seed; no outputFormat, moderation, resolution, draft or references
  const res = await rw('runway/generate/text_to_video', { method: 'POST', body: { model: 'seedance2_5', promptText: 'A paper boat', ratio: '1280:720', duration: 6, audio: true, seed: 7,
    outputFormat: 'mp4', contentModeration: { publicFigureThreshold: 'low' }, draft: true, references: [{ uri: PNG }], referenceVideos: [{ type: 'video', uri: RUNWAY_URI }], referenceAudio: [{ type: 'audio', uri: 'https://x.example/a.mp3' }], junk: 1 } });
  const j = await read(res);
  assert.equal(res.status, 200);
  assert.equal(calls[0].url, `${RUNWAY_BASE}/text_to_video`);
  assert.equal(calls[0].headers.get('x-runway-version'), RUNWAY_VERSION);
  assert.deepEqual(calls[0].json, { model: 'seedance2_5', promptText: 'A paper boat', ratio: '1280:720', duration: 6, audio: true, seed: 7 });
  assert.deepEqual(j.quote, { credits: 180, usd: 1.8 }, '30 credits a second at 720p');
  // image → video: the still, the prompt optional, 1080p portrait, 30 s
  const r2 = await rw('runway/generate/image_to_video', { method: 'POST', body: { model: 'seedance2_5', promptImage: PNG, ratio: '1080:1920', duration: 30, audio: false } });
  assert.equal(calls[1].url, `${RUNWAY_BASE}/image_to_video`);
  assert.deepEqual(calls[1].json, { model: 'seedance2_5', promptImage: PNG, ratio: '1080:1920', duration: 30, audio: false });
  assert.deepEqual((await read(r2)).quote, { credits: 2040, usd: 20.4 }, '68 credits a second at 1080p; no audio discount');
  // defaults: 1280:720, 6 s, Runway's own audio default (not sent)
  await rw('runway/generate/text_to_video', { method: 'POST', body: { model: 'seedance2_5', promptText: 'x' } });
  assert.deepEqual(calls[2].json, { model: 'seedance2_5', promptText: 'x', ratio: '1280:720', duration: 6 });
  // a 15,000-character prompt goes as is
  await rw('runway/generate/text_to_video', { method: 'POST', body: { model: 'seedance2_5', promptText: 'y'.repeat(15000), duration: 4 } });
  assert.equal(calls[3].json.promptText.length, 15000);
  // price by tier (pricing guide): 20 / 30 / 68 credits a second, at least 80 a generation, audio free
  assert.deepEqual(quote('seedance2_5', 4, true, { resolution: '480p' }), { credits: 80, usd: 0.8 });
  assert.deepEqual(quote('seedance2_5', 10, false, { resolution: '480p' }), { credits: 200, usd: 2 });
  assert.deepEqual(quote('seedance2_5', 10, true, { resolution: '720p' }), { credits: 300, usd: 3 });
  assert.deepEqual(quote('seedance2_5', 10, true, { resolution: '1080p' }), { credits: 680, usd: 6.8 });
  assert.deepEqual(quote('seedance2_5', 10), { credits: 300, usd: 3 }, 'no resolution: 720p');
  assert.equal(RUNWAY_MODELS.seedance2_5.minCredits, 80);
  // the 18 schema ratios, six per tier
  const tiers = RUNWAY_MODELS.seedance2_5.kinds.text_to_video.map(seedanceResolution);
  assert.deepEqual(tiers, [...Array(6).fill('480p'), ...Array(6).fill('720p'), ...Array(6).fill('1080p')]);
  assert.deepEqual([...RUNWAY_MODELS.seedance2_5.kinds.image_to_video], [...RUNWAY_MODELS.seedance2_5.kinds.text_to_video]);
  assert.deepEqual([seedanceResolution('640:640'), seedanceResolution('960:960'), seedanceResolution('1440:1440'), seedanceResolution('16:9')], ['480p', '720p', '1080p', null]);
});

test('generate: aleph2 edits only runway:// clips, drops the deprecated ratio and shapes keyframes', async () => {
  mockFetch([created(56)]);
  const res = await rw('runway/generate/video_to_video', { method: 'POST', body: {
    model: 'aleph2', promptText: 'make it a watercolor painting', videoUri: RUNWAY_URI, ratio: '1280:720', duration: 5, seconds: 1.5,
    targetAspectRatio: '3:4', keyframes: [{ uri: PNG, seconds: 0, extra: true }, { uri: RUNWAY_URI, at: 0.5 }], seed: 7, contentModeration: { publicFigureThreshold: 'low' },
  } });
  assert.equal(res.status, 200);
  assert.deepEqual((await read(res)).quote, { credits: 56, usd: 0.56 });
  assert.deepEqual(calls[0].json, {
    model: 'aleph2', promptText: 'make it a watercolor painting', videoUri: RUNWAY_URI,
    keyframes: [{ uri: PNG, seconds: 0 }, { uri: RUNWAY_URI, at: 0.5 }], targetAspectRatio: '3:4', seed: 7,
    contentModeration: { publicFigureThreshold: 'low' }, outputFormat: 'mp4',
  });
});

test('generate refuses bad input with 400 and never calls Runway', async () => {
  mockFetch([[/./, () => reply(500, { error: 'must not be called' })]]);
  const cases = [
    ['text_to_video', { ...t2v(), model: 'seedance2' }, /doesn’t offer the Runway model “seedance2”/],
    ['text_to_video', { ...t2v(), model: 'veo3' }, /doesn’t offer/],
    ['text_to_video', { model: 'veo3.1', promptText: 'x', duration: 5 }, /veo3\.1 clips are 4, 6, 8 seconds/],
    ['text_to_video', { model: 'veo3.1_fast', promptText: 'x', ratio: '960:960' }, /takes the ratios 1280:720, 720:1280, 1080:1920, 1920:1080/],
    ['text_to_video', { model: 'veo3.1', promptText: 'x', audio: 'yes' }, /audio must be true or false/],
    ['text_to_video', { model: 'veo3.1' }, /Describe the video/],
    ['video_to_video', { model: 'veo3.1', promptText: 'x', videoUri: RUNWAY_URI }, /can’t do video to video/],
    ['text_to_video', { model: 'grok_imagine_1_5_lite', promptText: 'x', duration: 16 }, /grok_imagine_1_5_lite clips are 1–15 whole seconds/],
    ['text_to_video', { model: 'grok_imagine_1_5_lite', promptText: 'x', duration: 0 }, /1–15 whole seconds/],
    ['text_to_video', { model: 'grok_imagine_1_5_lite', promptText: 'x', ratio: '16:9' }, /takes the ratios 848:480/],
    ['text_to_video', { model: 'grok_imagine_1_5_lite', promptText: 'x', resolution: '720p' }, /takes no resolution field/],
    ['image_to_video', { model: 'grok_imagine_1_5_lite', promptImage: PNG, ratio: '1280:720' }, /takes the ratios auto_480p, auto_720p, auto_1080p/],
    ['text_to_video', { model: 'grok_imagine_1_5_lite' }, /Describe the video/],
    ['text_to_video', { model: 'grok_imagine_1_5', promptText: 'x', resolution: '4k' }, /takes the resolutions 480p, 720p, 1080p/],
    ['text_to_video', { model: 'grok_imagine_1_5', promptText: 'x', ratio: '1280:720' }, /takes the ratios 1:1, 16:9/],
    ['image_to_video', { model: 'grok_imagine_1_5', promptImage: PNG, ratio: '16:9' }, /takes no ratio for image to video/],
    ['text_to_video', { model: 'grok_imagine_1_5', promptText: 'x'.repeat(2501) }, /limited to 2500 characters/],
    ['video_to_video', { model: 'grok_imagine_1_5', promptText: 'x', videoUri: RUNWAY_URI }, /can’t do video to video/],
    ['text_to_video', { model: 'seedance2_5', promptText: 'x', duration: 31 }, /seedance2_5 clips are 4–30 whole seconds/],
    ['text_to_video', { model: 'seedance2_5', promptText: 'x', duration: 3 }, /4–30 whole seconds/],
    ['text_to_video', { model: 'seedance2_5', promptText: 'x', duration: 'auto' }, /4–30 whole seconds/],
    ['text_to_video', { model: 'seedance2_5', promptText: 'x', ratio: '16:9' }, /takes the ratios 992:432/],
    ['text_to_video', { model: 'seedance2_5', promptText: 'x', resolution: '1080p' }, /takes no resolution field/],
    ['text_to_video', { model: 'seedance2_5', promptText: 'x', audio: 'yes' }, /audio must be true or false/],
    ['text_to_video', { model: 'seedance2_5', promptText: 'x', seed: -1 }, /seed must be/],
    ['text_to_video', { model: 'seedance2_5' }, /Describe the video/],
    ['text_to_video', { model: 'seedance2_5', promptText: 'x'.repeat(15001) }, /limited to 15000 characters/],
    ['image_to_video', { model: 'seedance2_5', promptText: 'x' }, /The image is missing/],
    ['image_to_video', { model: 'seedance2_5', promptImage: 'https://example.com/a.png' }, /sent from Atelier/],
    ['video_to_video', { model: 'seedance2_5', promptText: 'x', videoUri: RUNWAY_URI }, /can’t do video to video/],
    ['text_to_video', { ...t2v(), model: '__proto__' }, /doesn’t offer/],
    ['text_to_video', { ...t2v(), model: 'gen4_turbo' }, /only animates a still image/],
    ['image_to_video', { model: 'aleph2', promptText: 'x', promptImage: PNG }, /only edits a video/],
    ['text_to_video', t2v({ ratio: '960:960' }), /takes the ratios 1280:720, 720:1280/],
    ['image_to_video', { model: 'gen4.5', promptText: 'x', promptImage: PNG, ratio: '4:5' }, /takes the ratios/],
    ['text_to_video', t2v({ duration: 11 }), /2–10 whole seconds/],
    ['text_to_video', t2v({ duration: 1 }), /2–10 whole seconds/],
    ['text_to_video', t2v({ duration: 4.5 }), /2–10 whole seconds/],
    ['text_to_video', t2v({ duration: '5' }), /2–10 whole seconds/],
    ['text_to_video', t2v({ promptText: '' }), /Describe the video/],
    ['text_to_video', t2v({ promptText: 'x'.repeat(PROMPT_MAX + 1) }), /limited to 1000 characters/],
    ['text_to_video', t2v({ promptText: 42 }), /promptText must be text/],
    ['text_to_video', t2v({ seed: -1 }), /seed must be/],
    ['text_to_video', t2v({ seed: 4294967296 }), /seed must be/],
    ['text_to_video', t2v({ contentModeration: { publicFigureThreshold: 'off' } }), /auto or low/],
    ['image_to_video', { model: 'gen4.5', promptText: 'x', promptImage: 'https://example.com/a.png' }, /sent from Atelier/],
    ['image_to_video', { model: 'gen4.5', promptText: 'x', promptImage: 'data:image/gif;base64,R0lGOD' }, /JPEG, PNG or WebP/],
    ['image_to_video', { model: 'gen4.5', promptText: 'x' }, /The image is missing/],
    ['video_to_video', { model: 'aleph2', promptText: 'x', videoUri: 'https://example.com/v.mp4' }, /runway:\/\//],
    ['video_to_video', { model: 'aleph2', promptText: 'x', videoUri: 'data:video/mp4;base64,AAAA' }, /runway:\/\//],
    ['video_to_video', { model: 'aleph2', videoUri: RUNWAY_URI }, /Describe the edit/],
    ['video_to_video', { model: 'aleph2', promptText: 'x', videoUri: RUNWAY_URI, targetAspectRatio: '4:5' }, /targetAspectRatio must be/],
    ['video_to_video', { model: 'aleph2', promptText: 'x', videoUri: RUNWAY_URI, keyframes: [] }, /1 to 5 keyframes/],
    ['video_to_video', { model: 'aleph2', promptText: 'x', videoUri: RUNWAY_URI, keyframes: Array(6).fill({ uri: PNG, seconds: 0 }) }, /1 to 5 keyframes/],
    ['video_to_video', { model: 'aleph2', promptText: 'x', videoUri: RUNWAY_URI, keyframes: [{ uri: PNG, seconds: 0, at: 0 }] }, /either seconds or at/],
    ['video_to_video', { model: 'aleph2', promptText: 'x', videoUri: RUNWAY_URI, keyframes: [{ uri: PNG, seconds: 31 }] }, /0–30/],
    ['video_to_video', { model: 'aleph2', promptText: 'x', videoUri: RUNWAY_URI, keyframes: [{ uri: PNG, seconds: 0, range: { start_seconds: 0, end_seconds: 2 } }, { uri: PNG, seconds: 3 }] }, /every keyframe has a range or none/],
    ['video_to_video', { model: 'aleph2', promptText: 'x', videoUri: RUNWAY_URI, keyframes: [{ uri: PNG, seconds: 0, range: { start_seconds: 3, end_seconds: 2 } }] }, /start < end/],
  ];
  for (const [kind, body, re] of cases) {
    const res = await rw(`runway/generate/${kind}`, { method: 'POST', body });
    const j = await read(res);
    assert.equal(res.status, 400, `${JSON.stringify(body).slice(0, 120)} → ${res.status} ${j.error}`);
    assert.match(j.error, re);
    assert.match(j.code, /^runway_/);
  }
  for (const body of ['not json', '[]', 'null']) {
    const res = await rw('runway/generate/text_to_video', { method: 'POST', body, headers: { 'content-type': 'application/json' } });
    assert.equal(res.status, 400);
  }
  assert.equal(calls.length, 0, 'Runway was called for a refused request');
});

test('the Runway catalogue: only current ids (Runway retired gen3a_turbo and gen4_aleph on 2026-07-30)', () => {
  assert.deepEqual(Object.keys(RUNWAY_MODELS).sort(), ['aleph2', 'gen4.5', 'gen4_turbo', 'grok_imagine_1_5', 'grok_imagine_1_5_lite', 'seedance2_5', 'veo3.1', 'veo3.1_fast']);
  for (const old of ['gen3a_turbo', 'gen4_aleph']) {
    assert.throws(() => shapeRequest('text_to_video', { model: old, promptText: 'x' }), (e) => e instanceof RunwayError && e.status === 400 && /doesn’t offer/.test(e.message), old);
  }
});

test('generate: an oversized body is refused with 413 before anything is sent (declared or streamed)', async () => {
  mockFetch([[/./, () => reply(500, {})]]);
  const declared = await rw('runway/generate/image_to_video', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', 'content-length': String(BODY_MAX + 1) } });
  assert.equal(declared.status, 413);
  let sent = 0;
  const stream = new ReadableStream({ pull(c) { if (sent > BODY_MAX + 65536) return c.close(); sent += 65536; c.enqueue(new Uint8Array(65536).fill(32)); } });
  const streamed = await rw('runway/generate/image_to_video', { method: 'POST', body: stream, headers: { 'content-type': 'application/json' } });
  assert.equal(streamed.status, 413);
  assert.ok(sent <= BODY_MAX + 2 * 65536, 'stopped reading soon after the cap');
  const big = await rw('runway/generate/image_to_video', { method: 'POST', body: { model: 'gen4.5', promptText: 'x', promptImage: `data:image/png;base64,${'A'.repeat(DATA_URI_MAX)}` } });
  assert.equal(big.status, 413);
  assert.match((await read(big)).error, /5 MB/);
  assert.equal(calls.length, 0);
});

test('RUNWAY_MAX_CREDITS: a request priced over the cap is refused before anything is sent to Runway', async () => {
  mockFetch([created(120)]);
  // gen4.5, 10 s = 120 credits by Runway's price list (exact for whole seconds)
  const res = await rw('runway/generate/text_to_video', { method: 'POST', body: t2v({ duration: 10 }), env: { RUNWAY_MAX_CREDITS: '100' } });
  const j = await read(res);
  assert.equal(res.status, 402);
  assert.equal(j.code, 'runway_cap');
  assert.deepEqual(j.estimatedCost, { credits: 120, usd: 1.2 });
  assert.match(j.error, /cap of 100 \(RUNWAY_MAX_CREDITS\)\. Nothing was sent to Runway\./);
  assert.equal(calls.length, 0, 'the paid POST must not go out');
  // Aleph without a clip length: its 56-credit minimum still counts
  const a = await rw('runway/generate/video_to_video', { method: 'POST', body: { model: 'aleph2', promptText: 'snow', videoUri: RUNWAY_URI }, env: { RUNWAY_MAX_CREDITS: '50' } });
  assert.equal(a.status, 402);
  assert.equal((await read(a)).code, 'runway_cap');
  assert.equal(calls.length, 0);
  // under the cap (or no cap): left alone
  assert.equal((await rw('runway/generate/text_to_video', { method: 'POST', body: t2v(), env: { RUNWAY_MAX_CREDITS: '900' } })).status, 200);
  assert.deepEqual(calls.map((c) => c.method), ['POST']);
});

test('RUNWAY_MAX_CREDITS backstop: Runway’s own estimate over the cap is cancelled at once; a failed cancel hands back the id', async () => {
  // the price list says 48 (4 s), but Runway estimates 240: cancel straight away
  let del = 204;
  mockFetch([created(240), [up(`tasks/${ID}`), (c) => { assert.equal(c.method, 'DELETE', 'the backstop cancels directly'); return reply(del); }]]);
  const res = await rw('runway/generate/text_to_video', { method: 'POST', body: t2v({ duration: 4 }), env: { RUNWAY_MAX_CREDITS: '100' } });
  const j = await read(res);
  assert.equal(res.status, 402);
  assert.equal(j.code, 'runway_cap');
  assert.deepEqual(j.estimatedCost, { credits: 240, usd: 2.4 });
  assert.match(j.error, /cancelled it straight away/);
  assert.equal(j.id, undefined);
  assert.deepEqual(calls.map((c) => c.method), ['POST', 'DELETE']);
  // the cancel fails: never "nothing was made" — the id comes back so the browser can retry the cancel
  del = 500;
  calls = [];
  const res2 = await rw('runway/generate/text_to_video', { method: 'POST', body: t2v({ duration: 4 }), env: { RUNWAY_MAX_CREDITS: '100' } });
  const j2 = await read(res2);
  assert.equal(res2.status, 402);
  assert.equal(j2.code, 'runway_cap_running');
  assert.equal(j2.id, ID);
  assert.doesNotMatch(j2.error, /Nothing was/);
  assert.match(j2.error, /couldn’t cancel it/);
  assert.deepEqual(calls.map((c) => c.method), ['POST', 'DELETE']);
});

test('generate: a malformed Runway answer is a 502, not a crash', async () => {
  mockFetch([[up('text_to_video'), () => reply(200, { id: 'not-a-uuid' })]]);
  const res = await rw('runway/generate/text_to_video', { method: 'POST', body: t2v() });
  assert.equal(res.status, 502);
});

// ── error mapping: Runway's bodies are never forwarded as they are ──

test('Runway errors map to clean statuses and messages (never the raw body)', async () => {
  const raw400 = { error: 'Invalid input', docUrl: 'https://docs.dev.runwayml.com/errors/', issues: [{ code: 'invalid_enum_value', path: ['ratio'], message: `Expected one of 1280:720 — see ${CDN} and ${KEY}` }] };
  const cases = [
    [400, raw400, {}, 400, /^Runway didn’t accept that request — Invalid input — ratio: Expected one of 1280:720 — see \[link\] and …$/, 'runway_rejected'],
    [401, { error: 'Invalid API key' }, {}, 403, /rejected the server’s API key \(RUNWAYML_API_SECRET\)/, 'runway_key'],
    [429, { error: 'Daily limit' }, { 'retry-after': '30' }, 429, /limiting this account/, 'runway_limit'],
    [502, '<html>bad gateway</html>', {}, 503, /busy right now/, 'runway_busy'],
    [503, { error: 'shedding load' }, { 'retry-after': '5' }, 503, /busy right now/, 'runway_busy'],
    [504, '', {}, 503, /busy/, 'runway_busy'],
    [405, { error: 'no' }, {}, 502, /failed \(405\)/, 'runway_failed'],
  ];
  for (const [status, body, headers, want, re, code] of cases) {
    mockFetch([[up('text_to_video'), () => reply(status, body, headers)]]);
    const res = await rw('runway/generate/text_to_video', { method: 'POST', body: t2v() });
    const j = await read(res);
    assert.equal(res.status, want, `${status}`);
    assert.match(j.error, re, `${status}`);
    assert.equal(j.code, code);
    assert.ok(!JSON.stringify(j).includes('docs.dev.runwayml.com'), 'docUrl forwarded');
    if (headers['retry-after']) assert.equal(res.headers.get('retry-after'), headers['retry-after']);
    assert.ok(!/passcode/i.test(j.error), 'a Runway problem must never read as a passcode problem (app.js would sign the owner out)');
  }
  // network failure
  globalThis.fetch = async () => { throw new TypeError(`connect ECONNREFUSED ${KEY}`); };
  const res = await rw('runway/generate/text_to_video', { method: 'POST', body: t2v() });
  assert.equal(res.status, 502);
  assert.match((await read(res)).error, /unreachable/);
});

test('logs carry the status and issue codes only — never prompts, keys or links', async () => {
  mockFetch([[up('text_to_video'), () => reply(400, { error: 'bad', issues: [{ code: 'too_big', path: ['promptText'], message: 'SECRET PROMPT TEXT' }] })]]);
  await rw('runway/generate/text_to_video', { method: 'POST', body: t2v({ promptText: 'SECRET PROMPT TEXT' }) });
  assert.ok(logs.some((l) => /runway .*400 too_big/.test(l)), logs.join('\n'));
  assert.ok(logs.every((l) => !l.includes('SECRET PROMPT TEXT')), logs.join('\n'));
});

// ── polling a task ──

test('task: the cleaned status never carries output links, and asks for ≥ 5 s between polls', async () => {
  const states = [
    { id: ID, status: 'THROTTLED', createdAt: '2026-09-30T12:00:00.000Z', estimatedCost: { credits: 60 } },
    { id: ID, status: 'RUNNING', createdAt: '2026-09-30T12:00:00.000Z', progress: 0.42, estimatedCost: { credits: 60 } },
    { id: ID, status: 'SUCCEEDED', createdAt: '2026-09-30T12:00:00.000Z', output: [CDN], cost: { credits: 60 } },
    { id: ID, status: 'FAILED', createdAt: '2026-09-30T12:00:00.000Z', failure: `Blocked: see ${CDN}`, failureCode: 'SAFETY.INPUT.TEXT', cost: { credits: 60 } },
  ];
  let n = 0;
  mockFetch([[up(`tasks/${ID}`), () => reply(200, states[n++])]]);
  const a = await rw(`runway/task/${ID}`), ja = await read(a);
  assert.deepEqual(ja, { id: ID, status: 'THROTTLED', createdAt: '2026-09-30T12:00:00.000Z', estimatedCost: { credits: 60, usd: 0.6 }, outputs: 0, pollAfterMs: 5000 });
  assert.equal(a.headers.get('retry-after'), '5');
  const jb = await read(await rw(`runway/task/${ID}`));
  assert.equal(jb.progress, 0.42);
  const c = await rw(`runway/task/${ID}`), jc = await read(c);
  assert.deepEqual(jc, { id: ID, status: 'SUCCEEDED', createdAt: '2026-09-30T12:00:00.000Z', cost: { credits: 60, usd: 0.6 }, outputs: 1 });
  assert.equal(c.headers.get('retry-after'), null);
  const jd = await read(await rw(`runway/task/${ID}`));
  assert.equal(jd.failureCode, 'SAFETY.INPUT.TEXT');
  assert.equal(jd.failure, 'Blocked: see [link]');
});

test('task: a non-UUID id is a 404 without any upstream call; a gone task is 404 runway_gone', async () => {
  mockFetch([[up(`tasks/${ID}`), () => reply(404, { error: 'Task not found' })]]);
  for (const bad of ['task/abc', 'task/../organization', `task/${ID}x`, 'task/zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz', 'task/------------------------------------']) {
    assert.equal((await rw(`runway/${bad}`)).status, 404, bad);
  }
  assert.equal(calls.length, 0);
  const res = await rw(`runway/task/${ID}`);
  assert.equal(res.status, 404);
  assert.equal((await read(res)).code, 'runway_gone');
});

test('cancel (Stop): an unfinished task is cancelled; DELETE is idempotent (an upstream 404 is fine)', async () => {
  let get = () => reply(200, { id: ID, status: 'RUNNING', progress: 0.4 }), del = 204;
  mockFetch([[up(`tasks/${ID}`), (c) => (c.method === 'GET' ? get() : reply(del))]]);
  const a = await rw(`runway/task/${ID}`, { method: 'DELETE' });
  assert.deepEqual([a.status, await read(a)], [200, { ok: true, gone: false }]);
  assert.deepEqual(calls.map((c) => c.method), ['GET', 'DELETE']);
  del = 404;
  const b = await rw(`runway/task/${ID}`, { method: 'DELETE' });
  assert.deepEqual([b.status, await read(b)], [200, { ok: true, gone: true }]);
  del = 503;
  assert.equal((await rw(`runway/task/${ID}`, { method: 'DELETE' })).status, 503);
  // already gone at the status check: nothing to delete
  calls = [];
  get = () => reply(404, { error: 'Task not found' });
  const c = await rw(`runway/task/${ID}`, { method: 'DELETE' });
  assert.deepEqual([c.status, await read(c)], [200, { ok: true, gone: true }]);
  assert.deepEqual(calls.map((x) => x.method), ['GET']);
  // the status can't be read: Stop still cancels
  calls = []; del = 204;
  get = () => reply(503, { error: 'busy' });
  assert.equal((await rw(`runway/task/${ID}`, { method: 'DELETE' })).status, 200);
  assert.deepEqual(calls.map((x) => x.method), ['GET', 'DELETE']);
});

test('cancel (Stop): a finished task is left alone — Runway’s DELETE would delete a paid-for video', async () => {
  for (const status of ['SUCCEEDED', 'FAILED', 'CANCELLED']) {
    mockFetch([[up(`tasks/${ID}`), (c) => (c.method === 'GET' ? reply(200, { id: ID, status, output: [CDN] }) : reply(204))]]);
    const res = await rw(`runway/task/${ID}`, { method: 'DELETE' });
    assert.deepEqual([res.status, await read(res)], [200, { ok: true, gone: false, kept: true, status }], status);
    assert.deepEqual(calls.map((c) => c.method), ['GET'], `${status}: no DELETE`);
  }
});

test('cleanTask copes with odd shapes', () => {
  assert.throws(() => cleanTask(null, ID), RunwayError);
  assert.equal(cleanTask({ status: 'WEIRD' }, ID).status, 'WEIRD');
  assert.equal(cleanTask({ status: '<script>' }, ID).status, 'UNKNOWN');
  assert.equal(cleanTask({ status: 'RUNNING', progress: 7 }, ID).progress, undefined);
  assert.equal(cleanTask({ status: 'FAILED', failure: 'x', failureCode: 'bad code!' }, ID).failureCode, null);
  assert.equal(cleanTask({ id: 'nope', status: 'PENDING' }, ID).id, ID);
});

// ── downloading the result ──

const VIDEO = new Uint8Array(4096).map((_, i) => i % 251);
const done = (output = [CDN]) => [up(`tasks/${ID}`), () => reply(200, { id: ID, status: 'SUCCEEDED', createdAt: '2026-09-30T12:00:00.000Z', output, cost: { credits: 48 } })];

test('output: re-fetches the task, downloads without credentials and streams video/mp4 back, private and uncached', async () => {
  mockFetch([done(), [/^GET https:\/\/dnznrvs05pmza\.cloudfront\.net\//, () => new Response(VIDEO, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(VIDEO.byteLength) } })]]);
  const res = await rw(`runway/output/${ID}?i=0`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  assert.equal(res.headers.get('content-length'), String(VIDEO.byteLength));
  assert.equal(res.headers.get('x-runway-credits'), '48');
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), VIDEO);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `${RUNWAY_BASE}/tasks/${ID}`);
  assert.equal(calls[1].url, CDN);
  assert.equal(calls[1].headers.get('authorization'), null, 'the Runway key went to the CDN');
  assert.equal(calls[1].headers.get('x-runway-version'), null);
});

test('output: refuses unfinished tasks, missing indexes, foreign hosts and oversized files', async () => {
  mockFetch([[up(`tasks/${ID}`), () => reply(200, { id: ID, status: 'RUNNING', progress: 0.3, estimatedCost: { credits: 48 } })]]);
  const running = await rw(`runway/output/${ID}`);
  assert.equal(running.status, 409);
  assert.equal((await read(running)).code, 'runway_not_ready');

  mockFetch([done()]);
  assert.equal((await rw(`runway/output/${ID}?i=1`)).status, 404);
  assert.equal((await rw(`runway/output/${ID}?i=-1`)).status, 400);
  assert.equal((await rw(`runway/output/${ID}?i=abc`)).status, 400);

  for (const link of ['http://dnznrvs05pmza.cloudfront.net/v.mp4', 'https://evil.example/v.mp4', 'https://cloudfront.net.evil.example/v.mp4', 'https://user:pw@x.cloudfront.net/v.mp4', 'https://x.cloudfront.net:8443/v.mp4', 'ftp://x.runwayml.com/v']) {
    mockFetch([done([link]), [/./, () => reply(200, 'should not download')]]);
    const res = await rw(`runway/output/${ID}`);
    assert.equal(res.status, 502, link);
    assert.equal(calls.length, 1, `${link} was fetched`);
  }

  mockFetch([done(), [/cloudfront/, () => new Response('x', { headers: { 'content-length': String(OUTPUT_MAX + 1) } })]]);
  const big = await rw(`runway/output/${ID}`);
  assert.equal(big.status, 502);
  assert.match((await read(big)).error, /too big/);

  mockFetch([done(), [/cloudfront/, () => reply(403, 'AccessDenied')]]);
  assert.equal((await rw(`runway/output/${ID}`)).status, 502);
});

test('output: redirects are followed only onto allowed hosts', async () => {
  const next = 'https://other.cloudfront.net/v.mp4';
  mockFetch([done(), [/^GET https:\/\/dnznrvs05pmza/, () => new Response(null, { status: 302, headers: { location: next } })], [/^GET https:\/\/other\.cloudfront/, () => new Response(VIDEO, { headers: { 'content-type': 'video/mp4' } })]]);
  const ok = await rw(`runway/output/${ID}`);
  assert.equal(ok.status, 200);
  assert.equal((await ok.arrayBuffer()).byteLength, VIDEO.byteLength);
  assert.equal(calls.at(-1).init.redirect, 'manual');

  mockFetch([done(), [/^GET https:\/\/dnznrvs05pmza/, () => new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } })], [/evil/, () => reply(200, 'no')]]);
  assert.equal((await rw(`runway/output/${ID}`)).status, 502);
  assert.ok(!calls.some((c) => c.url.includes('evil.example')));
});

test('output: an undeclared length is streamed through a size cap', async () => {
  const body = new ReadableStream({ start(c) { c.enqueue(VIDEO); c.close(); } });
  mockFetch([done(), [/cloudfront/, () => new Response(body, { headers: { 'content-type': 'video/mp4' } })]]);
  const res = await rw(`runway/output/${ID}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-length'), null);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), VIDEO);
});

test('outputUrlOk', () => {
  for (const u of [CDN, 'https://runwayml.com/x', 'https://cdn.runwayml.com/x', 'https://assets.runway.com/x']) assert.ok(outputUrlOk(u), u);
  for (const u of ['http://x.cloudfront.net/a', 'https://xcloudfront.net/a', 'https://runwayml.com.evil/a', 'https://evilrunway.com/a', 'not a url', '']) assert.ok(!outputUrlOk(u), u);
});

// ── upload relay (Aleph source clips) ──

const CLIP = new Uint8Array(2048).map((_, i) => (i * 7) % 256);
const FIELDS = { key: 'uploads/abc/atelier.mp4', 'x-amz-algorithm': 'AWS4-HMAC-SHA256', 'x-amz-credential': 'AKIA/20260930/us-east-1/s3/aws4_request', policy: 'eyJleHBpcmF0aW9uIjoi', 'x-amz-signature': 'deadbeef' };
const S3 = 'https://runway-uploads.s3.amazonaws.com/';
const uploads = (answer = {}) => [up('uploads'), (c) => reply(200, { uploadUrl: S3, fields: FIELDS, runwayUri: RUNWAY_URI, ...answer, _filename: c.json?.filename })];

test('upload: one /uploads call, then the fields and the file as fixed-length multipart, bytes unchanged, no key', async () => {
  let multipart = null, ctype = '';
  mockFetch([uploads(), [/^POST https:\/\/runway-uploads\.s3\.amazonaws\.com\/$/, async (c) => { ctype = c.headers.get('content-type'); multipart = new Uint8Array(await new Response(c.body).arrayBuffer()); return new Response(null, { status: 204 }); }]]);
  const res = await rw('runway/upload', { method: 'POST', body: CLIP, headers: { 'content-type': 'video/mp4' } });
  const j = await read(res);
  assert.equal(res.status, 200, JSON.stringify(j));
  assert.equal(j.runwayUri, RUNWAY_URI);
  assert.ok(j.expiresAt > Date.now() + 22 * 3600e3 && j.expiresAt < Date.now() + 24 * 3600e3);
  assert.equal(calls.length, 2);
  assert.match(calls[0].json.filename, /^atelier-[0-9a-f]{8}\.mp4$/);
  assert.equal(calls[0].json.type, 'ephemeral');
  assert.equal(calls[1].headers.get('authorization'), null, 'the Runway key went to the upload URL');
  const boundary = ctype.match(/^multipart\/form-data; boundary=(\S+)$/)[1];
  const text = Buffer.from(multipart).toString('latin1');
  const parts = text.split(`--${boundary}`);
  assert.equal(parts.at(-1), '--\r\n');
  const names = parts.slice(1, -1).map((p) => p.match(/name="([^"]+)"/)[1]);
  assert.deepEqual(names, [...Object.keys(FIELDS), 'file'], 'fields first, file last');
  for (const [k, v] of Object.entries(FIELDS)) assert.ok(text.includes(`name="${k}"\r\n\r\n${v}\r\n`), k);
  const fileHead = `name="file"; filename="${calls[0].json.filename}"\r\nContent-Type: video/mp4\r\n\r\n`;
  const start = text.indexOf(fileHead) + fileHead.length;
  assert.deepEqual(multipart.slice(start, start + CLIP.byteLength), CLIP);
  assert.equal(multipart.byteLength, start + CLIP.byteLength + `\r\n--${boundary}--\r\n`.length);
});

test('upload: type, length and size are checked before Runway is called', async () => {
  mockFetch([[/./, () => reply(500, {})]]);
  assert.equal((await rw('runway/upload', { method: 'POST', body: CLIP, headers: { 'content-type': 'video/x-msvideo' } })).status, 415);
  assert.equal((await rw('runway/upload', { method: 'POST', body: CLIP, headers: { 'content-type': 'text/html' } })).status, 415);
  const stream = new ReadableStream({ start(c) { c.enqueue(CLIP); c.close(); } });
  assert.equal((await rw('runway/upload', { method: 'POST', body: stream, headers: { 'content-type': 'video/mp4' } })).status, 411);
  assert.equal((await rw('runway/upload', { method: 'POST', body: CLIP, headers: { 'content-type': 'video/mp4', 'content-length': String(UPLOAD_MAX + 1) } })).status, 413);
  assert.equal((await rw('runway/upload', { method: 'POST', body: new Uint8Array(100), headers: { 'content-type': 'video/mp4' } })).status, 400);
  assert.equal(calls.length, 0);
});

test('upload: a refused upload is never retried (exactly one /uploads call) and an http uploadUrl is refused', async () => {
  mockFetch([uploads(), [/s3\.amazonaws/, () => reply(403, '<Error>AccessDenied</Error>')]]);
  const res = await rw('runway/upload', { method: 'POST', body: CLIP, headers: { 'content-type': 'video/mp4' } });
  assert.equal(res.status, 502);
  assert.match((await read(res)).error, /attach the file again/);
  assert.equal(calls.filter((c) => /\/uploads$/.test(c.url)).length, 1);

  for (const answer of [{ uploadUrl: 'http://runway-uploads.s3.amazonaws.com/' }, { uploadUrl: 'not a url' }, { runwayUri: 'https://x' }, { fields: { 'bad name': 'x' } }, { fields: { key: 'a\r\nb' } }]) {
    mockFetch([uploads(answer), [/./, () => reply(204)]]);
    const r = await rw('runway/upload', { method: 'POST', body: CLIP, headers: { 'content-type': 'video/mp4' } });
    assert.equal(r.status, 502, JSON.stringify(answer));
    assert.equal(calls.length, 1, `${JSON.stringify(answer)}: the upload went ahead`);
  }
});

test('upload: a body shorter than its content-length fails cleanly', async () => {
  mockFetch([uploads(), [/s3\.amazonaws/, async (c) => { await new Response(c.body).arrayBuffer(); return new Response(null, { status: 204 }); }]]);
  const stream = new ReadableStream({ start(c) { c.enqueue(CLIP.slice(0, 1000)); c.close(); } });
  const res = await rw('runway/upload', { method: 'POST', body: stream, headers: { 'content-type': 'video/mp4', 'content-length': String(CLIP.byteLength) } });
  assert.ok([400, 502].includes(res.status), String(res.status));
});

// ── account, diag, routing ──

test('account: only the models Atelier uses, with the balance in credits and dollars', async () => {
  mockFetch([[up('organization'), () => reply(200, { creditBalance: 4210, tier: { maxMonthlyCreditSpend: 10000, models: { 'gen4.5': { maxConcurrentGenerations: 1, maxDailyGenerations: 50 }, aleph2: { maxConcurrentGenerations: null, maxDailyGenerations: null }, veo3: { maxConcurrentGenerations: 1, maxDailyGenerations: 50 } } }, usage: { models: {} } })]]);
  const j = await read(await rw('runway/account'));
  assert.deepEqual(j, { creditBalance: 4210, usd: 42.1, maxMonthlyCreditSpend: 10000, models: { 'gen4.5': { maxConcurrentGenerations: 1, maxDailyGenerations: 50 }, aleph2: { maxConcurrentGenerations: null, maxDailyGenerations: null } } });
});

test('runwayDiag reads the free organization call', async () => {
  mockFetch([[up('organization'), () => reply(200, { creditBalance: 4210, tier: { maxMonthlyCreditSpend: 10000, models: {} } })]]);
  assert.deepEqual(await runwayDiag(KEY), { ok: true, status: 200, message: '4,210 credits ($42.10) · up to 10,000 credits a month' });
  mockFetch([[up('organization'), () => reply(401, { error: 'bad key' })]]);
  const bad = await runwayDiag(KEY);
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 403);
  globalThis.fetch = async () => { throw new Error('offline'); };
  assert.equal((await runwayDiag(KEY)).ok, false);
});

test('account: the read has its own deadline, so a slow Runway answers runway_unreachable instead of holding Settings; a create never gets one', async () => {
  const { ACCOUNT_TIMEOUT_MS } = await import('../src/runway.js');
  assert.equal(ACCOUNT_TIMEOUT_MS, 8000);
  mockFetch([[up('organization'), () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }]]);
  const res = await rw('runway/account');
  assert.equal(res.status, 502);
  assert.equal((await read(res)).code, 'runway_unreachable');
  assert.ok(calls[0].init.signal instanceof AbortSignal, 'the account read carries AbortSignal.timeout');
  assert.ok(logs.some((l) => l.includes('no answer in 8000 ms')));
  mockFetch([created(48)]);
  assert.equal((await rw('runway/generate/text_to_video', { method: 'POST', body: t2v() })).status, 200);
  assert.equal(calls[0].init.signal, undefined, 'a create is never cut short: Runway may already be filming (and billing) it');
});

test('routing: no key → 401 before anything; unknown routes and wrong methods → 404 with no upstream call', async () => {
  mockFetch([[/./, () => reply(500, {})]]);
  const nokey = await rw('runway/account', { key: '' });
  assert.equal(nokey.status, 401);
  assert.match((await read(nokey)).error, /No Runway key on the server \(set RUNWAYML_API_SECRET\)/);
  for (const [method, path] of [['GET', 'runway/generate/text_to_video'], ['POST', 'runway/generate/text_to_image'], ['POST', 'runway/generate/character_performance'],
    ['GET', 'runway/probe'], ['POST', 'runway/a/b'], ['PUT', 'runway/upload'], ['GET', 'runway/upload'], ['POST', 'runway/account'], ['POST', `runway/task/${ID}`],
    ['GET', 'runway/organization'], ['GET', 'runway/tasks/' + ID], ['GET', 'runway/'], ['GET', 'runway']]) {
    const res = await rw(path, { method, ...(method === 'GET' ? {} : { body: '{}' }) });
    assert.equal(res.status, 404, `${method} ${path}`);
  }
  assert.equal(calls.length, 0);
});

test('quote and scrub', () => {
  assert.deepEqual(quote('gen4.5', 5), { credits: 60, usd: 0.6 });
  assert.deepEqual(quote('gen4_turbo', 10), { credits: 50, usd: 0.5 });
  assert.deepEqual(quote('aleph2', 1.2), { credits: 56, usd: 0.56 });
  assert.deepEqual(quote('aleph2', 12.4), { credits: 364, usd: 3.64 });
  assert.equal(quote('aleph2', 0), null);
  assert.equal(quote('nope', 5), null);
  const s = scrub(`a ${KEY} b ${CDN} c runway://abc d data:image/png;base64,AAAA e\nf\u2028g`, KEY);
  assert.ok(!s.includes(KEY) && !s.includes(JWT) && !s.includes('runway://abc') && !s.includes('AAAA') && !/[\n\u2028]/.test(s), s);
});

// ── owner only: nothing on the tester side may know Runway yet ──

test('testers: no runway: id in any tester model list, and no tester route reaches runway/*', async () => {
  const P = await import('../src/tester/prices.js');
  for (const list of ['TESTER_MODELS', 'TESTER_IMAGE_MODELS', 'TESTER_VIDEO_MODELS', 'TESTER_TTS_MODELS']) {
    for (const id of P[list] || []) assert.ok(!/^runway:/.test(id), `${id} is in ${list}: Runway would reach testers (and router.js providerOf would call it NVIDIA)`);
  }
  // A documented entry is fine only when it is explicitly kept from testers.
  for (const [id, e] of Object.entries(P.PRICES)) if (/^runway:/.test(id)) assert.equal(e.tester, false, `${id} in prices.js needs tester:false`);
  const { matchTesterRoute } = await import('../src/tester/router.js');
  for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']) {
    for (const path of ['runway/generate/text_to_video', 'runway/generate/image_to_video', 'runway/generate/video_to_video', `runway/task/${ID}`, `runway/output/${ID}`, 'runway/upload', 'runway/account', 'runway/probe']) {
      assert.equal(matchTesterRoute(method, path), null, `${method} ${path} is on the tester list`);
    }
  }
});

// ── the Worker wiring (runs once src/worker.js is patched per runway-integration.md) ──
const workerSrc = await readFile(new URL('../src/worker.js', import.meta.url), 'utf8');
const wired = /from '\.\/runway\.js'/.test(workerSrc) && /path\.startsWith\('runway\/'\)/.test(workerSrc);
const notWired = wired ? false : 'src/worker.js isn’t wired to src/runway.js yet (see runway-integration.md)';

test('worker: /api/health reports server.runway from RUNWAYML_API_SECRET', { skip: notWired }, async () => {
  const { makeEnv, api } = await import('./tester-env.mjs');
  const { env } = makeEnv({ RUNWAYML_API_SECRET: KEY });
  assert.equal((await (await api(env, 'health')).json()).server.runway, true);
  const { env: none } = makeEnv();
  assert.equal((await (await api(none, 'health')).json()).server.runway, false);
});

test('worker: the passcode gate and the missing-secret message', { skip: notWired }, async () => {
  const { makeEnv, api, mockFetch: mf, restoreFetch, upstream } = await import('./tester-env.mjs');
  mf([[/./, () => reply(500, {})]]);
  try {
    const { env } = makeEnv({ RUNWAYML_API_SECRET: KEY });
    const r1 = await api(env, 'runway/account');
    assert.equal(r1.status, 401);
    assert.match((await r1.json()).error, /Enter your passcode/);
    const r2 = await api(env, 'runway/account', {}, { pass: 'wrong' });
    assert.equal(r2.status, 401);
    const { env: noSecret } = makeEnv();
    const r3 = await api(noSecret, 'runway/account', {}, { pass: 'pw' });
    assert.equal(r3.status, 401);
    assert.equal((await r3.json()).error, 'No Runway key on the server (set RUNWAYML_API_SECRET).');
    assert.equal(upstream.calls.length, 0);
  } finally { restoreFetch(); }
});

test('worker: the owner reaches Runway through the Worker; the response is secured', { skip: notWired }, async () => {
  const { makeEnv, api, restoreFetch } = await import('./tester-env.mjs');
  mockFetch([created(48)]);
  try {
    const { env } = makeEnv({ RUNWAYML_API_SECRET: KEY });
    const res = await api(env, 'runway/generate/text_to_video', { method: 'POST', body: t2v(), headers: { 'content-type': 'application/json' } }, { pass: 'pw' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await res.json()).id, ID);
    assert.equal(calls[0].headers.get('authorization'), `Bearer ${KEY}`);
  } finally { restoreFetch(); }
});

test('worker: testers get 403 owner_only on every runway route, before any upstream or Ledger work', { skip: notWired }, async () => {
  const { makeEnv, api, signIn, PROFILE, mockFetch: mf, restoreFetch, upstream, resetTesterCaches } = await import('./tester-env.mjs');
  resetTesterCaches();
  mf([[/./, () => reply(500, { error: 'should not be called' })]]);
  try {
    const { env, L } = makeEnv({ RUNWAYML_API_SECRET: KEY });
    const t = await signIn(L, PROFILE());
    for (const [method, path] of [['POST', 'runway/generate/text_to_video'], ['POST', 'runway/generate/image_to_video'], ['POST', 'runway/generate/video_to_video'],
      ['GET', `runway/task/${ID}`], ['DELETE', `runway/task/${ID}`], ['GET', `runway/output/${ID}`], ['POST', 'runway/upload'], ['GET', 'runway/account']]) {
      L.calls.length = 0;
      const res = await api(env, path, { method, ...(method === 'GET' ? {} : { body: '{}' }) }, { cookie: t.token });
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.equal((await res.json()).code, 'owner_only', `${method} ${path}`);
      assert.ok(L.calls.every((m) => m === 'session'), `${method} ${path} touched the Ledger: ${L.calls}`);
    }
    assert.equal(upstream.calls.length, 0);
  } finally { restoreFetch(); }
});

test('worker: a tester’s Seedance 2.5 request is refused 403 owner_only before Runway or the Ledger', { skip: notWired }, async () => {
  const { makeEnv, api, signIn, PROFILE, mockFetch: mf, restoreFetch, upstream, resetTesterCaches } = await import('./tester-env.mjs');
  resetTesterCaches();
  mf([[/./, () => reply(500, { error: 'should not be called' })]]);
  try {
    const { env, L } = makeEnv({ RUNWAYML_API_SECRET: KEY });
    const t = await signIn(L, PROFILE());
    for (const [kind, body] of [['text_to_video', { model: 'seedance2_5', promptText: 'A paper boat', ratio: '1280:720', duration: 6 }],
      ['image_to_video', { model: 'seedance2_5', promptImage: PNG, ratio: '1920:1080', duration: 4 }]]) {
      L.calls.length = 0;
      const res = await api(env, `runway/generate/${kind}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }, { cookie: t.token });
      assert.equal(res.status, 403, kind);
      assert.equal((await res.json()).code, 'owner_only', kind);
      assert.ok(L.calls.every((m) => m === 'session'), `${kind} touched the Ledger: ${L.calls}`);
    }
    assert.equal(upstream.calls.length, 0);
  } finally { restoreFetch(); }
});

test('worker: /api/diag includes Runway when the secret is set', { skip: wired && /runwayDiag/.test(workerSrc) ? false : 'runwayDiag isn’t wired into /api/diag yet' }, async () => {
  const { makeEnv, api, restoreFetch } = await import('./tester-env.mjs');
  mockFetch([[up('organization'), () => reply(200, { creditBalance: 100, tier: { maxMonthlyCreditSpend: 10000, models: {} } })], [/./, () => reply(200, {})]]);
  try {
    const { env } = makeEnv({ RUNWAYML_API_SECRET: KEY });
    const j = await (await api(env, 'diag', {}, { pass: 'pw' })).json();
    assert.equal(j.runway?.ok, true);
  } finally { restoreFetch(); }
});

test('review fixture: a simulated tester gets 403 owner_only on every /api/runway/* stub, as from the Worker; the owner still films', async () => {
  const [{ spawn }, { createServer }, { fileURLToPath }] = await Promise.all([import('node:child_process'), import('node:net'), import('node:url')]);
  const port = await new Promise((res, rej) => { const s = createServer().once('error', rej).listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  // scripts/review-server.mjs as `REVIEW_TESTER=<sub> … --providers`: no passcode = the simulated tester session
  const child = spawn(process.execPath, ['scripts/review-server.mjs', '--providers'], { cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, REVIEW_TESTER: 'review-tester', REVIEW_PORT: String(port), REVIEW_SYNC: '', REVIEW_RUNWAY_LOG: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let timer;
  try {
    await new Promise((res, rej) => {
      timer = setTimeout(() => rej(new Error('the review fixture didn’t start')), 15_000);
      child.stdout.on('data', (d) => { if (/Isolated review/.test(d)) res(); });
      child.once('exit', (code) => rej(new Error(`the review fixture exited (${code})`)));
    });
    const base = `http://127.0.0.1:${port}/api/runway/`, json = { 'content-type': 'application/json' };
    const body = JSON.stringify({ model: 'seedance2_5', promptText: 'A paper boat', ratio: '1280:720', duration: 6 });
    for (const [method, path] of [['POST', 'generate/text_to_video'], ['POST', 'generate/image_to_video'], ['POST', 'generate/video_to_video'],
      ['GET', `task/${ID}`], ['DELETE', `task/${ID}`], ['GET', `output/${ID}`], ['POST', 'upload'], ['GET', 'account']]) {
      const res = await realFetch(base + path, { method, ...(method === 'POST' ? { body, headers: json } : {}) });
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.deepEqual(await res.json(), { error: 'That part of Atelier is only for its owner.', code: 'owner_only' }, `${method} ${path}`);
    }
    // the owner's passcode still reaches the stubs: create → poll → SUCCEEDED
    const own = { ...json, 'x-app-pass': 'review-only' };
    const made = await realFetch(base + 'generate/text_to_video', { method: 'POST', body, headers: own });
    assert.equal(made.status, 200);
    const { id } = await made.json();
    // …and the tester can't poll the owner's task either
    assert.equal((await realFetch(base + `task/${id}`)).status, 403);
    let status;
    for (let i = 0; i < 3; i++) status = (await (await realFetch(base + `task/${id}`, { headers: own })).json()).status;
    assert.equal(status, 'SUCCEEDED');
  } finally {
    clearTimeout(timer);
    child.kill();
  }
});
