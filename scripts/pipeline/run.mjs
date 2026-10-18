// The daily MyScroll pipeline. No AI until the very last step:
//   plan → gather (RSS/Reddit/YouTube/HN/Wikipedia) → preselect → extract article text
//   → write (Gemini / Ollama / Claude, one call per topic) → finalize (validate, images, publish)
//
// Usage:
//   node scripts/pipeline/run.mjs                 today's edition
//   node scripts/pipeline/run.mjs --dry           everything except the model: writes data/candidates-<date>.json
//   node scripts/pipeline/run.mjs --more 15       "Load more": ~15 extra items appended to today's edition
//   options: --date YYYY-MM-DD  --topics ai,motion  --force (redo today's edition)
//            --reuse (skip gathering: write from data/candidates-<date>.json of the last run)
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { loadContext, localDate, root } from "../agent/context.mjs";
import { gather } from "./gather.mjs";
import { preselect } from "./select.mjs";
import { extract } from "./extract.mjs";
import { writeTopic, writeLongread } from "./write.mjs";
import { loadHistory, seedFromEditions } from "./history.mjs";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const flag = (name) => args.includes(`--${name}`);
const date = opt("date") ?? localDate();
const dry = flag("dry");
const more = flag("more") ? Number(opt("more")) || 15 : 0;
const onlyTopics = opt("topics")?.split(",");
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s]`, ...a);

const config = JSON.parse(await readFile(join(root, "myscroll.config.json"), "utf8"));
const contentPath = join(root, "content", `${date}.json`);
const existing = JSON.parse(await readFile(contentPath, "utf8").catch(() => "null"));
const published = await readFile(join(root, "web", "editions", `${date}.json`)).then(() => true, () => false);
// An edition started by "Load more" (e.g. just after midnight) is partial: the daily run still completes it.
if (published && !more && !dry && !flag("force") && !existing?.partial) {
  log(`Edition for ${date} already exists. Use --more N to add items or --force to redo it.`);
  process.exit(0);
}

// 1. plan
execFileSync(process.execPath, [join(root, "scripts", "agent", "plan.mjs"), date], { stdio: "ignore" });
const plan = JSON.parse(await readFile(join(root, "data", `plan-${date}.json`), "utf8"));
if (onlyTopics) plan.topics = plan.topics.filter((t) => onlyTopics.includes(t.id));
if (more) {
  // Spread the extra items over the topics the same way as the daily slots.
  const sum = plan.topics.reduce((s, t) => s + t.slots, 0) || 1;
  for (const t of plan.topics) t.slots = Math.max(1, Math.round((t.slots / sum) * more));
}
log(`Plan: ${plan.topics.length} topics, ${plan.topics.reduce((s, t) => s + t.slots, 0)} slots${more ? " (load more)" : ""}, provider ${process.env.MYSCROLL_PROVIDER || config.provider}`);

// 2. memory of everything shown, so nothing repeats
const { model, ranking, state } = await loadContext();
const history = await loadHistory();
if (!history.list.length) await seedFromEditions(history, state.editions);
const todaysUrls = [...(existing?.items ?? []), existing?.longread].filter(Boolean).map((i) => i.source?.url);

const candidatesPath = join(root, "data", `candidates-${date}.json`);
let picked;
if (flag("reuse")) {
  // Skip gathering/extraction and reuse the last run's candidates (handy when only the writing failed).
  picked = JSON.parse(await readFile(candidatesPath, "utf8"));
  for (const t of Object.keys(picked)) picked[t] = picked[t].filter((c) => !history.seen(c) && !todaysUrls.includes(c.url));
  log(`Reusing saved candidates: ${Object.entries(picked).map(([t, l]) => `${t} ${l.length}`).join(", ")}`);
} else {
  // 3. gather
  log("Gathering from sources…");
  const candidates = await gather(plan, { log: (r) => console.log(r) });
  log(`${candidates.length} candidates`);

  // 4. preselect
  picked = preselect(plan, candidates, {
    history, ranking, profile: state.profile, config, extraSkip: todaysUrls,
    settings: { topicWeights: state.settings.topicWeights, sourceWeights: model.sourceWeights() },
  });
  log(`Preselected: ${Object.entries(picked).map(([t, l]) => `${t} ${l.length}`).join(", ")}`);

  // 5. extract real text
  for (const [topic, list] of Object.entries(picked)) {
    const out = [];
    for (let i = 0; i < list.length; i += 4) out.push(...await Promise.all(list.slice(i, i + 4).map((c) => extract(c, config.articleMaxWords))));
    picked[topic] = out;
  }
  const words = Object.values(picked).flat().reduce((s, c) => s + (c.text?.split(/\s+/).length ?? 0), 0);
  log(`Extracted ~${words} words of source text`);
  await writeFile(candidatesPath, JSON.stringify(picked, null, 2));
}

if (dry) {
  log(`Dry run: candidates saved to ${candidatesPath}`);
  process.exit(0);
}

// 6. write
const items = [];
let longread = existing?.longread ?? null;
const usage = [];
const failures = [];
for (const topic of plan.topics) {
  const list = picked[topic.id] ?? [];
  if (!list.length) { log(`  ${topic.id}: no candidates`); continue; }
  try {
    const res = await writeTopic(config, topic, list, plan);
    items.push(...res.items);
    usage.push(res.usage);
    log(`  ${topic.id}: ${res.items.length} written`);
  } catch (e) {
    log(`  ${topic.id}: FAILED — ${e.message}`);
    failures.push(e.message);
    if (/API_KEY is not set|401|403/.test(e.message)) break; // no point trying the other topics
  }
  await new Promise((r) => setTimeout(r, config.requestDelayMs));
}
if (!items.length) {
  console.error(`Nothing was written. ${failures[0] ?? "No good candidates today."}`);
  process.exit(1);
}
if (!more && !longread) {
  const used = new Set(items.map((i) => i.source.url));
  const long = Object.values(picked).flat()
    .filter((c) => !used.has(c.url) && (c.text?.split(/\s+/).length ?? 0) > 700 && ["til", "science", "design", "motion", "bike"].includes(c.topic))
    .sort((a, b) => (b.text.length - a.text.length)).slice(0, 4);
  try {
    const res = await writeLongread(config, long, plan);
    longread = res.item;
    log(longread ? `  long read: ${longread.title}` : "  long read: none suitable");
  } catch (e) { log(`  long read FAILED — ${e.message}`); }
}

// unique ids
const taken = new Set(state.editions.flatMap((e) => [e.longread, ...(e.items ?? [])].filter(Boolean).map((i) => i.id)));
// Only new items get ids checked: an existing long read keeps its id (read/rating state hangs on it).
const newLongread = longread && longread !== existing?.longread ? longread : null;
for (const it of [...items, newLongread].filter(Boolean)) {
  let id = it.id, n = 2;
  while (taken.has(id)) id = `${it.id}-${n++}`;
  it.id = id;
  taken.add(id);
}

const edition = existing
  ? { ...existing, longread: longread ?? existing.longread, items: [...existing.items, ...items], partial: more ? existing.partial : undefined }
  : { date, longread: longread ?? undefined, items, ...(more ? { partial: true } : {}) };
await writeFile(contentPath, JSON.stringify(edition, null, 2));

// 7. finalize & remember
execFileSync(process.execPath, [join(root, "scripts", "agent", "finalize.mjs"), date, ...(more || existing ? ["--append"] : [])], { stdio: "inherit" });
const final = JSON.parse(await readFile(contentPath, "utf8"));
history.add([final.longread, ...final.items].filter(Boolean).map((i) => ({ url: i.source.url, title: i.title, date, id: i.id })));
await history.save();
log(`Done: ${final.items.length} items in today's edition.`);
