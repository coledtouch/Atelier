/* Atelier — on-screen keyboard math for the composer (syncViewport() in app.js).
   viewportState() is pure (no DOM) and unit-tested in tests/viewport.test.mjs. All lengths are CSS px in the box that
   position:fixed elements are laid out in (the "layout"): the dock sits `kb` above its bottom, the header `top` below its top,
   so the dock's bottom edge is at top + vvh: the bottom of what is actually on screen.

   What each platform does when the keyboard opens (2025–26 reports, see the tests for the numbers):
   - iOS ≤ 18 Safari: the layout never resizes. The visual viewport shrinks (vv.height) and may pan down (vv.offsetTop).
   - iOS 26+: window.innerHeight now shrinks with the visual viewport too, but the fixed layout box does not, so the layout
     height is measured (a fixed probe), never taken from innerHeight. Home Screen apps can deliver vv events late or not at all.
   - Android Chrome/Firefox (interactive-widget=resizes-content): the layout itself shrinks. kb stays ~0 and the keyboard
     shows as the layout dropping well below the tallest height seen at this width.
   - Desktop: no keyboard. Pinch-zoom (scale > 1) is the user panning: leave the layout alone. */

export const KB_MIN = 40;     // visible area this much shorter than the layout: keyboard up (iOS model)
export const KB_RESIZE = 150; // layout this much shorter than the tallest at this width: keyboard up (Android model)
export const TIGHT_H = 460;   // below this visible height the header gives its rows to the conversation
export const FRAME_KB_MS = 1500; // a Build preview's keyboard resizes the layout this soon after focus moves into it
export const GAP_MIN = 4;      // iOS Home Screen app: the layout ends at least this far above the screen's bottom edge: extend down
export const GAP_MAX = 100;   // a status-bar-sized strip (59–62px seen on iOS 26/27); more is a real smaller window (iPad split view)
export const STRIP_MIN = 40, STRIP_MAX = 80; // a status bar (iPhone 44–62px): the only gap trusted when no safe-area inset reads
export const FRAME_HANDOFF_MS = 600; // focus moved into a preview with the composer's keyboard up: wait this long to tell
                                     // a keyboard on its way down from one that stays for a field in the preview

const px = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/* m: { layoutH, innerHeight, innerWidth, vvHeight, vvOffsetTop, vvScale, scrollY, editing, frame, frameAge, frameKb, handoff,
        inDock, nudged, coarse, fullH, fullW, prev, standalone }
   - layoutH: height of the fixed layout box (a position:fixed top:0 bottom:0 probe), 0 if unknown
   - editing: an editable field in this page has focus; frame: a Build preview iframe has focus
   - frameAge: ms since focus moved into that iframe (missing: long ago); frameKb: the previous result's frameKb
   - handoff: focus moved into that iframe while the composer's keyboard was up (the previous result's open, taken when
     focus moved in)
   - fullH/fullW: the previous result's fullH/fullW (tallest layout seen at this width while typing)
   - prev: the previous result (kept as it is while pinch-zoomed during typing)
   - standalone + ios: iOS Home Screen app; screenW/screenH: screen.width/height (portrait on iOS, whatever the rotation);
     safeTop/safeBottom: env(safe-area-inset-top/bottom) in px; largeH: the tallest of 100vh / 100lvh measured (a fixed
     element that tall). Used only for the bottom gap (below); the keyboard math never looks at them.

   The bottom gap (iOS 26/27 Home Screen apps, WebKit 301994 and the "first keyboard shrinks the window for good" bug):
   innerHeight, clientHeight, 100dvh, visualViewport and the fixed box can all report the screen minus a status-bar-sized
   strip (393×852 iPhone: 793) while the page still starts at the top of the screen, so the dock lands that strip above
   the bottom edge with an empty band under it. No measure inside the page says so; only screen.height does. With no
   keyboard, `gap` is how far to extend down (--vp-gap, html.vp-gap in studio.css) and `heal` asks app.js to try WebKit's
   own recovery first (a display toggle on the root). Evidence, strongest first (`gapBy`, shown in the kbdebug readout):
   'lvh'    100lvh/100vh runs a strip past the layout (and not past the screen): the window itself says it is that tall.
   'screen' screen.height is a strip past the layout and the page starts at the top of the screen (safe-area-inset-top > 0).
   'noinset' neither inset reads at all (both 0: env() lost in the short window) and the strip is status-bar sized.
   Not when the page starts below the status bar (top inset 0 but a bottom inset: WebKit 301994's other shape, where the
   page is pushed down and its bottom already is the screen's), never while the keyboard is up or a preview has it, and
   only for a strip: a bigger difference is a real window. */
