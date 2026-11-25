// Gives a hex book more tetrahex puzzles without reshuffling it: pentahex puzzles are swapped, in place, for tetrahex puzzles
// of the same board and tier (and about the same score), so the book keeps its order, its tier shares and most of its puzzles
// (a player's solved marks stay with the puzzles that did not change).
//
//   node tools/rebalance_hex.mjs <pools directory> [--tetra 0.35] [--skip h4d] [--dry 1]
//
// The pools directory holds make_shaped.mjs output for the tetrahexes (files like hexagon5_h4b.csv, one per board and tile,
// e.g. `node tools/make_shaped.mjs --shape hexagon5 --tile hex:h4b --from 0.0 --to 0.22 --count 80 --per-level 40 --minutes 3
// --out <dir>/hexagon5_h4b.csv`). Run it on the books of tools/books/hexes-{s,m,l}.csv, then `node tools/build_books.mjs --fresh --promote`.
// Replacements are picked so that no tile is next to itself, the least used tile (h4f counts as 1.5 and h4g as half) goes first; h4d, the dull 2x2 tetrahex, is never swapped in (--skip), and the swaps are spread along the book.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { parseCsv, toCsv, solveWithGivens, openCellsConnected } from '../js/logic.js';
import './lib/wasm_counter.mjs';
import { canonicalGrid } from '../js/generator.js';
import { boardShape } from './lib/board_shapes.mjs';

const args = Object.fromEntries(process.argv.slice(3).reduce((acc, a, i, all) => { if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]]); return acc; }, []));
const dir = process.argv[2];
if (!dir) throw new Error('usage: rebalance_hex.mjs <pools directory> [--tetra 0.35] [--skip h4d] [--dry 1]');
const TARGET = Number(args.tetra ?? 0.35);
const SKIP = new Set((args.skip ?? 'h4d').split(',').map(t => `hex:${t}`));   // tiles never swapped in (default: the dull 2x2 tetrahex)
const BOARDS = ['hexagon4', 'hexrhombus6', 'hextriangle8', 'hexrect6x6', 'hexagon5', 'hexrhombus8', 'hextriangle10', 'hexrect8x8', 'hexagon6', 'hexrhombus10', 'hextriangle13', 'hexrect10x10'];
const WEIGHT = { 'hex:h4f': 1.5, 'hex:h4g': 0.5 };
const CAP = { Beginner: 0.25, Medium: 0.17, Hard: 0.17, Expert: 0.25 };
const weightOf = t => WEIGHT[t] ?? 1;
const blockedShare = p => { const real = [...p.grid].filter((c, i) => p.outside?.[i] !== 'x').length; return [...p.grid].filter((c, i) => c === '#' && p.outside?.[i] !== 'x').length / real; };
const family = t => (/^hex:h4/.test(t) ? 4 : /^hex:h5/.test(t) ? 5 : 0);
const boardOf = p => BOARDS.find(b => { const s = boardShape(b); return s.rows === p.rows && s.cols === p.cols && (s.outside ?? '') === (p.outside ?? ''); });

// the tetrahex pool, by board and tier
const pool = [], poolSeen = new Set();
for (const f of readdirSync(dir).filter(f => f.endsWith('.csv')).sort()) {
  for (const p of parseCsv(readFileSync(`${dir}/${f}`, 'utf8'))) {
    p.shape = p.name.split('_')[0];
    p.outside = boardShape(p.shape).outside;
    const key = `${p.tile}|${canonicalGrid(p.grid, p.rows, p.cols, p.tile, p.outside)}`;
    if (family(p.tile) !== 4 || p.tile === 'hex:h4a' || SKIP.has(p.tile) || poolSeen.has(key) || blockedShare(p) > CAP[p.tier]) continue;
    poolSeen.add(key);
    if (solveWithGivens(p, 2).length !== 1 || !openCellsConnected(p)) continue;
    pool.push(p);
  }
}
console.log('tetrahex pool:', pool.length, 'puzzles');

