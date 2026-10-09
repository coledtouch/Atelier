// How app.js wires Build app data (public/appdata.js) in, read from the source: the preview sandbox is unchanged, every
// preview document comes from the bridge, the store is per workspace and goes with Clear this device and a deleted
// thread, and the CSP still runs the inline shim in a srcdoc frame.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { COPY } from '../public/sync.js';

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
const [APP, HEADERS, SW, PKG, PRIVACY, FIXTURE, INDEX] = await Promise.all(['public/app.js', 'public/_headers', 'public/sw.js', 'package.json', 'public/privacy.html', 'scripts/review-server.mjs', 'public/index.html'].map(read));
const PUBLIC_JS = await Promise.all((await readdir(new URL('../public/', import.meta.url))).filter((f) => f.endsWith('.js')).map(async (f) => [f, await read(`public/${f}`)]));
const SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock allow-downloads';

test('the Build preview sandbox is unchanged: no allow-same-origin, nothing that reaches Atelier, in every frame', () => {
  const flags = [...APP.matchAll(/sandbox(?:="|\s*=\s*')([^"']*)["']/g)].map((m) => m[1]);
  assert.deepEqual(flags, [SANDBOX, SANDBOX], 'the card and the viewer');
  for (const [f, file] of PUBLIC_JS) {
    const src = file.replace(/(^|\s)\/\/ .*$/gm, ''); // code, not the comments that explain why the flag is absent
    for (const flag of ['allow-same-origin', 'allow-top-navigation', 'allow-popups-to-escape-sandbox', 'allow-storage-access']) assert.ok(!src.includes(flag), `${f} never grants ${flag}`);
  }
});

