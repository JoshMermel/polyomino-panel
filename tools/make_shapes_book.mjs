// Pick the Shapes bonus book (tools/books/shapes.csv, a source book) from pools made by tools/make_shaped.mjs.
//   node tools/make_shapes_book.mjs <directory of make_shaped CSVs> [size 400]
// Drops duplicates (up to rotation and reflection), keeps the same number of puzzles per (shape, tile) as far as it
// can, sorts by tier then score with the board shapes mixed locally, and marks the cells outside each board's shape.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { parseCsv, toCsv, solveWithGivens, openCellsConnected, hasSwastika, tileSpecs } from '../js/logic.js';
import { canonicalGrid } from '../js/generator.js';
import { TIERS } from '../js/rating.js';
import { spreadByTier, weightedAllocation } from './lib/pick.mjs';
import { boardShape } from './lib/board_shapes.mjs';
const dir = process.argv[2], max = Number(process.argv[3] ?? 400);
// the same blocked-cell caps as the main books (a share of the cells that are part of the board, not of the bounding box):
// at most 17% for Medium and Hard, 25% for Beginner and Expert
const CAP = { Beginner: 0.25, Medium: 0.17, Hard: 0.17, Expert: 0.25 };
const blockedShare = p => { const real = [...p.grid].filter((c, i) => p.outside?.[i] !== 'x').length; return ([...p.grid].filter((c, i) => c === '#' && p.outside?.[i] !== 'x').length) / real; };
const all = [], seen = new Set();
for (const f of readdirSync(dir).filter(f => f.endsWith('.csv') && !f.startsWith('rect')).sort()) {     // (rectangles were dropped: boring)
  for (const p of parseCsv(readFileSync(`${dir}/${f}`, 'utf8'))) {
    const key = `${p.tile}|${canonicalGrid(p.grid, p.rows, p.cols)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    p.shape = p.name.split('_')[0];
    const { outside } = boardShape(p.shape);
    if (outside) p.outside = outside; else delete p.outside;
    all.push(p);
  }
}
const before = all.length;
for (let i = all.length - 1; i >= 0; i--) if (blockedShare(all[i]) > CAP[all[i].tier]) all.splice(i, 1);
console.log('candidates', before, '->', all.length, 'within the blocked-cell caps');
const bad = all.filter(p => solveWithGivens(p, 2).length !== 1 || !openCellsConnected(p) || hasSwastika(p, p.solution));
if (bad.length) throw new Error('bad puzzles: ' + bad.map(p => p.name));
// Pick `max` puzzles: every tier gets the main books' share (10% Beginner, 45% Medium, 32% Hard, 12.5% Expert) and, inside
// a tier, 70% single-tile and 30% two-tile puzzles (Beginner has no pairs: they hardly exist). A tier or kind the pools
// cannot fill makes that tier smaller in proportion. Inside each (tier, kind) the same number of puzzles for every board
// shape (as far as its pool goes; a short shape's slots go to the others), and inside a shape round after round over its
// tile specs, so each combination is as even as the pools allow. A tile spec's weight is how often it gets a turn: the L
// tetromino counts double (a favourite) and pairs of tiles 0.75.
const weightOf = tile => { const parts = tile.split('+'); return (parts.includes('L') ? 2 : 1) * (parts.length > 1 ? 0.75 : 1); };
const pickBalanced = (list, n) => {
  const shapes = [...new Set(list.map(p => p.shape))].sort();
  const perShape = weightedAllocation(n, shapes.map(sh => list.filter(p => p.shape === sh).length));
  const out = [];
  shapes.forEach((sh, k) => {
    const by = new Map();
    for (const p of list.filter(q => q.shape === sh).sort((a, b) => a.score - b.score)) { if (!by.has(p.tile)) by.set(p.tile, { list: [], credit: 0, w: weightOf(p.tile) }); by.get(p.tile).list.push(p); }
    let left = perShape[k];
    const groups = [...by.values()];
    const turn = [...groups.slice((k * 7) % groups.length), ...groups.slice(0, (k * 7) % groups.length)];     // who goes first differs by shape, so a tile that misses out in one shape gets in in another
    for (let guard = 0; left > 0 && guard < 1000; guard++) {
      for (const g of turn) {
        g.credit += g.w;
        while (g.credit >= 1 && g.list.length && left > 0) { out.push(g.list.shift()); g.credit -= 1; left--; }
      }
    }
  });
  return out;
};
const TIER_SHARE = { Beginner: 0.10, Medium: 0.45, Hard: 0.32, Expert: 0.125 }, PAIR_SHARE = 0.3;
const isPair = p => tileSpecs(p.tile).length === 2;
let picks = [];
for (const tier of TIERS) {
  const cands = all.filter(p => p.tier === tier), singles = cands.filter(p => !isPair(p)), pairs = cands.filter(isPair);
  const ps = tier === 'Beginner' ? 0 : PAIR_SHARE;
  let n = Math.round(max * TIER_SHARE[tier]);
  n = ps === 0 ? Math.min(n, singles.length) : Math.floor(Math.min(n, singles.length / (1 - ps), pairs.length / ps));
  const nPairs = Math.round(n * ps);
  picks.push(...pickBalanced(singles, n - nPairs), ...pickBalanced(pairs, nPairs));
  console.log(`${tier.padEnd(9)} ${n} (${n - nPairs} single + ${nPairs} pair; candidates ${singles.length}/${pairs.length})`);
}
picks.sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) || a.score - b.score);
const spread = spreadByTier(picks, { key: p => p.shape });
const book = spread.map((p, i) => { const { shape, ...rest } = p; return { ...rest, name: `shapes_${String(i + 1).padStart(3, '0')}` }; });
const header = '# Shapes: boards that are not plain squares (rectangles, a plus sign, an octagon, a ring, an L). Made by tools/make_shaped.mjs; the cells outside a shape are blocked.\n';
writeFileSync(new URL('./books/shapes.csv', import.meta.url), header + toCsv(book));
const count = f => book.filter(f).length;
console.log(book.length, 'puzzles; tiers', TIERS.map(t => `${t} ${count(p => p.tier === t)}`).join(' '), '; shapes', [...new Set(spread.map(p => p.shape))].map(s => `${s} ${spread.filter(p => p.shape === s).length}`).join(', '), '; tiles', [...new Set(book.map(p => p.tile))].join(' '));
