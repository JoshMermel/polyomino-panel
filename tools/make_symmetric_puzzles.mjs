// Make symmetric puzzles: boards whose blocked cells are symmetric (a rotation and/or a mirror), in two kinds.
//
//   node tools/make_symmetric_puzzles.mjs --mode voids|clues --out tools/books/sym_voids.csv
//        [--per 6] [--sizes 6,8,10] [--tiles L,T,...] [--syms rot180,rot90,mirror,diag,axes,diags,full]
//        [--minutes 8] [--seed N] [--max-void 0.2] [--min-clues 4] [--min-each 2] [--max-clues 30]
//        [--max-per-tile 2] [--max-per-sym 3]
//
// --mode voids: symmetric blocked cells and NO clues; the tiling is unique on its own. (Tiles may be placed in
//   every orientation, so a symmetric board with one solution has a symmetric solution.) Boards with few
//   blocked cells are preferred: the number of blocked cells is drawn from the smallest rungs of the ladder
//   of area-divisible counts, and --max-void caps it as a fraction of the board.
// --mode clues: symmetric blocked cells (the fewest that let the board be tiled at all, found among the
//   symmetric layouts) and pre-drawn edges whose POSITIONS are symmetric: a clue on an edge puts a clue on
//   every image of that edge, and each takes the type the intended tiling gives it (a line where it has a
//   tile boundary, a cross where two cells share a tile). The intended tiling is not symmetric, so an edge's
//   image may be a line while the edge is a cross. Clues are added orbit by orbit until the tiling is unique,
//   then orbits that turned out redundant are dropped.
//
// Shapes are tried in proportion to tools/lib/tile_weights.mjs; a size-and-tier bucket holds at most
// --max-per-tile puzzles of one shape and --max-per-sym of one symmetry. The puzzle is rated with its clues
// and written, sorted by tier then score. Nothing here touches data/ (see the Experiments groups in
// tools/books/collections.json).
import { writeFileSync } from 'node:fs';
import {
  toCsv, searchTilings, labelString, solveWithGivens, isPlayableEdge, hasSwastika, openCellsConnected, countSolutions, solve,
} from '../js/logic.js';
import './lib/wasm_counter.mjs';
import { mulberry32, holeLadder, canonicalGrid } from '../js/generator.js';
import { ratePuzzle, TIERS } from '../js/rating.js';
import { weightedPick, tileCap } from './lib/tile_weights.mjs';
import { SYMMETRIES, orbits, groupMaps } from './lib/symmetry.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]]);
  return acc;
}, []));
const mode = args.mode ?? 'voids';
if (!['voids', 'clues'].includes(mode)) throw new Error('--mode must be voids or clues');
const out = args.out ?? new URL(`./books/sym_${mode}.csv`, import.meta.url).pathname;
const per = Number(args.per ?? 6);
const sizes = (args.sizes ?? '6,8,10').split(',').map(Number);
const tiles = (args.tiles ?? 'I2,I3,V3,L,I,T,S,F5,L5,N5,P5,U5,V5,W5,Y5,Z5').split(',');
const syms = (args.syms ?? Object.keys(SYMMETRIES).join(',')).split(',');
for (const s of syms) if (!SYMMETRIES[s]) throw new Error(`unknown symmetry ${s}`);
const maxMs = Number(args.minutes ?? 8) * 60000;
const maxVoid = Number(args['max-void'] ?? 0.2);
const minClues = Number(args['min-clues'] ?? 4);
const minEach = Number(args['min-each'] ?? 2);
const maxClues = Number(args['max-clues'] ?? 30);
const maxPerTile = Number(args['max-per-tile'] ?? Math.max(1, Math.ceil(per / 4)));
const maxPerSym = Number(args['max-per-sym'] ?? Math.max(1, Math.ceil(per / 2)));
const NODE_BUDGET = 400000;
const rng = mulberry32(Number(args.seed ?? 31));
const pick = arr => arr[Math.floor(rng() * arr.length)];
const shuffled = arr => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

const orbitCache = new Map();
const orbitsOf = (sym, n) => { const k = `${sym}|${n}`; if (!orbitCache.has(k)) orbitCache.set(k, orbits(sym, n)); return orbitCache.get(k); };

