// tests/assist.test.mjs: the Atelier Assist bridge (public/assist.js) against a fake window.AtelierAssist.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssist, bridgeOf, safePath, toBlob, SAVE_MAX } from '../public/assist.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
function fakeWin({ bridge = true } = {}) {
  const sent = [];
  const listeners = [];
  const b = bridge ? {
    postMessage: (m) => sent.push(m),
    addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
  } : null;
  const win = { AtelierAssist: b };
  const reply = (obj) => listeners.forEach((fn) => fn({ data: typeof obj === 'string' ? obj : JSON.stringify(obj) }));
  const timers = { setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 20)) };
  return { win, sent, reply, timers };
}
const parsed = (sent) => sent.filter((m) => typeof m === 'string').map((m) => JSON.parse(m));

test('outside the app: off, every call a no-op, hello is null', async () => {
  const { win, timers } = fakeWin({ bridge: false });
  const a = createAssist({ win, timers });
  assert.equal(a.on, false);
  assert.equal(await a.hello, null);
  assert.equal(await a.micState(), 'prompt');
  assert.equal(a.close(), false);
  assert.equal(a.openApp('/'), false);
  assert.equal(a.canSave(), false);
  assert.equal(await a.save(new Blob(['x']), 'x.txt'), false);
  assert.equal(bridgeOf({ AtelierAssist: { postMessage: 1 } }), null);
});

test('inside the app: ready → hello, listen and sheet reach their handlers', async () => {
  const { win, sent, reply, timers } = fakeWin();
  const heard = [];
  const a = createAssist({ win, timers, onListen: (m) => heard.push(['listen', m.invocation]), onSheet: (m) => heard.push(['sheet', m.expanded]) });
  assert.equal(a.on, true);
  assert.deepEqual(parsed(sent), [{ type: 'ready' }]);
  reply({ type: 'hello', v: 1, mic: 'denied', save: true, invocation: 'assist' });
  assert.equal((await a.hello).invocation, 'assist');
  assert.equal(await a.micState(), 'denied');
  reply({ type: 'listen', invocation: 'assist' });
  reply({ type: 'sheet', expanded: true });
  reply('not json');
  reply({ nope: 1 });
  assert.deepEqual(heard, [['listen', 'assist'], ['sheet', true]]);
});

test('no answer from the app: hello settles to null, mic stays prompt', async () => {
  const { win, timers } = fakeWin();
  const a = createAssist({ win, timers });
  assert.equal(await a.hello, null);
  assert.equal(await a.micState(), 'prompt');
});

test('open-app only sends same-site paths', () => {
  assert.equal(safePath('/?start=ask'), '/?start=ask');
  for (const bad of ['//evil.example/', 'https://evil.example/', 'javascript:alert(1)', '/a\\b', '/a\nb', '']) assert.equal(safePath(bad), '/');
  const { win, sent, timers } = fakeWin();
  const a = createAssist({ win, timers });
  a.openApp('//evil.example');
  assert.deepEqual(parsed(sent).at(-1), { type: 'open-app', path: '/' });
});

test('theme: #rrggbb only, and only when it changes', () => {
  const { win, sent, timers } = fakeWin();
  const a = createAssist({ win, timers });
  assert.equal(a.theme(' #0E0D0B '), true);
  assert.equal(a.theme('#0e0d0b'), false);
  assert.equal(a.theme('red'), false);
  assert.equal(a.theme('#f3eee3'), true);
  assert.deepEqual(parsed(sent).filter((m) => m.type === 'theme').map((m) => m.bg), ['#0e0d0b', '#f3eee3']);
});

test('save: save-begin then exactly one ArrayBuffer, only when the app said save', async () => {
  const { win, sent, reply, timers } = fakeWin();
  const a = createAssist({ win, timers });
  assert.equal(await a.save(new Blob(['hi'], { type: 'text/plain' }), 'note.txt'), false); // no hello yet
  reply({ type: 'hello', save: true });
  await a.hello;
  assert.equal(await a.save(new Blob(['hi'], { type: 'text/plain' }), 'note.txt'), true);
  const begin = parsed(sent).find((m) => m.type === 'save-begin');
  assert.deepEqual(begin, { type: 'save-begin', name: 'note.txt', mime: 'text/plain', size: 2 });
  assert.ok(sent.at(-1) instanceof ArrayBuffer);
  assert.equal(new TextDecoder().decode(sent.at(-1)), 'hi');
  assert.equal(await a.save({ size: SAVE_MAX + 1, type: 'video/mp4', arrayBuffer: async () => new ArrayBuffer(1) }, 'big.mp4'), false);
  assert.equal(await a.save(new Blob([]), 'empty'), false);
});

test('toBlob: data: URLs (base64 and plain), text and Blobs', async () => {
  const png = toBlob('data:image/png;base64,iVBORw0KGgo=');
  assert.equal(png.type, 'image/png');
  assert.deepEqual([...new Uint8Array(await png.arrayBuffer())], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const txt = toBlob('data:text/plain,hello%20there');
  assert.equal(await txt.text(), 'hello there');
  const json = toBlob('{"a":1}', 'application/json');
  assert.equal(json.type, 'application/json');
  const b = new Blob(['x']);
  assert.equal(toBlob(b), b);
});
