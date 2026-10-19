// Moods: "what do I feel like reading?" A mood narrows the feed to some topics, a max reading time and
// optionally no news. The pure rules at the top have no imports, so model.js (and the Node agent) can use them.
// The UI below receives what it needs as parameters (no import of model.js, so no import cycle).
import { el } from "./ui.js";

export const DEFAULT_MOODS = [
  { id: "relax", name: "Relax", emoji: "😌", topics: ["til", "fun", "bike"], maxMinutes: 5, noNews: true },
  { id: "learn", name: "Learn", emoji: "🧠", topics: ["science", "books", "ideas", "tech"] },
  { id: "work", name: "Work inspiration", emoji: "🎨", topics: ["motion", "design", "ai"] },
];

export const moodsOf = (settings) => settings.moods ?? DEFAULT_MOODS;
export const activeMood = (settings) => moodsOf(settings).find((m) => m.id === settings.activeMood) ?? null;

// Does the item fit the active mood? (true when no mood is active)
export function moodFilter(item, settings) {
  const m = activeMood(settings);
  if (!m) return true;
  if (!m.topics.includes(item.topic)) return false;
  if (m.maxMinutes && (item.minutes ?? 1) > m.maxMinutes) return false;
  if (m.noNews && item.kind === "news") return false;
  return true;
}

// What "Load more" should research on All while a mood is active (null = no mood).
export function moodScope(settings) {
  const m = activeMood(settings);
  return m ? { topics: m.topics, label: `${m.emoji} ${m.name}` } : null;
}

const meta = (m) => [m.maxMinutes ? `up to ${m.maxMinutes} min` : null, m.noNews ? "no news" : null].filter(Boolean).join(" · ");

// ---------- header chip + picker ----------
// ctx: { settings, topics(): [{id,label,emoji}], save(), onChange() }
export function moodChip(ctx) {
  const m = activeMood(ctx.settings);
  return el("button", {
    class: "chip mood-chip", "aria-pressed": String(!!m), "aria-haspopup": "dialog",
    onclick: () => openPicker(ctx),
  }, m ? `${m.emoji} ${m.name}` : "Mood");
}

function openPicker(ctx) {
  const close = () => { sheet.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  const pick = (id) => { ctx.settings.activeMood = id; ctx.save(); close(); ctx.onChange(); };
  const topicName = (id) => ctx.topics().find((t) => t.id === id)?.emoji ?? "";
  const option = (m) => el("button", { class: "mood-opt", "aria-pressed": String(ctx.settings.activeMood === m.id), onclick: () => pick(m.id) },
    el("span", { class: "mood-emoji" }, m.emoji),
    el("span", { class: "mood-text" }, el("strong", {}, m.name),
      el("small", {}, [m.topics.map(topicName).join(" "), meta(m)].filter(Boolean).join("  ·  "))));
  const sheet = el("div", { class: "sheet-wrap", role: "dialog", "aria-label": "Pick a mood" },
    el("div", { class: "sheet-backdrop", onclick: close }),
    el("div", { class: "sheet" },
      el("p", { class: "sheet-title" }, "What do you feel like reading?"),
      ...moodsOf(ctx.settings).map(option),
      el("button", { class: "mood-opt", "aria-pressed": String(!ctx.settings.activeMood), onclick: () => pick(null) },
        el("span", { class: "mood-emoji" }, "✨"), el("span", { class: "mood-text" }, el("strong", {}, "None"), el("small", {}, "Everything in today's scroll")))));
  document.body.append(sheet);
  document.addEventListener("keydown", onKey);
}

// ---------- Settings section ----------
// ctx: { settings, topics(), save(), rerender() }
export function moodsSection(ctx) {
  const s = ctx.settings;
  // First edit copies the defaults into settings so they can be changed.
  const editable = () => (s.moods ??= JSON.parse(JSON.stringify(DEFAULT_MOODS)));
  const change = (fn) => { fn(editable()); ctx.save(); };
  return el("section", { class: "set-section moods-section" },
    el("h3", {}, "Moods"),
    el("p", { class: "set-hint" }, "A mood narrows the scroll to what you feel like right now. Pick one with the Mood chip at the top. “Load more” follows the mood too."),
    ...moodsOf(s).map((m) => moodEditor(ctx, m, change)),
    el("button", { class: "primary-btn", onclick: () => {
      change((list) => list.push({ id: `mood-${Date.now().toString(36)}`, name: "New mood", emoji: "🙂", topics: [] }));
      ctx.rerender();
    } }, "+ New mood"),
    s.moods ? el("button", { class: "link", onclick: () => {
      if (!confirm("Restore the three default moods?")) return;
      s.moods = null; s.activeMood = null; ctx.save(); ctx.rerender();
    } }, "Restore default moods") : null);
}

function moodEditor(ctx, m, change) {
  const upd = (patch) => change((list) => Object.assign(list.find((x) => x.id === m.id), patch));
  const toggleTopic = (id, on) => change((list) => {
    const cur = list.find((x) => x.id === m.id);
    cur.topics = on ? [...new Set([...cur.topics, id])] : cur.topics.filter((t) => t !== id);
  });
  return el("details", { class: "mood-edit" },
    el("summary", {}, `${m.emoji} ${m.name}`, el("span", { class: "n" }, meta(m) || `${m.topics.length} topics`)),
    el("div", { class: "name-row" },
      el("input", { class: "emoji-in", maxlength: 4, value: m.emoji, "aria-label": "Emoji", onchange: (e) => upd({ emoji: e.target.value.trim() || "🙂" }) }),
      el("input", { value: m.name, "aria-label": "Mood name", onchange: (e) => upd({ name: e.target.value.trim() || "Mood" }) })),
    el("p", { class: "mini" }, "Topics"),
    el("div", { class: "topic-checks" }, ctx.topics().map((t) => el("label", { class: "check" },
      el("input", { type: "checkbox", checked: m.topics.includes(t.id), onchange: (e) => toggleTopic(t.id, e.target.checked) }),
      `${t.emoji} ${t.label}`))),
    el("label", { class: "row" }, el("span", {}, "Max minutes per item (empty = any)"),
      el("input", { type: "number", min: 1, max: 60, value: m.maxMinutes ?? "", onchange: (e) => upd({ maxMinutes: e.target.value ? Number(e.target.value) : undefined }) })),
    el("label", { class: "row" }, el("span", {}, "No news"),
      el("input", { type: "checkbox", checked: !!m.noNews, onchange: (e) => upd({ noNews: e.target.checked || undefined }) })),
    el("button", { class: "link danger", onclick: () => {
      if (!confirm(`Delete the mood "${m.name}"?`)) return;
      change((list) => { list.splice(list.findIndex((x) => x.id === m.id), 1); });
      if (ctx.settings.activeMood === m.id) ctx.settings.activeMood = null;
      ctx.save(); ctx.rerender();
    } }, "Delete mood"));
}
