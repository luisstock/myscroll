// Inside an open card: "Explain more" / "Context" / "ELI5" (answers from the item's own text) and
// "PT" (reads the whole card in European Portuguese). Answers and translations are cached locally.
import { el, $ } from "./ui.js";
import { askJSON, local } from "./ai.js";
import { state, readerProfile } from "./model.js";

const MODES = {
  explain: { label: "Explain more", task: "Explain this item in more depth: unpack the key idea, how it works and why it matters." },
  context: { label: "Context", task: "Give context: where this fits, what came before, who and what is involved. You may add general background knowledge, but mark it clearly by starting that part with \"Background (not from the text):\"." },
  eli5: { label: "ELI5", task: "Explain it like I'm five: very simple words, short sentences, one friendly everyday analogy." },
};

const askSystem = () => `You are a calm reading companion inside a personal reading app. ${readerProfile(state.settings)}
Answer ONLY from the SOURCE TEXT you are given. If the text doesn't cover what is needed, say so plainly instead of guessing.
Write 80 to 200 words of plain prose in British English. No markdown, no headings, no bullet lists. Short paragraphs separated by a blank line.`;

const ASK_SCHEMA = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] };

const PT_SYSTEM = `You translate reading-app content into European Portuguese (Portugal, NOT Brazilian): use Portugal vocabulary and spelling (ecrã, telemóvel, equipa, comboio, utilizador, "a fazer" not "fazendo").
Keep proper nouns, product and software names, numbers, units and code unchanged. Keep the tone and length of each text.
Return JSON { "texts": [...] } with EXACTLY the same number of strings, in the same order. Never merge, drop or reorder them.`;

const PT_SCHEMA = { type: "object", properties: { texts: { type: "array", items: { type: "string" } } }, required: ["texts"] };

// ---------- cache ----------
const CACHE_KEY = "asks";
const cacheGet = (k) => local.get(CACHE_KEY, {})[k];
function cacheSet(k, v) {
  const all = local.get(CACHE_KEY, {});
  all[k] = { ...v, at: Date.now() };
  const keys = Object.keys(all);
  if (keys.length > 150) for (const old of keys.sort((a, b) => all[a].at - all[b].at).slice(0, keys.length - 150)) delete all[old];
  local.set(CACHE_KEY, all);
}

// ---------- source text ----------
const paras = (x) => (Array.isArray(x) ? x : x ? [x] : []);

function sourceText(item) {
  const parts = [`TITLE: ${item.title}`, `SUMMARY: ${item.snippet}`, ...paras(item.body), ...paras(item.more)];
  if (item.book) {
    parts.push(`BOOK: ${item.book.title} by ${item.book.author}`);
    item.book.lessons.forEach((l, i) => parts.push(`LESSON ${i + 1}: ${l.title}. ${l.text}`));
    if (item.book.takeaway) parts.push(`TRY THIS: ${item.book.takeaway}`);
  }
  return parts.join("\n\n").slice(0, 14000);
}

const answerParas = (text) => String(text).split(/\n{2,}/).map((t) => t.trim()).filter(Boolean).map((t) => el("p", {}, t));

// opts: { trackReading(), openSettingsAI() }
export function setupAsk(node, item, opts = {}) {
  node.querySelector(".ask-wrap")?.remove();
  const grew = () => setTimeout(() => opts.trackReading?.(), 50);
  restoreHead(node, item); // a card closed while in Portuguese keeps its header text: put English back

  const box = el("div", { class: "ask-box", hidden: true, "aria-live": "polite" });
  const buttons = {};
  let current = null;

  const showError = (err) => {
    box.classList.add("error");
    box.replaceChildren(el("p", {}, err.message),
      err.needsSetup && opts.openSettingsAI ? el("button", { class: "setup-link", onclick: opts.openSettingsAI }, "Open Settings → AI →") : null);
  };

  async function ask(mode) {
    current = mode;
    for (const [m, b] of Object.entries(buttons)) b.setAttribute("aria-pressed", String(m === mode));
    box.hidden = false;
    box.classList.remove("error");
    const key = `${item.id}|${mode}`;
    const hit = cacheGet(key);
    if (hit) { box.replaceChildren(el("p", { class: "ask-label" }, MODES[mode].label), ...answerParas(hit.text)); grew(); return; }
    box.replaceChildren(el("p", { class: "ask-loading" }, "Thinking…"));
    grew();
    Object.values(buttons).forEach((b) => (b.disabled = true));
    try {
      const out = await askJSON({
        system: askSystem(),
        prompt: `${MODES[mode].task}\n\nSOURCE TEXT:\n${sourceText(item)}`,
        schema: ASK_SCHEMA,
      });
      const text = String(out.answer ?? "").trim();
      if (!text) throw new Error("The answer came back empty. Try again.");
      cacheSet(key, { text });
      if (current === mode) box.replaceChildren(el("p", { class: "ask-label" }, MODES[mode].label), ...answerParas(text));
    } catch (err) {
      if (current === mode) showError(err);
    } finally {
      Object.values(buttons).forEach((b) => (b.disabled = false));
      grew();
    }
  }

  const row = el("div", { class: "ask-row" },
    ...Object.entries(MODES).map(([mode, m]) => (buttons[mode] = el("button", { class: "ask-btn", "aria-pressed": "false", onclick: () => ask(mode) }, m.label))));

  const wrap = el("div", { class: "ask-wrap" }, el("p", { class: "ask-title" }, "Ask about this"), row, box);
  if (item.lang !== "pt") row.append(ptButton(node, item, { grew, showError: (e) => { box.hidden = false; showError(e); grew(); } }));
  const anchor = $(".more", node);
  anchor.after(wrap);
}

