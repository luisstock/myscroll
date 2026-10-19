// MyScroll taste model. Shared by the app (ordering + "what I learned") and the daily agent
// (choosing which candidates make it into the next edition). See docs/ranking.md.

export const PARAMS = {
  halfLifeDays: 45,   // a rating counts half as much after 45 days
  priorStrength: 3,   // Bayesian shrinkage: a feature needs ~3 ratings before it moves far from neutral
  muteBelow: -0.5,    // affinity at which a feature gets muted...
  muteMinEvidence: 2, // ...once it has at least this much (weighted) evidence
  newsAgePenalty: 0.05, // per day, news only
  // How much each kind of feature contributes to an item's score.
  featureWeights: { topic: 1.0, sub: 0.8, source: 0.6, tag: 0.5, style: 0.4 },
};

// Rating 0..5 -> signal -1..+1 and evidence weight. 0 means "never this kind of thing again".
export function ratingSignal(r) {
  return { s: (r - 2.5) / 2.5, w: r === 0 ? 2 : 1 };
}

// Every item is described by features; the profile learns an affinity for each one.
export function featuresOf(item) {
  const f = [`topic:${item.topic}`];
  if (item.sub) f.push(`sub:${item.topic}/${item.sub}`);
  if (item.source?.id || item.source?.name) f.push(`source:${item.source.id ?? item.source.name}`);
  if (item.style) f.push(`style:${item.style}`);
  for (const t of item.tags ?? []) f.push(`tag:${t}`);
  return f;
}

const kindOf = (feature) => feature.slice(0, feature.indexOf(":"));

/**
 * Build the taste profile from feedback events.
 * events: [{ features, at, rating? , opened?, skips? }]
 * returns Map feature -> { n, sum, affinity, uncertainty, muted }
 */
export function buildProfile(events, now = Date.now(), p = PARAMS) {
  const acc = new Map();
  const add = (feature, w, s) => {
    const a = acc.get(feature) ?? { n: 0, sum: 0 };
    a.n += w;
    a.sum += w * s;
    acc.set(feature, a);
  };
  for (const e of events) {
    const ageDays = Math.max(0, (now - new Date(e.at).getTime()) / 864e5);
    const decay = 0.5 ** (ageDays / p.halfLifeDays);
    let signals = [];
    if (e.rating != null) {
      const { s, w } = ratingSignal(e.rating);
      signals.push([w, s]);
    } else if (e.notInterested) {
      signals.push([1, -0.6]); // "Not interested" counts like a 1★
    } else {
      // Implicit feedback is weak on purpose: explicit ratings should dominate.
      if (e.opened) signals.push([0.3, 0.3]);
      if (e.skips >= 3) signals.push([0.2 * Math.min(e.skips - 2, 5), -0.5]);
    }
    for (const [w, s] of signals) for (const f of e.features) add(f, w * decay, s);
  }
  const profile = new Map();
  for (const [feature, { n, sum }] of acc) {
    // Bayesian average toward a neutral prior of 0: sum / (n + m).
    const affinity = sum / (n + p.priorStrength);
    profile.set(feature, {
      n, sum, affinity,
      uncertainty: 1 / Math.sqrt(n + 1),
      muted: affinity <= p.muteBelow && n >= p.muteMinEvidence,
    });
  }
  return profile;
}

/**
 * Score an item for this user. Higher = show earlier / more likely to be picked.
 * settings.topicWeights / settings.sourceWeights: 0..3 (1 = normal, 0 = off).
 * explore: if true, sample each affinity from N(affinity, uncertainty) - Thompson-style exploration.
 */
export function scoreItem(item, profile, settings = {}, { now = Date.now(), explore = false, p = PARAMS } = {}) {
  const topicW = settings.topicWeights?.[item.topic] ?? 1;
  const sourceW = settings.sourceWeights?.[item.source?.id] ?? 1;
  if (topicW === 0 || sourceW === 0) return { score: -Infinity, muted: true, reasons: ["turned off in Settings"] };

  let score = item.quality ?? 0.5;
  const reasons = [];
  let muted = false;
  const tagAff = [];
  for (const f of featuresOf(item)) {
    const entry = profile.get(f);
    if (!entry) continue;
    if (entry.muted) { muted = true; reasons.push(`muted ${f}`); }
    const a = explore ? entry.affinity + gaussian() * entry.uncertainty * 0.5 : entry.affinity;
    const kind = kindOf(f);
    if (kind === "tag") tagAff.push(a);
    else score += p.featureWeights[kind] * a;
    if (Math.abs(entry.affinity) > 0.15) reasons.push(`${entry.affinity > 0 ? "+" : "−"} ${f}`);
  }
  if (tagAff.length) score += p.featureWeights.tag * (tagAff.reduce((x, y) => x + y, 0) / tagAff.length);
  score += 0.25 * (topicW - 1) + 0.2 * (sourceW - 1);
  if (item.kind === "news" && item.published) {
    score -= p.newsAgePenalty * Math.max(0, (now - new Date(item.published).getTime()) / 864e5);
  }
  return { score, muted, reasons };
}

// How many of `total` slots each topic gets in a new edition: user weight × learned affinity, min 2.
export function allocateSlots(topicIds, profile, settings = {}, total = 40) {
  const raw = topicIds.map((t) => {
    const w = settings.topicWeights?.[t] ?? 1;
    const a = profile.get(`topic:${t}`)?.affinity ?? 0;
    return [t, w === 0 ? 0 : w * Math.exp(a)];
  });
  const on = raw.filter(([, v]) => v > 0);
  const sum = on.reduce((s, [, v]) => s + v, 0) || 1;
  // Minimum 2 each, then share the rest by weight (largest remainder, so it adds up to `total`).
  const spare = Math.max(0, total - 2 * on.length);
  const exact = on.map(([t, v]) => [t, (v / sum) * spare]);
  const out = Object.fromEntries(raw.map(([t]) => [t, 0]));
  for (const [t, x] of exact) out[t] = 2 + Math.floor(x);
  let left = total - Object.values(out).reduce((a, b) => a + b, 0);
  for (const [t] of [...exact].sort((a, b) => (b[1] % 1) - (a[1] % 1))) {
    if (left-- <= 0) break;
    out[t] += 1;
  }
  return out;
}

function gaussian() {
  const u = 1 - Math.random(), v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
