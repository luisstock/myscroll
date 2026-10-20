// Settings screen: what the app learned, reading options, groups, topics (with editor), sources, backlog.
import {
  state, store, saveSettings, topics, groups, topicOf, groupOf, topicWeight, editableTopics, editableGroups,
  slugify, deriveKeywords, allSources, suggestSources, searchPlan, enableCatalogSource, removeSource, rebuildProfile, pool,
  visibility, featureLabel, reloadFromStorage, live,
} from "./model.js";
import { el } from "./ui.js";
import { DEFAULT_ABOUT } from "./profile.js";
import { collapseSections } from "./collapse.js";
import { aiSection } from "./ai.js";
import { moodsSection } from "./moods.js";
import { bedtimeSection } from "./bedtime.js";
import { statsSection } from "./stats.js";
import { github, loadMore } from "./loadmore.js";
import { getJSON } from "./env.js";
import { followedSection } from "./follow.js";
import { discoverSources, canDiscover, aiSuggestions, askedRecently, dismissSuggestion, addSuggestion, isFinding } from "./discover.js";
import { syncConfigured, syncStatus, pullState, pushState } from "./sync.js";

let ctx; // { root, refreshChrome, applyTheme }

export function renderSettings(context) {
  ctx = context;
  if (state.editTopic) return renderTopicEditor(state.editTopic);
  const s = state.settings;
  ctx.root.replaceChildren(el("div", { class: "settings" },
    profileSection(s),
    statsSection({ state, live, topicOf }),
    learnedSection(), readingSection(s),
    moodsSection({ settings: s, topics: () => topics().filter((t) => !t.hidden), save: saveSettings, rerender }),
    bedtimeSection({ settings: s, save: saveSettings, rerender }),
    aiSection({ rerender }), Object.assign(loadMoreSection(s), { className: "set-section sync-section" }),
    followedSection(() => renderSettings(ctx)), groupsSection(), topicsSection(), sourcesSection(), backlogSection()));
  collapseSections(ctx.root);
}

// ---------- Load more ----------
function syncLine() {
  if (!syncConfigured()) return "Not connected yet: your ratings and reading stay only on this device.";
  const m = syncStatus();
  if (m.lastError) return `⚠️ Last sync failed: ${m.lastError}`;
  if (m.dirty) return "Changes waiting to be sent…";
  return m.lastSyncedAt ? `✓ In sync (last ${new Date(m.lastSyncedAt).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" })})` : "Connected.";
}

function loadMoreSection(s) {
  const gh = github.get();
  const repo = el("input", { value: gh.repo || "luisstock/myscroll", placeholder: "your-user/myscroll", "aria-label": "GitHub repository" });
  const token = el("input", { type: "password", value: gh.token, placeholder: "github_pat_…", "aria-label": "GitHub token", autocomplete: "off" });
  const status = el("p", { class: "set-hint sync-line" }, syncLine());
  const sync = async () => {
    status.textContent = "Syncing…";
    if (await pullState()) { reloadFromStorage(); rebuildProfile(); }
    await pushState();
    status.textContent = syncLine();
    ctx.refreshChrome();
  };
  return section("Sync & Load more", "Connect your GitHub repo so the agent learns from your ratings and what you've read here, your progress survives a reinstall, and “Load more” works away from your PC.",
    status,
    el("label", { class: "field" }, el("span", {}, "GitHub repository"), repo),
    el("label", { class: "field" }, el("span", {}, "GitHub token: fine-grained, only this repo, “Contents” and “Actions” set to Read and write"), token),
    el("div", { class: "form-btns" },
      el("button", { class: "mini-btn", onclick: () => { github.set({ repo: repo.value.trim(), token: token.value.trim() }); sync(); } }, "Save & sync"),
      syncConfigured() ? el("button", { class: "mini-btn", onclick: sync }, "Sync now") : null),
    el("a", { class: "token-link", href: "https://github.com/settings/personal-access-tokens/new", target: "_blank", rel: "noopener" }, "Create a token on GitHub ↗"),
    el("ol", { class: "token-steps" },
      el("li", {}, "Repository access: Only select repositories → myscroll"),
      el("li", {}, "Permissions: Contents → Read and write, Actions → Read and write"),
      el("li", {}, "Generate token, copy it, paste it above, Save & sync")),
    el("p", { class: "set-hint" }, "The token stays only on this device and is never synced."),
    el("label", { class: "row" }, el("span", {}, "Items per “Load more”"),
      el("input", { type: "number", min: 3, max: 40, value: s.loadMoreCount ?? 15, onchange: (e) => { s.loadMoreCount = Number(e.target.value); saveSettings(); } })));
}

