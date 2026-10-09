// The boot watchdog inline in public/index.html (#bootWatch): its state machine (booted, slow, stalled, module error,
// boot error, offline), the recovery actions (Reload, Repair offline copy: only Atelier's caches), the report sanitizer,
// client dedupe and cap, and that the CSP still allows it. The script runs as shipped, in a vm with a fake page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
const [HTML, HEADERS, APP, SW] = await Promise.all(['public/index.html', 'public/_headers', 'public/app.js', 'public/sw.js'].map(read));
const SCRIPT = /<script id="bootWatch">([\s\S]*?)<\/script>/.exec(HTML)?.[1];
const ORIGIN = 'https://atelier.test';
const tick = () => new Promise((r) => setImmediate(r));

// ── a fake page: just enough DOM for the watchdog's screen ──
class Node {
  constructor(tag, doc) { Object.assign(this, { nodeName: tag.toUpperCase(), nodeType: 1, ownerDocument: doc, children: [], attrs: {}, listeners: {}, className: '', id: '', hidden: false, disabled: false, open: false, modal: false, parentNode: null, _text: '' }); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'open') this.open = true; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; if (k === 'open') this.open = false; }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  click() { if (!this.disabled) for (const fn of this.listeners.click || []) fn({}); }
  focus() { this.ownerDocument.activeElement = this; }
  // A dialog's show() runs the dialog focusing steps (Chrome moves focus to it), so the "Still opening…" card must not use it.
  show() { this.open = true; this.ownerDocument.activeElement = this; }
  showModal() { if (!this.parentNode) throw new Error('not connected'); this.open = true; this.modal = true; }
  close() { this.open = false; this.modal = false; }
  all() { return [this, ...this.children.flatMap((c) => (c.all ? c.all() : []))]; }
  find(cls) { return this.all().find((n) => n.className.split(' ').includes(cls)) || null; }
}

function page({ online = true, ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X)', standalone = true, referrer = '', session = new Map(),
  blockStorage = false, cacheKeys = ['atelier-v84', 'atelier-v85', 'atelier-share', 'other-app'], probe = 'ok', clipboard = true, search = '?source=pwa' } = {}) {
  let now = 1000;
  const timers = [];
  let nextId = 1;
  const log = { fetches: [], deleted: [], unregistered: 0, updated: 0, reloads: 0, replaced: [], copied: [], touched: [] };
  const doc = { visibilityState: 'visible', referrer, activeElement: null };
  Object.assign(doc, {
    createElement: (t) => new Node(t, doc),
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
    head: new Node('head', doc), body: new Node('body', doc), documentElement: new Node('html', doc),
    querySelector: (sel) => (sel === 'script[type="module"]' ? { getAttribute: (k) => (k === 'src' ? '/app.js?v=85' : null) } : null),
    createRange: () => ({ selectNodeContents() {} }),
  });
  const listeners = {};
  // localStorage and IndexedDB must never be opened: any access is recorded.
  const forbidden = (name) => new Proxy({}, { get(_, k) { log.touched.push(`${name}.${String(k)}`); return () => {}; } });
  const storage = blockStorage ? { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } }
    : { getItem: (k) => (session.has(k) ? session.get(k) : null), setItem: (k, v) => session.set(k, String(v)) };
  const reg = { update: async () => { log.updated++; }, unregister: async () => { log.unregistered++; return true; } };
  const win = {
    document: doc, URL, DOMException, JSON, Promise, Date, Math, Number, String, Boolean, Array, Object, RegExp, Error, TypeError,
    location: { origin: ORIGIN, href: `${ORIGIN}/${search}`, search, reload: () => { log.reloads++; }, replace: (u) => { log.replaced.push(u); } },
    navigator: {
      onLine: online, userAgent: ua, platform: 'iPhone', maxTouchPoints: 5, standalone: standalone && /iPhone/.test(ua),
      serviceWorker: { controller: {}, getRegistration: async () => reg, getRegistrations: async () => [reg, reg] },
      clipboard: clipboard ? { writeText: async (t) => { log.copied.push(t); } } : undefined,
    },
    matchMedia: () => ({ matches: standalone }),
    performance: { now: () => now, getEntriesByType: () => [] },
    sessionStorage: storage, localStorage: forbidden('localStorage'), indexedDB: forbidden('indexedDB'),
    caches: {
      keys: async () => [...cacheKeys],
      delete: async (k) => { log.deleted.push(k); return true; },
      open: async (k) => { log.touched.push(`caches.open(${k})`); return {}; },
    },
    fetch: (url, init = {}) => {
      log.fetches.push({ url, init });
      if (url === '/sw.js') return probe === 'ok' ? Promise.resolve({ ok: true }) : probe === 'never' ? new Promise(() => {}) : Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve({ ok: true, status: 204 });
    },
    setInterval: (fn, ms) => { const id = nextId++; timers.push({ id, fn, ms, at: now + ms, every: true }); return id; },
    setTimeout: (fn, ms) => { const id = nextId++; timers.push({ id, fn, ms, at: now + ms, every: false }); return id; },
    clearInterval: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn); },
  };
  win.window = win;
  win.clearTimeout = win.clearTimeout.bind(win);
  vm.runInNewContext(SCRIPT, win);
  const api = win.atelierBoot;
  const fire = (type, ev = {}) => { for (const fn of listeners[type] || []) fn({ type, target: win, ...ev }); };
  async function advance(ms, step = 100) {
    for (let t = 0; t < ms; t += step) {
      now += step;
      for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
        if (timer.at > now || !timers.includes(timer)) continue;
        if (timer.every) timer.at += timer.ms; else timers.splice(timers.indexOf(timer), 1);
        timer.fn();
      }
    }
    await tick();
  }
  const screen = () => doc.body.children.find((n) => n.id === 'atelierRecovery') || null;
  const shown = (cls) => { const s = screen(), n = s?.find(cls); return Boolean(n) && !n.hidden; };
  const reports = () => log.fetches.filter((f) => f.url === '/api/client-error').map((f) => JSON.parse(f.init.body));
  // Esc or Android back with no tap first, as Chrome does it: 'cancel' can't be held, the dialog closes, 'close' fires.
  const closeRequest = (s) => { s.close(); for (const fn of s.listeners.close || []) fn({ type: 'close', target: s }); };
  return { win, doc, api, log, fire, advance, screen, shown, reports, session, timers, closeRequest, setOnline: (v) => { win.navigator.onLine = v; } };
}

