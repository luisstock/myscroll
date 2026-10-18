// Renders assets/icon.svg into the PNG sources @capacitor/assets needs, then:
//   npx @capacitor/assets generate --android
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "assets");
const CREAM = "#F7F2E7";
const svg = await readFile(join(dir, "icon.svg"), "utf8");
const mark = svg.replace(/<rect width="1024" height="1024"[^>]*\/>/, ""); // the cards, no background

// The mark, scaled and centred on a square canvas (scale < 1 keeps it inside Android's safe zone).
const markOn = (size, scale, bg) => {
  const s = (size * scale) / 1024;
  const off = (size - 1024 * s) / 2;
  return Buffer.from(mark
    .replace(/viewBox="[^"]*" width="1024" height="1024"/, `viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"`)
    .replace("<g>", `${bg ? `<rect width="${size}" height="${size}" fill="${bg}"/>` : ""}<g transform="translate(${off} ${off}) scale(${s})">`));
};

await sharp(Buffer.from(svg)).png().toFile(join(dir, "icon-only.png"));
await sharp(markOn(1024, 0.78, null)).png().toFile(join(dir, "icon-foreground.png"));
await sharp({ create: { width: 1024, height: 1024, channels: 4, background: CREAM } }).png().toFile(join(dir, "icon-background.png"));
await sharp(markOn(2732, 0.32, CREAM)).png().toFile(join(dir, "splash.png"));
await sharp(markOn(2732, 0.32, CREAM)).png().toFile(join(dir, "splash-dark.png"));
await sharp(Buffer.from(svg)).resize(512, 512).png().toFile(join(dir, "preview-512.png"));
console.log("assets/ PNGs ready");