const rerender = () => { saveSettings(); ctx.refreshChrome(); renderSettings(ctx); };

function section(title, hint, ...body) {
  return el("section", { class: "set-section" },
    el("h3", {}, title), hint ? el("p", { class: "set-hint" }, hint) : null, ...body);
}

function seg(options, value, onPick, cls = "") {
  return el("div", { class: `seg ${cls}`, role: "group" }, options.map(([id, name]) =>
    el("button", { type: "button", "aria-pressed": String(value === id), onclick: () => onPick(id) }, name)));
}

const weightControl = (value, onChange) =>
  seg([[0, "Off"], [1, "Normal"], [2, "More"], [3, "Max"]], value, onChange, "weights");

// ---------- Your profile ----------
// Who you are and what to avoid: every AI prompt (Fast, books, ask, sources, the daily agent) starts from this.
function profileSection(s) {
  const p = (s.profile ??= { about: "", avoid: "" });
  let timer;
  const save = (key) => (e) => { p[key] = e.target.value; clearTimeout(timer); timer = setTimeout(saveSettings, 400); };
  const flush = () => { clearTimeout(timer); saveSettings(); };
  return section("👤 Your profile", "Tell MyScroll who is reading. It is used whenever AI writes for you. Saved as you type.",
    el("label", { class: "field" }, el("span", {}, "About you"),
      el("textarea", { rows: 4, placeholder: DEFAULT_ABOUT, "aria-label": "About you", oninput: save("about"), onchange: flush },  p.about ?? "")),
    el("label", { class: "field" }, el("span", {}, "Less of this"),
      el("textarea", { rows: 2, placeholder: "e.g. celebrity gossip, crypto hype, politics outrage", "aria-label": "Less of this", oninput: save("avoid"), onchange: flush }, p.avoid ?? "")));
}

// ---------- What MyScroll learned ----------
function learnedSection() {
  const s = state.settings;
  const entries = [...state.profile.entries()].filter(([, e]) => e.n >= 0.5);
  const liked = entries.filter(([, e]) => e.affinity > 0.1).sort((a, b) => b[1].affinity - a[1].affinity).slice(0, 10);
  const disliked = entries.filter(([, e]) => e.affinity < -0.1 && !e.muted).sort((a, b) => a[1].affinity - b[1].affinity).slice(0, 10);
  const muted = entries.filter(([, e]) => e.muted);
  const pill = ([f, e], extra) => el("span", { class: "pill" + (e.affinity > 0 ? " pos" : " neg") },
    featureLabel(f), el("span", { class: "aff" }, (e.affinity > 0 ? "+" : "") + e.affinity.toFixed(2)), extra);
  const n = Object.keys(state.ratings).length;
  return section("What MyScroll learned",
    n ? `From ${n} rating${n > 1 ? "s" : ""}. Scores go from −1 to +1 and need a few ratings before they move much.` : "Rate a few items (0–5) and this fills up.",
    liked.length ? el("div", {}, el("p", { class: "mini" }, "More of"), el("div", { class: "pills" }, liked.map((x) => pill(x)))) : null,
    disliked.length ? el("div", {}, el("p", { class: "mini" }, "Less of"), el("div", { class: "pills" }, disliked.map((x) => pill(x)))) : null,
    muted.length ? el("div", {}, el("p", { class: "mini" }, "Muted (removed from the feed)"), el("div", { class: "pills" }, muted.map((x) =>
      pill(x, el("button", { class: "unmute", onclick: () => { s.unmuted.push(x[0]); rebuildProfile(); rerender(); } }, "unmute"))))) : null,
    n ? el("button", { class: "link danger", onclick: () => {
      if (!confirm("Forget all ratings and start learning from scratch?")) return;
      state.ratings = {}; state.skips = {}; s.unmuted = [];
      store.set("ratings", {}); store.set("skips", {});
      rebuildProfile(); rerender();
    } }, "Reset learning") : null,
  );
}

