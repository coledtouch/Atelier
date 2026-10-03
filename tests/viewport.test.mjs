import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { viewportState, kbDebugFlag, iosVersion, kbDebugText, screenSide, bottomGap, KB_MIN, KB_RESIZE, TIGHT_H, FRAME_KB_MS, FRAME_HANDOFF_MS, GAP_MIN, GAP_MAX } from '../public/viewport.js';

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');

// Feed a sequence of metric snapshots through viewportState the way syncViewport() does: each call gets the previous
// result's fullH/fullW/frameKb (and the whole result as prev), and a scroll reset on the composer marks the focus as
// nudged (until the next focus).
function run(steps, base = {}) {
  let prev = viewportState({ ...base, ...steps[0], editing: false, frame: false });
  let nudged = false;
  return steps.map((step) => {
    const m = { ...base, ...step };
    if (m.focus) nudged = false;
    const s = viewportState({ ...m, nudged, fullH: prev.fullH, fullW: prev.fullW, frameKb: prev.frameKb, prev });
    if (s.resetScroll && s.open) nudged = true;
    prev = s;
    return s;
  });
}
// Where the dock's bottom edge lands, in the fixed box's coordinates. kb-open uses the % rule in studio.css,
// otherwise bottom: var(--kb) (0 when closed).
const dockBottom = (s) => (s.open ? s.layoutH - Math.max(0, s.layoutH - s.top - s.vvh) : s.layoutH - s.kb);
// What is really on screen, in the same coordinates: from the true pan to the pan plus the true visible height.
const assertDockOnScreen = (s, realTop, realVisible, msg) => {
  const bottom = dockBottom(s), visibleBottom = realTop + realVisible;
  assert.ok(bottom <= visibleBottom + 1, `${msg}: dock bottom ${bottom} is below the visible bottom ${visibleBottom} (hidden)`);
  assert.ok(bottom >= visibleBottom - 1, `${msg}: dock bottom ${bottom} floats above the visible bottom ${visibleBottom}`);
  assert.equal(s.layoutH - s.kb, s.open ? bottom : s.layoutH, `${msg}: --kb agrees with the CSS rule`);
};

// The syncViewport() math before this fix, kept as the reference for "unchanged on desktop / Android / iOS 18".
function legacy(st, m) {
  const zoomed = m.vvScale > 1.01;
  const vh = !zoomed ? m.vvHeight : m.innerHeight;
  const editing = !zoomed && !!m.editing;
  const kb = editing ? Math.max(0, Math.round(m.innerHeight - m.vvHeight - m.vvOffsetTop)) : 0;
  const top = editing ? Math.max(0, Math.round(m.vvOffsetTop)) : 0;
  if (m.innerWidth !== st.w) { st.w = m.innerWidth; st.fullH = m.innerHeight; }
  const open = editing && (kb + top > 40 || (m.coarse && st.fullH - m.innerHeight > 150));
  if (!open) st.fullH = m.innerHeight;
  return { vvh: Math.round(vh), kb: open ? kb : 0, top: open ? top : 0, open, tight: open && vh < 460, fullH: st.fullH };
}
const pick = ({ vvh, kb, top, open, tight, fullH }) => ({ vvh, kb, top, open, tight, fullH });

const IPHONE = { innerWidth: 393, coarse: true, vvScale: 1, scrollY: 0, vvOffsetTop: 0 };

test('iOS 26 (the bug): innerHeight shrinks with the keyboard, the fixed box does not; the dock stays on screen', () => {
  // focus → keyboard up and iOS pans to the composer (offsetTop 412, scrollY 412) → our one nudge un-pans → settled.
  const [focus, panned, unpanned] = run([
    { focus: true, editing: true, inDock: true, layoutH: 852, innerHeight: 852, vvHeight: 852 },
    { editing: true, inDock: true, layoutH: 852, innerHeight: 440, vvHeight: 440, vvOffsetTop: 412, scrollY: 412 },
    { editing: true, inDock: true, layoutH: 852, innerHeight: 440, vvHeight: 440, vvOffsetTop: 0, scrollY: 0 },
  ], IPHONE);
  assert.equal(focus.open, false); assert.equal(focus.kb, 0);
  assert.deepEqual([panned.open, panned.tight, panned.kb, panned.top], [true, true, 0, 412]);
  assert.equal(panned.resetScroll, true, 'one nudge back to the top for the composer');
  assertDockOnScreen(panned, 412, 440, 'panned');
  assert.deepEqual([unpanned.open, unpanned.kb, unpanned.top, unpanned.vvh], [true, 412, 0, 440]);
  assert.equal(unpanned.resetScroll, false);
  assertDockOnScreen(unpanned, 0, 440, 'un-panned');
});

test('iOS 26 without a measured fixed box falls back to innerHeight and reproduces the owner\'s photo (why the probe exists)', () => {
  const s = viewportState({ ...IPHONE, editing: true, layoutH: 0, innerHeight: 440, vvHeight: 440, fullH: 852, fullW: 393 });
  assert.equal(s.kb, 0, 'innerHeight - vv.height = 0 on iOS 26');
  const realBox = 852;
  assert.equal(realBox - s.kb, 852, 'bottom: var(--kb) in the real 852px box: dock under the keyboard (visible area ends at 440)');
  assert.equal(s.open, true, 'still detected as open (the box looked 412px shorter than the tallest seen)…');
  assert.equal(realBox - Math.max(0, realBox - s.top - s.vvh), 440, '…so the CSS % rule, which uses the real box, still lands on 440');
  const fixed = viewportState({ ...IPHONE, editing: true, layoutH: 852, innerHeight: 440, vvHeight: 440, fullH: 852, fullW: 393 });
  assert.equal(fixed.kb, 412, 'with the measured box --kb is right too (stage height, toast, sheets use it)');
});

