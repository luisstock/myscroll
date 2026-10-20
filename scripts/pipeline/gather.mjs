// Collects candidate stories from the user's sources without any AI:
// RSS/Atom feeds (discovered from each site), Reddit top posts, YouTube channel feeds,
// Hacker News front page and Wikipedia's daily featured feed.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { XMLParser } from "fast-xml-parser";
import { parseHTML } from "linkedom";
import { root } from "../agent/context.mjs";

const UA = "Mozilla/5.0 (compatible; MyScroll/0.2; personal reading app)";
const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", textNodeName: "#text" });
const cachePath = join(root, "data", "source-cache.json");
let cache = {};

export async function get(url, { json = false, timeout = 15000 } = {}) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: json ? "application/json" : "*/*" }, redirect: "follow", signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return json ? res.json() : res.text();
}

const text = (v) => (v == null ? "" : typeof v === "string" ? v : v["#text"] ?? (Array.isArray(v) ? text(v[0]) : ""));
export const stripHtml = (html = "") => parseHTML(`<div>${html}</div>`).document.querySelector("div").textContent.replace(/\s+/g, " ").trim();
const asArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

// ---------- feeds ----------
async function discoverFeed(src) {
  if (src.feed) return src.feed;
  if (cache[src.url]?.feed !== undefined) return cache[src.url].feed;
  let feed = null;
  try {
    const u = new URL(src.url);
    if (/substack\.com$/.test(u.hostname) || /\/feed\/?$/.test(u.pathname)) feed = new URL("/feed", u).href;
    else if (/vimeo\.com$/.test(u.hostname) && u.pathname.startsWith("/channels/")) feed = `${u.origin}${u.pathname.replace(/\/$/, "")}/videos/rss`;
    else {
      const html = await get(src.url);
      const { document } = parseHTML(html);
      const link = document.querySelector('link[rel="alternate"][type="application/rss+xml"], link[rel="alternate"][type="application/atom+xml"]');
      if (link?.getAttribute("href")) feed = new URL(link.getAttribute("href"), src.url).href;
      for (const guess of feed ? [] : ["/feed", "/rss", "/feed.xml", "/rss.xml", "/atom.xml", "/index.xml"]) {
        const url = new URL(guess, src.url).href;
        try { const body = await get(url, { timeout: 8000 }); if (/<(rss|feed)[\s>]/.test(body.slice(0, 500))) { feed = url; break; } } catch {}
      }
    }
  } catch {}
  cache[src.url] = { ...cache[src.url], feed };
  return feed;
}

export function parseFeed(body) {
  const doc = xml.parse(body);
  if (doc.rss) {
    return asArray(doc.rss.channel?.item).map((i) => ({
      title: stripHtml(text(i.title)), url: text(i.link) || text(i.guid),
      published: i.pubDate ? new Date(text(i.pubDate)) : null,
      summary: stripHtml(text(i.description) || text(i["content:encoded"])).slice(0, 2000),
      image: i["media:content"]?.["@url"] ?? i["media:thumbnail"]?.["@url"] ?? i.enclosure?.["@url"] ?? null,
    }));
  }
  if (doc.feed) {
    return asArray(doc.feed.entry).map((e) => {
      const links = asArray(e.link);
      const href = (links.find((l) => l["@rel"] === "alternate") ?? links[0])?.["@href"];
      const group = e["media:group"];
      return {
        title: stripHtml(text(e.title)), url: href,
        published: e.published || e.updated ? new Date(text(e.published) || text(e.updated)) : null,
        summary: stripHtml(text(e.summary) || text(e.content) || text(group?.["media:description"])).replace(/submitted by .*$/, "").slice(0, 2000),
        image: group?.["media:thumbnail"]?.["@url"] ?? null,
        videoId: text(e["yt:videoId"]) || null,
      };
    });
  }
  return [];
}

// ---------- special sources ----------
// Reddit blocks its JSON API for scripts but serves RSS, with a tight rate limit:
// one request at a time, a pause between them, one retry after a 429.
let redditQueue = Promise.resolve();
export function redditGet(url) {
  const run = async () => {
    await new Promise((r) => setTimeout(r, 6500)); // ~10 requests/minute without an API key
    try { return await get(url); } catch (e) {
      if (!/429/.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 15000));
      return get(url);
    }
  };
  const p = redditQueue.then(run, run);
  redditQueue = p.catch(() => {});
  return p;
}