// ---------- Reading ----------
function readingSection(s) {
  return section("Reading", null,
    el("div", { class: "row" }, el("span", {}, "Layout"),
      seg([["cards", "Cards"], ["list", "List"], ["text", "Text only"]], s.layout, (v) => { s.layout = v; saveSettings(); ctx.applyTheme(); renderSettings(ctx); })),
    el("div", { class: "row" }, el("span", {}, "Theme"),
      seg([["dark", "Dark"], ["night", "Night"], ["light", "Light"]], s.theme, (v) => { s.theme = v; saveSettings(); ctx.applyTheme(); renderSettings(ctx); })),
    el("div", { class: "row" }, el("span", {}, "Top bar shows"),
      seg([["groups", "Groups"], ["topics", "Topics"]], s.navBy, (v) => { s.navBy = v; rerender(); })),
    el("div", { class: "row" }, el("span", {}, "Feed order"),
      seg([["mixed", "Mixed"], ["topics", "By topic"]], s.feedOrder ?? "mixed", (v) => { s.feedOrder = v; rerender(); })),
    el("label", { class: "row" }, el("span", {}, "Order by what I read most"),
      el("input", { type: "checkbox", checked: s.orderByReading !== false, onchange: (e) => { s.orderByReading = e.target.checked; rerender(); } })),
    el("label", { class: "row" }, el("span", {}, "Items per edition"),
      el("input", { type: "number", min: 10, max: 150, step: 5, value: s.dailyTarget, onchange: (e) => { s.dailyTarget = Number(e.target.value); saveSettings(); } })),
    el("label", { class: "row" }, el("span", {}, "News expire after (days)"),
      el("input", { type: "number", min: 1, max: 60, value: s.newsExpireDays, onchange: (e) => { s.newsExpireDays = Number(e.target.value); rerender(); } })),
    el("label", { class: "row" }, el("span", {}, "Remove curiosities scrolled past unopened"),
      el("input", { type: "checkbox", checked: s.skipRule.enabled, onchange: (e) => { s.skipRule.enabled = e.target.checked; rerender(); } })),
    el("label", { class: "row" + (s.skipRule.enabled ? "" : " disabled") }, el("span", {}, "…after this many times"),
      el("input", { type: "number", min: 2, max: 50, value: s.skipRule.limit, disabled: !s.skipRule.enabled, onchange: (e) => { s.skipRule.limit = Number(e.target.value); rerender(); } })),
  );
}

