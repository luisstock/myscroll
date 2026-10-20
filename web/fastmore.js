// Fast "Load more": the same idea as the daily agent, run on this device in about a minute.
//   feeds of your sources (+ Reddit / Hacker News search for topics without sources or a search query)
//   → article text → ONE Gemini call (the key from Settings → AI, or the PC server's)
// The items it writes live only on this device (myscroll:fastItems) and join the feed like any other.
import { state, allSources, topicOf, topics, isTopicActive, topicWeight, pool, slugify } from "./model.js";
import { askJSON, local, canUseAI } from "./ai.js";
import { proxied, extractArticle, canFetchPages } from "./readmore.js";
import { getJSON } from "./env.js";

const KEEP_DAYS = 30;
const DAY = 864e5;

// ---------- local items: an extra "edition" the pool reads ----------
export function localItems() {
  const since = Date.now() - KEEP_DAYS * DAY;
  return local.get("fastItems", []).filter((i) => new Date(`${i.added}T12:00:00`).getTime() >= since);
}
export const withLocal = (editions) => {
  const items = localItems();
  return items.length ? [...editions, { date: "local", items }] : editions;
};

// Adds ready-made items (e.g. an AI book summary) to the local store; an item with the same id is replaced.
export function addLocalItems(items) {
  const ids = new Set(items.map((i) => i.id));
  local.set("fastItems", [...localItems().filter((i) => !ids.has(i.id)), ...items]);
}

export const canFastLoad =() => canFetchPages && canUseAI();

// ---------- gathering ----------
const q = encodeURIComponent;
const text = (n, sel) => n.querySelector(sel)?.textContent?.trim() ?? "";
const strip = (html) => new DOMParser().parseFromString(`<div>${html}</div>`, "text/html").body.textContent.replace(/\s+/g, " ").trim();

export function parseFeed(xml) {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const rss = [...doc.querySelectorAll("item")].map((i) => ({
    title: strip(text(i, "title")), url: text(i, "link") || text(i, "guid"),
    published: text(i, "pubDate") || null,
    summary: strip(text(i, "description") || i.getElementsByTagName("content:encoded")[0]?.textContent || "").slice(0, 1500),
    image: i.getElementsByTagName("media:content")[0]?.getAttribute("url") ?? i.getElementsByTagName("media:thumbnail")[0]?.getAttribute("url")
      ?? i.querySelector("enclosure[type^=image]")?.getAttribute("url") ?? null,
  }));
  const atom = [...doc.querySelectorAll("entry")].map((e) => ({
    title: strip(text(e, "title")),
    url: [...e.querySelectorAll("link")].find((l) => (l.getAttribute("rel") ?? "alternate") === "alternate")?.getAttribute("href") ?? "",
    published: text(e, "published") || text(e, "updated") || null,
    summary: strip(text(e, "content") || text(e, "summary") || e.getElementsByTagName("media:description")[0]?.textContent || "").slice(0, 1500),
    image: e.getElementsByTagName("media:thumbnail")[0]?.getAttribute("url") ?? null,
    videoId: e.getElementsByTagName("yt:videoId")[0]?.textContent ?? null,
  }));
  return [...rss, ...atom].filter((i) => i.title && i.url);
}

let feedsMap = null;
async function feedFor(src) {
  feedsMap ??= (await getJSON("feeds.json", { optional: true })) ?? {};
  const known = feedsMap[src.url];
  if (src.type === "reddit" || /reddit\.com\/r\//.test(src.url)) return `${src.url.replace(/\/+$/, "")}/top/.rss?t=week`;
  if (known?.channelId) return `https://www.youtube.com/feeds/videos.xml?channel_id=${known.channelId}`;
  return src.feed ?? known?.feed ?? null;
}

async function fromSource(src, topic) {
  const feed = await feedFor(src);
  if (!feed) return [];
  const list = parseFeed(await proxied(feed)).slice(0, 15);
  return list.map((i) => ({ ...i, topic: topic.id, sourceId: src.id, sourceName: src.name, sourceWeight: src.weight ?? 1 }));
}

async function redditSearch(query, topic) {
  const list = parseFeed(await proxied(`https://www.reddit.com/search.rss?q=${q(query)}&sort=top&t=month`)).slice(0, 12);
  return list.map((i) => ({ ...i, topic: topic?.id, sourceId: "reddit-search", sourceName: i.url.match(/reddit\.com\/(r\/[^/]+)/)?.[1] ?? "Reddit", sourceWeight: 1 }));
}

async function hnSearch(query, topic) {
  const data = await fetch(`https://hn.algolia.com/api/v1/search?query=${q(query)}&tags=story&hitsPerPage=12`, { signal: AbortSignal.timeout(10000) }).then((r) => r.json());
  return data.hits.filter((h) => h.title && h.url).map((h) => ({
    title: h.title, url: h.url, published: h.created_at, summary: "", topic: topic?.id,
    sourceId: "hacker-news", sourceName: "Hacker News", sourceWeight: 1 + Math.min(1, (h.points ?? 0) / 300),
  }));
}

async function wikiSearch(query) {
  const data = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${q(query)}&srlimit=4&format=json&origin=*`, { signal: AbortSignal.timeout(10000) }).then((r) => r.json());
  return (data.query?.search ?? []).map((s) => ({
    title: s.title, url: `https://en.wikipedia.org/wiki/${s.title.replace(/ /g, "_")}`, published: null, summary: strip(s.snippet),
    sourceId: "wikipedia-search", sourceName: "Wikipedia", sourceWeight: 0.8,
  }));
}