test('iOS 26 Home Screen app: vv.height left stale while innerHeight shrank still lifts the dock', () => {
  const [, stale] = run([
    { focus: true, editing: true, inDock: true, layoutH: 852, innerHeight: 852, vvHeight: 852 },
    { editing: true, inDock: true, layoutH: 852, innerHeight: 440, vvHeight: 852, vvOffsetTop: 0 },
  ], IPHONE);
  assert.deepEqual([stale.open, stale.kb, stale.vvh], [true, 412, 440]);
  assertDockOnScreen(stale, 0, 440, 'stale vv');
});

test('iOS Home Screen app whose fixed box resizes with the keyboard (Android-style), even in small steps', () => {
  const heights = [852, 760, 660, 560, 472];
  const states = run(heights.map((h, i) => ({ focus: i === 0, editing: true, inDock: true, layoutH: h, innerHeight: h, vvHeight: h })), IPHONE);
  assert.deepEqual(states.map((s) => s.open), [false, false, true, true, true], 'opens once the box is 150px+ below the tallest seen');
  assert.deepEqual(states.map((s) => s.fullH), [852, 852, 852, 852, 852], 'the baseline no longer ratchets down step by step');
  const last = states.at(-1);
  assert.deepEqual([last.kb, last.top, last.tight], [0, 0, false]);
  assertDockOnScreen(last, 0, 472, 'resized box');
  // the old math reset its baseline on every closed step and never saw the keyboard
  const st = { w: 393, fullH: 852 };
  assert.deepEqual(heights.map((h) => legacy(st, { ...IPHONE, editing: true, innerHeight: h, vvHeight: h }).open), [false, false, false, false, false]);
});

test('iOS 17/18 numbers (innerHeight constant): same answers as before, panned or not', () => {
  const steps = [
    { focus: true, editing: true, inDock: true, layoutH: 660, innerHeight: 660, vvHeight: 660 },
    { editing: true, inDock: true, layoutH: 660, innerHeight: 660, vvHeight: 376, vvOffsetTop: 0 }, // Safari tab, measured on 18.7
    { editing: true, inDock: true, layoutH: 660, innerHeight: 660, vvHeight: 376, vvOffsetTop: 284, scrollY: 284 }, // panned
    { editing: false, layoutH: 660, innerHeight: 660, vvHeight: 660 },
  ];
  const now = run(steps, IPHONE);
  const st = { w: 393, fullH: 660 };
  steps.forEach((m, i) => assert.deepEqual(pick(now[i]), legacy(st, { ...IPHONE, ...m }), `step ${i}`));
  assertDockOnScreen(now[1], 0, 376, 'iOS 18 un-panned');
  assertDockOnScreen(now[2], 284, 376, 'iOS 18 panned');
  assert.equal(now[1].tight, true, 'a Safari tab (376px) hides the header');
});

test('scroll resets never fight iOS: once per focus for the composer, never for other fields, frames or zoom', () => {
  const base = { ...IPHONE, layoutH: 852, innerHeight: 852, vvHeight: 470, vvOffsetTop: 382, scrollY: 382, fullH: 852, fullW: 393 };
  assert.equal(viewportState({ ...base, editing: true, inDock: true }).resetScroll, true);
  assert.equal(viewportState({ ...base, editing: true, inDock: true, nudged: true }).resetScroll, false, 'already nudged this focus');
  assert.equal(viewportState({ ...base, editing: true, inDock: false }).resetScroll, false, 'a Settings or drawer field: iOS keeps its pan');
  assert.equal(viewportState({ ...base, frame: true }).resetScroll, false, 'a field inside a Build preview: iOS is revealing it');
  assert.equal(viewportState({ ...base, editing: true, inDock: true, vvScale: 2 }).resetScroll, false, 'pinch-zoomed: the user is panning');
  assert.equal(viewportState({ ...base, vvScale: 2 }).resetScroll, false, 'pinch-zoomed with nothing focused either');
  // keyboard detection not settled yet (first vv event mid-animation): leave iOS's reveal alone
  assert.equal(viewportState({ ...base, vvHeight: 840, vvOffsetTop: 0, editing: true, inDock: true }).resetScroll, false);
  // the keyboard has gone and left the page scrolled: put it back
  assert.equal(viewportState({ ...base, vvHeight: 852, vvOffsetTop: 0 }).resetScroll, true);
  assert.equal(viewportState({ ...base, vvHeight: 852, vvOffsetTop: 0, scrollY: 0 }).resetScroll, false);
  // a whole focus: iOS re-pans after our nudge, we follow the pan instead of scrolling again
  const seq = run([
    { focus: true, editing: true, inDock: true, vvHeight: 852, vvOffsetTop: 0, scrollY: 0 },
    { editing: true, inDock: true, vvHeight: 470, vvOffsetTop: 382, scrollY: 382 },
    { editing: true, inDock: true, vvHeight: 470, vvOffsetTop: 0, scrollY: 0 },
    { editing: true, inDock: true, vvHeight: 470, vvOffsetTop: 382, scrollY: 382 },
    { editing: true, inDock: true, vvHeight: 470, vvOffsetTop: 382, scrollY: 382 },
  ], { ...IPHONE, layoutH: 852, innerHeight: 852 });
  assert.deepEqual(seq.map((s) => s.resetScroll), [false, true, false, false, false]);
  seq.slice(1).forEach((s, i) => assertDockOnScreen(s, [382, 0, 382, 382][i], 470, `step ${i + 1}`));
});

