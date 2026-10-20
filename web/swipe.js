// Tinder-style swipe on closed cards: left = "less like this" (same as the ✕ button), right = "liked".
// Only horizontal gestures are taken over, so vertical scrolling and pull-to-shuffle keep working.
import { el } from "./ui.js";

const START = 12;       // px before we decide the gesture's direction
const COMMIT = 0.3;     // fraction of the card width
const FLICK = 0.6;      // px/ms
const MAX_TILT = 6;     // degrees
let active = false;

// True while a card is being dragged (app.js uses it to keep pull-to-shuffle quiet).
export const swiping = () => active;

// onLeft / onRight run after the card has slid off-screen.
export function attachSwipe(node, { onLeft, onRight }) {
  let g = null; // { x0, y0, t0, dx, v, w, tint }
  const settle = (x, rot, ms) => {
    node.style.transition = `transform ${ms}ms ease-out`;
    node.style.transform = `translateX(${x}px) rotate(${rot}deg)`;
  };
  const reset = (tint) => {
    node.style.transition = node.style.transform = node.style.willChange = "";
    tint.remove();
    document.body.classList.remove("swiping");
  };

  node.addEventListener("touchstart", (e) => {
    g = null;
    if (e.touches.length !== 1 || node.classList.contains("open") || node.classList.contains("leaving")) return;
    if (e.target.closest(".corner")) return;
    const t = e.touches[0];
    g = { x0: t.clientX, y0: t.clientY, t0: Date.now(), dx: 0, v: 0, w: node.offsetWidth, on: false, tint: null };
  }, { passive: true });

  node.addEventListener("touchmove", (e) => {
    if (!g) return;
    const t = e.touches[0];
    const dx = t.clientX - g.x0;
    const dy = t.clientY - g.y0;
    if (!g.on) {
      if (Math.abs(dy) > START && Math.abs(dy) > Math.abs(dx)) { g = null; return; } // it's a scroll
      if (Math.abs(dx) <= START || Math.abs(dx) <= 1.5 * Math.abs(dy)) return;
      g.on = active = true;
      g.tint = el("div", { class: "swipe-tint" }, el("span", { class: "swipe-badge" }));
      node.append(g.tint);
      node.style.willChange = "transform";
      document.body.classList.add("swiping");
    }
    if (e.cancelable) e.preventDefault();
    const now = Date.now();
    g.v = (dx - g.dx) / Math.max(1, now - g.t0); // speed over the last move, px/ms
    g.t0 = now;
    g.dx = dx;
    const p = Math.min(1, Math.abs(dx) / (g.w * COMMIT));
    const left = dx < 0;
    g.tint.classList.toggle("left", left);
    g.tint.classList.toggle("right", !left);
    g.tint.firstChild.textContent = left ? "✕ Less like this" : "♥ Liked";
    g.tint.style.opacity = String(Math.min(1, 0.15 + p * 0.85));
    node.style.transition = "none";
    node.style.transform = `translateX(${dx}px) rotate(${Math.max(-1, Math.min(1, dx / g.w)) * MAX_TILT}deg)`;
  }, { passive: false });

  const end = (cancelled) => {
    const s = g;
    g = null;
    if (!s?.on) return;
    active = false;
    // The click that follows a touch must not open the card.
    const stop = (e) => { e.stopPropagation(); e.preventDefault(); };
    node.addEventListener("click", stop, { capture: true, once: true });
    setTimeout(() => node.removeEventListener("click", stop, { capture: true }), 400);
    const far = Math.abs(s.dx) > s.w * COMMIT || (Math.abs(s.v) > FLICK && Math.abs(s.dx) > 60 && Math.sign(s.v) === Math.sign(s.dx));
    if (cancelled || !far) {
      settle(0, 0, 200);
      setTimeout(() => reset(s.tint), 220);
      s.tint.style.opacity = "0";
      return;
    }
    const dir = Math.sign(s.dx);
    s.tint.style.opacity = "1";
    settle(dir * (s.w + 80), dir * MAX_TILT, 220);
    setTimeout(() => document.body.classList.remove("swiping"), 700);
    setTimeout(() => (dir < 0 ? onLeft : onRight)(), 230);
  };
  node.addEventListener("touchend", () => end(false));
  node.addEventListener("touchcancel", () => end(true));
}
