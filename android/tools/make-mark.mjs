// Builds the "A" mark that hovers and pulses in Atelier Assist's overlay card, from brand/atelier-mark-transparent-512.png.
//
//   node android/tools/make-mark.mjs      (run from the repo root; uses the repo's own sharp)
//
// The source is the ribbon A on a transparent 512 px square with generous padding. The padding is trimmed, the A is
// centred in a square (its aspect ratio kept), and written as drawable-<density>/atelier_mark.png at 48 dp: the card
// draws it at 40 dp and scales it up to ~1.12x with the voice, so the largest frame is still drawn from more pixels
// than it shows.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const require = createRequire(path.join(repo, 'package.json'));
const sharp = require('sharp');

const SRC = path.join(repo, 'brand', 'atelier-mark-transparent-512.png');
const RES = path.join(repo, 'android', 'app', 'src', 'main', 'res');
const MARK_DP = 48;
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

const trimmed = await sharp(SRC).ensureAlpha().trim({ threshold: 1 }).png().toBuffer({ resolveWithObject: true });
const { width: w, height: h } = trimmed.info;
const side = Math.max(w, h);
const square = await sharp(trimmed.data)
  .extend({
    top: Math.floor((side - h) / 2), bottom: Math.ceil((side - h) / 2),
    left: Math.floor((side - w) / 2), right: Math.ceil((side - w) / 2),
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
  .png()
  .toBuffer();
console.log(`trimmed A ${w}x${h} → ${side}x${side} square`);

for (const [name, scale] of Object.entries(DENSITIES)) {
  const px = Math.round(MARK_DP * scale);
  const dir = path.join(RES, `drawable-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'atelier_mark.png');
  await sharp(square).resize(px, px, { kernel: 'lanczos3' }).png({ compressionLevel: 9, adaptiveFiltering: true }).toFile(out);
  console.log(`${name}: ${px}x${px} → ${path.relative(repo, out)} (${fs.statSync(out).size} bytes)`);
}
