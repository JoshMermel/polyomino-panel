// Rates puzzles by the deduction rules needed to solve them, using the same rules
// as the hint system (see logic.js). The rules, easiest first:
//
//   forced      a cell has exactly one possible tile placement
//   lookahead2  a cell has two possible tiles and one would lead to a contradiction
//   edges       every possible tile for a cell (two or three of them) has a line on
//               some edge (draw it), or contains both cells beside some edge (mark it
//               with a cross)
//   tryLine     a line on an edge would leave a cell with no tile (mark it with a cross)
//   pocket      a line on an edge would wall off an enclosed region whose size the tiles cannot make up
//               (mark it with a cross)
//   lookahead3  a cell has three or more possible tiles; all but one lead to a
//               contradiction
//   edgesWide   the same edge reasoning over four or more possible tiles
//   eliminate   a cell has three or more possible tiles; some (not all but one) lead to a
//               contradiction, and the tiles that are left agree on an edge
//   chain       a cell has two possible tiles and one is eliminated only after following its
//               consequences (forced tiles, edges the candidate tiles agree on, edges where a line
//               would strand a cell) for several steps until something breaks
//
// A "contradiction" is a cell left with no placement, a region walled in by lines
// whose size is not a multiple of the tile (or, inside chains, whose chessboard
// colours are unbalanced).
//
// The solver always applies the easiest applicable rule and never looks at the
// stored solution. A puzzle's `rules` value is the hardest rule it needed
// ('unsolved' if the rules got stuck), and its `tier` is that rule's tier.
import {
  forcedTile, allForcedTiles, edgeDeduction, allEdgeDeductions, crossDeduction, allCrossDeductions, pocketDeduction, allPocketDeductions, lookaheadTile, allLookaheadTiles,
  chainTile, allChainTiles, eliminateTile, allEliminateTiles, newEdges, setEdge, cloneEdges, analyze, searchTilings,
  EDGE_LINE, EDGE_CROSS, LOOKAHEAD_2, LOOKAHEAD_3, EDGES_NARROW, EDGES_WIDE,
} from './logic.js';

// Difficulty tiers, easiest first. A puzzle's tier is the tier of the hardest rule it needs; Expert is for
// the puzzles the rules cannot finish at all (rules 'unsolved'), where Hint runs out of logical steps.
// (There used to be five tiers with a different split of Hard. The per-puzzle `rules` column keeps the finer information.)
export const TIERS = ['Beginner', 'Medium', 'Hard', 'Expert'];

// How the app presents each tier: its name and what it means.
export const TIER_INFO = {
  Beginner: { name: 'Beginner', blurb: 'only needs "this cell can only be covered one way" steps' },
  Medium: { name: 'Medium', blurb: 'needs edges that two or three candidate tiles agree on, an edge where a line would strand a cell or wall off an enclosed region, or trying one of two tiles and seeing it fail' },
  Hard: { name: 'Hard', blurb: 'needs edges shared by four or more candidate tiles, lookahead over three or more tiles, dropping the tiles that fail and comparing the rest, or a chain of consequences from a cell with two tiles' },
  Expert: { name: 'Expert', blurb: "the hint rules can't finish it: somewhere you have to try a tile and follow what it forces, further than Hint can explain" },
};

// Puzzles the deduction rules can't finish (their `rules` value is 'unsolved'): the Expert tier. They are also
// flagged "no logical hints" in the app so a player knows the hints will run dry.
export const beyondHints = puzzle => puzzle.rules === 'unsolved';

// The rule table. THIS is where rules are binned into tiers and given weights: to
// re-bin a rule, change its tier here and run tools/rescore_library.mjs (the stored
// `tier` column is derived from it); to change a weight, edit it and rescore.
// Listed easiest first; the solver (and the hint ladder in js/main.js, which reads
// this same table) tries them in this order. Fields:
//   find / findAll  the first / every deduction of this kind (see logic.js)
//   hintKind        how the app explains a deduction of this rule
// A chain (a tile hypothesis followed through several forced steps) is only used for a cell with just two
// possible tiles; branching over more tiles AND following chains is too much to keep in your head.
const CHAIN_OPTIONS = { maxOptions: 2 };

