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
function fakeEl({ tag = 'BUTTON', attrs = {}, text = '', value = '', row } = {}) {
  const el = {
    tagName: tag, innerText: text, value, id: attrs.id || '', attrs: { ...attrs }, isContentEditable: false, form: null,
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
function fakePage({ title = 'Settings · acme/site', url = 'https://github.com/acme/site/settings', elements = {} } = {}) {
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
    execCommand() {},
  };
  return page;
}

// ── background.js in a VM with just enough of chrome.* ──
function loadBackground({ manifest = SOURCE_MANIFEST, pages = {}, storage = {}, session = {}, windowsCreate } = {}) {
  const on = () => { const fns = []; return { fns, addListener: (f) => fns.push(f), removeListener: (f) => { const i = fns.indexOf(f); if (i >= 0) fns.splice(i, 1); } }; };
  const h = {
    events: { message: on(), connect: on(), removed: on(), startup: on(), installed: on(), alarm: on(), updated: on() },
    windows: [], removedWindows: [], injected: [], sockets: [], storage: { ...storage }, session: structuredClone(session), pages,
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
      update: async (id) => tab(id), remove: async () => {},
      onUpdated: h.events.updated,
    },
    scripting: {
      executeScript: async ({ target, func, args }) => {
        h.injected.push({ tabId: target.tabId, func: func.name, args });
        const page = pages[target.tabId];
        if (page.hold) await page.hold; // a page that isn't answering (e.g. showing a dialog box)
        ctx.document = page.document;
        ctx.location = { href: page.url };
        return [{ result: func(...args) }];
      },
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
  // The Atelier tab in this browser, through bridge.js (the page only controls cmd and args). Replies are cloned out
  // of the VM, as Chrome's messaging would, so they compare like ordinary objects.
  h.local = (cmd, args, origin = APP) => new Promise((resolve) => {
    const keep = h.events.message.fns[0]({ cmd, args }, { id: EXT_ID, origin, url: `${origin}/`, tab: { id: 1 } }, (r) => resolve(structuredClone(r)));
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
test('manifest: version 1.3.1, a description Chrome accepts, and a Chrome new enough for the worker keep-alives', () => {
  assert.equal(SOURCE_MANIFEST.version, '1.3.1');
  assert.ok(SOURCE_MANIFEST.description.length <= 132);
  assert.ok(Number(SOURCE_MANIFEST.minimum_chrome_version) >= 116);
});

test('isLocalPattern spots local development hosts only', () => {
  for (const p of ['http://localhost:8787/*', 'http://127.0.0.1/*', 'http://[::1]:8787/*', 'http://app.localhost/*']) assert.ok(isLocalPattern(p), p);
  for (const p of ['https://atelier.ciprari.ai/*', '<all_urls>', 'https://localhost.example.com/*']) assert.ok(!isLocalPattern(p), p);
});

test('the production pack drops localhost everywhere; the dev pack keeps it; both carry the confirmation page', () => {
  const prod = packExtension();
  const files = unzipSync(prod.zip);
  const manifest = JSON.parse(strFromU8(files['manifest.json']));
  assert.equal(manifest.version, '1.3.1');
  assert.deepEqual(manifest.content_scripts.map((c) => c.matches), [['https://atelier.ciprari.ai/*']]);
  assert.deepEqual(manifest.host_permissions, ['<all_urls>']);
  assert.ok(!/localhost|127\.0\.0\.1/.test(strFromU8(files['manifest.json'])));
  for (const f of ['background.js', 'bridge.js', 'confirm.html', 'confirm.js', 'icons/icon-128.png']) assert.ok(files[f], f);
  assert.equal(strFromU8(files['background.js']), BACKGROUND);

  const dev = packExtension({ dev: true });
  assert.deepEqual(dev.manifest.content_scripts[0].matches, ['https://atelier.ciprari.ai/*', 'http://localhost:8787/*']);
  assert.equal(dev.manifest.version, '1.3.1');
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
