# Daily agent contract

What the daily agent reads, what it must produce, and how it should handle what the user sets in the app.
(The agent itself is the next step; this is the spec it will follow.)

## Inputs

| What | Where (prototype) | Notes |
|---|---|---|
| Topics | `settings.topics` ?? `web/taxonomy.json` | `label`, `emoji`, `description`, `keywords`, `subs`, `group`, `lang`, `hidden`, `status` |
| Groups | `settings.groups` ?? `web/taxonomy.json` | a topic is off if its group has `enabled: false` |
| Topic weights | `settings.topicWeights` | 0 = off, 1 = normal, 2 = more, 3 = max |
| Sources | `web/catalog.json` (`default: true` or `sourceOverrides[id].enabled`) + `settings.customSources` − deleted | each has `topic`, `url`, `type`, `weight` |
| Ratings & signals | `ratings`, `opened`, `skips`, `itemFeatures` | fed to `buildProfile()` in `web/ranking.js` |
| Size | `settings.dailyTarget` | items per edition |

In the prototype these live in the browser's localStorage (`myscroll:*`). With the backend they'll be rows the agent reads before each run.

## Each run

1. **Active topics** = not hidden, weight > 0, group enabled.
2. **Slots per topic**: `allocateSlots()` from `ranking.js`.
3. **Set up new topics** (`status: "new"`):
   - turn the description into 5–8 good search keywords if the user left them generic;
   - find 5–10 quality sources (sites, subreddits, YouTube channels, newsletters, RSS), check that each one is alive, and add them to the catalog with `topic` + `tags`;
   - then set `status: "ready"`.
4. **Research**: for each topic, check its sources (weighted by `weight`) and run its keyword searches for things from the last ~7 days (news) plus evergreen finds. Collect about 2× as many candidates as slots.
5. **Score and pick**: `scoreItem()` with the profile; muted features are out; ~15% of slots go to exploration (`explore: true`).
6. **Write each item** in the edition format (`content/<date>.json`):
   - `topic`, `sub`, `style`, `kind` (`news` | `evergreen` | `longread`), `tags`, `published`, `source {id, name, url}`, `wiki` or `video` when relevant;
   - `title`, `snippet` (1–2 lines), `body` (100–250 words, in the topic's `lang`);
   - `more`: a longer, deeper version (400–900 words) written from the source plus extra research. This is what **Read more** shows first, so it works offline in the app and on sites that block extraction.
   - Facts must come from the source; no invented details.
7. Run `node scripts/build-edition.mjs <date>` to fetch images and update the index.

## Read more in the app

Order: `item.more` → Wikipedia API → Reddit thread JSON → article text extracted from the page (via `/api/fetch` in the prototype; native HTTP in the Android app). Some sites block extraction (e.g. paywalls, ARTnews); for those `more` is the only way, which is why the agent should always write it.

## Extra run modes

All append to today's edition (history/finalize --append). Same options in `run.mjs`, `/api/run` (local) and the `workflow_dispatch` inputs (`more`, `topics`, `sub`, `query`, `url`).

- **Subcategory** `--more N --sub topic/sub`: only that topic; candidates matching the sub label are preferred (plus a Google News / HN search for it); the writer must write only items for that sub and every item gets `sub`.
- **Search** `--more N --query "text"`: no AI gathering; Google News RSS, Reddit search RSS, HN Algolia and Wikipedia search, minus history, text extracted, then ONE model call picks the best N (default 10) and chooses each item's topic (fallback `search`). Items get `query` (normalized: trim, lowercase, collapse spaces).
- **Share** `--url <link>`: one candidate from the page (article, Reddit thread via RSS, YouTube via oEmbed), one model call, one item with `shared: true`. Exits 0 if the URL is already in the history.
- **Follow** (daily run only): for each live entry in the synced `follows` (no `off`), search `follow.query` over the last 7 days and since `follow.since`, drop what the history has seen, and write up to 2 update items per follow in one call, each with `follow: <followId>` and the follow's topic. Nothing new, nothing written.
- Stories whose item the reader hid (`hidden`, Not interested) are never picked again.
- Local server: `POST /api/llm` with `{ system, prompt, schema }` returns the model's JSON (Ask / translate).
