// Client side of LinkedIn tester mode (public/tester.js): allowance math, Veo fit, profile document, owner config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  VEO_PER_SECOND, VEO_CAP, MAX_IMAGES, CLIP_MAX_BYTES, CLIP_MAX_SECONDS, PROFILE_MAX,
  normalizeMe, allowedIds, isTesterCode, parseAllowanceHeader, leftOf, headroom, money, nextReset, parseResetsAt, resetIn,
  veoCost, veoShape, veoChoices, testerClipReason, profileOut, profileIn, toMs, isSub, configBody,
} from '../public/tester.js';
import { veoCost as serverVeoCost, PRICES, TESTER_MODELS, TESTER_IMAGE_MODELS, TESTER_VIDEO_MODELS } from '../src/tester/prices.js';

const ME = (over = {}) => ({
  sub: 'abc-123', name: 'Ada Lovelace', picture: 'https://media.licdn.com/dms/image/x.jpg', email: 'ada@example.com',
  models: { chat: ['anthropic:claude-opus-5-5', 'gemini:gemini-3.8-flash'], image: ['openai:gpt-image-2.5-flare'], video: ['gemini:veo-3.1-lite-generate-preview'] },
  features: { web: true, video: true, veo: true, helpers: true, profile: true },
  allowance: { day: { spent: 150_000, reserved: 50_000, limit: 1_000_000 }, month: { spent: 2_000_000, reserved: 0, limit: 10_000_000 } },
  pool: { paused: false, spotsLeft: 12 }, ...over,
});

test('the client Veo prices match src/tester/prices.js for every tester video model, length and resolution', () => {
  assert.deepEqual(Object.keys(VEO_PER_SECOND).sort(), [...TESTER_VIDEO_MODELS].sort());
  for (const model of TESTER_VIDEO_MODELS) {
    assert.deepEqual(VEO_PER_SECOND[model], PRICES[model].perSecond, model);
    for (const resolution of Object.keys(PRICES[model].perSecond)) for (const seconds of [4, 6, 8]) {
      assert.equal(veoCost(model, seconds, resolution), serverVeoCost({ model, seconds, resolution }), `${model} ${seconds}s ${resolution}`);
    }
  }
  assert.equal(veoCost('gemini:veo-3.1-generate-preview', 4, '720p'), null, 'Veo standard is not offered to testers');
  assert.equal(veoCost('gemini:veo-3.1-lite-generate-preview', 4, '4k'), null);
});

test('no NVIDIA or free model is ever listed for testers (addendum A7b), so the client never offers one', () => {
  for (const id of [...TESTER_MODELS, ...TESTER_IMAGE_MODELS, ...TESTER_VIDEO_MODELS]) {
    assert.notEqual(PRICES[id].provider, 'nvidia', id);
    assert.notEqual(PRICES[id].provider, 'local', id);
    assert.ok(!PRICES[id].free, id);
  }
});

test('normalizeMe keeps a clean tester record and rejects anything else', () => {
  for (const bad of [null, 'x', [], {}, { sub: '' }, { sub: 7 }]) assert.equal(normalizeMe(bad), null);
  const t = normalizeMe(ME({ models: { chat: ['anthropic:claude-opus-5-5', '<script>', 42], image: [], video: ['gemini:veo-3.1-lite-generate-preview'] }, picture: 'javascript:alert(1)' }));
  assert.deepEqual(t.models.chat, ['anthropic:claude-opus-5-5']);
  assert.equal(t.picture, '');
  assert.deepEqual(t.features, { web: true, video: true, veo: true, helpers: true, profile: true });
  assert.equal(t.left, null);
  // A feature switched off on the server takes its models with it; missing flags default to on.
  const noVeo = normalizeMe(ME({ features: { veo: false } }));
  assert.deepEqual(noVeo.models.video, []);
  assert.equal(noVeo.features.web, true);
  assert.deepEqual([...allowedIds(t)].sort(), ['anthropic:claude-opus-5-5', 'gemini:veo-3.1-lite-generate-preview']);
  assert.equal(allowedIds(null).size, 0);
  // The Ledger's allowance may carry the pool and the paused/preview flags.
  const pooled = normalizeMe(ME({ pool: undefined, allowance: { ...ME().allowance, pool: { spent: 40_000_000, reserved: 1_000_000, limit: 100_000_000 }, paused: true, preview: true } }));
  assert.equal(pooled.poolLeft, 59_000_000);
  assert.equal(pooled.pool.paused, true);
  assert.equal(pooled.pool.preview, true);
});

