// Books, Deepstash style: Gemini suggests books for this reader, you pick one (or type any title) and it writes
// the book card: big idea, swipeable lessons, one thing to try. Items live with the fast local items.
import { state, pool, topicOf, slugify } from "./model.js";
import { askJSON, canUseAI, local } from "./ai.js";
import { addLocalItems } from "./fastmore.js";
import { el } from "./ui.js";

const norm = (t) => String(t ?? "").toLowerCase().replace(/^(the|a|an)\s+/, "").replace(/[^a-z0-9]+/g, " ").trim();
const subsOf = () => topicOf("books").subs ?? [];

// ---------- suggestions ----------
const SUGG_SCHEMA = {
  type: "object",
  properties: {
    books: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" }, author: { type: "string" }, year: { type: "integer" },
          hook: { type: "string", description: "one line: why THIS reader would like it" },
          sub: { type: "string" },
        },
        required: ["title", "author", "year", "hook", "sub"],
      },
    },
  },
  required: ["books"],
};

const have = () => pool().filter((i) => i.book);
const bookKey = (title) => norm(title);

function suggestPrompt() {
  const t = topicOf("books");
  const likes = [...state.profile.entries()].filter(([, e]) => e.affinity > 0.15).sort((a, b) => b[1].affinity - a[1].affinity)
    .slice(0, 12).map(([f]) => f.split(":")[1]);
  const rated = (test) => pool().filter((i) => i.book && test(state.ratings[i.id]?.r)).map((i) => `${i.book.title} (${i.book.author})`);
  const loved = rated((r) => r >= 4), disliked = rated((r) => r != null && r <= 2);
  const mine = have().map((i) => i.book.title);
  return [
    "Suggest 8 non-fiction books for this reader. Only real, well-known books you are sure exist, with the correct author and year.",
    t.description ? `Books topic: ${t.description}` : "",
    likes.length ? `Topics and tags the reader likes: ${likes.join(", ")}.` : "",
    loved.length ? `Books they rated 4-5 stars: ${loved.join("; ")}.` : "",
    disliked.length ? `Books they did not like: ${disliked.join("; ")}.` : "",
    mine.length ? `Do NOT suggest (already in the app): ${mine.join("; ")}.` : "",
    "Mix classics and recent books; avoid the obvious top-10 list.",
    `For "sub" pick the best fit: ${subsOf().map((s) => `${s.id} (${s.label})`).join(", ")}.`,
    'For "hook" write one friendly line on why this reader would like it.',
  ].filter(Boolean).join("\n");
}

const SUGG_SYSTEM = `You are a thoughtful book curator. The reader is a Portuguese motion designer who reads in English in bed. Be specific and honest; never invent books.`;

async function fetchSuggestions() {
  const { books } = await askJSON({ system: SUGG_SYSTEM, prompt: suggestPrompt(), schema: SUGG_SCHEMA, fast: true });
  const out = (books ?? []).filter((b) => b.title && b.author);
  local.set("bookSuggestions", { at: Date.now(), books: out });
  return out;
}

// ---------- the summary ----------
const BOOK_SCHEMA = {
  type: "object",
  properties: {
    found: { type: "boolean", description: "false if you are not sure this book exists or what it says" },
    bookTitle: { type: "string" }, author: { type: "string" },
    sub: { type: "string" }, tags: { type: "array", items: { type: "string" } },
    title: { type: "string", description: "the book's big idea as a headline" },
    snippet: { type: "string", description: "the big idea in one or two sentences" },
    body: { type: "array", items: { type: "string" }, description: "what the book is and why it's worth knowing, 60-120 words" },
    lessons: {
      type: "array", description: "3-5 key lessons",
      items: { type: "object", properties: { title: { type: "string" }, text: { type: "string" } }, required: ["title", "text"] },
    },
    takeaway: { type: "string", description: "one concrete thing to try this week" },
    forWho: { type: "string", description: "who will get the most out of this book, one sentence" },
  },
  required: ["found"],
};

const BOOK_SYSTEM = `You write book summaries for MyScroll, a personal reading app, in the style of Deepstash: the big idea, a few punchy lessons, one thing to try.
The reader is a Portuguese motion designer who reads in English in bed. Tone: curious, warm, clear, no hype.
Write from well-established knowledge of the book. If you are unsure the book exists, or unsure of its content, return found=false and leave the rest empty. Never invent chapters, anecdotes, numbers or quotes.
Put everything in your own words; no long quotes. body: 60-120 words in 1-2 paragraphs. 3-5 lessons, each a punchy title and 2-3 sentences. tags: 2-5 lowercase-hyphenated tags.`;

