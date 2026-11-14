// Documents attached to a chat turn (v113; readers rebuilt in v114 against real Office files). Each file is read on this
// device into plain text, and the text goes to the model inside the turn's message (context.js filesBlock), so every
// chat model can read it: Claude, GPT, Gemini, Kimi alike. Nothing is uploaded on its own.
// Pure module (no DOM): app.js passes fflate in, and reads PDFs itself with pdf.js (pdfDoc). Tests run it in Node against
// files Word, Excel and PowerPoint saved (tests/fixtures/office), next to what those apps show for the same files.
//   docKind(name, type)        → 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'doc' | 'xls' | 'ppt' | 'odt' | 'ods' | 'odp' | 'rtf' |
//                                'html' | 'text' | 'old' (a format nothing here reads) | ''
//   readFile(kind, bytes, f)   → the text of any kind but 'pdf' (f: fflate's { unzipSync, strFromU8 })
//   clipText(text, max)        → { text, cut } with the text cut at max characters
import { legacyText } from './files-legacy.js?v=134';

export const FILE_MAX_BYTES = 50 * 1024 * 1024; // a bigger file isn't read
export const FILE_CHARS = 150_000; // one file's text, at most (~40k tokens)
export const FILES_CHARS = 250_000; // all of one turn's files together
export const MAX_FILES = 5;
// One part inside a .docx / .xlsx / .pptx, unpacked. A sheet or a string table past this is not unpacked at all: a
// 50 MB workbook can hold gigabytes of XML, and the tab would run out of memory before any of it was read.
export const PART_MAX_BYTES = 48 * 1024 * 1024;
// Of a plain text file, only this much is decoded: FILE_CHARS of it is all a turn sends, and a 50 MB log as one string
// (twice that in memory) is more than a phone has to spare.
export const TEXT_BYTES = 2 * 1024 * 1024;

const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'xml', 'yaml', 'yml', 'toml', 'ini', 'log',
  'tex', 'srt', 'vtt', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp',
  'cs', 'php', 'sh', 'ps1', 'bat', 'sql', 'css', 'scss', 'vue', 'svelte', 'r', 'lua', 'pl', 'dart', 'ics', 'vcf', 'env', 'conf', 'cfg', 'eml']);
const extOf = (name = '') => (/\.([a-z0-9]+)$/i.exec(String(name))?.[1] || '').toLowerCase();

export function docKind(name = '', type = '') {
  const ext = extOf(name), t = String(type || '').toLowerCase();
  if (ext === 'pdf' || t === 'application/pdf') return 'pdf';
  if (ext === 'docx' || ext === 'docm' || t.includes('wordprocessingml')) return 'docx';
  if (ext === 'xlsx' || ext === 'xlsm' || t.includes('spreadsheetml')) return 'xlsx';
  if (ext === 'pptx' || ext === 'pptm' || ext === 'ppsx' || t.includes('presentationml')) return 'pptx';
  if (ext === 'doc' || ext === 'dot' || t === 'application/msword') return 'doc';
  if (ext === 'xls' || ext === 'xlt' || t === 'application/vnd.ms-excel') return 'xls';
  if (ext === 'ppt' || ext === 'pps' || t === 'application/vnd.ms-powerpoint') return 'ppt';
  if (ext === 'odt' || t.includes('opendocument.text')) return 'odt';
  if (ext === 'ods' || t.includes('opendocument.spreadsheet')) return 'ods';
  if (ext === 'odp' || t.includes('opendocument.presentation')) return 'odp';
  if (ext === 'rtf' || t === 'application/rtf' || t === 'text/rtf') return 'rtf';
  if (ext === 'html' || ext === 'htm' || ext === 'xhtml' || t === 'text/html') return 'html';
  if (['pages', 'numbers', 'key', 'xlsb', 'wpd', 'wps', 'pub', 'one', 'msg'].includes(ext)) return 'old';
  if (TEXT_EXT.has(ext) || t.startsWith('text/') || /json|xml|javascript|yaml|csv/.test(t)) return 'text';
  return '';
}
export const KIND_LABEL = Object.freeze({ pdf: 'PDF', docx: 'Word', doc: 'Word', odt: 'Document', rtf: 'Rich text', xlsx: 'Excel', xls: 'Excel', ods: 'Sheet',
  pptx: 'PowerPoint', ppt: 'PowerPoint', odp: 'Slides', html: 'Web page', text: 'Text' });

// ── XML, without a DOM ──
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const unxml = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, k) => {
  if (k[0] === '#') { const n = k[1] === 'x' || k[1] === 'X' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10); try { return String.fromCodePoint(n); } catch { return m; } }
  return ENT[k.toLowerCase()] ?? m;
});
const TAG = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<![^>]*>|([^<]+)/g;
// One pass over an XML part. on.open(name, attrs, selfClosing), on.close(name), on.text(decoded text).
export function walk(xml, on) {
  const re = new RegExp(TAG.source, 'g'); // its own lastIndex: a walk can start inside another
  let m;
  while ((m = re.exec(xml))) {
    if (m[2]) {
      if (m[1]) on.close?.(m[2]);
      else { on.open?.(m[2], m[3] || '', Boolean(m[4])); if (m[4]) on.close?.(m[2]); }
    } else if (m[5] != null) on.text?.(m[5]);
    else if (m[6] != null) on.text?.(unxml(m[6]));
  }
}
const ATTR = new Map();
export function attr(attrs, name) {
  let re = ATTR.get(name);
  if (!re) ATTR.set(name, re = new RegExp(`(?:^|\\s)${name.replace(/[.:]/g, '\\$&')}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`));
  const m = re.exec(attrs);
  return m ? unxml(m[1] ?? m[2]) : '';
}
const tidy = (s) => s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// sheet2.xml before sheet10.xml: parts in the order of the number in their name.
const byPartNumber = (a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1] || 0) - Number(/(\d+)\.xml$/.exec(b)?.[1] || 0);

