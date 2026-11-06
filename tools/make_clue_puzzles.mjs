// Make "minimal void" clue puzzles: a board with as FEW blocked cells as can still be tiled (just enough
// that the number of open cells divides into tiles and some tiling exists), made uniquely solvable purely
// by pre-drawn edges. Such a board has astronomically many tilings, so the clues do all the work.
//
//   node tools/make_clue_puzzles.mjs --mode lines|crosses|both --out tools/books/clues_lines.csv
//        [--per 6] [--sizes 6,8,10] [--tiles L,T,S,...] [--minutes 8] [--seed N] [--min-each 2]
//        [--max-void 0.12] [--min-clues 2] [--max-per-tile 3]
// Shapes are tried in proportion to tools/lib/tile_weights.mjs (line pieces rarely), and a size-and-tier
// bucket holds at most --max-per-tile puzzles of one shape.
//
// --max-void: skip a shape and size whose smallest tileable board (as the search finds it) needs more than
// this fraction of the board blocked. --min-clues: skip boards that need fewer clues (a layout that is
// already unique, or one clue away from it, is not a clue puzzle).
// --mode lines: every clue is a line (a tile boundary); crosses: every clue is a cross (two cells share a
// tile); both: a mix (at least --min-each of each).
//
// Per attempt: pick a size and a shape; the smallest number of blocked cells that fits (the "parity" of the
// board: area divisible by the tile, then actually tileable, tried rung by rung); a random tiling is the
// intended solution; clues are added (random true edges of the allowed kind that rule out another tiling
// the search finds) until the solution is unique, then every clue that turned out redundant is dropped.
// The puzzle is rated WITH its clues (logic.newEdges) and kept in a bucket for its size and tier.
import { writeFileSync } from 'node:fs';
import {
  toCsv, searchTilings, labelString, solveWithGivens, isPlayableEdge, hasSwastika,
} from '../js/logic.js';
import './lib/wasm_counter.mjs';
import { mulberry32, holeLadder, randomInitial, puzzleFromState } from '../js/generator.js';
import { ratePuzzle, TIERS } from '../js/rating.js';
import { weightedPick, tileCap } from './lib/tile_weights.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]]);
  return acc;
}, []));
const mode = args.mode ?? 'both';
if (!['lines', 'crosses', 'both'].includes(mode)) throw new Error('--mode must be lines, crosses or both');
const out = args.out ?? new URL(`./books/clues_${mode}.csv`, import.meta.url).pathname;
const per = Number(args.per ?? 6);
const sizes = (args.sizes ?? '6,8,10').split(',').map(Number);
const tiles = (args.tiles ?? 'I2,I3,V3,L,I,T,S,F5,L5,N5,P5,U5,V5,W5,Y5,Z5').split(',');
const maxMs = Number(args.minutes ?? 8) * 60000;
const minEach = Number(args['min-each'] ?? 2);
const maxVoid = Number(args['max-void'] ?? 0.12);
const minClues = Number(args['min-clues'] ?? 2);
const maxPerTile = Number(args['max-per-tile'] ?? Math.max(1, Math.ceil(per / 4)));
const NODE_BUDGET = 400000;
const rng = mulberry32(Number(args.seed ?? 21));
const pick = arr => arr[Math.floor(rng() * arr.length)];
const shuffled = arr => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

const edgeCells = (cols, [kind, r, c]) => [kind === 'v' ? r * cols + c - 1 : (r - 1) * cols + c, r * cols + c];

// The minimal-void start: a random (blocked cells, tiling) with the fewest blocked cells that works.
function minimalVoidState(size, tile) {
  for (const holes of holeLadder(size, size, tile, maxVoid)) {
    const state = randomInitial(size, size, tile, holes, rng, 40);
    if (state) return { state, holes };
  }
  return null;
}