// A random symmetric set of exactly k blocked cells (a union of orbits), as a grid string, or null.
function symmetricGrid(sym, n, k) {
  const chosen = [];
  let total = 0;
  for (const o of shuffled(orbitsOf(sym, n))) {
    if (total + o.length > k) continue;
    chosen.push(o); total += o.length;
    if (total === k) break;
  }
  if (total !== k) return null;
  const g = Array(n * n).fill('.');
  for (const o of chosen) for (const i of o) g[i] = '#';
  return g.join('');
}

// Rungs of the hole ladder to draw from, the smallest most often.
function pickRung(ladder) {
  let r = 0;
  while (r < ladder.length - 1 && rng() < 0.4) r++;
  return ladder[r];
}

// --- clues mode ----------------------------------------------------------------------------------------
const edgeCells = (cols, [kind, r, c]) => [kind === 'v' ? r * cols + c - 1 : (r - 1) * cols + c, r * cols + c];

// Edge orbits of a board under a symmetry class: the playable edges and, for each, the indices of its images.
function edgeOrbits(puzzle, sym) {
  const { rows, cols } = puzzle;
  const edges = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (c > 0 && isPlayableEdge(puzzle, 'v', r, c)) edges.push(['v', r, c]);
    if (r > 0 && isPlayableEdge(puzzle, 'h', r, c)) edges.push(['h', r, c]);
  }
  const key = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const index = new Map(edges.map((e, i) => { const [a, b] = edgeCells(cols, e); return [key(a, b), i]; }));
  const maps = groupMaps(sym, rows);
  const orbitOf = edges.map((e, i) => {
    const [a, b] = edgeCells(cols, e);
    return [...new Set(maps.map(m => index.get(key(m[a], m[b]))))];
  });
  return { edges, orbitOf };
}

// Clues for one puzzle: [['L'|'X', kind, r, c], ...], or null if too many or the search is too heavy.
function makeSymmetricClues(puzzle, intended, sym) {
  const { cols } = puzzle;
  const { edges, orbitOf } = edgeOrbits(puzzle, sym);
  const truth = edges.map(e => { const [a, b] = edgeCells(cols, e); return intended[a] !== intended[b] ? 'L' : 'X'; });
  const asGivens = set => [...set].map(i => [truth[i], ...edges[i]]);
  const check = set => searchTilings({ ...puzzle, givens: null }, { limit: 2, budget: NODE_BUDGET, givens: asGivens(set) });

  const chosen = new Set();
  for (let step = 0; step < 100 && chosen.size <= maxClues; step++) {
    const res = check(chosen);
    if (res.aborted) return null;
    if (res.count === 1) break;
    const other = res.tilings.map(labelString).find(s => s !== intended);
    if (!other) return null;
    const killers = [];
    edges.forEach((e, i) => {
      if (chosen.has(i)) return;
      const [a, b] = edgeCells(cols, e);
      if ((other[a] !== other[b]) !== (truth[i] === 'L')) killers.push(i);
    });
    if (!killers.length) return null;
    for (const j of orbitOf[pick(killers)]) chosen.add(j);
  }
  if (chosen.size > maxClues || check(chosen).count !== 1) return null;
  // drop every orbit the others make redundant
  const seenOrbit = new Set();
  for (const i of shuffled([...chosen])) {
    const orbit = orbitOf[i], id = Math.min(...orbit);
    if (seenOrbit.has(id)) continue;
    seenOrbit.add(id);
    if (!orbit.every(j => chosen.has(j))) continue;
    orbit.forEach(j => chosen.delete(j));
    const res = check(chosen);
    if (res.aborted || res.count !== 1) orbit.forEach(j => chosen.add(j));
  }
  return asGivens(chosen);
}

// The fewest blocked cells (a symmetric layout) that still let the board be tiled, with a random tiling.
function minimalSymmetricState(size, tile, sym) {
  const ladder = holeLadder(size, size, tile, maxVoid);
  for (const k of ladder.slice(0, 4)) {
    for (let t = 0; t < 120; t++) {
      const grid = symmetricGrid(sym, size, k);
      if (!grid) break;                                   // no union of orbits has exactly k cells
      const puzzle = { rows: size, cols: size, tile, grid };
      if (!openCellsConnected(puzzle)) continue;
      const res = searchTilings(puzzle, { limit: 1, rng, budget: 20000 });
      if (res.tilings.length) return { puzzle, holes: k, intended: labelString(res.tilings[0]) };
    }
  }
  return null;
}

