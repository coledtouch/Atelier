import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEEDBACK_LIMITS, handleFeedback, cleanFeedbackDiagnostics, cleanFeedbackScreenshot } from '../src/feedback.js';
import { createFeedback, feedbackDiagnostics, screenshotProblem } from '../public/feedback.js';

const owner = { role: 'owner' }, tester = (sub = 'person-one') => ({ role: 'tester', sub });
const PNG = { type: 'image/png', data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]).toString('base64') };
const POST = (body, headers = {}) => new Request('https://atelier.ciprari.ai/api/feedback', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const GET = (query = '') => new Request(`https://atelier.ciprari.ai/api/feedback${query}`);
function env() {
  const entries = new Map(), writes = [], deleted = [];
  const ATELIER_KV = {
    async get(name) { return entries.get(name) || null; },
    async put(name, doc, opts) { writes.push({ name, doc, opts }); entries.set(name, doc); },
    async delete(name) { deleted.push(name); entries.delete(name); },
    async list({ prefix, limit }) { return { keys: [...entries.keys()].filter((key) => key.startsWith(prefix)).sort().slice(0, limit).map((name) => ({ name })), list_complete: entries.size <= limit }; },
  };
  return { ATELIER_KV, entries, writes, deleted };
}
const base = (extra = {}) => ({ kind: 'bug', message: 'The preview did not update after I changed the color.', ...extra });

test('only authenticated identities submit; tester cannot read feedback or screenshot, methods are constrained', async () => {
  const e = env();
  for (const who of [{}, { role: 'signedout' }, { role: 'tester' }, tester(''), tester('x'.repeat(1025))]) assert.equal((await handleFeedback(POST(base()), e, who)).status, 401);
  assert.equal((await handleFeedback(GET(), e, tester())).status, 403);
  assert.equal((await handleFeedback(GET('?id=anything'), e, tester())).status, 403);
  assert.equal((await handleFeedback(new Request(GET(), { method: 'DELETE' }), e, owner)).status, 405);
  assert.equal(e.writes.length, 0);
});

test('feedback validates kind, nonempty message, JSON format, content type and bounded body before writing', async () => {
  const e = env();
  for (const raw of [[], null, {}, base({ kind: 'email' }), base({ message: 123 }), base({ message: ' \n ' }), '{']) assert.equal((await handleFeedback(POST(raw), e, tester())).status, 400);
  assert.equal((await handleFeedback(POST(base({ message: 'x'.repeat(4001) })), e, tester())).status, 413);
  assert.equal((await handleFeedback(POST(base(), { 'content-type': 'text/plain' }), e, tester())).status, 415);
  assert.equal((await handleFeedback(POST('x'.repeat(FEEDBACK_LIMITS.request + 1)), e, tester())).status, 413);
  assert.equal((await handleFeedback(POST(base(), { 'content-length': String(FEEDBACK_LIMITS.request + 1) }), e, tester())).status, 413);
  assert.equal(e.entries.size, 0);
});

test('diagnostics use a strict whitelist on both client and server, dropping account, prompt, URL and arbitrary fields', () => {
  const raw = { mode: 'build', version: 'v76', online: true, viewport: { width: 390, height: 844, secret: 'x' }, passcode: 'pw', email: 'me@example.test', prompt: 'private', thread: { text: 'private' }, url: 'https://atelier.ciprari.ai/?pass=pw', namespace: 'me' };
  const want = { mode: 'build', version: 'v76', online: true, viewport: { width: 390, height: 844 } };
  assert.deepEqual(cleanFeedbackDiagnostics(raw), want);
  assert.deepEqual(feedbackDiagnostics(raw, raw.viewport), want);
  for (const raw of [null, [], { mode: 'private prompt', version: 'anything secret', online: 'yes', viewport: { width: Infinity, height: 100 } }]) assert.equal(cleanFeedbackDiagnostics(raw), null);
  assert.deepEqual(cleanFeedbackDiagnostics({ mode: 'ask', version: '76', viewport: { width: -1, height: 100 } }), { mode: 'ask', version: '76' });
});

test('authenticated identity owns the storage namespace; body identity fields are ignored and no automatic diagnostics are stored', async () => {
  const e = env();
  const response = await handleFeedback(POST(base({ sub: 'attacker', role: 'owner', namespace: 'me', email: 'private', prompt: 'private' })), e, tester('verified identity'));
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const saved = JSON.parse(e.writes[0].doc);
  assert.equal(saved.role, 'tester');
  assert.equal(saved.diagnostics, null);
  assert.equal(saved.screenshot, null);
  assert.match(e.writes[0].name, /^feedback:v1:\d{13}:[a-f\d-]+:tester-[a-f\d]{64}$/);
  assert.equal(e.writes[0].opts.expirationTtl, 90 * 86400);
  for (const privateText of ['attacker', 'verified identity', 'namespace', 'email', 'prompt']) assert.ok(!e.writes[0].name.includes(privateText) && !e.writes[0].doc.includes(privateText));
});

test('screenshot MIME, canonical base64, signature and byte size are validated; remote URLs and SVG are rejected', async () => {
  const e = env();
  assert.deepEqual(cleanFeedbackScreenshot(PNG), PNG);
  assert.ok(cleanFeedbackScreenshot({ type: 'image/jpeg', data: Buffer.from([255, 216, 255, 0]).toString('base64') }));
  assert.ok(cleanFeedbackScreenshot({ type: 'image/webp', data: Buffer.from('RIFF1234WEBP').toString('base64') }));
  const oversized = Buffer.alloc(FEEDBACK_LIMITS.screenshot + 1); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(oversized);
  const bad = [
    { type: 'image/svg+xml', data: Buffer.from('<svg/>').toString('base64') }, { ...PNG, type: 'image/jpeg' },
    { ...PNG, data: `data:image/png;base64,${PNG.data}` }, { ...PNG, data: PNG.data + '\n' },
    { ...PNG, data: 'https://evil.example/private' }, { ...PNG, data: '!!!!' }, { ...PNG, data: oversized.toString('base64') },
  ];
  for (const screenshot of bad) {
    assert.equal(cleanFeedbackScreenshot(screenshot), null);
    assert.equal((await handleFeedback(POST(base({ screenshot })), e, tester())).status, 400);
  }
  const response = await handleFeedback(POST(base({ screenshot: PNG })), e, tester());
  assert.equal(response.status, 201);
  assert.deepEqual(JSON.parse(e.writes[0].doc).screenshot, PNG);
});

test('owner inbox returns latest submissions as safe summaries, with screenshots fetched only when explicitly opened', async () => {
  const e = env(), earlier = Date.now;
  try {
    Date.now = () => 1800000000000;
    const one = await (await handleFeedback(POST(base({ message: 'First', screenshot: PNG })), e, tester())).json();
    Date.now = () => 1800000001000;
    await handleFeedback(POST(base({ kind: 'suggestion', message: '<img src=x onerror=alert(1)>', diagnostics: { mode: 'image', email: 'never collected' } })), e, owner);
    const result = await (await handleFeedback(GET(), e, owner)).json();
    assert.equal(result.retentionDays, 90);
    assert.deepEqual(result.entries.map((entry) => entry.message), ['<img src=x onerror=alert(1)>', 'First']);
    assert.deepEqual(result.entries[0].diagnostics, { mode: 'image' });
    assert.deepEqual(result.entries[1].screenshot, { type: 'image/png' });
    assert.ok(!JSON.stringify(result).includes(PNG.data));
    const image = await (await handleFeedback(GET(`?id=${one.id}`), e, owner)).json();
    assert.deepEqual(image.screenshot, PNG);
    assert.equal((await handleFeedback(GET('?id=me'), e, owner)).status, 400);
    assert.equal((await handleFeedback(GET('?id=00000000-0000-0000-0000-000000000000'), e, owner)).status, 404);
  } finally { Date.now = earlier; }
});

test('storage remains bounded per authenticated identity, with independent namespaces and a global cleanup cap', async () => {
  const e = env(), earlier = Date.now;
  let now = 1800000000000;
  try {
    Date.now = () => now++;
    for (let i = 0; i < 24; i++) await handleFeedback(POST(base({ message: `Report ${i}` })), e, tester('one'));
    for (let i = 0; i < 3; i++) await handleFeedback(POST(base({ message: `Other ${i}` })), e, tester('two'));
    assert.equal(e.entries.size, 23);
    assert.equal(e.deleted.length, 4);
    assert.ok([...e.entries.values()].some((raw) => JSON.parse(raw).message === 'Report 23'));
    assert.ok(![...e.entries.values()].some((raw) => JSON.parse(raw).message === 'Report 0'));
    for (let i = 0; i < 510; i++) e.entries.set(`feedback:v1:9999999999999:old-${String(i).padStart(4, '0')}:old`, JSON.stringify({}));
    await handleFeedback(POST(base()), e, owner);
    assert.equal(e.entries.size, FEEDBACK_LIMITS.total);
    assert.equal((await (await handleFeedback(GET(), e, owner)).json()).entries.length, 24);
  } finally { Date.now = earlier; }
});

test('missing KV and failed writes return actionable errors; cleanup failure does not falsely report a saved message as failed', async () => {
  assert.equal((await handleFeedback(POST(base()), {}, tester())).status, 503);
  const e = env(); e.ATELIER_KV.put = async () => { throw new Error('storage failure'); };
  assert.equal((await handleFeedback(POST(base()), e, tester())).status, 503);
  const second = env(); second.ATELIER_KV.list = async () => { throw new Error('eventual failure'); };
  const saved = await handleFeedback(POST(base()), second, tester());
  assert.equal(saved.status, 201);
  assert.equal(second.entries.size, 1);
});

test('client checks chosen screenshot size and format before reading or sending', () => {
  assert.equal(screenshotProblem(null), '');
  assert.equal(screenshotProblem({ type: 'image/png', size: 12000 }), '');
  assert.match(screenshotProblem({ type: 'image/svg+xml', size: 12000 }), /PNG/);
  assert.match(screenshotProblem({ type: 'image/jpeg', size: 350 * 1024 + 1 }), /350 KB/);
});

// A tiny DOM adapter fixture verifies actual form submission behavior without a browser or UI implementation tests.
function formFixture() {
  const listeners = {}, classes = { toggle() {}, remove() {} };
  const element = (value = '') => ({ value, disabled: false, checked: false, textContent: '', hidden: false, classList: classes, focus() {}, setCustomValidity(s) { this.validity = s; }, addEventListener(name, fn) { listeners[`file:${name}`] = fn; } });
  const form = { elements: { kind: element('bug'), message: element('Keep my edits'), screenshot: { ...element(), files: [] }, diagnostics: element() },
    addEventListener(name, fn) { listeners[name] = fn; }, reset() { this.resetCount = (this.resetCount || 0) + 1; this.elements.message.value = ''; this.elements.diagnostics.checked = false; this.elements.screenshot.files = []; },
    querySelector(selector) { return selector.includes('submit') ? send : selector.includes('feedback-error') ? error : selector.includes('data-clear-shot') ? clearShot : note; } };
  const send = element(), error = element(), note = element(), clearShot = element();
  const dialog = { open: false, setAttribute() {}, querySelector() { return form; }, querySelectorAll() { return []; }, showModal() { this.open = true; }, close() { this.open = false; } };
  const originals = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
  globalThis.document = { createElement: () => dialog, body: { append() {} } };
  globalThis.window = { innerWidth: 390, innerHeight: 844 };
  const restore = () => { for (const [key, value] of Object.entries(originals)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value; };
  return { form, send, error, dialog, submit: () => listeners.submit({ preventDefault() {} }), restore };
}

test('client only includes diagnostics when chosen; successful submit closes and resets, and failure preserves edits', async () => {
  const ui = formFixture(), requests = [], toasts = [];
  let fail = true;
  try {
    globalThis.fetch = async (url, options) => { requests.push({ url, ...options, json: JSON.parse(options.body) }); return new Response(JSON.stringify(fail ? { error: 'Try again shortly.' } : { ok: true }), { status: fail ? 503 : 201 }); };
    const feature = createFeedback({ headers: () => ({ 'x-app-pass': 'secret' }), role: () => 'owner', context: () => ({ mode: 'build', version: 'v76', online: true, prompt: 'NEVER COLLECTED', passcode: 'secret' }), toast: (text) => toasts.push(text) });
    feature.open();
    await ui.submit();
    assert.equal(ui.form.elements.message.value, 'Keep my edits');
    assert.equal(ui.dialog.open, true);
    assert.equal(ui.error.textContent, 'Try again shortly.');
    assert.equal(ui.send.disabled, false);
    assert.deepEqual(requests[0].json, { kind: 'bug', message: 'Keep my edits' });
    assert.equal(requests[0].credentials, 'same-origin');
    assert.equal(requests[0].headers['x-app-pass'], 'secret');
    ui.form.elements.diagnostics.checked = true;
    fail = false;
    await ui.submit();
    assert.deepEqual(requests[1].json.diagnostics, { mode: 'build', version: 'v76', online: true, viewport: { width: 390, height: 844 } });
    assert.equal(ui.form.resetCount, 1);
    assert.equal(ui.dialog.open, false);
    assert.equal(toasts.length, 1);
    assert.ok(!JSON.stringify(requests.map((r) => r.json)).includes('NEVER COLLECTED'));
  } finally { ui.restore(); }
});

test('signed-out client keeps the form content and never submits; owner inbox escapes user text', async () => {
  const ui = formFixture(); let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ entries: [{ id: 'x', at: 1800000000000, kind: 'bug', role: 'tester', message: '<img src=x onerror=alert(1)>', diagnostics: { mode: 'build', prompt: '<script>secret</script>' } }] })); };
    const signedout = createFeedback(); signedout.open(); await ui.submit();
    assert.equal(calls, 0);
    assert.equal(ui.form.elements.message.value, 'Keep my edits');
    const container = { innerHTML: '', querySelectorAll: () => [] };
    await createFeedback({ role: () => 'owner' }).showInbox(container);
    assert.ok(container.innerHTML.includes('&lt;img'));
    assert.ok(!container.innerHTML.includes('<img src=x'));
    assert.ok(!container.innerHTML.includes('secret'));
  } finally { ui.restore(); }
});