// ---------- Groups ----------
function groupsSection() {
  const emoji = el("input", { class: "emoji-in", maxlength: 4, placeholder: "📁", "aria-label": "Emoji" });
  const name = el("input", { placeholder: "New group name", "aria-label": "Group name" });
  return section("Groups", "Groups bundle topics together. Turn a group off to hide all its topics at once.",
    groups().map((g) => {
      const members = topics().filter((t) => t.group === g.id);
      return el("div", { class: "group-row" + (g.enabled === false ? " off" : "") },
        el("div", { class: "group-main" },
          el("label", { class: "switch" },
            el("input", { type: "checkbox", checked: g.enabled !== false, onchange: (e) => {
              editableGroups().find((x) => x.id === g.id).enabled = e.target.checked; rerender();
            } }),
            el("span", { class: "group-name" }, `${g.emoji} ${g.name}`)),
          el("div", { class: "group-btns" },
            el("button", { class: "mini-btn", onclick: () => {
              const n = prompt("Group name", g.name);
              if (!n) return;
              const e = prompt("Emoji", g.emoji) ?? g.emoji;
              Object.assign(editableGroups().find((x) => x.id === g.id), { name: n.trim(), emoji: e.trim() || g.emoji });
              rerender();
            } }, "Rename"),
            el("button", { class: "del", "aria-label": `Delete group ${g.name}`, onclick: () => {
              if (!confirm(`Delete the group "${g.name}"? Its topics stay, just ungrouped.`)) return;
              state.settings.groups = editableGroups().filter((x) => x.id !== g.id);
              state.settings.removedGroups = [...(state.settings.removedGroups ?? []), g.id];
              for (const t of editableTopics()) if (t.group === g.id) delete t.group;
              rerender();
            } }, "✕"))),
        el("p", { class: "group-topics" }, members.length ? members.map((t) => `${t.emoji} ${t.label}`).join("  ·  ") : "No topics yet — pick this group when editing a topic."));
    }),
    el("form", { class: "inline-add", onsubmit: (e) => {
      e.preventDefault();
      if (!name.value.trim()) return name.focus();
      const list = editableGroups();
      let id = slugify(name.value), i = 2;
      while (list.some((g) => g.id === id)) id = `${slugify(name.value)}-${i++}`;
      list.push({ id, name: name.value.trim(), emoji: emoji.value.trim() || "📁", enabled: true });
      rerender();
    } }, emoji, name, el("button", { type: "submit" }, "Add group")),
  );
}

// ---------- Topics ----------
function topicsSection() {
  const counts = allSources().reduce((m, s) => ((m[s.topic] = (m[s.topic] ?? 0) + 1), m), {});
  return section("Topics", "How much of each topic you want. Tap Edit to rename, describe what you want, change sources or hide it.",
    topics().map((t) => {
      const g = t.group && groupOf(t.group);
      return el("div", { class: "topic-row" + (t.hidden ? " off" : "") },
        el("div", { class: "topic-main" },
          el("span", { class: "topic-name" }, `${t.emoji} ${t.label}`),
          el("span", { class: "topic-meta" },
            [g ? `${g.emoji} ${g.name}` : "No group", `${counts[t.id] ?? 0} sources`, t.hidden ? "hidden" : null, t.status === "new" ? "setting up" : null]
              .filter(Boolean).join(" · "))),
        el("div", { class: "topic-ctl" },
          t.hidden ? el("span", { class: "badge" }, "Hidden") : weightControl(topicWeight(t.id), (w) => { state.settings.topicWeights[t.id] = w; rerender(); }),
          el("button", { class: "mini-btn", onclick: () => { state.editTopic = t.id; renderSettings(ctx); window.scrollTo({ top: 0 }); } }, "Edit")));
    }),
    el("button", { class: "primary-btn", onclick: () => { state.editTopic = "new"; renderSettings(ctx); window.scrollTo({ top: 0 }); } }, "+ New topic"),
    state.settings.topics ? el("button", { class: "link", onclick: () => {
      if (!confirm("Restore the original topics and groups? Your own topics will be removed.")) return;
      state.settings.topics = null; state.settings.groups = null;
      state.settings.removedTopics = []; state.settings.removedGroups = [];
      rerender();
    } }, "Restore default topics & groups") : null,
  );
}

function parseList(text) {
  return text.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
}

