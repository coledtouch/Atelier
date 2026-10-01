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
});
test('GET /share: 303 to /', async () => {
  const { e } = env();
  const r = await worker.fetch(new Request('https://atelier.ciprari.ai/share?text=hello'), e);
  assert.equal(r.status, 303); assert.equal(r.headers.get('location'), '/');
  assert.ok(!r.headers.get('location').includes('hello'));
});
test('other paths still go to the static assets', async () => {
  const { e, assets } = env();
  assert.equal(await (await worker.fetch(new Request('https://atelier.ciprari.ai/?share=sabc123def0'), e)).text(), 'index');
  assert.equal(await (await worker.fetch(new Request('https://atelier.ciprari.ai/shared'), e)).text(), 'index');
  assert.equal(assets.length, 2);
});
