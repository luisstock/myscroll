// MyScroll reader: header, feed and cards. State and rules live in model.js, Settings in settings.js.
import { featuresOf } from "./ranking.js";
import {
  state, store, saveSettings, DAY, topics, groups, topicOf, groupOf, subLabel, isTopicActive,
  rebuildProfile, pool, ranked, visibleItems, syncNow,
} from "./model.js";
import { renderSettings } from "./settings.js";
import { readMore } from "./readmore.js";
import { loadMore } from "./loadmore.js";
import { $, el } from "./ui.js";

const THEMES = ["dark", "night", "light"];
const THEME_ICON = { dark: "🌗", night: "🌙", light: "☀️" };
const feed = $("#feed");

// ---------- theme ----------
function applyTheme() {
  document.documentElement.dataset.theme = state.settings.theme;
  document.documentElement.dataset.layout = state.settings.layout;
  $("#themeBtn").textContent = THEME_ICON[state.settings.theme];
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  $('meta[name="theme-color"]').content = bg;
}
$("#themeBtn").addEventListener("click", () => {
  state.settings.theme = THEMES[(THEMES.indexOf(state.settings.theme) + 1) % THEMES.length];
  saveSettings();
  applyTheme();
});

let viewBeforeSettings = "all";
$("#settingsBtn").addEventListener("click", () => {
  if (state.view === "settings") state.view = viewBeforeSettings;
  else { viewBeforeSettings = state.view; state.view = "settings"; }
  state.sub = null;
  state.editTopic = null;
  render();
  window.scrollTo({ top: 0 });
});

// ---------- header ----------
// Active topics in display order: grouped topics follow their group's order, ungrouped ones go last.
function orderedTopics() {
  const active = topics().filter((t) => isTopicActive(t.id));
  const gIndex = (t) => { const i = groups().findIndex((g) => g.id === t.group); return i < 0 ? 999 : i; };
  return active.map((t, i) => ({ t, i })).sort((a, b) => gIndex(a.t) - gIndex(b.t) || a.i - b.i).map((x) => x.t);
}

function renderChips() {
  const items = visibleItems();
  const count = (pred) => items.filter(pred).length;
  const chips = [{ id: "all", label: "All", n: items.length }];
  if (state.settings.navBy === "groups") {
    for (const g of groups()) {
      if (g.enabled === false) continue;
      const ids = new Set(topics().filter((t) => t.group === g.id && isTopicActive(t.id)).map((t) => t.id));
      if (ids.size) chips.push({ id: `group:${g.id}`, label: `${g.emoji} ${g.name}`, n: count((i) => ids.has(i.topic)) });
    }
    for (const t of orderedTopics().filter((t) => !t.group || !groupOf(t.group))) {
      chips.push({ id: t.id, label: `${t.emoji} ${t.label}`, n: count((i) => i.topic === t.id) });
    }
  } else {
    for (const t of orderedTopics()) chips.push({ id: t.id, label: `${t.emoji} ${t.label}`, n: count((i) => i.topic === t.id) });
  }
  chips.push({ id: "saved", label: "⭐ Saved", n: state.saved.size });
  $("#settingsBtn").setAttribute("aria-pressed", String(state.view === "settings"));

  $("#chips").replaceChildren(...chips.map((c) => el("button", {
    class: "chip", "aria-pressed": String(state.view === c.id),
    onclick: () => { state.view = c.id; state.sub = null; render(); window.scrollTo({ top: 0 }); },
  }, c.label, el("span", { class: "n" }, String(c.n)))));
}

function updateProgress() {
  const items = visibleItems();
  const done = items.filter((i) => state.read.has(i.id)).length;
  $("#progressBar").style.width = items.length ? `${(done / items.length) * 100}%` : "0";
  return { done, total: items.length };
}

// ---------- cards ----------
function imageEl(item) {
  if (!item.image?.src) return null;
  const img = el("img", { src: item.image.src, alt: "", loading: "lazy" });
  img.onerror = () => img.remove();
  return img;
}

function ageLabel(item) {
  if (item.added === state.latest) return "New";
  const days = Math.round((new Date(state.latest) - new Date(item.added)) / DAY);
  return days === 1 ? "Yesterday" : `${days}d ago`;
}

