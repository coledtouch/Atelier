# Makes tests/fixtures/office: one document, one workbook and one deck, each saved by Word, Excel and PowerPoint themselves
# in every format Atelier reads (.docx .doc .rtf .odt .htm .pdf, .xlsx .xls .ods, .pptx .ppt .odp), plus truth.json: what
# those apps show for the same content, read through their own object model. tests/file-readers.test.mjs compares the two.
# Run on Windows with Office installed:  pwsh scripts/make-office-fixtures.ps1   (then scripts/make-scan-fixtures.py)
# Personal details are stripped (RemovePersonalInformation). It never quits an Office app that was already running.
$ErrorActionPreference = 'Stop'
$out = Join-Path (Split-Path $PSScriptRoot -Parent) 'tests/fixtures/office'
New-Item -ItemType Directory -Force $out | Out-Null
Get-ChildItem $out -File | Where-Object { $_.Name -notlike 'scan-*' } | Remove-Item -Force
$missing = [Type]::Missing
$truth = [ordered]@{}
function Release($o) { if ($null -ne $o) { try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($o) } catch {} } }

# ───────────── Word ─────────────
$word = New-Object -ComObject Word.Application
try {
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $doc = $word.Documents.Add()
  $sel = $word.Selection
  $sel.Style = $doc.Styles.Item(-2)                     # Heading 1
  $sel.TypeText('Quarterly Report'); $sel.TypeParagraph()
  $sel.Style = $doc.Styles.Item(-1)                     # Normal
  $sel.TypeText('Revenue rose 12% to ' + [char]0x20AC + '1,250,000 in Q3 ' + [char]0x2014 + ' a ' + [char]0x201C + 'record' + [char]0x201D + ' quarter.')
  $sel.TypeParagraph()
  $sel.TypeText('See ')
  [void]$doc.Hyperlinks.Add($sel.Range, 'https://example.com/report', $missing, $missing, 'the full report')
  $sel.EndKey(6) | Out-Null
  $sel.TypeText(' for details.'); $sel.TypeParagraph()
  $sel.TypeText("Name`tValue"); $sel.TypeParagraph()
  $sel.TypeText('Line one'); $sel.InsertBreak(6); $sel.TypeText('Line two'); $sel.TypeParagraph()
  $sel.TypeText('A well' + [char]30 + 'known caf' + [char]0xE9 + '.'); $sel.TypeParagraph()
  # numbered list
  $sel.Range.ListFormat.ApplyNumberDefault()
  $sel.TypeText('First step'); $sel.TypeParagraph()
  $sel.TypeText('Second step'); $sel.TypeParagraph()
  $sel.TypeText('Third step'); $sel.TypeParagraph()
  $sel.Range.ListFormat.RemoveNumbers()
  # footnote
  $sel.TypeText('Costs fell by a third.')
  [void]$doc.Footnotes.Add($sel.Range, $missing, 'Source: internal ledger.')
  $sel.EndKey(6) | Out-Null
  $sel.TypeParagraph()
  $sel.TypeText('Hiring stayed flat.')
  [void]$doc.Endnotes.Add($sel.Range, $missing, 'Endnote: per the HR summary.')
  $sel.EndKey(6) | Out-Null
  $sel.TypeParagraph()
  # table
  $tbl = $doc.Tables.Add($sel.Range, 3, 3)
  $cells = @(@('Region', 'Units', 'Revenue'), @('North', '120', '$4,800'), @('South', '95', '$3,800'))
  for ($r = 0; $r -lt 3; $r++) { for ($c = 0; $c -lt 3; $c++) { $tbl.Cell($r + 1, $c + 1).Range.Text = $cells[$r][$c] } }
  $sel.EndKey(6) | Out-Null
  $sel.TypeParagraph()
  # comment target
  $sel.TypeText('Margin was 41 percent.')
  $para = $doc.Paragraphs.Item($doc.Paragraphs.Count).Range
  [void]$doc.Comments.Add($para, 'Check this number.')
  $sel.EndKey(6) | Out-Null
  $sel.TypeParagraph()
  # tracked change: "The old plan stays." -> delete "old ", insert "new "
  $sel.TypeText('The old plan stays.')
  $sel.TypeParagraph()
  $doc.TrackRevisions = $true
  $find = $doc.Content
  $f = $find.Find
  if ($f.Execute('old ')) { $find.Delete() | Out-Null; $find.InsertAfter('new ') }
  $doc.TrackRevisions = $false
  # text box
  $box = $doc.Shapes.AddTextbox(1, 100, 560, 220, 40)
  $box.TextFrame.TextRange.Text = 'Callout text in a box'
  # page break + last paragraph
  $sel.EndKey(6) | Out-Null
  $sel.InsertBreak(7)
  $sel.TypeText('Second page conclusion.')
  # header / footer
  $doc.Sections.Item(1).Headers.Item(1).Range.Text = 'Acme Corp Confidential Header'
  $doc.Sections.Item(1).Footers.Item(1).Range.Text = 'Footer line text'
  try { $doc.RemoveDocumentInformation(8) } catch {}   # document properties (author, company)
  try { $doc.RemovePersonalInformation = $true } catch {}
  $truth.word = [ordered]@{
    body      = [string]$doc.Content.Text
    footnote  = [string]$doc.Footnotes.Item(1).Range.Text
    endnote   = [string]$doc.Endnotes.Item(1).Range.Text
    header    = [string]$doc.Sections.Item(1).Headers.Item(1).Range.Text
    footer    = [string]$doc.Sections.Item(1).Footers.Item(1).Range.Text
    comment   = [string]$doc.Comments.Item(1).Range.Text
    textbox   = [string]$box.TextFrame.TextRange.Text
    revisions = [int]$doc.Revisions.Count
  }
  $doc.SaveAs2((Join-Path $out 'sample.docx'), 16)
  $doc.SaveAs2((Join-Path $out 'sample.doc'), 0)
  $doc.SaveAs2((Join-Path $out 'sample.rtf'), 6)
  $doc.SaveAs2((Join-Path $out 'sample.odt'), 23)
  $doc.SaveAs2((Join-Path $out 'sample.htm'), 10)
  $doc.SaveAs2((Join-Path $out 'sample.pdf'), 17)
  $doc.Close(0)
} finally { $word.Quit(0); Release $word }
'word done'

