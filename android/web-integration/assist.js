// Atelier Assist: the Android side-button pop-up (android/ in this repo) shows Atelier in a WebView bottom sheet.
// That WebView injects window.AtelierAssist into https://atelier.ciprari.ai's top frame only (androidx.webkit
// addWebMessageListener with an origin allow-list; Build previews, being sandboxed iframes, never get it). It is the one
// signal the page may trust: ?panel=assist / ?via=assist are hints any link can carry and only ever change the look.
//
// App → page (JSON strings): hello {v, app, version, invocation:'assist'|'launcher', start, mic:'granted'|'prompt'|'denied',
//   expanded, save} (the answer to ready) · listen {invocation, keyboard} (the button pressed again while open) ·
//   sheet {expanded}
// Page → app: ready · close · open-app {path} · expand · collapse · theme {bg:'#rrggbb'} · mic-settings ·
//   save-begin {name, mime, size} followed by exactly one ArrayBuffer message (needs hello.save)
// Everything here takes its window as an argument, so tests/assist.test.mjs runs it in Node with a fake bridge.

export const SAVE_MAX = 64 * 1024 * 1024; // the app's Downloads.MAX_BYTES
const HELLO_WAIT_MS = 1200;

export function bridgeOf(win = globalThis) {
  try {
    const b = win?.AtelierAssist;
    return b && typeof b.postMessage === 'function' ? b : null;
  } catch { return null; }
}

// '/…' on this site only: one leading slash, no backslash or control characters (the app checks again).
export function safePath(p) {
  const s = String(p ?? '/').trim() || '/';
  return s.length <= 2048 && s.startsWith('/') && !s.startsWith('//') && !/[\\\u0000-\u001f\u007f]/.test(s) ? s : '/';
}

// What download() is handed (a Blob, a data: URL, or text) as a Blob.
export function toBlob(data, type = '') {
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data;
  const s = typeof data === 'string' ? data : String(data ?? '');
  const m = /^data:([^,;]*)((?:;[^,;]*)*?),(.*)$/s.exec(s);
  if (!m) return new Blob([s], { type: type || 'text/plain' });
  const mime = m[1] || type || 'text/plain';
  if (/;base64/i.test(m[2])) {
    const bin = atob(m[3]);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return new Blob([out], { type: mime });
  }
  return new Blob([decodeURIComponent(m[3])], { type: mime });
}

// createAssist({ win, onListen, onSheet, timers }) → the panel API. Outside the app every call is a harmless no-op:
//   on                      true only inside Atelier Assist
//   hello                   Promise<hello | null> (null outside, or if the app never answers)
//   info()                  the hello once it arrived
//   micState()              Promise<'granted'|'prompt'|'denied'>: Android's answer for the panel (navigator.permissions
//                           isn't in WebView), for launch.js's perm gate
//   canSave()               the app can take a file (save-begin + ArrayBuffer)
//   save(blob, name)        Promise<boolean>
//   close() openApp(path) expand() collapse() micSettings() theme(bg) syncTheme(doc) watchTheme(doc)
export function createAssist({ win = globalThis, onListen = () => {}, onSheet = () => {}, timers = globalThis } = {}) {
  const b = bridgeOf(win);
  let info = null, resolveHello = () => {};
  const hello = new Promise((res) => { resolveHello = res; });
  const send = (m) => {
    if (!b) return false;
    try { b.postMessage(JSON.stringify(m)); return true; } catch { return false; }
  };
  if (b) {
    const onMessage = (ev) => {
      let m = null;
      try { m = typeof ev?.data === 'string' ? JSON.parse(ev.data) : null; } catch { return; }
      if (!m || typeof m.type !== 'string') return;
      if (m.type === 'hello') { info = m; resolveHello(m); }
      else if (m.type === 'listen') onListen(m);
      else if (m.type === 'sheet') onSheet(m);
    };
    if (typeof b.addEventListener === 'function') b.addEventListener('message', onMessage);
    else b.onmessage = onMessage;
    send({ type: 'ready' });
    timers.setTimeout(() => resolveHello(null), HELLO_WAIT_MS);
  } else resolveHello(null);

  let lastBg = '';
  const api = {
    on: Boolean(b),
    hello,
    info: () => info,
    async micState() {
      const h = info || (b ? await hello : null);
      return ['granted', 'prompt', 'denied'].includes(h?.mic) ? h.mic : 'prompt';
    },
    canSave: () => Boolean(b && info?.save),
    async save(blob, name = '') {
      if (!api.canSave() || !blob || !(blob.size > 0) || blob.size > SAVE_MAX) return false;
      if (!send({ type: 'save-begin', name: String(name).slice(0, 120), mime: blob.type || '', size: blob.size })) return false;
      try { b.postMessage(await blob.arrayBuffer()); return true; } catch { return false; }
    },
    close: () => send({ type: 'close' }),
    openApp: (path = '/') => send({ type: 'open-app', path: safePath(path) }),
    expand: () => send({ type: 'expand' }),
    collapse: () => send({ type: 'collapse' }),
    micSettings: () => send({ type: 'mic-settings' }),
    theme(bg) {
      const c = String(bg ?? '').trim().toLowerCase();
      if (!/^#[0-9a-f]{6}$/.test(c) || c === lastBg) return false;
      lastBg = c;
      return send({ type: 'theme', bg: c });
    },
    // The sheet's colour follows the page's --bg (Settings → theme can differ from the phone's).
    syncTheme(doc = win.document) {
      try { return api.theme(win.getComputedStyle(doc.documentElement).getPropertyValue('--bg')); } catch { return false; }
    },
    watchTheme(doc = win.document) {
      if (!b) return;
      const again = () => timers.setTimeout(() => api.syncTheme(doc), 0);
      api.syncTheme(doc);
      try { new win.MutationObserver(again).observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] }); } catch {}
      try { win.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', again); } catch {}
    },
  };
  return api;
}

// Panel only: CSS shows the latest exchange; this pill above it says how many earlier ones the thread holds and opens
// the full app (with owner thread sync on, the thread is there too). → the pill, or null outside the panel.
export function mountEarlierHint(api, { doc = globalThis.document, stream = doc?.getElementById('stream'), win = globalThis } = {}) {
  if (!api?.on || !stream) return null;
  const pill = doc.createElement('button');
  pill.type = 'button';
  pill.className = 'assist-more';
  pill.hidden = true;
  pill.addEventListener('click', () => api.openApp('/'));
  stream.before(pill);
  const update = () => {
    const n = stream.querySelectorAll(':scope > .entry').length - 1;
    pill.hidden = n < 1;
    if (n >= 1) pill.textContent = `${n} earlier ${n === 1 ? 'message' : 'messages'} · Open in Atelier ↗`;
  };
  try { new win.MutationObserver(update).observe(stream, { childList: true }); } catch {}
  update();
  return pill;
}
