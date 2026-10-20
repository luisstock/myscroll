// Pure rules for the synced "localItems" map (items written on a device: ⚡ Fast Load more and AI book cards).
// Shape: id -> { at: ISO time, item, off?: true }. No imports, so the browser, sync.js and Node tests all share it.
const DAY = 864e5;
export const KEEP_DAYS = 30;      // fast items go after a month
export const MAX_AI_BOOKS = 200;  // AI book cards you asked for stay (the newest 200)
export const SLIM_DAYS = 7;       // in the synced copy, older items lose their `more` text
export const SYNC_BUDGET = 450000; // bytes of JSON for the whole map: data/state.json must stay well under ~1 MB

const isBook = (i) => i?.source?.id === "ai-books";
const addedMs = (i) => new Date(`${i.added}T12:00:00`).getTime();
const madeMs = (e) => e.item?.made ?? new Date(e.at ?? 0).getTime();

export function liveEntries(map) {
  return Object.entries(map ?? {}).filter(([, e]) => e && !e.off && e.item);
}

// Drops expired entries and the books beyond the cap. Pure: returns a new map.
export function prune(map, now = Date.now()) {
  const since = now - KEEP_DAYS * DAY;
  const live = liveEntries(map);
  const keepBooks = new Set(live.filter(([, e]) => isBook(e.item)).sort((a, b) => madeMs(a[1]) - madeMs(b[1])).slice(-MAX_AI_BOOKS).map(([id]) => id));
  const out = {};
  for (const [id, e] of Object.entries(map ?? {})) {
    if (!e) continue;
    if (e.off) { if (now - new Date(e.at ?? 0).getTime() < 60 * DAY) out[id] = { at: e.at, off: true }; continue; } // tombstones live 60 days
    if (!e.item) continue;
    if (isBook(e.item) ? keepBooks.has(id) : addedMs(e.item) >= since) out[id] = e;
  }
  return out;
}

// The copy that goes into data/state.json: pruned, old items slimmed, and trimmed to the size budget.
export function forSync(map, now = Date.now()) {
  const out = prune(map, now);
  for (const [id, e] of Object.entries(out)) {
    if (e.item && !isBook(e.item) && e.item.more && now - addedMs(e.item) > SLIM_DAYS * DAY) {
      const { more, ...rest } = e.item;
      out[id] = { ...e, item: rest };
    }
  }
  let size = JSON.stringify(out).length;
  if (size > SYNC_BUDGET) {
    // Oldest fast items first, then the oldest books.
    const order = liveEntries(out).sort((a, b) => (isBook(a[1].item) - isBook(b[1].item)) || madeMs(a[1]) - madeMs(b[1]) || addedMs(a[1].item) - addedMs(b[1].item));
    for (const [id, e] of order) {
      if (size <= SYNC_BUDGET) break;
      size -= JSON.stringify(e).length + id.length + 4;
      delete out[id];
    }
  }
  return out;
}

// Items for the feed (what withLocal() adds as an extra edition).
export const itemsOf = (map, now = Date.now()) => liveEntries(prune(map, now)).map(([, e]) => e.item);

// One-time migration of the old device-only array (myscroll:fastItems) into the map.
export function fromArray(list, now = Date.now()) {
  const out = {};
  for (const item of list ?? []) {
    if (!item?.id) continue;
    const at = new Date(item.made ?? addedMs(item) ?? now);
    out[item.id] = { at: (isNaN(at) ? new Date(now) : at).toISOString(), item };
  }
  return prune(out, now);
}
