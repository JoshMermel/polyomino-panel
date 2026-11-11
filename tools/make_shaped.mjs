// Experiment: puzzles on non-square boards (rectangles) and on boards with an outline (a plus sign, an octagon, a ring,
// an L), which are an ordinary square board with some cells always blocked (the generator's `fixed` option).
//
//   node tools/make_shaped.mjs --shape plus9 --tile L [--count 6] [--minutes 3] [--out data/tmp.csv] [--append]
//
// Shapes: rect6x10, rect8x12 (any rect<R>x<C>), plus9 (arms 3 wide, 3 long), octagon8, ring8, lshape8 (tools/lib/board_shapes.mjs).
// The puzzle's rows and cols are the bounding box; the fixed cells are blocked cells in its grid, so the app and the
// rating need nothing new. Writes the scored puzzles (data/tmp.csv is the app's local-only scratch book).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseCsv, toCsv, minTileSize, sizeFeasible } from '../js/logic.js';
import './lib/wasm_counter.mjs';
import { generatePuzzle, mulberry32, canonicalGrid } from '../js/generator.js';
import { ratePuzzle } from '../js/rating.js';
import { boardShape } from './lib/board_shapes.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => { if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]?.startsWith('--') ? '1' : all[i + 1]]); return acc; }, []));
const shape = args.shape ?? 'plus9', tile = args.tile ?? 'L', count = Number(args.count ?? 6), maxMs = Number(args.minutes ?? 3) * 60000;
const out = new URL(args.out ?? '../data/tmp.csv', import.meta.url);

const { rows, cols, fixed, outside } = boardShape(shape);
const openBase = fixed.filter(f => !f).length;

const pool = args.append && existsSync(out) ? parseCsv(readFileSync(out, 'utf8')) : [];
const seen = new Set(pool.map(p => canonicalGrid(p.grid, rows, cols)));
const rng = mulberry32(Number(args.seed ?? Date.now() % 2 ** 31));
const t0 = Date.now();
let found = 0;
// holes (extra blocked cells) from about 6% of the open cells upward, whatever leaves whole tiles
for (let holes = Math.max(0, Math.round(openBase * 0.06)); Date.now() - t0 < maxMs && found < count && holes < openBase / 2; holes++) {
  if (openBase - holes < minTileSize(tile) || !sizeFeasible(tile, openBase - holes)) continue;
  for (let k = 0; k < 4 && found < count && Date.now() - t0 < maxMs; k++) {
    const res = generatePuzzle({ rows, cols, tile, holes, fixed, rng, maxMs: 8000 });
    if (!res) { console.error(`${shape} ${tile}: no puzzle at ${holes} extra blocked cells`); break; }
    const p = res.puzzle, key = canonicalGrid(p.grid, rows, cols);
    if (seen.has(key)) continue;
    seen.add(key);
    const r = ratePuzzle(p);
    Object.assign(p, { name: `${shape}_${tile}_${pool.length + 1}`, rules: r.rules, tier: r.tier, score: r.score });
    if (outside) p.outside = outside;
    pool.push(p); found++;
    console.error(`${shape} ${tile}: ${holes} extra blocked, ${r.tier} (${r.rules}), ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
}
writeFileSync(out, '# experiment: shaped boards (tools/make_shaped.mjs)\n' + toCsv(pool));
console.log(`${shape} ${tile}: ${found} new puzzles, ${pool.length} in ${out.pathname}`);