test('Build preview frame with the keyboard up: dock steps aside (kb-frame), layout untouched', () => {
  const ios = viewportState({ ...IPHONE, frame: true, layoutH: 852, innerHeight: 440, vvHeight: 440, vvOffsetTop: 412, scrollY: 412, fullH: 852, fullW: 393 });
  assert.deepEqual([ios.frameKb, ios.open, ios.kb, ios.top, ios.resetScroll, ios.typing], [true, false, 0, 0, false, true]);
  // Android: a field in the preview is tapped (focus moves in at frameAge 0), the layout shrinks for the keyboard soon after
  // and stays counted while the keyboard is up, however long that is; it ends when the keyboard goes.
  const android = run([
    { frame: true, frameAge: 0, layoutH: 852, innerHeight: 852, vvHeight: 852 },
    { frame: true, frameAge: 350, layoutH: 480, innerHeight: 480, vvHeight: 480 },
    { frame: true, frameAge: 8000, layoutH: 480, innerHeight: 480, vvHeight: 480 }, // still typing (poll)
    { frame: true, frameAge: 9000, layoutH: 400, innerHeight: 400, vvHeight: 400 }, // emoji panel
    { frame: true, frameAge: 12000, layoutH: 852, innerHeight: 852, vvHeight: 852 }, // back button: keyboard down, focus kept
    { frame: true, frameAge: 15000, layoutH: 480, innerHeight: 480, vvHeight: 480 }, // another field in the same preview
  ], IPHONE);
  assert.deepEqual(android.map((s) => s.frameKb), [false, true, true, true, false, false],
    'the last step is the old behaviour (no kb-frame): from the parent page it looks just like split-screen');
  assert.ok(android.every((s) => !s.open && s.kb === 0 && !s.resetScroll));
  const tapped = viewportState({ ...IPHONE, frame: true, layoutH: 852, innerHeight: 852, vvHeight: 852, fullH: 852, fullW: 393 });
  assert.equal(tapped.frameKb, false, 'tapping a button in a preview (no keyboard) keeps the composer');
  const desk = viewportState({ innerWidth: 1280, coarse: false, frame: true, layoutH: 800, innerHeight: 800, vvHeight: 800, fullH: 800, fullW: 1280 });
  assert.equal(desk.frameKb, false);
});

test('Android split-screen / freeform resize while a preview holds focus with no keyboard: the composer stays', () => {
  // A tap on a button in the Build preview leaves the iframe focused without a keyboard; later the window halves at the
  // same width. Before the fix the baseline stayed at 860, the 440px drop read as a keyboard and kb-frame hid the dock.
  const A = { innerWidth: 412, coarse: true, vvScale: 1, scrollY: 0, vvOffsetTop: 0 };
  const steps = [
    { frame: false, layoutH: 860 },
    { frame: true, frameAge: 0, layoutH: 860 },     // tap a button in the preview
    { frame: true, frameAge: 900, layoutH: 860 },   // still no keyboard when the window closes
    { frame: true, frameAge: 4000, layoutH: 420 },  // enter portrait split-screen
    { frame: true, frameAge: 4700, layoutH: 420 },  // 700ms poll
    { frame: true, frameAge: 9000, layoutH: 860 },  // leave split-screen
    { frame: true, frameAge: 12000, layoutH: 300 }, // freeform window made shorter
  ].map((m) => ({ ...m, innerHeight: m.layoutH, vvHeight: m.layoutH }));
  const now = run(steps, A);
  assert.ok(now.every((s) => !s.frameKb && !s.open && s.kb === 0 && !s.resetScroll), JSON.stringify(now.map((s) => s.frameKb)));
  assert.deepEqual(now.map((s) => s.fullH), steps.map((s) => s.layoutH), 'the baseline follows the window, as the old math did');
  // the same drop right after focus moved in is the keyboard (the case kb-frame exists for)
  const kb = run([{ frame: true, frameAge: 0, layoutH: 860 }, { frame: true, frameAge: FRAME_KB_MS - 1, layoutH: 420 }]
    .map((m) => ({ ...m, innerHeight: m.layoutH, vvHeight: m.layoutH })), A);
  assert.deepEqual(kb.map((s) => s.frameKb), [false, true]);
  // a missing frameAge (unknown) never counts as fresh
  assert.equal(viewportState({ ...A, frame: true, layoutH: 420, innerHeight: 420, vvHeight: 420, fullH: 860, fullW: 412 }).frameKb, false);
});

test('Android resizes-content: identical to the old math for a one-step keyboard, rotation resets the baseline', () => {
  const A = { innerWidth: 412, coarse: true, vvScale: 1, scrollY: 0, vvOffsetTop: 0 };
  const steps = [
    { editing: false, innerHeight: 860, vvHeight: 860 },
    { focus: true, editing: true, inDock: true, innerHeight: 860, vvHeight: 860 },
    { editing: true, inDock: true, innerHeight: 480, vvHeight: 480 },
    { editing: true, inDock: true, innerHeight: 400, vvHeight: 400 }, // emoji / clipboard panel: tight
    { editing: true, inDock: true, innerHeight: 860, vvHeight: 860 }, // back button: keyboard down, focus kept
    { editing: true, inDock: true, innerHeight: 470, vvHeight: 470 },
    { editing: false, innerHeight: 860, vvHeight: 860 },
    { editing: true, inDock: true, innerWidth: 915, innerHeight: 412, vvHeight: 412 }, // rotated with focus: new baseline
  ].map((m) => ({ ...m, layoutH: m.innerHeight }));
  const now = run(steps, A);
  const st = { w: 412, fullH: 860 };
  steps.forEach((m, i) => assert.deepEqual(pick(now[i]), legacy(st, { ...A, ...m }), `step ${i}`));
  assert.deepEqual(now.map((s) => s.open), [false, false, true, true, false, true, false, false]);
  assert.deepEqual(now.map((s) => s.kb), [0, 0, 0, 0, 0, 0, 0, 0], 'the layout itself shrank: nothing to lift');
  now.forEach((s, i) => assertDockOnScreen(s, 0, steps[i].vvHeight, `step ${i}`));
});

test('desktop: identical to the old math, never opens, window resizes track --full-h', () => {
  const D = { innerWidth: 1280, coarse: false, vvScale: 1, scrollY: 0, vvOffsetTop: 0 };
  const steps = [
    { editing: false, innerHeight: 800, vvHeight: 800 },
    { editing: true, inDock: true, innerHeight: 800, vvHeight: 800 },
    { editing: true, inDock: true, innerHeight: 600, vvHeight: 600 }, // window made shorter while typing
    { editing: true, inDock: true, innerWidth: 900, innerHeight: 600, vvHeight: 600 },
    { editing: false, innerHeight: 1000, vvHeight: 1000 },
    { editing: true, inDock: true, innerHeight: 1000, vvHeight: 1000, vvScale: 1.5 }, // ctrl-zoom is scale 1; trackpad pinch is not
  ].map((m) => ({ ...m, layoutH: m.innerHeight }));
  const now = run(steps, D);
  const st = { w: 1280, fullH: 800 };
  steps.forEach((m, i) => assert.deepEqual(pick(now[i]), legacy(st, { ...D, ...m }), `step ${i}`));
  assert.ok(now.every((s) => !s.open && s.kb === 0 && s.top === 0 && !s.resetScroll && !s.frameKb));
  assert.deepEqual(now.map((s) => s.fullH), [800, 800, 600, 600, 1000, 1000]);
});

