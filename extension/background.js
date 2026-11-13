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
const TIMING = { confirm: 45_000, settle: 1200, read: 10_000, fill: 700, helper: 30_000, render: 800, front: 400, pick: 30_000, poll: 500, bar: 900 };
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
  const what = action === 'type' ? 'typing' : action === 'signin' ? 'sign-in' : action === 'sms' ? 'text message' : 'click';
  const nothing = action === 'type' ? 'nothing was typed' : action === 'signin' ? 'nothing was signed in' : action === 'sms' ? 'nothing was sent' : 'nothing was clicked';
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
// What the window shows: the element read from the page, or for a text message (sms) who it goes to.
function looksAt(action, { tabId, element, to }, token) {
  if (action === 'sms') return Promise.resolve([{ url: '', title: 'Messages' }, { tag: 'message', type: '', label: String(to || '').slice(0, 200) }]);
  return withTimeout(Promise.all([
    chrome.tabs.get(tabId),
    inPage(tabId, pageElement, [element, 'describe', { token }]),
  ]), TIMING.read, NOT_RESPONDING);
}
async function confirmFirst(action, { tabId, element, text, submit, to }, via) {
  const path = via === 'remote' ? 'remote' : 'local';
  // The user's standing OK on this computer: no window, no cooldown. The element is still found and marked, the page
  // is still checked again before the action, and a password or payment field is still refused.
  if (await asksNothing()) {
    const token = crypto.randomUUID();
    const [tab, target] = await looksAt(action, { tabId, element, to }, token);
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
    const [tab, target] = await looksAt(action, { tabId, element, to }, req.id);
    if (!target) throw new Error('Element not found — call browser_elements again (the page may have changed).');
    if (action === 'type' && target.sensitive) throw new Error(REFUSED_FIELD);
    const typed = String(text ?? '');
    req.info = {
      action, via: path, submit: action === 'type' && Boolean(submit),
      element: { tag: target.tag, type: target.type, label: target.label, ...(target.href ? { href: target.href } : {}), ...(target.near ? { near: target.near } : {}) },
      page: { title: tab.title || target.page || '', url: tab.url || target.url || '' },
      ...(action === 'type' || action === 'sms' ? { text: typed.slice(0, MAX_SHOWN_TEXT), more: Math.max(0, typed.length - MAX_SHOWN_TEXT) } : {}),
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
const REMOTE_COMMANDS = ['tabs', 'read', 'open', 'elements', 'describe', 'click', 'type', 'signin', 'messages', 'show'];

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