test('every preview document comes from the bridge (shim first); app.js never writes srcdoc itself', () => {
  assert.equal((APP.match(/\.srcdoc\s*=/g) || []).length, 0);
  assert.match(APP, /appBridge\.mount\(\$\('iframe', out\), \{ key, html: e\.app\.html \}\)/, 'the card');
  assert.match(APP, /appBridge\.mount\(f, \{ key: app, html \}\)/, 'Full screen, the Library and code previews (no key: saves nothing)');
  assert.match(APP, /case 'app-full': return openViewer\(\{ title: e\.app\.title, html: e\.app\.html, app: appKeyOf\(e\),/);
  assert.match(APP, /openViewer\(\{ title: x\.e\.app\.title, html: x\.e\.app\.html, app: appKey\(x\.t\.id, x\.t\.entries, x\.e\),/);
  // Download is the app as generated: no data in a file that can be shared.
  assert.match(APP, /case 'app-download': return download\(e\.app\.html, /);
  assert.match(APP, /window\.addEventListener\('message', \(ev\) => \{ appBridge\.onMessage\(ev\); \}\);/);
  assert.match(APP, /createBridge\(\{\s+store: appStore, origin: location\.origin, head: FOCUS_GUARD,/);
});

test('the store is this workspace’s own database, and goes with Clear this device and a deleted thread', () => {
  assert.match(APP, /backend: idbBackend\(workspaceDb\(workspace\)\)/);
  assert.match(APP, /new BroadcastChannel\(`atelier-appdata\/\$\{workspaceDb\(workspace\)\}`\)/);
  const wipe = APP.slice(APP.indexOf("$('#wipeBtn').onclick"), APP.indexOf('function applyTheme()'));
  assert.match(wipe, /await DB\.kvClear\(\);[^\n]*\n\s+await appStore\.clearAll\(\);/);
  const del = APP.slice(APP.indexOf('async function deleteSavedThread'), APP.indexOf("$('#threadMenuDelete')"));
  // A delete Recently deleted can undo keeps the data for the restore (the boot prune drops it after 30 days); any other
  // delete takes it at once.
  assert.match(del, /const ask = Sync\.on\(\) \? await Sync\.deleteCopy\(id\) : 'Delete this thread\?';\r?\n\s+if \(!confirm\(ask\)\) return;/);
  assert.match(del, /if \(!ask\.startsWith\(Sync\.COPY\.deleteConfirm\)\) appStore\.forgetThread\(id\)/);
  assert.match(APP, /DB\.keys\(\)\.then\(\(ids\) => appStore\.prune\(ids\)\)/, 'threads gone from this device: pruned at boot after 30 days');
  assert.match(APP, /addEventListener\('pagehide', \(\) => \{ appStore\.flush\(\)/, 'a closing page writes what is pending');
  assert.match(APP, /case 'app-data-clear': return clearAppData\(e\);/);
  // The Clear this device hint (in all three states) says what the button clears, as its confirms do.
  assert.match(INDEX, /<span id="wipeHint">Clears threads, media, app data, profile/);
  for (const k of ['wipeSynced', 'wipeSyncedLocal', 'wipeConfirm', 'wipeConfirmLocal']) assert.match(COPY[k], /threads, media, app data, profile/, k);
  assert.match(APP, /if \(!confirm\(`Clear what “\$\{e\.app\.title\}” saved on this device/, 'Clear app data asks first');
});

test('the CSP still runs the inline shim in a srcdoc frame; the module is precached and checked', () => {
  const csp = /^[ \t]+Content-Security-Policy-Report-Only: ([^\r\n]+)/m.exec(HEADERS)[1];
  const dir = (d) => (new RegExp(`(?:^|; )${d} ([^;]+)`).exec(csp)?.[1] || '').split(' ');
  assert.ok(dir('script-src').includes("'unsafe-inline'"), 'srcdoc previews inherit this policy: the shim is an inline script');
  assert.deepEqual(dir('frame-src'), ["'self'"], 'previews stay srcdoc documents (a blob: frame would need frame-src blob:)');
  assert.match(SW, /`\/appdata\.js\?v=\$\{V\}`/);
  assert.match(JSON.parse(PKG).scripts.check, /node --check public\/appdata\.js/);
});

test('the Build prompt asks for localStorage and for keys that survive a refine; privacy and the fixture say how it works', () => {
  assert.match(APP, /Persist state with localStorage \(Atelier keeps it for this app, on this device;/);
  assert.match(APP, /keep its localStorage keys and data format \(or migrate the old format\) so what the user saved still loads/);
  assert.match(PRIVACY, /<li id="app-data"><b>Build app data \(this device\):<\/b>/);
  assert.match(PRIVACY, /isn’t synced, sent to Atelier’s server, put in thread backups or added to a downloaded app/);
  assert.match(FIXTURE, /localStorage\.setItem\("review-count",String\(n\)\)/, 'the review fixture’s Build app saves its count');
});

test('Atelier’s own reloads wait for the Build apps’ writes; a refused write and a reload loop are visible', () => {
  // A page that is unloading can't finish an IndexedDB write: an account change and a new version's reload flush first.
  const ws = APP.slice(APP.indexOf('function reloadWorkspace('), APP.indexOf('function onAccountStorage('));
  assert.match(ws, /const apps = appStore\.busy\(\) \? appStore\.flush\(\) : null;/);
  assert.match(ws, /if \(!flushed && !apps\) location\.reload\(\);/);
  assert.match(ws, /setTimeout\(reload, 2000\); Promise\.allSettled\(\[flushed, apps\]\)\.then\(reload\);/);
  assert.match(APP, /reloaded = true; appDataSaved\(\)\.then\(\(\) => location\.reload\(\)\);/);
  assert.match(APP, /const appDataSaved = \(ms = 2000\) => \(appStore\.busy\(\) \? Promise\.race\(\[appStore\.flush\(\)\.catch\(\(\) => \{\}\), sleep\(ms\)\]\) : Promise\.resolve\(\)\);/);
  const reloads = [...APP.matchAll(/location\.reload\(\)/g)].map((m) => APP.slice(APP.lastIndexOf('\n', m.index) + 1, APP.indexOf('\n', m.index)).trim());
  assert.equal(reloads.length, 4, 'reloadWorkspace (2), the new-version reload, and Clear this device (its app data is gone by then)');
  assert.match(APP, /await appStore\.clearAll\(\);[\s\S]{0,1200}location\.reload\(\);/);
  assert.match(APP, /onRefused: \(\) => \{ if \(!appRoomShown\) \{ appRoomShown = true; toast\(/);
  assert.match(APP, /onStall: \(key\) => queueAppData\(key\)/);
  assert.match(APP, /paused \? 'App data · not saving while the app keeps reloading itself'/);
});