function makeCard(item, { longread = false } = {}) {
  const node = $("#cardTpl").content.firstElementChild.cloneNode(true);
  const topic = topicOf(item.topic);
  node.dataset.id = item.id;
  if (longread) node.classList.add("longread");
  if (state.read.has(item.id)) node.classList.add("read");
  if (item.lang) node.lang = item.lang;

  const sub = subLabel(item);
  $(".tag", node).textContent = longread ? "🌙 Long read" : (sub ? `${topic.label} · ${sub}` : topic.label);
  $(".mins", node).textContent = `${item.video ? "▶ " : ""}${item.minutes ?? 1} min`;
  const age = $(".age", node);
  age.textContent = ageLabel(item);
  age.classList.toggle("new", item.added === state.latest);
  paintRatingBadge(node, item.id);
  $(".title", node).textContent = item.title;
  $(".snippet", node).textContent = item.snippet;

  const thumb = $(".thumb", node);
  const img = imageEl(item);
  if (img) thumb.append(img); else { thumb.textContent = topic.emoji; node.classList.add("no-img"); }
  if (item.video) thumb.classList.add("is-video");

  const head = $(".card-head", node);
  const body = $(".card-body", node);
  let built = false;
  head.addEventListener("click", () => {
    const open = body.hidden;
    if (open && !built) { buildBody(node, item); built = true; }
    body.hidden = !open;
    node.classList.toggle("open", open);
    head.setAttribute("aria-expanded", String(open));
    if (open) markOpened(item, node);
    else {
      $(".hero iframe", node)?.remove(); // stop the video when closing
      built = false;
      node.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  });
  skipObserver.observe(node);
  return node;
}

function buildBody(node, item) {
  const hero = $(".hero", node);
  hero.replaceChildren();
  hero.classList.toggle("video", !!item.video);
  if (item.video?.provider === "youtube") {
    const f = el("iframe", {
      src: `https://www.youtube-nocookie.com/embed/${item.video.id}?rel=0&modestbranding=1`,
      title: item.video.title ?? item.title,
      allow: "accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen",
      referrerpolicy: "strict-origin-when-cross-origin", // YouTube embeds need a referrer
    });
    hero.append(f);
  } else {
    const img = imageEl(item);
    if (img) { img.loading = "eager"; hero.append(img); }
  }

  const paragraphs = Array.isArray(item.body) ? item.body : [item.body];
  $(".prose", node).replaceChildren(...paragraphs.map((t) => el("p", {}, t)));

  setupReadMore(node, item);

  const src = $(".source", node);
  src.href = item.source.url;
  src.textContent = `${item.source.name} ↗`;

  $(".rate", node).replaceChildren(...[0, 1, 2, 3, 4, 5].map((r) => el("button", {
    "data-r": r, class: r === 0 ? "zero" : "star", "aria-label": r === 0 ? "0 – not for me" : `${r} of 5`,
    onclick: () => rate(item, r, node),
  }, r === 0 ? "0" : "★")));
  paintRating(node, item.id);

  const saveBtn = $("[data-save]", node);
  const paintSave = () => {
    const on = state.saved.has(item.id);
    saveBtn.textContent = on ? "★ Saved" : "☆ Save";
    saveBtn.setAttribute("aria-pressed", String(on));
  };
  paintSave();
  saveBtn.onclick = () => {
    state.saved.has(item.id) ? state.saved.delete(item.id) : state.saved.add(item.id);
    store.set("saved", [...state.saved]);
    paintSave();
    renderChips();
  };
}

function setupReadMore(node, item) {
  const box = $(".more", node);
  const btn = $(".more-btn", node);
  box.replaceChildren();
  box.hidden = true;
  const isVideo = !!item.video && !item.more;
  btn.hidden = isVideo;
  btn.disabled = false;
  btn.textContent = "Read more";
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = "Fetching the full text…";
    try {
      const { blocks, from } = await readMore(item);
      box.replaceChildren(
        el("p", { class: "more-from" }, `More from ${from}`),
        ...blocks.map((b) => b.type === "h" ? el("h4", {}, b.text)
          : b.type === "quote" ? el("blockquote", {}, b.text, b.by ? el("cite", {}, b.by) : null)
          : el("p", {}, b.text)),
        el("a", { class: "more-continue", href: item.source.url, target: "_blank", rel: "noopener" }, "Continue at the source ↗"));
      box.hidden = false;
      btn.hidden = true;
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Try again";
      box.replaceChildren(el("p", { class: "more-error" }, err.message));
      box.hidden = false;
    }
  };
}

const RATE_HINT = ["Not for me – less of this", "Meh", "Not great", "OK", "Good", "Loved it – more like this"];

