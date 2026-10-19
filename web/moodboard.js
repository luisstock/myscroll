// Motion moodboard: pin images / video thumbnails from Motion & Design items, browse them as a grid.
// state.moodboard: key -> { at, src, kind: "image"|"video", itemId, title, topic, url, source, videoId, off? } (synced).
// Everything needed to show a pin is stored in the entry, because the item may leave the edition pool.
import { el } from "./ui.js";
import { dataUrl } from "./env.js";

const ytThumb = (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

// ctx: { state, store, live, topicOf(id), onChange() }
const eligible = (item, ctx) => {
  const media = item.image?.src || item.video?.id;
  return !!media && (["motion", "design"].includes(item.topic) || ctx.topicOf(item.topic)?.group === "work");
};

// A 📌 button over the hero image / video of the open card.
export function setupPin(node, item, ctx) {
  const hero = node.querySelector(".hero");
  hero?.querySelector(".pin-btn")?.remove();
  if (!hero || hero.childElementCount === 0 || !eligible(item, ctx)) return;
  const key = item.id;
  const on = () => { const e = ctx.state.moodboard[key]; return !!e && !e.off; };
  const btn = el("button", { class: "pin-btn", "aria-label": "Pin to Moodboard", title: "Pin to Moodboard", onclick: (e) => {
    e.stopPropagation();
    if (on()) ctx.state.moodboard[key] = { ...ctx.state.moodboard[key], off: true, at: new Date().toISOString() };
    else {
      const video = item.video?.provider === "youtube" ? item.video.id : null;
      ctx.state.moodboard[key] = {
        at: new Date().toISOString(),
        src: video ? ytThumb(video) : item.image.src,
        kind: video ? "video" : "image",
        itemId: item.id, title: item.title, topic: item.topic,
        url: video ? `https://www.youtube.com/watch?v=${video}` : item.source?.url, source: item.source?.name,
        ...(video ? { videoId: video } : {}),
      };
    }
    ctx.store.set("moodboard", ctx.state.moodboard);
    paint();
    ctx.onChange?.();
  } }, "📌");
  const paint = () => { btn.setAttribute("aria-pressed", String(on())); btn.title = on() ? "Pinned: tap to unpin" : "Pin to Moodboard"; };
  paint();
  hero.append(btn);
}

// The Moodboard view: renders into `root`.
export function renderMoodboard(root, ctx) {
  const pins = ctx.live(ctx.state.moodboard).sort((a, b) => b[1].at.localeCompare(a[1].at));
  const remove = (key) => {
    ctx.state.moodboard[key] = { ...ctx.state.moodboard[key], off: true, at: new Date().toISOString() };
    ctx.store.set("moodboard", ctx.state.moodboard);
    ctx.onChange?.();
    renderMoodboard(root, ctx);
  };
  const tile = ([key, p]) => {
    let timer, fired = false;
    const cancel = () => clearTimeout(timer);
    const img = el("img", { src: p.kind === "image" ? dataUrl(p.src) : p.src, alt: p.title, loading: "lazy" });
    const open = el("button", {
      class: "mb-open", "aria-label": `Open ${p.title}`,
      onclick: () => { if (fired) fired = false; else openLightbox(p, () => remove(key)); },
      onpointerdown: () => { timer = setTimeout(() => { fired = true; if (confirm("Remove this from your Moodboard?")) remove(key); }, 650); },
      onpointerup: cancel, onpointerleave: cancel, onpointercancel: cancel,
      oncontextmenu: (e) => e.preventDefault(),
    }, img, p.kind === "video" ? el("span", { class: "mb-play", "aria-hidden": "true" }, "▶") : null);
    return el("figure", { class: "mb-tile" }, open,
      el("button", { class: "mb-x", "aria-label": "Remove from Moodboard", onclick: () => remove(key) }, "✕"));
  };
  root.replaceChildren(el("div", { class: "moodboard" },
    el("div", { class: "mb-head" },
      el("h2", {}, "📌 Moodboard"),
      el("p", {}, pins.length ? `${pins.length} pinned. Tap one to see it bigger; long-press or ✕ to remove.` : "Nothing pinned yet. Open a Motion or Design item and tap 📌 on its image.")),
    pins.length ? el("div", { class: "mb-grid" }, pins.map(tile)) : null));
}

function openLightbox(p, onRemove) {
  const close = () => { box.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  const box = el("div", { class: "lightbox", role: "dialog", "aria-label": p.title },
    el("div", { class: "sheet-backdrop", onclick: close }),
    el("figure", { class: "lb-fig" },
      el("img", { src: p.kind === "image" ? dataUrl(p.src) : p.src, alt: p.title }),
      el("figcaption", {},
        el("strong", {}, p.title),
        el("div", { class: "lb-links" },
          p.url ? el("a", { href: p.url, target: "_blank", rel: "noopener" }, p.kind === "video" ? "Watch on YouTube ↗" : `${p.source ?? "Source"} ↗`) : null,
          el("button", { onclick: () => { close(); onRemove(); } }, "Remove"),
          el("button", { onclick: close }, "Close")))));
  document.body.append(box);
  document.addEventListener("keydown", onKey);
}
