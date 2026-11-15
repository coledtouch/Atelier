// Atelier Browser — service worker. Runs browser commands for Atelier: from the Atelier tab in this browser (through
// bridge.js) or from Atelier on another device (through the server relay).
// Every click and every typing action first waits for the user's own OK in a window this extension opens itself
// (confirm.html), whatever Atelier already approved, so a hijacked page or relay can never drive the browser silently.
// Since 1.3.4 that window has "Don't ask again on this computer": ticked with an Allow, later clicks and typing here run
// without the window (storage.local noAsk), and since 1.4.0 so do saved-password sign-ins and texts (the window's own
// wording says so since 1.4.1). Only that window can turn it on (no page and no relay command can); the
// Atelier tab on this computer can turn asking back on (askAgain). Password and payment fields are refused either way.
// Opening a page, and reading one by its address, run only with Atelier's own approval flag (the owner OK'd that step in
// the app): the address the model chose loads signed in as the user, so it could carry data out. The server's relay
// checks the same flag first (src/relay.js relayNeedsApproval); this is the last check.
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
// helper: the longest wait for the Messages helper on a Mac. A text can so take confirm + helper, 75 s: more than
// those 60 s, so Atelier has to give a text 90 s, as the relay gives every command (v114). render: the pause that
// lets a page loaded for a read draw itself.
// front: the pause after a sign-in tab comes forward. pick: how long a sign-in waits for the user to click their login in
// Chrome's list when the keys didn't pick it, looking every poll (1.4.3, v120).
// li: the pause that lets a LinkedIn page draw its posts after it loads (1.4.9, v140).
const TIMING = { confirm: 45_000, settle: 1200, read: 10_000, fill: 700, helper: 30_000, render: 800, front: 400, pick: 30_000, poll: 500, bar: 900, gm: 8000, wake: 20_000, li: 2500 };
// After a click or typing request is declined, closed or left unanswered, further ones from the same path (this
// browser's Atelier tab, or another device through the relay) are refused without a window for a while: 30 s, doubling
// with each refusal in a row (at most 10 min); an Allow resets it. A hijacked page can't keep stealing the focus.
const COOLDOWN = { first: 30_000, max: 600_000 };
const REFUSED_FIELD = 'Refused: Atelier never types into password, payment or ID fields. Ask the user to fill this in themselves.';
const NOT_RESPONDING = 'The page isn’t responding (it may be showing a dialog box), so nothing was done. Ask the user to close it, then try again.';
const NEEDS_APPROVAL = 'Opening a page or reading one by its address needs the user’s approval in Atelier first, so nothing was loaded.';
const NO_ANSWER = 'That page didn’t answer in time, so nothing was read. It may be slow, or showing a dialog box.';

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
  // Sensitive: a password, payment, sign-in code or ID-number field (REFUSED_FIELD). Read from every name the page gives
  // the field: its attributes, and the text of its <label>s and aria-labelledby, so a field named only by a
  // <label for> ("Social Security Number", name=field3) counts. A password a show-password toggle turned into type=text
  // still counts by its autocomplete (current-password / new-password) or its masking (-webkit-text-security). Short
  // words that are common in ordinary text (pin, pwd, acct, otp, tin, ein, itin, exp_month) count only in the field's
  // own identifiers (autocomplete, name, id), never in its label or placeholder ("Geben Sie ein Stichwort ein").
  // A name or id is split at its case changes first (otpCode, cardPin, userPIN, SSNNumber → "otp code", "card pin",
  // "user pin", "ssn number"), so a short word there counts as a word; "ssn" counts only as a word anywhere
  // (businessName, className are ordinary fields). (v89 review, pipeline-ext-sensitive-field-gaps; v91 review. This runs
  // inside the page, so it uses nothing from outside.)
  const auto = String(el.getAttribute('autocomplete') || '').toLowerCase();
  const words = (v) => String(v || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  const labelText = [...(el.labels || [])].map((l) => l?.innerText || '')
    .concat(String(el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map((id) => document.getElementById?.(id)?.innerText || ''));
  const ids = [auto, words(el.getAttribute('name')), words(el.id)].join(' ').toLowerCase();
  const hints = [ids, el.getAttribute('placeholder'), el.getAttribute('aria-label'), el.getAttribute('title'), ...labelText].join(' ').toLowerCase();
  let masked = false;
  try { masked = typeof getComputedStyle === 'function' && !/^(none|)$/.test(String(getComputedStyle(el).webkitTextSecurity || '')); } catch { /* no style */ }
  const sensitive = type === 'password' || masked
    || /(^|\s)(current-password|new-password|one-time-code|cc-[a-z-]+)(\s|$)/.test(auto)
    || /pass(word|wd|code|phrase)|cc-|card.?(num|no\b)|credit|cvc|cvv|security.?code|expir|iban|routing|account.?(num|no\b|#)|(?<![a-z])ssn(?![a-z])|social.?security|tax.?(id|payer)|passport|driv.{0,6}licen[cs]e|national.?(id|insurance)|one.?time.?(code|pass)|verification.?code|sort.?code/.test(hints)
    || /(?<![a-z])(pin|pwd|acct|otp|tin|ein|itin|cvn|exp.?(month|year|date|mm|yy))(?![a-z])/.test(ids);
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
  const what = action === 'type' ? 'typing' : action === 'signin' ? 'sign-in' : action === 'sms' ? 'text message' : action === 'linkedin' ? 'LinkedIn action' : 'click';
  const nothing = action === 'type' ? 'nothing was typed' : action === 'signin' ? 'nothing was signed in' : action === 'sms' ? 'nothing was sent' : action === 'linkedin' ? 'nothing was done on LinkedIn' : 'nothing was clicked';
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

// true once the user ticked "Don't ask again on this computer" in the confirmation window.
async function asksNothing() {
  try { return (await chrome.storage.local.get(['noAsk'])).noAsk === true; } catch { return false; }
}
// What the window shows: the element read from the page, for a text message (sms) who it goes to, and for LinkedIn
// (1.4.9) what is done to whose post (to) on which page (url).
function looksAt(action, { tabId, element, to, url, op }, token) {
  if (action === 'sms') return Promise.resolve([{ url: '', title: 'Messages' }, { tag: 'message', type: '', label: String(to || '').slice(0, 200) }]);
  if (action === 'linkedin') return Promise.resolve([{ url: String(url || ''), title: 'LinkedIn' }, { tag: 'linkedin', type: String(op || ''), label: String(to || '').slice(0, 200) }]);
  return withTimeout(Promise.all([
    chrome.tabs.get(tabId),
    inPage(tabId, pageElement, [element, 'describe', { token }]),
  ]), TIMING.read, NOT_RESPONDING);
}
async function confirmFirst(action, { tabId, element, text, submit, to, url, op }, via) {
  const path = via === 'remote' ? 'remote' : 'local';
  // The user's standing OK on this computer: no window, no cooldown. The element is still found and marked, the page
  // is still checked again before the action, and a password or payment field is still refused.
  if (await asksNothing()) {
    const token = crypto.randomUUID();
    const [tab, target] = await looksAt(action, { tabId, element, to, url, op }, token);
    if (!target) throw new Error('Element not found — call browser_elements again (the page may have changed).');
    if (action === 'type' && target.sensitive) throw new Error(REFUSED_FIELD);
    return { url: tab.url, expect: { tag: target.tag, type: target.type, label: target.label }, token };
  }
  const lane = (await cooldowns())[path];
  const wait = lane.until - Date.now();
  if (wait > 0) throw new Error(`A click or typing request on this computer was just declined or left unanswered, so Atelier Browser won’t ask again for ${Math.ceil(wait / 1000)} s and nothing was done. Check with the user before trying again.`);
  if (asking) throw new Error('Another click or typing request is still waiting for an answer on this computer. Try again once it is answered.');
  const req = asking = { id: crypto.randomUUID() };
  const expiresAt = Date.now() + TIMING.confirm;
  try {
    // Bounded: a page showing a dialog box never answers, and this request holds the one-at-a-time lock meanwhile.
    // A description that arrives too late is dropped, so no window ever opens for a request already given up on.
    const [tab, target] = await looksAt(action, { tabId, element, to, url, op }, req.id);
    if (!target) throw new Error('Element not found — call browser_elements again (the page may have changed).');
    if (action === 'type' && target.sensitive) throw new Error(REFUSED_FIELD);
    const typed = String(text ?? '');
    req.info = {
      action, via: path, submit: action === 'type' && Boolean(submit),
      element: { tag: target.tag, type: target.type, label: target.label, ...(target.href ? { href: target.href } : {}), ...(target.near ? { near: target.near } : {}) },
      page: { title: tab.title || target.page || '', url: tab.url || target.url || '' },
      ...(action === 'type' || action === 'sms' || action === 'linkedin' ? { text: typed.slice(0, MAX_SHOWN_TEXT), more: Math.max(0, typed.length - MAX_SHOWN_TEXT) } : {}),
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
    if (m?.answer !== 'allow' && m?.answer !== 'deny') return;
    // "Don't ask again on this computer", ticked beside an Allow in this extension's own window: the only way it turns on.
    if (m.answer === 'allow' && m.always === true) { try { chrome.storage.local.set({ noAsk: true }).catch(() => {}); } catch {} }
    req.answer(m.answer);
  });
  port.onDisconnect.addListener(() => { if (asking?.port === port) asking.answer('closed'); });
});
chrome.windows.onRemoved.addListener((windowId) => { if (asking && asking.windowId === windowId) asking.answer('closed'); });

// ── sign in with the password Chrome already saved (1.4.0) ──
// Atelier never sees, types or reads a password. The extension makes real clicks through chrome.debugger (Chrome shows
// its "started debugging" bar meanwhile), so Chrome's own password manager fills the form it already knows. Chrome only
// offers a saved password on the site it was saved for, so a look-alike page gets nothing. The page script reports
// whether the password field is filled, never what is in it. If nothing fills, nothing is submitted.
// Since 1.4.1 (v114) it also reports whether that field is still on the page afterwards, so a form that never went
// anywhere is not called submitted.
const NO_LOGIN_FORM = 'No sign-in form with a password field on that tab. Open the sign-in page first.';
const NO_SAVED = 'Chrome didn’t fill a saved password on this page, so nothing was submitted. Ask the user to click the user name field on that tab during the next try, and pick their login from Chrome’s list. If Chrome lists none, ask the user to sign in, or to save the password in Chrome first.';
const NO_SIGNIN_BUTTON = 'Atelier Browser couldn’t tell which button signs in on that page, so nothing was submitted. Ask the user to sign in.';
const SIGNIN_UNKNOWN = 'The tab stopped answering while the sign-in form was being sent. It isn’t known whether it went through. Look at that tab before trying again.';
const FILLED = 'Chrome filled the password it had saved. Atelier never saw it.';
function pageLogin(op, which) {
  const q = (k) => document.querySelector(`[data-atelier-login="${k}"]`);
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  if (op === 'find') {
    document.querySelectorAll('[data-atelier-login]').forEach((e) => e.removeAttribute('data-atelier-login'));
    const inputs = [...document.querySelectorAll('input')].filter(shown);
    const kind = (el) => String(el.getAttribute('type') || '').toLowerCase();
    const pw = inputs.find((el) => kind(el) === 'password' && !/new-password/i.test(el.getAttribute('autocomplete') || ''));
    if (!pw) return { error: 'none' };
    const scope = pw.form ? inputs.filter((el) => el.form === pw.form) : inputs;
    const user = scope.slice(0, scope.indexOf(pw)).filter((el) => /^(text|email|tel|)$/.test(kind(el))).at(-1) || null;
    const buttons = [...(pw.form || document).querySelectorAll('button, input[type=submit]')];
    const words = (b) => String(b.innerText || b.value || b.getAttribute('aria-label') || '');
    // Which button to click (1.4.1, v114). It was the form's first button that submits, and a <button> with no type
    // does: a show-password eye, "Forgot password?" or "Continue with Google" placed before the real one got the click.
    // Now, in this order: a button of this form marked type=submit; a button whose words say sign in; the form's first
    // button with no type (one with words before a bare icon, which is what an unnamed eye is). Never a button of
    // those three kinds (other), and "Sign in" before "Sign in with …". A provider's name counts only away from its
    // own site: on github.com "Sign in to GitHub" is the sign-in button.
    let host = '';
    try { host = new URL(location.href).hostname.toLowerCase(); } catch { /* no address */ }
    const all = (b) => [b.innerText, b.value, b.getAttribute('aria-label'), b.getAttribute('title')].join(' ');
    const other = (b) => {
      const brand = /\b(google|apple|facebook|microsoft|github)\b/i.exec(all(b))?.[1].toLowerCase();
      return /\b(show|hide|toggle|forg[eo]t(ten)?|reset)\b|visibility/i.test(all(b)) || Boolean(brand && !host.includes(brand));
    };
    const mine = (b) => Boolean(pw.form) && b.form === pw.form;
    const named = (list) => { const hit = list.filter((b) => /sign.?in|log.?in|continue|submit/i.test(words(b))); return hit.find((b) => !/\bwith\b/i.test(words(b))) || hit[0]; };
    const ok = buttons.filter((b) => shown(b) && !other(b));
    const explicit = ok.filter((b) => mine(b) && kind(b) === 'submit'), typeless = ok.filter((b) => mine(b) && kind(b) === '');
    const submit = named(explicit) || explicit[0] || named(ok) || typeless.find((b) => /\p{L}/u.test(all(b))) || typeless[0] || null;
    // With no button to click, Enter in the password field sends the form through its default button: the first one in
    // it that submits, shown or not. When that is a button of the three kinds above, Enter would press it too.
    const first = buttons.find((b) => mine(b) && /^(submit|)$/.test(kind(b)) && !b.disabled);
    const enter = !(first && other(first));
    if (!submit && !enter) return { error: 'button' };
    pw.setAttribute('data-atelier-login', 'pw');
    pw.setAttribute('data-atelier-i', 'signin'); // the confirmation describes this field
    if (user) user.setAttribute('data-atelier-login', 'user');
    if (submit) submit.setAttribute('data-atelier-login', 'submit');
    return { user: Boolean(user), submit: Boolean(submit), enter };
  }
  if (op === 'at') {
    const el = q(which);
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null;
  }
  if (op === 'filled') return { filled: String(q('pw')?.value || '').length > 0 };
  // The user name the form holds (never the password): which saved account Chrome filled (1.4.2, v119).
  if (op === 'who') return { who: String(q('user')?.value || '') };
  // Both fields emptied, the user name field focused: typing the account then makes Chrome list only its logins.
  if (op === 'clear') {
    for (const k of ['user', 'pw']) { const el = q(k); if (el) { el.value = ''; el.dispatchEvent?.(new Event('input', { bubbles: true })); } }
    q('user')?.focus();
    return true;
  }
  // After the click or the Enter: is that same password field still showing? A page that moved on has lost the mark.
  if (op === 'after') { const el = q('pw'); return { still: Boolean(el) && shown(el) }; }
  // While the extension picks from Chrome's own list, an Enter that reaches the page (no list showing) must not send
  // the form with an empty password. Chrome's list takes its Enter before the page ever sees it.
  if (op === 'guard' || op === 'unguard') {
    const KEY = '__atelierLoginGuard';
    if (op === 'guard' && !window[KEY]) {
      window[KEY] = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); ev.stopImmediatePropagation(); } };
      window.addEventListener('keydown', window[KEY], true);
    }
    if (op === 'unguard' && window[KEY]) { window.removeEventListener('keydown', window[KEY], true); window[KEY] = null; }
    return true;
  }
  if (op === 'focusPw') { q('pw')?.focus(); return true; }
  return null;
}

