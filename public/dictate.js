// Dictation: the composer's mic. One controller, two engines:
//   'record': MediaRecorder captures the mic, an AnalyserNode drives the level meter and a voice-activity detector that
//             stops after a pause; the recording goes to POST /api/transcribe (src/transcribe.js). The only engine on an
//             iPhone or iPad, in Safari and in the Home Screen web app alike.
//   'speech': the browser's own recognizer (Web Speech) for live text as you talk. Android and desktop only. On an error
//             that means the recognizer can't work here (service-not-allowed, network while online, no event at all
//             within 8 s of the tap or of answering the mic prompt) the same tap carries on as a recording; not-allowed
//             means the mic is blocked, so that shows how to allow it. Where recording can't run, every tap tries Web
//             Speech again and says why it failed.
// Why iOS never uses Web Speech: in a Home Screen web app WebKit exposes webkitSpeechRecognition but never delivers a
// result (bugs.webkit.org/show_bug.cgi?id=225298, "RESOLVED LATER"), so feature detection passes and nothing is
// transcribed. That was the "mic flaked out on my iPhone" report. getUserMedia and recognition are never run together.
// Pure helpers are node-tested (tests/dictate.test.mjs) and createDictation() is the controller. Nothing here touches the
// DOM at import time: app.js wires #micBtn. start() must run straight from the tap (no await before it): iOS only shows
// the mic prompt, and only lets an AudioContext run, inside a user gesture. startFromGesture() arms a "Tap to talk"
// target for quick launch, where the mic can't open by itself.

// ── limits and wording ──
export const DICTATE_LIMITS = Object.freeze({
  maxMs: 120_000, // longest recording; the server takes up to 180 s / 10 MB
  warnMs: 10_000, // onLevel reports leftMs: the UI may count down the last 10 s
  maxBytes: 10 * 1024 * 1024, // src/transcribe.js cap: a bigger recording isn't sent
  minBytes: 256, // a container header and a moment of sound; less is an empty recording
  timesliceMs: 1_000, // MediaRecorder chunk interval: Safari can lose the tail of an MP4 recorded without one
  bitrate: 64_000, // AAC / Opus for speech; 120 s is about 1 MB
  tickMs: 50, // level meter and VAD poll
  stopWaitMs: 2_000, // longest wait for the recorder's 'stop' after stop()
  speechWatchMs: 8_000, // Web Speech: no event at all this long after start() (or after the mic prompt) → record instead
  speechPromptMs: 30_000, // Web Speech: longest wait on the browser's mic prompt before the watch above starts anyway
  speechQuietMs: 3_000, // Web Speech: no new result this long → end it ourselves (Safari may never end by itself)
  speechNoResultMs: 12_000, // Web Speech: running, but no result this long → end it
  speechEndWaitMs: 1_500, // longest wait for recognition's 'end' (it must let go of the mic before getUserMedia)
  speechNetHoldMs: 300_000, // Web Speech 'network' while online: record instead for this long, then try it again
  uploadMs: 90_000, // the whole upload, retries included
  netRetryMs: 1_200, // one retry this long after a dropped connection
  busyRetryMaxS: 5, // a 429 asking for a longer wait than this isn't retried automatically
  errorMs: 4_000, // 'error' shows this long, then 'idle'
  cancelTapMs: 4_000, // while transcribing: a second tap this soon after the first cancels
});
/**
 * The voice-activity detector (RMS against the room's noise floor). Recording stops after silenceMs of quiet once armMs
 * of speech has been heard. Before that, a pause never stops it (an "um" or a cough, then thinking, is not the end):
 * shorter speech stops only after noSpeechMs of quiet, and no speech at all gives up after noSpeechMs. An automatic stop
 * that never heard speech sends nothing.
 * The noise floor is the quietest frame of the last floorWindowMs (a running minimum), seeded by the first frame: a
 * steady fan, TV or car is learnt within that window, and speaking doesn't raise it (its pauses keep the minimum down).
 */
