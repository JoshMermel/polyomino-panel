// Make "given edge" puzzles: a sparse board with just a few (2 to 4) distinct tilings becomes a puzzle
// with ONE solution by pre-drawing an edge or two for the player (a line where the intended solution
// has a tile boundary, a cross where two cells share a tile).
//
//   node tools/make_given_puzzles.mjs [--out tools/books/experiments.csv] [--per 3] [--sizes 6,8,10]
//        [--tiles L,T,S,P5,...] [--minutes 8] [--seed N] [--max-givens 2]
//        [--cross-clues 1] [--add-to tools/books/experiments.csv]
//        [--balanced 1] [--max-solutions 120] [--min-givens 5] [--max-givens 10]
// Shapes are tried in proportion to tools/lib/tile_weights.mjs (line pieces rarely); in --balanced mode a
// size-and-tier bucket holds at most --max-per-tile puzzles of one shape.
// --cross-clues keeps only puzzles with at least one given cross ("these two cells share a tile") among
// their givens; --add-to adds the new puzzles to an existing book file instead of replacing it.
// --balanced makes puzzles with FEW blocked cells (2 to 8% of the board) and MANY given edges (at least
// --min-givens, a mix of lines and crosses): the layout has up to --max-solutions tilings, and a greedy
// cover picks the edges (each kills as many of the other tilings as it can) until one tiling is left;
// extra true edges are added up to --min-givens so the clues are balanced between cells and edges.
//
// For each board size it generates layouts that have 2 to 4 solutions (the generator's local search with
// minSolutions/maxSolutions), lists every solution, and looks for the smallest set of edges (one, else
// two) on which the intended solution differs from every other. The puzzle is then rated WITH its
// givens (they start as marks, see logic.newEdges) and goes into a bucket for its size and tier; the
// tool keeps up to --per puzzles per size and tier, as varied in shape as it can, and writes the book
// file (sorted by tier, then score). Nothing here touches data/: tools/build_books.mjs picks the file up
// (the "Experiments" group in tools/books/collections.json).
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import {
  toCsv, parseCsv, solve, solveWithGivens, isPlayableEdge, hasSwastika,
} from '../js/logic.js';
import './lib/wasm_counter.mjs';
import { generatePuzzle, mulberry32, holeLadder, canonicalGrid } from '../js/generator.js';
import { ratePuzzle, TIERS } from '../js/rating.js';
import { weightedPick, tileCap } from './lib/tile_weights.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]]);
  return acc;
}, []));
const out = args.out ?? new URL('./books/experiments.csv', import.meta.url).pathname;
const per = Number(args.per ?? 3);
const sizes = (args.sizes ?? '6,8,10').split(',').map(Number);
const tiles = (args.tiles ?? 'L,T,S,P5,V3,I3,Y5,N5,F5,W5,L5,L+T,T+S,L+S,V3+I3').split(',');
const maxMs = Number(args.minutes ?? 8) * 60000;
const balanced = 'balanced' in args;
const maxGivens = Number(args['max-givens'] ?? (balanced ? 10 : 2));
const crossClues = 'cross-clues' in args;
const maxSolutions = Number(args['max-solutions'] ?? (balanced ? 120 : 4));
const minGivens = Number(args['min-givens'] ?? (balanced ? 5 : 1));
const addTo = args['add-to'];
const maxPerTile = Number(args['max-per-tile'] ?? Math.max(1, Math.ceil(per / 4)));
const rng = mulberry32(Number(args.seed ?? 11));
const pick = arr => arr[Math.floor(rng() * arr.length)];

// every playable edge of a puzzle, and for one solution which of them are lines (tile boundaries)
function edgeList(puzzle) {
  const list = [];
  for (let r = 0; r < puzzle.rows; r++) for (let c = 0; c < puzzle.cols; c++) {
    if (c > 0 && isPlayableEdge(puzzle, 'v', r, c)) list.push(['v', r, c]);
    if (r > 0 && isPlayableEdge(puzzle, 'h', r, c)) list.push(['h', r, c]);
  }
  return list;
}
const isLine = (puzzle, sol, [kind, r, c]) => {
  const { cols } = puzzle;
  const a = kind === 'v' ? r * cols + c - 1 : (r - 1) * cols + c;
  return sol[a] !== sol[r * cols + c];
};

