// Atelier Browser — the confirmation window for one click or typing request (opened by background.js).
// It shows what the extension read from the page itself (never the requester's own description), always as plain
// text, and answers the service worker over a port. Deny, Esc, closing the window and running out of time all refuse.
const $ = (id) => document.getElementById(id);
// Allow only works once the window has had focus this long with no click or key press in it. A press meant for
// something else can't land on it the moment the window appears, and neither can a burst of clicks aimed at the spot
// where Allow shows up: the user has to pause before choosing it.
const ARM_MS = 1000;
const VIA = {
  local: 'The Atelier tab in this browser is asking.',
  remote: 'Atelier on another device is asking, through this computer’s paired connection.',
};

const id = new URLSearchParams(location.search).get('id') || '';
let info = null, done = false, armTimer = 0, tick = 0, beat = 0;
// live: Allow can be used now. pressedLive: the current press on Allow began while it was live. Allow is never given
// the real `disabled` attribute before it is answered: a disabled button swallows the presses that must restart the wait.
let live = false, pressedLive = false;
const port = chrome.runtime.connect({ name: 'atelier-confirm' });

function render(i) {
  info = i;
  const typing = i.action === 'type';
  const el = i.element || {}, page = i.page || {};
  document.title = `${typing ? 'Allow typing?' : 'Allow click?'} — Atelier Browser`;
  $('title').textContent = typing ? (i.submit ? 'Allow Atelier to type and submit?' : 'Allow Atelier to type?') : 'Allow Atelier to click?';
  $('via').textContent = VIA[i.via] || 'Atelier is asking.';
  $('action').textContent = typing ? (i.submit ? 'Type the text below, then submit it' : 'Type the text below') : 'Click';
  $('label').textContent = el.label ? `“${el.label}”` : '(no label)';
  $('kind').textContent = `${el.tag || 'element'}${el.type ? ` · ${el.type}` : ''}`;
  $('kind').hidden = false;
  let host = '';
  try { host = new URL(page.url).host; } catch {}
  $('host').textContent = host;
  $('pageTitle').textContent = page.title ? `— ${page.title}` : '';
  $('url').textContent = page.url || '';
  // What tells same-label elements apart: the text of the row it sits in, and where a link goes.
  $('near').hidden = !el.near;
  $('near').textContent = el.near ? `In: “${el.near}”` : '';
  $('href').hidden = !el.href;
  $('href').textContent = el.href ? `Link to ${el.href}` : '';
  if (typing) {
    $('typed').hidden = false;
    $('text').textContent = i.text || '(nothing: the field is cleared)';
    if (i.more > 0) { $('more').hidden = false; $('more').textContent = `…and ${i.more} more characters.`; }
  }
  countdown();
  tick = setInterval(countdown, 250);
  // Without preventScroll the focus would scroll the heading and the "who is asking" line out of a tall request's view.
  $('deny').focus({ preventScroll: true });
  arm();
}

function countdown() {
  if (!info) return;
  const left = Math.max(0, Math.ceil((info.expiresAt - Date.now()) / 1000));
  $('timer').textContent = `Denied automatically in ${left} s`;
}

function setLive(on) {
  live = on;
  $('allow').setAttribute('aria-disabled', on ? 'false' : 'true');
}
// (Re)start the wait before Allow can be used; it only runs while this window has focus.
function arm() {
  clearTimeout(armTimer);
  setLive(false);
  if (done || !info || !document.hasFocus()) return;
  armTimer = setTimeout(() => { if (!done) setLive(true); }, ARM_MS);
}
function disarm() {
  clearTimeout(armTimer);
  setLive(false);
}
// A press anywhere in the window before Allow is live starts the wait again.
const early = () => { if (!live && !done && info) arm(); };

function finish(message) {
  if (done) return;
  done = true;
  clearInterval(tick); clearInterval(beat); clearTimeout(armTimer);
  setLive(false);
  $('allow').disabled = true;
  $('deny').disabled = true;
  if (message) $('timer').textContent = message;
  setTimeout(() => window.close(), 1500);
}

function answer(choice) {
  if (done) return;
  if (!info) { window.close(); return; } // nothing shown yet: closing the window refuses
  try { port.postMessage({ answer: choice }); } catch {}
  finish(choice === 'allow' ? 'Allowed.' : 'Denied.');
}

// Capture phase, so every press is seen before a button handles it.
document.addEventListener('pointerdown', (ev) => { early(); pressedLive = live && ev.target === $('allow'); }, true);
// Allow takes a real click whose press began once it was live, or a keyboard press on it (a click with detail 0).
$('allow').addEventListener('click', (ev) => {
  if (ev.isTrusted && live && (pressedLive || ev.detail === 0)) answer('allow');
  pressedLive = false;
});
$('deny').addEventListener('click', () => answer('deny'));
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') { ev.preventDefault(); answer('deny'); }
  else early();
});
window.addEventListener('focus', arm);
window.addEventListener('blur', disarm);

port.onMessage.addListener((m) => {
  if (m?.info && !info && !done) render(m.info);
  else if (m?.gone) finish('This request is no longer waiting.');
});
port.onDisconnect.addListener(() => finish('This request is no longer waiting.'));
port.postMessage({ hello: true, id });
// Messages on the port keep the extension's service worker awake while the user decides (MV3 stops idle workers).
beat = setInterval(() => { try { port.postMessage({ ping: true }); } catch {} }, 10_000);
