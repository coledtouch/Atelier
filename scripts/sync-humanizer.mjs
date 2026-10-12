// Cole's humanizer, kept in step with its canonical copy: `const HUMANIZER` in coleos-api/src/worker.js.
//
//   node scripts/sync-humanizer.mjs           re-copy it into public/humanizer.js when it changed (prints the diff)
//   node scripts/sync-humanizer.mjs --check   write nothing; exit 1 when public/humanizer.js differs (prints the diff)
//   --from <worker.js>                         another checkout (or set COLEOS_WORKER)
//
// It also compares the canonical lint (HUMANIZER_BANNED, HUMANIZER_WARN in the same file) with the port in
// tests/humanizer-lint.mjs and reports any pattern or label that moved; those are ported by hand.
// When the coleos-api checkout isn't on this machine it says so, changes nothing and exits 0.
// A copy that changed needs a version bump before it ships (sw.js caches /humanizer.js?v=<n>).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'public', 'humanizer.js');
const PARTS = ['OneDrive', 'Documents', 'Claude', 'Projects', 'Coen Business', 'coleos-api', 'src', 'worker.js'];
export const CANONICAL = join(homedir(), ...PARTS);
const SHOWN_PATH = ['~', ...PARTS].join('/'); // in the header: the same on every machine, no user name

/** worker.js source → the HUMANIZER template's text, exactly as written between its backticks. */
export function canonicalText(src) {
  const m = /\nconst HUMANIZER = `([^`]*)`;\n/.exec(String(src).replace(/\r\n/g, '\n'));
  if (!m) throw new Error('no `const HUMANIZER = `…`;` in the canonical file');
  if (/\$\{|\\/.test(m[1])) throw new Error('the canonical text holds ${…} or a backslash: copy it by hand');
  return m[1];
}

/** The whole of public/humanizer.js for this text, copied on `date` (YYYY-MM-DD). */
export function moduleSource(text, date) {
  return `// Cole's humanizer: the owner's writing rules for what Atelier writes in his name. public/app.js adds it to the system
// prompt for "As me" (voiceBlock) and for the accounts agent's tool arguments that go out under his name (nameRules, SENT_AS_THEM).
// Ask, Code, Ideas, Build, the helpers and titles never get it.
// Source: const HUMANIZER in ${SHOWN_PATH}, copied ${date}.
// The text is a byte-for-byte copy: don't edit it here. \`node scripts/sync-humanizer.mjs\` re-copies it, and --check
// reports a diff. tests/humanizer-copy.test.mjs compares the two whenever the coleos-api checkout is on this machine.
export const HUMANIZER = \`${text}\`;
`;
}

/** The text public/humanizer.js holds now ('' when there is none). */
export function currentText(src) {
  const m = /\nexport const HUMANIZER = `([^`]*)`;\n/.exec(String(src).replace(/\r\n/g, '\n'));
  return m ? m[1] : '';
}

// A line diff: the lines only in a (−) and only in b (+), in order, with one line of context.
export function lineDiff(a, b) {
  const x = a.split('\n'), y = b.split('\n'), n = x.length, m = y.length;
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) { out.push(['  ', x[i]]); i++; j++; } else if (i < n && (j >= m || L[i + 1][j] >= L[i][j + 1])) out.push(['- ', x[i++]]); else out.push(['+ ', y[j++]]);
  }
  return out.filter((d, k) => d[0] !== '  ' || out[k - 1]?.[0].trim() || out[k + 1]?.[0].trim()).map(([s, t]) => s + t).join('\n');
}

// [regex literal, label] rows of a `const NAME = [ … ];` array, or a single regex literal for `const NAME = /…/flags;`.
function lintRows(src, name) {
  const s = String(src).replace(/\r\n/g, '\n');
  const one = new RegExp(`\\nconst ${name} = (\\/.+\\/[a-z]*);\\n`).exec(s);
  if (one) return [[one[1], '']];
  const at = s.indexOf(`\nconst ${name} = [\n`);
  if (at < 0) return null;
  const body = s.slice(at, s.indexOf('\n];\n', at));
  return [...body.matchAll(/^\s*\[(\/.+\/[a-z]*), "(.*)"\],?$/gm)].map((r) => [r[1], r[2]]);
}

/** The canonical lint patterns that differ from tests/humanizer-lint.mjs's port → ['…'] (empty when they agree). */
export async function lintDrift(src) {
  const port = await import(pathToFileURL(join(ROOT, 'tests', 'humanizer-lint.mjs')).href);
  const out = [];
  const banned = lintRows(src, 'HUMANIZER_BANNED'), warn = lintRows(src, 'HUMANIZER_WARN');
  if (!banned) out.push('HUMANIZER_BANNED is gone from the canonical file');
  else if (banned[0][0] !== String(port.HUMANIZER_BANNED)) out.push(`HUMANIZER_BANNED moved:\n  canonical ${banned[0][0]}\n  port      ${port.HUMANIZER_BANNED}`);
  if (!warn) out.push('HUMANIZER_WARN is gone from the canonical file');
  else {
    const ours = port.HUMANIZER_WARN.map(([rx, label]) => [String(rx), label]);
    if (warn.length !== ours.length) out.push(`HUMANIZER_WARN has ${warn.length} patterns, the port ${ours.length}`);
    warn.forEach(([rx, label], k) => { if (rx !== ours[k]?.[0] || label !== ours[k]?.[1]) out.push(`HUMANIZER_WARN[${k}] moved:\n  canonical ${rx} "${label}"\n  port      ${ours[k]?.[0]} "${ours[k]?.[1]}"`); });
  }
  if (!/\bn > 16\b/.test(src)) out.push('the 16-word sentence rule (n > 16) is gone from the canonical file');
  return out;
}

async function main(argv) {
  const check = argv.includes('--check');
  const k = argv.indexOf('--from');
  const from = k >= 0 ? argv[k + 1] : process.env.COLEOS_WORKER || CANONICAL;
  if (!existsSync(from)) {
    console.log(`sync-humanizer: ${from} isn't on this machine, so nothing was compared or copied.`);
    return 0;
  }
  const src = readFileSync(from, 'utf8');
  const text = canonicalText(src);
  const had = existsSync(OUT) ? currentText(readFileSync(OUT, 'utf8')) : '';
  let code = 0;
  if (had === text) console.log('sync-humanizer: public/humanizer.js matches the canonical text.');
  else {
    console.log(had ? `sync-humanizer: public/humanizer.js differs from the canonical text:\n${lineDiff(had, text)}` : 'sync-humanizer: public/humanizer.js is missing.');
    if (check) code = 1;
    else {
      writeFileSync(OUT, moduleSource(text, new Date().toISOString().slice(0, 10)));
      console.log('sync-humanizer: copied. Bump the version before shipping (node scripts/bump-version.mjs <n>).');
    }
  }
  const drift = await lintDrift(src);
  if (drift.length) { console.log(`sync-humanizer: the canonical lint moved; port it to tests/humanizer-lint.mjs by hand:\n${drift.join('\n')}`); if (check) code = 1; }
  return code;
}

const self = (p) => resolve(p).toLowerCase();
if (process.argv[1] && self(process.argv[1]) === self(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2));
