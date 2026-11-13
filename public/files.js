// v113: documents attached to a chat turn (PDF, Word, Excel, PowerPoint, text, code, CSV, JSON…). Each one is read on
// this device into plain text, and the text goes to the model inside the turn's message (context.js withFiles), so every
// chat model can read it: Claude, GPT, Gemini, Kimi alike. Nothing is uploaded on its own.
// Pure module (no DOM): app.js passes fflate in, and reads PDFs itself with pdf.js (pdfText). Tests run it in Node.
//   docKind(name, type)        → 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'text' | 'old' (a binary .doc/.xls/.ppt) | ''
//   officeText(kind, bytes, f) → the text of a .docx / .xlsx / .pptx (f: fflate's { unzipSync, strFromU8 })
//   clipText(text, max)        → { text, cut } with the text cut at max characters
export const FILE_MAX_BYTES = 50 * 1024 * 1024; // a bigger file isn't read
export const FILE_CHARS = 150_000; // one file's text, at most (~40k tokens)
export const FILES_CHARS = 250_000; // all of one turn's files together
export const MAX_FILES = 5;

const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'xml', 'html', 'htm', 'yaml', 'yml', 'toml', 'ini', 'log',
  'rtf', 'tex', 'srt', 'vtt', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp',
  'cs', 'php', 'sh', 'ps1', 'bat', 'sql', 'css', 'scss', 'vue', 'svelte', 'r', 'lua', 'pl', 'dart', 'ics', 'vcf', 'env', 'conf', 'cfg']);
const extOf = (name = '') => (/\.([a-z0-9]+)$/i.exec(String(name))?.[1] || '').toLowerCase();

export function docKind(name = '', type = '') {
  const ext = extOf(name), t = String(type || '').toLowerCase();
  if (ext === 'pdf' || t === 'application/pdf') return 'pdf';
  if (ext === 'docx' || t.includes('wordprocessingml')) return 'docx';
  if (ext === 'xlsx' || ext === 'xlsm' || t.includes('spreadsheetml')) return 'xlsx';
  if (ext === 'pptx' || t.includes('presentationml')) return 'pptx';
  if (['doc', 'xls', 'ppt', 'pages', 'numbers', 'key'].includes(ext)) return 'old';
  if (TEXT_EXT.has(ext) || t.startsWith('text/') || /json|xml|javascript|yaml|csv/.test(t)) return 'text';
  return '';
}
export const KIND_LABEL = Object.freeze({ pdf: 'PDF', docx: 'Word', xlsx: 'Excel', pptx: 'PowerPoint', text: 'Text' });

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const unxml = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, k) => {
  if (k[0] === '#') { const n = k[1] === 'x' || k[1] === 'X' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10); try { return String.fromCodePoint(n); } catch { return m; } }
  return ENT[k.toLowerCase()] ?? m;
});
// The text runs of one XML chunk: <w:t>, <a:t> or <t> elements, joined.
const runs = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => unxml(m[1])).join('');
const tidy = (s) => s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

// Word: paragraphs, tabs and line breaks kept, table cells split by " | ".
export function docxText(xml) {
  const body = String(xml).replace(/<w:tab\/>/g, '<w:t>\t</w:t>').replace(/<w:br[^>]*\/>/g, '<w:t>\n</w:t>').replace(/<\/w:tc>/g, '<w:t> | </w:t></w:tc>');
  const paras = body.split(/<\/w:p>/).map((p) => runs(p, 'w:t'));
  return tidy(paras.join('\n').replace(/ \| \n/g, '\n'));
}
// Excel: each sheet under its name, one row per line, cells as CSV.
const colNum = (ref) => { let n = 0; for (const ch of String(ref).replace(/\d+/g, '').toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
const csvCell = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
export function sheetText(xml, shared = []) {
  const rows = [];
  for (const r of String(xml).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1], inner = c[2] || '';
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1], t = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let val = t === 's' ? shared[Number(v)] ?? '' : t === 'inlineStr' ? runs(inner, 't') : t === 'b' ? (v === '1' ? 'TRUE' : 'FALSE') : v != null ? unxml(v) : '';
      const at = ref ? colNum(ref) : cells.length;
      while (cells.length < at) cells.push('');
      cells[at] = csvCell(String(val));
    }
    while (cells.length && cells.at(-1) === '') cells.pop();
    rows.push(cells.join(','));
  }
  while (rows.length && !rows.at(-1)) rows.pop();
  return rows.join('\n');
}
export const sharedStrings = (xml) => [...String(xml || '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => runs(m[1], 't'));
// PowerPoint: each slide's text in order, paragraphs on their own lines.
export const slideText = (xml) => tidy(String(xml).split(/<\/a:p>/).map((p) => runs(p, 'a:t')).join('\n'));

const byNumber = (re) => (a, b) => Number(re.exec(a)?.[1] || 0) - Number(re.exec(b)?.[1] || 0);
export function officeText(kind, bytes, { unzipSync, strFromU8 }) {
  const want = kind === 'docx' ? /^word\/document\.xml$/ : kind === 'xlsx' ? /^xl\/(worksheets\/sheet\d+\.xml|sharedStrings\.xml|workbook\.xml)$/ : /^ppt\/slides\/slide\d+\.xml$/;
  let zip;
  try { zip = unzipSync(bytes, { filter: (f) => want.test(f.name) }); } catch { throw new Error('That file looks damaged — couldn’t open it.'); }
  const str = (n) => (zip[n] ? strFromU8(zip[n]) : '');
  if (kind === 'docx') {
    if (!zip['word/document.xml']) throw new Error('That isn’t a Word document Atelier can read.');
    return docxText(str('word/document.xml'));
  }
  if (kind === 'pptx') {
    const re = /slide(\d+)\.xml$/;
    const slides = Object.keys(zip).sort(byNumber(re));
    if (!slides.length) throw new Error('That presentation has no slides Atelier can read.');
    return slides.map((n, i) => `--- Slide ${i + 1} ---\n${slideText(str(n))}`).join('\n\n');
  }
  const shared = sharedStrings(str('xl/sharedStrings.xml'));
  const names = [...str('xl/workbook.xml').matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => unxml(m[1]));
  const re = /sheet(\d+)\.xml$/;
  const sheets = Object.keys(zip).filter((n) => /worksheets\//.test(n)).sort(byNumber(re));
  if (!sheets.length) throw new Error('That spreadsheet has no sheets Atelier can read.');
  return sheets.map((n, i) => `--- Sheet: ${names[i] || `Sheet ${i + 1}`} ---\n${sheetText(str(n), shared)}`).join('\n\n');
}

export function clipText(text, max = FILE_CHARS) {
  const s = String(text || '');
  return s.length <= max ? { text: s, cut: false } : { text: s.slice(0, max), cut: true };
}
// The whole set a turn sends: each file in order, the later ones cut once FILES_CHARS is used up.
export function fitFiles(files, total = FILES_CHARS) {
  let left = total;
  return (files || []).map((f) => {
    const { text, cut } = clipText(f.text, Math.max(0, Math.min(FILE_CHARS, left)));
    left -= text.length;
    return { ...f, text, cut: Boolean(f.cut || cut) };
  });
}