// ── the zip a .docx / .xlsx / .pptx / .od? is ──
// Parts are unpacked one at a time, by name, and only up to PART_MAX_BYTES each.
function openZip(bytes, { unzipSync, strFromU8 }) {
  const sizes = new Map();
  try { unzipSync(bytes, { filter: (f) => { sizes.set(f.name, f.originalSize); return false; } }); } catch { throw new Error('That file looks damaged — couldn’t open it.'); }
  const fits = (name) => sizes.has(name) && !(sizes.get(name) > PART_MAX_BYTES);
  return {
    names: [...sizes.keys()],
    has: (name) => sizes.has(name),
    fits,
    text(name) {
      if (!fits(name)) return '';
      try { const z = unzipSync(bytes, { filter: (f) => f.name === name }); return z[name] ? strFromU8(z[name]) : ''; } catch { return ''; }
    },
  };
}
// A part's relationships: Id → { target (a full part name, or a URL when external), type (its last path word) }.
function rels(zip, part) {
  const dir = part.slice(0, part.lastIndexOf('/') + 1), base = part.slice(part.lastIndexOf('/') + 1);
  const out = new Map();
  walk(zip.text(`${dir}_rels/${base}.rels`), { open(name, a) {
    if (name !== 'Relationship') return;
    const target = attr(a, 'Target'), external = attr(a, 'TargetMode') === 'External';
    out.set(attr(a, 'Id'), { target: external ? target : resolve(dir, target), type: attr(a, 'Type').split('/').pop(), external });
  } });
  return out;
}
function resolve(dir, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = dir.split('/').filter(Boolean);
  for (const seg of target.split('/')) { if (seg === '..') parts.pop(); else if (seg && seg !== '.') parts.push(seg); }
  return parts.join('/');
}

// ── Word (.docx) ──
// The text as Word shows it with every tracked change accepted: paragraphs, headings (#), list items (-), tables (one
// row a line, cells split by " | "), tabs and line breaks, links with their address, text boxes once (a drawing carries
// its text twice, for old readers), footnote marks. Footnotes, endnotes and comments come back as notes.
const HEADING = /^(?:heading|berschrift|titre|ttulo|titolo|kop)\s?([1-6])$/i;
export function wordXml(xml, links = new Map()) {
  const out = { lines: [], notes: [], images: 0, tracked: false };
  const frames = [{ kind: 'root', lines: out.lines }]; // where a finished paragraph goes: the body, a cell, a box, a note
  const paras = []; // open paragraphs; a text box's paragraphs sit inside the paragraph that anchors it
  let skip = '', depth = 0, inText = false;
  const top = () => frames[frames.length - 1], para = () => paras[paras.length - 1];
  const put = (s) => { const p = para(); if (p) p.text += s; };
  const SKIP = new Set(['mc:Fallback', 'w:del', 'w:moveFrom', 'w:pPrChange', 'w:rPrChange', 'w:sectPrChange', 'w:tblPrChange', 'w:tcPrChange', 'w:trPrChange', 'w:instrText', 'w:delText', 'w:delInstrText']);
  walk(xml, {
    open(name, a, self) {
      if (skip) { if (name === skip && !self) depth++; return; }
      if (SKIP.has(name)) { if (name === 'w:del' || name === 'w:moveFrom') out.tracked = true; if (!self) { skip = name; depth = 1; } return; }
      switch (name) {
        case 'w:ins': case 'w:moveTo': out.tracked = true; break;
        case 'w:p': paras.push({ text: '', style: '', list: -1, boxes: [], link: null }); break;
        case 'w:pStyle': if (para()) para().style = attr(a, 'w:val'); break;
        case 'w:numPr': if (para()) para().list = 0; break;
        case 'w:ilvl': if (para() && para().list >= 0) para().list = Number(attr(a, 'w:val')) || 0; break;
        case 'w:numId': if (para() && attr(a, 'w:val') === '0') para().list = -1; break; // "0" takes the numbering off
        case 'w:t': inText = !self; break;
        case 'w:tab': put('\t'); break;
        case 'w:br': case 'w:cr': put('\n'); break;
        case 'w:noBreakHyphen': put('-'); break;
        case 'w:footnoteReference': put(`[^${attr(a, 'w:id')}]`); break;
        case 'w:endnoteReference': put(`[^e${attr(a, 'w:id')}]`); break;
        case 'w:hyperlink': if (para()) para().link = { at: para().text.length, url: links.get(attr(a, 'r:id'))?.target || '' }; break;
        case 'wp:docPr': { const d = attr(a, 'descr').replace(/\s+/g, ' ').trim(); if (d) put(`[Image: ${d.slice(0, 300)}]`); break; }
        case 'a:blip': case 'v:imagedata': out.images++; break;
        case 'w:txbxContent': frames.push({ kind: 'box', lines: [] }); break;
        case 'w:tbl': frames.push({ kind: 'table', rows: [] }); break;
        case 'w:tr': if (top().kind === 'table') top().rows.push([]); break;
        case 'w:tc': frames.push({ kind: 'cell', lines: [] }); break;
        case 'w:footnote': case 'w:endnote': case 'w:comment':
          frames.push({ kind: 'note', lines: [], id: attr(a, 'w:id'), type: attr(a, 'w:type'), author: attr(a, 'w:author'), of: name.slice(2) }); break;
        default:
      }
    },
    close(name) {
      if (skip) { if (name === skip && --depth === 0) skip = ''; return; }
      switch (name) {
        case 'w:t': inText = false; break;
        case 'w:hyperlink': { const p = para(), l = p?.link; if (l?.url && !p.text.slice(l.at).includes(l.url) && /^(https?|mailto):/i.test(l.url)) p.text += ` (${l.url})`; if (p) p.link = null; break; }
        case 'w:p': {
          const p = paras.pop(); if (!p) break;
          let line = p.text.replace(/[ \t]+$/, '');
          const h = HEADING.exec(p.style), title = /^title$/i.test(p.style);
          if (line && (h || title)) line = `${'#'.repeat(h ? Number(h[1]) : 1)} ${line}`;
          else if (line && p.list >= 0) line = `${'  '.repeat(Math.min(p.list, 6))}- ${line}`;
          const to = top().kind === 'table' ? frames[0] : top(); // a paragraph straight in a table (malformed): the body
          to.lines.push(line);
          for (const b of p.boxes) to.lines.push(`[Text box] ${b}`);
          break;
        }
        case 'w:txbxContent': {
          const f = frames.pop(), text = f.lines.filter(Boolean).join(' / ');
          if (!text) break;
          if (para()) para().boxes.push(text); else top().lines?.push(`[Text box] ${text}`);
          break;
        }
        case 'w:tc': { const f = frames.pop(), t = top(); if (t.kind === 'table') { if (!t.rows.length) t.rows.push([]); t.rows[t.rows.length - 1].push(f.lines.filter(Boolean).join(' / ')); } break; }
        case 'w:tbl': {
          const f = frames.pop(), rows = f.rows.map((r) => r.join(' | ')).filter((r) => r.replace(/[ |]/g, ''));
          const t = top();
          if (t.kind === 'cell') t.lines.push(rows.join('; ')); else if (t.lines) t.lines.push(...rows);
          break;
        }
        case 'w:footnote': case 'w:endnote': case 'w:comment': {
          const f = frames.pop(), text = f.lines.filter(Boolean).join(' / ').trim();
          if (text && !/separator|continuation/i.test(f.type)) out.notes.push({ of: f.of, id: f.id, author: f.author, text });
          break;
        }
        default:
      }
    },
    text(s) { if (inText && !skip) put(s); },
  });
  return out;
}
function docxText(zip) {
  if (!zip.has('word/document.xml')) throw new Error('That isn’t a Word document Atelier can read.');
  if (!zip.fits('word/document.xml')) throw new Error('That document is too big to read here.');
  const main = wordXml(zip.text('word/document.xml'), rels(zip, 'word/document.xml'));
  const out = [tidy(main.lines.join('\n'))];
  let images = main.images, tracked = main.tracked;
  const part = (name) => { const r = wordXml(zip.text(name), rels(zip, name)); images += r.images; tracked ||= r.tracked; return r; };
  const notes = (name, title, line) => {
    if (!zip.has(name)) return;
    const list = part(name).notes;
    if (list.length) out.push(`--- ${title} ---\n${list.map(line).join('\n')}`);
  };
  notes('word/footnotes.xml', 'Footnotes', (n) => `[^${n.id}]: ${n.text}`);
  notes('word/endnotes.xml', 'Endnotes', (n) => `[^e${n.id}]: ${n.text}`);
  notes('word/comments.xml', 'Comments', (n) => `- ${n.author && !/^author$/i.test(n.author) ? `${n.author}: ` : ''}${n.text}`);
  const byNumber = (a, b) => (parseInt(a.replace(/\D+/g, ''), 10) || 0) - (parseInt(b.replace(/\D+/g, ''), 10) || 0);
  for (const [prefix, title] of [['word/header', 'Page header'], ['word/footer', 'Page footer']]) {
    const seen = new Set();
    for (const name of zip.names.filter((n) => n.startsWith(prefix) && /^\d*\.xml$/.test(n.slice(prefix.length))).sort(byNumber)) {
      const t = tidy(part(name).lines.filter((l) => l && !/^\d+$/.test(l.trim())).join('\n'));
      if (t) seen.add(t);
    }
    if (seen.size) out.push(`--- ${title} ---\n${[...seen].join('\n')}`);
  }
  if (tracked) out.push('[This document has tracked changes. This is the text with every change accepted.]');
  if (images) out.push(`[${plural(images, 'image')} in this document ${images === 1 ? 'was' : 'were'} not read.]`);
  return out.filter(Boolean).join('\n\n');
}

