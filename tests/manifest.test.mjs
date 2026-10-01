// The installed app's identity and launch surfaces: 3 shortcuts (Talk first), their icons, the POST share target, and
// the /share route reaching the Worker. Identity members must not change (a new name or icon set adds a WebAPK
// identity-change step; a new id makes it a different app).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const read = (p) => readFile(new URL(p, import.meta.url));
const manifest = JSON.parse(await read('../public/manifest.webmanifest'));
const wrangler = JSON.parse(String(await read('../wrangler.jsonc')).replace(/^\s*\/\/.*$/gm, '')); // full-line comments only
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

test('exactly three shortcuts, Talk first, labels within Android’s limits, URLs in scope', () => {
  assert.equal(manifest.shortcuts.length, 3);
  assert.equal(manifest.shortcuts[0].name, 'Talk to Atelier');
  assert.equal(manifest.shortcuts[0].url, '/?start=voice');
  assert.deepEqual(manifest.shortcuts.map((s) => s.url), ['/?start=voice', '/?start=ask', '/?start=image']);
  for (const s of manifest.shortcuts) {
    assert.ok(s.name.length <= 25, s.name);
    assert.ok(s.short_name && s.short_name.length <= 10, s.short_name);
    assert.ok(s.url.startsWith('/'), s.url);
  }
});
test('every shortcut has an any and a maskable icon; every icon file is a PNG of its declared size (≥ 96)', async () => {
  for (const s of manifest.shortcuts) {
    assert.ok(s.icons.some((i) => i.purpose === 'any'), `${s.name} any`);
    assert.ok(s.icons.some((i) => i.purpose === 'maskable'), `${s.name} maskable`);
    for (const i of s.icons) {
      const buf = await read(`../public${i.src}`);
      assert.deepEqual([...buf.subarray(0, 8)], PNG, i.src);
      const [w, h] = [buf.readUInt32BE(16), buf.readUInt32BE(20)];
      assert.equal(`${w}x${h}`, i.sizes, i.src);
      assert.ok(w >= 96, i.src);
      assert.equal(i.type, 'image/png');
    }
  }
});
test('share target: POST multipart to /share with title, text, url and image/video files named media', () => {
  const t = manifest.share_target;
  assert.equal(t.action, '/share'); assert.equal(t.method, 'POST'); assert.equal(t.enctype, 'multipart/form-data');
  assert.deepEqual([t.params.title, t.params.text, t.params.url], ['title', 'text', 'url']);
  assert.equal(t.params.files[0].name, 'media');
  assert.deepEqual(t.params.files[0].accept, ['image/*', 'video/*']);
});
test('no launch_handler or desktop-only handlers; identity members unchanged', () => {
  for (const k of ['launch_handler', 'protocol_handlers', 'file_handlers', 'note_taking']) assert.equal(k in manifest, false, k);
  assert.equal(manifest.id, '/'); assert.equal(manifest.start_url, '/?source=pwa'); assert.equal(manifest.scope, '/');
  assert.equal(manifest.name, 'Atelier — Personal Studio'); assert.equal(manifest.short_name, 'Atelier');
  assert.deepEqual(manifest.icons, [
    { src: '/icons/atelier-v2-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icons/atelier-v2-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icons/atelier-v2-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ]);
});
test('/share runs the Worker first (whatever static assets would do with a POST)', () => {
  assert.ok(wrangler.assets.run_worker_first.includes('/share'));
  assert.ok(wrangler.assets.run_worker_first.includes('/api/*'));
});
