# Atelier Assist: web-side panel mode (integration patch, not applied)

> **Superseded by Atelier Assist 1.1.0 (2026-10-01).** 1.1 replaced the WebView sheet with a small native card that
> opens the installed Atelier app (see `assist-launch-web-patch.md` next to this file). There is no
> `window.AtelierAssist` bridge any more, so §1–§5g and §6–§9 below no longer apply.
>
> **Still worth shipping on its own: §5h**, `FORBID_TAGS: ['form']` in `md()`. It is a security fix for every
> browser, not just the panel.

> **Status (2026-10-01).** The Android app is built: `android/`, `app-release.apk` 1.0.1 (versionCode 2). Nothing under
> `public/`, `src/` or `tests/` was touched, because another workflow is editing `public/app.js`.
>
> This patch teaches the web app the panel. Apply it on top of whatever `public/app.js` looks like then: every edit
> below is anchored on code text, not line numbers. A tested copy of the new files sits next to this document (`android/web-integration/`) and in the scratchpad, under
> `assist-web/` (`assist.js`, `assist-boot.js`, `assist.test.mjs`; 7/7 pass with `node --test`).
>
> **Without this patch the panel already works.** Atelier shows its normal phone layout in the sheet, and the mic
> waits for a tap. `?start=voice` only arms it, because `isStandalone()` is false in a WebView.
>
> **§5h is a security fix for every browser, not only the panel.** It stops rendered replies from carrying a
> `<form>`. It is one line and can ship on its own, ahead of the rest. The APK (1.0.1) already refuses to let a form
> POST take the sheet to another site; §5h closes the same hole in Chrome and the PWA.

## 0. What the app does, and the contract

- **Start URL:** `https://atelier.ciprari.ai/?start=voice&via=assist&panel=assist`, or `?start=ask&…` when the
  system asks for the keyboard or unlocking took more than 5 s.
  - `start` is launch.js's existing quick-launch intent.
  - `via=assist` is already parsed by `readLaunch` (with "no other effect").
  - `panel=assist` is a new layout hint.
  - None of the three grants anything, because any link can carry them.
- **Trust signal:** `window.AtelierAssist`. The WebView injects it with
  `WebViewCompat.addWebMessageListener(webView, "AtelierAssist", setOf("https://atelier.ciprari.ai"), …)`:
  - only into Atelier's top frame (Build previews are sandboxed iframes and never get it);
  - present before any page script runs;
  - the app also drops messages that aren't from the main frame of that origin.
- **User agent:** the WebView's user agent ends with ` AtelierAssist/1`. That is fine for help text, never for trust.
- **Bridge messages:** every message is a JSON string, except the save payload.

  | Direction | Message | Meaning |
  |---|---|---|
  | page → app | `ready` | The app replies `hello {v:1, app:'atelier-assist', version, invocation:'assist'\|'launcher', start:'voice'\|'ask', mic:'granted'\|'prompt'\|'denied', expanded, save}`. |
  | page → app | `close` | Slide the sheet away. |
  | page → app | `open-app {path}` | Open the installed PWA (Chrome WebAPK) at that same-site path, then close the panel. |
  | page → app | `expand` / `collapse` | Sheet height. |
  | page → app | `theme {bg:'#rrggbb'}` | Sheet colour and nav-bar icons follow the page. |
  | page → app | `mic-settings` | Atelier Assist's Android app settings. |
  | page → app | `save-begin {name, mime, size}`, then one `ArrayBuffer` | Saved to Downloads/Atelier. Media, text, JSON, PDF and ZIP only, ≤ 64 MB, needs `hello.save`. Accepted from the top frame without a tap; files are written one at a time and refused while 4 are already waiting. |
  | app → page | `listen {invocation, keyboard}` | The side button was pressed again while the panel was open. |
  | app → page | `sheet {expanded}` | The sheet changed height. |

