// Digital Asset Links for the Atelier Android app (android/: a Trusted Web Activity with the Assist card inside).
// Chrome reads https://atelier.ciprari.ai/.well-known/assetlinks.json to show the TWA without a URL bar, and Android
// reads it to verify the app's https://atelier.ciprari.ai links (autoVerify). It must name the app's package and its
// release signing certificate, and be served as a plain static file: 200, application/json, no redirect.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');

const raw = await read('../public/.well-known/assetlinks.json');
const links = JSON.parse(raw);
const PACKAGE = 'ai.ciprari.atelier.assist';
const FINGERPRINT = /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/; // SHA-256: 32 upper-case hex bytes, colon-separated

test('one statement: handle_all_urls for the Android app, with its release certificate', () => {
  assert.ok(Array.isArray(links), 'top level is an array');
  assert.equal(links.length, 1);
  const [s] = links;
  assert.deepEqual(Object.keys(s).sort(), ['relation', 'target']);
  assert.deepEqual(s.relation, ['delegate_permission/common.handle_all_urls']);
  assert.deepEqual(Object.keys(s.target).sort(), ['namespace', 'package_name', 'sha256_cert_fingerprints']);
  assert.equal(s.target.namespace, 'android_app');
  assert.equal(s.target.package_name, PACKAGE);
  assert.ok(Array.isArray(s.target.sha256_cert_fingerprints));
  assert.equal(s.target.sha256_cert_fingerprints.length, 1);
  for (const f of s.target.sha256_cert_fingerprints) assert.match(f, FINGERPRINT);
});

test('the fingerprint is the release key the Android README pins (and the app id is the Gradle applicationId)', async () => {
  const readme = await read('../android/README.md');
  const pinned = readme.match(/signing certificate SHA-256 must be\s+`([0-9a-f]{64})`/)?.[1];
  assert.ok(pinned, 'android/README.md states the signing certificate SHA-256');
  const fp = links[0].target.sha256_cert_fingerprints[0].replaceAll(':', '').toLowerCase();
  assert.equal(fp, pinned);
  const gradle = await read('../android/app/build.gradle.kts');
  assert.match(gradle, new RegExp(`applicationId = "${PACKAGE.replaceAll('.', '\\.')}"`));
});

test('the app verifies the same host it is served from', async () => {
  const manifest = await read('../android/app/src/main/AndroidManifest.xml');
  assert.match(manifest, /<intent-filter android:autoVerify="true">[\s\S]*?android:host="atelier\.ciprari\.ai"[\s\S]*?<\/intent-filter>/);
  const wrangler = JSON.parse((await read('../wrangler.jsonc')).replace(/^\s*\/\/.*$/gm, ''));
  assert.ok(wrangler.routes.some((r) => r.pattern === 'atelier.ciprari.ai' && r.custom_domain));
});

test('served as a static asset: not routed to the Worker, not ignored, no header or redirect rule touches it', async () => {
  const wrangler = JSON.parse((await read('../wrangler.jsonc')).replace(/^\s*\/\/.*$/gm, ''));
  assert.equal(wrangler.assets.directory, './public');
  // run_worker_first patterns: none may match /.well-known/assetlinks.json (the Worker would answer instead).
  const rwf = [].concat(wrangler.assets.run_worker_first ?? []);
  const glob = (p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  for (const p of rwf) assert.ok(!glob(p).test('/.well-known/assetlinks.json'), p);
  // Wrangler uploads .well-known (it ignores only .assetsignore, _headers and _redirects unless told otherwise).
  if (existsSync(new URL('../public/.assetsignore', import.meta.url))) {
    const ignore = await read('../public/.assetsignore');
    assert.ok(!/well-known|assetlinks/.test(ignore), '.assetsignore must not drop it');
  }
  assert.ok(!existsSync(new URL('../public/_redirects', import.meta.url)) ||
    !/well-known/.test(await read('../public/_redirects')), 'no redirect for it');
  // _headers may add the site-wide security headers (/*), but must not give it its own Content-Type or a Location.
  const headers = await read('../public/_headers');
  assert.ok(!/well-known/.test(headers), '_headers has no rule of its own for /.well-known');
  assert.ok(!/^\s*Content-Type:/mi.test(headers), 'no Content-Type override anywhere in _headers');
  // .json → application/json by extension; strict JSON (no comments, no BOM, no trailing commas: JSON.parse passed).
  assert.ok(!raw.startsWith('﻿'));
});