export const VAD_DEFAULTS = Object.freeze({
  minLevel: 0.012, // RMS that always counts as quiet (about -38 dBFS)
  ratio: 3, // speech is this many times louder than the noise floor
  maxThreshold: 0.08, // a loud room never needs more than this to count as speech
  onsetMs: 150, // this much continuous sound starts speech (a click or a bump doesn't)
  armMs: 1_000, // this much speech arms the silence stop
  silenceMs: 2_500, // quiet this long after armMs of speech → stop
  noSpeechMs: 12_000, // no speech at all this long, or this much quiet after less speech than armMs → stop
  floorWindowMs: 3_000, // the noise floor is the quietest frame of this window
  quietPeak: 0.006, // a tapped-off recording whose loudest moment stayed under this (about -44 dBFS) held nothing
});
/** MediaRecorder types in order of preference. Apple: MP4/AAC (WebKit's native path; WebM/Opus only since 18.4). */
export const RECORDER_TYPES_APPLE = Object.freeze(['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']);
/** Everyone else: WebM/Opus first (Chrome's MP4 recorder may put Opus in MP4, which OpenAI doesn't list). */
export const RECORDER_TYPES = Object.freeze(['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/ogg;codecs=opus']);
export const CONSTRAINTS = Object.freeze({ echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 });
export const STATES = Object.freeze(['idle', 'listening', 'recording', 'transcribing', 'error']);
const MIME = Object.freeze({ webm: 'audio/webm', mp4: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', mp3: 'audio/mpeg' });

export const SAY = Object.freeze({
  noSpeech: 'I didn’t hear anything. Tap the mic and speak.',
  noWords: 'I couldn’t make out any words. Try again, a little closer to the mic.',
  offline: 'You’re offline. Dictation needs a connection.',
  network: 'Couldn’t reach Atelier to transcribe that. Check your connection, then try again.',
  slow: 'Transcribing took too long. Try again, or try a shorter recording.',
  busy: 'Dictation is busy right now. Try again in a moment.',
  tooLong: 'That recording is too long to transcribe. Try a shorter one.',
  format: 'This browser recorded audio Atelier can’t read. Try again, or use the keyboard’s mic.',
  formatDesktop: 'This browser recorded audio Atelier can’t read. Try again, or try another browser.',
  unreadable: 'Couldn’t make out that recording. Try again.',
  short: 'That was too short to transcribe. Tap the mic, speak, then pause.',
  down: 'Dictation isn’t available right now. Try again later, or use the keyboard’s mic.',
  downDesktop: 'Dictation isn’t available right now. Try again later.',
  off: 'Dictation isn’t available on this account.',
  passcode: 'Add your passcode in Settings to use dictation.',
  signin: 'Sign in again to use dictation.',
  unsupported: 'Dictation isn’t available in this browser.',
  unsupportedIos: 'Dictation isn’t available here. Tap the text box, then the keyboard’s mic.',
  noMic: 'No microphone was found.',
  micBusy: 'The microphone is busy (a call or another app?). Try again when it’s free.',
  recorder: 'This browser can’t record audio for dictation.',
  // Not a toast: a screen reader would speak it into the mic that is opening. The 'recording' state's detail.fallback
  // lets the app show it (the mic button's title).
  fallback: 'Live dictation isn’t working here, so Atelier is recording instead.',
  tapToRecord: 'Live dictation isn’t working here. Tap the mic again to record instead.',
  speechNet: 'Dictation needs a connection to the speech service. Try again.',
  speechLang: 'Dictation doesn’t support your language in this browser.',
  stillTranscribing: 'Still transcribing. Tap the mic again to cancel.',
  cancelled: 'Dictation cancelled.',
});
/**
 * How to unblock the microphone, by platform: an installed app ('app') or a browser tab. On iPhone/iPad, Safari's page
 * menu exists only in Safari: other browsers ({app} is their name) and apps' built-in browsers get their own help.
 */
export const MIC_HELP = Object.freeze({
  iosApp: 'Atelier can’t use the microphone. Tap the mic again and choose Allow. If it doesn’t ask: Settings → Apps → Safari → Microphone → Ask, then reopen Atelier.',
  ios: 'Atelier can’t use the microphone. In Safari, open the page menu (aA) → Website Settings → Microphone → Allow, then try again.',
  iosBrowser: 'Atelier can’t use the microphone. Allow it for this site in {app}, or turn it on in Settings → Apps → {app} → Microphone, then try again.',
  iosInApp: 'This app’s built-in browser won’t let Atelier use the microphone. Open Atelier in Safari, then tap the mic.',
  androidApp: 'The mic is off for Atelier. Touch and hold the Atelier icon → Site settings → Microphone → Allow. If it’s still off: Android Settings → Apps → Chrome → Permissions → Microphone.',
  android: 'The mic is off for this site. Tap the icon left of the address → Permissions → Microphone → Allow, then try again.',
  desktop: 'The microphone is blocked for this site. Click the icon left of the address → Microphone → Allow, then try again.',
});

// ── pure helpers ──
// Browsers on iPhone/iPad other than Safari (all WebKit), by their user-agent token, for the microphone help.
const IOS_BROWSERS = [[/\bCriOS\//, 'Chrome'], [/\bEdgiOS\//, 'Edge'], [/\bFxiOS\//, 'Firefox'], [/\b(?:OPiOS|OPT)\//, 'Opera'], [/\bDuckDuckGo\//, 'DuckDuckGo'], [/\bGSA\//, 'Google']];
/**
 * {ios, android, apple, standalone, browser} for this page. iPadOS reports itself as a Mac with touch.
 * browser (iPhone/iPad only, else null): 'safari' (a tab or the Home Screen app), a named browser ('Chrome', 'Edge' …),
 * or 'inapp': an app's built-in browser (LinkedIn, Instagram …), whose user agent has no "Safari/" token.
 */
export function platformOf(nav = {}, matchMedia = null) {
  const ua = String(nav?.userAgent || '');
  const ios = /\b(iPhone|iPad|iPod)\b/.test(ua) || (nav?.platform === 'MacIntel' && Number(nav?.maxTouchPoints) > 1);
  const android = !ios && /Android/i.test(ua);
  let standalone = nav?.standalone === true;
  try { standalone ||= Boolean(matchMedia?.('(display-mode: standalone), (display-mode: fullscreen), (display-mode: minimal-ui), (display-mode: window-controls-overlay)')?.matches); } catch {}
  // WebKit on a Mac too (Safari, not Chrome/Edge/Firefox, which also say "Safari"): its recorder prefers MP4/AAC.
  const apple = ios || (/Mac OS X/.test(ua) && /Version\/[\d.]+.*Safari\//.test(ua) && !/(Chrome|Chromium|CriOS|Edg|Firefox|FxiOS|OPR)\//.test(ua));
  // A Home Screen app's user agent drops "Safari/" too, so standalone is Safari's web app, not an in-app browser.
  const browser = !ios ? null : IOS_BROWSERS.find(([re]) => re.test(ua))?.[1] || (standalone || /\bSafari\//.test(ua) ? 'safari' : 'inapp');
  return { ios, android, apple, standalone, browser };
}

/**
 * Which engine a tap uses: 'speech' | 'record' | null (nothing works here).
 * iPhone/iPad: always 'record' (never Web Speech, see the top of this file). Elsewhere Web Speech first (live text, no
 * server cost); once it has failed on this page (speechBroken) taps record instead, when they can. Where recording
 * can't run (no server: an OpenAI key, the passcode or the tester's dictation feature), Web Speech stays the engine
 * whatever happened: each tap tries it and says why it failed, rather than the mic disappearing.
 */
export function pickEngine({ ios = false, speech = false, recorder = false, server = false, speechBroken = false, prefer = 'auto' } = {}) {
  const canRecord = Boolean(recorder && server);
  if (ios) return canRecord ? 'record' : null;
  if (prefer === 'record' && canRecord) return 'record'; // a setting (or a review) that wants the server's transcription
  if (speech && (!speechBroken || !canRecord)) return 'speech';
  return canRecord ? 'record' : null;
}

/** The first type the browser can record → its mime, or '' (let the browser pick). */
export function pickRecorderType(isTypeSupported, { apple = false } = {}) {
  for (const mime of apple ? RECORDER_TYPES_APPLE : RECORDER_TYPES) {
    let ok = false;
    try { ok = Boolean(isTypeSupported?.(mime)); } catch {}
    if (ok) return mime;
  }
  return '';
}

/** 'audio/webm;codecs=opus' → 'audio/webm'; '' for anything that isn't a content type. */
export const baseType = (v) => {
  const t = String(v ?? '').split(';')[0].trim().toLowerCase();
  return /^[a-z]+\/[\w.+-]+$/.test(t) ? t : '';
};

const tagAt = (b, i, s) => b.length >= i + s.length && [...s].every((c, k) => b[i + k] === c.charCodeAt(0));
/**
 * The container in a recording's first bytes → 'wav' | 'mp4' | 'webm' | 'ogg' | 'flac' | 'mp3' | null: the kinds
 * src/transcribe.js sniffAudio() accepts (a test keeps the two in step). The server reads the bytes, not the label.
 */
export function sniffAudio(b) {
  if (!b || b.length < 12) return null;
  if (tagAt(b, 0, 'RIFF') && tagAt(b, 8, 'WAVE')) return 'wav';
  if (tagAt(b, 4, 'ftyp')) return 'mp4';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm';
  if (tagAt(b, 0, 'OggS')) return 'ogg';
  if (tagAt(b, 0, 'fLaC')) return 'flac';
  if (tagAt(b, 0, 'ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x06) !== 0)) return 'mp3';
  return null;
}
/** The content type to label an upload with: the sniffed container, else the recorder's own type, else octet-stream. */
export const uploadType = (head, recorderType = '') => MIME[sniffAudio(head)] || baseType(recorderType) || 'application/octet-stream';

// Legacy and macro codes some devices report → the code the transcription models know (src/transcribe.js LANG_ALIASES).
const LANG_ALIASES = Object.freeze({ iw: 'he', in: 'id', ji: 'yi', nb: 'no', fil: 'tl' });
const BCP47 = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{1,8})*$/;
/** A BCP 47 tag → its ISO 639-1 code for ?lang= ('en-US' → 'en'), or '' (let the model detect it). */
export function isoLang(tag) {
  const l = String(tag ?? '').trim().toLowerCase().split(/[-_]/)[0];
  const code = LANG_ALIASES[l] || l;
  return /^[a-z]{2}$/.test(code) ? code : '';
}
/** The whole tag for x-dictate-lang ('pt_BR' → 'pt-BR'; the fallback model takes it as a hint), or ''. */
export function langTag(tag) {
  const t = String(tag ?? '').trim();
  return t.length <= 35 && BCP47.test(t) ? t.replace(/_/g, '-') : '';
}
/** A short hint for the transcriber (names, terms) → x-dictate-prompt (percent-encoded, ≤ 300 characters), or ''. */
export function promptHeader(text) {
  const t = [...String(text ?? '').replace(/[\u0000-\u001F\u007F-\u009F<>]/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, 300).join('').trim();
  return t ? encodeURIComponent(t) : '';
}

/** Root mean square of time-domain samples (floats in -1..1, or bytes centred on 128). */
export function rms(buf) {
  if (!buf?.length) return 0;
  const bytes = buf instanceof Uint8Array;
  let sum = 0;
  for (let i = 0; i < buf.length; i++) { const x = bytes ? (buf[i] - 128) / 128 : buf[i]; sum += x * x; }
  return Math.sqrt(sum / buf.length);
}
/** RMS → a 0..1 meter level on a dB scale: -60 dBFS and below → 0, -10 dBFS and above → 1. */
export function meterLevel(r) {
  if (!(r > 0)) return 0;
  return Math.min(1, Math.max(0, (20 * Math.log10(r) + 60) / 50));
}
/** 7_400 → '0:07' (the elapsed clock). */
export function clock(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * A voice-activity detector fed with (rms, ms since the mic opened). push() →
 *   'waiting' (no speech yet) | 'speaking' | 'stop' (speech, then enough quiet) | 'no-speech' (noSpeechMs, nothing).
 * The noise floor is the quietest frame of the last floorWindowMs, so a steady background is learnt and speaking
 * doesn't raise it. heard, speechMs, armed, peak, floor and threshold say what happened.
 */
export function createVad(o = {}) {
  const c = { ...VAD_DEFAULTS, ...o };
  const frames = []; // [ms, rms] within floorWindowMs of the newest
  let t0 = null, last = null, run = 0, lastLoud = null;
  const v = {
    heard: false, armed: false, speechMs: 0, peak: 0, floor: null, threshold: c.minLevel,
    push(level, now) {
      const r = Number(level) > 0 ? Number(level) : 0;
      if (t0 == null) t0 = now;
      const dt = last == null ? 0 : Math.max(0, now - last);
      last = now;
      v.peak = Math.max(v.peak, r);
      frames.push([now, r]);
      while (now - frames[0][0] > c.floorWindowMs) frames.shift();
      v.floor = frames.reduce((m, f) => Math.min(m, f[1]), Infinity);
      v.threshold = Math.min(c.maxThreshold, Math.max(c.minLevel, v.floor * c.ratio));
      const loud = r >= v.threshold;
      run = loud ? run + dt : 0;
      if (loud && (v.heard || run >= c.onsetMs)) {
        v.speechMs += v.heard ? dt : run;
        v.heard = true;
        lastLoud = now;
      }
      v.armed = v.speechMs >= c.armMs;
      if (v.heard) return now - lastLoud >= (v.armed ? c.silenceMs : c.noSpeechMs) ? 'stop' : 'speaking';
      return now - t0 >= c.noSpeechMs ? 'no-speech' : 'waiting';
    },
  };
  return v;
}

// Writing systems with no spaces between words (Chinese, Japanese), plus the CJK punctuation and full-width forms
// around them. Korean (Hangul) spaces its words, so it isn't here.
const NO_SPACE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}・ー　-〿＀-￯]/u;
const CJK_MARK = /[　-〿＀-￯]/; // 、。「」！？ and full-width forms: never a space beside them
const firstChar = (s) => (s ? String.fromCodePoint(s.codePointAt(0)) : '');
const lastChar = (s) => (s ? String.fromCodePoint(s.codePointAt(/[\uDC00-\uDFFF]/.test(s.at(-1)) && s.length > 1 ? s.length - 2 : s.length - 1)) : '');
const joins = (a, b) => NO_SPACE.test(lastChar(a)) && NO_SPACE.test(firstChar(b)); // no space between a and b
/**
 * SpeechRecognitionResultList → one transcript, final and interim pieces alike (so the last interim is kept when a
 * recognizer ends without marking it final). Pieces are usually consecutive, but some recognizers report each new
 * result as the whole transcript so far: a piece that repeats what came before replaces it. No space between two
 * Chinese or Japanese pieces (Korean keeps its word spaces).
 */
export function mergeResults(results) {
  let out = '';
  for (const r of Array.from(results || [])) {
    const t = String(r?.[0]?.transcript ?? '').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    if (out && t.toLowerCase().startsWith(out.toLowerCase())) out = t;
    else out = !out ? t : joins(out, t) ? out + t : `${out} ${t}`;
  }
  return out;
}

/** The microphone help for this platform (on iPhone/iPad, for the browser or app the page is in). */
export function micHelp(plat = {}) {
  if (plat.ios) {
    if (plat.standalone) return MIC_HELP.iosApp;
    if (plat.browser === 'inapp') return MIC_HELP.iosInApp;
    if (plat.browser && plat.browser !== 'safari') return MIC_HELP.iosBrowser.replaceAll('{app}', plat.browser);
    return MIC_HELP.ios;
  }
  return plat.android ? (plat.standalone ? MIC_HELP.androidApp : MIC_HELP.android) : MIC_HELP.desktop;
}
// Desktop has no keyboard mic to point at.
const isDesktop = (plat) => Boolean(plat) && !plat.ios && !plat.android;
const downFor = (plat) => (isDesktop(plat) ? SAY.downDesktop : SAY.down);

/** A getUserMedia / MediaRecorder failure → what to tell the person. */
export function micError(err, plat = {}) {
  switch (err?.name) {
    case 'NotAllowedError': case 'PermissionDeniedError': case 'SecurityError': return micHelp(plat);
    case 'NotFoundError': case 'DevicesNotFoundError': case 'OverconstrainedError': return SAY.noMic;
    case 'NotReadableError': case 'TrackStartError': case 'AbortError': return SAY.micBusy;
    default: return plat.ios ? SAY.unsupportedIos : SAY.unsupported;
  }
}

/**
 * A Web Speech error code → {say, fallback}. fallback: the recognizer can't work on this page, so the same tap carries
 * on as a recording (when recording is possible) and later taps record straight away. say is shown otherwise.
 * 'aborted' (our own abort) says nothing. 'network' while offline is just offline: a recording couldn't be sent either.
 */
export function speechError(code, plat = {}, { offline = false } = {}) {
  switch (code) {
    case 'aborted': return { say: null, fallback: false };
    case 'no-speech': return { say: SAY.noSpeech, fallback: false };
    case 'not-allowed': return { say: micHelp(plat), fallback: false };
    case 'audio-capture': return { say: SAY.micBusy, fallback: false };
    case 'network': return offline ? { say: SAY.offline, fallback: false } : { say: SAY.speechNet, fallback: true };
    case 'language-not-supported': return { say: SAY.speechLang, fallback: true };
    case 'service-not-allowed': return { say: SAY.unsupported, fallback: true };
    default: return { say: downFor(plat), fallback: true };
  }
}

/**
 * A refused /api/transcribe → what to tell the person. Tester refusals arrive already worded and are shown as sent.
 * plat: platformOf(); on a desktop the wording doesn't point at a keyboard mic.
 */
export function refusalMessage(status, info = {}, { tester = false, plat = null } = {}) {
  const code = typeof info?.code === 'string' ? info.code : '';
  const error = typeof info?.error === 'string' ? info.error.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  if (code === 'tester_signin') return SAY.signin;
  if ((code.startsWith('tester_') || code === 'owner_only') && error) return error;
  if (status === 401) return tester ? SAY.signin : SAY.passcode;
  if (code === 'too_large' || status === 413) return SAY.tooLong;
  if (code === 'unsupported_type' || code === 'unsupported_audio' || status === 415) return isDesktop(plat) ? SAY.formatDesktop : SAY.format;
  if (code === 'transcribe_short') return SAY.short;
  if (code === 'transcribe_unreadable' || code === 'bad_request' || status === 400 || status === 422) return SAY.unreadable;
  if (code === 'transcribe_busy' || status === 429) return SAY.busy;
  if (code === 'transcribe_timeout' || status === 504) return SAY.slow;
  if (status === 403) return SAY.off;
  return downFor(plat);
}
/** Worth keeping the recording for retry(): the connection, a busy or broken server. Not a refusal of the recording. */
const retryable = (status, code = '') => !String(code).startsWith('tester_') && (status === 0 || status === 408 || status === 429 || status >= 500);

/** A Retry-After value → seconds, or null. */
export function retryAfterS(v, now = Date.now()) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const at = Date.parse(s);
  return Number.isFinite(at) ? Math.max(0, (at - now) / 1000) : null;
}

/**
 * Puts dictated text into a composer value at the selection [start, end), with a space on each side where the
 * neighbouring text needs one: none inside Chinese or Japanese text, or beside CJK punctuation. → {value, caret}
 */
export function insertText(value, start, end, text) {
  const v = String(value ?? ''), t = String(text ?? '').trim();
  const s = Math.max(0, Math.min(v.length, Number.isFinite(start) ? start : v.length));
  const e = Math.max(s, Math.min(v.length, Number.isFinite(end) ? end : s));
  if (!t) return { value: v, caret: s };
  const before = v.slice(0, s), after = v.slice(e);
  const lead = before && !/\s$/.test(before) && !CJK_MARK.test(lastChar(before)) && !joins(before, t) ? ' ' : '';
  const trail = after && !/^[\s.,;:!?)\]}”’]/.test(after) && !CJK_MARK.test(firstChar(after)) && !joins(t, after) ? ' ' : '';
  const out = before + lead + t + trail;
  return { value: out + after, caret: out.length };
}

// ── the controller ──
/**
 * opts (all optional):
 *   apiHeaders(extra) → headers: app.js's (adds x-app-pass for the owner; testers ride on their cookie).
 *   serverReady() → true when recording can be transcribed now, else a reason: 'passcode' | 'signin' | 'off' | 'down'
 *     (false means 'down'). Owner: an OpenAI key and a passcode; tester: their 'dictation' feature.
 *   isTester() → word 401s as "sign in again" rather than "add your passcode".
 *   prefer() → 'auto' (default) | 'record': record and transcribe on the server even where Web Speech exists.
 *   lang() → the UI/device language (BCP 47); the recognizer gets it whole, the server ?lang=<ISO 639-1> plus the whole
 *     tag in x-dictate-lang. prompt() → an optional short hint for the transcriber (names, terms): x-dictate-prompt.
 *   beforeStart() runs inside the tap, before the mic opens: stop read-aloud there (the mic would record it, and while
 *     the mic is open iOS plays through the earpiece).
 *   onState(state, detail): state is one of STATES; detail {engine, reason, auto, autoSend, fallback?, message?, code?,
 *     retry?}. 'error' carries the message (already toasted) and returns to 'idle' after errorMs. 'recording' with
 *     fallback: Web Speech couldn't run, so this is a recording instead (SAY.fallback; not toasted, see there).
 *     'idle' after cancel() has reason 'cancel'.
 *   onText(text, detail): detail {final, live, engine, provider?, reason, auto, autoSend}. live: Web Speech's running
 *     transcript (replace the previous live text); final: the finished text.
 *   onLevel(level 0..1, {elapsedMs, leftMs, heard}) about every tickMs while recording.
 *   onResponse(r) for every /api/transcribe response (x-tester-allowance); onRefusal({status, code, scope, resetsAt,
 *     error}) for tester refusals; toast(message, {error}).
 *   limits: DICTATE_LIMITS overrides; vad: VAD_DEFAULTS overrides.
 * Test seams (default to the browser's): navigator, MediaRecorder, AudioContext, SpeechRecognition, fetch, document,
 *   matchMedia, now, setTimeout, clearTimeout, setInterval, clearInterval.
 * → {start({reason, auto, autoSend}?) → Promise<boolean started>, stop(reason?), cancel(), toggle(opts?), retry(),
 *    hasRetry(), state(), busy(), engine(), available(), whyNot(), needsGesture(), platform}
 * start() and toggle() must be called straight from the tap. start({auto: true}) (quick launch) says nothing when it
 * can't open the mic: the caller arms a "Tap to talk" target instead (startFromGesture). toggle() while transcribing:
 * the first tap toasts SAY.stillTranscribing, a second within cancelTapMs cancels (SAY.cancelled).
 */
export function createDictation(opts = {}) {
  const g = globalThis, has = (k) => k in opts;
  const nav = has('navigator') ? opts.navigator : g.navigator;
  const MR = has('MediaRecorder') ? opts.MediaRecorder : g.MediaRecorder;
  const AC = has('AudioContext') ? opts.AudioContext : (g.AudioContext || g.webkitAudioContext);
  const doc = has('document') ? opts.document : g.document;
  const mm = has('matchMedia') ? opts.matchMedia : (typeof g.matchMedia === 'function' ? (q) => g.matchMedia(q) : null);
  const doFetch = opts.fetch || ((...a) => g.fetch(...a));
  const now = opts.now || (() => Date.now());
  const T = {
    set: opts.setTimeout || ((f, ms) => g.setTimeout(f, ms)), clear: opts.clearTimeout || ((t) => g.clearTimeout(t)),
    every: opts.setInterval || ((f, ms) => g.setInterval(f, ms)), stop: opts.clearInterval || ((t) => g.clearInterval(t)),
  };
  const L = { ...DICTATE_LIMITS, ...(opts.limits || {}) };
  const V = { ...VAD_DEFAULTS, ...(opts.vad || {}) };
  const call = (f, ...a) => { try { return f?.(...a); } catch (err) { console.error(err); return undefined; } };
  const toast = (msg, error = true) => { if (msg) call(opts.toast, msg, { error }); };
  const plat = platformOf(nav || {}, mm);
  // iPhone/iPad: the recognizer is never looked up, so it is never constructed.
  const SR = plat.ios ? null : has('SpeechRecognition') ? opts.SpeechRecognition : (g.SpeechRecognition || g.webkitSpeechRecognition);
  const recorderOk = () => typeof MR === 'function' && typeof nav?.mediaDevices?.getUserMedia === 'function';
  const serverWhy = () => { const r = call(opts.serverReady); return r === true ? null : typeof r === 'string' && r ? r : 'down'; };
  const offline = () => nav?.onLine === false;
  // speechDead: the recognizer can't even be made or started here (for the page's life). speechBroken: it ran and
  // failed in a way that means it won't work here, so taps record instead (when they can). speechNetUntil: a 'network'
  // failure while online, which may pass: record until then, then try Web Speech again.
  let state = 'idle', session = null, speechDead = false, speechBroken = false, speechNetUntil = 0, pending = null, errT = null, cancelT = null, seq = 0;
  const hasSpeech = () => typeof SR === 'function' && !speechDead;
  function breakSpeech(code) {
    if (code === 'network') { if (!offline()) speechNetUntil = now() + L.speechNetHoldMs; return; } // offline: nothing to learn
    speechBroken = true;
  }

  const engine = () => pickEngine({ ios: plat.ios, speech: hasSpeech(), recorder: recorderOk(), server: !serverWhy(), speechBroken: speechBroken || now() < speechNetUntil, prefer: call(opts.prefer) || 'auto' });
  const canRecord = () => recorderOk() && !serverWhy();
  /**
   * Why there is no engine: 'unsupported' (this browser) or the server's reason. null when there is one. Where a
   * recognizer exists there always is one (see pickEngine), so 'off' or 'passcode' here means nothing else can work.
   */
  function whyNot() {
    if (engine()) return null;
    if (!recorderOk() && !hasSpeech()) return 'unsupported';
    return serverWhy() || 'unsupported';
  }
  const whyMessage = (why) => ({ passcode: SAY.passcode, signin: SAY.signin, off: SAY.off, down: downFor(plat) })[why]
    || (plat.ios ? SAY.unsupportedIos : SAY.unsupported);

  const pub = (s) => ({ reason: s.reason, auto: s.auto, autoSend: s.autoSend });
  const live = (s) => Boolean(s) && session === s && !s.dead;
  function setState(next, detail = {}) {
    T.clear(errT); errT = null;
    if (next !== 'transcribing' && cancelT != null) { T.clear(cancelT); cancelT = null; }
    state = next;
    call(opts.onState, next, detail);
    if (next === 'error') errT = T.set(() => { errT = null; if (state === 'error' && !session) setState('idle', {}); }, L.errorMs);
  }
  function release(s) {
    for (const k of ['watch', 'force', 'maxT', 'quietT', 'noResult', 'upT']) { if (s[k] != null) { T.clear(s[k]); s[k] = null; } }
    if (s.tick != null) { T.stop(s.tick); s.tick = null; }
    if (s.onHidden) { try { doc?.removeEventListener?.('visibilitychange', s.onHidden); } catch {} s.onHidden = null; }
    stopTracks(s.stream); s.stream = null;
    if (s.ctx) { try { s.ctx.close?.()?.catch?.(() => {}); } catch {} s.ctx = null; }
    s.an = null;
  }
  function stopTracks(stream) {
    let tracks = [];
    try { tracks = stream?.getTracks?.() || []; } catch {}
    for (const t of tracks) { try { t.stop(); } catch {} }
  }
  function finish(s, detail = {}) {
    if (session !== s) return;
    release(s);
    session = null;
    setState('idle', { engine: s.engine, ...pub(s), ...detail });
  }
  // quiet: an automatic start (quick launch) that couldn't open the mic says nothing and goes back to idle.
  function fail(s, message, { code = 'error', retry = false, quiet = false } = {}) {
    if (s && session !== s) return;
    if (s) { release(s); session = null; }
    const detail = { engine: s?.engine ?? null, ...(s ? pub(s) : {}), message, code, retry: Boolean(retry) };
    if (quiet) return setState('idle', detail);
    toast(message);
    setState('error', detail);
  }
  const sleep = (ms) => new Promise((r) => T.set(r, ms));

  // ── record: MediaRecorder → /api/transcribe ──
  function startRecord(meta, fallback = null) {
    const s = session = { id: ++seq, engine: 'record', ...meta, fallback, dead: false, stopping: false, chunks: [] };
    let done;
    const started = new Promise((r) => { done = r; });
    // Both inside the tap, before any await: an AudioContext made later stays suspended (no meter, no VAD), and iOS
    // only shows the mic prompt for a gesture.
    try { if (typeof AC === 'function') { s.ctx = new AC(); s.ctx.resume?.()?.catch?.(() => {}); } } catch { s.ctx = null; }
    let asked;
    try { asked = nav.mediaDevices.getUserMedia({ audio: { ...CONSTRAINTS } }); } catch (err) { asked = Promise.reject(err); }
    setState('recording', { engine: 'record', ...pub(s), ...(fallback ? { fallback } : {}) });
    Promise.resolve(asked).then((stream) => {
      if (!live(s) || s.stopping) { stopTracks(stream); if (session === s) finish(s, { reason: 'cancel' }); return done(false); }
      s.stream = stream;
      done(record(s));
    }, (err) => {
      if (live(s)) fail(s, micError(err, plat), { code: 'mic', quiet: s.auto });
      done(false);
    });
    return started;
  }

  function record(s) {
    const mime = pickRecorderType((t) => MR.isTypeSupported?.(t), { apple: plat.apple });
    let rec = null;
    try { rec = new MR(s.stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: L.bitrate }); } catch {
      try { rec = new MR(s.stream); } catch {}
    }
    if (!rec) { fail(s, SAY.recorder, { code: 'recorder', quiet: s.auto }); return false; }
    s.rec = rec; s.mime = mime;
    rec.ondataavailable = (e) => { if (e?.data?.size) s.chunks.push(e.data); };
    rec.onstop = () => s.recStopped?.();
    rec.onerror = () => { if (live(s)) s.chunks.length ? stop('error') : fail(s, SAY.recorder, { code: 'recorder' }); };
    for (const t of s.stream.getAudioTracks?.() || []) t.addEventListener?.('ended', () => { if (live(s)) stop('ended'); }); // a call took the mic
    try { rec.start(L.timesliceMs); } catch { fail(s, SAY.recorder, { code: 'recorder', quiet: s.auto }); return false; }
    // The meter and the VAD: source → analyser → silent gain → destination (WebKit only pulls connected graphs).
    if (s.ctx) {
      try {
        const src = s.ctx.createMediaStreamSource(s.stream), an = s.ctx.createAnalyser(), sink = s.ctx.createGain();
        an.fftSize = 1024; sink.gain.value = 0;
        src.connect(an); an.connect(sink); sink.connect(s.ctx.destination);
        s.an = an;
        s.buf = typeof an.getFloatTimeDomainData === 'function' ? new Float32Array(an.fftSize) : new Uint8Array(an.fftSize);
      } catch { s.an = null; }
    }
    s.vad = createVad(V);
    s.t0 = now();
    s.tick = T.every(() => tick(s), L.tickMs);
    s.maxT = T.set(() => { if (live(s)) stop('max'); }, L.maxMs);
    // Backgrounded or locked: iOS mutes the mic. Keep what was said and transcribe it.
    s.onHidden = () => { if (doc?.visibilityState === 'hidden' && live(s)) stop('hidden'); };
    try { doc?.addEventListener?.('visibilitychange', s.onHidden); } catch {}
    return true;
  }

  function tick(s) {
    if (!live(s) || s.stopping) return;
    const elapsedMs = Math.max(0, now() - s.t0), leftMs = Math.max(0, L.maxMs - elapsedMs);
    let level = 0, v = null;
    // A suspended context reads silence: the VAD stays out of it rather than hear "no speech".
    if (s.an && !s.vadOff && (!s.ctx || s.ctx.state == null || s.ctx.state === 'running')) {
      try {
        if (s.buf instanceof Float32Array) s.an.getFloatTimeDomainData(s.buf); else s.an.getByteTimeDomainData(s.buf);
        const r = rms(s.buf);
        level = meterLevel(r);
        v = s.vad.push(r, elapsedMs);
      } catch { s.vadOff = true; }
    }
    call(opts.onLevel, level, { elapsedMs, leftMs, heard: Boolean(s.vad?.heard) });
    if (!live(s) || s.stopping) return;
    if (elapsedMs >= L.maxMs) stop('max');
    else if (v === 'stop') stop('silence');
    // Exactly zero for noSpeechMs: the analyser isn't getting the mic (the recorder may be). Stop trusting it.
    else if (v === 'no-speech') { if (s.vad.peak === 0) s.vadOff = true; else stop('no-speech'); }
  }

  function stopRecord(s, reason) {
    if (s.stopping) return;
    s.stopping = true;
    if (s.tick != null) { T.stop(s.tick); s.tick = null; }
    if (s.maxT != null) { T.clear(s.maxT); s.maxT = null; }
    if (!s.rec) { s.dead = true; finish(s, { reason }); return; } // still waiting for the mic: just close it
    s.stopReason = reason;
    setState('transcribing', { engine: 'record', ...pub(s), why: reason });
    const stopped = new Promise((res) => { s.recStopped = res; s.watch = T.set(res, L.stopWaitMs); });
    try { if (s.rec.state !== 'inactive') s.rec.stop(); else s.recStopped(); } catch { s.recStopped(); }
    stopped.then(() => send(s, reason)).catch((err) => { console.error(err); fail(s, downFor(plat), { code: 'client' }); });
  }

  async function send(s, reason) {
    if (s.watch != null) { T.clear(s.watch); s.watch = null; }
    const vadLive = Boolean(s.an) && !s.vadOff, vad = s.vad;
    const chunks = s.chunks; s.chunks = [];
    const recType = s.rec?.mimeType || s.mime || '';
    release(s); // the mic indicator goes off as soon as the recording ends
    if (!live(s)) return;
    // Nothing in it was heard as speech. An automatic stop (no speech for noSpeechMs, the cap, the page hidden, a call)
    // sends nothing: room noise only draws made-up text, and testers pay for it. A tap still sends it, unless the whole
    // recording stayed under quietPeak. A peak of exactly 0 means the analyser saw nothing (dead or suspended): send.
    if (vadLive && vad.peak > 0 && !vad.heard && (reason !== 'user' || vad.peak < V.quietPeak)) return fail(s, SAY.noSpeech, { code: 'no_speech' });
    const blob = new Blob(chunks, baseType(recType) ? { type: baseType(recType) } : {});
    if (blob.size < L.minBytes) return fail(s, SAY.noSpeech, { code: 'empty' });
    if (blob.size > L.maxBytes) return fail(s, SAY.tooLong, { code: 'too_large' });
    let head = new Uint8Array(0);
    try { head = new Uint8Array(await blob.slice(0, 16).arrayBuffer()); } catch {}
    if (!live(s)) return;
    const tag = call(opts.lang) || nav?.language;
    const job = { blob, type: uploadType(head, recType), lang: isoLang(tag), tag: langTag(tag), prompt: promptHeader(call(opts.prompt)), meta: pub(s), reason };
    return upload(s, job);
  }

  async function upload(s, job) {
    const url = `/api/transcribe${job.lang ? `?lang=${job.lang}` : ''}`;
    const ctrl = s.ctrl = new AbortController();
    s.upT = T.set(() => { try { ctrl.abort(); } catch {} }, L.uploadMs);
    const lost = (message, code) => { pending = job; fail(s, message, { code, retry: true }); return false; };
    for (let attempt = 0; ; attempt++) {
      if (!live(s)) return false;
      if (nav?.onLine === false) return lost(SAY.offline, 'offline');
      const headers = new Headers(call(opts.apiHeaders, { 'content-type': job.type }) || {});
      headers.set('content-type', job.type);
      if (job.tag) headers.set('x-dictate-lang', job.tag);
      if (job.prompt) headers.set('x-dictate-prompt', job.prompt);
      let r;
      try {
        r = await doFetch(url, { method: 'POST', headers, body: job.blob, signal: ctrl.signal, credentials: 'same-origin', cache: 'no-store' });
      } catch (err) {
        if (!live(s)) return false;
        const aborted = ctrl.signal.aborted || err?.name === 'AbortError';
        if (!aborted && attempt === 0) { await sleep(L.netRetryMs); continue; } // one retry on a dropped connection
        return lost(aborted ? SAY.slow : SAY.network, aborted ? 'timeout' : 'network');
      }
      call(opts.onResponse, r);
      if (!live(s)) return false;
      if (r.ok) {
        const j = await r.json().catch(() => null);
        if (!live(s)) return false;
        const text = typeof j?.text === 'string' ? j.text.trim() : '';
        pending = null;
        if (!text) { fail(s, SAY.noWords, { code: 'no_words' }); return false; }
        const from = {};
        for (const k of ['provider', 'model']) if (typeof j?.[k] === 'string' && j[k].length <= 80) from[k] = j[k];
        call(opts.onText, text, { final: true, live: false, engine: 'record', ...from, ...job.meta });
        finish(s, { reason: job.reason });
        return true;
      }
      const info = (await r.json().catch(() => null)) || {};
      if (!live(s)) return false;
      const code = typeof info.code === 'string' ? info.code : '';
      const wait = retryAfterS(r.headers?.get?.('retry-after'), now());
      if (r.status === 429 && !code.startsWith('tester_') && attempt === 0 && (wait ?? 1) <= L.busyRetryMaxS) {
        await sleep(Math.max(0.5, wait ?? 1) * 1000);
        continue;
      }
      if (code.startsWith('tester_') || code === 'owner_only') {
        call(opts.onRefusal, { status: r.status, code, scope: typeof info.scope === 'string' ? info.scope : undefined, resetsAt: info.resetsAt ?? null, error: typeof info.error === 'string' ? info.error : '' });
      }
      const again = retryable(r.status, code);
      pending = again ? job : null;
      fail(s, refusalMessage(r.status, info, { tester: Boolean(call(opts.isTester)), plat }), { code: code || `http_${r.status}`, retry: again });
      return false;
    }
  }

  // ── speech: Web Speech, live text ──
  function startSpeech(meta) {
    const s = session = { id: ++seq, engine: 'speech', ...meta, dead: false, stopping: false, text: '', err: null, events: 0, results: 0 };
    let done;
    s.started = new Promise((r) => { done = r; });
    s.done = (v) => { if (!s.settled) { s.settled = true; done(v); } };
    let rec;
    try { rec = new SR(); } catch {
      // Still inside the tap: record instead, straight away.
      session = null; speechDead = true;
      if (canRecord()) return startRecord(meta, 'speech-unavailable');
      fail(null, whyMessage('unsupported'), { code: 'unsupported', quiet: meta.auto });
      return Promise.resolve(false);
    }
    s.rec = rec;
    try {
      rec.lang = call(opts.lang) || nav?.language || 'en-US';
      rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
    } catch {}
    const seen = () => { s.events++; if (s.watch != null) { T.clear(s.watch); s.watch = null; } };
    const on = (f) => (ev) => { if (live(s)) f(ev); };
    rec.onstart = on(() => { seen(); s.done(true); });
    rec.onaudiostart = rec.onsoundstart = rec.onspeechstart = rec.onnomatch = on(() => { seen(); s.done(true); });
    rec.onresult = on((ev) => {
      seen(); s.done(true);
      s.results++;
      const text = mergeResults(ev?.results);
      if (text && text !== s.text) { s.text = text; call(opts.onText, text, { final: false, live: true, engine: 'speech', ...pub(s) }); }
      if (s.noResult != null) { T.clear(s.noResult); s.noResult = null; }
      if (s.quietT != null) T.clear(s.quietT);
      s.quietT = T.set(() => { if (live(s) && !s.stopping) stopSpeech(s, 'quiet'); }, L.speechQuietMs);
    });
    rec.onerror = (ev) => {
      if (session !== s) return;
      seen();
      const code = String(ev?.error || 'unknown');
      if (code === 'aborted' && s.err) return; // our own abort() after a real error: keep the real one
      s.err = code;
      if (!s.dead && !s.text && s.why !== 'user' && speechError(code, plat, { offline: offline() }).fallback && canRecord()) beginFallback(s, code);
    };
    rec.onend = () => endSpeech(s);
    try { rec.start(); } catch (err) {
      // InvalidStateError: one is already running somewhere. Anything else: this browser can't.
      session = null;
      if (err?.name !== 'InvalidStateError') { speechDead = true; if (canRecord()) return startRecord(meta, 'speech-unavailable'); }
      fail(null, err?.name === 'InvalidStateError' ? SAY.micBusy : whyMessage('unsupported'), { code: 'speech', quiet: meta.auto });
      return Promise.resolve(false);
    }
    setState('listening', { engine: 'speech', ...pub(s) });
    armSpeech(s);
    awaitPrompt(s);
    s.maxT = T.set(() => { if (live(s) && !s.stopping) stopSpeech(s, 'max'); }, L.maxMs);
    return s.started;
  }
  // The recognizer gets speechWatchMs to show any sign of life, and speechNoResultMs to hear something.
  function armSpeech(s, { watch = true } = {}) {
    for (const k of ['watch', 'noResult']) { if (s[k] != null) { T.clear(s[k]); s[k] = null; } }
    // No event at all: the recognizer exists but won't run here (an installed app, a managed device, a WebView).
    if (watch) s.watch = T.set(() => { if (live(s) && !s.events) { s.err = 'silent'; canRecord() ? beginFallback(s, 'silent') : stopSpeech(s, 'silent', true); } }, L.speechWatchMs);
    s.noResult = T.set(() => { if (live(s) && !s.results && !s.stopping) stopSpeech(s, 'no-result'); }, L.speechNoResultMs);
  }
  // Chrome fires no recognizer event while its microphone prompt is up. Waiting on the person isn't "dead here": while
  // the prompt is up the timers above wait, and start when it is answered (or after speechPromptMs), or a slow Allow
  // would retire Web Speech for the page.
  function awaitPrompt(s) {
    let asked;
    try { asked = nav?.permissions?.query?.({ name: 'microphone' }); } catch { return; } // Firefox: not a permission name
    if (!asked) return;
    Promise.resolve(asked).then((st) => {
      if (!live(s) || s.stopping || s.events || st?.state !== 'prompt') return;
      for (const k of ['watch', 'noResult']) { if (s[k] != null) { T.clear(s[k]); s[k] = null; } }
      let done = false;
      const answered = () => {
        if (done) return;
        done = true;
        if (s.promptT != null) { T.clear(s.promptT); s.promptT = null; }
        try { st.removeEventListener?.('change', answered); } catch {}
        if (live(s) && !s.stopping) armSpeech(s, { watch: !s.events });
      };
      s.unprompt = () => { done = true; try { st.removeEventListener?.('change', answered); } catch {} };
      try { st.addEventListener?.('change', answered); } catch {}
      s.promptT = T.set(answered, L.speechPromptMs);
    }, () => {});
  }
  function stopSpeech(s, why, abort = false) {
    if (s.stopping) {
      // A tap while waiting to switch to recording: don't start the recording after all.
      if (why === 'user' && s.fallback) { s.fallback = null; s.why = 'user'; }
      return;
    }
    s.stopping = true; s.why = why;
    endRecognizer(s, abort);
  }
  const SPEECH_TIMERS = ['watch', 'force', 'quietT', 'noResult', 'maxT', 'promptT'];
  function endRecognizer(s, abort) {
    for (const k of SPEECH_TIMERS) { if (s[k] != null) { T.clear(s[k]); s[k] = null; } }
    try { abort ? s.rec.abort() : s.rec.stop(); } catch { return endSpeech(s); }
    s.force = T.set(() => endSpeech(s), L.speechEndWaitMs); // some recognizers never fire 'end'
  }
  // The recognizer can't work here: end it, wait for it to let go of the mic, then record (same session).
  function beginFallback(s, why) {
    if (s.fallback || s.ended) return;
    s.fallback = why; breakSpeech(why);
    s.stopping = true; s.why = 'fallback';
    endRecognizer(s, true);
  }
  function endSpeech(s) {
    if (session !== s || s.ended) return;
    s.ended = true;
    for (const k of SPEECH_TIMERS) { if (s[k] != null) { T.clear(s[k]); s[k] = null; } }
    s.unprompt?.();
    if (s.dead) return finish(s, { reason: 'cancel' });
    const m = s.err && s.err !== 'aborted' ? speechError(s.err === 'silent' ? 'service-not-allowed' : s.err, plat, { offline: offline() }) : null;
    if (s.text) {
      // The last interim result counts: Safari and some Android builds end without ever marking one final.
      call(opts.onText, s.text, { final: true, live: true, engine: 'speech', ...pub(s) });
      if (m?.fallback) breakSpeech(s.err); // the next tap records
      s.done(true);
      return finish(s, { reason: s.why || 'end' });
    }
    if (s.fallback && canRecord()) {
      // No toast here: a screen reader would speak it into the mic that is opening (onState's detail.fallback says it).
      session = null;
      startRecord(pub(s), s.fallback).then((ok) => s.done(ok));
      return;
    }
    s.done(false);
    if (m) {
      if (m.fallback) breakSpeech(s.err);
      const say = m.fallback && canRecord() ? SAY.tapToRecord : m.say || downFor(plat);
      return fail(s, say, { code: s.err, quiet: s.auto && s.err !== 'no-speech' });
    }
    if (s.why === 'user' || s.err === 'aborted') return finish(s, { reason: s.why || 'aborted' });
    return fail(s, SAY.noSpeech, { code: 'no-speech', quiet: s.auto }); // ended with nothing heard
  }

  // ── public ──
  function start(o = {}) {
    const meta = { reason: typeof o.reason === 'string' ? o.reason : 'tap', auto: Boolean(o.auto), autoSend: Boolean(o.autoSend) };
    if (session) return Promise.resolve(false);
    const e = engine();
    if (!e) { fail(null, whyMessage(whyNot()), { code: whyNot() || 'unsupported', quiet: meta.auto }); return Promise.resolve(false); }
    pending = null; // a new recording replaces one that couldn't be sent
    call(opts.beforeStart);
    return e === 'speech' ? startSpeech(meta) : startRecord(meta);
  }
  function stop(reason = 'user') {
    const s = session;
    if (!s || s.dead) return;
    if (s.engine === 'record') { if (state === 'recording') stopRecord(s, reason); return; }
    stopSpeech(s, reason);
  }
  function cancel() {
    const s = session;
    if (!s) { if (state === 'error') setState('idle', {}); return; }
    s.dead = true;
    try { s.ctrl?.abort(); } catch {}
    if (s.engine === 'record') { try { if (s.rec && s.rec.state !== 'inactive') s.rec.stop(); } catch {} s.recStopped?.(); }
    else { try { s.rec?.abort(); } catch {} s.done?.(false); }
    pending = null;
    finish(s, { reason: 'cancel' });
  }
  // A tap while transcribing: the first says it's still on its way, a second within cancelTapMs cancels (no phone has
  // an Escape key, and an upload on a weak connection can take a while).
  function toggle(o) {
    if (state === 'listening' || state === 'recording') { stop('user'); return Promise.resolve(false); }
    if (state === 'transcribing') {
      if (cancelT != null) { cancel(); toast(SAY.cancelled, false); return Promise.resolve(false); }
      cancelT = T.set(() => { cancelT = null; }, L.cancelTapMs);
      toast(SAY.stillTranscribing, false);
      return Promise.resolve(false);
    }
    if (session) return Promise.resolve(false);
    return start(o);
  }
  /** Sends the last recording that couldn't be (offline, busy, the server down) again. → Promise<boolean> */
  function retry() {
    if (session || !pending) return Promise.resolve(false);
    const job = pending;
    pending = null;
    const s = session = { id: ++seq, engine: 'record', ...job.meta, reason: 'retry', dead: false, stopping: true, chunks: [] };
    setState('transcribing', { engine: 'record', ...pub(s) });
    return upload(s, { ...job, meta: { ...job.meta, reason: 'retry' } });
  }
  return {
    start, stop, cancel, toggle, retry,
    hasRetry: () => Boolean(pending) && !session,
    state: () => state,
    busy: () => state === 'listening' || state === 'recording' || state === 'transcribing',
    engine, available: () => engine() !== null, whyNot,
    /** True where the mic can only open from a tap (iPhone/iPad): quick launch arms startFromGesture instead. */
    needsGesture: () => plat.ios,
    platform: plat,
  };
}

/**
 * Quick launch's "Tap to talk": arms `target` (the mic button, or a big one-tap target) so its next tap starts
 * dictation inside that tap, the only way an iPhone shows the mic prompt and lets the level meter run. The listener sits
 * on the document in the capture phase (so it runs before any listener on the button, in every engine) and stops that
 * tap there: the button's own click handler doesn't toggle the mic straight off. One shot. While dictation is already
 * busy the tap is let through untouched.
 * opts: autoSend, reason ('launch'), timeoutMs (0: until disarmed), onFire(promise of start()), onDisarm(why: 'fired'
 *   | 'timeout' | 'busy' | 'disarm'), root (where to listen; default target.ownerDocument, else the target itself),
 *   setTimeout / clearTimeout (test seams).
 * → disarm(why?)
 */
export function startFromGesture(dictation, target, { autoSend = false, reason = 'launch', timeoutMs = 0, onFire, onDisarm, root, setTimeout: st, clearTimeout: ct } = {}) {
  if (!dictation || typeof target?.addEventListener !== 'function') return () => {};
  const setT = st || ((f, ms) => globalThis.setTimeout(f, ms)), clearT = ct || ((t) => globalThis.clearTimeout(t));
  const r = root || target.ownerDocument;
  const host = typeof r?.addEventListener === 'function' ? r : target;
  const hit = (ev) => host === target || ev?.target === target || Boolean(ev?.target && target.contains?.(ev.target));
  let armed = true, t = null;
  function disarm(why = 'disarm') {
    if (!armed) return;
    armed = false;
    try { host.removeEventListener('click', fire, true); } catch {}
    if (t != null) clearT(t);
    try { onDisarm?.(why); } catch (err) { console.error(err); }
  }
  function fire(ev) {
    if (!armed || !hit(ev)) return;
    if (dictation.busy?.()) return disarm('busy');
    ev?.stopImmediatePropagation?.();
    ev?.preventDefault?.();
    disarm('fired');
    let p;
    try { p = Promise.resolve(dictation.start({ reason, autoSend })); } catch (err) { console.error(err); p = Promise.resolve(false); }
    try { onFire?.(p); } catch (err) { console.error(err); }
  }
  host.addEventListener('click', fire, true);
  if (timeoutMs > 0) t = setT(() => disarm('timeout'), timeoutMs);
  return disarm;
}