test('the client reads only a deliberately chosen screenshot, and failures retain its selection and diagnostic choice', async () => {
  const ui = formFixture(), oldReader = globalThis.FileReader, requests = [];
  const chosen = { name: 'preview.png', type: 'image/png', size: 12 };
  let reads = 0;
  try {
    globalThis.FileReader = class { readAsDataURL(file) { assert.equal(file, chosen); reads++; this.result = `data:image/png;base64,${PNG.data}`; this.onload(); } };
    globalThis.fetch = async (_, options) => { requests.push(JSON.parse(options.body)); return new Response('{"error":"Feedback is unavailable."}', { status: 503 }); };
    const feature = createFeedback({ role: () => 'tester', context: () => ({ mode: 'image', version: 'v76', online: true }) });
    feature.open();
    assert.equal(reads, 0);
    await ui.submit();
    assert.equal(reads, 0);
    assert.equal(requests[0].screenshot, undefined);
    ui.form.elements.screenshot.files = [chosen];
    ui.form.elements.diagnostics.checked = true;
    await ui.submit();
    assert.equal(reads, 1);
    assert.deepEqual(requests[1].screenshot, PNG);
    assert.equal(ui.form.elements.screenshot.files[0], chosen);
    assert.equal(ui.form.elements.diagnostics.checked, true);
    assert.equal(ui.form.elements.message.value, 'Keep my edits');
    assert.equal(ui.form.elements.screenshot.disabled, false);
  } finally {
    ui.restore();
    if (oldReader === undefined) delete globalThis.FileReader; else globalThis.FileReader = oldReader;
  }
});
