// "Find sources": Gemini suggests sources for a topic from its name and description, then this device checks
// that each one is alive (a working feed, subreddit or YouTube channel) and keeps the good ones as suggestions;
// "+ Add" turns one into a normal source you can weight, turn off or delete. The daily agent has its own version for new topics.
import { state, allSources, saveSettings, slugify, readerProfile, sourceKey } from "./model.js";
import { askJSON, canUseAI, local } from "./ai.js";
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
    readerProfile(state.settings),
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

// ---------- suggestion cache (local, per topic) ----------
// { topicId: [{ name, url, type, feed?, why, checkedAt }] }: verified sources waiting for a tap on "+ Add".
const keyOf = sourceKey; // the same site under another URL (www, /feed/ vs /section/) is the same source
const WEEK = 7 * 864e5;
const readSugg = () => local.get("sourceSuggestions", {});
const readDismissed = () => local.get("sourceDismissed", {});

// AI suggestions for a topic that aren't a source yet.
export function aiSuggestions(topicId) {
  const have = new Set(allSources().filter((x) => x.topic === topicId).map((x) => keyOf(x.url)));
  return (readSugg()[topicId] ?? []).filter((s) => !have.has(keyOf(s.url)));
}
// Whether Gemini was asked for this topic in the last 7 days (even if nothing came back).
export const askedRecently = (topicId) => Date.now() - (local.get("sourceSuggestionsRun", {})[topicId] ?? 0) < WEEK;

export function dismissSuggestion(topicId, sug) {
  const all = readSugg();
  all[topicId] = (all[topicId] ?? []).filter((x) => keyOf(x.url) !== keyOf(sug.url));
  local.set("sourceSuggestions", all);
  const d = readDismissed();
  d[topicId] = [...new Set([...(d[topicId] ?? []), keyOf(sug.url)])];
  local.set("sourceDismissed", d);
}

// Turns a suggestion into a normal custom source (and removes it from the suggestions).
export function addSuggestion(topicId, sug) {
  const ids = new Set(state.settings.customSources.map((x) => x.id));
  let id = `${topicId}-${slugify(sug.name)}`.slice(0, 50);
  for (let k = 2; ids.has(id); k++) id = `${topicId}-${slugify(sug.name)}-${k}`.slice(0, 50);
  state.settings.customSources.push({
    id, topic: topicId, name: sug.name, url: sug.url, type: sug.type, weight: 1, tags: [], custom: true,
    ...(sug.feed ? { feed: sug.feed } : {}), note: sug.why, discovered: new Date().toISOString().slice(0, 10),
  });
  saveSettings();
  const all = readSugg();
  all[topicId] = (all[topicId] ?? []).filter((x) => keyOf(x.url) !== keyOf(sug.url));
  local.set("sourceSuggestions", all);
}

// One run per topic at a time (the editor and the button can both ask).
const running = new Map();
export const isFinding = (topicId) => running.has(topicId);

// Asks Gemini, verifies each idea, caches the working ones as suggestions. autoAdd: also adds the first N as sources
// (used for a brand-new topic with none). onStatus(text). Resolves { found: [names], added: [names], skipped: [names] }.
export function discoverSources(topic, onStatus = () => {}, { autoAdd = 0 } = {}) {
  if (!running.has(topic.id)) {
    const p = run(topic, onStatus, autoAdd).finally(() => running.delete(topic.id));
    running.set(topic.id, p);
  }
  return running.get(topic.id);
}

async function run(topic, onStatus, autoAdd) {
  onStatus("Asking Gemini for good sources…");
  const ideas = await suggest(topic);
  const gone = new Set(readDismissed()[topic.id] ?? []);
  const haveKeys = new Set(allSources().filter((x) => x.topic === topic.id).map((x) => keyOf(x.url)));
  const fresh = ideas.filter((s, i) => s.url && s.name && !haveKeys.has(keyOf(s.url)) && !gone.has(keyOf(s.url)) && ideas.findIndex((x) => keyOf(x.url ?? "") === keyOf(s.url)) === i);
  onStatus(`Checking ${fresh.length} sources…`);
  const checked = [];
  for (let i = 0; i < fresh.length; i += 4) checked.push(...await Promise.all(fresh.slice(i, i + 4).map(async (s) => ({ s, ok: await verify(s) }))));
  const now = new Date().toISOString();
  const good = checked.filter((x) => x.ok).map(({ s, ok }) => ({
    name: s.name, url: ok.url, type: ok.type, ...(ok.feed ? { feed: ok.feed } : {}), why: s.why ?? "", checkedAt: now,
  }));
  const all = readSugg();
  const kept = (all[topic.id] ?? []).filter((x) => !good.some((g) => keyOf(g.url) === keyOf(x.url)));
  all[topic.id] = [...good, ...kept].slice(0, 20);
  local.set("sourceSuggestions", all);
  local.set("sourceSuggestionsRun", { ...local.get("sourceSuggestionsRun", {}), [topic.id]: Date.now() });
  const added = [];
  for (const g of good.slice(0, autoAdd)) { addSuggestion(topic.id, g); added.push(g.name); }
  return { found: good.map((g) => g.name), added, skipped: checked.filter((x) => !x.ok).map((x) => x.s.name) };
}
