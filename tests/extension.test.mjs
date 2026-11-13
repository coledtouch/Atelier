import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { unzipSync, strFromU8 } from 'fflate';
import { packExtension, productionManifest, isLocalPattern, isCli } from '../scripts/pack-extension.mjs';

const read = (p) => readFileSync(new URL(`../extension/${p}`, import.meta.url), 'utf8');
const BACKGROUND = read('background.js');
const CONFIRM_JS = read('confirm.js');
const CONFIRM_HTML = read('confirm.html');
const SOURCE_MANIFEST = JSON.parse(read('manifest.json'));
const EXT_ID = 'atelierext';
const APP = 'https://atelier.ciprari.ai';

const tick = () => new Promise((r) => setTimeout(r, 1));
async function until(cond, what = 'condition') {
  const end = Date.now() + 3000;
  while (!cond()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await tick(); }
}
// Timers handed to the scripts never keep the test process alive.
const unref = (f) => (...a) => { const t = f(...a); t?.unref?.(); return t; };

// ── a fake page: numbered elements as pageElements would have tagged them ──
// row: the text of the list row / table row the element sits in.
// labels: the text of the <label for> elements that name it (el.labels).
function fakeEl({ tag = 'BUTTON', attrs = {}, text = '', value = '', row, labels = [] } = {}) {
  const el = {
    tagName: tag, innerText: text, value, id: attrs.id || '', attrs: { ...attrs }, isContentEditable: false, form: null,
    labels: labels.map((t) => ({ innerText: t })),
    clicks: 0, events: [], focused: false,
    ...(row ? { parentElement: { closest: () => ({ innerText: row }) } } : {}),
    getAttribute: (n) => el.attrs[n] ?? null,
    setAttribute: (n, v) => { el.attrs[n] = String(v); },
    removeAttribute: (n) => { delete el.attrs[n]; },
    scrollIntoView() {}, focus() { el.focused = true; }, click() { el.clicks++; }, dispatchEvent(e) { el.events.push(e.type); },
  };
  return el;
}
// page.elements (number → element) can be replaced to renumber the page, as browser_elements would.
// byId: other elements by id (aria-labelledby points at them).
function fakePage({ title = 'Settings · acme/site', url = 'https://github.com/acme/site/settings', elements = {}, byId = {} } = {}) {
  const page = { title, url, elements };
  const all = () => Object.values(page.elements);
  page.document = {
    title,
    querySelector(sel) {
      let m = /^\[data-atelier-i="(\d+)"\]$/.exec(sel);
      if (m) return page.elements[m[1]] ?? null;
      m = /^\[data-atelier-c="([0-9a-f-]+)"\]$/.exec(sel);
      return m ? all().find((el) => el.attrs['data-atelier-c'] === m[1]) ?? null : null;
    },
    querySelectorAll(sel) { return sel === '[data-atelier-c]' ? all().filter((el) => 'data-atelier-c' in el.attrs) : []; },
    getElementById: (id) => (Object.hasOwn(byId, id) ? { innerText: byId[id] } : null),
    execCommand() {},
  };
  return page;
}

// ── background.js in a VM with just enough of chrome.* ──
function loadBackground({ manifest = SOURCE_MANIFEST, pages = {}, storage = {}, session = {}, windowsCreate } = {}) {
  const on = () => { const fns = []; return { fns, addListener: (f) => fns.push(f), removeListener: (f) => { const i = fns.indexOf(f); if (i >= 0) fns.splice(i, 1); } }; };
  const h = {
    events: { message: on(), connect: on(), removed: on(), startup: on(), installed: on(), alarm: on(), updated: on() },
    windows: [], removedWindows: [], injected: [], sockets: [], storage: { ...storage }, session: structuredClone(session), pages, cdp: [], native: [], os: 'win', nativeMissing: false, nativeReply: null, tabUpdates: [],
  };
  class FakeInput {}
  Object.defineProperty(FakeInput.prototype, 'value', { set(v) { this.typedValue = v; }, get() { return this.typedValue; } });
  class FakeWebSocket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor(url, protocols) { Object.assign(this, { url, protocols, readyState: 0, sent: [] }); h.sockets.push(this); }
    send(d) { this.sent.push(d); }
    // Like a browser: the close event comes later, after a round trip.
    close(code = 1005) {
      if (this.readyState >= 2) return;
      this.readyState = 2;
      this.closedWith = code;
      setTimeout(() => { this.readyState = 3; this.onclose?.({ code }); }, 5);
    }
  }
  const tab = (id) => { const p = pages[id]; if (!p) throw new Error(`No tab with id: ${id}.`); return { id, title: p.title, url: p.url, status: 'complete', windowId: 1 }; };
  const chrome = {
    runtime: {
      id: EXT_ID,
      getManifest: () => structuredClone(manifest),
      getURL: (p) => `chrome-extension://${EXT_ID}/${p}`,
      onStartup: h.events.startup, onInstalled: h.events.installed, onMessage: h.events.message, onConnect: h.events.connect,
      // The Atelier Messages helper on a Mac (native messaging), recorded in h.native.
      sendNativeMessage: async (host, msg) => {
        h.native.push([host, structuredClone(msg)]);
        if (h.nativeMissing) throw new Error('Specified native messaging host not found.');
        return h.nativeReply ? h.nativeReply(msg) : { ok: true, result: { op: msg.op } };
      },
      getPlatformInfo: async () => ({ os: h.os }),
    },
    alarms: { create() {}, onAlarm: h.events.alarm },
    storage: {
      local: {
        get: async (keys) => Object.fromEntries(keys.filter((k) => k in h.storage).map((k) => [k, h.storage[k]])),
        set: async (o) => { Object.assign(h.storage, o); },
      },
      session: {
        get: async (key) => (key in h.session ? { [key]: structuredClone(h.session[key]) } : {}),
        set: async (o) => { Object.assign(h.session, structuredClone(o)); },
      },
    },
    tabs: {
      get: async (id) => tab(id),
      query: async () => Object.keys(pages).map((id) => tab(Number(id))),
      create: async () => { throw new Error('not in these tests'); },
      update: async (id, props) => { h.tabUpdates.push([id, props]); return tab(id); }, remove: async () => {},
      onUpdated: h.events.updated,
    },
    scripting: {
      executeScript: async ({ target, func, args }) => {
        h.injected.push({ tabId: target.tabId, func: func.name, args });
        const page = pages[target.tabId];
        if (page.hold) await page.hold; // a page that isn't answering (e.g. showing a dialog box)
        ctx.document = page.document;
        ctx.window = page.window;
        ctx.location = { href: page.url };
        return [{ result: func(...args) }];
      },
    },
    // chrome.debugger (1.4.0 sign-in): every call is recorded in h.cdp; a page's onCdp plays Chrome's password manager.
    debugger: {
      attach: async (t, v) => { if (pages[t.tabId]?.noDebug) throw new Error('Another debugger is already attached'); h.cdp.push(['attach', t.tabId, v]); },
      detach: async (t) => { h.cdp.push(['detach', t.tabId]); },
      sendCommand: async (t, method, params) => { h.cdp.push([method, structuredClone(params)]); pages[t.tabId]?.onCdp?.(method, params); return {}; },
    },
    windows: {
      create: windowsCreate || (async (opts) => { const w = { id: 500 + h.windows.length, focused: true, ...opts }; h.windows.push(w); return w; }),
      remove: async (id) => { h.removedWindows.push(id); },
      update: async () => ({}),
      getLastFocused: async () => ({ left: 100, top: 50, width: 1400, height: 900, state: 'normal' }),
      onRemoved: h.events.removed,
    },
  };
  const ctx = vm.createContext({
    chrome, console, URL, crypto: globalThis.crypto, Event, KeyboardEvent: class extends Event {},
    HTMLInputElement: FakeInput, HTMLTextAreaElement: FakeInput, WebSocket: FakeWebSocket,
    setTimeout: unref(setTimeout), clearTimeout, setInterval: unref(setInterval), clearInterval,
  });
  vm.runInContext(BACKGROUND, ctx, { filename: 'background.js' });
  h.ctx = ctx;
  h.run = (code) => vm.runInContext(code, ctx);
  h.run('TIMING.settle = 0');
  // The Atelier tab in this browser, through bridge.js (the page controls cmd, args and the approved flag). Replies are
  // cloned out of the VM, as Chrome's messaging would, so they compare like ordinary objects.
  h.local = (cmd, args, origin = APP, extra = {}) => new Promise((resolve) => {
    const keep = h.events.message.fns[0]({ cmd, args, ...extra }, { id: EXT_ID, origin, url: `${origin}/`, tab: { id: 1 } }, (r) => resolve(structuredClone(r)));
    if (keep === false) setTimeout(() => resolve('ignored'), 5);
  });
  return h;
}

// Plays the confirm.html page: connects the port, says hello, and can answer.
function confirmPage(h, { url = h.windows.at(-1)?.url, sender } = {}) {
  const port = {
    name: 'atelier-confirm', received: [], disconnected: false,
    sender: sender || { id: EXT_ID, url, origin: `chrome-extension://${EXT_ID}`, tab: { id: 900, windowId: h.windows.at(-1)?.id } },
    msg: [], disc: [],
    postMessage(m) { port.received.push(structuredClone(m)); },
    disconnect() { port.disconnected = true; },
    onMessage: { addListener: (f) => port.msg.push(f) },
    onDisconnect: { addListener: (f) => port.disc.push(f) },
  };
  for (const f of h.events.connect.fns) f(port);
  const send = (m) => port.msg.forEach((f) => f(m));
  send({ hello: true, id: new URL(url).searchParams.get('id') });
  return { port, send, info: port.received.find((m) => m.info)?.info, close: () => port.disc.forEach((f) => f()) };
}

const repoPage = () => fakePage({ elements: {
  3: fakeEl({ tag: 'BUTTON', text: 'Delete this repository' }),
  4: fakeEl({ tag: 'INPUT', attrs: { type: 'text', name: 'q', placeholder: 'Search issues' }, value: 'old draft' }),
  5: fakeEl({ tag: 'INPUT', attrs: { type: 'password', name: 'pw', 'aria-label': 'Password' }, value: 'hunter2' }),
  6: fakeEl({ tag: 'INPUT', attrs: { type: 'text', name: 'card', autocomplete: 'cc-number', placeholder: 'Card number' } }),
} });
const clicks = (h) => h.injected.filter((c) => c.func === 'pageElement' && c.args[1] === 'click');
const typings = (h) => h.injected.filter((c) => c.func === 'pageElement' && c.args[1] === 'type');

// ── origins come from the manifest ──
test('the allowed origins are the content-script pages: localhost in the source manifest, only the site in production', () => {
  assert.deepEqual([...loadBackground().run('ALLOWED_ORIGINS')], [APP, 'http://localhost:8787']);
  assert.deepEqual([...loadBackground({ manifest: productionManifest(SOURCE_MANIFEST) }).run('ALLOWED_ORIGINS')], [APP]);
  assert.ok(!/localhost|127\.0\.0\.1/.test(BACKGROUND.replace(/\/\/.*$/gm, '')), 'no hard-coded local origins left in background.js');
});

test('a production build ignores the localhost page and refuses to pair with it', async () => {
  const h = loadBackground({ manifest: productionManifest(SOURCE_MANIFEST) });
  assert.equal(await h.local('status', {}, 'http://localhost:8787'), 'ignored');
  const ok = await h.local('pair', { token: 'a'.repeat(64) }, APP);
  assert.deepEqual(ok, { ok: true, result: { paired: true } });
  await until(() => h.sockets.length === 1, 'the relay socket');
  assert.equal(h.sockets.at(-1).url, 'wss://atelier.ciprari.ai/api/relay/ws');
  assert.deepEqual([...h.sockets.at(-1).protocols], ['atelier', 'a'.repeat(64)]);
});

test('a relay pairing saved by a build that allowed localhost is not used by a production build', async () => {
  const h = loadBackground({ manifest: productionManifest(SOURCE_MANIFEST), storage: { relayToken: 'a'.repeat(64), relayOrigin: 'http://localhost:8787' } });
  await tick();
  assert.equal(h.sockets.length, 0);
});

// ── the same-page path (the Atelier tab, through bridge.js) ──
test('a click from the Atelier tab waits for the confirmation window, which shows action, element and page', async () => {
  const h = loadBackground({ pages: { 7: repoPage() } });
  const reply = h.local('click', { tabId: 7, element: 3 });
  await until(() => h.windows.length === 1, 'the confirmation window');
  const w = h.windows[0];
  assert.match(w.url, new RegExp(`^chrome-extension://${EXT_ID}/confirm\\.html\\?id=[0-9a-f-]{36}$`));
  assert.equal(w.type, 'popup');
  assert.equal(w.focused, true);
  assert.equal(clicks(h).length, 0, 'nothing is clicked before the user answers');

  const page = confirmPage(h);
  assert.equal(page.info.action, 'click');
  assert.equal(page.info.via, 'local');
  assert.deepEqual(page.info.element, { tag: 'button', type: '', label: 'Delete this repository' });
  assert.deepEqual(page.info.page, { title: 'Settings · acme/site', url: 'https://github.com/acme/site/settings' });
  assert.ok(page.info.expiresAt > Date.now() + 40_000 && page.info.expiresAt <= Date.now() + 45_000);

  page.send({ answer: 'allow' });
  const res = await reply;
  assert.equal(res.ok, true);
  assert.equal(res.result.clicked, 'Delete this repository');
  assert.equal(h.pages[7].elements[3].clicks, 1);
  assert.deepEqual(h.removedWindows, [w.id], 'the window closes once answered');
  assert.equal(page.port.disconnected, true);
});