test('allowance: /me numbers, then the x-tester-allowance header; money never overstates what is left', () => {
  const t = normalizeMe(ME());
  assert.deepEqual(leftOf(t), { day: 800_000, month: 8_000_000, pool: null });
  for (const bad of [null, '', 'nope', '{}', '{"dayLeft":"x","monthLeft":1}', '{"dayLeft":null,"monthLeft":1}']) assert.equal(parseAllowanceHeader(bad), null, String(bad));
  const h = parseAllowanceHeader('{"dayLeft":412345,"monthLeft":9100000,"poolLeft":87000000}');
  assert.deepEqual(h, { day: 412_345, month: 9_100_000, pool: 87_000_000 });
  assert.deepEqual(parseAllowanceHeader('{"dayLeft":-5,"monthLeft":10}'), { day: 0, month: 10, pool: null });
  t.left = h;
  assert.deepEqual(leftOf(t), h);
  // A restored record keeps the header figures.
  assert.deepEqual(leftOf(normalizeMe(JSON.parse(JSON.stringify(t)))), h);
  assert.equal(money(412_345), '$0.41');
  assert.equal(money(412_345, { up: true }), '$0.42');
  assert.equal(money(1_000_000), '$1.00');
  assert.equal(money(123_456_789_000), '$123,456.78');
  assert.equal(money(-3), '$0.00');
  assert.equal(money(undefined), '$0.00');
  assert.deepEqual(headroom({ day: 300_000, month: 200_000, pool: null }), { scope: 'month', amount: 200_000 });
  assert.deepEqual(headroom({ day: 3_000_000, month: 9_000_000, pool: 5_000_000 }, VEO_CAP), { scope: 'call', amount: VEO_CAP });
  assert.deepEqual(headroom({ day: 900_000, month: 9_000_000, pool: 100 }, VEO_CAP), { scope: 'pool', amount: 100 });
});

test('resets: the UTC day and calendar month, a 402 resetsAt in any common shape, and a readable countdown', () => {
  const now = Date.UTC(2026, 11, 31, 22, 30); // 31 Dec 2026, 22:30 UTC
  assert.equal(nextReset('day', now), Date.UTC(2027, 0, 1));
  assert.equal(nextReset('month', now), Date.UTC(2027, 0, 1));
  assert.equal(nextReset('pool', Date.UTC(2026, 9, 15)), Date.UTC(2026, 10, 1));
  assert.equal(nextReset('call', now), null);
  const at = Date.UTC(2027, 0, 1);
  for (const v of [at, at / 1000, new Date(at).toISOString(), String(at), String(at / 1000)]) assert.equal(parseResetsAt(v, 'day', now), at, String(v));
  assert.equal(parseResetsAt(undefined, 'day', now), at);
  assert.equal(parseResetsAt('garbage', 'call', now), null);
  assert.equal(resetIn(now + 90 * 60_000, now), 'in 1 h 30 min');
  assert.equal(resetIn(now + 2 * 3_600_000, now), 'in 2 h');
  assert.equal(resetIn(now + 8 * 60_000, now), 'in 8 min');
  assert.equal(resetIn(now + 30_000, now), 'in a minute');
  assert.match(resetIn(now + 5 * 86_400_000, now), /^on /);
  assert.equal(resetIn(NaN, now), '');
});

test('Veo: only the lengths and resolutions whose worst case fits what is left, and never above $1', () => {
  const lite = 'gemini:veo-3.1-lite-generate-preview', fast = 'gemini:veo-3.1-fast-generate-preview';
  assert.deepEqual(veoShape({ aspect: '16:9hd', secs: 4 }), { seconds: 8, resolution: '1080p' });
  assert.deepEqual(veoShape({ aspect: '9:16', secs: 4 }), { seconds: 4, resolution: '720p' });
  const full = { day: 1_000_000, month: 10_000_000, pool: null };
  assert.deepEqual(veoChoices(lite, full), { secs: [4, 6, 8], hd: true, cheapest: 250_000, room: 1_000_000 });
  // Fast: 8 s at 720p is exactly $1.00 (fits), 8 s at 1080p reserves $1.20 (never offered).
  assert.deepEqual(veoChoices(fast, full).secs, [4, 6, 8]);
  assert.equal(veoChoices(fast, full).hd, false);
  assert.deepEqual(veoChoices(lite, { day: 400_000, month: 9_000_000, pool: null }), { secs: [4, 6], hd: false, cheapest: 250_000, room: 400_000 });
  assert.deepEqual(veoChoices(lite, { day: 100_000, month: 9_000_000, pool: null }).secs, []);
  assert.deepEqual(veoChoices(lite, { day: 900_000, month: 9_000_000, pool: 260_000 }).secs, [4]);
});

