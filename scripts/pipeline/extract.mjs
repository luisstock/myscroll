// Gets the readable text behind a candidate so the model writes from the real source,
// not from a headline. Reddit → post + top comments; Wikipedia → article extract; else Readability.
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import { XMLParser } from "fast-xml-parser";
import { get, redditGet } from "./gather.mjs";

const clip = (t, maxWords) => {
  const w = t.split(/\s+/);
  return w.length > maxWords ? w.slice(0, maxWords).join(" ") + " …" : t;
};

// Thread RSS: first entry is the post, the rest are top comments.
const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", textNodeName: "#text" });
const toText = (html) => parseHTML(`<div>${html}</div>`).document.querySelector("div").textContent.replace(/\s+/g, " ").trim();
async function redditText(url) {
  const feed = xml.parse(await redditGet(url.replace(/\/?(\?.*)?$/, "/.rss?sort=top&limit=8")));
  const entries = [].concat(feed.feed?.entry ?? []);
  const content = (e) => (typeof e.content === "string" ? e.content : e.content?.["#text"] ?? "");
  const postHtml = content(entries[0] ?? {});
  const { document } = parseHTML(`<div>${postHtml}</div>`);
  const link = [...document.querySelectorAll("a")].map((a) => a.getAttribute("href")).find((h) => h && !/reddit\.com|redd\.it/.test(h)) ?? null;
  let text = `POST: ${toText(postHtml).replace(/submitted by .*$/, "")}\n\n`;
  text += entries.slice(1, 7).map((e) => `COMMENT by ${e.author?.name ?? "someone"}: ${toText(content(e))}`).join("\n\n");
  return { text, link };
}

async function wikiText(url) {
  const m = url.match(/https?:\/\/([a-z-]+)\.wikipedia\.org\/wiki\/([^#?]+)/);
  const api = `https://${m[1]}.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&titles=${m[2]}`;
  const data = await get(api, { json: true });
  return Object.values(data.query.pages)[0]?.extract ?? "";
}

export async function articleText(url) {
  const html = await get(url);
  const { document } = parseHTML(html);
  const og = document.querySelector('meta[property="og:image"]')?.getAttribute("content") ?? null;
  const parsed = new Readability(document).parse();
  return { text: (parsed?.textContent ?? "").replace(/\n{3,}/g, "\n\n").replace(/[ \t]+/g, " ").trim(), image: og };
}

// Reddit allows ~10 requests a minute: only the first few threads get their comments fetched.
let redditThreads = 6;

export async function extract(c, maxWords) {
  try {
    if (/reddit\.com\/r\/[^/]+\/comments\//.test(c.url) && redditThreads-- > 0) {
      const r = await redditText(c.url);
      let text = r.text;
      if (r.link && !/reddit\.com|redd\.it|i\.imgur|youtube\.com|youtu\.be/.test(r.link)) {
        try { text = `ARTICLE:\n${(await articleText(r.link)).text}\n\nREDDIT DISCUSSION:\n${text}`; } catch {}
      }
      return { ...c, text: clip(text, maxWords) };
    }
    if (/reddit\.com\//.test(c.url)) return { ...c, text: c.summary || "" }; // out of Reddit budget: use the post text from the feed
    if (/wikipedia\.org\/wiki\//.test(c.url)) return { ...c, text: clip(await wikiText(c.url), maxWords) };
    if (c.video) return { ...c, text: clip(c.summary || "", maxWords) };
    const a = await articleText(c.url);
    return { ...c, text: clip(a.text || c.summary || "", maxWords), image: c.image ?? a.image };
  } catch (e) {
    return { ...c, text: c.summary || "", extractError: e.message };
  }
}