// ── Messages on a Mac (1.4.0) ──
// The Atelier Messages helper (public/mac/atelier-messages-host.js, set up by public/mac/install-messages.sh) is a
// native-messaging host: it reads ~/Library/Messages/chat.db read-only and sends through Messages.app. Reading
// needs nothing more than any read here; sending needs the owner's OK in Atelier and asks in this window like a click.
const MESSAGES_HOST = 'ai.ciprari.atelier.messages';
const NO_MESSAGES = 'Messages isn’t set up on this computer. On the Mac, open Atelier Settings → Connections → Set up Messages.';
const SEND_NEEDS_APPROVAL = 'Sending a text needs the user’s approval in Atelier first, so nothing was sent.';
const MAX_SMS = 2000;
const clampInt = (v, lo, hi, dflt) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };
// A send that ends without the helper's own answer may have gone out, or may yet: the helper keeps running after this
// wait is over (the first send ever sits on macOS's "Chrome wants to control Messages" prompt until the user answers),
// and a helper that died may have sent first. Both used to read as a plain failure, and a retry then sent the text
// twice. They now say the outcome isn't known (1.4.1, v114). A helper that never started sent nothing.
const SEND_UNKNOWN = 'The Messages helper didn’t answer in time, so it isn’t known whether the text was sent. Check Messages before trying again.';
const SEND_LOST = 'The Messages helper stopped before it answered, so it isn’t known whether the text was sent. Check Messages before trying again.';
async function messagesHost(msg) {
  const sending = msg?.op === 'send';
  let r;
  try {
    r = await withTimeout(chrome.runtime.sendNativeMessage(MESSAGES_HOST, msg), TIMING.helper, sending ? SEND_UNKNOWN : 'The Messages helper on this computer didn’t answer.');
  } catch (err) {
    const m = err?.message || '';
    if (/not found|forbidden|not allowed|failed to start|invalid native messaging host/i.test(m)) throw new Error(NO_MESSAGES); // it never ran
    if (sending) throw new Error(m === SEND_UNKNOWN ? SEND_UNKNOWN : SEND_LOST);
    if (/native messaging host/i.test(m)) throw new Error(NO_MESSAGES);
    throw err;
  }
  if (!r || r.ok !== true) throw new Error(String(r?.error || 'The Messages helper failed.').slice(0, 400));
  return r.result;
}

