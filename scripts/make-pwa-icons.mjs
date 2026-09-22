/**
 * The home-screen icons, drawn from the same mark the app bar uses: a white
 * "S" on --primary-600. Run once after changing the mark:
 *
 *   node scripts/make-pwa-icons.mjs
 *
 * The maskable icon keeps the letter inside the central 80% safe zone, because
 * Android crops it to a circle or a squircle and a clipped letter reads as a
 * broken app.
 */
import sharp from "sharp";
import { mkdirSync } from "node:fs";

const PRIMARY = "#4a56d2";
mkdirSync("public/icons", { recursive: true });

function svg(size, { maskable }) {
  const radius = maskable ? 0 : Math.round(size * 0.22);
  const font = Math.round(size * (maskable ? 0.46 : 0.6));
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  <rect width="${size}" height="${size}" rx="${radius}" fill="${PRIMARY}"/>
  <text x="50%" y="50%" dy="0.35em" text-anchor="middle" fill="#ffffff"
    font-family="Inter, Segoe UI, Arial, sans-serif" font-weight="700" font-size="${font}">S</text>
</svg>`);
}

const outputs = [
  ["public/icons/icon-192.png", 192, false],
  ["public/icons/icon-512.png", 512, false],
  ["public/icons/maskable-512.png", 512, true],
  // iOS ignores the manifest's icons and applies its own rounding.
  ["public/icons/apple-touch-icon.png", 180, true],
];

for (const [path, size, maskable] of outputs) {
  await sharp(svg(size, { maskable })).png().toFile(path);
  console.log(path);
}
