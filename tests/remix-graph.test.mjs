import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// public/remix-graph.js — what each output frame of a remix draws, and which audio goes out. Pure.
const G = await import('../public/remix-graph.js');
const R = await import('../public/remix.js');
const { cutsFrom } = await import('../public/remix-cuts.js');
const FX = JSON.parse(readFileSync(new URL('./fixtures/remix/remix-plan-promo.json', import.meta.url), 'utf8'));
const LUMA = JSON.parse(readFileSync(new URL('./fixtures/remix/promo-luma.json', import.meta.url), 'utf8'));
const SRC = { duration: 48, width: 1080, height: 1350, fps: 30, vkbps: 1046, rotation: 0 };

const settled = () => R.settlePlan(FX.plan, { source: SRC, opts: { maxNew: 0 }, cuts: cutsFrom(LUMA.polished) });
const graphOf = (s, out = { w: 1080, h: 1350 }) => G.buildGraph(s.layout, s.plan, { fps: 30, out, source: SRC });

test('buildGraph: 1440 frames for the 48 s fixture; crops; layers drawn cover → image → text', () => {
  const g = graphOf(settled(), { w: 1088, h: 1360 });
  assert.equal(g.frames, 1440);
  assert.deepEqual(g.items.map((i) => [i.id, i.type, i.outStart, i.outEnd]), [['open', 'source', 0, 24], ['tools', 'card', 24, 26], ['models', 'source', 26, 42], ['close', 'source', 42, 48]]);
  assert.deepEqual(g.items[0].crop, { sx: 0, sy: 0, sw: 1080, sh: 1350, rotation: 0, scale: 1088 / 1080 });
  assert.equal(g.items[1].card.backdrop.kind, 'frame_blur');
  assert.deepEqual(g.layers.map((l) => l.kind), ['cover', 'image', 'text', 'text']);
  assert.deepEqual(g.audio, { mode: 'copy', end: 48, lead: 0.5 });
  assert.equal(g.transitions.length, 0, 'the fixture is all straight cuts');
});

test('frameAt: media time follows each item’s own clock; layers fade in 0.18 s and out 0.38 s; text drifts', () => {
  const g = graphOf(settled());
  const f = G.frameAt(g, 27 * 30); // 27.0 s → 'models', 1 s in → source 25.0
  assert.deepEqual(f.draws, [{ id: 'models', type: 'source', media: 25, alpha: 1 }]);
  const card = G.frameAt(g, 24 * 30 + 1);
  assert.equal(card.draws[0].type, 'card');
  assert.ok(card.draws[0].card.textAlpha > 0 && card.draws[0].card.textAlpha < 1, 'card text fades in over 0.16 s');
  const fall = g.layers.find((l) => l.id === 'fall');
  const start = G.frameAt(g, Math.round(fall.outStart * 30) + 3).layers.find((l) => l.id === 'fall');
  assert.ok(Math.abs(start.alpha - 0.1 / 0.18) < 0.01, `${start.alpha}`);
  const mid = G.frameAt(g, Math.round((fall.outStart + 1.5) * 30)).layers.find((l) => l.id === 'fall');
  assert.equal(mid.alpha, 1);
  const cta = g.layers.find((l) => l.id === 'cta');
  const c = G.frameAt(g, Math.round((cta.outStart + 2) * 30)).layers.find((l) => l.id === 'cta');
  assert.ok(Math.abs(c.dy - 0.68 * 2) < 0.03, `drift_y 0.68 px/s → ${c.dy}`);
  assert.deepEqual(G.frameAt(g, 1439).draws[0].id, 'close');
});

test('transitions: a dip peaks in the brand colour at the cut; a fade draws both items from their handles', () => {
  const plan = R.normalizePlan({ v: 1, title: 't', style: { look: '' }, audio: { mode: 'follow_cuts' }, scenes: [], shots: [], overlays: [], timeline: [
    { id: 'a', type: 'source', src_in: 0, src_out: 10 },
    { id: 'b', type: 'source', src_in: 20, src_out: 30, enter: 'fade' },
    { id: 'c', type: 'card', seconds: 2, backdrop: { kind: 'brand' }, lines: [{ text: 'Hi', style: 'headline' }], enter: 'dip', motion: 'push' },
  ] }, SRC).plan;
  const lay = R.layout(plan, SRC);
  const g = G.buildGraph(lay, plan, { fps: 30, out: { w: 1080, h: 1350 }, source: SRC });
  assert.deepEqual(g.transitions.map((t) => [t.kind, t.at]), [['fade', 10], ['dip', 20]]);
  const before = G.frameAt(g, 299); // 9.967 s, inside the 0.33 s crossfade
  assert.deepEqual(before.draws.map((d) => d.id), ['a', 'b']);
  assert.ok(before.draws[1].media < 20, 'the incoming clip plays its handle before its in-point');
  const after = G.frameAt(g, 302);
  assert.ok(after.draws[0].media > 10, 'the outgoing clip plays its handle after its out-point');
  assert.ok(after.draws[1].alpha > before.draws[1].alpha);
  assert.equal(G.frameAt(g, 600).dip, 1, 'the brand colour fully covers the cut frame');
  assert.ok(G.frameAt(g, 598).dip > 0 && G.frameAt(g, 598).dip < 1);
  assert.equal(G.frameAt(g, 610).dip, 0);
  const push = G.frameAt(g, 659).draws[0].card;
  assert.ok(push.scale > 1.03 && push.scale <= 1.04, 'push-in grows to 4 %');
  assert.equal(g.audio.mode, 'mix');
  assert.deepEqual(g.audio.segments.map((s) => s.kind), ['source', 'source', 'silence']);
});

test('sampleTimes: one ascending timestamp list per item (handles included); brand cards need no frames', () => {
  const s = settled();
  const times = G.sampleTimes(graphOf(s));
  assert.equal(times.open.length, 720);
  assert.equal(times.open[0], 0);
  for (const list of Object.values(times)) for (let i = 1; i < list.length; i++) assert.ok(list[i] > list[i - 1]);
  assert.deepEqual(times.tools, [24], 'a frame_blur card needs its one still');
  assert.equal(times.models[0], 24);
});

test('keepPackets: AAC priming before 0 stays; packets at or past the output end go', () => {
  assert.deepEqual(G.keepPackets([-0.021333, 0, 1, 47.978667, 48, 48.02], 48), [-0.021333, 0, 1, 47.978667]);
  assert.deepEqual(G.audioPlan({ duration: 50, items: [] }, { audio: { mode: 'keep' } }, undefined), { mode: 'copy', end: 50, lead: 0.5 });
});
