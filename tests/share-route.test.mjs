// The Worker's /share fallback (only reached when no service worker answers the share POST): 303 to /?share=lost,
// no-store, and the body is never read, parsed or echoed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { worker, makeEnv } from './tester-env.mjs';

function env() {
  const { env: e } = makeEnv();
  const assets = [];
  e.ASSETS = { fetch: async (r) => { assets.push(r.url); return new Response('index'); } };
  return { e, assets };
}
test('POST /share: 303 to /?share=lost, no-store, body untouched, nothing echoed', async () => {
  const { e, assets } = env();
  const fd = new FormData();
  fd.set('text', 'secret words https://x.test'); fd.set('title', 'Private');
  fd.set('media', new File([new Uint8Array([1, 2, 3])], 'p.png', { type: 'image/png' }));
  const req = new Request('https://atelier.ciprari.ai/share', { method: 'POST', body: fd, headers: { origin: 'https://evil.test' } });
  const r = await worker.fetch(req, e);
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/?share=lost');
  assert.match(r.headers.get('cache-control'), /no-store/);
  assert.equal(req.bodyUsed, false);
  assert.equal(await r.text(), '');
  assert.deepEqual(assets, []);
  assert.ok(!/secret|Private/.test(JSON.stringify([...r.headers])));
  // public/_headers never applies to /share (run_worker_first): the Worker sets its own security headers, as on /api.
  assert.equal(r.headers.get('strict-transport-security'), 'max-age=31536000');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  // plain http (wrangler dev): no HSTS
  const plain = await worker.fetch(new Request('http://127.0.0.1:8787/share', { method: 'POST', body: 'x' }), e);
  assert.equal(plain.headers.get('strict-transport-security'), null);
  assert.equal(plain.headers.get('x-content-type-options'), 'nosniff');
});
test('GET /share: 303 to /', async () => {
  const { e } = env();
  const r = await worker.fetch(new Request('https://atelier.ciprari.ai/share?text=hello'), e);
  assert.equal(r.status, 303); assert.equal(r.headers.get('location'), '/');
  assert.ok(!r.headers.get('location').includes('hello'));
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff'); assert.equal(r.headers.get('strict-transport-security'), 'max-age=31536000');
});
test('other paths still go to the static assets', async () => {
  const { e, assets } = env();
  assert.equal(await (await worker.fetch(new Request('https://atelier.ciprari.ai/?share=sabc123def0'), e)).text(), 'index');
  assert.equal(await (await worker.fetch(new Request('https://atelier.ciprari.ai/shared'), e)).text(), 'index');
  assert.equal(assets.length, 2);
});
test('the accepted quick-launch risks live in the repo (docs/quick-launch.md), and the code points there', async () => {
  const { readFile } = await import('node:fs/promises');
  const read = (f) => readFile(new URL('../' + f, import.meta.url), 'utf8');
  const doc = await read('docs/quick-launch.md');
  for (const words of ['## Accepted residual risks', 'History sync', '413', 'formData()', 'run_worker_first', 'untrusted', 'browser_open', 'Talk, then send'])
    assert.ok(doc.includes(words), words);
  for (const f of ['src/worker.js', 'public/sw.js', 'public/app.js', 'public/launch.js'])
    assert.ok(!(await read(f)).includes('quicklaunch-integration'), `${f}: no reference to a document outside the repo`);
  for (const f of ['src/worker.js', 'public/sw.js', 'public/app.js']) assert.ok((await read(f)).includes('docs/quick-launch.md'), f);
});
