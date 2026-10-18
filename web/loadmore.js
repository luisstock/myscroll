// "Load more": asks the pipeline to research a few more items right now and append them to today.
// On the PC it talks to the local server (/api/run). Elsewhere it triggers the GitHub Actions workflow.
import { state, store } from "./model.js";
import { isLocalDev, getJSON } from "./env.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The GitHub token lives under its own key so it is never synced to data/state.json.
export const github = {
  get: () => store.get("github", { repo: "", token: "" }),
  set: (v) => { try { localStorage.setItem("myscroll:github", JSON.stringify(v)); } catch {} },
};

async function localServer() {
  if (!isLocalDev) return false;
  try {
    const r = await fetch("/api/run", { cache: "no-store" });
    return r.ok && (await r.json()) && true;
  } catch { return false; }
}

// Runs the request and reports progress through onStatus(text). Resolves when new items should be there.
// topics: ids to research (null = all active topics).
export async function loadMore(onStatus, topics = null) {
  const n = state.settings.loadMoreCount ?? 15;
  const only = topics?.length ? topics.join(",") : "";
  if (await localServer()) {
    const start = await fetch(`/api/run?more=${n}${only ? `&topics=${encodeURIComponent(only)}` : ""}`, { method: "POST" });
    if (start.status !== 202 && start.status !== 409) throw new Error(`Couldn't start (${start.status})`);
    onStatus("Researching your sources…");
    for (;;) {
      await sleep(3000);
      const s = await fetch("/api/run", { cache: "no-store" }).then((r) => r.json());
      if (s.last) onStatus(s.last.replace(/^\[\s*\d+s\]\s*/, "").slice(0, 90));
      if (!s.running) {
        if (s.code !== 0) throw new Error(s.last || "The run failed");
        return;
      }
    }
  }

  const { repo, token } = github.get();
  if (!repo || !token) {
    const err = new Error("Connect GitHub first: it takes a minute, once.");
    err.needsSetup = true;
    throw err;
  }
  // Every request still being worked on is remembered (survives closing the app). A new request that's
  // identical to one of them is not sent again: we just keep waiting for that one.
  const key = `${n}|${only}`;
  const active = activeRequests();
  const same = active.find((p) => p.key === key);
  if (same) {
    onStatus("Already on it: waiting for the same request you made earlier…");
    return waitForNewItems(onStatus, same);
  }

  const before = await todaysCount();
  const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/daily.yml/dispatches`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    body: JSON.stringify({ ref: "main", inputs: { more: String(n), topics: only } }),
  });
  if (res.status === 403 || res.status === 404) {
    const err = new Error("Your GitHub token can't start the agent yet: edit it on GitHub and set “Actions” to Read and write (same token, nothing to change here).");
    err.needsSetup = true;
    throw err;
  }
  if (res.status === 401) throw Object.assign(new Error("GitHub doesn't accept this token any more (expired or deleted). Create a new one and paste it in Sync settings."), { needsSetup: true });
  if (res.status !== 204) throw new Error(`GitHub said ${res.status}. Try again in a minute.`);
  const request = { key, at: Date.now(), before };
  saveRequests([...active, request]);
  onStatus(active.length ? `Queued after ${active.length} earlier request${active.length > 1 ? "s" : ""}. This takes a few minutes…` : "Asked GitHub to research more. This takes a few minutes…");
  return waitForNewItems(onStatus, request);
}

const MAX_WAIT = 30 * 60000;
const activeRequests = () => store.get("loadMoreRequests", []).filter((p) => Date.now() - p.at < MAX_WAIT);
const saveRequests = (list) => { try { localStorage.setItem("myscroll:loadMoreRequests", JSON.stringify(list)); } catch {} };

// Wait until today's edition grows past what it had when this request was sent, then forget the request.
async function waitForNewItems(onStatus, request) {
  const finish = () => saveRequests(activeRequests().filter((p) => p.key !== request.key));
  while (Date.now() - request.at < MAX_WAIT) {
    await sleep(20000);
    if ((await todaysCount()) > request.before) { finish(); return; }
    onStatus(`Still researching… (${Math.round((Date.now() - request.at) / 60000)} min)`);
  }
  finish();
  throw new Error("It's taking longer than usual. New items will appear next time you open the app.");
}

async function todaysCount() {
  try {
    const idx = await getJSON("editions/index.json");
    const ed = await getJSON(`editions/${idx.latest}.json`);
    return ed.items.length + (idx.latest !== state.latest ? 1000 : 0);
  } catch { return 0; }
}