- **What the app already handles natively:**
  - Navigation: the sheet's main frame stays on this origin. GET links elsewhere open in their own apps. A main-frame
    POST (or anything else `shouldOverrideUrlLoading` doesn't see) to another site gets an empty 204 before it
    reaches the network, so the page stays put and nothing opens. If something foreign still commits, it is stopped
    and the WebView goes back.
  - Microphone: `RECORD_AUDIO` is requested at the first `getUserMedia`. Only audio is granted, and only to this
    origin. `hello.mic` is `'denied'` only when Android won't ask again: a second "Don't allow", or a request that
    returns with no dialog. Then a native banner offers Settings. A dismissed dialog stays `'prompt'`.
  - File chooser: the system picker.
  - `window.open` / `target=_blank`: a GET destination opens outside; the popup itself loads nothing.
  - Downloads (WebView's download listener): taken only when Atelier is the main frame, within 10 s of a real tap
    (one download per tap), one save at a time and at most one every 2 s. Anything else is dropped, because a
    generated app in a Build preview (`allow-downloads`) could otherwise download in a loop. `data:` URLs are
    decoded natively, off the main thread. A `blob:` URL is read by injected JS (`fetch(blob)`), which works while
    the CSP is Report-Only; see §9. With §5e the page's own saves go over the bridge instead and need no tap.
  - Keyboard: the sheet goes to full height and the WebView is resized, so viewport.js's Android "shrinking layout"
    path applies; `env(safe-area-inset-*)` is 0 in the panel.

## 1. New file `public/assist-boot.js` (classic script, sets the layout class before first paint)

```js
// Atelier Assist panel layout, before first paint (classic script in <head>). The Android app's WebView injects
// window.AtelierAssist for this origin's top frame only; ?panel=assist alone (any link can carry it) counts only together
// with the app's user-agent token, and only ever changes the look. public/assist.js holds the bridge itself.
(function () {
  var d = document.documentElement, b = window.AtelierAssist;
  var bridge = !!(b && typeof b.postMessage === 'function');
  var hinted = /[?&]panel=assist(?:&|$)/.test(location.search) && / AtelierAssist\/\d/.test(navigator.userAgent);
  if (bridge || hinted) d.classList.add('assist');
})();
```

## 2. New file `public/assist.js` (ES module)

Copy it verbatim from `scratchpad/assist-web/assist.js`. Its exports:

- `SAVE_MAX`, `bridgeOf(win)`, `safePath(p)`, `toBlob(data, type)`.
- `createAssist({ win, onListen, onSheet, timers })`. It returns
  `{ on, hello, info(), micState(), canSave(), save(blob, name), close(), openApp(path), expand(), collapse(), micSettings(), theme(bg), syncTheme(doc), watchTheme(doc) }`.
  - Outside the app, `on` is false and every call is a no-op.
  - It sends `ready` as soon as it is created. `hello` resolves to the app's hello, or to `null` after 1.2 s.
- `mountEarlierHint(api, { doc, stream, win })`: the "N earlier messages · Open in Atelier ↗" pill shown above the
  latest exchange.

## 3. `public/index.html`

In `<head>`, right after `<link rel="manifest" …>` and before the stylesheets, add:

```html
  <script src="/assist-boot.js?v=NN"></script>
```

Use the same `NN` as the stylesheets. `scripts/bump-version.mjs` rewrites every `?v=` in index.html. The script is
a blocking classic script under 1 KB, served cache-first by sw.js. It is external rather than inline so that the CSP
can drop `'unsafe-inline'` for scripts later.

## 4. `public/sw.js`: precache both files

In `SHELL`, next to the other modules:

```js
  `/assist.js?v=${V}`, `/assist-boot.js?v=${V}`,
```

`tests/service-worker.test.mjs` fails until a module that the app imports is precached at its `?v=` URL.

## 5. `public/app.js`

**5a. Import.** Add it next to the other module imports. bump-version keeps the `?v=` in step:

```js
import { createAssist, mountEarlierHint, toBlob } from './assist.js?v=NN';
```

**5b. Create the bridge.** Do it right after
`const STANDALONE = () => isStandalone(window);` in the quick-launch block:

```js
// Atelier Assist (android/: the side-button pop-up). window.AtelierAssist exists only in that app's WebView, for this
// origin's top frame, so it counts as the installed app for quick launch: a voice launch may open the mic by itself,
// still behind every other launch.js gate (signed in, visible, no dialog, permission not denied). The side button
// pressed again while the panel is open ({type:'listen'}) is the same voice launch.
const assist = createAssist({
  onListen: () => { if (!micOn() && !sendHold && !S.busy) runLaunch({ ...readLaunch('?start=voice', ''), source: 'assist' }); },
});
```

`micOn`, `sendHold` and `runLaunch` are defined further down. `onListen` only ever runs later, from a message
event, so this is safe.

**5c. `launchCtx()`: the panel counts as the installed app, and its mic state comes from Android.**
`navigator.permissions` doesn't exist in a WebView. Replace

```js
  const perm = await micPermission(navigator);
  return {
    signedIn: hasCredentials(), role: roleNow(), standalone: STANDALONE(), sr: dictation.available(), needsTap: dictation.needsGesture(),
```

with

```js
  const perm = assist.on ? await assist.micState() : await micPermission(navigator);
  return {
    signedIn: hasCredentials(), role: roleNow(), standalone: STANDALONE() || assist.on, sr: dictation.available(), needsTap: dictation.needsGesture(),
```

**5d. Dictation records and transcribes on the server in the panel.** Web Speech in an Android WebView is
unreliable. In `createDictation({ … })`, replace

```js
  prefer: () => LS.get('dictateEngine', 'auto'), // 'record': server transcription even where Web Speech exists (review)
```

with

```js
  prefer: () => (assist.on ? 'record' : LS.get('dictateEngine', 'auto')), // 'record': server transcription even where Web Speech exists (review; always in the Atelier Assist panel)
```

**5e. Downloads keep their names in the panel.** In `function download(data, name, type) {`, add as the first
statement:

```js
  if (assist.canSave()) { // Atelier Assist: the app saves to Downloads/Atelier (a WebView can't download blob:/data: links itself)
    assist.save(toBlob(data, type), name).then((ok) => { if (!ok) toast('Couldn’t save it here — open it in Atelier to download it', { error: true }); });
    return;
  }
```

**5f. Settings → Quick launch.** The install hint makes no sense in the panel. Replace

```js
  $('#qlInstall').hidden = PLATFORM !== 'android' || sa;
```

with

```js
  $('#qlInstall').hidden = PLATFORM !== 'android' || sa || assist.on;
```

**5g. Boot.** In `boot()`, just before the final `syncDock(); moveInk();`, add:

```js
  if (assist.on) { assist.watchTheme(); mountEarlierHint(assist); } // the sheet follows the page's colours; "N earlier · Open in Atelier"
```

**5h. No forms in rendered replies (security, all browsers; can ship on its own).** `md()` passes model replies
through `marked` and `DOMPurify`. DOMPurify 3.4.16 (`public/vendor/purify.js`) keeps `<form>`, `<button>` and
`<input>` and the `action`/`method` attributes by default. A reply that quotes HTML from an email or a web page can
therefore carry `<form method=post action=https://elsewhere>` with a "Continue" button. The stream's click handler
doesn't stop a plain button, and the CSP's `form-action 'self'` is still Report-Only, so a tap posts the reader to
that site. DOMPurify already drops the `form=`, `formaction`, `formmethod` and `formtarget` attributes, so forbidding
the tag is enough. Replace

```js
function md(text) {
  return DOMPurify.sanitize(marked.parse(text || ''), { ADD_ATTR: ['data-act', 'data-lang', 'target'] });
}
```

with

```js
function md(text) {
  // No <form> in rendered replies: one quoted from an email or a web page could POST the reader to another site (the
  // CSP's form-action is still Report-Only). Atelier's own forms live in index.html and dialogs, never in md().
  return DOMPurify.sanitize(marked.parse(text || ''), { ADD_ATTR: ['data-act', 'data-lang', 'target'], FORBID_TAGS: ['form'] });
}
```

Optional, separately: when the CSP moves from Report-Only to enforced (`public/_headers`), keep
`form-action 'self'`. Atelier's own forms use `method="dialog"` and are unaffected.

A test for it, if `md` is ever exported or moved to a module: a reply containing
`<form method="post" action="https://example.com/"><button>Go</button></form>` renders with no `form` element.

## 6. `public/dictate.js`: mic help that points at the right app

- In `MIC_HELP`, add:

  ```js
  assist: 'The mic is off for Atelier Assist. Android Settings → Apps → Atelier Assist → Permissions → Microphone → Allow, then try again.',
  ```

- In `platformOf()`, before `return { ios, android, apple, standalone, browser };`, add:

  ```js
  const assist = !ios && / AtelierAssist\/\d/.test(ua); // the Atelier Assist panel's WebView (help text only, never trust)
  ```

  Then return `{ ios, android, apple, standalone, browser, assist }`.

- At the top of `micHelp(plat)`, add:

  ```js
  if (plat.assist) return MIC_HELP.assist;
  ```

Update any test that deep-equals `platformOf()`'s result, since it has a new `assist` key.

## 7. CSS: append to the end of `public/studio.css`

Put it there so it loads last and also beats studio.css's `@media` rules.

```css
/* ── Atelier Assist panel (android/: the side-button pop-up; html.assist is set by /assist-boot.js) ──
   The native sheet draws the drag handle and "Open in Atelier", so the page drops its own chrome: no header, nav, grain
   or halo, a short greeting instead of the studio tiles, and only the latest exchange above the composer (the
   .assist-more pill counts the earlier ones and opens the full app). Nothing here applies outside the panel. */
html.assist :is(.top, .studio-nav, .grain, .halo, .composer-hint, #qlInstall) { display: none !important; }
html.assist #stage { padding-top: 12px; scroll-padding-top: 12px; }
html.assist .welcome { padding-top: 8px; }
html.assist .welcome :is(.bento, .section-label, .legal-links, .welcome-copy) { display: none; }
html.assist .greeting { font-size: clamp(30px, 9vw, 40px); margin-bottom: 4px; }
html.assist .stream > .entry:not(:last-child) { display: none; }
html.assist .stream > .entry:last-child { border-top: 0; padding-top: 4px; }
.assist-more { display: none; }
html.assist .assist-more:not([hidden]) {
  display: flex; align-items: center; gap: 6px; margin: 0 auto 8px; padding: 7px 14px; border-radius: 999px;
  background: var(--surface-2); color: var(--ink-2); font: 500 12px/1.2 var(--sans); letter-spacing: 0.01em;
}
html.assist .assist-more:hover, html.assist .assist-more:focus-visible { color: var(--ink); }
```

Check these against the layout at that time:

- `#stage`'s top padding exists only to clear the fixed `.top`; recheck it if ChatGPT's layout changed.
- `.stream > .entry` is `<ol id="stream" class="stream">` with `li.entry`.

## 8. Tests

- Add `tests/assist.test.mjs`, copied verbatim from `scratchpad/assist-web/assist.test.mjs`. It covers:
  - off outside the app;
  - ready → hello, with `listen` and `sheet` dispatch;
  - the hello timeout;
  - same-site `open-app` paths;
  - theme validation and de-duplication;
  - the save protocol (`save-begin`, then exactly one ArrayBuffer; refused before hello, when empty or over 64 MB);
  - `toBlob` for base64 and plain `data:`, text and Blob.
- `tests/launch.test.mjs`: nothing changes in launch.js. Optionally add one case: `planLaunch({voice:true}, {standalone:true, …})`
  gives `voice:'start'` (that is the panel's path now).
- `package.json` `check`: append `&& node --check public/assist.js && node --check public/assist-boot.js`.
- Run `npm run check` and `npm test`.

## 9. Notes and edge cases

- **Sign-in:** the panel has its own storage, so the owner signs in once in the panel with the passcode.
  - LinkedIn tester sign-in can't finish inside the panel: leaving the site opens Chrome, and the cookie lands there.
    The app is owner-only, so that is acceptable. Optionally hide `#liBtn` under `html.assist`.
  - With owner thread sync on, the panel is just another device, so "Open in Atelier" shows the same thread in the
    PWA once it has synced.
- **CSP:** the app's blob-download fallback (`fetch(blob:)` from injected JS) needs `connect-src blob:` once the CSP is
  enforced. With 5e in place, the page hands the bytes over itself and that fallback isn't used.
- **`navigator.share`:** app.js doesn't use it today. If it starts to, feature-detect it, because WebView has no
  `navigator.share`.
- **Back:** Android Back goes back in the WebView's history while it can, then closes the sheet. Dialogs that push a
  history entry close on Back as usual.
- **Mic in the panel:**
  - The first voice launch shows Android's "Allow Atelier Assist to record audio?" dialog. The page stays visible
    behind it: the app pauses the WebView only on onStop, so a pending `getUserMedia` isn't dropped.
  - After a permanent denial, the native banner offers Settings, and `micHelp` (§6) gives the panel's own steps.
    After the owner comes back from that Settings page, the app reports `'prompt'` again until the next request
    shows whether the mic is still blocked.
- **Theme:** the app keeps the page's `theme {bg}` colour across rotation and dark-mode switches, and re-applies the
  nav-bar icons itself. The page doesn't need to resend it (`assist.theme` de-duplicates anyway).

## 10. Deploy checklist (memory: atelier-deploy-checklist)

1. Apply the patch on top of the current `public/`. If ChatGPT is mid-edit, wait for it to go quiet.
2. Run `node scripts/bump-version.mjs <n>`. That bumps sw.js `VERSION`, index.html `?v=` and every module import,
   including the new `assist.js` / `assist-boot.js`.
3. Run `npm run check` and `npm test`.
4. **Fixture (:8791, `npm run review:ui`):**
   - The panel CSS and bridge need `window.AtelierAssist` before page scripts run. In a Playwright harness use
     `page.addInitScript(() => { window.AtelierAssist = { postMessage: (m) => console.log('[to app]', m), addEventListener() {} }; })`
     and a user agent ending in ` AtelierAssist/1`, at 360–430 px.
   - Check:
     - no header or nav;
     - the greeting is compact;
     - with ≥ 2 entries, only the last one shows, under the "N earlier · Open in Atelier ↗" pill;
     - the composer is at the bottom;
     - a `ready` then a `theme` message are logged;
     - nothing changes when the init script is absent.
5. Check desktop and ordinary phone widths without the bridge: there must be no visual change.
6. Run `npm run deploy`, then confirm the live sw.js `VERSION` with curl.
7. **On the phone:**
   - Press and hold the side button: the sheet opens and the mic starts by itself. The first time, Android asks for
     the microphone.
   - Speak: Atelier transcribes and sends after the hold.
   - Press the button again while the panel is open: it listens again.
   - "Open in Atelier" opens the PWA.
   - A generated image's Download saves to Downloads/Atelier under its own name.
