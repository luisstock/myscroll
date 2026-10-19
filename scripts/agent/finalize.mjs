// Step 3 of a daily run: check what the agent wrote, then publish it.
//  - validates every item (fields, topic, links, lengths) — exits 1 with a list of problems to fix
//  - drops repeats of recent stories and anything muted by the user
//  - trims to the plan's slots using the taste model (keeping exploration picks)
//  - adds discovered sources to web/catalog.json, marks set-up topics in web/agent-notes.json
//  - builds the edition (images, reading time, index)
// Usage: node scripts/agent/finalize.mjs <date>
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { loadContext, localDate, root } from "./context.mjs";

const date = process.argv[2] ?? localDate();
const contentPath = join(root, "content", `${date}.json`);
const edition = JSON.parse(await readFile(contentPath, "utf8"));
const plan = JSON.parse(await readFile(join(root, "data", `plan-${date}.json`), "utf8").catch(() => "null"));
const { model, ranking, state } = await loadContext();

const errors = [];
const warnings = [];
const KINDS = new Set(["news", "evergreen", "longread"]);
const words = (x) => (Array.isArray(x) ? x.join(" ") : x ?? "").split(/\s+/).filter(Boolean).length;
const topicIds = new Set([...model.topics().map((t) => t.id), "search"]); // "search": fallback topic for Search/Share items

function check(item, where) {
  const e = (msg) => errors.push(`${where} ${item.id ?? "(no id)"}: ${msg}`);
  if (!item.id || !/^[a-z0-9][a-z0-9-]{2,60}$/.test(item.id)) e("id must be lowercase-with-dashes");
  if (!topicIds.has(item.topic)) e(`unknown topic "${item.topic}"`);
  if (!KINDS.has(item.kind)) e(`kind must be news | evergreen | longread`);
  if (!item.title || item.title.length > 120) e("title missing or longer than 120 chars");
  if (!item.snippet || item.snippet.length > 260) e("snippet missing or longer than 260 chars");
  const bw = words(item.body);
  const minWords = item.kind === "longread" ? 300 : item.video ? 25 : 40;
  if (bw < minWords) e(`body too short (${bw} words, minimum ${minWords})`);
  if (item.kind !== "longread" && bw > 320) warnings.push(`${item.id}: body is long (${bw} words) — the extra belongs in "more"`);
  if (!item.more) warnings.push(`${item.id}: no "more" text — Read more will try to fetch the source`);
  else if (words(item.more) < 150) warnings.push(`${item.id}: "more" is short (${words(item.more)} words)`);
  try { if (!/^https?:$/.test(new URL(item.source?.url).protocol)) throw 0; } catch { e("source.url must be a full http(s) link"); }
  if (!item.source?.name) e("source.name missing");
  if (item.kind === "news" && !/^\d{4}-\d{2}-\d{2}$/.test(item.published ?? "")) e("news needs published: YYYY-MM-DD");
  if (item.video && !(item.video.provider === "youtube" && /^[\w-]{11}$/.test(item.video.id))) e("video must be { provider: 'youtube', id: <11 chars> }");
  if (item.sub && !model.topicOf(item.topic).subs?.some((s) => s.id === item.sub)) {
    warnings.push(`${item.id}: sub "${item.sub}" isn't a subcategory of ${item.topic} — removed`);
    delete item.sub;
  }
  if (item.tags && !Array.isArray(item.tags)) e("tags must be an array");
  item.tags = (item.tags ?? []).map((t) => String(t).toLowerCase().trim().replace(/\s+/g, "-")).slice(0, 6);
}

const items = edition.items ?? [];
items.forEach((it, i) => check(it, `items[${i}]`));
if (edition.longread) check(edition.longread, "longread");
else warnings.push("no long read today");
const ids = [...items, edition.longread].filter(Boolean).map((i) => i.id);
for (const id of ids.filter((x, i) => ids.indexOf(x) !== i)) errors.push(`duplicate id ${id}`);

if (errors.length) {
  console.error(`✗ ${errors.length} problem(s) in content/${date}.json — fix them and run again:\n- ${errors.join("\n- ")}`);
  process.exit(1);
}