function renderTopicEditor(id) {
  const isNew = id === "new";
  const t = isNew ? { label: "", emoji: "", description: "", keywords: [], subs: [], group: "" } : topicOf(id);
  const back = () => { state.editTopic = null; renderSettings(ctx); window.scrollTo({ top: 0 }); };

  const f = {
    emoji: el("input", { class: "emoji-in", maxlength: 4, value: t.emoji, placeholder: "🧭", "aria-label": "Emoji" }),
    label: el("input", { value: t.label, placeholder: "e.g. Coffee, Japanese culture, Synthesizers", required: true, "aria-label": "Name" }),
    description: el("textarea", { rows: 3, placeholder: "What do you want from this topic? The agent reads this. e.g. 'New releases and techniques in modular synths, no gear-buying advice.'" }, t.description ?? ""),
    keywords: el("textarea", { rows: 2, placeholder: "Comma separated. Leave empty and the agent will work them out." }, (t.keywords ?? []).join(", ")),
    subs: el("input", { value: (t.subs ?? []).map((x) => x.label).join(", "), placeholder: "Optional, comma separated: News, Techniques, History" }),
    group: el("select", {}, el("option", { value: "" }, "No group"), groups().map((g) => el("option", { value: g.id, selected: t.group === g.id }, `${g.emoji} ${g.name}`))),
    lang: el("select", {}, el("option", { value: "en", selected: t.lang !== "pt" }, "English"), el("option", { value: "pt", selected: t.lang === "pt" }, "Português")),
    hidden: el("input", { type: "checkbox", checked: !!t.hidden }),
  };

  const save = (e) => {
    e.preventDefault();
    const label = f.label.value.trim();
    if (!label) return f.label.focus();
    const list = editableTopics();
    const subs = parseList(f.subs.value).map((l) => t.subs?.find((x) => x.label === l) ?? { id: slugify(l), label: l });
    const data = {
      label, emoji: f.emoji.value.trim() || "🧭", description: f.description.value.trim(),
      keywords: parseList(f.keywords.value), subs, group: f.group.value || undefined,
      lang: f.lang.value === "pt" ? "pt" : undefined, hidden: f.hidden.checked || undefined,
    };
    if (isNew) {
      let newId = slugify(label), i = 2;
      while (list.some((x) => x.id === newId)) newId = `${slugify(label)}-${i++}`;
      if (!data.keywords.length) data.keywords = deriveKeywords(label, data.description, subs);
      const topic = { id: newId, ...data, custom: true, status: "new", created: new Date().toISOString() };
      list.push(topic);
      // Get it working straight away: attach the best-matching sources from the catalog...
      for (const src of suggestSources(topic, 4)) enableCatalogSource(src, newId);
      state.editTopic = newId;
      autoFind = newId; // ...and let Gemini find more as soon as the editor opens
    } else if (data.description !== (t.description ?? "") && !allSources().some((s) => s.topic === id)) {
      autoFind = id; // a description was added to a topic that still has no sources
    } else {
      Object.assign(list.find((x) => x.id === id), data);
    }
    rerender();
    window.scrollTo({ top: 0 });
  };

  const form = el("form", { class: "topic-form", onsubmit: save },
    el("div", { class: "name-row" }, f.emoji, f.label),
    el("label", { class: "field" }, el("span", {}, "What you want from it"), f.description),
    el("label", { class: "field" }, el("span", {}, "Keywords to search"), f.keywords),
    el("label", { class: "field" }, el("span", {}, "Subcategories"), f.subs),
    el("div", { class: "two" },
      el("label", { class: "field" }, el("span", {}, "Group"), f.group),
      el("label", { class: "field" }, el("span", {}, "Language"), f.lang)),
    isNew ? null : el("label", { class: "row" }, el("span", {}, "Hide this topic"), f.hidden),
    el("div", { class: "form-btns" },
      el("button", { type: "submit", class: "primary-btn" }, isNew ? "Create topic" : "Save"),
      el("button", { type: "button", class: "mini-btn", onclick: back }, "Cancel")),
  );

  const extra = [];
  if (!isNew) {
    const mine = allSources().filter((s) => s.topic === id);
    const suggNode = suggestionsSection(t); // built before the Find button so it knows if a first-run search is pending
    if (t.status === "new") extra.push(el("p", { class: "notice" },
      "🆕 Ready to use with the sources below. On its next run the agent will finish setting it up: look for more sources and learn what's worth showing."));
    extra.push(section("How the agent will search", "Built from your keywords and description, plus every source below.",
      el("ul", { class: "plan" }, searchPlan(t).map((q) => el("li", {}, q)))));
    extra.push(section(`Sources (${mine.length})`, mine.length ? null : "No sources yet. Tap ✨ Find sources, add some below, or let the agent find them.",
      findSourcesBox(t), mine.map((src) => sourceRow(src)), addSourceForm(id)));
    extra.push(suggNode);
    extra.push(el("button", { class: "link danger", onclick: () => {
      if (!confirm(`Delete the topic "${t.label}"? Items already in your scroll from it will disappear.`)) return;
      state.settings.topics = editableTopics().filter((x) => x.id !== id);
      state.settings.removedTopics = [...(state.settings.removedTopics ?? []), id];
      state.settings.customSources = state.settings.customSources.filter((x) => x.topic !== id);
      state.editTopic = null;
      rerender();
    } }, "Delete topic"));
  }

  ctx.root.replaceChildren(el("div", { class: "settings" },
    el("button", { class: "back", onclick: back }, "← Settings"),
    section(isNew ? "New topic" : `${t.emoji} ${t.label}`, isNew ? "Describe it and MyScroll sets up where to look: keywords, a search plan and matching sources." : null, form),
    ...extra));
}

