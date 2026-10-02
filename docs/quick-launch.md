# Quick launch: owner decisions and accepted risks

Quick launch shipped in v55. It covers app shortcuts, Share → Atelier, Talk to Atelier and the iPhone Shortcut. The
code is in `public/launch.js` (pure logic), `public/sw.js` (share intake), `src/worker.js` (the `/share` fallback) and
`public/app.js` (wiring). This page records the decisions and the risks that were accepted. Code comments that say
"docs/quick-launch.md" point here.

## Entry points

- **Manifest shortcuts:** `/?start=voice|ask|image`, plus the legacy `?mode=`.
- **Share target:** `POST /share`, sent as `multipart/form-data` with `title`, `text`, `url` and `media` (`image/*` or
  `video/*`).
  - `sw.js` stores it in the `atelier-share` cache and redirects to `/?share=<id>`. It keeps one pending share: either
    one video of up to 1 GB, or up to 4 photos of 25 MB each, plus the text.
- **Worker fallback:** `run_worker_first: ["/share"]` sends a share to the Worker when no service worker answers.
  - It answers `303` to `/?share=lost` for a POST and to `/` otherwise.
  - It never reads, parses or echoes the body.
  - It sets the Worker's own security headers (HSTS, nosniff, Referrer-Policy and X-Frame-Options), because
    `public/_headers` never applies to it.
- **iPhone Shortcut:** `/?start=ask#send=1&k=<key>&q=<dictation>`. The key and the words travel only in the fragment.
- **Legacy GET share:** `/?title=&text=&url=`.

## Trust rules

- **Anyone can write a link or POST a share.** A site can auto-submit a multipart form to `/share` as a top-level
  navigation, with no tap. So launch text is only ever prefilled, and is labelled "From a link…" or "From another app
  or site — check it before sending".
- **A share never sends itself.** A link sends itself only with every gate passed:
  - the per-browser 22-character fragment key;
  - a role match;
  - a first-use confirm;
  - a visible, cancellable hold (2.5 s for a link, 4 s for Video with its price, 1.5 s for voice);
  - at most one keyed send every 15 s;
  - in the link's own mode (`start=`, any of the six since v57: Atelier Assist on Android, and Shortcut links that
    name a mode), never a voice start and never a `/mode` prefix in the text;
  - a first-use confirm given before v57 (under the Ask-only dialog) doesn't count. An Allow is stored as
    `v2:<key>` now, so the first keyed send after the update asks again, and the dialog names the mode (and
    Video's length and price).
- **Launch text keeps its mark after edits (v56).**
  - The composer remembers that it holds link or share text (`composerFrom`) until the box is emptied, even after the
    note goes at the first keystroke. A draft saved with such text comes back marked.
  - An emptied box remembers the mark and the marked text. That text coming back (Undo, Redo, or pasted back after a
    cut) brings the mark back. Text the owner types or pastes after emptying the box is never marked.
  - `submit()` marks that turn `e.untrusted` (`'link'` or `'share'`). Text that came with this browser's **own key** (a paired
    Atelier Assist or a keyed Shortcut) is not marked: owner decision 2026-10-02, it counts as the owner's own words.
    Write tools still show an approval card, and browser_open/browser_read({url}) always ask.
  - `runChat` never routes a marked turn to the accounts agent. It is answered as plain chat, and the meta line says
    "shared content · tools off for this turn — ask again without it to use your accounts".
  - The owner uses the tools on purpose by asking in their own words.
  - `runAgent` also asks for approval before every tool on a marked turn, as a backstop.
  - Text made from a marked entry carries its mark: an idea's Expand, Build and Image, To app, Vary, Edit prompt,
    Animate, and Look up's "Ask about this" on words selected in a marked answer (`submit(…, { untrusted })`).
  - A marked turn never teaches memory (`learnFrom`). Memory goes into every later system prompt, the agent's
    included, and syncs to the owner's other devices.
- **Some reads always ask first (v56).** `browser_open`, and `browser_read` with a `url`, wait for the owner's approval
  like a write. They load an address the model chose in the owner's logged-in browser, so the address itself could
  carry data out. Reading an already-open tab (`browser_read` with `tabId`) does not ask.