async function reddit(src) {
  const m = src.url.match(/reddit\.com\/r\/([^/?#]+)/);
  if (!m) return [];
  const items = parseFeed(await redditGet(`https://www.reddit.com/r/${m[1]}/top/.rss?t=day&limit=15`));
  // Rank order of "top of the day" stands in for score (RSS has no vote counts).
  return items.map((i, rank) => ({ ...i, engagement: Math.max(0, 3000 - rank * 200) }));
}

async function youtube(src) {
  let id = cache[src.url]?.channelId;
  if (!id) {
    const html = await get(src.url);
    id = html.match(/"channelId":"(UC[\w-]{22})"/)?.[1] ?? html.match(/channel\/(UC[\w-]{22})/)?.[1];
    if (!id) throw new Error("no channel id");
    cache[src.url] = { ...cache[src.url], channelId: id };
  }
  return parseFeed(await get(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`));
}

async function hackerNews(src, topic) {
  const data = await get("https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=40", { json: true });
  const GENERIC = new Set(["open", "release", "local", "video", "after", "effects", "model", "models", "news", "latest", "workflow", "generation", "benchmark", "design", "new"]);
  const kw = (topic.keywords ?? []).concat(topic.label).join(" ").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !GENERIC.has(w));
  if (topic.id === "ai") kw.push("llm", "gpt", "claude", "gemini", "llama", "openai", "anthropic", "diffusion", "neural", "agent", "agents", "transformer", "qwen", "deepseek", "mistral");
  const hit = (title) => title.toLowerCase().split(/[^a-z0-9.]+/).some((w) => kw.includes(w));
  return data.hits
    .filter((h) => h.url && hit(h.title))
    .map((h) => ({ title: h.title, url: h.url, published: new Date(h.created_at), summary: "", engagement: h.points + 2 * h.num_comments, discussion: `https://news.ycombinator.com/item?id=${h.objectID}` }));
}

async function wikipediaFeatured(date) {
  const [y, m, d] = date.split("-");
  const data = await get(`https://en.wikipedia.org/api/rest_v1/feed/featured/${y}/${m}/${d}`, { json: true });
  const out = [];
  const page = (p) => p && ({ title: p.titles?.normalized ?? p.title, url: p.content_urls?.desktop?.page, summary: p.extract ?? "", wiki: p.title, evergreen: true });
  if (data.tfa) out.push({ ...page(data.tfa), title: `${data.tfa.titles?.normalized}` });
  for (const ev of (data.onthisday ?? []).slice(0, 8)) {
    const p = ev.pages?.[0];
    if (p) out.push({ ...page(p), title: `On this day in ${ev.year}: ${ev.text}`.slice(0, 160) });
  }
  return out.filter((x) => x.url);
}

// ---------- main ----------
// The app's fast Load more reads feeds straight from the phone: publish the feeds/channels found so far.
export async function writeFeeds() {
  const feeds = {};
  for (const [url, c] of Object.entries(cache)) if (c.feed || c.channelId) feeds[url] = { ...(c.feed ? { feed: c.feed } : {}), ...(c.channelId ? { channelId: c.channelId } : {}) };
  await writeFile(join(root, "web", "feeds.json"), JSON.stringify(feeds, null, 1));
}

export async function gather(plan, { log = console.log } = {}) {
  cache = JSON.parse(await readFile(cachePath, "utf8").catch(() => "{}"));
  const jobs = [];
  for (const topic of plan.topics) {
    for (const src of topic.sources) {
      jobs.push(async () => {
        let items;
        if (src.type === "reddit") items = await reddit(src);
        else if (/youtube\.com\/@|youtube\.com\/channel\//.test(src.url)) items = await youtube(src);
        else if (src.id === "hacker-news") items = await hackerNews(src, topic);
        else if (src.id === "wikipedia-dyk") items = await wikipediaFeatured(plan.date);
        else {
          const feed = await discoverFeed(src);
          if (!feed) throw new Error("no feed found");
          items = parseFeed(await get(feed));
        }
        return items.filter((i) => i.title && i.url).slice(0, 25).map((i) => {
          const yt = i.videoId ?? i.url.match(/youtube\.com\/watch\?v=([\w-]{11})/)?.[1];
          return {
            ...i, topic: topic.id, sourceId: src.id, sourceName: src.name, sourceType: src.type, sourceWeight: src.weight,
            published: i.published && !isNaN(i.published) ? i.published.toISOString() : null,
            video: yt ? { provider: "youtube", id: yt } : null,
          };
        });
      });
      jobs[jobs.length - 1].label = `${topic.id}/${src.name}`;
    }
  }
  // A few at a time: polite to the sites, fast enough.
  const results = [];
  const report = [];
  for (let i = 0; i < jobs.length; i += 6) {
    const batch = jobs.slice(i, i + 6);
    const settled = await Promise.allSettled(batch.map((j) => j()));
    settled.forEach((r, k) => {
      if (r.status === "fulfilled") { results.push(...r.value); report.push(`  ✓ ${batch[k].label}: ${r.value.length}`); }
      else report.push(`  ✗ ${batch[k].label}: ${r.reason?.message ?? r.reason}`);
    });
  }
  await mkdir(join(root, "data"), { recursive: true });
  await writeFile(cachePath, JSON.stringify(cache, null, 2));
  await writeFeeds();
  log(report.join("\n"));
  return results;
}