// ── Excel: what a cell shows ──
// A date, a time and a percentage are stored as plain numbers; only the cell's number format says which. Shown here the
// way Excel shows them, with dates and times in ISO form (2025-12-09, 18:00) so no model has to guess month from day.
const BUILTIN_FMT = { 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 5: '$#,##0', 6: '$#,##0', 7: '$#,##0.00', 8: '$#,##0.00', 9: '0%', 10: '0.00%', 11: '0.00E+00',
  12: '# ?/?', 13: '# ??/??', 14: 'm/d/yyyy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss',
  22: 'm/d/yyyy h:mm', 37: '#,##0', 38: '#,##0', 39: '#,##0.00', 40: '#,##0.00', 41: '#,##0', 42: '$#,##0', 43: '#,##0.00', 44: '$#,##0.00', 45: 'mm:ss',
  46: '[h]:mm:ss', 47: 'mm:ss.0', 48: '##0.0E+0', 49: '@' };
for (const id of [27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 55, 56, 57, 58]) BUILTIN_FMT[id] = 'yyyy-mm-dd'; // East Asian date formats
for (const id of [32, 33]) BUILTIN_FMT[id] = 'h:mm:ss';
export const builtinFormat = (id) => BUILTIN_FMT[id] || '';
const pad = (n, w = 2) => String(n).padStart(w, '0');
// The number as Excel's General format would print it: 15 significant digits, no binary noise (0.30000000000000004).
export function plainNumber(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  const s = String(Number(n.toPrecision(15)));
  return /e/i.test(s) ? Number(n.toPrecision(15)).toLocaleString('en-US', { useGrouping: false, maximumSignificantDigits: 15 }) : s;
}
const grouped = (n, dec) => { const [i, f] = Math.abs(n).toFixed(dec).split('.'); return `${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${f ? `.${f}` : ''}`; };
// A serial day number → [year, month, day, seconds into the day]. 1900 system: day 60 is the 29 Feb 1900 that never was.
export function serialDate(v, date1904 = false) {
  let days = Math.floor(v), secs = Math.round((v - days) * 86400);
  if (secs >= 86400) { days += 1; secs = 0; }
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, days < 60 ? 31 : 30);
  const d = new Date(epoch + days * 86400000);
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), secs];
}
export function formatCell(raw, code = '', date1904 = false) {
  const v = Number(raw);
  if (raw === '' || raw == null || !Number.isFinite(v)) return String(raw ?? '');
  const first = String(code || '').split(';')[0];
  // What is left once literals are gone: "text", \x, _x (a space as wide as x), *x (fill), [Red] and [$-409].
  const bare = first.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/_./g, '').replace(/\*./g, '').replace(/\[(?!h+\]|m+\]|s+\])[^\]]*\]/gi, '');
  if (!bare || /^general$/i.test(bare.trim()) || bare.includes('@')) return plainNumber(v);
  if (/[ymdhs]/i.test(bare.replace(/AM\/PM|A\/P/gi, ''))) {
    const elapsed = /\[h+\]/i.test(bare), lower = bare.toLowerCase();
    const hasTime = /h|s/.test(lower), hasDate = /y|d/.test(lower) || (/m/.test(lower) && !hasTime);
    if (elapsed) { const total = Math.round(v * 86400); return `${Math.floor(total / 3600)}:${pad(Math.floor(total / 60) % 60)}${/s/.test(lower) ? `:${pad(total % 60)}` : ''}`; }
    if (v < 0) return plainNumber(v);
    const [y, mo, d, secs] = serialDate(v, date1904);
    const time = `${pad(Math.floor(secs / 3600))}:${pad(Math.floor(secs / 60) % 60)}${/s/.test(lower) ? `:${pad(secs % 60)}` : ''}`;
    const date = `${pad(y, 4)}-${pad(mo)}-${pad(d)}`;
    return hasDate && hasTime ? `${date} ${time}` : hasDate ? date : time;
  }
  const dec = (/\.([0#?]+)/.exec(bare)?.[1].replace(/[^0]/g, '') || '').length;
  if (bare.includes('%')) return `${(v * 100).toFixed(dec)}%`;
  if (/e[+-]/i.test(bare) || bare.includes('/')) return plainNumber(v); // scientific and fractions: the plain number
  if (!/[0#?]/.test(bare)) return plainNumber(v);
  const symbol = /\[\$([^\]-]*)[^\]]*\]/.exec(first)?.[1] || /[$€£¥₹₩₽]/.exec(first.replace(/\[[^\]]*\]/g, ''))?.[0] || '';
  const after = symbol && first.indexOf(symbol) > first.search(/[0#?]/);
  const body = bare.includes(',') ? grouped(v, dec) : Math.abs(v).toFixed(dec);
  return `${v < 0 ? '-' : ''}${symbol && !after ? symbol : ''}${body}${symbol && after ? ` ${symbol}` : ''}`;
}

// ── Excel (.xlsx) ──
const colNum = (ref) => { let n = 0; for (const ch of String(ref).replace(/\d+/g, '').toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
const csvCell = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const COLS_MAX = 256; // a stray cell far to the right doesn't turn every row into thousands of commas
const runsOf = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => unxml(m[1])).join('');
// Shared strings, in order. A string's phonetic guide (<rPh>, Japanese readings) is not part of its text.
export const sharedStrings = (xml) => [...String(xml || '').matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)].map((m) => runsOf((m[1] || '').replace(/<rPh\b[\s\S]*?<\/rPh>/g, ''), 't'));
// styles.xml → for each cell style index (a cell's s="n"), its number format code.
export function cellFormats(xml) {
  const custom = new Map();
  const src = String(xml || '');
  for (const m of src.matchAll(/<numFmt\b([^>]*)\/?>/g)) custom.set(Number(attr(m[1], 'numFmtId')), attr(m[1], 'formatCode'));
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(src)?.[1] || '';
  return [...xfs.matchAll(/<xf\b([^>]*?)\/?>/g)].map((m) => { const id = Number(attr(m[1], 'numFmtId')) || 0; return custom.get(id) ?? builtinFormat(id); });
}
// One sheet as CSV lines. opts: { shared, formats, date1904, budget (characters this sheet may still use) } → { text, cut }.
export function sheetText(xml, { shared = [], formats = [], date1904 = false, budget = Infinity } = {}) {
  const rows = [];
  let size = 0, cut = false, last = 0;
  for (const r of String(xml).matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const c of r[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = c[1], inner = c[2] || '';
      const ref = /(?:^|\s)r="([A-Z]+)\d+"/.exec(a)?.[1], t = /(?:^|\s)t="([^"]+)"/.exec(a)?.[1], s = Number(/(?:^|\s)s="(\d+)"/.exec(a)?.[1] || 0);
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let val = '';
      if (t === 's') val = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') val = runsOf(inner.replace(/<rPh\b[\s\S]*?<\/rPh>/g, ''), 't');
      else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
      else if (t === 'str' || t === 'e' || t === 'd') val = v != null ? unxml(v) : '';
      else if (v != null) val = formatCell(unxml(v), formats[s], date1904);
      const at = ref ? colNum(ref) : cells.length;
      if (at >= COLS_MAX) continue;
      while (cells.length < at) cells.push('');
      cells[at] = csvCell(String(val).replace(/\r\n?/g, '\n'));
    }
    while (cells.length && cells.at(-1) === '') cells.pop();
    const n = Number(/(?:^|\s)r="(\d+)"/.exec(r[1])?.[1]) || last + 1;
    if (rows.length && n > last + 1) rows.push(''); // rows the sheet skips: one blank line, so blocks stay apart
    last = n;
    const line = cells.join(',');
    rows.push(line); size += line.length + 1;
    if (size > budget) { cut = true; break; }
  }
  while (rows.length && !rows.at(-1)) rows.pop();
  return { text: rows.join('\n'), cut };
}
function xlsxText(zip) {
  if (!zip.has('xl/workbook.xml')) throw new Error('That isn’t a spreadsheet Atelier can read.');
  const wb = zip.text('xl/workbook.xml'), links = rels(zip, 'xl/workbook.xml');
  const date1904 = /<workbookPr\b[^>]*\bdate1904="(?:1|true)"/.test(wb);
  let sheets = [...wb.matchAll(/<sheet\b([^>]*?)\/?>/g)].map((m) => ({ name: attr(m[1], 'name'), hidden: /hidden/i.test(attr(m[1], 'state')), part: links.get(attr(m[1], 'r:id'))?.target || '' }));
  if (!sheets.some((s) => zip.has(s.part))) { // no usable relationships: the sheet files in number order
    const files = zip.names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort(byPartNumber);
    sheets = files.map((part, i) => ({ name: sheets[i]?.name || `Sheet ${i + 1}`, hidden: false, part }));
  }
  if (!sheets.length) throw new Error('That spreadsheet has no sheets Atelier can read.');
  if (zip.has('xl/sharedStrings.xml') && !zip.fits('xl/sharedStrings.xml')) throw new Error('That spreadsheet is too big to read here.');
  const shared = sharedStrings(zip.text('xl/sharedStrings.xml')), formats = cellFormats(zip.text('xl/styles.xml'));
  const out = [];
  let left = FILE_CHARS + 2000; // a little past the cap, so clipText sees a cut and says so
  for (const s of sheets) {
    const title = `--- Sheet: ${s.name || 'Sheet'}${s.hidden ? ' (hidden)' : ''} ---`;
    if (left <= 0) { out.push(`${title}\n[Not read: the file is longer than Atelier sends.]`); continue; }
    if (!/worksheets\//.test(s.part) || !zip.has(s.part)) { out.push(`${title}\n[A chart sheet. Nothing to read as text.]`); continue; }
    if (!zip.fits(s.part)) { out.push(`${title}\n[This sheet is too big to read here.]`); continue; }
    const { text } = sheetText(zip.text(s.part), { shared, formats, date1904, budget: left });
    out.push(`${title}\n${text || '[Empty sheet]'}`); left -= text.length;
  }
  return out.join('\n\n');
}

// ── PowerPoint (.pptx) ──
// One slide: its title (#), each text paragraph on a line (indented by its outline level), tables one row a line.
export function slideXml(xml, { notes = false } = {}) {
  const lines = [];
  let shape = null, table = null, cell = null, para = null, inText = false, skip = '', depth = 0, pictures = 0, inFrame = false, frameHasTable = false;
  walk(xml, {
    open(name, a, self) {
      if (skip) { if (name === skip && !self) depth++; return; }
      if (name === 'mc:Fallback' || (name === 'a:fld' && /slidenum|datetime/i.test(attr(a, 'type')))) { if (!self) { skip = name; depth = 1; } return; }
      switch (name) {
        case 'p:sp': shape = { ph: '', paras: [] }; break;
        case 'p:ph': if (shape) shape.ph = attr(a, 'type') || 'body'; break;
        case 'p:pic': pictures++; break;
        case 'p:graphicFrame': inFrame = true; frameHasTable = false; break;
        case 'a:tbl': table = []; frameHasTable = true; break;
        case 'a:tr': table?.push([]); break;
        case 'a:tc': cell = []; break;
        case 'a:p': para = { text: '', lvl: 0 }; break;
        case 'a:pPr': if (para) para.lvl = Number(attr(a, 'lvl')) || 0; break;
        case 'a:br': if (para) para.text += '\n'; break;
        case 'a:t': inText = !self; break;
        default:
      }
    },
    close(name) {
      if (skip) { if (name === skip && --depth === 0) skip = ''; return; }
      switch (name) {
        case 'a:t': inText = false; break;
        case 'a:p': {
          if (!para) break;
          const text = para.text.replace(/\s+$/, '');
          if (cell) { if (text) cell.push(text); } else if (shape && text) shape.paras.push({ text, lvl: para.lvl });
          para = null; break;
        }
        case 'a:tc': if (table?.length && cell) table[table.length - 1].push(cell.join(' / ')); cell = null; break;
        case 'a:tbl': if (table) lines.push(...table.map((r) => r.join(' | ')).filter((r) => r.replace(/[ |]/g, ''))); table = null; break;
        case 'p:graphicFrame': if (inFrame && !frameHasTable) pictures++; inFrame = false; break; // a chart or a diagram
        case 'p:sp': {
          if (!shape) break;
          const ph = shape.ph;
          if (notes ? ph === 'body' : !/^(sldNum|dt|ftr|hdr|sldImg)$/.test(ph)) {
            if (!notes && /title/i.test(ph) && !/sub/i.test(ph)) { const t = shape.paras.map((p) => p.text).join(' ').replace(/\s+/g, ' '); if (t) lines.push(`# ${t}`); }
            else for (const p of shape.paras) lines.push(`${'  '.repeat(Math.min(p.lvl, 6))}${p.text}`);
          }
          shape = null; break;
        }
        default:
      }
    },
    text(s) { if (inText && para && !skip) para.text += s; },
  });
  return { text: lines.join('\n'), pictures, hidden: /<p:sld\b[^>]*\bshow="(?:0|false)"/.test(xml.slice(0, 2000)) };
}
function pptxText(zip) {
  const pres = zip.text('ppt/presentation.xml'), links = rels(zip, 'ppt/presentation.xml');
  let slides = [...pres.matchAll(/<p:sldId\b([^>]*?)\/?>/g)].map((m) => links.get(attr(m[1], 'r:id'))?.target).filter((p) => p && zip.has(p));
  if (!slides.length) slides = zip.names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort(byPartNumber);
  if (!slides.length) throw new Error('That presentation has no slides Atelier can read.');
  const out = [];
  let size = 0;
  for (const [i, part] of slides.entries()) {
    if (size > FILE_CHARS + 2000) break;
    if (!zip.fits(part)) { out.push(`--- Slide ${i + 1} ---\n[This slide is too big to read here.]`); continue; }
    const s = slideXml(zip.text(part));
    const notesPart = [...rels(zip, part).values()].find((r) => r.type === 'notesSlide')?.target;
    const notes = notesPart && zip.fits(notesPart) ? slideXml(zip.text(notesPart), { notes: true }).text : '';
    const block = [`--- Slide ${i + 1}${s.hidden ? ' (hidden)' : ''} ---`, s.text, notes && `Speaker notes: ${notes}`, s.pictures ? `[${plural(s.pictures, 'picture or chart', 'pictures or charts')} not read]` : ''].filter(Boolean).join('\n');
    out.push(block); size += block.length;
  }
  return out.join('\n\n');
}

// ── OpenDocument (.odt .ods .odp): LibreOffice, and the OpenDocument export of Word, Excel and Google Docs ──
// A footnote, a comment and a text box all sit inside the paragraph that holds them, with paragraphs of their own.
export function odfXml(xml, kind) {
  const lines = [], paras = [], wraps = [];
  let row = null, cell = null, skip = '', depth = 0, slide = 0, repeat = 1, list = 0, title = false;
  const para = () => paras[paras.length - 1];
  const sink = () => (wraps.length ? wraps[wraps.length - 1].lines : cell ? cell.text : lines);
  const SKIP = new Set(['text:tracked-changes', 'text:note-citation', 'dc:creator', 'dc:date', 'meta:creator-initials', 'draw:image', 'draw:page-thumbnail',
    'text:page-number', 'text:page-count', 'svg:title', 'svg:desc']);
  const WRAP = { 'text:note': 'Footnote', 'office:annotation': 'Comment', 'presentation:notes': 'Speaker notes' };
  const wrapOf = (name, a) => (name === 'draw:text-box' ? (kind === 'odt' ? 'Text box' : '') : name === 'text:note' && attr(a, 'text:note-class') === 'endnote' ? 'Endnote' : WRAP[name] || '');
  const open = []; // which wrapping elements are open, so their closing tags are matched
  walk(xml, {
    open(name, a, self) {
      if (skip) { if (name === skip && !self) depth++; return; }
      if (SKIP.has(name)) { if (!self) { skip = name; depth = 1; } return; }
      if (name === 'text:note' || name === 'office:annotation' || name === 'presentation:notes' || name === 'draw:text-box') {
        const w = wrapOf(name, a);
        if (!self) { open.push(w ? name : ''); if (w) wraps.push({ kind: w, lines: [], host: para() }); }
        return;
      }
      switch (name) {
        case 'draw:page': slide++; lines.push(`${slide > 1 ? '\n' : ''}--- Slide ${slide} ---`); break;
        case 'draw:frame': title = /title/i.test(attr(a, 'presentation:class')) && !/sub/i.test(attr(a, 'presentation:class')); break;
        case 'table:table': if (kind === 'ods') lines.push(`${lines.length ? '\n' : ''}--- Sheet: ${attr(a, 'table:name') || 'Sheet'} ---`); break;
        case 'table:table-row': row = []; break;
        case 'table:table-cell': case 'table:covered-table-cell': {
          repeat = Math.min(Number(attr(a, 'table:number-columns-repeated')) || 1, COLS_MAX);
          const shown = attr(a, 'office:value-type') === 'date' ? attr(a, 'office:date-value').replace(/T00:00:00(?:\.0+)?$/, '').replace('T', ' ').replace(/(\d\d:\d\d):00(?:\.0+)?$/, '$1') : '';
          cell = { text: [], shown };
          if (self) { if (row) for (let i = 0; i < repeat && row.length < COLS_MAX; i++) row.push(''); cell = null; }
          break;
        }
        case 'text:list': list++; break;
        case 'text:p': paras.push({ text: '', tail: '', level: 0, bullet: list > 0 && !wraps.length, after: [], link: null }); break;
        case 'text:h': paras.push({ text: '', tail: '', level: Number(attr(a, 'text:outline-level')) || 1, bullet: false, after: [], link: null }); break;
        case 'text:tab': if (para()) para().text += '\t'; break;
        case 'text:line-break': if (para()) para().text += '\n'; break;
        case 'text:s': if (para()) para().text += ' '.repeat(Math.min(Number(attr(a, 'text:c')) || 1, 100)); break;
        case 'text:a': if (para()) para().link = { at: para().text.length, url: attr(a, 'xlink:href') }; break;
        default:
      }
    },
    close(name) {
      if (skip) { if (name === skip && --depth === 0) skip = ''; return; }
      if (name === 'text:note' || name === 'office:annotation' || name === 'presentation:notes' || name === 'draw:text-box') {
        if (!open.pop()) return;
        const w = wraps.pop(), text = w ? w.lines.filter(Boolean).join(' / ').trim() : '';
        if (!text) return;
        if (w.kind === 'Speaker notes') lines.push(`Speaker notes: ${text}`);
        else if (w.kind === 'Text box') (w.host ? w.host.after : sink()).push(`[Text box] ${text}`);
        else if (w.host && w.kind === 'Comment') w.host.tail += ` [Comment: ${text}]`; // a comment opens before the words it is about
        else if (w.host) w.host.text += ` [${w.kind}: ${text}]`;
        else sink().push(`[${w.kind}: ${text}]`);
        return;
      }
      switch (name) {
        case 'text:a': { const p = para(), l = p?.link; if (l?.url && /^(https?|mailto):/i.test(l.url) && !p.text.slice(l.at).includes(l.url)) p.text += ` (${l.url})`; if (p) p.link = null; break; }
        case 'text:p': case 'text:h': {
          const p = paras.pop();
          if (!p) break;
          const text = `${p.text.replace(/[ \t]+$/, '')}${p.tail}`.trim() ? `${p.text.replace(/[ \t]+$/, '')}${p.tail}` : '', to = sink(), plain = Boolean(cell) || wraps.length > 0;
          to.push(plain || !text ? text : p.level || title ? `${'#'.repeat(Math.min(p.level || 1, 6))} ${text}` : p.bullet ? `${'  '.repeat(Math.max(0, list - 1))}- ${text}` : text);
          to.push(...p.after);
          break;
        }
        case 'draw:frame': title = false; break;
        case 'text:list': list = Math.max(0, list - 1); break;
        case 'table:table-cell': case 'table:covered-table-cell':
          if (cell && row) { const v = cell.shown || cell.text.filter(Boolean).join(kind === 'ods' ? '\n' : ' / '); for (let i = 0; i < repeat && row.length < COLS_MAX; i++) row.push(v); }
          cell = null; break;
        case 'table:table-row':
          if (row) { while (row.length && !row.at(-1)) row.pop(); if (kind === 'ods') lines.push(row.map((v) => csvCell(v)).join(',')); else if (row.length) lines.push(row.join(' | ')); }
          row = null; break;
        default:
      }
    },
    text(t) { if (para() && !skip) para().text += t; },
  });
  return tidy(lines.join('\n'));
}
function odfText(kind, zip) {
  if (!zip.has('content.xml')) throw new Error('That isn’t an OpenDocument file Atelier can read.');
  if (!zip.fits('content.xml')) throw new Error('That file is too big to read here.');
  const xml = zip.text('content.xml');
  return odfXml(/<office:body>([\s\S]*)<\/office:body>/.exec(xml)?.[1] ?? xml, kind);
}

// ── Rich Text (.rtf) ──
// Word's RTF is mostly tables of fonts, colors and styles, plus pictures as hex. Only the document's own text is kept:
// a deleted (tracked) run is left out, a footnote reads in place, a link keeps its address, a text box gets its own line.
const RTF_SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'objdata', 'themedata', 'colorschememapping', 'datastore', 'latentstyles',
  'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'xmlnstbl', 'header', 'headerl', 'headerr', 'headerf', 'footer', 'footerl', 'footerr', 'footerf',
  'ftnsep', 'ftnsepc', 'ftncn', 'aftnsep', 'aftnsepc', 'aftncn', 'pgdsctbl', 'operator', 'author', 'title', 'subject', 'company', 'filetbl', 'revtbl',
  'listtext', 'pntext', 'nonshppict', 'template', 'bkmkstart', 'bkmkend', 'mmathPr', 'defchp', 'defpap', 'wgrffmtfilter', 'passwordhash', 'xe', 'tc',
  'annotation', 'atnid', 'atnauthor', 'atrfstart', 'atrfend']);
