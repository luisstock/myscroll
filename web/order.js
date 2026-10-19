// "Order by reading": chips and sections sorted by how much you read each topic (settings.orderByReading).
// Score per topic = Σ over read items of 0.5^(ageDays/30) + 0.5 per rating of 4★ or more. Group = sum of its topics.
import { state, groups, topics, live, DAY } from "./model.js";

export const readingOrderOn = () => state.settings.orderByReading !== false;

const topicFeature = (f) => f?.find((x) => x.startsWith("topic:"))?.slice(6);

export function topicScores(now = Date.now()) {
  const score = new Map();
  const add = (t, v) => { if (t) score.set(t, (score.get(t) ?? 0) + v); };
  const logged = new Set();
  for (const [id, e] of live(state.readLog)) {
    logged.add(id);
    add(e.topic, 0.5 ** (Math.max(0, now - new Date(e.at).getTime()) / DAY / 30));
  }
  // Read before the log existed: no date, so count them as a month old.
  for (const id of state.read) if (!logged.has(id)) add(topicFeature(state.itemFeatures[id]), 0.5);
  for (const r of Object.values(state.ratings)) if (r.r >= 4) add(topicFeature(r.f), 0.5);
  return score;
}

// Stable sort, highest score first; ties keep their current (manual) order.
const byScore = (list, scoreOf) => list.map((x, i) => ({ x, i, s: scoreOf(x) })).sort((a, b) => b.s - a.s || a.i - b.i).map((o) => o.x);

export function orderedGroups(list = groups()) {
  if (!readingOrderOn()) return list;
  const scores = topicScores();
  const total = (g) => topics().filter((t) => t.group === g.id).reduce((s, t) => s + (scores.get(t.id) ?? 0), 0);
  return byScore(list, total);
}

// list: topics in manual order -> reading order (flat). Callers group them afterwards if they want.
export function orderedByReading(list) {
  if (!readingOrderOn()) return list;
  const scores = topicScores();
  return byScore(list, (t) => scores.get(t.id) ?? 0);
}
