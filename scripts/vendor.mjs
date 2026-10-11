// The browser libraries the app loads from public/vendor/ are copies of npm packages at the versions package-lock.json
// pins. This script makes the copies: `node scripts/vendor.mjs` after `npm i <package>@<version>`, then bump the
// VERSION (node scripts/bump-version.mjs <N>) so installed apps pick them up. `--check` only reports drift (exit 1).
// tests/vendor.test.mjs fails whenever a copy and its package differ, and ship runs the tests after `npm ci` from the
// lockfile, so a library upgraded in the lockfile can't ship while the app still serves the old copy (v89 review,
// pipeline-vendor-drift-unguarded: DOMPurify sanitizes model output, and npm audit would read only the lockfile).
import { copyFileSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// public/vendor/<file> ← node_modules/<source>
export const VENDOR = Object.freeze([
  ['purify.js', 'dompurify/dist/purify.min.js'],
  ['marked.js', 'marked/lib/marked.umd.js'],
  ['highlight.js', '@highlightjs/cdn-assets/highlight.min.js'],
  ['fflate.js', 'fflate/umd/index.js'],
  ['mediabunny.js', 'mediabunny/dist/bundles/mediabunny.min.mjs'],
  ['mediabunny.LICENSE.txt', 'mediabunny/LICENSE'],
]);
const root = new URL('../', import.meta.url);
const vendored = (f) => new URL(`public/vendor/${f}`, root);
const source = (s) => new URL(`node_modules/${s}`, root);
// Git on Windows checks text out with CRLF; the bytes that matter are the same.
export const sameText = (a, b) => a.toString('utf8').replace(/\r\n/g, '\n') === b.toString('utf8').replace(/\r\n/g, '\n');

/** → the vendored files that differ from their package (or whose package is missing). */
export function drift() {
  const out = [];
  for (const [file, src] of VENDOR) {
    let from;
    try { from = readFileSync(source(src)); } catch { out.push({ file, src, why: `node_modules/${src} is missing (npm ci)` }); continue; }
    let have = null;
    try { have = readFileSync(vendored(file)); } catch { /* not vendored yet */ }
    if (!have || !sameText(have, from)) out.push({ file, src, why: have ? 'differs from its package' : 'not vendored yet' });
  }
  return out;
}

export function main(argv = process.argv.slice(2)) {
  const check = argv.includes('--check');
  const d = drift();
  if (!d.length) { console.log(`vendor: all ${VENDOR.length} files in public/vendor/ match their packages`); return 0; }
  for (const x of d) console.log(`vendor: public/vendor/${x.file} ← node_modules/${x.src}: ${x.why}`);
  if (check) return 1;
  const missing = d.filter((x) => /missing/.test(x.why));
  if (missing.length) { console.error('vendor: run npm ci first'); return 1; }
  for (const x of d) copyFileSync(source(x.src), vendored(x.file));
  console.log(`vendor: copied ${d.length} file${d.length === 1 ? '' : 's'}. Now bump the VERSION: node scripts/bump-version.mjs <N>`);
  return 0;
}

function isMain() {
  if (!process.argv[1]) return false;
  const real = (p) => { const r = realpathSync(p); return process.platform === 'win32' ? r.toLowerCase() : r; };
  try { return real(process.argv[1]) === real(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (isMain()) process.exitCode = main();
