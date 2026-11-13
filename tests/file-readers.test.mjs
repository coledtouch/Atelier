import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { zipSync, unzipSync, strFromU8, strToU8 } from 'fflate';
import { readFile, docKind, KIND_LABEL, formatCell, plainNumber, serialDate, builtinFormat, sharedStrings, cellFormats, sheetText, wordXml, slideXml, odfXml,
  rtfText, htmlText, decodeText, unxml, walk, attr, PART_MAX_BYTES, FILE_CHARS, TEXT_BYTES } from '../public/files.js';
import { cfb, legacyText } from '../public/files-legacy.js';

// v114: the readers behind document attachments, checked against files Word, Excel and PowerPoint themselves saved
// (tests/fixtures/office, made by scripts/make-office-fixtures.ps1) and against what those apps show for the same files
// (truth.json, read through Office's own object model). v113's first readers were only ever run on hand-made XML, and
// showed dates as serial numbers, dropped footnotes and notes, and read a text box twice.
const fl = { unzipSync, strFromU8 };
const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/office/${name}`, import.meta.url)));
const truth = JSON.parse(readFileSync(new URL('./fixtures/office/truth.json', import.meta.url), 'utf8').replace(/^\ufeff/, ''));
const read = (kind, name) => readFile(kind, fixture(name), fl);
const zip = (files) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
const count = (hay, needle) => hay.split(needle).length - 1;

// ── Word ──
// What Word shows for the body, paragraph by paragraph (its own marks taken out), minus the one tracked change.
const wordParagraphs = truth.word.body.replace(/\u0007/g, '').replace(/\u0002/g, '').replace(/\u000b/g, '\n').replace(/\u001e/g, '-').replace(/\f/g, '').split('\r')
  .map((p) => p.trim()).filter(Boolean).filter((p) => !p.includes('old new'));
for (const [kind, name] of [['docx', 'sample.docx'], ['doc', 'sample.doc'], ['rtf', 'sample.rtf'], ['odt', 'sample.odt']]) {
  test(`${name}: every paragraph Word shows is read, once, in order`, () => {
    const text = read(kind, name);
    const plain = text.replace(' (https://example.com/report)', '').replace(/\[\^e?\d+\]/g, '').replace(/ \[(?:Note|Footnote|Endnote|Comment): [^\]]*\]/g, '').replace(/\u2011/g, '-');
    let at = -1;
    for (const p of wordParagraphs) {
      const where = plain.indexOf(p, Math.max(0, at));
      assert.ok(where >= 0, `${name}: "${p}" is read (after the paragraph before it)`);
      at = where;
    }
    assert.match(text, /The new plan stays\./, 'the tracked change reads as accepted');
    assert.doesNotMatch(text, /\bold\b/, 'the deleted word is gone');
    assert.equal(count(text, 'Callout text in a box'), 1, 'a text box is read once');
    assert.match(text, /Region \| Units \| Revenue\nNorth \| 120 \| \$4,800\nSouth \| 95 \| \$3,800/, 'a table row is one line');
    assert.match(text, /Line one\nLine two/);
    assert.match(text, /Name\tValue/);
    assert.match(text, /See the full report \(https:\/\/example\.com\/report\) for details\./, 'a link keeps its address');
    assert.match(text, /Source: internal ledger\./);
    assert.match(text, /Endnote: per the HR summary\./);
  });
}

test('sample.docx: headings, list items, notes, comments, page header and footer, and what was left out', () => {
  const text = read('docx', 'sample.docx');
  assert.match(text, /^# Quarterly Report\n/);
  assert.match(text, /- First step\n- Second step\n- Third step/);
  assert.match(text, /Costs fell by a third\.\[\^1\]/);
  assert.match(text, /--- Footnotes ---\n\[\^1\]: Source: internal ledger\./);
  assert.match(text, /Hiring stayed flat\.\[\^e1\]/);
  assert.match(text, /--- Endnotes ---\n\[\^e1\]: Endnote: per the HR summary\./);
  assert.match(text, /--- Comments ---\n- Check this number\./);
  assert.match(text, /\[Text box\] Callout text in a box/);
  assert.match(text, /--- Page header ---\nAcme Corp Confidential Header/);
  assert.match(text, /--- Page footer ---\nFooter line text/);
  assert.match(text, /A well-known café\./, 'a non-breaking hyphen is a hyphen');
  assert.match(text, /\[This document has tracked changes\. This is the text with every change accepted\.\]/);
  assert.equal(truth.word.revisions, 2);
});

test('sample.doc (Word 97-2003): the same text from the binary format, tracked deletion left out', () => {
  const text = read('doc', 'sample.doc');
  assert.match(text, /^Quarterly Report\n/);
  assert.match(text, /Costs fell by a third\.\[\^1\]\nHiring stayed flat\.\[\^e1\]/);
  assert.match(text, /--- Footnotes ---\n\[\^1\]: Source: internal ledger\./);
  assert.match(text, /--- Endnotes ---\n\[\^e1\]: Endnote: per the HR summary\./);
  assert.match(text, /--- Comments ---\n- Check this number\./);
  assert.match(text, /\[Text box\] Callout text in a box/);
  assert.match(text, /--- Page headers and footers ---\nAcme Corp Confidential Header\nFooter line text/);
  assert.match(text, /A well-known café\./);
  assert.match(text, /€1,250,000 in Q3 — a “record” quarter\./, '8-bit text is Windows-1252, not Latin-1');
  assert.match(text, /\[This document has tracked changes/);
});

test('sample.rtf and sample.odt: notes read in place, comments after their paragraph', () => {
  const rtf = read('rtf', 'sample.rtf');
  assert.match(rtf, /Costs fell by a third\. \[Note: Source: internal ledger\.\]/);
  assert.match(rtf, /\[Text box\] Callout text in a box/);
  assert.ok(rtf.length < 1200, `only the document's own text is kept, not Word's 70 KB of tables (${rtf.length})`);
  const odt = read('odt', 'sample.odt');
  assert.match(odt, /^# Quarterly Report\n/);
  assert.match(odt, /Costs fell by a third\. \[Footnote: Source: internal ledger\.\]/);
  assert.match(odt, /Hiring stayed flat\. \[Endnote: Endnote: per the HR summary\.\]/);
  assert.match(odt, /Margin was 41 percent\. \[Comment: Check this number\.\]/);
  assert.match(odt, /- First step\n- Second step/);
});

test('sample.htm (Word\'s "Web Page, Filtered"): Windows-1252 is honored, markup and deleted text are gone, a table row is one line', () => {
  const text = read('html', 'sample.htm');
  assert.match(text, /^# Quarterly Report\n/);
  assert.match(text, /Revenue rose 12% to €1,250,000 in Q3 — a “record” quarter\./);
  assert.match(text, /A well.known café\./);
  assert.match(text, /Region \| Units \| Revenue\nNorth \| 120 \| \$4,800\nSouth \| 95 \| \$3,800/);
  assert.match(text, /The new plan stays\./);
  assert.doesNotMatch(text, /mso|<|font-family/i);
  assert.equal(count(text, 'Callout text in a box'), 1);
});

// ── Excel ──
// One CSV text → rows of cells.
function csv(text) {
  const rows = [[]];
  let cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch; }
    else if (ch === '"') quoted = true;
    else if (ch === ',') { rows.at(-1).push(cell); cell = ''; }
    else if (ch === '\n') { rows.at(-1).push(cell); cell = ''; rows.push([]); }
    else cell += ch;
  }
  rows.at(-1).push(cell);
  return rows;
}
const sheetsOf = (text) => Object.fromEntries(text.split(/\n*--- Sheet: /).filter(Boolean).map((b) => { const nl = b.indexOf('\n'); return [b.slice(0, nl).replace(/ ---$/, ''), csv(b.slice(nl + 1))]; }));
// Cells where Atelier writes the same value another way than Excel's window does: ISO dates and 24-hour times (no
// model has to guess month from day), and a long number in full where Excel's General format abbreviates it.
const SAME = { '12/9/2025': '2025-12-09', '12/10/2025 18:00': '2025-12-10 18:00', '09-Jan-26': '2026-01-09', '12:00 PM': '12:00', '8:30:00': '08:30:00', '1.23457E+13': '12345678901234' };
const truthRows = (rows) => rows.map((r) => { const out = [...r]; while (out.length && out.at(-1) === '') out.pop(); return out; });
for (const [kind, name] of [['xlsx', 'sample.xlsx'], ['xls', 'sample.xls']]) {
  test(`${name}: every cell reads as Excel shows it (dates and times in ISO form), sheets in tab order, the hidden one named as hidden`, () => {
    const text = read(kind, name), got = sheetsOf(text);
    assert.deepEqual(Object.keys(got), ['Alpha', 'Zeta', 'Hidden (hidden)']);
    assert.deepEqual(truth.excel.map((s) => [s.name, s.visible]), [['Alpha', -1], ['Zeta', -1], ['Hidden', 0]]);
    for (const s of truth.excel) {
      const mine = got[s.visible === -1 ? s.name : `${s.name} (hidden)`];
      const want = truthRows(s.rows).map((r) => r.map((c) => SAME[c] ?? c));
      assert.deepEqual(mine, want, `${name} · ${s.name}`);
    }
    assert.doesNotMatch(text, /46000|0\.30000000000000004|E-2\b/, 'no serial dates, no binary noise');
  });
}
test('sample.ods: the same sheet from OpenDocument; dates come from the cell\'s own ISO value', () => {
  const got = sheetsOf(read('ods', 'sample.ods'));
  const zeta = truth.excel.find((s) => s.name === 'Zeta');
  const iso = { '12/9/2025': '2025-12-09', '12/10/2025 18:00': '2025-12-10 18:00', '09-Jan-26': '2026-01-09' };
  assert.deepEqual(got.Zeta, truthRows(zeta.rows).map((r) => r.map((c) => iso[c] ?? c)));
  assert.deepEqual(got.Alpha, [['Alpha first cell'], ['', '7']]);
});
test('the 1904 date system (old Mac workbooks) is honored in both formats', () => {
  assert.deepEqual(truth.excel1904.rows, [['Date'], ['2025-12-09']]);
  assert.match(read('xlsx', 'sample-1904.xlsx'), /--- Sheet: Mac ---\nDate\n2025-12-09$/);
  assert.match(read('xls', 'sample-1904.xls'), /--- Sheet: Mac ---\nDate\n2025-12-09$/);
});

test('formatCell: a number reads the way its format shows it', () => {
  const rows = [
    [46000, 'm/d/yyyy', '2025-12-09'], [46001.75, 'm/d/yyyy h:mm', '2025-12-10 18:00'], [46031, 'dd-mmm-yy', '2026-01-09'], [46000, builtinFormat(14), '2025-12-09'],
    [0.5, 'h:mm AM/PM', '12:00'], [0.354166666666667, 'h:mm:ss', '08:30:00'], [0.999305555555556, '[h]:mm', '23:59'], [1.5, '[h]:mm', '36:00'], [0.5, builtinFormat(20), '12:00'],
    [46000.999999999, 'yyyy-mm-dd hh:mm', '2025-12-10 00:00'], [59, 'yyyy-mm-dd', '1900-02-28'], [61, 'yyyy-mm-dd', '1900-03-01'], [1, 'yyyy-mm-dd', '1900-01-01'],
    [0.25, '0.0%', '25.0%'], [0.075, builtinFormat(9), '8%'], [1, '0.00%', '100.00%'],
    [1250.5, '$#,##0.00', '$1,250.50'], [-40, '$#,##0.00', '-$40.00'], [1250.5, '#,##0.00 [$€-407]', '1,250.50 €'], [1250.5, '[$€-2] #,##0.00', '€1,250.50'],
    [1250.5, '_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)', '$1,250.50'], [1234.5, '#,##0', '1,235'], [5, '0.00', '5.00'], [5, '[Red]0.00', '5.00'],
    [0.30000000000000004, '', '0.3'], ['1.2345E-5', 'General', '0.000012345'], [12345678901234, 'General', '12345678901234'], [7, '@', '7'], [1234.5678, '0.00E+00', '1234.5678'],
    [0.5, '# ?/?', '0.5'], [42, undefined, '42'], ['', 'm/d/yyyy', ''], ['abc', '0.00', 'abc'], [-5, 'm/d/yyyy', '-5'],
  ];
  for (const [v, code, want] of rows) assert.equal(formatCell(v, code), want, `${v} as ${code}`);
  assert.equal(formatCell(0, 'yyyy-mm-dd', true), '1904-01-01');
  assert.equal(formatCell(44538, 'yyyy-mm-dd', true), '2025-12-09');
  assert.deepEqual(serialDate(46000.75), [2025, 12, 9, 64800]);
  assert.equal(plainNumber(1e21), '1000000000000000000000');
  assert.equal(plainNumber(1.5e-10), '0.00000000015');
  assert.equal(plainNumber('7.4999999999999997E-2'), '0.075');
  assert.equal(builtinFormat(22), 'm/d/yyyy h:mm');
  assert.equal(builtinFormat(999), '');
});

test('xlsx: sheets follow the workbook\'s tab order (not the file numbers); phonetic guides, text formulas, errors and ISO dates read right', () => {
  const sheet = (rows) => `<worksheet><sheetData>${rows}</sheetData></worksheet>`;
  const bytes = zip({
    'xl/workbook.xml': '<workbook xmlns:r="x"><workbookPr date1904="1"/><sheets><sheet name="Second &amp; last" sheetId="5" r:id="rId9"/><sheet name="Chart" sheetId="7" r:id="rId3"/><sheet name="First" sheetId="1" state="veryHidden" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="http://x/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId9" Type="http://x/worksheet" Target="/xl/worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://x/chartsheet" Target="chartsheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><t>東京</t><rPh sb="0" eb="2"><t>トウキョウ</t></rPh></si><si><r><t>Rich </t></r><r><t xml:space="preserve">text</t></r></si><si/></sst>',
    'xl/styles.xml': '<styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts><cellStyleXfs><xf numFmtId="14"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="164" applyNumberFormat="1"/><xf numFmtId="10"/></cellXfs></styleSheet>',
    'xl/worksheets/sheet1.xml': sheet('<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="str"><f>A1&amp;"!"</f><v>東京!</v></c></row>'),
    'xl/worksheets/sheet2.xml': sheet('<row r="2"><c r="B2" s="1"><v>0</v></c><c r="C2" s="2"><v>0.5</v></c><c r="D2" t="e"><v>#N/A</v></c><c r="E2" t="d"><v>2026-01-09T00:00:00Z</v></c><c r="XFD2"><v>9</v></c></row><row r="9"><c r="A9" t="inlineStr"><is><t>inline</t></is></c><c r="B9" t="b"><v>0</v></c></row>'),
    'xl/chartsheets/sheet1.xml': '<chartsheet/>',
  });
  const text = readFile('xlsx', bytes, fl);
  assert.equal(text, ['--- Sheet: Second & last ---\n,1904-01-01,50.00%,#N/A,2026-01-09T00:00:00Z\n\ninline,FALSE', '--- Sheet: Chart ---\n[A chart sheet. Nothing to read as text.]', '--- Sheet: First (hidden) ---\n東京,Rich text,,東京!'].join('\n\n'));
  assert.deepEqual(sharedStrings('<sst><si><t>a</t></si><si/><si><r><t>b</t></r><rPh><t>x</t></rPh></si></sst>'), ['a', '', 'b']);
  assert.deepEqual(cellFormats('<styleSheet><numFmts><numFmt numFmtId="170" formatCode="0.0&quot; kg&quot;"/></numFmts><cellXfs><xf numFmtId="170"/><xf numFmtId="22"/><xf/></cellXfs></styleSheet>'), ['0.0" kg"', 'm/d/yyyy h:mm', '']);
});

test('xlsx: with no usable relationships the sheet files are read in number order; a long sheet stops at its budget and says so', () => {
  const row = (n) => `<row r="${n}"><c r="A${n}"><v>${n}</v></c><c r="B${n}" t="inlineStr"><is><t>row ${n}</t></is></c></row>`;
  const bytes = zip({ 'xl/workbook.xml': '<workbook><sheets><sheet name="One"/><sheet name="Two"/></sheets></workbook>',
    'xl/worksheets/sheet10.xml': `<worksheet><sheetData>${row(1)}</sheetData></worksheet>`, 'xl/worksheets/sheet2.xml': `<worksheet><sheetData>${row(1)}${row(2)}</sheetData></worksheet>` });
  assert.equal(readFile('xlsx', bytes, fl), '--- Sheet: One ---\n1,row 1\n2,row 2\n\n--- Sheet: Two ---\n1,row 1');
  const many = Array.from({ length: 400 }, (_, i) => row(i + 1)).join('');
  const cut = sheetText(`<worksheet><sheetData>${many}</sheetData></worksheet>`, { budget: 500 });
  assert.equal(cut.cut, true);
  assert.ok(cut.text.length > 500 && cut.text.length < 600, `stops just past the budget (${cut.text.length})`);
  assert.equal(sheetText(`<worksheet><sheetData>${row(1)}</sheetData></worksheet>`).cut, false);
});

// ── PowerPoint ──
for (const [kind, name] of [['pptx', 'sample.pptx'], ['ppt', 'sample.ppt'], ['odp', 'sample.odp']]) {
  test(`${name}: slides in show order, titles marked, every text PowerPoint shows, speaker notes on their slide`, () => {
    const text = read(kind, name);
    const blocks = text.split(/\n*--- Slide \d+ ---\n/).filter(Boolean);
    assert.equal(blocks.length, truth.powerpoint.length);
    for (const [i, s] of truth.powerpoint.entries()) {
      for (const t of s.texts.flatMap((x) => x.split('\r'))) assert.ok(blocks[i].includes(t), `${name} slide ${i + 1}: "${t}"`);
      if (s.notes) assert.ok(blocks[i].includes(`Speaker notes: ${s.notes}`), `${name} slide ${i + 1}: notes`); else assert.doesNotMatch(blocks[i], /Speaker notes/);
    }
    assert.match(blocks[0], /^# Launch Plan\nSpring 2027$/);
    assert.match(blocks[2], /^# Goals\n/);
    assert.equal(count(text, 'Remember to thank the team.'), 1);
  });
}
test('pptx: a table row is one line; slide order comes from the presentation, not the file numbers; hidden slides, pictures and charts are named', () => {
  assert.match(read('pptx', 'sample.pptx'), /Metric \| Target\nSignups \| 500/);
  const sp = (text, ph = '') => `<p:sp><p:nvSpPr><p:nvPr>${ph ? `<p:ph type="${ph}"/>` : ''}</p:nvPr></p:nvSpPr><p:txBody>${text}</p:txBody></p:sp>`;
  const p = (t, lvl = 0) => `<a:p><a:pPr lvl="${lvl}"/><a:r><a:t>${t}</a:t></a:r></a:p>`;
  const bytes = zip({
    'ppt/presentation.xml': '<p:presentation xmlns:r="x"><p:sldIdLst><p:sldId id="300" r:id="rId7"/><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="rId2" Type="http://x/slide" Target="slides/slide1.xml"/><Relationship Id="rId7" Type="http://x/slide" Target="slides/slide2.xml"/></Relationships>',
    'ppt/slides/slide1.xml': `<p:sld show="0"><p:cSld><p:spTree>${sp(p('Made first, shown last'), 'title')}${sp(`<a:p><a:fld type="slidenum"><a:t>9</a:t></a:fld></a:p>`, 'sldNum')}<p:pic/><p:graphicFrame><c:chart/></p:graphicFrame></p:spTree></p:cSld></p:sld>`,
    'ppt/slides/slide2.xml': `<p:sld><p:cSld><p:spTree>${sp(p('Opening'), 'ctrTitle')}${sp(p('Top') + p('Nested', 1) + '<a:p><a:r><a:t>Two</a:t></a:r><a:br/><a:r><a:t>lines</a:t></a:r></a:p>', 'body')}<mc:AlternateContent><mc:Choice>${sp(p('Once'))}</mc:Choice><mc:Fallback>${sp(p('Once'))}</mc:Fallback></mc:AlternateContent></p:spTree></p:cSld></p:sld>`,
    'ppt/slides/_rels/slide2.xml.rels': '<Relationships><Relationship Id="rId1" Type="http://x/notesSlide" Target="../notesSlides/notesSlide7.xml"/></Relationships>',
    'ppt/notesSlides/notesSlide7.xml': `<p:notes><p:cSld><p:spTree>${sp(p('ignored image'), 'sldImg')}${sp(p('Say hello first.'), 'body')}${sp('<a:p><a:fld type="slidenum"><a:t>1</a:t></a:fld></a:p>', 'sldNum')}</p:spTree></p:cSld></p:notes>`,
  });
  assert.equal(readFile('pptx', bytes, fl), '--- Slide 1 ---\n# Opening\nTop\n  Nested\nTwo\nlines\nOnce\nSpeaker notes: Say hello first.\n\n--- Slide 2 (hidden) ---\n# Made first, shown last\n[2 pictures or charts not read]');
  assert.equal(slideXml('<p:sld><p:sp><p:txBody><a:p><a:r><a:t>x</a:t></a:r></a:p></p:txBody></p:sp></p:sld>').hidden, false);
});

// ── Word XML edge cases ──
test('docx XML: nested tables, text boxes inside drawings, deleted and moved text, field codes, footnote separators', () => {
  const r = (t) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;
  const body = wordXml(`<w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr>${r('Scope')}</w:p>
    <w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="1"/><w:numId w:val="3"/></w:numPr></w:pPr>${r('nested item')}</w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="0"/></w:numPr></w:pPr>${r('numbering taken off')}</w:p>
    <w:p>${r('Keep ')}<w:del><w:r><w:delText>gone</w:delText></w:r></w:del><w:moveFrom>${r('moved away')}</w:moveFrom><w:ins>${r('added')}</w:ins><w:r><w:fldChar w:fldCharType="begin"/><w:instrText> PAGE </w:instrText><w:fldChar w:fldCharType="separate"/><w:t>7</w:t></w:r></w:p>
    <w:p>${r('Anchor')}<w:r><mc:AlternateContent><mc:Choice><w:drawing><wp:docPr id="1" name="Text Box 1"/><wps:txbx><w:txbxContent><w:p>${r('In a box')}</w:p><w:p>${r('second line')}</w:p></w:txbxContent></wps:txbx></w:drawing></mc:Choice><mc:Fallback><w:pict><v:textbox><w:txbxContent><w:p>${r('In a box')}</w:p></w:txbxContent></v:textbox></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>
    <w:tbl><w:tr><w:tc><w:p>${r('a')}</w:p><w:p>${r('b')}</w:p></w:tc><w:tc><w:tbl><w:tr><w:tc><w:p>${r('in')}</w:p></w:tc><w:tc><w:p>${r('ner')}</w:p></w:tc></w:tr></w:tbl><w:p/></w:tc></w:tr><w:tr><w:tc><w:p/></w:tc><w:tc><w:p/></w:tc></w:tr></w:tbl>
    <w:p><w:r><w:drawing><wp:docPr id="2" name="Picture 2" descr="A bar chart of sales"/><a:blip r:embed="rId5"/></w:drawing></w:r><w:r><w:noBreakHyphen/><w:softHyphen/><w:tab/></w:r><w:r><w:t>end</w:t><w:cr/><w:t>line</w:t></w:r></w:p>
  </w:body>`);
  assert.deepEqual(body.lines.filter(Boolean), ['## Scope', '  - nested item', 'numbering taken off', 'Keep added7', 'Anchor', '[Text box] In a box / second line', 'a / b | in | ner', '[Image: A bar chart of sales]-\tend\nline']);
  assert.equal(body.tracked, true);
  assert.equal(body.images, 1);
  const notes = wordXml('<w:footnotes><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:t>sep</w:t></w:r></w:p></w:footnote><w:footnote w:id="2"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> See page 4.</w:t></w:r></w:p></w:footnote></w:footnotes>').notes;
  assert.deepEqual(notes, [{ of: 'footnote', id: '2', author: '', text: 'See page 4.' }]);
});

test('the XML walker: attributes in either quote, CDATA, comments, entities; a damaged or wrong zip says so', () => {
  const seen = [];
  walk('<?xml version="1.0"?><a x="1" y:z=\'two &amp; 2\'><!-- skip <b> --><b/>t&lt;x<![CDATA[<raw>]]></a>', { open: (n, a, self) => seen.push(['open', n, attr(a, 'x'), attr(a, 'y:z'), self]), close: (n) => seen.push(['close', n]), text: (t) => seen.push(['text', t]) });
  assert.deepEqual(seen, [['open', 'a', '1', 'two & 2', false], ['open', 'b', '', '', true], ['close', 'b'], ['text', 't<x'], ['text', '<raw>'], ['close', 'a']]);
  assert.equal(unxml('&lt;a&gt; &quot;x&quot; &#39;y&#39; &#x2019; &bogus;'), '<a> "x" \'y\' ’ &bogus;');
  assert.throws(() => readFile('docx', strToU8('not a zip'), fl), /damaged/);
  assert.throws(() => readFile('docx', zip({ 'x.xml': '<a/>' }), fl), /Word document/);
  assert.throws(() => readFile('xlsx', zip({ 'x.xml': '<a/>' }), fl), /spreadsheet/);
  assert.throws(() => readFile('pptx', zip({ 'x.xml': '<a/>' }), fl), /no slides/);
  assert.throws(() => readFile('odt', zip({ 'x.xml': '<a/>' }), fl), /OpenDocument/);
  assert.equal(PART_MAX_BYTES, 48 * 1024 * 1024);
});

// ── the binary formats ──
test('legacy files: not an Office file, a file named for the wrong app, and what the container exposes', () => {
  assert.throws(() => legacyText('doc', strToU8('plain text pretending to be a .doc, long enough to pass the size check'.repeat(12)), {}), /isn’t an Office file/);
  assert.throws(() => cfb(new Uint8Array(100)), /isn’t an Office file/);
  const doc = cfb(fixture('sample.doc'));
  assert.ok(doc.names.includes('WordDocument') && (doc.names.includes('1Table') || doc.names.includes('0Table')));
  assert.equal(doc.stream('NoSuchStream'), null);
  assert.ok(cfb(fixture('sample.xls')).names.includes('Workbook'));
  assert.ok(cfb(fixture('sample.ppt')).names.includes('PowerPoint Document'));
  // A workbook someone renamed to .doc is still read as a workbook: the content decides, not the name.
  assert.match(readFile('doc', fixture('sample.xls'), fl), /^--- Sheet: Alpha ---/);
  assert.match(readFile('xls', fixture('sample.ppt'), fl), /^--- Slide 1 ---/);
});

// ── OpenDocument, RTF, HTML, plain text ──
test('OpenDocument XML: a note, a comment and a text box inside a paragraph keep that paragraph whole', () => {
  const xml = '<office:text><text:h text:outline-level="2">Plan</text:h><text:p>Before<text:note text:note-class="footnote"><text:note-citation>1</text:note-citation><text:note-body><text:p>the note</text:p></text:note-body></text:note> after<office:annotation><dc:creator>Sam</dc:creator><dc:date>2026-01-01</dc:date><text:p>why?</text:p></office:annotation>.</text:p>'
    + '<text:list><text:list-item><text:p>one<text:s text:c="2"/>two<text:tab/>x<text:line-break/>y</text:p></text:list-item></text:list><text:tracked-changes><text:p>deleted words</text:p></text:tracked-changes>'
    + '<text:p><draw:frame><draw:text-box><text:p>boxed</text:p></draw:text-box></draw:frame>host</text:p><table:table><table:table-row><table:table-cell><text:p>a</text:p></table:table-cell><table:table-cell table:number-columns-repeated="3"/><table:table-cell><text:p>b</text:p></table:table-cell></table:table-row></table:table></office:text>';
  assert.equal(odfXml(xml, 'odt'), '## Plan\nBefore [Footnote: the note] after. [Comment: why?]\n- one  two\tx\ny\nhost\n[Text box] boxed\na |  |  |  | b');
  const sheet = '<table:table table:name="S"><table:table-row><table:table-cell office:value-type="date" office:date-value="2026-01-09T00:00:00"><text:p>1/9/26</text:p></table:table-cell><table:table-cell office:value-type="date" office:date-value="2026-01-09T13:30:00"><text:p>x</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="0.5"><text:p>50%</text:p></table:table-cell><table:table-cell table:number-columns-repeated="1000"/></table:table-row></table:table>';
  assert.equal(odfXml(sheet, 'ods'), '--- Sheet: S ---\n2026-01-09,2026-01-09 13:30,50%');
});

test('rtfText: only the document\'s words; Unicode, Windows-1252 bytes, deleted runs, notes, links and text boxes', () => {
  const rtf = String.raw`{\rtf1\ansi\deff0{\fonttbl{\f0 Arial;}}{\colortbl;\red0\green0\blue0;}{\*\generator Riched20;}{\info{\author Someone}}`
    + String.raw`\pard\f0 Hello \b bold\b0\par Caf\'e9 \u8364\'80 5 {\deleted gone }kept{\footnote \chftn  a note}\par`
    + String.raw`{\field{\*\fldinst{HYPERLINK "https://example.com/x" }}{\fldrslt{the link}}} \{braces\} A\_B\~C\par`
    + String.raw`{\shp{\*\shpinst\shpleft1{\sp{\sn shapeType}{\sv 202}}{\shptxt \pard boxed text\par}}}{\pict\wmetafile8 010009000003}\uc2 \u8212 --dash\par \cell x\cell\row}`;
  assert.equal(rtfText(rtf), 'Hello bold\nCafé € 5 kept [Note: a note]\nthe link (https://example.com/x) {braces} A-B\u00a0C\n\n[Text box] boxed text\n\n—dash\n | x');
  assert.equal(rtfText('not rtf at all'), 'not rtf at all');
});

