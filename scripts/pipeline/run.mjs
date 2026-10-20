// The daily MyScroll pipeline. No AI until the very last step:
//   plan → gather (RSS/Reddit/YouTube/HN/Wikipedia) → preselect → extract article text
//   → write (Gemini / Ollama / Claude, one call per topic) → finalize (validate, images, publish)
//
// Usage:
//   node scripts/pipeline/run.mjs                 today's edition (+ updates on followed stories)
//   node scripts/pipeline/run.mjs --dry           everything except the model: writes data/candidates-<date>.json
//   node scripts/pipeline/run.mjs --more 15       "Load more": ~15 extra items appended to today's edition
//   options: --date YYYY-MM-DD  --topics ai,motion  --force (redo today's edition)
//            --reuse (skip gathering: write from data/candidates-<date>.json of the last run)
//   Load more variants (append to today's edition):
//            --more 15 --topics ai --sub ai/frontier   only that subcategory
//            --more 10 --query "text"                  web search (no AI gathering), the model picks the best ~N
//            --url https://…                           "Share": one item from that page (flagged shared)
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { loadContext, localDate, root } from "../agent/context.mjs";
import { gather } from "./gather.mjs";
import { preselect } from "./select.mjs";
import { extract } from "./extract.mjs";
import { writeTopic, writeLongread, writeSearch, writeShare, writeFollows } from "./write.mjs";
import { loadHistory, seedFromEditions } from "./history.mjs";
import { searchGather, pickCandidates, urlCandidate } from "./search.mjs";
import { discoverSources } from "../agent/discover.mjs";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const flag = (name) => args.includes(`--${name}`);
const date = opt("date") ?? localDate();
const dry = flag("dry");
const query = opt("query")?.trim().slice(0, 200) || "";
const shareUrl = opt("url")?.trim() || "";
const subArg = opt("sub") || "";
const more = flag("more") ? Number(opt("more")) || (query ? 10 : 15) : 0;
const append = !!(more || query || shareUrl); // adds to today's edition instead of making it
const onlyTopics = opt("topics")?.split(",");
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s]`, ...a);
const normQuery = (q) => q.trim().toLowerCase().replace(/\s+/g, " ");
const fail = (msg) => { console.error(msg); process.exit(1); };

if (shareUrl && !/^https?:\/\//i.test(shareUrl)) fail("--url must be an http(s) link");
if ([subArg, query, shareUrl].filter(Boolean).length > 1) fail("Use only one of --sub, --query and --url");

const config = JSON.parse(await readFile(join(root, "myscroll.config.json"), "utf8"));
const contentPath = join(root, "content", `${date}.json`);
const existing = JSON.parse(await readFile(contentPath, "utf8").catch(() => "null"));
const published = await readFile(join(root, "web", "editions", `${date}.json`)).then(() => true, () => false);
// An edition started by "Load more" (e.g. just after midnight) is partial: the daily run still completes it.
if (published && !append && !dry && !flag("force") && !existing?.partial) {
  log(`Edition for ${date} already exists. Use --more N to add items or --force to redo it.`);
  process.exit(0);
}

// 1. plan
execFileSync(process.execPath, [join(root, "scripts", "agent", "plan.mjs"), date], { stdio: "ignore" });
const plan = JSON.parse(await readFile(join(root, "data", `plan-${date}.json`), "utf8"));
const discovered = []; // sources found for new topics (finalize adds them to the catalog)
const readyTopics = [];

// 2. memory of everything shown, so nothing repeats
const { model, ranking, state, live } = await loadContext();
const history = await loadHistory();
if (!history.list.length) await seedFromEditions(history, state.editions);
const todaysUrls = [...(existing?.items ?? []), existing?.longread].filter(Boolean).map((i) => i.source?.url);

// "Not interested": never pick a story whose item the reader hid (the taste profile handles the rest in the app).
const pool = state.editions.flatMap((e) => [e.longread, ...(e.items ?? [])]).filter(Boolean);
const hiddenIds = new Set(live(state.hidden).map((h) => h.id));
const hiddenUrls = pool.filter((i) => hiddenIds.has(i.id)).map((i) => i.source?.url).filter(Boolean);
const skipUrls = [...todaysUrls, ...hiddenUrls];

// Subcategory focus: --sub topic/sub (restricts the plan to that topic).
let sub = null;
if (subArg) {
  const [tid, sid] = subArg.split("/");
  const t = plan.topics.find((x) => x.id === tid);
  const s = t?.subs.find((x) => x.id === sid);
  if (!s) fail(`Unknown or inactive subcategory "${subArg}"`);
  sub = { topic: tid, id: sid, label: s.label };
  plan.topics = [t];
} else if (onlyTopics && !query && !shareUrl) plan.topics = plan.topics.filter((t) => onlyTopics.includes(t.id));
if (more && !query && !shareUrl) {
  // Spread the extra items over the topics the same way as the daily slots.
  const sum = plan.topics.reduce((s, t) => s + t.slots, 0) || 1;
  for (const t of plan.topics) t.slots = Math.max(1, Math.round((t.slots / sum) * more));
}
const mode = shareUrl ? "share" : query ? "search" : sub ? "sub" : more ? "more" : "daily";
log(`Plan (${mode}): ${plan.topics.length} topics, ${plan.topics.reduce((s, t) => s + t.slots, 0)} slots, provider ${process.env.MYSCROLL_PROVIDER || config.provider}`);

const extractAll = async (list) => {
  const out = [];
  for (let i = 0; i < list.length; i += 4) out.push(...await Promise.all(list.slice(i, i + 4).map((c) => extract(c, config.articleMaxWords))));
  return out;
};
const usable = (c) => (c.text?.split(/\s+/).length ?? 0) >= 40 || c.video;

let items = [];
let longread = existing?.longread ?? null;
let picked = {};

if (shareUrl) {
  // ---- Share: one page → one item ----
  if (history.seen({ url: shareUrl, title: "" })) { log("Already in the history: nothing to do."); process.exit(0); }
  const cand = await urlCandidate(shareUrl);
  if (history.seen({ url: cand.url, title: "" })) { log("Already in the history: nothing to do."); process.exit(0); }
  const [c] = await extractAll([cand]);
  log(`Extracted "${c.title}" (${c.text?.split(/\s+/).length ?? 0} words)`);
  if (dry) { log(JSON.stringify(c).slice(0, 600)); process.exit(0); }
  if (!usable(c)) fail("Couldn't read that page (no text found).");
  items = (await writeShare(config, c, plan)).items;
  if (!items.length) fail("Nothing was written for that page.");
  log(`  shared: ${items[0].title}`);
} else if (query) {
  // ---- Search: web search feeds → one model call picks the best N ----
  log(`Searching the web for "${query}"…`);
  const found = await searchGather(query, { log: (r) => console.log(r) });
  const cands = pickCandidates(found, { history, skip: skipUrls, max: Math.min(40, more * 3) });
  log(`${found.length} found, ${cands.length} new`);
  const texts = (await extractAll(cands)).filter(usable);
  log(`${texts.length} with readable text`);
  if (dry) { await writeFile(join(root, "data", `candidates-${date}.json`), JSON.stringify(texts, null, 2)); log("Dry run: saved candidates."); process.exit(0); }
  if (!texts.length) fail("The search found nothing new and readable.");
  items = (await writeSearch(config, texts, plan, { query, n: more, queryKey: normQuery(query) })).items;
  log(`  search: ${items.length} written`);
} else {
  const candidatesPath = join(root, "data", `candidates-${date}.json`);
  if (flag("reuse")) {
    // Skip gathering/extraction and reuse the last run's candidates (handy when only the writing failed).
    picked = JSON.parse(await readFile(candidatesPath, "utf8"));
    for (const t of Object.keys(picked)) picked[t] = picked[t].filter((c) => !history.seen(c) && !skipUrls.includes(c.url));
    log(`Reusing saved candidates: ${Object.entries(picked).map(([t, l]) => `${t} ${l.length}`).join(", ")}`);
  } else {
    // 3. gather
    // Topics with no sources (usually new ones): find and check some first (they reach the app through the catalog).
    for (const topic of plan.topics.filter((t) => !t.sources.length && !dry)) {
      try {
        const found = await discoverSources(config, topic, log, plan.profile);
        topic.sources = found.map((s) => ({ id: `${topic.id}-${s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`.slice(0, 50), name: s.name, url: s.url, type: s.type, weight: 1, ...(s.feed ? { feed: s.feed } : {}) }));
        discovered.push(...found.map((s) => ({ topic: topic.id, name: s.name, url: s.url, type: s.type, activate: true })));
        if (found.length) readyTopics.push(topic.id);
      } catch (e) { log(`  ${topic.id}: couldn't find sources — ${e.message}`); }
    }
    log("Gathering from sources…");
    const candidates = await gather(plan, { log: (r) => console.log(r) });
    if (sub) {
      // Search the web for the subcategory too: its sources may be thin.
      const topic = plan.topics[0];
      const found = await searchGather(`${sub.label} ${topic.label}`, { sources: ["gnews", "hn"], sinceDays: 30, log: (r) => console.log(r) });
      candidates.push(...found.slice(0, 20).map((c) => ({ ...c, topic: topic.id })));
    }
    // A topic the user just created has no sources yet: search the web for its name and keywords instead.
    for (const topic of plan.topics.filter((t) => !t.sources.length)) {
      const queries = [...new Set([topic.label, ...topic.keywords.slice(0, 2)])];
      for (const q of queries) {
        const found = await searchGather(q, { sinceDays: 14, log: (r) => console.log(r) });
        candidates.push(...found.slice(0, 15).map((c) => ({ ...c, topic: topic.id })));
      }
    }
    log(`${candidates.length} candidates`);

    // 4. preselect
    picked = preselect(plan, candidates, {
      history, ranking, profile: state.profile, config, extraSkip: skipUrls, sub,
      settings: { topicWeights: state.settings.topicWeights, sourceWeights: model.sourceWeights() },
    });
    log(`Preselected: ${Object.entries(picked).map(([t, l]) => `${t} ${l.length}`).join(", ")}`);

    // 5. extract real text
    for (const [topic, list] of Object.entries(picked)) picked[topic] = await extractAll(list);
    const words = Object.values(picked).flat().reduce((s, c) => s + (c.text?.split(/\s+/).length ?? 0), 0);
    log(`Extracted ~${words} words of source text`);
    await writeFile(candidatesPath, JSON.stringify(picked, null, 2));
  }

  if (dry) {
    log(`Dry run: candidates saved to ${candidatesPath}`);
    process.exit(0);
  }

  // 6. write
  const failures = [];
  for (const topic of plan.topics) {
    const list = picked[topic.id] ?? [];
    if (!list.length) { log(`  ${topic.id}: no candidates`); continue; }
    try {
      const res = await writeTopic(config, topic, list, plan, { sub });
      items.push(...res.items);
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

  // 6b. updates on followed stories (daily run only): up to 2 per follow, one model call for all
  if (!more) {
    try {
      const upd = await followUpdates();
      if (upd.length) { items.push(...upd); log(`  follows: ${upd.length} update(s)`); }
    } catch (e) { log(`  follows FAILED — ${e.message}`); }
  }
}

async function followUpdates() {
  const follows = live(state.follows).filter((f) => f.query && f.title);
  if (!follows.length) return [];
  const cands = [];
  for (const f of follows) {
    const found = await searchGather(f.query, { sinceDays: 7, since: f.since, log: () => {} });
    // Only stories with a known date count as "new" for a follow (undated wiki/evergreen hits are not updates).
    const fresh = found.filter((c) => c.published);
    const list = pickCandidates(fresh, { history, skip: [...skipUrls, ...cands.map((c) => c.url)], max: 4, perSource: 2 });
    log(`  follow "${f.title}": ${list.length} new candidate(s)`);
    cands.push(...(await extractAll(list)).filter(usable).map((c) => ({ ...c, followId: f.id })));
  }
  if (!cands.length) return [];
  const topicOf = (id) => follows.find((f) => f.id === id)?.topic;
  const res = await writeFollows(config, cands, plan, follows, topicOf);
  const perFollow = {};
  return res.items.filter((it) => (perFollow[it.follow] = (perFollow[it.follow] ?? 0) + 1) <= 2);
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
  ? { ...existing, longread: longread ?? existing.longread, items: [...existing.items, ...items], partial: append ? existing.partial : undefined }
  : { date, longread: longread ?? undefined, items, ...(append ? { partial: true } : {}) };
if (discovered.length) edition.discoveredSources = [...(edition.discoveredSources ?? []), ...discovered];
if (readyTopics.length) edition.readyTopics = [...new Set([...(edition.readyTopics ?? []), ...readyTopics])];
await writeFile(contentPath, JSON.stringify(edition, null, 2));

// 7. finalize & remember
execFileSync(process.execPath, [join(root, "scripts", "agent", "finalize.mjs"), date, ...(append || existing ? ["--append"] : [])], { stdio: "inherit" });
const final = JSON.parse(await readFile(contentPath, "utf8"));
history.add([final.longread, ...final.items].filter(Boolean).map((i) => ({ url: i.source.url, title: i.title, date, id: i.id })));
await history.save();
log(`Done: ${final.items.length} items in today's edition.`);
