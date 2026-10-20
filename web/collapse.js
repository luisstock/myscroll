// Collapsible Settings sections (accordion style). Post-processes the rendered .set-section elements,
// so the section builders stay untouched. Open/closed is remembered per section on this device only.
import { el } from "./ui.js";

const KEY = "myscroll:settingsOpen";
const OPEN_BY_DEFAULT = ["Reading"];

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}
function save(map) {
  try { localStorage.setItem(KEY, JSON.stringify(map)); } catch { /* private mode: just don't remember */ }
}
const isOpen = (map, title) => (title in map ? !!map[title] : OPEN_BY_DEFAULT.includes(title));
const remember = (title, open) => { const m = load(); m[title] = open; save(m); };

export function collapseSections(root) {
  const map = load();
  for (const sec of root.querySelectorAll(".set-section")) {
    if (sec.tagName === "DETAILS") { // "Your reading" is already a <details>
      const title = sec.querySelector("summary").textContent.trim();
      sec.open = isOpen(map, title);
      sec.addEventListener("toggle", () => remember(title, sec.open));
      continue;
    }
    const head = sec.querySelector(":scope > h2, :scope > h3");
    if (!head) continue;
    const title = head.textContent.trim();
    const inner = el("div", { class: "set-inner" }, [...sec.childNodes].filter((n) => n !== head));
    const body = el("div", { class: "set-body" }, inner);
    head.classList.add("set-head");
    head.setAttribute("role", "button");
    head.tabIndex = 0;
    head.append(el("span", { class: "set-chev", "aria-hidden": "true" }, "▾"));
    const paint = (on) => {
      sec.classList.toggle("collapsed", !on);
      head.setAttribute("aria-expanded", String(on));
    };
    const toggle = () => { const on = sec.classList.contains("collapsed"); paint(on); remember(title, on); };
    head.addEventListener("click", toggle);
    head.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
    paint(isOpen(map, title));
    sec.append(body);
  }
}
