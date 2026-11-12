// Pick the books for a grid that is not square (tools/books/hexes-{s,m,l}.csv or triangles-{s,m,l}.csv, source books: Small,
// Medium and Large by the number of cells on the board) from pools made by
// tools/make_shaped.mjs (--shape hexagon4 --tile hex:h3b, --shape trihexagon3 --tile tri:i4a ...; the board is the first part of a
// puzzle's name).
//   node tools/make_grid_book.mjs hex|tri <directory of make_shaped CSVs> [puzzles per book]
// A book is as big as the one-shape books of the polyomino grid (Small 250, Medium 500, Large 500, as far as the pools reach).
// Drops duplicates (up to rotation and reflection of the board), keeps the main books' blocked-cell caps, gives every tier
// its usual share, shares each tier out over the board sizes and, inside a board, over the tile shapes in rounds (the sparsest
// puzzle of a tile first), and sorts by tier then score with the shapes mixed locally.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { parseCsv, toCsv, solveWithGivens, openCellsConnected, tileSizes } from '../js/logic.js';
import { canonicalGrid } from '../js/generator.js';
import { TIERS } from '../js/rating.js';
import { spreadByTier, weightedAllocation } from './lib/pick.mjs';
import { boardShape } from './lib/board_shapes.mjs';
const grid = process.argv[2], dir = process.argv[3], maxArg = process.argv[4];
// per grid: how much each board shape counts, which tiles are dull (straight strips: one technique over and over), and the book's file and blurb
const CONFIG = {
  hex: {
    boardWeight: { hexagon4: 1.5, hexagon5: 1.5, hexagon6: 1.5 },                // the hexagon is the classic board, the others add variety
    dull: ['hex:h2', 'hex:h3a', 'hex:h4a', 'hex:h5a'],
    // How often a tile gets a turn, on top of 1 (0.33 for the dull straight pieces above). Measured on the pools: 'rich' tiles
    // (8 or 9 different deduction rules, from Beginner up to Hard and Expert) get 1.5, 'easy' tiles (only Beginner and Medium
    // puzzles, 1 to 5 rules) 0.5, and tiles that only make Beginner puzzles 0.5 too (they were 0 while Beginner was 10% of a book;
    // now that it is 20 to 25% they are a fair share of it).
    weights: { 'hex:h4f': 1.5, 'hex:h5k': 1.5, 'hex:h5l': 1.5, 'hex:h5o': 1.5, 'hex:h5p': 1.5,
      'hex:h4d': 0.5, 'hex:h5s': 0.5, 'hex:h5g': 0.5, 'hex:h5c': 0.5, 'hex:h5r': 0.5, 'hex:h5q': 0.5,
      'hex:h4g': 0.5, 'hex:h5u': 0.5, 'hex:h5t': 0.5 },
    // Tier shares per size, gentler than the polyomino books' (10 / 45 / 32 / 12.5): the solver rates hex puzzles no harder than
    // square ones, but they feel harder (12 orientations, no rows or columns to line up against), and an Expert puzzle (no logical
    // hints) means trial and error. Small has no Expert at all.
    shares: { s: { Beginner: 0.25, Medium: 0.6, Hard: 0.15, Expert: 0 }, m: { Beginner: 0.25, Medium: 0.55, Hard: 0.18, Expert: 0.02 }, l: { Beginner: 0.2, Medium: 0.5, Hard: 0.25, Expert: 0.05 } },
    prefix: 'hexes',
    cells: { s: '36', m: '55 to 64', l: '91 to 100' },
    sizes: { s: ['hexagon4', 'hexrhombus6', 'hextriangle8', 'hexrect6x6'], m: ['hexagon5', 'hexrhombus8', 'hextriangle10', 'hexrect8x8'], l: ['hexagon6', 'hexrhombus10', 'hextriangle13', 'hexrect10x10'] },
    header: '# Hexes, {size}: hexagonal cells (hexagon, rhombus, triangle and rectangle boards of about {cells} cells), cut into polyhex tiles. Made by tools/make_shaped.mjs; the corners of the array are outside the board.\n',
  },
  tri: {
    boardWeight: { trihexagon3: 1, trihexagon4: 1.5, trihexagon5: 1.2, trihexagon6: 0.5, tritriangle8: 1, tritriangle10: 1.5, tritriangle12: 0.5, trirhombus5: 1, trirhombus6: 1.5 },
    dull: ['tri:i4a', 'tri:i5a', 'tri:i6a'],
    // As for hexes. The tiles that make the Hard and Expert puzzles (i5b, i5c, i6j, i6b) already fill those tiers, so only the
    // easy tiles are turned down: i6f, i6k, i6g and i6d (almost no Hard puzzles; 3 or 4 rules); i3 (a strip of three, 8 rules, Hard puzzles on the
    // Small boards) is left at 1, and the tiles that only make Beginner puzzles (i4c, i6c, i6h, i6i, i6l) are left out.
    weights: { 'tri:i6f': 0.5, 'tri:i6k': 0.5, 'tri:i6g': 0.5, 'tri:i6d': 0.5, 'tri:i6e': 1.5,
      'tri:i4c': 0.5, 'tri:i6c': 0.5, 'tri:i6h': 0.5, 'tri:i6i': 0.5, 'tri:i6l': 0.5 },
    prefix: 'triangles',
    cells: { s: '24 to 40', m: '50 to 64', l: '72 to 100' },
    // Small is the gentle book: boards of 24 to 40 triangles (the small triangles are small to tap on, and more cells make a harder
    // puzzle), where there are no Hard or Expert puzzles, so it is Beginner and Medium only. Medium and Large are the boards that
    // were Small and Medium when the books were first made (the 144 to 216 cell boards are no longer in a book).
    sizes: { s: ['trihexagon2', 'tritriangle6', 'trirhombus4', 'trirect5x9'], m: ['trihexagon3', 'trirhombus5', 'tritriangle8', 'trirect6x11'], l: ['trirhombus6', 'trihexagon4', 'tritriangle10', 'trirect7x13'] },
    book: { s: 150, m: 250, l: 500 },
    // Small has no Hard or Expert puzzles at all; Medium and Large have the same gentle shares as the hex books (Medium has only 5
    // Expert puzzles to give, so 2% of 250)
    shares: { s: { Beginner: 0.4, Medium: 0.6, Hard: 0, Expert: 0 }, m: { Beginner: 0.24, Medium: 0.56, Hard: 0.18, Expert: 0.02 }, l: { Beginner: 0.2, Medium: 0.5, Hard: 0.25, Expert: 0.05 } },
    header: '# Triangles, {size}: triangular cells on hexagon, triangle, rhombus and rectangle boards, cut into polyiamond tiles. Made by tools/make_shaped.mjs; cells outside a board are blocked and not drawn.\n',
  },
}[grid];
if (!CONFIG) throw new Error('usage: make_grid_book.mjs hex|tri <pools directory> [size]');
// the same blocked-cell caps as the shapes book: a share of the cells that are part of the board
const CAP = { Beginner: 0.25, Medium: 0.17, Hard: 0.17, Expert: 0.25 };
const TIER_SHARE = { Beginner: 0.10, Medium: 0.45, Hard: 0.325, Expert: 0.125 };
const BOARD_WEIGHT = CONFIG.boardWeight;
const blockedShare = p => { const real = [...p.grid].filter((c, i) => p.outside?.[i] !== 'x').length; return [...p.grid].filter((c, i) => c === '#' && p.outside?.[i] !== 'x').length / real; };
// how often a tile gets a turn: the straight pieces make dull puzzles (one technique over and over)
const LINE_PIECES = new Set(CONFIG.dull);
const weightOf = tile => CONFIG.weights[tile] ?? (LINE_PIECES.has(tile) ? 0.33 : 1);