- **Replies load nothing remote (v56).** `md()` lets a rendered reply load only same-origin, `data:` and `blob:` URLs.
  - A remote `<img>` becomes a small "Image from <host> blocked" link that opens in a new tab.
  - Remote `src`, `srcset`, `poster`, `background`, SVG `href` and CSS `url()` / `image-set()` attributes are removed.
  - An attribute CSS can read (an SVG `fill`, `stroke`, `mask`, `filter`, `cursor`…) is judged with its CSS escapes
    decoded and comments dropped (`u\rl(` and `\75 rl(` are `url(`), and one still holding a backslash is removed.
    A local `url(#id)` stays. Text attributes (`alt`, `title`, `aria-*`) and link `href`s are left alone.
  - `<form>` and `<style>` are forbidden (assist-panel-integration §5h), and so are the `style`, `id` and `name`
    attributes. A reply element named like the app's own (`id="input"`) could otherwise stand in for the composer.
    The composer and its source note are also captured once at startup, never looked up by id again.
  - Without this, a reply steered by a page, an email or shared text could carry data out the moment it shows. The
    CSP is still Report-Only.

## Storage and lifetimes (all on the device)

Every time limit below is checked when the data is read. None is a deletion timer.

| What | Usable for | Deleted |
|---|---|---|
| Pending share (`atelier-share` cache) | 30 min (`SHARE_TTL`) | when it is used; at the next boot (`sweepShare`); on sign-out or a role switch seen by a running page; by Clear this device |
| Unsent draft (`draft`) | 6 h (`DRAFT_TTL`) | when it is sent; at the next boot (`takeDraft`); on sign-out; by Clear this device |
| Signed-out launch (`pendingLaunch`) | 15 min after sign-in (`PENDING_TTL`) | at the next sign-in, or the next boot while signed in; on a role switch; by Clear this device |

- Only the user's own typed or dictated text is saved as a draft. An untouched prefill is never saved.
- Sign-out and role changes clear Quick launch prefs and the launch key.

## Talk, then send

`dictatedSend` holds and then sends only while the page is visible and nothing is running. Otherwise it pulses Send.

`armMic` never carries `autoSend`. An armed launch never sends by itself: that covers a tab, a replay, an open dialog,
iOS, a blocked mic, and a start that failed.

## Accepted residual risks

- **The launch key and dictated words stay in browser History.**
  - The Shortcut opens Safari at the keyed link. The browser records the whole URL, fragment included, in its History
    and History sync (iCloud, Chrome sync).
  - `boot()` runs `history.replaceState` first thing, but that only rewrites this tab's entry.
  - The privacy page says so and points to Settings → Quick launch → New link, which revokes the old key.
  - The copy in History stops working after New link, sign-out, a role switch, turning link send off, or Clear this
    device.
  - A keyed send is still a rate-limited, held and labelled turn. Since v57 it can be any of the six modes, so a key
    read from History or History sync can start paid Image or Video work, after the hold (4 s and the price for
    Video), and only in a browser that holds that confirmed key. Atelier Assist's links land in Chrome's History
    the same way. Retire a key that may have been seen with **New link**. Since v58 a keyed send is the owner's own
    (it may use account tools, with the usual approval cards); a leaked key is therefore worth retiring at once.
- **A stranger's link can start the mic.** Once mic permission is granted, a stranger's link can open the installed
  app listening. Only the user's own words can be sent, behind a visible hold with Cancel, while the Android mic
  indicator shows. "After you speak: Review" removes even the hold-to-send.
- **Cross-site share POST.** Nothing in the service worker can tell a site's form POST from the share sheet. It is
  limited to one pending share, with the limits above, and is only prefilled. A video never uploads before Send.
- **Big shares are parsed in memory.**
  - `req.formData()` holds the whole body before any cap applies. Running out of memory kills the worker, and the user
    sees an error page, or `?share=lost` if Chrome falls back to the network.
  - The 1 GB video cap is untested on a phone. Share a ~300 MB and then a ~1 GB video from Photos before relying on
    big ones. If either fails, lower `SHARE_VIDEO_MAX` (sw.js) and `SHARE_LIMITS.videoBytes` (launch.js).
- **No service worker in control.** This happens after site data is cleared, in the first moments after install, or
  after a crash.
  - The browser sends the share to the server. The Worker discards it unread, and the privacy page discloses this.
  - A body over the zone's request limit (100 MB on Free/Pro, 200 MB on Business) gets Cloudflare's own 413 page
    instead. The share is lost either way.
- **Visible filler can still push text down.** `cleanText` removes invisible characters but not a column of visible
  ones. The composer scrolls.
- **Sign-out empties the composer.** This is by design: a rejected passcode or an expired tester session counts as a
  sign-out.
- **Unconfirmed on a device:** whether Pixel Quick Tap and the Samsung side button list the WebAPK and offer Talk to
  Atelier.
