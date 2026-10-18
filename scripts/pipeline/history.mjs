// Permanent memory of everything ever shown, so MyScroll never serves the same story twice
// (across days and across "Load more" runs). data/history.json: [{ url, title, date, id }]
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { root } from "../agent/context.mjs";

const path = join(root, "data", "history.json");

export function normUrl(u) {
  try {
    const x = new URL(u);
    for (const p of [...x.searchParams.keys()]) if (/^(utm_|ref|fbclid|gclid|mc_)/.test(p)) x.searchParams.delete(p);
    return (x.hostname.replace(/^(www|old|m)\./, "") + x.pathname.replace(/\/+$/, "") + (x.search || "")).toLowerCase();
  } catch { return String(u).toLowerCase(); }
}

const words = (t) => new Set(String(t).toLowerCase().replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter((w) => w.length > 3));
export function titleSimilarity(a, b) {
  const A = words(a), B = words(b);
  const inter = [...A].filter((w) => B.has(w)).length;
  return inter / Math.max(1, Math.min(A.size, B.size));
}

export async function loadHistory() {
  const list = JSON.parse(await readFile(path, "utf8").catch(() => "[]"));
  const urls = new Set(list.map((h) => normUrl(h.url)));
  return {
    list,
    seen(item) {
      if (item.url && urls.has(normUrl(item.url))) return true;
      if (item.link && urls.has(normUrl(item.link))) return true;
      return list.some((h) => titleSimilarity(h.title, item.title) >= 0.75);
    },
    add(entries) {
      for (const e of entries) {
        if (!e.url || urls.has(normUrl(e.url))) continue;
        urls.add(normUrl(e.url));
        list.push(e);
      }
    },
    async save() {
      await mkdir(join(root, "data"), { recursive: true });
      await writeFile(path, JSON.stringify(list, null, 1));
    },
  };
}

// One-time: seed the history from every edition already published.
export async function seedFromEditions(history, editions) {
  for (const ed of editions) {
    history.add([ed.longread, ...(ed.items ?? [])].filter(Boolean)
      .map((i) => ({ url: i.source?.url, title: i.title, date: ed.date, id: i.id })));
  }
}
