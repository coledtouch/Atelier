// public/vendor/ is what the browser runs; package-lock.json is what npm audit, Dependabot and `npm ci` read. These tests
// keep them the same: each vendored file must be its package's file at the installed (lockfile) version. ship runs them
// in a clean worktree after `npm ci`, so upgrading DOMPurify in the lockfile without copying it (node scripts/vendor.mjs)
// can't ship while md() still sanitizes model output with the old build (v89 review, pipeline-vendor-drift-unguarded).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VENDOR, drift, sameText } from '../scripts/vendor.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url));
const json = (p) => JSON.parse(read(p).toString('utf8'));

for (const [file, src] of VENDOR) {
  test(`public/vendor/${file} is node_modules/${src} at the lockfile version`, () => {
    assert.ok(sameText(read(`public/vendor/${file}`), read(`node_modules/${src}`)), `public/vendor/${file} differs from ${src}: run node scripts/vendor.mjs, then bump the VERSION`);
  });
}

test('every vendored library is a dependency pinned by the lockfile; mediabunny exactly (it is only ever a copied file)', () => {
  const pkg = json('package.json'), lock = json('package-lock.json');
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const name of new Set(VENDOR.map(([, src]) => src.startsWith('@') ? src.split('/').slice(0, 2).join('/') : src.split('/')[0]))) {
    assert.ok(deps[name], `${name} is in package.json`);
    const locked = lock.packages[`node_modules/${name}`];
    assert.ok(locked?.version && /^sha512-/.test(locked.integrity || ''), `${name} is pinned in package-lock.json with its integrity`);
    assert.equal(json(`node_modules/${name}/package.json`).version, locked.version, `${name}: node_modules holds the lockfile version (npm ci)`);
  }
  assert.match(pkg.devDependencies.mediabunny, /^\d+\.\d+\.\d+$/, 'mediabunny is pinned exactly');
  assert.deepEqual(drift(), []);
});

test('every vendored script the app or the worker loads is covered here', () => {
  const sw = read('public/sw.js').toString('utf8');
  const html = read('public/index.html').toString('utf8');
  const served = new Set([...`${sw}\n${html}`.matchAll(/\/vendor\/([\w.-]+\.(?:js|mjs))/g)].map((m) => m[1]));
  assert.ok(served.size >= 5, [...served].join(', '));
  for (const f of served) assert.ok(VENDOR.some(([v]) => v === f), `public/vendor/${f} has a package source in scripts/vendor.mjs`);
});