// ---------- Sources ----------
// Suggested sources: catalog matches + Gemini's verified ideas (cached per topic). "+ Add" makes a normal source.
let autoFind = null;
let paintSugg = null; // repaints the open editor's suggestions section
function suggestionsSection(topic) {
  const sec = el("section", { class: "set-section sugg-section" });
  const row = (src, ai) => el("div", { class: "src-row sugg" },
    el("div", { class: "src-name sugg-name" },
      el("div", { class: "sugg-line" }, el("a", { href: src.url, target: "_blank", rel: "noopener" }, src.name),
        ai ? el("span", { class: "badge ai" }, "✨ AI") : null, el("span", { class: "badge" }, src.type)),
      ai && src.why ? el("small", { class: "sugg-why" }, src.why) : null),
    el("div", { class: "sugg-ctl" },
      el("button", { class: "mini-btn add", onclick: () => { ai ? addSuggestion(topic.id, src) : enableCatalogSource(src, topic.id); rerender(); } }, "+ Add"),
      ai ? el("button", { class: "del", "aria-label": `Dismiss ${src.name}`, onclick: () => { dismissSuggestion(topic.id, src); paint(); } }, "✕") : null));
  const paint = () => {
    const ai = aiSuggestions(topic.id), cat = suggestSources(topic, 8);
    const busy = isFinding(topic.id) || autoFind === topic.id;
    sec.hidden = !ai.length && !cat.length && !busy;
    sec.replaceChildren(...[el("h3", {}, "Suggested sources"),
      el("p", { class: "set-hint" }, "From the MyScroll catalog and from Gemini (checked: each one has a working feed)."),
      busy ? el("p", { class: "more-status" }, "Looking for sources…") : null,
      ...ai.map((s) => row(s, true)), ...cat.map((s) => row(s, false))].filter(Boolean));
  };
  paintSugg = () => { if (sec.isConnected && state.editTopic === topic.id) paint(); };
  paint();
  // Few suggestions and Gemini not asked this week: look in the background (a brand-new topic does it via autoFind).
  if (autoFind !== topic.id && canDiscover() && !isFinding(topic.id) && !askedRecently(topic.id)
    && aiSuggestions(topic.id).length + suggestSources(topic, 8).length < 3) {
    discoverSources(topic).then(() => paintSugg?.(), () => paintSugg?.());
    paint();
  }
  return sec;
}

