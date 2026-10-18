// MyScroll reader: header, feed and cards. State and rules live in model.js, Settings in settings.js.
import { featuresOf } from "./ranking.js";
import {
  state, store, saveSettings, DAY, topics, groups, topicOf, groupOf, subLabel, isTopicActive,
  rebuildProfile, pool, ranked, visibleItems, visibility, syncNow, reloadFromStorage,
} from "./model.js";
import { pullState } from "./sync.js";
import { renderSettings } from "./settings.js";
import { readMore } from "./readmore.js";
import { loadMore } from "./loadmore.js";
import { $, el } from "./ui.js";
import { getJSON, dataUrl, setSystemBars, onBackButton } from "./env.js";

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
  setSystemBars(state.settings.theme);
}

// Android back: Settings/topic editor → feed → All → exit.
onBackButton(() => {
  if (state.editTopic) { state.editTopic = null; render(); return true; }
  if (state.view !== "all") { state.view = "all"; state.sub = null; render(); window.scrollTo({ top: 0 }); return true; }
  return false;
});
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
  if (isWeekDay()) chips.push({ id: "week", label: "📅 Week", n: weekItems().total });
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

// Read items leave the feed, so progress = today's read ÷ (today's read + what's still in the scroll).
function updateProgress() {
  const left = visibleItems().length;
  const done = pool().filter((i) => i.added === state.latest && state.read.has(i.id) && isTopicActive(i.topic)).length;
  const total = done + left;
  $("#progressBar").style.width = total ? `${(done / total) * 100}%` : "0";
  return { done, total };
}