const settle = async (jobs) => (await Promise.allSettled(jobs)).flatMap((r) => (r.status === "fulfilled" ? r.value : []));

// Which topics to research for a Load more scope.
function scopeTopics(scope) {
  const active = topics().filter((t) => isTopicActive(t.id));
  if (scope.topics?.length) return scope.topics.map(topicOf).filter((t) => active.some((a) => a.id === t.id));
  // "Everything": the topics you weight and like most, a few at a time so it stays fast.
  const like = (t) => topicWeight(t.id) * Math.exp(state.profile.get(`topic:${t.id}`)?.affinity ?? 0) * (0.6 + Math.random() * 0.8);
  return active.sort((a, b) => like(b) - like(a)).slice(0, 4);
}

async function gatherCandidates(scope, onStatus) {
  if (scope.query) {
    onStatus(`Searching for “${scope.query}”…`);
    return settle([redditSearch(scope.query), hnSearch(scope.query), wikiSearch(scope.query)]);
  }
  const ts = scopeTopics(scope);
  onStatus(`Checking your sources for ${ts.map((t) => t.label).join(", ")}…`);
  const sub = scope.sub ? topicOf(scope.sub.split("/")[0]).subs?.find((s) => s.id === scope.sub.split("/")[1]) : null;
  const jobs = [];
  for (const t of ts) {
    const srcs = allSources().filter((s) => s.topic === t.id && s.weight > 0).sort((a, b) => b.weight - a.weight).slice(0, 6);
    jobs.push(...srcs.map((s) => fromSource(s, t)));
    const words = sub ? `${sub.label} ${t.label}` : (t.keywords?.[0] ?? t.label);
    if (!srcs.length || sub) jobs.push(redditSearch(words, t), hnSearch(words, t));
  }
  return settle(jobs);
}

const normUrl = (u) => u.replace(/^https?:\/\/(www\.)?/, "").replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();

function pick(cands, n) {
  const seenUrls = new Set(pool().map((i) => normUrl(i.source?.url ?? "")));
  const seenTitles = new Set(pool().map((i) => i.title.toLowerCase()));
  const out = [];
  const now = Date.now();
  const scored = cands
    .filter((c) => !seenUrls.has(normUrl(c.url)) && !seenTitles.has(c.title.toLowerCase()))
    .map((c) => {
      const age = c.published ? (now - new Date(c.published).getTime()) / DAY : 10;
      return { c, s: (c.sourceWeight ?? 1) + Math.max(0, 1 - age / 14) + Math.random() * 0.3 };
    })
    .sort((a, b) => b.s - a.s);
  const per = {};
  const cap = Math.max(2, Math.ceil(n / Math.max(1, new Set(cands.map((c) => c.topic)).size)) + 1);
  for (const { c } of scored) {
    if (out.length >= n) break;
    if (out.some((o) => normUrl(o.url) === normUrl(c.url))) continue;
    const k = `${c.topic}|${c.sourceId}`;
    if ((per[k] ?? 0) >= cap) continue;
    per[k] = (per[k] ?? 0) + 1;
    out.push(c);
  }
  return out;
}

async function withText(c) {
  if (c.videoId || /reddit\.com|youtube\.com|youtu\.be/.test(c.url)) return c; // the feed text is the best we get
  try {
    const { blocks, image } = extractArticle(await proxied(c.url));
    const body = blocks.filter((b) => b.type !== "h").map((b) => b.text).join("\n").split(/\s+/).slice(0, 450).join(" ");
    return { ...c, text: body, image: c.image ?? image };
  } catch { return c; }
}

// ---------- writing ----------
const SYSTEM = `You are the editor of MyScroll, a personal daily reading app that replaces doomscrolling.
The reader: a Portuguese motion designer who reads in English before bed. Into After Effects and motion design, local and frontier AI, gravel cycling, curiosities, tech, science, design.
Write only from the provided text. Never invent facts, numbers, names or quotes; if the text is thin, write less.
Tone: curious, warm, a little witty, no hype, no clickbait.
title: specific and intriguing, max 90 characters. snippet: 1-2 sentences. body: 2-3 short paragraphs, 80-200 words. more: 2-4 paragraphs, 150-300 words, deeper, no repetition of the body.
tags: 2-5 lowercase-hyphenated tags. Skip ads, sponsored posts, job listings, memes and anything not genuinely interesting.`;

const SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          candidate: { type: "integer" }, sub: { type: "string" },
          style: { type: "string", enum: ["til", "story", "reddit", "news", "explainer", "video", "list"] },
          tags: { type: "array", items: { type: "string" } },
          title: { type: "string" }, snippet: { type: "string" },
          body: { type: "array", items: { type: "string" } }, more: { type: "array", items: { type: "string" } },
        },
        required: ["candidate", "sub", "style", "tags", "title", "snippet", "body", "more"],
      },
    },
  },
  required: ["items"],
};

