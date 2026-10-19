// Bedtime mode: inside a time window the theme goes to "night", the feed gets calm (no news, short reads),
// a small badge shows in the header, and after a while a gentle "good night" appears. No streaks, no guilt.
// The pure rules at the top have no imports (model.js uses them); the UI receives what it needs as parameters.
import { el, $ } from "./ui.js";

export const BEDTIME_DEFAULTS = { enabled: false, from: "22:30", to: "06:00", minutes: 20 };
export const bedtimeOf = (settings) => ({ ...BEDTIME_DEFAULTS, ...(settings.bedtime ?? {}) });

const toMin = (hhmm) => { const [h, m] = String(hhmm).split(":").map(Number); return (h || 0) * 60 + (m || 0); };

// Is "now" inside the window? Handles windows that cross midnight (22:30 → 06:00).
export function bedtimeActive(settings, now = new Date()) {
  const b = bedtimeOf(settings);
  if (!b.enabled) return false;
  const t = now.getHours() * 60 + now.getMinutes();
  const from = toMin(b.from), to = toMin(b.to);
  if (from === to) return false;
  return from < to ? t >= from && t < to : t >= from || t < to;
}

// Same signature as moodFilter: a built-in calm mood while bedtime is on.
export function bedtimeFilter(item, settings, now = new Date()) {
  if (!bedtimeActive(settings, now)) return true;
  return item.kind !== "news" && item.style !== "news" && (item.minutes ?? 1) <= 4;
}

// The theme to show: night inside the window, otherwise the user's choice (which is never overwritten).
export const effectiveTheme = (settings) => (bedtimeActive(settings) ? "night" : settings.theme);

// ---------- runtime: badge, window changes, "that's enough" overlay ----------
// ctx: { settings(): current settings object, onChange(): re-apply theme + re-render }
export function initBedtime(ctx) {
  const badge = el("span", { class: "bedtime-badge", hidden: true, title: "Bedtime mode is on" }, "🌙 Bedtime");
  $(".top-btns")?.prepend(badge);

  let was = bedtimeActive(ctx.settings());
  let seconds = 0;       // time the app was visible inside the window this session
  let extra = 0;         // seconds added by "5 more minutes"
  let closed = false;    // "Close" pressed: leave the reader alone for the rest of this session
  let overlay = null;

  const hide = () => { overlay?.remove(); overlay = null; };
  const paint = () => { badge.hidden = !bedtimeActive(ctx.settings()); };

  function show() {
    if (overlay) return;
    overlay = el("div", { class: "bedtime-overlay", role: "dialog", "aria-label": "Good night" },
      el("div", { class: "bedtime-card" },
        el("div", { class: "moon" }, "🌙"),
        el("h2", {}, "That's enough for tonight."),
        el("p", {}, "Good night 🌙"),
        el("div", { class: "bedtime-btns" },
          el("button", { class: "bedtime-more", onclick: () => { extra += 300; hide(); } }, "5 more minutes"),
          el("button", { class: "bedtime-close", onclick: () => { closed = true; hide(); } }, "Close"))));
    document.body.append(overlay);
  }

  function check() {
    const active = bedtimeActive(ctx.settings());
    if (active !== was) {
      was = active;
      if (!active) { seconds = 0; extra = 0; closed = false; hide(); }
      paint();
      ctx.onChange();
    }
  }

  // setInterval, not requestAnimationFrame: it keeps running when the page is in the background.
  setInterval(() => {
    check();
    if (!was || closed || document.visibilityState !== "visible") return;
    seconds += 1;
    if (seconds >= bedtimeOf(ctx.settings()).minutes * 60 + extra) show();
  }, 1000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") check(); });
  document.addEventListener("myscroll:bedtime", () => { check(); paint(); }); // the user edited the bedtime settings
  paint();
}

// ---------- Settings section ----------
// ctx: { settings, save(), rerender() }
export function bedtimeSection(ctx) {
  const s = ctx.settings;
  const b = bedtimeOf(s);
  const upd = (patch) => { s.bedtime = { ...bedtimeOf(s), ...patch }; ctx.save(); document.dispatchEvent(new Event("myscroll:bedtime")); };
  const timeIn = (key, label) => el("input", { type: "time", value: b[key], "aria-label": label, disabled: !b.enabled, onchange: (e) => e.target.value && upd({ [key]: e.target.value }) });
  return el("section", { class: "set-section bedtime-section" },
    el("h3", {}, "Bedtime"),
    el("p", { class: "set-hint" }, "In the evening the app turns to the warm night theme, shows only calm, short reads and no news, and after a while says good night. Nothing is counted and nothing is lost."),
    el("label", { class: "row" }, el("span", {}, "Bedtime mode"),
      el("input", { type: "checkbox", checked: b.enabled, onchange: (e) => { upd({ enabled: e.target.checked }); ctx.rerender(); } })),
    el("div", { class: "row" + (b.enabled ? "" : " disabled") }, el("span", {}, "From"), timeIn("from", "Bedtime starts")),
    el("div", { class: "row" + (b.enabled ? "" : " disabled") }, el("span", {}, "Until"), timeIn("to", "Bedtime ends")),
    el("label", { class: "row" + (b.enabled ? "" : " disabled") }, el("span", {}, "Say good night after (minutes)"),
      el("input", { type: "number", min: 5, max: 120, step: 5, value: b.minutes, disabled: !b.enabled, onchange: (e) => upd({ minutes: Math.max(1, Number(e.target.value) || 20) }) })));
}