test('Deny returns an error to the app and nothing is clicked', async () => {
  const h = loadBackground({ pages: { 7: repoPage() } });
  const reply = h.local('click', { tabId: 7, element: 3 });
  await until(() => h.windows.length === 1);
  confirmPage(h).send({ answer: 'deny' });
  const res = await reply;
  assert.equal(res.ok, false);
  assert.match(res.error, /declined this click .* nothing was clicked/);
  assert.equal(h.pages[7].elements[3].clicks, 0);
  assert.equal(clicks(h).length, 0);
  assert.deepEqual(h.removedWindows, [h.windows[0].id]);
});

test('typing shows the exact text and the submit, and types it only after Allow', async () => {
  const h = loadBackground({ pages: { 7: repoPage() } });
  const reply = h.local('type', { tabId: 7, element: 4, text: 'bug: login loops', submit: true });
  await until(() => h.windows.length === 1);
  const page = confirmPage(h);
  assert.equal(page.info.action, 'type');
  assert.equal(page.info.text, 'bug: login loops');
  assert.equal(page.info.more, 0);
  assert.equal(page.info.submit, true);
  // A field's current value is never shown as its label.
  assert.deepEqual(page.info.element, { tag: 'input', type: 'text', label: 'Search issues' });
  assert.equal(typings(h).length, 0);
  page.send({ answer: 'allow' });
  const res = await reply;
  assert.equal(res.ok, true);
  assert.equal(h.pages[7].elements[4].typedValue, 'bug: login loops');
  assert.deepEqual(h.pages[7].elements[4].events, ['input', 'change', 'keydown']);
});

test('long text is shown up to 2,000 characters with a count of the rest', async () => {
  const h = loadBackground({ pages: { 7: repoPage() } });
  const reply = h.local('type', { tabId: 7, element: 4, text: 'x'.repeat(2500) });
  await until(() => h.windows.length === 1);
  const page = confirmPage(h);
  assert.equal(page.info.text.length, 2000);
  assert.equal(page.info.more, 500);
  page.send({ answer: 'deny' });
  assert.match((await reply).error, /declined this typing .* nothing was typed/);
});

test('password and payment fields are refused before any window opens', async () => {
  const h = loadBackground({ pages: { 7: repoPage() } });
  for (const element of [5, 6]) {
    const res = await h.local('type', { tabId: 7, element, text: 'x' });
    assert.equal(res.ok, false);
    assert.match(res.error, /never types into password, payment or ID fields/);
  }
  assert.equal(h.windows.length, 0);
  assert.equal(typings(h).length, 0);
});

// v89 review (pipeline-ext-sensitive-field-gaps): the refusal covers what REFUSED_FIELD and the agent prompt promise —
// passwords (also shown as text by a show-password toggle), sign-in codes, payment and ID numbers — read from the
// field's labels too; short words common in ordinary text count only in the field's own name, id or autocomplete.
test('typing is refused into every password, sign-in code, payment and ID field, however the page names it', async () => {
  const fields = {
    'show-password toggle (type=text, current-password)': { attrs: { type: 'text', name: 'password', autocomplete: 'current-password' } },
    'new-password': { attrs: { type: 'text', name: 'pw2', autocomplete: 'new-password' } },
    'masked by -webkit-text-security': { attrs: { type: 'text', name: 'f1', 'data-mask': 'disc' } },
    'PIN by name': { attrs: { type: 'tel', name: 'pin' } },
    'PIN by id': { attrs: { type: 'text', id: 'card_pin', name: 'f2' } },
    'one-time-code': { attrs: { type: 'text', name: 'code', autocomplete: 'one-time-code' } },
    'verification code label': { attrs: { type: 'text', name: 'f3', 'aria-label': 'Verification code' } },
    'SSN by <label for> only': { attrs: { type: 'text', id: 'f3', name: 'field3' }, labels: ['Social Security Number'] },
    'SSN by aria-labelledby': { attrs: { type: 'text', name: 'f4', 'aria-labelledby': 'lab4 hint4' }, byId: { lab4: 'Social security number', hint4: '9 digits' } },
    'bank account number': { attrs: { type: 'text', name: 'account_number' } },
    'account no. label': { attrs: { type: 'text', name: 'f5' }, labels: ['Account No.'] },
    'tax ID (EIN)': { attrs: { type: 'text', name: 'ein' } },
    'tax ID label': { attrs: { type: 'text', name: 'f6' }, labels: ['Tax ID'] },
    passport: { attrs: { type: 'text', name: 'passport_no' } },
    "driver's licence": { attrs: { type: 'text', name: 'f7' }, labels: ["Driver's license number"] },
    'national insurance': { attrs: { type: 'text', name: 'ni', placeholder: 'National Insurance number' } },
    'card expiry month': { attrs: { type: 'text', name: 'exp_month' } },
    'card number': { attrs: { type: 'text', name: 'cardnumber' } },
    'cc-csc': { attrs: { type: 'text', name: 'f8', autocomplete: 'cc-csc' } },
    // v91 review: camelCase identifiers (React-style pages) count word by word
    'otpCode (camelCase name)': { attrs: { type: 'text', name: 'otpCode', placeholder: 'Enter code' } },
    'otpInput / pinInput': { attrs: { type: 'text', name: 'otpInput', id: 'pinInput' } },
    pinNumber: { attrs: { type: 'text', name: 'pinNumber' } },
    userPin: { attrs: { type: 'text', id: 'userPin', name: 'f9' } },
    cardPin: { attrs: { type: 'tel', name: 'cardPin' } },
    'userPIN (capitals)': { attrs: { type: 'text', name: 'userPIN' } },
    pwdInput: { attrs: { type: 'text', name: 'pwdInput' } },
    acctNumber: { attrs: { type: 'text', name: 'acctNumber' } },
    'SSNNumber (an acronym run)': { attrs: { type: 'text', name: 'SSNNumber' } },
    'ssn by id': { attrs: { type: 'text', id: 'user_ssn', name: 'f10' } },
    'SSN label': { attrs: { type: 'text', name: 'f11' }, labels: ['SSN'] },
  };
  const elements = {}, byId = {}, names = {};
  Object.entries(fields).forEach(([what, f], i) => { elements[20 + i] = fakeEl({ tag: 'INPUT', ...f }); Object.assign(byId, f.byId || {}); names[20 + i] = what; });
  const page = fakePage({ elements, byId });
  const h = loadBackground({ pages: { 7: page } });
  // the page's computed style: only the masked one has -webkit-text-security
  h.ctx.getComputedStyle = (el) => ({ webkitTextSecurity: el.attrs['data-mask'] || 'none' });
  for (const [n, what] of Object.entries(names)) {
    const d = await h.local('describe', { tabId: 7, element: Number(n) });
    assert.equal(d.result?.sensitive, true, `${what}: described as sensitive`);
    const res = await h.local('type', { tabId: 7, element: Number(n), text: '123-45-6789' });
    assert.equal(res.ok, false, what);
    assert.match(res.error, /never types into password, payment or ID fields/, what);
  }
  assert.equal(h.windows.length, 0, 'refused before any window opens');
  assert.equal(typings(h).length, 0);
});

test('ordinary fields stay typeable: a short word in a label or placeholder is not a field name', async () => {
  const fields = {
    'search, German placeholder': { attrs: { type: 'search', name: 'q', placeholder: 'Geben Sie ein Stichwort ein' } },
    'shipping address': { attrs: { type: 'text', name: 'shipping_address', autocomplete: 'shipping street-address' } },
    'pin a note (label)': { attrs: { type: 'text', name: 'note' }, labels: ['Pin this note to the top'] },
    'settings title': { attrs: { type: 'text', name: 'setting_title', id: 'spinner_label' } },
    'export date': { attrs: { type: 'text', name: 'export_date' } },
    'email': { attrs: { type: 'email', name: 'email', autocomplete: 'email' } },
    'username': { attrs: { type: 'text', name: 'username', autocomplete: 'username' } },
    // v91 review: "ssn" inside a word was a match (busine-ss-n-ame), and camelCase splitting adds no new one
    businessName: { attrs: { type: 'text', name: 'businessName' } },
    'business name by id': { attrs: { type: 'text', id: 'businessName', name: 'f1' } },
    addressName: { attrs: { type: 'text', name: 'addressName' } },
    className: { attrs: { type: 'text', name: 'className' } },
    'businessname (one word)': { attrs: { type: 'text', name: 'businessname' } },
    'spinnerLabel / isPinned': { attrs: { type: 'text', name: 'spinnerLabel', id: 'isPinned' } },
    'tinyUrl / pinnedAt': { attrs: { type: 'text', name: 'tinyUrl', id: 'pinnedAt' } },
  };
  const elements = {}, names = {};
  Object.entries(fields).forEach(([what, f], i) => { elements[40 + i] = fakeEl({ tag: 'INPUT', ...f }); names[40 + i] = what; });
  const h = loadBackground({ pages: { 7: fakePage({ elements }) } });
  h.ctx.getComputedStyle = () => ({ webkitTextSecurity: 'none' });
  for (const [n, what] of Object.entries(names)) {
    const d = await h.local('describe', { tabId: 7, element: Number(n) });
    assert.equal(d.result?.sensitive, false, `${what}: not sensitive`);
  }
  // and the check still works where getComputedStyle is missing (it runs inside any page)
  const bare = loadBackground({ pages: { 7: fakePage({ elements: { 1: fakeEl({ tag: 'INPUT', attrs: { type: 'text', name: 'q' } }) } }) } });
  assert.equal((await bare.local('describe', { tabId: 7, element: 1 })).result.sensitive, false);
});

test('describe never reports a password field’s value', async () => {
  const h = loadBackground({ pages: { 7: repoPage() } });
  const res = await h.local('describe', { tabId: 7, element: 5 });
  assert.equal(res.ok, true);
  assert.equal(res.result.label, 'Password');
  assert.equal(res.result.sensitive, true);
  assert.ok(!JSON.stringify(res.result).includes('hunter2'));
  assert.equal(h.windows.length, 0, 'reading needs no confirmation');
});

test('no answer in time refuses and closes the window', async () => {
  const h = loadBackground({ pages: { 7: repoPage() } });
  h.run('TIMING.confirm = 30');
  const reply = h.local('click', { tabId: 7, element: 3 });
  await until(() => h.windows.length === 1);
  const res = await reply;
  assert.equal(res.ok, false);
  assert.match(res.error, /No one answered .* nothing was clicked/);
  assert.equal(h.pages[7].elements[3].clicks, 0);
  assert.deepEqual(h.removedWindows, [h.windows[0].id]);
});

test('closing the window, or the page going away, counts as Deny', async () => {
  const h = loadBackground({ pages: { 7: repoPage() } });
  h.run('COOLDOWN.first = 0'); // two refusals in a row here; the cooldown has its own tests
  let reply = h.local('click', { tabId: 7, element: 3 });
  await until(() => h.windows.length === 1);
  confirmPage(h);
  h.events.removed.fns.forEach((f) => f(h.windows[0].id));
  assert.match((await reply).error, /declined/);

  reply = h.local('click', { tabId: 7, element: 3 });
  await until(() => h.windows.length === 2);
  confirmPage(h).close();
  assert.match((await reply).error, /declined/);
  assert.equal(h.pages[7].elements[3].clicks, 0);
});

test('if the window can’t be opened, nothing happens', async () => {
  const h = loadBackground({ pages: { 7: repoPage() }, windowsCreate: async () => { throw new Error('no display'); } });
  const res = await h.local('click', { tabId: 7, element: 3 });
  assert.equal(res.ok, false);
  assert.match(res.error, /couldn’t be shown/);
  assert.equal(clicks(h).length, 0);
});

test('one request at a time: a second click while one waits is refused without a second window', async () => {
  const h = loadBackground({ pages: { 7: repoPage() } });
  h.run('COOLDOWN.first = 0');
  const first = h.local('click', { tabId: 7, element: 3 });
  await until(() => h.windows.length === 1);
  const second = await h.local('type', { tabId: 7, element: 4, text: 'x' });
  assert.equal(second.ok, false);
  assert.match(second.error, /still waiting for an answer on this computer/);
  assert.equal(h.windows.length, 1);
  confirmPage(h).send({ answer: 'deny' });
  await first;
  // Once answered, the next request gets its own window.
  const third = h.local('click', { tabId: 7, element: 3 });
  await until(() => h.windows.length === 2);
  confirmPage(h).send({ answer: 'allow' });
  assert.equal((await third).ok, true);
});

test('after a refusal, the same path is refused for a while without a window; the other path still asks', async () => {
  const h = loadBackground({ pages: { 7: repoPage() }, storage: { relayToken: 'a'.repeat(64), relayOrigin: APP } });
  const deliver = await relayed(h);
  let reply = h.local('click', { tabId: 7, element: 3 });
  await until(() => h.windows.length === 1);
  confirmPage(h).send({ answer: 'deny' });
  assert.match((await reply).error, /declined/);

  // A hijacked page asking again at once gets no new window, whatever it asks for.
  for (const [cmd, args] of [['click', { tabId: 7, element: 3 }], ['type', { tabId: 7, element: 4, text: 'x' }]]) {
    const res = await h.local(cmd, args);
    assert.equal(res.ok, false);
    assert.match(res.error, /just declined or left unanswered, so Atelier Browser won’t ask again for (29|30) s and nothing was done/);
  }
  assert.equal(h.windows.length, 1);
  assert.equal(clicks(h).length + typings(h).length, 0);
  assert.equal(h.injected.length, 1, 'not even the page is read');
  assert.deepEqual(h.session.cooldown.local.n, 1, 'kept in session storage');

  // The relay path has its own cooldown, untouched.
  const handled = deliver({ id: 'r9', cmd: 'click', args: { tabId: 7, element: 3 } });
  await until(() => h.windows.length === 2);
  confirmPage(h).send({ answer: 'allow' });
  await handled;
  assert.equal(repliesOn(h)[0].ok, true);
});