// ── Personal texts through Google Messages for web (1.4.6, v131) ──
// The owner's personal Android phone has no helper like the Mac's. Google Messages pairs a phone with a browser tab
// (messages.google.com/web), and that page marks its parts with data-e2e-* names: the conversation list, each message,
// the box to type in and the send button. This reads and sends through that tab, in the browser where it is paired.
// Reading a conversation opens it there, which marks it read on the phone too. A send asks like a text from the Mac.
const GM_URL = 'https://messages.google.com/web/*';
const GM_NOT_OPEN = 'Google Messages isn’t open in this browser. Open messages.google.com/web here and pair the phone.';
const GM_NOT_PAIRED = 'Google Messages isn’t paired in this browser. Open messages.google.com/web here and pair the phone.';
const GM_NO_CHAT = 'No Google Messages conversation matches that. Use a chat id or name from personal_texts_recent.';
const GM_NOT_SENT = 'Google Messages didn’t take the text, so it isn’t known whether it was sent. Look at that tab before trying again.';
function pageGMessages(op, arg = {}) {
  const clean = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const rows = () => [...document.querySelectorAll('a[data-e2e-conversation]')];
  const idOf = (a) => String(a.getAttribute('href') || '').split('/').pop();
  const nameOf = (a) => clean(a.querySelector('[data-e2e-conversation-name]')?.innerText, 80);
  if (op === 'state') return { paired: !/\/web\/(welcome|authentication)/.test(location.pathname), list: rows().length };
  if (op === 'recent') {
    return rows().slice(0, arg.limit).map((a) => ({
      chat: idOf(a), name: nameOf(a), last: clean(a.querySelector('[data-e2e-conversation-snippet]')?.innerText, 200),
      at: clean(a.querySelector('mws-relative-timestamp')?.innerText, 40), unread: a.getAttribute('data-e2e-is-unread') === 'true',
    }));
  }
  // The conversation asked for: by its id, its exact name, a phone number (last 10 digits), then a part of its name.
  if (op === 'open') {
    const want = clean(arg.chat, 200), low = want.toLowerCase(), digits = want.replace(/\D/g, '');
    const all = rows();
    const hit = all.find((a) => idOf(a) === want) || all.find((a) => nameOf(a).toLowerCase() === low)
      || (digits.length >= 7 && !/[a-z]/i.test(want) ? all.find((a) => nameOf(a).replace(/\D/g, '').endsWith(digits.slice(-10))) : null)
      || (low.length >= 3 ? all.find((a) => nameOf(a).toLowerCase().includes(low)) : null);
    if (!hit) return { error: 'none' };
    hit.click();
    return { chat: idOf(hit), name: nameOf(hit) };
  }
  if (op === 'messages') {
    const here = String(location.pathname).split('/').pop();
    if (here !== arg.chat) return { ready: false };
    const list = [...document.querySelectorAll('mws-message-wrapper')];
    if (!list.length) return { ready: false };
    const name = clean(document.querySelector('[data-e2e-header-title]')?.innerText, 80);
    return {
      ready: true, name,
      messages: list.slice(-arg.limit).map((w) => {
        const said = String(w.querySelector('mws-text-message-part')?.getAttribute('aria-label') || '');
        const when = /\b(?:Sent|Received) on (.+?)\.(?: |$)/.exec(said)?.[1] || '';
        const text = clean(w.querySelector('[data-e2e-text-message-content]')?.innerText, 2000) || (w.querySelector('[data-e2e-message-image], mws-image-message-part') ? '(image)' : '(attachment)');
        return { from: w.getAttribute('is-outgoing') === 'true' ? 'me' : name || 'them', at: clean(when, 60), text };
      }),
    };
  }
  if (op === 'outgoing') return { n: document.querySelectorAll('mws-message-wrapper[is-outgoing="true"]').length, here: String(location.pathname).split('/').pop() };
  if (op === 'type') {
    const box = document.querySelector('[data-e2e-message-input-box]');
    if (!box) return { error: 'box' };
    if (clean(box.innerText, 10)) return { error: 'draft' }; // a draft the user left there is never sent along
    box.focus();
    document.execCommand('insertText', false, String(arg.text));
    return { typed: clean(box.innerText, 4000) === clean(arg.text, 4000) };
  }
  if (op === 'send') {
    const btn = document.querySelector('[data-e2e-send-text-button]');
    if (!btn || btn.disabled) return { error: 'button' };
    btn.click();
    return { clicked: true };
  }
  return null;
}
async function gmTab() {
  const tabs = await chrome.tabs.query({ url: GM_URL });
  const tab = tabs.find((t) => /\/web\/conversations/.test(t.url || '')) || tabs[0];
  if (!tab) throw new Error(GM_NOT_OPEN);
  // Chrome can't pass undefined into a page ("Value is unserializable"), so an op without a value sends {}.
  const page = (op, arg = {}) => withTimeout(inPage(tab.id, pageGMessages, [op, arg]), TIMING.read, NOT_RESPONDING);
  // Chrome's Memory Saver discards an idle tab, and a discarded or frozen tab runs no script (1.4.8). Keep this one
  // from being discarded again, and wake it with a reload when it doesn't answer.
  chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  let st = tab.discarded ? null : await page('state').catch(() => null);
  if (!st) st = await gmWake(tab.id, page);
  if (!st?.paired) throw new Error(GM_NOT_PAIRED);
  return { tab, page };
}
// Reloads the Google Messages tab and waits until its conversation list shows (or it says it isn't paired).
async function gmWake(tabId, page) {
  await chrome.tabs.reload(tabId);
  await waitForLoad(tabId, TIMING.wake);
  let st = null;
  for (let waited = 0; waited < TIMING.wake; waited += TIMING.poll) {
    st = await page('state').catch(() => null);
    if (st && (!st.paired || st.list > 0)) return st;
    await sleep(TIMING.poll);
  }
  return st; // paired with no conversations yet, or still not answering
}
// Opens a conversation in that tab and waits for its messages to show.
async function gmOpen(page, chat, limit) {
  const hit = await page('open', { chat });
  if (!hit || hit.error) throw new Error(GM_NO_CHAT);
  for (let waited = 0; waited < TIMING.gm; waited += TIMING.poll) {
    const got = await page('messages', { chat: hit.chat, limit });
    if (got?.ready) return { ...hit, name: got.name || hit.name, messages: got.messages };
    await sleep(TIMING.poll);
  }
  return { ...hit, messages: [] }; // a conversation with nothing in it yet, or one slow to load
}

