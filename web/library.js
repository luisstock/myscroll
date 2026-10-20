// 📚 Library: a place for books. Suggestions (books.js), your unread book cards, finished books, and the
// "Remember this?" lessons that are due. AI-written books (source.id "ai-books") live only here (and in Saved).
import { state, store, pool, live } from "./model.js";
import { isHidden } from "./later.js";
import { booksPanel } from "./books.js";
import { rememberBlock, dueEntries } from "./remember.js";
import { el, $ } from "./ui.js";

export const isAIBook = (item) => item.source?.id === "ai-books";

// Newest first (added day, then when it was written; ties keep the pool order).
const newest = (a, b) => (b.added > a.added ? 1 : b.added < a.added ? -1 : (b.made ?? 0) - (a.made ?? 0));

// { unread, finished }: every book item in the pool, AI-generated or from an edition.
export function libraryBooks() {
  const books = pool().filter((i) => i.book && !isHidden(i.id));
  const when = (i) => state.readLog[i.id]?.at ?? "";
  return {
    unread: books.filter((i) => !state.read.has(i.id)).sort(newest),
    finished: books.filter((i) => state.read.has(i.id)).sort((a, b) => (when(b) < when(a) ? -1 : when(b) > when(a) ? 1 : newest(a, b))),
  };
}

const stars = (id) => { const r = state.ratings[id]?.r; return r == null ? "" : r === 0 ? "✕" : `${r}★`; };

// ctx: { makeCard(item), booksCtx, label(text), empty(text) }
export function renderLibrary(ctx) {
  const { unread, finished } = libraryBooks();
  const nodes = [booksPanel(ctx.booksCtx)];
  if (dueEntries(state, live).length) nodes.push(rememberBlock({ state, store, live }));

  nodes.push(ctx.label("Your books"));
  if (unread.length) nodes.push(...unread.map((i) => ctx.makeCard(i)));
  else nodes.push(ctx.empty("No books waiting. Pick one above and it lands here."));

  if (finished.length) {
    nodes.push(ctx.label("Finished"));
    nodes.push(el("div", { class: "fin-list" }, finished.map((item) => el("button", {
      class: "fin-row", "data-id": item.id,
      onclick: (e) => { // open the card again, even though it's read
        const card = ctx.makeCard(item);
        e.currentTarget.replaceWith(card);
        $(".card-head", card).click();
      },
    }, el("span", { class: "fin-title" }, item.book.title), el("span", { class: "fin-by" }, item.book.author),
    el("span", { class: "fin-rate" }, stars(item.id))))));
  }
  return nodes;
}
