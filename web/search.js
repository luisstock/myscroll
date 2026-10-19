// Search tab: asks the pipeline to research a query on the web (loadMore with { query }); results are the pool
// items whose `query` matches. Recent searches are kept on this device only.
import { state, pool, ranked } from "./model.js";
import { loadMore } from "./loadmore.js";
import { isHidden } from "./later.js";
import { el } from "./ui.js";

export const normQuery = (q) => q.trim().toLowerCase().replace(/\s+/g, " ");

const KEY = "myscroll:searches";
export const recentSearches = () => { try { return JSON.parse(localStorage.getItem(KEY)) ?? []; } catch { return []; } };
function remember(q) {
  const list = [q, ...recentSearches().filter((x) => x !== q)].slice(0, 10);
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch {}
}

let active = ""; // the query whose results are showing
let busy = false;

export const searchResults = (q) =>
  q ? ranked(pool().filter((i) => i.query === q && !isHidden(i.id) && !state.read.has(i.id))) : [];

// ctx: { makeCard, label, empty, reload(): Promise, rerender(), openSync() }
export function renderSearch(ctx) {
  const results = searchResults(active);
  const input = el("input", { type: "search", placeholder: "Search the web for…", "aria-label": "Search", value: active, autocomplete: "off", enterkeyhint: "search" });
  const btn = el("button", { class: "search-go", disabled: busy }, busy ? "Searching…" : active && results.length ? "Find more" : "Search");
  const status = el("p", { class: "more-status", hidden: true });

  const run = async () => {
    const q = normQuery(input.value);
    if (!q || busy) return;
    const showingThis = q === active && searchResults(q).length > 0;
    active = q;
    remember(q);
    if (!showingThis && searchResults(q).length) return ctx.rerender(); // already researched: just show it
    busy = true;
    btn.disabled = true;
    btn.textContent = "Searching…";
    status.hidden = false;
    status.classList.remove("error");
    status.textContent = "Starting…";
    try {
      await loadMore((t) => { status.textContent = t; }, { query: q });
      busy = false;
      await ctx.reload();
    } catch (err) {
      busy = false;
      status.replaceChildren(err.message, err.needsSetup
        ? el("button", { class: "setup-link", onclick: ctx.openSync }, "Open Sync settings →") : null);
      status.classList.add("error");
      btn.disabled = false;
      btn.textContent = results.length ? "Find more" : "Search";
    }
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
  btn.addEventListener("click", run);

  const nodes = [el("div", { class: "search-form" }, input, btn), status];
  const recents = recentSearches();
  if (!active && recents.length) {
    nodes.push(ctx.label("Recent searches"), el("div", { class: "recents" }, recents.map((q) =>
      el("button", { class: "subchip", onclick: () => { active = q; ctx.rerender(); } }, q))));
  }
  if (active) {
    nodes.push(ctx.label(results.length ? `Results for “${active}”` : `No results yet for “${active}”`));
    if (!results.length && !busy) nodes.push(ctx.empty("Nothing researched for this yet. Tap Search to look it up on the web."));
    nodes.push(...results.map((i) => ctx.makeCard(i)));
  } else if (!recents.length) {
    nodes.push(ctx.empty("Search anything: MyScroll researches it on the web and brings back a short reading list."));
  }
  return nodes;
}
