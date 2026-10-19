// "Your reading": a calm look at what you read. Data comes from state.readLog (id -> { at, min, topic }),
// written when an item is finished. No streaks, no goals, no red numbers.
import { el } from "./ui.js";

const DAY = 864e5;
const WEEKS = 8;

const mondayOf = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };

// entries: [[id, { at, min, topic }]] (live readLog); ratings: state.ratings
export function readingStats(entries, ratings = {}, now = new Date()) {
  const thisMonday = mondayOf(now).getTime();
  const weeks = Array.from({ length: WEEKS }, (_, i) => ({ start: new Date(thisMonday - (WEEKS - 1 - i) * 7 * DAY), items: 0, minutes: 0 }));
  const topics = new Map();
  let totalItems = 0, totalMinutes = 0;
  for (const [, e] of entries) {
    const t = new Date(e.at).getTime();
    if (!Number.isFinite(t)) continue;
    const i = Math.floor((t - (thisMonday - (WEEKS - 1) * 7 * DAY)) / (7 * DAY));
    if (i < 0 || i >= WEEKS) continue; // older than 8 weeks: not shown
    weeks[i].items += 1;
    weeks[i].minutes += e.min ?? 1;
    totalItems += 1;
    totalMinutes += e.min ?? 1;
    const tp = topics.get(e.topic) ?? { id: e.topic, reads: 0, minutes: 0, rated: 0, sum: 0 };
    tp.reads += 1;
    tp.minutes += e.min ?? 1;
    topics.set(e.topic, tp);
  }
  // Ratings add a little weight to the topics you rated well.
  for (const { r, f } of Object.values(ratings)) {
    const topic = f?.find((x) => x.startsWith("topic:"))?.slice(6);
    const tp = topic && topics.get(topic);
    if (tp) { tp.rated += 1; tp.sum += r; }
  }
  const top = [...topics.values()]
    .map((t) => ({ ...t, avg: t.rated ? t.sum / t.rated : null, score: t.reads + (t.rated ? (t.sum / t.rated - 2.5) * 0.4 : 0) }))
    .sort((a, b) => b.score - a.score).slice(0, 5);
  return { weeks, thisWeek: weeks[WEEKS - 1], totalItems, totalMinutes, top };
}

const hours = (min) => (min < 60 ? `${Math.round(min)} min` : `${(min / 60).toFixed(min < 600 ? 1 : 0).replace(/\.0$/, "")} h`);

function bars(weeks) {
  const W = 320, H = 96, pad = 18, gap = 8;
  const bw = (W - gap * (WEEKS - 1)) / WEEKS;
  const max = Math.max(1, ...weeks.map((w) => w.items));
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H + pad}`);
  svg.setAttribute("class", "stats-bars");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Items read per week: ${weeks.map((w) => w.items).join(", ")}`);
  weeks.forEach((w, i) => {
    const h = w.items ? Math.max(4, (w.items / max) * (H - 14)) : 2;
    const x = i * (bw + gap);
    const rect = document.createElementNS(ns, "rect");
    Object.entries({ x, y: H - h, width: bw, height: h, rx: 4, class: i === WEEKS - 1 ? "bar now" : "bar" }).forEach(([k, v]) => rect.setAttribute(k, v));
    const label = document.createElementNS(ns, "text");
    Object.entries({ x: x + bw / 2, y: H - h - 4, "text-anchor": "middle", class: "bar-n" }).forEach(([k, v]) => label.setAttribute(k, v));
    label.textContent = w.items || "";
    const day = document.createElementNS(ns, "text");
    Object.entries({ x: x + bw / 2, y: H + 13, "text-anchor": "middle", class: "bar-d" }).forEach(([k, v]) => day.setAttribute(k, v));
    day.textContent = w.start.toLocaleDateString("en-GB", { day: "numeric", month: "short" }).replace(" ", " ");
    svg.append(rect, label, day);
  });
  return svg;
}

// ctx: { state, live, topicOf(id) }. Built when first opened.
export function statsSection(ctx) {
  const details = el("details", { class: "set-section stats-section" }, el("summary", {}, "📊 Your reading"));
  let built = false;
  details.addEventListener("toggle", () => {
    if (!details.open || built) return;
    built = true;
    const s = readingStats(ctx.live(ctx.state.readLog), ctx.state.ratings);
    if (!s.totalItems) {
      details.append(el("p", { class: "set-hint" }, "Nothing here yet. Each item you finish (read to the end, or ✓ Done) is counted, and this page fills in quietly."));
      return;
    }
    details.append(
      el("div", { class: "stats-big" },
        el("div", {}, el("strong", {}, String(s.thisWeek.items)), el("span", {}, s.thisWeek.items === 1 ? "item read this week" : "items read this week")),
        el("div", {}, el("strong", {}, hours(s.thisWeek.minutes)), el("span", {}, "of reading this week"))),
      el("p", { class: "mini" }, "Items per week"),
      bars(s.weeks),
      el("p", { class: "mini" }, "Most read topics"),
      el("ul", { class: "stats-topics" }, s.top.map((t) => {
        const tp = ctx.topicOf(t.id);
        return el("li", {}, el("span", {}, `${tp.emoji} ${tp.label}`),
          el("small", {}, `${t.reads} read${t.avg != null ? ` · ${t.avg.toFixed(1)}★ average` : ""}`));
      })),
      el("p", { class: "stats-won" }, `~${hours(s.totalMinutes)} of reading instead of scrolling, over the last ${WEEKS} weeks. 🌿`));
  });
  return details;
}