// ---- repeats & muted ----
const norm = (t) => new Set(t.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter((w) => w.length > 3));
const similar = (a, b) => { const A = norm(a), B = norm(b); const inter = [...A].filter((w) => B.has(w)).length; return inter / Math.max(1, Math.min(A.size, B.size)); };
const recent = model.pool().filter((i) => i.added !== date);
const dropped = [];
const accepted = [];
let kept = items.filter((it) => {
  const dupe = [...recent, ...accepted].find((r) => r.source?.url === it.source.url || similar(r.title, it.title) >= 0.75);
  if (!dupe) accepted.push(it);
  if (dupe) { dropped.push(`${it.id} (repeat of "${dupe.title}")`); return false; }
  const muted = ranking.featuresOf(it).find((f) => state.profile.get(f)?.muted);
  if (muted) { dropped.push(`${it.id} (muted: ${muted})`); return false; }
  return true;
});

// ---- trim to slots ----
// "Load more" runs append to today's edition: keep everything already published.
const appendMode = process.argv.includes("--append");
const slots = plan && !appendMode ? Object.fromEntries(plan.topics.map((t) => [t.id, t.slots])) : null;
if (slots) {
  const settings = { topicWeights: state.settings.topicWeights, sourceWeights: model.sourceWeights() };
  const byTopic = {};
  for (const it of kept) (byTopic[it.topic] ??= []).push(it);
  kept = [];
  for (const [topic, list] of Object.entries(byTopic)) {
    const cap = Math.ceil((slots[topic] ?? 2) * 1.25); // a little slack: better a full edition than a thin one
    const scored = list.map((it) => ({ it, s: it.explore ? Infinity : ranking.scoreItem(it, state.profile, settings).score }))
      .sort((a, b) => b.s - a.s);
    kept.push(...scored.slice(0, cap).map((x) => x.it));
    for (const x of scored.slice(cap)) dropped.push(`${x.it.id} (over ${topic} slots)`);
  }
}

// ---- discovered sources & set-up topics ----
const catalogPath = join(root, "web", "catalog.json");
const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
const known = new Set(catalog.sources.map((s) => s.url.replace(/\/+$/, "")));
let added = 0;
for (const src of edition.discoveredSources ?? []) {
  if (!src.url || !src.name || !topicIds.has(src.topic) || known.has(src.url.replace(/\/+$/, ""))) continue;
  catalog.sources.push({
    id: `${src.topic}-${src.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`.slice(0, 50),
    topic: src.topic, name: src.name, url: src.url, type: src.type ?? "site", tags: src.tags ?? [],
    default: !!src.activate, discovered: date,
  });
  known.add(src.url.replace(/\/+$/, ""));
  added++;
}
if (added) await writeFile(catalogPath, JSON.stringify(catalog, null, 2));

const notesPath = join(root, "web", "agent-notes.json");
const notes = JSON.parse(await readFile(notesPath, "utf8").catch(() => "{}"));
notes.readyTopics = [...new Set([...(notes.readyTopics ?? []), ...(edition.readyTopics ?? [])])];
notes.lastRun = { date, at: new Date().toISOString(), items: kept.length, dropped: dropped.length, sourcesAdded: added };
await writeFile(notesPath, JSON.stringify(notes, null, 2));

// ---- publish ----
const out = {
  date, number: plan?.number ?? edition.number ?? 1,
  longread: edition.longread ? { ...edition.longread, kind: "longread" } : undefined,
  items: kept.map(({ explore, ...it }) => ({ ...it, ...(explore ? { explore: true } : {}) })),
  ...(edition.partial ? { partial: true } : {}),
};
await writeFile(contentPath, JSON.stringify(out, null, 2));
execFileSync(process.execPath, [join(root, "scripts", "build-edition.mjs"), date], { stdio: "inherit" });

const perTopic = kept.reduce((m, i) => ((m[i.topic] = (m[i.topic] ?? 0) + 1), m), {});
console.log(`\n✓ Edition #${out.number} for ${date}: ${kept.length} items + ${out.longread ? 1 : 0} long read`);
console.log(`  per topic: ${Object.entries(perTopic).map(([t, n]) => `${t} ${n}`).join(", ")}`);
if (dropped.length) console.log(`  dropped ${dropped.length}: ${dropped.join("; ")}`);
if (added) console.log(`  added ${added} discovered source(s) to the catalog`);
if (warnings.length) console.log(`  warnings:\n  - ${warnings.join("\n  - ")}`);
