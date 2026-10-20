// Settings → Reading: the "Available offline" line with Clear / Save now.
import { el } from "./ui.js";
import { offlineStats, clearOffline, precache } from "./offline.js";

export function offlineSection() {
  const line = el("span", {});
  const paint = (busy) => {
    const { items, bytes } = offlineStats();
    line.textContent = busy ? "Saving for offline…" : `${items ? "✓ " : ""}Available offline: ${items} items · ${(bytes / 1048576).toFixed(1)} MB`;
  };
  paint();
  return el("div", { class: "row" }, line,
    el("span", { class: "form-btns" },
      el("button", { class: "mini-btn", onclick: async () => { paint(true); await precache({ force: true, onProgress: () => paint(true) }); paint(); } }, "Save for offline now"),
      el("button", { class: "mini-btn", onclick: async () => { await clearOffline(); paint(); } }, "Clear")));
}