// ErrorEvent-shaped errors as each engine reports them.
const v8Error = (name, message, frames) => ({ name, message, stack: `${name}: ${message}\n${frames.map((f) => `    at ${f}`).join('\n')}` });
const appScript = (path) => ({ nodeType: 1, nodeName: 'SCRIPT', src: `${ORIGIN}${path}` });

test('the watchdog is inline, first in <head> before any stylesheet or script, and app.js signals started → booted / failed', () => {
  assert.ok(SCRIPT, 'index.html has <script id="bootWatch">');
  const at = HTML.indexOf('<script id="bootWatch">');
  assert.ok(at < HTML.indexOf('<link rel="stylesheet"') && at < HTML.indexOf('<link href="https://fonts.googleapis.com'), 'ahead of the stylesheets (a slow font can’t hold it up)');
  assert.ok(at < HTML.indexOf('<script src="/vendor/marked.js">') && at < HTML.indexOf('<script src="/app.js'), 'ahead of every other script');
  assert.ok(HTML.indexOf('<style id="bootWatchStyle">') < at, 'its own styles: readable without app.css');
  // app.js: started() right before boot() runs, booted() when it resolves, failed(err) when it throws.
  // (\r?\n: a Windows checkout has CRLF line ends, as in the clean worktree npm run ship tests in.)
  assert.match(APP, /window\.atelierBoot\?\.started\(\);\r?\n\(async function boot\(\) \{/);
  assert.match(APP, /\}\)\(\)\.then\(\(\) => window\.atelierBoot\?\.booted\(\), \(err\) => \{\r?\n  console\.error\('\[atelier\] boot failed', err\);\r?\n  window\.atelierBoot\?\.failed\(err\);\r?\n\}\);\s*$/);
});

