// Query and URL gathering without any AI, used by "Search", "Follow a story" and "Share to MyScroll":
//   searchGather(query)   Google News RSS search, Reddit search RSS, Hacker News (Algolia), Wikipedia search
//   urlCandidate(url)     one candidate from a pasted link (article, Reddit thread or YouTube video)
import { XMLParser } from "fast-xml-parser";
import { get, redditGet, parseFeed, stripHtml } from "./gather.mjs";
import { normUrl, titleSimilarity } from "./history.mjs";

const DAY = 864e5;
const q = encodeURIComponent;

// ---------- Google News: links are redirect stubs, resolve them to the publisher's page ----------
export async function resolveGoogleNews(link) {
  try {
    const id = link.match(/news\.google\.com\/(?:rss\/)?articles\/([^?/]+)/)?.[1];
    if (!id) return link;
    const html = await get(`https://news.google.com/rss/articles/${id}?hl=en-US&gl=US&ceid=US:en`, { timeout: 10000 });
    const sg = html.match(/data-n-a-sg="([^"]+)"/)?.[1], ts = html.match(/data-n-a-ts="([^"]+)"/)?.[1];
    if (!sg || !ts) return link;
    const inner = JSON.stringify(["garturlreq", [["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1, null, null, null, null, null, 0, 1], "X", "X", 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0], id, Number(ts), sg]);
    const res = await fetch("https://news.google.com/_/DotsSplashUi/data/batchexecute", {
      method: "POST", signal: AbortSignal.timeout(10000),
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", "User-Agent": "Mozilla/5.0 (compatible; MyScroll/0.2)" },
      body: "f.req=" + q(JSON.stringify([[["Fbv4je", inner, null, "generic"]]])),
    });
    const m = (await res.text()).match(/garturlres\\",\\"(https?:[^"\\]+)/);
    return m?.[1] ?? link;
  } catch { return link; }
}

async function gnews(query) {
  const items = parseFeed(await get(`https://news.google.com/rss/search?q=${q(query)}&hl=en-US&gl=US&ceid=US:en`));
  const out = [];
  for (const i of items.slice(0, 20)) {
    // Titles end with " - Publisher".
    const m = i.title.match(/^(.*) - ([^-]{2,60})$/);
    out.push({ ...i, title: m?.[1] ?? i.title, sourceId: "web", sourceName: m?.[2] ?? "Google News", sourceType: "news", summary: "", googleNews: i.url });
  }
  // Resolve links a few at a time (only the freshest ones; the rest keep the stub and are unlikely to be picked).
  for (let k = 0; k < out.length; k += 5) await Promise.all(out.slice(k, k + 5).map(async (c) => { c.url = await resolveGoogleNews(c.googleNews); }));
  return out.filter((c) => !/news\.google\.com/.test(c.url));
}

async function redditSearch(query) {
  const items = parseFeed(await redditGet(`https://www.reddit.com/search.rss?q=${q(query)}&sort=top&t=month`));
  return items.slice(0, 12).map((i, rank) => ({
    ...i, sourceId: "reddit-search", sourceType: "reddit",
    sourceName: i.url?.match(/reddit\.com\/(r\/[^/]+)/)?.[1] ?? "Reddit", engagement: Math.max(0, 3000 - rank * 250),
  }));
}

async function hn(query) {
  const data = await get(`https://hn.algolia.com/api/v1/search?query=${q(query)}&tags=story&hitsPerPage=15`, { json: true });
  return data.hits.filter((h) => h.title).map((h) => ({
    title: h.title, url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`, published: new Date(h.created_at), summary: "",
    engagement: (h.points ?? 0) + 2 * (h.num_comments ?? 0), discussion: `https://news.ycombinator.com/item?id=${h.objectID}`,
    sourceId: "hacker-news", sourceName: "Hacker News", sourceType: "news",
  }));
}

async function wikipedia(query) {
  const data = await get(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${q(query)}&srlimit=5&format=json`, { json: true });
  return (data.query?.search ?? []).map((s) => ({
    title: s.title, url: `https://en.wikipedia.org/wiki/${s.title.replace(/ /g, "_")}`, published: null, summary: stripHtml(s.snippet),
    evergreen: true, wiki: s.title.replace(/ /g, "_"), sourceId: "wikipedia-search", sourceName: "Wikipedia", sourceType: "wiki",
  }));
}

const SOURCES = { gnews, reddit: redditSearch, hn, wiki: wikipedia };
const words = (t) => String(t).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2);

// Candidates for a query. opts: { sources: ["gnews","reddit","hn","wiki"], sinceDays, since (ISO), log }
// Items with a known date older than the window are dropped.
export async function searchGather(query, { sources = Object.keys(SOURCES), sinceDays = null, since = null, log = () => {} } = {}) {
  const jobs = sources.map(async (name) => {
    try {
      const list = await SOURCES[name](query);
      log(`  ✓ search ${name}: ${list.length}`);
      return list;
    } catch (e) { log(`  ✗ search ${name}: ${e.message}`); return []; }
  });
  // Reddit's queue is serialised inside redditGet; the others run in parallel.
  const all = (await Promise.all(jobs)).flat();
  const minTime = Math.max(sinceDays ? Date.now() - sinceDays * DAY : 0, since ? new Date(since).getTime() || 0 : 0);
  const qw = words(query);
  const now = Date.now();
  return all.filter((c) => c.title && c.url).map((c) => {
    const published = c.published && !isNaN(c.published) ? new Date(c.published).toISOString() : null;
    const yt = c.videoId ?? c.url.match(/youtube\.com\/watch\?v=([\w-]{11})/)?.[1];
    const text = `${c.title} ${c.summary ?? ""}`.toLowerCase();
    const rel = qw.length ? qw.filter((w) => text.includes(w)).length / qw.length : 0;
    const age = published ? (now - new Date(published)) / DAY : null;
    const score = rel * 2 + (c.engagement ? Math.min(0.8, Math.log10(1 + c.engagement) / 5) : 0) + (age == null ? 0 : Math.max(0, 1 - age / 30) * 0.5);
    const kind = published && age <= 7 && !c.evergreen ? "news" : "evergreen";
    return { ...c, published, sourceWeight: 1, video: yt ? { provider: "youtube", id: yt } : null, kind, score };
  }).filter((c) => !(minTime && c.published && new Date(c.published).getTime() < minTime))
    .filter((c) => !qw.length || c.score >= 0.4 || c.sourceType === "reddit" || c.sourceType === "wiki")
    .sort((a, b) => b.score - a.score);
}

// Drops seen/duplicate candidates and keeps a mix of sources: at most `perSource` per source id.
export function pickCandidates(list, { history, skip = [], max = 30, perSource = 6 }) {
  const skipSet = new Set(skip.map(normUrl));
  const out = [];
  const count = {};
  for (const c of list) {
    if (out.length >= max) break;
    if (history.seen(c) || skipSet.has(normUrl(c.url))) continue;
    if (out.some((s) => normUrl(s.url) === normUrl(c.url) || titleSimilarity(s.title, c.title) >= 0.75)) continue;
    if ((count[c.sourceId] ?? 0) >= perSource) continue;
    count[c.sourceId] = (count[c.sourceId] ?? 0) + 1;
    out.push(c);
  }
  return out;
}

// ---------- Share: one candidate from a URL ----------
const xml = new XMLParser({ ignoreAttributes: false });
export async function urlCandidate(url) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error("http(s) links only");
  const host = u.hostname.replace(/^(www|m|old)\./, "");
  const base = { url, published: null, sourceWeight: 1, kind: "evergreen", shared: true };
  const yt = host === "youtu.be" ? u.pathname.slice(1, 12) : /youtube\.com$/.test(host) ? (u.searchParams.get("v") ?? u.pathname.match(/\/(?:shorts|embed|live)\/([\w-]{11})/)?.[1]) : null;
  if (yt && /^[\w-]{11}$/.test(yt)) {
    const o = await get(`https://www.youtube.com/oembed?url=${q(`https://www.youtube.com/watch?v=${yt}`)}&format=json`, { json: true });
    return { ...base, url: `https://www.youtube.com/watch?v=${yt}`, title: o.title, summary: `Video by ${o.author_name}.`, video: { provider: "youtube", id: yt }, sourceId: "shared", sourceName: o.author_name || "YouTube", sourceType: "youtube" };
  }
  if (/(^|\.)reddit\.com$/.test(host) && /\/comments\//.test(u.pathname)) {
    // The thread JSON is blocked for scripts; the RSS (post + top comments) is not. extract() reads the same feed.
    const feed = xml.parse(await redditGet(url.replace(/[?#].*$/, "").replace(/\/?$/, "/.rss?sort=top&limit=8")));
    const e = [].concat(feed.feed?.entry ?? [])[0];
    const title = typeof e?.title === "string" ? e.title : e?.title?.["#text"] ?? u.pathname.split("/")[5]?.replace(/_/g, " ") ?? "Reddit thread";
    return { ...base, title, summary: "", sourceId: "reddit-share", sourceName: `r/${u.pathname.split("/")[2]}`, sourceType: "reddit" };
  }
  return { ...base, title: u.hostname, summary: "", sourceId: "shared", sourceName: host, sourceType: "site", needsTitle: true };
}
