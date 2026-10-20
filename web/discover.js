// "Find sources": Gemini suggests sources for a topic from its name and description, then this device checks
// that each one is alive (a working feed, subreddit or YouTube channel) before adding it as a normal source
// you can weight, turn off or delete. The daily agent does the same for new topics that still have none.
import { state, allSources, saveSettings, slugify } from "./model.js";
import { askJSON, canUseAI } from "./ai.js";
import { proxied, canFetchPages } from "./readmore.js";
import { parseFeed } from "./fastmore.js";

export const canDiscover = () => canUseAI() && canFetchPages;

const SCHEMA = {
  type: "object",
  properties: {
    sources: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          url: { type: "string", description: "homepage, subreddit URL (https://www.reddit.com/r/name) or YouTube channel URL (https://www.youtube.com/@handle)" },
          type: { type: "string", enum: ["reddit", "video", "site", "newsletter"] },
          why: { type: "string" },
        },
        required: ["name", "url", "type", "why"],
      },
    },
  },
  required: ["sources"],
};

async function suggest(topic) {
  const prompt = [
    `Suggest 10 high-quality, currently active sources for this reading topic: ${topic.label}.`,
    topic.description ? `What the reader wants: ${topic.description}` : "",
    topic.keywords?.length ? `Keywords: ${topic.keywords.join(", ")}` : "",
    topic.lang === "pt" ? "Prefer sources in Portuguese (Portugal)." : "Sources in English.",
    "Mix: 3-4 subreddits, 2-3 YouTube channels, 3-4 websites or newsletters that publish often and have an RSS feed.",
    "Only real, well-known sources you are sure exist, with their exact URLs. No paywalled-only sites, no aggregators of aggregators.",
  ].filter(Boolean).join("\n");
  const { sources } = await askJSON({ system: "You are a research librarian who knows the best places on the web for every niche.", prompt, schema: SCHEMA, fast: true });
  return sources ?? [];
}

// A working feed for a suggestion, or null.
async function verify(s) {
  try {
    const url = new URL(s.url);
    if (/reddit\.com$/.test(url.hostname) || s.type === "reddit") {
      const sub = url.pathname.match(/\/r\/([\w-]+)/)?.[1];
      if (!sub) return null;
      const home = `https://www.reddit.com/r/${sub}`;
      return parseFeed(await proxied(`${home}/top/.rss?t=week`)).length ? { url: home, type: "reddit" } : null;
    }
    if (/youtube\.com$/.test(url.hostname)) {
      const html = await proxied(s.url);
      const id = html.match(/"channelId":"(UC[\w-]{22})"/)?.[1] ?? html.match(/channel\/(UC[\w-]{22})/)?.[1];
      if (!id) return null;
      const feed = `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`;
      return parseFeed(await proxied(feed)).length ? { url: s.url, type: "video", feed } : null;
    }
    const html = await proxied(s.url);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const link = doc.querySelector('link[rel="alternate"][type="application/rss+xml"], link[rel="alternate"][type="application/atom+xml"]')?.getAttribute("href");
    const guesses = [link && new URL(link, s.url).href, ...["/feed", "/rss", "/feed.xml", "/rss.xml", "/atom.xml"].map((p) => new URL(p, s.url).href)].filter(Boolean);
    for (const feed of guesses) {
      try { if (parseFeed(await proxied(feed)).length) return { url: s.url, type: s.type === "newsletter" ? "newsletter" : "site", feed }; } catch {}
    }
    return null;
  } catch { return null; }
}

// Finds, checks and adds sources to a topic. onStatus(text). Resolves { added: [names], skipped: [names] }.
export async function discoverSources(topic, onStatus = () => {}) {
  onStatus("Asking Gemini for good sources…");
  const ideas = await suggest(topic);
  const have = new Set(allSources().filter((x) => x.topic === topic.id).map((x) => x.url.replace(/\/+$/, "").toLowerCase()));
  const key = (u) => u.toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/\/+$/, "");
  const haveKeys = new Set([...have].map(key));
  const fresh = ideas.filter((s, i) => s.url && s.name && !haveKeys.has(key(s.url)) && ideas.findIndex((x) => key(x.url ?? "") === key(s.url)) === i);
  onStatus(`Checking ${fresh.length} sources…`);
  const checked = [];
  for (let i = 0; i < fresh.length; i += 4) checked.push(...await Promise.all(fresh.slice(i, i + 4).map(async (s) => ({ s, ok: await verify(s) }))));
  const added = [];
  const ids = new Set(state.settings.customSources.map((x) => x.id));
  for (const { s, ok } of checked) {
    if (!ok) continue;
    let id = `${topic.id}-${slugify(s.name)}`.slice(0, 50);
    for (let k = 2; ids.has(id); k++) id = `${topic.id}-${slugify(s.name)}-${k}`.slice(0, 50);
    ids.add(id);
    state.settings.customSources.push({
      id, topic: topic.id, name: s.name, url: ok.url, type: ok.type, weight: 1, tags: [], custom: true,
      ...(ok.feed ? { feed: ok.feed } : {}), note: s.why, discovered: new Date().toISOString().slice(0, 10),
    });
    added.push(s.name);
  }
  if (added.length) saveSettings();
  return { added, skipped: checked.filter((x) => !x.ok).map((x) => x.s.name) };
}
