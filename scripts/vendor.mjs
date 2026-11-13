// The browser libraries the app loads from public/vendor/ are copies of npm packages at the versions package-lock.json
// pins. This script makes the copies: `node scripts/vendor.mjs` after `npm i <package>@<version>`, then bump the
// VERSION (node scripts/bump-version.mjs <N>) so installed apps pick them up. `--check` only reports drift (exit 1).
// tests/vendor.test.mjs fails whenever a copy and its package differ, and ship runs the tests after `npm ci` from the
// lockfile, so a library upgraded in the lockfile can't ship while the app still serves the old copy (v89 review,
// pipeline-vendor-drift-unguarded: DOMPurify sanitizes model output, and npm audit would read only the lockfile).
import { copyFileSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// public/vendor/<file> ← node_modules/<source>
export const VENDOR = Object.freeze([
  ['purify.js', 'dompurify/dist/purify.min.js'],
  ['marked.js', 'marked/lib/marked.umd.js'],
  ['highlight.js', '@highlightjs/cdn-assets/highlight.min.js'],
  ['fflate.js', 'fflate/umd/index.js'],
  ['mediabunny.js', 'mediabunny/dist/bundles/mediabunny.min.mjs'],
  ['mediabunny.LICENSE.txt', 'mediabunny/LICENSE'],
  ['pdf.js', 'pdfjs-dist/legacy/build/pdf.min.mjs'], // v113: reading attached PDFs (lazy, app.js loadPdf)
  ['pdf.worker.js', 'pdfjs-dist/legacy/build/pdf.worker.min.mjs'],
  ['pdf.LICENSE.txt', 'pdfjs-dist/LICENSE'],
  // v114: what pdf.js fetches on demand from /vendor/pdfjs/ (app.js PDF_ASSETS). Its image decoders for fax (CCITT),
  // JBIG2 and JPEG 2000, the compressions of scanned PDFs: without them those pages rendered blank. Each has a wasm
  // build and a plain-JavaScript one pdf.js falls back to. qcms converts ICC color profiles.
  ['pdfjs/jbig2.wasm', 'pdfjs-dist/wasm/jbig2.wasm'],
  ['pdfjs/jbig2_nowasm_fallback.js', 'pdfjs-dist/wasm/jbig2_nowasm_fallback.js'],
  ['pdfjs/openjpeg.wasm', 'pdfjs-dist/wasm/openjpeg.wasm'],
  ['pdfjs/openjpeg_nowasm_fallback.js', 'pdfjs-dist/wasm/openjpeg_nowasm_fallback.js'],
  ['pdfjs/qcms_bg.wasm', 'pdfjs-dist/wasm/qcms_bg.wasm'],
  ['pdfjs/LICENSE_JBIG2', 'pdfjs-dist/wasm/LICENSE_JBIG2'],
  ['pdfjs/LICENSE_PDFJS_JBIG2', 'pdfjs-dist/wasm/LICENSE_PDFJS_JBIG2'],
  ['pdfjs/LICENSE_OPENJPEG', 'pdfjs-dist/wasm/LICENSE_OPENJPEG'],
  ['pdfjs/LICENSE_PDFJS_OPENJPEG', 'pdfjs-dist/wasm/LICENSE_PDFJS_OPENJPEG'],
  ['pdfjs/LICENSE_QCMS', 'pdfjs-dist/wasm/LICENSE_QCMS'],
  ['pdfjs/LICENSE_PDFJS_QCMS', 'pdfjs-dist/wasm/LICENSE_PDFJS_QCMS'],
]);
// Whole folders, copied file for file: public/vendor/<dir>/ ← node_modules/<source>/
// pdfjs/cmaps: the character maps a PDF in Chinese, Japanese or Korean names instead of carrying (169 small files and
// their license). Without them pdf.js cannot turn those PDFs' text into characters.
export const VENDOR_DIRS = Object.freeze([
  ['pdfjs/cmaps', 'pdfjs-dist/cmaps'],
]);
const root = new URL('../', import.meta.url);
const vendored = (f) => new URL(`public/vendor/${f}`, root);
const source = (s) => new URL(`node_modules/${s}`, root);
// Git on Windows checks text out with CRLF; the bytes that matter are the same.
export const sameText = (a, b) => a.toString('utf8').replace(/\r\n/g, '\n') === b.toString('utf8').replace(/\r\n/g, '\n');
// A compiled module or a packed character map is compared byte for byte: Git leaves those alone.
const BINARY = /\.(wasm|bcmap)$/;
const same = (file, a, b) => (BINARY.test(file) ? Buffer.compare(a, b) === 0 : sameText(a, b));

/** Every [vendored file, package source] pair: the listed files, then each file of the listed folders. */
export function pairs() {
  const out = VENDOR.map(([file, src]) => [file, src]);
  for (const [dir, src] of VENDOR_DIRS) {
    let names = null;
    try { names = readdirSync(source(src), { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort(); } catch { /* the package is missing: one entry reports it */ }
    if (names) for (const n of names) out.push([`${dir}/${n}`, `${src}/${n}`]); else out.push([`${dir}/`, `${src}/`]);
  }
  return out;
}

/** → the vendored files that differ from their package (or whose package is missing), and stray files in a vendored folder. */
export function drift() {
  const out = [];
  for (const [file, src] of pairs()) {
    let from;
    try { from = readFileSync(source(src)); } catch { out.push({ file, src, why: `node_modules/${src} is missing (npm ci)` }); continue; }
    let have = null;
    try { have = readFileSync(vendored(file)); } catch { /* not vendored yet */ }
    if (!have || !same(file, have, from)) out.push({ file, src, why: have ? 'differs from its package' : 'not vendored yet' });
  }
  // A file the package no longer ships must not linger in a copied folder.
  for (const [dir, src] of VENDOR_DIRS) {
    let have = [], from = null;
    try { have = readdirSync(vendored(dir)); } catch { /* not vendored yet */ }
    try { from = new Set(readdirSync(source(src))); } catch { continue; }
    for (const n of have) if (!from.has(n)) out.push({ file: `${dir}/${n}`, src: `${src}/${n}`, why: 'is not in its package any more: delete it' });
  }
  return out;
}

export function main(argv = process.argv.slice(2)) {
  const check = argv.includes('--check');
  const d = drift();
  if (!d.length) { console.log(`vendor: all ${pairs().length} files in public/vendor/ match their packages`); return 0; }
  for (const x of d) console.log(`vendor: public/vendor/${x.file} ← node_modules/${x.src}: ${x.why}`);
  if (check) return 1;
  const missing = d.filter((x) => /missing/.test(x.why));
  if (missing.length) { console.error('vendor: run npm ci first'); return 1; }
  const stray = d.filter((x) => /delete it/.test(x.why));
  if (stray.length) { console.error('vendor: delete the files above that their package no longer ships, then run this again'); return 1; }
  for (const x of d) { mkdirSync(new URL('.', vendored(x.file)), { recursive: true }); copyFileSync(source(x.src), vendored(x.file)); }
  console.log(`vendor: copied ${d.length} file${d.length === 1 ? '' : 's'}. Now bump the VERSION: node scripts/bump-version.mjs <N>`);
  return 0;
}

function isMain() {
  if (!process.argv[1]) return false;
  const real = (p) => { const r = realpathSync(p); return process.platform === 'win32' ? r.toLowerCase() : r; };
  try { return real(process.argv[1]) === real(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (isMain()) process.exitCode = main();