for (const size of ['s', 'm', 'l']) {
  const file = new URL(`./books/hexes-${size}.csv`, import.meta.url);
  const text = readFileSync(file, 'utf8');
  const header = text.split('\n').filter(l => l.startsWith('#')).join('\n') + '\n';
  const book = parseCsv(text);
  for (const p of book) p.shape = boardOf(p);
  const have = book.filter(p => family(p.tile) === 4).length;
  const want = Math.round(TARGET * book.length);
  const need = Math.max(0, want - have);
  const used = new Set(book.map(p => `${p.tile}|${canonicalGrid(p.grid, p.rows, p.cols, p.tile, p.outside ?? boardShape(p.shape).outside)}`));
  const tileCount = new Map();
  for (const p of book) tileCount.set(p.tile, (tileCount.get(p.tile) ?? 0) + 1);
  // positions to give up: pentahex puzzles, the over-used tiles first (by count per unit of weight), spread along the book
  const near = (i, f, r = 3) => { for (let j = Math.max(0, i - r); j <= Math.min(book.length - 1, i + r); j++) if (j !== i && f(book[j])) return true; return false; };
  let done = 0;
  for (let round = 0; done < need && round < 4 * need; round++) {
    // candidate positions: pentahex puzzles in the stretches between tetrahex puzzles, the longest stretch first, the middle of each first
    const marks = [-1, ...book.map((p, i) => (family(p.tile) === 4 ? i : null)).filter(i => i != null), book.length];
    const order = [], gaps = [];
    for (let k = 1; k < marks.length; k++) gaps.push([marks[k - 1], marks[k]]);
    gaps.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]));
    for (const [lo, hi] of gaps) {
      const mid = (lo + hi) / 2;
      for (let i = lo + 1; i < hi; i++) if (family(book[i].tile) === 5) order.push([Math.abs(i - mid) - (hi - lo) * 0.001, i]);
    }
    order.sort((a, b) => a[0] - b[0]);
    let placed = false;
    for (const [, i] of order.slice(0, 60)) {
      const v = book[i];
      const cands = pool.filter(p => p.shape === v.shape && p.tier === v.tier && !used.has(`${p.tile}|${canonicalGrid(p.grid, p.rows, p.cols, p.tile, p.outside)}`) && !near(i, q => q.tile === p.tile, 2));
      if (!cands.length) continue;
      // the least used tile first, then the score nearest to the puzzle it replaces
      cands.sort((x, y) => (tileCount.get(x.tile) ?? 0) / weightOf(x.tile) - (tileCount.get(y.tile) ?? 0) / weightOf(y.tile) || Math.abs(x.score - v.score) - Math.abs(y.score - v.score));
      const c = cands[0];
      tileCount.set(v.tile, tileCount.get(v.tile) - 1);
      tileCount.set(c.tile, (tileCount.get(c.tile) ?? 0) + 1);
      used.add(`${c.tile}|${canonicalGrid(c.grid, c.rows, c.cols, c.tile, c.outside)}`);
      const { shape, ...rest } = c;
      book[i] = { ...rest, name: v.name, shape: c.shape };
      done++; placed = true;
      break;
    }
    if (!placed) break;
  }
  const count = f => book.filter(f).length;
  console.log(`hexes-${size}: ${done} of ${need} swaps; tetra ${have} -> ${count(p => family(p.tile) === 4)}, penta ${count(p => family(p.tile) === 5)}, other ${count(p => !family(p.tile) || p.tile === 'hex:h4a')}; h4d ${count(p => p.tile === 'hex:h4d')}`);
  const tiles = [...new Set(book.filter(p => family(p.tile) === 4).map(p => p.tile))].sort();
  for (const t of tiles) console.log('   ', t.slice(4), ['Beginner', 'Medium', 'Hard', 'Expert'].map(r => count(p => p.tile === t && p.tier === r)).join(' / '));
  if (!args.dry) writeFileSync(file, header + toCsv(book.map(({ shape, ...p }) => p)));
}
