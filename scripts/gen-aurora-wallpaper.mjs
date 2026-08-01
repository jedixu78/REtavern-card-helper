/**
 * 生成「玻璃幻境」主题壁纸：暗色基底 + 彩色极光光斑，最适合磨砂玻璃效果。
 *
 * 用法：node scripts/gen-aurora-wallpaper.mjs
 * 输出：public/themes/aurora-glass.webp (1600x1000, WebP q90)
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const W = 1600;
const H = 1000;

const blobs = [
  { x: 350, y: 220, r: 520, color: '#7c3aed', o: 0.55 },
  { x: 1280, y: 180, r: 460, color: '#22d3ee', o: 0.42 },
  { x: 240, y: 830, r: 500, color: '#db2777', o: 0.4 },
  { x: 1330, y: 800, r: 520, color: '#4f46e5', o: 0.5 },
  { x: 800, y: 480, r: 440, color: '#8b5cf6', o: 0.28 },
  { x: 820, y: 20, r: 300, color: '#38bdf8', o: 0.25 },
];

const defs = blobs
  .map(
    (b, i) => `
    <radialGradient id="g${i}" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${b.color}" stop-opacity="${b.o}"/>
      <stop offset="55%" stop-color="${b.color}" stop-opacity="${b.o * 0.55}"/>
      <stop offset="100%" stop-color="${b.color}" stop-opacity="0"/>
    </radialGradient>`
  )
  .join('');

const circles = blobs
  .map((b, i) => `<circle cx="${b.x}" cy="${b.y}" r="${b.r}" fill="url(#g${i})"/>`)
  .join('');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0f0c29"/>
      <stop offset="55%" stop-color="#1e1b4b"/>
      <stop offset="100%" stop-color="#0b1026"/>
    </linearGradient>
    ${defs}
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  ${circles}
  <rect width="${W}" height="${H}" fill="url(#bg)" opacity="0.25"/>
</svg>`;

await sharp(Buffer.from(svg)).webp({ quality: 90 }).toFile(join(ROOT, 'public/themes/aurora-glass.webp'));
console.log('generated public/themes/aurora-glass.webp');