function paintRating(node, id) {
  const r = state.ratings[id]?.r;
  node.querySelectorAll(".rate button").forEach((b) => {
    const v = Number(b.dataset.r);
    b.classList.toggle("on", r != null && (v === 0 ? r === 0 : r > 0 && v <= r));
  });
  const hint = $(".rate-hint", node);
  if (hint) hint.textContent = r != null ? RATE_HINT[r] : "Rate it so tomorrow's edition gets better";
  paintRatingBadge(node, id);
}

function paintRatingBadge(node, id) {
  const r = state.ratings[id]?.r;
  $(".rated", node).textContent = r == null ? "" : r === 0 ? "✕" : `${r}★`;
}

function rememberFeatures(item) {
  state.itemFeatures[item.id] = featuresOf(item);
  store.set("itemFeatures", state.itemFeatures);
}

function rate(item, r, node) {
  if (state.ratings[item.id]?.r === r) delete state.ratings[item.id];
  else state.ratings[item.id] = { r, at: new Date().toISOString(), f: featuresOf(item) };
  store.set("ratings", state.ratings);
  rememberFeatures(item);
  rebuildProfile();
  paintRating(node, item.id);
}

function markOpened(item, node) {
  rememberFeatures(item);
  if (!state.opened.has(item.id)) {
    state.opened.add(item.id);
    store.set("opened", [...state.opened]);
  }
  if (state.read.has(item.id)) return;
  state.read.add(item.id);
  store.set("read", [...state.read]);
  node.classList.add("read");
  const { done, total } = updateProgress();
  $(".the-end", feed)?.replaceWith(theEnd(done, total));
}

// Count how often an item is scrolled past without being opened (once per page load).
const skippedThisSession = new Set();
const skipObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const id = e.target.dataset.id;
    if (e.isIntersecting) { e.target.dataset.seen = "1"; continue; }
    const passedUp = e.boundingClientRect.bottom < (e.rootBounds?.top ?? 0);
    if (passedUp && e.target.dataset.seen && !state.opened.has(id) && !skippedThisSession.has(id)) {
      skippedThisSession.add(id);
      state.skips[id] = (state.skips[id] ?? 0) + 1;
      store.set("skips", state.skips);
      const item = pool().find((i) => i.id === id);
      if (item) rememberFeatures(item);
    }
  }
}, { threshold: 0 });

// ---------- feed ----------
function theEnd(done, total) {
  const status = el("p", { class: "more-status", hidden: true });
  const btn = el("button", { class: "load-more", onclick: async () => {
    btn.disabled = true;
    btn.textContent = "Loading more…";
    status.hidden = false;
    status.classList.remove("error");
    try {
      await loadMore((text) => { status.textContent = text; });
      status.textContent = "Done! Fresh items added below the ones you had.";
      await reloadEditions();
    } catch (err) {
      status.textContent = err.message;
      status.classList.add("error");
      btn.disabled = false;
      btn.textContent = "Load more";
    }
  } }, "Load more");
  return el("section", { class: "the-end" },
    el("div", { class: "moon" }, "🌙"),
    el("h3", {}, "That's all for now"),
    el("p", {}, `You've read ${done} of ${total}.`),
    el("p", {}, "Whatever you didn't read stays here for tomorrow.", el("br"), "Go to sleep. 😴"),
    el("div", { class: "more-wrap" }, el("p", { class: "more-q" }, "Still awake and want more?"), btn, status));
}

async function reloadEditions() {
  const getJSON = (u) => fetch(u, { cache: "no-store" }).then((r) => r.json());
  const index = await getJSON("editions/index.json");
  state.latest = index.latest;
  state.editions = await Promise.all(index.editions.slice(0, 30).map((d) => getJSON(`editions/${d}.json`)));
  const y = window.scrollY;
  render();
  window.scrollTo({ top: y });
}
const label = (text, cls = "section-label") => el("p", { class: cls }, text);
const empty = (text) => el("p", { class: "empty" }, text);

function filterChips(options) {
  if (options.length < 2) return null;
  return el("div", { class: "subchips" }, [{ id: null, label: "All" }, ...options].map((o) => el("button", {
    class: "subchip", "aria-pressed": String(state.sub === o.id),
    onclick: () => { state.sub = o.id; renderFeed(); },
  }, o.label)));
}

