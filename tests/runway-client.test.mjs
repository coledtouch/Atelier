import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// public/runway.js — pure helpers, plus the task runner against a mocked /api/runway/* (no network, no real Runway).
const R = await import('../public/runway.js');
const S = await import('../src/runway.js');
const {
  RUNWAY_MODELS, RUNWAY_VIDEO_MODELS, RUNWAY_EDIT_MODEL, RUNWAY_TIMING, I2V_RATIOS, T2V_RATIOS, TARGET_ASPECTS, UPLOAD_TYPES, RUNWAY_SECONDS,
  quote, quoteNote, creditsNote, ratioFor, ratioBox, t2vRatio, runwaySeconds, veoSeconds, alephProblem, ALEPH_PROBLEM_TEXT, clampPrompt, buildRequest,
  pollDelay, statusText, failureOf, mentionsRunway, runwayHint, connectionRow, isRunwayId, runwayModelOf,
  waitForTask, runwayVideo, takeSlot, slotState, uploadToRunway, runwayAccount, forgetAccount, accountLimit, cancelTask, downloadOutput, POWERED_BY,
  stillPlan, INPUT_ASPECT, createTask, createTimeout, VEO_RATIOS, runwaySecondsFor, veoRatio, optionNote, GROK_SECONDS, grokShape,
} = R;

// app.js's own errorKind (+ accountProblem), lifted from the source so the card a Runway error gets is the real one.
// null if app.js has been reshaped; the tests below then fall back to its documented regexes.
const appErrorKind = (() => {
  try {
    const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const a = src.match(/\nconst accountProblem = [\s\S]*?\);\n/), k = src.match(/\nfunction errorKind\([\s\S]*?\n}\n/);
    return a && k ? new Function('isTesterCode', `${a[0]}\n${k[0]}\nreturn errorKind;`)(() => false) : null;
  } catch { return null; }
})();

const ID = '4a7b0c1d-2e3f-4a5b-8c6d-7e8f9a0b1c2d';
const PNG = `data:image/png;base64,${'iVBORw0KGgo'.padEnd(64, 'A')}`;
const JPEG = `data:image/jpeg;base64,${'/9j/4AAQ'.padEnd(64, 'A')}`;

