// Follow a story: state.follows[followId] = { at, title, query, topic, since }. The daily run adds updates
// (items with `follow` = followId). UI: a toggle in the open card and a list in Settings.
import { state, store, live, slugify } from "./model.js";
import { el } from "./ui.js";

const STOP = new Set(("the a an and or of for to in on at by with from as is are was were be been it its this that these those " +
  "how what why when who will new says say after over into than about out up not no your you our their his her " +
  "has have had can could would should more most just than still now year years ago month months " +
  "de da do das dos e o os um uma para por com em no na nos nas que").split(" "));

export function keywordsOf(title) {
  const words = title.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
  return [...new Set(words)].slice(0, 6).join(" ");
}

export const followIdOf = (item) => item.follow ?? slugify(item.title);
export const isFollowing = (item) => { const f = state.follows[followIdOf(item)]; return !!f && !f.off; };
export const canFollow = (item) => item.kind === "news" || !!item.follow;
export const followTitle = (item) => state.follows[item.follow]?.title ?? "story";

export function setFollow(item, on) {
  const id = followIdOf(item);
  const at = new Date().toISOString();
  if (on) {
    state.follows[id] = { at, title: item.title, query: keywordsOf(item.title), topic: item.topic, since: at.slice(0, 10) };
  } else {
    state.follows[id] = { ...state.follows[id], at, off: true };
  }
  store.set("follows", state.follows);
}

// "🔔 Follow" / "🔔 Following" toggle for the card's actions row.
export function followButton(item) {
  const btn = el("button", { class: "wide follow-btn" });
  const paint = () => {
    const on = isFollowing(item);
    btn.textContent = on ? "🔔 Following" : "🔔 Follow";
    btn.setAttribute("aria-pressed", String(on));
  };
  btn.onclick = () => { setFollow(item, !isFollowing(item)); paint(); };
  paint();
  return btn;
}

// Settings → followed stories.
export function followedSection(rerender) {
  const list = live(state.follows).sort((a, b) => (b[1].at > a[1].at ? 1 : -1));
  return el("section", { class: "set-section" },
    el("h3", {}, "Followed stories"),
    el("p", { class: "set-hint" }, list.length
      ? "The daily edition looks for updates on these."
      : "Nothing followed yet. Open a news item and tap 🔔 Follow."),
    ...list.map(([id, f]) => el("div", { class: "row follow-row" },
      el("span", {}, f.title, el("small", { class: "follow-q" }, ` · ${f.query}`)),
      el("button", { class: "mini-btn", onclick: () => {
        state.follows[id] = { ...f, at: new Date().toISOString(), off: true };
        store.set("follows", state.follows);
        rerender();
      } }, "Unfollow"))));
}
