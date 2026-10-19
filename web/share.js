// Share to MyScroll: links shared from other apps (Android ShareIn plugin) or pasted in the Later view are sent
// to the pipeline (loadMore with { url }); the resulting item (shared: true) shows up in Read later.
import { pool } from "./model.js";
import { loadMore } from "./loadmore.js";
import { el } from "./ui.js";

const KEY = "myscroll:sharePending"; // local only: [{ url, at, status: "sending"|"done"|"error", error? }]
const read = () => { try { return JSON.parse(localStorage.getItem(KEY)) ?? []; } catch { return []; } };
const write = (list) => { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch {} };
const inflight = new Set();
const notes = new Map(); // url -> latest progress text
let hooks = { toast() {}, reload: async () => {}, showLater() {}, refresh() {} };

export function extractUrl(text) {
  const m = String(text ?? "").match(/https?:\/\/[^\s<>"']+/i);
  return m ? m[0].replace(/[).,;:!?\]]+$/, "") : null;
}

const arrived = (url) => pool().some((i) => i.shared && i.source?.url === url);

// Set up once at boot. hooks: { toast(text), reload(): Promise, showLater(), refresh() }
export function initShare(h) {
  hooks = { ...hooks, ...h };
  const plugin = window.Capacitor?.Plugins?.ShareIn;
  if (!plugin) return;
  try {
    plugin.getPending?.().then((r) => { if (r?.text) sendLink(r.text); }).catch(() => {});
    plugin.addListener?.("share", (e) => sendLink(e?.text));
  } catch {}
}

export async function sendLink(text) {
  const url = extractUrl(text);
  if (!url) { hooks.toast("No link found in what you shared"); return false; }
  if (inflight.has(url)) return true;
  write([{ url, at: Date.now(), status: "sending" }, ...read().filter((p) => p.url !== url)]);
  hooks.toast("Sending to MyScroll… it'll appear in Read later");
  hooks.showLater();
  inflight.add(url);
  try {
    await loadMore((t) => {
      notes.set(url, t);
      const n = document.querySelector(`[data-pending="${CSS.escape(url)}"] .pnote`);
      if (n) n.textContent = t;
    }, { url });
    update(url, { status: "done" });
    await hooks.reload(); // re-renders; the new item is in Later if it arrived
  } catch (err) {
    update(url, { status: "error", error: err.message });
  } finally {
    inflight.delete(url);
    notes.delete(url);
    hooks.refresh();
  }
  return true;
}

function update(url, patch) { write(read().map((p) => (p.url === url ? { ...p, ...patch } : p))); }
function drop(url) { write(read().filter((p) => p.url !== url)); hooks.refresh(); }

// Shares still on their way (items that arrived, or older than a day, are forgotten).
function pending() {
  const keep = read().filter((p) => Date.now() - p.at < 864e5 && !arrived(p.url));
  if (keep.length !== read().length) write(keep);
  return keep;
}

export function pendingNodes() {
  return pending().map((p) => {
    const busy = inflight.has(p.url);
    const text = busy ? (notes.get(p.url) ?? "Sending…")
      : p.status === "error" ? p.error
      : p.status === "done" ? "Sent. If nothing shows up, the page may not be readable."
      : "Waiting for the agent. It will show up here when ready.";
    return el("div", { class: "pending" + (p.status === "error" && !busy ? " error" : ""), "data-pending": p.url },
      el("p", { class: "ptitle" }, `🔗 ${p.url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 60)}`),
      el("p", { class: "pnote" }, text),
      busy ? null : el("div", { class: "pbtns" },
        p.status === "error" ? el("button", { onclick: () => sendLink(p.url) }, "Try again") : null,
        el("button", { onclick: () => drop(p.url) }, "Dismiss")));
  });
}

// "+ Add a link": the same thing as sharing from another app, for the browser.
export function linkForm() {
  const input = el("input", { type: "url", placeholder: "Paste a link…", "aria-label": "Link to add", autocomplete: "off" });
  const go = () => { const v = input.value; if (!v.trim()) return; input.value = ""; sendLink(v); };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  return el("div", { class: "link-form" }, input, el("button", { onclick: go }, "+ Add a link"));
}
