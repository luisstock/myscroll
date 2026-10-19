# How MyScroll learns your taste

Implemented in `web/ranking.js` (shared by the app and the daily agent).

## 1. Every item has features

`topic`, `sub` (subcategory), `source`, `style` (til, cracked, story, news, video…) and free `tags` (e.g. `comfyui`, `after-effects`, `gravel-racing`).

## 2. Ratings become signals

| Rating | Signal | Weight |
|---|---|---|
| 0 | −1.0 | ×2 ("never this kind of thing") |
| 1 | −0.6 | ×1 |
| 2 | −0.2 | ×1 |
| 3 | +0.2 | ×1 |
| 4 | +0.6 | ×1 |
| 5 | +1.0 | ×1 |

"Not interested" (the ✕ on a card) counts like a 1★: −0.6 at weight 1, unless you also rated that item.

Implicit signals are deliberately weak: opening without rating = +0.3 at weight 0.3; scrolling past an item 3+ times without opening = −0.5 at a small weight.

Every signal fades over time (half-life 45 days), so tastes can change.

## 3. Affinity per feature = Bayesian average

```
affinity(f) = Σ w·s / (Σ w + m)        m = 3
```

The `m` acts as a prior centred on neutral (0), the same idea as IMDb's weighted rating: a single 5★ doesn't make a whole topic a favourite, but many consistent ratings do. Uncertainty `1/√(n+1)` is kept for exploration.

**Muting:** if a feature's affinity drops to −0.5 or below with enough evidence (≥ 2), items with it are removed. Muted features are listed in Settings and can be unmuted.

## 4. Item score

```
score = quality (agent's own 0–1 judgement)
      + 1.0·a(topic) + 0.8·a(sub) + 0.6·a(source) + 0.4·a(style) + 0.5·mean(a(tags))
      + 0.25·(topic weight − 1) + 0.2·(source weight − 1)        ← your Settings
      − 0.05·age in days (news only)
```

## 5. Building the next edition (agent)

1. **Slots per topic** ∝ your topic weight × e^affinity, minimum 2 per enabled topic.
2. Research ~2× more candidates than slots.
3. ~85% of slots: best scores. ~15%: **exploration**, scores drawn with Thompson-style noise proportional to uncertainty, so new kinds of content still get a chance and the feed doesn't collapse into a bubble.
4. Muted features and sources/topics set to 0 are never picked.

## References

- Bayesian average / IMDb weighted rating: [Algolia](https://www.algolia.com/doc/guides/managing-results/must-do/custom-ranking/how-to/bayesian-average.md), [Arpit Bhayani](https://arpitbhayani.me/blogs/bayesian-average)
- Explicit 5-level ratings in news recommenders: [Tasci & Cicekli, KDIR 2014](https://www.scitepress.org/Papers/2014/50720/50720.pdf)
- Profile time decay: [USPTO 12632776](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/12632776)
- Thompson sampling for explore/exploit: [Microsoft Research](https://microsoft.com/en-us/research/wp-content/uploads/2016/02/EE_Autosuggest_MSRTR.pdf), [Shaped.ai](https://www.shaped.ai/blog/is-the-key-to-unlocking-better-user-experiences-in-recommender-systems-found-in-exploration)
