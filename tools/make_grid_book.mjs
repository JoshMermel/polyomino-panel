// Pick a bonus book for a grid that is not square (tools/books/hexes.csv or triangles.csv, source books) from pools made by
// tools/make_shaped.mjs (--shape hexagon4 --tile hex:h3b, --shape trihexagon3 --tile tri:i4a ...; the board is the first part of a
// puzzle's name).
//   node tools/make_grid_book.mjs hex|tri <directory of make_shaped CSVs> [size 300]
// Drops duplicates (up to rotation and reflection of the board), keeps the main books' blocked-cell caps, gives every tier
// its usual share, shares each tier out over the board sizes and, inside a board, over the tile shapes in rounds (the sparsest
// puzzle of a tile first), and sorts by tier then score with the shapes mixed locally.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { parseCsv, toCsv, solveWithGivens, openCellsConnected, tileSizes } from '../js/logic.js';
import { canonicalGrid } from '../js/generator.js';
import { TIERS } from '../js/rating.js';
import { spreadByTier, weightedAllocation } from './lib/pick.mjs';
import { boardShape } from './lib/board_shapes.mjs';
const grid = process.argv[2], dir = process.argv[3], max = Number(process.argv[4] ?? 300);
// per grid: how much each board shape counts, which tiles are dull (straight strips: one technique over and over), and the book's file and blurb
const CONFIG = {
  hex: {
    boardWeight: { hexagon4: 1, hexagon5: 1.5, hexagon6: 2 },                    // bigger boards get more puzzles
    dull: ['hex:h2', 'hex:h3a', 'hex:h4a', 'hex:h5a'],
    file: 'hexes.csv', prefix: 'hexes',
    header: '# Hexes: hexagonal cells (a hexagon-shaped board of 4, 5 or 6 cells a side), cut into polyhex tiles. Made by tools/make_shaped.mjs; the corners of the array are outside the board.\n',
  },
  tri: {
    boardWeight: { trihexagon3: 1, trihexagon4: 1.5, trihexagon5: 1.2, trihexagon6: 0.5, tritriangle8: 1, tritriangle10: 1.5, tritriangle12: 0.5, trirhombus5: 1, trirhombus6: 1.5 },
    dull: ['tri:i3', 'tri:i4a', 'tri:i5a', 'tri:i6a'],
    file: 'triangles.csv', prefix: 'tri',
    header: '# Triangles: triangular cells on hexagon, triangle and rhombus boards, cut into polyiamond tiles. Made by tools/make_shaped.mjs; cells outside a board are blocked and not drawn.\n',
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
const weightOf = tile => (LINE_PIECES.has(tile) ? 0.33 : 1);

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
let picks = [];
for (const tier of TIERS) {
  const cands = all.filter(p => p.tier === tier);
  const n = Math.min(Math.round(max * TIER_SHARE[tier]), cands.length);
  picks.push(...pickBalanced(cands, n));
  console.log(`${tier.padEnd(9)} ${n} of ${cands.length} candidates`);
}
picks.sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) || a.score - b.score);
const spread = spreadByTier(picks, { key: p => p.tile });
const book = spread.map((p, i) => { const { shape, ...rest } = p; return { ...rest, name: `${CONFIG.prefix === 'tri' ? 'triangles' : 'hexes'}_${String(i + 1).padStart(3, '0')}` }; });
writeFileSync(new URL(`./books/${CONFIG.file}`, import.meta.url), CONFIG.header + toCsv(book));
const count = f => book.filter(f).length;
console.log(book.length, 'puzzles; tiers', TIERS.map(t => `${t} ${count(p => p.tier === t)}`).join(' '), '; boards', [...new Set(spread.map(p => p.shape))].sort().map(s => `${s} ${spread.filter(p => p.shape === s).length}`).join(', '), '; tiles', new Set(book.map(p => p.tile)).size, 'sizes', [...new Set(book.flatMap(p => tileSizes(p.tile)))].join(','));