test('tester clip limits: 200 MB and 3 min (addendum A2); frames stand in past that', () => {
  assert.equal(CLIP_MAX_BYTES, 200 * 1024 * 1024);
  assert.equal(CLIP_MAX_SECONDS, 180);
  assert.equal(MAX_IMAGES, 8);
  assert.equal(testerClipReason({ size: 10e6, duration: 60 }), null);
  assert.equal(testerClipReason({ size: CLIP_MAX_BYTES + 1, duration: 60 }), 'tester-large');
  assert.equal(testerClipReason({ size: 10e6, duration: 181 }), 'tester-long');
  assert.equal(testerClipReason({ size: 10e6, duration: NaN }), null);
  assert.equal(testerClipReason(null), null);
});

test('tester codes bypass the fallback chain; model_no_images does not', () => {
  for (const c of ['tester_budget', 'tester_paused', 'tester_model', 'tester_signin', 'tester_too_large', 'tester_owner', 'tester_origin', 'tester_video_not_ready', 'owner_only']) assert.ok(isTesterCode(c), c);
  for (const c of ['model_no_images', 'video_file_gone', undefined, null, 42]) assert.ok(!isTesterCode(c), String(c));
});

test('profile document: the shape the Worker stores, under 300 KB, and back', () => {
  let n = 0; const id = () => `m${++n}`;
  const me = { bio: 'Builder', samples: 'x'.repeat(10), style: 'Plain', learned: 'Likes tea', updatedAt: 1234, sources: { 'ChatGPT history': { at: 5, count: 12 } },
    memory: [{ id: 'a1', text: 'Lives in Ohio', src: 'chat', at: 1 }, { id: '"><x', text: 'Odd id', src: 'you', at: 2 }, { text: '' }, null] };
  const doc = profileOut(me, 'Ada');
  assert.deepEqual(Object.keys(doc).sort(), ['bio', 'learned', 'memory', 'name', 'samples', 'sources', 'style', 'updatedAt']);
  assert.equal(doc.name, 'Ada');
  assert.deepEqual(doc.memory, [{ id: 'a1', text: 'Lives in Ohio', src: 'chat', at: 1 }, { text: 'Odd id', src: 'you', at: 2 }]);
  assert.deepEqual(doc.sources, { 'ChatGPT history': { at: 5, count: 12 } });
  const back = profileIn(doc, id);
  assert.equal(back.memory[0].id, 'a1');
  assert.equal(back.memory[1].id, 'm1', 'a memory without a usable id gets a new one');
  assert.equal(back.updatedAt, 1234);
  assert.deepEqual(profileIn(null, id).memory, []);
  // Oversized: the oldest memories go first, then the long text fields are trimmed, until it fits.
  const big = { samples: 'é'.repeat(100_000), learned: 'l'.repeat(100_000), bio: 'b'.repeat(100_000), memory: Array.from({ length: 400 }, (_, i) => ({ id: `k${i}`, text: `fact ${i} `.repeat(40), at: i })) };
  const out = profileOut(big);
  assert.ok(new TextEncoder().encode(JSON.stringify(out)).length <= PROFILE_MAX);
  assert.ok(out.memory.length < 400 && out.memory.at(-1).id === 'k399', 'newest memories are kept');
});

test('owner config: dollars in, micro-dollars out, validated before it is sent', () => {
  assert.deepEqual(configBody({ cap: '25', day: '1', month: '10.00', pool: '100' }).body, { cap: 25, day_limit: 1_000_000, month_limit: 10_000_000, pool_limit: 100_000_000 });
  assert.deepEqual(configBody({ cap: 0, day: '0.5', month: '2', pool: '1000' }).body, { cap: 0, day_limit: 500_000, month_limit: 2_000_000, pool_limit: 1_000_000_000 });
  for (const bad of [{ cap: '2.5', day: 1, month: 10, pool: 100 }, { cap: -1, day: 1, month: 10, pool: 100 }, { cap: 25, day: '', month: 10, pool: 100 },
    { cap: 25, day: 'x', month: 10, pool: 100 }, { cap: 25, day: 1, month: 10, pool: '1000.01' }, { cap: 25, day: 20, month: 10, pool: 100 }, { cap: 25, day: 0, month: 10, pool: 100 }]) {
    assert.ok(configBody(bad).error, JSON.stringify(bad));
  }
  assert.ok(isSub('AbC_12-x') && !isSub('a b') && !isSub('') && !isSub('x'.repeat(129)) && !isSub(5));
  assert.equal(toMs(1_790_000_000), 1_790_000_000_000);
  assert.equal(toMs(1_790_000_000_000), 1_790_000_000_000);
  assert.equal(toMs('2026-09-30T00:00:00Z'), Date.UTC(2026, 8, 30));
  assert.equal(toMs(null), null);
  assert.equal(toMs('soon'), null);
});