// ── LinkedIn in this browser, signed in as the owner (1.4.9, v140) ──
// Reads posts, notifications and the owner's own activity, and likes, comments, replies or posts once he says so. It
// works on LinkedIn's own pages in one background tab, never through LinkedIn's private API, and only on pages this
// worker builds from a short list (liPage): a model can't send that tab anywhere else. LinkedIn's class names are
// scrambled, so the page is read by its labels: "Open control menu for post by …", "Reaction button state: …",
// "View more options for …’s comment." and the comment editor's role=textbox.
// LinkedIn's terms forbid automated likes and comments, so every write here needs Atelier's approval flag (the owner
// tapped it) and this window's OK, and runs under limits a page or the relay can't lift: a daily cap per kind, a human
// pause since the last write, no second comment on a post already commented on, and a 24-hour stop the moment LinkedIn
// shows a warning, a check or a restriction.
const LI = 'https://www.linkedin.com';
const LI_LIMITS = { like: 40, comment: 15, post: 2 }; // per day; a reply counts as a comment
const LI_GAP = { like: [6000, 12000], comment: [15000, 30000], post: [30000, 60000] }; // ms since the last write of that kind
const LI_MAX_WAIT = 30_000; // a longer pause still to go is refused rather than waited out (the relay gives a command 90 s)
const LI_PAUSE = 24 * 3600_000;
const LI_KEEP = 60 * 24 * 3600_000; // how long a comment or reply is remembered, so it is never posted twice
const LI_MAX = { comment: 1250, post: 3000 };
const LI_NOT_SIGNED_IN = 'LinkedIn isn’t signed in in this browser. Ask the user to sign in to LinkedIn here. Atelier never signs in to LinkedIn.';
const LI_WARNING = 'LinkedIn showed a warning, a security check or a restriction. Atelier stopped all LinkedIn actions for 24 hours. Ask the user to look at LinkedIn.';
const LI_NO_POST = 'That post isn’t on the page any more. Read the page again and use a post from the new list.';
const LI_UNKNOWN = 'LinkedIn didn’t show the result, so it isn’t known whether it went through. Look at the post before trying again.';
const LI_NEEDS_APPROVAL = 'This LinkedIn action needs the user’s tap in Atelier first, so nothing was done.';
const LI_SOURCES = ['search', 'feed', 'person', 'company', 'newsletter', 'mine', 'post'];
const LI_DATES = ['past-24h', 'past-week', 'past-month'];
const LI_SLUG = /^(?!\.+$)[\w%.-]{2,120}$/; // never just dots: '..' would climb out of /in/

