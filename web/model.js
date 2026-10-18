// MyScroll state and domain logic: settings, topics, groups, sources, the backlog pool and ranking.
// Everything here is UI-free so the agent (Node) can reuse the same rules later.
import { buildProfile, scoreItem } from "./ranking.js";
import { isLocalDev } from "./env.js";
import { markDirty } from "./sync.js";

const SYNCED = ["settings", "ratings", "opened", "skips", "itemFeatures", "read", "saved"];

export const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem("myscroll:" + key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem("myscroll:" + key, JSON.stringify(value)); } catch {}
    if (SYNCED.includes(key)) { scheduleSync(); markDirty(); }
  },
};

// After sync.js brought in newer state from GitHub: reload it into memory.
export function reloadFromStorage() {
  state.settings = { ...DEFAULT_SETTINGS, ...store.get("settings", {}) };
  state.read = new Set(store.get("read", []));
  state.opened = new Set(store.get("opened", []));
  state.saved = new Set(store.get("saved", []));
  state.ratings = store.get("ratings", {});
  state.skips = store.get("skips", {});
  state.itemFeatures = store.get("itemFeatures", {});
  state.progress = store.get("progress", {});
}

// Push the user's state to the server (data/state.json) so the daily agent can read it.
// Debounced; failures are silent (the app works offline, the next change retries).
let syncTimer;
function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, 1500);
}
export function syncNow() {
  // Only the local dev server can receive the state; GitHub Pages and the Android app can't (yet).
  if (!isLocalDev) return Promise.resolve();
  const body = { updatedAt: new Date().toISOString() };
  for (const k of SYNCED) body[k] = store.get(k, null);
  return fetch("/api/state", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    .catch(() => {});
}

const DEFAULT_SETTINGS = {
  theme: "dark",
  layout: "cards",                         // "cards" | "list" | "text"
  navBy: "groups",                         // header chips: "groups" | "topics"
  dailyTarget: 40,
  newsExpireDays: 7,
  skipRule: { enabled: false, limit: 10 }, // off while testing
  topicWeights: {},                        // topicId -> 0..3 (missing = 1)
  topics: null,                            // editable copy of taxonomy topics (null = defaults)
  groups: null,                            // editable copy of taxonomy groups (null = defaults)
  sourceOverrides: {},                     // catalog sourceId -> { weight?, deleted?, enabled? }
  customSources: [],                       // [{ id, topic, name, url, type, weight, tags }]
  unmuted: [],                             // features the user un-muted by hand
};

export const state = {
  taxonomy: null,
  catalog: [],
  editions: [],          // newest first
  latest: null,
  view: "all",           // "all" | "group:<id>" | topicId | "saved" | "settings"
  sub: null,             // sub-filter inside a view (topic id inside a group, or subcategory inside a topic)
  editTopic: null,       // topic id being edited in Settings, or "new"
  settings: { ...DEFAULT_SETTINGS, ...store.get("settings", {}) },
  read: new Set(store.get("read", [])),
  opened: new Set(store.get("opened", [])),
  saved: new Set(store.get("saved", [])),
  ratings: store.get("ratings", {}),           // id -> { r, at, f: features }
  skips: store.get("skips", {}),               // id -> times scrolled past unopened
  itemFeatures: store.get("itemFeatures", {}), // id -> features (kept after an item leaves the feed)
  progress: store.get("progress", {}),         // id -> how far you scrolled through it (0..1)
  profile: new Map(),
};

export const saveSettings = () => store.set("settings", state.settings);
export const DAY = 864e5;

// ---------- topics & groups ----------
const clone = (x) => JSON.parse(JSON.stringify(x));

// The user's edited copy, plus any topic/group added to the taxonomy later (unless they deleted it).
function withNewDefaults(mine, defaults, removed = []) {
  if (!mine) return defaults;
  const have = new Set(mine.map((x) => x.id));
  return [...mine, ...defaults.filter((d) => !have.has(d.id) && !removed.includes(d.id))];
}
export function topics() {
  return withNewDefaults(state.settings.topics, state.taxonomy.topics, state.settings.removedTopics);
}
export function groups() {
  return withNewDefaults(state.settings.groups, state.taxonomy.groups, state.settings.removedGroups);
}
// Call before mutating topics/groups: the first edit copies the defaults into settings.
export function editableTopics() {
  state.settings.topics = clone(topics());
  return state.settings.topics;
}
export function editableGroups() {
  state.settings.groups = clone(groups());
  return state.settings.groups;
}

export const topicOf = (id) => topics().find((t) => t.id === id) ?? { id, label: id, emoji: "•", subs: [], keywords: [] };
export const groupOf = (id) => groups().find((g) => g.id === id);
export const subLabel = (item) => topicOf(item.topic).subs?.find((s) => s.id === item.sub)?.label;
export const topicWeight = (id) => state.settings.topicWeights[id] ?? 1;

export function isTopicActive(id) {
  const t = topicOf(id);
  if (t.hidden || topicWeight(id) === 0) return false;
  const g = t.group && groupOf(t.group);
  return !g || g.enabled !== false;
}

export function slugify(text) {
  return text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "topic";
}

// ---------- sources ----------
export function allSources() {
  const o = state.settings.sourceOverrides;
  const fromCatalog = state.catalog.filter((s) => (s.default && !o[s.id]?.deleted) || o[s.id]?.enabled);
  return [...fromCatalog, ...state.settings.customSources]
    .map((s) => ({ ...s, weight: o[s.id]?.weight ?? s.weight ?? 1 }));
}
export function sourceWeights() {
  return Object.fromEntries(allSources().map((s) => [s.id, s.weight]));
}

const STOP = new Set(["the", "and", "of", "for", "a", "in", "on", "to", "news", "new", "de", "e", "o", "a", "do", "da", "with", "what", "how"]);
const tokens = (...texts) => new Set(texts.flat().filter(Boolean).join(" ").toLowerCase()
  .replace(/[-_/]/g, " ").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOP.has(w)));

