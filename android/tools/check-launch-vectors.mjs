// Feeds the launch links Atelier Assist builds (LaunchLink.build, written by LaunchLinkTest) to the web app's real
// public/launch.js, and checks that readLaunch() gets back exactly what the app meant to send.
//
//   node android/tools/check-launch-vectors.mjs [vectors.json]
//
// Run from the repo root after `gradlew :app:testReleaseUnitTest` (the default path is the one the build writes:
// %LOCALAPPDATA%\atelier-assist-build\app\launch-vectors.json, or $ATELIER_ASSIST_BUILD_DIR/app/launch-vectors.json).
//
// For every vector: start → mode, the fragment's q → text (as launch.js cleanText leaves the prompt), k → key, send=1 only
// with a key and words, via=assist, and no stray characters before or after.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const { readLaunch, cleanText, cap, LAUNCH_MODES } = await import(pathToFileURL(path.join(repo, 'public', 'launch.js')).href);

const buildDir = process.env.ATELIER_ASSIST_BUILD_DIR || (process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'atelier-assist-build'));
const file = process.argv[2] || (buildDir && path.join(buildDir, 'app', 'launch-vectors.json'));
if (!file) throw new Error('pass the vectors file');
const vectors = JSON.parse(await readFile(file, 'utf8'));
assert.ok(vectors.length > 0, 'no vectors');

let n = 0;
for (const v of vectors) {
  const u = new URL(v.url);
  assert.equal(u.origin, 'https://atelier.ciprari.ai', v.url);
  const got = readLaunch(u.search, u.hash);
  const text = cap(cleanText(v.prompt));
  const label = JSON.stringify(v.prompt).slice(0, 60) + ` (${v.mode}, ${v.key ? 'keyed' : 'plain'})`;
  assert.ok(LAUNCH_MODES.includes(v.mode), label);
  assert.equal(got.mode, v.mode, `mode ${label}`);
  assert.equal(got.text, text, `text ${label}`);
  assert.equal(got.key, text && v.key ? v.key : '', `key ${label}`);
  assert.equal(got.send, Boolean(text && v.key), `send ${label}`);
  assert.equal(got.via, 'assist', `via ${label}`);
  assert.equal(got.voice, false, `voice ${label}`);
  // in=voice|typed: only on a keyed link with words (launch.js input; '' when the link doesn't say)
  assert.equal(got.input, text && v.key && typeof v.spoken === 'boolean' ? (v.spoken ? 'voice' : 'typed') : '', `input ${label}`);
  n++;
}
console.log(`launch.js readLaunch agrees with LaunchLink.build on ${n} vectors (${file})`);
