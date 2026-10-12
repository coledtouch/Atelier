// Cole's humanizer lint for Atelier's own copy (tests/humanizer-copy.test.mjs): a port of the mechanical rules in
// coleos-api/src/worker.js (HUMANIZER_BANNED, HUMANIZER_WARN and the 16-word sentence rule in postStyleProblems), plus
// the extractors that find the text a person reads: the visible text of an HTML page, and the user-visible strings of a
// module (toasts, errors, dialogs, labels, hints and the HTML templates the app builds; the Worker's error messages).
// scripts/sync-humanizer.mjs reports when the canonical patterns move away from these copies.

// ── the rules: copied from postStyleProblems (2026-10-11) ──
export const HUMANIZER_BANNED = /\b(pivotal|crucial(?:ly)?|enhanc(?:e|es|ed|ing|ements?)|underscor(?:e|es|ed|ing)|landscapes?(?! (?:mode|orientation|layout|view)\b)|vibran(?:t|cy)|testaments?|foster(?:s|ed|ing)?|delv(?:e|es|ed|ing)|showcas(?:e|es|ed|ing)|intricate(?:ly)?|intricacies|evolving|seamless(?:ly)?|tapestry|tapestries|transformative|groundbreaking|game[- ]chang(?:er|ers|ing)|paradigms?|realms?)\b/gi;
export const HUMANIZER_WARN = [
  [/\b(?:it|this|that)(?:'s| is| was)\s+not\b[^.?!]{0,80}?[,;:—–]\s*(?:it|this|that)(?:'s| is| was)\b/gi, "contrast structure (It's not X, it's Y)"],
  [/(?:\b(?:is|was|are|were)(?:n't| not)|'s not)\b[^.?!]{1,70}[.?!]\s+(?:it|they)(?:'s|'re| is| was| are| were)\b/gi, "contrast structure (It's not X. It's Y.)"],
  [/\bI can\b[^.?!]{1,80}[.?!]\s+I (?:cannot|can't|can not)\b/gi, "contrast structure (I can X. I cannot Y.)"],
  [/\bnot (?:just|only|merely|simply)\b/gi, "contrast structure (not just X)"],
  [/\b(?:despite|in spite of)\b/gi, "contrast structure (Despite this)"],
  [/(?:^|[.?!]\s+)(?:Not|No) [^.?!]{1,60}\.\s+(?:Not|No) [^.?!]{1,60}\./gim, "contrast structure (Not A. Not B.)"],
  [/,\s+not\s+(?!(?:coincidentally|surprisingly|to mention|least|counting|including|yet|always|all|much|so much|quite|once|necessarily|exactly)\b)\w[^,.;:?!—\n]{0,40}/gi, "contrast structure (X, not Y)"],
  [/\b(?:experts?|analysts?|observers|commentators|insiders|pundits|critics|sources)\s+(?:say|says|said|believe|warn|warned|argue|argued|note|noted|predict|suggest|expect|claim)\b|\breportedly\b|\bindustry (?:reports?|watchers|insiders)\b|\b(?:many|some) (?:\w+ )?(?:believe|say|argue|think)\b|\bstudies (?:show|suggest)\b/gi, "vague authority"],
  [/(?:^|[.?!]\s+)(?:(?:In conclusion|In summary|In short|To sum up|Ultimately|All in all|At the end of the day|In the end|The bottom line)\b|Overall,|The (?:takeaway|lesson)s?(?: here)?(?: (?:is|was)\b|:))|\b(?:two|three|four|five|six) stories,? one (?:pattern|thread|theme|lesson)\b/gim, "summary ending"],
  [/\b(?:the (?:broader|bigger|larger|wider) (?:picture|trend|story|lesson)|this (?:matters|is significant|is important) because|worth noting|a new era|sea change|watershed|inflection point|why (?:it|this) matters|(?:is|was) a reminder that)\b/gi, "importance sentence"],
];
export const MAX_WORDS = 16;

// humanizerSentences / humanizerWords: one block per line, split after . ? ! (and a closing quote or bracket).
export function sentences(text) {
  const out = [];
  for (const block of String(text).split('\n'))
    for (const s of block.split(/(?<=[.?!]["'”)]?)\s+/)) {
      const t = s.split(/\s+/).filter(Boolean).join(' ');
      if (t) out.push(t);
    }
  return out;
}
export const words = (s) => s.split(/\s+/).filter((w) => /\w/.test(w)).length;

// Curly quotes as straight ones (the patterns spell "it's" with ').
export const normalize = (s) => String(s).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/ /g, ' ');

/** One block of copy → [{rule: 'banned' | 'length' | <warn label>, text}]. */
export function problems(block) {
  const text = normalize(block), out = [];
  for (const m of text.matchAll(HUMANIZER_BANNED)) out.push({ rule: 'banned', text: m[0] });
  for (const [rx, label] of HUMANIZER_WARN) for (const m of text.matchAll(rx)) out.push({ rule: label, text: m[0].trim().replace(/\s+/g, ' ') });
  for (const s of sentences(text)) if (words(s) > MAX_WORDS) out.push({ rule: 'length', text: s, words: words(s) });
  return out;
}

// ── HTML: the text a person sees ──
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', mdash: '—', ndash: '–', middot: '·', hellip: '…', rarr: '→', larr: '←', times: '×', copy: '©', trade: '™', reg: '®', bull: '•' };
export const decode = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m));
// Tags that sit inside a sentence: removed (as a space). Every other tag ends a block.
const INLINE = /<\/?(?:a|b|strong|i|em|code|kbd|span|small|abbr|sup|sub|mark|u|s|q|time|br|wbr)\b[^>]*>/gi;
// The attributes a person reads or hears: tooltips, placeholders, alt text and screen-reader labels.
const SHOWN_ATTRS = /\s(title|placeholder|alt|aria-label)\s*=\s*"([^"]*)"/gi;
const SHOWN_META = /^(?:description|og:title|og:description|og:image:alt|twitter:title|twitter:description)$/i;

/** HTML (a page or an app template) → its blocks of visible text: text runs, then shown attributes and meta text. */
export function htmlText(html) {
  // Line breaks in the source are spaces (as humanizerPlain has them); only block tags end a block.
  let s = String(html).replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|svg|template)\b[\s\S]*?<\/\1\s*>/gi, ' ').replace(/\s*\n\s*/g, ' ');
  const attrs = [];
  for (const m of s.matchAll(/<meta\b[^>]*>/gi)) {
    const key = /\s(?:name|property)\s*=\s*"([^"]+)"/i.exec(m[0])?.[1] || '';
    const content = /\scontent\s*=\s*"([^"]*)"/i.exec(m[0])?.[1];
    if (SHOWN_META.test(key) && content) attrs.push(content);
  }
  for (const m of s.matchAll(/<[a-z][^>]*>/gi)) for (const a of m[0].matchAll(SHOWN_ATTRS)) attrs.push(a[2]);
  const text = s.replace(/<head\b[\s\S]*?<\/head\s*>/i, (h) => (/<title>([\s\S]*?)<\/title>/i.exec(h)?.[1] || '') + '\n')
    .replace(INLINE, ' ').replace(/<[^>]*>/g, '\n');
  return [...text.split('\n'), ...attrs].map((b) => decode(b).replace(/\s+/g, ' ').trim()).filter((b) => /\w/.test(b));
}

