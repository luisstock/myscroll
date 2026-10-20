// Keeps the reader's state (ratings, read, opened, saved, skips, settings) in the GitHub repo
// at data/state.json, so the daily agent learns from the phone and a reinstall restores everything.
// Needs the GitHub repo + token from Settings (fine-grained token: Contents read/write on that repo).
import { forSync } from "./localitems.js";
const PATH = "data/state.json";
const KEYS = ["settings", "ratings", "opened", "skips", "itemFeatures", "read", "saved",
  "later", "hidden", "readLog", "follows", "moodboard", "remember", "localItems"];
const prefix = "myscroll:";

const get = (k, fb) => { try { return JSON.parse(localStorage.getItem(prefix + k)) ?? fb; } catch { return fb; } };
const put = (k, v) => { try { localStorage.setItem(prefix + k, JSON.stringify(v)); } catch {} };

const github = () => get("github", { repo: "", token: "" });
export const syncConfigured = () => { const g = github(); return !!(g.repo && g.token); };
const meta = () => get("syncMeta", { dirty: false, lastSyncedAt: null, sha: null, lastError: null });
const setMeta = (m) => put("syncMeta", { ...meta(), ...m });
export const syncStatus = () => meta();

function api(path, init = {}) {
  const { repo, token } = github();
  return fetch(`https://api.github.com/repos/${repo}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(init.headers ?? {}) },
    cache: "no-store",
  });
}

const toB64 = (text) => { const bytes = new TextEncoder().encode(text); let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
const fromB64 = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\n/g, "")), (c) => c.charCodeAt(0)));

async function readRemote() {
  const res = await api(`contents/${PATH}`);
  if (res.status === 404) return { state: null, sha: null };
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  const file = await res.json();
  return { state: JSON.parse(fromB64(file.content)), sha: file.sha };
}

function localState() {
  const s = { updatedAt: new Date().toISOString(), device: "app" };
  for (const k of KEYS) s[k] = get(k, null);
  if (s.localItems) s.localItems = forSync(s.localItems); // pruned + slimmed: data/state.json must stay small
  return s;
}

// Union of both sides; for ratings the most recent one wins; settings stay local.
export function merge(local, remote) {
  const union = (a, b) => [...new Set([...(a ?? []), ...(b ?? [])])];
  const ratings = { ...(remote.ratings ?? {}) };
  for (const [id, r] of Object.entries(local.ratings ?? {})) {
    if (!ratings[id] || new Date(r.at) >= new Date(ratings[id].at)) ratings[id] = r;
  }
  const skips = { ...(remote.skips ?? {}) };
  for (const [id, n] of Object.entries(local.skips ?? {})) skips[id] = Math.max(n, skips[id] ?? 0);
  // Maps of id -> { at, ... }: the most recent entry wins (so "off: true" removals carry over too).
  const latest = (a = {}, b = {}) => {
    const out = { ...b };
    for (const [id, v] of Object.entries(a)) if (!out[id] || new Date(v?.at ?? 0) >= new Date(out[id]?.at ?? 0)) out[id] = v;
    return out;
  };
  return {
    settings: local.settings ?? remote.settings,
    later: latest(local.later, remote.later),
    hidden: latest(local.hidden, remote.hidden),
    readLog: latest(local.readLog, remote.readLog),
    follows: latest(local.follows, remote.follows),
    moodboard: latest(local.moodboard, remote.moodboard),
    remember: latest(local.remember, remote.remember),
    localItems: forSync(latest(local.localItems, remote.localItems)), // written-on-device items (Fast Load more, AI books)
    ratings, skips,
    itemFeatures: { ...(remote.itemFeatures ?? {}), ...(local.itemFeatures ?? {}) },
    read: union(local.read, remote.read),
    opened: union(local.opened, remote.opened),
    saved: union(local.saved, remote.saved),
  };
}

// On app start: bring in the repo's state. Returns true if local state changed (caller re-renders).
export async function pullState() {
  if (!syncConfigured()) return false;
  try {
    const { state: remote, sha } = await readRemote();
    setMeta({ sha, lastError: null });
    if (!remote) { markDirty(); return false; }
    const m = meta();
    const remoteNewer = !m.lastSyncedAt || new Date(remote.updatedAt) > new Date(m.lastSyncedAt);
    if (!remoteNewer) { if (m.dirty) pushState(); return false; } // leftovers from last time: send them now
    const next = m.dirty ? merge(localState(), remote) : remote; // fresh install / other device: take the repo's
    for (const k of KEYS) if (next[k] != null) put(k, next[k]);
    if (m.dirty) await pushState(); else setMeta({ lastSyncedAt: remote.updatedAt });
    return true;
  } catch (e) {
    setMeta({ lastError: e.message });
    return false;
  }
}

let timer;
export function markDirty() {
  if (!syncConfigured()) return;
  setMeta({ dirty: true });
  clearTimeout(timer);
  timer = setTimeout(pushState, 15000); // batch a few ratings together
}

let pushing = null;
export function pushState() {
  if (!syncConfigured() || !meta().dirty) return Promise.resolve();
  clearTimeout(timer);
  pushing ??= (async () => {
    try {
      const body = localState();
      for (let attempt = 0; attempt < 2; attempt++) {
        let { sha } = meta();
        if (!sha) sha = (await readRemote()).sha;
        const res = await api(`contents/${PATH}`, {
          method: "PUT",
          body: JSON.stringify({ message: "Sync reading state from the app", content: toB64(JSON.stringify(body, null, 1)), ...(sha ? { sha } : {}) }),
        });
        if (res.status === 409 || res.status === 422) { setMeta({ sha: null }); continue; } // file changed meanwhile: refetch sha
        if (!res.ok) throw new Error(`GitHub ${res.status}`);
        const out = await res.json();
        setMeta({ sha: out.content.sha, dirty: false, lastSyncedAt: body.updatedAt, lastError: null });
        return;
      }
    } catch (e) {
      setMeta({ lastError: e.message });
    } finally {
      pushing = null;
    }
  })();
  return pushing;
}

// Send pending changes when the app goes to the background.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") pushState(); });
}
