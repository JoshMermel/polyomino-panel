// Pick the Shapes bonus book (tools/books/shapes.csv, a source book) from pools made by tools/make_shaped.mjs.
//   node tools/make_shapes_book.mjs <directory of make_shaped CSVs> [size 400]
// Drops duplicates (up to rotation and reflection), keeps the same number of puzzles per (shape, tile) as far as it
// can, sorts by tier then score with the board shapes mixed locally, and marks the cells outside each board's shape.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { parseCsv, toCsv, solveWithGivens, openCellsConnected, hasSwastika } from '../js/logic.js';
import { canonicalGrid } from '../js/generator.js';
import { TIERS } from '../js/rating.js';
import { spreadByTier, weightedAllocation } from './lib/pick.mjs';
import { boardShape } from './lib/board_shapes.mjs';
const dir = process.argv[2], max = Number(process.argv[3] ?? 400);
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
console.log('candidates', all.length);
const bad = all.filter(p => solveWithGivens(p, 2).length !== 1 || !openCellsConnected(p) || hasSwastika(p, p.solution));
if (bad.length) throw new Error('bad puzzles: ' + bad.map(p => p.name));
// Trim to `max`: the same number of puzzles for every board shape (as far as its pool goes; a short shape's slots go to
// the others), and inside a shape round after round over its tile specs, so each combination is as even as the pools allow.
// A tile spec's weight is how often it gets a turn: the L tetromino counts double (a favourite) and pairs of tiles
// 0.75 (they are the harder puzzles, and there are more of them to choose from).
const weightOf = tile => { const parts = tile.split('+'); return (parts.includes('L') ? 2 : 1) * (parts.length > 1 ? 0.75 : 1); };
let picks = all;
if (picks.length > max) {
  const shapes = [...new Set(all.map(p => p.shape))].sort();
  const perShape = weightedAllocation(max, shapes.map(sh => all.filter(p => p.shape === sh).length));
  picks = [];
  shapes.forEach((sh, k) => {
    const by = new Map();
    for (const p of all.filter(q => q.shape === sh)) { if (!by.has(p.tile)) by.set(p.tile, { list: [], credit: 0, w: weightOf(p.tile) }); by.get(p.tile).list.push(p); }
    let left = perShape[k];
    const groups = [...by.values()];
    const turn = [...groups.slice((k * 7) % groups.length), ...groups.slice(0, (k * 7) % groups.length)];     // who goes first differs by shape, so a tile that misses out in one shape gets in in another
    for (let guard = 0; left > 0 && guard < 1000; guard++) {
      for (const g of turn) {
        g.credit += g.w;
        while (g.credit >= 1 && g.list.length && left > 0) { picks.push(g.list.shift()); g.credit -= 1; left--; }
      }
    }
  });
}
picks.sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) || a.score - b.score);
const spread = spreadByTier(picks, { key: p => p.shape });
const book = spread.map((p, i) => { const { shape, ...rest } = p; return { ...rest, name: `shapes_${String(i + 1).padStart(3, '0')}` }; });
const header = '# Shapes: boards that are not plain squares (rectangles, a plus sign, an octagon, a ring, an L). Made by tools/make_shaped.mjs; the cells outside a shape are blocked.\n';
writeFileSync(new URL('./books/shapes.csv', import.meta.url), header + toCsv(book));
const count = f => book.filter(f).length;
console.log(book.length, 'puzzles; tiers', TIERS.map(t => `${t} ${count(p => p.tier === t)}`).join(' '), '; shapes', [...new Set(spread.map(p => p.shape))].map(s => `${s} ${spread.filter(p => p.shape === s).length}`).join(', '), '; tiles', [...new Set(book.map(p => p.tile))].join(' '));
