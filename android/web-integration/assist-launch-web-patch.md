# Atelier Assist 1.1 — web patch: keyed launches in all six modes (not applied)

> **Status (2026-10-02, revised after review).** Written for after v56 (thread sync) ships. Another workflow owns `public/app.js` and
> `public/launch.js` until then, so nothing under `public/` or `tests/` was edited. Every edit below is **exact text,
> matched once**, not a line number. It applies on top of v55 (HEAD `d6bbd4f`) and on top of today's v56 working tree.
>
> **Tested by applying it to a copy** of today's working tree (`scratchpad/assist-web-patch/`; `patch.py` is the single
> source for both this document and the copy):
>
> - `node --test tests/assist-launch.test.mjs tests/launch.test.mjs tests/launch-wiring.test.mjs
>   tests/untrusted-turns.test.mjs tests/lookup-client.test.mjs tests/privacy-disclosures.test.mjs`: **150/150 pass**.
>   Nine tests are new (§6); ten existing expectations change (§5).
> - The full suite on that copy (with the repo's `node_modules` and `wrangler.jsonc`): **1017/1018 pass**. The one
>   failure, `extension.test.mjs`, fails identically on the unpatched copy (the copy has no `extension/` folder).
> - `node --check` passes on the patched `launch.js` and `app.js`.

## 0. What this changes

Atelier Assist 1.1 (`android/`) is the Samsung side-button app. It listens, picks the mode, then opens the installed
Atelier with:

```text
https://atelier.ciprari.ai/?start=<ask|code|image|video|ideas|build>&via=assist#k=<key>&send=1&q=<words>   (q last)
```

**Today (v55/v56)**

- `planLaunch` sends a keyed link in **Ask only**. Any other `start=` gives `sendWhy: 'mode'`: the words are
  prefilled in that mode and Send pulses.
- There is **no way to get a keyed link on Android**. The "Send without a tap" step is iPhone-only, and Android's
  Copy gives the keyless link.

**After this patch**

- **Any of the six modes sends in the link's own mode.** Every other keyed-send rule stays as it is:
  - this browser's own key, made for the signed-in role (owner or tester);
  - confirmed once per key, in Atelier Assist's own words for `via=assist` links. The dialog names the mode this send
    goes to, and for Video its length and price;
  - **an Allow given before this patch doesn't count.** It was given under the Ask-only dialog, so it isn't widened
    to paid modes silently: an Allow is now stored as `v2:<key>` (`CONFIRM_SCOPE`), a bare key reads as unconfirmed,
    and the first keyed send after the update asks again (iPhone Shortcut included);
  - at most one keyed send per 15 s;
  - an empty composer with no attachments;
  - signed in, online, idle, visible and no dialog open;
  - never a voice start, and never a `/video …` prefix in the text;
  - never on a replay after sign-in (the stash never keeps the key);
  - link text stays untrusted: tools are off for that turn, as today.
- **The hold says where it's going**, behind the same visible Cancel:
  - Image, Code, Ideas, Build, Ask: "Sending to Image…" for 2.5 s;
  - Video: "Making a 4 s video · ≈ $0.25" for **4 s**. The price is Veo's reserve from the Video options' own table
    (`tester.js` `veoShape`/`veoCost`; HD is 8 s at 1080p). A model with no price there (Runway, local) shows the
    length only.
  - Talk's own hold ("Sending…", 1.5 s) is unchanged.
- **Labels, only with this browser's key:**
  - the source note says "From Atelier Assist — check it before sending.";
  - the entry shows **From Atelier Assist** above the prompt (the existing `.task-of` style).
  - `via=assist` without the key is just a link. Anyone can write that parameter.
- **Android pairing:** Settings → General → Quick launch → Android → **Atelier Assist**.
  - It has its own **Send without a tap** switch (the same setting and key as the iPhone's), **Copy Assist link** and
    **New link**.
  - The link is `/?start=ask&via=assist#send=1&k=<key>&q=`. The app keeps only the key, and its setup page names these
    exact labels; `assist-launch.test.mjs` checks the two agree.
  - The iPhone section's Copy on Android (the plain link) no longer switches that setting off or forgets the key.
- **The iPhone Shortcut** gets the same freedom. A Shortcut whose link says `?start=image` now sends in Image.

- **Docs and privacy:** `docs/quick-launch.md` drops "Ask mode only" from the trust rules and its History
  residual-risk paragraph no longer rests on Ask-only (§5a). `privacy.html` says Atelier Assist's keyed links land in
  Chrome History and sync like the Shortcut's, and that speech goes through the phone's speech service (§5b).
- **Clipboard history:** the Copy Assist link toasts remind the owner to delete the link from the keyboard's clipboard
  history (Samsung Keyboard and Gboard keep copies that clearing the clipboard doesn't touch).

**Why widening beyond Ask is acceptable**

- Ask-only was a conservative first step, not a security boundary. The key already lets its holder send to Ask
  without a tap.
- What the change adds is cost: image and video generation. That stays bounded by:
  - the private per-browser key;
  - the one-time confirmation, asked again after this update and naming the mode and Video's price;
  - the 15 s rate limit;
  - the visible, cancellable hold, longer for Video, with its price;
  - for testers, the Ledger's metering, which still refuses a call that doesn't fit.
- Video's hold and price are the owner's last look before the costliest send.

## 1. How to apply

1. Ship v56 first. Then apply §2–§5b in order and add the new test file (§6).
2. Each Find must match exactly once. If one doesn't, the code around it changed: re-anchor it on the same function.
3. Run `npm run check` and `npm test`.
4. Bump the version with `node scripts/bump-version.mjs` (sw.js VERSION and every `?v=`), then follow §7.

No CSS changes are needed. The entry label reuses `.task-of`, and the Android block reuses `.ql-row`, `.seg`,
`.ql-acts` and `.ql-link`.

## 2. `public/launch.js`

**L1.** Threat-model header: keyed sends are no longer Ask-only.

Find (exact, once):

```text
//   that key once, the launch is Ask-only (no /mode prefix) with nothing else in the composer, and no other keyed send
```

Replace with:

```text
//   that key once, the launch is a plain request in the link's own mode (start=, any of the six: Atelier Assist names
//   it; never a voice start or a /mode prefix) with nothing else in the composer, and no other keyed send
```

**L2.** Video's longer hold, the hold per mode, and the mode labels.

Find (exact, once):

```text
export const HOLD_MS = { link: 2500, voice: 1500 };
```

Replace with:

```text
export const HOLD_MS = { link: 2500, voice: 1500, video: 4000 };
// A keyed link holds 2.5 s before it sends; Video, the costly one, 4 s (its toast shows the price: app.js holdNote).
export const holdMs = (mode) => (mode === 'video' ? HOLD_MS.video : HOLD_MS.link);
export const MODE_LABELS = Object.freeze({ ask: 'Ask', code: 'Code', image: 'Image', video: 'Video', ideas: 'Ideas', build: 'Build' });
```

**L3.** Notes for Atelier Assist, and the hold toast's "Sending to <Mode>…".

Find (exact, once):

```text
  confirmHint: 'Prompts from your Ask Atelier Shortcut will send after a short pause. Links without your private key only fill the box.',
});
```

Replace with:

```text
  confirmHint: 'Prompts from your Ask Atelier Shortcut will send after a short pause, in the mode the link names (Ask unless it names another). Links without your private key only fill the box.',
  // Atelier Assist (android/): only a link with this browser's own key gets these (planLaunch plan.via).
  assist: 'From Atelier Assist — check it before sending.',
  confirmTitleAssist: 'Send from Atelier Assist without a tap?',
  confirmHintAssist: 'What you ask Atelier Assist on this phone will send here after a short pause, in the mode it picked. Links without your private key only fill the box.',
  assistOn: 'Turn on Send without a tap first, then copy the link.',
  assistCopied: 'Assist link copied — in Atelier Assist, tap ⋯ → Paste link, then delete it from your keyboard’s clipboard history.',
  assistCopyBelow: 'Copy the link below, then in Atelier Assist tap ⋯ → Paste link. Delete it from your keyboard’s clipboard history afterwards.',
  assistNewLink: 'New Assist link copied — paste it into Atelier Assist, then delete it from your keyboard’s clipboard history. The old one only fills the box now.',
});
// The hold's toast for a keyed launch: where it is going. (Video's, with its length and price, is app.js holdNote.)
export const sendingNote = (mode) => (MODE_LABELS[mode] ? `Sending to ${MODE_LABELS[mode]}…` : NOTES.sending);
```

**L4.** The link Atelier Assist pairs with (it keeps only the key). The Find starts at the blank line before the "pending launch" header.

Find (exact, once):

```text

// ───────────────────────── pending launch (signed out, LinkedIn round trip)
```

Replace with:

```text

// Atelier Assist (android/) pairs with this link once (Settings → Quick launch → Android → Atelier Assist): the app keeps
// only the key and builds its own /?start=<mode>&via=assist#k=<key>&send=1&q=<words> links (q last). Opened anywhere
// else, it is a keyed Ask link with nothing to send.
export const assistLink = (origin, key) => `${String(origin).replace(/\/+$/, '')}/?start=ask&via=assist#send=1&k=${key}&q=`;

// ───────────────────────── pending launch (signed out, LinkedIn round trip)
```

**L5.** planLaunch's documented plan gains `via`.

Find (exact, once):

```text
//   autoSend, stash, replay, clean, key: { present, valid, confirmed, limited }, intent (key-free) }.
```

Replace with:

```text
//   autoSend, stash, replay, clean, key: { present, valid, confirmed, limited }, via ('assist': a keyed Atelier Assist
//   link, labelled as such; else ''), intent (key-free) }.
```

**L6.** `via=assist` counts only with this browser's own key.

Find (exact, once):

```text
  const key = { present: Boolean(intent.key), valid, confirmed: valid && keys.confirmed === keys.mine, limited: rateLimited(keys.lastAutoAt, c.now) };
```

Replace with:

```text
  const key = { present: Boolean(intent.key), valid, confirmed: valid && keys.confirmed === keys.mine, limited: rateLimited(keys.lastAutoAt, c.now) };
  // via=assist is a label anyone can write: it counts (the note, the entry's label) only with this browser's own key.
  const assisted = valid && intent.via === 'assist';
```

**L7.** The source note says "From Atelier Assist" for a keyed Assist link.

Find (exact, once):

```text
label: intent.from === 'share' ? NOTES.shared : NOTES.link } : null,
```

Replace with:

```text
label: intent.from === 'share' ? NOTES.shared : assisted ? NOTES.assist : NOTES.link } : null,
```

**L8.** `plan.via`.

Find (exact, once):

```text
    share, send: 'none', sendWhy: '', voice: null, voiceWhy: null, autoSend: false, stash: false, replay, clean: Boolean(intent.any), key,
```

Replace with:

```text
    share, send: 'none', sendWhy: '', voice: null, voiceWhy: null, autoSend: false, stash: false, replay, clean: Boolean(intent.any), key,
    via: assisted ? 'assist' : '',
```

**L9.** The gate comment.

Find (exact, once):

```text
  // Keyed send: every gate must pass; anything else only prefills (and pulses Send). Ask only: no other start, and no
  // "/video …"-style prefix that submit() would turn into another mode (app.js also sends launches with extra.launch,
  // which skips that prefix and the multi-task split).
```

Replace with:

```text
  // Keyed send: every gate must pass; anything else only prefills (and pulses Send). In the link's own mode (start=,
  // any of the six); never a voice start, and never a "/video …" prefix in the text (app.js sends launches with
  // extra.launch, which skips that prefix and the multi-task split, so the mode is always the link's). Video holds
  // longer and shows its price (HOLD_MS.video, app.js holdNote).
```

**L10.** The gate itself: any of the six modes may send (voice and /prefix still may not).

Find (exact, once):

```text
    : intent.voice || (intent.mode && intent.mode !== 'ask') || /^\s*\//.test(text) ? 'mode'
```

Replace with:

```text
    : intent.voice || /^\s*\//.test(text) ? 'mode'
```

**L11.** A keyed send keeps the link's mode instead of forcing Ask.

Find (exact, once):

```text
  if (plan.send === 'send' || plan.send === 'confirm') plan.mode = 'ask';
```

Replace with:

```text
  if (plan.send === 'send' || plan.send === 'confirm') plan.mode = intent.mode || 'ask'; // the link's own mode
```

**L12.** applyLaunch's documented deps.

Find (exact, once):

```text
//   holdThenSend({ ms })  visible, cancellable hold, then submit()
```

Replace with:

```text
//   holdThenSend({ ms, mode, via })  visible, cancellable hold, then submit() in that mode (via 'assist': labelled)
```

**L13.** The confirm dep's doc.

Find (exact, once):

```text
//   confirmLinkSend()  → Promise<boolean>  the first-use dialog (Allow → true)
```

Replace with:

```text
//   confirmLinkSend({ via, mode })  → Promise<boolean>  the first-use dialog (Allow → true; Atelier Assist's own wording;
//     it names the mode this send goes to, and Video's length and price)
```

**L14.** The hold gets the mode's length, the mode and the label.

Find (exact, once):

```text
    call('holdThenSend', { ms: HOLD_MS.link }); did.push('hold');
```

Replace with:

```text
    call('holdThenSend', { ms: holdMs(plan.mode), mode: plan.mode, via: plan.via || '' }); did.push('hold');
```

**L15.** The first-use dialog learns the launch is Atelier Assist's.

Find (exact, once):

```text
    try { ok = Boolean(await call('confirmLinkSend')); } catch {}
```

Replace with:

```text
    try { ok = Boolean(await call('confirmLinkSend', { via: plan.via || '', mode: plan.mode || 'ask' })); } catch {}
```

**L16.** The hold after Allow, likewise.

Find (exact, once):

```text
      call('holdThenSend', { ms: HOLD_MS.link }); did.push('confirmed', 'hold');
```

Replace with:

```text
      call('holdThenSend', { ms: holdMs(plan.mode), mode: plan.mode, via: plan.via || '' }); did.push('confirmed', 'hold');
```

**L17.** Old consents don't carry over: an Allow is remembered with a scope (`v2:` = any of the six modes). A bare key in `launchKeyOk` was confirmed under the Ask-only dialog, so it reads as unconfirmed and the next keyed send asks again, naming its mode.

Find (exact, once):

```text
export function keyState(store) {
  return { mine: str(store.get('launchKey', '')), role: str(store.get('launchRole', '')), confirmed: str(store.get('launchKeyOk', '')), lastAutoAt: num(store.get('lastAutoSend', 0)) };
```

Replace with:

```text
// An Allow is kept as CONFIRM_SCOPE + key. 'v2:' = keyed sends in any of the six modes (v57). A bare key was allowed
// under the Ask-only dialog (v55/v56): it doesn't count, so the first keyed send after the update asks again.
export const CONFIRM_SCOPE = 'v2:';
const confirmedKey = (v) => { const s = str(v); return s.startsWith(CONFIRM_SCOPE) ? s.slice(CONFIRM_SCOPE.length) : ''; };
export function keyState(store) {
  return { mine: str(store.get('launchKey', '')), role: str(store.get('launchRole', '')), confirmed: confirmedKey(store.get('launchKeyOk', '')), lastAutoAt: num(store.get('lastAutoSend', 0)) };
```

**L18.** Allow is stored with that scope.

Find (exact, once):

```text
  store.set('launchKeyOk', mine); store.set('lastAutoSend', now);
```

Replace with:

```text
  store.set('launchKeyOk', CONFIRM_SCOPE + mine); store.set('lastAutoSend', now);
```

## 3. `public/app.js`

**A1.** Import the new launch.js names (anchored before `} from './launch.js`, so any `?v=` is kept).

Find (exact, once):

```text
NOTES, HOLD_MS, SHARE_CACHE, SHARE_LIMITS } from './launch.js
```

Replace with:

```text
NOTES, HOLD_MS, SHARE_CACHE, SHARE_LIMITS, sendingNote, assistLink, MODE_LABELS } from './launch.js
```

**A2.** holdNote: the hold toast's text per mode; Video's length and price from the Video options' own price table.

Find (exact, once):

```text
let sendHold = null;
```

Replace with:

```text
let sendHold = null;
// The keyed hold's toast: where it is going ("Sending to Image…"). Video also says how long and what it will cost, from
// the same table as the Video options (tester.js veoShape/veoCost: Veo's reserve, price × 1.25). A model with no price
// there (Runway, local) shows no price rather than a wrong one.
function holdNote(launchMode) {
  if (launchMode !== 'video') return sendingNote(launchMode);
  const o = S.opts.video, vm = videoModel(o.model), { seconds, resolution } = veoShape(o);
  const cost = vm?.veo ? veoCost(vm.id, seconds, resolution) : null;
  return `Making a ${seconds} s video${cost != null ? ` · ≈ ${money(cost, { up: true })}` : ''}`;
}
// The first-use dialog says what this send will do: its mode, and for Video its length, price and the 4 s hold.
function confirmWhat(launchMode) {
  if (launchMode === 'video') return `This one: ${holdNote('video')}, after a 4-second pause you can cancel.`;
  return `This one goes to ${MODE_LABELS[launchMode] || 'Ask'}, after a short pause you can cancel.`;
}
```

**A3.** holdThenSend takes the launch's mode and label.

Find (exact, once):

```text
function holdThenSend({ ms }) {
```

Replace with:

```text
function holdThenSend({ ms, mode: launchMode = '', via = '' }) {
```

**A4.** When the hold runs out, the entry is labelled.

Find (exact, once):

```text
submit(undefined, mode, { launch: true }); },
```

Replace with:

```text
submit(undefined, mode, { launch: true, ...(via && { via }) }); },
```

**A5.** The hold's toast: "Sending to Image…" / "Making a 4 s video · ≈ $0.25" + Cancel (Talk's own hold is unchanged).

Find (exact, once):

```text
  toast(NOTES.sending, { ms: ms + 600, action: { label: 'Cancel', onClick: () => sendHold?.cancel('cancel') } });
```

Replace with:

```text
  toast(launchMode ? holdNote(launchMode) : NOTES.sending, { ms: ms + 600, action: { label: 'Cancel', onClick: () => sendHold?.cancel('cancel') } });
```

**A6.** submit keeps the label on the entry (only ever set by the keyed hold above). Anchored on the end of the `const e = { … }` line, which reads the same before and after v56.

Find (exact, once):

```text
, ...extra.entry };
```

Replace with:

```text
, ...(extra.via === 'assist' && { via: 'assist' }), ...extra.entry };
```

**A7.** The entry shows "From Atelier Assist" above the prompt (the existing .task-of style).

Find (exact, once):

```text
      <h2 class="prompt" title="Click to expand">${esc(e.prompt)}</h2>
```

Replace with:

```text
      ${e.via === 'assist' ? '<p class="task-of">From Atelier Assist</p>' : ''}
      <h2 class="prompt" title="Click to expand">${esc(e.prompt)}</h2>
```

**A8.** The first-use dialog in Atelier Assist's words.

Find (exact, once):

```text
function confirmLinkSend() {
```

Replace with:

```text
function confirmLinkSend({ via = '', mode: launchMode = 'ask' } = {}) {
```

**A9.** Its title and hint, then what this send does (its mode; Video's length and price).

Find (exact, once):

```text
${esc(NOTES.confirmTitle)}</h3><p class="hint">${esc(NOTES.confirmHint)}</p>
```

Replace with:

```text
${esc(via === 'assist' ? NOTES.confirmTitleAssist : NOTES.confirmTitle)}</h3><p class="hint">${esc(via === 'assist' ? NOTES.confirmHintAssist : NOTES.confirmHint)}</p><p class="hint">${esc(confirmWhat(launchMode))}</p>
```

**A10.** Settings → Quick launch: the Android Atelier Assist block mirrors Send without a tap.

Find (exact, once):

```text
  $('#qlLink').hidden = true; $('#qlLink').value = '';
}
```

Replace with:

```text
  $('#qlLink').hidden = true; $('#qlLink').value = '';
  // Android: Atelier Assist (the side-button app). Its Send without a tap is the same setting and key as the iPhone's.
  if ($('#qlAssist')) {
    $('#qlAssist').hidden = PLATFORM !== 'android';
    $$('input[name=qlAssistSend]', f).forEach((r) => (r.checked = r.value === (q.linkSend ? 'on' : 'off')));
    $('#qlAssistReset').hidden = PLATFORM !== 'android' || !keyState(LS).mine;
    $('#qlAssistLink').hidden = true; $('#qlAssistLink').value = '';
  }
}
```

**A11.** Save reads Android's Send without a tap from the Atelier Assist block (the iPhone step is hidden there).

Find (exact, once):

```text
  const next = { send: val('qlSend') ? val('qlSend') === 'send' : prev.send, listen: val('qlListen') ? val('qlListen') === 'on' : prev.listen, linkSend: val('qlLinkSend') ? val('qlLinkSend') === 'on' : prev.linkSend };
```

Replace with:

```text
  const link = val(PLATFORM === 'android' && $('#qlAssist') ? 'qlAssistSend' : 'qlLinkSend');
  const next = { send: val('qlSend') ? val('qlSend') === 'send' : prev.send, listen: val('qlListen') ? val('qlListen') === 'on' : prev.listen, linkSend: link ? link === 'on' : prev.linkSend };
```

**A12.** copyLink can fill another manual-copy field.

Find (exact, once):

```text
async function copyLink(link, ok, manual) {
  try { await navigator.clipboard.writeText(link); $('#qlLink').hidden = true; $('#qlLink').value = ''; toast(ok, { ms: 9000 }); }
  catch { const i = $('#qlLink'); i.value = link; i.hidden = false; i.focus(); i.select(); toast(manual, { ms: 9000 }); }
}
```

Replace with:

```text
async function copyLink(link, ok, manual, field = '#qlLink') {
  try { await navigator.clipboard.writeText(link); $(field).hidden = true; $(field).value = ''; toast(ok, { ms: 9000 }); }
  catch { const i = $(field); i.value = link; i.hidden = false; i.focus(); i.select(); toast(manual, { ms: 9000 }); }
}
```

**A13.** On Android, the iPhone section's Copy (a plain link) must not switch off Atelier Assist or forget its key.

Find (exact, once):

```text
  LS.set('quick', { ...quickPrefs(LS), linkSend: on }); // copying is the choice: no Save needed for the link to work
  if (!on) forgetLaunchKey(LS);
```

Replace with:

```text
  // Android: this copies the plain link and leaves Atelier Assist's Send without a tap, and its key, alone.
  if (PLATFORM !== 'android') {
    LS.set('quick', { ...quickPrefs(LS), linkSend: on }); // copying is the choice: no Save needed for the link to work
    if (!on) forgetLaunchKey(LS);
  }
```

**A14.** Copy Assist link / New link.

Find (exact, once):

```text
$('#qlTest')?.addEventListener('click', async () => {
```

Replace with:

```text
// Settings → Quick launch → Android → Atelier Assist: the same per-browser key as the iPhone link, in the link the
// Android app pairs with (it keeps only the key). Copying with Send without a tap on is the choice: no Save needed.
$('#qlAssistCopy')?.addEventListener('click', () => {
  const role = roleNow();
  if (!role) return toast('Sign in first — the link only works in a signed-in browser.');
  if ($('input[name=qlAssistSend]:checked', $('#settingsForm'))?.value !== 'on') return toast(NOTES.assistOn);
  LS.set('quick', { ...quickPrefs(LS), linkSend: true });
  $('#qlAssistReset').hidden = false;
  copyLink(assistLink(location.origin, ensureLaunchKey(LS, role)), NOTES.assistCopied, NOTES.assistCopyBelow, '#qlAssistLink');
});
// New link: a fresh key (paste it into Atelier Assist again; the old pairing only fills the box from now on).
$('#qlAssistReset')?.addEventListener('click', () => {
  const role = roleNow(); if (!role || PLATFORM !== 'android') return;
  LS.set('quick', { ...quickPrefs(LS), linkSend: true });
  copyLink(assistLink(location.origin, rotateLaunchKey(LS, role)), NOTES.assistNewLink, NOTES.assistCopyBelow, '#qlAssistLink');
});
$('#qlTest')?.addEventListener('click', async () => {
```

## 4. `public/index.html`

**H1.** The Android power-button note.

Find (exact, once):

```text
<p class="hint ql-small">Holding the power button stays with your phone’s assistant — Android gives that only to native apps.</p>
```

Replace with:

```text
<p class="hint ql-small">Holding the power button stays with your phone’s assistant — Android gives that only to native apps, like Atelier Assist below.</p>
```

**H2.** Settings → Quick launch → Android → Atelier Assist (before Test the mic).

Find (exact, once):

```text
            <div class="row-actions ql-acts"><button type="button" class="chip" id="qlTest">Test the mic</button></div>
```

Replace with:

```text
            <div class="ql-row" id="qlAssist" hidden>
              <span class="ql-label">Atelier Assist</span>
              <p class="hint">The Atelier Assist app on your side button sends what you say here, in the mode it picks. Pair it once: turn on <b>Send without a tap</b>, tap <b>Copy Assist link</b>, then in Atelier Assist tap ⋯ → <b>Paste link</b>.</p>
              <span class="ql-label" id="qlAssistSendLabel">Send without a tap</span>
              <div class="seg" role="radiogroup" aria-labelledby="qlAssistSendLabel">
                <label><input type="radio" name="qlAssistSend" value="off" /> <span>Off</span></label>
                <label><input type="radio" name="qlAssistSend" value="on" /> <span>On</span></label>
              </div>
              <p class="hint">On adds a private key to the link that only this browser and the installed app accept. The first time, Atelier asks you to confirm. Video waits 4 seconds and shows its price before it starts. Signing out turns it off.</p>
              <div class="row-actions ql-acts"><button type="button" class="chip" id="qlAssistCopy">Copy Assist link</button><button type="button" class="chip" id="qlAssistReset" hidden>New link</button></div>
              <input class="ql-link" id="qlAssistLink" type="text" readonly aria-label="Your Atelier Assist link" hidden />
            </div>
            <div class="row-actions ql-acts"><button type="button" class="chip" id="qlTest">Test the mic</button></div>
```

## 5. `tests/launch.test.mjs` (existing expectations that change)

**T1.** Header.

Find (exact, once):

```text
// confirmed per-browser fragment key can send it (Ask-only, empty composer, signed in, online, idle, 1 per 15 s).
```

Replace with:

```text
// confirmed per-browser fragment key can send it (in the link's own mode, never a voice start or a /mode prefix; empty
// composer, signed in, online, idle, 1 per 15 s).
```

**T2.** Any of the six modes now sends; a voice start still only prefills.

Find (exact, once):

```text
  // Ask-only: any other start (including voice) only prefills.
  for (const m of ['code', 'image', 'video', 'ideas', 'build', 'voice']) {
    const p = booted(`/?start=${m}#send=1&k=${KEY}&q=x`);
    assert.deepEqual([p.send, p.sendWhy], ['review', 'mode'], m);
  }
  assert.equal(booted(`/?mode=build#send=1&k=${KEY}&q=x`).sendWhy, 'mode', 'legacy ?mode= counts too');
```

Replace with:

```text
  // Any of the six modes sends in that mode (tests/assist-launch.test.mjs); a voice start never sends a link's text.
  for (const m of ['code', 'image', 'video', 'ideas', 'build']) {
    const p = booted(`/?start=${m}#send=1&k=${KEY}&q=x`);
    assert.deepEqual([p.send, p.sendWhy, p.mode], ['send', 'ok', m], m);
  }
  const voice = booted(`/?start=voice#send=1&k=${KEY}&q=x`);
  assert.deepEqual([voice.send, voice.sendWhy], ['review', 'mode']);
  assert.equal(booted(`/?mode=build#send=1&k=${KEY}&q=x`).mode, 'build', 'legacy ?mode= counts too');
```

**T3.** The hold now gets the mode and label.

Find (exact, once):

```text
  assert.deepEqual(d.calls.find((c) => c[0] === 'holdThenSend'), ['holdThenSend', { ms: HOLD_MS.link }]);
```

Replace with:

```text
  assert.deepEqual(d.calls.find((c) => c[0] === 'holdThenSend'), ['holdThenSend', { ms: HOLD_MS.link, mode: 'ask', via: '' }]);
```

**T4.** Title.

Find (exact, once):

```text
test('the keyed send is Ask only: a /mode prefix in the text only prefills', () => {
```

Replace with:

```text
test('a /mode prefix in keyed text only prefills: the link’s start= picks the mode', () => {
```

**T5.** A keyed image link now sends; a keyed "/video …" prefix is the "held by another gate" case.

Find (exact, once):

```text
  const [, mode] = await toasts(`/?start=image#send=1&k=${KEY}&q=x`);
```

Replace with:

```text
  const [, mode] = await toasts(`/?start=image#send=1&k=${KEY}&q=%2Fvideo%20x`); // a /mode prefix never sends
```

**T6.** Import the confirmation scope.

Find (exact, once):

```text
  takeShare, sweepShare, detectPlatform, isStandalone, micPermission, whenVisible, createHold, applyLaunch,
} from '../public/launch.js';
```

Replace with:

```text
  takeShare, sweepShare, detectPlatform, isStandalone, micPermission, whenVisible, createHold, applyLaunch, CONFIRM_SCOPE,
} from '../public/launch.js';
```

**T7.** A stored Allow now carries its scope.

Find (exact, once):

```text
  const store = memStore({ quick: { linkSend: true }, launchKey: KEY, launchRole: 'owner', launchKeyOk: KEY });
```

Replace with:

```text
  const store = memStore({ quick: { linkSend: true }, launchKey: KEY, launchRole: 'owner', launchKeyOk: CONFIRM_SCOPE + KEY });
```

**T8.** Likewise.

Find (exact, once):

```text
  const store = memStore({ launchKey: KEY, launchRole: 'owner', launchKeyOk: KEY });
```

Replace with:

```text
  const store = memStore({ launchKey: KEY, launchRole: 'owner', launchKeyOk: CONFIRM_SCOPE + KEY });
```

**T9.** Allow stores the scoped key.

Find (exact, once):

```text
  assert.equal(store.get('launchKeyOk'), KEY); assert.equal(store.get('lastAutoSend'), NOW);
```

Replace with:

```text
  assert.equal(store.get('launchKeyOk'), CONFIRM_SCOPE + KEY); assert.equal(store.get('lastAutoSend'), NOW);
```

**T10.** Likewise.

Find (exact, once):

```text
  const store = memStore({ launchKey: KEY, launchRole: 'owner', launchKeyOk: KEY, quick: { linkSend: true } });
```

Replace with:

```text
  const store = memStore({ launchKey: KEY, launchRole: 'owner', launchKeyOk: CONFIRM_SCOPE + KEY, quick: { linkSend: true } });
```

## 5a. `docs/quick-launch.md` (the trust rules)

**D1.** The hold lengths.

Find (exact, once):

```text
  - a visible, cancellable hold (2.5 s for a link, 1.5 s for voice);
```

Replace with:

```text
  - a visible, cancellable hold (2.5 s for a link, 4 s for Video with its price, 1.5 s for voice);
```

**D2.** The trust rule: no longer Ask-only, and old consents don't carry over.

Find (exact, once):

```text
  - Ask mode only.
```

Replace with:

```text
  - in the link's own mode (`start=`, any of the six since v57: Atelier Assist on Android, and Shortcut links that
    name a mode), never a voice start and never a `/mode` prefix in the text;
  - a first-use confirm given before v57 (under the Ask-only dialog) doesn't count. An Allow is stored as
    `v2:<key>` now, so the first keyed send after the update asks again, and the dialog names the mode (and
    Video's length and price).
```

**D3.** The History residual risk no longer rests on Ask-only.

Find (exact, once):

```text
  - A keyed send is still an Ask-only, rate-limited, held and labelled turn.
```

Replace with:

```text
  - A keyed send is still a rate-limited, held and labelled turn. Since v57 it can be any of the six modes, so a key
    read from History or History sync can start paid Image or Video work, after the hold (4 s and the price for
    Video), and only in a browser that holds that confirmed key. Atelier Assist's links land in Chrome's History
    the same way. Retire a key that may have been seen with **New link**.
```

## 5b. `public/privacy.html` (History and speech)

**P1.** Atelier Assist's links are in Chrome History too, and speech goes through the phone's speech service.

Find (exact, once):

```text
use Settings → Quick launch → New link if anyone else can see that history.
```

Replace with:

```text
use Settings → Quick launch → New link if anyone else can see that history. Atelier Assist, the Android side-button app, works the same way: each request opens Atelier at a link with that key and your words in it, so Chrome’s History (and Chrome sync) keeps them too; New link under Quick launch → Atelier Assist retires that key. Atelier Assist turns your voice into text with your phone’s speech service, which may use Google’s or your phone maker’s servers, before the words reach Atelier; the app itself keeps only the key.
```

## 6. New file `tests/assist-launch.test.mjs`

```js
// Atelier Assist 1.1 (android/): keyed launches in all six modes.
// The app opens the installed Atelier with /?start=<mode>&via=assist#k=<key>&send=1&q=<words> (q last). Atelier sends
// without a tap only with this browser's own confirmed key, in the link's mode (any of the six now, not only Ask),
// behind the visible, cancellable hold: 2.5 s, or 4 s for Video with its price in the toast. Everything else about a
// keyed send is unchanged (role, confirm once, 15 s rate limit, empty composer, idle, online, visible, no voice start,
// no /mode prefix). A stranger's link, via=assist or not, still only prefills, and never gets the Assist label.
// An Allow given under the Ask-only dialog (v55/v56, a bare key) no longer counts: the next keyed send asks again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  LAUNCH_MODES, HOLD_MS, NOTES, QUICK_DEFAULTS, RATE_MS, MODE_LABELS, holdMs, sendingNote, assistLink, readLaunch, planLaunch,
  applyLaunch, keyState, createHold, stashLaunch, takePendingLaunch, confirmLaunchKey, CONFIRM_SCOPE,
} from '../public/launch.js';
import { money, veoCost, veoShape } from '../public/tester.js';

const read = async (p) => (await readFile(new URL(`../${p}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const [APP, HTML] = await Promise.all(['public/app.js', 'public/index.html'].map(read));

const NOW = 1_800_000_000_000;
const KEY = 'AbCdEfGhIjKlMnOpQrStU_';
const OTHER = 'ZZCdEfGhIjKlMnOpQrStU-';
function memStore(init = {}) {
  const m = new Map(Object.entries(init).map(([k, v]) => [k, JSON.stringify(v)]));
  return { get(k, d) { return m.has(k) ? JSON.parse(m.get(k)) : d; }, set(k, v) { m.set(k, JSON.stringify(v)); }, del(k) { m.delete(k); } };
}
const owner = (over = {}) => ({
  signedIn: true, role: 'owner', standalone: true, sr: true, perm: 'prompt', online: true, busy: false, visible: true, now: NOW,
  composer: '', attachments: 0, prefs: { ...QUICK_DEFAULTS, linkSend: true }, keys: { mine: KEY, role: 'owner', confirmed: KEY, lastAutoAt: 0 }, ...over,
});
// The composer as boot leaves it: the link text prefilled into an empty composer.
const booted = (url, ctx = {}) => { const u = new URL(url, 'https://atelier.test'); const i = readLaunch(u.search, u.hash); return planLaunch(i, { ...owner(), composer: i.text, ...ctx }); };
// What Atelier Assist (android/app/.../LaunchLink.kt) sends.
const assist = (mode, q = 'a red fox', key = KEY) => `/?start=${mode}&via=assist#k=${key}&send=1&q=${encodeURIComponent(q)}`;
function fakeDeps({ store = memStore(), text = '', allow = true } = {}) {
  const calls = [];
  const rec = (name, ret) => (...a) => { calls.push([name, ...a]); return typeof ret === 'function' ? ret(...a) : ret; };
  return {
    calls, store, now: () => NOW, platform: 'android',
    setMode: rec('setMode'), getText: () => text, setText: rec('setText'), showSource: rec('showSource'), toast: rec('toast'),
    armSend: rec('armSend'), armMic: rec('armMic'), holdThenSend: rec('holdThenSend'), confirmLinkSend: rec('confirmLinkSend', async () => allow),
    startVoice: rec('startVoice', true), composerEmpty: () => !text.trim(), dialogOpen: () => false, whenVisible: async () => true, focusInput: rec('focusInput'),
  };
}
const find = (calls, name) => calls.find((c) => c[0] === name);

// ───────────────────────── planLaunch ─────────────────────────
test('a keyed link sends in its own mode, for all six; via=assist with the key is labelled "From Atelier Assist"', () => {
  for (const m of LAUNCH_MODES) {
    const p = booted(assist(m));
    assert.deepEqual([p.send, p.sendWhy, p.mode, p.via], ['send', 'ok', m, 'assist'], m);
    assert.equal(p.prefill.label, NOTES.assist, m);
    assert.equal(p.prefill.from, 'link', `${m}: still a link's text (kept from the accounts agent)`);
  }
  // The iPhone Shortcut (no via) can name a mode too; it is labelled as a link.
  const s = booted(`/?start=image#send=1&k=${KEY}&q=cat`);
  assert.deepEqual([s.send, s.mode, s.via, s.prefill.label], ['send', 'image', '', NOTES.link]);
  const legacy = booted(`/?mode=build#send=1&k=${KEY}&q=x`);
  assert.deepEqual([legacy.send, legacy.mode], ['send', 'build'], 'legacy ?mode=');
  assert.equal(booted(`/#send=1&k=${KEY}&q=x`).mode, 'ask', 'no start: Ask, as before');
});

test('every other keyed-send gate still holds, in every mode', () => {
  for (const m of LAUNCH_MODES) {
    const gate = (url, ctx = {}) => { const p = booted(url, ctx); return [p.send, p.sendWhy]; };
    assert.deepEqual(gate(assist(m), { prefs: { ...QUICK_DEFAULTS, linkSend: false } }), ['review', 'off'], `${m} off`);
    assert.deepEqual(gate(assist(m).replace(`k=${KEY}&`, '')), ['review', 'no-key'], `${m} no key`);
    assert.deepEqual(gate(assist(m, 'x', OTHER)), ['review', 'bad-key'], `${m} bad key`);
    assert.deepEqual(gate(assist(m), { role: 'tester:li-1' }), ['review', 'bad-key'], `${m} another role`);
    assert.deepEqual(gate(assist(m), { keys: { mine: KEY, role: 'owner', confirmed: KEY, lastAutoAt: NOW - RATE_MS + 1 } }), ['review', 'rate'], `${m} rate`);
    assert.deepEqual(gate(assist(m), { composer: 'my draft\n\na red fox' }), ['review', 'draft'], `${m} draft`);
    assert.deepEqual(gate(assist(m), { attachments: 1 }), ['review', 'draft'], `${m} attachment`);
    assert.deepEqual(gate(assist(m), { online: false }), ['review', 'offline'], `${m} offline`);
    assert.deepEqual(gate(assist(m), { busy: true }), ['review', 'busy'], `${m} busy`);
    assert.deepEqual(gate(assist(m), { dialogOpen: true }), ['review', 'dialog'], `${m} dialog`);
    assert.deepEqual(gate(assist(m), { visible: false }), ['review', 'hidden'], `${m} hidden`);
    assert.deepEqual(gate(assist(m), { replay: true }), ['review', 'replay'], `${m} replay`);
    assert.deepEqual(gate(assist(m, '/video a dog surfing')), ['review', 'mode'], `${m} slash prefix`);
    const out = booted(assist(m), { signedIn: false, role: '' });
    assert.deepEqual([out.send, out.sendWhy, out.stash], ['review', 'signed-out', true], `${m} signed out`);
  }
  // A voice start never sends a link's words, keyed or not.
  assert.deepEqual([booted(`/?start=voice&via=assist#k=${KEY}&send=1&q=x`).send, booted(`/?start=voice&via=assist#k=${KEY}&send=1&q=x`).sendWhy], ['review', 'mode']);
});

test('a stranger can’t borrow the label: via=assist without this browser’s key is just a link', () => {
  for (const url of [`/?start=video&via=assist#send=1&q=x`, assist('video', 'x', OTHER), `/?start=video&via=assist#q=x`]) {
    const p = booted(url);
    assert.notEqual(p.send, 'send', url);
    assert.equal(p.via, '', url);
    assert.equal(p.prefill.label, NOTES.link, url);
  }
  // The stash after sign-in keeps neither the key nor the label: a replay only prefills.
  const store = memStore();
  stashLaunch(store, readLaunch('?start=image&via=assist', `#k=${KEY}&send=1&q=cat`), NOW);
  const r = planLaunch(takePendingLaunch(store, NOW), owner({ composer: 'cat' }));
  assert.deepEqual([r.send, r.via, r.mode, r.prefill.label], ['review', '', 'image', NOTES.link]);
});

test('the first keyed use still asks (with Atelier Assist’s wording); Allow holds in the link’s mode', async () => {
  const store = memStore({ launchKey: KEY, launchRole: 'owner' });
  const p = booted(assist('image'), { keys: keyState(store) });
  assert.deepEqual([p.send, p.sendWhy, p.mode, p.via], ['confirm', 'unconfirmed', 'image', 'assist']);
  const d = fakeDeps({ store, text: 'a red fox' });
  assert.deepEqual(await applyLaunch(p, d), ['mode:image', 'prefill:link', 'confirmed', 'hold']);
  assert.deepEqual(find(d.calls, 'confirmLinkSend'), ['confirmLinkSend', { via: 'assist', mode: 'image' }]);
  assert.deepEqual(find(d.calls, 'holdThenSend'), ['holdThenSend', { ms: HOLD_MS.link, mode: 'image', via: 'assist' }]);
  assert.deepEqual(find(d.calls, 'showSource'), ['showSource', NOTES.assist]);
  assert.equal(store.get('launchKeyOk'), CONFIRM_SCOPE + KEY);
  // Not now: Send pulses, nothing is held.
  const s2 = memStore({ launchKey: KEY, launchRole: 'owner' });
  const no = fakeDeps({ store: s2, text: 'a red fox', allow: false });
  await applyLaunch(booted(assist('video'), { keys: keyState(s2) }), no);
  assert.equal(find(no.calls, 'holdThenSend'), undefined);
  assert.ok(find(no.calls, 'armSend'));
});

test('an Allow given under the Ask-only dialog (a bare key) no longer counts: the next keyed send asks again, naming its mode', async () => {
  // v55/v56 stored the bare key. It reads as unconfirmed now, in every mode, Ask included.
  const legacy = memStore({ launchKey: KEY, launchRole: 'owner', launchKeyOk: KEY });
  assert.equal(keyState(legacy).confirmed, '');
  for (const m of LAUNCH_MODES) assert.deepEqual([booted(assist(m), { keys: keyState(legacy) }).send], ['confirm'], m);
  assert.equal(booted(`/?start=video#send=1&k=${KEY}&q=x`, { keys: keyState(legacy) }).send, 'confirm', 'the iPhone Shortcut too');
  const d = fakeDeps({ store: legacy, text: 'waves' });
  await applyLaunch(booted(assist('video', 'waves'), { keys: keyState(legacy) }), d);
  assert.deepEqual(find(d.calls, 'confirmLinkSend'), ['confirmLinkSend', { via: 'assist', mode: 'video' }]);
  assert.equal(legacy.get('launchKeyOk'), CONFIRM_SCOPE + KEY, 'Allow re-stores it with the scope');
  assert.equal(keyState(legacy).confirmed, KEY);
  // A scoped Allow for another (older) key doesn't count either.
  assert.equal(keyState(memStore({ launchKey: KEY, launchRole: 'owner', launchKeyOk: CONFIRM_SCOPE + OTHER })).confirmed, OTHER);
  assert.equal(booted(assist('ask'), { keys: keyState(memStore({ launchKey: KEY, launchRole: 'owner', launchKeyOk: CONFIRM_SCOPE + OTHER })) }).send, 'confirm');
  const fresh = memStore({ launchKey: KEY, launchRole: 'owner' });
  assert.equal(confirmLaunchKey(fresh, NOW), true);
  assert.equal(fresh.get('launchKeyOk'), CONFIRM_SCOPE + KEY);
});

test('Video holds 4 s, every other mode 2.5 s; the 15 s window starts either way', async () => {
  assert.equal(HOLD_MS.video, 4000);
  for (const m of LAUNCH_MODES) assert.equal(holdMs(m), m === 'video' ? 4000 : HOLD_MS.link, m);
  assert.equal(holdMs(undefined), HOLD_MS.link);
  for (const m of ['video', 'build']) {
    const store = memStore({ launchKey: KEY, launchRole: 'owner', launchKeyOk: CONFIRM_SCOPE + KEY });
    const d = fakeDeps({ store, text: 'a red fox' });
    assert.deepEqual(await applyLaunch(booted(assist(m), { keys: keyState(store) }), d), [`mode:${m}`, 'prefill:link', 'hold']);
    assert.deepEqual(find(d.calls, 'holdThenSend'), ['holdThenSend', { ms: holdMs(m), mode: m, via: 'assist' }]);
    assert.equal(store.get('lastAutoSend'), NOW);
    assert.equal(booted(assist(m), { keys: keyState(store) }).sendWhy, 'rate', `${m}: the same link again right away only prefills`);
  }
});

test('sendingNote names the mode; assistLink is what the Android app pairs with', () => {
  for (const m of LAUNCH_MODES) assert.equal(sendingNote(m), `Sending to ${MODE_LABELS[m]}…`);
  assert.equal(sendingNote('ideas'), 'Sending to Ideas…');
  assert.equal(sendingNote(''), NOTES.sending);
  assert.equal(sendingNote('voice'), NOTES.sending);
  const link = assistLink('https://atelier.test/', KEY);
  assert.equal(link, `https://atelier.test/?start=ask&via=assist#send=1&k=${KEY}&q=`);
  const u = new URL(link + encodeURIComponent('what is 2+2 & why = ?'));
  const i = readLaunch(u.search, u.hash);
  assert.deepEqual([i.key, i.send, i.via, i.text, i.mode], [KEY, true, 'assist', 'what is 2+2 & why = ?', 'ask']);
  // Opened as is (empty q), it sends nothing.
  const bare = new URL(link);
  assert.equal(planLaunch(readLaunch(bare.search, bare.hash), owner()).send, 'none');
});

// ───────────────────────── app.js wiring (functions lifted out, run against stubs) ─────────────────────────
function fnSource(name) {
  const at = APP.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `app.js has function ${name}`);
  return APP.slice(at, APP.indexOf('\n}\n', at) + 2);
}
const scope = (vars) => new Proxy(vars, {
  has: (t, k) => typeof k === 'string' && (k in t || !(k in globalThis)),
  get: (t, k) => (k === Symbol.unscopables ? undefined : k in t ? t[k] : () => undefined),
  set: (t, k, v) => { t[k] = v; return true; },
});
const evalIn = (vars, body) => new Function('scope', `with (scope) { ${body} }`)(scope(vars));
function holdRig({ mode = 'ask', video = { model: '', aspect: '16:9', secs: 4, enhance: true }, vm = { id: 'gemini:veo-3.1-lite-generate-preview', veo: true } } = {}) {
  const calls = [], due = new Map(); let id = 0;
  const timers = { setTimeout: (f, ms) => { due.set(++id, { f, ms }); return id; }, clearTimeout: (t) => due.delete(t) };
  const vars = {
    calls, sendHold: null, S: { mode, busy: false, attachments: [], video: null, opts: { video } },
    NOTES, HOLD_MS, MODE_LABELS, sendingNote, money, veoCost, veoShape, videoModel: () => vm,
    hasDraft: () => true, micOn: () => false, createHold: (o) => createHold({ ...o, timers }),
    $: () => ({ classList: { add() {}, remove() {} }, style: { setProperty() {}, removeProperty() {} }, contains: () => false }),
    input: { addEventListener() {}, removeEventListener() {} },
    document: { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' },
    toast: (msg, o = {}) => calls.push(['toast', msg, o.action?.label ?? null]),
    hideToast: () => calls.push(['hideToast']), armSend: () => calls.push(['armSend']), submit: (...a) => calls.push(['submit', ...a]),
  };
  const fns = evalIn(vars, `return { holdNote: (${fnSource('holdNote')}), holdThenSend: (${fnSource('holdThenSend')}), confirmWhat: (${fnSource('confirmWhat')}) };`);
  vars.holdNote = fns.holdNote;
  return { ...fns, calls, due, vars };
}

test('the hold’s toast names the mode; Video says its length and price; the send carries the Assist label', () => {
  const img = holdRig({ mode: 'image' });
  img.holdThenSend({ ms: HOLD_MS.link, mode: 'image', via: 'assist' });
  assert.deepEqual(img.calls[0], ['toast', 'Sending to Image…', 'Cancel']);
  [...img.due.values()][0].f(); // the hold runs out
  assert.deepEqual(img.calls.find((c) => c[0] === 'submit'), ['submit', undefined, 'image', { launch: true, via: 'assist' }]);

  const vid = holdRig({ mode: 'video' });
  vid.holdThenSend({ ms: HOLD_MS.video, mode: 'video', via: 'assist' });
  assert.deepEqual(vid.calls[0], ['toast', 'Making a 4 s video · ≈ $0.25', 'Cancel']);
  assert.equal([...vid.due.values()][0].ms, 4000);
  // 16:9 HD is always 8 s at 1080p; a model with no price here (Runway, local) shows no price rather than a wrong one.
  assert.equal(holdRig({ mode: 'video', video: { model: '', aspect: '16:9hd', secs: 4 } }).holdNote('video'), 'Making a 8 s video · ≈ $0.80');
  assert.equal(holdRig({ mode: 'video', vm: { id: 'runway:gen4.5', veo: false } }).holdNote('video'), 'Making a 4 s video');

  // The first-use dialog says where this send goes; Video also says its length and price.
  assert.equal(img.confirmWhat('image'), 'This one goes to Image, after a short pause you can cancel.');
  assert.equal(vid.confirmWhat('video'), 'This one: Making a 4 s video · ≈ $0.25, after a 4-second pause you can cancel.');
  assert.equal(img.confirmWhat(undefined), 'This one goes to Ask, after a short pause you can cancel.');

  // The iPhone Shortcut (no via) and Talk's own hold (no mode) are unchanged.
  const plain = holdRig();
  plain.holdThenSend({ ms: HOLD_MS.voice });
  assert.deepEqual(plain.calls[0], ['toast', NOTES.sending, 'Cancel']);
  [...plain.due.values()][0].f();
  assert.deepEqual(plain.calls.find((c) => c[0] === 'submit'), ['submit', undefined, 'ask', { launch: true }]);
});

test('the entry, the first-use dialog and Settings → Quick launch know about Atelier Assist', async () => {
  assert.match(fnSource('submit'), /\.\.\.\(extra\.via === 'assist' && \{ via: 'assist' \}\)/, 'submit keeps the label on the entry');
  assert.match(fnSource('renderEntry'), /e\.via === 'assist' \? '<p class="task-of">From Atelier Assist<\/p>'/);
  assert.match(fnSource('confirmLinkSend'), /via === 'assist' \? NOTES\.confirmTitleAssist : NOTES\.confirmTitle/);
  assert.match(fnSource('confirmLinkSend'), /\{ via = '', mode: launchMode = 'ask' \}/);
  assert.match(fnSource('confirmLinkSend'), /esc\(confirmWhat\(launchMode\)\)/, 'the dialog names the mode (and Video’s price)');
  for (const id of ['qlAssist', 'qlAssistCopy', 'qlAssistReset', 'qlAssistLink']) assert.match(HTML, new RegExp(`id="${id}"`), id);
  assert.match(HTML, /name="qlAssistSend" value="on"/);
  assert.match(APP, /\$\('#qlAssistCopy'\)\?\.addEventListener\('click'/);
  // The Android app's setup page walks the owner through these exact labels.
  const strings = await read('android/app/src/main/res/values/strings.xml');
  for (const label of ['Quick launch → Android → Atelier Assist', 'Send without a tap', 'Copy Assist link']) {
    assert.ok(strings.includes(label), `android strings.xml says "${label}"`);
    assert.ok(HTML.includes(label.split(' → ').at(-1)), `index.html says "${label.split(' → ').at(-1)}"`);
  }
});
```

## 7. Verify before deploying (the deploy checklist)

1. `npm run check` and `npm test`. The launch suites must pass: `assist-launch`, `launch` and `launch-wiring`.
2. Bump the version, then run the offline fixture (`npm run review:ui`, http://127.0.0.1:8791, launch config
   "atelier-review"). Use a phone width (360–430 px) with an Android user agent, signed in as the owner:
   1. Settings → Quick launch → Android shows **Atelier Assist**. With Send without a tap Off, Copy Assist link says
      "Turn on Send without a tap first…".
   2. Turn it On and tap Copy. The clipboard holds `…/?start=ask&via=assist#send=1&k=<22 chars>&q=`, and **New link**
      appears. In the iPhone section, Copy (the plain link) leaves Send without a tap On.
   3. Open the copied link with `start=image` and `q=a%20red%20fox`:
      - the confirm dialog says "Send from Atelier Assist without a tap?" and "This one goes to Image…"; choose Allow;
      - the mode is Image, the note says "From Atelier Assist", and the toast says "Sending to Image… Cancel" for 2.5 s;
      - once it sends, the entry shows **FROM ATELIER ASSIST**.
   4. The same link again within 15 s only prefills.
   5. `start=video`: "Making a 4 s video · ≈ $0.25 — Cancel" for 4 s. With HD on, "8 s · ≈ $0.80". Don't let it
      generate on the fixture: Cancel shows "Held — edit, then tap Send".
   6. A link with `via=assist` but no `k` only prefills, and says "From a link".
   7. Sign out: the key, the setting and the pairing link stop working (only prefill).
   8. An Allow from before the update: in DevTools set `localStorage` `launchKeyOk` to the bare key (no `v2:`) and open
      a keyed link. The dialog asks again.
3. Deploy (`npm run deploy`) and curl the live `sw.js` VERSION.
4. On the phone: in Atelier Assist, tap ⋯ → Paste link. Then press and hold the side button and say "make an image of a
   red fox". The installed app opens in Image, asks once, holds 2.5 s and sends "a red fox".

## 8. Notes

- **Video price:** Veo's reserve (price × 1.25, rounded up), the same number the tester budget holds. Runway and local
  models show no price, rather than a wrong one. A Runway credit estimate could be added later from
  `runwayCredits`.
- **Testers:** the same rules apply per tester role (the key is made for that role). Their Ledger still refuses a send
  that doesn't fit, after the hold.
- **Atelier Assist without this patch:** Ask requests send once paired. All other modes open with the words in the box
  and Send pulsing. Today, pairing isn't possible on Android at all, because no keyed link is offered there. So until
  this ships, the app runs unpaired: prefill only, in the right mode.
- **History:** the browser's History, and History sync, keep the launch link with its key and words. §5a and §5b
  say so for Atelier Assist too, and no longer lean on "Ask-only". **New link** retires a key.
- **Re-confirmation:** every existing "Send without a tap" user (the owner's iPhone Shortcut included) sees the
  first-use dialog once more after this ships. That is intended: their earlier Allow covered Ask only.
- **Also pending from 1.0:** `android/web-integration/assist-panel-integration.md` §5h (`FORBID_TAGS: ['form']` in
  `md()`) is still a standalone security fix for every browser. The rest of that document is obsolete with 1.1 (there
  is no WebView panel).