// Catalog sources that fit a topic and aren't active for it yet, best first.
export function suggestSources(topic, limit = 8) {
  const want = tokens(topic.label, topic.description, topic.keywords, topic.subs?.map((s) => s.label));
  const active = new Set(allSources().filter((s) => s.topic === topic.id).map((s) => s.url));
  return state.catalog
    .filter((s) => !active.has(s.url))
    .map((s) => {
      const have = tokens(s.name, s.tags);
      let score = s.topic === topic.id ? 3 : 0;
      for (const w of have) if (want.has(w)) score += 1;
      return { source: s, score };
    })
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.source);
}

// Starter keywords for a new topic when the user doesn't give any: the name, its subcategories,
// and the short phrases in the description ("routes, packing lists and stories" -> 3 phrases).
export function deriveKeywords(label, description = "", subs = []) {
  const name = label.toLowerCase();
  const phrases = description.split(/[,:;.()]|\band\b|\bor\b|\be\b|\bou\b/i)
    .map((p) => p.replace(/^(the|a|an|from|of|in|on|about|new|o|a|os|as|de|do|da)\s+/i, "").trim())
    .filter((p) => p.length >= 3 && p.split(/\s+/).length <= 4);
  const withName = (p) => (p.toLowerCase().includes(name) ? p : `${label} ${p.toLowerCase()}`);
  return [...new Set([label, ...subs.map((s) => withName(s.label)), ...phrases.map(withName)])].slice(0, 8);
}

// What the daily agent will search for this topic (shown in the topic editor).
export function searchPlan(topic) {
  const kws = topic.keywords?.length ? topic.keywords : [topic.label];
  const fresh = kws.slice(0, 5).map((k) => `${k} — latest news & releases`);
  const reddit = kws.slice(0, 2).map((k) => `best of Reddit: ${k}`);
  const video = kws.slice(0, 1).map((k) => `YouTube: ${k} (videos worth watching)`);
  return [...fresh, ...reddit, ...video];
}

