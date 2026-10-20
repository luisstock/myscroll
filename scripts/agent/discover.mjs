// Finds sources for a new topic that has none yet (same idea as "✨ Find sources" in the app):
// the model suggests well-known sources from the topic's name and description, then each one is checked
// (a working subreddit, YouTube channel or site feed) before it is used. Unchecked suggestions are dropped.
import { generateJSON } from "../pipeline/llm.mjs";
import { get, redditGet, parseFeed } from "../pipeline/gather.mjs";

const SCHEMA = {
  type: "object",
  properties: {
    sources: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          url: { type: "string" },
          type: { type: "string", enum: ["reddit", "video", "site", "newsletter"] },
        },
        required: ["name", "url", "type"],
      },
    },
  },
  required: ["sources"],
};

async function verify(s) {
  try {
    const url = new URL(s.url);
    if (/reddit\.com$/.test(url.hostname) || s.type === "reddit") {
      const sub = url.pathname.match(/\/r\/([\w-]+)/)?.[1];
      if (!sub) return null;
      const home = `https://www.reddit.com/r/${sub}`;
      return parseFeed(await redditGet(`${home}/top/.rss?t=week`)).length ? { ...s, url: home, type: "reddit" } : null;
    }
    if (/youtube\.com$/.test(url.hostname)) {
      const html = await get(s.url);
      const id = html.match(/"channelId":"(UC[\w-]{22})"/)?.[1] ?? html.match(/channel\/(UC[\w-]{22})/)?.[1];
      if (!id) return null;
      return parseFeed(await get(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`)).length ? { ...s, type: "video" } : null;
    }
    const html = await get(s.url);
    const link = html.match(/<link[^>]+type="application\/(?:rss|atom)\+xml"[^>]*>/i)?.[0]?.match(/href="([^"]+)"/)?.[1];
    const guesses = [link && new URL(link, s.url).href, ...["/feed", "/rss", "/feed.xml", "/rss.xml", "/atom.xml"].map((p) => new URL(p, s.url).href)].filter(Boolean);
    for (const feed of guesses) {
      try { if (parseFeed(await get(feed, { timeout: 8000 })).length) return { ...s, type: s.type === "newsletter" ? "newsletter" : "site", feed }; } catch {}
    }
    return null;
  } catch { return null; }
}

export async function discoverSources(config, topic, log = () => {}) {
  const prompt = [
    `Suggest 10 high-quality, currently active sources for this reading topic: ${topic.label}.`,
    topic.description ? `What the reader wants: ${topic.description}` : "",
    topic.keywords?.length ? `Keywords: ${topic.keywords.join(", ")}` : "",
    topic.lang === "pt" ? "Prefer sources in Portuguese (Portugal)." : "Sources in English.",
    "Mix: 3-4 subreddits (https://www.reddit.com/r/name), 2-3 YouTube channels (https://www.youtube.com/@handle), 3-4 websites or newsletters that publish often and have an RSS feed.",
    "Only real, well-known sources you are sure exist, with their exact URLs.",
  ].filter(Boolean).join("\n");
  const lite = (config.fallbackModels?.gemini ?? []).filter((m) => /lite/.test(m));
  const { json } = await generateJSON(config, {
    system: "You are a research librarian who knows the best places on the web for every niche.", prompt, schema: SCHEMA,
    ...(lite.length ? { models: [...lite, config.models.gemini] } : {}),
  });
  const key = (u) => u.toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/\/+$/, "");
  const ideas = (json.sources ?? []).filter((s, i, all) => s.url && s.name && all.findIndex((x) => key(x.url ?? "") === key(s.url)) === i);
  const ok = [];
  for (let i = 0; i < ideas.length; i += 4) ok.push(...(await Promise.all(ideas.slice(i, i + 4).map(verify))).filter(Boolean));
  log(`  ${topic.id}: ${ok.length} of ${ideas.length} suggested sources work`);
  return ok;
}