export function viewportState(m = {}) {
  const ih = px(m.innerHeight);
  const layoutH = Math.round(px(m.layoutH) || ih);
  const vvH = px(m.vvHeight);
  const zoomed = vvH > 0 && (m.vvScale ?? 1) > 1.01;
  // Pinch-zoomed while typing: the user is panning around the field and the keyboard hasn't moved, so the zoomed numbers
  // say nothing about it. Keep the last answer (dock lifted, header as it was, Android's baseline) until the zoom ends.
  // Not once nothing is typed in (the keyboard has gone: the zoomed answer below lifts nothing), and not across a layout
  // resize (Android's keyboard opening or closing, a rotation): that is read again.
  const p = m.prev;
  if (zoomed && p && (m.editing || m.frame) && p.layoutH === layoutH && p.fullW === m.innerWidth) return { ...p, zoomed: true, resetScroll: false };
  // What is on screen. iOS 26 can shrink innerHeight while vv.height still reports the pre-keyboard value (Home Screen
  // app), so the smaller of the two wins; everywhere else they agree.
  const vis = !vvH || zoomed ? ih || layoutH : ih && ih < vvH - 1 ? ih : vvH;
  const editing = !zoomed && !!m.editing;
  const frame = !zoomed && !editing && !!m.frame;
  const typing = editing || frame;
  // Tallest layout at this width while typing: Android can shrink it in several steps, which must not reset the baseline.
  // A preview iframe keeps focus after a mere tap on one of its buttons, so for it a shrink only counts as the keyboard
  // right after focus moved in, or while its keyboard is already up. Otherwise a same-width resize with no keyboard
  // (Android split-screen, a freeform window) would read as one and hide the composer.
  // A field still focused while pinch-zoomed (resized under the zoom) keeps the baseline too, so the keyboard is still
  // seen once the zoom ends.
  const keep = editing || (zoomed && !!m.editing) || (frame && (m.frameAge < FRAME_KB_MS || !!m.frameKb));
  const fullH = m.innerWidth === m.fullW && keep && m.coarse ? Math.max(Math.round(px(m.fullH)), layoutH) : layoutH;
  const shrunk = !!m.coarse && fullH - layoutH > KB_RESIZE;
  const top = editing && vvH ? Math.max(0, Math.round(m.vvOffsetTop || 0)) : 0;
  const kb = editing && vvH ? Math.max(0, Math.round(layoutH - vis - top)) : 0;
  const open = editing && (kb + top > KB_MIN || shrunk);
  // A field inside a Build preview has the keyboard: the composer would cover the spot iOS just revealed. Right after focus
  // moved in from the composer with its keyboard up (handoff), that keyboard may still be closing (a tap on the preview's
  // canvas or a button) or staying (a tap on a field in it); the numbers can't tell which yet, and hiding the dock at once
  // would blink it out for the whole close. So the dock stays for FRAME_HANDOFF_MS; a keyboard still up then is the preview's.
  const settling = frame && !!m.handoff && m.frameAge < FRAME_HANDOFF_MS;
  const frameKb = frame && !!m.coarse && !settling && (layoutH - vis > KB_MIN || shrunk);
  // iOS scrolls the page to reveal a focused field. Undo it once per focus for the composer (the dock is placed right
  // either way; unscrolled just keeps the whole stage in view) and once nothing editable has focus (the keyboard has gone
  // and left the page scrolled). Never while zoomed (the user is panning), never for a Build preview (iOS is revealing a
  // field inside it) and never for other fields, so this can't fight iOS in a loop.
  const sy = m.scrollY > 0 ? m.scrollY : 0;
  const resetScroll = sy > 0 && !zoomed && !m.frame && (open ? !!m.inDock && !m.nudged : !m.editing);
  const g = open || frameKb ? null : gapFor(m, layoutH);
  const gap = g ? g.gap : 0;
  return { vvh: Math.round(vis), kb: open ? kb : 0, top: open ? top : 0, open, tight: open && vis < TIGHT_H, frameKb,
    typing, zoomed, layoutH, fullH, fullW: m.innerWidth, resetScroll, gap, gapBy: g ? g.by : '', heal: gap > 0 };
}

