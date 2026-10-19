// Picks the best candidates per topic before any AI is involved:
// never-seen-before, not muted, fresh enough, relevant to the topic, popular, liked sources first.
import { titleSimilarity, normUrl } from "./history.mjs";

const DAY = 864e5;

export function preselect(plan, candidates, { history, ranking, profile, settings, config, extraSkip = [], sub = null }) {
  const now = Date.now();
  const picked = {};
  const seenHere = [];
  const skip = new Set(extraSkip.map(normUrl));

  for (const topic of plan.topics) {
    const kws = [topic.label, ...(topic.keywords ?? [])].join(" ").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3);
    const subWords = sub && sub.topic === topic.id ? sub.label.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2) : [];
    const pool = candidates.filter((c) => c.topic === topic.id)
      .filter((c) => !history.seen(c) && !skip.has(normUrl(c.url)))
      .map((c) => {
        const ageDays = c.published ? (now - new Date(c.published)) / DAY : null;
        const evergreen = c.evergreen || ageDays == null || ageDays > config.newsMaxAgeDays;
        if (ageDays != null && ageDays > 60 && !c.evergreen) return null; // stale feed entries
        const itemLike = { topic: topic.id, source: { id: c.sourceId }, kind: evergreen ? "evergreen" : "news", style: c.video ? "video" : undefined };
        const taste = ranking.scoreItem(itemLike, profile, settings);
        if (taste.muted) return null;
        const text = `${c.title} ${c.summary}`.toLowerCase();
        let relevance = Math.min(0.6, kws.filter((w) => text.includes(w)).length * 0.2);
        // "Load more" for one subcategory: strongly prefer candidates that mention its label words.
        if (subWords.length) relevance += 1.5 * (subWords.filter((w) => text.includes(w)).length / subWords.length);
        const fresh = ageDays == null ? 0.1 : Math.max(0, 1 - ageDays / config.newsMaxAgeDays) * 0.6;
        const popular = c.engagement ? Math.min(0.8, Math.log10(1 + c.engagement) / 5) : 0;
        const source = 0.3 * ((c.sourceWeight ?? 1) - 1);
        return { ...c, kind: evergreen ? "evergreen" : "news", score: taste.score + relevance + fresh + popular + source };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    const want = Math.ceil((topic.slots ?? 2) * config.candidatesPerSlot);
    const perSource = {};
    const out = [];
    for (const c of pool) {
      if (out.length >= want) break;
      if ((perSource[c.sourceId] ?? 0) >= config.maxPerSource) continue;
      if (seenHere.some((s) => normUrl(s.url) === normUrl(c.url) || titleSimilarity(s.title, c.title) >= 0.75)) continue;
      perSource[c.sourceId] = (perSource[c.sourceId] ?? 0) + 1;
      out.push(c);
      seenHere.push(c);
    }
    picked[topic.id] = out;
  }
  return picked;
}
