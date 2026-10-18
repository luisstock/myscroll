// Loads the app's own rules (web/model.js, web/ranking.js) in Node with the user's synced state,
// so the agent sees exactly what the app sees: active topics, sources, taste profile.
import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readJSON = async (p, fallback) => JSON.parse(await readFile(join(root, p), "utf8").catch(() => JSON.stringify(fallback)));

export async function loadContext() {
  // Node 25 has an experimental localStorage that warns on access; model.js only needs it in the browser.
  Object.defineProperty(globalThis, "localStorage", { value: undefined, configurable: true, writable: true });
  const model = await import("../../web/model.js");
  const ranking = await import("../../web/ranking.js");
  const { state } = model;

  const synced = await readJSON("data/state.json", {});
  state.taxonomy = await readJSON("web/taxonomy.json", { topics: [], groups: [] });
  state.catalog = (await readJSON("web/catalog.json", { sources: [] })).sources;
  Object.assign(state.settings, synced.settings ?? {});
  state.ratings = synced.ratings ?? {};
  state.skips = synced.skips ?? {};
  state.itemFeatures = synced.itemFeatures ?? {};
  state.opened = new Set(synced.opened ?? []);
  state.read = new Set(synced.read ?? []);
  state.saved = new Set(synced.saved ?? []);

  const index = await readJSON("web/editions/index.json", { editions: [] });
  state.latest = index.latest;
  state.editions = [];
  for (const d of index.editions.slice(0, 30)) state.editions.push(await readJSON(`web/editions/${d}.json`, { items: [] }));
  model.rebuildProfile();

  return { model, ranking, state, synced, index };
}

export async function contentDates() {
  return (await readdir(join(root, "content"))).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)).sort();
}

export function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