function prompt(cands, scope, n) {
  const ts = [...new Set(cands.map((c) => c.topic).filter(Boolean))].map(topicOf);
  const likes = [...state.profile.entries()].filter(([, e]) => e.affinity > 0.15).sort((a, b) => b[1].affinity - a[1].affinity).slice(0, 8).map(([f]) => f.split(":")[1]);
  return [
    scope.query ? `The reader searched for: "${scope.query}". Only write items that really match it.` : "",
    ...ts.map((t) => `Topic ${t.id} = ${t.emoji} ${t.label}${t.description ? ` (${t.description})` : ""}${t.subs?.length ? `; subcategories for "sub": ${t.subs.map((s) => s.id).join(", ")}` : ""}${t.lang === "pt" ? "; write this topic in European Portuguese" : ""}`),
    scope.sub ? `Write ONLY items for subcategory "${scope.sub.split("/")[1]}"; skip candidates that don't fit.` : "",
    likes.length ? `The reader likes: ${likes.join(", ")}.` : "",
    `Write ${n} items: pick the ${n} best candidates and write one item for each (skip a candidate only if it is an ad, a job post or empty). Use "" for sub when none fits.`,
    "",
    ...cands.map((c, i) => [
      `### Candidate ${i}`, `Title: ${c.title}`, `Source: ${c.sourceName}${c.published ? ` · ${String(c.published).slice(0, 16)}` : ""}`, `URL: ${c.url}`,
      `Text:\n${c.text || c.summary || "(only the title)"}`,
    ].join("\n")),
  ].filter((l) => l !== "").join("\n");
}

function toItem(it, c, scope, taken) {
  const topic = topicOf(c.topic ?? scope.topics?.[0] ?? "search");
  let id = `${topic.id}-${slugify(it.title)}`.slice(0, 56).replace(/-$/, "");
  for (let k = 2; taken.has(id); k++) id = `${id.replace(/-\d+$/, "")}-${k}`;
  taken.add(id);
  const published = c.published && !isNaN(new Date(c.published)) ? new Date(c.published).toISOString().slice(0, 10) : undefined;
  const fresh = published && Date.now() - new Date(published).getTime() < 7 * DAY;
  const videoId = c.videoId ?? c.url.match(/youtube\.com\/watch\?v=([\w-]{11})/)?.[1];
  const sub = topic.subs?.some((s) => s.id === it.sub) ? it.sub : scope.sub?.split("/")[1];
  const words = [it.snippet, ...it.body].join(" ").split(/\s+/).length;
  return {
    id, topic: topic.id, ...(sub ? { sub } : {}),
    kind: fresh && it.style === "news" ? "news" : "evergreen",
    ...(published ? { published } : {}),
    style: videoId ? "video" : it.style, tags: it.tags,
    title: it.title.trim(), snippet: it.snippet.trim(), body: it.body.filter(Boolean), more: it.more.filter(Boolean),
    source: { id: c.sourceId, name: c.sourceName, url: c.url },
    ...(videoId ? { video: { provider: "youtube", id: videoId, title: c.title } } : {}),
    ...(c.image && !videoId ? { image: { src: c.image } } : {}),
    lang: topic.lang ?? "en", minutes: Math.max(1, Math.round(words / 220)),
    added: state.latest, fast: true,
    ...(scope.query ? { query: scope.query.trim().toLowerCase().replace(/\s+/g, " ") } : {}),
  };
}

// scope: { topics, sub, query } like Load more. Resolves with the number of items added.
export async function fastLoadMore(onStatus, scope = {}) {
  if (!canFetchPages) throw new Error("Fast Load more works in the Android app and on the PC.");
  const n = Math.min(6, state.settings.loadMoreCount ?? 15); // small batches keep it quick
  const t0 = Date.now();
  const lap = (what) => console.debug(`[fast] ${what} after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const cands = await gatherCandidates(scope, onStatus);
  lap(`gathered ${cands.length}`);
  const picked = pick(cands, Math.round(n * 1.5));
  if (!picked.length) throw new Error("Nothing new in your sources right now. Try the Full agent.");
  onStatus(`Reading ${picked.length} articles…`);
  const withTexts = await Promise.all(picked.map(withText));
  lap(`read ${withTexts.filter((c) => c.text).length}/${picked.length} articles`);
  onStatus("Writing your items…");
  const { items } = await askJSON({ system: SYSTEM, prompt: prompt(withTexts, scope, n), schema: SCHEMA, fast: true });
  lap("written");
  const taken = new Set(pool().map((i) => i.id));
  const fresh = (items ?? []).filter((it) => withTexts[it.candidate]).map((it) => toItem(it, withTexts[it.candidate], scope, taken));
  if (!fresh.length) throw new Error("Gemini didn't find anything worth writing up. Try again or use the Full agent.");
  local.set("fastItems", [...localItems(), ...fresh]);
  return fresh.length;
}