test('the CSP still allows the inline watchdog, and it needs nothing the policy keeps tight', () => {
  const policy = /^\s+Content-Security-Policy-Report-Only: (.+)$/m.exec(HEADERS)[1];
  const dir = Object.fromEntries(policy.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
  const hash = `'sha256-${createHash('sha256').update(SCRIPT, 'utf8').digest('base64')}'`;
  const scriptSrc = dir['script-src'] || dir['default-src'];
  // While a hash or nonce is listed, browsers ignore 'unsafe-inline': then this exact script must be listed by its hash.
  const hashed = scriptSrc.some((s) => /^'(sha\d+|nonce)-/.test(s));
  assert.ok(hashed ? scriptSrc.includes(hash) : scriptSrc.includes("'unsafe-inline'"), `script-src allows the watchdog (${hashed ? hash : "'unsafe-inline'"})`);
  assert.ok((dir['style-src'] || []).includes("'unsafe-inline'"), 'style-src allows its <style> block');
  assert.deepEqual(dir['script-src-attr'], ["'none'"], 'inline handlers stay off');
  // So it uses none: no handler attributes, eval, HTML strings or document.write; listeners only.
  const block = HTML.slice(HTML.indexOf('<style id="bootWatchStyle">'), HTML.indexOf('</script>', HTML.indexOf('<script id="bootWatch">')));
  assert.ok(!/\son[a-z]+\s*=/i.test(block), 'no on…= attributes');
  for (const bad of [/\beval\s*\(/, /new Function/, /innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /setAttribute\(\s*'on/]) assert.ok(!bad.test(SCRIPT), String(bad));
  // and nothing the deploy scripts read as a file reference (scripts/ship.mjs, bump-version.mjs).
  assert.ok(!/\b(?:src|href)="/.test(SCRIPT), 'no src="… / href="… inside the script');
  assert.ok(!/\?v=\d/.test(SCRIPT), 'no ?v=<n> for a version bump to rewrite');
});

test('booted in time: nothing is ever shown, the clock stops, a late error is only reported', async () => {
  const p = page();
  await p.advance(1500);
  p.api.started();
  await p.advance(1500);
  assert.equal(p.api.phase(), 'starting');
  p.api.booted();
  assert.equal(p.api.state(), 'booted');
  assert.equal(p.api.phase(), 'running');
  assert.equal(p.timers.length, 0, 'the visible-time clock is cleared');
  await p.advance(30_000);
  assert.equal(p.screen(), null, 'never a screen');
  // After boot an error is reported, never a recovery screen.
  p.fire('error', { filename: `${ORIGIN}/app.js?v=85`, lineno: 10, colno: 4, error: v8Error('TypeError', 'x is null', [`click (${ORIGIN}/app.js?v=85:10:4)`]) });
  await tick();
  assert.equal(p.screen(), null);
  assert.equal(p.reports().length, 1);
  assert.equal(p.reports()[0].phase, 'running');
});

test('slow: a quiet “Still opening…” at 8 s with nothing to press, then a normal start removes it', async () => {
  const p = page();
  const input = p.doc.createElement('textarea');
  p.doc.activeElement = input; // someone already typing in the composer (plain markup, usable before app.js runs)
  await p.advance(7900);
  assert.equal(p.api.state(), 'waiting');
  await p.advance(200);
  assert.equal(p.api.state(), 'slow');
  const s = p.screen();
  // A plain element, not a <dialog>: the app's dialog[open] checks (toast placement, launch, Look up) never count it,
  // and nothing runs the dialog focusing steps, so the keyboard stays open.
  assert.equal(s.nodeName, 'DIV');
  assert.ok(!s.modal, 'a non-modal card: the page behind stays as it is');
  assert.equal(s.getAttribute('role'), 'region');
  assert.equal(p.doc.activeElement, input, 'focus stays where it was');
  assert.match(s.textContent, /Still opening…/);
  assert.match(s.textContent, /a little longer than usual/);
  assert.ok(!p.shown('ar-actions'), 'no Reload or Repair yet');
  assert.ok(!/didn’t open|Repair/.test(s.find('ar-title').textContent + s.find('ar-body').textContent), 'nothing alarming');
  assert.equal(p.reports().length, 0, 'slow is not reported');
  p.api.started();
  p.api.booted();
  assert.equal(p.screen(), null, 'gone once the app is up');
});

test('stalled: at 20 s Reload and Repair are offered, once reported; boot can still finish; hidden time never counts', async () => {
  const p = page();
  p.doc.visibilityState = 'hidden';
  await p.advance(60_000);
  assert.equal(p.api.state(), 'waiting', 'a backgrounded app doesn’t count time');
  p.doc.visibilityState = 'visible';
  p.api.started();
  await p.advance(20_100);
  assert.equal(p.api.state(), 'stalled');
  assert.ok(p.shown('ar-actions') && p.shown('ar-primary'));
  const repair = p.screen().find('ar-actions').children[1];
  assert.equal(repair.textContent, 'Repair offline copy');
  assert.ok(!repair.hidden);
  assert.ok(!p.screen().modal, 'still not modal: keep waiting is an option');
  assert.equal(p.screen().nodeName, 'DIV');
  assert.equal(p.doc.activeElement, null, 'the card took no focus');
  assert.match(p.screen().textContent, /You can keep waiting, or reload/);
  assert.deepEqual(p.reports().map((r) => [r.kind, r.name, r.phase]), [['stall', 'Stall', 'starting']]);
  await p.advance(10_000);
  assert.equal(p.reports().length, 1, 'one stall report');
  p.api.booted();
  assert.equal(p.screen(), null);
});

test('a frozen page (the phone slept with the page showing) counts at most 2 s per tick', async () => {
  const p = page();
  // One tick after a 60 s gap: the clock jumps, the count doesn't.
  p.win.performance.now = () => 61_000;
  await p.advance(500, 500);
  assert.equal(p.api.state(), 'waiting');
});

test('module error: a syntax error in a module before app.js runs opens the recovery screen at once', async () => {
  const p = page();
  await p.advance(300);
  p.fire('error', { filename: `${ORIGIN}/app.js?v=85`, lineno: 6412, colno: 7, message: 'Unexpected token', error: { name: 'SyntaxError', message: 'Unexpected token ;', stack: 'SyntaxError: Unexpected token ;' } });
  await tick();
  assert.equal(p.api.state(), 'error');
  const s = p.screen();
  assert.ok(s.open && s.modal, 'modal: the half-drawn page is covered');
  assert.equal(s.getAttribute('role'), 'alertdialog');
  assert.match(s.find('ar-title').textContent, /Atelier didn’t open\./);
  assert.match(s.find('ar-body').textContent, /threads, settings and media are safe/);
  assert.ok(p.shown('ar-actions') && p.shown('ar-note') && p.shown('ar-details'));
  assert.equal(p.doc.activeElement?.textContent, 'Reload', 'focus on Reload');
  assert.equal(p.api.details(), 'Atelier v85 · SyntaxError · /app.js:6412:7');
  assert.equal(s.find('ar-code').textContent, p.api.details());
  assert.deepEqual(p.reports(), [{ v: '85', kind: 'error', name: 'SyntaxError', platform: 'ios-standalone', phase: 'loading', online: true, sw: true, file: '/app.js', line: 6412, col: 7 }]);
  assert.equal(p.timers.length, 0, 'no clock left running behind the recovery screen');
  // Esc is held when the browser lets the page (after a tap)...
  let prevented = false;
  for (const fn of s.listeners.cancel) fn({ preventDefault: () => { prevented = true; } });
  assert.ok(prevented);
  // ...and without a tap Chrome closes it anyway (Esc, Android back): it comes straight back, focus on Reload again.
  p.doc.activeElement = null;
  p.closeRequest(s);
  assert.ok(!s.open);
  await p.advance(100);
  assert.ok(s.open && s.modal, 'shown again');
  assert.equal(p.screen(), s);
  assert.equal(p.doc.activeElement?.textContent, 'Reload');
  p.closeRequest(s);
  await p.advance(100);
  p.closeRequest(s);
  await p.advance(100);
  assert.ok(s.open && s.modal, 'every time');
});

test('the offline screen comes back after Esc too; the app starting after all takes the screen away for good', async () => {
  const p = page({ online: false });
  p.fire('error', { target: appScript('/app.js?v=85') });
  await tick();
  const s = p.screen();
  assert.equal(p.api.state(), 'offline');
  p.closeRequest(s);
  await p.advance(100);
  assert.ok(s.open && s.modal);
  // An error in a module file while the graph loads (a timer in it threw), and then boot finished after all: booted()
  // takes the screen away, and that close is not undone.
  const q = page();
  q.fire('error', { filename: `${ORIGIN}/sync.js?v=85`, lineno: 3, colno: 9, error: v8Error('TypeError', 'x', [`t (${ORIGIN}/sync.js?v=85:3:9)`]) });
  await tick();
  const e = q.screen();
  assert.equal(q.api.state(), 'error');
  q.api.started();
  q.api.booted();
  for (const fn of e.listeners.close || []) fn({ type: 'close', target: e });
  await q.advance(100);
  assert.equal(q.screen(), null);
  assert.ok(!e.open && !e.parentNode, 'gone for good');
});

test('a module that fails to load is a load error naming the file; Chrome’s Resource Timing names the dependency (404, or the SPA fallback’s 200 page)', async () => {
  const p = page();
  p.win.performance.getEntriesByType = () => [{ name: `${ORIGIN}/app.css?v=85`, responseStatus: 200, contentType: 'text/css' }, { name: `${ORIGIN}/data-safety.js?v=85`, responseStatus: 404 }];
  p.fire('error', { target: appScript('/app.js?v=85') });
  await tick();
  assert.equal(p.api.state(), 'error');
  assert.equal(p.reports()[0].kind, 'load');
  assert.equal(p.reports()[0].name, 'LoadError');
  assert.equal(p.reports()[0].file, '/data-safety.js');
  assert.equal(p.reports()[0].net, false, 'a server error: a broken version');
  assert.match(p.screen().find('ar-title').textContent, /Atelier didn’t open\./);
  assert.ok(p.shown('ar-note') && !p.screen().find('ar-actions').children[1].hidden, 'Repair offered');
  // Production answers a missing file with index.html and 200 (wrangler.jsonc not_found_handling: single-page-application).
  const spa = page();
  spa.win.performance.getEntriesByType = () => [
    { name: `${ORIGIN}/app.js?v=85`, responseStatus: 200, contentType: 'text/javascript' },
    { name: `${ORIGIN}/data-safety.js?v=85`, responseStatus: 200, contentType: 'text/html' },
    { name: `${ORIGIN}/icons/x.png`, responseStatus: 200, contentType: 'text/html' },
  ];
  spa.fire('error', { target: appScript('/app.js?v=85') });
  await tick();
  assert.deepEqual([spa.reports()[0].file, spa.reports()[0].net], ['/data-safety.js', false]);
  assert.equal(spa.api.details(), 'Atelier v85 · LoadError · /data-safety.js');
  // Images, stylesheets and other sites' scripts that fail to load are none of its business.
  const q = page();
  q.fire('error', { target: { nodeType: 1, nodeName: 'IMG', src: `${ORIGIN}/icons/x.png` } });
  q.fire('error', { target: { nodeType: 1, nodeName: 'LINK', href: 'https://fonts.googleapis.com/css2' } });
  q.fire('error', { target: { nodeType: 1, nodeName: 'SCRIPT', src: 'https://static.cloudflareinsights.com/beacon.min.js' } });
  await tick();
  assert.equal(q.api.state(), 'waiting');
  assert.equal(q.reports().length, 0);
  // A vendor script that fails is reported; the timeline still covers a start that never comes.
  q.fire('error', { target: appScript('/vendor/highlight.js') });
  await tick();
  assert.equal(q.api.state(), 'waiting');
  assert.deepEqual(q.reports().map((r) => [r.kind, r.file]), [['load', '/vendor/highlight.js']]);
});

test('a file that didn’t arrive with no server error seen (a dropped connection, or Safari) says so: Try again, no Repair; the same again in this tab offers Repair', async () => {
  const p = page();
  // A network failure: Chrome lists it with status 0 (the service worker's Response.error() too); Safari lists no status.
  p.win.performance.getEntriesByType = () => [{ name: `${ORIGIN}/sync.js?v=86`, responseStatus: 0, contentType: '' }, { name: `${ORIGIN}/remix.js?v=86` }];
  p.fire('error', { target: appScript('/app.js?v=86') });
  await tick();
  assert.equal(p.api.state(), 'error');
  const s = p.screen();
  assert.ok(s.open && s.modal);
  assert.match(s.find('ar-title').textContent, /Couldn’t finish downloading\./);
  assert.match(s.find('ar-body').textContent, /connection dropped.*threads, settings and media are safe/);
  assert.ok(!/version/.test(s.find('ar-body').textContent), 'not blamed on the version');
  assert.equal(s.find('ar-primary').textContent, 'Try again');
  assert.ok(s.find('ar-actions').children[1].hidden && !p.shown('ar-note'), 'no Repair: the offline copy is fine');
  assert.deepEqual([p.reports()[0].kind, p.reports()[0].file, p.reports()[0].net], ['load', '/app.js', true], 'marked: not a crash');
  assert.ok(Number(p.session.get('atelier.netFailAt')) > 0);
  s.find('ar-primary').click();
  await p.advance(100);
  assert.equal(p.log.reloads, 1, 'Try again reloads');
  // The same after that reload, in the same tab: Repair is offered too.
  const q = page({ session: p.session });
  q.fire('error', { target: appScript('/app.js?v=86') });
  await tick();
  assert.match(q.screen().find('ar-title').textContent, /Atelier didn’t open\./);
  assert.match(q.screen().find('ar-body').textContent, /didn’t arrive again\. If your connection is fine, Repair/);
  assert.equal(q.screen().find('ar-primary').textContent, 'Reload');
  assert.ok(!q.screen().find('ar-actions').children[1].hidden && q.shown('ar-note'));
  assert.equal(q.reports().length, 0, 'the same failure is reported once a session');
  // A vendor file, a module error and a boot error say nothing of the network.
  const r = page();
  r.api.failed(v8Error('TypeError', 'x', [`boot (${ORIGIN}/app.js?v=85:5:6)`]));
  assert.equal(r.reports()[0].net, undefined);
  assert.equal(r.screen().find('ar-primary').textContent, 'Reload');
});

test('anything the app put in the screen goes back to the page when it goes: toast() moves #toast into the last open dialog', async () => {
  for (const how of ['slow', 'error']) {
    const p = page();
    if (how === 'slow') await p.advance(8100); else p.fire('error', { filename: `${ORIGIN}/sync.js?v=85`, lineno: 1, colno: 1, error: v8Error('TypeError', 'x', []) });
    await tick();
    const s = p.screen();
    assert.equal(p.api.state(), how);
    const toast = p.doc.createElement('div');
    toast.id = 'toast';
    s.appendChild(toast); // where toast() puts it: host.append(t)
    const stray = p.doc.createElement('span');
    s.find('ar-card').appendChild(stray);
    p.api.started();
    p.api.booted();
    assert.equal(p.screen(), null, how);
    assert.equal(toast.parentNode, p.doc.body, `${how}: #toast is back in <body>, so every later toast() still finds it`);
    assert.equal(stray.parentNode, p.doc.body, how);
    assert.ok(!s.children.includes(toast));
  }
});

test('boot error: boot() throwing opens the recovery screen with only the name and the app frames', async () => {
  const p = page();
  p.api.started();
  // Uncaught errors while boot() runs (a timer, a handler) are reported but don't take the screen.
  p.fire('error', { filename: `${ORIGIN}/sync.js?v=85`, lineno: 3, colno: 9, error: v8Error('RangeError', 'bad', [`x (${ORIGIN}/sync.js?v=85:3:9)`]) });
  await tick();
  assert.equal(p.api.state(), 'waiting');
  p.api.failed(v8Error('TypeError', 'Cannot read properties of null (reading "my secret prompt")', [
    `boot (${ORIGIN}/app.js?v=85:6290:3)`, `https://evil.example/x.js:1:1`, `${ORIGIN}/vendor/marked.js:12:40`,
  ]));
  await tick();
  assert.equal(p.api.state(), 'error');
  const r = p.reports().at(-1);
  assert.deepEqual(r, { v: '85', kind: 'boot', name: 'TypeError', platform: 'ios-standalone', phase: 'starting', online: true, sw: true, file: '/app.js', line: 6290, col: 3, stack: ['/app.js:6290:3', '/vendor/marked.js:12:40'] });
  assert.equal(p.api.details(), 'Atelier v85 · TypeError · /app.js:6290:3');
});

test('offline is not a crash: “You’re offline”, Try again, no Repair; one retry by itself when the connection returns', async () => {
  const p = page({ online: false });
  p.fire('error', { target: appScript('/app.js?v=85') });
  await tick();
  assert.equal(p.api.state(), 'offline');
  const s = p.screen();
  assert.match(s.find('ar-title').textContent, /You’re offline\./);
  assert.ok(!/didn’t open/.test(s.textContent));
  assert.equal(s.find('ar-primary').textContent, 'Try again');
  assert.ok(s.find('ar-actions').children[1].hidden, 'no Repair offline: it would throw away the only copy');
  assert.ok(!p.shown('ar-details'));
  p.setOnline(true);
  p.fire('online');
  await p.advance(3100);
  assert.equal(p.log.updated, 1, 'asks the service worker for a new version first');
  assert.equal(p.log.reloads, 1);
  // The same tab coming online again within a minute doesn't reload again (no loop).
  const again = page({ online: false, session: p.session });
  again.fire('error', { target: appScript('/app.js?v=85') });
  again.setOnline(true);
  again.fire('online');
  await again.advance(3100);
  assert.equal(again.log.reloads, 0);
  assert.equal(again.api.state(), 'offline', 'Try again still works by tap');
});

test('stalled while offline says so, and never offers Repair', async () => {
  const p = page({ online: false });
  await p.advance(20_100);
  assert.equal(p.api.state(), 'stalled');
  assert.match(p.screen().textContent, /You’re offline, so Atelier is opening from what’s saved on this device/);
  assert.ok(p.screen().find('ar-actions').children[1].hidden);
  assert.equal(p.reports().length, 0, 'no stall report while offline');
  p.setOnline(true);
  p.fire('online');
  assert.ok(!p.screen().find('ar-actions').children[1].hidden, 'back online: Repair is offered');
});

test('Reload: a tap asks the service worker to update (3 s at most), then reloads; never twice at once', async () => {
  const p = page();
  p.fire('error', { target: appScript('/app.js?v=85') });
  await tick();
  const reload = p.screen().find('ar-primary');
  reload.click(); reload.click();
  await p.advance(100);
  assert.equal(p.log.updated, 1);
  assert.equal(p.log.reloads, 1);
  // A registration that never answers holds it 3 s, no longer.
  const q = page();
  q.win.navigator.serviceWorker.getRegistration = () => new Promise(() => {});
  q.api.reload();
  await q.advance(2900);
  assert.equal(q.log.reloads, 0);
  await q.advance(200);
  assert.equal(q.log.reloads, 1);
});

test('Repair: checks the server, unregisters the worker, deletes only atelier-v<N> caches, never opens IndexedDB or localStorage', async () => {
  const p = page();
  p.fire('error', { target: appScript('/app.js?v=85') });
  await tick();
  p.screen().find('ar-actions').children[1].click();
  await p.advance(100);
  const probe = p.log.fetches.find((f) => f.url === '/sw.js');
  assert.deepEqual({ ...probe.init }, { cache: 'no-store', credentials: 'omit' });
  assert.equal(p.log.unregistered, 2, 'every registration');
  assert.deepEqual(p.log.deleted, ['atelier-v84', 'atelier-v85'], 'not atelier-share (a pending share is the user’s) nor anyone else’s');
  assert.deepEqual(p.log.touched, [], 'IndexedDB, localStorage and cache contents untouched');
  assert.equal(p.log.replaced.length, 1);
  assert.match(p.log.replaced[0], /^\/\?repair=[0-9a-z]+$/, 'a fresh query: nothing cached answers it');
  assert.equal(p.log.reloads, 0);
  assert.ok(Number(p.session.get('atelier.repairedAt')) > 0);
  assert.match(p.screen().find('ar-status').textContent, /Repaired/);
  // The same failure after a repair: the screen says a fix is needed, and still offers both.
  const q = page({ session: p.session });
  q.fire('error', { target: appScript('/app.js?v=85') });
  await tick();
  assert.match(q.screen().find('ar-body').textContent, /Repair already ran here\. If it still won’t open, this version needs a fix/);
  assert.ok(!q.screen().find('ar-actions').children[1].hidden);
});

test('Repair keeps a pending share: ?share=<id> rides along to the reload (only an id of the right shape)', async () => {
  for (const [search, want] of [
    ['?share=sabcdefghij', /^\/\?share=sabcdefghij&repair=[0-9a-z]+$/],
    ['?source=share&share=s0123456789&x=1', /^\/\?share=s0123456789&repair=[0-9a-z]+$/],
    ['?share=failed', /^\/\?repair=[0-9a-z]+$/],
    ['?share=s0123456789%3Cscript%3E', /^\/\?repair=[0-9a-z]+$/],
    ['?share=SABCDEFGHIJ', /^\/\?repair=[0-9a-z]+$/],
  ]) {
    const p = page({ search });
    p.fire('error', { target: appScript('/app.js?v=85') });
    await tick();
    await p.api.repair();
    assert.equal(p.log.replaced.length, 1, search);
    assert.match(p.log.replaced[0], want, search);
    assert.deepEqual(p.log.deleted, ['atelier-v84', 'atelier-v85'], 'the share cache itself is never touched');
  }
});

test('Repair while the server can’t be reached removes nothing (failed fetch or no answer in 8 s)', async () => {
  for (const probe of ['fail', 'never']) {
    const p = page({ probe });
    p.fire('error', { filename: `${ORIGIN}/app.js?v=85`, lineno: 1, colno: 1, error: { name: 'SyntaxError', stack: '' } });
    await tick();
    const done = p.api.repair();
    await p.advance(8100);
    assert.equal(await done, false, probe);
    assert.deepEqual(p.log.deleted, [], probe);
    assert.equal(p.log.unregistered, 0, probe);
    assert.deepEqual(p.log.replaced, [], probe);
    assert.match(p.screen().find('ar-status').textContent, /Nothing was removed/, probe);
    assert.equal(p.screen().find('ar-primary').disabled, false, 'buttons back');
  }
});

test('Copy error details: only the version, error name and failing file; a fallback when the clipboard says no', async () => {
  const p = page();
  p.api.failed(v8Error('TypeError', 'secret words', [`boot (${ORIGIN}/app.js?v=85:5:6)`]));
  await tick();
  p.screen().find('ar-link').click();
  await tick();
  assert.deepEqual(p.log.copied, ['Atelier v85 · TypeError · /app.js:5:6']);
  assert.equal(p.screen().find('ar-status').textContent, 'Copied.');
  const q = page({ clipboard: false });
  q.api.failed(v8Error('TypeError', 'x', [`boot (${ORIGIN}/app.js?v=85:5:6)`]));
  q.screen().find('ar-link').click();
  await tick();
  assert.match(q.screen().find('ar-status').textContent, /Couldn’t copy/);
});

test('sanitizer: never the message, a query, a fragment, another site’s frame or user text; names and paths by pattern; frames capped', () => {
  const { api } = page();
  const secret = 'my private prompt about https://atelier.test/secret-thing.js:1:2';
  const stack = [
    `TypeError: ${secret}`, `and its second line https://atelier.test/also-secret.js:9:9`,
    ...Array.from({ length: 10 }, (_, i) => `    at f${i} (${ORIGIN}/remix-${i}.js?v=85&token=abc#frag:${i + 1}:${i + 2})`),
  ].join('\n');
  const v8 = api.report('error', { name: 'TypeError', stack });
  assert.equal(v8.stack.length, 6, 'six frames at most');
  assert.deepEqual([...v8.stack.slice(0, 2)], ['/remix-0.js:1:2', '/remix-1.js:2:3'], 'V8: only "at" lines are read (the message is never parsed)');
  const all = JSON.stringify(v8);
  for (const bad of ['private prompt', 'token', 'abc', 'frag', '?v=', 'https:', 'secret-thing', 'also-secret']) assert.ok(!all.includes(bad), bad);
  // Safari / Firefox shape: fn@url:line:col; other origins, blob:, eval and data: frames are dropped.
  const safari = api.report('boot', { name: 'Error', stack: [
    'boot@https://atelier.test/app.js?v=85:6290:12', 'evil@https://evil.example/app.js:1:1', 'blob@blob:https://atelier.test/abc:1:1',
    'eval code@', 'module code@https://atelier.test/vendor/marked.js:3:4', 'x@https://atelier.test/Weird%20Name.js:1:1',
    'y@https://atelier.test/../../etc/passwd.js:1:1', 'z@https://atelier.test/a/b/c.js:1:1',
  ].join('\n') });
  assert.deepEqual([...safari.stack], ['/app.js:6290:12', '/vendor/marked.js:3:4']);
  assert.deepEqual([safari.file, safari.line, safari.col], ['/app.js', 6290, 12], 'the top app frame names the place');
  // A name that isn't a code identifier, or a cross-origin file, says nothing.
  const odd = api.report('error', { name: 'Hello <b>world</b> my secret', file: 'https://evil.example/app.js?x=1', line: 3, col: 4 });
  assert.equal(odd.name, 'Error');
  assert.equal(odd.file, undefined);
  assert.equal(odd.line, undefined);
  assert.equal(api.report('error', { name: 'QuotaExceededError', file: `${ORIGIN}/?invite=SECRET#t`, line: 2, col: 1 }).file, '/index.html', 'the page itself, query dropped');
  assert.equal(api.report('error', { name: 'E', file: `${ORIGIN}/app.js`, line: -1, col: 1.5 }).line, undefined);
  // Only these keys, ever.
  assert.deepEqual(Object.keys(v8).sort(), ['col', 'file', 'kind', 'line', 'name', 'online', 'phase', 'platform', 'stack', 'sw', 'v']);
});

test('rejections: reported only when Atelier’s code or the browser’s storage threw; never on screen', async () => {
  const p = page();
  p.fire('unhandledrejection', { reason: 'a plain string with secrets' });
  p.fire('unhandledrejection', { reason: { name: 'Error', stack: 'Error: x\n    at https://other.example/x.js:1:1' } });
  p.fire('unhandledrejection', { reason: null });
  await tick();
  assert.equal(p.reports().length, 0);
  p.fire('unhandledrejection', { reason: v8Error('ApiError', 'Wrong passcode for cole@example.com', [`go (${ORIGIN}/app.js?v=85:44:2)`]) });
  p.fire('unhandledrejection', { reason: new DOMException('The quota has been exceeded: big secret', 'QuotaExceededError') });
  await tick();
  assert.deepEqual(p.reports().map((r) => [r.kind, r.name, r.file ?? null]), [['rejection', 'ApiError', '/app.js'], ['rejection', 'QuotaExceededError', null]]);
  assert.equal(p.api.state(), 'waiting', 'a rejection never takes the screen');
  for (const r of p.reports()) assert.ok(!JSON.stringify(r).includes('secret') && !JSON.stringify(r).includes('example.com'));
});

test('errors that aren’t Atelier’s (an extension, another site’s script, an inline page error before start) never take the screen', async () => {
  const p = page();
  p.fire('error', { filename: 'chrome-extension://abc/content.js', lineno: 1, colno: 1, error: v8Error('TypeError', 'x', ['chrome-extension://abc/content.js:1:1']) });
  p.fire('error', { filename: '', lineno: 0, colno: 0, error: null, message: 'Script error.' });
  p.fire('error', { filename: `${ORIGIN}/vendor/highlight.js`, lineno: 2, colno: 2, error: v8Error('TypeError', 'x', [`${ORIGIN}/vendor/highlight.js:2:2`]) });
  p.fire('error', { filename: `${ORIGIN}/?source=pwa`, lineno: 30, colno: 2, error: v8Error('TypeError', 'x', []) });
  // Chrome's ResizeObserver notice: an ErrorEvent on the page with nothing thrown and no line.
  p.fire('error', { filename: `${ORIGIN}/`, lineno: 0, colno: 0, error: null, message: 'ResizeObserver loop completed with undelivered notifications.' });
  await tick();
  assert.equal(p.api.state(), 'waiting');
  assert.deepEqual(p.reports().map((r) => r.file), ['/vendor/highlight.js', '/index.html'], 'the vendor and page errors are reported; the others aren’t');
});

test('client cap: each failure once per session, five at most; the count survives a reload; blocked storage caps per page', async () => {
  const p = page();
  const boom = (i) => p.fire('error', { filename: `${ORIGIN}/app.js?v=85`, lineno: i, colno: 1, error: v8Error('TypeError', 'x', []) });
  p.api.booted();
  boom(1); boom(1); boom(1);
  await tick();
  assert.equal(p.reports().length, 1, 'deduped');
  for (let i = 2; i <= 9; i++) boom(i);
  await tick();
  assert.equal(p.reports().length, 5, 'five a session');
  const again = page({ session: p.session });
  again.api.booted();
  again.fire('error', { filename: `${ORIGIN}/app.js?v=85`, lineno: 77, colno: 1, error: v8Error('TypeError', 'x', []) });
  await tick();
  assert.equal(again.reports().length, 0, 'the same tab after a reload has used its five');
  const blocked = page({ blockStorage: true });
  blocked.api.booted();
  for (let i = 1; i <= 9; i++) blocked.fire('error', { filename: `${ORIGIN}/app.js?v=85`, lineno: i, colno: 1, error: v8Error('TypeError', 'x', []) });
  await tick();
  assert.equal(blocked.reports().length, 5, 'private mode: still five, counted in memory');
  // Each report: POST, JSON, no cookies, kept alive through a reload.
  const sent = p.log.fetches.find((f) => f.url === '/api/client-error');
  assert.equal(sent.init.method, 'POST');
  assert.equal(sent.init.credentials, 'omit');
  assert.equal(sent.init.keepalive, true);
  assert.deepEqual({ ...sent.init.headers }, { 'content-type': 'application/json' });
  assert.ok(sent.init.body.length < 2048, 'under the server’s cap');
});

test('platform classes: iOS Home Screen, iOS Safari, the Android TWA (and after a reload), Android Chrome, desktop app and browser', () => {
  const android = 'Mozilla/5.0 (Linux; Android 16; Pixel 9) Chrome/141';
  assert.equal(page().api.platform, 'ios-standalone');
  assert.equal(page({ standalone: false }).api.platform, 'ios-browser');
  const twa = page({ ua: android, referrer: 'android-app://ai.ciprari.atelier' });
  assert.equal(twa.api.platform, 'android-twa');
  assert.equal(page({ ua: android, session: twa.session }).api.platform, 'android-twa', 'a reload loses the referrer, not the class');
  assert.equal(page({ ua: android }).api.platform, 'android-standalone');
  assert.equal(page({ ua: android, standalone: false, referrer: 'android-app://com.google.android.gm' }).api.platform, 'android-browser', 'a Custom Tab from Gmail is not the TWA');
  assert.equal(page({ ua: 'Mozilla/5.0 (Windows NT 10.0) Chrome/141' }).api.platform, 'desktop-standalone');
  assert.equal(page({ ua: 'Mozilla/5.0 (Windows NT 10.0) Chrome/141', standalone: false }).api.platform, 'desktop-browser');
});

test('sw.js caching is unaffected: it never answers /sw.js (the repair probe) or /api/client-error, and activate still drops only old atelier-v caches', async () => {
  const handlers = {}, fetched = [], deleted = [];
  vm.runInNewContext(SW, { URL, Response, location: { origin: ORIGIN },
    self: { addEventListener: (n, fn) => { handlers[n] = fn; }, clients: { claim: async () => {} }, skipWaiting: async () => {} },
    caches: { open: async () => ({ match: async () => new Response('cached'), put: async () => {}, addAll: async () => {} }), keys: async () => ['atelier-v1', 'atelier-share', 'other'], delete: async (k) => deleted.push(k) },
    fetch: async (r) => { fetched.push(r); return new Response('network'); } });
  for (const [path, method] of [['/sw.js', 'GET'], ['/api/client-error', 'POST'], ['/api/client-error', 'GET']]) {
    let answered = false;
    handlers.fetch({ request: { url: `${ORIGIN}${path}`, method, mode: 'cors' }, waitUntil() {}, respondWith: () => { answered = true; } });
    assert.equal(answered, false, `${method} ${path} goes to the network`);
  }
  let done;
  handlers.activate({ waitUntil: (p) => { done = p; } });
  await done;
  assert.deepEqual(deleted, ['atelier-v1']);
  assert.match(SW, /`\/app-errors\.js\?v=\$\{V\}`/, 'the Settings list module is precached at its ?v=');
});

test('nothing in the app can break it on purpose: the fixture’s switch lives only in scripts/review-server.mjs', async () => {
  const fixture = await read('scripts/review-server.mjs');
  assert.match(fixture, /REVIEW_BREAK/);
  for (const f of ['public/index.html', 'public/app.js', 'public/sw.js', 'src/worker.js', 'src/client-errors.js']) {
    const src = await read(f);
    assert.ok(!/review[_ ]break|REVIEW_BREAK|__review/.test(src), f);
  }
});