# ───────────── Excel ─────────────
$xl = New-Object -ComObject Excel.Application
try {
  $xl.Visible = $false
  $xl.DisplayAlerts = $false
  function Fill-Book($wb) {
    $ws = $wb.Worksheets.Item(1); $ws.Name = 'Zeta'
    $h = @('Item', 'Date', 'Amount', 'Paid', 'Share', 'When', 'Note')
    for ($c = 0; $c -lt $h.Count; $c++) { $ws.Cells.Item(1, $c + 1).Value2 = $h[$c] }
    $rows = @(
      @('Lumber', 46000, 1250.5, $true, 0.25, 0.5, 'He said "hi", twice'),
      @('Nails', 46001.75, 89.99, $false, 0.075, 0.354166666666667, "Line1`nLine2"),
      @('Paint, blue', 46031, -40, $true, 1, 0.999305555555556, 'plain')
    )
    # One call site, one argument type: PowerShell's COM binder caches the first type it sees. Excel parses the string.
    $inv = [cultureinfo]::InvariantCulture
    for ($r = 0; $r -lt $rows.Count; $r++) { for ($c = 0; $c -lt 7; $c++) {
      $v = $rows[$r][$c]
      $text = if ($v -is [bool]) { if ($v) { 'TRUE' } else { 'FALSE' } } elseif ($v -is [string]) { $v } else { ([double]$v).ToString('R', $inv) }
      $ws.Cells.Item($r + 2, $c + 1).Formula = [string]$text
    } }
    $ws.Range('B2').NumberFormat = 'm/d/yyyy'
    $ws.Range('B3').NumberFormat = 'm/d/yyyy h:mm'
    $ws.Range('B4').NumberFormat = 'dd-mmm-yy'
    $ws.Range('C2:C4').NumberFormat = '$#,##0.00'
    $ws.Range('E2:E4').NumberFormat = '0.0%'
    $ws.Range('F2').NumberFormat = 'h:mm AM/PM'
    $ws.Range('F3').NumberFormat = 'h:mm:ss'
    $ws.Range('F4').NumberFormat = '[h]:mm'
    $ws.Range('A5').Value2 = 'Total'
    $ws.Range('C5').Formula = '=SUM(C2:C4)'
    $ws.Range('C5').NumberFormat = '$#,##0.00'
    $ws.Range('A6').Formula = '=A2&" x"'
    $ws.Range('B6').Formula = '=1/0'
    $ws.Range('C6').Formula = '=0.1+0.2'
    $ws.Range('D6').Value2 = 12345678901234
    $ws.Range('E6').Value2 = 0.000012345
    $ws.Range('A7').Value2 = 'Bold and plain'
    $ws.Range('A7').Characters(1, 4).Font.Bold = $true
    $ws.Range('A8:C8').Merge() | Out-Null
    $ws.Range('A8').Value2 = 'Merged title'
    $ws.Range('A9').NumberFormat = '@'
    $ws.Range('A9').Value2 = '00123'
    $ws.Range('B9').Value2 = 1234.5
    $ws.Range('B9').NumberFormat = '#,##0'
    $ws.Range('C9').Value2 = 5
    $ws.Range('C9').NumberFormat = '0.00'
    $a = $wb.Worksheets.Add($missing, $wb.Worksheets.Item($wb.Worksheets.Count)); $a.Name = 'Alpha'
    $a.Range('A1').Value2 = 'Alpha first cell'; $a.Range('B2').Value2 = 7
    $hid = $wb.Worksheets.Add($missing, $wb.Worksheets.Item($wb.Worksheets.Count)); $hid.Name = 'Hidden'
    $hid.Range('A1').Value2 = 'secret value'
    $a.Move($wb.Worksheets.Item(1))          # display order: Alpha, Zeta, Hidden
    $hid.Visible = 0
  }
  function Read-Book($wb) {
    $sheets = @()
    foreach ($ws in $wb.Worksheets) {
      $ur = $ws.UsedRange
      $rowsOut = @()
      for ($r = 1; $r -le $ur.Rows.Count; $r++) {
        $line = @()
        for ($c = 1; $c -le $ur.Columns.Count; $c++) { $line += [string]$ur.Cells.Item($r, $c).Text }
        $rowsOut += , $line
      }
      $sheets += [ordered]@{ name = [string]$ws.Name; visible = [int]$ws.Visible; rows = $rowsOut }
    }
    return $sheets
  }
  $wb = $xl.Workbooks.Add()
  Fill-Book $wb
  $ws0 = $wb.Worksheets.Item('Zeta'); $ws0.Columns.Item('A:G').ColumnWidth = 22
  try { $wb.RemovePersonalInformation = $true } catch {}
  $truth.excel = Read-Book $wb
  $wb.SaveAs((Join-Path $out 'sample.xlsx'), 51)
  $wb.CheckCompatibility = $false
  $wb.SaveAs((Join-Path $out 'sample.xls'), 56)
  $wb.SaveAs((Join-Path $out 'sample.ods'), 60)
  $wb.Close($false)
  # a 1904-date-system book
  $wb2 = $xl.Workbooks.Add()
  $wb2.Date1904 = $true
  $s = $wb2.Worksheets.Item(1); $s.Name = 'Mac'
  $s.Range('A1').Value2 = 'Date'; $s.Range('A2').Value2 = 44538; $s.Range('A2').NumberFormat = 'yyyy-mm-dd'
  $s.Columns.Item('A').ColumnWidth = 20
  try { $wb2.RemovePersonalInformation = $true } catch {}
  $truth.excel1904 = Read-Book $wb2
  $wb2.SaveAs((Join-Path $out 'sample-1904.xlsx'), 51)
  $wb2.CheckCompatibility = $false
  $wb2.SaveAs((Join-Path $out 'sample-1904.xls'), 56)
  $wb2.Close($false)
} finally { $xl.Quit(); Release $xl }
'excel done'