test('the cooldown doubles with each refusal in a row (deny, close, timeout), and an Allow resets it', async () => {
  const h = loadBackground({ pages: { 7: repoPage() } });
  h.run('COOLDOWN.first = 40');
  const lane = () => h.run('quiet.local');
  let reply = h.local('click', { tabId: 7, element: 3 });
  await until(() => h.windows.length === 1);
  confirmPage(h).send({ answer: 'deny' });
  await reply;
  assert.equal(lane().n, 1);
  assert.ok(lane().until - Date.now() <= 40);
  assert.match((await h.local('click', { tabId: 7, element: 3 })).error, /won’t ask again/);

  await new Promise((r) => setTimeout(r, 50));
  reply = h.local('click', { tabId: 7, element: 3 });
  await until(() => h.windows.length === 2);
  confirmPage(h).close(); // closing the window
  await reply;
  assert.equal(lane().n, 2);
  assert.ok(lane().until - Date.now() > 40 && lane().until - Date.now() <= 80, 'twice as long');

  await new Promise((r) => setTimeout(r, 90));
  reply = h.local('click', { tabId: 7, element: 3 });
  await until(() => h.windows.length === 3);
  confirmPage(h).send({ answer: 'allow' });
  assert.equal((await reply).ok, true);
  assert.equal(lane().n, 0);

  // After an Allow the next request asks at once. No answer in time is a refusal too.
  h.run('TIMING.confirm = 20');
  reply = h.local('click', { tabId: 7, element: 3 });
  await until(() => h.windows.length === 4);
  assert.match((await reply).error, /No one answered/);
  assert.equal(lane().n, 1);
  assert.match((await h.local('click', { tabId: 7, element: 3 })).error, /won’t ask again/);
});

test('a cooldown survives a restart of the service worker', async () => {
  const h = loadBackground({ pages: { 7: repoPage() }, session: { cooldown: { local: { until: Date.now() + 20_000, n: 1 } } } });
  const res = await h.local('click', { tabId: 7, element: 3 });
  assert.match(res.error, /won’t ask again for (19|20) s/);
  assert.equal(h.windows.length, 0);
});

test('a page that doesn’t answer (e.g. it shows a dialog box) is refused after a short wait and blocks nothing else', { timeout: 10_000 }, async () => {
  let release;
  const stuck = repoPage();
  stuck.hold = new Promise((r) => { release = r; });
  const h = loadBackground({ pages: { 7: stuck, 8: repoPage() } });
  h.run('TIMING.read = 30');
  const res = await h.local('click', { tabId: 7, element: 3 });
  assert.equal(res.ok, false);
  assert.match(res.error, /isn’t responding \(it may be showing a dialog box\), so nothing was done/);
  assert.equal(h.windows.length, 0);

  // Another tab gets its confirmation straight away (not "Another click … is still waiting").
  let reply = h.local('click', { tabId: 8, element: 3 });
  await until(() => h.windows.length === 1);
  // The stuck page answering late opens nothing.
  release();
  await tick(); await tick();
  assert.equal(h.windows.length, 1);
  confirmPage(h).send({ answer: 'allow' });
  assert.equal((await reply).ok, true);

  // A click that leaves the page stuck (its handler opens a dialog box) ends with a clear error, not a hang.
  reply = h.local('click', { tabId: 8, element: 3 });
  await until(() => h.windows.length === 2);
  const page = confirmPage(h);
  h.pages[8].hold = new Promise(() => {});
  page.send({ answer: 'allow' });
  const after = await reply;
  assert.equal(after.ok, false);
  assert.match(after.error, /stopped responding while Atelier Browser was clicking/);
});

test('the window opens over the last-used browser window, a little off-centre at random, with room for a typing request', async () => {
  const h = loadBackground();
  for (let i = 0; i < 12; i++) await h.run('popupWindow("about:blank")');
  // The fake last-focused window is 1400×900 at (100, 50).
  for (const w of h.windows) {
    assert.equal(w.width, 460);
    assert.equal(w.height, 600);
    assert.ok(w.left >= 100 + 470 - 60 && w.left <= 100 + 470 + 60, `left ${w.left}`);
    assert.ok(w.top >= 50 + 100 - 60 && w.top <= 50 + 100 + 60, `top ${w.top}`);
  }
  assert.ok(new Set(h.windows.map((w) => `${w.left},${w.top}`)).size > 1, 'not always the same spot');
});

test('only the extension’s own confirm page can answer, and only for its own request id', async () => {
  const h = loadBackground({ pages: { 7: repoPage() } });
  const reply = h.local('click', { tabId: 7, element: 3 });
  await until(() => h.windows.length === 1);
  // bridge.js (running in the Atelier page) connecting with the same port name.
  const forged = confirmPage(h, { sender: { id: EXT_ID, url: `${APP}/`, origin: APP, tab: { id: 1 } } });
  assert.equal(forged.port.disconnected, true);
  assert.equal(forged.info, undefined);
  forged.send({ answer: 'allow' });
  // The confirm page, but with a guessed id.
  const guessed = confirmPage(h, { url: `chrome-extension://${EXT_ID}/confirm.html?id=00000000-0000-4000-8000-000000000000` });
  assert.deepEqual(guessed.port.received, [{ gone: true }]);
  guessed.send({ answer: 'allow' });
  await tick();
  assert.equal(clicks(h).length, 0);
  // The real page, once; a second copy of it gets nothing.
  const real = confirmPage(h);
  assert.ok(real.info);
  const copy = confirmPage(h);
  assert.deepEqual(copy.port.received, [{ gone: true }]);
  copy.send({ answer: 'allow' });
  await tick();
  assert.equal(clicks(h).length, 0);
  real.send({ ping: true });
  real.send({ answer: 'deny' });
  assert.equal((await reply).ok, false);
});

test('an element that changes after the confirmation is not clicked', async () => {
  const h = loadBackground({ pages: { 7: repoPage() } });
  // The same node, relabelled while the user decides.
  let reply = h.local('click', { tabId: 7, element: 3 });
  await until(() => h.windows.length === 1);
  let page = confirmPage(h);
  h.pages[7].elements[3].innerText = 'Transfer ownership';
  page.send({ answer: 'allow' });
  let res = await reply;
  assert.equal(res.ok, false);
  assert.match(res.error, /element changed/);
  assert.equal(h.pages[7].elements[3].clicks, 0);

  // Another node in its place under the same number: the confirmed node is gone, so nothing is clicked.
  h.pages[7].elements[3].innerText = 'Delete this repository';
  reply = h.local('click', { tabId: 7, element: 3 });
  await until(() => h.windows.length === 2);
  page = confirmPage(h);
  const old = h.pages[7].elements[3];
  h.pages[7].elements[3] = fakeEl({ tag: 'BUTTON', text: 'Delete this repository' });
  page.send({ answer: 'allow' });
  res = await reply;
  assert.equal(res.ok, false);
  assert.match(res.error, /Element not found/);
  assert.equal(h.pages[7].elements[3].clicks + old.clicks, 0);
});

test('the node clicked is the node confirmed, even if browser_elements renumbers the page while the user decides', async () => {
  const a = fakeEl({ text: 'Archive', row: 'Invoice from Acme · 09:12 Archive' });
  const b = fakeEl({ text: 'Archive', row: 'Lunch on Friday? · 10:40 Archive' });
  const c = fakeEl({ text: 'Archive', row: 'New mail · 10:41 Archive' });
  const page = fakePage({ title: 'Inbox', url: 'https://mail.example.com/inbox', elements: { 0: a, 1: b } });
  const h = loadBackground({ pages: { 7: page } });
  const reply = h.local('click', { tabId: 7, element: 1 });
  await until(() => h.windows.length === 1);
  const confirm = confirmPage(h);
  // The confirmation tells the two Archive buttons apart by their row.
  assert.deepEqual(confirm.info.element, { tag: 'button', type: '', label: 'Archive', near: 'Lunch on Friday? · 10:40 Archive' });
  // A new mail arrives above row B, and the page is numbered again (browser_elements needs no confirmation).
  page.elements = { 0: a, 1: c, 2: b };
  assert.equal((await h.local('elements', { tabId: 7 })).ok, true);
  confirm.send({ answer: 'allow' });
  const res = await reply;
  assert.equal(res.ok, true);
  assert.deepEqual([a.clicks, b.clicks, c.clicks], [0, 1, 0]);
  assert.equal('data-atelier-c' in b.attrs, false, 'the mark is removed once used');
  // describe (reading only) marks nothing.
  await h.local('describe', { tabId: 7, element: 0 });
  assert.equal(Object.values(page.elements).some((el) => 'data-atelier-c' in el.attrs), false);
});

test('a page that navigates after the confirmation is not clicked', async () => {
  const h = loadBackground({ pages: { 7: repoPage() } });
  const reply = h.local('click', { tabId: 7, element: 3 });
  await until(() => h.windows.length === 1);
  const page = confirmPage(h);
  h.pages[7].url = 'https://evil.example/phish';
  page.send({ answer: 'allow' });
  const res = await reply;
  assert.match(res.error, /page changed/);
  assert.equal(h.pages[7].elements[3].clicks, 0);
});

test('bad element numbers are rejected before touching the page', async () => {
  const h = loadBackground({ pages: { 7: repoPage() } });
  for (const element of ['3"], body, [x="', -1, 1.5, undefined]) {
    const res = await h.local('click', { tabId: 7, element });
    assert.equal(res.ok, false);
    assert.match(res.error, /element number/);
  }
  assert.equal(h.injected.length, 0);
  assert.equal(h.windows.length, 0);
});

test('reading commands run without a confirmation, and never list Atelier or the extension’s own pages', async () => {
  const h = loadBackground({ pages: {
    7: repoPage(),
    8: fakePage({ title: 'Atelier', url: `${APP}/` }),
    9: fakePage({ title: 'Confirm', url: `chrome-extension://${EXT_ID}/confirm.html?id=x` }),
  } });
  const res = await h.local('tabs', {});
  assert.equal(res.ok, true);
  assert.deepEqual(res.result.map((t) => t.tabId), [7]);
  assert.equal(h.windows.length, 0);
  assert.deepEqual(await h.local('constructor', {}), { ok: false, error: 'Unknown command constructor' });
});

test('opening a page or reading one by its address needs Atelier’s approval flag, locally and through the relay; a tab read doesn’t', async () => {
  const h = loadBackground({ pages: { 7: repoPage() }, storage: { relayToken: 'a'.repeat(64), relayOrigin: APP } });
  const created = [];
  h.ctx.chrome.tabs.create = async ({ url }) => { created.push(url); h.pages[90 + created.length] = fakePage({ title: 'Loaded', url }); return { id: 90 + created.length }; };
  const NEEDS = /needs the user’s approval in Atelier first, so nothing was loaded/;
  // the Atelier tab (bridge.js): no flag, or anything but true, is refused before a tab is made
  for (const extra of [{}, { approved: false }, { approved: 'true' }, { approved: 1 }]) {
    for (const [cmd, args] of [['open', { url: 'https://evil.example/c?d=SECRET' }], ['read', { url: 'https://evil.example/r?d=SECRET' }], ['read', { tabId: 7, url: 'https://evil.example/r' }]]) {
      const res = await h.local(cmd, args, APP, extra);
      assert.equal(res.ok, false, `${cmd} ${JSON.stringify(extra)}`);
      assert.match(res.error, NEEDS);
    }
  }
  assert.deepEqual(created, [], 'no page was loaded');
  // reading an open tab needs nothing
  assert.equal((await h.local('read', { tabId: 7 })).ok, true);
  // with the flag the page loads
  const opened = await h.local('open', { url: 'https://example.com/a' }, APP, { approved: true });
  assert.equal(opened.ok, true);
  const read = await h.local('read', { url: 'https://example.com/b' }, APP, { approved: true });
  assert.equal(read.ok, true);
  assert.deepEqual(created, ['https://example.com/a', 'https://example.com/b']);
  // through the relay: the same rule on the flag the server passes on
  await until(() => h.sockets.length === 1, 'the relay socket');
  const ws = h.sockets[0];
  ws.readyState = 1; ws.onopen();
  await ws.onmessage({ data: JSON.stringify({ id: 'o1', cmd: 'open', args: { url: 'https://evil.example/c?d=SECRET' } }) });
  await ws.onmessage({ data: JSON.stringify({ id: 'o2', cmd: 'read', args: { url: 'https://evil.example/r?d=SECRET' }, approved: false }) });
  await ws.onmessage({ data: JSON.stringify({ id: 'o3', cmd: 'open', args: { url: 'https://example.com/c' }, approved: true }) });
  const replies = ws.sent.filter((x) => x !== 'ping').map((x) => JSON.parse(x));
  assert.deepEqual(replies.map((r) => [r.id, r.ok]), [['o1', false], ['o2', false], ['o3', true]]);
  for (const r of replies.slice(0, 2)) assert.match(r.error, NEEDS);
  assert.deepEqual(created, ['https://example.com/a', 'https://example.com/b', 'https://example.com/c']);
});

test('bridge.js passes the page’s approved flag on, and only a real true', () => {
  const bridge = read('bridge.js');
  assert.match(bridge, /chrome\.runtime\.sendMessage\(\{ cmd: d\.cmd, args: d\.args \|\| \{\}, approved: d\.approved === true \}\)/);
});