test('pinch-zoom while typing keeps the last answer (dock where it was) until the zoom ends or nothing is typed in', () => {
  // no previous answer to keep: the zoomed fallback, the layout left alone, nothing lifted or scrolled
  const s = viewportState({ ...IPHONE, editing: true, inDock: true, layoutH: 852, innerHeight: 852, vvHeight: 300, vvOffsetTop: 200, vvScale: 2.8, scrollY: 500, fullH: 852, fullW: 393 });
  assert.deepEqual([s.zoomed, s.open, s.kb, s.top, s.vvh, s.resetScroll, s.typing], [true, false, 0, 0, 852, false, false]);
  // iPhone, keyboard up, then a pinch (probe 852, innerHeight 440, vv 293 at ×1.5 reset everything to "closed" before)
  const [up, zoomed, zoomedMore, back] = run([
    { focus: true, editing: true, inDock: true, layoutH: 852, innerHeight: 440, vvHeight: 440 },
    { editing: true, inDock: true, layoutH: 852, innerHeight: 440, vvHeight: 293, vvScale: 1.5, vvOffsetTop: 60, scrollY: 60 },
    { editing: true, inDock: true, layoutH: 852, innerHeight: 440, vvHeight: 176, vvScale: 2.5, vvOffsetTop: 140, scrollY: 140 },
    { editing: true, inDock: true, layoutH: 852, innerHeight: 440, vvHeight: 440 },
  ], IPHONE);
  assert.deepEqual([up.open, up.kb, up.tight], [true, 412, true]);
  for (const z of [zoomed, zoomedMore]) {
    assert.deepEqual(pick(z), pick(up), '--kb, --vvh and the classes stay as they were');
    assert.equal(z.zoomed, true);
    assert.equal(z.resetScroll, false, 'never scrolls while the user pans');
    assert.equal(z.typing, true, 'the Home Screen poll keeps running');
  }
  assert.deepEqual(pick(back), pick(up));
  // the field loses focus while zoomed (Done): the keyboard has gone, so nothing stays lifted
  const done = viewportState({ ...IPHONE, editing: false, layoutH: 852, innerHeight: 852, vvHeight: 568, vvScale: 1.5, prev: up, fullH: up.fullH, fullW: up.fullW });
  assert.deepEqual([done.open, done.kb, done.tight, done.zoomed], [false, 0, false, true]);
  // Android: keyboard up, a pinch, the zoom ends: still open, because the baseline was kept (it was lost before)
  const A = { innerWidth: 412, coarse: true, vvScale: 1, scrollY: 0, vvOffsetTop: 0 };
  const lay = (h, o) => ({ layoutH: h, innerHeight: h, vvHeight: h, editing: true, inDock: true, ...o });
  const android = run([lay(900, { focus: true }), lay(600), lay(600, { vvHeight: 400, vvScale: 1.5 }), lay(600)], A);
  assert.deepEqual(android.map((x) => x.open), [false, true, true, true]);
  assert.deepEqual(android.map((x) => x.fullH), [900, 900, 900, 900]);
  // …and when the layout resizes under the zoom (the back button closed the keyboard, then it opened again), it is read
  // again: nothing lifted while zoomed, the baseline kept while the field has focus, open once the zoom ends
  const resized = run([lay(900, { focus: true }), lay(600), lay(900, { vvHeight: 600, vvScale: 1.5 }), lay(600, { vvHeight: 400, vvScale: 1.5 }), lay(600)], A);
  assert.deepEqual(resized.map((x) => x.open), [false, true, false, false, true]);
  assert.deepEqual(resized.map((x) => x.fullH), [900, 900, 900, 900, 900]);
});

