// Builds Atelier Assist's adaptive launcher icon layers from public/icons/atelier-v2-master.png.
//
//   node android/tools/make-icons.mjs [previewDir]      (run from the repo root; uses the repo's own sharp)
//
// The master is the ribbon "A" on warm black (#0e0d0b). "Color to alpha" against that black lifts the A off its
// background exactly (composited back over #0e0d0b it is the original pixel), so the foreground layer is the A alone
// and the adaptive icon's background layer is the plain colour @color/ic_launcher_background. That leaves no seam
// whatever mask the launcher uses. The monochrome layer (themed icons) is the same A as a solid white silhouette.
//
// Sizes: the 108dp layer at mdpi..xxxhdpi. The master square is drawn 68dp wide, centred, so the A's far corners stay
// inside the 66dp safe circle that every launcher mask keeps.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const require = createRequire(path.join(repo, 'package.json'));
const sharp = require('sharp');

const MASTER = path.join(repo, 'public', 'icons', 'atelier-v2-master.png');
const RES = path.join(repo, 'android', 'app', 'src', 'main', 'res');
const BG = [0x0e, 0x0d, 0x0b];
const LAYER_DP = 108;
const MASTER_DP = 68;
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
const ALPHA_FLOOR = 0.12; // below this a pixel is background noise (the master's faint radial lift), so fully clear

const { data: rgb, info } = await sharp(MASTER).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const W = info.width, H = info.height, N = W * H;

// The A's extent: pixels clearly brighter than the background (the ribbon and its lime edge).
const lift = (i) => Math.max(...BG.map((b, k) => (rgb[i * 3 + k] - b) / (255 - b)));
let minX = W, minY = H, maxX = -1, maxY = -1;
for (let i = 0; i < N; i++) {
  if (lift(i) > 0.3) {
    const x = i % W, y = (i - x) / W;
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
}
const NEAR = 24; // the ribbon's contact shadows (darker than the background) are kept only next to the A
const nearA = (x, y) => x >= minX - NEAR && x <= maxX + NEAR && y >= minY - NEAR && y <= maxY + NEAR;

// GIMP-style colour-to-alpha against BG: the smallest alpha that, composited over BG, reproduces the pixel.
const fg = Buffer.alloc(N * 4);
const mono = Buffer.alloc(N * 4);
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
for (let i = 0; i < N; i++) {
  const x = i % W, y = (i - x) / W;
  const c = [rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]];
  let a = 0;
  for (let k = 0; k < 3; k++) {
    const d = c[k] - BG[k];
    a = Math.max(a, d > 0 ? d / (255 - BG[k]) : d < 0 && nearA(x, y) ? -d / BG[k] : 0);
  }
  if (a < ALPHA_FLOOR) a = 0;
  for (let k = 0; k < 3; k++) fg[i * 4 + k] = a ? Math.round(Math.min(255, Math.max(0, (c[k] - BG[k]) / a + BG[k]))) : 0;
  fg[i * 4 + 3] = Math.round(a * 255);
  const m = smooth(0.15, 0.45, Math.max(0, lift(i))); // solid silhouette: the ribbon's shaded folds count as ribbon
  mono[i * 4] = mono[i * 4 + 1] = mono[i * 4 + 2] = 255;
  mono[i * 4 + 3] = Math.round(m * 255);
}

// Where the A lands in the 108dp layer: its farthest bounding-box corner from the centre must stay in the safe circle.
const scale = MASTER_DP / W;
const corner = Math.max(...[[minX, minY], [maxX, minY], [minX, maxY], [maxX, maxY]].map(([x, y]) => Math.hypot(x - W / 2, y - H / 2))) * scale;
console.log(`A bbox ${minX},${minY}..${maxX},${maxY} of ${W}x${H}; A width ${((maxX - minX) * scale).toFixed(1)}dp, far corner ${corner.toFixed(1)}dp from centre (safe circle radius 33dp)`);
if (corner > 33) throw new Error('the A would be clipped by a circular mask: lower MASTER_DP');

async function layer(raw, px, inner) {
  const pad = (px - inner) / 2;
  const lo = Math.floor(pad), hi = px - inner - lo;
  return sharp(raw, { raw: { width: W, height: H, channels: 4 } })
    .resize(inner, inner, { kernel: 'lanczos3' })
    .extend({ top: lo, bottom: hi, left: lo, right: hi, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
}

for (const [name, d] of Object.entries(DENSITIES)) {
  const px = Math.round(LAYER_DP * d), inner = Math.round(MASTER_DP * d);
  const dir = path.join(RES, `mipmap-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ic_launcher_foreground.png'), await layer(fg, px, inner));
  fs.writeFileSync(path.join(dir, 'ic_launcher_monochrome.png'), await layer(mono, px, inner));
  console.log(`mipmap-${name}: ${px}px layers, A square ${inner}px`);
}

// Optional preview: the xxxhdpi foreground on the background colour, cut by a circle and a squircle-ish mask.
const previewDir = process.argv[2];
if (previewDir) {
  fs.mkdirSync(previewDir, { recursive: true });
  const px = 432, inner = Math.round(MASTER_DP * 4);
  const fgLayer = await layer(fg, px, inner), monoLayer = await layer(mono, px, inner);
  const visible = Math.round(px * 72 / 108), off = Math.round((px - visible) / 2);
  for (const [label, rx] of [['circle', visible / 2], ['squircle', visible * 0.3]]) {
    const mask = Buffer.from(`<svg width="${visible}" height="${visible}"><rect width="${visible}" height="${visible}" rx="${rx}" ry="${rx}" fill="#fff"/></svg>`);
    const full = await sharp({ create: { width: px, height: px, channels: 4, background: { r: BG[0], g: BG[1], b: BG[2], alpha: 1 } } })
      .composite([{ input: fgLayer }]).png().toBuffer();
    await sharp(full).extract({ left: off, top: off, width: visible, height: visible })
      .composite([{ input: mask, blend: 'dest-in' }]).png().toFile(path.join(previewDir, `icon-${label}.png`));
  }
  await sharp({ create: { width: px, height: px, channels: 4, background: { r: 60, g: 90, b: 140, alpha: 1 } } })
    .composite([{ input: monoLayer }]).png().toFile(path.join(previewDir, 'icon-monochrome.png'));
  console.log(`previews in ${previewDir}`);
}
