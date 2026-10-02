// Quick launch: what a launch URL may do. Manifest shortcuts (/?start=voice|ask|image), the iPhone "Ask Atelier"
// Shortcut (/?start=ask#q=…, optionally #send=1&k=<key>&q=…), the share target (/?share=<id|status>, sw.js), the
// legacy GET share (/?title=&text=&url=), legacy ?mode= and the start_url marker ?source=pwa.
//
// Threat model (the installed WebAPK captures every in-scope link, so ANY of these URLs can come from a stranger):
// - URL text (q, title/text/url, shares) is only ever prefilled and labelled, and cleaned first so that what the user
//   checks is all there is (no invisible characters, no blank padding below the fold). It is sent without a tap only
//   when the fragment carries this browser's private launch key, the key matches the signed-in role, the user confirmed
//   that key once, the launch is a plain request in the link's own mode (start=, any of the six: Atelier Assist names
//   it; never a voice start or a /mode prefix) with nothing else in the composer, and no other keyed send
//   ran in the last 15 s. A link that fails any key check only pulses Send; "Ready when you are" is for verified links.
// - Voice auto-send applies only to an explicit voice launch that starts the mic itself, right after the launch, and
//   only while the composer is empty, so a ?q= prefill or a restored draft always waits for a tap. The send itself sits
//   behind a visible, cancellable hold (app.js). The mic opens by itself only in the installed app, visible, with
//   permission not denied; a browser tab, a background boot, a replayed launch (after sign-in) or an open dialog only
//   arms it.
// - Nothing that can send is ever stashed: the pending launch keeps {voice, mode, text, share, review} and replays
//   never send. An untouched link or share prefill is never kept as a draft (draftKeeper).
// Everything here is pure or takes its I/O (storage, Cache Storage, timers, UI) as arguments, so it is unit-tested in
// tests/launch.test.mjs without a browser. app.js owns the DOM and calls applyLaunch(plan, deps).

export const LAUNCH_MODES = ['ask', 'code', 'image', 'video', 'ideas', 'build'];
export const SHARE_STATUS = ['failed', 'lost', 'big'];
export const SHARE_ID = /^s[a-z0-9]{10}$/;
export const SHARE_CACHE = 'atelier-share'; // not 'atelier-v*': sw.js activate() keeps it across deploys
export const SHARE_TTL = 30 * 60e3;
export const PENDING_TTL = 15 * 60e3;
export const DRAFT_TTL = 6 * 36e5;
export const RATE_MS = 15e3; // at most one keyed auto-send per 15 s
export const MAX_TEXT = 8000;
export const HOLD_MS = { link: 2500, voice: 1500, video: 4000 };
// A keyed link holds 2.5 s before it sends; Video, the costly one, 4 s (its toast shows the price: app.js holdNote).
export const holdMs = (mode) => (mode === 'video' ? HOLD_MS.video : HOLD_MS.link);
export const MODE_LABELS = Object.freeze({ ask: 'Ask', code: 'Code', image: 'Image', video: 'Video', ideas: 'Ideas', build: 'Build' });
// A voice launch opens the mic only if the page is visible within this long: a boot that stays in the background (power
// button, app switch) arms the mic instead of opening it at the next unlock or return through Recents.
export const VISIBLE_WAIT_MS = 5000;
// What one shared message can carry (sw.js writes no more; app.js MAX_ATT is 4): one video up to 1 GB (Gemini's clip
// limit) or up to 4 photos of 25 MB each. Anything else is dropped and counted. These cap what is stored, not what is
// read: sw.js parses the whole POST body in memory first, so a share far below 1 GB may already be too much for a phone
// (unverified on a device; the user copy names no video size until it is).
export const SHARE_LIMITS = Object.freeze({ images: 4, imageBytes: 25 * 1024 ** 2, videoBytes: 1024 ** 3 });
export const KEY_LEN = 22; // base64url characters, 6 random bits each (132 bits)
const KEY_RE = /^[A-Za-z0-9_-]{22}$/;
const B64U = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
// Every device-local key this feature writes (all under the app's 'atelier.' localStorage prefix). 'quick' (the Settings →
// Quick launch choices) is one of them: the next person on a shared device must not inherit "Start listening when I open
// Atelier" or "Send without a tap" (the same rule setTester applies to Look up's "Automatic").
export const LAUNCH_STORE_KEYS = ['launchKey', 'launchKeyOk', 'lastAutoSend', 'pendingLaunch', 'draft', 'quick', 'launchRole'];
export const QUICK_DEFAULTS = Object.freeze({ listen: false, send: true, linkSend: false });