// --- the search -------------------------------------------------------------------------------------------
const buckets = new Map();
const seenBoards = new Set();
const t0 = Date.now();
let tried = 0, found = 0;
const full = () => sizes.every(s => TIERS.every(t => (buckets.get(`${s}|${t}`) ?? []).length >= per));
const keptBoards = new Set();                      // a board (up to rotation and mirror) is in the book at most once
function keep(puzzle, sym, extra) {
  const boardKey = `${puzzle.tile}|${canonicalGrid(puzzle.grid, puzzle.rows, puzzle.cols)}`;
  if (keptBoards.has(boardKey)) return;
  const r = ratePuzzle(puzzle);
  Object.assign(puzzle, { rules: r.rules, tier: r.tier, score: r.score, _sym: sym, ...extra });
  const bucket = buckets.get(`${puzzle.rows}|${r.tier}`) ?? [];
  if (bucket.length < per && bucket.filter(q => q.tile === puzzle.tile).length < tileCap(puzzle.tile, maxPerTile) &&
      bucket.filter(q => q._sym === sym).length < maxPerSym) {
    bucket.push(puzzle); buckets.set(`${puzzle.rows}|${r.tier}`, bucket); keptBoards.add(boardKey); found++;
  }
}

while (Date.now() - t0 < maxMs && !full()) {
  const size = pick(sizes), tile = weightedPick(rng, tiles), sym = pick(syms);
  if (mode === 'voids') {
    const ladder = holeLadder(size, size, tile, maxVoid);
    if (!ladder.length) continue;
    const k = pickRung(ladder);
    const grid = symmetricGrid(sym, size, k);
    if (!grid) continue;
    const base = { rows: size, cols: size, tile, grid };
    const key = `${tile}|${canonicalGrid(grid, size, size)}`;
    if (seenBoards.has(key) || !openCellsConnected(base)) continue;
    seenBoards.add(key);
    tried++;
    if (countSolutions(base, 2, NODE_BUDGET) !== 1) continue;
    const [solution] = solve(base, 1);
    if (hasSwastika(base, solution)) continue;
    keep({ ...base, solution }, sym, { _holes: k });
  } else {
    const start = minimalSymmetricState(size, tile, sym);
    if (!start) continue;
    const key = `${tile}|${canonicalGrid(start.puzzle.grid, size, size)}|${start.intended}`;
    if (seenBoards.has(key)) continue;
    seenBoards.add(key);
    tried++;
    const base = { ...start.puzzle, solution: start.intended };
    if (hasSwastika(base, start.intended)) continue;
    const givens = makeSymmetricClues(base, start.intended, sym);
    if (!givens || givens.length < minClues) continue;
    const nLines = givens.filter(g => g[0] === 'L').length, nCross = givens.length - nLines;
    if (nLines < minEach || nCross < minEach) continue;
    const puzzle = { ...base, givens };
    if (solveWithGivens(puzzle, 2).length !== 1) throw new Error('internal error: clues do not give a unique solution');
    keep(puzzle, sym, { _holes: start.holes });
  }
}

const all = [...buckets.values()].flat().sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) || a.score - b.score);
const book = all.map((p, i) => ({ ...p, name: `sym_${mode}_${String(i + 1).padStart(2, '0')}` }));
const header = mode === 'voids'
  ? '# Symmetric puzzles, voids only: the blocked cells are symmetric (a rotation and/or a mirror) and the tiling is unique with no clues.\n'
  : '# Symmetric puzzles with clues: symmetric blocked cells (as few as can be tiled) and pre-drawn edges in symmetric positions (the given column: L = a line, X = a cross).\n';
writeFileSync(out, header + '# Built by tools/make_symmetric_puzzles.mjs. grid: # = blocked cell, . = open cell. solution: tile labels.\n' + toCsv(book));
console.log(`${book.length} puzzles (${found} kept from ${tried} boards in ${((Date.now() - t0) / 60000).toFixed(1)} min) -> ${out}`);
console.log(sizes.map(s => `${s}x${s}: ` + TIERS.map(t => `${t} ${(buckets.get(`${s}|${t}`) ?? []).length}`).join(' ')).join(' | '));
const count = f => { const m = {}; for (const p of book) m[f(p)] = (m[f(p)] ?? 0) + 1; return JSON.stringify(m); };
console.log('symmetries:', count(p => p._sym), ' shapes:', count(p => p.tile));
const stat = f => { const v = book.map(f); return v.length ? `${Math.min(...v)}-${Math.max(...v)} (avg ${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1)})` : '-'; };
console.log('blocked cells:', stat(p => p._holes), mode === 'clues' ? ' clues: ' + stat(p => p.givens.length) : '');
