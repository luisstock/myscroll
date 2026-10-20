// Read later + Not interested: synced maps (state.later / state.hidden), the corner buttons on closed cards,
// and the Later view. Card animations and toasts stay in app.js; this module only holds state and DOM bits.
import { state, store, pool } from "./model.js";
import { featuresOf } from "./ranking.js";
import { el } from "./ui.js";
import { pendingNodes, linkForm } from "./share.js";

const stamp = () => new Date().toISOString();

export const isHidden = (id) => !!state.hidden[id] && !state.hidden[id].off;
// In Read later: an explicit (live) entry, or an item the pipeline marked "shared" that you haven't removed.
export const inLater = (item) => (state.later[item.id] ? !state.later[item.id].off : !!item.shared);

export function setLater(id, on) {
  state.later[id] = on ? { at: stamp() } : { ...state.later[id], at: stamp(), off: true };
  store.set("later", state.later);
}
export function hideItem(item) {
  state.hidden[item.id] = { at: stamp(), f: featuresOf(item) };
  store.set("hidden", state.hidden);
}
export function unhideItem(id) {
  state.hidden[id] = { ...state.hidden[id], at: stamp(), off: true };
  store.set("hidden", state.hidden);
}

// Newest first: by when you put it there (shared items: when they arrived).
export function laterItems() {
  const when = (i) => state.later[i.id]?.at ?? `${i.added}T00:00:00`;
  return pool()
    .filter((i) => !state.read.has(i.id) && !isHidden(i.id) && inLater(i))
    .sort((a, b) => (when(b) < when(a) ? -1 : when(b) > when(a) ? 1 : 0));
}

const ICON_CLOCK = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
const ICON_CHECK = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const ICON_X = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

function cornerBtn(cls, icon, label, onClick) {
  const b = el("button", { type: "button", class: `corner-btn ${cls}`, "aria-label": label, title: label });
  b.innerHTML = icon;
  b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
  return b;
}

// Three small round buttons in a row on a closed card: ✓ read (without opening), ✕ read but less of this,
// 🕒 read later. inLaterView: the clock removes it from Later.
export function cornerButtons({ inLaterView, onRead, onLater, onHide }) {
  return el("div", { class: "corner" },
    cornerBtn("read", ICON_CHECK, "Mark as read", onRead),
    cornerBtn("hide", ICON_X, "Read — less of this", onHide),
    cornerBtn(inLaterView ? "later on" : "later", ICON_CLOCK, inLaterView ? "Remove from Read later" : "Read later", onLater));
}

// The Later view: add-a-link box, pending shares, then the items.
export function renderLater({ makeCard, empty }) {
  const items = laterItems();
  const nodes = [linkForm(), ...pendingNodes()];
  if (!items.length) nodes.push(empty("Nothing saved for later. Tap the clock on a card, or share a link to MyScroll."));
  nodes.push(...items.map((i) => makeCard(i)));
  return nodes;
}
