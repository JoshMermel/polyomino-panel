// Pick the Hexes bonus book (tools/books/hexes.csv, a source book) from pools made by tools/make_shaped.mjs on hexagonal
// boards (--shape hexagon4 --tile hex:h3b ...; pool files are named <board>_<tile>.csv, e.g. hexagon5_h4b.csv).
//   node tools/make_hex_book.mjs <directory of make_shaped CSVs> [size 200]
// Drops duplicates (up to rotation and reflection of the hexagon), keeps the main books' blocked-cell caps, gives every tier
// its usual share, shares each tier out over the board sizes and, inside a board, over the tile shapes in rounds (the sparsest
// puzzle of a tile first), and sorts by tier then score with the shapes mixed locally.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { parseCsv, toCsv, solveWithGivens, openCellsConnected, tileSizes } from '../js/logic.js';
import { canonicalGrid } from '../js/generator.js';
import { TIERS } from '../js/rating.js';
import { spreadByTier, weightedAllocation } from './lib/pick.mjs';
import { boardShape } from './lib/board_shapes.mjs';
const dir = process.argv[2], max = Number(process.argv[3] ?? 200);
// the same blocked-cell caps as the shapes book: a share of the cells that are part of the board
const CAP = { Beginner: 0.25, Medium: 0.17, Hard: 0.17, Expert: 0.25 };
const TIER_SHARE = { Beginner: 0.10, Medium: 0.45, Hard: 0.325, Expert: 0.125 };
const BOARD_WEIGHT = { hexagon4: 1, hexagon5: 1.5, hexagon6: 2 };       // bigger boards get more puzzles
const blockedShare = p => { const real = [...p.grid].filter((c, i) => p.outside?.[i] !== 'x').length; return [...p.grid].filter((c, i) => c === '#' && p.outside?.[i] !== 'x').length / real; };
// how often a tile gets a turn: the straight pieces make dull puzzles (one technique over and over)
const LINE_PIECES = new Set(['hex:h2', 'hex:h3a', 'hex:h4a', 'hex:h5a']);
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
const book = spread.map((p, i) => { const { shape, ...rest } = p; return { ...rest, name: `hexes_${String(i + 1).padStart(3, '0')}` }; });
const header = '# Hexes: hexagonal cells (a hexagon-shaped board of 4, 5 or 6 cells a side), cut into polyhex tiles. Made by tools/make_shaped.mjs; the corners of the array are outside the board.\n';
writeFileSync(new URL('./books/hexes.csv', import.meta.url), header + toCsv(book));
const count = f => book.filter(f).length;
console.log(book.length, 'puzzles; tiers', TIERS.map(t => `${t} ${count(p => p.tier === t)}`).join(' '), '; boards', [...new Set(spread.map(p => p.shape))].sort().map(s => `${s} ${spread.filter(p => p.shape === s).length}`).join(', '), '; tiles', new Set(book.map(p => p.tile)).size, 'sizes', [...new Set(book.flatMap(p => tileSizes(p.tile)))].join(','));