export const NOTES = Object.freeze({
  link: 'From a link — check it before sending.',
  // Not "Shared to Atelier": any site can make the same POST to /share as the share sheet (sw.js), so the label
  // claims no more than it can know.
  shared: 'From another app or site — check it before sending.',
  ready: 'Ready when you are — tap Send.',
  tapMic: 'Tap the mic to talk.',
  listening: 'Listening — speak, then pause.',
  sending: 'Sending…',
  held: 'Held — edit, then tap Send.',
  typeIos: 'Tap the box, then the keyboard’s mic to talk.',
  typeOther: 'Voice isn’t available in this browser — type instead.',
  shareExpired: 'That share expired — share it again.',
  // No video size here: the 1 GB cap (SHARE_LIMITS) is untested on phones, where the share is parsed in memory first.
  shareDropped: 'Skipped some files — a share brings in up to 4 photos (25 MB each) or one video. Attach others with the paperclip.',
  linkCopied: 'Link copied — paste it into the Shortcut.',
  copyBelow: 'Copy the link below, then paste it into the Shortcut.',
  newLink: 'New link copied — paste it into your Shortcut. Old links only fill the box now.',
  newLinkManual: 'New link made — copy it below and paste it into your Shortcut. Old links only fill the box now.',
  confirmTitle: 'Send from your Shortcut without a tap?',
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
export const SHARE_NOTES = Object.freeze({
  failed: 'That share didn’t come through — try sharing it again.',
  lost: 'Atelier was still starting up — share that again.',
  big: 'Too large to share in — attach it with the paperclip instead.',
});
export const MIC_BLOCKED = Object.freeze({
  android: 'The mic is off for Atelier. Touch and hold the Atelier icon → Site settings → Microphone → Allow. If it’s still off: Android Settings → Apps → Chrome → Permissions → Microphone.',
  ios: 'The mic is off for this site. In Safari: aA → Website Settings → Microphone → Allow (in the Home Screen app, allow it when asked), then tap the mic again.',
  desktop: 'The mic is blocked for this site.',
});

// ───────────────────────── text helpers ─────────────────────────
// A link or share must not hide or reorder what it prefills: the user checks that text before sending, and a model reads
// characters the screen doesn't show. cleanText removes:
// - C0/C1 controls (except tab and newline) and every format character (\p{Cf}): bidi controls, zero-width characters,
//   the soft hyphen, word joiner, BOM and the TAG block that "ASCII smuggling" hides whole sentences in;
// - variation selectors (bytes can be smuggled behind one emoji), the CGJ, Hangul fillers and other invisible letters.
// It keeps what real text needs: a lone ZWJ inside an emoji sequence, a lone ZWJ/ZWNJ between two letters of a script
// that uses them (Persian, Hindi…), one VS16 after an emoji, and the RGI England/Scotland/Wales flags.
// Padding can't push text below the fold of the composer either: whitespace-only lines become blank, blank lines collapse
// to one, and a run of blanks wider than 32 columns becomes one space (ASCII indentation up to that stays, for code).
const RGI_TAG_FLAG = '\u{1F3F4}\u{E0067}\u{E0062}(?:\u{E0065}\u{E006E}\u{E0067}|\u{E0073}\u{E0063}\u{E0074}|\u{E0077}\u{E006C}\u{E0073})\u{E007F}';
const HIDDEN = new RegExp(`(${RGI_TAG_FLAG})|[\\p{Cf}\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u034F\\u115F\\u1160\\u17B4\\u17B5\\u180B-\\u180F\\u3164\\uFFA0\\uFE00-\\uFE0F\\u{E0100}-\\u{E01EF}]`, 'gu');
const PICT = /\p{Extended_Pictographic}/u, EMOJI = /\p{Emoji}/u, SKIN = /\p{Emoji_Modifier}/u;
const scriptLetter = (c) => /[\p{L}\p{M}]/u.test(c) && !/[\p{Script=Latin}\p{Script=Common}]/u.test(c);
const cpBefore = (s, i) => (i <= 0 ? '' : i >= 2 && /[\uDC00-\uDFFF]/.test(s[i - 1]) && /[\uD800-\uDBFF]/.test(s[i - 2]) ? s.slice(i - 2, i) : s[i - 1]);
const cpAt = (s, i) => (i < s.length ? String.fromCodePoint(s.codePointAt(i)) : '');
function keepInvisible(ch, prev, next) {
  if (ch === '\u{200D}') return ((PICT.test(prev) || SKIN.test(prev) || prev === '\u{FE0F}') && PICT.test(next)) || (scriptLetter(prev) && scriptLetter(next));
  if (ch === '\u{200C}') return scriptLetter(prev) && scriptLetter(next);
  if (ch === '\u{FE0F}') return EMOJI.test(prev); // a heart or keycap's VS16; a second one in a row has a VS16 before it, so it goes
  return false;
}
const BLANKS = /[ \t\u{A0}\u{1680}\u{2000}-\u{200A}\u{202F}\u{205F}\u{3000}\u{2800}]{5,}/gu;
const blankWidth = (m) => [...m].reduce((w, c) => w + (c === '\t' ? 8 : 1), 0);
export function cleanText(s) {
  return String(s ?? '')
    .replace(/\r\n?|[\u{85}\u{2028}\u{2029}]/gu, '\n')
    .replace(HIDDEN, (m, flag, i, all) => (flag || keepInvisible(m, cpBefore(all, i), cpAt(all, i + m.length)) ? m : ''))
    .replace(BLANKS, (m) => (blankWidth(m) > 32 ? ' ' : m))
    .replace(/[ \t\u{A0}\u{1680}\u{2000}-\u{200A}\u{202F}\u{205F}\u{3000}\u{2800}]+$/gmu, '') // a line of blanks is a blank line
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
// Cut to n UTF-16 units without leaving half a surrogate pair at the end.
export function cap(s, n = MAX_TEXT) {
  const t = String(s ?? '');
  if (t.length <= n) return t;
  const out = t.slice(0, n);
  return /[\uD800-\uDBFF]$/.test(out) ? out.slice(0, -1) : out;
}
// Decode every run of valid %XX escapes; leave a stray % (or a broken UTF-8 run) exactly as typed. Never throws.
export const decodeLoose = (s) => String(s ?? '').replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) => { try { return decodeURIComponent(m); } catch { return m; } });
// Join shared parts, dropping any part another part already contains (title "Foo" + text "Foo https://x" → one line).
export function joinShared(...parts) {
  const out = [];
  for (const p of parts.map(cleanText).filter(Boolean)) {
    if (out.some((o) => o.includes(p))) continue;
    for (let i = out.length - 1; i >= 0; i--) if (p.includes(out[i])) out.splice(i, 1);
    out.push(p);
  }
  return out.join('\n');
}
// Prefill below what's already in the composer, after a blank line.
export const joinDraft = (a, b) => (String(a ?? '').trim() ? String(a).trimEnd() + '\n\n' + b : b);

// ───────────────────────── URL → intent ─────────────────────────
// The fragment is "a=1&b=2&q=<rest>": q is always last and takes the rest verbatim, so dictated &, = and + survive.
export function splitHash(hash = '') {
  const h = String(hash ?? '').replace(/^#/, ''), m = /(?:^|&)q=/.exec(h);
  return { params: new URLSearchParams(m ? h.slice(0, m.index) : h), q: m ? decodeLoose(h.slice(m.index + m[0].length)) : null };
}
const shareOf = (s) => (SHARE_STATUS.includes(s) ? s : SHARE_ID.test(s ?? '') ? s : null);
// readLaunch(search, hash) → the raw intent. No context, no side effects; `send`/`k` are read from the fragment only
// (never sent to the server, never in Referer or Worker logs; the browser's History, and History sync, does keep the
// whole link: docs/quick-launch.md). The key itself never leaves this object.
export function readLaunch(search = '', hash = '') {
  const s = String(search ?? ''), hs = String(hash ?? '');
  const q = new URLSearchParams(s), { params: h, q: hq } = splitHash(hs);
  const start = h.get('start') ?? q.get('start');
  const voice = start === 'voice';
  const named = [start, q.get('mode')].find((m) => LAUNCH_MODES.includes(m)) ?? null; // legacy ?mode= still works
  const fromLink = cap(cleanText(hq ?? q.get('q') ?? ''));
  // Legacy GET share target at '/' (WebAPKs Chrome hasn't regenerated yet). Anyone can write that URL, so it is labelled
  // "From a link" like q. A POST share (?share=<id>, stored by the device's service worker) is labelled "From another app
  // or site": any page can auto-submit the same multipart form to /share, so neither label vouches for where it came from.
  const shared = joinShared(q.get('title'), q.get('text'), q.get('url'));
  const text = cap(joinShared(fromLink, shared));
  return {
    voice,
    mode: voice ? 'ask' : named,
    text,
    from: text ? 'link' : null,
    send: h.get('send') === '1',
    key: cap(h.get('k') ?? '', 64),
    share: shareOf(q.get('share')),
    source: q.get('source') ?? '',
    via: q.get('via') ?? '', // 'assist' from Atelier Assist (android/): only a label, and only with this browser's own key (planLaunch)
    review: false,
    replay: false,
    any: s.length > 1 || hs.length > 1,
  };
}
// True when the URL carried anything: boot replaces it with '/' so a reload never listens or sends twice.
export const needsCleanup = (loc = {}) => String(loc.search ?? '').length > 1 || String(loc.hash ?? '').length > 1;
export function cleanLaunchUrl(loc, hist) {
  if (!needsCleanup(loc)) return false;
  try { hist.replaceState(null, '', '/'); return true; } catch { return false; }
}

// ───────────────────────── storage helpers ─────────────────────────
// `store` is app.js's LS ({ get(k, d), set(k, v), del(k) }); del falls back to writing null.
const del = (store, k) => (typeof store.del === 'function' ? store.del(k) : store.set(k, null));
const str = (v) => (typeof v === 'string' ? v : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
export function quickPrefs(store) {
  const p = store?.get?.('quick', null);
  const o = p && typeof p === 'object' ? p : {};
  return { listen: typeof o.listen === 'boolean' ? o.listen : QUICK_DEFAULTS.listen, send: typeof o.send === 'boolean' ? o.send : QUICK_DEFAULTS.send, linkSend: typeof o.linkSend === 'boolean' ? o.linkSend : QUICK_DEFAULTS.linkSend };
}

// ───────────────────────── launch key (iPhone "Send without a tap") ─────────────────────────
export function makeLaunchKey(rand = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  const bytes = rand(KEY_LEN);
  if (!bytes || bytes.length < KEY_LEN) throw new Error('no randomness');
  return Array.from(bytes.slice(0, KEY_LEN), (b) => B64U[b & 63]).join(''); // 256 % 64 === 0: unbiased
}
// Length-independent compare of two well-formed keys; a short or malformed stored key never validates.
export function keyOk(given, mine) {
  if (typeof given !== 'string' || typeof mine !== 'string' || !KEY_RE.test(mine) || given.length !== mine.length) return false;
  let d = 0;
  for (let i = 0; i < mine.length; i++) d |= given.charCodeAt(i) ^ mine.charCodeAt(i);
  return d === 0;
}
// An Allow is kept as CONFIRM_SCOPE + key. 'v2:' = keyed sends in any of the six modes (v57). A bare key was allowed
// under the Ask-only dialog (v55/v56): it doesn't count, so the first keyed send after the update asks again.
export const CONFIRM_SCOPE = 'v2:';
const confirmedKey = (v) => { const s = str(v); return s.startsWith(CONFIRM_SCOPE) ? s.slice(CONFIRM_SCOPE.length) : ''; };
export function keyState(store) {
  return { mine: str(store.get('launchKey', '')), role: str(store.get('launchRole', '')), confirmed: confirmedKey(store.get('launchKeyOk', '')), lastAutoAt: num(store.get('lastAutoSend', 0)) };
}
// Within 15 s either side of the last keyed send (a clock set back can't unlock a burst; a far-future stamp can't lock forever).
export const rateLimited = (lastAutoAt, now) => lastAutoAt > 0 && Math.abs(now - lastAutoAt) < RATE_MS;
// Settings → Quick launch → Copy Shortcut link (On): reuse this role's key, or make one.
export function ensureLaunchKey(store, role, rand) {
  if (!role) return '';
  const s = keyState(store);
  return KEY_RE.test(s.mine) && s.role === role ? s.mine : rotateLaunchKey(store, role, rand);
}
// "New link": a fresh key; old Shortcuts only prefill from now on, and the new key needs its own first-use confirm.
export function rotateLaunchKey(store, role, rand) {
  if (!role) return '';
  const k = makeLaunchKey(rand);
  store.set('launchKey', k); store.set('launchRole', role); del(store, 'launchKeyOk');
  return k;
}
export function forgetLaunchKey(store) { for (const k of ['launchKey', 'launchKeyOk', 'lastAutoSend']) del(store, k); }
// Everything this feature keeps on the device (sign-out, role switch, Clear this device).
export function forgetLaunch(store) { for (const k of LAUNCH_STORE_KEYS) if (k !== 'launchRole') del(store, k); }
// The first-use dialog said Allow: remember it for this exact key, and start the 15 s window.
export function confirmLaunchKey(store, now) {
  const { mine } = keyState(store);
  if (!KEY_RE.test(mine)) return false;
  store.set('launchKeyOk', CONFIRM_SCOPE + mine); store.set('lastAutoSend', now);
  return true;
}
export const noteAutoSend = (store, now) => store.set('lastAutoSend', now);
// 'owner' | 'tester:<sub>' | '' (signed out). The owner passcode always wins on a device.
export const roleOf = ({ passcode, tester } = {}) => (passcode ? 'owner' : tester?.sub ? `tester:${tester.sub}` : '');
// Call from app.js syncRole() (it runs on every sign-in, sign-out and owner/tester switch).
// signed out → signed in keeps the stashed launch and draft (that's the sign-in round trip) but drops any key;
// signed in → signed out, or one role → another, forgets everything. Returns 'same' | 'init' | 'signin' | 'wiped'.
export function syncLaunchRole(store, role) {
  const now = String(role || ''), prev = store.get('launchRole', null);
  if (prev === now) return 'same';
  if (prev == null) { store.set('launchRole', now); return 'init'; }
  if (prev === '') { forgetLaunchKey(store); store.set('launchRole', now); return 'signin'; }
  forgetLaunch(store); store.set('launchRole', now);
  return 'wiped';
}
// The text the iPhone Shortcut appends its URL-encoded dictation to (q must stay last). Without a key, send=1 only asks
// for a review: the words are prefilled and Send pulses (planLaunch 'off' / 'no-key'); only a valid key can send.
export function shortcutLink(origin, key = '') {
  const base = `${String(origin).replace(/\/+$/, '')}/?start=ask#`;
  return key ? `${base}send=1&k=${key}&q=` : `${base}send=1&q=`;
}

// Atelier Assist (android/) pairs with this link once (Settings → Quick launch → Android → Atelier Assist): the app keeps
// only the key and builds its own /?start=<mode>&via=assist#k=<key>&send=1&q=<words> links (q last). Opened anywhere
// else, it is a keyed Ask link with nothing to send.
export const assistLink = (origin, key) => `${String(origin).replace(/\/+$/, '')}/?start=ask&via=assist#send=1&k=${key}&q=`;

// ───────────────────────── pending launch (signed out, LinkedIn round trip) ─────────────────────────
// Never stores the key or the send flag: only {voice, mode, text, from, share, review, at}. 15-minute life, read once.
export function stashLaunch(store, intent, now) {
  const p = {
    voice: Boolean(intent?.voice),
    mode: LAUNCH_MODES.includes(intent?.mode) ? intent.mode : null,
    text: cap(cleanText(intent?.text)),
    from: null,
    share: shareOf(intent?.share),
    review: Boolean(intent?.review || (intent?.send && intent?.text)),
    at: now,
  };
  p.from = p.text ? (intent.from === 'share' ? 'share' : 'link') : null;
  if (!p.voice && !p.text && !p.share) { del(store, 'pendingLaunch'); return null; }
  store.set('pendingLaunch', p);
  return p;
}
export function peekPendingLaunch(store, now) {
  const p = store.get('pendingLaunch', null);
  if (!p || typeof p !== 'object' || typeof p.at !== 'number' || now - p.at < 0 || now - p.at >= PENDING_TTL) return null;
  const text = cap(cleanText(str(p.text)));
  return {
    voice: p.voice === true, mode: LAUNCH_MODES.includes(p.mode) ? p.mode : null, text, from: text ? (p.from === 'share' ? 'share' : 'link') : null,
    send: false, key: '', share: shareOf(p.share), source: '', via: '', review: p.review === true && Boolean(text), replay: true, any: false,
  };
}
export function takePendingLaunch(store, now) {
  const p = peekPendingLaunch(store, now);
  del(store, 'pendingLaunch');
  return p;
}

// ───────────────────────── composer draft (survives Android's force-reload on a shortcut/share launch) ─────────────────────────
// localStorage 'draft' = { t, at, src? }. src ('link' | 'share') says the "From a link / Shared" note was still showing
// when it was saved (some of the text isn't the user's), so the restore shows the note again.
const SRC = ['link', 'share'];
export function saveDraft(store, text, now, src = '') {
  const t = String(text ?? '');
  if (!t.trim()) { del(store, 'draft'); return false; }
  store.set('draft', SRC.includes(src) ? { t: cap(t, 20000), at: now, src } : { t: cap(t, 20000), at: now });
  return true;
}
// Once at boot, into an empty composer only; the entry is deleted either way. → { text, src } (text '' when none).
export function takeDraft(store, now) {
  const d = store.get('draft', null);
  del(store, 'draft');
  const ok = d && typeof d.t === 'string' && typeof d.at === 'number' && now - d.at >= 0 && now - d.at < DRAFT_TTL;
  return ok ? { text: d.t, src: SRC.includes(d.src) ? d.src : '' } : { text: '', src: '' };
}
// The draft's lifecycle; app.js wires the events. Only a composer the user typed or dictated into (any 'input' event)
// is kept, so an untouched link or share prefill never comes back later (unlabelled, or piled onto the next iPhone
// Shortcut run's text). sent() after a send, reset() on sign-out or a role switch, stop() for Clear this device (the
// page is about to reload: nothing may write the draft back on pagehide).
//   text() → the composer text     source() → 'link' | 'share' | '' (the note showing now)
export function draftKeeper({ store, now = () => Date.now(), text = () => '', source = () => '' } = {}) {
  let edited = false, off = false;
  return {
    get edited() { return edited; },
    edit() { if (!off) edited = true; }, // typing, dictation, a chip: the composer now holds the user's words
    restored() { if (!off) edited = true; }, // a draft put back at boot was the user's when it was saved
    keep() { return !off && edited ? saveDraft(store, text(), now(), source()) : false; },
    sent() { edited = false; del(store, 'draft'); },
    reset() { edited = false; del(store, 'draft'); },
    stop() { off = true; edited = false; del(store, 'draft'); },
  };
}

// ───────────────────────── intent + context → plan ─────────────────────────
// ctx: { signedIn, role, standalone, sr (dictation is available here: Web Speech or dictate.js's recorder),
//   needsTap (this device's dictation can only start from a tap), perm ('granted'|'prompt'|'denied'), replay,
//   dialogOpen, online, busy, visible, ios, now, composer (current #input text), attachments (count incl. video),
//   prefs (quickPrefs), keys (keyState) or store (to read both) }.
// plan: { mode, prefill, share, send: 'none'|'review'|'confirm'|'send', sendWhy, voice: 'start'|'arm'|null, voiceWhy,
//   autoSend, stash, replay, clean, key: { present, valid, confirmed, limited }, via ('assist': a keyed Atelier Assist
//   link, labelled as such; else ''), intent (key-free) }.
export function planLaunch(intent, ctx = {}) {
  const c = { signedIn: false, role: '', standalone: false, sr: false, perm: 'prompt', replay: false, dialogOpen: false, online: true,
    busy: false, visible: true, ios: false, now: Date.now(), composer: '', attachments: 0, ...ctx };
  const prefs = c.prefs || (c.store ? quickPrefs(c.store) : { ...QUICK_DEFAULTS });
  const keys = c.keys || (c.store ? keyState(c.store) : { mine: '', role: '', confirmed: '', lastAutoAt: 0 });
  const replay = Boolean(c.replay || intent.replay);
  const text = cap(cleanText(intent.text));
  const composer = String(c.composer ?? '').trim();
  const emptyComposer = !composer && !c.attachments;
  const otherDraft = Boolean(c.attachments) || (Boolean(composer) && composer !== text); // something besides the link text
  const valid = Boolean(intent.key) && keyOk(intent.key, keys.mine) && Boolean(c.role) && keys.role === c.role;
  const key = { present: Boolean(intent.key), valid, confirmed: valid && keys.confirmed === keys.mine, limited: rateLimited(keys.lastAutoAt, c.now) };
  // via=assist is a label anyone can write: it counts (the note, the entry's label) only with this browser's own key.
  const assisted = valid && intent.via === 'assist';
  const share = intent.share ? (SHARE_STATUS.includes(intent.share) ? { status: intent.share } : SHARE_ID.test(intent.share) ? { id: intent.share } : null) : null;
  const plan = {
    mode: intent.mode || null,
    // own: the text came with this browser's own key (the owner's paired Atelier Assist or keyed Shortcut), so it counts as
    // the owner's own words (owner decision 2026-10-02): it may use the accounts agent. A share or an unkeyed link never does.
    prefill: text ? { text, from: intent.from === 'share' ? 'share' : 'link', label: intent.from === 'share' ? NOTES.shared : assisted ? NOTES.assist : NOTES.link, own: valid && intent.from !== 'share' } : null,
    share, send: 'none', sendWhy: '', voice: null, voiceWhy: null, autoSend: false, stash: false, replay, clean: Boolean(intent.any), key,
    via: assisted ? 'assist' : '',
    // Key-free copy for stashLaunch: a requested send survives only as "review" (pulse Send), never as a send.
    intent: { voice: Boolean(intent.voice), mode: intent.mode || null, text, from: text ? (intent.from === 'share' ? 'share' : 'link') : null, share: intent.share || null, source: intent.source || '', review: Boolean(intent.review || (intent.send && text)) },
  };

  // Keyed send: every gate must pass; anything else only prefills (and pulses Send). In the link's own mode (start=,
  // any of the six); never a voice start, and never a "/video …" prefix in the text (app.js sends launches with
  // extra.launch, which skips that prefix and the multi-task split, so the mode is always the link's). Video holds
  // longer and shows its price (HOLD_MS.video, app.js holdNote).
  const why = !intent.send && !intent.review ? 'no-send' : !text ? 'no-text' : replay ? 'replay' : !c.signedIn ? 'signed-out'
    : !prefs.linkSend ? 'off' : !intent.key ? 'no-key' : !valid ? 'bad-key'
    : intent.voice || /^\s*\//.test(text) ? 'mode'
    : share ? 'share' : otherDraft ? 'draft' : !c.online ? 'offline' : c.busy ? 'busy' : c.dialogOpen ? 'dialog' : !c.visible ? 'hidden'
    : key.limited ? 'rate' : '';
  plan.sendWhy = why || (key.confirmed ? 'ok' : 'unconfirmed');
  plan.send = why === 'no-send' || why === 'no-text' ? 'none' : why ? 'review' : key.confirmed ? 'send' : 'confirm';
  if (plan.send === 'send' || plan.send === 'confirm') plan.mode = intent.mode || 'ask'; // the link's own mode

  // Signed out: keep the launch for after sign-in (owner passcode, or the LinkedIn round trip). Never twice.
  if (!c.signedIn) {
    plan.stash = !replay && Boolean(intent.voice || text || share);
    if (intent.voice) plan.voiceWhy = 'signed-out';
    return plan;
  }

  if (intent.voice) {
    if (!c.sr) plan.voiceWhy = 'unsupported';
    else if (replay) { plan.voice = 'arm'; plan.voiceWhy = 'replay'; }
    else if (!c.standalone) { plan.voice = 'arm'; plan.voiceWhy = 'tab'; } // a browser tab never opens the mic by itself
    else if (c.ios || c.needsTap) { plan.voice = 'arm'; plan.voiceWhy = 'gesture'; } // iOS (and a recorder that needs a tap) can't start unasked
    else if (!c.visible) { plan.voice = 'arm'; plan.voiceWhy = 'hidden'; } // booted in the background: never listen at a later unlock
    else if (c.dialogOpen) { plan.voice = 'arm'; plan.voiceWhy = 'dialog'; }
    else if (c.perm === 'denied') { plan.voice = 'arm'; plan.voiceWhy = 'blocked'; }
    else {
      plan.voice = 'start'; plan.voiceWhy = 'talk';
      // Auto-send only your own words into an empty composer: a q= prefill, a share or a restored draft means Review.
      plan.autoSend = prefs.send && !text && !share && emptyComposer && plan.send === 'none';
    }
  } else if (intent.source === 'pwa' && prefs.listen && !replay && !text && !share && !c.ios && !c.needsTap && c.standalone && c.sr && c.perm !== 'denied'
    && c.visible && !c.dialogOpen && c.online && !c.busy && plan.send === 'none') {
    plan.voice = 'start'; plan.voiceWhy = 'open'; // "Start listening when I open Atelier": cold start only, never sends
  }
  return plan;
}
// The signature the integration notes use: parseLaunch(location, ctx) → plan.
export const parseLaunch = (loc, ctx = {}) => planLaunch(readLaunch(loc?.search, loc?.hash), ctx);

// ───────────────────────── Cache Storage share intake (written by sw.js) ─────────────────────────
async function readMeta(cache, id) {
  const r = await cache.match(`/__share/${id}/meta`);
  if (!r) return null;
  const m = await r.json().catch(() => null);
  return m && typeof m === 'object' && m.id === id ? m : null;
}
const freshMeta = (m, now) => typeof m?.at === 'number' && Math.abs(now - m.at) < SHARE_TTL;
// 'image' | 'video' | '' — the same test as sw.js (and video.js isVideoFile: a typeless file goes by its extension).
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|3gp|3g2|avi|mpe?g|ogv|wmv)$/i;
export const shareKind = (type, name = '') => (/^image\//i.test(type || '') ? 'image' : /^video\//i.test(type || '') || (!type && VIDEO_EXT.test(name)) ? 'video' : '');
// Take the pending share: text and Files, then delete the bucket whatever happened. Only what one message can carry is
// rebuilt (SHARE_LIMITS: one video, or up to 4 photos), whatever the stored meta says; the rest is added to `dropped`.
// → { ok: true, text, files: File[], dropped } | { ok: false, reason: 'expired' | 'unavailable' }
export async function takeShare(id, { caches, now = Date.now(), File: FileCtor = globalThis.File, limits = SHARE_LIMITS } = {}) {
  if (!caches || typeof FileCtor !== 'function') return { ok: false, reason: 'unavailable' };
  let out = { ok: false, reason: 'expired' };
  try {
    if (SHARE_ID.test(id ?? '') && await caches.has(SHARE_CACHE)) {
      const cache = await caches.open(SHARE_CACHE);
      const meta = await readMeta(cache, id);
      if (meta && freshMeta(meta, now)) {
        const files = [], list = Array.isArray(meta.files) ? meta.files : [];
        let skipped = Math.max(0, list.length - limits.images), video = false;
        for (const f of list.slice(0, limits.images)) {
          const r = Number.isInteger(f?.i) && f.i >= 0 && f.i < limits.images ? await cache.match(`/__share/${id}/${f.i}`) : null;
          if (!r) { skipped++; continue; }
          const hdr = r.headers.get('content-type') || '';
          const type = cap(str(f.type) || (hdr === 'application/octet-stream' ? '' : hdr), 100), name = cap(str(f.name), 120) || `shared-${f.i + 1}`;
          const kind = shareKind(type, name);
          // One video on its own, or photos only: the first kind wins, as in app.js addFiles.
          if (!kind || video || (kind === 'video' && files.length)) { skipped++; continue; }
          const blob = await r.blob();
          if (blob.size > (kind === 'video' ? limits.videoBytes : limits.imageBytes)) { skipped++; continue; }
          files.push(new FileCtor([blob], name, { type }));
          video = kind === 'video';
        }
        const text = cap(joinShared(meta.title, meta.text, meta.url));
        const dropped = Math.max(0, Math.floor(num(meta.dropped))) + skipped;
        if (text || files.length) out = { ok: true, text, files, dropped };
        else if (dropped) out = { ok: true, text: '', files: [], dropped };
      }
    }
  } catch { out = { ok: false, reason: 'expired' }; }
  try { await caches.delete(SHARE_CACHE); } catch {}
  return out;
}
// Boot: delete a leftover share unless this launch, or a fresh pending launch, still refers to it (and it's < 30 min).
export async function sweepShare({ caches, keep = [], now = Date.now() } = {}) {
  if (!caches) return false;
  try {
    if (!(await caches.has(SHARE_CACHE))) return false;
    const ids = keep.filter((k) => SHARE_ID.test(k ?? ''));
    if (ids.length) {
      const cache = await caches.open(SHARE_CACHE);
      for (const id of ids) if (freshMeta(await readMeta(cache, id), now)) return false;
    }
    await caches.delete(SHARE_CACHE);
    return true;
  } catch { return false; }
}

// ───────────────────────── small runtime helpers ─────────────────────────
export function detectPlatform(nav = globalThis.navigator || {}) {
  const ua = String(nav.userAgent || '');
  if (/iPhone|iPad|iPod/.test(ua) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1)) return 'ios';
  return /Android/i.test(ua) ? 'android' : 'desktop';
}
export function isStandalone(win = globalThis) {
  try { return Boolean(win.matchMedia?.('(display-mode: standalone), (display-mode: window-controls-overlay), (display-mode: fullscreen)').matches) || win.navigator?.standalone === true; } catch { return false; }
}
export async function micPermission(nav = globalThis.navigator) {
  try { return (await nav.permissions.query({ name: 'microphone' })).state; } catch { return 'prompt'; }
}
// → Promise<boolean>: true now when the page is visible, else on the next visibilitychange to visible (Android aborts
// recognition in a hidden page); false once `ms` (> 0) passes first. Without ms it waits as long as it takes.
export function whenVisible(doc = globalThis.document, { ms = 0, timers = globalThis } = {}) {
  if (!doc || doc.visibilityState === 'visible' || doc.visibilityState == null) return Promise.resolve(true);
  return new Promise((res) => {
    let t = null;
    const done = (shown) => { doc.removeEventListener('visibilitychange', on); if (t != null) timers.clearTimeout(t); res(shown); };
    const on = () => { if (doc.visibilityState === 'visible') done(true); };
    doc.addEventListener('visibilitychange', on);
    if (ms > 0) t = timers.setTimeout(() => done(false), ms);
  });
}
// The send hold: fires after ms unless cancelled; fire() is "tap Send during the hold" (sends at once).
export function createHold({ ms, onFire, onCancel, timers = globalThis } = {}) {
  let state = 'holding';
  const t = timers.setTimeout(() => { if (state === 'holding') { state = 'fired'; onFire?.(); } }, ms);
  const end = (next, cb, arg) => { if (state !== 'holding') return false; state = next; timers.clearTimeout(t); cb?.(arg); return true; };
  return { get state() { return state; }, ms, cancel: (why = 'cancel') => end('cancelled', onCancel, why), fire: () => end('fired', onFire) };
}

// ───────────────────────── plan → UI (app.js adapter) ─────────────────────────
// sendWhy values that come after every key check in planLaunch: a verified keyed link that some other gate held back.
const KEYED_HOLD = ['mode', 'share', 'draft', 'offline', 'busy', 'dialog', 'hidden', 'rate'];
// deps (all optional except the ones a plan needs):
//   store            LS ({ get, set, del })               now()            → ms (default Date.now)
//   setMode(mode)                                          getText() / setText(text)   the #input value (setText autosizes)
//   showSource(label)  the "From a link / Shared" note     toast(msg, { error, silent })  silent: shown but kept out of
//                      the live region, for anything said while the mic is open
//   armSend() / armMic({ why, autoSend: false })  the pulsing ring (dictate.js: a one-shot "Tap to talk")
//   micHint(kind)    'blocked' → the platform's mic settings path (dictate.js has its own MIC_HELP copy)
//   holdThenSend({ ms, mode, via })  visible, cancellable hold, then submit() in that mode (via 'assist': labelled)
//   confirmLinkSend({ via, mode })  → Promise<boolean>  the first-use dialog (Allow → true; Atelier Assist's own wording;
//     it names the mode this send goes to, and Video's length and price)
//   startVoice({ autoSend, auto: true }) → boolean | Promise<boolean>  the dictation starter (public/dictate.js via app.js);
//                      autoSend=false means "listen, then pulse Send"; true means "hold-then-send if the composer was empty"
//   composerEmpty()  → boolean (text, photos and video)    dialogOpen() → boolean
//   whenVisible(ms)  → Promise<boolean> (false: still hidden after ms)        caches, File     for share intake
//   addFiles(files, { from: 'share' })                     focusInput()     desktop: focus #input for a plain mode launch
//   platform         'ios' | 'android' | 'desktop'
// Returns the list of steps it took (for tests and debugging).
export async function applyLaunch(plan, deps = {}) {
  const d = { now: () => Date.now(), platform: 'desktop', ...deps };
  const did = [];
  const call = (name, ...args) => (typeof d[name] === 'function' ? d[name](...args) : undefined);
  const prefill = (p) => {
    const cur = String(call('getText') ?? '');
    if (!cur.includes(p.text)) call('setText', joinDraft(cur, p.text));
    call('showSource', p.label, { own: Boolean(p.own) });
    did.push(`prefill:${p.from}`);
  };

  if (plan.mode) { call('setMode', plan.mode); did.push(`mode:${plan.mode}`); }
  if (plan.prefill) prefill(plan.prefill);
  if (plan.stash) { if (d.store) stashLaunch(d.store, plan.intent, d.now()); did.push('stash'); return did; }

  if (plan.share?.status) { call('toast', SHARE_NOTES[plan.share.status], { error: plan.share.status === 'failed' }); did.push(`share:${plan.share.status}`); }
  else if (plan.share?.id) {
    const got = await takeShare(plan.share.id, { caches: d.caches, now: d.now(), File: d.File || globalThis.File });
    if (!got.ok) { call('toast', NOTES.shareExpired); did.push('share:expired'); }
    else {
      if (got.text) prefill({ text: got.text, from: 'share', label: NOTES.shared });
      if (got.files.length) { await call('addFiles', got.files, { from: 'share' }); did.push(`files:${got.files.length}`); }
      if (got.dropped) call('toast', NOTES.shareDropped);
      did.push('share:taken');
    }
  }

  if (plan.send === 'send') {
    if (d.store) noteAutoSend(d.store, d.now());
    call('holdThenSend', { ms: holdMs(plan.mode), mode: plan.mode, via: plan.via || '' }); did.push('hold');
    return did;
  }
  if (plan.send === 'confirm') {
    const before = d.store ? keyState(d.store).mine : '';
    let ok = false;
    try { ok = Boolean(await call('confirmLinkSend', { via: plan.via || '', mode: plan.mode || 'ask' })); } catch {}
    // Allow counts only for the key the link was checked against (a "New link" in another tab voids it).
    if (ok && d.store && keyState(d.store).mine === before && confirmLaunchKey(d.store, d.now())) {
      call('holdThenSend', { ms: holdMs(plan.mode), mode: plan.mode, via: plan.via || '' }); did.push('confirmed', 'hold');
      return did;
    }
    call('armSend'); did.push('declined', 'armSend');
  } else if (plan.send === 'review') {
    // Every link that asked to send pulses Send, but only one that passed the key checks says "Ready when you are":
    // a stranger's link (no key, a wrong key, link send off, a replay) gets the "From a link" note and nothing more.
    call('armSend');
    if (KEYED_HOLD.includes(plan.sendWhy)) call('toast', NOTES.ready);
    did.push('armSend');
  }

  if (plan.voice === 'start') {
    // Only right after the launch: still hidden after VISIBLE_WAIT_MS (power button, app switch), Talk arms the mic and
    // "listen when I open" gives up, rather than opening the mic at some later unlock.
    const shown = await (d.whenVisible ? d.whenVisible(VISIBLE_WAIT_MS) : whenVisible(globalThis.document, { ms: VISIBLE_WAIT_MS }));
    if (shown === false) {
      if (plan.voiceWhy === 'talk') { call('armMic', { why: 'hidden', autoSend: false }); did.push('armMic'); }
      return did;
    }
    if (call('dialogOpen')) { call('armMic', { why: 'dialog', autoSend: false }); did.push('armMic'); return did; }
    const autoSend = Boolean(plan.autoSend) && call('composerEmpty') !== false;
    let started = false;
    try { started = Boolean(await call('startVoice', { autoSend, auto: true })); } catch {}
    // The mic is open now: shown, never announced (a screen reader speaking into it would be transcribed, and sent).
    if (started) { call('toast', NOTES.listening, { silent: true }); did.push(autoSend ? 'listen:send' : 'listen:review'); }
    else if (plan.voiceWhy === 'talk') { call('armMic', { why: 'talk', autoSend: false }); call('toast', NOTES.tapMic); did.push('armMic'); }
    return did;
  }
  if (plan.voice === 'arm') {
    call('armMic', { why: plan.voiceWhy, autoSend: false }); // an armed launch never sends by itself: the tap is plain dictation
    if (plan.voiceWhy === 'blocked') { if (typeof d.micHint === 'function') d.micHint('blocked'); else call('toast', MIC_BLOCKED[d.platform] || MIC_BLOCKED.desktop, { error: true }); }
    else call('toast', NOTES.tapMic);
    did.push('armMic');
    return did;
  }
  if (plan.voiceWhy === 'unsupported') { call('toast', d.platform === 'ios' ? NOTES.typeIos : NOTES.typeOther); did.push('type'); return did; }
  if (plan.mode && !plan.prefill && plan.send === 'none') { call('focusInput'); did.push('focus'); }
  return did;
}