test('focus from the composer (keyboard up) into a Build preview: the dock never blinks out while that keyboard closes', () => {
  // iPhone 430×932 (iOS 26 numbers): the composer's keyboard is 346. A tap on the preview's canvas moves focus into it
  // while the numbers still show the keyboard, then the keyboard closes. syncViewport passes handoff (the composer's
  // keyboard was open when focus moved in).
  const P = { ...IPHONE, innerWidth: 430 };
  const ios = (h, o) => ({ layoutH: 932, innerHeight: h, vvHeight: h, ...o });
  const closing = [
    ios(932, { focus: true, editing: true, inDock: true }),
    ios(586, { editing: true, inDock: true }),
    ios(586, { frame: true, handoff: true, frameAge: 0 }),
    ios(586, { frame: true, handoff: true, frameAge: 120 }),
    ios(760, { frame: true, handoff: true, frameAge: 300 }),
    ios(932, { frame: true, handoff: true, frameAge: 450 }),
    ios(932, { frame: true, handoff: true, frameAge: 2000 }),
  ];
  const now = run(closing, P);
  assert.equal(now[1].open, true);
  assert.deepEqual(now.map((s) => s.frameKb), [false, false, false, false, false, false, false]);
  assert.ok(now.every((s) => !s.resetScroll));
  // the same steps without the hold (the reviewer's repro): hidden from focus-in until the keyboard was all the way down
  assert.deepEqual(run(closing.map((m) => ({ ...m, handoff: false })), P).map((s) => s.frameKb), [false, false, true, true, true, false, false]);
  // a tap on a field in the preview instead: the keyboard stays, and once the hold is over it is the preview's
  const stays = run([
    ios(932, { focus: true, editing: true, inDock: true }),
    ios(586, { editing: true, inDock: true }),
    ios(586, { frame: true, handoff: true, frameAge: 0 }),
    ios(586, { frame: true, handoff: true, frameAge: FRAME_HANDOFF_MS - 1 }),
    ios(586, { frame: true, handoff: true, frameAge: FRAME_HANDOFF_MS + 20 }),
    ios(586, { frame: true, handoff: true, frameAge: 5000 }),
    ios(932, { frame: true, handoff: true, frameAge: 6000 }), // keyboard dismissed, focus kept
  ], P);
  assert.deepEqual(stays.map((s) => s.frameKb), [false, false, false, false, true, true, false]);
  // Android 412×852: the composer's keyboard shrank the layout to 480 (FRAME_KB_MS keeps the 852 baseline after focus-in)
  const A = { innerWidth: 412, coarse: true, vvScale: 1, scrollY: 0, vvOffsetTop: 0 };
  const lay = (h, o) => ({ layoutH: h, innerHeight: h, vvHeight: h, ...o });
  const closes = run([
    lay(852, { focus: true, editing: true, inDock: true }),
    lay(480, { editing: true, inDock: true }),
    lay(480, { frame: true, handoff: true, frameAge: 0 }),
    lay(640, { frame: true, handoff: true, frameAge: 150 }),
    lay(852, { frame: true, handoff: true, frameAge: 300 }),
    lay(852, { frame: true, handoff: true, frameAge: 2000 }),
  ], A);
  assert.equal(closes[1].open, true);
  assert.deepEqual(closes.map((s) => s.frameKb), [false, false, false, false, false, false]);
  const kept = run([
    lay(852, { focus: true, editing: true, inDock: true }),
    lay(480, { editing: true, inDock: true }),
    lay(480, { frame: true, handoff: true, frameAge: 0 }),
    lay(480, { frame: true, handoff: true, frameAge: FRAME_HANDOFF_MS + 20 }),
    lay(480, { frame: true, handoff: true, frameAge: 8000 }), // long after FRAME_KB_MS: still the preview's keyboard
  ], A);
  assert.deepEqual(kept.map((s) => s.frameKb), [false, false, false, true, true]);
  // no handoff (the keyboard was down when focus moved in): a keyboard that opens for the preview hides the dock at once
  assert.equal(viewportState({ ...P, frame: true, handoff: false, frameAge: 0, layoutH: 932, innerHeight: 586, vvHeight: 586, fullH: 932, fullW: 430 }).frameKb, true);
  assert.ok(FRAME_HANDOFF_MS < FRAME_KB_MS, 'Android keeps its baseline past the hold');
});

test('no visualViewport (old browsers): innerHeight, never open', () => {
  const s = viewportState({ innerWidth: 390, innerHeight: 700, editing: true, coarse: true, fullH: 700, fullW: 390 });
  assert.deepEqual([s.vvh, s.kb, s.open, s.layoutH], [700, 0, false, 700]);
});

test('iOS 26.0 leftover offsetTop / short vv after the keyboard closed: ignored until something is typed in again', () => {
  const s = viewportState({ ...IPHONE, editing: false, layoutH: 852, innerHeight: 852, vvHeight: 828, vvOffsetTop: 24, fullH: 852, fullW: 393 });
  assert.deepEqual([s.open, s.kb, s.top, s.resetScroll], [false, 0, 0, false]);
});

test('thresholds are the ones the CSS comments describe', () => {
  assert.deepEqual([KB_MIN, KB_RESIZE, TIGHT_H], [40, 150, 460]);
  const at = (vvHeight) => viewportState({ ...IPHONE, editing: true, layoutH: 852, innerHeight: 852, vvHeight, fullH: 852, fullW: 393 });
  assert.equal(at(812).open, false); assert.equal(at(811).open, true);
  assert.equal(at(460).tight, false); assert.equal(at(459).tight, true);
});

test('?kbdebug flag: URL wins (1 on, 0 off), otherwise the tab\'s stored choice; off by default', () => {
  assert.equal(kbDebugFlag('?kbdebug=1', null), true);
  assert.equal(kbDebugFlag('?mode=ask&kbdebug=1', null), true);
  assert.equal(kbDebugFlag('?kbdebug=0', '1'), false);
  assert.equal(kbDebugFlag('', '1'), true);
  assert.equal(kbDebugFlag('', null), false);
  assert.equal(kbDebugFlag('?kbdebug=yes', null), false);
  assert.equal(kbDebugFlag(undefined, undefined), false);
});

test('iOS version from the UA (frozen at 18.x since iOS 26; Safari\'s Version/ is the real one, absent in Home Screen apps)', () => {
  const safari = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1';
  const app = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
  const old = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
  assert.deepEqual(iosVersion(safari), { os: '18.6', safari: '26.1' });
  assert.deepEqual(iosVersion(app), { os: '18.6', safari: '' });
  assert.deepEqual(iosVersion(old), { os: '17.5.1', safari: '17.5' });
  assert.equal(iosVersion('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36'), null);
  assert.equal(iosVersion('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15'), null);
});

test('readout text: every number the owner needs, and a plain verdict on the dock', () => {
  const state = viewportState({ ...IPHONE, editing: true, inDock: true, layoutH: 852, innerHeight: 440, vvHeight: 440, fullH: 852, fullW: 393 });
  const d = { standalone: true, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
    iw: 393, ih: 440, ch: 852, layoutH: 852, vvH: 440, vvTop: 0, pageTop: 0, scale: 1, scrollY: 0, state, dockBottom: 440,
    active: 'textarea#input', cls: 'kb-open kb-tight', ev: 'resize', n: 7 };
  const text = kbDebugText(d);
  for (const want of ['Home Screen app', 'iOS ua 18.6', 'inner 393×440', 'fixed 852', 'vv h 440', 'top 0', 'scrollY 0', 'kb 412', 'open Y', 'tight Y',
    'dock bottom 440', 'vv bottom 440', ' ok', 'textarea#input', 'resize #7']) assert.ok(text.includes(want), `readout shows "${want}"\n${text}`);
  assert.match(kbDebugText({ ...d, dockBottom: 852 }), /DOCK CUT 412px/);
  assert.match(kbDebugText({ ...d, dockBottom: 400 }), /gap 40px/);
  assert.match(kbDebugText({ ...d, standalone: false, ua: 'Mozilla/5.0 (Linux; Android 15)' }), /browser tab · not iOS/);
  assert.match(kbDebugText({ ...d, vvTop: 412.5, vvH: 439.75 }), /vv h 439\.8 · top 412\.5/);
});

