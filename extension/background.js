// Atelier Browser — service worker. Runs browser commands for Atelier: from the Atelier tab in this browser (through
// bridge.js) or from Atelier on another device (through the server relay).
// Every click and every typing action first waits for the user's own OK in a window this extension opens itself
// (confirm.html), whatever Atelier already approved, so a hijacked page or relay can never drive the browser silently.
// This worker also refuses to type into password or payment fields no matter what it is asked.

// The pages allowed to talk to this worker are exactly the ones bridge.js runs on. They are read from the manifest, so
// the production pack (which drops localhost from the content script) narrows this list too.
function originsOf(manifest) {
  const out = [];
  for (const cs of manifest.content_scripts || []) {
    for (const match of cs.matches || []) {
      const hit = /^(https?:\/\/[^/*]+)\/\*$/.exec(match);
      let origin = null;
      try { origin = hit && new URL(hit[1]).origin; } catch {}
      if (origin && !out.includes(origin)) out.push(origin);
    }
  }
  return out;
}
const ALLOWED_ORIGINS = originsOf(chrome.runtime.getManifest());
const MAX_TEXT = 40000;
const MAX_SHOWN_TEXT = 2000; // characters of the text to type shown in the confirmation
// confirm: how long a click/type request may wait, from its arrival to the user's answer. Atelier gives a command on
// this computer 60 s in all, so this leaves room for the action itself. settle: pause after a click or a submit so the
// page can react. read: the longest wait for a page to answer the extension (a page showing a dialog box never does).
const TIMING = { confirm: 45_000, settle: 1200, read: 10_000 };
// After a click or typing request is declined, closed or left unanswered, further ones from the same path (this
// browser's Atelier tab, or another device through the relay) are refused without a window for a while: 30 s, doubling
// with each refusal in a row (at most 10 min); an Allow resets it. A hijacked page can't keep stealing the focus.
const COOLDOWN = { first: 30_000, max: 600_000 };
const REFUSED_FIELD = 'Refused: Atelier never types into password, payment or ID fields. Ask the user to fill this in themselves.';
const NOT_RESPONDING = 'The page isn’t responding (it may be showing a dialog box), so nothing was done. Ask the user to close it, then try again.';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Settles like p, or rejects with message after ms (p's own late result is then ignored).
function withTimeout(p, ms, message) {
  let t;
  return Promise.race([p, new Promise((_, reject) => { t = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(t));
}

function waitForLoad(tabId, timeout = 20000) {
  return new Promise((resolve) => {
    const done = () => { chrome.tabs.onUpdated.removeListener(onUpd); clearTimeout(t); resolve(); };
    const onUpd = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    const t = setTimeout(done, timeout);
    chrome.tabs.onUpdated.addListener(onUpd);
    chrome.tabs.get(tabId).then((tab) => { if (tab.status === 'complete') done(); }).catch(done);
  });
}

async function inPage(tabId, func, args = []) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return res?.result;
}

function checkUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error('That is not a valid URL.'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) pages can be opened.');
  return u.href;
}

// A tab id and an element number from browser_elements (both whole numbers; the element goes into a selector).
function elementArgs({ tabId, element } = {}) {
  const tab = Number(tabId), el = Number(element);
  if (!Number.isInteger(tab) || tab < 0) throw new Error('tabId is required.');
  if (!Number.isInteger(el) || el < 0) throw new Error('element must be an element number from browser_elements.');
  return { tabId: tab, element: el };
}

// ── functions injected into pages ──
function pageExtract(maxText) {
  const main = document.querySelector('article, main, [role=main]');
  const root = main && main.innerText.trim().length > 500 ? main : document.body;
  const text = (root?.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
  const links = [...document.querySelectorAll('a[href]')]
    .map((a) => ({ text: a.innerText.trim().replace(/\s+/g, ' ').slice(0, 80), href: a.href }))
    .filter((l) => l.text && /^https?:/.test(l.href)).slice(0, 80);
  return { title: document.title, url: location.href, text: text.slice(0, maxText), truncated: text.length > maxText, links };
}

function pageElements() {
  const sel = 'a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], [role=tab], [contenteditable=true]';
  const out = [];
  let i = 0;
  document.querySelectorAll('[data-atelier-i]').forEach((el) => el.removeAttribute('data-atelier-i'));
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    if (r.width < 2 || r.height < 2 || st.visibility === 'hidden' || st.display === 'none' || el.disabled) continue;
    el.setAttribute('data-atelier-i', String(i));
    const type = (el.getAttribute('type') || el.getAttribute('role') || '').toLowerCase();
    const isButtonValue = el.tagName === 'INPUT' && /submit|button|reset/.test(type);
    const label = (el.getAttribute('aria-label') || (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' ? '' : el.innerText)
      || (isButtonValue ? el.value : '') || el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('title') || '')
      .trim().replace(/\s+/g, ' ').slice(0, 80);
    out.push({ element: i, tag: el.tagName.toLowerCase(), type, label, ...(el.href ? { href: el.href } : {}) });
    if (++i >= 150) break;
  }
  return out;
}

// Everything that touches one element: describe it, click it or type into it. One function, so the description shown
// in the confirmation and the check made just before acting can't drift apart.
// op 'describe' → {tag, type, label, href?, near?, sensitive, page, url} or null; 'click' / 'type' → a result or {error}.
// opts.token: 'describe' also marks the element with this request's own id, and 'click' / 'type' then find it by that
// mark instead of by its number, so the node acted on is the very node the user confirmed even if browser_elements
// numbers the page again in the meantime.
// opts.expect ({tag, type, label}, from the confirmation) makes the action refuse an element that has changed since.
function pageElement(i, op, opts = {}) {
  const byToken = op !== 'describe' && Boolean(opts.token);
  const el = document.querySelector(byToken ? `[data-atelier-c="${opts.token}"]` : `[data-atelier-i="${i}"]`);
  if (!el) return op === 'describe' ? null : { error: 'Element not found — call browser_elements again (the page may have changed).' };
  if (byToken) el.removeAttribute('data-atelier-c');
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') || '').toLowerCase();
  const field = tag === 'input' || tag === 'textarea' || tag === 'select';
  const buttonValue = tag === 'input' && /^(submit|button|reset)$/.test(type);
  const clean = (s, n) => String(s || '').trim().replace(/\s+/g, ' ').slice(0, n);
  // A field's current value is never used as its label: it could be a password.
  const label = clean(el.getAttribute('aria-label') || (field ? '' : el.innerText) || (buttonValue ? el.value : '')
    || el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('title'), 100);
  const hints = [el.getAttribute('autocomplete'), el.getAttribute('name'), el.id, el.getAttribute('placeholder'), el.getAttribute('aria-label')].join(' ').toLowerCase();
  const sensitive = type === 'password' || /cc-|card.?num|credit|cvc|cvv|security.?code|expir|iban|routing|ssn|social.?security/.test(hints);
  if (op === 'describe') {
    if (opts.token) {
      document.querySelectorAll('[data-atelier-c]').forEach((e) => e.removeAttribute('data-atelier-c'));
      el.setAttribute('data-atelier-c', opts.token);
    }
    // What tells same-label elements apart for the user: where a link goes, and the text of the row it sits in.
    const href = tag === 'a' && /^https?:/i.test(el.href || '') ? String(el.href).slice(0, 300) : '';
    let near = clean(el.parentElement?.closest('tr, li, [role=row], [role=listitem], article, form')?.innerText, 120);
    if (near === label) near = '';
    return { tag, type, label, ...(href ? { href } : {}), ...(near ? { near } : {}), sensitive, page: document.title, url: location.href };
  }

  const expect = opts.expect;
  if (expect && (expect.tag !== tag || expect.type !== type || expect.label !== label)) {
    return { error: 'The element changed after it was confirmed, so nothing was done. Call browser_elements again.' };
  }
  if (op === 'type' && sensitive) return { error: 'Refused: Atelier never types into password, payment or ID fields. Ask the user to fill this in themselves.' };
  el.scrollIntoView({ block: 'center' });
  if (op === 'click') {
    el.click();
    return { clicked: label.slice(0, 80) };
  }
  const text = String(opts.text ?? '');
  el.focus();
  if (el.isContentEditable) {
    document.execCommand('selectAll', false);
    document.execCommand('insertText', false, text);
  } else if (tag === 'select') {
    const opt = [...el.options].find((o) => o.text.trim().toLowerCase() === text.trim().toLowerCase() || o.value === text);
    if (!opt) return { error: `No option "${text}". Options: ${[...el.options].map((o) => o.text.trim()).join(', ').slice(0, 400)}` };
    el.value = opt.value;
  } else {
    const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  if (opts.submit) {
    if (el.form) el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit();
    else el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  }
  return { typed: true, submitted: Boolean(opts.submit) };
}

// ── confirmation: the user's own OK, on this computer, before any click or typing ──
// One request at a time. It opens confirm.html in a small popup window (chrome.windows needs no permission and no user
// gesture, unlike the action popup) and waits for Allow; Deny, closing the window and the time running out all refuse.
// The window talks to this worker over a port and pings it, which keeps this service worker awake while the user
// decides. It shows what this worker read from the page itself, never the requester's own description.
// After a refusal, the same path gets no new window until its cooldown ends (see COOLDOWN).
let asking = null; // the request on screen: { id, info, port, windowId, answer, timer }
// Per path: { until (no new window before this time), n (refusals in a row) }. Mirrored in chrome.storage.session
// (which content scripts can't reach) so a restart of this worker doesn't reset it.
let quiet = null;

async function cooldowns() {
  if (!quiet) {
    let saved = null;
    try { ({ cooldown: saved } = await chrome.storage.session.get('cooldown')); } catch {}
    const lane = (s) => ({ until: Number(s?.until) || 0, n: Number(s?.n) || 0 });
    quiet ??= { local: lane(saved?.local), remote: lane(saved?.remote) };
  }
  return quiet;
}

function noteAnswer(lane, result) {
  if (result === 'failed') return; // no window was shown, so the user refused nothing
  if (result === 'allow') lane.n = 0;
  else {
    if (Date.now() > lane.until + COOLDOWN.max) lane.n = 0; // the last refusal was long ago
    lane.until = Date.now() + Math.min(COOLDOWN.max, COOLDOWN.first * 2 ** lane.n++);
  }
  try { chrome.storage.session.set({ cooldown: quiet }).catch(() => {}); } catch {}
}

const confirmUrl = () => chrome.runtime.getURL('confirm.html');
const isConfirmPage = (sender) => sender?.id === chrome.runtime.id && String(sender.url || '').split(/[?#]/)[0] === confirmUrl();
const withoutHash = (url) => String(url || '').split('#')[0];

function refusal(action, answer) {
  const what = action === 'type' ? 'typing' : 'click';
  const nothing = action === 'type' ? 'nothing was typed' : 'nothing was clicked';
  if (answer === 'timeout') return `No one answered the Atelier Browser confirmation on the computer within ${Math.round(TIMING.confirm / 1000)} seconds, so ${nothing}.`;
  if (answer === 'failed') return `The Atelier Browser confirmation window couldn’t be shown, so ${nothing}.`;
  return `The user declined this ${what} in the Atelier Browser confirmation window, so ${nothing}.`;
}

// Over the window the user last used, inside it where it fits, and nudged a random few dozen pixels so a page can't
// work out where Allow will appear. (A popup must be mostly on screen, so fall back to Chrome's own placement.)
async function popupWindow(url) {
  const width = 460, height = 600;
  const base = { url, type: 'popup', focused: true, width, height };
  const nudge = () => (Math.random() * 2 - 1) * 60;
  const place = (start, room, share) => Math.round(start + Math.min(Math.max(0, room), Math.max(0, room * share + nudge())));
  try {
    const w = await chrome.windows.getLastFocused();
    if (w && w.state !== 'minimized' && [w.left, w.top, w.width, w.height].every(Number.isFinite)) {
      return await chrome.windows.create({ ...base, left: place(w.left, w.width - width, 1 / 2), top: place(w.top, w.height - height, 1 / 3) });
    }
  } catch {}
  return chrome.windows.create(base);
}

async function confirmFirst(action, { tabId, element, text, submit }, via) {
  const path = via === 'remote' ? 'remote' : 'local';
  const lane = (await cooldowns())[path];
  const wait = lane.until - Date.now();
  if (wait > 0) throw new Error(`A click or typing request on this computer was just declined or left unanswered, so Atelier Browser won’t ask again for ${Math.ceil(wait / 1000)} s and nothing was done. Check with the user before trying again.`);
  if (asking) throw new Error('Another click or typing request is still waiting for an answer on this computer. Try again once it is answered.');
  const req = asking = { id: crypto.randomUUID() };
  const expiresAt = Date.now() + TIMING.confirm;
  try {
    // Bounded: a page showing a dialog box never answers, and this request holds the one-at-a-time lock meanwhile.
    // A description that arrives too late is dropped, so no window ever opens for a request already given up on.
    const [tab, target] = await withTimeout(Promise.all([
      chrome.tabs.get(tabId),
      inPage(tabId, pageElement, [element, 'describe', { token: req.id }]),
    ]), TIMING.read, NOT_RESPONDING);
    if (!target) throw new Error('Element not found — call browser_elements again (the page may have changed).');
    if (action === 'type' && target.sensitive) throw new Error(REFUSED_FIELD);
    const typed = String(text ?? '');
    req.info = {
      action, via: path, submit: action === 'type' && Boolean(submit),
      element: { tag: target.tag, type: target.type, label: target.label, ...(target.href ? { href: target.href } : {}), ...(target.near ? { near: target.near } : {}) },
      page: { title: tab.title || target.page || '', url: tab.url || target.url || '' },
      ...(action === 'type' ? { text: typed.slice(0, MAX_SHOWN_TEXT), more: Math.max(0, typed.length - MAX_SHOWN_TEXT) } : {}),
      expiresAt,
    };
    const answer = new Promise((resolve) => { req.answer = resolve; });
    req.timer = setTimeout(() => req.answer('timeout'), Math.max(0, expiresAt - Date.now()));
    try {
      const win = await popupWindow(`${confirmUrl()}?id=${req.id}`);
      req.windowId = win?.id;
      if (win && !win.focused) chrome.windows.update(win.id, { drawAttention: true }).catch(() => {});
    } catch { req.answer('failed'); }
    const result = await answer;
    noteAnswer(lane, result);
    if (result !== 'allow') throw new Error(refusal(action, result));
    return { url: tab.url, expect: { tag: target.tag, type: target.type, label: target.label }, token: req.id };
  } finally {
    clearTimeout(req.timer);
    if (asking === req) asking = null;
    if (req.windowId != null) chrome.windows.remove(req.windowId).catch(() => {});
    try { req.port?.disconnect(); } catch {}
  }
}

// A page that stops answering while the action runs (a click that opens a dialog box, say) ends with this, instead of
// leaving Atelier to wait out its own time limit.
const stalled = (action) => `The page stopped responding while Atelier Browser was ${action === 'type' ? 'typing' : 'clicking'} (it may be showing a dialog box), so it isn’t known whether the ${action === 'type' ? 'text went in' : 'click went through'}. Ask the user to look at that tab.`;

// The page must still be the one the user confirmed (a navigation in the meantime cancels the action).
async function samePage(tabId, url) {
  const t = await chrome.tabs.get(tabId);
  if (withoutHash(t.url) !== withoutHash(url)) throw new Error('The page changed after it was confirmed, so nothing was done.');
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'atelier-confirm') return;
  if (!isConfirmPage(port.sender)) { try { port.disconnect(); } catch {} return; }
  port.onMessage.addListener((m) => {
    const req = asking;
    if (m?.hello) {
      if (!req?.info || m.id !== req.id || req.port) { port.postMessage({ gone: true }); return; }
      req.port = port;
      port.postMessage({ info: req.info });
      return;
    }
    if (!req || req.port !== port) return; // pings land here too: they only keep this worker awake
    if (m?.answer === 'allow' || m?.answer === 'deny') req.answer(m.answer);
  });
  port.onDisconnect.addListener(() => { if (asking?.port === port) asking.answer('closed'); });
});
chrome.windows.onRemoved.addListener((windowId) => { if (asking && asking.windowId === windowId) asking.answer('closed'); });

// ── commands ── (ctx.via: 'local' for the Atelier tab in this browser, 'remote' for the relay)
const COMMANDS = {
  async tabs() {
    const tabs = await chrome.tabs.query({});
    const own = chrome.runtime.getURL(''); // e.g. an open confirmation window
    return tabs.filter((t) => t.url && !t.url.startsWith(own) && !ALLOWED_ORIGINS.some((o) => t.url.startsWith(o)))
      .map((t) => ({ tabId: t.id, title: t.title, url: t.url, active: t.active }));
  },
  async open({ url, active = false }) {
    const tab = await chrome.tabs.create({ url: checkUrl(url), active: Boolean(active) });
    await waitForLoad(tab.id);
    const t = await chrome.tabs.get(tab.id);
    return { tabId: t.id, title: t.title, url: t.url };
  },
  async read({ tabId, url }) {
    let id = tabId;
    let opened = false;
    if (!id && url) {
      const tab = await chrome.tabs.create({ url: checkUrl(url), active: false });
      id = tab.id; opened = true;
      await waitForLoad(id);
      await sleep(800); // let client-rendered pages settle
    }
    if (!id) throw new Error('Pass a tabId or a url.');
    const page = await inPage(id, pageExtract, [MAX_TEXT]);
    if (opened) chrome.tabs.remove(id).catch(() => {});
    return { ...(opened ? {} : { tabId: id }), ...page };
  },
  async elements({ tabId }) {
    if (!tabId) throw new Error('tabId is required.');
    const t = await chrome.tabs.get(tabId);
    return { tabId, title: t.title, url: t.url, elements: await inPage(tabId, pageElements) };
  },
  async describe(args) {
    const { tabId, element } = elementArgs(args);
    return (await inPage(tabId, pageElement, [element, 'describe'])) || { error: 'Element not found' };
  },
  async click(args, ctx = {}) {
    const { tabId, element } = elementArgs(args);
    const ok = await confirmFirst('click', { tabId, element }, ctx.via);
    await samePage(tabId, ok.url);
    const res = await withTimeout(inPage(tabId, pageElement, [element, 'click', { expect: ok.expect, token: ok.token }]), TIMING.read, stalled('click'));
    if (res?.error) throw new Error(res.error);
    await sleep(TIMING.settle);
    await waitForLoad(tabId, 8000);
    const t = await chrome.tabs.get(tabId);
    return { ...res, now: { title: t.title, url: t.url } };
  },
  async type(args, ctx = {}) {
    const { tabId, element } = elementArgs(args);
    const text = String(args.text ?? ''), submit = Boolean(args.submit);
    const ok = await confirmFirst('type', { tabId, element, text, submit }, ctx.via);
    await samePage(tabId, ok.url);
    const res = await withTimeout(inPage(tabId, pageElement, [element, 'type', { expect: ok.expect, token: ok.token, text, submit }]), TIMING.read, stalled('type'));
    if (res?.error) throw new Error(res.error);
    if (submit) { await sleep(TIMING.settle); await waitForLoad(tabId, 8000); }
    const t = await chrome.tabs.get(tabId);
    return { ...res, now: { title: t.title, url: t.url } };
  },
  async show({ tabId }) {
    const t = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(t.windowId, { focused: true });
    return { shown: true };
  },
};

const friendly = (err) => (/Cannot access|chrome:\/\//.test(err.message) ? 'The browser doesn’t allow extensions on that page (e.g. chrome:// or the Web Store).' : err.message);

// ── Remote relay: a persistent connection to the Atelier server so Atelier on other devices
// (e.g. your phone) can use this browser while the computer is on. ──
let ws = null; // the current connection; a replaced one may still deliver its last events
let pingTimer = null;
let retry = 0;
let relayCalls = 0;

const isLive = (s) => Boolean(s) && (s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING);

// Several wake-ups can call this at once (on a cold start the top-level call and onStartup; an alarm; a re-pair). Only
// the newest call opens a socket, and each socket's handlers act on that socket alone, touching the shared state only
// while it is still the current one: a late close from a replaced socket can't knock out its successor.
async function connectRelay() {
  if (isLive(ws)) return;
  const call = ++relayCalls;
  const { relayToken, relayOrigin } = await chrome.storage.local.get(['relayToken', 'relayOrigin']);
  if (call !== relayCalls || isLive(ws)) return; // a newer call is on it, or a socket opened meanwhile
  if (!relayToken || !relayOrigin) return; // not paired yet — open Atelier on this computer once
  if (!ALLOWED_ORIGINS.includes(relayOrigin)) return; // paired by a build that allowed more origins (e.g. a dev pack)
  // The token travels as a WebSocket subprotocol, never in the URL (so it can't leak into logs).
  const url = `${relayOrigin.replace(/^http/, 'ws')}/api/relay/ws`;
  let sock;
  try { sock = new WebSocket(url, ['atelier', relayToken]); } catch { return scheduleReconnect(); }
  ws = sock;
  sock.onopen = () => {
    if (ws !== sock) { try { sock.close(); } catch {} return; } // replaced before it opened
    retry = 0;
    clearInterval(pingTimer);
    // Regular traffic also keeps this service worker alive while connected.
    pingTimer = setInterval(() => { try { sock.send('ping'); } catch {} }, 20000);
  };
  sock.onmessage = async (ev) => {
    if (ev.data === 'pong') return;
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    const fn = REMOTE_COMMANDS.includes(msg?.cmd) && COMMANDS[msg.cmd];
    let reply;
    try { reply = fn ? { ok: true, result: await fn(msg.args || {}, { via: 'remote' }) } : { ok: false, error: `Unknown command ${msg?.cmd}` }; }
    catch (err) { reply = { ok: false, error: friendly(err) }; }
    // The relay matches a reply to its command by id on any connection, so answer on whichever one is open now.
    const out = ws?.readyState === WebSocket.OPEN ? ws : sock;
    try { out.send(JSON.stringify({ id: msg.id, ...reply })); } catch {}
  };
  sock.onclose = (ev) => {
    if (ws !== sock) return; // an old connection, already replaced
    clearInterval(pingTimer);
    ws = null;
    if (ev.code === 4000 || ev.code === 4001) return; // replaced by a newer connection / re-paired
    scheduleReconnect();
  };
  sock.onerror = () => { try { sock.close(); } catch {} };
}
function scheduleReconnect() {
  retry = Math.min(retry + 1, 6);
  setTimeout(connectRelay, 1000 * 2 ** retry); // 2s … 64s
}
// Commands the server may send (pairing/status are local-only).
const REMOTE_COMMANDS = ['tabs', 'read', 'open', 'elements', 'describe', 'click', 'type', 'show'];

// Local-only: pairing handed over by the Atelier page on this computer.
COMMANDS.pair = async ({ token, origin }) => {
  if (!/^[a-f0-9]{64}$/.test(token || '') || !ALLOWED_ORIGINS.includes(origin)) throw new Error('Invalid pairing data.');
  await chrome.storage.local.set({ relayToken: token, relayOrigin: origin });
  const old = ws;
  ws = null; // first, so the old socket's close (which comes later) finds itself replaced
  clearInterval(pingTimer);
  try { old?.close(4000, 'repair'); } catch {}
  connectRelay();
  return { paired: true };
};
COMMANDS.status = async () => {
  const { relayToken, relayOrigin } = await chrome.storage.local.get(['relayToken', 'relayOrigin']);
  return { paired: Boolean(relayToken), origin: relayOrigin || null, connected: ws?.readyState === WebSocket.OPEN };
};

// Reconnect whenever the service worker wakes: browser start, install/update, and a 1-minute alarm.
chrome.runtime.onStartup.addListener(connectRelay);
chrome.runtime.onInstalled.addListener(connectRelay);
chrome.alarms.create('atelier-relay', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'atelier-relay') connectRelay(); });
connectRelay();

// Same-page path: the Atelier tab in this browser, through bridge.js. Click and type are confirmed here too, so a
// script injected into the Atelier page can't use the extension without the user seeing it.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const origin = sender.origin || (sender.url && new URL(sender.url).origin);
  if (sender.id !== chrome.runtime.id || !ALLOWED_ORIGINS.includes(origin)) return false;
  if (msg?.cmd === 'pair') msg.args = { ...(msg.args || {}), origin };
  const fn = Object.hasOwn(COMMANDS, msg?.cmd) && COMMANDS[msg.cmd];
  if (!fn) { sendResponse({ ok: false, error: `Unknown command ${msg?.cmd}` }); return false; }
  fn(msg.args || {}, { via: 'local' })
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: friendly(err) }));
  return true; // async response
});
