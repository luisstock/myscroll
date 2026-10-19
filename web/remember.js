// "Remember this?": book lessons and ideas you rated 5★ come back after 3, 7, 21, 60 and 180 days
// (spaced repetition, gentle). state.remember: id -> { at, item (snapshot), step, due, off? } (synced).
import { el } from "./ui.js";

export const INTERVALS = [3, 7, 21, 60, 180]; // days
const DAY = 864e5;

const pad = (n) => String(n).padStart(2, "0");
const dayString = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => dayString(new Date());
const inDays = (n) => { const d = new Date(); d.setHours(12, 0, 0, 0); return dayString(new Date(d.getTime() + n * DAY)); };

// Called by rate() after the rating changed. Removing the 5★ later does not remove the entry.
export function maybeRemember(item, { state, store }) {
  if (!(item.book || item.style === "idea")) return;
  if (state.ratings[item.id]?.r !== 5) return;
  const cur = state.remember[item.id];
  if (cur && !cur.off) return;
  const { id, topic, sub, style, title, snippet, body, book, source, lang } = item;
  state.remember[id] = {
    at: new Date().toISOString(), step: 0, due: inDays(INTERVALS[0]),
    item: { id, topic, sub, style, title, snippet, body, book, source, lang },
  };
  store.set("remember", state.remember);
}

export const dueEntries = (state, live) =>
  live(state.remember).filter(([, e]) => e.due <= today()).sort((a, b) => a[1].due.localeCompare(b[1].due));

// The block at the top of All. Returns null when nothing is due. ctx: { state, store, live }
export function rememberBlock(ctx) {
  const due = dueEntries(ctx.state, ctx.live);
  if (!due.length) return null;
  const section = el("section", { class: "remember" },
    el("h3", {}, "🧠 Remember this?"),
    el("p", { class: "remember-hint" }, due.length > 2 ? `A couple of lessons worth keeping. ${due.length - 2} more are waiting.` : "A quick look back at something you loved."));
  section.append(...due.slice(0, 2).map(([id, e]) => card(ctx, section, id, e)));
  return section;
}

function card(ctx, section, id, entry) {
  const it = entry.item;
  const paras = Array.isArray(it.body) ? it.body : it.body ? [it.body] : [];
  const content = it.book
    ? el("div", { class: "remember-lessons" }, it.book.lessons.map((l) => el("details", {}, el("summary", {}, l.title), el("p", {}, l.text))))
    : el("div", { class: "remember-body" }, (paras.length ? paras : [it.snippet]).map((t) => el("p", {}, t)));
  const resolve = (patch) => {
    ctx.state.remember[id] = { ...entry, ...patch, at: new Date().toISOString() };
    ctx.store.set("remember", ctx.state.remember);
    const next = rememberBlock(ctx);
    next ? section.replaceWith(next) : section.remove();
  };
  return el("article", { class: "remember-card" },
    el("h4", {}, it.title),
    it.book ? el("p", { class: "byline" }, `📖 ${it.book.title} — ${it.book.author}`) : null,
    content,
    el("div", { class: "remember-btns" },
      el("button", { class: "got", onclick: () => {
        const step = entry.step + 1;
        step >= INTERVALS.length ? resolve({ step, off: true }) : resolve({ step, due: inDays(INTERVALS[step]) });
      } }, "Got it"),
      el("button", { onclick: () => resolve({ due: inDays(1) }) }, "Again"),
      el("button", { class: "stop", onclick: () => resolve({ off: true }) }, "Stop")));
}