// ── iOS Home Screen app bottom gap (WebKit 301994 / first-keyboard shrink): the window ends a strip above the screen ──
// The owner's iPhone (393×852, iOS 27 Home Screen app, keyboard closed): innerHeight, clientHeight, the fixed box and the
// visual viewport all said 793, so the dock sat 59px above the screen's bottom edge.
const APP = { ...IPHONE, standalone: true, ios: true, screenW: 393, screenH: 852, safeTop: 59 };
const SHORT = { layoutH: 793, innerHeight: 793, vvHeight: 793 };
// Where the dock's bottom edge lands with html.vp-gap .dock { bottom: calc(var(--kb) - var(--vp-gap)) } (keyboard closed).
const dockBottomGap = (s) => (s.open ? dockBottom(s) : s.layoutH - s.kb + s.gap);

test('owner\'s readout: standalone, every measure 793 on an 852 screen, no keyboard: extend 59px, the dock ends on the screen\'s bottom', () => {
  const s = viewportState({ ...APP, ...SHORT, editing: false, fullH: 793, fullW: 393 });
  assert.deepEqual([s.open, s.kb, s.top, s.vvh, s.layoutH], [false, 0, 0, 793, 793], 'the keyboard math is untouched');
  assert.equal(s.gap, 59); assert.equal(s.heal, true, 'try WebKit\'s own recovery first');
  assert.equal(dockBottomGap(s), 852, 'dock bottom at the 852 screen edge');
  assert.equal(s.layoutH + s.gap, 852, '--vp-full: the stage runs to the screen\'s bottom too');
  // the same numbers anywhere else: nothing changes
  for (const [name, m] of [['Safari tab', { standalone: false }], ['Android PWA', { ios: false }], ['desktop', { standalone: false, ios: false, coarse: false }],
    ['no screen numbers', { screenW: 0, screenH: 0 }]]) {
    const o = viewportState({ ...APP, ...SHORT, ...m, editing: false, fullH: 793, fullW: 393 });
    assert.deepEqual([o.gap, o.heal], [0, false], name);
  }
});

test('bottom gap: zero while the keyboard is up or a preview has it, when the page starts below the status bar, or for a real window', () => {
  const [, up] = run([
    { focus: true, editing: true, inDock: true, ...SHORT },
    { editing: true, inDock: true, layoutH: 793, innerHeight: 440, vvHeight: 440 },
  ], APP);
  assert.deepEqual([up.open, up.gap, up.heal], [true, 0, false], 'kb-open owns the dock');
  assertDockOnScreen(up, 0, 440, 'keyboard up in the short window');
  const frame = viewportState({ ...APP, frame: true, frameAge: 5000, frameKb: true, layoutH: 793, innerHeight: 400, vvHeight: 400, fullH: 793, fullW: 393 });
  assert.deepEqual([frame.frameKb, frame.gap], [true, 0], 'a Build preview\'s keyboard: dock hidden, no extension');
  // WebKit 301994's other shape: the page is pushed below the status bar (inset 0), so its bottom already is the screen's
  assert.equal(viewportState({ ...APP, ...SHORT, safeTop: 0 }).gap, 0);
  assert.equal(viewportState({ ...APP, layoutH: 852, innerHeight: 852, vvHeight: 852 }).gap, 0, 'a healthy window');
  assert.equal(viewportState({ ...APP, layoutH: 852 - GAP_MIN, innerHeight: 848, vvHeight: 848 }).gap, 0, 'rounding noise');
  assert.equal(viewportState({ ...APP, layoutH: 852 - GAP_MAX - 1, innerHeight: 751, vvHeight: 751 }).gap, 0, 'iPad split view / a real smaller window');
  assert.equal(viewportState({ ...APP, layoutH: 852 - GAP_MAX, innerHeight: 752, vvHeight: 752 }).gap, GAP_MAX);
  // landscape: iOS keeps screen.width/height portrait; the screen's height is then its width (no top inset in landscape)
  assert.equal(screenSide(852, 393, 852), 393); assert.equal(screenSide(393, 393, 852), 852); assert.equal(screenSide(393, 0, 852), 0);
  assert.equal(bottomGap({ ...APP, innerWidth: 852, safeTop: 0 }, 372), 21);
  assert.equal(bottomGap({ ...APP, innerWidth: 852, safeTop: 0 }, 393), 0);
});

test('stale state after the keyboard closes with no resize event: the settle re-reads clear kb-open and extend into the gap', () => {
  // keyboard up, then focus leaves (focusout) with no resize/vv event: vv.height and innerHeight still say 440
  const [, up, stale, settled] = run([
    { focus: true, editing: true, inDock: true, ...SHORT },
    { editing: true, inDock: true, layoutH: 793, innerHeight: 440, vvHeight: 440 },
    { editing: false, layoutH: 793, innerHeight: 440, vvHeight: 440 },  // focusout: settle re-read, numbers stale
    { editing: false, ...SHORT },                                       // a later re-read once WebKit catches up
  ], APP);
  assert.equal(up.open, true);
  assert.deepEqual([stale.open, stale.kb, stale.top], [false, 0, 0], 'nothing focused: kb-open cleared even with stale numbers');
  assert.equal(stale.gap, 59); assert.equal(dockBottomGap(stale), 852, 'dock back on the screen\'s bottom at once');
  assert.deepEqual([settled.open, settled.gap, dockBottomGap(settled)], [false, 59, 852]);
});

