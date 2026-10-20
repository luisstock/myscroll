// Loads the app's own rules (web/model.js, web/ranking.js) in Node with the user's synced state,
// so the agent sees exactly what the app sees: active topics, sources, taste profile.
import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readJSON = async (p, fallback) => JSON.parse(await readFile(join(root, p), "utf8").catch(() => JSON.stringify(fallback)));

// Live entries of a synced map: removing = `off: true`.
export const live = (map) => Object.entries(map ?? {}).filter(([, v]) => v && !v.off).map(([id, v]) => ({ id, ...v }));

export async function loadContext() {
  // Node 25 has an experimental localStorage that warns on access; model.js only needs it in the browser.
  Object.defineProperty(globalThis, "localStorage", { value: undefined, configurable: true, writable: true });
  const model = await import("../../web/model.js");
  const ranking = await import("../../web/ranking.js");
  const { state } = model;

  // data/state.json: synced from the phone through GitHub. data/state.local.json: the PC browser. Newest wins.
  const phone = await readJSON("data/state.json", {});
  const pc = await readJSON("data/state.local.json", {});
  const synced = new Date(pc.updatedAt ?? 0) > new Date(phone.updatedAt ?? 0) ? pc : phone;
  state.taxonomy = await readJSON("web/taxonomy.json", { topics: [], groups: [] });
  state.catalog = (await readJSON("web/catalog.json", { sources: [] })).sources;
  Object.assign(state.settings, synced.settings ?? {});
  state.ratings = synced.ratings ?? {};
  state.skips = synced.skips ?? {};
  state.itemFeatures = synced.itemFeatures ?? {};
  state.opened = new Set(synced.opened ?? []);
  state.read = new Set(synced.read ?? []);
  state.saved = new Set(synced.saved ?? []);
  // Newer synced maps (id -> { at, ..., off? }). Set on state so the agent can read them even before model.js knows them.
  for (const k of ["later", "hidden", "readLog", "follows", "moodboard", "remember", "localItems"]) state[k] = synced[k] ?? {};

  const index = await readJSON("web/editions/index.json", { editions: [] });
  state.latest = index.latest;
  state.editions = [];
  for (const d of index.editions.slice(0, 30)) state.editions.push(await readJSON(`web/editions/${d}.json`, { items: [] }));
  model.rebuildProfile();

  // Items written on the reader's devices (⚡ Fast Load more, AI books): already shown, so the agent must not repeat their stories.
  const { itemsOf } = await import("../../web/localitems.js");
  const localItems = itemsOf(state.localItems);

  return { model, ranking, state, synced, index, live, localItems };
}

export async function contentDates() {
  return (await readdir(join(root, "content"))).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)).sort();
}

export function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