// The screen's height in the current orientation: iOS keeps screen.width/height portrait when rotated, so the side that
// isn't the window's width is the one that runs top to bottom. 0 when unknown.
export function screenSide(innerWidth, sw, sh) {
  const a = px(sw), b = px(sh);
  if (!a || !b) return 0;
  const long = Math.max(a, b), short = Math.min(a, b);
  return px(innerWidth) > short + 1 ? short : long;
}
// px the layout ends above the screen's bottom edge in an iOS Home Screen app (see the gap note above); 0 everywhere else.
export function bottomGap(m, layoutH) { return gapFor(m, Math.round(px(layoutH))).gap; }
const strip = (g) => g > GAP_MIN && g <= GAP_MAX;
function gapFor(m, layoutH) {
  const none = { gap: 0, by: '' };
  if (!m.standalone || !m.ios || !layoutH) return none;
  const sh = screenSide(m.innerWidth, m.screenW, m.screenH);
  const portrait = !sh || sh >= Math.max(px(m.screenW), px(m.screenH));
  const top = px(m.safeTop) > 0, bottom = px(m.safeBottom) > 0;
  if (portrait && !top && bottom) return none; // the page starts below the status bar: its bottom is the screen's
  const big = Math.round(px(m.largeH));
  if (big && strip(big - layoutH) && (!sh || big <= sh + 1)) return { gap: big - layoutH, by: 'lvh' };
  if (!sh) return none;
  const gap = Math.round(sh - layoutH);
  if (!strip(gap)) return none;
  if (!portrait || top) return { gap, by: 'screen' };
  return gap >= STRIP_MIN && gap <= STRIP_MAX ? { gap, by: 'noinset' } : none; // no inset reads at all
}