const RTF_CHAR = { par: '\n', line: '\n', sect: '\n', page: '\n', tab: '\t', cell: ' | ', row: '\n', emdash: '—', endash: '–', lquote: '‘', rquote: '’', ldblquote: '“',
  rdblquote: '”', bullet: '•', emspace: ' ', enspace: ' ', qmspace: ' ' };
export function rtfText(src) {
  const s = String(src);
  if (!/^\s*\{\\rtf/.test(s)) return s;
  const cp1252 = new TextDecoder('windows-1252');
  const out = [], stack = [];
  let st = { skip: false, uc: 1, del: false, inst: false, close: null };
  let pending = 0, i = 0, star = false, code = '';
  const emit = (t) => {
    if (pending > 0) { pending--; return; }
    if (st.inst) { if (code.length < 2000) code += t; return; }
    if (!st.skip && !st.del) out.push(t);
  };
  while (i < s.length) {
    const ch = s[i];
    if (ch === '{') { stack.push(st); st = { ...st, close: null }; star = false; i++; }
    else if (ch === '}') { st.close?.(); st = stack.pop() || st; star = false; pending = 0; i++; }
    else if (ch === '\\') {
      const next = s[i + 1];
      if (next === "'") { const b = parseInt(s.slice(i + 2, i + 4), 16); i += 4; if (Number.isFinite(b)) emit(cp1252.decode(new Uint8Array([b]))); }
      else if (next === '*') { star = true; i += 2; }
      else if (next === '\\' || next === '{' || next === '}') { emit(next); i += 2; }
      else if (next === '~') { emit('\u00a0'); i += 2; }
      else if (next === '_') { emit('-'); i += 2; }
      else if (next === '-' || next === '|' || next === ':') i += 2;
      else if (next === '\n' || next === '\r') { emit('\n'); i += 2; }
      else {
        const m = /^([a-zA-Z]+)(-?\d+)?[ ]?/.exec(s.slice(i + 1, i + 48));
        if (!m) { i += 2; continue; }
        i += 1 + m[0].length;
        const word = m[1], num = m[2] != null ? parseInt(m[2], 10) : null, wasStar = star;
        star = false;
        if (word === 'fldinst') { st.skip = true; st.inst = true; code = ''; }
        else if (word === 'fldrslt') {
          const outer = stack[stack.length - 1], live = !(outer?.skip || outer?.del), at = out.length;
          st.skip = !live; st.inst = false;
          st.close = () => { const url = /HYPERLINK\s+"([^"]+)"/i.exec(code)?.[1]; code = ''; if (live && url && /^(https?|mailto):/i.test(url) && !out.slice(at).join('').includes(url)) out.push(` (${url})`); };
        } else if (word === 'shptxt') { st.skip = false; st.del = false; st.inst = false; out.push('\n[Text box] '); st.close = () => out.push('\n'); }
        else if (word === 'footnote') { if (!st.skip && !st.del) { out.push(' [Note: '); st.close = () => out.push(']'); } }
        else if (wasStar || RTF_SKIP.has(word)) { st.skip = true; st.inst = false; }
        else if (word === 'deleted') st.del = num !== 0;
        else if (word === 'plain') st.del = false;
        else if (word === 'u' && num != null) { emit(String.fromCharCode(num < 0 ? num + 65536 : num)); pending = st.uc; }
        else if (word === 'uc' && num != null) st.uc = num;
        else if (word === 'bin' && num != null) i += Math.max(0, num);
        else if (RTF_CHAR[word] != null) { pending = 0; if (!st.skip && !st.del && !st.inst) out.push(RTF_CHAR[word]); }
      }
    } else if (ch === '\r' || ch === '\n') i++;
    else { emit(ch); i++; }
  }
  return tidy(out.join('').replace(/\[Note:\s+/g, '[Note: ').replace(/[ \t]+\]/g, ']').replace(/ \| \n/g, '\n'));
}

