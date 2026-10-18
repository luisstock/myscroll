// Turns pre-selected, extracted candidates into finished MyScroll items with one model call per topic.
// The model only chooses and writes; links, dates, sources and videos always come from the candidate.
import { generateJSON } from "./llm.mjs";

const SYSTEM = `You are the editor of MyScroll, a personal daily reading app that replaces doomscrolling.
The reader: a Portuguese motion designer who reads in English before bed. Into After Effects and motion design, local and frontier AI, gravel cycling and technique, random curiosities (Reddit TIL, old Cracked), tech, science, design.

Rules:
- Write only from the provided source text. Never invent facts, numbers, names or quotes. If the text is thin, write less rather than make things up.
- Tone: curious, warm, a little witty, never mean, no hype, no clickbait. Plain, vivid language.
- title: specific and intriguing, max 90 characters.
- snippet: 1-2 sentences that make you want to open it.
- body: 2-3 short paragraphs, 80-200 words in total: what happened or what the thing is, why it's interesting, the key facts.
- more: 4-7 paragraphs, 350-700 words, the deeper version: context, details, how it works, notable reactions (for Reddit: the best comments), what's next. No repetition of the body.
- tags: 2-5 specific lowercase-hyphenated tags (e.g. "comfyui", "after-effects", "gravel-racing"); reuse obvious names.
- wiki: an English Wikipedia article title that fits the story's main subject for a picture (e.g. "Perseverance_(rover)"), or "" if none fits well.
- Skip candidates that are ads, sponsored posts, job listings, low-effort memes, paywalled stubs or not genuinely interesting.`;

const ITEM = {
  type: "object",
  properties: {
    candidate: { type: "integer", description: "index of the candidate this item is based on" },
    sub: { type: "string" },
    style: { type: "string", enum: ["til", "cracked", "story", "reddit", "news", "explainer", "video", "list"] },
    tags: { type: "array", items: { type: "string" } },
    title: { type: "string" },
    snippet: { type: "string" },
    body: { type: "array", items: { type: "string" } },
    more: { type: "array", items: { type: "string" } },
    wiki: { type: "string" },
    explore: { type: "boolean" },
  },
  required: ["candidate", "sub", "style", "tags", "title", "snippet", "body", "more", "wiki", "explore"],
  additionalProperties: false,
};
const TOPIC_SCHEMA = { type: "object", properties: { items: { type: "array", items: ITEM } }, required: ["items"], additionalProperties: false };

const BOOK_ITEM = {
  type: "object",
  properties: {
    candidate: { type: "integer" },
    sub: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    bookTitle: { type: "string" },
    author: { type: "string" },
    title: { type: "string", description: "the book's big idea as a headline" },
    snippet: { type: "string", description: "the big idea in one or two sentences" },
    body: { type: "array", items: { type: "string" }, description: "what the book is and why it's worth knowing, 60-120 words" },
    lessons: {
      type: "array",
      items: { type: "object", properties: { title: { type: "string" }, text: { type: "string" } }, required: ["title", "text"], additionalProperties: false },
      description: "3-5 key lessons: a punchy title and 2-3 sentences each",
    },
    takeaway: { type: "string", description: "one concrete thing to try this week" },
    forWho: { type: "string", description: "who will get the most out of this book, one sentence" },
    wiki: { type: "string" },
    explore: { type: "boolean" },
  },
  required: ["candidate", "sub", "tags", "bookTitle", "author", "title", "snippet", "body", "lessons", "takeaway", "forWho", "wiki", "explore"],
  additionalProperties: false,
};
const BOOK_SCHEMA = { type: "object", properties: { items: { type: "array", items: BOOK_ITEM } }, required: ["items"], additionalProperties: false };

// Extra instructions per topic format.
const FORMAT_RULES = {
  news: `FORMAT: calm world news. body = what happened, why it matters, what happens next. No gore, crime voyeurism, celebrity gossip or outrage bait; skip those candidates. Prefer the stories that change something.`,
  idea: `FORMAT: one idea per item, Deepstash-style. title = the idea itself as a crisp, quotable statement (not a headline about an article). snippet = one sentence on why it matters. body = 60-120 words: the idea, an example, how to use it. more = 250-450 words going deeper. style = "explainer". Credit the author/thinker in the body.`,
  book: `FORMAT: book cards, Deepstash-style. Only use candidates that are clearly about ONE specific book (review, interview with the author, an essay built on the book). Skip anything else.
Each item: bookTitle and author exactly as in the text; title = the book's big idea as a headline; 3-5 lessons, each with a punchy title and 2-3 sentences in your own words; one concrete takeaway to try; who it's for.
Lessons must come from the candidate text. Never quote long passages and never invent content the text doesn't support.`,
};

const fmtDate = (iso) => (iso ? iso.slice(0, 10) : "undated");

function candidateBlock(c, i) {
  return [
    `### Candidate ${i}`,
    `Title: ${c.title}`,
    `Source: ${c.sourceName} (${c.sourceType}) · ${fmtDate(c.published)}${c.engagement ? ` · ${c.engagement} engagement` : ""}${c.video ? " · YouTube video" : ""}`,
    `URL: ${c.url}`,
    `Text:\n${c.text || c.summary || "(no text — only use if the title alone is clearly great)"}`,
  ].join("\n");
}