// ── the remote path (the server relay) ──
async function relayed(h) {
  await until(() => h.sockets.length === 1, 'the relay socket');
  const ws = h.sockets[0];
  ws.readyState = 1;
  ws.onopen();
  return (msg) => ws.onmessage({ data: JSON.stringify(msg) });
}
const repliesOn = (h) => h.sockets[0].sent.filter((s) => s !== 'ping').map((s) => JSON.parse(s));

test('a click through the relay opens the same confirmation, marked as coming from another device; Deny answers the relay with an error', async () => {
  const h = loadBackground({ pages: { 7: repoPage() }, storage: { relayToken: 'a'.repeat(64), relayOrigin: APP } });
  const deliver = await relayed(h);
  const handled = deliver({ id: 'r1', cmd: 'click', args: { tabId: 7, element: 3 } });
  await until(() => h.windows.length === 1);
  const page = confirmPage(h);
  assert.equal(page.info.via, 'remote');
  assert.equal(page.info.element.label, 'Delete this repository');
  page.send({ answer: 'deny' });
  await handled;
  const [reply] = repliesOn(h);
  assert.equal(reply.id, 'r1');
  assert.equal(reply.ok, false);
  assert.match(reply.error, /declined this click/);
  assert.equal(h.pages[7].elements[3].clicks, 0);
});

test('typing through the relay types only after Allow on this computer', async () => {
  const h = loadBackground({ pages: { 7: repoPage() }, storage: { relayToken: 'a'.repeat(64), relayOrigin: APP } });
  const deliver = await relayed(h);
  const handled = deliver({ id: 'r2', cmd: 'type', args: { tabId: 7, element: 4, text: 'hello' } });
  await until(() => h.windows.length === 1);
  assert.equal(typings(h).length, 0);
  const page = confirmPage(h);
  assert.equal(page.info.via, 'remote');
  assert.equal(page.info.text, 'hello');
  page.send({ answer: 'allow' });
  await handled;
  const [reply] = repliesOn(h);
  assert.equal(reply.ok, true);
  assert.equal(reply.result.typed, true);
  assert.equal(h.pages[7].elements[4].typedValue, 'hello');
});

test('the relay can’t reach local-only commands', async () => {
  const h = loadBackground({ storage: { relayToken: 'a'.repeat(64), relayOrigin: APP } });
  const deliver = await relayed(h);
  await deliver({ id: 'r3', cmd: 'pair', args: { token: 'b'.repeat(64), origin: APP } });
  assert.deepEqual(repliesOn(h), [{ id: 'r3', ok: false, error: 'Unknown command pair' }]);
  assert.equal(h.storage.relayToken, 'a'.repeat(64));
});

test('re-pairing while connected: the old socket’s late close doesn’t knock out the new one', async () => {
  const h = loadBackground({ storage: { relayToken: 'a'.repeat(64), relayOrigin: APP }, pages: { 7: repoPage() } });
  await relayed(h);
  assert.equal((await h.local('pair', { token: 'b'.repeat(64) })).ok, true);
  await until(() => h.sockets.length === 2, 'the new socket');
  const [old, now] = h.sockets;
  assert.equal(old.closedWith, 4000);
  assert.deepEqual([...now.protocols], ['atelier', 'b'.repeat(64)]);
  now.readyState = 1;
  now.onopen();
  await until(() => old.readyState === 3, 'the old socket’s close event');
  await tick();
  assert.equal((await h.local('status', {})).result.connected, true);
  // A command on the new connection is answered on it.
  await now.onmessage({ data: JSON.stringify({ id: 'r5', cmd: 'describe', args: { tabId: 7, element: 3 } }) });
  const replies = now.sent.filter((d) => d !== 'ping').map((d) => JSON.parse(d));
  assert.equal(replies.length, 1);
  assert.equal(replies[0].id, 'r5');
  assert.equal(replies[0].result.label, 'Delete this repository');
  assert.equal(h.sockets.length, 2, 'and no extra socket was opened');
});

test('a command that finishes after its socket was replaced is answered on the live one', async () => {
  const h = loadBackground({ storage: { relayToken: 'a'.repeat(64), relayOrigin: APP }, pages: { 7: repoPage() } });
  const deliver = await relayed(h);
  const handled = deliver({ id: 'r6', cmd: 'click', args: { tabId: 7, element: 3 } });
  await until(() => h.windows.length === 1);
  await h.local('pair', { token: 'b'.repeat(64) });
  await until(() => h.sockets.length === 2);
  const now = h.sockets[1];
  now.readyState = 1;
  now.onopen();
  confirmPage(h).send({ answer: 'deny' });
  await handled;
  assert.deepEqual(now.sent.map((d) => JSON.parse(d).id), ['r6']);
});

test('a cold start (top-level call plus onStartup) opens exactly one relay socket', async () => {
  const h = loadBackground({ storage: { relayToken: 'a'.repeat(64), relayOrigin: APP } });
  h.events.startup.fns.forEach((f) => f());
  h.events.installed.fns.forEach((f) => f({ reason: 'update' }));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.sockets.length, 1);
});

test('a socket that fails while connecting closes itself and tries again later', async () => {
  const h = loadBackground({ storage: { relayToken: 'a'.repeat(64), relayOrigin: APP } });
  await until(() => h.sockets.length === 1);
  h.run('scheduleReconnect = () => { globalThis.reconnects = (globalThis.reconnects || 0) + 1; }');
  h.sockets[0].onerror();
  await until(() => h.sockets[0].readyState === 3);
  assert.equal(h.run('globalThis.reconnects'), 1);
  assert.equal((await h.local('status', {})).result.connected, false);
});

// ── confirm.html / confirm.js ──
// Each element of confirm.html that has an id, with the attributes written on it.
function fakeDom() {
  const els = {};
  for (const [, attrText] of CONFIRM_HTML.matchAll(/<\w+\s([^>]*)>/g)) {
    const attrs = Object.fromEntries([...attrText.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(([, k, v = '']) => [k, v]));
    if (!attrs.id) continue;
    const el = {
      id: attrs.id, attrs, textContent: '', hidden: 'hidden' in attrs, disabled: 'disabled' in attrs, focused: false, focusOptions: undefined, listeners: {},
      getAttribute: (n) => el.attrs[n] ?? null,
      setAttribute: (n, v) => { el.attrs[n] = String(v); },
      addEventListener(t, f) { (el.listeners[t] ||= []).push(f); },
      focus(o) { el.focused = true; el.focusOptions = o; },
      // A mouse click has detail 1; a keyboard press on a button gives a click with detail 0.
      fire(t, ev = {}) { (el.listeners[t] || []).forEach((f) => f({ isTrusted: true, detail: 1, target: el, preventDefault() {}, ...ev })); },
    };
    els[attrs.id] = el;
  }
  return els;
}
function loadConfirmPage({ focused = true } = {}) {
  const els = fakeDom(), docL = {}, winL = {};
  const port = { sent: [], msg: [], disc: [], postMessage(m) { port.sent.push(structuredClone(m)); }, onMessage: { addListener: (f) => port.msg.push(f) }, onDisconnect: { addListener: (f) => port.disc.push(f) } };
  const page = {
    els, port, closed: false, focused,
    deliver: (m) => port.msg.forEach((f) => f(m)),
    key: (key) => (docL.keydown || []).forEach((f) => f({ key, preventDefault() {} })),
    // A real mouse press: pointerdown (seen by the document first), then the click.
    down: (el) => (docL.pointerdown || []).forEach((f) => f({ target: el, isTrusted: true })),
    press: (el) => { page.down(el); el.fire('click'); },
    focus: () => { page.focused = true; (winL.focus || []).forEach((f) => f({})); },
    blur: () => { page.focused = false; (winL.blur || []).forEach((f) => f({})); },
    live: () => page.els.allow.getAttribute('aria-disabled') === 'false',
    answers: () => port.sent.filter((m) => m.answer),
  };
  const ctx = vm.createContext({
    chrome: { runtime: { connect: (o) => { port.name = o.name; return port; } } },
    location: { search: '?id=req-1' }, URL, URLSearchParams,
    document: { title: '', getElementById: (id) => els[id], hasFocus: () => page.focused, addEventListener: (t, f) => { (docL[t] ||= []).push(f); } },
    window: { addEventListener: (t, f) => { (winL[t] ||= []).push(f); }, close: () => { page.closed = true; } },
    setTimeout: unref(setTimeout), clearTimeout, setInterval: unref(setInterval), clearInterval,
  });
  vm.runInContext(CONFIRM_JS, ctx, { filename: 'confirm.js' });
  page.ctx = ctx;
  return page;
}
const INFO = {
  action: 'type', via: 'remote', submit: true, text: 'Ship it <script>alert(1)</script>', more: 3,
  element: { tag: 'textarea', type: '', label: '<img src=x onerror=alert(1)>' },
  page: { title: 'New issue', url: 'https://github.com/acme/site/issues/new' }, expiresAt: Date.now() + 45_000,
};

test('confirm page: says hello with its id and shows the request as plain text', () => {
  const p = loadConfirmPage();
  assert.equal(p.port.name, 'atelier-confirm');
  assert.deepEqual(p.port.sent[0], { hello: true, id: 'req-1' });
  p.deliver({ info: { ...INFO, expiresAt: Date.now() + 45_000 } });
  const e = p.els;
  assert.equal(e.title.textContent, 'Allow Atelier to type and submit?');
  assert.match(e.via.textContent, /another device/);
  assert.equal(e.label.textContent, '“<img src=x onerror=alert(1)>”');
  assert.equal(e.kind.textContent, 'textarea');
  assert.equal(e.host.textContent, 'github.com');
  assert.equal(e.url.textContent, 'https://github.com/acme/site/issues/new');
  assert.equal(e.typed.hidden, false);
  assert.equal(e.text.textContent, INFO.text);
  assert.match(e.more.textContent, /3 more characters/);
  assert.match(e.timer.textContent, /Denied automatically in 4[45] s/);
  assert.equal(e.deny.focused, true, 'Deny has the focus, so Enter refuses');
  assert.deepEqual({ ...e.deny.focusOptions }, { preventScroll: true }, 'focusing Deny doesn’t scroll the heading away');
  assert.equal(e.near.hidden, true);
  assert.equal(e.href.hidden, true);
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(CONFIRM_JS), 'text only');
});

test('confirm page: a click shows the row the element sits in and where a link goes, as plain text', () => {
  const p = loadConfirmPage();
  p.deliver({ info: { ...INFO, action: 'click', text: undefined, element: { tag: 'a', type: '', label: 'Archive', near: 'Lunch on Friday? <b>x</b>', href: 'https://mail.example.com/a?id=1' } } });
  assert.equal(p.els.near.hidden, false);
  assert.equal(p.els.near.textContent, 'In: “Lunch on Friday? <b>x</b>”');
  assert.equal(p.els.href.hidden, false);
  assert.equal(p.els.href.textContent, 'Link to https://mail.example.com/a?id=1');
  assert.equal(p.els.typed.hidden, true);
});

test('confirm page: Allow unlocks only after the window has had focus for a moment, and posts allow once', async () => {
  const p = loadConfirmPage();
  p.deliver({ info: { ...INFO, action: 'click', text: undefined } });
  assert.equal(p.live(), false);
  p.press(p.els.allow);
  assert.deepEqual(p.answers(), [], 'a click before the delay does nothing');
  p.blur();
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(p.live(), false, 'still locked while the window is in the background');
  p.focus();
  assert.equal(p.live(), false);
  await until(p.live, 'Allow to unlock');
  p.els.allow.fire('click', { isTrusted: false, detail: 0 });
  assert.deepEqual(p.answers(), [], 'synthetic clicks are ignored');
  p.press(p.els.allow);
  p.press(p.els.allow);
  assert.deepEqual(p.answers(), [{ answer: 'allow' }]);
  assert.equal(p.live(), false);
  assert.equal(p.els.allow.disabled, true);
  assert.equal(p.els.deny.disabled, true);
});