// ---------- cards ----------
function imageEl(item) {
  if (!item.image?.src) return null;
  const img = el("img", { src: dataUrl(item.image.src), alt: "", loading: "lazy" });
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
  if (item.book) {
    node.classList.add("book");
    $(".title", node).after(el("p", { class: "byline" }, `📖 ${item.book.title} — ${item.book.author}`));
    $(".mins", node).textContent = `${item.book.lessons.length} lessons`;
  }
  if (item.style === "idea") node.classList.add("idea");

  const thumb = $(".thumb", node);
  const img = imageEl(item);
  if (img) thumb.append(img); else { thumb.textContent = topic.emoji; node.classList.add("no-img"); }
  if (item.video) thumb.classList.add("is-video");

  // How far you got last time (thin bar at the bottom of the closed card).
  node.append(el("div", { class: "card-progress", "aria-hidden": "true" }, el("span")));
  paintPartial(node, item.id);

  const head = $(".card-head", node);
  const body = $(".card-body", node);
  let built = false;
  head.addEventListener("click", () => {
    const open = body.hidden;
    // Closing a card you've read to the end: it's done, clear it from the feed.
    if (!open && isFinished(item.id) && !state.read.has(item.id)) return dismiss(node, item);
    if (open && !built) { buildBody(node, item); built = true; }
    body.hidden = !open;
    node.classList.toggle("open", open);
    head.setAttribute("aria-expanded", String(open));
    if (open) { markOpened(item, node); setTimeout(trackReading, 50); }
    else {
      $(".hero iframe", node)?.remove(); // stop the video when closing
      built = false;
      paintPartial(node, item.id);
      trackReading();
      node.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  });
  skipObserver.observe(node);
  return node;
}

// ---------- reading progress ----------
const FINISHED = 0.97;
const isFinished = (id) => (state.progress[id] ?? 0) >= FINISHED;

function paintPartial(node, id) {
  const p = state.read.has(id) ? 0 : state.progress[id] ?? 0;
  node.classList.toggle("partial", p > 0.08 && p < FINISHED);
  $(".card-progress span", node).style.width = `${Math.round(p * 100)}%`;
}

// While a card is open: how much of it you've scrolled through (to the end of its actions row).
let saveProgressTimer;
function trackReading() {
  let best = null;
  let bestVisible = 0;
  for (const node of feed.querySelectorAll(".card.open")) {
    const r = node.getBoundingClientRect();
    const end = $(".actions", node)?.getBoundingClientRect().bottom ?? r.bottom;
    const total = Math.max(1, end - r.top);
    const p = Math.max(0, Math.min(1, (window.innerHeight - r.top) / total));
    const id = node.dataset.id;
    if (p > (state.progress[id] ?? 0)) {
      state.progress[id] = p;
      clearTimeout(saveProgressTimer);
      saveProgressTimer = setTimeout(() => store.set("progress", state.progress), 800);
    }
    node.classList.toggle("finished", isFinished(id));
    const visible = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
    if (visible > bestVisible) { bestVisible = visible; best = p; }
  }
  const bar = $("#readBar");
  bar.hidden = best == null;
  bar.firstElementChild.style.width = `${Math.round((best ?? 0) * 100)}%`;
}
// Throttled (every ~80 ms, plus once when scrolling stops).
let lastTrack = 0;
let trailingTrack;
window.addEventListener("scroll", () => {
  const now = Date.now();
  if (now - lastTrack > 80) { lastTrack = now; trackReading(); }
  clearTimeout(trailingTrack);
  trailingTrack = setTimeout(trackReading, 120);
}, { passive: true });

// Mark as read, slide the card out, offer Undo.
function dismiss(node, item) {
  state.progress[item.id] = 1;
  store.set("progress", state.progress);
  state.read.add(item.id);
  store.set("read", [...state.read]);
  rememberFeatures(item);
  node.style.height = `${node.offsetHeight}px`;
  requestAnimationFrame(() => node.classList.add("leaving"));
  setTimeout(() => {
    $(".hero iframe", node)?.remove();
    node.remove();
    renderChips();
    const { done, total } = updateProgress();
    $(".the-end", feed)?.replaceWith(theEnd(done, total));
    trackReading();
  }, 320);
  toast("Marked as read", "Undo", () => {
    state.read.delete(item.id);
    store.set("read", [...state.read]);
    const y = window.scrollY;
    render();
    window.scrollTo({ top: y });
  });
}

let toastTimer;
function toast(text, actionLabel, onAction) {
  $(".toast")?.remove();
  clearTimeout(toastTimer);
  const t = el("div", { class: "toast", role: "status" }, el("span", {}, text),
    actionLabel ? el("button", { onclick: () => { t.remove(); onAction(); } }, actionLabel) : null);
  document.body.append(t);
  toastTimer = setTimeout(() => t.remove(), 5000);
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
  $(".lessons-wrap", node)?.remove();
  if (item.book) $(".prose", node).after(lessonCards(item.book));

  setupReadMore(node, item);

  const src = $(".source", node);
  src.href = item.source.url;
  src.textContent = `${item.source.name} ↗`;

  $(".rate", node).replaceChildren(...[0, 1, 2, 3, 4, 5].map((r) => el("button", {
    "data-r": r, class: r === 0 ? "zero" : "star", "aria-label": r === 0 ? "0 – not for me" : `${r} of 5`,
    onclick: () => rate(item, r, node),
  }, r === 0 ? "0" : "★")));
  paintRating(node, item.id);

  if (!$(".done-btn", node)) {
    $(".actions", node).append(el("button", { class: "done-btn", onclick: () => dismiss(node, item) }, "✓ Done"));
  }

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

// Book lessons as swipeable cards (scroll-snap), ending with "Try this" and "For who".
function lessonCards(book) {
  const n = book.lessons.length;
  const slides = [
    ...book.lessons.map((l, i) => el("div", { class: "lesson" },
      el("p", { class: "lesson-n" }, `Lesson ${i + 1} of ${n}`),
      el("h4", {}, l.title), el("p", {}, l.text))),
    el("div", { class: "lesson last" },
      el("p", { class: "lesson-n" }, "Try this"), el("h4", {}, book.takeaway),
      el("p", { class: "for-who" }, `For: ${book.forWho}`)),
  ];
  const track = el("div", { class: "lessons", tabindex: 0, "aria-label": "Lessons, swipe sideways" }, slides);
  const dots = el("div", { class: "dots" }, slides.map(() => el("span")));
  const paint = () => {
    const i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth * 0.86));
    [...dots.children].forEach((d, k) => d.classList.toggle("on", k === Math.min(i, slides.length - 1)));
  };
  track.addEventListener("scroll", () => requestAnimationFrame(paint), { passive: true });
  requestAnimationFrame(paint);
  return el("div", { class: "lessons-wrap" }, track, dots);
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
      setTimeout(trackReading, 50); // the card just got longer
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

// Opening isn't reading: "read" happens when you reach the end (or tap Done).
function markOpened(item) {
  rememberFeatures(item);
  if (!state.opened.has(item.id)) {
    state.opened.add(item.id);
    store.set("opened", [...state.opened]);
  }
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

// ---------- best of the week (Sundays) ----------
const isWeekDay = () => new Date().getDay() === 0;

function weekItems() {
  const since = new Date(state.latest);
  since.setDate(since.getDate() - 6);
  const inWeek = pool().filter((i) => new Date(i.added) >= since && isTopicActive(i.topic));
  const favourites = inWeek.filter((i) => (state.ratings[i.id]?.r ?? 0) >= 4)
    .sort((a, b) => state.ratings[b.id].r - state.ratings[a.id].r);
  const saved = inWeek.filter((i) => state.saved.has(i.id) && !favourites.includes(i));
  const unread = ranked(inWeek.filter((i) => !state.read.has(i.id) && visibility(i) === "visible")).slice(0, 10);
  return { favourites, saved, unread, total: favourites.length + saved.length + unread.length };
}

function renderWeek() {
  const { favourites, saved, unread } = weekItems();
  const nodes = [el("section", { class: "week-head" },
    el("h2", {}, "Your week in MyScroll"),
    el("p", {}, `${favourites.length} favourites · ${saved.length} saved · the best ${unread.length} you haven't read yet`))];
  if (favourites.length) nodes.push(label("⭐ What you loved"), ...favourites.map((i) => makeCard(i)));
  if (saved.length) nodes.push(label("🔖 Saved this week"), ...saved.map((i) => makeCard(i)));
  if (unread.length) nodes.push(label("📌 Worth catching up on"), ...unread.map((i) => makeCard(i)));
  if (!favourites.length && !saved.length && !unread.length) nodes.push(empty("Rate and save things during the week and they'll show up here on Sunday."));
  return nodes;
}

// ---------- feed ----------
// What "Load more" researches: everything, the current group, or the current topic.
function loadMoreScope() {
  const v = state.view;
  if (v.startsWith("group:")) {
    const g = groupOf(v.slice(6));
    const ids = orderedTopics().filter((t) => t.group === g?.id).map((t) => t.id);
    if (state.sub && ids.includes(state.sub)) { const t = topicOf(state.sub); return { topics: [t.id], label: `${t.emoji} ${t.label}` }; }
    return { topics: ids, label: `${g.emoji} ${g.name}` };
  }
  if (v !== "all" && v !== "saved" && v !== "settings" && v !== "week") { const t = topicOf(v); return { topics: [t.id], label: `${t.emoji} ${t.label}` }; }
  return { topics: null, label: "" };
}

function theEnd(done, total) {
  const scope = loadMoreScope();
  const idleLabel = scope.label ? `Load more ${scope.label}` : "Load more";
  const status = el("p", { class: "more-status", hidden: true });
  const btn = el("button", { class: "load-more", onclick: async () => {
    btn.disabled = true;
    btn.textContent = "Loading more…";
    status.hidden = false;
    status.classList.remove("error");
    try {
      await loadMore((text) => { status.textContent = text; }, scope.topics);
      status.textContent = "Done! Fresh items added below the ones you had.";
      await reloadEditions();
    } catch (err) {
      status.textContent = err.message;
      status.classList.add("error");
      btn.disabled = false;
      btn.textContent = idleLabel;
    }
  } }, idleLabel);
  return el("section", { class: "the-end" },
    el("div", { class: "moon" }, "🌙"),
    el("h3", {}, "That's all for now"),
    el("p", {}, `You've read ${done} of ${total}.`),
    el("p", {}, "Whatever you didn't read stays here for tomorrow.", el("br"), "Go to sleep. 😴"),
    el("div", { class: "more-wrap" }, el("p", { class: "more-q" }, "Still awake and want more?"), btn, status));
}

async function reloadEditions() {
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

  if (state.view === "week") {
    nodes.push(...renderWeek());
  } else if (state.view === "all") {
    if (isWeekDay()) nodes.push(el("button", { class: "week-banner", onclick: () => { state.view = "week"; render(); window.scrollTo({ top: 0 }); } },
      "📅 It's Sunday: your week in review is ready →"));
    nodes.push(...items.filter((i) => i.kind === "longread").map((i) => makeCard(i, { longread: true })));
    if (state.shuffleSeed != null) {
      nodes.push(el("div", { class: "shuffle-bar" }, el("span", {}, "🔀 Shuffled"),
        el("button", { onclick: () => { state.shuffleSeed = null; renderFeed(); window.scrollTo({ top: 0 }); } }, "Sort by topic")));
      nodes.push(...shuffled(items.filter((i) => i.kind !== "longread"), state.shuffleSeed).map((i) => makeCard(i)));
    } else {
      nodes.push(...topicSections(items, state.settings.navBy === "groups"));
    }
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

  if (!nodes.some((n) => n?.classList?.contains("card")) && !["saved", "week"].includes(state.view)) {
    nodes.push(empty("Nothing here right now. New items arrive with tomorrow's edition."));
  }
  if (!["saved", "week"].includes(state.view)) {
    const { done, total } = updateProgress();
    nodes.push(theEnd(done, total));
  }
  feed.replaceChildren(...nodes.filter(Boolean));
}

// ---------- pull to shuffle (All) ----------
function rng(seed) { // mulberry32
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Random order, then break up runs of the same topic so the mix feels mixed.
function shuffled(items, seed) {
  const rand = rng(seed);
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  for (let i = 1; i < a.length; i++) {
    if (a[i].topic !== a[i - 1].topic) continue;
    const j = a.findIndex((x, k) => k > i && x.topic !== a[i - 1].topic);
    if (j > 0) [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function shuffleNow() {
  state.shuffleSeed = Math.floor(Math.random() * 2 ** 31);
  renderFeed();
  window.scrollTo({ top: 0 });
  toast("Shuffled ✨");
}

const pullEl = el("div", { class: "pull", "aria-hidden": "true" }, el("span"));
$(".top").after(pullEl);
const PULL_TRIGGER = 90;
let pull = null;
window.addEventListener("touchstart", (e) => {
  pull = state.view === "all" && window.scrollY <= 0 && e.touches.length === 1 ? { y0: e.touches[0].clientY, d: 0 } : null;
}, { passive: true });
window.addEventListener("touchmove", (e) => {
  if (!pull) return;
  pull.d = Math.max(0, (e.touches[0].clientY - pull.y0) * 0.5); // resistance
  if (pull.d <= 0) return;
  e.preventDefault(); // we handle this pull, not the page
  pullEl.style.height = `${Math.min(pull.d, PULL_TRIGGER + 20)}px`;
  pullEl.firstElementChild.textContent = pull.d >= PULL_TRIGGER ? "↻ Release to shuffle" : "↓ Pull to shuffle";
  pullEl.classList.toggle("ready", pull.d >= PULL_TRIGGER);
}, { passive: false });
window.addEventListener("touchend", () => {
  if (!pull) return;
  const go = pull.d >= PULL_TRIGGER;
  pull = null;
  pullEl.style.height = "0";
  pullEl.classList.remove("ready");
  if (go) shuffleNow();
});

// ---------- boot ----------
function render() {
  // A view can disappear (group turned off, topic hidden): fall back to All.
  const v = state.view;
  if (v.startsWith("group:") ? groupOf(v.slice(6))?.enabled === false || !groupOf(v.slice(6))
    : !["all", "saved", "settings", "week"].includes(v) && !isTopicActive(v)) state.view = "all";
  renderChips();
  renderFeed();
}

async function load() {
  applyTheme();
  const [taxonomy, catalog, index] = await Promise.all([getJSON("taxonomy.json"), getJSON("catalog.json"), getJSON("editions/index.json")]);
  state.taxonomy = taxonomy;
  state.catalog = catalog.sources;
  state.latest = index.latest;
  // Only the last 30 editions can hold unread items worth carrying over.
  state.editions = await Promise.all(index.editions.slice(0, 30).map((d) => getJSON(`editions/${d}.json`)));

  // The agent marks new topics as set up (and may add sources to the catalog) in agent-notes.json.
  const notes = await getJSON("agent-notes.json", { optional: true });
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

  // Bring in ratings/read state from GitHub (e.g. after a reinstall); re-render if anything changed.
  if (await pullState()) {
    reloadFromStorage();
    applyTheme();
    rebuildProfile();
    render();
  }
}

load().catch((err) => {
  feed.replaceChildren(el("p", { class: "empty" }, "Couldn't load your editions.", el("br"), el("small", {}, err.message)));
});
