// Word, Excel and PowerPoint files from before 2007 (.doc .xls .ppt), which schools, councils and suppliers still send.
// Each is an OLE2 "compound file": a small file system of named streams. This reads just far enough for the text
// (v114). Pure module, no DOM: files.js calls legacyText, and tests run it in Node against files Office itself saved.
// Formats: [MS-CFB] the container, [MS-DOC] Word, [MS-XLS] Excel (BIFF8), [MS-PPT] PowerPoint.
const NONE = 0xFFFFFFFA; // sector numbers from here up mean "free" or "end of chain"
const tidy = (s) => s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const CHARS = 152_000; // a little past files.js FILE_CHARS, so its clipText sees a cut and says so
const latin1 = (b, at, n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(b[at + i]); return s; };
const utf16 = (dv, at, n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(dv.getUint16(at + i * 2, true)); return s; };
const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);

// ── the container ──
// → { stream(name) → Uint8Array | null } for the streams in the root folder.
export function cfb(bytes) {
  const dv = view(bytes);
  if (bytes.length < 512 || dv.getUint32(0, true) !== 0xE011CFD0 || dv.getUint32(4, true) !== 0xE11AB1A1) throw new Error('That isn’t an Office file Atelier can read.');
  const ssz = 1 << dv.getUint16(30, true), msz = 1 << dv.getUint16(32, true);
  if ((ssz !== 512 && ssz !== 4096) || msz !== 64) throw new Error('That file looks damaged — couldn’t open it.');
  const nFat = dv.getUint32(44, true), dirStart = dv.getUint32(48, true), cutoff = dv.getUint32(56, true), miniFatStart = dv.getUint32(60, true), difatStart = dv.getUint32(68, true);
  const maxSecs = Math.ceil(bytes.length / ssz) + 1, per = ssz / 4;
  const at = (sec) => (sec + 1) * ssz;
  const fatSecs = [];
  for (let i = 0; i < 109 && fatSecs.length < nFat; i++) { const s = dv.getUint32(76 + i * 4, true); if (s < NONE) fatSecs.push(s); }
  for (let ds = difatStart, guard = 0; ds < NONE && guard++ < maxSecs && at(ds) + ssz <= bytes.length;) {
    const o = at(ds);
    for (let i = 0; i < per - 1 && fatSecs.length < nFat; i++) { const s = dv.getUint32(o + i * 4, true); if (s < NONE) fatSecs.push(s); }
    ds = dv.getUint32(o + ssz - 4, true);
  }
  const fat = (sec) => { const fs = fatSecs[Math.floor(sec / per)]; if (fs == null) return 0xFFFFFFFE; const o = at(fs) + (sec % per) * 4; return o + 4 <= bytes.length ? dv.getUint32(o, true) : 0xFFFFFFFE; };
  const chain = (start) => { const out = []; for (let s = start, n = 0; s < NONE && n++ < maxSecs; s = fat(s)) out.push(s); return out; };
  const read = (start, size) => {
    const secs = chain(start), total = size == null ? secs.length * ssz : Math.min(size, secs.length * ssz);
    const out = new Uint8Array(total);
    let p = 0;
    for (const s of secs) { if (p >= total) break; const o = at(s), n = Math.min(ssz, total - p, bytes.length - o); if (n <= 0) break; out.set(bytes.subarray(o, o + n), p); p += n; }
    return out;
  };
  const dir = read(dirStart), ddv = view(dir);
  const entry = (i) => {
    const o = i * 128;
    if (i < 0 || o + 128 > dir.length) return null;
    const nlen = Math.min(64, ddv.getUint16(o + 64, true));
    return { name: utf16(ddv, o, Math.max(0, nlen / 2 - 1)), type: dir[o + 66], left: ddv.getUint32(o + 68, true), right: ddv.getUint32(o + 72, true), child: ddv.getUint32(o + 76, true), start: ddv.getUint32(o + 116, true), size: ddv.getUint32(o + 120, true) };
  };
  const root = entry(0);
  if (!root || root.type !== 5) throw new Error('That file looks damaged — couldn’t open it.');
  const top = new Map(); // the root folder's own streams (an embedded object keeps its streams in a sub-folder)
  for (const stack = [root.child], seen = new Set(); stack.length;) {
    const id = stack.pop();
    if (id >= NONE || seen.has(id)) continue;
    seen.add(id);
    const e = entry(id);
    if (!e) continue;
    if (e.type === 2 && !top.has(e.name)) top.set(e.name, e);
    stack.push(e.left, e.right);
  }
  let mini = null, miniFat = null;
  return {
    names: [...top.keys()],
    stream(name) {
      const e = top.get(name);
      if (!e) return null;
      if (e.size >= cutoff) return read(e.start, e.size);
      mini ??= read(root.start, root.size);
      miniFat ??= view(read(miniFatStart));
      const out = new Uint8Array(e.size);
      for (let s = e.start, p = 0, n = 0; s < NONE && p < e.size && n++ < maxSecs * 8;) {
        const o = s * msz, len = Math.min(msz, e.size - p);
        if (o + len > mini.length) break;
        out.set(mini.subarray(o, o + len), p); p += len;
        s = s * 4 + 4 <= miniFat.byteLength ? miniFat.getUint32(s * 4, true) : 0xFFFFFFFE;
      }
      return out;
    },
  };
}

