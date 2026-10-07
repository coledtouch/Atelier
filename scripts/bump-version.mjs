// Moves every cache-busting version to <N> in one step: sw.js serves its shell cache-first, so a new app.js must never
// load an older cached module (a bare screen after v52). What moves together:
//   public/sw.js       const VERSION = 'atelier-v<N>'   (SHELL builds every ?v= from it)
//   public/index.html  every ?v=<n> already there (/app.css, /studio.css, /app.js)
//   public/*.js        every relative module specifier: from './x.js?v=<N>', import './x.js?v=<N>', import('./x.js?v=<N>')
//                      (an unversioned one gains ?v=<N>)
//   public/app.js      const APP_BUILD = '<N>'  (the version feedback reports when app.js loads without its ?v=)
// Idempotent: a second run with the same <N> changes nothing. tests/bump-version.test.mjs covers the patterns, and
// tests/service-worker.test.mjs fails when the three disagree.
// Usage: node scripts/bump-version.mjs <N>          (e.g. 53 for atelier-v53)
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const VERSION_RE = /(const VERSION = 'atelier-v)(\d+)(';)/;
// Same-origin href/src that already carry ?v= (vendor scripts, icons and the manifest have none and are left alone).
export const HTML_RE = /((?:href|src)="\/[\w./-]+\?v=)[^"&]*(")/g;
// A relative .js specifier after `from`, `import` or `import(`, with or without a ?v= already; single or double quotes.
export const IMPORT_RE = /(\b(?:from|import)\s*\(?\s*(['"])\.\/[\w./-]+\.m?js)(?:\?v=[^'"]*)?(?=\2)/g;
// app.js's fallback build number (feedback diagnostics), a plain string so it needs no import.meta parsing.
export const BUILD_RE = /(const APP_BUILD = ')\d+(';)/;

export function versionOf(sw) {
  const m = String(sw).match(VERSION_RE);
  if (!m) throw new Error("public/sw.js has no `const VERSION = 'atelier-v<N>';` line");
  return Number(m[2]);
}
export const bumpSw = (src, n) => { versionOf(src); return src.replace(VERSION_RE, `$1${n}$3`); };
export const bumpHtml = (src, n) => src.replace(HTML_RE, `$1${n}$2`);
export const bumpImports = (src, n) => src.replace(IMPORT_RE, `$1?v=${n}`);
export const bumpBuild = (src, n) => src.replace(BUILD_RE, `$1${n}$2`);
export const validN =(n) => /^[1-9]\d{0,5}$/.test(String(n));

/** Applies <n> to sw.js, index.html and every top-level .js file in `dir` (a public/ folder URL); → changed file names. */
export async function bumpFiles(n, dir = new URL('../public/', import.meta.url)) {
  if (!validN(n)) throw new Error(`Not a version number: ${n}`);
  const names = (await readdir(dir)).filter((f) => f.endsWith('.js') || f === 'index.html').sort();
  const changed = [];
  for (const name of names) {
    const url = new URL(name, dir), before = await readFile(url, 'utf8');
    let after = name === 'index.html' ? bumpHtml(before, n) : bumpImports(before, n);
    if (name === 'sw.js') after = bumpSw(after, n);
    if (name === 'app.js') after = bumpBuild(after, n);
    if (after !== before) { await writeFile(url, after); changed.push(name); }
  }
  return changed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const n = process.argv[2];
  if (!validN(n)) {
    console.error('Usage: node scripts/bump-version.mjs <N>   (moves sw.js VERSION, index.html ?v=, every module import ?v= and app.js APP_BUILD to N)');
    process.exit(1);
  }
  const from = versionOf(await readFile(new URL('../public/sw.js', import.meta.url), 'utf8'));
  if (Number(n) < from) console.warn(`Warning: going back from atelier-v${from} to atelier-v${n}.`);
  const changed = await bumpFiles(n);
  console.log(changed.length ? `atelier-v${from} → atelier-v${n}: ${changed.join(', ')}` : `Already at atelier-v${n}: nothing to change.`);
}
