// AI client for the app: askJSON({ system, prompt, schema }) -> parsed JSON object.
//  - Local dev server: POST /api/llm (uses the server's GEMINI_API_KEY).
//  - Phone / GitHub Pages: Gemini REST directly, with the key the user pasted in Settings → AI.
// The key lives only in localStorage under "myscroll:gemini" and is never synced.
import { isLocalDev } from "./env.js";
import { el } from "./ui.js";

// Same models as the daily pipeline (myscroll.config.json: models.gemini + fallbackModels.gemini).
const MODELS = ["gemini-3.8-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"];
const FAST_MODELS = ["gemini-3.5-flash-lite", "gemini-3.8-flash"]; // lite answers in ~5 s, 3.8 can take a minute

const readLocal = (k, fb) => { try { return JSON.parse(localStorage.getItem("myscroll:" + k)) ?? fb; } catch { return fb; } };
const writeLocal = (k, v) => { try { localStorage.setItem("myscroll:" + k, JSON.stringify(v)); } catch {} };

// Small local-only cache (answers, translations). Never synced.
export const local = { get: readLocal, set: writeLocal };

export const geminiKey = {
  get: () => readLocal("gemini", {}).key || "",
  set: (key) => writeLocal("gemini", { key: key.trim() }),
  clear: () => { try { localStorage.removeItem("myscroll:gemini"); } catch {} },
};

// Gemini's responseSchema is an OpenAPI subset: drop keywords it doesn't accept (mirrors scripts/pipeline/llm.mjs).
function geminiSchema(s) {
  if (Array.isArray(s)) return s.map(geminiSchema);
  if (!s || typeof s !== "object") return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (["additionalProperties", "$schema", "minLength", "maxLength", "pattern"].includes(k)) continue;
    out[k] = typeof v === "object" ? geminiSchema(v) : v;
  }
  return out;
}

function needsSetup() {
  return Object.assign(new Error("Add your Gemini key in Settings → AI (once)"), { needsSetup: true });
}

// The dev server may not have /api/llm or a GEMINI_API_KEY: then `serverUnavailable` lets us fall back to a pasted key.
async function viaServer(req) {
  let res;
  try { res = await fetch("/api/llm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req) }); }
  catch { throw Object.assign(new Error("The local server isn't answering."), { serverUnavailable: true }); }
  if (res.ok) return res.json();
  let detail = "";
  try { detail = (await res.json()).error ?? ""; } catch {}
  const err = new Error(detail || `The AI server answered ${res.status}.`);
  err.serverUnavailable = res.status === 404 || res.status === 405 || /GEMINI_API_KEY/.test(detail);
  throw err;
}

// JSON out of a free-text answer (Google Search grounding can't always be combined with a response schema).
function parseLooseJSON(text) {
  const t = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  try { return JSON.parse(t); } catch {}
  return JSON.parse(t.slice(t.search(/[[{]/), Math.max(t.lastIndexOf("}"), t.lastIndexOf("]")) + 1));
}

// search: Google Search grounding; the result is then { json, sources: [{ uri, title }] }.
async function viaGemini({ system, prompt, schema, search = false, fast = false }, key) {
  let last;
  let plain = false; // fell back to "JSON in the prompt" because the model refused schema + tools
  const models = fast ? FAST_MODELS : MODELS;
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    let res;
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: plain ? `${prompt}\n\nAnswer with JSON only, matching this JSON schema:\n${JSON.stringify(schema)}` : prompt }] }],
          ...(search ? { tools: [{ google_search: {} }] } : {}),
          generationConfig: {
            ...(plain ? {} : { responseMimeType: "application/json", responseSchema: geminiSchema(schema) }), temperature: 0.6,
            ...(model.startsWith("gemini-2.5") ? { thinkingConfig: { thinkingBudget: 0 } }
              : model.startsWith("gemini-3") ? { thinkingConfig: { thinkingLevel: "low" } } : {}),
          },
        }),
        signal: AbortSignal.timeout(search ? 120000 : 60000),
      });
    } catch (e) {
      last = new Error("Couldn't reach Gemini. Check your connection and try again.");
      continue;
    }
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      const text = await res.text();
      if (search && !plain && res.status === 400 && !/API key|API_KEY/i.test(text)) { plain = true; i--; continue; } // same model, JSON in the prompt
      if (/API key|API_KEY|permission|PERMISSION/i.test(text)) throw Object.assign(new Error("Gemini doesn't accept this key. Paste it again in Settings → AI."), { needsSetup: true });
      throw new Error(`Gemini ${res.status}: ${text.replace(/\s+/g, " ").slice(0, 160)}`);
    }
    if (!res.ok) { // busy, rate limited or model gone: try the next one
      last = new Error(res.status === 429 ? "Gemini is rate limited right now. Try again in a minute." : `Gemini ${model} answered ${res.status}.`);
      continue;
    }
    const data = await res.json();
    const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
    if (!text) { last = new Error("Gemini returned no text. Try again."); continue; }
    try {
      const json = plain ? parseLooseJSON(text) : JSON.parse(text);
      if (!search) return json;
      const sources = (data.candidates?.[0]?.groundingMetadata?.groundingChunks ?? []).map((c) => c.web).filter(Boolean);
      return { json, sources };
    } catch { last = new Error("Gemini's answer was cut off. Try again."); }
  }
  throw last ?? new Error("Gemini didn't answer.");
}

