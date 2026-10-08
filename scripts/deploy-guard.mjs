// wrangler.jsonc's build.command. Wrangler runs it before it bundles the Worker, for `wrangler deploy`, `wrangler
// versions upload`, `wrangler dev` and `wrangler types` alike, and names the command in WRANGLER_COMMAND (wrangler
// 4.144 passes it to custom builds). A non-zero exit stops wrangler before anything is uploaded.
// A deploy (or a version upload) goes ahead only when it comes from:
//   npm run deploy / npm run ship (scripts/ship.mjs): ATELIER_SHIP=1, from inside the clean ship worktree in the temp
//     folder, after the tree, VERSION, file-name, live-record and clean-checkout test checks and the go-ahead;
//   npm run deploy:raw (scripts/ship.mjs --raw): ATELIER_SHIP=raw, after its own confirmation.
// So `npx wrangler deploy` from this folder (unbumped, untested, uncommitted) stops here. dev and types never do.
// tests/ship.test.mjs covers guardDecision.
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSafeTempDir } from './ship.mjs';

export const FREE_COMMANDS = Object.freeze(['dev', 'types']);

/** command: WRANGLER_COMMAND; ship: ATELIER_SHIP; root: this checkout's folder; tmp: the OS temp folder. → {ok, message} */
export function guardDecision({ command, ship, root, tmp, platform = process.platform }) {
  if (FREE_COMMANDS.includes(command)) return { ok: true, message: '' };
  const p = platform === 'win32' ? path.win32 : path.posix;
  const inShipWorktree = Boolean(root) && p.basename(p.resolve(root)) === 'atelier' && isSafeTempDir(p.dirname(p.resolve(root)), tmp, platform);
  if (ship === '1' && inShipWorktree) return { ok: true, message: 'deploy guard: npm run ship, from its clean worktree' };
  if (ship === 'raw') return { ok: true, message: 'deploy guard: npm run deploy:raw (confirmed, unchecked)' };
  return {
    ok: false,
    message: [
      `Refusing \`wrangler ${command || 'deploy'}\`: Atelier deploys only through npm run deploy (scripts/ship.mjs), which checks`,
      'the tree is committed, the VERSION is bumped past the live one, the file names match git and the tests pass in a',
      'clean checkout, then deploys that checkout. Run: npm run deploy -- --dry-run, then npm run deploy.',
      '(This guard is wrangler.jsonc\'s build.command, scripts/deploy-guard.mjs. Nothing was uploaded.)',
    ].join('\n'),
  };
}

function isMain() {
  if (!process.argv[1]) return false;
  const real = (x) => { const r = realpathSync(x); return process.platform === 'win32' ? r.toLowerCase() : r; };
  try { return real(process.argv[1]) === real(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isMain()) {
  // Real paths on both sides: Windows may name the temp folder in 8.3 form (C:\Users\COLE~1\…) or another case.
  const real = (x) => { try { return realpathSync.native(path.resolve(x)); } catch { return path.resolve(x); } };
  const d = guardDecision({
    command: process.env.WRANGLER_COMMAND, ship: process.env.ATELIER_SHIP,
    root: real(fileURLToPath(new URL('..', import.meta.url))), tmp: real(tmpdir()),
  });
  if (!d.ok) { console.error(d.message); process.exitCode = 1; } else if (d.message) console.log(d.message);
}
