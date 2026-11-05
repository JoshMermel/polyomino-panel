// Helpers for choosing which puzzles go in which book (see tools/build_books.mjs).

export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// Choose `count` puzzles from a scored pool at evenly spaced RANKS: sort by score and take the
// puzzles at ranks 0, 1/(count-1), ..., 1 of the way through, so the picks include the pool's easiest
// and hardest puzzle and follow its own distribution in between (a pool that is mostly easy gives
// mostly easy picks). One pick is the median. (Star battle's builder spaces picks evenly over a fixed
// score range instead, which suits hand-tuned ranges; ours are merged tiers whose scores run from
// tens to over a thousand, so equal-width score bins would be dominated by the extreme tail.)
// Equal scores are ordered by a hash of the puzzle's name and the seed, so rescoring or re-sorting a
// pool doesn't reshuffle which of several equal puzzles is chosen.
// cands: [{name, score, ...}]; returns { picks (ascending by score), short }.
export function pickQuantiles(cands, { count, seed = 1 }) {
  const tie = c => hashString(`${c.name}#${seed}`);
  const sorted = cands.map(c => ({ c, t: tie(c) }))
    .sort((a, b) => a.c.score - b.c.score || a.t - b.t || (a.c.name < b.c.name ? -1 : 1))
    .map(x => x.c);
  const n = sorted.length;
  if (n <= count) return { picks: sorted, short: count - n };
  const picks = [];
  for (let i = 0; i < count; i++) picks.push(sorted[count === 1 ? Math.floor(n / 2) : Math.round(i * (n - 1) / (count - 1))]);
  return { picks, short: 0 };
}

// Like pickQuantiles, but PREFERS candidates for which isKept(c) is true (puzzles already published in
// the book), so a rebuild changes as little as possible: every kept puzzle is included and quantile
// picks from the rest make up the number. If more than `count` are kept, `keepAll` decides: true keeps
// them all (a rebuild only ever adds puzzles), false trims them to a quantile subset. With nothing
// kept it is exactly pickQuantiles.
export function pickStable(cands, { count, seed = 1, isKept = () => false, keepAll = false }) {
  const kept = cands.filter(isKept);
  const byScore = (a, b) => a.score - b.score || (a.name < b.name ? -1 : 1);
  if (kept.length >= count) return keepAll ? { picks: kept.sort(byScore), short: 0 } : pickQuantiles(kept, { count, seed });
  const more = pickQuantiles(cands.filter(c => !isKept(c)), { count: count - kept.length, seed });
  return { picks: [...kept, ...more.picks].sort(byScore), short: more.short };
}

// Split `count` slots across cells in proportion to `weights` (default: equal), as far as their
// capacities allow: a cell that can't fill its share gives up what it can't and the others share the
// difference in the same proportions (weighted water-filling). `caps` is the number of candidates in each
// cell; a cell with weight 0 gets nothing. Returns the allocation, same order; the total is
// min(count, sum of caps of the cells with weight). With equal weights this is the even split.
export function weightedAllocation(count, caps, weights = caps.map(() => 1)) {
  const alloc = new Array(caps.length).fill(0);
  let left = Math.min(count, caps.reduce((sum, c, i) => sum + (weights[i] > 0 ? c : 0), 0));
  for (;;) {
    const open = caps.map((c, i) => i).filter(i => alloc[i] < caps[i] && weights[i] > 0);
    if (left <= 0 || !open.length) break;
    const total = open.reduce((sum, i) => sum + weights[i], 0);
    const gives = open.map(i => Math.floor(left * weights[i] / total));
    if (gives.every(g => g === 0)) {                    // fewer slots than cells: one each, heaviest first
      for (const i of [...open].sort((a, b) => weights[b] - weights[a] || a - b).slice(0, left)) alloc[i]++;
      break;
    }
    open.forEach((i, k) => {
      const g = Math.min(gives[k], caps[i] - alloc[i]);
      alloc[i] += g;
      left -= g;
    });
  }
  return alloc;
}

// The even split: every cell the same, as far as capacities allow.
export const evenAllocation = (count, caps) => weightedAllocation(count, caps);

// Local, deterministic reshuffle of a list already sorted by difficulty, so the same key (a puzzle's
// shape or pair of shapes) doesn't come up again and again. Walk the list; at each step look at the next
// `window` puzzles not yet placed and take the first one whose key hasn't appeared among the last `gap`
// placed (or simply the first if every one has). So a puzzle moves only a little from its sorted
// position (a book stays easy to hard), nothing is random, and the same input gives the same order.
// `recent` seeds the history (the keys just before this list), so it can continue another list.
// (For spreadByTier, `recent` is the keys of whatever comes before the book's first tier, e.g. a tour.)
export const SPREAD_WINDOW = 40;
export const SPREAD_GAP = 4;
export function spreadOut(items, { key = x => x, window = SPREAD_WINDOW, gap = SPREAD_GAP, recent = [] } = {}) {
  const left = [...items];
  const out = [];
  const hist = [...recent];
  while (left.length) {
    const last = new Set(hist.slice(-gap));
    let pick = 0;
    for (let i = 0; i < Math.min(window, left.length); i++) {
      if (!last.has(key(left[i]))) { pick = i; break; }
    }
    const [item] = left.splice(pick, 1);
    out.push(item);
    hist.push(key(item));
  }
  return out;
}

// Spread a book's puzzles (sorted by tier, then score) tier by tier, so the tiers stay in order and
// puzzles only trade places inside their own tier. `tierOf` and `key` read a puzzle's tier and shape key.
export function spreadByTier(sorted, { tierOf = p => p.tier, key = p => p.tile, recent = [], ...opts } = {}) {
  const out = [];
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j < sorted.length && tierOf(sorted[j]) === tierOf(sorted[i])) j++;
    out.push(...spreadOut(sorted.slice(i, j), { key, ...opts, recent: [...recent, ...out.map(key)] }));
    i = j;
  }
  return out;
}