// ✨ Find sources: Gemini suggests, this device checks each one works, the good ones go to the suggestions above.
// Without a Gemini key on this device: the agent on GitHub finds sources for a topic that has none (a few minutes);
// suggestions for a topic that already has some need the key.
function agentFindBox(topic) {
  const status = el("p", { class: "more-status", hidden: true });
  const empty = !allSources().some((s) => s.topic === topic.id);
  const openAI = () => {
    state.editTopic = null;
    renderSettings(ctx);
    const sec = document.querySelector(".ai-section");
    if (sec?.classList.contains("collapsed")) sec.querySelector(".set-head")?.click();
    sec?.scrollIntoView({ block: "start" });
    window.scrollBy(0, -110);
  };
  const btn = el("button", { type: "button", class: "mini-btn add find-btn" }, "✨ Find sources");
  btn.onclick = async () => {
    status.hidden = false;
    status.classList.remove("error");
    if (!empty) {
      status.replaceChildren("Suggestions come from Gemini: add your free key once in Settings → AI. ",
        el("button", { class: "setup-link", onclick: openAI }, "Open Settings → AI →"));
      return;
    }
    btn.disabled = true;
    btn.textContent = "Finding…";
    try {
      await loadMore((t) => { status.textContent = t; }, { topics: [topic.id] });
      state.catalog = (await getJSON("catalog.json")).sources; // the agent adds what it found to the catalog
      if (state.editTopic === topic.id) rerender();
    } catch (err) {
      status.replaceChildren(err.message, err.needsSetup ? el("button", { class: "setup-link", onclick: openAI }, " Or add a Gemini key →") : null);
      status.classList.add("error");
      btn.disabled = false;
      btn.textContent = "✨ Find sources";
    }
  };
  return el("div", { class: "find-box" }, btn, status,
    el("p", { class: "set-hint" }, empty
      ? "The agent will look for good sources for this topic and bring the first items (a few minutes). With a Gemini key in Settings → AI it takes seconds."
      : "Add your Gemini key in Settings → AI to get source suggestions you can add with one tap."));
}

function findSourcesBox(topic) {
  if (!canDiscover()) return agentFindBox(topic);
  const status = el("p", { class: "more-status", hidden: true });
  const btn = el("button", { type: "button", class: "mini-btn add find-btn" }, "✨ Find sources");
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = "Finding…";
    status.hidden = false;
    status.classList.remove("error");
    paintSugg?.();
    // A brand-new topic with no sources yet gets the top 3 verified ones right away so it works immediately.
    const autoAdd = allSources().some((s) => s.topic === topic.id) ? 0 : 3;
    try {
      const { found, added, skipped } = await discoverSources(topic, (t) => { status.textContent = t; }, { autoAdd });
      if (!found.length) throw new Error(`No working sources found${skipped.length ? ` (${skipped.length} didn't answer)` : ""}. Try a more specific description.`);
      if (state.editTopic !== topic.id) return;
      if (added.length) { rerender(); return; }
      status.textContent = `Found ${found.length} working source${found.length > 1 ? "s" : ""}: see Suggested sources below.`;
      btn.disabled = false;
      btn.textContent = "✨ Find sources";
      paintSugg?.();
    } catch (err) {
      paintSugg?.();
      status.textContent = err.message;
      status.classList.add("error");
      btn.disabled = false;
      btn.textContent = "✨ Find sources";
    }
  };
  if (autoFind === topic.id) { autoFind = null; setTimeout(() => btn.click(), 0); }
  return el("div", { class: "find-box" }, btn, status,
    allSources().some((s) => s.topic === topic.id) ? null : el("p", { class: "set-hint" }, "No sources yet: the 3 best working ones will be added automatically so this topic works right away."));
}

function sourceRow(src) {
  const s = state.settings;
  return el("div", { class: "src-row" },
    el("div", { class: "src-name" },
      el("a", { href: src.url, target: "_blank", rel: "noopener" }, src.name),
      el("span", { class: "badge" }, src.type), src.custom ? el("span", { class: "badge mine" }, "added") : null),
    el("div", { class: "src-ctl" },
      weightControl(src.weight, (w) => { s.sourceOverrides[src.id] = { ...s.sourceOverrides[src.id], weight: w }; rerender(); }),
      el("button", { class: "del", "aria-label": `Remove ${src.name}`, onclick: () => { removeSource(src); rerender(); } }, "✕")));
}

function addSourceForm(fixedTopic) {
  const s = state.settings;
  const urlInput = el("input", { type: "url", name: "url", placeholder: "https://… (site, subreddit, YouTube channel, RSS)", required: true });
  const nameInput = el("input", { type: "text", name: "name", placeholder: "Name (optional)" });
  const topicSelect = fixedTopic ? null : el("select", { name: "topic" }, topics().map((t) => el("option", { value: t.id }, `${t.emoji} ${t.label}`)));
  return el("form", { class: "add-source", onsubmit: (e) => {
    e.preventDefault();
    let url;
    try { url = new URL(urlInput.value.trim()); } catch { urlInput.focus(); return; }
    const topic = fixedTopic ?? topicSelect.value;
    const host = url.hostname.replace(/^www\./, "");
    const norm = (u) => { const x = new URL(u); return x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/+$/, "").toLowerCase(); };
    const dupe = allSources().find((src) => src.topic === topic && (norm(src.url).startsWith(norm(url.href)) || norm(url.href).startsWith(norm(src.url))));
    if (dupe) { alert(`Already in this topic: ${dupe.name}`); return; }
    const type = /reddit\.com/.test(host) ? "reddit" : /youtube\.com|youtu\.be|vimeo\.com/.test(host) ? "video" : /rss|feed|\.xml$/.test(url.href) ? "rss" : "site";
    const name = nameInput.value.trim() || (type === "reddit" ? url.pathname.match(/\/r\/[^/]+/)?.[0]?.slice(1) : null) || host;
    s.customSources.push({ id: `custom-${Date.now()}`, topic, name, url: url.href, type, weight: 1, custom: true });
    rerender();
  } }, urlInput, el("div", { class: "add-row" + (fixedTopic ? " no-topic" : "") }, topicSelect, nameInput, el("button", { type: "submit" }, "Add")));
}