// Smallest sets of edges (<= maxGivens) that single out `target` among `solutions`; null if none.
function givenSets(puzzle, solutions, target) {
  const others = solutions.filter(s => s !== target);
  const edges = edgeList(puzzle);
  const kills = edges.map(e => others.map(o => isLine(puzzle, o, e) !== isLine(puzzle, target, e)));
  const sets = [];
  for (let i = 0; i < edges.length; i++) if (kills[i].every(Boolean)) sets.push([i]);
  if (!sets.length && maxGivens >= 2) {
    for (let i = 0; i < edges.length; i++) {
      for (let j = i + 1; j < edges.length; j++) {
        if (others.every((_, k) => kills[i][k] || kills[j][k])) sets.push([i, j]);
        if (sets.length > 400) break;
      }
      if (sets.length > 400) break;
    }
  }
  return sets.map(set => set.map(i => {
    const e = edges[i];
    return [isLine(puzzle, target, e) ? 'L' : 'X', ...e];
  }));
}

// Balanced mode: a greedy set of edges (lines and crosses, true in `target`) that kills every other
// solution; then extra true edges up to `minGivens`, alternating line / cross. Null if it takes more than maxGivens.
function greedyGivens(puzzle, solutions, target) {
  const others = solutions.filter(s => s !== target);
  const edges = edgeList(puzzle);
  const kills = edges.map(e => others.map(o => isLine(puzzle, o, e) !== isLine(puzzle, target, e)));
  const alive = new Set(others.keys());
  const chosen = [];
  while (alive.size) {
    if (chosen.length >= maxGivens) return null;
    let best = 0;
    const gains = edges.map((_, i) => { if (chosen.includes(i)) return 0; let g = 0; for (const k of alive) if (kills[i][k]) g++; best = Math.max(best, g); return g; });
    if (!best) return null;
    // among the edges that kill nearly as many as the best, take a random one (varied, not always the same kind)
    const top = gains.map((g, i) => [g, i]).filter(([g]) => g >= Math.max(1, Math.ceil(best * 0.7)));
    const [, pickedEdge] = pick(top);
    chosen.push(pickedEdge);
    for (const k of [...alive]) if (kills[pickedEdge][k]) alive.delete(k);
  }
  // extras: random true edges until there are minGivens clues, about half lines and half crosses
  const lineEdges = edges.map((e, i) => i).filter(i => isLine(puzzle, target, edges[i]));
  const crossEdges = edges.map((e, i) => i).filter(i => !isLine(puzzle, target, edges[i]));
  let wantLine = chosen.filter(i => isLine(puzzle, target, edges[i])).length <= chosen.length / 2;
  for (let guard = 0; chosen.length < minGivens && guard < 200; guard++) {
    const pool = (wantLine ? lineEdges : crossEdges).filter(i => !chosen.includes(i));
    if (pool.length) { chosen.push(pick(pool)); wantLine = !wantLine; } else wantLine = !wantLine;
  }
  return chosen.map(i => [isLine(puzzle, target, edges[i]) ? 'L' : 'X', ...edges[i]]);
}