test('confirm page: clicking non-stop where Allow appears never allows; Allow needs a pause first', async () => {
  const p = loadConfirmPage();
  p.deliver({ info: { ...INFO, action: 'click', text: undefined } });
  let last = Date.now();
  const end = Date.now() + 1800; // well past the 1 s wait
  while (Date.now() < end) {
    p.press(p.els.allow);
    if (Math.random() < 0.3) p.key('Enter'); // keys count as presses too
    last = Date.now();
    assert.equal(p.live(), false);
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.deepEqual(p.answers(), [], 'no Allow from the burst');
  await until(p.live, 'Allow to unlock after the pause');
  assert.ok(Date.now() - last >= 990, 'only after a full second without a press');
  p.press(p.els.allow);
  assert.deepEqual(p.answers(), [{ answer: 'allow' }]);
});

test('confirm page: a press that began before Allow unlocked doesn’t count; a keyboard press on Allow does', async () => {
  const p = loadConfirmPage();
  p.deliver({ info: { ...INFO, action: 'click', text: undefined } });
  // Tab to Allow and Enter (a click with detail 0) before it unlocks: ignored, and the wait starts again.
  p.key('Tab');
  p.key('Enter');
  p.els.allow.fire('click', { detail: 0 });
  assert.deepEqual(p.answers(), []);
  p.down(p.els.allow); // pressed early, held past the unlock …
  await until(p.live, 'Allow to unlock');
  p.els.allow.fire('click'); // … and released now
  assert.deepEqual(p.answers(), []);
  // A press elsewhere while Allow is live doesn't make a later click on Allow count either.
  p.down(p.els.deny);
  p.els.allow.fire('click');
  assert.deepEqual(p.answers(), []);
  // Once it is live, Enter on Allow works.
  p.key('Enter');
  p.els.allow.fire('click', { detail: 0 });
  assert.deepEqual(p.answers(), [{ answer: 'allow' }]);
});

test('confirm page: Deny and Esc refuse; a closed request shuts the window', async () => {
  let p = loadConfirmPage();
  p.deliver({ info: INFO });
  p.els.deny.fire('click');
  assert.deepEqual(p.port.sent.filter((m) => m.answer), [{ answer: 'deny' }]);

  p = loadConfirmPage();
  p.deliver({ info: INFO });
  p.key('Escape');
  assert.deepEqual(p.port.sent.filter((m) => m.answer), [{ answer: 'deny' }]);

  p = loadConfirmPage();
  p.deliver({ gone: true });
  assert.match(p.els.timer.textContent, /no longer waiting/);
  assert.equal(p.els.allow.disabled, true);
  assert.equal(p.live(), false);
  await until(() => p.closed, 'the window to close');
});

test('confirm.html: no inline script (MV3 extension pages forbid it), and the page is not web-accessible', () => {
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(CONFIRM_HTML));
  assert.match(CONFIRM_HTML, /<script src="confirm\.js"><\/script>/);
  assert.ok(!/\bon[a-z]+="/.test(CONFIRM_HTML));
  // Locked by aria-disabled, not the disabled attribute: a disabled button would swallow the early presses that must
  // restart the wait.
  assert.match(CONFIRM_HTML, /<button[^>]*id="allow"[^>]*aria-disabled="true"/);
  assert.ok(!/<button[^>]*id="allow"[^>]*\sdisabled\b/.test(CONFIRM_HTML));
  // The buttons stay in view while a tall request opens at its top.
  assert.match(CONFIRM_HTML, /\.foot \{[^}]*position: sticky; bottom: 0;[^}]*background: var\(--bg\)/);
  assert.equal(SOURCE_MANIFEST.web_accessible_resources, undefined, 'web pages must not be able to frame confirm.html');
  assert.equal(SOURCE_MANIFEST.externally_connectable, undefined);
});

// ── packing ──
// ── 1.3.4: "Don't ask again on this computer" ──
test('Allow with "Don’t ask again" ticked: that click runs, and later clicks and typing run with no window, locally and through the relay', async () => {
  const pages = { 7: repoPage() }, h = loadBackground({ pages });
  const first = h.local('click', { tabId: 7, element: 3 });
  await until(() => h.windows.length === 1, 'the confirmation window');
  confirmPage(h).send({ answer: 'allow', always: true });
  assert.ok(!(await first).error, 'the click that was allowed runs');
  assert.equal(h.storage.noAsk, true);
  assert.equal(clicks(h).length, 1);

  const again = await h.local('click', { tabId: 7, element: 3 });
  assert.ok(!again.error); assert.equal(h.windows.length, 1, 'no second window'); assert.equal(clicks(h).length, 2);
  const typed = await h.local('type', { tabId: 7, element: 4, text: 'hello', submit: false });
  assert.ok(!typed.error); assert.equal(h.windows.length, 1); assert.equal(typings(h).length, 1);
  assert.equal((await h.local('status', {})).result.asks, false);
});

test('with asking off, a password or payment field is still refused, a missing element still errors, and a changed page is still not clicked', async () => {
  const pages = { 7: repoPage() }, h = loadBackground({ pages, storage: { noAsk: true } });
  for (const element of [5, 6]) {
    const r = await h.local('type', { tabId: 7, element, text: 'x' });
    assert.match(r.error, /password|payment|sign-in|refus/i, `field ${element}`);
  }
  assert.equal(typings(h).length, 0); assert.equal(h.windows.length, 0);
  assert.match((await h.local('click', { tabId: 7, element: 99 })).error, /Element not found/);
  assert.equal(clicks(h).length, 0);
});

test('only an Allow from the extension’s own window turns asking off: a Deny with the tick, a page, and the relay cannot', async () => {
  const pages = { 7: repoPage() }, h = loadBackground({ pages });
  const p = h.local('click', { tabId: 7, element: 3 });
  await until(() => h.windows.length === 1, 'the confirmation window');
  confirmPage(h).send({ answer: 'deny', always: true });
  assert.ok((await p).error); assert.notEqual(h.storage.noAsk, true);
  // No command sets it: the page and the relay only have the commands below, and none of them writes noAsk = true.
  for (const cmd of ['noAsk', 'setNoAsk', 'always', 'allowAlways']) assert.ok((await h.local(cmd, { on: true })).error, cmd);
  assert.notEqual(h.storage.noAsk, true);
  assert.ok(!h.run('REMOTE_COMMANDS').includes('askAgain'), 'the relay cannot reach askAgain either');
  assert.equal((await h.local('status', {})).result.asks, true);
});

test('askAgain, from the Atelier tab on this computer, brings the window back', async () => {
  const pages = { 7: repoPage() }, h = loadBackground({ pages, storage: { noAsk: true } });
  assert.deepEqual((await h.local('askAgain', {})).result, { asks: true });
  assert.equal(h.storage.noAsk, false);
  const p = h.local('click', { tabId: 7, element: 3 });
  await until(() => h.windows.length === 1, 'the confirmation window is back');
  confirmPage(h).send({ answer: 'deny' });
  assert.ok((await p).error);
});

test('confirm page: the tick is sent only with an Allow, and the page carries the checkbox', () => {
  const html = readFileSync(new URL('../extension/confirm.html', import.meta.url), 'utf8');
  assert.match(html, /<input type="checkbox" id="always" \/>/);
  assert.match(html, /Don’t ask again on this computer\./);
  const js = readFileSync(new URL('../extension/confirm.js', import.meta.url), 'utf8');
  assert.match(js, /const always = choice === 'allow' && \$\('always'\)\?\.checked === true;/);
  assert.match(js, /port\.postMessage\(\{ answer: choice, \.\.\.\(always \? \{ always: true \} : \{\}\) \}\)/);
});

test('manifest: version 1.4.6, a description Chrome accepts, and a Chrome new enough for the worker keep-alives', () => {
  assert.equal(SOURCE_MANIFEST.version, '1.4.6');
  assert.ok(SOURCE_MANIFEST.description.length <= 132);
  assert.ok(Number(SOURCE_MANIFEST.minimum_chrome_version) >= 116);
});