function sourcesSection() {
  const sources = allSources();
  return section("Sources", "The agent also discovers new sources on its own. Add your favourites, clean up, set priorities, or pick from suggestions inside each topic.",
    addSourceForm(null),
    topics().map((t) => {
      const list = sources.filter((src) => src.topic === t.id);
      const sugg = suggestSources(t, 5);
      return el("details", { class: "src-group" },
        el("summary", {}, `${t.emoji} ${t.label}`, el("span", { class: "n" }, String(list.length))),
        list.map(sourceRow),
        sugg.length ? el("div", { class: "sugg-block" }, el("p", { class: "mini" }, "Suggestions"),
          sugg.map((src) => el("div", { class: "src-row sugg" },
            el("div", { class: "src-name" }, el("a", { href: src.url, target: "_blank", rel: "noopener" }, src.name), el("span", { class: "badge" }, src.type)),
            el("button", { class: "mini-btn add", onclick: () => { enableCatalogSource(src, t.id); rerender(); } }, "+ Add")))) : null);
    }),
    Object.values(state.settings.sourceOverrides).some((o) => o.deleted)
      ? el("button", { class: "link", onclick: () => { for (const o of Object.values(state.settings.sourceOverrides)) delete o.deleted; rerender(); } }, "Restore removed default sources")
      : null,
  );
}

// ---------- Backlog ----------
function backlogSection() {
  const counts = pool().reduce((acc, i) => ((acc[visibility(i)] = (acc[visibility(i)] ?? 0) + 1), acc), {});
  return section("Backlog", null,
    el("p", { class: "set-hint" },
      `${counts.visible ?? 0} in your scroll · ${counts.done ?? 0} read · ${counts.expired ?? 0} expired news` +
      (counts["topic-off"] ? ` · ${counts["topic-off"]} in hidden topics` : "") +
      (counts["skipped-out"] ? ` · ${counts["skipped-out"]} removed after skipping` : "")),
    el("button", { class: "link", onclick: () => {
      if (!confirm("Mark everything as unread again?")) return;
      state.read.clear(); state.opened.clear(); state.skips = {};
      store.set("read", []); store.set("opened", []); store.set("skips", {});
      rebuildProfile(); rerender();
    } }, "Reset reading progress (testing)"),
  );
}
