// Zips ./extension into ./public/atelier-browser.zip (served from the site for easy install).
// The default is the production pack (what `npm run deploy` ships): local development hosts are dropped from the
// manifest's content script, and with them from the origins the service worker accepts (it reads them from the
// manifest). `node scripts/pack-extension.mjs --dev` keeps localhost and writes ./atelier-browser-dev.zip instead,
// outside public/ so it is never served or deployed. For day-to-day work, "Load unpacked" on ./extension works too.
import { readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

export const PROD_ZIP = 'public/atelier-browser.zip';
export const DEV_ZIP = 'atelier-browser-dev.zip';
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$|\.localhost$/i;

// True for a match pattern / URL on a local development host (http://localhost:8787/*, http://127.0.0.1/*, …).
export function isLocalPattern(pattern) {
  const host = /^[a-z*]+:\/\/([^/]*)/i.exec(String(pattern))?.[1]?.replace(/:\d+$/, '') ?? '';
  return LOCAL_HOST.test(host);
}

// The manifest the production pack ships: no local hosts anywhere the extension could run or connect.
export function productionManifest(manifest) {
  const out = structuredClone(manifest);
  out.content_scripts = (out.content_scripts || [])
    .map((cs) => ({ ...cs, matches: (cs.matches || []).filter((m) => !isLocalPattern(m)) }))
    .filter((cs) => cs.matches.length);
  if (out.host_permissions) out.host_permissions = out.host_permissions.filter((m) => !isLocalPattern(m));
  if (/localhost|127\.0\.0\.1|\[::1\]/i.test(JSON.stringify(out))) throw new Error('The production manifest still mentions a local host.');
  if (!out.content_scripts.length) throw new Error('The production manifest has no content script left.');
  return out;
}

export function collectFiles(root) {
  const files = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else files[relative(root, p).split(sep).join('/')] = readFileSync(p);
    }
  };
  walk(root);
  return files;
}

// → { files (name → bytes, as zipped), manifest (as shipped), zip }
export function packExtension({ root = 'extension', dev = false } = {}) {
  const files = collectFiles(root);
  const source = JSON.parse(Buffer.from(files['manifest.json']).toString('utf8'));
  const manifest = dev ? source : productionManifest(source);
  files['manifest.json'] = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  return { files, manifest, zip: zipSync(files, { level: 9 }) };
}

// True when this file is the script node was started with. Node reports the main module's URL with junctions and
// symlinks resolved but leaves argv[1] as typed, so both are compared as real paths. Comparing them as given made the
// pack skip itself silently when the project was opened through a link, and `npm run deploy` then shipped the old zip.
export function isCli(argv1 = process.argv[1], url = import.meta.url) {
  if (!argv1) return false;
  const real = (p) => { const r = realpathSync(p); return process.platform === 'win32' ? r.toLowerCase() : r; };
  try { return real(argv1) === real(fileURLToPath(url)); } catch { return false; }
}

if (isCli()) {
  const dev = process.argv.includes('--dev');
  const { files, manifest, zip } = packExtension({ dev });
  const out = dev ? DEV_ZIP : PROD_ZIP;
  writeFileSync(out, zip);
  console.log(`packed ${Object.keys(files).length} files (v${manifest.version}, ${dev ? 'dev: localhost kept' : 'production'}) → ${out}`);
}
