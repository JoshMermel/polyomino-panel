// Pick the Shapes bonus book (tools/books/shapes.csv, a source book) from pools made by tools/make_shaped.mjs.
//   node tools/make_shapes_book.mjs <directory of make_shaped CSVs> [size 150]
// Drops duplicates (up to rotation and reflection), keeps the same number of puzzles per (shape, tile) as far as it
// can, sorts by tier then score with the board shapes mixed locally, and marks the cells outside each board's shape.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { parseCsv, toCsv, solveWithGivens, openCellsConnected, hasSwastika } from '../js/logic.js';
import { canonicalGrid } from '../js/generator.js';
import { TIERS } from '../js/rating.js';
import { spreadByTier } from './lib/pick.mjs';
import { boardShape } from './lib/board_shapes.mjs';
const dir = process.argv[2], max = Number(process.argv[3] ?? 150);
const all = [], seen = new Set();
for (const f of readdirSync(dir).filter(f => f.endsWith('.csv') && !f.startsWith('x_')).sort()) {
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
// at most `cap` per (shape, tile), then even across tiers when trimming to `max`
let picks = all;
if (picks.length > max) {
  const by = new Map();
  for (const p of picks) { const k = `${p.shape}|${p.tile}`; if (!by.has(k)) by.set(k, []); by.get(k).push(p); }
  picks = []; for (let r = 0; picks.length < max; r++) { let any = false; for (const g of by.values()) if (g[r] && picks.length < max) { picks.push(g[r]); any = true; } if (!any) break; }
}
picks.sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) || a.score - b.score);
const spread = spreadByTier(picks, { key: p => p.shape });
const book = spread.map((p, i) => { const { shape, ...rest } = p; return { ...rest, name: `shapes_${String(i + 1).padStart(3, '0')}` }; });
const header = '# Shapes: boards that are not plain squares (rectangles, a plus sign, an octagon, a ring, an L). Made by tools/make_shaped.mjs; the cells outside a shape are blocked.\n';
writeFileSync(new URL('./books/shapes.csv', import.meta.url), header + toCsv(book));
const count = f => book.filter(f).length;
console.log(book.length, 'puzzles; tiers', TIERS.map(t => `${t} ${count(p => p.tier === t)}`).join(' '), '; shapes', [...new Set(spread.map(p => p.shape))].map(s => `${s} ${spread.filter(p => p.shape === s).length}`).join(', '), '; tiles', [...new Set(book.map(p => p.tile))].join(' '));
