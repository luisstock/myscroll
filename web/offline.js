// Offline reading: pre-caches card images and "Read more" text so the app works with Wi-Fi off.
//  - images -> Cache API "myscroll-img-v1" (keyed by the URL imageEl uses)
//  - Read more blocks -> Cache API "myscroll-more-v1" (JSON keyed by item id)
// A small index in localStorage remembers sizes per item so Settings can show totals without opening caches.
import { dataUrl } from "./env.js";
import { state, pool, visibleItems } from "./model.js";
import { readMore, canFetchPages } from "./readmore.js";

const IMG = "myscroll-img-v1";
const MORE = "myscroll-more-v1";
const KEY = "myscroll:offline";
const CAP = 50 * 1024 * 1024;
const MAX_MORE = 40;
const BATCH = 3;

let running = false;
const idle = (ms) => new Promise((r) => setTimeout(r, ms));
const moreUrl = (id) => `/more/${encodeURIComponent(id)}`;

function readIndex() {
  try { return JSON.parse(localStorage.getItem(KEY)) || { items: {} }; } catch { return { items: {} }; }
}
function writeIndex(ix) {
  try { localStorage.setItem(KEY, JSON.stringify(ix)); } catch {}
}
const entrySize = (e) => (e.img ? e.imgSize || 0 : 0) + (e.more || 0);

// { items, bytes } for the Settings line.
export function offlineStats() {
  const list = Object.values(readIndex().items).filter((e) => e.img || e.more);
  return { items: list.length, bytes: list.reduce((s, e) => s + entrySize(e), 0) };
}

export async function clearOffline() {
  try { await caches.delete(IMG); await caches.delete(MORE); } catch {}
  writeIndex({ items: {} });
}

// ---- Read more cache ----
export async function getCachedMore(id) {
  try {
    const hit = await (await caches.open(MORE)).match(moreUrl(id));
    return hit ? await hit.json() : null;
  } catch { return null; }
}

export async function putCachedMore(id, result) {
  try {
    const text = JSON.stringify(result);
    await (await caches.open(MORE)).put(moreUrl(id), new Response(text, { headers: { "Content-Type": "application/json" } }));
    const ix = readIndex();
    (ix.items[id] ||= {}).more = text.length;
    writeIndex(ix);
    return text.length;
  } catch { return 0; }
}

// ---- Images ----
// Used by <img> onerror: the cached copy as a blob URL, or null.
export async function cachedImageUrl(src) {
  try {
    const hit = await (await caches.open(IMG)).match(src);
    return hit ? URL.createObjectURL(await hit.blob()) : null;
  } catch { return null; }
}

async function cacheImage(item, imgCache) {
  const url = dataUrl(item.image.src);
  if (await imgCache.match(url)) return 0; // already stored (size is in the index)
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(String(res.status));
  const blob = await res.blob();
  if (!blob.size) throw new Error("empty");
  await imgCache.put(url, new Response(blob, { headers: { "Content-Type": blob.type || "image/jpeg" } }));
  const ix = readIndex();
  Object.assign((ix.items[item.id] ||= {}), { img: url, imgSize: blob.size });
  writeIndex(ix);
  return blob.size;
}

// ---- Eviction: forget items that left the pool ----
async function evict() {
  const alive = new Set(pool().map((i) => i.id));
  const ix = readIndex();
  const imgCache = await caches.open(IMG), moreCache = await caches.open(MORE);
  for (const [id, e] of Object.entries(ix.items)) {
    if (alive.has(id)) continue;
    if (e.img) await imgCache.delete(e.img);
    await moreCache.delete(moreUrl(id));
    delete ix.items[id];
  }
  writeIndex(ix);
}

const saveData = () => {
  const c = navigator.connection;
  return !!c && c.saveData && c.type === "cellular";
};

// Run one pass. force = from the Settings button (ignores the cellular/save-data skip).
export async function precache({ force = false, onProgress } = {}) {
  if (running || typeof caches === "undefined") return;
  if (navigator.onLine === false || (!force && saveData())) return;
  running = true;
  try {
    await evict();
    const imgCache = await caches.open(IMG);
    let total = offlineStats().bytes;
    const visible = visibleItems();
    const known = readIndex().items;

    // 1) images for every visible card (up to 80% of the cap, leaving room for the Read more text)
    const withImg = visible.filter((i) => i.image?.src && !known[i.id]?.img);
    for (let k = 0; k < withImg.length && total < CAP * 0.8; k += BATCH) {
      const res = await Promise.allSettled(withImg.slice(k, k + BATCH).map((i) => cacheImage(i, imgCache)));
      total += res.reduce((s, r) => s + (r.status === "fulfilled" ? r.value : 0), 0);
      onProgress?.();
      await idle(150);
    }

    // 2) Read more for the newest unread items that have no text of their own
    if (canFetchPages) {
      const want = visible.filter((i) => !i.more && i.source?.url && !state.read.has(i.id))
        .sort((a, b) => (b.added || "").localeCompare(a.added || ""))
        .slice(0, MAX_MORE);
      const todo = want.filter((i) => !readIndex().items[i.id]?.more);
      for (let k = 0; k < todo.length && total < CAP; k += 2) {
        if (navigator.onLine === false) break;
        const res = await Promise.allSettled(todo.slice(k, k + 2).map(async (i) => putCachedMore(i.id, await readMore(i, { network: true }))));
        total += res.reduce((s, r) => s + (r.status === "fulfilled" ? r.value : 0), 0);
        onProgress?.();
        await idle(400);
      }
    }
  } catch {}
  running = false;
}

// Called after editions load: wait for the feed to settle, then work quietly in the background.
let timer = null;
export function scheduleOffline(delay = 3000) {
  clearTimeout(timer);
  timer = setTimeout(() => precache(), delay);
}
