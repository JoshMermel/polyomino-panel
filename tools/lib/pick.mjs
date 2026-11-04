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

// Split `count` slots across cells as evenly as their capacities allow: every cell gets the
// same number, except that a cell with fewer candidates than that gives up what it can't fill
// and the others share the difference (water-filling). `caps` is the number of candidates in
// each cell; returns the allocation, same order. The total is min(count, sum of caps).
export function evenAllocation(count, caps) {
  const alloc = new Array(caps.length).fill(0);
  let left = Math.min(count, caps.reduce((a, b) => a + b, 0));
  for (;;) {
    const open = caps.map((c, i) => i).filter(i => alloc[i] < caps[i]);
    if (left <= 0 || !open.length) break;
    const each = Math.floor(left / open.length);
    if (each === 0) {                                  // fewer slots than cells: one each, in order
      for (const i of open.slice(0, left)) alloc[i]++;
      break;
    }
    for (const i of open) {
      const give = Math.min(each, caps[i] - alloc[i]);
      alloc[i] += give;
      left -= give;
    }
  }
  return alloc;
}
