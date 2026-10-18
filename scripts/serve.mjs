// Tiny static server for testing the app in the browser: node scripts/serve.mjs [port]
// Also serves /api/fetch?url=… so "Read more" can load source pages despite CORS.
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
const port = Number(process.argv[2] ?? 5173);
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const BROWSER_UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";

async function proxy(req, res) {
  let target;
  try { target = new URL(new URL(req.url, "http://x").searchParams.get("url")); } catch { return res.writeHead(400).end("bad url"); }
  if (!/^https?:$/.test(target.protocol)) return res.writeHead(400).end("http(s) only");
  try {
    const r = await fetch(target, { headers: { "User-Agent": BROWSER_UA, Accept: "text/html,application/json;q=0.9,*/*;q=0.8" }, redirect: "follow", signal: AbortSignal.timeout(15000) });
    const body = (await r.text()).slice(0, 3_000_000);
    res.writeHead(r.ok ? 200 : r.status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }).end(body);
  } catch (e) {
    res.writeHead(502).end(String(e.message));
  }
}

// The app PUTs the user's state here; the daily agent reads data/state.json.
const statePath = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "state.json");
async function saveState(req, res) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 5_000_000) return res.writeHead(413).end();
  }
  try { JSON.parse(body); } catch { return res.writeHead(400).end("bad json"); }
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, body);
  res.writeHead(204).end();
}

// "Load more": run the pipeline now (one run at a time) and report progress.
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let job = null; // { startedAt, log: [], done, code }
function startRun(req, res) {
  if (job && !job.done) return json(res, 409, status());
  const params = new URL(req.url, "http://x").searchParams;
  const n = Math.min(40, Math.max(3, Number(params.get("more")) || 15));
  const topics = (params.get("topics") ?? "").split(",").filter((t) => /^[a-z0-9-]{1,40}$/.test(t));
  job = { startedAt: new Date().toISOString(), log: [], done: false, code: null, more: n, topics };
  const args = [join(projectRoot, "scripts", "pipeline", "run.mjs"), "--more", String(n), ...(topics.length ? ["--topics", topics.join(",")] : [])];
  const child = spawn(process.execPath, args, { cwd: projectRoot, env: process.env });
  const onData = (d) => { for (const line of String(d).split("\n")) if (line.trim()) job.log.push(line); job.log = job.log.slice(-40); };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("close", (code) => { job.done = true; job.code = code; job.finishedAt = new Date().toISOString(); });
  json(res, 202, status());
}
const status = () => (job ? { running: !job.done, startedAt: job.startedAt, finishedAt: job.finishedAt ?? null, code: job.code, last: job.log.at(-1) ?? "", log: job.log } : { running: false });
const json = (res, code, body) => res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body));

createServer(async (req, res) => {
  if (req.url.startsWith("/api/fetch")) return proxy(req, res);
  if (req.url.startsWith("/api/run")) return req.method === "POST" ? startRun(req, res) : json(res, 200, status());
  if (req.url === "/api/state" && req.method === "PUT") return saveState(req, res);
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^([\\/]\.\.)+/, "");
  const file = join(webRoot, path.endsWith("/") || path === "\\" ? "index.html" : path);
  try {
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    res.end(data);
  } catch {
    res.writeHead(404).end("Not found");
  }
}).listen(port, () => console.log(`MyScroll em http://localhost:${port}`));