const all = [], seen = new Set();
for (const f of readdirSync(dir).filter(f => f.endsWith('.csv')).sort()) {
  for (const p of parseCsv(readFileSync(`${dir}/${f}`, 'utf8'))) {
    p.shape = p.name.split('_')[0];
    const { outside } = boardShape(p.shape);
    p.outside = outside;
    const key = `${p.tile}|${canonicalGrid(p.grid, p.rows, p.cols, p.tile, outside)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(p);
  }
}
const before = all.length;
for (let i = all.length - 1; i >= 0; i--) if (blockedShare(all[i]) > CAP[all[i].tier]) all.splice(i, 1);
console.log('candidates', before, '->', all.length, 'within the blocked-cell caps');
const bad = all.filter(p => solveWithGivens(p, 2).length !== 1 || !openCellsConnected(p));
if (bad.length) throw new Error('bad puzzles: ' + bad.map(p => p.name));

const pickBalanced = (list, n) => {
  const boards = [...new Set(list.map(p => p.shape))].sort();
  const perBoard = weightedAllocation(n, boards.map(b => list.filter(p => p.shape === b).length), boards.map(b => BOARD_WEIGHT[b] ?? 1));
  const out = [];
  boards.forEach((b, k) => {
    const by = new Map();
    for (const p of list.filter(q => q.shape === b).sort((x, y) => blockedShare(x) - blockedShare(y) || x.score - y.score)) {
      if (!by.has(p.tile)) by.set(p.tile, { list: [], credit: 0, w: weightOf(p.tile) });
      by.get(p.tile).list.push(p);
    }
    let left = perBoard[k];
    const groups = [...by.values()];
    const turn = [...groups.slice((k * 5) % groups.length), ...groups.slice(0, (k * 5) % groups.length)];
    for (let guard = 0; left > 0 && guard < 1000; guard++) {
      for (const g of turn) {
        g.credit += g.w;
        while (g.credit >= 1 && g.list.length && left > 0) { out.push(g.list.shift()); g.credit -= 1; left--; }
      }
    }
  });
  return out;
};
const SIZE_BOOK = CONFIG.book ?? { s: 250, m: 500, l: 500 };
const SIZE_NAME = { s: 'small', m: 'medium', l: 'large' };
for (const [size, boards] of Object.entries(CONFIG.sizes)) {
  const max = Number(maxArg ?? SIZE_BOOK[size]);
  let picks = [];
  const inSize = all.filter(p => boards.includes(p.shape));
  for (const tier of TIERS) {
    const cands = inSize.filter(p => p.tier === tier);
    const share = (CONFIG.shares?.[size] ?? TIER_SHARE)[tier];
    const n = Math.min(tier === 'Hard' ? Math.floor(max * share) : Math.round(max * share), cands.length);
    picks.push(...pickBalanced(cands, n));
    console.log(`${size} ${tier.padEnd(9)} ${n} of ${cands.length} candidates`);
  }
  // a tier with too few puzzles gives up what it cannot fill; Medium and Hard (never Beginner or Expert, which keep their shares) take the difference
  for (const tier of ['Hard', 'Medium', 'Hard', 'Medium', 'Hard', 'Medium', 'Hard', 'Medium']) {
    const short = max - picks.length;
    if (short <= 0) break;
    const spare = inSize.filter(p => p.tier === tier && !picks.includes(p));
    const extra = pickBalanced(spare, Math.min(spare.length, Math.ceil(short / 2)));
    picks.push(...extra);
    if (extra.length) console.log(`${size} ${tier.padEnd(9)} +${extra.length} to make up the size`);
  }
  picks.sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) || a.score - b.score);
  const spread = spreadByTier(picks, { key: p => p.tile });
  const book = spread.map((p, i) => { const { shape, ...rest } = p; return { ...rest, name: `${CONFIG.prefix}-${size}_${String(i + 1).padStart(3, '0')}` }; });
  const header = CONFIG.header.replace('{size}', SIZE_NAME[size]).replace('{cells}', CONFIG.cells[size]);
  writeFileSync(new URL(`./books/${CONFIG.prefix}-${size}.csv`, import.meta.url), header + toCsv(book));
  const count = f => book.filter(f).length;
  console.log(size, book.length, 'puzzles; tiers', TIERS.map(t => `${t} ${count(p => p.tier === t)}`).join(' '), '; boards', [...new Set(spread.map(p => p.shape))].sort().map(sh => `${sh} ${spread.filter(p => p.shape === sh).length}`).join(', '), '; tiles', new Set(book.map(p => p.tile)).size);
}
