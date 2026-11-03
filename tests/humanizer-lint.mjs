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
const INLINE_TAGS = 'a|b|strong|i|em|code|kbd|span|small|abbr|sup|sub|mark|u|s|q|time|br|wbr';
const INLINE = new RegExp(`<\\/?(?:${INLINE_TAGS})\\b[^>]*>`, 'gi');
const INLINE_TAG = new RegExp(`^(?:${INLINE_TAGS})$`, 'i');
// The attributes a person reads or hears: tooltips, placeholders, alt text and screen-reader labels.
const SHOWN_ATTRS = /\s(title|placeholder|alt|aria-label)\s*=\s*"([^"]*)"/gi;
const OPEN_ATTR = /\s(?:title|placeholder|alt|aria-label)\s*=\s*"[^"]*$/i; // markup that ends inside one's value
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
const UNARY = new Set(['typeof', 'new', 'void', 'await']); // inside a '+' chain's operand: 'Saved ' + await count() + '.'
// A log call: log, warn, info, debug or trace (console's or a module's own), and console.error (c.error(…) errors a
// stream; it logs nothing).
const LOGGER = /^(?:log|warn|info|debug|trace)$/;
const ESC = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };

/**
 * src → [{text, line, calls, direct, arg, via, prefix, template, outer, branch, key, obj}]: each string or template
 * literal, cooked. A ${…} reads as its own string with the most words (`${n ? ` in project ${n}` : ''}` reads " in
 * project X"; never a call's argument, an array's item, an object's key or value, or a comparand), or "X" when it holds
 * none. A '+' chain is one entry, read as its template would be: 'Saved ' + n + ' threads.' reads "Saved X threads.",
 * 'Synced ' + (on ? 'here and there' : 'here') + '.' reads "Synced here and there.", and it comes after its operands'
 * literals, as a template comes after its ${…}'s. calls is the stack of functions whose argument list holds it
 * (innermost last); direct is false when a callback stands between it and that call (`on('click', () => { el.textContent
 * = '…' })`), and arg is its argument's index there; via, the named calls it is under up to the first callback. prefix
 * is the source of its statement before it; outer, the template or chain whose ${…} or operand holds it as text (not in
 * a tag, short of a shown attribute's value), and branch, whether it is one of that ${…}'s or operand's own strings. key
 * is the object key whose value it is (`{ error: on ? 'a' : 'b' }`: both), never a call's argument or an array's item in
 * that value, or a comparand (`e.code === 'quota'`); obj, that object: the call whose argument it is (call, and the call
 * around that, parent), every call it is a direct argument of (via), what its ok: says and the key it is the value of
 * (under: `{ error: { message } }`).
 */
