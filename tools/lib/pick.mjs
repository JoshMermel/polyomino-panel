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

// Quotas per tier: `shares` is {tier: share} (any positive numbers); `avail` is
// {tier: how many candidates the pool has}. Each tier gets its share of `count`,
// capped by what is available; the shortfall is handed to tiers that still have
// spare candidates, largest share first, one puzzle at a time. Returns
// {quotas, short} where short is whatever could not be placed at all.
export function tierQuotas(count, shares, avail) {
  const tiers = Object.keys(shares);
  const total = tiers.reduce((a, t) => a + shares[t], 0) || 1;
  // largest-remainder rounding of the ideal allocation
  const ideal = Object.fromEntries(tiers.map(t => [t, count * shares[t] / total]));
  const quotas = Object.fromEntries(tiers.map(t => [t, Math.floor(ideal[t])]));
  let left = count - tiers.reduce((a, t) => a + quotas[t], 0);
  for (const t of [...tiers].sort((a, b) => (ideal[b] - Math.floor(ideal[b])) - (ideal[a] - Math.floor(ideal[a])))) {
    if (left <= 0) break;
    quotas[t]++; left--;
  }
  // cap by availability, then redistribute the deficit
  let deficit = 0;
  for (const t of tiers) {
    const have = avail[t] ?? 0;
    if (quotas[t] > have) { deficit += quotas[t] - have; quotas[t] = have; }
  }
  const byShare = [...tiers].sort((a, b) => shares[b] - shares[a]);
  while (deficit > 0) {
    let moved = false;
    for (const t of byShare) {
      if (deficit > 0 && quotas[t] < (avail[t] ?? 0) && shares[t] > 0) { quotas[t]++; deficit--; moved = true; }
    }
    if (!moved) {                                       // tiers with zero share may still help
      for (const t of byShare) {
        if (deficit > 0 && quotas[t] < (avail[t] ?? 0)) { quotas[t]++; deficit--; moved = true; }
      }
    }
    if (!moved) break;
  }
  return { quotas, short: deficit };
}

// Pick a book in tiers: each tier gets its quota (see tierQuotas) of puzzles
// spread evenly over that tier's own score range (pickEven). Candidates need
// `tier` and `score`. Returns { picks (tier order, then score), perTier, short }.
//   tiers   ordered list of tier names, easiest first
//   shares  {tier: share}
export function pickTiered(cands, { count, tiers, shares, tierKey = 'tier', low = 0.02, high = 0.98, seed = 1 }) {
  const groups = Object.fromEntries(tiers.map(t => [t, cands.filter(c => c[tierKey] === t)]));
  const avail = Object.fromEntries(tiers.map(t => [t, groups[t].length]));
  const { quotas, short } = tierQuotas(count, Object.fromEntries(tiers.map(t => [t, shares[t] ?? 0])), avail);
  const picks = [], perTier = {};
  for (const t of tiers) {
    // trim outliers only when the tier is big enough for percentiles to mean something
    const trim = groups[t].length >= 50 ? { low, high } : { low: 0, high: 1 };
    const r = quotas[t] > 0 ? pickEven(groups[t], { count: quotas[t], seed, ...trim }) : { picks: [], lo: 0, hi: 0 };
    perTier[t] = { quota: quotas[t], avail: avail[t], got: r.picks.length, lo: r.lo, hi: r.hi };
    picks.push(...r.picks);
  }
  return { picks, perTier, short };
}