// Clues for one puzzle: [['L'|'X', kind, r, c], ...], or null if it gets too many or the search is too heavy.
function makeClues(puzzle, intended) {
  const { rows, cols } = puzzle;
  const edges = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (c > 0 && isPlayableEdge(puzzle, 'v', r, c)) edges.push(['v', r, c]);
    if (r > 0 && isPlayableEdge(puzzle, 'h', r, c)) edges.push(['h', r, c]);
  }
  const truth = edges.map(e => { const [a, b] = edgeCells(cols, e); return intended[a] !== intended[b] ? 'L' : 'X'; });
  const allowed = i => mode === 'both' || (mode === 'lines') === (truth[i] === 'L');
  const asGivens = set => [...set].map(i => [truth[i], ...edges[i]]);
  const check = set => searchTilings({ ...puzzle, givens: null }, { limit: 2, budget: NODE_BUDGET, givens: asGivens(set) });

  const chosen = new Set();
  for (let step = 0; step < 300; step++) {
    const res = check(chosen);
    if (res.aborted) return null;
    if (res.count === 1) break;
    const other = res.tilings.map(labelString).find(s => s !== intended);
    if (!other) return null;
    // clues that tell `other` apart from the intended tiling: edges whose state differs
    const killers = [];
    edges.forEach((e, i) => {
      if (chosen.has(i) || !allowed(i)) return;
      const [a, b] = edgeCells(cols, e);
      if ((other[a] !== other[b]) !== (truth[i] === 'L')) killers.push(i);
    });
    if (!killers.length) return null;
    if (mode === 'both') {
      // keep the mix balanced: prefer the kind that is currently rarer among the clues
      const have = [...chosen].filter(i => truth[i] === 'L').length;
      const wantLine = have <= chosen.size / 2;
      const preferred = killers.filter(i => (truth[i] === 'L') === wantLine);
      chosen.add(pick(preferred.length ? preferred : killers));
    } else chosen.add(pick(killers));
  }
  if (check(chosen).count !== 1) return null;
  // drop every clue the others make redundant
  for (const i of shuffled([...chosen])) {
    chosen.delete(i);
    const res = check(chosen);
    if (res.aborted || res.count !== 1) chosen.add(i);
  }
  return asGivens(chosen);
}

const buckets = new Map();
const t0 = Date.now();
let tried = 0, found = 0;
const full = () => sizes.every(s => TIERS.every(t => (buckets.get(`${s}|${t}`) ?? []).length >= per));
while (Date.now() - t0 < maxMs && !full()) {
  const size = pick(sizes), tile = weightedPick(rng, tiles);
  const start = minimalVoidState(size, tile);
  if (!start) continue;
  tried++;
  const base = puzzleFromState(start.state, size, size, tile);
  const intended = base.solution;
  if (hasSwastika(base, intended)) continue;
  const givens = makeClues(base, intended);
  if (!givens || givens.length < minClues) continue;
  const nLines = givens.filter(g => g[0] === 'L').length, nCross = givens.length - nLines;
  if (mode === 'both' && (nLines < minEach || nCross < minEach)) continue;
  const puzzle = { ...base, givens };
  if (solveWithGivens(puzzle, 2).length !== 1) throw new Error('internal error: clues do not give a unique solution');
  const r = ratePuzzle(puzzle);
  Object.assign(puzzle, { rules: r.rules, tier: r.tier, score: r.score, _holes: start.holes });
  const bucket = buckets.get(`${size}|${r.tier}`) ?? [];
  if (bucket.length < per && bucket.filter(q => q.tile === tile).length < tileCap(tile, maxPerTile)) { bucket.push(puzzle); buckets.set(`${size}|${r.tier}`, bucket); found++; }
}

const all = [...buckets.values()].flat().sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) || a.score - b.score);
const book = all.map((p, i) => ({ ...p, name: `clues_${mode}_${String(i + 1).padStart(2, '0')}` }));
const header = `# Minimal-void clue puzzles (${mode}): the fewest blocked cells that still allow a tiling, made unique by pre-drawn edges only (the given column: L = a line, X = a cross).\n` +
  '# Built by tools/make_clue_puzzles.mjs. grid: # = blocked cell, . = open cell. solution: tile labels. given: edges drawn for the player.\n';
writeFileSync(out, header + toCsv(book));
const summary = sizes.map(s => `${s}x${s}: ` + TIERS.map(t => `${t} ${(buckets.get(`${s}|${t}`) ?? []).length}`).join(' ')).join(' | ');
console.log(`${book.length} puzzles (${found} kept from ${tried} boards in ${((Date.now() - t0) / 60000).toFixed(1)} min) -> ${out}\n${summary}`);
const stat = f => { const v = book.map(f); return v.length ? `${Math.min(...v)}-${Math.max(...v)} (avg ${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1)})` : '-'; };
console.log('clues:', stat(p => p.givens.length), ' blocked cells:', stat(p => p._holes), ' crosses:', stat(p => p.givens.filter(g => g[0] === 'X').length));