// A post's own address, normalized; '' for anything else.
function liPostUrl(url) {
  const m = /^https:\/\/www\.linkedin\.com\/feed\/update\/(urn:li:(?:activity|ugcPost|share):\d{6,25})\/?(?:[?#].*)?$/.exec(String(url || '').trim());
  return m ? `${LI}/feed/update/${m[1]}/` : '';
}
// The page a list of posts comes from, built here from a source and plain values. Every value is checked, so the
// address can't carry anything but a search word, a date range or a profile name to LinkedIn.
function liSourceUrl(a = {}) {
  const source = String(a.source || 'search');
  if (!LI_SOURCES.includes(source)) throw new Error(`source must be one of ${LI_SOURCES.join(', ')}.`);
  const slug = (v) => { const s = String(v || '').trim().replace(/^https:\/\/www\.linkedin\.com\/(in|company|newsletters)\//, '').replace(/\/.*$/, ''); if (!LI_SLUG.test(s)) throw new Error('Pass the profile, company or newsletter name as it shows in its LinkedIn address.'); return encodeURIComponent(decodeURIComponent(s)); };
  if (source === 'feed') return `${LI}/feed/`;
  if (source === 'person') return `${LI}/in/${slug(a.profile)}/recent-activity/all/`;
  if (source === 'company') return `${LI}/company/${slug(a.profile)}/posts/`;
  if (source === 'newsletter') return `${LI}/newsletters/${slug(a.profile)}/`;
  if (source === 'mine') return `${LI}/in/me/recent-activity/${['comments', 'reactions', 'all'].includes(a.kind) ? a.kind : 'comments'}/`;
  if (source === 'post') { const u = liPostUrl(a.url); if (!u) throw new Error('Pass url: a post address like https://www.linkedin.com/feed/update/urn:li:activity:…/'); return u; }
  const words = String(a.keywords || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!words) throw new Error('Pass keywords for a post search.');
  const date = LI_DATES.includes(a.datePosted) ? a.datePosted : 'past-week';
  const by = a.postedBy === 'anyone' ? '' : `&postedBy=${encodeURIComponent('["first"]')}`;
  return `${LI}/search/results/content/?keywords=${encodeURIComponent(words)}&datePosted=${encodeURIComponent(`"${date}"`)}&sortBy=${encodeURIComponent('"date_posted"')}${by}`;
}
// A page a post was found on, as liSourceUrl or liPostUrl built it ('' for anything else): a post with no address of
// its own (search results have none) is found again there by its author and opening words.
function liPage(url) {
  const post = liPostUrl(url);
  if (post) return post;
  let u;
  try { u = new URL(String(url || '')); } catch { return ''; }
  if (u.origin !== LI) return '';
  return /^\/(search\/results\/content\/|feed\/$|in\/[^/]+\/recent-activity\/|company\/[^/]+\/posts\/|newsletters\/[^/]+\/$)/.test(u.pathname) ? u.href : '';
}

function pageLinkedIn(op, arg = {}) {
  const clean = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  // A post or comment as its author laid it out (1.4.10, v141): line breaks and blank lines kept, and LinkedIn's own
  // "… more" button text dropped. The whole text is in the page; only styling hides the rest behind that button.
  const prose = (s, n) => String(s || '').replace(/\r/g, '').replace(/[ \t ]+/g, ' ').split('\n').map((l) => l.trim()).join('\n')
    .replace(/\n*(?:…|\.\.\.) ?(?:see )?more$/i, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, n);
  const CTL = 'button[aria-label^="Open control menu for post by"]';
  const REACT = 'button[aria-label^="Reaction button state"]';
  const EDITOR = '[role="textbox"][contenteditable="true"], [role="textbox"]';
  const single = /^\/feed\/update\//.test(location.pathname);
  const cardOf = (b) => { let e = b; while (e && !e.querySelector(REACT)) e = e.parentElement; return e; };
  const cards = () => {
    const seen = new Set(), out = [];
    for (const b of document.querySelectorAll(CTL)) {
      const el = cardOf(b);
      if (!el || seen.has(el)) continue;
      seen.add(el);
      out.push({ el, author: clean(String(b.getAttribute('aria-label')).replace(/^Open control menu for post by\s*/, ''), 120) });
    }
    return out;
  };
  const body = (el) => prose(el.querySelector('[data-testid="expandable-text-box"]')?.innerText, 3000); // LinkedIn's own post limit
  const liked = (el) => !/no reaction/i.test(el.querySelector(REACT)?.getAttribute('aria-label') || 'no reaction');
  const urlOf = (el) => {
    if (single) return `${location.origin}${location.pathname}`;
    const a = el.querySelector('a[href*="/feed/update/urn:li:"]');
    return a ? String(a.href).split(/[?#]/)[0] : '';
  };
  // Whose comments a post shows: on a post's own page the whole page, in a list just that post.
  const scope = (el) => (single ? document : el);
  const OPTS = /^View more options for\s*/;
  const commenters = (root) => [...root.querySelectorAll('button[aria-label^="View more options for "]')]
    .map((b) => clean(String(b.getAttribute('aria-label')).replace(OPTS, '').replace(/[’']s? comment\.?$/, ''), 120));
  const age = (el) => /(?:^|\s)(\d+(?:mo|yr|m|h|d|w))\b/.exec(clean(el.innerText, 400))?.[1] || '';
  const starts = (t) => clean(t, 60).toLowerCase();
  const marked = () => document.querySelector(`[data-atelier-li="${arg.token}"]`);
  const editorIn = (root) => [...root.querySelectorAll(EDITOR)].find((e) => e.getBoundingClientRect().height > 0) || null;
  const insert = (ed, text) => { ed.focus(); const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.execCommand('insertText', false, text); };
  const submitNear = (ed, words) => {
    let e = ed;
    for (let i = 0; i < 9 && e; i++, e = e.parentElement) {
      const b = [...e.querySelectorAll('button')].find((x) => words.includes(clean(x.innerText, 20)) && !x.getAttribute('aria-label') && !x.disabled);
      if (b) return b;
    }
    return null;
  };
  if (op === 'state') {
    const text = clean(document.body?.innerText, 6000);
    const warning = /\/checkpoint\//.test(location.pathname)
      || /unusual activity|temporarily (restricted|limited)|account (has been |is )?restricted|security (check|verification)|verify (that )?you(’|')?re (a )?(human|real)|we(’|')ve restricted/i.test(text);
    const signedIn = !/^\/(login|uas|authwall|signup)/.test(location.pathname) && !/\/authwall/.test(location.href);
    return { warning, signedIn };
  }
  if (op === 'scroll') { window.scrollBy(0, innerHeight * 2); document.getElementById('workspace')?.scrollBy(0, 2400); return true; }
  if (op === 'posts') {
    return cards().slice(0, arg.limit).map(({ el, author }) => ({
      author, text: body(el), url: urlOf(el), liked: liked(el), age: age(el),
      mine: Boolean(arg.me) && commenters(scope(el)).includes(arg.me),
    }));
  }
  if (op === 'notifications') {
    const out = [], seen = new Set();
    for (const a of document.querySelectorAll('main a[href]')) {
      let u;
      try { u = new URL(a.href); } catch { continue; }
      const urn = u.searchParams.get('highlightedUpdateUrn') || (/\/feed\/update\/(urn:li:[a-zA-Z]+:\d+)/.exec(u.pathname)?.[1]) || '';
      if (!/^urn:li:(activity|ugcPost|share):\d+$/.test(urn)) continue;
      const text = clean(a.innerText, 300);
      if (!text || seen.has(urn + text)) continue;
      seen.add(urn + text);
      out.push({ text, url: `${location.origin}/feed/update/${urn}/` });
      if (out.length >= arg.limit) break;
    }
    return out;
  }
  // The post asked for, marked with this request's token: on its own page the first post, else by author and opening words.
  if (op === 'find') {
    document.querySelectorAll('[data-atelier-li]').forEach((e) => e.removeAttribute('data-atelier-li'));
    const all = cards();
    const want = starts(arg.starts), who = clean(arg.author, 120).toLowerCase();
    const hit = single ? all[0]
      : all.find((c) => c.author.toLowerCase() === who && starts(body(c.el)).startsWith(want.slice(0, 40)))
        || (want.length >= 20 ? all.find((c) => starts(body(c.el)).startsWith(want.slice(0, 40))) : null);
    if (!hit) return { error: 'none' };
    hit.el.setAttribute('data-atelier-li', arg.token);
    const comments = [...scope(hit.el).querySelectorAll('button[aria-label^="View more options for "]')].slice(0, 40).map((b) => {
      let c = b; for (let i = 0; i < 8 && c && !c.querySelector('[data-testid="expandable-text-box"]'); i++) c = c.parentElement;
      return { author: clean(String(b.getAttribute('aria-label')).replace(OPTS, '').replace(/[’']s? comment\.?$/, ''), 120), text: prose(c?.querySelector('[data-testid="expandable-text-box"]')?.innerText, 1250) };
    });
    return { author: hit.author, text: body(hit.el), url: urlOf(hit.el), liked: liked(hit.el), age: age(hit.el), mine: Boolean(arg.me) && commenters(scope(hit.el)).includes(arg.me), comments };
  }
  // More comments on a post's own page, so a comment already there by the owner shows before anything is posted.
  if (op === 'more') {
    const b = [...document.querySelectorAll('button')].find((x) => /^load more comments$/i.test(x.getAttribute('aria-label') || clean(x.innerText, 40)));
    if (!b) return { more: false };
    b.click();
    return { more: true };
  }
  if (op === 'mine') { const el = marked(); return { n: el ? commenters(scope(el)).filter((n) => n === arg.me).length : -1 }; }
  if (op === 'liked') { const el = marked(); return el ? { liked: liked(el) } : { error: 'none' }; }
  if (op === 'like') {
    const el = marked();
    if (!el) return { error: 'none' };
    if (liked(el)) return { already: true };
    el.querySelector(REACT).click();
    return { clicked: true };
  }
  // The comment box under the marked post, opened if it isn't showing yet. A draft already in it is never posted along.
  if (op === 'openComment') {
    const el = marked();
    if (!el) return { error: 'none' };
    let ed = editorIn(el) || (single ? editorIn(document) : null);
    if (!ed) { const b = el.querySelector('button[aria-label="Comment"]'); if (!b) return { error: 'box' }; b.click(); return { opened: true }; }
    return { ready: true };
  }
  if (op === 'typeComment') {
    const el = marked();
    if (!el) return { error: 'none' };
    const ed = editorIn(el) || (single ? editorIn(document) : null);
    if (!ed) return { error: 'box' };
    if (clean(ed.innerText, 10)) return { error: 'draft' };
    insert(ed, String(arg.text));
    ed.setAttribute('data-atelier-ed', arg.token);
    return { typed: clean(ed.innerText, 4000) === clean(arg.text, 4000) };
  }
  // Reply under one person's comment: its own Reply button, then the box that opens under it, after the name LinkedIn
  // puts there.
  if (op === 'openReply') {
    const who = clean(arg.to, 120);
    const b = [...document.querySelectorAll('button[aria-label^="View more options for "]')]
      .find((x) => clean(String(x.getAttribute('aria-label')).replace(OPTS, '').replace(/[’']s? comment\.?$/, ''), 120).toLowerCase() === who.toLowerCase());
    if (!b) return { error: 'none' };
    let c = b; for (let i = 0; i < 10 && c && !c.querySelector('button[aria-label="Reply"]'); i++) c = c.parentElement;
    const reply = c?.querySelector('button[aria-label="Reply"]');
    if (!reply) return { error: 'none' };
    document.querySelectorAll('[data-atelier-li]').forEach((e) => e.removeAttribute('data-atelier-li'));
    c.setAttribute('data-atelier-li', arg.token);
    reply.click();
    return { opened: true };
  }
  if (op === 'typeReply') {
    const c = marked();
    if (!c) return { error: 'none' };
    const ed = editorIn(c);
    if (!ed) return { error: 'box' };
    const had = clean(ed.innerText, 200);
    if (had && !had.toLowerCase().startsWith(clean(arg.to, 60).split(' ')[0].toLowerCase())) return { error: 'draft' };
    insert(ed, `${had && !/\s$/.test(ed.innerText.replace(/\n$/, '')) ? ' ' : ''}${arg.text}`);
    ed.setAttribute('data-atelier-ed', arg.token);
    return { typed: clean(ed.innerText, 4000).endsWith(clean(arg.text, 4000)) };
  }
  if (op === 'compose') {
    const b = [...document.querySelectorAll('button, [role="button"]')].find((x) => /^start a post/i.test(clean(x.innerText || x.getAttribute('aria-label'), 40)));
    if (!b) return { error: 'box' };
    b.click();
    return { opened: true };
  }
  if (op === 'typePost') {
    const dlg = document.querySelector('[role="dialog"]');
    const ed = dlg && editorIn(dlg);
    if (!ed) return { error: 'box' };
    if (clean(ed.innerText, 10)) return { error: 'draft' };
    insert(ed, String(arg.text));
    ed.setAttribute('data-atelier-ed', arg.token);
    return { typed: clean(ed.innerText, 4000) === clean(arg.text, 4000) };
  }
  if (op === 'submit') {
    const ed = document.querySelector(`[data-atelier-ed="${arg.token}"]`);
    if (!ed) return { error: 'box' };
    const b = submitNear(ed, arg.words || ['Comment']);
    if (!b) return { error: 'button' };
    b.click();
    return { clicked: true };
  }
  // After a submit: the box emptied or gone (a post's dialog closed), and the words now on the page.
  if (op === 'posted') {
    const ed = document.querySelector(`[data-atelier-ed="${arg.token}"]`);
    const gone = !ed || !ed.isConnected || !clean(ed.innerText, 10);
    const shown = clean(document.body?.innerText, 400000).includes(clean(arg.text, 120));
    return { gone, shown };
  }
  return null;
}
// The owner's name as LinkedIn has it: the title of his own profile page ("Cole Ciprari | LinkedIn").
async function pageLinkedInMe() {
  const r = await fetch('/in/me/', { credentials: 'include' });
  const title = /<title>([^<]*)<\/title>/.exec(await r.text())?.[1] || '';
  return { name: title.replace(/\s*\|\s*LinkedIn\s*$/i, '').replace(/&amp;/g, '&').replace(/&#39;|&#x27;/g, '’').trim(), signedIn: !/\/(login|authwall|uas)/.test(r.url) };
}

async function liStore() {
  const got = await chrome.storage.local.get(['liDay', 'liLast', 'liPause', 'liDone']).catch(() => ({}));
  const today = new Date().toISOString().slice(0, 10);
  const day = got.liDay?.date === today ? got.liDay : { date: today, like: 0, comment: 0, post: 0 };
  const now = Date.now();
  const done = Object.fromEntries(Object.entries(got.liDone || {}).filter(([, t]) => now - Number(t) < LI_KEEP));
  return { day, last: got.liLast || {}, pause: Number(got.liPause) || 0, done };
}
async function liCheckPause() {
  const { pause } = await liStore();
  if (pause > Date.now()) throw new Error(`${LI_WARNING} It resumes in about ${Math.ceil((pause - Date.now()) / 3600_000)} h.`);
}
// Before a write: the 24-hour stop, the day's cap and the human pause since the last write of that kind.
async function liGate(kind) {
  const st = await liStore();
  if (st.pause > Date.now()) throw new Error(`${LI_WARNING} It resumes in about ${Math.ceil((st.pause - Date.now()) / 3600_000)} h.`);
  if (st.day[kind] >= LI_LIMITS[kind]) throw new Error(`That is today’s limit of ${LI_LIMITS[kind]} LinkedIn ${kind === 'like' ? 'likes' : kind === 'post' ? 'posts' : 'comments and replies'}, so nothing was done. It resets tomorrow.`);
  const [lo, hi] = LI_GAP[kind];
  const wait = Number(st.last[kind] || 0) + lo + Math.random() * (hi - lo) - Date.now();
  if (wait > LI_MAX_WAIT) throw new Error(`Atelier spaces LinkedIn actions out like a person would. Try this one again in ${Math.ceil(wait / 1000)} s.`);
  if (wait > 0) await sleep(wait);
}
async function liNote(kind, key) {
  const st = await liStore();
  st.day[kind] += 1;
  st.last[kind] = Date.now();
  if (key) st.done[key] = Date.now();
  await chrome.storage.local.set({ liDay: st.day, liLast: st.last, liDone: st.done }).catch(() => {});
}
async function liStop() { await chrome.storage.local.set({ liPause: Date.now() + LI_PAUSE }).catch(() => {}); }

// The one background tab LinkedIn work happens in: reused while it is still on LinkedIn, else a new one.
async function liTab(url) {
  const { liTabId } = await chrome.storage.session.get('liTabId').catch(() => ({}));
  let tab = Number.isInteger(liTabId) ? await chrome.tabs.get(liTabId).catch(() => null) : null;
  if (tab && !String(tab.url || '').startsWith(LI)) tab = null;
  if (tab) await chrome.tabs.update(tab.id, { url });
  else { tab = await chrome.tabs.create({ url, active: false }); chrome.storage.session.set({ liTabId: tab.id }).catch(() => {}); }
  chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  await waitForLoad(tab.id);
  await sleep(TIMING.li);
  const page = (op, arg = {}) => withTimeout(inPage(tab.id, pageLinkedIn, [op, arg]), TIMING.read, NOT_RESPONDING);
  const st = await page('state');
  if (st?.warning) { await liStop(); throw new Error(LI_WARNING); }
  if (!st?.signedIn) throw new Error(LI_NOT_SIGNED_IN);
  return { tab, page };
}
async function liMe(tabId) {
  const { liMe: saved } = await chrome.storage.session.get('liMe').catch(() => ({}));
  if (saved) return saved;
  const me = await withTimeout(inPage(tabId, pageLinkedInMe), TIMING.read, NOT_RESPONDING).catch(() => null);
  if (!me?.signedIn) throw new Error(LI_NOT_SIGNED_IN);
  if (me.name) chrome.storage.session.set({ liMe: me.name }).catch(() => {});
  return me.name || '';
}
// A post the tools pass around: its own address, or the page it was listed on plus its author and opening words.
function liHandle(a = {}) {
  const url = liPostUrl(a.url), page = url || liPage(a.page);
  if (!page) throw new Error('Pass url (a post address) or page, author and starts from linkedin_posts.');
  const starts = String(a.starts || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const author = String(a.author || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!url && (!author || starts.length < 20)) throw new Error('A post without its own address needs author and starts (its first words) from linkedin_posts.');
  return { url, page, author, starts, key: url || `${author}|${starts.slice(0, 60).toLowerCase()}` };
}
async function liOpen(h, { comments = false } = {}) {
  const { tab, page } = await liTab(h.page);
  const me = await liMe(tab.id);
  const token = crypto.randomUUID();
  if (comments && /\/feed\/update\//.test(h.page)) {
    for (let i = 0; i < 3 && (await page('more'))?.more; i++) await sleep(1200);
  }
  let post = await page('find', { author: h.author, starts: h.starts, token, me });
  for (let i = 0; i < 2 && post?.error && !h.url; i++) { await page('scroll'); await sleep(1500); post = await page('find', { author: h.author, starts: h.starts, token, me }); }
  if (!post || post.error) throw new Error(LI_NO_POST);
  return { tab, page, me, token, post };
}

// ── commands ── (ctx.via: 'local' for the Atelier tab in this browser, 'remote' for the relay; ctx.approved: the
// owner approved this step in Atelier)
const COMMANDS = {
  async tabs() {
    const tabs = await chrome.tabs.query({});
    const own = chrome.runtime.getURL(''); // e.g. an open confirmation window
    return tabs.filter((t) => t.url && !t.url.startsWith(own) && !ALLOWED_ORIGINS.some((o) => t.url.startsWith(o)))
      .map((t) => ({ tabId: t.id, title: t.title, url: t.url, active: t.active }));
  },
  async open({ url, active = false }, ctx = {}) {
    if (ctx.approved !== true) throw new Error(NEEDS_APPROVAL);
    const tab = await chrome.tabs.create({ url: checkUrl(url), active: Boolean(active) });
    await waitForLoad(tab.id);
    const t = await chrome.tabs.get(tab.id);
    return { tabId: t.id, title: t.title, url: t.url };
  },
  async read({ tabId, url }, ctx = {}) {
    if (url && ctx.approved !== true) throw new Error(NEEDS_APPROVAL); // a url needs it even beside a tabId, as in the app
    if (!tabId && url) {
      const tab = await chrome.tabs.create({ url: checkUrl(url), active: false });
      // The tab opened for this read is closed whatever the page does (1.4.1, v114). Chrome lets no extension read its
      // own error page (a dead host), the Web Store or a PDF, and each such read left one more hidden tab open. A page
      // that never answers (it opens a dialog box as it loads) held its tab the same way, so that wait has an end too.
      try {
        await waitForLoad(tab.id);
        await sleep(TIMING.render); // let client-rendered pages settle
        return { ...(await withTimeout(inPage(tab.id, pageExtract, [MAX_TEXT]), TIMING.read, NO_ANSWER)) };
      } finally { chrome.tabs.remove(tab.id).catch(() => {}); }
    }
    if (!tabId) throw new Error('Pass a tabId or a url.');
    return { tabId, ...(await inPage(tabId, pageExtract, [MAX_TEXT])) };
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
  // Sign in with the password Chrome saved for this site (see pageLogin). Asks like a click, unless the user ticked
  // "Don't ask again on this computer".
  async signin(args, ctx = {}) {
    const tabId = Number(args?.tabId);
    if (!Number.isInteger(tabId) || tabId < 0) throw new Error('tabId is required.');
    const form = await withTimeout(inPage(tabId, pageLogin, ['find']), TIMING.read, NOT_RESPONDING);
    if (form?.error === 'button') throw new Error(NO_SIGNIN_BUTTON); // before anything is asked, clicked or filled
    if (!form || form.error) throw new Error(NO_LOGIN_FORM);
    const ok = await confirmFirst('signin', { tabId, element: 'signin' }, ctx.via);
    await samePage(tabId, ok.url);
    // Which saved login, when Chrome has more than one for the site (1.4.2, v119). Without it Chrome's first is taken.
    const account = String(args?.account || '').trim().slice(0, 200);
    // Chrome shows its saved passwords only on a tab in front, in a focused window. The agent opens pages in the
    // background, so the sign-in found nothing to pick and said none was saved (1.4.2, v119).
    try {
      const front = await chrome.tabs.update(tabId, { active: true });
      if (front?.windowId !== undefined) await chrome.windows.update(front.windowId, { focused: true });
    } catch { /* the clicks below still say whether Chrome filled */ }
    await sleep(TIMING.front);
    const target = { tabId };
    let used = '';
    let mac = false;
    try { mac = (await chrome.runtime.getPlatformInfo()).os === 'mac'; } catch { /* the keys go as on Windows */ }
    try { await chrome.debugger.attach(target, '1.3'); } catch (err) {
      throw new Error(`Atelier Browser couldn’t take control of that tab (${err?.message || err}). Ask the user to sign in.`);
    }
    try {
      const cdp = (method, params) => chrome.debugger.sendCommand(target, method, params);
      const click = async (pt) => {
        await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y });
        await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
        await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
      };
      // On a Mac the key goes with the Mac's own key code as well (1.4.3, v120): Chrome's list of saved logins ignored
      // the keys there, so nothing was picked.
      const native = mac ? { ArrowDown: 125, Enter: 36 } : {};
      const key = async (k, vk) => {
        const n = native[k] ?? vk;
        await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: n });
        await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: n });
      };
      // The Enter that sends the form is a keyDown carrying its character: that gives the page a keypress, and a form
      // is sent on keypress. The rawKeyDown above carries none, so the page saw a key go down and the form stayed where
      // it was (1.4.1, v114). Chrome's own list still gets the rawKeyDown: that is the one it takes.
      const pressEnter = async () => {
        await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
        await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      };
      // Once the click or the Enter that sends the form is on its way, a failure can't say the form stayed put.
      const sent = (p) => p.catch(() => { throw new Error(SIGNIN_UNKNOWN); });
      const filled = async () => (await inPage(tabId, pageLogin, ['filled']))?.filled === true;
      // Chrome's "started debugging" bar slides in now and moves the page. Chrome closes its list of saved logins when
      // the page moves, so the first click waits until the bar has settled (1.4.4, v121).
      await sleep(TIMING.bar);
      const first = await inPage(tabId, pageLogin, ['at', form.user ? 'user' : 'pw']);
      if (!first) throw new Error(NO_LOGIN_FORM);
      // A real click releases what Chrome filled when the page loaded; if it didn't fill, it shows its list here.
      // (v114 review, tools #3, left open: with no login saved, the list Chrome shows at a user-name field can hold its
      // saved addresses, and the pick below takes the first row. Picking at the password field instead was not done:
      // on a sign-up form Chrome offers a new password there, and the same keys accept it. A real Chrome must settle it.)
      await click(first);
      await sleep(TIMING.fill);
      // An account named is a preference, never typed (1.4.5, v126). 1.4.2 to 1.4.4 typed it into the field: on the
      // owner's Mac that closed Chrome's list or cut it down to a name the model had guessed ("bkenny" for a login saved
      // under a full address), and the address he then picked was refused as another account. Chrome's list opens for
      // the user's own click, so the user picks. What Chrome filled by itself stays only when it is the account asked
      // for: the same name, or the part of it before "@".
      const whoIs = async () => String((await inPage(tabId, pageLogin, ['who']))?.who || '');
      const asked = (who) => { const a = account.toLowerCase(), w = who.toLowerCase(); return w === a || w.split('@')[0] === a.split('@')[0]; };
      const prefer = Boolean(account && form.user);
      if (prefer && (await filled()) && !asked(await whoIs())) {
        await inPage(tabId, pageLogin, ['clear']);
        const again = await inPage(tabId, pageLogin, ['at', 'user']);
        if (again) { await click(again); await sleep(TIMING.fill); }
      }
      if (!(await filled())) {
        await inPage(tabId, pageLogin, ['guard']);
        try {
          // The keys take the first row of Chrome's list, so they go only when no account was named.
          if (!prefer) {
            await key('ArrowDown', 40);
            await sleep(250);
            await key('Enter', 13);
            await sleep(TIMING.fill);
          }
          // Still empty: the user clicks the user name field and their login in Chrome's list; the form is sent once
          // Chrome fills it, within TIMING.pick (1.4.3, v120). The Enter guard stays on meanwhile.
          for (let waited = 0; waited < TIMING.pick && !(await filled()); waited += TIMING.poll) await sleep(TIMING.poll);
        } finally { await inPage(tabId, pageLogin, ['unguard']).catch(() => {}); }
      }
      if (!(await filled())) throw new Error(NO_SAVED);
      used = await whoIs();
      const sub = form.submit ? await inPage(tabId, pageLogin, ['at', 'submit']) : null;
      if (sub) await sent(click(sub));
      else if (form.enter === false) throw new Error(NO_SIGNIN_BUTTON); // the button found went away, and Enter would press another
      else { await inPage(tabId, pageLogin, ['focusPw']); await sent(pressEnter()); }
    } finally {
      await Promise.resolve(chrome.debugger.detach(target)).catch(() => {});
    }
    await sleep(TIMING.settle);
    await waitForLoad(tabId, 8000);
    // What the page did next decides the answer (1.4.1, v114: it was 'submitted' whatever happened). The same password
    // field still showing at the same address means the form may never have gone: 'unclear', and the note says so.
    const t = await chrome.tabs.get(tabId).catch(() => null);
    const as = used ? { account: used } : {};
    if (!t) return { signedIn: 'unclear', ...as, note: `${FILLED} That tab then closed, so it isn’t known whether the sign-in went through.` };
    const now = { title: t.title, url: t.url };
    const still = withoutHash(t.url) === withoutHash(ok.url)
      && await withTimeout(inPage(tabId, pageLogin, ['after']), TIMING.read, NOT_RESPONDING).then((r) => r?.still === true, () => true);
    if (still) return { signedIn: 'unclear', ...as, note: `${FILLED} The sign-in form is still showing, so it isn’t known whether it went through. Look at that tab before trying again.`, now };
    return { signedIn: 'submitted', ...as, note: FILLED, now };
  },
  // Messages on this Mac: op recent / read / send (see messagesHost).
  async messages(args = {}, ctx = {}) {
    const op = String(args.op || '');
    if (op === 'recent') return messagesHost({ op, limit: clampInt(args.limit, 1, 50, 20) });
    if (op === 'read') {
      const chat = String(args.chat || '').trim().slice(0, 200);
      if (!chat) throw new Error('Pass chat: a chat id from messages_recent, or a phone number or email.');
      return messagesHost({ op, chat, limit: clampInt(args.limit, 1, 100, 30) });
    }
    if (op === 'send') {
      if (ctx.approved !== true) throw new Error(SEND_NEEDS_APPROVAL);
      const to = String(args.to || '').trim().slice(0, 200), text = String(args.text ?? '');
      if (!to || !text.trim()) throw new Error('Pass to (a chat id, phone number or email) and text.');
      if (text.length > MAX_SMS) throw new Error(`That text is over ${MAX_SMS} characters.`);
      await confirmFirst('sms', { to, text }, ctx.via);
      return messagesHost({ op, to, text });
    }
    throw new Error('Unknown Messages action.');
  },
  // Personal texts through Google Messages for web in this browser: op recent / read / send (see pageGMessages).
  async gmessages(args = {}, ctx = {}) {
    const op = String(args.op || '');
    if (op === 'recent') {
      const { page } = await gmTab();
      return { conversations: (await page('recent', { limit: clampInt(args.limit, 1, 50, 20) })) || [] };
    }
    if (op === 'read') {
      const chat = String(args.chat || '').trim().slice(0, 200);
      if (!chat) throw new Error('Pass chat: a chat id or a name from personal_texts_recent.');
      const { page } = await gmTab();
      const got = await gmOpen(page, chat, clampInt(args.limit, 1, 100, 30));
      return { chat: got.chat, name: got.name, messages: got.messages };
    }
    if (op === 'send') {
      if (ctx.approved !== true) throw new Error(SEND_NEEDS_APPROVAL);
      const to = String(args.to || '').trim().slice(0, 200), text = String(args.text ?? '');
      if (!to || !text.trim()) throw new Error('Pass to (a chat id or a name from personal_texts_recent) and text.');
      if (text.length > MAX_SMS) throw new Error(`That text is over ${MAX_SMS} characters.`);
      const { page } = await gmTab();
      // The conversation is found first, so the confirmation names who gets the text, never just what was asked for.
      const got = await gmOpen(page, to, 1);
      await confirmFirst('sms', { to: got.name || to, text }, ctx.via);
      const before = await page('outgoing');
      if (before?.here !== got.chat) throw new Error(GM_NOT_SENT); // the tab moved to another conversation meanwhile
      const typed = await page('type', { text });
      if (typed?.error === 'draft') throw new Error('That conversation has a draft in its box, so nothing was sent. Ask the user to clear it.');
      if (!typed?.typed) throw new Error(GM_NOT_SENT);
      const sent = await page('send');
      if (!sent?.clicked) throw new Error(GM_NOT_SENT);
      for (let waited = 0; waited < TIMING.gm; waited += TIMING.poll) {
        await sleep(TIMING.poll);
        const now = await page('outgoing');
        if (now?.here === got.chat && now.n > before.n) return { sent: true, to: got.name || to, chat: got.chat, via: 'Google Messages' };
      }
      throw new Error(GM_NOT_SENT);
    }
    throw new Error('Unknown personal texts action.');
  },
  // LinkedIn in this browser: op posts / notifications / read / like / comment / reply / post (see pageLinkedIn).
  async linkedin(args = {}, ctx = {}) {
    const op = String(args.op || '');
    if (op === 'posts') {
      await liCheckPause();
      const url = liSourceUrl(args);
      const limit = clampInt(args.limit, 1, 25, 10);
      const { tab, page } = await liTab(url);
      const me = await liMe(tab.id);
      let posts = (await page('posts', { limit, me })) || [];
      for (let i = 0; i < 3 && posts.length < limit; i++) { await page('scroll'); await sleep(1500); posts = (await page('posts', { limit, me })) || []; }
      return { page: url, me, posts };
    }
    if (op === 'notifications') {
      await liCheckPause();
      const { page } = await liTab(`${LI}/notifications/`);
      return { notifications: (await page('notifications', { limit: clampInt(args.limit, 1, 40, 20) })) || [] };
    }
    if (op === 'read') {
      await liCheckPause();
      const h = liHandle(args);
      const { post, me } = await liOpen(h, { comments: true });
      return { ...post, me };
    }
    if (!['like', 'comment', 'reply', 'post'].includes(op)) throw new Error('Unknown LinkedIn action.');
    if (ctx.approved !== true) throw new Error(LI_NEEDS_APPROVAL);
    const kind = op === 'reply' ? 'comment' : op;
    const text = String(args.text ?? '').trim();
    if (op !== 'like') {
      if (!text) throw new Error('Pass the text.');
      if (/[–—]/.test(text)) throw new Error('The text has a dash the owner never uses (— or –). Rewrite it without one.');
      if (text.length > LI_MAX[kind]) throw new Error(`That is over LinkedIn’s ${LI_MAX[kind]} characters.`);
    }
    if (op === 'post') {
      await liGate('post');
      await confirmFirst('linkedin', { to: 'A new post on your LinkedIn', url: `${LI}/feed/`, op, text }, ctx.via);
      const { page } = await liTab(`${LI}/feed/`);
      const token = crypto.randomUUID();
      if ((await page('compose'))?.error) throw new Error('Couldn’t find “Start a post” on LinkedIn, so nothing was posted.');
      await sleep(1500);
      const typed = await page('typePost', { text, token });
      if (typed?.error === 'draft') throw new Error('LinkedIn’s post box already holds a draft, so nothing was posted. Ask the user to clear it.');
      if (!typed?.typed) throw new Error('The text didn’t go into LinkedIn’s post box, so nothing was posted.');
      await sleep(800 + Math.random() * 1200);
      if ((await page('submit', { token, words: ['Post'] }))?.error) throw new Error('Couldn’t find LinkedIn’s Post button, so nothing was posted. The text is still in the box.');
      for (let waited = 0; waited < 8000; waited += 1000) {
        await sleep(1000);
        if ((await page('posted', { token, text }).catch(() => null))?.gone) { await liNote('post'); return { posted: true }; }
      }
      throw new Error(LI_UNKNOWN);
    }
    const h = liHandle(args);
    if (op === 'reply' && !h.url) throw new Error('A reply needs url: the post’s own address.');
    const to = String(args.to || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (op === 'reply' && !to) throw new Error('Pass to: the name of the person whose comment this answers.');
    const key = op === 'reply' ? `${h.key}|reply|${to.toLowerCase()}` : h.key;
    if (op !== 'like' && (await liStore()).done[key]) throw new Error(`Atelier already ${op === 'reply' ? `replied to ${to} there` : 'commented on that post'}, so nothing was posted. Never twice.`);
    await liGate(kind);
    let { page, me, token, post } = await liOpen(h, { comments: op !== 'like' });
    if (op === 'like' && post.liked) return { liked: true, already: true, author: post.author };
    if (op === 'comment' && post.mine) { await liNote('comment', key).catch(() => {}); throw new Error('The user already commented on that post, so nothing was posted. Never twice.'); }
    const about = `${post.author || h.author || 'this person'}’s post`;
    await confirmFirst('linkedin', { to: op === 'like' ? `Like ${about}` : op === 'reply' ? `Reply to ${to} on ${about}` : `Comment on ${about}`, url: post.url || h.page, op, text: op === 'like' ? '' : text }, ctx.via);
    // The confirmation took time: the page is found again before anything is clicked.
    post = await page('find', { author: h.author || post.author, starts: h.starts || post.text, token, me });
    if (!post || post.error) throw new Error(LI_NO_POST);
    if ((await page('state'))?.warning) { await liStop(); throw new Error(LI_WARNING); }
    await sleep(600 + Math.random() * 1400);
    if (op === 'like') {
      const r = await page('like', { token });
      if (r?.already) return { liked: true, already: true, author: post.author };
      if (!r?.clicked) throw new Error(LI_NO_POST);
      for (let waited = 0; waited < 5000; waited += 500) {
        await sleep(500);
        if ((await page('liked', { token }))?.liked) { await liNote('like'); return { liked: true, author: post.author, url: post.url || '' }; }
      }
      throw new Error(LI_UNKNOWN);
    }
    if (op === 'comment') {
      const open = await page('openComment', { token });
      if (open?.error) throw new Error('Couldn’t open the comment box on that post, so nothing was posted.');
      if (open?.opened) await sleep(1500);
      const typed = await page('typeComment', { text, token });
      if (typed?.error === 'draft') throw new Error('That post’s comment box already holds a draft, so nothing was posted. Ask the user to clear it.');
      if (!typed?.typed) throw new Error('The text didn’t go into the comment box, so nothing was posted.');
    } else {
      if ((await page('openReply', { to, token }))?.error) throw new Error(`Couldn’t find ${to}’s comment on that post, so nothing was posted.`);
      await sleep(1500);
      const typed = await page('typeReply', { to, text, token });
      if (typed?.error === 'draft') throw new Error('That reply box already holds other text, so nothing was posted. Ask the user to clear it.');
      if (!typed?.typed) throw new Error('The text didn’t go into the reply box, so nothing was posted.');
    }
    await sleep(800 + Math.random() * 1200);
    if ((await page('submit', { token, words: op === 'reply' ? ['Reply', 'Comment'] : ['Comment', 'Post'] }))?.error) throw new Error('Couldn’t find the button that posts it, so nothing was posted. The text is still in the box.');
    await liNote(kind, key); // from here it may have gone out: never again, whatever the check below finds
    for (let waited = 0; waited < 8000; waited += 1000) {
      await sleep(1000);
      const r = await page('posted', { token, text }).catch(() => null);
      if (r?.gone && r.shown) return { posted: true, as: me, on: post.author, url: post.url || '' };
    }
    throw new Error(LI_UNKNOWN);
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
    try { reply = fn ? { ok: true, result: await fn(msg.args || {}, { via: 'remote', approved: msg.approved === true }) } : { ok: false, error: `Unknown command ${msg?.cmd}` }; }
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
const REMOTE_COMMANDS = ['tabs', 'read', 'open', 'elements', 'describe', 'click', 'type', 'signin', 'messages', 'gmessages', 'linkedin', 'show'];

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
  // On a Mac: this extension's id (the Messages setup command needs it) and whether the Messages helper answers.
  let mac = false;
  try { mac = (await chrome.runtime.getPlatformInfo()).os === 'mac'; } catch {}
  const messages = mac ? await messagesHost({ op: 'ping' }).then(() => true, () => false) : false;
  return { paired: Boolean(relayToken), origin: relayOrigin || null, connected: ws?.readyState === WebSocket.OPEN, asks: !(await asksNothing()), id: chrome.runtime.id, mac, messages };
};
// Local-only: the Atelier tab on this computer turns the confirmation window back on. Nothing here can turn it off.
COMMANDS.askAgain = async () => {
  await chrome.storage.local.set({ noAsk: false });
  return { asks: true };
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
  fn(msg.args || {}, { via: 'local', approved: msg?.approved === true })
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: friendly(err) }));
  return true; // async response
});