export function literals(src) {
  const out = [], calls = [];
  // per open call: the function bodies open when it opened, whether an arrow function started in its arguments (and at
  // what bracket depth inside them), the bracket depth now, how many arguments came before, and whether it logs.
  const frames = [];
  let blocks = 0;
  // per open {: 'fn' (a function or statement body), or an object: its key now (set at its own level by an ident or
  // string after { or , that ':' follows, cleared at the next ','), the key it is the value of (under); and 'tpl' while
  // a ${…} is read (the template is the value, its branches come through outer)
  const braces = [];
  const at = () => { const f = frames.at(-1); return f ? { direct: f.blocks === blocks && f.arrow < 0, arg: f.args } : { direct: true, arg: 0 }; };
  // the calls around a literal or an object up to the first callback: their names, innermost last (via), or whether
  // one is a log call (logs)
  const around = () => { const k0 = frames.length; let k = k0 - 1; while (k >= 0 && frames[k].blocks === blocks && frames[k].arrow < 0) k--; return frames.slice(k + 1).map((f, n) => [calls[k + 1 + n], f]); };
  const via = () => around().map(([c]) => c).filter(Boolean);
  const logs = () => around().some(([, f]) => f.log);
  const obj = () => { const b = braces.at(-1); return typeof b === 'object' && b.level === level ? b : null; };
  const tok = (v, name = false) => { // a token at an object's own level (name: an ident or a string); after ok:, its value
    const o = obj();
    if (!o) return;
    if (o.fresh) { if (o.key === 'ok') o.ok = v; o.fresh = false; }
    if (!name && v === ':' && o.cand != null) { o.key = o.cand; o.keys.add(o.cand); o.fresh = true; } else if (!name && (v === ',' || v === '}')) {
      if (o.cand != null) { o.keys.add(o.cand); if (o.cand === 'ok') o.ok = 'ok'; } // shorthand: { ok, error }
      o.key = '';
    }
    o.cand = o.expect && name ? v : null;
    o.expect = !name && v === ',';
  };
  let prev = null; // the last significant token: { t: 'id' | 'kw' | 'num' | 'str' | 'p', v }
  // bracket levels: what opened each ('(' a group, 'f' a call's arguments, '[' an array, 'i' an index, '{' or '$' for a
  // ${…}) and at which entry of out; base, the level a literal is the value at (only groups above it)
  let level = 0;
  const kinds = [], starts = [];
  const base = () => { let b = level; while (b > 0 && kinds[b - 1] === '(') b--; return b; };
  const whole = (b) => b > 0 && kinds[b - 1] === 'f'; // a call's argument itself: not in a ${…}, an array or an object
  // box: the level of the innermost array, index or object around it
  const boxOf = (b) => { while (b > 0 && !'[i{'.includes(kinds[b - 1])) b--; return b; };
  const boxed = () => boxOf(level);
  const open = (kind) => { kinds[level++] = kind; lead[level] = starts[level] = out.length; };
  // A lookup's values are what it reads as, as if no box held them: { day: 'Used up today', … }[k], ['a', 'b'][i]. lv:
  // the level of the array or object closing at i.
  const lookup = (lv, i) => {
    let j = i + 1, up = lv - 1;
    for (;;) { while (/\s/.test(src[j] || '')) j++; if (src[j] === ')' && up > 0 && kinds[up - 1] === '(') { j++; up--; } else break; }
    if (src[j] !== '[' || !'[{'.includes(kinds[lv - 1])) return;
    for (const l of out.slice(starts[lv])) if (l.box === lv && (kinds[lv - 1] === '[' || l.key)) l.box = boxOf(lv - 1);
  };
  // a comparand: after === != < >=… (not =>), or before == != < > or a ternary's ?
  const CMP_BEFORE = /(?:[=!]==?|(?<!=)[<>]=?)\s*$/, CMP_AFTER = /^\s*(?:[=!]=|[<>]|\?(?![.?]))/;
  const cmpAt = (i, after) => CMP_BEFORE.test(src.slice(Math.max(0, i - 12), i)) || CMP_AFTER.test(src.slice(after, after + 12));
  const keyOf = (cmp) => { // → [key, obj] for a literal here
    const b = braces.at(-1);
    return typeof b === 'object' && b.key && base() <= b.level && !cmp ? [b.key, b] : ['', null];
  };
  // '+' chains, per bracket level: the chain's first literal (the entry the rest join), its level, whether a '+' followed
  // its last piece (plus) or any piece (more), the operands read since its last piece (parts), whether one is open
  // (gap) and from which entry of out. lead: per level, the entry where its current operand began (n + ' threads': before
  // a chain's first piece, '+' may be a sum, so it all reads as one operand).
  const chains = [], lead = [0], nested = new Set(); // nested: the literals in a template's ${…}, which the template stands for
  const TAG = /^\s*<[^]*>\s*$/, MARKUP = /<\/?[a-z][^>]*>/i, IN_TAG = /<[a-z][^<>]*$/i, BLOCK = new RegExp(`<\\/?(?!(?:${INLINE_TAGS})\\b)[a-z]`, 'i');
  const blockStart = (s) => { const m = /^\s*<\/?([a-z][\w-]*)/i.exec(s); return Boolean(m) && !INLINE_TAG.test(m[1]); };
  const blockEnd = (s) => { const m = /<\/?([a-z][\w-]*)[^<>]*>\s*$/i.exec(s); return Boolean(m) && !INLINE_TAG.test(m[1]); };
  // markup of its own: tags and their text, never a value between inline tags ('<b>' + n + '</b>', `<b>${name}</b>`)
  const bare = (l) => TAG.test(l.text) && !(l.value && !blockStart(l.text));
  const byWords = (a, b) => words(b.text) - words(a.text) || b.text.length - a.text.length;
  // A ${…}'s or an operand's strings (lvl: its level): what it may read as, never a comparand or what an array or object
  // in it holds (a call's argument may be: `${esc(err.message || 'Couldn’t load it.')}`); and its branches, those at its
  // own level (groups aside), which are its value.
  const reads = (from, lvl) => out.slice(from).filter((l) => !nested.has(l) && !l.cmp && l.box <= lvl);
  // What a ${…} or an operand reads as, [text, shape]: its string with the most words, or X (x: a stand-in). Markup of
  // its own (its strings are tags or empty) reads X only as an inline element with text, a word (`Tap ${on ? '<b>Send</b>'
  // : ''} to go`); a block element is a line of its own and an empty one (an icon, a <br>) no word, so a space:
  // `</span>${on ? '<button>…</button>' : ''}` adds nothing. Other markup stays X: an element is linted as its own literal.
  const reading = (rd) => {
    if (rd.some(bare) && rd.every((l) => bare(l) || !l.text.trim()))
      return !rd.some((l) => BLOCK.test(l.text)) && rd.some((l) => /\w/.test(decode(l.text.replace(/<[^>]*>/g, '')))) ? { t: 'X', s: 'X', x: true } : { t: ' ', s: ' ' };
    const t = rd.filter((l) => /\w/.test(l.text)).sort(byWords)[0]?.text;
    return t && !MARKUP.test(t) ? { t, s: 'X' } : { t: 'X', s: 'X', x: true };
  };
  // An operand between, before or after the pieces reads as a ${…} does. left: the chain's text before it.
  const part = (from, lvl, left) => {
    const all = out.slice(from).filter((l) => !nested.has(l)), rd = reads(from, lvl), tag = IN_TAG.test(left), hid = tag && !OPEN_ATTR.test(left);
    return { all, br: rd.filter((l) => l.base <= lvl), tag, hid, ...reading(rd) };
  };
  // l reads through owner: an operand's string is no key's value of its own (`{ error: 'Offline: ' + (a ? 'b' : 'c') }`)
  const hold = (l, owner, branch) => { if (l.outer == null) { l.outer = owner; l.branch = branch; l.key = ''; l.obj = null; } };
  // A gap's operands into owner, as [text, shape]. Their X's go when nothing else is read and a block tag or the chain's
  // end (null) is on each side, where they would be a line of their own (`rows.join('') + '<input …>'`). Between inline
  // tags a value is a word: '<b>' + name + '</b>'.
  const fill = (parts, left, right, owner) => {
    const drop = parts.every((p) => p.x || !p.t.trim()) && (left == null || blockEnd(left)) && (right == null || blockStart(right));
    let t = '', s = '';
    for (const p of parts) {
      if (!p.hid) for (const l of p.all) hold(l, owner, p.br.includes(l));
      if (drop && p.x) continue;
      t += p.t; s += p.s;
      if (p.t.trim() && !p.tag) owner.value = true; // a value at a text position
    }
    return [t, s];
  };
  const join = (l, [t, s], after) => { // a gap's reading into l, after its text or before it
    if (l.shape == null && t === s) { l.text = after ? l.text + t : t + l.text; return; }
    l.shape = after ? (l.shape ?? l.text) + s : s + (l.shape ?? l.text);
    l.text = after ? l.text + t : t + l.text;
  };
  const flush = (c) => { if (c.gap) { c.parts.push(part(c.from, c.level, c.head.text + c.parts.map((p) => p.t).join(''))); c.gap = false; } };
  const end = () => {
    const c = chains[level];
    if (c) { flush(c); if (c.parts.length) join(c.head, fill(c.parts, c.head.text, null, c.head), true); }
    if (c?.more) { const k = out.lastIndexOf(c.head); if (k >= 0 && k < out.length - 1) { out.splice(k, 1); out.push(c.head); } }
    chains[level] = null;
  };
  const stop = () => { end(); lead[level] = out.length; }; // an operand ends here: , ; : ? = < > & | or a keyword
  const operand = () => { const c = chains[level]; if (c?.plus) { if (!c.gap) { c.gap = true; c.from = out.length; } } else if (c) end(); };
  const plus = () => { const c = chains[level]; if (c) { flush(c); c.plus = c.more = true; } }; // the next literal joins
  const add = (l, before) => { // → the entry that stands for l: its own, or the chain's it joined
    const c = chains[level];
    if (c?.plus) {
      const h = c.head;
      flush(c);
      if (c.parts.length) join(h, fill(c.parts, h.text, l.text, h), true);
      if (l.shape != null || h.shape != null) h.shape = (h.shape ?? h.text) + (l.shape ?? l.text);
      h.text += l.text;
      h.value ||= l.value;
      c.plus = false; c.parts = [];
      return h;
    }
    end();
    if (before?.t === 'p' && before.v === '+') join(l, fill([part(lead[level] ?? 0, level, '')], null, l.text, l), false); // n + ' threads'
    out.push(l);
    chains[level] = { head: l, level, plus: false, more: false, gap: false, from: 0, parts: [] };
    return l;
  };
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
    const cmp = cmpAt(i, j + 1), [key, o] = keyOf(cmp);
    add({ text, line: lineOf(i), calls: [...calls], ...at(), log: logs(), whole: whole(base()), prefix: prefixOf(i), template: false, key, obj: o, base: base(), box: boxed(), cmp }, prev);
    tok(text, true);
    return j + 1;
  }
  function template(i) {
    const start = i, snapshot = [...calls], where = at(), log = logs(), before = prev, inner = [], first = out.length, lvl = base(), box = boxed();
    let j = i + 1, text = '', shape = '', value = false; // shape: every ${…} as "X"
    while (j < src.length && src[j] !== '`') {
      if (src[j] === '\\') { const [t, n] = escape(j); text += t; shape += t; j = n; } else if (src[j] === '$' && src[j + 1] === '{') {
        const from = out.length;
        // inside a tag, only a shown attribute's value is read: a class list or a data-* value isn't text
        const tag = /<[a-z][^<>]*$/i.test(text), read = !tag || OPEN_ATTR.test(text);
        prev = { t: 'p', v: '{' }; open('$'); const lv = level; braces.push('tpl'); j = scan(j + 2, true); braces.pop(); end(); level--;
        // its string with the most words stands in for the expression: the branch that makes the longest sentence
        const rd = reads(from, lv), r = reading(rd);
        text += r.t;
        shape += r.s;
        value ||= !tag && Boolean(r.t.trim());
        if (read) for (const l of out.slice(from)) inner.push([l, rd.includes(l) && l.base <= lv]);
      } else { text += src[j]; shape += src[j++]; }
    }
    for (const l of out.slice(first)) nested.add(l);
    const cmp = cmpAt(start, j + 1), [key, o] = keyOf(cmp);
    const self = add({ text, shape, line: lineOf(start), calls: snapshot, ...where, log, prefix: prefixOf(start), template: true, key, obj: o, base: lvl, box, whole: whole(lvl), cmp, value }, before);
    for (const [l, branch] of inner) hold(l, self, branch);
    tok('`');
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
      if (c === '/') { operand(); tok(c); if (regexOk()) { i = regex(i); prev = { t: 'str' }; } else { i++; prev = { t: 'p', v: '/' }; } continue; }
      if (/[A-Za-z_$]/.test(c)) { const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 80)); const v = m[0]; i += v.length; if (KW.has(v) && !UNARY.has(v)) stop(); else operand(); tok(v, true); prev = KW.has(v) ? { t: 'kw', v } : { t: 'id', v, of: prev?.v === '.' && prev.t === 'p' ? prev.of : '' }; continue; }
      if (/\d/.test(c)) { const m = /^[\d._a-fA-FxXnoObB]+/.exec(src.slice(i, i + 40)); i += m[0].length; operand(); tok(m[0]); prev = { t: 'num' }; continue; }
      if (/\s/.test(c)) { i++; continue; }
      tok(c); // before the bracket level moves
      // a '+' (not ++ or +=) joins the next literal to the chain; a bracket or the rest of an operand (a.b?.c, -n, !x)
      // keeps it open; any other mark ends it (, ; : ? = < > & |)
      if (c === '+' && src[i + 1] !== '+' && src[i + 1] !== '=' && src[i - 1] !== '+') plus();
      else if ('([{+-*%.~'.includes(c) || (c === '!' && src[i + 1] !== '=') || (c === '?' && src[i + 1] === '.' && !/\d/.test(src[i + 2] || ''))) operand();
      else stop();
      const f = frames.at(-1);
      const close = () => { if (f) { f.nest--; if (f.arrow > f.nest) f.arrow = -1; } };
      if (c === '=' && src[i + 1] === '>') { if (f && f.arrow < 0) f.arrow = f.nest; prev = { t: 'p', v: '=>' }; i += 2; continue; }
      const under = c === '{' ? keyOf(false)[0] : ''; // the key whose value an object is: { error: { message } }
      const index = prev?.t === 'id' || prev?.t === 'str' || (prev?.t === 'p' && ')]'.includes(prev.v)); // a[…], f()[…]
      if ('([{'.includes(c)) open(c === '(' ? (prev?.t === 'id' ? 'f' : '(') : c === '[' && index ? 'i' : c);
      else if (c === ')' || c === ']') { if (c === ']') lookup(level, i); level = Math.max(0, level - 1); }
      if (c === '(') { calls.push(prev?.t === 'id' ? prev.v : ''); frames.push({ blocks, arrow: -1, nest: 0, args: 0, log: prev?.t === 'id' && (LOGGER.test(prev.v) || (prev.v === 'error' && prev.of === 'console')) }); }
      else if (c === ')') { calls.pop(); frames.pop(); }
      else if (c === '[') { if (f) f.nest++; }
      else if (c === ']') close();
      else if (c === ',') { if (f) { if (f.arrow === f.nest) f.arrow = -1; if (f.nest === 0) f.args++; } }
      else if (c === '{') {
        depth++;
        // a body after `)` or `=>` (a function, if, for…) or else/do; anything else is an object literal
        const body = (prev?.t === 'p' && (prev.v === ')' || prev.v === '=>')) || (prev?.t === 'kw' && (prev.v === 'else' || prev.v === 'do'));
        const fns = calls.filter(Boolean);
        braces.push(body ? 'fn' : { level, key: '', keys: new Set(), cand: null, expect: true, fresh: false, ok: '', call: at().direct ? fns.at(-1) ?? '' : '', parent: fns.at(-2) ?? '', via: via(), under });
        if (body) blocks++;
        if (f) f.nest++;
      } else if (c === '}') { if (inExpr && depth === 0) return i + 1; depth--; lookup(level, i); level = Math.max(0, level - 1); if (braces.pop() === 'fn') blocks--; close(); }
      prev = c === '.' ? { t: 'p', v: c, of: prev?.t === 'id' ? prev.v : '' } : { t: 'p', v: c }; // of: the name before a dot
      i++;
    }
    return i;
  }
  scan(0, false);
  end();
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
// Model prompts and tool descriptions are for the model, never shown: they talk about "the user", are markdown sections,
// or say what to answer with ("Return only the corrected JSON object"). "JSON" alone isn't a prompt: "Send the report as
// JSON." is copy. They are out of this lint's scope (Cole's rules reach the model only through public/humanizer.js).
const FOR_MODEL = /\bthe user\b|\bthe USER\b|(?:^|\n)#{2,3} |\bYou are\b|\b(?:Output|Return) (?:ONLY|only)\b/;
// …except where a person reads the string whatever it says: a direct argument of a toast, a dialog, an error, a status
// line or a DOM insert, text assigned to an element, or a ${…} of a template that is. "That file isn’t valid JSON." is
// copy.
const UI_SINK = /^(?:toast|alert|confirm|prompt|claudeStatus|busyBtn|fail|Error|[A-Z]\w*Error|insertAdjacentHTML|append|prepend|replaceChildren|replaceWith)$/;
const SHOWN_PROP = /\.(?:textContent|innerHTML|innerText|title|placeholder|alt|ariaLabel)\s*=(?!=)/;
// The assignment itself, not an argument of a call made after it or an item: `el.title = 'Copy'`, never `el.title =
// fmt('a b')` or `el.title = ['a b', 'c d'].includes(x) ? …`.
const SHOWN_PROPS = new RegExp(SHOWN_PROP.source, 'g');
const propSet = (prefix) => {
  const m = [...prefix.matchAll(SHOWN_PROPS)].at(-1);
  const tail = m ? prefix.slice(m.index + m[0].length) : '', n = (rx) => (tail.match(rx) || []).length;
  return Boolean(m) && n(/\(/g) <= n(/\)/g) && n(/\[/g) <= n(/\]/g);
};
// CSS, a selector, an address or a request line: code, however it reads.
const CODE = /[{};]\s*$|^\s*[.#@][\w-]|\b[a-z-]+\s*:\s*[^\s;]+;|^\w+:\/\/\S+$|^(?:GET|POST|PUT|DELETE|PATCH) \//;
// Shown as written: lowercase and unpunctuated still counts ("sign-in link expired — start again"), and so do a #channel,
// an @handle, a .folder, a "reason: detail;" or a {placeholder}. One-token codes, CSS rules (declarations in braces)
// and a request line don't.
const CSS_RULE = /\{[^{}]*[a-z-]\s*:[^{}]*;[^{}]*\}/i, REQUEST = /^(?:GET|POST|PUT|DELETE|PATCH) \//;
const LOOSE = (t) => /[A-Za-z]{2,}/.test(t) && /\s/.test(t) && !CSS_RULE.test(t) && !REQUEST.test(t);
// String.replace's second argument is the text put in: shown when it reads as prose.
const REPLACE = /^(?:replace|replaceAll)$/;
const HAS_HTML = /<(?:p|span|small|button|b|strong|em|h[1-6]|li|div|label|summary|a|i|code|section|ul|ol|header|footer|details|figcaption|dialog|option|th|td)\b[^>]*>/i;
// Copy, as opposed to a key, class list, selector, CSS, SVG path data, an address or a format string: at least one word
// of letters, and a capital letter, a curly quote or a digit up front, or a sentence mark at the end.
const PROSE = (t) => /[A-Za-z]{2,}/.test(t) && (/^[“"‘'(✦✎↻＋→←·•✓✕×⚠]?\s*[A-Z0-9]/.test(t) || /[.?!…:]["”’)]?$/.test(t.replace(/(?:\s*X)+$/, '')))
  && (!/^[\w.#\[\]:="'*>~+-]+$/.test(t) || /^[A-Z][a-z’']+[.!?…]?$/.test(t)) && !/^[MmLlHhVvCcSsQqTtAaZz][\d\s.,MmLlHhVvCcSsQqTtAaZz-]*$/.test(t)
  && !CODE.test(t);

// The Worker's text that only the model or the database reads: tool and parameter descriptions (src/tools.js S(), N(),
// desc:) and SQL (its keywords in capitals, as the Worker writes them: "Select a word…" is copy).
const SERVER_HIDDEN_CALLS = /^(?:S|N|obj|ACCT|prepare|exec|batch|bind)$/;
// the object key whose value it is (wherever the key sits: first, or on a line of its own), or the line before it
const MODEL_KEYS = /^(?:desc|description|prompt|system|instructions)$/;
const MODEL_KEY = /(?:^|[{,(]\s*)(?:desc|description|prompt|system|instructions)\s*:\s*$/;
const SQL = /^\s*(?:SELECT|INSERT|CREATE|DELETE|UPDATE|WITH|PRAGMA|ALTER|DROP)\b/;
// The Worker's usual error shape, new Response(JSON.stringify({ error: '…' })): the client shows the error, message or
// detail, and a Response's own text body.
const ERROR_KEY = /^(?:error|message|detail)$/;
// A log's text is never copy: anything under a log call (LOGGER's, console.error's), new Error(…) in one included,
// short of a callback handed to one.
const logged = (l) => l.log;
// A module's JSON response helpers: json (Response.json too), and any it defines as new Response(JSON.stringify(data…))
// or Response.json(data…).
const HELPER = /\b(?:const|let|var|function)\s+([\w$]+)\s*=?\s*(?:async\s*)?(?:\(\s*([\w$]+)[^)]*\)|([\w$]+))\s*(?:=>\s*(?:\{\s*return\s+)?|\{\s*return\s+)(?:new Response\(JSON\.stringify|Response\.json)\(\s*([\w$]+)\s*[,)]/g;
const jsonHelpers = (src) => new Set(['json', ...[...src.matchAll(HELPER)].filter((m) => (m[2] || m[3]) === m[4]).map((m) => m[1])]);
// A request's own calls (fetch, a model's, the database's): an object sent in one is never shown. JSON.stringify isn't one.
const SENT = (c) => (HIDDEN_CALLS.test(c) && c !== 'stringify') || SERVER_HIDDEN_CALLS.test(c);

/**
 * A module's source → [{text, line}]: its copy, one block each — the text and shown attributes of every HTML template,
 * and every string that reads as prose, except what only the model or the code reads (hidden: top-level declarations
 * that hold prompts, tool descriptions or internal notes; and anything FOR_MODEL matches, unless a toast, dialog, error,
 * DOM insert or element shows it, and a branch of one it matches). What one of those shows as written needs only a word
 * and a space to count. server: a Worker module, whose tool descriptions and SQL are skipped too; its response bodies
 * are shown like a toast, and its other error messages and notes reach the app's error cards and approval steps.
 */
export function shownStrings(src, { hidden = [], server = false } = {}) {
  const out = [], declOf = declarations(src), seen = new Map(), asIs = new Map(), helpers = jsonHelpers(src);
  // the call a literal is a direct argument of; inside a callback, it stands in a statement of its own
  const callOf = (l) => (l.direct ? (l.calls.at(-1) ?? '') : '');
  // the Worker's response body: the error, message or detail of json({…}), reply({…}) (a helper like it) or new
  // Response(JSON.stringify({…})), and of the error object in one; or a Response's text
  const body = (l) => server && ((ERROR_KEY.test(l.key) && (!l.obj.under || l.obj.under === 'error') && (helpers.has(l.obj.call) || (l.obj.call === 'stringify' && l.obj.parent === 'Response'))) || (callOf(l) === 'Response' && l.arg === 0));
  // any other error object's (returned, resolved, sent as a stream's frame or stringified): shown as written too, but
  // FOR_MODEL still skips the one a tool hands the model. Never one a request sends, a check that passed (ok: true), or
  // a message or detail with no ok: or error: beside or around it (a commit message, a model's input).
  const errorValue = (l) => server && ERROR_KEY.test(l.key) && l.obj.ok !== 'true' && (l.key === 'error' || l.obj.ok !== '' || l.obj.keys.has('error') || l.obj.under === 'error') && !l.obj.via.some(SENT);
  // shown: a sink, an element or a response shows it, or the template or chain whose ${…} or operand holds it is shown
  const shown = (l) => {
    if (!seen.has(l)) seen.set(l, UI_SINK.test(callOf(l)) || SHOWN_PROP.test(l.prefix) || body(l) || Boolean(l.outer && shown(l.outer)));
    return seen.get(l);
  };
  // for the model: FOR_MODEL matches it, as written or as read (a tool result whose branch says "the user"). Skipped
  // unless it is shown; the branches of one held in a variable are read on their own (a toast may show it later).
  const model = (l) => FOR_MODEL.test(l.text) || (l.shape != null && FOR_MODEL.test(l.shape));
  const skipped = (l) => !shown(l) && model(l);
  // a tool's result for the model: an error value FOR_MODEL skips; what its ${…} or operands hold is the model's too
  const tool = (l) => (skipped(l) && written(l)) || Boolean(l.outer && tool(l.outer));
  // shown as written: the sink's own argument, the value set, an error value, or a branch of a template or chain that is
  // shown or shown as written, and not skipped (never a call's argument, an item, a key or a comparand in one of those)
  const written = (l) => {
    if (!asIs.has(l)) asIs.set(l, (!l.cmp && ((UI_SINK.test(callOf(l)) && l.whole) || propSet(l.prefix))) || body(l) || errorValue(l) || Boolean(l.outer && l.branch && !skipped(l.outer) && (shown(l.outer) || written(l.outer))));
    return asIs.get(l);
  };
  for (const l of literals(src)) {
    const t = l.text.replace(/\s+/g, ' ').trim(), shape = (l.shape ?? l.text).replace(/\s+/g, ' ').trim();
    const call = callOf(l);
    if (!t || hidden.includes(declOf(l.line)) || logged(l) || skipped(l) || (l.outer && tool(l.outer))) continue;
    if (HIDDEN_CALLS.test(call) && !(REPLACE.test(call) && l.arg === 1) && !body(l) && !(call === 'stringify' && errorValue(l))) continue;
    if (server && (SERVER_HIDDEN_CALLS.test(call) || MODEL_KEYS.test(l.key) || MODEL_KEY.test(l.prefix) || (SQL.test(t) && !body(l) && !errorValue(l)))) continue;
    // markup, even after a ${…} that reads X (`${rows}<input aria-label="…">`)
    if (HAS_HTML.test(l.text) || /^\s*X?\s*<[a-z]/i.test(l.text)) { for (const b of htmlText(l.text)) out.push({ text: b, line: l.line }); continue; }
    // its shape with every ${…} as X: two values side by side ("XX") are no word
    if (PROSE(t) || PROSE(shape.replace(/X{2,}/g, 'X')) || (written(l) && LOOSE(t))) out.push({ text: t, line: l.line });
  }
  return out;
}