const buckets = new Map();                         // `${size}|${tier}` -> puzzles
const seen = new Set();
const t0 = Date.now();
let tried = 0, found = 0;
const full = () => sizes.every(s => TIERS.every(t => (buckets.get(`${s}|${t}`) ?? []).length >= per));
while (Date.now() - t0 < maxMs && !full()) {
  const size = pick(sizes), tile = weightedPick(rng, tiles);
  const ladder = holeLadder(size, size, tile);
  const target = size * size * pick(balanced ? [0.02, 0.04, 0.06, 0.08] : [0.06, 0.09, 0.12, 0.15, 0.2, 0.26]);
  const holes = ladder.reduce((best, k) => (Math.abs(k - target) < Math.abs(best - target) ? k : best), ladder[0]);
  tried++;
  const res = generatePuzzle({ rows: size, cols: size, tile, holes, rng, maxMs: 8000, minSolutions: balanced ? 6 : 2, maxSolutions, cap: maxSolutions + 1 });
  if (!res) continue;
  const base = res.puzzle;
  const solutions = solve(base, maxSolutions + 1);
  if (solutions.length < (balanced ? 6 : 2) || solutions.length > maxSolutions) continue;
  const key = `${tile}|${canonicalGrid(base.grid, size, size)}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const clean = solutions.filter(sol => !hasSwastika(base, sol));      // never publish a swastika in the solution
  if (!clean.length) continue;
  const intended = pick(clean);
  if (balanced) {
    const givens = greedyGivens(base, solutions, intended);
    if (!givens) continue;
    const puzzle = { ...base, solution: intended, givens };
    if (solveWithGivens(puzzle, 2).length !== 1) continue;
    const r = ratePuzzle(puzzle);
    Object.assign(puzzle, { rules: r.rules, tier: r.tier, score: r.score, _tile: tile, _solutions: solutions.length });
    const bucket = buckets.get(`${size}|${r.tier}`) ?? [];
    if (bucket.length < per && bucket.filter(q => q.tile === tile).length < tileCap(tile, maxPerTile)) { bucket.push(puzzle); buckets.set(`${size}|${r.tier}`, bucket); found++; }
    continue;
  }
  const sets = givenSets(base, solutions, intended);
  if (!sets.length) continue;
  const best = Math.min(...sets.map(s => s.length));
  const choices = sets.filter(s => s.length === best);
  // lines read better than crosses as pre-drawn clues: prefer sets that are all lines (unless crosses are wanted)
  const lines = choices.filter(s => s.every(g => g[0] === 'L'));
  const withCross = choices.filter(s => s.some(g => g[0] === 'X'));
  if (crossClues && !withCross.length) continue;
  const givens = crossClues ? pick(withCross) : pick(lines.length ? lines : choices);
  const puzzle = { ...base, solution: intended, givens };
  if (solveWithGivens(puzzle, 2).length !== 1) throw new Error('internal error: givens do not give a unique solution');
  const r = ratePuzzle(puzzle);
  Object.assign(puzzle, { rules: r.rules, tier: r.tier, score: r.score, _tile: tile, _solutions: solutions.length });
  const bucket = buckets.get(`${size}|${r.tier}`) ?? [];
  if (bucket.length >= per) {
    // swap in if this puzzle adds a shape the bucket doesn't have yet
    if (bucket.some(p => p.tile === puzzle.tile) || !bucket.some(p => bucket.filter(q => q.tile === p.tile).length > 1)) continue;
    const dup = bucket.findIndex(p => bucket.filter(q => q.tile === p.tile).length > 1);
    bucket[dup] = puzzle;
  } else bucket.push(puzzle);
  buckets.set(`${size}|${r.tier}`, bucket);
  found++;
}

const existing = addTo && existsSync(addTo) ? parseCsv(readFileSync(addTo, 'utf8')) : [];
const all = [...existing, ...[...buckets.values()].flat()].sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) || a.score - b.score);
const book = all.map((p, i) => ({
  ...p, name: `experiments_${String(i + 1).padStart(2, '0')}`,
}));
const header = '# Experiments: puzzles with a few distinct tilings made unique by pre-drawn edges (the given column: L = a line, X = a cross).\n' +
  '# Built by tools/make_given_puzzles.mjs. grid: # = blocked cell, . = open cell. solution: tile labels. given: edges drawn for the player.\n';
writeFileSync(addTo ?? out, header + toCsv(book));
const summary = sizes.map(s => `${s}x${s}: ` + TIERS.map(t => `${t} ${(buckets.get(`${s}|${t}`) ?? []).length}`).join(' ')).join(' | ');
console.log(`${book.length} puzzles (${found} found from ${tried} layouts in ${((Date.now() - t0) / 60000).toFixed(1)} min) -> ${out}\n${summary}`);
console.log('solutions before givens:', JSON.stringify(book.filter(p => p._solutions).reduce((m, p) => ((m[p._solutions] = (m[p._solutions] ?? 0) + 1), m), {})), 'givens:', JSON.stringify(book.reduce((m, p) => ((m[p.givens.length] = (m[p.givens.length] ?? 0) + 1), m), {})));