// ── a client module: every string literal, with the calls it sits inside ──
const KW = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await', 'if', 'while', 'for', 'const', 'let', 'var', 'export', 'import', 'from', 'default']);
const ESC = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };

/**
 * src → [{text, line, calls, direct, arg, prefix, template}]: each string or template literal, cooked. A ${…} reads as
 * the longest string in it (the branch with the most words: `${n ? ` in project ${n}` : ''}` reads " in project X"), or
 * "X" when it holds none. calls is the stack of functions whose argument list holds it (innermost last); direct is false
 * when a callback stands between it and that call (`on('click', () => { el.textContent = '…' })`), and arg is its
 * argument's index there. prefix is the source of its statement before it.
 */
export function literals(src) {
  const out = [], calls = [];
  // per open call: the function bodies open when it opened, whether an arrow function started in its arguments (and at
  // what bracket depth inside them), the bracket depth now, and how many arguments came before.
  const frames = [];
  let blocks = 0;
  const braces = []; // per open {: 'fn' (a function or statement body) or 'obj'
  const at = () => { const f = frames.at(-1); return f ? { direct: f.blocks === blocks && f.arrow < 0, arg: f.args } : { direct: true, arg: 0 }; };
  let prev = null; // the last significant token: { t: 'id' | 'kw' | 'num' | 'str' | 'p', v }
  const lineStarts = [0];
  for (let k = 0; k < src.length; k++) if (src[k] === '\n') lineStarts.push(k + 1);
  const lineOf = (pos) => { let lo = 0, hi = lineStarts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1; } return lo + 1; };
  const prefixOf = (pos) => { const before = src.slice(Math.max(0, pos - 240), pos); const cut = Math.max(before.lastIndexOf(';'), before.lastIndexOf('{'), before.lastIndexOf('}')); return before.slice(cut + 1); };
  const regexOk = () => !prev || (prev.t === 'kw' && prev.v !== 'this') || (prev.t === 'p' && !')]}'.includes(prev.v));
  const escape = (j) => { // src[j] === '\\' → [cooked, next index]
    const c = src[j + 1];
    if (c === 'u') { const m = /^u(?:\{([0-9a-f]+)\}|([0-9a-f]{4}))/i.exec(src.slice(j + 1, j + 12)); if (m) return [String.fromCodePoint(parseInt(m[1] || m[2], 16)), j + 1 + m[0].length]; }
    if (c === 'x') { const m = /^x([0-9a-f]{2})/i.exec(src.slice(j + 1, j + 4)); if (m) return [String.fromCharCode(parseInt(m[1], 16)), j + 4]; }
    if (c === '\n') return ['', j + 2];
    if (c === '\r') return ['', src[j + 2] === '\n' ? j + 3 : j + 2];
    return [ESC[c] ?? c, j + 2];
  };
  function quoted(i) {
    const q = src[i];
    let j = i + 1, text = '';
    while (j < src.length && src[j] !== q && src[j] !== '\n') { if (src[j] === '\\') { const [t, n] = escape(j); text += t; j = n; } else text += src[j++]; }
    out.push({ text, line: lineOf(i), calls: [...calls], ...at(), prefix: prefixOf(i), template: false });
    return j + 1;
  }
  function template(i) {
    const start = i, snapshot = [...calls], where = at();
    let j = i + 1, text = '', shape = ''; // shape: every ${…} as "X"
    while (j < src.length && src[j] !== '`') {
      if (src[j] === '\\') { const [t, n] = escape(j); text += t; shape += t; j = n; } else if (src[j] === '$' && src[j + 1] === '{') {
        const from = out.length;
        prev = { t: 'p', v: '{' }; j = scan(j + 2, true);
        // the longest string inside stands in for the expression: the branch that makes the longest sentence. Markup
        // stays "X": an element is usually a line of its own, and its text is linted as its own literal.
        const longest = out.slice(from).map((l) => l.text).filter((t) => /\w/.test(t)).sort((a, b) => b.length - a.length)[0];
        text += longest && !/<\/?[a-z][^>]*>/i.test(longest) ? longest : 'X';
        shape += 'X';
      } else { text += src[j]; shape += src[j++]; }
    }
    out.push({ text, shape, line: lineOf(start), calls: snapshot, ...where, prefix: prefixOf(start), template: true });
    return j + 1;
  }
  function regex(i) {
    let j = i + 1, cls = false;
    while (j < src.length && src[j] !== '\n') {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '[') cls = true; else if (c === ']') cls = false; else if (c === '/' && !cls) break;
      j++;
    }
    j++;
    while (/[a-z]/i.test(src[j] || '')) j++;
    return j;
  }
  function scan(i, inExpr) {
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') { const n = src.indexOf('\n', i); i = n < 0 ? src.length : n; continue; }
      if (c === '/' && src[i + 1] === '*') { const n = src.indexOf('*/', i + 2); i = n < 0 ? src.length : n + 2; continue; }
      if (c === "'" || c === '"') { i = quoted(i); prev = { t: 'str' }; continue; }
      if (c === '`') { i = template(i); prev = { t: 'str' }; continue; }
      if (c === '/') { if (regexOk()) { i = regex(i); prev = { t: 'str' }; } else { i++; prev = { t: 'p', v: '/' }; } continue; }
      if (/[A-Za-z_$]/.test(c)) { const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 80)); const v = m[0]; i += v.length; prev = KW.has(v) ? { t: 'kw', v } : { t: 'id', v }; continue; }
      if (/\d/.test(c)) { const m = /^[\d._a-fA-FxXnoObB]+/.exec(src.slice(i, i + 40)); i += m[0].length; prev = { t: 'num' }; continue; }
      if (/\s/.test(c)) { i++; continue; }
      const f = frames.at(-1);
      const close = () => { if (f) { f.nest--; if (f.arrow > f.nest) f.arrow = -1; } };
      if (c === '=' && src[i + 1] === '>') { if (f && f.arrow < 0) f.arrow = f.nest; prev = { t: 'p', v: '=>' }; i += 2; continue; }
      if (c === '(') { calls.push(prev?.t === 'id' ? prev.v : ''); frames.push({ blocks, arrow: -1, nest: 0, args: 0 }); }
      else if (c === ')') { calls.pop(); frames.pop(); }
      else if (c === '[') { if (f) f.nest++; }
      else if (c === ']') close();
      else if (c === ',') { if (f) { if (f.arrow === f.nest) f.arrow = -1; if (f.nest === 0) f.args++; } }
      else if (c === '{') {
        depth++;
        // a body after `)` or `=>` (a function, if, for…) or else/do; anything else is an object literal
        const body = (prev?.t === 'p' && (prev.v === ')' || prev.v === '=>')) || (prev?.t === 'kw' && (prev.v === 'else' || prev.v === 'do'));
        braces.push(body ? 'fn' : 'obj');
        if (body) blocks++;
        if (f) f.nest++;
      } else if (c === '}') { if (inExpr && depth === 0) return i + 1; depth--; if (braces.pop() === 'fn') blocks--; close(); }
      prev = { t: 'p', v: c };
      i++;
    }
    return i;
  }
  scan(0, false);
  return out;
}