// ── a saved web page (.html) ──
const HTML_ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", mdash: '—', ndash: '–', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  copy: '©', reg: '®', trade: '™', bull: '•', middot: '·', laquo: '«', raquo: '»', deg: '°', euro: '€', pound: '£', yen: '¥', cent: '¢', times: '×', divide: '÷',
  frac12: '½', frac14: '¼', frac34: '¾', eacute: 'é', egrave: 'è', agrave: 'à', aacute: 'á', uuml: 'ü', ouml: 'ö', auml: 'ä', ntilde: 'ñ', ccedil: 'ç', szlig: 'ß',
  rarr: '→', larr: '←', check: '✓', sect: '§', para: '¶', plusmn: '±', le: '≤', ge: '≥', ne: '≠', minus: '−', zwnj: '', zwj: '', shy: '', ensp: ' ', emsp: ' ', thinsp: ' ' };
const HTML_BLOCK = /^(p|div|section|article|ul|ol|blockquote|pre|header|footer|main|nav|dd|dt|dl|figcaption|figure|form|address|aside|details|summary|fieldset|caption|thead|tbody|tfoot)$/;
// A page's own words: scripts, styles and markup gone, headings (#) and list items (-) kept, a table row on one line.
export function htmlText(src) {
  let s = String(src);
  const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(s)?.[1] || '';
  s = s.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<![^>]*>/g, ' ').replace(/<\?[\s\S]*?\?>/g, ' ')
    .replace(/<(script|style|svg|noscript|template|head|iframe|object|select|textarea|del)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>|([^<]+)|</g, tables = [];
  let out = '', cells = 0, m;
  while ((m = re.exec(s))) {
    if (m[4] != null) { out += m[4].replace(/\s+/g, ' '); continue; }
    if (!m[2]) { out += '<'; continue; }
    const tag = m[2].toLowerCase(), closing = Boolean(m[1]), nl = cells ? ' ' : '\n';
    if (tag === 'br' || tag === 'hr') out += nl;
    else if (tag === 'table') { if (closing) cells = tables.pop() ?? 0; else tables.push(cells); out += cells ? ' ' : '\n'; }
    else if (tag === 'td' || tag === 'th') { if (closing) { cells = Math.max(0, cells - 1); out += ' | '; } else cells++; }
    else if (tag === 'tr') { if (closing) out += nl; }
    else if (tag === 'img') { const alt = /\balt\s*=\s*"([^"]{1,200})"/i.exec(m[3])?.[1]?.trim(); if (alt && !closing) out += ` [Image: ${alt}] `; }
    else if (/^h[1-6]$/.test(tag)) out += closing || cells ? nl : `\n${'#'.repeat(Number(tag[1]))} `;
    else if (tag === 'li') out += closing ? '' : cells ? ' ' : '\n- ';
    else if (HTML_BLOCK.test(tag)) out += nl;
  }
  const ent = (all, k) => {
    if (k[0] === '#') { const n = k[1] === 'x' || k[1] === 'X' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10); try { return String.fromCodePoint(n); } catch { return all; } }
    return HTML_ENT[k] ?? HTML_ENT[k.toLowerCase()] ?? all;
  };
  const text = (t) => t.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, ent);
  const body = text(out).split('\n').map((l) => l.replace(/[ \t\f\v\u00a0]+/g, ' ').replace(/(?: ?\| ?)+$/, '').replace(/^(?: ?\| ?)+/, '').trim()).join('\n');
  const head = text(title).replace(/\s+/g, ' ').trim();
  return tidy(`${head && !body.includes(head) ? `# ${head}\n\n` : ''}${body}`);
}

