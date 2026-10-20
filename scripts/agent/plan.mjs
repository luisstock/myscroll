// Step 1 of a daily run: work out what today's edition needs.
// Writes data/plan-<date>.json and prints a readable brief for the agent.
// Usage: node scripts/agent/plan.mjs [date]
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadContext, localDate, root } from "./context.mjs";

const date = process.argv[2] ?? localDate();
const { model, ranking, state, synced, index, localItems } = await loadContext();
const s = state.settings;

const active = model.topics().filter((t) => model.isTopicActive(t.id));
// "Auto" edition size follows how much the reader actually finishes (web/model.js editionSize).
const target = model.editionSize(s, state.readLog).target;
const slots = ranking.allocateSlots(active.map((t) => t.id), state.profile, s, target);
const sources = model.allSources();

const topics = active.map((t) => ({
  id: t.id, label: t.label, emoji: t.emoji, lang: t.lang ?? "en", format: t.format ?? "article",
  description: t.description ?? "", keywords: t.keywords ?? [],
  subs: (t.subs ?? []).map((x) => ({ id: x.id, label: x.label })),
  status: t.status ?? "ready",
  slots: slots[t.id],
  weight: model.topicWeight(t.id),
  sources: sources.filter((x) => x.topic === t.id && x.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .map((x) => ({ id: x.id, name: x.name, url: x.url, type: x.type, weight: x.weight, ...(x.feed ? { feed: x.feed } : {}) })),
}));

// Taste summary, readable.
const entries = [...state.profile.entries()].filter(([, e]) => e.n >= 0.5);
const fmt = ([f, e]) => ({ feature: f, label: model.featureLabel(f), affinity: +e.affinity.toFixed(2) });
const taste = {
  ratings: Object.keys(state.ratings).length,
  likes: entries.filter(([, e]) => e.affinity > 0.1).sort((a, b) => b[1].affinity - a[1].affinity).slice(0, 15).map(fmt),
  dislikes: entries.filter(([, e]) => e.affinity < -0.1 && !e.muted).sort((a, b) => a[1].affinity - b[1].affinity).slice(0, 15).map(fmt),
  muted: entries.filter(([, e]) => e.muted).map(fmt),
};

// Things already shown recently: don't repeat them.
const recent = [...model.pool(), ...localItems].map((i) => ({ id: i.id, title: i.title, url: i.source?.url }));

const number = Math.max(0, ...state.editions.map((e) => e.number ?? 0)) + (index.latest === date ? 0 : 1);
const plan = {
  date, number, target, longread: 1, explorationShare: 0.15,
  stateUpdatedAt: synced.updatedAt ?? null,
  profile: s.profile ?? null, // { about, avoid } from Settings → Your profile
  topics, taste, recent,
  setupTopics: topics.filter((t) => t.status === "new").map((t) => t.id),
};

await mkdir(join(root, "data"), { recursive: true });
await writeFile(join(root, "data", `plan-${date}.json`), JSON.stringify(plan, null, 2));

// ---- brief ----
const lines = [];
lines.push(`# MyScroll plan for ${date} (edition #${number})`);
lines.push(`Target: ${target} items + 1 long read · ~${Math.round(target * plan.explorationShare)} exploration picks · state synced ${plan.stateUpdatedAt ?? "never (defaults)"}`);
lines.push("");
for (const t of topics) {
  lines.push(`## ${t.emoji} ${t.label} [${t.id}] — ${t.slots} slots${t.weight !== 1 ? ` (weight ${t.weight})` : ""}${t.status === "new" ? " — NEW TOPIC, needs setup" : ""}${t.lang === "pt" ? " — write in European Portuguese" : ""}`);
  if (t.description) lines.push(`What the user wants: ${t.description}`);
  if (t.subs.length) lines.push(`Subcategories: ${t.subs.map((x) => `${x.label} [${x.id}]`).join(", ")}`);
  lines.push(`Keywords: ${t.keywords.join("; ") || "(none)"}`);
  lines.push(`Sources (${t.sources.length}): ${t.sources.map((x) => `${x.name}${x.weight > 1 ? ` ×${x.weight}` : ""} <${x.url}>`).join(" · ") || "(none — discover some)"}`);
  lines.push("");
}
lines.push("## Taste");
lines.push(`${taste.ratings} ratings so far.`);
if (taste.likes.length) lines.push(`More of: ${taste.likes.map((x) => `${x.label} (${x.affinity})`).join(", ")}`);
if (taste.dislikes.length) lines.push(`Less of: ${taste.dislikes.map((x) => `${x.label} (${x.affinity})`).join(", ")}`);
if (taste.muted.length) lines.push(`MUTED — never pick: ${taste.muted.map((x) => `${x.label} [${x.feature}]`).join(", ")}`);
lines.push("");
lines.push(`## Already shown (${recent.length}) — do not repeat these stories`);
lines.push(recent.map((r) => `- ${r.title}`).join("\n"));
console.log(lines.join("\n"));
