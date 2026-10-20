// Mixed feed: keep the rank order but spread items so neighbours don't share a key (a topic, or a subcategory).
// Greedy: take the best remaining item whose key differs from the last two; failing that, from the last one;
// failing that, the best. Pure and UI-free.
const NONE = Symbol("none");

export function spread(items, keyOf) {
  const left = [...items];
  const out = [];
  while (left.length) {
    const k1 = out.length > 0 ? keyOf(out[out.length - 1]) : NONE;
    const k2 = out.length > 1 ? keyOf(out[out.length - 2]) : NONE;
    let i = left.findIndex((x) => keyOf(x) !== k1 && keyOf(x) !== k2);
    if (i < 0) i = left.findIndex((x) => keyOf(x) !== k1);
    out.push(left.splice(i < 0 ? 0 : i, 1)[0]);
  }
  return out;
}
