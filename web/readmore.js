// "Read more": fetches the full text behind an item so it can be read inside the app.
// Order: text the agent already wrote (item.more) → Wikipedia API → Reddit JSON → article extraction.
// Pages are fetched through /api/fetch (the dev server) to get around CORS; in the Android app
// this will be a native HTTP call instead.

const MAX_BLOCKS = 40;

export async function readMore(item) {
  if (item.more) {
    const paras = Array.isArray(item.more) ? item.more : [item.more];
    return { blocks: paras.map((text) => ({ type: "p", text })), from: "MyScroll" };
  }
  const url = item.source?.url;
  if (!url) throw new Error("No source link for this item.");
  if (/youtube\.com|youtu\.be|vimeo\.com/.test(url)) throw new Error("This one is a video — watch it above.");

  const wiki = url.match(/https?:\/\/([a-z-]+)\.(?:m\.)?wikipedia\.org\/wiki\/([^#?]+)/);
  if (wiki) return wikipedia(wiki[1], decodeURIComponent(wiki[2]));
  if (/reddit\.com\/r\/[^/]+\/comments\//.test(url)) return reddit(url);
  return article(url);
}

async function wikipedia(lang, title) {
  const api = `https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&origin=*&titles=${encodeURIComponent(title)}`;
  const data = await fetch(api).then((r) => r.json());
  const page = Object.values(data.query?.pages ?? {})[0];
  if (!page?.extract) throw new Error("Wikipedia didn't return any text.");
  const blocks = [];
  for (const line of page.extract.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const h = t.match(/^=+\s*(.+?)\s*=+$/);
    if (h) {
      if (/^(See also|References|Notes|Further reading|External links|Bibliography|Sources|Ver também|Referências|Ligações externas)$/i.test(h[1])) break;
      blocks.push({ type: "h", text: h[1] });
    } else blocks.push({ type: "p", text: t });
    if (blocks.length >= MAX_BLOCKS) break;
  }
  return { blocks: dropTrailingHeadings(blocks), from: "Wikipedia" };
}

async function reddit(url) {
  const json = JSON.parse(await proxied(url.replace(/\/?(\?.*)?$/, "/.json?limit=8&sort=top")));
  const post = json[0]?.data?.children?.[0]?.data;
  const blocks = [];
  if (post?.selftext) blocks.push(...post.selftext.split(/\n{2,}/).map((text) => ({ type: "p", text })));
  const comments = (json[1]?.data?.children ?? []).map((c) => c.data).filter((c) => c?.body && !c.stickied).slice(0, 5);
  if (comments.length) {
    blocks.push({ type: "h", text: "Top comments" });
    for (const c of comments) blocks.push({ type: "quote", text: c.body, by: `u/${c.author} · ${c.score} points` });
  }
  if (!blocks.length) throw new Error("Nothing more to read in this thread.");
  return { blocks, from: "Reddit" };
}

async function article(url) {
  const html = await proxied(url);
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, style, noscript, nav, header, footer, aside, form, iframe, svg, button, figure, [role=navigation], [aria-hidden=true], .comments, #comments, .newsletter, .related, .share, .social, .ad, .advert")
    .forEach((n) => n.remove());

  // Pick the container with the most paragraph text.
  const candidates = [...doc.querySelectorAll("article, main, [role=main], .post-content, .entry-content, .article-body, .article__body")];
  candidates.push(doc.body);
  const textLen = (n) => [...n.querySelectorAll("p")].reduce((s, p) => s + p.textContent.trim().length, 0);
  const root = candidates.sort((a, b) => textLen(b) - textLen(a))[0];

  const seen = new Set();
  const blocks = [];
  for (const n of root.querySelectorAll("h2, h3, p, blockquote, li")) {
    const text = n.textContent.replace(/\s+/g, " ").trim();
    if (!text || seen.has(text)) continue;
    const isHeading = /^H[23]$/.test(n.tagName);
    if (!isHeading && text.length < (n.tagName === "LI" ? 60 : 40)) continue;
    if (n.tagName === "LI" && n.closest("nav, ul.menu")) continue;
    seen.add(text);
    blocks.push({ type: isHeading ? "h" : n.tagName === "BLOCKQUOTE" ? "quote" : "p", text });
    if (blocks.length >= MAX_BLOCKS) break;
  }
  const words = blocks.filter((b) => b.type !== "h").reduce((s, b) => s + b.text.split(" ").length, 0);
  if (words < 80) throw new Error("Couldn't pull the article text from this site (it may need a browser or a subscription).");
  return { blocks: dropTrailingHeadings(blocks), from: new URL(url).hostname.replace(/^www\./, "") };
}

async function proxied(url) {
  const res = await fetch(`/api/fetch?url=${encodeURIComponent(url)}`);
  if (!res.ok) throw new Error(`The source answered ${res.status}.`);
  return res.text();
}

function dropTrailingHeadings(blocks) {
  while (blocks.length && blocks[blocks.length - 1].type === "h") blocks.pop();
  return blocks;
}