export function enableCatalogSource(src, topicId) {
  if (src.topic === topicId) {
    state.settings.sourceOverrides[src.id] = { ...state.settings.sourceOverrides[src.id], enabled: true, deleted: false };
  } else {
    state.settings.customSources.push({ ...src, id: `${src.id}@${topicId}`, topic: topicId, weight: 1, custom: true, default: undefined });
  }
}

export function removeSource(src) {
  if (src.custom) state.settings.customSources = state.settings.customSources.filter((c) => c.id !== src.id);
  else state.settings.sourceOverrides[src.id] = { ...state.settings.sourceOverrides[src.id], deleted: true, enabled: false };
}

// ---------- taste profile ----------
export function rebuildProfile() {
  const events = [];
  const now = new Date().toISOString();
  for (const { r, at, f } of Object.values(state.ratings)) events.push({ features: f, at, rating: r });
  for (const id of state.opened) {
    if (state.ratings[id] || !state.itemFeatures[id]) continue;
    events.push({ features: state.itemFeatures[id], at: now, opened: true });
  }
  for (const [id, n] of Object.entries(state.skips)) {
    if (state.ratings[id] || state.opened.has(id) || !state.itemFeatures[id]) continue;
    events.push({ features: state.itemFeatures[id], at: now, skips: n });
  }
  state.profile = buildProfile(events);
  for (const f of state.settings.unmuted) {
    const e = state.profile.get(f);
    if (e) e.muted = false;
  }
}

// ---------- the pool: today's edition + unread backlog ----------
function itemDate(item) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(item.published ?? "") ? item.published : item.added;
  return new Date(d + "T00:00:00");
}
// Whole calendar days since a date (so "7 days" means 7 calendar days, not 168 hours).
function daysSince(date) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((today - date) / DAY);
}

export function visibility(item) {
  if (state.read.has(item.id)) return "done"; // read to the end (or Done): it leaves the feed
  if (item.kind === "news") {
    if (daysSince(itemDate(item)) > state.settings.newsExpireDays) return "expired";
  } else if (state.settings.skipRule.enabled && !state.opened.has(item.id) && (state.skips[item.id] ?? 0) >= state.settings.skipRule.limit) {
    return "skipped-out";
  }
  if (!isTopicActive(item.topic)) return "topic-off";
  if (item.source?.id && sourceWeights()[item.source.id] === 0) return "source-off";
  return "visible";
}

export function pool() {
  const seen = new Set();
  const out = [];
  for (const ed of state.editions) {
    for (const item of [ed.longread, ...ed.items].filter(Boolean)) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
  }
  return out;
}

export function ranked(items) {
  const settings = { topicWeights: state.settings.topicWeights, sourceWeights: sourceWeights() };
  return items
    .map((item) => ({ item, ...scoreItem(item, state.profile, settings) }))
    .filter((x) => !x.muted || state.ratings[x.item.id] || state.saved.has(x.item.id))
    .sort((a, b) => (b.item.added === state.latest) - (a.item.added === state.latest) || b.score - a.score)
    .map((x) => x.item);
}

export function visibleItems() {
  return ranked(pool().filter((i) => visibility(i) === "visible"));
}

export function featureLabel(f) {
  const kind = f.slice(0, f.indexOf(":"));
  const rest = f.slice(f.indexOf(":") + 1);
  if (kind === "topic") { const t = topicOf(rest); return `${t.emoji} ${t.label}`; }
  if (kind === "sub") {
    const [tid, sid] = rest.split("/");
    const t = topicOf(tid);
    return `${t.emoji} ${t.subs?.find((s) => s.id === sid)?.label ?? sid}`;
  }
  if (kind === "source") return `📰 ${[...allSources(), ...state.catalog].find((s) => s.id === rest)?.name ?? rest}`;
  if (kind === "style") return `✍︎ ${rest}`;
  return `#${rest}`;
}