export async function writeTopic(config, topic, candidates, plan) {
  if (!candidates.length) return { items: [], usage: null };
  const want = Math.min(topic.slots, candidates.length);
  const explore = Math.max(0, Math.round(want * plan.explorationShare));
  const taste = plan.taste;
  const prompt = [
    `# Topic: ${topic.emoji} ${topic.label}`,
    `What the reader wants: ${topic.description || topic.label}`,
    topic.subs.length ? `Subcategories (use one id for "sub"): ${topic.subs.map((s) => `${s.id} = ${s.label}`).join("; ")}` : `No subcategories: use "" for "sub".`,
    topic.lang === "pt" ? `LANGUAGE: write title, snippet, body and more in European Portuguese (Portugal, not Brazil).` : `LANGUAGE: English.`,
    taste.likes.length ? `The reader likes: ${taste.likes.slice(0, 10).map((x) => x.label).join(", ")}.` : "",
    taste.dislikes.length ? `The reader is less keen on: ${taste.dislikes.slice(0, 10).map((x) => x.label).join(", ")}.` : "",
    FORMAT_RULES[topic.format] ?? "",
    "",
    `Pick the best ${want} candidates (fewer if some aren't good enough) and write an item for each.`,
    explore ? `Mark ${explore} of them "explore": true: good picks a bit outside the reader's usual taste. All others false.` : `Set "explore": false for all.`,
    "",
    ...candidates.map(candidateBlock),
  ].filter((l) => l !== "").join("\n");

  const isBook = topic.format === "book";
  const { json, usage } = await generateJSON(config, { system: SYSTEM, prompt, schema: isBook ? BOOK_SCHEMA : TOPIC_SCHEMA });
  const items = (json.items ?? [])
    .filter((it) => candidates[it.candidate])
    .map((it) => {
      if (!isBook) return toItem(topic.format === "idea" ? { ...it, style: "idea" } : it, candidates[it.candidate], topic, plan);
      const base = toItem({ ...it, style: "book", more: [] }, candidates[it.candidate], topic, plan);
      delete base.more;
      return {
        ...base, kind: "evergreen",
        book: { title: it.bookTitle, author: it.author, lessons: it.lessons.slice(0, 5), takeaway: it.takeaway, forWho: it.forWho },
      };
    });
  return { items, usage };
}

const LONGREAD_SCHEMA = {
  type: "object",
  properties: {
    candidate: { type: "integer" },
    title: { type: "string" }, snippet: { type: "string" },
    body: { type: "array", items: { type: "string" } },
    tags: { type: "array", items: { type: "string" } },
    wiki: { type: "string" },
  },
  required: ["candidate", "title", "snippet", "body", "tags", "wiki"],
  additionalProperties: false,
};

export async function writeLongread(config, candidates, plan) {
  if (!candidates.length) return { item: null, usage: null };
  const prompt = [
    `Write tonight's LONG READ: one story that is wonderful to read in bed. Pick the single best candidate below.`,
    `body: 7-12 paragraphs, 600-1000 words, told as a story with a beginning, middle and satisfying end. English.`,
    `Use only facts from the candidate's text.`,
    "",
    ...candidates.map(candidateBlock),
  ].join("\n");
  const { json, usage } = await generateJSON(config, { system: SYSTEM, prompt, schema: LONGREAD_SCHEMA });
  const c = candidates[json.candidate];
  if (!c) return { item: null, usage };
  const item = toItem({ ...json, style: "story", sub: "story", more: [], explore: false }, c, plan.topics.find((t) => t.id === c.topic) ?? { id: c.topic, subs: [] }, plan);
  delete item.more;
  return { item: { ...item, kind: "longread" }, usage };
}

function slug(text) {
  return text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
}

function toItem(it, c, topic, plan) {
  const evergreen = c.kind !== "news";
  const sub = topic.subs?.some((s) => s.id === it.sub) ? it.sub : undefined;
  return {
    id: `${topic.id}-${slug(it.title)}`.slice(0, 60).replace(/-$/, ""),
    topic: topic.id,
    ...(sub ? { sub } : {}),
    kind: evergreen ? "evergreen" : "news",
    ...(c.published ? { published: c.published.slice(0, 10) } : {}),
    style: c.video ? "video" : it.style,
    tags: it.tags,
    title: it.title.trim(),
    snippet: it.snippet.trim(),
    body: it.body.filter(Boolean),
    more: it.more?.filter(Boolean),
    source: { id: c.sourceId, name: c.sourceName, url: c.url },
    ...(c.video ? { video: { ...c.video, title: c.title } } : {}),
    ...(it.wiki && !c.video ? { wiki: it.wiki.replace(/ /g, "_") } : {}),
    ...(c.image && !c.video ? { imageUrl: c.image } : {}),
    lang: topic.lang ?? "en",
    ...(it.explore ? { explore: true } : {}),
  };
}