// Like askJSON, with Google Search grounding: -> { json, sources: [{ uri, title }] }.
export async function askSearch({ system, prompt, schema }) {
  const req = { system, prompt, schema, search: true };
  if (isLocalDev) {
    try { return await viaServer(req); }
    catch (e) {
      if (!e.serverUnavailable) throw e;
      const key = geminiKey.get();
      if (!key) throw needsSetup();
      return viaGemini(req, key);
    }
  }
  const key = geminiKey.get();
  if (!key) throw needsSetup();
  return viaGemini(req, key);
}

// Whether the fast (on-device) Gemini path can run here.
export const canUseAI = () => isLocalDev || !!geminiKey.get();

// fast: lite model first (seconds instead of a minute), for the fast Load more.
export async function askJSON({ system, prompt, schema, fast = false }) {
  const req = { system, prompt, schema, ...(fast ? { fast: true } : {}) };
  if (isLocalDev) {
    try { return await viaServer(req); }
    catch (e) {
      if (!e.serverUnavailable) throw e;
      const key = geminiKey.get();
      if (!key) throw needsSetup();
      return viaGemini(req, key);
    }
  }
  const key = geminiKey.get();
  if (!key) throw needsSetup();
  return viaGemini(req, key);
}

// ---------- Settings → AI ----------
// ctx: { rerender() }. The key is typed by the user, never shown back, never synced.
export function aiSection(ctx) {
  const saved = !!geminiKey.get();
  const input = el("input", { type: "password", placeholder: "Paste your Gemini API key", "aria-label": "Gemini API key", autocomplete: "off", spellcheck: "false" });
  return el("section", { class: "set-section ai-section" },
    el("h3", {}, "AI"),
    el("p", { class: "set-hint" }, "“Ask about this”, “Context”, “ELI5” and “PT” on an open item use Gemini. Get a free key at Google AI Studio and paste it here once. It stays on this device and is never synced."),
    saved
      ? el("div", { class: "row" }, el("span", {}, "•••• saved"),
          el("button", { class: "mini-btn", onclick: () => { geminiKey.clear(); ctx.rerender(); } }, "Remove"))
      : el("div", { class: "form-btns" }, input,
          el("button", { class: "mini-btn", onclick: () => { if (!input.value.trim()) return input.focus(); geminiKey.set(input.value); input.value = ""; ctx.rerender(); } }, "Save")),
    saved ? null : el("a", { class: "token-link", href: "https://aistudio.google.com/apikey", target: "_blank", rel: "noopener" }, "Get a key at Google AI Studio ↗"),
    isLocalDev ? el("p", { class: "set-hint" }, "On this PC the local server's own key is used when it has one.") : null);
}
