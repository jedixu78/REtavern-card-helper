/**
 * 一次性图片压缩脚本：把 public/cards 与 public/themes 的 PNG 转成 WebP。
 *
 * 用法：node scripts/compress-images.mjs
 *   - 输出 *.webp 到同目录，删除原 PNG（引用方已同步改为 .webp）
 *   - 卡片图缩放到最长边 800px（首页卡片为 CSS 背景，展示尺寸远小于此）
 *   - 主题图缩放到最长边 1600px（全屏背景的宽裕上限）
 *   - WebP 质量 80，保留透明通道
 */
import { readdir, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TARGETS = [
  { dir: 'public/cards', maxSide: 800, quality: 80 },
  { dir: 'public/themes', maxSide: 1600, quality: 80 },
];

let savedTotal = 0;

for (const { dir, maxSide, quality } of TARGETS) {
  const fullDir = join(ROOT, dir);
  const files = (await readdir(fullDir)).filter((f) => f.endsWith('.png'));
  for (const file of files) {
    const src = join(fullDir, file);
    const out = join(fullDir, file.replace(/\.png$/, '.webp'));
    const before = (await stat(src)).size;

    const img = sharp(src).rotate();
    const meta = await img.metadata();
    const longest = Math.max(meta.width ?? 0, meta.height ?? 0);
    if (longest > maxSide) {
      img.resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true });
    }
    await img.webp({ quality, alphaQuality: 90 }).toFile(out);

    const after = (await stat(out)).size;
    const pct = ((1 - after / before) * 100).toFixed(1);
    savedTotal += before - after;
    console.log(
      `[${dir}] ${file} (${meta.width}x${meta.height})  ${(before / 1024).toFixed(0)}KB → ${(after / 1024).toFixed(0)}KB  (-${pct}%)`
    );
    await rm(src);
  }
}

console.log(`\n合计节省 ${(savedTotal / 1024 / 1024).toFixed(1)} MB`);