async function writeBook({ title, author }) {
  const subs = subsOf();
  const out = await askJSON({
    system: BOOK_SYSTEM, fast: true, schema: BOOK_SCHEMA,
    prompt: `Write the summary card for the book "${title}"${author ? ` by ${author}` : ""}.\nFor "sub" pick the best fit: ${subs.map((s) => `${s.id} (${s.label})`).join(", ")}.`,
  });
  const lessons = (out.lessons ?? []).filter((l) => l?.title && l?.text).slice(0, 5);
  if (!out.found || lessons.length < 3 || !out.title || !out.bookTitle) {
    throw new Error(`I'm not sure enough about “${title}” to summarise it without making things up. Try another title.`);
  }
  const taken = new Set(pool().map((i) => i.id));
  let id = `books-${slugify(out.bookTitle)}`.slice(0, 56).replace(/-$/, "");
  const reuse = pool().find((i) => i.book && bookKey(i.book.title) === bookKey(out.bookTitle));
  if (reuse) return reuse; // already generated: just open it
  for (let k = 2; taken.has(id); k++) id = `${id.replace(/-\d+$/, "")}-${k}`;
  const body = (out.body ?? []).filter(Boolean);
  const q = encodeURIComponent(`${out.bookTitle} ${out.author ?? ""}`.trim());
  const item = {
    id, topic: "books", ...(subs.some((s) => s.id === out.sub) ? { sub: out.sub } : {}),
    kind: "evergreen", style: "book", tags: (out.tags ?? []).slice(0, 5),
    title: out.title.trim(), snippet: (out.snippet ?? "").trim(), body,
    book: { title: out.bookTitle, author: out.author ?? author ?? "", lessons, takeaway: out.takeaway ?? "", forWho: out.forWho ?? "" },
    source: { id: "ai-books", name: "MyScroll · AI summary", url: `https://openlibrary.org/search?q=${q}` },
    lang: "en", minutes: Math.max(2, Math.round(([out.snippet, ...body, ...lessons.map((l) => l.text)].join(" ").split(/\s+/).length) / 220)),
    added: state.latest, fast: true,
  };
  addLocalItems([item]);
  return item;
}

// ---------- the panel ----------
// ctx: { openItem(id) (reload, scroll to the card and open it), openSettingsAI() }
export function booksPanel(ctx) {
  const root = el("section", { class: "books-panel" });
  let busy = false;
  let status = null; // { text, error?, setup? }

  const setStatus = (s) => { status = s; paint(); };
  const pick = async (book) => {
    if (busy) return;
    busy = true;
    setStatus({ text: `Writing the summary of “${book.title}”…` });
    try {
      const item = await writeBook(book);
      busy = false;
      await ctx.openItem(item.id);
    } catch (err) {
      busy = false;
      setStatus({ text: err.message, error: true, setup: err.needsSetup });
    }
  };
  const refresh = async () => {
    if (busy) return;
    busy = true;
    setStatus({ text: "Finding books you might like…" });
    try { await fetchSuggestions(); busy = false; setStatus(null); }
    catch (err) { busy = false; setStatus({ text: err.message, error: true, setup: err.needsSetup }); }
  };

  const input = el("input", { type: "text", placeholder: "Or type a book…", "aria-label": "Book title" });
  const form = el("form", { class: "book-ask", onsubmit: (e) => {
    e.preventDefault();
    const title = input.value.trim();
    if (!title) return input.focus();
    input.value = "";
    pick({ title, author: "" });
  } }, input, el("button", { type: "submit" }, "Write"));

  function paint() {
    if (!canUseAI()) {
      root.replaceChildren(el("h3", {}, "📚 Suggest books"),
        el("p", { class: "set-hint" }, "Gemini suggests books for you and writes the lessons."),
        el("button", { class: "setup-link", onclick: ctx.openSettingsAI }, "Open Settings → AI →"));
      return;
    }
    const cached = local.get("bookSuggestions", null);
    const mine = new Set(have().map((i) => bookKey(i.book.title)));
    const list = (cached?.books ?? []).filter((b) => !mine.has(bookKey(b.title)));
    root.replaceChildren(...[
      el("div", { class: "books-head" }, el("h3", {}, "📚 Suggest books"),
        el("button", { class: "mini-btn", disabled: busy, onclick: refresh }, cached ? "↻ New suggestions" : "Suggest")),
      !cached && !status ? el("p", { class: "set-hint" }, "Eight books picked for you, from what you like and rate. Tap one for a lesson card.") : null,
      list.length ? el("div", { class: "book-list" }, list.map((b) => el("button", { class: "book-sugg", disabled: busy, onclick: () => pick(b) },
        el("span", { class: "bs-title" }, b.title),
        el("span", { class: "bs-by" }, `${b.author}${b.year ? ` · ${b.year}` : ""}`),
        el("span", { class: "bs-hook" }, b.hook)))) : null,
      form,
      status ? el("p", { class: "more-status" + (status.error ? " error" : "") }, status.text,
        status.setup ? el("button", { class: "setup-link", onclick: ctx.openSettingsAI }, "Open Settings → AI →") : null) : null,
    ].filter(Boolean));
    input.disabled = busy;
  }
  paint();
  return root;
}