// ── fetch mock for /api/runway/* ──
let calls = [];
const realFetch = globalThis.fetch;
const reply = (status, body, headers = {}) => new Response(body === undefined || status === 204 ? null : typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
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
const headers = () => ({ 'content-type': 'application/json', 'x-app-pass': 'pw' }); // like app.js apiHeaders
// A sleep that records the waits instead of waiting (and honours aborts).
function fakeSleep() {
  const waits = [];
  const sleep = async (ms, signal) => { if (signal?.aborted) throw new DOMException('Aborted', 'AbortError'); waits.push(ms); };
  return { waits, sleep };
}
beforeEach(() => { forgetAccount(); });
afterEach(() => { globalThis.fetch = realFetch; });

// ── catalogue: the client and the Worker agree ──

test('the client catalogue matches the Worker’s (models, prices, ratios, upload types)', () => {
  assert.deepEqual(Object.keys(RUNWAY_MODELS).sort(), Object.keys(S.RUNWAY_MODELS).sort());
  for (const [id, m] of Object.entries(RUNWAY_MODELS)) {
    const s = S.RUNWAY_MODELS[id];
    assert.equal(m.credits, s.creditsPerSecond, id);
    assert.equal(m.min, s.minCredits, id);
    assert.equal(m.t2v, Object.hasOwn(s.kinds, 'text_to_video'), id);
    assert.equal(m.i2v, Object.hasOwn(s.kinds, 'image_to_video'), id);
    assert.equal(m.v2v, Object.hasOwn(s.kinds, 'video_to_video'), id);
    for (const secs of [1, 2, 5, 10, 12.4, 30]) assert.deepEqual(quote(id, secs), S.quote(id, secs), `${id} ${secs}`);
  }
  assert.deepEqual([...I2V_RATIOS], [...S.RUNWAY_MODELS['gen4.5'].kinds.image_to_video]);
  assert.deepEqual([...I2V_RATIOS], [...S.RUNWAY_MODELS.gen4_turbo.kinds.image_to_video]);
  assert.deepEqual([...T2V_RATIOS], [...S.RUNWAY_MODELS['gen4.5'].kinds.text_to_video]);
  assert.deepEqual([...TARGET_ASPECTS], [...S.TARGET_ASPECTS]);
  assert.deepEqual([...UPLOAD_TYPES].sort(), Object.keys(S.UPLOAD_TYPES).sort());
  assert.equal(R.PROMPT_MAX, S.PROMPT_MAX);
  assert.equal(R.DATA_URI_MAX, S.DATA_URI_MAX);
  assert.equal(R.UPLOAD_MAX, S.UPLOAD_MAX);
  assert.ok(RUNWAY_SECONDS.every((s) => s >= S.DURATION_MIN && s <= S.DURATION_MAX));
  // Veo 3.1 on Runway: the same four ratios and 4/6/8 s on both sides, and the silent rate on the Worker
  for (const id of ['veo3.1', 'veo3.1_fast']) {
    assert.deepEqual([...VEO_RATIOS], [...S.RUNWAY_MODELS[id].kinds.text_to_video], id);
    assert.deepEqual([...VEO_RATIOS], [...S.RUNWAY_MODELS[id].kinds.image_to_video], id);
    assert.deepEqual([...RUNWAY_MODELS[id].seconds], [...S.RUNWAY_MODELS[id].durations], id);
    assert.equal(S.RUNWAY_MODELS[id].creditsNoAudio * 2, S.RUNWAY_MODELS[id] === S.RUNWAY_MODELS['veo3.1'] ? 40 : 20, id);
  }
  // only current ids (gen3a_turbo and gen4_aleph were retired by Runway on 2026-07-30)
  assert.deepEqual(Object.keys(RUNWAY_MODELS).sort(), ['aleph2', 'gen4.5', 'gen4_turbo', 'grok_imagine_1_5', 'grok_imagine_1_5_lite', 'veo3.1', 'veo3.1_fast']);
  // Grok Imagine on Runway: the same per-resolution rates and start-frame credit on both sides
  for (const id of ['grok_imagine_1_5', 'grok_imagine_1_5_lite']) {
    assert.deepEqual({ ...RUNWAY_MODELS[id].rates }, { ...S.RUNWAY_MODELS[id].rates }, id);
    assert.equal(RUNWAY_MODELS[id].still, S.RUNWAY_MODELS[id].stillCredits, id);
    for (const resolution of ['480p', '720p', '1080p']) for (const still of [false, true]) {
      assert.deepEqual(quote(id, 7, { resolution, still }), S.quote(id, 7, true, { resolution, still }), `${id} ${resolution} ${still}`);
    }
    assert.ok(GROK_SECONDS.every((s) => s >= S.RUNWAY_MODELS[id].durationRange[0] && s <= S.RUNWAY_MODELS[id].durationRange[1]), id);
  }
});

test('Grok Imagine on Runway: requests the Worker accepts, the still as is, and quotes by resolution', () => {
  // every request the client builds passes the Worker's own shaping unchanged
  const cases = [
    [{ model: 'grok_imagine_1_5_lite', prompt: 'a lighthouse', aspect: '16:9', secs: 6 }, { kind: 'text_to_video', body: { model: 'grok_imagine_1_5_lite', promptText: 'a lighthouse', ratio: '1280:720', duration: 6 } }],
    [{ model: 'grok_imagine_1_5_lite', prompt: 'x', aspect: '9:16', secs: 10 }, { kind: 'text_to_video', body: { model: 'grok_imagine_1_5_lite', promptText: 'x', ratio: '720:1280', duration: 10 } }],
    [{ model: 'grok_imagine_1_5_lite', prompt: 'x', aspect: '16:9hd', secs: 15 }, { kind: 'text_to_video', body: { model: 'grok_imagine_1_5_lite', promptText: 'x', ratio: '1904:1072', duration: 15 } }],
    [{ model: 'grok_imagine_1_5_lite', prompt: '', still: PNG, aspect: '16:9hd', secs: 4 }, { kind: 'image_to_video', body: { model: 'grok_imagine_1_5_lite', promptImage: PNG, ratio: 'auto_1080p', duration: 4 } }],
    [{ model: 'grok_imagine_1_5', prompt: 'x', aspect: '9:16', secs: 8 }, { kind: 'text_to_video', body: { model: 'grok_imagine_1_5', promptText: 'x', ratio: '9:16', resolution: '720p', duration: 8 } }],
    [{ model: 'grok_imagine_1_5', prompt: 'push in', still: JPEG, aspect: '16:9hd', secs: 6 }, { kind: 'image_to_video', body: { model: 'grok_imagine_1_5', promptText: 'push in', promptImage: JPEG, resolution: '1080p', duration: 6 } }],
  ];
  for (const [input, want] of cases) {
    const r = buildRequest(input);
    assert.deepEqual({ kind: r.kind, body: r.body }, want, JSON.stringify(input).slice(0, 80));
    assert.deepEqual(S.shapeRequest(r.kind, r.body).body, r.body, 'the Worker sends it as built');
  }
  assert.equal(buildRequest({ model: 'grok_imagine_1_5_lite', prompt: 'x'.repeat(3000), secs: 6 }).body.promptText.length, 2500, 'Grok takes 2,500 characters');
  assert.throws(() => buildRequest({ model: 'grok_imagine_1_5', prompt: '' }), (e) => e.status === 400 && /Describe the video/.test(e.message));
  assert.deepEqual([...runwaySecondsFor('grok_imagine_1_5_lite')], [4, 6, 8, 10, 15]);
  assert.deepEqual([runwaySeconds(5, 'grok_imagine_1_5'), runwaySeconds(15, 'grok_imagine_1_5'), runwaySeconds(30, 'grok_imagine_1_5')], [4, 15, 15]);
  assert.equal(quoteNote('grok_imagine_1_5_lite', 6), '≈ 18 credits ($0.18)');
  assert.equal(quoteNote('grok_imagine_1_5', 6, { resolution: '1080p', still: true }), '≈ 175 credits ($1.75)');
  const lite = RUNWAY_VIDEO_MODELS.find((m) => m.id === 'runway:grok_imagine_1_5_lite');
  assert.equal(optionNote(lite, 10, '16:9'), 'Grok Imagine 1.5 Lite (Runway) · 10 s ≈ 30 credits ($0.30) · 720p');
  assert.equal(optionNote(lite, 10, '16:9hd'), 'Grok Imagine 1.5 Lite (Runway) · 10 s ≈ 140 credits ($1.40) · 1080p');
  assert.deepEqual(grokShape('grok_imagine_1_5', { aspect: '16:9', still: true }), { ratio: null, resolution: '720p' });
  assert.equal(RUNWAY_MODELS.grok_imagine_1_5.hd, true);
});

test('Veo 3.1 on Runway: requests in its own ratios and lengths, the still as is, and a quote per second with sound', () => {
  assert.deepEqual(buildRequest({ model: 'veo3.1', prompt: 'a lighthouse', aspect: '16:9', secs: 8 }),
    { kind: 'text_to_video', body: { model: 'veo3.1', promptText: 'a lighthouse', ratio: '1280:720', duration: 8 }, ratio: '1280:720', seconds: 8, note: 'text → video' });
  assert.equal(buildRequest({ model: 'veo3.1', prompt: 'x', aspect: '9:16', secs: 4 }).body.ratio, '720:1280');
  assert.equal(buildRequest({ model: 'veo3.1_fast', prompt: 'x', aspect: '16:9hd', secs: 6 }).body.ratio, '1920:1080');
  const i2v = buildRequest({ model: 'veo3.1_fast', prompt: 'slow push in', still: PNG, stillSize: { w: 720, h: 1280 }, aspect: '16:9', secs: 10 });
  assert.deepEqual(i2v.body, { model: 'veo3.1_fast', promptText: 'slow push in', promptImage: PNG, ratio: '720:1280', duration: 8 }); // portrait still; 10 s → 8
  assert.equal(buildRequest({ model: 'veo3.1', prompt: 'x', still: PNG, ratio: '1080:1920', secs: 6 }).body.ratio, '1080:1920');
  assert.throws(() => buildRequest({ model: 'veo3.1', prompt: '' }), (e) => e.status === 400 && /Describe the video/.test(e.message));
  assert.deepEqual([runwaySeconds(2, 'veo3.1'), runwaySeconds(5, 'veo3.1'), runwaySeconds(6, 'veo3.1'), runwaySeconds(10, 'veo3.1')], [4, 4, 6, 8]);
  assert.deepEqual([...runwaySecondsFor('veo3.1')], [4, 6, 8]);
  assert.deepEqual([...runwaySecondsFor('gen4.5')], [...RUNWAY_SECONDS]);
  assert.equal(veoRatio({ w: 1000, h: 500, aspect: '16:9hd' }), '1920:1080');
  assert.equal(quoteNote('veo3.1', 4), '≈ 160 credits ($1.60)');
  assert.equal(quoteNote('veo3.1_fast', 8), '≈ 120 credits ($1.20)');
  const entry = RUNWAY_VIDEO_MODELS.find((m) => m.id === 'runway:veo3.1');
  assert.equal(optionNote(entry, 10), 'Veo 3.1 (Runway) · 8 s ≈ 320 credits ($3.20)');
});

test('menu entries: runway:<model> ids, never Auto, and the meta line reads runway:gen4.5', () => {
  assert.deepEqual(RUNWAY_VIDEO_MODELS.map((m) => m.id), ['runway:gen4.5', 'runway:gen4_turbo', 'runway:veo3.1', 'runway:veo3.1_fast', 'runway:grok_imagine_1_5_lite', 'runway:grok_imagine_1_5']);
  for (const m of [...RUNWAY_VIDEO_MODELS, RUNWAY_EDIT_MODEL]) {
    assert.equal(m.auto, false, m.id);
    assert.equal(runwayModelOf(m.id), m.runway);
    assert.ok(isRunwayId(m.id));
    // app.js shortModel strips only (anthropic|openai|gemini|zai|deepseek|meta): so the meta line shows the full id
    assert.equal(m.id.replace(/^(anthropic|openai|gemini|zai|deepseek|meta):/, '').split('/').pop(), m.id);
  }
  assert.equal(RUNWAY_EDIT_MODEL.id, 'runway:aleph2');
  assert.equal(runwayModelOf('runway:seedance2'), null);
  assert.equal(runwayModelOf('gemini:gemini-omni-1.1-flash'), null);
  assert.equal(runwayModelOf('runway:veo3.1'), 'veo3.1');
  assert.match(POWERED_BY, /href="https:\/\/runway\.com" target="_blank" rel="noopener">Powered by Runway</);
});

// ── pure helpers ──

test('ratioFor picks the nearest allowed ratio', () => {
  assert.equal(ratioFor(4, 5), '832:1104');
  assert.equal(ratioFor(1024, 1280), '832:1104');
  assert.equal(ratioFor(16, 9), '1280:720');
  assert.equal(ratioFor(1, 1), '960:960');
  assert.equal(ratioFor(9, 16), '720:1280');
  assert.equal(ratioFor(4, 3), '1104:832');
  assert.equal(ratioFor(21, 9), '1584:672');
  assert.equal(ratioFor(0, 0), '1280:720');
  assert.equal(ratioFor(NaN, 5), '1280:720');
  assert.equal(ratioFor(4, 5, 'text_to_video'), '720:1280');
  assert.equal(ratioFor(1, 1, 'text_to_video'), '1280:720');
  assert.deepEqual(ratioBox('832:1104'), [832, 1104]);
  assert.equal(ratioBox('x'), null);
  assert.equal(t2vRatio('9:16'), '720:1280');
  assert.equal(t2vRatio('16:9hd'), '1280:720');
});

test('stillPlan: stills outside Runway’s input range are centre-cropped to the clip’s shape (phone screenshots, panoramas)', () => {
  // Runway refuses a prompt image outside 0.5–2 (gen4.5) / 0.5–2.358 (gen4_turbo) instead of cropping it
  assert.deepEqual(INPUT_ASPECT, { 'gen4.5': [0.5, 2], gen4_turbo: [0.5, 2.358] });
  const cases = [
    // [w, h, model, ratio]
    [1080, 2400, 'gen4.5', '720:1280'], [1179, 2556, 'gen4.5', '720:1280'], [1080, 2400, 'gen4_turbo', '720:1280'],
    [3000, 1000, 'gen4.5', '1584:672'], [3000, 1000, 'gen4_turbo', '1584:672'], [4000, 1000, 'gen4.5', '1584:672'],
    [1024, 1280, 'gen4.5', '832:1104'], [1500, 1000, 'gen4_turbo', '1104:832'], [37, 120, 'gen4.5', '720:1280'], [500, 101, 'gen4_turbo', '1584:672'],
  ];
  for (const [w, h, model, ratio] of cases) {
    const p = stillPlan(w, h, model);
    assert.equal(p.ratio, ratio, `${w}×${h}`);
    assert.ok(p.crop, `${w}×${h} ${model} should be cropped`);
    const { x, y, w: cw, h: ch } = p.crop;
    const [lo, hi] = INPUT_ASPECT[model];
    assert.ok(cw / ch >= lo && cw / ch <= hi, `${w}×${h} ${model}: ${cw}×${ch} = ${cw / ch}`);
    assert.ok(x >= 0 && y >= 0 && x + cw <= w && y + ch <= h, 'inside the image');
    assert.ok(Math.abs(x - (w - cw - x)) <= 1 && Math.abs(y - (h - ch - y)) <= 1, 'centred');
    assert.ok(cw === w || ch === h, 'only one side is cut');
  }
  // the 1080×2400 screenshot becomes 1080×1920 (9:16), cut evenly top and bottom
  assert.deepEqual(stillPlan(1080, 2400, 'gen4.5').crop, { x: 0, y: 240, w: 1080, h: 1920 });
  // a 3:1 panorama: cut to ~2:1 for gen4.5 (Runway trims the rest to 1584:672), to ~2.33:1 for Turbo
  assert.ok(stillPlan(3000, 1000, 'gen4.5').crop.w / 1000 <= 2);
  assert.ok(stillPlan(3000, 1000, 'gen4_turbo').crop.w / 1000 > 2.3);
  // already the clip's shape: left alone
  for (const [w, h] of [[1280, 720], [720, 1280], [960, 960], [1104, 832], [1600, 1200]]) assert.equal(stillPlan(w, h, 'gen4.5').crop, null, `${w}×${h}`);
  assert.deepEqual(stillPlan(0, 0), { ratio: '1280:720', crop: null });
  // the chosen ratio goes into the request even when the cut still is nearer another one (2:1 → 1584:672, not 16:9)
  const r = buildRequest({ model: 'gen4.5', prompt: 'pan across', still: JPEG, stillSize: { w: 1980, h: 1000 }, ratio: '1584:672', secs: 4 });
  assert.equal(r.body.ratio, '1584:672');
  assert.equal(S.shapeRequest(r.kind, structuredClone(r.body)).body.ratio, '1584:672');
  assert.equal(buildRequest({ model: 'gen4.5', prompt: 'x', still: JPEG, stillSize: { w: 1980, h: 1000 }, ratio: '999:1' }).body.ratio, '1280:720', 'an unknown ratio is ignored');
});

test('quotes: per-second credits, Aleph’s 56-credit minimum, whole seconds', () => {
  assert.deepEqual(quote('aleph2', 1.2), { credits: 56, usd: 0.56 });
  assert.deepEqual(quote('aleph2', 12.4), { credits: 364, usd: 3.64 });
  assert.deepEqual(quote('gen4_turbo', 5), { credits: 25, usd: 0.25 });
  assert.deepEqual(quote('gen4.5', 4), { credits: 48, usd: 0.48 });
  assert.equal(quote('gen4.5', 0), null);
  assert.equal(quote('veo', 4), null);
  assert.equal(quoteNote('gen4.5', 10), '≈ 120 credits ($1.20)');
  assert.equal(quoteNote('x', 1), '');
  assert.equal(creditsNote(1), '1 credit ($0.01)');
  assert.equal(creditsNote(4210), '4,210 credits ($42.10)');
  assert.equal(creditsNote(NaN), '');
  assert.equal(R.optionNote(RUNWAY_VIDEO_MODELS[0], 4), 'Runway Gen-4.5 · 4 s ≈ 48 credits ($0.48)');
  assert.equal(R.optionNote(RUNWAY_VIDEO_MODELS[1], 10), 'Runway Gen-4 Turbo · 10 s ≈ 50 credits ($0.50) · attach a still');
  assert.equal(R.optionNote({ id: 'gemini:veo-3.1-lite-generate-preview' }, 4), '');
});

test('lengths: Runway 2–10 s, back to Veo’s 4/6/8', () => {
  assert.deepEqual([2, 4, 6, 8, 10, 3, 0, 11, 'x', undefined].map(runwaySeconds), [2, 4, 6, 8, 10, 3, 5, 5, 5, 5]);
  assert.deepEqual([2, 4, 6, 8, 10].map(veoSeconds), [4, 4, 6, 8, 8]);
});

test('alephProblem: 2–30 s, 95 MB, Runway’s types', () => {
  assert.equal(alephProblem({ duration: 1.9, size: 1e6, type: 'video/mp4' }), 'too-short');
  assert.equal(alephProblem({ duration: 30.5, size: 1e6, type: 'video/mp4' }), 'too-long');
  assert.equal(alephProblem({ duration: 10, size: 96 * 1024 * 1024, type: 'video/mp4' }), 'too-large');
  assert.equal(alephProblem({ duration: 10, size: 1e6, type: 'video/x-msvideo' }), 'type');
  assert.equal(alephProblem({ duration: 10, size: 1e6, type: '' }), 'type');
  assert.equal(alephProblem({ duration: 10, size: 1e6, type: 'video/quicktime' }), null);
  assert.equal(alephProblem({ duration: 0, size: 1e6, mime: 'video/webm' }), null); // length unknown yet
  for (const k of ['too-short', 'too-long', 'too-large', 'type']) assert.ok(ALEPH_PROBLEM_TEXT[k]);
});

test('clampPrompt keeps prompts within 1000 UTF-16 units, cutting at a word', () => {
  assert.equal(clampPrompt('  hi  '), 'hi');
  const long = 'word '.repeat(400);
  const c = clampPrompt(long);
  assert.ok(c.length <= 1000 && c.endsWith('word'), c.slice(-20));
  const emoji = '😀'.repeat(600);
  const e = clampPrompt(emoji);
  assert.ok(e.length <= 1000 && !/[\ud800-\udbff]$/.test(e));
});

test('buildRequest: what Video mode sends, and every body passes the Worker’s own check', () => {
  const cases = [
    [{ model: 'gen4.5', prompt: 'A paper boat', aspect: '16:9', secs: 4 }, 'text_to_video', { model: 'gen4.5', promptText: 'A paper boat', ratio: '1280:720', duration: 4 }],
    [{ model: 'gen4.5', prompt: 'A paper boat', aspect: '9:16', secs: 10 }, 'text_to_video', { model: 'gen4.5', promptText: 'A paper boat', ratio: '720:1280', duration: 10 }],
    [{ model: 'gen4.5', prompt: 'A paper boat', aspect: '16:9hd', secs: 8 }, 'text_to_video', { model: 'gen4.5', promptText: 'A paper boat', ratio: '1280:720', duration: 8 }],
    [{ model: 'gen4.5', prompt: 'push in', still: JPEG, stillSize: { w: 1024, h: 1280 }, secs: 6 }, 'image_to_video', { model: 'gen4.5', promptText: 'push in', promptImage: JPEG, ratio: '832:1104', duration: 6 }],
    [{ model: 'gen4_turbo', prompt: '', still: PNG, stillSize: { w: 1280, h: 720 }, secs: 2 }, 'image_to_video', { model: 'gen4_turbo', promptImage: PNG, ratio: '1280:720', duration: 2 }],
    [{ model: 'gen4.5', prompt: 'x', secs: 7, seed: 42 }, 'text_to_video', { model: 'gen4.5', promptText: 'x', ratio: '1280:720', duration: 7, seed: 42 }],
    [{ model: 'aleph2', prompt: 'make it watercolor', videoUri: 'runway://upload/abc123', framing: '3:4', seconds: 12.4 }, 'video_to_video', { model: 'aleph2', promptText: 'make it watercolor', videoUri: 'runway://upload/abc123', targetAspectRatio: '3:4', seconds: 12.4 }],
    [{ model: 'aleph2', prompt: 'make it watercolor', videoUri: 'runway://upload/abc123', framing: 'keep' }, 'video_to_video', { model: 'aleph2', promptText: 'make it watercolor', videoUri: 'runway://upload/abc123' }],
  ];
  for (const [input, kind, body] of cases) {
    const r = buildRequest(input);
    assert.equal(r.kind, kind, JSON.stringify(input));
    assert.deepEqual(r.body, body, JSON.stringify(input));
    const shaped = S.shapeRequest(r.kind, structuredClone(r.body)); // throws if the Worker would refuse it
    assert.equal(shaped.model, input.model);
  }
  assert.equal(buildRequest(cases[3][0]).note, 'image → video');
  assert.equal(buildRequest(cases[0][0]).note, 'text → video');
  assert.equal(buildRequest(cases[6][0]).seconds, 12.4);
  assert.deepEqual(S.shapeRequest('video_to_video', buildRequest(cases[6][0]).body).seconds, 12.4);
});

test('buildRequest refuses what Runway would refuse, in words for people', () => {
  const bad = [
    [{ model: 'gen4_turbo', prompt: 'a cat' }, 400, /animates a still image — attach one, or pick Runway Gen-4.5/],
    [{ model: 'gen4.5', prompt: '' }, 400, /Describe the video/],
    [{ model: 'gen4.5', prompt: '', still: PNG, stillSize: { w: 1, h: 1 } }, 400, /Describe the video/],
    [{ model: 'gen4.5', prompt: 'x', still: 'data:image/gif;base64,AAAA' }, 400, /JPEG, PNG or WebP/],
    [{ model: 'gen4.5', prompt: 'x', still: `data:image/jpeg;base64,${'A'.repeat(R.DATA_URI_MAX)}` }, 413, /too large for Runway/],
    [{ model: 'aleph2', prompt: 'x' }, 400, /Attach a clip/],
    [{ model: 'aleph2', prompt: 'x', videoUri: 'https://example.com/a.mp4' }, 400, /Attach a clip/],
    [{ model: 'aleph2', prompt: '', videoUri: 'runway://upload/abc123' }, 400, /Describe the edit/],
    [{ model: 'seedance2', prompt: 'x' }, 400, /isn’t available/],
  ];
  for (const [input, status, re] of bad) {
    assert.throws(() => buildRequest(input), (e) => e.status === status && re.test(e.message) && !/passcode/i.test(e.message), JSON.stringify(input).slice(0, 80));
  }
  // an over-long prompt is trimmed, not refused
  const r = buildRequest({ model: 'gen4.5', prompt: 'word '.repeat(400) });
  assert.ok(r.body.promptText.length <= 1000);
});

test('pollDelay: 5–7.5 s between polls, never faster; backs off (with up to 50% jitter) after 429/5xx', () => {
  for (const r of [0, 0.25, 0.5, 0.999]) {
    const d = pollDelay({ random: () => r });
    assert.ok(d >= 5000 && d < 7500, String(d));
  }
  assert.equal(pollDelay({ hintMs: 1000, random: () => 0 }), 5000, 'a smaller server hint never speeds polling up');
  assert.equal(pollDelay({ hintMs: 9000, random: () => 0 }), 9000);
  const backoff = [1, 2, 3, 4, 5, 9].map((failures) => pollDelay({ failures, random: () => 0 }));
  assert.deepEqual(backoff, [10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
  assert.equal(pollDelay({ failures: 1, random: () => 1 }), 15_000);
  assert.equal(pollDelay({ failures: 1, retryAfter: 30, random: () => 0 }), 30_000);
  assert.equal(pollDelay({ failures: 1, retryAfter: 999, random: () => 0 }), 60_000);
  for (let i = 0; i < 200; i++) assert.ok(pollDelay({ failures: i % 7, random: Math.random }) >= 5000);
});

test('statusText: the pending card’s line', () => {
  assert.equal(statusText({ status: 'PENDING' }), 'Queued at Runway');
  assert.match(statusText({ status: 'THROTTLED' }), /^Queued at Runway · waiting/);
  assert.equal(statusText({ status: 'RUNNING', progress: 0.42 }), 'Filming with Runway · 42%');
  assert.equal(statusText({ status: 'RUNNING' }), 'Filming with Runway');
  assert.equal(statusText({ status: 'RUNNING', progress: 3 }), 'Filming with Runway');
  assert.equal(statusText({ status: 'SUCCEEDED' }), 'Downloading from Runway');
  assert.equal(statusText({ status: 'FAILED' }), '');
  assert.equal(statusText({ status: 'NEW_THING' }), 'Working at Runway');
});

// errorKind in app.js: 400 + /safety|filtered|rephras/ → 'filtered'; 503 → 'busy'; no "passcode" (it would sign out).
test('failureOf: Runway failure codes → statuses and words app.js classifies correctly', () => {
  const safety = failureOf({ status: 'FAILED', failureCode: 'SAFETY.INPUT.TEXT', cost: { credits: 48 } });
  assert.equal(safety.status, 400);
  assert.match(safety.message, /safety filter blocked this — try rephrasing\. Runway still charged \$0\.48 for this attempt\./);
  assert.equal(safety.credits, 48);
  assert.equal(failureOf({ failureCode: 'INPUT_PREPROCESSING.SAFETY.TEXT' }).status, 400);
  assert.match(failureOf({ failureCode: 'SAFETY.OUTPUT.VIDEO', cost: { credits: 0 } }).message, /rephrasing\.$/);
  assert.match(failureOf({ failureCode: 'ASSET.INVALID' }).message, /2–30 s at 30 fps/);
  assert.match(failureOf({ failureCode: 'ASSET.INVALID' }).message, /between 1:2 and 2:1/);
  assert.match(failureOf({ failureCode: 'INTERNAL.BAD_OUTPUT.01' }).message, /without logos or text/);
  for (const code of ['THIRD_PARTY.UNAVAILABLE', 'INTERNAL', 'INPUT_PREPROCESSING.INTERNAL', null, undefined]) {
    const e = failureOf({ failureCode: code });
    assert.equal(e.status, 503, String(code));
    assert.match(e.message, /hiccup/);
  }
  for (const code of ['SAFETY.INPUT.TEXT', 'ASSET.INVALID', 'INTERNAL.BAD_OUTPUT.01', 'INTERNAL']) {
    const e = failureOf({ failureCode: code });
    assert.equal(e.code, 'runway_failed');
    assert.ok(!/passcode/i.test(e.message));
  }
});

// Runway bills blocked and failed generations, so the charge note is the normal case — it must not turn the card into
// "A provider key needs attention" (errorKind reads credit/billing/quota… as an account problem before 'filtered').
test('failureOf: a charged failure keeps its card — Try rephrasing, busy or error, never the key card', () => {
  const want = { 'SAFETY.INPUT.TEXT': 'filtered', 'SAFETY.OUTPUT.VIDEO': 'filtered', 'INPUT_PREPROCESSING.SAFETY.TEXT': 'filtered', INTERNAL: 'busy', 'THIRD_PARTY.UNAVAILABLE': 'busy', 'ASSET.INVALID': 'error', 'INTERNAL.BAD_OUTPUT.01': 'error' };
  for (const [code, kind] of Object.entries(want)) {
    for (const credits of [0, 1, 60, 4210]) {
      const e = failureOf({ status: 'FAILED', failureCode: code, cost: { credits } });
      assert.doesNotMatch(e.message, /workspace|api key|credit|billing|quota|balance|permission|not enabled|organization|passcode|key on the server|isn[’']t allowed/i, `${code} ${credits}`);
      if (appErrorKind) assert.equal(appErrorKind(e.message, e.status, e.code), kind, `${code} with ${credits} credits: ${e.message}`);
    }
  }
});

test('mentionsRunway: the AI company, not the catwalk or the airport', () => {
  const yes = ['Create a short video to test runway capabilities', 'test runway', 'use runway for this please', 'Let Runway animate it', 'Make this with Runway Gen-4.5',
    'gen-4.5 video of a cat', 'runwayml test', 'try Runway', 'Runway’s gen4 turbo please', 'a fox in snow via runway', 'aleph2 edit'];
  const no = ['A model walking down the runway in Paris', 'Airplane landing on a runway at dusk', 'Fashion week runway show', 'Runway show at Milan', 'Video of the Runway at JFK',
    'A jet on runway 27', 'Waves on a beach', 'A runway model in red', 'jets taking off, use runway lights', '', null];
  for (const s of yes) assert.equal(mentionsRunway(s), true, s);
  for (const s of no) assert.equal(mentionsRunway(s), false, String(s));
});

test('runwayHint: offers the switch only when Runway is usable and not already picked — it never switches', () => {
  const p = 'Create a short video to test runway capabilities';
  assert.deepEqual(runwayHint(p, { current: 'gemini:veo-3.1-lite-generate-preview', ready: true }), { id: 'runway:gen4.5', model: 'gen4.5', label: 'Use Runway Gen-4.5?' });
  assert.equal(runwayHint(p, { current: 'gemini:veo-3.1-lite-generate-preview', ready: false }), null);
  assert.equal(runwayHint(p, { current: 'runway:gen4.5', ready: true }), null);
  assert.equal(runwayHint(p, { current: 'runway:gen4_turbo', ready: true }), null);
  assert.equal(runwayHint('Waves on a beach', { current: '', ready: true }), null);
  assert.equal(runwayHint('animate this with runway turbo', { current: '', ready: true, hasImage: true }).id, 'runway:gen4_turbo');
  assert.equal(runwayHint('animate this with runway turbo', { current: '', ready: true }).id, 'runway:gen4.5');
  assert.equal(runwayHint('runway aleph: make it snow', { current: '', ready: true, edit: true }).id, 'runway:aleph2');
});

test('connectionRow: Settings → Connections wording', () => {
  assert.deepEqual(connectionRow({ configured: false, passcode: true }), { on: false, state: 'Not set up', detail: 'set RUNWAYML_API_SECRET' });
  assert.deepEqual(connectionRow({ configured: false, passcode: false }), { on: false, state: 'Not set up', detail: 'needs the server passcode' });
  assert.equal(connectionRow({ configured: true, passcode: false }).state, 'Needs passcode');
  assert.deepEqual(connectionRow({ configured: true, passcode: true, account: { ok: true, creditBalance: 4210, models: { 'gen4.5': { maxConcurrentGenerations: 1 } } } }),
    { on: true, state: 'Connected', detail: '4,210 credits ($42.10) · 1 video at a time' });
  assert.equal(connectionRow({ configured: true, passcode: true, account: { ok: true, creditBalance: 0, models: {} } }).detail, '0 credits ($0.00)');
  assert.deepEqual(connectionRow({ configured: true, passcode: true, account: { ok: false, code: 'runway_key' } }), { on: false, state: 'Key rejected', detail: 'check RUNWAYML_API_SECRET at dev.runway.com' });
  assert.equal(connectionRow({ configured: true, passcode: true, account: { ok: false, status: 0 } }).state, 'Connected');
  assert.equal(connectionRow({ configured: true, passcode: true }).state, 'Connected');
});

// ── the task runner ──

const task = (status, extra = {}) => ({ id: ID, status, outputs: status === 'SUCCEEDED' ? 1 : 0, ...(status === 'SUCCEEDED' || status === 'FAILED' ? {} : { pollAfterMs: 5000 }), ...extra });
const MP4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50]);

test('runwayVideo: create → poll every ≥ 5 s → download; the pending card follows along', async () => {
  const seq = [task('PENDING'), task('THROTTLED'), task('RUNNING', { progress: 0.1 }), task('RUNNING', { progress: 0.7 }), task('SUCCEEDED', { cost: { credits: 48, usd: 0.48 } })];
  let n = 0;
  mockFetch([
    [/^POST \/api\/runway\/generate\/text_to_video$/, () => reply(200, { id: ID, estimatedCost: { credits: 48, usd: 0.48 }, pollAfterMs: 5000 })],
    [new RegExp(`^GET /api/runway/task/${ID}$`), () => reply(200, seq[n++])],
    [new RegExp(`^GET /api/runway/output/${ID}\\?i=0$`), () => new Response(MP4, { headers: { 'content-type': 'application/octet-stream' } })],
  ]);
  const { waits, sleep } = fakeSleep();
  const lines = [], tasks = [];
  const req = buildRequest({ model: 'gen4.5', prompt: 'A paper boat', aspect: '16:9', secs: 4 });
  const out = await runwayVideo(req, { apiHeaders: headers, sleep, random: () => 0.5, onStatus: (t) => lines.push(t), onTask: (id) => tasks.push(id) });
  assert.equal(out.id, ID);
  assert.equal(out.credits, 48);
  assert.equal(out.estimate, 48);
  assert.equal(out.blob.type, 'video/mp4', 'stored as video/mp4 so backups restore it');
  assert.deepEqual(new Uint8Array(await out.blob.arrayBuffer()), MP4);
  assert.deepEqual(tasks, [ID]);
  assert.equal(waits.length, 5);
  assert.ok(waits.every((w) => w >= 5000 && w < 7500), waits.join());
  assert.deepEqual(lines, ['Sending to Runway', 'Queued at Runway', 'Queued at Runway', 'Queued at Runway · waiting for a free slot', 'Filming with Runway · 10%', 'Filming with Runway · 70%', 'Downloading from Runway', 'Downloading from Runway']);
  assert.deepEqual(calls[0].json, req.body);
  for (const c of calls) {
    assert.equal(c.headers.get('x-app-pass'), 'pw');
    assert.ok(!/runwayml\.com|cloudfront/.test(c.url), 'the browser only talks to Atelier');
  }
  assert.equal(calls[1].headers.get('content-type'), null, 'GETs carry no JSON content-type');
  assert.deepEqual(slotState(), { busy: 0, waiting: 0 });
});

test('runwayVideo: a FAILED task throws the friendly error and is not retried', async () => {
  mockFetch([
    [/^POST \/api\/runway\/generate\//, () => reply(200, { id: ID, estimatedCost: { credits: 48 } })],
    [/^GET \/api\/runway\/task\//, () => reply(200, task('FAILED', { failureCode: 'SAFETY.INPUT.TEXT', failure: 'blocked', cost: { credits: 48 } }))],
  ]);
  const { sleep } = fakeSleep();
  await assert.rejects(runwayVideo(buildRequest({ model: 'gen4.5', prompt: 'x' }), { apiHeaders: headers, sleep }),
    (e) => e.status === 400 && /safety filter/.test(e.message) && e.task === ID && !e.resumable);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
  assert.equal(calls.filter((c) => c.method === 'DELETE').length, 0);
});

test('waitForTask: 429/5xx/network drops back off (honouring retry-after), then carry on', async () => {
  const answers = [() => reply(429, { error: 'slow down', code: 'runway_limit' }, { 'retry-after': '20' }), () => reply(503, { error: 'busy' }), () => { throw new TypeError('Failed to fetch'); }, () => reply(200, task('RUNNING', { progress: 0.5 })), () => reply(200, task('SUCCEEDED'))];
  let n = 0;
  mockFetch([[/^GET \/api\/runway\/task\//, () => answers[n++]()]]);
  const { waits, sleep } = fakeSleep();
  const t = await waitForTask(ID, { apiHeaders: headers, sleep, random: () => 0 });
  assert.equal(t.status, 'SUCCEEDED');
  assert.deepEqual(waits, [5000, 20_000, 20_000, 40_000, 5000]);
});

test('waitForTask: hard errors stop at once; gone is 404; too slow keeps the task resumable', async () => {
  mockFetch([[/^GET \/api\/runway\/task\//, () => reply(403, { error: 'Runway rejected the server’s API key', code: 'runway_key' })]]);
  await assert.rejects(waitForTask(ID, { apiHeaders: headers, sleep: fakeSleep().sleep }), (e) => e.status === 403 && e.code === 'runway_key');
  assert.equal(calls.length, 1);

  mockFetch([[/^GET \/api\/runway\/task\//, () => reply(404, { error: 'gone', code: 'runway_gone' })]]);
  await assert.rejects(waitForTask(ID, { apiHeaders: headers, sleep: fakeSleep().sleep }), (e) => e.status === 404 && e.code === 'runway_gone');

  mockFetch([[/^GET \/api\/runway\/task\//, () => reply(200, task('RUNNING', { progress: 0.2 }))]]);
  let clock = 0;
  const { sleep } = fakeSleep();
  await assert.rejects(waitForTask(ID, { apiHeaders: headers, sleep: async (ms) => { clock += ms; await sleep(ms); }, now: () => clock, random: () => 0 }),
    (e) => e.status === 504 && e.code === 'runway_slow' && e.resumable === true && /won’t start a new video/.test(e.message));
  assert.ok(calls.length >= 200 && calls.length <= 241, String(calls.length)); // 20 min / 5 s

  let k = 0;
  mockFetch([[/^GET \/api\/runway\/task\//, () => { k++; return reply(503, { error: 'busy' }); }]]);
  await assert.rejects(waitForTask(ID, { apiHeaders: headers, sleep: fakeSleep().sleep, random: () => 0 }), (e) => e.status === 503 && e.resumable === true);
  assert.equal(k, RUNWAY_TIMING.failures + 1);
});

test('runwayVideo: Stop cancels the task at Runway (DELETE) and rethrows the AbortError', async () => {
  const ctrl = new AbortController();
  mockFetch([
    [/^POST \/api\/runway\/generate\//, () => reply(200, { id: ID, estimatedCost: { credits: 48 } })],
    [/^GET \/api\/runway\/task\//, () => { ctrl.abort(); return reply(200, task('RUNNING', { progress: 0.3 })); }],
    [/^DELETE \/api\/runway\/task\//, () => reply(200, { ok: true })],
  ]);
  const { sleep } = fakeSleep();
  await assert.rejects(runwayVideo(buildRequest({ model: 'gen4.5', prompt: 'x' }), { apiHeaders: headers, sleep, signal: ctrl.signal }), (e) => e.name === 'AbortError');
  await new Promise((r) => setTimeout(r, 10));
  const del = calls.find((c) => c.method === 'DELETE');
  assert.ok(del, 'no cancel was sent');
  assert.equal(del.url, `/api/runway/task/${ID}`);
  assert.equal(del.init.keepalive, true);
  assert.equal(del.headers.get('x-app-pass'), 'pw');
  assert.deepEqual(slotState(), { busy: 0, waiting: 0 });
});

test('runwayVideo: resume picks up an earlier task (no second charge); a gone one starts afresh', async () => {
  mockFetch([
    [new RegExp(`^GET /api/runway/task/${ID}$`), () => reply(200, task('SUCCEEDED', { cost: { credits: 24 } }))],
    [/^GET \/api\/runway\/output\//, () => new Response(MP4, { headers: { 'content-type': 'video/mp4' } })],
  ]);
  const { waits, sleep } = fakeSleep();
  const out = await runwayVideo(buildRequest({ model: 'gen4.5', prompt: 'x' }), { apiHeaders: headers, sleep, resume: ID });
  assert.equal(out.id, ID);
  assert.equal(out.credits, 24);
  assert.equal(waits.length, 0, 'a resume polls at once');
  assert.ok(!calls.some((c) => c.method === 'POST'), 'resuming created a new task');

  const NEW = '0b7b0c1d-2e3f-4a5b-8c6d-7e8f9a0b1c2e';
  mockFetch([
    [new RegExp(`^GET /api/runway/task/${ID}$`), () => reply(404, { error: 'gone', code: 'runway_gone' })],
    [/^POST \/api\/runway\/generate\//, () => reply(200, { id: NEW, estimatedCost: { credits: 48 } })],
    [new RegExp(`^GET /api/runway/task/${NEW}$`), () => reply(200, task('SUCCEEDED', { id: NEW, cost: { credits: 48 } }))],
    [/^GET \/api\/runway\/output\//, () => new Response(MP4, { headers: { 'content-type': 'video/mp4' } })],
  ]);
  const ids = [];
  const again = await runwayVideo(buildRequest({ model: 'gen4.5', prompt: 'x' }), { apiHeaders: headers, sleep: fakeSleep().sleep, resume: ID, onTask: (id) => ids.push(id) });
  assert.equal(again.id, NEW);
  assert.deepEqual(ids, [NEW]);
});

test('runwayVideo: a dropped download keeps the task for Try again', async () => {
  mockFetch([
    [/^POST \/api\/runway\/generate\//, () => reply(200, { id: ID, estimatedCost: { credits: 48 } })],
    [/^GET \/api\/runway\/task\//, () => reply(200, task('SUCCEEDED', { cost: { credits: 48 } }))],
    [/^GET \/api\/runway\/output\//, () => { throw new TypeError('Failed to fetch'); }],
  ]);
  await assert.rejects(runwayVideo(buildRequest({ model: 'gen4.5', prompt: 'x' }), { apiHeaders: headers, sleep: fakeSleep().sleep }),
    (e) => e.status === 0 && e.resumable === true && e.task === ID);
  assert.ok(!calls.some((c) => c.method === 'DELETE'), 'a finished task must not be deleted before it is saved');
});

test('runwayVideo: any download failure after SUCCEEDED keeps the paid task — Try again only downloads it', async () => {
  const outcomes = [
    () => reply(502, { error: 'Downloading the Runway video failed (503) — try again.', code: 'runway_failed' }),
    () => reply(502, { error: 'Downloading the Runway video failed — try again.', code: 'runway_unreachable' }),
    () => reply(503, { error: 'Runway is busy right now — try again in a moment.', code: 'runway_busy' }, { 'retry-after': '30' }),
    () => reply(524, '<html>timeout</html>'),
    () => reply(429, { error: 'Runway is limiting this account right now', code: 'runway_limit' }),
    () => reply(401, { error: 'Enter your passcode to use Atelier.' }),
  ];
  for (const outcome of outcomes) {
    mockFetch([
      [/^POST \/api\/runway\/generate\//, () => reply(200, { id: ID, estimatedCost: { credits: 48 } })],
      [/^GET \/api\/runway\/task\//, () => reply(200, task('SUCCEEDED', { cost: { credits: 48 } }))],
      [/^GET \/api\/runway\/output\//, outcome],
    ]);
    const err = await runwayVideo(buildRequest({ model: 'gen4.5', prompt: 'x' }), { apiHeaders: headers, sleep: fakeSleep().sleep }).catch((e) => e);
    assert.equal(err.resumable, true, `${err.status} ${err.message}`);
    assert.equal(err.task, ID);
    assert.match(err.message, /won’t make \(or charge for\) a new video/);
    assert.ok(!calls.some((c) => c.method === 'DELETE'), 'a paid video must not be deleted');
  }
  // …and Try again (resume) downloads that same task: no second POST
  mockFetch([
    [new RegExp(`^GET /api/runway/task/${ID}$`), () => reply(200, task('SUCCEEDED', { cost: { credits: 48 } }))],
    [/^GET \/api\/runway\/output\//, () => new Response(MP4, { headers: { 'content-type': 'video/mp4' } })],
  ]);
  const out = await runwayVideo(buildRequest({ model: 'gen4.5', prompt: 'x' }), { apiHeaders: headers, sleep: fakeSleep().sleep, resume: ID });
  assert.equal(out.id, ID);
  assert.ok(!calls.some((c) => c.method === 'POST'));
  // gone for good (deleted, expired, no output, too large): not resumable
  for (const [status, code] of [[404, 'runway_gone'], [404, 'runway_no_output'], [502, 'runway_too_large']]) {
    mockFetch([
      [/^POST \/api\/runway\/generate\//, () => reply(200, { id: ID, estimatedCost: { credits: 48 } })],
      [/^GET \/api\/runway\/task\//, () => reply(200, task('SUCCEEDED'))],
      [/^GET \/api\/runway\/output\//, () => reply(status, { error: 'nope', code })],
    ]);
    const e = await runwayVideo(buildRequest({ model: 'gen4.5', prompt: 'x' }), { apiHeaders: headers, sleep: fakeSleep().sleep }).catch((x) => x);
    assert.equal(e.code, code);
    assert.ok(!e.resumable, code);
  }
});

test('runwayVideo: Stop while resuming an earlier task cancels that task (DELETE) and keeps it for Try again', async () => {
  const ctrl = new AbortController();
  mockFetch([
    [new RegExp(`^GET /api/runway/task/${ID}$`), () => reply(200, task('RUNNING', { progress: 0.2 }))],
    [/^DELETE \/api\/runway\/task\//, () => reply(200, { ok: true, gone: false })],
  ]);
  const sleep = async (ms, signal) => { ctrl.abort(); if (signal?.aborted) throw new DOMException('Aborted', 'AbortError'); };
  const err = await runwayVideo(buildRequest({ model: 'gen4.5', prompt: 'x' }), { apiHeaders: headers, sleep, signal: ctrl.signal, resume: ID }).catch((e) => e);
  assert.equal(err.name, 'AbortError');
  assert.equal(err.task, ID);
  assert.equal(err.resumable, true);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [`GET /api/runway/task/${ID}`, `DELETE /api/runway/task/${ID}`]);
  assert.deepEqual(slotState(), { busy: 0, waiting: 0 });
});

test('runwayVideo: resuming a task an earlier Stop cancelled starts a new one', async () => {
  const NEW = '0b7b0c1d-2e3f-4a5b-8c6d-7e8f9a0b1c2e';
  mockFetch([
    [new RegExp(`^GET /api/runway/task/${ID}$`), () => reply(200, task('CANCELLED'))],
    [/^POST \/api\/runway\/generate\//, () => reply(200, { id: NEW, estimatedCost: { credits: 48 } })],
    [new RegExp(`^GET /api/runway/task/${NEW}$`), () => reply(200, task('SUCCEEDED', { id: NEW }))],
    [/^GET \/api\/runway\/output\//, () => new Response(MP4, { headers: { 'content-type': 'video/mp4' } })],
  ]);
  const out = await runwayVideo(buildRequest({ model: 'gen4.5', prompt: 'x' }), { apiHeaders: headers, sleep: fakeSleep().sleep, resume: ID });
  assert.equal(out.id, NEW);
});

test('runwayVideo: Stop during “Downloading from Runway” never deletes the paid video; Try again downloads it', async () => {
  const ctrl = new AbortController();
  mockFetch([
    [/^POST \/api\/runway\/generate\//, () => reply(200, { id: ID, estimatedCost: { credits: 48 } })],
    [/^GET \/api\/runway\/task\//, () => reply(200, task('SUCCEEDED', { cost: { credits: 48 } }))],
    [/^GET \/api\/runway\/output\//, (c) => new Promise((res, rej) => { c.init.signal.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError'))); ctrl.abort(); })],
    [/^DELETE /, () => reply(200, { ok: true })],
  ]);
  const err = await runwayVideo(buildRequest({ model: 'gen4.5', prompt: 'x' }), { apiHeaders: headers, sleep: fakeSleep().sleep, signal: ctrl.signal }).catch((e) => e);
  assert.equal(err.name, 'AbortError');
  assert.equal(err.task, ID);
  assert.equal(err.resumable, true, 'kept so Try again downloads it for free');
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(!calls.some((c) => c.method === 'DELETE'), 'Stop after SUCCEEDED must not send DELETE');
});

test('runwayVideo: Stop while “Sending to Runway” answers at once, then cancels the task the POST made', async () => {
  const ctrl = new AbortController();
  let answer;
  mockFetch([
    [/^POST \/api\/runway\/generate\//, (c) => { assert.equal(c.init.signal?.aborted, false); return new Promise((res) => { answer = res; }); }],
    [/^DELETE \/api\/runway\/task\//, () => reply(200, { ok: true })],
  ]);
  const tasks = [];
  const job = runwayVideo(buildRequest({ model: 'gen4.5', prompt: 'x' }), { apiHeaders: headers, sleep: fakeSleep().sleep, signal: ctrl.signal, onTask: (id) => tasks.push(id) });
  await new Promise((r) => setTimeout(r, 5));
  ctrl.abort();
  const err = await job.catch((e) => e);
  assert.equal(err.name, 'AbortError');
  assert.ok(!err.resumable && !err.task, 'nothing to resume');
  assert.ok(!calls.some((c) => c.method === 'DELETE'), 'no id yet');
  assert.deepEqual(slotState(), { busy: 0, waiting: 0 });
  answer(reply(200, { id: ID, estimatedCost: { credits: 48 } })); // Runway made it after all
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(calls.filter((c) => c.method === 'DELETE').map((c) => c.url), [`/api/runway/task/${ID}`]);
  assert.deepEqual(tasks, [], 'the stopped entry never adopts the task');
});

test('createTask: its own body-sized timeout; no answer is never resumable and says a video may have started', async () => {
  assert.equal(createTimeout(0), RUNWAY_TIMING.create);
  assert.equal(createTimeout(4_000_000), RUNWAY_TIMING.create + Math.ceil(4_000_000 / RUNWAY_TIMING.uplink) * 1000);
  assert.ok(createTimeout(4_000_000) > RUNWAY_TIMING.request * 4, 'a 4 MB still on a slow uplink gets minutes, not 30 s');
  assert.equal(createTimeout(1e9), RUNWAY_TIMING.createMax);
  const saved = { ...RUNWAY_TIMING };
  try {
    Object.assign(RUNWAY_TIMING, { create: 20, uplink: 1e12, createMax: 50 });
    mockFetch([[/^POST \/api\/runway\/generate\//, (c) => new Promise((res, rej) => c.init.signal.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError'))))]]);
    const err = await runwayVideo(buildRequest({ model: 'gen4.5', prompt: 'x' }), { apiHeaders: headers, sleep: fakeSleep().sleep }).catch((e) => e);
    assert.equal(err.status, 0);
    assert.equal(err.code, 'runway_unconfirmed');
    assert.ok(!err.resumable, 'there is no task id to resume');
    assert.match(err.message, /didn’t confirm the new video in time — it may have started anyway\. Check your Runway usage at dev\.runway\.com/);
    mockFetch([[/^POST \/api\/runway\/generate\//, () => { throw new TypeError('Failed to fetch'); }]]);
    const drop = await createTask('text_to_video', { model: 'gen4.5', promptText: 'x' }, { apiHeaders: headers }).catch((e) => e);
    assert.match(drop.message, /connection dropped before Runway confirmed/);
    assert.ok(!drop.resumable);
  } finally { Object.assign(RUNWAY_TIMING, saved); }
});

test('runwayVideo: an over-the-cap task the Worker couldn’t cancel is cancelled again from here', async () => {
  mockFetch([
    [/^POST \/api\/runway\/generate\//, () => reply(402, { error: 'Runway estimated 240 credits … couldn’t cancel it at once', code: 'runway_cap_running', id: ID, estimatedCost: { credits: 240 } })],
    [/^DELETE \/api\/runway\/task\//, () => reply(200, { ok: true })],
  ]);
  const err = await runwayVideo(buildRequest({ model: 'gen4.5', prompt: 'x' }), { apiHeaders: headers, sleep: fakeSleep().sleep }).catch((e) => e);
  assert.equal(err.status, 402);
  assert.equal(err.code, 'runway_cap_running');
  assert.equal(err.task, ID);
  assert.ok(!err.resumable);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(calls.filter((c) => c.method === 'DELETE').map((c) => c.url), [`/api/runway/task/${ID}`]);
});

test('runwayVideo: Worker refusals keep the Worker’s words, status and code', async () => {
  mockFetch([[/^POST \/api\/runway\/generate\//, () => reply(401, { error: 'Enter your passcode to use Atelier.' })]]);
  await assert.rejects(runwayVideo(buildRequest({ model: 'gen4.5', prompt: 'x' }), { apiHeaders: headers, sleep: fakeSleep().sleep }),
    (e) => e.status === 401 && e.message === 'Enter your passcode to use Atelier.'); // app.js then reopens sign-in, as for every route
  mockFetch([[/^POST \/api\/runway\/generate\//, () => reply(429, { error: 'Runway is limiting this account right now', code: 'runway_limit' }, { 'retry-after': '60' })]]);
  await assert.rejects(runwayVideo(buildRequest({ model: 'gen4.5', prompt: 'x' }), { apiHeaders: headers, sleep: fakeSleep().sleep }),
    (e) => e.status === 429 && e.code === 'runway_limit' && e.retryAfter === 60);
  assert.deepEqual(slotState(), { busy: 0, waiting: 0 });
});

test('takeSlot: one Runway job at a time by default; aborting a wait leaves the queue clean', async () => {
  const first = await takeSlot(1);
  let second = false;
  const waiting = takeSlot(1, null, () => {}).then((rel) => { second = true; return rel; });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(second, false);
  assert.deepEqual(slotState(), { busy: 1, waiting: 1 });
  const ctrl = new AbortController();
  const third = takeSlot(1, ctrl.signal);
  ctrl.abort();
  await assert.rejects(third, (e) => e.name === 'AbortError');
  assert.deepEqual(slotState(), { busy: 1, waiting: 1 });
  first(); first(); // releasing twice is harmless
  const rel = await waiting;
  assert.equal(second, true);
  assert.deepEqual(slotState(), { busy: 1, waiting: 0 });
  rel();
  assert.deepEqual(slotState(), { busy: 0, waiting: 0 });
  const a = await takeSlot(2), b = await takeSlot(2);
  assert.deepEqual(slotState(), { busy: 2, waiting: 0 });
  a(); b();
});

test('cancelTask and downloadOutput', async () => {
  mockFetch([[/^DELETE /, () => reply(200, { ok: true })], [/^GET \/api\/runway\/output\//, () => reply(409, { error: 'The Runway video isn’t ready yet.', code: 'runway_not_ready' })]]);
  assert.equal(await cancelTask(ID, { apiHeaders: headers }), true);
  assert.equal(await cancelTask('', { apiHeaders: headers }), false);
  await assert.rejects(downloadOutput(ID, { apiHeaders: headers }), (e) => e.status === 409 && e.code === 'runway_not_ready');
  mockFetch([[/^DELETE /, () => { throw new TypeError('offline'); }], [/^GET /, () => new Response(new Uint8Array(0))]]);
  assert.equal(await cancelTask(ID, { apiHeaders: headers }), false);
  await assert.rejects(downloadOutput(ID, { apiHeaders: headers }), (e) => e.status === 502 && /empty/.test(e.message));
});

test('uploadToRunway: raw bytes with the file’s own type and the passcode; checks size and type first', async () => {
  const file = new File([new Uint8Array(2048)], 'clip.mov', { type: 'video/quicktime' });
  mockFetch([[/^POST \/api\/runway\/upload$/, () => reply(200, { runwayUri: 'runway://upload/abc', expiresAt: 123 })]]);
  assert.deepEqual(await uploadToRunway(file, { apiHeaders: headers }), { runwayUri: 'runway://upload/abc', expiresAt: 123 });
  assert.equal(calls[0].headers.get('content-type'), 'video/quicktime');
  assert.equal(calls[0].headers.get('x-app-pass'), 'pw');
  assert.equal(calls[0].body, file);
  calls = [];
  await assert.rejects(uploadToRunway(new File([new Uint8Array(2048)], 'a.avi', { type: 'video/x-msvideo' }), { apiHeaders: headers }), (e) => e.status === 415);
  await assert.rejects(uploadToRunway(new File([new Uint8Array(10)], 'a.mp4', { type: 'video/mp4' }), { apiHeaders: headers }), (e) => e.status === 400);
  assert.equal(calls.length, 0);
  mockFetch([[/^POST \/api\/runway\/upload$/, () => reply(502, { error: 'The upload to Runway failed — attach the file again.', code: 'runway_upload' })]]);
  await assert.rejects(uploadToRunway(file, { apiHeaders: headers }), (e) => e.status === 502 && e.code === 'runway_upload');
  mockFetch([[/^POST \/api\/runway\/upload$/, () => reply(200, { runwayUri: 'https://nope' })]]);
  await assert.rejects(uploadToRunway(file, { apiHeaders: headers }), (e) => e.status === 502);
});

test('runwayAccount: cached for 10 minutes, never rejects, feeds the queue size', async () => {
  let n = 0;
  mockFetch([[/^GET \/api\/runway\/account$/, () => { n++; return reply(200, { creditBalance: 4210, usd: 42.1, maxMonthlyCreditSpend: 10000, models: { 'gen4.5': { maxConcurrentGenerations: 3, maxDailyGenerations: 500 }, aleph2: { maxConcurrentGenerations: null, maxDailyGenerations: null } } }); }]]);
  assert.equal(accountLimit('gen4.5'), 1, 'unknown → one at a time');
  const a = await runwayAccount({ apiHeaders: headers });
  assert.equal(a.ok, true);
  assert.equal(a.creditBalance, 4210);
  await runwayAccount({ apiHeaders: headers });
  assert.equal(n, 1);
  assert.equal(accountLimit('gen4.5'), 3);
  assert.equal(accountLimit('aleph2'), 4);
  assert.equal(accountLimit('gen4_turbo'), 1);
  await runwayAccount({ apiHeaders: headers, force: true });
  assert.equal(n, 2);
  forgetAccount();
  mockFetch([[/^GET \/api\/runway\/account$/, () => reply(403, { error: 'Runway rejected the server’s API key', code: 'runway_key' })]]);
  assert.deepEqual(await runwayAccount({ apiHeaders: headers }), { ok: false, status: 403, code: 'runway_key', error: 'Runway rejected the server’s API key' });
  mockFetch([[/./, () => { throw new TypeError('offline'); }]]);
  assert.equal((await runwayAccount({ apiHeaders: headers })).ok, false);
});