# ───────────── PowerPoint ─────────────
$pptWasRunning = [bool](Get-Process POWERPNT -ErrorAction SilentlyContinue)
$ppt = New-Object -ComObject PowerPoint.Application
try {
  $pres = $ppt.Presentations.Add(0)                    # no window
  $s1 = $pres.Slides.Add(1, 1)                         # title slide
  $s1.Shapes.Item(1).TextFrame.TextRange.Text = 'Launch Plan'
  $s1.Shapes.Item(2).TextFrame.TextRange.Text = 'Spring 2027'
  $s2 = $pres.Slides.Add(2, 2)                         # title + bullets
  $s2.Shapes.Item(1).TextFrame.TextRange.Text = 'Goals'
  $s2.Shapes.Item(2).TextFrame.TextRange.Text = "Ship the app`rWin ten customers`rStay under budget"
  $s2.NotesPage.Shapes.Placeholders.Item(2).TextFrame.TextRange.Text = 'Remember to thank the team.'
  $t = $s2.Shapes.AddTable(2, 2, 60, 330, 420, 90).Table
  $t.Cell(1, 1).Shape.TextFrame.TextRange.Text = 'Metric'; $t.Cell(1, 2).Shape.TextFrame.TextRange.Text = 'Target'
  $t.Cell(2, 1).Shape.TextFrame.TextRange.Text = 'Signups'; $t.Cell(2, 2).Shape.TextFrame.TextRange.Text = '500'
  $s3 = $pres.Slides.Add(3, 12)                        # blank
  $a = $s3.Shapes.AddTextbox(1, 50, 60, 320, 50); $a.TextFrame.TextRange.Text = 'Grouped A ' + [char]0x2014 + ' caf' + [char]0xE9
  $b = $s3.Shapes.AddTextbox(1, 50, 140, 320, 50); $b.TextFrame.TextRange.Text = 'Grouped B'
  [void]$s3.Shapes.Range(@($a.Name, $b.Name)).Group()
  $s3.MoveTo(2)                                        # order now: Launch Plan, Grouped, Goals
  try { $pres.RemovePersonalInformation = -1 } catch {}
  # drop the layouts no slide uses: the default theme's eleven layouts are most of the file
  for ($i = $pres.SlideMaster.CustomLayouts.Count; $i -ge 1; $i--) { try { $pres.SlideMaster.CustomLayouts.Item($i).Delete() } catch {} }
  function Shape-Texts($shapes) {
    $o = @()
    foreach ($sh in $shapes) {
      if ($sh.Type -eq 6) { $o += Shape-Texts $sh.GroupItems }
      elseif ($sh.HasTable -eq -1) { foreach ($row in $sh.Table.Rows) { foreach ($cell in $row.Cells) { $o += [string]$cell.Shape.TextFrame.TextRange.Text } } }
      elseif ($sh.HasTextFrame -eq -1 -and $sh.TextFrame.HasText -eq -1) { $o += [string]$sh.TextFrame.TextRange.Text }
    }
    return $o
  }
  $slides = @()
  foreach ($sl in $pres.Slides) {
    $notes = ''
    try { $notes = [string]$sl.NotesPage.Shapes.Placeholders.Item(2).TextFrame.TextRange.Text } catch {}
    $slides += [ordered]@{ index = [int]$sl.SlideIndex; texts = @(Shape-Texts $sl.Shapes); notes = $notes }
  }
  $truth.powerpoint = $slides
  $pres.SaveAs((Join-Path $out 'sample.pptx'), 24)
  $pres.SaveAs((Join-Path $out 'sample.ppt'), 1)
  $pres.SaveAs((Join-Path $out 'sample.odp'), 35)
  $pres.SaveAs((Join-Path $out 'slides.pdf'), 32)
  $pres.Close()
} finally { if (-not $pptWasRunning) { $ppt.Quit() }; Release $ppt }
'powerpoint done'

$truth | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 (Join-Path $out 'truth.json')
Get-ChildItem $out | Select-Object Name, Length | Format-Table -AutoSize | Out-String