// ---------- Read in Portuguese ----------
// While a card is in Portuguese we remember the English header text (by item id), so reopening the card
// (which rebuilds the body in English) can put the header back too.
const inPortuguese = new Map(); // id -> { title, snippet }

function restoreHead(node, item) {
  const saved = inPortuguese.get(item.id);
  if (!saved) return;
  $(".title", node).textContent = saved.title;
  $(".snippet", node).textContent = saved.snippet;
  node.lang = item.lang || "en";
  inPortuguese.delete(item.id);
}

// Every piece of text on the card that gets translated, in a stable order: { get(), set(text) }.
function targets(node, item) {
  const list = [];
  const text = (n) => ({ get: () => n.textContent, set: (v) => { n.textContent = v; } });
  list.push(text($(".title", node)), text($(".snippet", node)));
  node.querySelectorAll(".card-body > .prose:not(.more) p").forEach((p) => list.push(text(p)));
  const more = $(".more", node);
  if (!more.hidden) {
    more.querySelectorAll(":scope > p:not(.more-from):not(.more-error), :scope > h4").forEach((n) => list.push(text(n)));
    more.querySelectorAll(":scope > blockquote").forEach((q) => { const t = q.firstChild; if (t?.nodeType === 3) list.push({ get: () => t.data, set: (v) => { t.data = v; } }); });
  }
  node.querySelectorAll(".lesson").forEach((l) => l.querySelectorAll("h4, p").forEach((n) => {
    if (n.classList.contains("lesson-n")) return;
    list.push(text(n));
  }));
  return list;
}

function ptButton(node, item, { grew, showError }) {
  let originals = null; // English texts (and the nodes they came from) while Portuguese is shown
  let busy = false;
  const btn = el("button", { class: "ask-btn pt-btn", "aria-pressed": "false", title: "Read this card in European Portuguese", onclick: async () => {
    if (busy) return;
    const list = targets(node, item);
    if (originals) { // back to English
      originals.forEach(({ target, text }) => target.set(text));
      originals = null;
      inPortuguese.delete(item.id);
      node.lang = item.lang || "en";
      btn.textContent = "PT";
      btn.setAttribute("aria-pressed", "false");
      grew();
      return;
    }
    const english = list.map((t) => t.get());
    const key = `${item.id}|pt|${english.length}`;
    let texts = cacheGet(key)?.texts;
    if (!texts) {
      busy = true;
      btn.disabled = true;
      btn.textContent = "Translating…";
      try {
        const out = await askJSON({
          system: PT_SYSTEM,
          prompt: `Translate these ${english.length} texts (a title, a summary, then the body paragraphs${item.book ? " and book lessons" : ""}) into European Portuguese:\n${JSON.stringify(english)}`,
          schema: PT_SCHEMA,
        });
        texts = out.texts;
        if (!Array.isArray(texts) || texts.length !== english.length) throw new Error("The translation came back incomplete. Try again.");
        cacheSet(key, { texts });
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "PT";
        busy = false;
        showError(err);
        return;
      }
      busy = false;
      btn.disabled = false;
    }
    originals = list.map((target, i) => ({ target, text: english[i] }));
    inPortuguese.set(item.id, { title: english[0], snippet: english[1] });
    texts.forEach((t, i) => list[i]?.set(t));
    node.lang = "pt";
    btn.textContent = "EN";
    btn.setAttribute("aria-pressed", "true");
    grew();
  } }, "PT");
  return btn;
}
