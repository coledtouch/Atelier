// Runs only on the Atelier page. Relays requests between the page and the extension's service worker.
// The page talks to us with window.postMessage({ __atelier: 'req' | 'ping', ... }).
const VERSION = chrome.runtime.getManifest().version;

function hello() {
  window.postMessage({ __atelier: 'hello', version: VERSION }, location.origin);
}

window.addEventListener('message', async (ev) => {
  if (ev.source !== window || ev.origin !== location.origin) return;
  const d = ev.data;
  if (!d || typeof d !== 'object') return;
  if (d.__atelier === 'ping') return hello();
  if (d.__atelier !== 'req' || typeof d.id !== 'string' || typeof d.cmd !== 'string') return;
  let reply;
  try {
    reply = await chrome.runtime.sendMessage({ cmd: d.cmd, args: d.args || {} });
  } catch (err) {
    reply = { ok: false, error: `Extension error: ${err.message}` };
  }
  window.postMessage({ __atelier: 'res', id: d.id, ...(reply || { ok: false, error: 'No response from extension' }) }, location.origin);
});

hello();