export const RULES = [
  { id: 'forced', tier: 'Beginner', weight: 1, hintKind: 'forced',
    find: forcedTile, findAll: allForcedTiles,
    label: 'only one tile fits a cell' },
  { id: 'lookahead2', tier: 'Medium', weight: 6, hintKind: 'lookahead2',
    find: (p, e) => lookaheadTile(p, e, LOOKAHEAD_2), findAll: (p, e) => allLookaheadTiles(p, e, LOOKAHEAD_2),
    label: 'two possible tiles, one fails' },
  { id: 'edges', tier: 'Medium', weight: 3, hintKind: 'edges',
    find: (p, e) => edgeDeduction(p, e, EDGES_NARROW), findAll: (p, e) => allEdgeDeductions(p, e, EDGES_NARROW),
    label: 'an edge that every one of two or three possible tiles agrees on' },
  { id: 'tryLine', tier: 'Medium', weight: 4, hintKind: 'tryLine',
    find: crossDeduction, findAll: allCrossDeductions,
    label: 'a line on an edge would leave a cell with no tile' },
  { id: 'pocket', tier: 'Medium', weight: 5, hintKind: 'pocket',
    find: pocketDeduction, findAll: allPocketDeductions,
    label: 'a line on an edge would wall off an enclosed region the tiles cannot fill' },
  { id: 'lookahead3', tier: 'Hard', weight: 16, hintKind: 'lookahead3',
    find: (p, e) => lookaheadTile(p, e, LOOKAHEAD_3), findAll: (p, e) => allLookaheadTiles(p, e, LOOKAHEAD_3),
    label: 'three or more possible tiles, all but one fail' },
  { id: 'edgesWide', tier: 'Hard', weight: 8, hintKind: 'edges',
    find: (p, e) => edgeDeduction(p, e, EDGES_WIDE), findAll: (p, e) => allEdgeDeductions(p, e, EDGES_WIDE),
    label: 'an edge that every one of four or more possible tiles agrees on' },
  { id: 'eliminate', tier: 'Hard', weight: 22, hintKind: 'eliminate',
    find: eliminateTile, findAll: allEliminateTiles,
    label: 'some of a cell\'s tiles fail; the ones left agree on an edge' },
  { id: 'chain', tier: 'Hard', weight: 30, hintKind: 'chain',
    find: (p, e) => chainTile(p, e, CHAIN_OPTIONS), findAll: (p, e) => allChainTiles(p, e, CHAIN_OPTIONS),
    label: 'one of a cell\'s two tiles fails after a chain of steps' },
];

// What each tile the rules could not place costs in the score.
export const UNDETERMINED_WEIGHT = 40;

export const RULE_IDS = RULES.map(r => r.id);
export const tierOfRule = id => (id === 'unsolved' ? 'Expert' : RULES.find(r => r.id === id).tier);
export const ruleLabel = id => (id === 'unsolved' ? 'none of the current rules finishes it' : RULES.find(r => r.id === id).label);