test('htmlText: scripts, styles and markup go; headings, lists, table rows, image alt text and entities stay', () => {
  const html = '<!doctype html><html><head><title>Price &amp; list</title><style>p{color:red}</style><script>var x = "<p>no</p>";</script></head><body><nav><a href="/">Home</a></nav>'
    + '<h1>Price\n   list</h1><p>First&nbsp;line<br>second &mdash; line</p><ul><li>one</li><li>two &#8364;5</li></ul><table><tr><th>Item</th><th>Cost</th></tr><tr><td><p>Tea</p></td><td>3 &lt; 4</td></tr></table>'
    + '<img src="a.png" alt="A red kettle"><del>old price</del><ins>new price</ins><!-- hidden --><p>a < b &unknown; &#x41;</p></body></html>';
  assert.equal(htmlText(html), '# Price & list\n\nHome\n\n# Price list\n\nFirst line\nsecond — line\n\n- one\n- two €5\n\nItem | Cost\nTea | 3 < 4\n\n[Image: A red kettle] new price\na < b &unknown; A');
});

test('decodeText: UTF-8 with or without a BOM, UTF-16 either way round, and Windows-1252 as Excel\'s CSV is saved', () => {
  const u16 = (s, be = false) => { const b = new Uint8Array(s.length * 2); for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); b[i * 2 + (be ? 1 : 0)] = c & 255; b[i * 2 + (be ? 0 : 1)] = c >> 8; } return b; };
  const join = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
  assert.equal(decodeText(strToU8('café, €5')), 'café, €5');
  assert.equal(decodeText(join(new Uint8Array([0xEF, 0xBB, 0xBF]), strToU8('Name,Total'))), 'Name,Total');
  assert.equal(decodeText(join(new Uint8Array([0xFF, 0xFE]), u16('Name\tTotal\r\ncafé'))), 'Name\tTotal\r\ncafé');
  assert.equal(decodeText(join(new Uint8Array([0xFE, 0xFF]), u16('Name', true))), 'Name');
  assert.equal(decodeText(u16('no byte-order mark here')), 'no byte-order mark here');
  assert.equal(decodeText(new Uint8Array([0x63, 0x61, 0x66, 0xE9, 0x2C, 0x80, 0x35])), 'café,€5', 'not UTF-8: Windows-1252');
  const sjis = join(strToU8('<meta charset="shift_jis"><p>'), new Uint8Array([0x93, 0x8C, 0x8B, 0x9E]), strToU8('</p>'));
  assert.equal(htmlText(decodeText(sjis, { html: true })), '東京');
  // A long text file is only read at its head, cut on a whole character.
  const big = strToU8(`a${'é'.repeat(TEXT_BYTES)}`); // "é" is 2 bytes and starts on an odd offset: the cut lands mid-character
  const text = readFile('text', big.subarray(0, TEXT_BYTES + 2), fl);
  assert.ok(text.length > FILE_CHARS && text.length < TEXT_BYTES && /^aé+$/.test(text), 'still UTF-8, no stray byte at the cut');
  assert.equal(readFile('text', strToU8('a,b\n1,2'), fl), 'a,b\n1,2');
});