// ── ?kbdebug=1 readout (owner diagnostics; nothing renders unless asked for) ──
// The URL wins (1 on, 0 off); otherwise this tab's stored choice.
export function kbDebugFlag(search, stored) {
  const v = new URLSearchParams(search || '').get('kbdebug');
  return v === '1' ? true : v === '0' ? false : stored === '1';
}
// iOS 26+ freezes the OS number in the UA (it says 18.x); Safari's Version/ token is the real release but is missing in
// Home Screen apps, so Settings → General → About stays the reliable source.
export function iosVersion(ua = '') {
  const os = /\b(?:iPhone|iPad|iPod)\b[^)]*?\bOS (\d+)[_.](\d+)(?:[_.](\d+))?/.exec(ua);
  if (!os) return null;
  const safari = /\bVersion\/(\d+(?:\.\d+)*)/.exec(ua);
  return { os: os.slice(1).filter(Boolean).join('.'), safari: safari ? safari[1] : '' };
}
const num = (v) => (typeof v !== 'number' || !Number.isFinite(v) ? '–' : Number.isInteger(v) ? String(v) : v.toFixed(1));
const yn = (b) => (b ? 'Y' : 'n');
export function kbDebugText(d) {
  const s = d.state || {};
  const ios = iosVersion(d.ua);
  const vvBottom = (d.vvTop || 0) + (d.vvH || 0);
  // Where the dock should end: the visible bottom, plus the strip under the layout when extending into it (keyboard closed)
  const target = vvBottom + (s.open ? 0 : s.gap || 0);
  const off = Math.round((d.dockBottom || 0) - target); // > 0: that many px of the dock are under the keyboard / off screen
  const verdict = d.dockHidden ? 'dock hidden (preview typing)' : off > 2 ? `DOCK CUT ${off}px` : off < -2 ? `gap ${-off}px` : 'ok';
  return [
    `kbdebug · ${d.standalone ? 'Home Screen app' : 'browser tab'} · ${ios ? `iOS ua ${ios.os}${ios.safari ? ` · Safari ${ios.safari}` : ''}` : 'not iOS (ua)'}`,
    `inner ${num(d.iw)}×${num(d.ih)} · client ${num(d.ch)} · fixed ${num(d.layoutH)} · html ${num(d.htmlH)}`,
    `screen ${num(d.sw)}×${num(d.sh)} · safe top ${num(d.safeTop)} · bottom ${num(d.safeBottom)} · gap ${num(s.gap || 0)}${s.gap ? ` (extended, ${s.gapBy || '?'})` : ''}${d.heals ? ` · heals ${d.heals}` : ''}`,
    `100vh ${num(d.vh)} · lvh ${num(d.lvh)} · svh ${num(d.svh)} · dvh ${num(d.dvh)} · vp-gap ${d.vpGapOn ? 'on' : 'off'}${d.marks ? ' · marks: pink fixed, cyan page' : ''}`,
    `vv h ${num(d.vvH)} · top ${num(d.vvTop)} · pageTop ${num(d.pageTop)} · ×${num(d.scale)}`,
    `scrollY ${num(d.scrollY)} · focus ${d.active || '-'}`,
    `kb ${num(s.kb)} · top ${num(s.top)} · vis ${num(s.vvh)} · open ${yn(s.open)} · tight ${yn(s.tight)}${s.frameKb ? ' · frame' : ''}${s.zoomed ? ' · zoomed' : ''}`,
    `dock bottom ${num(d.dockBottom)} · vv bottom ${num(vvBottom)}${s.gap && !s.open ? ` · target ${num(target)}` : ''} · ${verdict}`,
    `${d.ev || '-'} #${d.n || 0} · ${d.cls || 'no kb classes'}`,
  ].join('\n');
}
// Small monospace box pinned to the top-left of what is on screen; pointer-events none so it never takes a tap.
export function createKbDebug({ win, probe, dock, state, insets = () => ({}), units = () => ({}) }) {
  const doc = win.document;
  const el = doc.createElement('pre');
  el.id = 'kbDebug';
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText = 'position:fixed;left:0;top:env(safe-area-inset-top,0px);z-index:2147483647;margin:0;padding:4px 6px;'
    + 'max-width:calc(100vw - 8px);font:10px/1.35 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;color:#c8f25a;'
    + 'background:rgba(0,0,0,.8);border-radius:0 0 6px 0;pointer-events:none;transform-origin:0 0';
  doc.body.append(el);
  // Two 4px bars on the screen's bottom edge where the extended area ends (iOS Home Screen app bottom gap): pink is fixed
  // (how the dock is placed), cyan is in the page (how html/#stage extend). One the screenshot shows is a way that paints there.
  const bar = (css) => { const b = doc.createElement('i'); b.setAttribute('aria-hidden', 'true'); b.style.cssText = 'z-index:2147483646;left:0;height:4px;pointer-events:none;' + css; doc.body.append(b); return b; };
  const marks = doc.documentElement.dataset.standalone ? [
    bar('position:fixed;width:50%;bottom:calc(0px - var(--vp-gap, 0px));background:#ff2fb4'),
    bar('position:absolute;left:50%;width:50%;top:calc(var(--vp-full, 100%) - 4px);background:#2fe6ff'),
  ] : [];
  const render = () => {
    const vv = win.visualViewport, a = doc.activeElement, st = state();
    const ins = insets(), u = units();
    el.textContent = kbDebugText({
      standalone: win.matchMedia('(display-mode: standalone)').matches || win.navigator.standalone === true,
      sw: win.screen?.width, sh: win.screen?.height, safeTop: ins.top, safeBottom: ins.bottom, heals: st.heals,
      vh: u.vh, lvh: u.lvh, svh: u.svh, dvh: u.dvh, vpGapOn: doc.documentElement.classList.contains('vp-gap'), marks: marks.length > 0,
      htmlH: doc.documentElement.getBoundingClientRect().height,
      ua: win.navigator.userAgent, iw: win.innerWidth, ih: win.innerHeight, ch: doc.documentElement.clientHeight,
      layoutH: probe.offsetHeight, vvH: vv?.height, vvTop: vv?.offsetTop, pageTop: vv?.pageTop, scale: vv?.scale,
      scrollY: win.scrollY, state: st.s, dockBottom: dock.getBoundingClientRect().bottom,
      dockHidden: win.getComputedStyle(dock).visibility === 'hidden',
      active: a && a !== doc.body ? a.tagName.toLowerCase() + (a.id ? '#' + a.id : '') : 'body',
      cls: [...doc.documentElement.classList].filter((c) => c.startsWith('kb-') || c === 'vp-gap').join(' '), ev: st.ev, n: st.n,
    });
    // follow the visual viewport (iOS pans it) and stay readable when pinch-zoomed
    el.style.transform = vv ? `translate(${vv.offsetLeft}px, ${vv.offsetTop}px) scale(${1 / (vv.scale || 1)})` : '';
  };
  const timer = win.setInterval(render, 300);
  render();
  return { render, remove() { win.clearInterval(timer); el.remove(); for (const b of marks) b.remove(); } };
}