test('resume from the background (pageshow / visibilitychange, no resize): read again, the dock lands on the screen\'s bottom', () => {
  // left with the keyboard up and a 59px pan, came back with nothing focused and a window that came back short
  const [, away, back] = run([
    { focus: true, editing: true, inDock: true, layoutH: 852, innerHeight: 852, vvHeight: 852 },
    { editing: true, inDock: true, layoutH: 852, innerHeight: 440, vvHeight: 440, vvOffsetTop: 59, scrollY: 59 },
    { editing: false, ...SHORT, vvOffsetTop: 0, scrollY: 0 },
  ], APP);
  assert.equal(away.open, true);
  assert.deepEqual([back.open, back.kb, back.top, back.gap, back.heal], [false, 0, 0, 59, true]);
  assert.equal(dockBottomGap(back), 852);
  // resumed with a healthy window: no extension, no heal
  const fine = viewportState({ ...APP, layoutH: 852, innerHeight: 852, vvHeight: 852, prev: back, fullH: back.fullH, fullW: back.fullW });
  assert.deepEqual([fine.gap, fine.heal, dockBottomGap(fine)], [0, false, 852]);
});

test('first keyboard shrinks the window for good (932 → 873 reports): heal asked once it is down, extended until it recovers', () => {
  const PRO_MAX = { ...APP, innerWidth: 430, screenW: 430, screenH: 932 };
  const [boot, up, down, healed] = run([
    { layoutH: 932, innerHeight: 932, vvHeight: 932 },
    { focus: true, editing: true, inDock: true, layoutH: 932, innerHeight: 500, vvHeight: 500 },
    { editing: false, layoutH: 873, innerHeight: 873, vvHeight: 873 },
    { editing: false, layoutH: 932, innerHeight: 932, vvHeight: 932 }, // after the display toggle
  ], PRO_MAX);
  assert.deepEqual([boot.gap, boot.heal, dockBottomGap(boot)], [0, false, 932]);
  assert.deepEqual([up.open, up.gap], [true, 0]);
  assert.deepEqual([down.open, down.gap, down.heal, dockBottomGap(down)], [false, 59, true, 932]);
  assert.deepEqual([healed.gap, healed.heal, dockBottomGap(healed)], [0, false, 932]);
});

test('bottom gap leaves every non-standalone answer exactly as it was (legacy comparison)', () => {
  for (const m of [
    { ...IPHONE, innerHeight: 793, vvHeight: 793, editing: false },
    { ...IPHONE, innerHeight: 852, vvHeight: 440, editing: true },
    { innerWidth: 1280, innerHeight: 720, vvHeight: 720, vvOffsetTop: 0, vvScale: 1, editing: true, coarse: false },
  ]) {
    const st = { w: 0, fullH: 0 };
    const now = viewportState({ ...m, screenW: 393, screenH: 852, safeTop: 59, fullH: m.innerHeight, fullW: m.innerWidth });
    assert.deepEqual(pick(now), legacy(st, m));
    assert.deepEqual([now.gap, now.heal], [0, false]);
  }
});

test('readout: screen, insets, gap and the dock verdict against the extended target', () => {
  const state = viewportState({ ...APP, ...SHORT, editing: false, fullH: 793, fullW: 393 });
  const d = { standalone: true, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
    iw: 393, ih: 793, ch: 793, layoutH: 793, htmlH: 852, sw: 393, sh: 852, safeTop: 59, safeBottom: 34, heals: 1, vvH: 793, vvTop: 0, pageTop: 0,
    scale: 1, scrollY: 0, state, dockBottom: 852, active: 'body', cls: '', ev: 'reread', n: 564 };
  const text = kbDebugText(d);
  for (const want of ['screen 393×852', 'safe top 59', 'bottom 34', 'gap 59 (extended)', 'heals 1', 'html 852', 'fixed 793', 'target 852', ' ok'])
    assert.ok(text.includes(want), `readout shows "${want}"\n${text}`);
  assert.match(kbDebugText({ ...d, dockBottom: 793 }), /gap 59px$/m, 'the owner\'s v62 picture reads as a 59px gap');
  const healthy = viewportState({ ...APP, layoutH: 852, innerHeight: 852, vvHeight: 852 });
  assert.match(kbDebugText({ ...d, state: healthy, vvH: 852, dockBottom: 852 }), /gap 0 ·/);
});