// ── Word 97–2003 ──
// The text lives in pieces (the piece table), 8-bit or 16-bit. Text a tracked change deleted is still in the file, marked
// only in its character formatting, so those runs are found (deletedRanges) and left out: the text reads as Word shows
// it with every change accepted. Fields keep their result, not their code; a link keeps its address.
const FIELD_START = '\x13', FIELD_SEP = '\x14', FIELD_END = '\x15';
function plainWord(s) {
  let out = '';
  const stack = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === FIELD_START) { stack.push({ code: '', inCode: true, at: out.length }); continue; }
    if (ch === FIELD_SEP) { const t = stack[stack.length - 1]; if (t) t.inCode = false; continue; }
    if (ch === FIELD_END) {
      const t = stack.pop();
      const url = t && /HYPERLINK\s+"([^"]+)"/i.exec(t.code)?.[1];
      if (url && /^(https?|mailto):/i.test(url) && !out.slice(t.at).includes(url)) out += ` (${url})`;
      continue;
    }
    const open = stack[stack.length - 1];
    if (open?.inCode) { if (open.code.length < 2000) open.code += ch; continue; }
    if (stack.some((f) => f.inCode)) continue;
    out += ch;
  }
  return out.replace(/\x07\x07/g, '\n').replace(/\x07/g, ' | ').replace(/[\r\x0b]/g, '\n').replace(/\x0c/g, '\n\n').replace(/\x1e/g, '-')
    .replace(/[\x00-\x08\x0e-\x1f]/g, '').replace(/ \| \n/g, '\n');
}
// Stream offsets of the runs a tracked change deleted: every character run whose formatting says sprmCFRMarkDel.
function deletedRanges(wd, dv, table, tdv) {
  const fc = dv.getUint32(0xFA, true), lcb = dv.getUint32(0xFE, true), out = [];
  if (!lcb || fc + lcb > table.length) return out;
  const n = Math.floor((lcb - 4) / 8);
  for (let i = 0; i < n; i++) {
    const page = (tdv.getUint32(fc + (n + 1) * 4 + i * 4, true) & 0x3FFFFF) * 512;
    if (page + 512 > wd.length) continue;
    const crun = wd[page + 511];
    for (let r = 0; r < crun; r++) {
      const off = wd[page + (crun + 1) * 4 + r] * 2;
      if (!off) continue;
      const cb = wd[page + off];
      let q = page + off + 1;
      const end = Math.min(q + cb, page + 511);
      let deleted = false;
      while (q + 2 <= end) {
        const op = dv.getUint16(q, true), spra = op >> 13;
        q += 2;
        if (op === 0x0800 && q < end) deleted = (wd[q] & 0x7F) === 1;
        q += spra === 6 ? 1 + wd[q] : [1, 1, 2, 4, 2, 2, 0, 3][spra];
      }
      if (deleted) out.push([dv.getUint32(page + r * 4, true), dv.getUint32(page + (r + 1) * 4, true)]);
    }
  }
  return out;
}
function wordText(f) {
  const wd = f.stream('WordDocument');
  if (!wd || wd.length < 0x200) throw new Error('That isn’t a Word document Atelier can read.');
  const dv = view(wd);
  if (dv.getUint16(0, true) !== 0xA5EC) throw new Error('That isn’t a Word document Atelier can read.');
  const nFib = dv.getUint16(2, true), flags = dv.getUint16(0x0A, true);
  if (flags & 0x0100) throw new Error('that document has a password — remove it, then attach it again');
  if (nFib < 0xC1) { // Word 6 and 95: one run of 8-bit text
    if (flags & 0x0004) throw new Error('that document is from a very old Word — save it as .docx, then attach it again');
    const a = dv.getUint32(0x18, true), b = Math.min(dv.getUint32(0x1C, true), wd.length);
    return tidy(plainWord(new TextDecoder('windows-1252').decode(wd.subarray(a, Math.max(a, b)))));
  }
  const table = f.stream(flags & 0x0200 ? '1Table' : '0Table');
  if (!table) throw new Error('That document looks damaged — couldn’t open it.');
  const tdv = view(table);
  const ccp = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => Math.max(0, dv.getInt32(0x4C + i * 4, true))); // text, footnotes, headers, macros, comments, endnotes, text boxes, header text boxes
  let p = dv.getUint32(0x1A2, true);
  const clxEnd = Math.min(table.length, p + dv.getUint32(0x1A6, true));
  while (p + 3 <= clxEnd && table[p] === 1) p += 3 + tdv.getUint16(p + 1, true);
  if (p + 5 > clxEnd || table[p] !== 2) throw new Error('That document looks damaged — couldn’t open it.');
  const n = Math.floor((tdv.getUint32(p + 1, true) - 4) / 12);
  p += 5;
  const cp1252 = new TextDecoder('windows-1252'), u16le = new TextDecoder('utf-16le');
  const pieces = [];
  let full = '';
  for (let i = 0; i < n && p + (n + 1) * 4 + (i + 1) * 8 <= table.length; i++) {
    const cp0 = tdv.getUint32(p + i * 4, true), cp1 = tdv.getUint32(p + (i + 1) * 4, true), raw = tdv.getUint32(p + (n + 1) * 4 + i * 8 + 2, true);
    const small = (raw & 0x40000000) !== 0, fc = small ? (raw & 0x3FFFFFFF) >>> 1 : raw & 0x3FFFFFFF, width = small ? 1 : 2;
    const len = Math.max(0, Math.min(cp1 - cp0, Math.floor((wd.length - fc) / width)));
    if (cp1 <= cp0 || fc >= wd.length) continue;
    const text = (small ? cp1252 : u16le).decode(wd.subarray(fc, fc + len * width));
    pieces.push({ cp0: full.length, fc, width, len: text.length });
    full += text;
    if (full.length > 4_000_000) break;
  }
  const gone = new Uint8Array(full.length);
  let tracked = false;
  for (const [a, b] of deletedRanges(wd, dv, table, tdv)) {
    for (const pc of pieces) {
      const lo = Math.max(a, pc.fc), hi = Math.min(b, pc.fc + pc.len * pc.width);
      if (hi > lo) { gone.fill(1, pc.cp0 + Math.floor((lo - pc.fc) / pc.width), pc.cp0 + Math.ceil((hi - pc.fc) / pc.width)); tracked = true; }
    }
  }
  // Where the footnote and endnote marks sit in the main text (character positions), so each mark gets its own number.
  const refs = (index) => {
    const fc = dv.getUint32(0x9A + index * 8, true), lcb = dv.getUint32(0x9E + index * 8, true), map = new Map();
    const k = Math.floor((lcb - 4) / 6);
    for (let i = 0; i < k && fc + (i + 1) * 4 <= table.length; i++) map.set(tdv.getUint32(fc + i * 4, true), i + 1);
    return map;
  };
  const foot = refs(2), endn = refs(46);
  const take = (from, to, mark) => {
    let s = '';
    for (let i = Math.max(0, from); i < Math.min(to, full.length); i++) {
      if (gone[i]) continue;
      s += mark && full[i] === '\x02' ? mark(i) : full[i];
    }
    return s;
  };
  const starts = []; let acc = 0;
  for (const c of ccp) { starts.push(acc); acc += c; }
  const part = (i, mark) => take(starts[i], starts[i] + ccp[i], mark);
  const body = plainWord(part(0, (i) => (foot.has(i) ? `[^${foot.get(i)}]` : endn.has(i) ? `[^e${endn.get(i)}]` : '')));
  const out = [tidy(body)];
  // In its own story a note starts with its mark (\x02 for a footnote or endnote, \x05 for a comment); plainWord drops
  // those, so the stories are split first.
  const story = (i, sepChar) => take(starts[i], starts[i] + ccp[i]).split(sepChar).map((t) => plainWord(t).replace(/\s+/g, ' ').trim()).filter(Boolean);
  const push = (title, list, line) => { if (list.length) out.push(`--- ${title} ---\n${list.map(line).join('\n')}`); };
  push('Footnotes', story(1, '\x02'), (t, k) => `[^${k + 1}]: ${t}`);
  push('Endnotes', story(5, '\x02'), (t, k) => `[^e${k + 1}]: ${t}`);
  push('Comments', story(4, '\x05'), (t) => `- ${t}`);
  const lines = (i) => [...new Set(plainWord(part(i)).split('\n').map((t) => t.trim()).filter((t) => t && !/^\d+$/.test(t)))];
  const boxes = [...lines(6), ...lines(7)];
  if (boxes.length) out.push(boxes.map((t) => `[Text box] ${t}`).join('\n'));
  const heads = lines(2);
  if (heads.length) out.push(`--- Page headers and footers ---\n${heads.join('\n')}`);
  if (tracked) out.push('[This document has tracked changes. This is the text with every change accepted.]');
  return out.filter(Boolean).join('\n\n');
}