test('tester mode never reaches owner surfaces from the client: app.js gates them and index.html marks them', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(app, /const agentTools = \(\) => \(S\.tester \? \[\]/);
  assert.match(app, /const browserAvailable = \(\) => !S\.tester &&/);
  assert.match(app, /function canvaOn\(\) \{ return !S\.tester &&/);
  assert.match(app, /if \(!S\.settings\.passcode \|\| S\.tester \|\| !server\.nvidia\) return;/, 'loadTools is owner-only');
  assert.match(html, /<button type="button" class="chip owner-only" data-settings="connections"/);
  assert.match(html, /<section class="field-group owner-only">\s*<h4>Available providers<\/h4>/);
  assert.match(html, /<section class="field-group owner-only">\s*<h4>Connections<\/h4>/);
  assert.match(html, /class="model-grid owner-only" id="modelFields"/);
  assert.match(html, /class="chip owner-only" id="refreshModels"/);
  assert.match(html, /class="field-group needs-owner">\s*<h4>Testers<\/h4>/);
  assert.match(html, /<a class="li-btn" id="liBtn" href="\/api\/li\/start">/);
  assert.doesNotMatch(html, /w_member_social/);
});

test('link previews carry the A7a launch copy; the privacy page names both sign-in cookies', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const privacy = await readFile(new URL('../public/privacy.html', import.meta.url), 'utf8');
  assert.match(html, /<meta property="og:title" content="Atelier — Come make something yours\." \/>/);
  assert.match(html, /<meta property="og:description" content="25 LinkedIn tester spots\. Paid models included\. Built by Cole Ciprari\." \/>/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image" \/>/);
  for (const c of ['__Host-atelier_tester', '__Host-atelier_li']) assert.ok(privacy.includes(`<code>${c}</code>`), c);
  assert.doesNotMatch(privacy, /the only cookie is/);
});

test('privacy page and tester welcome name every provider Auto or a fallback can send a tester prompt to', async () => {
  const privacy = await readFile(new URL('../public/privacy.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const row = privacy.match(/<tr><td>Z\.ai, DeepSeek and Meta<\/td><td>([^<]*)<\/td><\/tr>/);
  assert.ok(row, 'the Z.ai/DeepSeek/Meta processor row');
  assert.doesNotMatch(row[1], /models you can choose\./, 'not only when picked: Auto and fallbacks use them too');
  assert.match(row[1], /Auto/);
  assert.match(row[1], /fall back/);
  // Testers: Auto puts GLM 5.3 first for Code/Build (Opus is demoted), so the copy must say so.
  assert.match(app, /code: \[\s*\['anthropic:claude-opus-5-5', 'Claude Opus 5\.5'\], \['zai:glm-5\.3'/);
  assert.match(row[1], /GLM 5\.3/);
  assert.match(app, /Claude, GPT, Gemini and others \(Z\.ai, DeepSeek, Meta\) for answers, code, ideas and apps/);
  assert.doesNotMatch(app, /— Claude, GPT and Gemini for answers, code, ideas and apps/);
});

test('the clip-not-ready refusal gets its own budget-card title', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /tester_video_not_ready: 'video'/);
  assert.match(app, /video: 'This clip isn’t ready yet'/);
});

test('tester client guards: a per-call refusal moves down the chain, Auto demotes the tightest models, a name ends with its session', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /const callCap = err\.code === 'tester_budget' && err\.scope === 'call';\s*if \(isTesterCode\(err\.code\) && !callCap\) throw err;/);
  assert.match(app, /const TESTER_DEMOTE = new Set\(\['anthropic:claude-opus-5-5', 'anthropic:claude-fable-5-1', 'openai:gpt-6-astra'\]\)/);
  assert.match(app, /const chain = \[opts\.model, \.\.\.roleModels\(opts\.role\)/);
  assert.match(app, /if \(prev && !S\.settings\.passcode && S\.settings\.name\) \{ S\.settings\.name = '';/);
  assert.match(app, /LS\.set\('outReason', reason\)/);
});