// ── text, whatever it was saved as ──
// Excel's own CSV is Windows-1252 and its "Unicode text" is UTF-16. Read as UTF-8, "café" came out as "caf" plus a box.
export function decodeText(bytes, { html = false } = {}) {
  const dec = (label, from = 0) => new TextDecoder(label).decode(from ? bytes.subarray(from) : bytes);
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return dec('utf-8', 3);
  if (bytes[0] === 0xFF && bytes[1] === 0xFE) return dec('utf-16le', 2);
  if (bytes[0] === 0xFE && bytes[1] === 0xFF) return dec('utf-16be', 2);
  const n = Math.min(bytes.length, 2000);
  let odd = 0, even = 0;
  for (let i = 0; i < n; i++) if (bytes[i] === 0) { if (i & 1) odd++; else even++; }
  if (n >= 8 && odd > n * 0.3 && even < n * 0.05) return dec('utf-16le');
  if (n >= 8 && even > n * 0.3 && odd < n * 0.05) return dec('utf-16be');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* not UTF-8 */ }
  if (html) {
    const label = /<meta\b[^>]*charset\s*=\s*["']?\s*([\w-]+)/i.exec(new TextDecoder('windows-1252').decode(bytes.subarray(0, 4096)))?.[1];
    try { if (label) return dec(label); } catch { /* a label this browser doesn't know */ }
  }
  return dec('windows-1252');
}