// v89 review (pipeline-ext-version-not-enforced): the extension never updates itself, so the app asks for the build it
// ships. An older copy (an old 1.3.x, too) gets the update toast; scripts/check-bump.mjs makes every extension/ change
// raise the version.
test('the app asks for the extension build it ships: MIN_EXT is the manifest version, and an older copy gets the update toast', () => {
  const APP = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const min = /const MIN_EXT = '([\d.]+)';/.exec(APP)?.[1];
  assert.equal(min, SOURCE_MANIFEST.version, 'public/app.js MIN_EXT = extension/manifest.json version');
  const olderExt = new Function(`const MIN_EXT = '${min}'; return ${/\nconst olderExt = ([^\n]+);\n/.exec(APP)[1]};`)();
  for (const v of ['1.4.5', '1.4.4', '1.4.3', '1.4.2', '1.4.0', '1.3.10', '1.3.4', '1.3.3', '1.3.2', '1.3.1', '1.2.9', '0.9', '', null, undefined, '1.3', 'x']) assert.equal(olderExt(v), true, String(v));
  for (const v of [min, '1.4.6', '1.10.0', '2.0.0']) assert.equal(olderExt(v), false, v);
  assert.match(APP, /if \(olderExt\(d\.version\)\) setTimeout\(\(\) => toast\(`Atelier Browser has an update \(v\$\{MIN_EXT\}\)/);
});

test('isLocalPattern spots local development hosts only', () => {
  for (const p of ['http://localhost:8787/*', 'http://127.0.0.1/*', 'http://[::1]:8787/*', 'http://app.localhost/*']) assert.ok(isLocalPattern(p), p);
  for (const p of ['https://atelier.ciprari.ai/*', '<all_urls>', 'https://localhost.example.com/*']) assert.ok(!isLocalPattern(p), p);
});

test('the production pack drops localhost everywhere; the dev pack keeps it; both carry the confirmation page', () => {
  const prod = packExtension();
  const files = unzipSync(prod.zip);
  const manifest = JSON.parse(strFromU8(files['manifest.json']));
  assert.equal(manifest.version, '1.4.6');
  assert.deepEqual(manifest.content_scripts.map((c) => c.matches), [['https://atelier.ciprari.ai/*']]);
  assert.deepEqual(manifest.host_permissions, ['<all_urls>']);
  assert.ok(!/localhost|127\.0\.0\.1/.test(strFromU8(files['manifest.json'])));
  for (const f of ['background.js', 'bridge.js', 'confirm.html', 'confirm.js', 'icons/icon-128.png']) assert.ok(files[f], f);
  assert.equal(strFromU8(files['background.js']), BACKGROUND);

  const dev = packExtension({ dev: true });
  assert.deepEqual(dev.manifest.content_scripts[0].matches, ['https://atelier.ciprari.ai/*', 'http://localhost:8787/*']);
  assert.equal(dev.manifest.version, '1.4.6');
  assert.deepEqual(SOURCE_MANIFEST.content_scripts[0].matches, dev.manifest.content_scripts[0].matches, 'the source keeps localhost for Load unpacked');
});

test('the pack script knows it was started from the command line, also through a junction or symlink', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-pack-'));
  try {
    mkdirSync(join(dir, 'real'));
    const file = join(dir, 'real', 'pack.mjs');
    writeFileSync(file, '');
    symlinkSync(join(dir, 'real'), join(dir, 'link'), 'junction');
    const url = pathToFileURL(file).href; // what import.meta.url is: the real path
    assert.equal(isCli(file, url), true);
    assert.equal(isCli(join(dir, 'link', 'pack.mjs'), url), true, 'started through the link (npm run deploy would otherwise ship the old zip)');
    assert.equal(isCli(join(dir, 'real', 'other.mjs'), url), false);
    assert.equal(isCli(undefined, url), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // Imported (as by these tests), it packs nothing.
  assert.equal(isCli(), false);
});

test('productionManifest refuses a manifest that would still reach a local host', () => {
  assert.throws(() => productionManifest({ ...SOURCE_MANIFEST, externally_connectable: { matches: ['http://localhost:8787/*'] } }), /local host/);
  assert.throws(() => productionManifest({ ...SOURCE_MANIFEST, content_scripts: [{ matches: ['http://localhost:8787/*'], js: ['bridge.js'] }] }), /no content script/);
});

// ── 1.4.0: sign in with the password Chrome already saved ──
// A sign-in page. fill: 'click' (Chrome filled on load; the first real click releases it), 'pick' (Chrome fills only
// once its list is picked with ArrowDown + Enter), 'never' (Chrome has nothing saved for this site).
// 1.4.1: buttons = the form's buttons in page order, each { text, type, aria, title, value, shown, disabled, signs }
// (signs: pressing it sends the form; with no list the page has one <button type="submit">Log in</button> that does).
// They sit 40 px apart from y 180, so a click's y says which one took it (190, 230, 270, …); page.pressed names them.
// onEnter: 'send' = the page's own key handler sends the form on an Enter that gives a keypress. stays: the form is
// sent and the page stays as it was (a real page moves on, and the marks the extension left on its fields go with it).
// 1.4.2: saved = the user names Chrome holds for the site, in its order. A click fills the first; typed text (insertText)
// narrows the list to the names that start with it, and ArrowDown + Enter fills the first of those.
function loginPage({ fill = 'click', user = true, submit = true, password = true, buttons: specs, onEnter = '', stays = false, url = 'https://permits.example.gov/login', saved = null } = {}) {
  const form = {};
  const box = (top, h = 20) => () => ({ left: 10, top, width: h ? 100 : 0, height: h });
  const mk = (tag, attrs, rect) => { const el = fakeEl({ tag, attrs }); el.getBoundingClientRect = rect; el.form = form; return el; };
  const hidden = mk('INPUT', { type: 'hidden', name: 'csrf' }, box(0, 0));
  const userEl = mk('INPUT', { type: 'email', name: 'email', 'aria-label': 'Email' }, box(100));
  const pw = mk('INPUT', { type: 'password', name: 'password', 'aria-label': 'Password' }, box(140));
  const buttons = (specs || (submit ? [{ text: 'Log in', type: 'submit', signs: true }] : [])).map((s, i) => {
    const attrs = { ...(s.type === undefined ? {} : { type: s.type }), ...(s.aria ? { 'aria-label': s.aria } : {}), ...(s.title ? { title: s.title } : {}) };
    const el = mk(s.tag || 'BUTTON', attrs, box(180 + 40 * i, s.shown === false ? 0 : 20));
    return Object.assign(el, { innerText: s.text || '', value: s.value || '', disabled: s.disabled === true, signs: s.signs === true, what: s.text || s.value || s.aria || s.title || `button ${i + 1}` });
  });
  const btn = buttons[0];
  const inputs = [hidden, ...(user ? [userEl] : []), ...(password ? [pw] : [])];
  const all = [...inputs, ...buttons];
  form.querySelectorAll = (sel) => (sel === 'button, input[type=submit]' ? buttons : []);
  const listeners = [];
  const page = { title: 'Login · Permits', url, elements: {}, userEl, pw, btn, buttons, listeners, submitted: 0, enters: [], pressed: [] };
  page.window = {
    addEventListener: (type, f) => listeners.push(f),
    removeEventListener: (type, f) => { const i = listeners.indexOf(f); if (i >= 0) listeners.splice(i, 1); },
  };
  page.document = {
    title: page.title,
    querySelector(sel) {
      const m = /^\[data-atelier-(login|i|c)="([^"]+)"\]$/.exec(sel);
      return m ? all.find((el) => el.attrs[`data-atelier-${m[1]}`] === m[2]) ?? null : null;
    },
    querySelectorAll(sel) {
      if (sel === 'input') return inputs;
      if (sel === 'button, input[type=submit]') return buttons;
      if (sel === '[data-atelier-login]') return all.filter((el) => 'data-atelier-login' in el.attrs);
      if (sel === '[data-atelier-c]') return all.filter((el) => 'data-atelier-c' in el.attrs);
      return [];
    },
    getElementById: () => null,
  };
  // The form is sent. page.onSend lets a test say what the page does then (move to another address, close, hang).
  const send = () => { page.submitted++; page.onSend?.(); if (!stays) for (const el of all) delete el.attrs['data-atelier-login']; };
  const press = (b) => { page.pressed.push(b.what); if (b.signs) send(); };
  let listed = false;
  page.onCdp = (method, p) => {
    const up = method === 'Input.dispatchMouseEvent' && p.type === 'mouseReleased';
    const key = method === 'Input.dispatchKeyEvent' && p.type === 'rawKeyDown' ? p.key : '';
    if (up && p.y === 110 && fill === 'click' && !page.clickedOnce) { pw.value = 'hunter2'; if (saved) userEl.value = saved[0]; }
    if (up && p.y === 110) page.clickedOnce = true; // what Chrome filled on load is released by the first click only
    if (method === 'Input.insertText' && userEl.focused) userEl.value += p.text;
    if (key === 'ArrowDown' && (fill === 'pick' || saved)) listed = true;
    if (key === 'Enter') {
      // With Chrome's list showing, Chrome takes the Enter; otherwise the page gets it, unless the guard holds it.
      // A rawKeyDown carries no character, so the page gets a keydown and no keypress: no form is sent by it.
      if (listed && saved) { const hit = saved.find((s) => s.toLowerCase().startsWith(userEl.value.toLowerCase())); if (hit) { userEl.value = hit; pw.value = `pw-of-${hit}`; } else page.enters.push({ guarded: listeners.length > 0 }); }
      else if (listed) pw.value = 'hunter2';
      else page.enters.push({ guarded: listeners.length > 0 });
      listed = false;
    }
    // An Enter that carries its character gives the page a keypress. In a form the browser then presses the form's
    // default button: the first one that submits, shown or not. With no such button and two fields nothing is sent,
    // unless the page has its own key handler.
    if (method === 'Input.dispatchKeyEvent' && p.type === 'keyDown' && p.key === 'Enter' && p.text === '\r' && pw.focused) {
      const first = buttons.find((b) => /^(submit|)$/.test(String(b.attrs.type ?? '').toLowerCase()) && !b.disabled);
      if (first) press(first);
      else if (onEnter === 'send') send();
    }
    const hit = up ? buttons.find((b) => b.getBoundingClientRect().height > 0 && p.y === b.getBoundingClientRect().top + 10) : null;
    if (hit) press(hit);
  };
  return page;
}
const mouseAt = (h) => h.cdp.filter(([m, p]) => m === 'Input.dispatchMouseEvent' && p.type === 'mouseReleased').map(([, p]) => [p.x, p.y]);
const keysSent = (h) => h.cdp.filter(([m, p]) => m === 'Input.dispatchKeyEvent' && p.type === 'rawKeyDown').map(([, p]) => p.key);
function signinRig(opts, storage = { noAsk: true }) {
  const page = loginPage(opts);
  const h = loadBackground({ pages: { 7: page }, storage });
  h.run('TIMING.fill = 0; TIMING.front = 0; TIMING.pick = 0; TIMING.poll = 1; TIMING.bar = 0');
  return { h, page };
}

test('sign-in: a real click releases what Chrome filled, then Log in is clicked; the password never leaves the page', async () => {
  const { h, page } = signinRig({ fill: 'click' });
  const r = await h.local('signin', { tabId: 7 });
  assert.ok(r.ok, r.error);
  assert.equal(r.result.signedIn, 'submitted');
  assert.doesNotMatch(JSON.stringify(r), /hunter2/);
  assert.deepEqual(h.cdp[0], ['attach', 7, '1.3']);
  assert.deepEqual(mouseAt(h), [[60, 110], [60, 190]], 'the email field, then Log in');
  assert.deepEqual(keysSent(h), [], 'nothing typed, no list picked');
  assert.equal(page.submitted, 1);
  assert.deepEqual(h.cdp.at(-1), ['detach', 7]);
  assert.ok(!h.cdp.some(([m]) => m === 'Input.insertText'), 'never inserts text');
});

test('sign-in: when Chrome only lists the saved login, ArrowDown + Enter picks it, with the Enter guard on meanwhile', async () => {
  const { h, page } = signinRig({ fill: 'pick' });
  const r = await h.local('signin', { tabId: 7 });
  assert.ok(r.ok, r.error);
  assert.deepEqual(keysSent(h), ['ArrowDown', 'Enter']);
  assert.equal(page.submitted, 1);
  assert.equal(page.listeners.length, 0, 'the guard is removed');
  assert.deepEqual(page.enters, [], 'Chrome took the Enter');
  assert.equal(r.result.signedIn, 'submitted');
});

test('sign-in: with nothing saved, nothing is submitted, the stray Enter is held from the page, and the debugger lets go', async () => {
  const { h, page } = signinRig({ fill: 'never' });
  const r = await h.local('signin', { tabId: 7 });
  assert.equal(r.ok, false);
  assert.match(r.error, /didn’t fill a saved password/);
  assert.equal(page.submitted, 0);
  assert.deepEqual(page.enters, [{ guarded: true }], 'the page saw no unguarded Enter');
  assert.equal(page.listeners.length, 0);
  assert.deepEqual(h.cdp.at(-1), ['detach', 7]);
});

// 1.4.1 (v114 review, tools #4): the Enter was a rawKeyDown, which gives a page no keypress, so the form stayed where it
// was and the sign-in was still reported as submitted.
test('sign-in: no submit button → an Enter that carries its character, in the filled password field; no password field → refused before anything runs', async () => {
  // The page's "button" is a styled div; its own key handler sends the form on Enter.
  const one = signinRig({ fill: 'click', submit: false, onEnter: 'send' });
  const r = await one.h.local('signin', { tabId: 7 });
  assert.ok(r.ok, r.error);
  assert.equal(one.page.pw.focused, true);
  assert.deepEqual(one.h.cdp.filter(([m]) => m === 'Input.dispatchKeyEvent').map(([, p]) => p), [
    { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' },
    { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
  ]);
  assert.deepEqual(keysSent(one.h), [], 'no rawKeyDown: that one is for Chrome’s own list');
  assert.equal(one.page.submitted, 1, 'the form was sent');
  assert.equal(r.result.signedIn, 'submitted');
  assert.match(BACKGROUND, /await key\('ArrowDown', 40\);\r?\n\s+await sleep\(250\);\r?\n\s+await key\('Enter', 13\);/, 'the list pick keeps its rawKeyDown Enter: Chrome’s list takes that one');
  const none = signinRig({ password: false });
  const r2 = await none.h.local('signin', { tabId: 7 });
  assert.match(r2.error, /No sign-in form/);
  assert.deepEqual(none.h.cdp, []);
  assert.equal(none.h.windows.length, 0);
});

test('sign-in: a form that is still there afterwards is reported as unclear, never as submitted', async () => {
  // Two fields, no button and no key handler: Enter sends nothing.
  const none = signinRig({ fill: 'click', submit: false });
  let r = await none.h.local('signin', { tabId: 7 });
  assert.ok(r.ok, r.error);
  assert.equal(none.page.submitted, 0);
  assert.equal(r.result.signedIn, 'unclear');
  assert.equal(r.result.note, 'Chrome filled the password it had saved. Atelier never saw it. The sign-in form is still showing, so it isn’t known whether it went through. Look at that tab before trying again.');
  assert.deepEqual(r.result.now, { title: 'Login · Permits', url: 'https://permits.example.gov/login' });
  assert.doesNotMatch(JSON.stringify(r), /hunter2/);
  // The button was pressed and the page kept its form (a wrong password on a page that redraws nothing).
  const stays = signinRig({ stays: true });
  r = await stays.h.local('signin', { tabId: 7 });
  assert.deepEqual(stays.page.pressed, ['Log in']);
  assert.equal(r.result.signedIn, 'unclear');
  // The same, but the address changed: the page moved on, so it is submitted. A new #fragment alone is the same page.
  for (const [to, want] of [['https://permits.example.gov/home', 'submitted'], ['https://permits.example.gov/login#try-again', 'unclear']]) {
    const moved = signinRig({ stays: true });
    moved.page.onSend = () => { moved.page.url = to; };
    r = await moved.h.local('signin', { tabId: 7 });
    assert.equal(r.result.signedIn, want, to);
    assert.equal(r.result.now.url, to);
  }
  // The page shows a dialog box after the click and answers nothing: what it did is not known.
  const stuck = signinRig({ stays: true });
  stuck.h.run('TIMING.read = 30');
  stuck.page.onSend = () => { stuck.page.hold = new Promise(() => {}); };
  r = await stuck.h.local('signin', { tabId: 7 });
  assert.equal(r.result.signedIn, 'unclear');
  // The tab closed once the form was sent (a sign-in window that shuts itself): an answer, not "No tab with id".
  const closed = signinRig();
  closed.page.onSend = () => { delete closed.h.pages[7]; };
  r = await closed.h.local('signin', { tabId: 7 });
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.result, { signedIn: 'unclear', note: 'Chrome filled the password it had saved. Atelier never saw it. That tab then closed, so it isn’t known whether the sign-in went through.' });
});

test('sign-in: a tab lost while the form is being sent ends with "it isn’t known", and the debugger lets go', async () => {
  const { h, page } = signinRig();
  const play = page.onCdp;
  page.onCdp = (method, p) => {
    if (method === 'Input.dispatchMouseEvent' && p.type === 'mouseReleased' && p.y === 190) throw new Error('Debugger is not attached to the tab with id: 7.');
    return play(method, p);
  };
  const r = await h.local('signin', { tabId: 7 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'The tab stopped answering while the sign-in form was being sent. It isn’t known whether it went through. Look at that tab before trying again.');
  assert.deepEqual(h.cdp.at(-1), ['detach', 7]);
  // Before that click nothing was sent, so an error there stays a plain one.
  const early = signinRig();
  const play2 = early.page.onCdp;
  early.page.onCdp = (method, p) => {
    if (method === 'Input.dispatchMouseEvent' && p.y === 110) throw new Error('Debugger is not attached to the tab with id: 7.');
    return play2(method, p);
  };
  const r2 = await early.h.local('signin', { tabId: 7 });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /Debugger is not attached/);
  assert.equal(early.page.submitted, 0);
});

// 1.4.1 (v114 review, tools #5): the form's first button that submits took the click, and a <button> with no type
// does: a show-password toggle, "Forgot password?" or "Continue with Google" placed before the real button.
const signinOn = async (opts, storage) => { const rig = signinRig(opts, storage); return { ...rig, r: await rig.h.local('signin', { tabId: 7 }) }; };
test('sign-in presses the sign-in button, never a show-password toggle, "Forgot password?" or another provider’s button before it', async () => {
  const before = [{ aria: 'Show password' }, { text: 'Forgot password?' }, { text: 'Continue with Google' }];
  // the review's case: every button is a <button> with no type, and the real one comes last
  let s = await signinOn({ buttons: [...before, { text: 'Sign in', signs: true }] });
  assert.ok(s.r.ok, s.r.error);
  assert.deepEqual(s.page.pressed, ['Sign in']);
  assert.deepEqual(mouseAt(s.h), [[60, 110], [60, 310]], 'the email field, then the fourth button');
  assert.equal(s.r.result.signedIn, 'submitted');
  const cases = [
    ['a button marked type=submit wins, whatever it says', [{ text: 'Continue with Google' }, { text: 'Anmelden', type: 'submit', signs: true }, { text: 'Registrieren' }], 'Anmelden'],
    ['of two marked type=submit, the one that says sign in', [{ text: 'Suchen', type: 'submit' }, { value: 'Log In', tag: 'INPUT', type: 'submit', signs: true }], 'Log In'],
    ['"Sign in" before "Sign in with SSO"', [{ text: 'Sign in with SSO' }, { text: 'Sign in', signs: true }], 'Sign in'],
    ['"Sign in with email" when it is the only one that says so', [{ text: 'Sign in with email', signs: true }, { text: 'Abbrechen', type: 'button' }], 'Sign in with email'],
    ['the form’s first button with no type, once the toggle is set aside (the browser’s own choice for Enter, as before)', [{ aria: 'Show password' }, { text: 'Anmelden', signs: true }, { text: 'Registrieren' }], 'Anmelden'],
    ['a toggle named only by its title, or by an icon with an aria-label', [{ title: 'Show password' }, { text: '👁', aria: 'Hide password' }, { text: 'Anmelden', signs: true }], 'Anmelden'],
    ['a toggle named by its icon font, or as a toggle', [{ text: 'visibility_off' }, { aria: 'Toggle password visibility' }, { text: 'Anmelden', signs: true }, { text: 'Registrieren' }], 'Anmelden'],
    ['an eye that is a bare icon with no name: the button with words comes first', [{ text: '👁' }, {}, { text: 'Anmelden', signs: true }], 'Anmelden'],
    ['a bare icon is still pressed when it is the form’s only button', [{ signs: true }], 'button 1'],
    ['"Forgotten your password?" and "Reset password"', [{ text: 'Forgotten your password?' }, { text: 'Reset password' }, { text: 'Log in', signs: true }], 'Log in'],
    ['a hidden first button is never clicked', [{ text: 'Log in', type: 'submit', shown: false }, { text: 'Sign in', type: 'button', signs: true }], 'Sign in'],
  ];
  for (const [what, buttons, want] of cases) {
    s = await signinOn({ buttons });
    assert.ok(s.r.ok, `${what}: ${s.r.error}`);
    assert.deepEqual(s.page.pressed, [want], what);
    assert.equal(mouseAt(s.h).length, 2, `${what}: one click on the field, one on the button`);
  }
  // A provider's name sets a button aside only away from that provider's own site.
  s = await signinOn({ url: 'https://github.com/login', buttons: [{ text: 'Sign in to GitHub', signs: true }, { text: 'Cancel' }] });
  assert.deepEqual(s.page.pressed, ['Sign in to GitHub']);
  s = await signinOn({ buttons: [{ text: 'Sign in to GitHub' }, { text: 'Sign in', signs: true }] });
  assert.deepEqual(s.page.pressed, ['Sign in']);
});

test('sign-in: with no button it can click, Enter is used only where the form’s own default button is not one of those; otherwise the form is left untouched', async () => {
  // The page's button is a script-driven one (type=button) in words it doesn't know: no click, and Enter sends the form.
  let s = await signinOn({ buttons: [{ text: 'Weiter', type: 'button' }], onEnter: 'send' });
  assert.ok(s.r.ok, s.r.error);
  assert.deepEqual(mouseAt(s.h), [[60, 110]], 'only the field was clicked');
  assert.deepEqual(s.page.pressed, []);
  assert.equal(s.page.submitted, 1);
  assert.equal(s.r.result.signedIn, 'submitted');
  // A hidden submit button put first so that Enter works: Enter presses it, as it does for a person.
  s = await signinOn({ buttons: [{ text: 'Senden', type: 'submit', shown: false, signs: true }, { text: 'Weiter', type: 'button' }] });
  assert.ok(s.r.ok, s.r.error);
  assert.deepEqual(mouseAt(s.h), [[60, 110]]);
  assert.deepEqual(s.page.pressed, ['Senden']);
  // A disabled toggle is not the form's default button, so Enter is safe there too.
  s = await signinOn({ buttons: [{ aria: 'Show password', disabled: true }, { text: 'Weiter', type: 'button' }], onEnter: 'send' });
  assert.ok(s.r.ok, s.r.error);
  assert.equal(s.page.submitted, 1);
  // "Continue with Google" (or the toggle) is the form's default button and the real one is a styled div or a
  // script-driven button: a click would press it, and so would Enter. Nothing is asked, clicked or filled.
  for (const buttons of [[{ text: 'Continue with Google' }], [{ aria: 'Show password' }, { text: 'Weiter', type: 'button' }]]) {
    s = await signinOn({ buttons }, {});
    assert.deepEqual(s.r, { ok: false, error: 'Atelier Browser couldn’t tell which button signs in on that page, so nothing was submitted. Ask the user to sign in.' });
    assert.deepEqual(s.h.cdp, [], 'the debugger never attached');
    assert.equal(s.h.windows.length, 0, 'no window asked');
    assert.equal(s.page.pw.value, '', 'nothing was filled');
    assert.deepEqual(s.page.pressed, []);
  }
});

test('sign-in asks first in the extension’s own window, naming the password field; a Deny leaves the tab alone', async () => {
  const { h } = signinRig({ fill: 'click' }, {});
  const reply = h.local('signin', { tabId: 7 });
  await until(() => h.windows.length === 1, 'the confirmation window');
  const page = confirmPage(h);
  assert.equal(page.info.action, 'signin');
  assert.equal(page.info.element.label, 'Password');
  assert.equal(page.info.page.url, 'https://permits.example.gov/login');
  page.send({ answer: 'deny' });
  const r = await reply;
  assert.match(r.error, /declined this sign-in/);
  assert.deepEqual(h.cdp, []);
});

test('sign-in: the relay can ask for it; the manifest asks for debugger; the window says Atelier never sees the password', () => {
  const h = loadBackground();
  assert.ok(h.run('REMOTE_COMMANDS').includes('signin'));
  assert.ok(SOURCE_MANIFEST.permissions.includes('debugger'));
  assert.match(CONFIRM_JS, /Allow Atelier to sign in\?/);
  assert.match(CONFIRM_JS, /Atelier never sees it\./);
});

// ── 1.4.0: Messages on a Mac, through the Atelier Messages helper ──
test('messages: reads go straight to the helper with their limits clamped; an unknown op and a missing chat are refused', async () => {
  const h = loadBackground();
  assert.ok((await h.local('messages', { op: 'recent', limit: 900 })).ok);
  assert.ok((await h.local('messages', { op: 'read', chat: 'iMessage;-;+16175550142', limit: 0 })).ok);
  assert.deepEqual(h.native, [['ai.ciprari.atelier.messages', { op: 'recent', limit: 50 }], ['ai.ciprari.atelier.messages', { op: 'read', chat: 'iMessage;-;+16175550142', limit: 1 }]]);
  assert.match((await h.local('messages', { op: 'read' })).error, /Pass chat/);
  assert.match((await h.local('messages', { op: 'delete' })).error, /Unknown Messages action/);
  assert.equal(h.native.length, 2);
});

test('messages: a send needs the owner’s OK in Atelier, then this computer’s Allow, before the helper is called', async () => {
  const h = loadBackground();
  assert.match((await h.local('messages', { op: 'send', to: '+16175550142', text: 'On my way' })).error, /needs the user’s approval/);
  assert.equal(h.native.length, 0);
  const reply = h.local('messages', { op: 'send', to: '+16175550142', text: 'On my way' }, APP, { approved: true });
  await until(() => h.windows.length === 1, 'the confirmation window');
  const page = confirmPage(h);
  assert.equal(page.info.action, 'sms');
  assert.equal(page.info.element.label, '+16175550142');
  assert.equal(page.info.text, 'On my way');
  page.send({ answer: 'allow' });
  const r = await reply;
  assert.ok(r.ok, r.error);
  assert.deepEqual(h.native, [['ai.ciprari.atelier.messages', { op: 'send', to: '+16175550142', text: 'On my way' }]]);
});

test('messages: a Deny sends nothing; with "Don’t ask again" an approved send runs with no window; a blank or long text is refused', async () => {
  const h = loadBackground();
  const reply = h.local('messages', { op: 'send', to: '+16175550142', text: 'hi' }, APP, { approved: true });
  await until(() => h.windows.length === 1, 'the confirmation window');
  confirmPage(h).send({ answer: 'deny' });
  assert.match((await reply).error, /declined this text message.*nothing was sent/);
  assert.equal(h.native.length, 0);
  const quiet = loadBackground({ storage: { noAsk: true } });
  assert.ok((await quiet.local('messages', { op: 'send', to: 'pat@example.com', text: 'hi' }, APP, { approved: true })).ok);
  assert.equal(quiet.windows.length, 0);
  assert.equal(quiet.native.length, 1);
  assert.match((await quiet.local('messages', { op: 'send', to: 'pat@example.com', text: '  ' }, APP, { approved: true })).error, /Pass to/);
  assert.match((await quiet.local('messages', { op: 'send', to: 'pat@example.com', text: 'x'.repeat(2001) }, APP, { approved: true })).error, /over 2000/);
  assert.equal(quiet.native.length, 1);
});

test('messages: no helper → how to set it up; a helper error passes through; status names the id and the helper on a Mac only', async () => {
  const h = loadBackground();
  h.nativeMissing = true;
  assert.match((await h.local('messages', { op: 'recent' })).error, /Set up Messages/);
  h.nativeMissing = false;
  h.nativeReply = () => ({ ok: false, error: 'Chrome can’t read Messages yet. Give Google Chrome Full Disk Access.' });
  assert.match((await h.local('messages', { op: 'recent' })).error, /Full Disk Access/);
  h.nativeReply = null;
  const pc = (await h.local('status', {})).result;
  assert.equal(pc.mac, false); assert.equal(pc.messages, false); assert.equal(pc.id, EXT_ID);
  const before = h.native.length;
  assert.equal(h.native.length, before, 'no helper call off a Mac');
  h.os = 'mac';
  const mac = (await h.local('status', {})).result;
  assert.equal(mac.mac, true); assert.equal(mac.messages, true);
  assert.deepEqual(h.native.at(-1), ['ai.ciprari.atelier.messages', { op: 'ping' }]);
});

test('messages: the relay may carry it; the manifest asks for nativeMessaging; the window says what is sent', () => {
  const h = loadBackground();
  assert.ok(h.run('REMOTE_COMMANDS').includes('messages'));
  assert.ok(SOURCE_MANIFEST.permissions.includes('nativeMessaging'));
  assert.match(CONFIRM_JS, /Allow Atelier to send a text\?/);
  assert.match(CONFIRM_JS, /if \(typing \|\| texting\) \{/);
});

// ── 1.4.1: fixes from the v114 review ──
// tools #7: a helper that hadn't answered in 30 s read as "didn't answer", and the text still went out once the owner
// answered macOS's prompt. The agent, told it had failed, sent it again.
test('messages: a send that gets no answer from the helper says the outcome isn’t known; a helper that never ran sent nothing', async () => {
  const send = (h) => h.local('messages', { op: 'send', to: '+16175550142', text: 'On my way' }, APP, { approved: true });
  const h = loadBackground({ storage: { noAsk: true } });
  assert.equal(h.run('TIMING.helper'), 30_000);
  h.run('TIMING.helper = 30');
  h.nativeReply = () => new Promise(() => {}); // osascript sits on macOS's "Chrome wants to control Messages" prompt
  assert.deepEqual(await send(h), { ok: false, error: 'The Messages helper didn’t answer in time, so it isn’t known whether the text was sent. Check Messages before trying again.' });
  // a read with no answer is a plain failure: nothing can have gone out
  assert.deepEqual(await h.local('messages', { op: 'recent' }), { ok: false, error: 'The Messages helper on this computer didn’t answer.' });
  // the helper ran and went away before it answered: it may have sent first
  for (const died of ['Native host has exited.', 'Error when communicating with the native messaging host.']) {
    h.nativeReply = () => { throw new Error(died); };
    assert.deepEqual(await send(h), { ok: false, error: 'The Messages helper stopped before it answered, so it isn’t known whether the text was sent. Check Messages before trying again.' }, died);
  }
  // it never started: nothing was sent, and the note says how to set it up
  for (const never of ['Specified native messaging host not found.', 'Access to the specified native messaging host is forbidden.', 'Failed to start native messaging host.']) {
    h.nativeReply = () => { throw new Error(never); };
    assert.match((await send(h)).error, /^Messages isn’t set up on this computer\./, never);
  }
  // the helper's own answer is passed on as it is: it knows whether it sent
  h.nativeReply = () => ({ ok: false, error: 'Chrome can’t control Messages yet. Allow it in System Settings → Privacy & Security → Automation, then try again.' });
  assert.match((await send(h)).error, /^Chrome can’t control Messages yet\./);
  // reads keep the notes they had
  h.nativeReply = () => { throw new Error('Error when communicating with the native messaging host.'); };
  assert.match((await h.local('messages', { op: 'recent' })).error, /Set up Messages/);
  h.nativeReply = () => { throw new Error('Native host has exited.'); };
  assert.equal((await h.local('messages', { op: 'read', chat: 'x' })).error, 'Native host has exited.');
});

test('messages: a send fits inside the time the relay and the Atelier tab give it (the confirmation, then the helper)', () => {
  const worst = loadBackground().run('TIMING.confirm + TIMING.helper');
  assert.equal(worst, 75_000);
  const relay = readFileSync(new URL('../src/relay.js', import.meta.url), 'utf8');
  assert.ok(Number(/const COMMAND_TIMEOUT_MS = ([\d_]+);/.exec(relay)[1].replace(/_/g, '')) > worst, 'the relay waits longer than a send can take');
  // The Atelier tab on this computer (public/app.js): with less than that, "The browser took too long to respond" could
  // be said of a text that then goes out.
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const limit = /extCall\(step\.name\.startsWith\('personal_texts_'\) \? 'gmessages' : 'messages', \{ \.\.\.step\.args, op: step\.name\.replace\(\/\^\(messages\|personal_texts\)_\/, ''\) \}, ([^\n]+?), step\.write \|\| step\.confirm === true \|\| step\.auto === true\)/.exec(app)?.[1];
  assert.ok(limit, 'app.js runs a Messages step through extCall with a time limit');
  const given = new Function('step', `return ${limit};`)({ name: 'messages_send', write: true });
  assert.ok(given > worst, `public/app.js gives messages_send ${given} ms, and a send can take ${worst} ms`);
});

// tools #8: the tab was closed on the line after the read, so a page Chrome won't let an extension read left it open.
test('reading a page by its address always closes the tab it opened, and never a tab that was already open', async () => {
  const h = loadBackground({ pages: { 7: repoPage() } });
  h.run('TIMING.render = 0');
  const created = [], removed = [], dead = new Set();
  let stuck = false;
  h.ctx.chrome.tabs.create = async ({ url }) => {
    const id = 90 + created.push(url);
    h.pages[id] = fakePage({ title: 'Loaded', url });
    if (stuck) h.pages[id].hold = new Promise(() => {});
    return { id };
  };
  h.ctx.chrome.tabs.remove = async (id) => { removed.push(id); };
  // Chrome lets no extension script its own error page (a dead host), the Web Store or a PDF.
  const inject = h.ctx.chrome.scripting.executeScript;
  h.ctx.chrome.scripting.executeScript = async (o) => { if (dead.has(o.target.tabId)) throw new Error('Frame with ID 0 is showing error page'); return inject(o); };
  const read = (args) => h.local('read', args, APP, { approved: true });
  const ok = await read({ url: 'https://example.com/a' });
  assert.equal(ok.ok, true);
  assert.equal(ok.result.url, 'https://example.com/a');
  assert.equal('tabId' in ok.result, false, 'a tab that is gone is not named');
  assert.deepEqual(removed, [91], 'a page that reads: closed, as before');
  dead.add(92);
  assert.deepEqual(await read({ url: 'https://dead.example/' }), { ok: false, error: 'Frame with ID 0 is showing error page' });
  assert.deepEqual(removed, [91, 92], 'a page that can’t be read: its hidden tab is closed too');
  // a page that never answers (it opens a dialog box as it loads) held its tab the same way
  h.run('TIMING.read = 30');
  stuck = true;
  assert.deepEqual(await read({ url: 'https://example.com/alert' }), { ok: false, error: 'That page didn’t answer in time, so nothing was read. It may be slow, or showing a dialog box.' });
  assert.deepEqual(removed, [91, 92, 93]);
  // a tab that was already open is the user's: it stays, read or not
  assert.equal((await h.local('read', { tabId: 7 })).result.tabId, 7);
  dead.add(7);
  assert.equal((await h.local('read', { tabId: 7 })).ok, false);
  assert.equal((await read({ tabId: 7, url: 'https://example.com/b' })).ok, false, 'a tabId beside a url reads that tab');
  assert.deepEqual(removed, [91, 92, 93]);
  assert.equal(created.length, 3);
});

// tools #9: the one-second wait guarded Allow only. A click meant for something else, landing on the box's label as
// the window appeared, ticked it; the Allow a second later then turned asking off for good.
test('confirm page: "Don’t ask again" takes no tick before Allow can be chosen', async () => {
  // A real click on the box or its label: the press, then the click. The box flips unless a listener cancels the click.
  const tick = (p) => {
    const box = p.els.always;
    let cancelled = false;
    p.down(box);
    box.fire('click', { preventDefault() { cancelled = true; } });
    if (!cancelled) box.checked = !box.checked;
    return box.checked === true;
  };
  const early = loadConfirmPage(), late = loadConfirmPage();
  for (const p of [early, late]) p.deliver({ info: { ...INFO, action: 'click', text: undefined, expiresAt: Date.now() + 45_000 } });
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(tick(early), false, 'a click that lands on it as the window appears changes nothing');
  assert.equal(early.els.always.getAttribute('aria-disabled'), 'true', 'and it is shown as locked, like Allow');
  await until(late.live, 'Allow to unlock');
  assert.equal(early.live(), false, 'and that press started the wait again, like any other');
  assert.equal(late.els.always.getAttribute('aria-disabled'), 'false');
  assert.equal(tick(late), true, 'once Allow can be chosen, a tick is a choice');
  late.press(late.els.allow);
  assert.deepEqual(late.answers(), [{ answer: 'allow', always: true }]);
  await until(early.live, 'Allow to unlock');
  early.press(early.els.allow);
  assert.deepEqual(early.answers(), [{ answer: 'allow' }], 'the Allow that follows the stray click turns nothing off');
  // a keyboard press on the box (a click with detail 0) is held to the same rule
  const keyed = loadConfirmPage();
  keyed.deliver({ info: { ...INFO, action: 'click', text: undefined, expiresAt: Date.now() + 45_000 } });
  let cancelled = false;
  keyed.key(' ');
  keyed.els.always.fire('click', { detail: 0, preventDefault() { cancelled = true; } });
  assert.equal(cancelled, true);
  assert.match(CONFIRM_HTML, /\.always:has\(input\[aria-disabled="true"\]\) \{ opacity: \.45; cursor: default; \}/);
});

test('confirm page: the box names everything it covers, and a text message is headed "Text to send"', () => {
  assert.match(CONFIRM_HTML, /<span>Don’t ask again on this computer\. Atelier then clicks, types, signs in and sends texts here without this window\. Turn it back on in Atelier’s Settings, under Connections\.<\/span>/);
  // what it covers is what the worker lets through with no window: the four actions that ask
  for (const action of ['click', 'type', 'signin', 'sms']) assert.match(BACKGROUND, new RegExp(`confirmFirst\\('${action}', `), action);
  assert.equal(new Set(BACKGROUND.match(/confirmFirst\('\w+'/g)).size, 4, 'a fifth kind of request would need the wording changed');
  assert.equal(BACKGROUND.match(/confirmFirst\('sms', /g).length, 2, 'a text from the Mac, and one through Google Messages (1.4.6)');
  assert.match(CONFIRM_HTML, /<h2 id="typedTitle">Text to type<\/h2>/);
  const texting = loadConfirmPage();
  texting.deliver({ info: { action: 'sms', via: 'local', submit: false, text: 'On my way', more: 0, element: { tag: 'message', type: '', label: '+16175550142' }, page: { title: 'Messages', url: '' }, expiresAt: Date.now() + 45_000 } });
  assert.equal(texting.els.typedTitle.textContent, 'Text to send');
  assert.equal(texting.els.text.textContent, 'On my way');
  assert.equal(texting.els.typed.hidden, false);
  const typing = loadConfirmPage();
  typing.deliver({ info: { ...INFO, expiresAt: Date.now() + 45_000 } });
  assert.equal(typing.els.typedTitle.textContent, 'Text to type');
});

// ── 1.4.2 to 1.4.5 (v119 to v126): signing in on the owner's Mac ──
// 1.4.2: the agent opened the sign-in page in a background tab, where Chrome shows no saved passwords.
// 1.4.3: Chrome showed its list of two saved logins and the ArrowDown + Enter never picked one. The keys carry the
//   Mac's own key codes too, and the sign-in waits for the user to click their login.
// 1.4.4: the first click waits for Chrome's debugging bar, which moves the page and closes the list.
// 1.4.5: an account named was typed into the field (1.4.2 to 1.4.4). That closed Chrome's list or cut it down to a name
//   the model had guessed ("bkenny" for a login saved under a full address), and the address the owner then picked was
//   refused as another account. Nothing is typed now: Chrome's list opens for the user's own click, and the user picks.
test('sign-in 1.4.2: the tab comes to the front before any click', async () => {
  const { h } = signinRig({ fill: 'pick' });
  const r = await h.local('signin', { tabId: 7 });
  assert.ok(r.ok, r.error);
  assert.deepEqual(JSON.parse(JSON.stringify(h.tabUpdates[0])), [7, { active: true }]);
  assert.match(BACKGROUND.replace(/\r/g, ''), /await chrome\.windows\.update\(front\.windowId, \{ focused: true \}\);\n    \} catch \{[^}]*\}\n    await sleep\(TIMING\.front\);\n    const target = \{ tabId \};/, 'its window focused, then a moment, then the clicks');
});

test('sign-in 1.4.3: on a Mac the keys carry the Mac key codes', async () => {
  const { h } = signinRig({ fill: 'pick' });
  h.os = 'mac';
  const r = await h.local('signin', { tabId: 7 });
  assert.ok(r.ok, r.error);
  const sent = h.cdp.filter(([m, p]) => m === 'Input.dispatchKeyEvent' && p.type === 'rawKeyDown').map(([, p]) => [p.key, p.windowsVirtualKeyCode, p.nativeVirtualKeyCode]);
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [['ArrowDown', 40, 125], ['Enter', 13, 36]]);
  const win = signinRig({ fill: 'pick' });
  await win.h.local('signin', { tabId: 7 });
  assert.deepEqual(win.h.cdp.filter(([m, p]) => m === 'Input.dispatchKeyEvent' && p.type === 'rawKeyDown').map(([, p]) => p.nativeVirtualKeyCode), [40, 13]);
});

test('sign-in 1.4.3: when the keys pick nothing, the user’s own click in Chrome’s list is waited for, then the form goes', async () => {
  const { h, page } = signinRig({ fill: 'never' });
  h.run('TIMING.pick = 5000; TIMING.poll = 5');
  setTimeout(() => { page.pw.value = 'picked-by-hand'; }, 40); // the user clicks their login in Chrome's list
  const r = await h.local('signin', { tabId: 7 });
  assert.ok(r.ok, r.error);
  assert.equal(r.result.signedIn, 'submitted');
  assert.equal(page.submitted, 1);
  assert.deepEqual(page.enters.map((e) => e.guarded), [true], 'the page’s Enter was held while waiting');
  assert.equal(page.listeners.length, 0, 'and the guard is off afterwards');
  assert.doesNotMatch(JSON.stringify(r), /picked-by-hand/);
  // Nobody clicks: nothing is sent, and the answer says what the user does on the next try.
  const none = signinRig({ fill: 'never' });
  const r2 = await none.h.local('signin', { tabId: 7 });
  assert.match(r2.error, /Ask the user to click the user name field on that tab during the next try, and pick their login from Chrome’s list\./);
  assert.equal(none.page.submitted, 0);
});

test('sign-in 1.4.4: the first click waits for Chrome’s debugging bar', () => {
  const src = BACKGROUND.replace(/\r/g, '');
  assert.match(src, /await sleep\(TIMING\.bar\);\n      const first = await inPage\(tabId, pageLogin, \['at', form\.user \? 'user' : 'pw'\]\);/);
  assert.match(src, /pick: 30_000, poll: 500, bar: 900, /, '30 s for the user’s click, inside the app’s 90 s');
});

test('sign-in 1.4.5: nothing is ever typed into the form; with an account named the keys stay off and the user picks', async () => {
  assert.doesNotMatch(BACKGROUND, /Input\.insertText/, 'no typing into a sign-in form');
  const saved = ['coen@example.com', 'bkenny@example.com'];
  // The model guessed "bkenny". Chrome fills nothing by itself; the user clicks bkenny@example.com in Chrome's list.
  const { h, page } = signinRig({ fill: 'never', saved });
  h.run('TIMING.pick = 5000; TIMING.poll = 5');
  setTimeout(() => { page.userEl.value = 'bkenny@example.com'; page.pw.value = 'pw'; }, 40);
  const r = await h.local('signin', { tabId: 7, account: 'bkenny' });
  assert.ok(r.ok, r.error);
  assert.equal(r.result.account, 'bkenny@example.com', 'the full address is the account asked for');
  assert.deepEqual(keysSent(h), [], 'no ArrowDown + Enter: they would take Chrome’s first row');
  assert.equal(page.submitted, 1);
  // The user picks another login than the one named: their pick stands, and the answer says which.
  const other = signinRig({ fill: 'never', saved });
  other.h.run('TIMING.pick = 5000; TIMING.poll = 5');
  setTimeout(() => { other.page.userEl.value = 'coen@example.com'; other.page.pw.value = 'pw'; }, 40);
  const r2 = await other.h.local('signin', { tabId: 7, account: 'bkenny' });
  assert.equal(r2.result.account, 'coen@example.com');
  assert.equal(other.page.submitted, 1);
});

test('sign-in 1.4.5: what Chrome filled by itself stays only when it is the account asked for', async () => {
  const saved = ['coen@example.com', 'bkenny@example.com'];
  // Chrome's own fill is the account asked for: straight on, by full address or by the part before "@".
  for (const account of ['coen@example.com', 'COEN']) {
    const { h, page } = signinRig({ fill: 'click', saved });
    const r = await h.local('signin', { tabId: 7, account });
    assert.equal(r.result?.account, 'coen@example.com', account);
    assert.deepEqual(mouseAt(h), [[60, 110], [60, 190]], 'the field, then Log in');
    assert.equal(page.submitted, 1);
  }
  // Chrome filled coen@, bkenny was asked for: both fields emptied, the field clicked again, and the user picks.
  const { h, page } = signinRig({ fill: 'click', saved });
  h.run('TIMING.pick = 5000; TIMING.poll = 5');
  let cleared = null;
  // The user picks once the field has been clicked the second time (the click that reopens Chrome's list). Tied to
  // that click, not to a clock: on a busy machine a timer could fire before the form was emptied, and the pick was lost.
  const onCdp = page.onCdp;
  let clicks = 0;
  page.onCdp = (method, p) => {
    onCdp(method, p);
    if (method === 'Input.dispatchMouseEvent' && p.type === 'mouseReleased' && p.y === 110 && ++clicks === 2) {
      setTimeout(() => { cleared = [page.userEl.value, page.pw.value]; page.userEl.value = 'bkenny@example.com'; page.pw.value = 'pw-b'; }, 0);
    }
  };
  const r = await h.local('signin', { tabId: 7, account: 'bkenny@example.com' });
  assert.deepEqual(cleared, ['', ''], 'the other account’s password never stays in the form');
  assert.equal(r.result.account, 'bkenny@example.com');
  assert.deepEqual(mouseAt(h), [[60, 110], [60, 110], [60, 190]], 'the field, the field again to open the list, then Log in');
  assert.equal(page.pw.value, 'pw-b');
  // Nobody picks: nothing is sent.
  const none = signinRig({ fill: 'click', saved });
  const r2 = await none.h.local('signin', { tabId: 7, account: 'bkenny@example.com' });
  assert.equal(r2.ok, false);
  assert.equal(none.page.submitted, 0);
  assert.equal(none.page.pw.value, '');
});

test('app 1.4.5: browser_signin’s account is the user’s own word, a sign-in step gets 90 s, and the card says to pick', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /account: \{ type: 'string', description: 'The saved user name or email the user asked for, in their own words\. Never guess one: leave it out, and the user picks from Chrome’s list\.' \}/);
  assert.match(app, /const MIN_EXT = '1\.4\.6';/);
  assert.match(app, /step\.name === 'browser_signin' \? 90000 : 60000/);
  assert.match(app, /If Chrome doesn’t fill it, click the user name field on that tab and pick your login\./);
});
