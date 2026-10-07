// scripts/bump-version.mjs: one step moves sw.js VERSION, index.html ?v= and every module import ?v= to the same number.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { VERSION_RE, BUILD_RE, bumpSw, bumpHtml, bumpImports, bumpBuild, bumpFiles, versionOf, validN } from '../scripts/bump-version.mjs';

const read = (p) => readFile(new URL(`../public/${p}`, import.meta.url), 'utf8');

test('sw.js: only the VERSION line moves', () => {
  const sw = "// VERSION moves with index.html (atelier-v<n>)\nconst VERSION = 'atelier-v52';\nconst V = VERSION.slice('atelier-v'.length);\nconst SHELL = [`/app.js?v=${V}`, '/x'];\n";
  const out = bumpSw(sw, 53);
  assert.equal(out, sw.replace("'atelier-v52'", "'atelier-v53'"));
  assert.equal(versionOf(out), 53);
  assert.equal(bumpSw(out, 53), out, 'idempotent');
  assert.throws(() => bumpSw('const V = 1;', 53), /VERSION/);
  assert.ok(VERSION_RE.test("const VERSION = 'atelier-v7';"));
});

test('index.html: every existing ?v= moves; files without one are left alone', () => {
  const html = [
    '<link rel="stylesheet" href="/app.css?v=52" />', '<link rel="stylesheet" href="/studio.css?v=51" />',
    '<link rel="manifest" href="/manifest.webmanifest" />', '<script src="/vendor/marked.js"></script>',
    '<link rel="icon" href="/icons/atelier-v2-32.png" />', '<a href="https://example.com/?v=3">x</a>',
    '<script src="/app.js?v=52" type="module"></script>',
  ].join('\r\n');
  const out = bumpHtml(html, 53);
  assert.deepEqual([...out.matchAll(/="(\/[^"]*\?v=[^"]*)"/g)].map((m) => m[1]), ['/app.css?v=53', '/studio.css?v=53', '/app.js?v=53']);
  assert.ok(out.includes('href="/manifest.webmanifest"') && out.includes('src="/vendor/marked.js"') && out.includes('atelier-v2-32.png'));
  assert.ok(out.includes('https://example.com/?v=3'), 'other origins untouched');
  assert.ok(out.includes('\r\n'), 'line endings kept');
  assert.equal(bumpHtml(out, 53), out, 'idempotent');
});

test('module imports: versioned ones move, unversioned ones gain ?v=, nothing else changes', () => {
  const src = [
    "import { a, b } from './tester.js?v=52';",
    "import { c } from './video.js';",
    'import { d } from "./context.js?v=51";',
    "import './side.js';",
    "export { e } from './readaloud.js?v=52';",
    "const m = await import('./lazy.js');",
    "import marked from '/vendor/marked.js';",
    "import { x } from '../src/tts.js';",
    "fetch('./data.js'); const s = 'from ./video.js';",
    "const url = './video.js';",
  ].join('\r\n');
  const out = bumpImports(src, 53);
  assert.deepEqual(out.split('\r\n'), [
    "import { a, b } from './tester.js?v=53';",
    "import { c } from './video.js?v=53';",
    'import { d } from "./context.js?v=53";',
    "import './side.js?v=53';",
    "export { e } from './readaloud.js?v=53';",
    "const m = await import('./lazy.js?v=53');",
    "import marked from '/vendor/marked.js';",
    "import { x } from '../src/tts.js';",
    "fetch('./data.js'); const s = 'from ./video.js';",
    "const url = './video.js';",
  ]);
  assert.equal(bumpImports(out, 53), out, 'idempotent');
  // multi-line imports are versioned too
  assert.equal(bumpImports("import {\n  a,\n} from './x.js';", 9), "import {\n  a,\n} from './x.js?v=9';");
});

test('app.js APP_BUILD: the feedback fallback build moves with the rest, and nothing else does', () => {
  const src = "const APP_BUILD = '76';\nconst x = '76'; // const APP_BUILD = 'other'\n";
  assert.equal(bumpBuild(src, 78), src.replace("const APP_BUILD = '76';", "const APP_BUILD = '78';"));
  assert.equal(bumpBuild(bumpBuild(src, 78), 78), bumpBuild(src, 78), 'idempotent');
  assert.ok(BUILD_RE.test("const APP_BUILD = '7';"));
});

test('version numbers: positive integers only', () => {
  for (const ok of [1, 53, '53', 999999]) assert.ok(validN(ok), String(ok));
  for (const bad of [0, '053', '', 'v53', '5.3', -1, 1_000_000, undefined]) assert.ok(!validN(bad), String(bad));
});

test('bumpFiles rewrites a public folder in one step, and a second run changes nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atelier-bump-'));
  try {
    const url = pathToFileURL(dir + '/');
    await writeFile(new URL('sw.js', url), "const VERSION = 'atelier-v52';\n");
    await writeFile(new URL('index.html', url), '<script src="/app.js?v=52" type="module"></script>\n');
    await writeFile(new URL('app.js', url), "import { a } from './a.js?v=52';\r\nimport { b } from './b.js';\r\nconst APP_BUILD = '52';\r\n");
    await writeFile(new URL('a.js', url), 'export const a = 1;\n');
    await writeFile(new URL('notes.txt', url), "from './a.js'\n");
    assert.deepEqual(await bumpFiles('53', url), ['app.js', 'index.html', 'sw.js']);
    assert.equal(await readFile(new URL('app.js', url), 'utf8'), "import { a } from './a.js?v=53';\r\nimport { b } from './b.js?v=53';\r\nconst APP_BUILD = '53';\r\n");
    assert.equal(await readFile(new URL('notes.txt', url), 'utf8'), "from './a.js'\n", 'only .js files and index.html');
    assert.deepEqual(await bumpFiles(53, url), [], 'idempotent');
    await assert.rejects(bumpFiles('x', url), /version number/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the repo is consistent: bumping to the current VERSION would change nothing the app loads', async () => {
  const n = versionOf(await read('sw.js'));
  assert.equal(bumpHtml(await read('index.html'), n), await read('index.html'));
  // feedback's fallback version: no hardcoded number left behind by a bump
  const app = await read('app.js');
  assert.ok(BUILD_RE.test(app), 'app.js has const APP_BUILD');
  assert.equal(bumpBuild(app, n), app, `app.js APP_BUILD is ${n}`);
  assert.doesNotMatch(app, /searchParams\.get\('v'\) \|\| '\d+'/, 'no hardcoded version fallback');
  const specs = (s) => [...s.matchAll(/\b(?:from|import)\s*\(?\s*['"]\.\/[^'"\n]+['"]/g)].map((m) => m[0]);
  const seen = new Set(), todo = ['app.js'];
  while (todo.length) {
    const f = todo.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    const src = await read(f);
    assert.deepEqual(specs(src), specs(bumpImports(src, n)), `${f}: every relative import is at ?v=${n}`);
    for (const [, p] of src.matchAll(/\b(?:from|import)\s*\(?\s*['"]\.\/([\w./-]+\.m?js)/g)) todo.push(p);
  }
});
