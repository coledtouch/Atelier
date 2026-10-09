// Settings → Advanced diagnostics → Recent app errors (public/app-errors.js): every value lands as text, never HTML.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { reportRow, renderAppErrors, loadAppErrors } from '../public/app-errors.js';

// A DOM that only does text: innerHTML (or any HTML parsing) throws.
class El {
  constructor(tag, doc) { Object.assign(this, { tagName: tag, ownerDocument: doc, kids: [], className: '', _text: '' }); }
  get textContent() { return this._text + this.kids.map((k) => k.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.kids = []; }
  set innerHTML(_) { throw new Error('innerHTML used'); }
  insertAdjacentHTML() { throw new Error('insertAdjacentHTML used'); }
  append(...k) { this.kids.push(...k); }
  replaceChildren(...k) { this.kids = k; this._text = ''; }
  all() { return [this, ...this.kids.flatMap((k) => k.all())]; }
}
const doc = { createElement: (t) => new El(t, doc) };
const box = () => new El('div', doc);
const EVIL = '<img src=x onerror=alert(1)>';

test('rows: kind, name, place, version, platform, phase, count and time as plain strings', () => {
  const at = Date.UTC(2026, 9, 8, 17, 4);
  assert.deepEqual(reportRow({ v: '85', kind: 'boot', name: 'TypeError', file: '/app.js', line: 6290, col: 3, platform: 'ios-standalone', phase: 'starting', count: 3, lastAt: at, stack: ['/app.js:6290:3', '/sync.js:4:1'] }, { locale: 'en-US', timeZone: 'UTC' }), {
    title: 'Start failed · TypeError', where: '/app.js:6290:3', meta: 'v85 · ios-standalone · starting · ×3 · Oct 8, 05:04 PM', stack: ['/app.js:6290:3', '/sync.js:4:1'],
  });
  assert.deepEqual(reportRow({ v: '85', kind: 'stall', name: 'Stall', platform: 'android-twa', phase: 'loading', online: false }), {
    title: 'Stalled while opening · Stall', where: 'no file named', meta: 'v85 · android-twa · loading files · offline', stack: [],
  });
  assert.equal(reportRow(null), null);
  // A load that saw no server error (net: true) reads as a download, not a broken file.
  assert.equal(reportRow({ v: '85', kind: 'load', name: 'LoadError', file: '/app.js', net: true }).title, 'Didn’t download · LoadError');
  assert.equal(reportRow({ v: '85', kind: 'load', name: 'LoadError', file: '/data-safety.js', net: false }).title, 'Didn’t load · LoadError');
  assert.equal(reportRow({ v: '85', kind: 'boot', name: 'TypeError', net: true }).title, 'Start failed · TypeError');
});

test('render: a list built from text nodes only; hostile values show as text', () => {
  const b = box();
  const n = renderAppErrors(b, { days: 30, reports: [
    { v: '85', kind: 'error', name: EVIL, file: EVIL, line: 1, platform: EVIL, stack: [EVIL, '/a.js:1:1'], count: 2, lastAt: Date.now() },
    { v: '85', kind: 'load', name: 'LoadError', file: '/data-safety.js' },
  ] });
  assert.equal(n, 2);
  assert.ok(b.textContent.includes(EVIL), 'shown literally');
  const tags = b.all().map((e) => e.tagName);
  assert.deepEqual([...new Set(tags)].sort(), ['details', 'div', 'li', 'p', 'span', 'summary', 'ul'], 'no element came from the data');
  assert.match(b.textContent, /never what was typed/);
});

test('render: empty and error states; loadAppErrors sends the owner headers and surfaces the server message', async () => {
  const b = box();
  assert.equal(renderAppErrors(b, { reports: [], days: 30 }), 0);
  assert.equal(b.textContent, 'No app errors reported in the last 30 days.');
  renderAppErrors(b, null);
  assert.match(b.textContent, /No app errors/);
  const seen = [];
  const ok = await loadAppErrors({ 'x-app-pass': 'pw' }, async (url, init) => { seen.push([url, init.headers]); return new Response('{"reports":[],"days":30}', { status: 200 }); });
  assert.deepEqual(ok, { reports: [], days: 30 });
  assert.deepEqual(seen, [['/api/client-error', { 'x-app-pass': 'pw' }]]);
  await assert.rejects(loadAppErrors({}, async () => new Response('{"error":"Enter your passcode."}', { status: 401 })), /Enter your passcode\./);
  await assert.rejects(loadAppErrors({}, async () => new Response('nope', { status: 503 })), /Couldn’t load app errors \(503\)/);
});

test('wired in Settings → Advanced diagnostics (owner only), loaded with apiHeaders, precached and syntax-checked', async () => {
  const [html, app, pkg] = await Promise.all(['public/index.html', 'public/app.js', 'package.json'].map((p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8')));
  const diag = /<details class="settings-details" id="advancedDiagnostics">([\s\S]*?)<\/details>/.exec(html)[1];
  assert.match(diag, /<button type="button" class="chip" id="appErrorsBtn"/);
  assert.match(diag, /<div class="app-errors" id="appErrorsOut" aria-live="polite"><\/div>/);
  assert.match(html, /<section class="field-group owner-only">\s*<details class="settings-details" id="advancedDiagnostics">/);
  assert.match(app, /import \{ renderAppErrors, loadAppErrors \} from '\.\/app-errors\.js\?v=\d+';/);
  assert.match(app, /renderAppErrors\(box, await loadAppErrors\(apiHeaders\(\)\)\)/);
  assert.match(JSON.parse(pkg).scripts.check, /node --check public\/app-errors\.js && node --check src\/client-errors\.js/);
});
