// Turns raw editions (content/<date>.json) into what the app reads:
//   web/editions/<date>.json  + images downloaded to web/editions/<date>/
//   web/editions/index.json   (list of editions, newest first)
// Image per item, in order: YouTube thumbnail (video items), a photo from the item's
// Wikipedia page (skipping logos/maps/SVGs), or the source page's og:image.
// Images are downloaded so the app also works offline.
// Usage: node scripts/build-edition.mjs            (all editions in content/)
//        node scripts/build-edition.mjs 2026-10-18 (just one)
import { readFile, writeFile, mkdir, access, readdir } from "node:fs/promises";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const contentDir = join(root, "content");
const outDir = join(root, "web", "editions");

const UA = { "User-Agent": "MyScroll/0.1 (personal reading app prototype)" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => access(p).then(() => true, () => false);

const cachePath = join(contentDir, ".image-cache.json");
const cache = JSON.parse(await readFile(cachePath, "utf8").catch(() => "{}"));

// Wikimedia rate-limits aggressively: go slowly and back off on 429.
async function politeFetch(url) {
  let res;
  for (let attempt = 0; attempt < 6; attempt++) {
    res = await fetch(url, { headers: UA, redirect: "follow" });
    if (res.status !== 429) break;
    await sleep(2000 * 2 ** attempt);
  }
  await sleep(500);
  return res;
}

const NOT_A_PHOTO = /\.svg$|logo|coat_of_arms|arms_of|flag_of|icon|map|location|signature|seal_of/i;

async function wikiPhoto(title, lang = "en") {
  const key = `v2:${lang}:${title}`;
  if (key in cache) return cache[key];
  const res = await politeFetch(`https://${lang}.wikipedia.org/api/rest_v1/page/media-list/${encodeURIComponent(title)}`);
  if (!res.ok) return null;
  const { items = [] } = await res.json();
  const photo = items.find((m) => m.type === "image" && m.srcset?.length && !NOT_A_PHOTO.test(m.title));
  if (!photo) return (cache[key] = null);
  // srcset entries are 1x/1.5x/2x of a ~330-640px thumbnail; take the largest.
  const best = photo.srcset.reduce((a, b) => (parseFloat(b.scale) > parseFloat(a.scale) ? b : a));
  return (cache[key] = { url: "https:" + best.src.replace(/^https?:/, ""), credit: photo.title });
}

async function ogImage(pageUrl) {
  const key = `og:${pageUrl}`;
  if (key in cache) return cache[key];
  const res = await politeFetch(pageUrl).catch(() => null);
  if (!res?.ok) return null;
  const html = await res.text();
  const m = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*content=["']([^"']+)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|twitter:image)["']/i);
  if (!m) return (cache[key] = null);
  return (cache[key] = { url: new URL(m[1].replace(/&amp;/g, "&"), pageUrl).href, credit: new URL(pageUrl).hostname });
}

async function download(url, dir, base) {
  let ext = (extname(new URL(url).pathname) || ".jpg").toLowerCase();
  if (!/^\.(jpe?g|png|webp|gif|avif)$/.test(ext)) ext = ".jpg";
  const name = base + ext;
  const dest = join(dir, name);
  if (!(await exists(dest))) {
    const res = await politeFetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  }
  return name;
}

function minutes(item) {
  const text = [item.snippet, ...(Array.isArray(item.body) ? item.body : [item.body])].join(" ");
  return Math.max(1, Math.round(text.split(/\s+/).length / 220));
}

async function findImage(item) {
  if (item.video?.provider === "youtube") return { url: `https://i.ytimg.com/vi/${item.video.id}/hqdefault.jpg`, credit: "YouTube" };
  if (item.imageUrl) return { url: item.imageUrl, credit: new URL(item.source?.url ?? item.imageUrl).hostname };
  if (item.wiki) {
    const photo = await wikiPhoto(item.wiki);
    if (photo) return photo;
  }
  if (item.source?.url) return ogImage(item.source.url);
  return null;
}

async function enrich(item, date, imgDir) {
  if (!item.image) {
    try {
      const found = await findImage(item);
      if (found) item.image = { src: `editions/${date}/${await download(found.url, imgDir, item.id)}`, credit: found.credit };
    } catch (err) {
      console.warn(`  erro na imagem de ${item.id}: ${err.message}`);
      // The article's own image failed: fall back to Wikipedia / og:image.
      if (item.imageUrl) {
        delete item.imageUrl;
        return enrich(item, date, imgDir);
      }
    }
    delete item.imageUrl;
    if (!item.image) console.warn(`  sem imagem: ${item.id}`);
  }
  item.minutes ??= minutes(item);
  item.lang ??= "en";
  item.added ??= date;
  return item;
}

async function build(date) {
  const edition = JSON.parse(await readFile(join(contentDir, `${date}.json`), "utf8"));
  const imgDir = join(outDir, date);
  await mkdir(imgDir, { recursive: true });
  for (const item of edition.items) await enrich(item, date, imgDir);
  if (edition.longread) await enrich(edition.longread, date, imgDir);
  await writeFile(join(outDir, `${date}.json`), JSON.stringify(edition, null, 2));
  await writeFile(cachePath, JSON.stringify(cache, null, 2));
  console.log(`OK ${date}: ${edition.items.length} itens, ${edition.items.filter((i) => i.image).length} com imagem`);
}

const all = (await readdir(contentDir)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)).sort();
const targets = process.argv[2] ? [process.argv[2]] : all;
for (const date of targets) await build(date);

const built = (await readdir(outDir)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)).sort().reverse();
await writeFile(join(outDir, "index.json"), JSON.stringify({ latest: built[0], editions: built }, null, 2));