// ── wiring (source checks): the browser-only half can't run under node ──
test('app.js measures the fixed box and wires every viewport trigger', async () => {
  const app = await read('public/app.js');
  assert.match(app, /^import \{[^}]*\bviewportState\b[^}]*\} from '\.\/viewport\.js(\?v=\d+)?';\r?$/m);
  assert.match(app, /position:fixed;top:0;bottom:0;[^']*visibility:hidden;pointer-events:none/, 'fixed probe');
  assert.match(app, /layoutH: vpProbe\.offsetHeight \|\| root\.clientHeight/);
  assert.match(app, /if \(frame !== vpFrame\) \{\s*vpFrame = frame; vpFrameAt = performance\.now\(\); vpHandoff = !!frame && vp\.open;/, 'focus moving into (or between) previews restarts frameAge and notes a handoff from the composer\'s keyboard');
  assert.match(app, /if \(vpHandoff\) setTimeout\(syncViewport, FRAME_HANDOFF_MS \+ 20, 'handoff'\)/, 'read again when the handoff hold ends');
  assert.match(app, /handoff: vpHandoff,/);
  assert.match(app, /fullH: vp\.fullH, fullW: vp\.fullW, prev: vp,/, 'the previous answer, kept while pinch-zoomed');
  // a width-only resize changes the key, so the composer text is re-fitted (the old visualViewport resize → autosize)
  assert.match(app, /const key = \[vp\.vvh, vp\.kb, vp\.top, vp\.open, vp\.tight, vp\.frameKb, vp\.fullH, vp\.fullW, vp\.gap\]\.join\(\);/);
  assert.match(app, /root\.classList\.toggle\('kb-frame', vp\.frameKb\);\s*if \(input\.value\) fitInput\(\);/);
  assert.match(app, /frame: !!frame, frameAge: performance\.now\(\) - vpFrameAt, frameKb: vp\.frameKb,/, 'frameAge and the previous frameKb reach viewport.js');
  assert.ok(!/Math\.round\(innerHeight - vv\.height/.test(app), 'the iOS 26-broken formula is gone');
  for (const re of [/vv\?\.addEventListener\('resize', vpEvent\)/, /vv\?\.addEventListener\('scroll', vpEvent\)/, /^addEventListener\('resize', syncViewport\)/m,
    /document\.addEventListener\('focusin', \(ev\) => \{ vpNudged = false; vpEvent\(ev\); \}\)/, /document\.addEventListener\('focusout', \(\) => \{ vpHealArm = true; vpSettle\(\); \}\)/,
    /^addEventListener\('blur', /m, /^addEventListener\('focus', vpEvent\)/m, /document\.addEventListener\('compositionend', /])
    assert.ok(re.test(app), `wired: ${re}`);
  assert.match(app, /const vpEvent = \(ev\) => \{ syncViewport\(ev\); vpSettle\(\); \}/, 'every vv event also starts the settle loop');
  assert.match(app, /requestAnimationFrame\(function tick\(\)/, 'per-frame re-sync while the keyboard animates');
  assert.match(app, /const VP_REREAD = \[50, 150, 300, 600, 1000\]/, 'timed re-reads a background tab cannot skip');
  assert.match(app, /setInterval\(syncViewport, 700, 'poll'\)/, 'slow poll while typing on a touch screen');
  // scrollTo(0,0) only where viewport.js allows it
  const scrolls = [...app.matchAll(/scrollTo\(0, 0\)/g)].length;
  assert.equal(scrolls, 1, 'one scrollTo(0, 0) left');
  assert.match(app, /if \(vp\.resetScroll\) \{ if \(vp\.open\) vpNudged = true; scrollTo\(0, 0\); vpSettle\(0\); \}/, 'a reset re-reads without extending the settle loop');
  for (const v of ['--vvh', '--kb', '--vv-top', '--full-h']) assert.ok(app.includes(`root.style.setProperty('${v}'`), v);
  for (const c of ['kb-open', 'kb-tight', 'kb-frame']) assert.ok(app.includes(`root.classList.toggle('${c}'`), c);
  assert.match(app, /if \(vp\.open\) cap = Math\.min\(cap, /, 'autosize caps the textarea to the visible area while typing');
  // the readout exists only when asked for, and is read before boot() strips the query string
  assert.match(app, /setKbDebug\(kbDebugFlag\(location\.search, stored\)\)/);
  assert.match(app, /kbDebug = on \? createKbDebug\(/);
  assert.ok(app.indexOf('setKbDebug(kbDebugFlag(') < app.indexOf("history.replaceState(null, '', '/')"));
  // iOS Home Screen app bottom gap
  assert.match(app, /const IOS_APP = PLATFORM === 'ios' && STANDALONE\(\);\s*if \(IOS_APP\) document\.documentElement\.dataset\.standalone = 'ios';/);
  assert.match(app, /\.\.\.\(IOS_APP && \{ standalone: true, ios: true, screenW: screen\.width, screenH: screen\.height, safeTop: vpInsets\(\)\.top \}\)/,
    'only an iOS Home Screen app passes the screen numbers');
  for (const v of ['--vp-gap', '--vp-full']) assert.ok(app.includes(`root.style.setProperty('${v}'`), v);
  assert.ok(app.includes("root.classList.toggle('vp-gap', vp.gap > 0)"));
  assert.match(app, /vp\.fullW, vp\.gap\]\.join\(\)/, 'a gap change re-applies');
  assert.match(app, /if \(vp\.heal && vpHealArm && !vpHealT\) \{ vpHealArm = false; vpHealT = setTimeout\(vpHeal, 150\); \}/, 'one heal per trigger');
  assert.match(app, /if \(!IOS_APP \|\| el\?\.matches\?\.\(EDITABLE\) \|\| el\?\.tagName === 'IFRAME'\) return;/, 'never with a field or preview focused');
  assert.match(app, /root\.style\.display = 'none';\s*void root\.offsetHeight;\s*root\.style\.display = '';/);
  for (const re of [/^addEventListener\('pageshow', vpRearm\)/m, /document\.addEventListener\('visibilitychange', \(ev\) => \{ if \(document\.visibilityState === 'visible'\) vpRearm\(ev\); \}\)/,
    /^addEventListener\('orientationchange', vpRearm\)/m, /document\.addEventListener\('focusout', \(\) => \{ vpHealArm = true; vpSettle\(\); \}\)/])
    assert.ok(re.test(app), `wired: ${re}`);
});

test('CSS keeps the dock on the visible bottom, hides it for preview typing, and only the header goes when tight', async () => {
  const css = await read('public/studio.css');
  assert.ok(css.includes('html.kb-open .dock { bottom: max(0px, calc(100% - var(--vv-top, 0px) - var(--vvh, 100%))); }'));
  assert.ok(css.includes('html.kb-frame .dock { visibility: hidden; }'));
  assert.ok(css.includes('html.vp-gap .dock { bottom: calc(var(--kb, 0px) - var(--vp-gap, 0px));'), 'the dock extends into the strip');
  assert.ok(css.includes('html.vp-gap #stage { height: var(--vp-full, 100dvh); }'));
  assert.ok(css.includes('html.vp-gap { height: calc(100% + var(--vp-gap, 0px)); }'));
  for (const [, sel] of css.matchAll(/html\.kb-tight ([^{]+)\{[^}]*(?:display:\s*none|visibility:\s*hidden)/g))
    assert.doesNotMatch(sel, /dock|composer|#input|composer-row/, `kb-tight never hides the composer (${sel.trim()})`);
});

test('viewport.js ships: precached, syntax-checked, Settings toggle is owner-only', async () => {
  const [sw, pkg, html] = await Promise.all([read('public/sw.js'), read('package.json'), read('public/index.html')]);
  assert.match(sw, /['`]\/viewport\.js(\?v=\$\{V\})?['`]/, 'in the service worker shell');
  assert.ok(JSON.parse(pkg).scripts.check.includes('node --check public/viewport.js'));
  const section = html.slice(html.lastIndexOf('<section', html.indexOf('id="kbDebugBtn"')), html.indexOf('id="kbDebugBtn"'));
  assert.match(section, /<section class="field-group owner-only">/);
});
