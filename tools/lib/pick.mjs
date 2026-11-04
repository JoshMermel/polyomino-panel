// Choose `count` puzzles from a scored pool so that scores are spread as evenly
// as the pool allows across a score range (the same idea as multiverse star
// battle's book builder): split the range into `count` equal bins and, for each
// bin in turn, claim the unused candidate whose score is nearest the bin's
// centre. Ties are broken by a hash of the puzzle's name and the seed, so
// rescoring or re-sorting a pool doesn't reshuffle which equal-scored puzzle
// is picked.

export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// cands: [{name, score, ...}]
// opts:  count; low/high = percentiles (0..1) of the pool's scores that bound the
//        range; or range: [lo, hi] absolute scores (wins over percentiles); seed.
// Returns { picks (ascending by score), lo, hi, short }.
export function pickEven(cands, { count, low = 0.02, high = 0.98, range = null, seed = 1 }) {
  const sorted = [...cands].sort((a, b) => a.score - b.score || (a.name < b.name ? -1 : 1));
  const n = sorted.length;
  if (n === 0) return { picks: [], lo: 0, hi: 0, short: count };
  const q = f => sorted[Math.min(n - 1, Math.max(0, Math.round(f * (n - 1))))].score;
  const lo = range ? range[0] : q(low), hi = range ? range[1] : q(high);
  if (n <= count) return { picks: sorted, lo, hi, short: count - n };

  const tie = c => hashString(`${c.name}#${seed}`);
  const used = new Uint8Array(n);
  const picked = [];
  for (let i = 0; i < count; i++) {
    const center = lo + (i + 0.5) * (hi - lo) / count;
    // first index with score >= center (binary search)
    let a = 0, b = n;
    while (a < b) { const m = (a + b) >> 1; if (sorted[m].score < center) a = m + 1; else b = m; }
    // expand outward to the nearest unused candidate(s); among equally near ones take the lowest tie-hash
    let best = -1, bestDist = Infinity;
    for (let step = 0; step < n; step++) {
      const left = a - 1 - step, right = a + step;
      const dl = left >= 0 ? Math.abs(sorted[left].score - center) : Infinity;
      const dr = right < n ? Math.abs(sorted[right].score - center) : Infinity;
      if (Math.min(dl, dr) > bestDist) break;                // nothing closer can follow
      for (const [idx, d] of [[left, dl], [right, dr]]) {
        if (idx < 0 || idx >= n || used[idx]) continue;
        if (d < bestDist || (d === bestDist && tie(sorted[idx]) < tie(sorted[best]))) { best = idx; bestDist = d; }
      }
    }
    used[best] = 1;
    picked.push(sorted[best]);
  }
  picked.sort((x, y) => x.score - y.score || (x.name < y.name ? -1 : 1));
  return { picks: picked, lo, hi, short: 0 };
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