// The top-level declaration each line belongs to (`const NAME =`, `function name(` … at column 0), for skipping the
// ones that only the model reads.
export function declarations(src) {
  const names = [];
  let cur = '';
  for (const line of src.split('\n')) {
    const m = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?\s+([\w$]+)|(?:const|let|var|class)\s+([\w$]+))/.exec(line);
    if (m) cur = m[1] || m[2];
    names.push(cur);
  }
  return (line) => names[line - 1] || '';
}

// Calls whose arguments are never shown: lookups, selectors, storage keys, logs, network and the model's own requests.
const HIDDEN_CALLS = /^(?:querySelector|querySelectorAll|closest|matches|getElementById|\$|\$\$|matchMedia|RegExp|fetch|addEventListener|removeEventListener|getItem|setItem|removeItem|postMessage|log|warn|info|debug|error|trace|createElement|setProperty|getPropertyValue|startsWith|endsWith|includes|indexOf|split|replace|replaceAll|join|test|exec|match|matchAll|add|remove|toggle|contains|has|get|set|delete|getAttribute|hasAttribute|removeAttribute|toLocaleString|toLocaleDateString|toLocaleTimeString|DateTimeFormat|NumberFormat|completeChat|streamChat|streamChatRaw|streamChatOnce|extCall|callTool|api|apiFetch|sendBeacon|URL|URLSearchParams|Blob|File|Response|Request|Headers|Worker|importScripts|open|keys|range|put|structuredClone|encode|decode|atob|btoa|stringify|parse|define|customElements|animate|scrollTo|focus)$/;
// Model prompts and tool descriptions are for the model, never shown: they talk about "the user", or are markdown
// sections. They are out of this lint's scope (Cole's rules reach the model only through public/humanizer.js).
const FOR_MODEL = /\bthe user\b|\bthe USER\b|(?:^|\n)#{2,3} |\bYou are\b|\bOutput (?:ONLY|only)\b|\bReturn ONLY\b|\bJSON\b/;
// …except where a person reads the string whatever it says: a direct argument of a toast, a dialog, an error or a status
// line, or text assigned to an element. "That file isn’t valid JSON." is copy.
const UI_SINK = /^(?:toast|alert|confirm|prompt|claudeStatus|busyBtn|fail|Error|[A-Z]\w*Error)$/;
const SHOWN_PROP = /\.(?:textContent|innerHTML|innerText|title|placeholder|alt|ariaLabel)\s*=(?!=)/;
// String.replace's second argument is the text put in: shown when it reads as prose.
const REPLACE = /^(?:replace|replaceAll)$/;
const HAS_HTML = /<(?:p|span|small|button|b|strong|em|h[1-6]|li|div|label|summary|a|i|code|section|ul|ol|header|footer|details|figcaption|dialog|option|th|td)\b[^>]*>/i;
// Copy, as opposed to a key, class list, selector, CSS, SVG path data, an address or a format string: at least one word
// of letters, and a capital letter, a curly quote or a digit up front, or a sentence mark at the end.
const PROSE = (t) => /[A-Za-z]{2,}/.test(t) && (/^[“"‘'(✦✎↻＋→←·•✓✕×⚠]?\s*[A-Z0-9]/.test(t) || /[.?!…:]["”’)]?$/.test(t.replace(/(?:\s*X)+$/, '')))
  && (!/^[\w.#\[\]:="'*>~+-]+$/.test(t) || /^[A-Z][a-z’']+[.!?…]?$/.test(t)) && !/^[MmLlHhVvCcSsQqTtAaZz][\d\s.,MmLlHhVvCcSsQqTtAaZz-]*$/.test(t)
  && !/[{};]\s*$|^\s*[.#@][\w-]|\b[a-z-]+\s*:\s*[^\s;]+;|^\w+:\/\/\S+$|^(?:GET|POST|PUT|DELETE|PATCH) \//.test(t);

// The Worker's text that only the model or the database reads: tool and parameter descriptions (src/tools.js S(), N(),
// desc:) and SQL.
const SERVER_HIDDEN_CALLS = /^(?:S|N|obj|ACCT|prepare|exec|batch|bind)$/;
const MODEL_KEY = /(?:^|[{,(]\s*)(?:desc|description|prompt|system|instructions)\s*:\s*$/;
const SQL = /^\s*(?:SELECT|INSERT|CREATE|DELETE|UPDATE|WITH|PRAGMA|ALTER|DROP)\b/i;

/**
 * A module's source → [{text, line}]: its copy, one block each — the text and shown attributes of every HTML template,
 * and every string that reads as prose, except what only the model or the code reads (hidden: top-level declarations
 * that hold prompts, tool descriptions or internal notes; and anything FOR_MODEL matches, unless a toast, dialog, error
 * or element shows it). server: a Worker module, whose tool descriptions and SQL are skipped too; its error messages
 * and notes reach the app's error cards and approval steps.
 */
export function shownStrings(src, { hidden = [], server = false } = {}) {
  const out = [], declOf = declarations(src);
  for (const l of literals(src)) {
    const t = l.text.replace(/\s+/g, ' ').trim(), shape = (l.shape ?? l.text).replace(/\s+/g, ' ').trim();
    // the call a literal is a direct argument of; inside a callback, it stands in a statement of its own
    const call = l.direct ? (l.calls.at(-1) ?? '') : '';
    const shown = UI_SINK.test(call) || SHOWN_PROP.test(l.prefix);
    if (!t || hidden.includes(declOf(l.line)) || (!shown && FOR_MODEL.test(l.shape ?? l.text))) continue;
    if (HIDDEN_CALLS.test(call) && !(REPLACE.test(call) && l.arg === 1)) continue;
    if (server && (SERVER_HIDDEN_CALLS.test(call) || MODEL_KEY.test(l.prefix) || SQL.test(t))) continue;
    if (HAS_HTML.test(l.text) || /^\s*<[a-z]/i.test(l.text)) { for (const b of htmlText(l.text)) out.push({ text: b, line: l.line }); continue; }
    if (PROSE(t) || PROSE(shape)) out.push({ text: t, line: l.line });
  }
  return out;
}
