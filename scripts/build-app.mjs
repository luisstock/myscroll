// Copies the reader app (web/) into dist/ for the Android build, without the editions:
// the Android app downloads editions from GitHub Pages and keeps them for offline reading.
// Usage: node scripts/build-app.mjs && npx cap sync android
import { cp, rm, mkdir } from "node:fs/promises";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "web");
const out = join(root, "dist");

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(src, out, {
  recursive: true,
  filter: (path) => {
    const rel = relative(src, path).split(sep).join("/");
    return !(rel === "editions" || rel.startsWith("editions/") || rel === "agent-notes.json");
  },
});
console.log("dist/ ready (app code only)");