// ── Excel 97–2003 (BIFF8) ──
const XL_ERR = { 0x00: '#NULL!', 0x07: '#DIV/0!', 0x0F: '#VALUE!', 0x17: '#REF!', 0x1D: '#NAME?', 0x24: '#NUM!', 0x2A: '#N/A' };
function rkNumber(v) {
  let n;
  if (v & 2) n = (v | 0) >> 2;
  else { const b = new DataView(new ArrayBuffer(8)); b.setUint32(4, v & 0xFFFFFFFC, true); n = b.getFloat64(0, true); }
  return v & 1 ? n / 100 : n;
}
function bookText(f, { formatCell, builtinFormat, csvCell }) {
  const wb = f.stream('Workbook') || f.stream('Book');
  if (!wb) throw new Error('That isn’t a spreadsheet Atelier can read.');
  const dv = view(wb);
  const recAt = (p) => (p + 4 <= wb.length ? { id: dv.getUint16(p, true), at: p + 4, len: Math.min(dv.getUint16(p + 2, true), wb.length - p - 4) } : null);
  const first = recAt(0);
  if (!first || first.id !== 0x0809 || dv.getUint16(first.at, true) !== 0x0600) throw new Error('that spreadsheet is from before Excel 97 — save it as .xlsx, then attach it again');
  // A string: its length, a flags byte (bit 0: 16-bit characters), then the characters.
  const str = (o, lenBytes = 2) => {
    const cch = lenBytes === 2 ? dv.getUint16(o, true) : wb[o], wide = wb[o + lenBytes] & 1, q = o + lenBytes + 1;
    const n = Math.max(0, Math.min(cch, Math.floor((wb.length - q) / (wide ? 2 : 1))));
    return wide ? utf16(dv, q, n) : latin1(wb, q, n);
  };
  const sheets = [], formats = new Map(), xfs = [];
  let shared = [], date1904 = false;
  for (let p = 0, r; (r = recAt(p)); p = r.at + r.len) {
    if (r.id === 0x000A) break;
    if (r.id === 0x002F) throw new Error('that spreadsheet has a password — remove it, then attach it again');
    if (r.id === 0x0022) date1904 = dv.getUint16(r.at, true) === 1;
    else if (r.id === 0x041E && r.len >= 5) formats.set(dv.getUint16(r.at, true), str(r.at + 2));
    else if (r.id === 0x00E0 && r.len >= 4) xfs.push(dv.getUint16(r.at + 2, true));
    else if (r.id === 0x0085 && r.len >= 8) sheets.push({ at: dv.getUint32(r.at, true), hidden: (wb[r.at + 4] & 3) !== 0, kind: wb[r.at + 5], name: str(r.at + 6, 1) });
    else if (r.id === 0x00FC) {
      const segs = [r];
      for (let q = r.at + r.len, c; (c = recAt(q)) && c.id === 0x003C; q = c.at + c.len) segs.push(c);
      shared = sharedTable(wb, dv, segs);
    }
  }
  const code = (ixfe) => { const id = xfs[ixfe]; return formats.get(id) ?? builtinFormat(id); };
  const out = [];
  let left = CHARS;
  for (const s of sheets) {
    const title = `--- Sheet: ${s.name || 'Sheet'}${s.hidden ? ' (hidden)' : ''} ---`;
    if (s.kind !== 0) { if (s.kind === 2) out.push(`${title}\n[A chart sheet. Nothing to read as text.]`); continue; }
    if (left <= 0) { out.push(`${title}\n[Not read: the file is longer than Atelier sends.]`); continue; }
    const rows = new Map();
    let size = 0, last = null;
    const put = (row, col, text) => {
      if (col >= 256 || text === '') return;
      let r = rows.get(row);
      if (!r) rows.set(row, r = []);
      r[col] = csvCell(String(text).replace(/\r\n?/g, '\n')); size += r[col].length + 1;
    };
    const num = (row, col, ixfe, v) => put(row, col, formatCell(v, code(ixfe), date1904));
    for (let p = s.at, r, started = false; (r = recAt(p)) && size <= left; p = r.at + r.len) {
      if (!started) { if (r.id !== 0x0809) break; started = true; continue; }
      if (r.id === 0x000A) break;
      const row = r.len >= 6 ? dv.getUint16(r.at, true) : 0, col = r.len >= 6 ? dv.getUint16(r.at + 2, true) : 0, ixfe = r.len >= 6 ? dv.getUint16(r.at + 4, true) : 0;
      if (r.id === 0x00FD && r.len >= 10) put(row, col, shared[dv.getUint32(r.at + 6, true)] ?? '');
      else if ((r.id === 0x0204 || r.id === 0x00D6) && r.len >= 9) put(row, col, str(r.at + 6));
      else if (r.id === 0x0203 && r.len >= 14) num(row, col, ixfe, dv.getFloat64(r.at + 6, true));
      else if (r.id === 0x027E && r.len >= 10) num(row, col, ixfe, rkNumber(dv.getUint32(r.at + 6, true)));
      else if (r.id === 0x00BD && r.len >= 12) { for (let q = r.at + 4, c = col; q + 6 <= r.at + r.len - 2; q += 6, c++) num(row, c, dv.getUint16(q, true), rkNumber(dv.getUint32(q + 2, true))); }
      else if (r.id === 0x0205 && r.len >= 8) put(row, col, wb[r.at + 7] ? XL_ERR[wb[r.at + 6]] || '#ERR' : wb[r.at + 6] ? 'TRUE' : 'FALSE');
      else if (r.id === 0x0006 && r.len >= 14) {
        if (dv.getUint16(r.at + 12, true) === 0xFFFF) {
          const kind = wb[r.at + 6];
          if (kind === 0) last = [row, col]; else if (kind === 1) put(row, col, wb[r.at + 8] ? 'TRUE' : 'FALSE'); else if (kind === 2) put(row, col, XL_ERR[wb[r.at + 8]] || '#ERR');
        } else num(row, col, ixfe, dv.getFloat64(r.at + 6, true));
      } else if (r.id === 0x0207 && last && r.len >= 3) { put(last[0], last[1], str(r.at)); last = null; } // the text a formula returned
    }
    const lines = [];
    let prev = null;
    for (const k of [...rows.keys()].sort((a, b) => a - b)) {
      if (prev != null && k > prev + 1) lines.push('');
      const r = rows.get(k);
      lines.push(Array.from(r, (v) => v ?? '').join(','));
      prev = k;
    }
    const text = lines.join('\n');
    out.push(`${title}\n${text || '[Empty sheet]'}`); left -= text.length;
  }
  if (!out.length) throw new Error('That spreadsheet has no sheets Atelier can read.');
  return out.join('\n\n');
}
// The shared string table. It runs on through CONTINUE records; a string cut by a record boundary restates its
// character width in the first byte of the next record, while formatting runs and phonetic data just carry on.
function sharedTable(wb, dv, segs) {
  let si = 0, o = segs[0].at + 8, end = segs[0].at + segs[0].len;
  const total = Math.min(dv.getUint32(segs[0].at + 4, true), 2_000_000), out = [];
  const next = () => { if (++si >= segs.length) return false; o = segs[si].at; end = o + segs[si].len; return true; };
  while (out.length < total) {
    if (o >= end && !next()) break;
    if (o + 3 > end) break;
    const cch = dv.getUint16(o, true), flags = wb[o + 2];
    o += 3;
    let runs = 0, ext = 0, wide = flags & 1, s = '';
    if (flags & 0x08) { runs = dv.getUint16(o, true); o += 2; }
    if (flags & 0x04) { ext = dv.getUint32(o, true); o += 4; }
    for (let leftChars = cch; leftChars > 0;) {
      if (o >= end) { if (!next()) break; wide = wb[o] & 1; o += 1; }
      const can = Math.min(leftChars, Math.floor((end - o) / (wide ? 2 : 1)));
      if (can <= 0) { o = end; continue; }
      s += wide ? utf16(dv, o, can) : latin1(wb, o, can);
      o += can * (wide ? 2 : 1); leftChars -= can;
    }
    for (let skip = runs * 4 + ext; skip > 0;) { if (o >= end && !next()) break; const k = Math.min(skip, end - o); o += k; skip -= k; }
    out.push(s);
  }
  return out;
}