test('docKind: every format a reader exists for; formats nothing here reads are named so the app can say so', () => {
  const kinds = { 'Report.PDF': 'pdf', 'a.docx': 'docx', 'a.docm': 'docx', 'b.xlsx': 'xlsx', 'b.xlsm': 'xlsx', 'c.pptx': 'pptx', 'c.ppsx': 'pptx', 'old.doc': 'doc', 'old.xls': 'xls', 'old.ppt': 'ppt',
    'x.odt': 'odt', 'x.ods': 'ods', 'x.odp': 'odp', 'x.rtf': 'rtf', 'page.html': 'html', 'page.htm': 'html', 'notes.txt': 'text', 'data.csv': 'text', 'x.json': 'text', 'main.py': 'text', 'README.md': 'text',
    'mail.eml': 'text', 'main.ts': 'text', 'a.pages': 'old', 'a.numbers': 'old', 'a.key': 'old', 'a.xlsb': 'old', 'a.msg': 'old', 'song.mp3': '', 'thing.exe': '', 'photo.png': '', '': '' };
  for (const [name, kind] of Object.entries(kinds)) assert.equal(docKind(name), kind, name);
  assert.equal(docKind('x', 'application/pdf'), 'pdf');
  assert.equal(docKind('x', 'application/msword'), 'doc');
  assert.equal(docKind('x', 'application/vnd.ms-excel'), 'xls');
  assert.equal(docKind('odd', 'text/plain'), 'text');
  assert.equal(docKind('page', 'text/html'), 'html');
  for (const k of new Set(Object.values(kinds))) if (k && k !== 'old') assert.ok(KIND_LABEL[k], `a label for ${k}`);
  for (const k of Object.keys(KIND_LABEL)) assert.match(k, /^[a-z]{1,8}$/, 'context.js filesBlock and data-safety accept this kind');
});