function topicSections(items, withGroupHeaders) {
  const nodes = [];
  let lastGroup;
  for (const t of orderedTopics()) {
    const list = items.filter((i) => i.topic === t.id && i.kind !== "longread");
    if (!list.length) continue;
    const g = t.group && groupOf(t.group);
    if (withGroupHeaders && g && g.id !== lastGroup) {
      nodes.push(label(`${g.emoji} ${g.name}`, "group-label"));
      lastGroup = g.id;
    }
    nodes.push(label(`${t.emoji} ${t.label}`), ...list.map((i) => makeCard(i)));
  }
  return nodes;
}

function renderFeed() {
  if (state.view === "settings") {
    return renderSettings({ root: feed, refreshChrome: () => { renderChips(); updateProgress(); }, applyTheme });
  }
  const items = visibleItems();
  const nodes = [];

  if (state.view === "all") {
    nodes.push(...items.filter((i) => i.kind === "longread").map((i) => makeCard(i, { longread: true })));
    nodes.push(...topicSections(items, state.settings.navBy === "groups"));
  } else if (state.view === "saved") {
    const saved = ranked(pool().filter((i) => state.saved.has(i.id)));
    if (!saved.length) nodes.push(empty("Nothing saved yet. Open an item and tap ☆ Save."));
    nodes.push(...saved.map((i) => makeCard(i)));
  } else if (state.view.startsWith("group:")) {
    const gid = state.view.slice(6);
    const ts = orderedTopics().filter((t) => t.group === gid);
    const inGroup = items.filter((i) => ts.some((t) => t.id === i.topic));
    nodes.push(filterChips(ts.filter((t) => inGroup.some((i) => i.topic === t.id)).map((t) => ({ id: t.id, label: `${t.emoji} ${t.label}` }))));
    const shown = inGroup.filter((i) => !state.sub || i.topic === state.sub);
    nodes.push(...shown.filter((i) => i.kind === "longread").map((i) => makeCard(i, { longread: true })));
    nodes.push(...(state.sub ? shown.filter((i) => i.kind !== "longread").map((i) => makeCard(i)) : topicSections(shown, false)));
  } else {
    const t = topicOf(state.view);
    const inTopic = items.filter((i) => i.topic === state.view);
    nodes.push(filterChips((t.subs ?? []).filter((s) => inTopic.some((i) => i.sub === s.id))));
    nodes.push(...inTopic.filter((i) => !state.sub || i.sub === state.sub).map((i) => makeCard(i, { longread: i.kind === "longread" })));
  }

  if (!nodes.some((n) => n?.classList?.contains("card")) && state.view !== "saved") {
    nodes.push(empty("Nothing here right now. New items arrive with tomorrow's edition."));
  }
  if (state.view !== "saved") {
    const { done, total } = updateProgress();
    nodes.push(theEnd(done, total));
  }
  feed.replaceChildren(...nodes.filter(Boolean));
}

// ---------- boot ----------
function render() {
  // A view can disappear (group turned off, topic hidden): fall back to All.
  const v = state.view;
  if (v.startsWith("group:") ? groupOf(v.slice(6))?.enabled === false || !groupOf(v.slice(6))
    : !["all", "saved", "settings"].includes(v) && !isTopicActive(v)) state.view = "all";
  renderChips();
  renderFeed();
}

async function load() {
  applyTheme();
  const getJSON = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(`${u}: ${r.status}`); return r.json(); });
  const [taxonomy, catalog, index] = await Promise.all([getJSON("taxonomy.json"), getJSON("catalog.json"), getJSON("editions/index.json")]);
  state.taxonomy = taxonomy;
  state.catalog = catalog.sources;
  state.latest = index.latest;
  // Only the last 30 editions can hold unread items worth carrying over.
  state.editions = await Promise.all(index.editions.slice(0, 30).map((d) => getJSON(`editions/${d}.json`)));

  // The agent marks new topics as set up (and may add sources to the catalog) in agent-notes.json.
  const notes = await fetch("agent-notes.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (notes?.readyTopics?.length && state.settings.topics) {
    let changed = false;
    for (const t of state.settings.topics) {
      if (t.status === "new" && notes.readyTopics.includes(t.id)) { t.status = "ready"; changed = true; }
    }
    if (changed) saveSettings();
  }
  syncNow(); // make sure the agent sees the latest state even if nothing changes this session

  const today = state.editions[0];
  const date = new Date(today.date + "T12:00:00");
  $("#dateline").textContent =
    `${date.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })} · Edition #${today.number}`;
  rebuildProfile();
  render();
}

load().catch((err) => {
  feed.replaceChildren(el("p", { class: "empty" }, "Couldn't load your editions.", el("br"), el("small", {}, err.message)));
});