// ── PowerPoint 97–2003 ──
// Records nest; a container's version nibble is 0xF. A slide's title and body text sit in the document's slide list
// (the outline); text boxes and table cells sit in the slide's own record, found through the persist directory.
function slidesText(f) {
  const doc = f.stream('PowerPoint Document'), cur = f.stream('Current User');
  if (!doc) throw new Error('That isn’t a presentation Atelier can read.');
  const dv = view(doc), u32 = (o) => (o + 4 <= doc.length ? dv.getUint32(o, true) : 0), u16 = (o) => (o + 2 <= doc.length ? dv.getUint16(o, true) : 0);
  if (cur && cur.length >= 20 && view(cur).getUint32(12, true) === 0xF3D1C4DF) throw new Error('that presentation has a password — remove it, then attach it again');
  function* records(start, end) {
    for (let p = start; p + 8 <= end && p + 8 <= doc.length;) {
      const len = u32(p + 4), at = p + 8;
      if (at + len > doc.length) return;
      yield { ver: u16(p) & 0xF, inst: u16(p) >> 4, type: u16(p + 2), at, len };
      p = at + len;
    }
  }
  const head = (o) => (o + 8 <= doc.length ? { ver: u16(o) & 0xF, inst: u16(o) >> 4, type: u16(o + 2), at: o + 8, len: Math.min(u32(o + 4), doc.length - o - 8) } : null);
  const clean = (t) => t.replace(/[\r\x0b]/g, '\n').replace(/[\x00-\x08\x0c\x0e-\x1f]/g, '').replace(/[ \t]+\n/g, '\n').trim();
  // Every text in a record tree, in order: { kind (0 title, 1 body, 2 notes, 6 centered title, ...), text }.
  const texts = (r, depth = 0, out = [], state = { kind: 4 }) => {
    for (const c of records(r.at, r.at + r.len)) {
      if (c.type === 0x0F9F && c.len >= 4) state.kind = u32(c.at);
      else if (c.type === 0x0FA0) out.push({ kind: state.kind, text: clean(utf16(dv, c.at, c.len >> 1)) });
      else if (c.type === 0x0FA8) out.push({ kind: state.kind, text: clean(latin1(doc, c.at, c.len)) });
      else if (c.ver === 0xF && depth < 24) texts(c, depth + 1, out, state);
    }
    return out;
  };
  // The persist directory: object id → where its newest copy sits in the stream.
  const persist = new Map();
  let docRef = 0;
  for (let edit = cur && cur.length >= 20 ? view(cur).getUint32(16, true) : 0, guard = 0; edit && guard++ < 500;) {
    const e = head(edit);
    if (!e || e.type !== 0x0FF5 || e.len < 20) break;
    docRef ||= u32(e.at + 16);
    const d = head(u32(e.at + 12));
    if (d && d.type === 0x1772) {
      for (let q = d.at; q + 4 <= d.at + d.len;) {
        const v = u32(q), id = v & 0xFFFFF, count = v >>> 20;
        q += 4;
        for (let i = 0; i < count && q + 4 <= d.at + d.len; i++, q += 4) if (!persist.has(id + i)) persist.set(id + i, u32(q));
      }
    }
    edit = u32(e.at + 8);
  }
  const root = head(persist.get(docRef) ?? -1);
  const slides = [], notesOf = new Map();
  if (root && root.type === 0x03E8) {
    for (const list of records(root.at, root.at + root.len)) {
      if (list.type !== 0x0FF0 || (list.inst !== 0 && list.inst !== 2)) continue;
      let cur2 = null;
      const state = { kind: 4 };
      for (const c of records(list.at, list.at + list.len)) {
        if (c.type === 0x03F3 && c.len >= 16) { cur2 = { ref: u32(c.at), id: u32(c.at + 12), outline: [] }; if (list.inst === 0) slides.push(cur2); else cur2.notes = true; state.kind = 4; if (list.inst === 2) notesOf.set(`ref:${cur2.ref}`, cur2); }
        else if (c.type === 0x0F9F && c.len >= 4) state.kind = u32(c.at);
        else if (cur2 && c.type === 0x0FA0) cur2.outline.push({ kind: state.kind, text: clean(utf16(dv, c.at, c.len >> 1)) });
        else if (cur2 && c.type === 0x0FA8) cur2.outline.push({ kind: state.kind, text: clean(latin1(doc, c.at, c.len)) });
      }
    }
  }
  if (!slides.length) { // no usable directory: every text in the file, in the order it is stored
    const all = texts({ at: 0, len: doc.length }).map((t) => t.text).filter(Boolean);
    if (!all.length) throw new Error('That presentation has no slides Atelier can read.');
    return tidy([...new Set(all)].join('\n'));
  }
  // Notes pages name their slide (NotesAtom.slideIdRef).
  const notesBySlide = new Map();
  for (const n of [...notesOf.values()]) {
    const r = head(persist.get(n.ref) ?? -1);
    if (!r || r.type !== 0x03F0) continue;
    let slideId = 0;
    for (const c of records(r.at, r.at + r.len)) if (c.type === 0x03F1 && c.len >= 4) slideId = u32(c.at);
    const text = [...n.outline, ...texts(r)].filter((t) => t.kind === 2 && t.text).map((t) => t.text).join('\n');
    if (text) notesBySlide.set(slideId, text);
  }
  const out = [];
  let size = 0;
  for (const [i, s] of slides.entries()) {
    if (size > CHARS) break;
    const r = head(persist.get(s.ref) ?? -1);
    const own = r && r.type === 0x03EE ? texts(r) : [];
    const lines = [...s.outline, ...own].filter((t) => t.text).map((t) => (t.kind === 0 || t.kind === 6 ? `# ${t.text.replace(/\s+/g, ' ')}` : t.text));
    const notes = notesBySlide.get(s.id);
    const block = [`--- Slide ${i + 1} ---`, ...lines, notes && `Speaker notes: ${notes}`].filter(Boolean).join('\n');
    out.push(block); size += block.length;
  }
  return out.join('\n\n');
}

export function legacyText(kind, bytes, helpers) {
  const f = cfb(bytes);
  // The name can lie (a .doc that is really a workbook): go by what is inside.
  const has = (n) => f.names.includes(n);
  const real = has('WordDocument') ? 'doc' : has('Workbook') || has('Book') ? 'xls' : has('PowerPoint Document') ? 'ppt' : kind;
  if (real === 'doc') return wordText(f);
  if (real === 'xls') return bookText(f, helpers);
  return slidesText(f);
}