// Solve with the rules alone. Returns
//   rules      the hardest rule needed ('unsolved' if the rules got stuck)
//   tier       its tier (see TIERS)
//   counts     { ruleId: how many deductions of that rule were applied }
//   steps      total deductions
//   remaining  tiles still undetermined when the rules got stuck (0 if solved)
//   score      sum of the rules' weights over the deductions used, plus
//              UNDETERMINED_WEIGHT per undetermined tile. Puzzles the rules can't
//              finish also get a small tie-breaker (0-30) from how large a search
//              it takes to prove the solution unique, so stuck puzzles that make no
//              deductions at all still differ. (Drop it if the rules ever solve
//              everything.)
export function ratePuzzle(puzzle) {
  const edges = newEdges(puzzle);
  const counts = Object.fromEntries(RULE_IDS.map(id => [id, 0]));
  let steps = 0, hardest = -1;
  for (let guard = 0; guard < 10000; guard++) {
    let found = null, which = -1;
    for (let i = 0; i < RULES.length && !found; i++) { found = RULES[i].find(puzzle, edges); which = i; }
    if (!found) break;
    for (const [k, r, c] of found.lines ?? []) setEdge(puzzle, edges, k, r, c, EDGE_LINE);
    for (const [k, r, c] of found.crosses ?? []) setEdge(puzzle, edges, k, r, c, EDGE_CROSS);
    counts[RULES[which].id]++;
    steps++;
    hardest = Math.max(hardest, which);
  }
  const a = analyze(puzzle, edges);
  const remaining = (a.total ?? a.validCount) - a.validCount;
  const rules = !a.solved ? 'unsolved' : hardest < 0 ? RULES[0].id : RULES[hardest].id;
  let score = RULES.reduce((sum, r) => sum + counts[r.id] * r.weight, 0) + remaining * UNDETERMINED_WEIGHT;
  if (remaining > 0) {
    const nodes = searchTilings(puzzle, { limit: 2, keep: false }).nodes;
    score += Math.min(30, Math.round(2 * Math.log2(nodes + 1)));
  }
  return { rules, tier: tierOfRule(rules), counts, steps, remaining, score };
}

// Peeks. When no rule finds anything, the hint reveals one edge the solution has no line on (a cross). Which
// one? The one that sets off the most logical progress afterwards: for each candidate edge (in the order
// given), mark it, then count how many deductions the cheap rules (the Beginner and Medium ones) can make
// before they run dry (at most maxSteps). Returns [{ edge, gain }] sorted by gain, best first; candidates
// with equal gain keep the order given, so a caller can put its favourites first. Candidates the time
// budget did not reach get gain 0 (and keep their place among the zeros), so the call always takes about
// budgetMs at most, however big the board.
const PEEK_RULES = RULES.filter(r => r.tier !== 'Hard');
export function rankPeeks(puzzle, edges, candidates, { budgetMs = 250, maxSteps = 40, now = () => performance.now() } = {}) {
  const t0 = now();
  const gains = candidates.map(([kind, r, c]) => {
    if (now() - t0 > budgetMs) return 0;
    const trial = cloneEdges(edges);
    setEdge(puzzle, trial, kind, r, c, EDGE_CROSS);
    let steps = 0;
    for (; steps < maxSteps; steps++) {
      let found = null;
      for (let i = 0; i < PEEK_RULES.length && !found; i++) found = PEEK_RULES[i].find(puzzle, trial);
      if (!found) break;
      for (const [k, r2, c2] of found.lines ?? []) setEdge(puzzle, trial, k, r2, c2, EDGE_LINE);
      for (const [k, r2, c2] of found.crosses ?? []) setEdge(puzzle, trial, k, r2, c2, EDGE_CROSS);
    }
    return steps;
  });
  return candidates.map((edge, i) => ({ edge, gain: gains[i], i }))
    .sort((a, b) => b.gain - a.gain || a.i - b.i).map(({ edge, gain }) => ({ edge, gain }));
}

// Order puzzles by rating: easier tier first, then lower score.
export function compareRatings(a, b) {
  const rank = x => TIERS.indexOf(x.tier);
  return rank(a) - rank(b) || a.score - b.score || a.steps - b.steps;
}

// Rate every puzzle, sort easiest first, renumber as `${prefix}_NN`, and store the
// rating in puzzle.rules / .tier / .score. Returns { puzzles, counts } where counts
// maps tier -> number of puzzles.
export function sortByRules(puzzles, prefix) {
  const rated = puzzles.map(p => ({ p, rating: ratePuzzle(p) }));
  rated.sort((x, y) => compareRatings(x.rating, y.rating));
  const pad = String(rated.length).length;
  const counts = Object.fromEntries(TIERS.map(t => [t, 0]));
  const out = rated.map(({ p, rating }, i) => {
    counts[rating.tier]++;
    return {
      ...p, name: `${prefix}_${String(i + 1).padStart(Math.max(2, pad), '0')}`,
      rules: rating.rules, tier: rating.tier, score: rating.score,
    };
  });
  return { puzzles: out, counts };
}
