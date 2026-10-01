// Produce installable app and browser icon sizes from the approved full-bleed master.
// Usage: node scripts/pack-app-icon.mjs <generated-image-path>
import sharp from 'sharp';
import { copyFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const source = process.argv[2] || 'public/icons/atelier-v2-master.png';
const master = 'public/icons/atelier-v2-master.png';
await mkdir('public/icons', { recursive: true });
if (resolve(source) !== resolve(master)) await copyFile(source, master);
const metadata = await sharp(master).metadata();
if (metadata.width !== metadata.height) throw new Error('The icon master must be square.');
for (const size of [32, 180, 192, 512]) {
  await sharp(master).resize(size, size, { kernel: 'lanczos3' }).flatten({ background: '#0e0d0b' }).png().toFile(`public/icons/atelier-v2-${size}.png`);
}
// Extra breathing room keeps the complete mark within the circular 80% safe zone.
await sharp(master).resize(430, 430, { kernel: 'lanczos3' })
  .extend({ top: 41, bottom: 41, left: 41, right: 41, extendWith: 'copy' })
  .flatten({ background: '#0e0d0b' }).png().toFile('public/icons/atelier-v2-maskable-512.png');
console.log(`Prepared Atelier icon sizes from ${metadata.width}×${metadata.height} master.`);