// ── PDF: one page's text, from the pieces pdf.js hands back ──
// pdf.js marks where a line ends (hasEOL) and puts the spaces in itself, as pieces of their own, so the pieces are
// joined as they come. (v113 added a space after every piece: a word that arrived in two pieces was split in two.)
export function pdfPageText(items) {
  let s = '';
  for (const it of items || []) { if (typeof it?.str === 'string') s += it.str; if (it?.hasEOL) s += '\n'; }
  return s.replace(/[ \t\xa0]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ── every kind but PDF ──
export function readFile(kind, bytes, fflate) {
  switch (kind) {
    case 'docx': return docxText(openZip(bytes, fflate));
    case 'xlsx': return xlsxText(openZip(bytes, fflate));
    case 'pptx': return pptxText(openZip(bytes, fflate));
    case 'odt': case 'ods': case 'odp': return odfText(kind, openZip(bytes, fflate));
    case 'doc': case 'xls': case 'ppt': return legacyText(kind, bytes, { formatCell, builtinFormat, csvCell });
    case 'rtf': return rtfText(new TextDecoder('windows-1252').decode(bytes));
    case 'html': return htmlText(decodeText(bytes, { html: true }));
    default: return decodeText(headBytes(bytes, TEXT_BYTES));
  }
}
// The first n bytes, ending on a whole UTF-8 character: a cut mid-character would fail the UTF-8 check for the whole text.
function headBytes(bytes, n) {
  if (bytes.length <= n) return bytes;
  let end = n;
  while (end > n - 4 && end > 0 && (bytes[end] & 0xC0) === 0x80) end--;
  return bytes.subarray(0, end);
}

// How much of a budget a text uses: its characters (the owner's budgets), or its UTF-8 bytes (a tester's: the server
// caps a tester's whole request in bytes, src/tester/router.js, and 150,000 Chinese characters are 450 KB).
const utf8Of = (cp) => (cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4);
export function textSize(text, bytes = false) {
  const s = String(text || '');
  if (!bytes) return s.length;
  let n = 0;
  for (let i = 0; i < s.length; i++) { const cp = s.codePointAt(i); n += utf8Of(cp); if (cp > 0xffff) i++; }
  return n;
}
// The first part of a text that fits max (characters, or UTF-8 bytes). Never half of a pair: a cut inside an emoji or a
// rare CJK character left a lone surrogate at the end, which a request carries as an escape some providers refuse, and
// which kept the whole text inside the synced thread document (v114).
export function clipText(text, max = FILE_CHARS, { bytes = false } = {}) {
  const s = String(text || '');
  let end = s.length;
  if (bytes) {
    let used = 0, i = 0;
    while (i < s.length) { const cp = s.codePointAt(i), n = utf8Of(cp); if (used + n > max) break; used += n; i += cp > 0xffff ? 2 : 1; }
    end = i;
  } else if (s.length > max) {
    end = Math.max(0, max);
    const last = s.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--; // the first half of a pair: stop before it
  }
  return end >= s.length ? { text: s, cut: false } : { text: s.slice(0, end), cut: true };
}
// The whole set a turn sends: each file in order, the later ones cut once the total is used up. A file there was no
// room left for keeps its name and no text (cut, with nothing kept): the turn shows it as not sent.
// opts: { total, each, bytes } (a number is the total, as before).
export function fitFiles(files, opts = {}) {
  const { total = FILES_CHARS, each = FILE_CHARS, bytes = false } = typeof opts === 'number' ? { total: opts } : opts || {};
  let left = total;
  return (files || []).map((f) => {
    const { text, cut } = clipText(f.text, Math.max(0, Math.min(each, left)), { bytes });
    left -= textSize(text, bytes);
    return { ...f, text, cut: Boolean(f.cut || cut) };
  });
}
// A file fitFiles had no room for at all.
export const leftOut = (f) => Boolean(f?.cut && !f.text);
