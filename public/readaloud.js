// Read aloud: an answer's Markdown → speakable text → short segments → the Atelier voice (POST /api/tts) through one
// persistent <audio>, with the device's own voice (speechSynthesis) as the offline and fallback reader.
// The pure helpers are node-tested (tests/readaloud.test.mjs); createReader() is the player. Nothing here touches the
// DOM at import time — app.js imports it and wires the Read aloud buttons and Settings → Read aloud.

// ── shared constants (src/tts.js owns the voices, the brief and the preview line; keep the ids and TTS_BRIEF_V in step) ──
export const TTS_BRIEF_V = 2; // src/tts.js TTS_BRIEF_V: part of every cache key, so a new voice never replays old clips
export const PREVIEW_ID = '7d6c99da'; // src/tts.js PREVIEW_ID (a hash of its PREVIEW_TEXT): part of the preview cache key
/**
 * Spoken length, as src/tts.js counts it (a test keeps the two identical): characters, plus extra weight for digits (3),
 * symbols read as words (2) and Chinese, Japanese or Korean characters (2). Segments are sized in these units, and a
 * tester's request may hold at most 1,000 of them.
 */
const SPOKEN_EXTRA = [[/[0-9]/g, 3], [/[%$€£¥&@#°×÷=+/§‰]/g, 2], [/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, 2]];
export function spokenUnits(text) {
  const s = String(text ?? '');
  let n = s.length;
  for (const [re, w] of SPOKEN_EXTRA) n += (s.match(re)?.length || 0) * w;
  return n;
}
// provider: 'gemini' (every AI voice: the server sends one whole WAV per segment) or 'device' (speechSynthesis).
export const VOICES = Object.freeze([
  Object.freeze({ id: 'atelier', label: 'Atelier', hint: 'warm, soft (default)', provider: 'gemini' }),
  Object.freeze({ id: 'sulafat', label: 'Sulafat', hint: 'warm', provider: 'gemini' }),
  Object.freeze({ id: 'device', label: 'Device voice', hint: 'offline, free', provider: 'device' }),
]);
const VOICE = new Map(VOICES.map((v) => [v.id, v]));
/**
 * Retired voice ids → the voice that reads in their place (src/tts.js RETIRED_VOICES; a test keeps them in step). The
 * OpenAI voices Cedar and Sage went with gpt-4o-mini-tts in v80, and the Atelier voice is the nearest soft one.
 */
export const RETIRED_VOICES = Object.freeze({ cedar: 'atelier', sage: 'atelier' });
// A saved or allowed voice id as it reads today: a retired id becomes its stand-in.
const current = (id) => (typeof id === 'string' && Object.hasOwn(RETIRED_VOICES, id) ? RETIRED_VOICES[id] : id);
export const SPEEDS = Object.freeze([0.9, 1, 1.1, 1.25]);
export const DEFAULT_READ_ALOUD = Object.freeze({ voice: 'atelier', speed: 1 }); // settings.readAloud
// first/target: segment sizes in spoken units (fast first audio, then paragraph-sized); owner/tester: the most one
// answer reads, in characters. codespan: inline code up to this length is read; deviceLine: one utterance, in spoken
// units (Chrome cuts long ones off near 15 s).
export const READ_LIMITS = Object.freeze({ first: 220, target: 900, owner: 24_000, tester: 8_000, codespan: 24, deviceLine: 160 });
export const DEVICE_RATE = 0.95;
export const TTS_CACHE = 'atelier-tts'; // sw.js only deletes 'atelier-v*' caches, so clips survive deploys
export const CACHE_CAP = Object.freeze({ bytes: 30 * 1024 * 1024, clips: 200 });
export const AI_CAPTION = 'AI-generated voice. To make the audio, answer text is sent to Google. Clips stay on this device until you clear it.';
export const NOTES = Object.freeze({
  code: 'There’s a code block on screen.',
  formula: 'There’s a formula on screen.',
  mostlyCode: 'This answer is mostly code.',
  table: (n) => `There’s a table on screen with ${n} ${n === 1 ? 'row' : 'rows'}.`,
  // said in place of long inline code and of math inside a sentence, so the sentence stays whole
  inlineCode: 'the code on screen',
  inlineMath: 'the formula on screen',
});
// What the reader says in a toast. Gentle on purpose: a fallback still reads the answer.
export const SAY = Object.freeze({
  first: 'Reading aloud · AI voice',
  offline: 'Offline — reading with the device voice.',
  busy: 'The Atelier voice is busy — reading with the device voice.',
  down: 'The Atelier voice isn’t available right now — reading with the device voice.',
  budget: 'Your tester allowance is used up for now — reading with the device voice.',
  plan: 'The Atelier voice isn’t available on this account — reading with the device voice.',
  passcode: 'Add your passcode in Settings for the Atelier voice — reading with the device voice.',
  signin: 'Sign in again for the Atelier voice — reading with the device voice.',
  nothing: 'There’s nothing to read aloud here.',
  unsupported: 'Read aloud isn’t supported in this browser.',
  resume: 'Tap Resume to keep listening.',
  // A preview has no answer to fall back on, so these never promise the device voice.
  previewOffline: 'You’re offline — connect to hear this voice.',
  previewFailed: 'Couldn’t play that preview — try again in a moment.',
  previewPlan: 'This voice isn’t available on this account.',
  previewPasscode: 'Add your passcode in Settings to hear the AI voices.',
  previewSignin: 'Sign in again to hear this voice.',
  previewBudget: 'Your tester allowance is used up for now, and previews use it too.',
});
// why() gives a SAY key; a preview says the matching preview line instead.
const PREVIEW_SAY = { offline: 'previewOffline', plan: 'previewPlan', passcode: 'previewPasscode', signin: 'previewSignin', budget: 'previewBudget' };
const DEVICE_PREVIEW = 'This is your device’s own voice. It works offline, and it’s free.';
const ARTWORK = [{ src: '/icons/atelier-v2-512.png', sizes: '512x512', type: 'image/png' }, { src: '/icons/atelier-v2-192.png', sizes: '192x192', type: 'image/png' }];
const MOSTLY_CODE_PROSE = 400; // this much prose is always read, however much code sits around it
const MOSTLY_CODE_TINY = 80; // less prose than this (or none in whole sentences) next to mostly code isn't read
const SHORT_SENTENCE = 15; // "Yes." or "Dr.": not counted toward the first segment's two sentences

/**
 * settings.readAloud → {voice, speed}: a known voice id (a retired one, 'cedar' or 'sage', becomes its stand-in,
 * RETIRED_VOICES; anything else unknown becomes 'atelier') and one of SPEEDS (else 1).
 */
export function normalizeReadAloud(v) {
  const o = v && typeof v === 'object' ? v : {}, speed = Number(o.speed), voice = current(o.voice);
  return { voice: VOICE.has(voice) ? voice : DEFAULT_READ_ALOUD.voice, speed: SPEEDS.includes(speed) ? speed : DEFAULT_READ_ALOUD.speed };
}
/** The Settings list: AI voices the account may use (allowed: ids, or null for all) plus the device voice. */
export const voiceChoices = (allowed) => VOICES.filter((v) => v.provider === 'device' || !Array.isArray(allowed) || allowed.map(current).includes(v.id));
/**
 * The voice that reads for this account when `want` is chosen (allowed: ids, or null for all): `want` itself, else the
 * first AI voice the account may use, else the device voice. The reader picks this way, and Settings and the Read aloud
 * button show the same answer. Retired ids (RETIRED_VOICES), in `want` or in `allowed`, count as their stand-in.
 */
export function voiceFor(want, allowed) {
  const w = current(want), v = VOICE.has(w) ? w : DEFAULT_READ_ALOUD.voice;
  const ok = Array.isArray(allowed) ? allowed.map(current) : null;
  if (v === 'device' || !ok || ok.includes(v)) return v;
  return ok.find((id) => VOICE.get(id) && VOICE.get(id).provider !== 'device') || 'device';
}

// ── text: Markdown → what a listener should hear ──
const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', '#39': '\'', nbsp: ' ' };
const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u200D\uFE0F\u20E3]/gu;
// $$…$$, \(…\), \[…\] and short $…$ with TeX in it. A plain "$5" never matches (no digit or space right after the $).
const MATH = /\$\$[\s\S]*?\$\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|\$(?![\s\d])[^$\n]{0,80}?[\\^_{}][^$\n]{0,80}?[^\s$]\$/g;
// Placeholders for what isn't read as written: push() turns them into words (or a one-time note) after counting prose.
const CODE_MARK = '\uE000', MATH_MARK = '\uE001', MARKS = /[\uE000\uE001]/g;
const english = (lang) => /^en\b/i.test(lang || 'en');
// One spoken unit: entities decoded; math, footnote markers [1] and emoji gone; arrows (→, ->, =>) and "3×4" said in
// words; a lone $x$ read as its letter. Hyphens are kept, so "state-of-the-art", "2026-09-30" and "-5" read as written.
function tidy(s, lang) {
  const en = english(lang);
  return String(s ?? '')
    .replace(/&(amp|lt|gt|quot|apos|#39|nbsp);/g, (_, e) => ENTITY[e])
    .replace(/\$([A-Za-z])\$/g, '$1')
    .replace(MATH, ` ${MATH_MARK} `)
    .replace(/\[\^?\d{1,3}\]/g, '')
    .replace(/\s*[→⟶⇒]\s*(?:then\s+)?/gi, en ? ' then ' : ', ')
    .replace(/(?:^|\s+)(?:-{1,2}>|=>)\s+(?:then\s+)?|(?<=\p{L})(?:-{1,2}>|=>)(?=\p{L})/giu, en ? ' then ' : ', ')
    .replace(/(\d)\s*×\s*(?=\d)/g, en ? '$1 by ' : '$1 x ')
    .replace(EMOJI, '')
    .replace(/\s+/g, ' ').trim();
}
const sentence = (s) => (/[.!?…:;。！？]["'”’)\]」』]*$/.test(s) ? s : `${s}.`);
// A whole sentence (for "mostly code"): four or more words, or six CJK characters, ending in . ! ? or the like.
const wholeSentence = (t) => /[\p{L}\p{N}][)"'”’」』]*[.!?…。！？]/u.test(t)
  && (t.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length >= 4 || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]{6}/u.test(t));
const bareUrl = (t) => !/^mailto:/i.test(t.href || '') && (t.autolink || t.text === t.href || /^(https?:\/\/|www\.)\S+$/i.test(t.text || ''));
function linkTo(href) {
  try { const host = new URL(/^www\./i.test(href) ? `https://${href}` : href).hostname.replace(/^www\./, ''); return host ? `a link to ${host}` : 'a link'; } catch { return 'a link'; }
}
function push(ctx, s, { end = false, prose = true } = {}) {
  let t = tidy(s, ctx.lang);
  if (!t) return;
  // Only code, math or punctuation: a one-time note instead of a sentence of placeholders.
  if (!t.replace(MARKS, '').replace(/[\s\p{P}\p{S}]+/gu, '')) {
    if (t.includes(CODE_MARK)) codeNote(ctx, 0);
    if (t.includes(MATH_MARK) && !ctx.saidMath) { ctx.saidMath = true; ctx.out.push(NOTES.formula); }
    return;
  }
  if (prose) {
    const words = t.replace(MARKS, '');
    ctx.prose += words.replace(/\s+/g, ' ').trim().length;
    if (wholeSentence(words)) ctx.sentences++;
  }
  const en = english(ctx.lang); // a run of placeholders is said once, and keeps no space before the punctuation after it
  t = t.replace(/\uE000(?:\s*\uE000)*(?:\s+(?=[.,;:!?…]))?/g, en ? NOTES.inlineCode : '…').replace(/\uE001(?:\s*\uE001)*(?:\s+(?=[.,;:!?…]))?/g, en ? NOTES.inlineMath : '…');
  ctx.out.push(end ? sentence(t) : t);
}
function codeNote(ctx, chars) {
  ctx.code += chars;
  if (!ctx.saidCode) { ctx.saidCode = true; ctx.out.push(NOTES.code); }
}
// \( \) \[ \] reach marked as escapes whose text drops the backslash: keep it, so MATH still sees the delimiters.
const MATH_ESCAPE = /^\\[()[\]]$/;
function inline(tokens, ctx) {
  let s = '';
  for (const t of tokens || []) {
    if (t.type === 'codespan') { const c = t.text || ''; if (c.length <= READ_LIMITS.codespan) s += c; else { ctx.code += c.length; s += ` ${CODE_MARK} `; } }
    else if (t.type === 'link') s += bareUrl(t) ? linkTo(t.href) : inline(t.tokens, ctx) || t.text || '';
    else if (t.type === 'image') s += t.text || ''; // alt text, or nothing
    else if (t.type === 'br') s += ' ';
    else if (t.type === 'escape') s += MATH_ESCAPE.test(t.raw || '') ? t.raw : t.text || '';
    else if (t.type === 'del') s += ' '; // struck-out text is no longer current: it isn't read
    else if (t.type !== 'html' && t.type !== 'checkbox') s += t.tokens ? inline(t.tokens, ctx) : t.text || ''; // inline tags drop; their words are text tokens
  }
  return s;
}
function table(t, ctx) {
  const cell = (c) => tidy(c?.tokens ? inline(c.tokens, ctx) : c?.text, ctx.lang), head = (t.header || []).map(cell), rows = t.rows || [];
  if (head.length > 4 || rows.length > 6) { ctx.out.push(NOTES.table(rows.length)); return; }
  for (const r of rows) push(ctx, r.map((c, j) => { const v = cell(c); return v && head[j] ? `${head[j]}: ${v}` : v; }).filter(Boolean).join(', '), { end: true });
}
function walk(tokens, ctx) {
  for (const t of tokens || []) {
    if (t.type === 'space' || t.type === 'hr' || t.type === 'def') continue;
    if (t.type === 'code') codeNote(ctx, (t.text || '').length);
    else if (t.type === 'heading') push(ctx, inline(t.tokens, ctx), { end: true });
    else if (t.type === 'blockquote') walk(t.tokens, ctx);
    else if (t.type === 'table') table(t, ctx);
    else if (t.type === 'html') push(ctx, String(t.text || '').replace(/<[^>]*>/g, ' '));
    else if (t.type === 'list') {
      for (const item of t.items || []) { // the item's own words make one sentence; nested lists and code follow it
        const own = (item.tokens || []).filter((x) => !['list', 'code', 'table', 'blockquote'].includes(x.type));
        push(ctx, own.map((x) => (x.tokens ? inline(x.tokens, ctx) : x.text || '')).join(' '), { end: true });
        walk((item.tokens || []).filter((x) => !own.includes(x)), ctx);
      }
    } else push(ctx, t.tokens ? inline(t.tokens, ctx) : t.text || '');
  }
}
// Without marked (it is a global vendor script in the app): a rougher pass over the same rules, line by line.
const MARKER = /^\s{0,3}(?:#{1,6}|>|[-*+]|\d{1,3}[.)])\s+/, ITEM = /^\s{0,3}(?:#{1,6}|[-*+]|\d{1,3}[.)])\s+|^\s*\|/;
// A table rule or a thematic break: only pipes, colons, hyphens and spaces (with a pipe or 3+ hyphens), or *** / ___.
const isRule = (l) => (/^[\s|:-]+$/.test(l) && /-/.test(l) && (/\|/.test(l) || /-{3,}/.test(l))) || /^\s*([*_])(?:\s*\1){2,}\s*$/.test(l);
const inlineMd = (s) => s
  .replace(/`([^`\n]{1,24})`/g, '$1').replace(/`[^`\n]+`/g, (c) => ` ${CODE_MARK} `)
  .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/(?:https?:\/\/|www\.)[^\s)<>]*[^\s)<>.,;:!?]/gi, (u) => linkTo(u)) // a URL never ends in punctuation
  .replace(/~~.+?~~/g, ' ') // struck-out text is no longer current
  .replace(/(\*\*|__)(.+?)\1/g, '$2').replace(/<[^>]*>/g, ' ').trim();
function plain(md, ctx) {
  md.split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$))/).forEach((p, i) => {
    if (i % 2) return codeNote(ctx, p.length);
    for (const block of p.split(/\n\s*\n/)) {
      const lines = block.split('\n').filter((l) => !isRule(l)).map((l) => {
        const raw = l.replace(MARKER, '').replace(/^\s*\||\|\s*$/g, '').replace(/\s*\|\s*/g, ', ');
        ctx.code += (raw.match(/`[^`\n]{25,}`/g) || []).reduce((n, c) => n + c.length - 2, 0);
        const t = tidy(inlineMd(raw), ctx.lang);
        return t && ITEM.test(l) ? sentence(t) : t; // headings, list items and table rows end as sentences
      });
      push(ctx, lines.join(' '));
    }
  });
}
// Cuts at the last sentence end before max (Latin or CJK punctuation), else the last space past halfway, else at max.
const ENDS = ['. ', '! ', '? ', '… ', '\n', '。', '！', '？', '．'];
function capText(s, max) {
  if (!(max > 0) || s.length <= max) return s;
  const cut = s.slice(0, max), end = Math.max(...ENDS.map((m) => cut.lastIndexOf(m)));
  if (end > max / 2) return cut.slice(0, end + 1).trim();
  const space = cut.lastIndexOf(' ');
  let at = space > max / 2 ? space : max;
  if (at === max && /[\ud800-\udbff]/.test(s[max - 1])) at--; // never split a surrogate pair
  return cut.slice(0, at).trim();
}

/**
 * Markdown → plain text to speak, blocks separated by blank lines. Code blocks are skipped (said once), short inline
 * code is read and longer inline code becomes "the code on screen", links read their text, bare URLs become "a link to
 * <domain>", headings and list items become sentences, small tables (≤ 4 columns × 6 rows) are read row by row and
 * larger ones summarized, math is left out (a formula alone is said once), struck-out text isn't read. An answer that
 * is almost all code, with no whole sentence of prose, becomes NOTES.mostlyCode. max caps the result (owner 24,000;
 * testers 8,000).
 */
export function speakable(markdown, { lang = 'en', max = READ_LIMITS.owner } = {}) {
  const md = String(markdown ?? '').slice(0, Number.isFinite(max) && max > 0 ? max * 4 : undefined);
  const ctx = { lang, out: [], prose: 0, code: 0, sentences: 0, saidCode: false, saidMath: false };
  let tokens = null;
  try { if (typeof globalThis.marked?.lexer === 'function') tokens = globalThis.marked.lexer(md); } catch { tokens = null; }
  tokens ? walk(tokens, ctx) : plain(md, ctx);
  if (ctx.code && ctx.prose < MOSTLY_CODE_PROSE && ctx.prose < 0.15 * (ctx.prose + ctx.code) && (ctx.prose < MOSTLY_CODE_TINY || !ctx.sentences)) return NOTES.mostlyCode;
  return capText(ctx.out.join('\n\n'), max);
}

// ── which language the answer is in (the device voice, its sentence breaks, "then" for →) ──
// Non-Latin scripts: [the script, its usual tag, the languages written in it (a device language among them is kept)].
const SCRIPTS = [
  ['Hangul', 'ko', ['ko']], ['Han', 'zh-CN', ['zh', 'yue', 'ja']], ['Cyrillic', 'ru', ['ru', 'uk', 'bg', 'sr', 'be', 'mk', 'kk', 'ky', 'mn', 'tg']],
  ['Arabic', 'ar', ['ar', 'fa', 'ur', 'ps', 'ug', 'ckb', 'sd']], ['Hebrew', 'he', ['he', 'iw', 'yi']], ['Greek', 'el', ['el']],
  ['Devanagari', 'hi', ['hi', 'mr', 'ne', 'sa']], ['Bengali', 'bn', ['bn', 'as']], ['Thai', 'th', ['th']], ['Tamil', 'ta', ['ta']],
  ['Telugu', 'te', ['te']], ['Kannada', 'kn', ['kn']], ['Malayalam', 'ml', ['ml']], ['Gujarati', 'gu', ['gu']], ['Gurmukhi', 'pa', ['pa']],
  ['Georgian', 'ka', ['ka']], ['Armenian', 'hy', ['hy']], ['Khmer', 'km', ['km']], ['Lao', 'lo', ['lo']], ['Myanmar', 'my', ['my']],
  ['Sinhala', 'si', ['si']], ['Ethiopic', 'am', ['am', 'ti']],
].map(([script, tag, langs]) => ({ re: new RegExp(`\\p{Script=${script}}`, 'u'), tag, langs }));
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u, LATIN = /\p{Script=Latin}/u;
const HAN = SCRIPTS.find((x) => x.tag === 'zh-CN'), JA = { tag: 'ja', langs: ['ja'] }, DENSE = new Set([HAN, JA, SCRIPTS[0]]);
// Latin-script languages told apart by their commonest short words (only when one clearly leads).
const LATIN_WORDS = Object.entries({
  en: 'the and of to is in that it for you with on are this be was have not your can',
  es: 'el la de que y en los se del las por un una para con es no lo como más',
  fr: 'le la les de des et est un une que qui pour dans pas sur au vous ce avec',
  de: 'der die das und ist nicht ein eine zu mit den von sie es auf ich für dem',
  it: 'il la di che e un una per non sono del della con è le gli si come anche',
  pt: 'o a os as de que e do da em um uma para não com é se mais por como',
  nl: 'de het een en van is dat niet op te zijn met voor die je ook maar',
}).map(([tag, w]) => [tag, new Set(w.split(' '))]);
const baseOf = (tag) => String(tag || '').toLowerCase().split(/[-_]/)[0];
const latinLang = (base) => !SCRIPTS.some((s) => s.langs.includes(base));
function guessLatin(text) {
  const score = new Map();
  for (const w of text.slice(0, 4_000).toLowerCase().match(/\p{L}+/gu) || []) for (const [tag, set] of LATIN_WORDS) if (set.has(w)) score.set(tag, (score.get(tag) || 0) + 1);
  const [a, b] = [...score].sort((x, y) => y[1] - x[1]);
  return a && a[1] >= 3 && a[1] >= 1.5 * (b?.[1] || 0) ? a[0] : null;
}
/**
 * The BCP 47 tag to read `text` in: its dominant script decides (the device language `fallback` is kept when it is
 * written in that script, so zh-TW or uk-UA stay as they are); Latin text keeps the device language unless its common
 * words clearly say English, Spanish, French, German, Italian, Portuguese or Dutch instead.
 */
export function textLang(text, fallback = 'en') {
  const s = String(text ?? ''), base = baseOf(fallback);
  let latin = 0, kana = 0, best = null, top = 0;
  const counts = new Map();
  for (const ch of s) {
    if (LATIN.test(ch)) { latin++; continue; }
    if (!/\p{L}/u.test(ch)) continue;
    if (KANA.test(ch)) { kana++; continue; }
    const sc = SCRIPTS.find((x) => x.re.test(ch));
    if (sc) counts.set(sc, (counts.get(sc) || 0) + 1);
  }
  if (kana) { counts.set(JA, (counts.get(HAN) || 0) + kana); counts.delete(HAN); } // kana with kanji: Japanese
  for (const [sc, n] of counts) if (n > top) { top = n; best = sc; }
  // A CJK character carries about a word: weigh it against Latin letters accordingly.
  if (best && top * (DENSE.has(best) ? 4 : 1) > latin) return best.langs.includes(base) ? fallback : best.tag;
  const guess = guessLatin(s);
  if (guess) return guess === base ? fallback : guess;
  return latinLang(base) ? fallback : 'en';
}

// ── segments: short first, then paragraph-sized ──
const SEGMENTERS = new Map();
function segmenter(lang) {
  if (SEGMENTERS.has(lang)) return SEGMENTERS.get(lang);
  let s = null;
  if (typeof Intl?.Segmenter === 'function') for (const l of [lang, undefined]) { try { s = new Intl.Segmenter(l, { granularity: 'sentence' }); break; } catch {} }
  SEGMENTERS.set(lang, s);
  return s;
}
// Without Intl.Segmenter: a break after . ! ? … (and closing quotes) only before a space, so 2.5 and example.com stay
// whole; after 。！？ no space is needed.
const FALLBACK_BREAK = /(?<=[.!?…]+["'”’)\]]*)\s+|(?<=[。！？]+["'”’)\]」』]*)(?![。！？"'”’)\]」』])/u;
// Units that end in a title, an abbreviation or initials ("Dr.", "U.S.", "e.g.") aren't sentence ends.
const CJK_END = /[。！？；：，、」』）]$/;
const ABBR = /(?:^|[\s("'“‘])(?:Mr|Mrs|Ms|Mx|Dr|Prof|Sr|Jr|St|Mt|Ft|Gen|Col|Lt|Sgt|Capt|Cmdr|Adm|Rev|Hon|Gov|Sen|Rep|Pres|Inc|Ltd|Co|Corp|Bros|vs|etc|approx|est|dept|Fig|fig|figs|No|Nos|no|Vol|vol|pp|ch|Ch|Sec|sec|Eq|eq|Ex|ex|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|al|cf|ca|e\.g|i\.e|a\.m|p\.m)\.$|(?:^|[\s("'“‘])(?:\p{Lu}\.)+$/u;
function sentencesOf(p, lang) {
  const seg = segmenter(lang);
  const list = (seg ? Array.from(seg.segment(p), (x) => x.segment) : p.split(FALLBACK_BREAK)).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const s of list) { // join a unit to the one before when that one ends in an abbreviation, or this one starts in lower case or a digit
    if (out.length && (ABBR.test(out.at(-1)) || /^[\p{Ll}\d]/u.test(s))) out[out.length - 1] += `${CJK_END.test(out.at(-1)) ? '' : ' '}${s}`;
    else out.push(s);
  }
  return out;
}
// The number of chars of `s` that fit in n spoken units (never splitting a surrogate pair).
function unitsIndex(s, n) {
  let u = 0, i = 0;
  for (const ch of s) { const w = spokenUnits(ch); if (u + w > n) break; u += w; i += ch.length; }
  return i;
}
// → [head, rest] with head at most n spoken units: at the last clause break (; , : — and CJK ，、；：) past halfway,
// else the last space, else hard.
function cutAt(s, n) {
  if (spokenUnits(s) <= n) return [s, ''];
  const m = Math.max(1, unitsIndex(s, n)), win = s.slice(0, m + 1), fit = s.slice(0, m);
  const clause = Math.max(...[';', ',', ':', '—', '–'].map((c) => win.lastIndexOf(`${c} `)), ...['，', '、', '；', '：'].map((c) => fit.lastIndexOf(c)));
  const space = win.lastIndexOf(' ');
  let at = clause >= m / 2 ? clause + 1 : space > 0 ? space : m;
  if (at === m && /[\ud800-\udbff]/.test(s[m - 1])) at--; // never split a surrogate pair
  return [s.slice(0, at).trim(), s.slice(at).trim()];
}
function splitLong(s, n) {
  const out = [];
  while (spokenUnits(s) > n) {
    const [a, b] = cutAt(s, n);
    if (!a || b.length >= s.length) break;
    out.push(a); s = b;
  }
  if (s) out.push(s);
  return out;
}

/**
 * Plain text → the pieces sent to /api/tts one at a time, sized in spoken units (spokenUnits). The first is one or two
 * sentences of at most `first` (220) units so sound starts fast (a sentence under 15 characters doesn't count toward
 * the two); later ones pack sentences up to `target` (900, under the tester cap of 1,000), closing at a paragraph end
 * once past 60% of it. An over-long sentence splits at ; , : — (or ，、；：) or a space, never mid-word.
 */
export function segments(text, lang = 'en', { first = READ_LIMITS.first, target = READ_LIMITS.target } = {}) {
  const parts = [];
  for (const p of String(text ?? '').split(/\n\s*\n/)) {
    const ss = sentencesOf(p.replace(/\s+/g, ' ').trim(), lang).flatMap((s) => splitLong(s, target));
    ss.forEach((s, i) => parts.push({ s, w: spokenUnits(s), end: i === ss.length - 1 }));
  }
  const lead = parts[0];
  if (lead && lead.w > first) {
    const [a, b] = cutAt(lead.s, first);
    parts.splice(0, 1, { s: a, w: spokenUnits(a), end: !b && lead.end }, ...(b ? [{ s: b, w: spokenUnits(b), end: lead.end }] : []));
  }
  const out = [];
  let cur = '', cw = 0, count = 0, sep = ' ';
  for (const { s, w, end } of parts) {
    const glue = sep === ' ' && CJK_END.test(cur) ? '' : sep; // CJK sentences run on without a space
    const nw = cur ? cw + glue.length + w : w, counts = s.length >= SHORT_SENTENCE ? 1 : 0;
    if (cur && (nw > (out.length ? target : first) || (!out.length && count >= 2))) { out.push(cur); cur = s; cw = w; count = counts; }
    else { cur = cur ? cur + glue + s : s; cw = nw; count += counts; }
    sep = end ? '\n' : ' ';
    if (end && out.length && cw >= target * 0.6) { out.push(cur); cur = ''; cw = 0; count = 0; }
  }
  if (cur) out.push(cur);
  return out;
}

// ── device voice and cache helpers ──
const GOOD_VOICE = /natural|neural|premium|enhanced|online/i;
// macOS/iOS novelty and robotic voices: never the pick when anything else speaks the language.
const ODD_VOICE = /^(albert|bad news|bahh|bells|boing|bubbles|cellos|eddy|flo|fred|good news|grandma|grandpa|jester|junior|kathy|organ|ralph|reed|rocko|sandy|shelley|superstar|trinoids|whisper|wobble|zarvox)\b/i;
/** The device voice that sounds best for `lang`: same language first, Natural/Neural/Premium/Enhanced names preferred. */
export function pickDeviceVoice(voices, lang = 'en-US') {
  const want = String(lang || 'en').toLowerCase().replace(/_/g, '-'), base = want.split('-')[0];
  let best = null, top = -Infinity;
  for (const v of voices || []) {
    const vl = String(v?.lang || '').toLowerCase().replace(/_/g, '-');
    if (vl.split('-')[0] !== base) continue;
    const score = (vl === want ? 3 : 0) + (GOOD_VOICE.test(v.name) ? 6 : 0) - (ODD_VOICE.test(v.name) ? 8 : 0) + (v.default ? 1 : 0) + (v.localService ? 0.5 : 0);
    if (score > top) { top = score; best = v; }
  }
  return best;
}

const fnv = (bytes) => [0x811c9dc5, 0x01000193 ^ 0x5bd1e995].map((h) => { for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0; return h.toString(16).padStart(8, '0'); }).join('');
/** The Cache Storage key of one clip: '/__tts/' + SHA-256 of brief version, voice id and the exact segment text. */
export async function cacheKey(voice, text, v = TTS_BRIEF_V) {
  const data = new TextEncoder().encode(`v${v}|${voice}|${text}`), subtle = globalThis.crypto?.subtle;
  const hex = subtle ? Array.from(new Uint8Array(await subtle.digest('SHA-256', data)), (b) => b.toString(16).padStart(2, '0')).join('') : fnv(data);
  return `/__tts/${hex}`;
}
export const previewKey = (voice, v = TTS_BRIEF_V, id = PREVIEW_ID) => `/__tts/preview/v${v}/${id}/${voice}`;
/** LRU index [[key, bytes], …] (oldest first) after adding key → {list, evicted: keys to delete}. The newest always stays. */
export function lruAdd(list, key, bytes, cap = CACHE_CAP) {
  const next = (Array.isArray(list) ? list : []).filter((e) => Array.isArray(e) && e[0] !== key).concat([[key, Math.max(0, Number(bytes) || 0)]]);
  let total = next.reduce((n, e) => n + (Number(e[1]) || 0), 0);
  const evicted = [];
  while (next.length > 1 && (next.length > cap.clips || total > cap.bytes)) { const [k, b] = next.shift(); evicted.push(k); total -= Number(b) || 0; }
  return { list: next, evicted };
}
export const lruTouch = (list, key) => { const i = list.findIndex((e) => e[0] === key); return i < 0 ? list : [...list.slice(0, i), ...list.slice(i + 1), list[i]]; };
// 0.1 s of 8 kHz silence: played inside the tap so iOS lets this element play later clips without a new gesture.
let silence = '';
export function silentWav(samples = 800) {
  if (silence && samples === 800) return silence;
  const b = new Uint8Array(44 + samples), v = new DataView(b.buffer), tag = (at, s) => { for (let i = 0; i < 4; i++) b[at + i] = s.charCodeAt(i); };
  tag(0, 'RIFF'); v.setUint32(4, 36 + samples, true); tag(8, 'WAVE'); tag(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); tag(36, 'data'); v.setUint32(40, samples, true);
  b.fill(128, 44); // 8-bit PCM silence
  const url = `data:audio/wav;base64,${btoa(String.fromCharCode(...b))}`;
  if (samples === 800) silence = url;
  return url;
}

// ── the player ──
const failure = (code, status, extra) => Object.assign(new Error(code), { tts: true, code, status, ...extra });
const tagOf = (t) => { try { return typeof t === 'string' && t ? Intl.getCanonicalLocales(t)[0] : null; } catch { return null; } };
const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('Aborted', 'AbortError')); }, { once: true });
});
const bufferedEnd = (x) => { try { const b = x?.buffered; return b?.length ? b.end(b.length - 1) : 0; } catch { return 0; } };
const ACTIONS = ['play', 'pause', 'stop', 'seekbackward', 'seekforward', 'previoustrack', 'nexttrack'];
const IDX = 'atelier.ttsIndex', NOTED = 'atelier.ttsNoted';
// Clips kept in memory for instant replay: at most this many, and this many bytes (a Sulafat WAV is ~2.9 MB a minute).
const MEMO_MAX = 40, MEMO_BYTES = 24 * 1024 * 1024;
const AHEAD = 2; // segments requested past the one being heard
const aborted = () => new DOMException('Aborted', 'AbortError');

/**
 * The read-aloud player. One read at a time; states per entry id: 'idle' | 'preparing' | 'playing' | 'paused',
 * reported through onState(id, state) (previews use the id 'preview:<voiceId>').
 * opts: apiHeaders() (app.js's, adds x-app-pass), getSettings() → settings.readAloud, isTester(), toast(msg, {error}),
 *   onState, fetch; optional: allowedVoices() → AI voice ids this account may use (null = all, [] = device only),
 *   signedIn() → false when no AI voice can be asked for at all (no passcode and no tester session: the device voice
 *   reads and SAY.passcode says why, with no request), onResponse(r) for every /api/tts response (x-tester-allowance),
 *   onRefusal(err, {preview}) for tester refusals ({status, code, scope, resetsAt, error}; the reader then reads with the
 *   device voice without its own toast, or for a preview just stops), onSignedOut(err) when a tester's /api/tts answers
 *   401 (the session has ended: the app may sign them out, and if that stops the read the reader says nothing more),
 *   lang() → BCP 47.
 * Test seams (default to the browser's): Audio, URL, speech, Utterance, caches, storage, mediaSession,
 *   MediaMetadata, online(), stallMs.
 * → {toggle(id, markdown, button?, {title, album, lang}?), stop(), pause(), resume(), stateFor(id), preview(voiceId),
 *    setSpeed(x), clearCache()}. toggle() and preview() must be called straight from the tap (no await before them).
 */
export function createReader(opts = {}) {
  const g = globalThis, has = (k) => k in opts;
  const { apiHeaders, getSettings, isTester, onState, onResponse, onRefusal, onSignedOut, allowedVoices, signedIn } = opts;
  const toast = opts.toast || (() => {});
  const doFetch = opts.fetch || ((...a) => g.fetch(...a));
  const AudioCtor = opts.Audio || g.Audio, URLs = opts.URL || g.URL;
  const speech = has('speech') ? opts.speech : g.speechSynthesis, Utterance = opts.Utterance || g.SpeechSynthesisUtterance;
  const store = has('caches') ? opts.caches : g.caches, session = has('mediaSession') ? opts.mediaSession : g.navigator?.mediaSession;
  const Meta = opts.MediaMetadata || g.MediaMetadata, stallMs = opts.stallMs ?? 1500;
  const online = opts.online || (() => g.navigator?.onLine !== false);
  const langOf = opts.lang || (() => g.navigator?.language || g.document?.documentElement?.lang || 'en');
  let ls = null;
  try { ls = has('storage') ? opts.storage : g.localStorage; } catch {}
  const lsGet = (k) => { try { return ls?.getItem(k) ?? null; } catch { return null; } };
  const lsSet = (k, v) => { try { v == null ? ls?.removeItem(k) : ls?.setItem(k, v); } catch {} };

  let el = null, job = null, generation = 0, opened = null, spoke = false, toldPlan = false, toldPass = false, memoBytes = 0;
  const memo = new Map(), ctrls = new Set();
  speech?.getVoices?.(); // Chrome loads its voice list on first ask

  // ── state ──
  function set(j, state) {
    if (j.state === state) return;
    j.state = state;
    if (j.button?.dataset) j.button.dataset.read = state;
    if (session && !j.dead && !j.preview && j.mode !== 'device') { try { session.playbackState = state === 'playing' ? 'playing' : state === 'paused' ? 'paused' : 'none'; } catch {} }
    try { onState?.(j.id, state); } catch (err) { console.error(err); }
  }
  function newJob(id, voice, segs, o = {}) {
    const ctrl = new AbortController();
    ctrls.add(ctrl);
    return job = { id, voice, segs, lang: o.lang || langOf(), speed: o.speed ?? 1, button: o.button || null, meta: o.meta || null, preview: Boolean(o.preview),
      mode: null, state: 'idle', recs: [], cur: -1, turn: 0, line: 0, lines: [], pending: 0, ctrl, gen: generation, dead: false };
  }
  // Ends a read (stopped or finished). Clips already being fetched finish into the cache: a tester is then settled at
  // the real cost rather than the full reservation, and a replay is instant. Nothing new is requested.
  function end(j) {
    if (!j || j.dead) return;
    j.dead = true;
    if (job === j) job = null;
    clearTimeout(j.guard); j.token = null;
    if (j.mode === 'device') { try { speech?.cancel(); } catch {} }
    quiet(j);
    if (!j.preview) clearSession();
    if (!j.pending) ctrls.delete(j.ctrl);
    set(j, 'idle');
  }
  // Silences the element for this read. Callers set j.mode first, so a 'pause' event from here is never taken for
  // the listener pausing.
  function quiet(j) {
    if (el && j.audio) { j.audio = false; try { el.pause(); el.removeAttribute('src'); el.load(); } catch {} }
    if (j.url) { try { URLs.revokeObjectURL(j.url); } catch {} j.url = null; }
  }

  // ── the <audio> element: one for the page's life (WebKit and Chromium remember a gesture unlock per element) ──
  function element() {
    if (el) return el;
    el = new AudioCtor();
    el.preload = 'auto';
    el.addEventListener('playing', () => {
      const j = job;
      if (!j || j.dead || j.mode === 'device' || (j.mode === 'blob' && (j.cur < 0 || j.waiting))) return; // the silent unlock clip
      if (j.state !== 'playing') set(j, 'playing');
    });
    el.addEventListener('pause', () => { // headphones out, a call, the lock-screen button
      const j = job;
      if (j && !j.dead && j.mode !== 'device' && j.state === 'playing' && !el.ended && !j.waiting && !(j.mode === 'blob' && j.cur < 0)) set(j, 'paused');
    });
    el.addEventListener('ended', () => {
      const j = job;
      if (!j || j.dead || j.mode === 'device') return;
      if (j.cur < 0 || j.waiting) return;
      return j.cur + 1 < j.segs.length ? playSeg(j, j.cur + 1) : end(j);
    });
    el.addEventListener('error', () => {
      const j = job;
      if (!j || j.dead || j.mode === 'device' || (j.mode === 'blob' && (j.cur < 0 || j.waiting))) return;
      fail(j, failure('media', 0), j.cur);
    });
    return el;
  }
  const rate = (j) => { el.defaultPlaybackRate = el.playbackRate = j.speed; if ('preservesPitch' in el) el.preservesPitch = true; };
  function play(j, silent = false) {
    let p;
    try { p = el.play(); } catch (err) { p = Promise.reject(err); }
    p?.catch?.((err) => {
      if (silent || j !== job || j.dead || err?.name !== 'NotAllowedError') return; // AbortError: the source changed
      j.stalled = true; set(j, 'paused'); toast(SAY.resume);
    });
  }
  // iOS 26 home-screen apps can resolve play() and stay silent: if time hasn't moved, set the source again once, then
  // ask for a tap.
  function guard(j) {
    clearTimeout(j.guard);
    const t0 = el.currentTime, i = j.cur;
    j.guard = setTimeout(() => {
      if (j !== job || j.dead || j.state !== 'playing' || j.cur !== i || j.waiting || el.ended || el.currentTime > t0 + 0.05) return;
      if (!j.retried) { j.retried = true; el.src = j.url; rate(j); play(j); return guard(j); }
      j.stalled = true; el.pause(); set(j, 'paused'); toast(SAY.resume);
    }, stallMs);
  }

  // ── fetching clips: memory → Cache Storage → POST /api/tts ──
  function headers() {
    const h = new Headers(typeof apiHeaders === 'function' ? apiHeaders() : apiHeaders || {});
    h.set('content-type', 'application/json');
    return h;
  }
  async function request(j, body) {
    for (let attempt = 0; ; attempt++) {
      if (j.dead) throw aborted(); // stopped before this clip was asked for (or while waiting to ask again): never sent
      if (!online()) throw failure('offline', 0);
      let r;
      try { r = await doFetch('/api/tts', { method: 'POST', headers: headers(), body: JSON.stringify(body), signal: j.ctrl.signal }); }
      catch (err) { if (err?.name === 'AbortError') throw err; throw failure('network', 0); }
      try { onResponse?.(r); } catch {}
      if (r.ok && /^audio\//i.test(r.headers.get('content-type') || '')) return r;
      const info = (r.ok ? null : await r.json().catch(() => null)) || {}, wait = Number(r.headers.get('retry-after'));
      if (r.status === 429 && !attempt && !j.dead && !(wait > 4)) { await sleep(Math.max(0.5, wait || 1) * 1000, j.ctrl.signal); continue; }
      throw failure(typeof info.code === 'string' ? info.code : 'http', r.ok ? 502 : r.status, { error: info.error, scope: info.scope, resetsAt: info.resetsAt });
    }
  }
  function load(j, i) {
    if (j.recs[i]) return j.recs[i];
    const rec = j.recs[i] = { chunks: [], done: false, error: null };
    j.pending++;
    // Keys (SHA-256) and Cache Storage lookups finish in any order: chained per read, so requests go out in reading order.
    const look = j.look = (j.look || Promise.resolve()).catch(() => {}).then(async () => {
      const key = j.preview ? previewKey(j.voice) : await cacheKey(j.voice, j.segs[i]);
      return { key, hit: recall(key) || await cached(key) };
    });
    rec.whole = (async () => {
      const { key, hit } = await look;
      if (hit) return hit;
      const r = await request(j, j.preview ? { voice: j.voice, preview: true } : { voice: j.voice, text: j.segs[i] });
      try {
        if (r.body?.getReader) {
          const rd = r.body.getReader();
          for (;;) { const { done, value } = await rd.read(); if (done) break; if (value?.byteLength) rec.chunks.push(value); }
        } else rec.chunks.push(new Uint8Array(await r.arrayBuffer()));
      } catch (err) { // the provider failed after the 200 (src/tts.js then errors the body) or the connection dropped
        if (err?.name === 'AbortError') throw err;
        throw failure('stream', 502);
      }
      const blob = new Blob(rec.chunks, { type: (r.headers.get('content-type') || 'audio/wav').split(';')[0] });
      rec.chunks = []; // the blob holds the clip now
      if (!blob.size) throw failure('empty', 502);
      keep(key, blob, j.gen);
      return blob;
    })();
    rec.whole.then(() => { rec.done = true; }, (err) => { rec.error = err; }).finally(() => {
      if (!--j.pending && j.dead) ctrls.delete(j.ctrl);
    });
    return rec;
  }
  const prefetch = (j, i) => { for (let k = i + 1; k <= i + AHEAD && k < j.segs.length; k++) if (!j.dead) load(j, k); };
  // Lets go of finished clips before segment `upto` (memory, Cache Storage or a new request bring one back if needed).
  function release(j, upto) {
    for (let k = 0; k < upto; k++) { const r = j.recs[k]; if (r && (r.done || r.error)) j.recs[k] = undefined; }
  }
  function bucket() {
    if (!store?.open) return Promise.resolve(null);
    return opened ||= (async () => {
      // A lost index (cleared site data) can't evict what is in the bucket: start the bucket over.
      if (lsGet(IDX) == null) { await store.delete(TTS_CACHE); lsSet(IDX, '[]'); }
      return store.open(TTS_CACHE);
    })().catch(() => null);
  }
  const readIndex = () => { try { const v = JSON.parse(lsGet(IDX) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
  async function cached(key) {
    try {
      const c = await bucket(), r = await c?.match(key);
      if (!r) return null;
      lsSet(IDX, JSON.stringify(lruTouch(readIndex(), key)));
      return await r.blob();
    } catch { return null; }
  }
  // The memory copy of a clip (most recently used last), or null.
  function recall(key) {
    const b = memo.get(key);
    if (b) { memo.delete(key); memo.set(key, b); }
    return b || null;
  }
  function keep(key, blob, gen) {
    if (gen !== generation) return; // the cache was cleared while this clip was on its way
    const old = memo.get(key);
    if (old) { memoBytes -= old.size; memo.delete(key); }
    memo.set(key, blob); memoBytes += blob.size;
    while (memo.size > 1 && (memo.size > MEMO_MAX || memoBytes > MEMO_BYTES)) { const [k, b] = memo.entries().next().value; memo.delete(k); memoBytes -= b.size; }
    bucket().then(async (c) => {
      if (!c || gen !== generation) return;
      await c.put(key, new Response(blob, { headers: { 'content-type': blob.type || 'audio/wav' } }));
      const { list, evicted } = lruAdd(readIndex(), key, blob.size);
      lsSet(IDX, JSON.stringify(list));
      await Promise.all(evicted.map((k) => c.delete(k)));
    }).catch(() => {});
  }

  // ── one blob per segment (a whole Gemini WAV each), played in turn on the one <audio> element ──
  async function playSeg(j, i) {
    if (j !== job || j.dead || j.mode !== 'blob') return;
    const turn = ++j.turn;
    j.waiting = true;
    const rec = load(j, i);
    prefetch(j, i);
    let blob;
    try { blob = await rec.whole; } catch (err) { if (turn === j.turn) fail(j, err, i); return; }
    if (j !== job || j.dead || j.mode !== 'blob' || turn !== j.turn) return;
    if (j.url) URLs.revokeObjectURL(j.url);
    j.url = URLs.createObjectURL(blob);
    Object.assign(j, { cur: i, waiting: false, stalled: false, retried: false });
    release(j, i - 1);
    el.src = j.url; // set just before play(): it also helps WebKit 295518
    rate(j);
    if (j.state !== 'paused') { play(j); guard(j); }
  }

  // ── the device voice: one utterance per sentence (also the fallback for every AI-voice failure) ──
  function device(j, from = 0) {
    if (j !== job || j.dead || j.mode === 'device') return;
    if (!speech || typeof Utterance !== 'function') { toast(SAY.unsupported, { error: true }); return end(j); }
    const was = j.mode;
    Object.assign(j, { mode: 'device', line: 0 });
    if (was) { quiet(j); if (!j.preview) clearSession(); }
    j.lines = j.segs.slice(from).flatMap((s) => sentencesOf(s, j.lang)).flatMap((s) => splitLong(s, READ_LIMITS.deviceLine));
    if (j.state === 'idle') set(j, 'preparing');
    const voices = () => { try { return speech.getVoices?.() || []; } catch { return []; } };
    const go = () => { if (j.go) return; j.go = true; j.voiceObj = pickDeviceVoice(voices(), j.lang); say(j); };
    if (voices().length || typeof speech.addEventListener !== 'function') return go();
    speech.addEventListener('voiceschanged', go, { once: true }); // Chrome fills the list late; iOS has it at once
    setTimeout(go, 800);
  }
  function say(j) {
    if (j !== job || j.dead || j.mode !== 'device' || j.state === 'paused') return;
    if (j.line >= j.lines.length) return end(j);
    const u = new Utterance(j.lines[j.line]), token = j.token = {};
    u.lang = j.lang; u.rate = DEVICE_RATE * j.speed;
    if (j.voiceObj) u.voice = j.voiceObj;
    u.onend = () => { if (j.token === token) { j.line++; say(j); } };
    u.onerror = (ev) => { // interrupted/canceled come only from our own cancel(), which clears the token first
      if (j.token !== token) return;
      if (ev?.error === 'not-allowed') { j.token = null; set(j, 'paused'); return toast(SAY.resume); }
      j.line++; say(j);
    };
    speech.speak(u);
    if (j.state === 'preparing') set(j, 'playing');
  }

  // ── failures: say why gently, then let the device voice read the rest ──
  // → a SAY key, or '' when the app has said it (onRefusal). A tester's 401 also tells the app (onSignedOut).
  function why(err, preview) {
    const s = err?.status, code = err?.code || '';
    if (code === 'offline' || !online()) return 'offline';
    if (code === 'owner_only' || code === 'tester_model') return 'plan';
    if (s === 401 || code === 'tester_signin') {
      if (!isTester?.()) return 'passcode';
      try { onSignedOut?.(err); } catch (e) { console.error(e); }
      return 'signin';
    }
    if (s === 402 || code.startsWith('tester_')) {
      if (!onRefusal) return 'budget';
      try { onRefusal(err, { preview: Boolean(preview) }); } catch (e) { console.error(e); }
      return '';
    }
    return s === 429 ? 'busy' : 'down';
  }
  function fail(j, err, i) {
    if (j !== job || j.dead || j.mode === 'device' || err?.name === 'AbortError') return; // the device voice already reads it
    if (!err?.tts || err.status >= 500 || err.status === 400 || err.status === 413) console.warn('[atelier] read aloud:', err?.status ?? '', err?.code || err);
    const k = why(err, j.preview);
    if (j.dead) return; // the app ended the read (a tester whose session ended is signed out): nothing more to say
    // A preview has nothing to fall back on: say why it didn't play (never "reading with the device voice") and stop.
    if (j.preview) { if (k) toast(SAY[PREVIEW_SAY[k] || 'previewFailed']); return end(j); }
    const msg = k && SAY[k];
    if (msg) toast(msg);
    device(j, i);
  }

  // ── Media Session: lock screen, headphones, car controls ──
  function bindSession(j) {
    if (!session) return;
    try { if (typeof Meta === 'function') session.metadata = new Meta({ title: String(j.meta?.title || 'Answer').slice(0, 60), artist: 'Atelier · Read aloud', album: String(j.meta?.album || '').slice(0, 80), artwork: ARTWORK }); } catch {}
    const h = { play: resume, pause, stop, seekbackward: () => seek(-10), seekforward: () => seek(10), previoustrack: () => track(-1), nexttrack: () => track(1) };
    for (const a of ACTIONS) { try { session.setActionHandler(a, h[a]); } catch {} } // unsupported actions throw
  }
  function clearSession() {
    if (!session) return;
    try { session.metadata = null; session.playbackState = 'none'; } catch {}
    for (const a of ACTIONS) { try { session.setActionHandler(a, null); } catch {} }
  }
  function seek(d) {
    const j = job;
    if (!j || j.dead || j.mode === 'device' || !el) return;
    const top = (Number.isFinite(el.duration) ? el.duration : bufferedEnd(el)) - 0.1;
    el.currentTime = Math.max(0, Math.min(el.currentTime + d, top));
  }
  function track(step) {
    const j = job;
    if (!j || j.dead || j.mode === 'device') return;
    const i = j.cur + step;
    if (i >= 0 && i < j.segs.length) playSeg(j, i);
  }

  // ── public ──
  function pause() {
    const j = job;
    if (!j || j.dead || j.state === 'paused') return;
    set(j, 'paused');
    if (j.mode === 'device') { j.token = null; try { speech.cancel(); } catch {} } // resume() restarts the sentence
    else el?.pause();
  }
  function resume() {
    const j = job;
    if (!j || j.dead || j.state !== 'paused') return;
    if (j.mode === 'blob' && j.cur < 0) return set(j, 'preparing'); // the first clip plays as soon as it arrives
    set(j, 'playing');
    if (j.mode === 'device') return say(j);
    if (j.mode === 'blob' && j.waiting) return; // so does the next one
    if (j.stalled && j.url) { j.stalled = false; el.src = j.url; rate(j); }
    play(j);
    if (j.mode === 'blob') { j.retried = false; guard(j); }
  }
  // Which voice reads this, and why not the one asked for (a toast line, or '' to stay quiet).
  function choose(want) {
    if (want === 'device') return { voice: 'device', note: '' };
    if (!online()) return { voice: 'device', note: SAY.offline };
    if (signedIn && !signedIn()) { // no passcode, no tester session: a request would only come back 401
      const note = toldPass ? '' : SAY.passcode;
      toldPass = true;
      return { voice: 'device', note };
    }
    toldPass = false; // said again should the passcode go once more
    const voice = voiceFor(want, allowedVoices?.());
    if (voice !== 'device') return { voice, note: '' };
    const note = toldPlan ? '' : SAY.plan;
    toldPlan = true;
    return { voice: 'device', note };
  }
  // Runs inside the tap: the element is attached and play() is called before anything is awaited.
  function startAi(j) {
    const E = element();
    j.audio = true;
    rate(j);
    j.mode = 'blob'; E.src = silentWav();
    play(j, true);
    if (!spoke && speech && typeof Utterance === 'function') { // let a later device-voice fallback speak on iOS too
      spoke = true;
      try { const u = new Utterance(' '); u.volume = 0; speech.speak(u); } catch {}
    }
    set(j, 'preparing');
    playSeg(j, 0);
  }
  function toggle(id, markdown, button, meta) {
    const cur = job;
    if (cur && cur.id === id) {
      if (cur.state === 'playing') return pause();
      if (cur.state === 'paused') return resume();
      return stop(); // a tap while preparing cancels
    }
    stop();
    const prefs = normalizeReadAloud(getSettings?.()), max = isTester?.() ? READ_LIMITS.tester : READ_LIMITS.owner;
    // The answer's own language (app.js may pass the thread's as meta.lang), else what its script and words say.
    const hint = tagOf(meta?.lang), pref = hint || langOf();
    let text = speakable(markdown, { lang: pref, max });
    const lang = hint || textLang(text, pref);
    if (english(lang) !== english(pref)) text = speakable(markdown, { lang, max });
    const segs = segments(text, lang);
    if (!segs.length) return toast(SAY.nothing);
    const pick = choose(prefs.voice);
    const j = newJob(id, pick.voice, segs, { lang, speed: prefs.speed, button, meta });
    if (pick.voice === 'device') { if (pick.note) toast(pick.note); return device(j, 0); }
    startAi(j);
    bindSession(j);
    if (lsGet(NOTED) == null) { toast(SAY.first); lsSet(NOTED, '1'); } // listeners are told once that it's an AI voice
  }
  function stop() { end(job); }
  function preview(voiceId) {
    const id = `preview:${voiceId}`;
    if (job?.id === id) return stop(); // a second tap stops it
    stop();
    if (!VOICE.has(voiceId)) return;
    const speed = normalizeReadAloud(getSettings?.()).speed;
    if (voiceId === 'device') return device(newJob(id, 'device', [DEVICE_PREVIEW], { speed, preview: true, lang: textLang(DEVICE_PREVIEW, langOf()) }), 0);
    if (!online()) return toast(SAY.previewOffline);
    // The same checks as a read (choose()), said for a preview: no request that can only be refused.
    if (signedIn && !signedIn()) return toast(SAY.previewPasscode);
    if (voiceFor(voiceId, allowedVoices?.()) !== voiceId) return toast(SAY.previewPlan);
    startAi(newJob(id, voiceId, ['(preview)'], { speed, preview: true }));
  }
  function setSpeed(x) {
    const s = normalizeReadAloud({ speed: x }).speed;
    if (!job) return;
    job.speed = s;
    if (job.mode && job.mode !== 'device' && el) rate(job); // the device voice picks it up at the next sentence
  }
  // Device wipe, tester sign-out or account change: no clip from this device's reads stays behind.
  async function clearCache() {
    stop();
    generation++;
    for (const c of ctrls) c.abort();
    ctrls.clear(); memo.clear(); memoBytes = 0; opened = null;
    lsSet(IDX, null);
    try { await store?.delete(TTS_CACHE); } catch {}
  }
  return { toggle, stop, pause, resume, stateFor: (id) => (job && job.id === id ? job.state : 'idle'), preview, setSpeed, clearCache };
}
