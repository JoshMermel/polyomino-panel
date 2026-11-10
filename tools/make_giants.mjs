// Pick the Giants book (16x16 boards, one or two tile shapes) from the pools in tools/library/. It starts at Medium:
// no Beginner puzzles, even where a pool has some (T5); see --min-tier.
//
//   node tools/make_giants.mjs [--size 16] [--single 40] [--pairs 40] [--max-stuck 0.2] [--max-blocked 0.2] [--out tools/books/giants.csv]
//                              [--keep data/bonus-giants.csv] [--min-tier Medium]
//
// The pools (tools/library/<tile>_16x16.csv) come from
//   node tools/fill_library.mjs --tile L5 --size 16 --target 40 --min-fraction 0.14 --max-fraction 0.20 --attempt-seconds 60
// (the local-search generator reaches 16x16 only for the flexible pentominoes, and only at about 14 to 20%
// blocked cells (the rigid shapes and S go higher, to 25%; --max-blocked caps it); see TODO.md "Giants book"). Within each shape the sparsest puzzles come first; the shapes
// share a kind by weight, so no shape dominates it; `--single` and `--pairs` are the counts of one-shape and two-shape
// puzzles. At most `--max-stuck` of the book may be puzzles the hint rules cannot finish ("no logical
// hints"). Rotated/mirrored duplicates are already gone from the pools; disconnected boards and swastika patterns are skipped, as in the other books. The book is sorted by tier, then
// score, with shapes spread out as in the other books. It is a source book (tools/books/collections.json):
// build_books.mjs copies it as it is. `--keep BOOK` grows an existing book: every puzzle of BOOK stays (so players' saved
// progress, which is keyed by the puzzle's content, is not lost), counts as part of its shape's share, and the new
// puzzles of each shape come from its pool, sparsest first.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { parseCsv, toCsv, tileSpecs, hasSwastika, openCellsConnected, puzzleHash } from '../js/logic.js';
import { TIERS, beyondHints } from '../js/rating.js';
import { spreadByTier, hashString, weightedAllocation } from './lib/pick.mjs';
import { tileWeight } from './lib/tile_weights.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]]);
  return acc;
}, []));
const size = Number(args.size ?? 16);
const wantSingle = Number(args.single ?? 40);
const wantPairs = Number(args.pairs ?? 40);
const maxStuck = Number(args['max-stuck'] ?? 0.2);
const maxBlocked = Number(args['max-blocked'] ?? 0.2);       // share of the board
const minTier = TIERS.indexOf(args['min-tier'] ?? 'Medium');
const out = new URL(args.out ?? 'books/giants.csv', import.meta.url);
const libDir = new URL('library/', import.meta.url);
const blocked = p => [...p.grid].filter(c => c === '#').length;

const keptBook = args.keep ? parseCsv(readFileSync(args.keep, 'utf8')) : [];
const kept = new Set(keptBook.map(puzzleHash));

const pools = new Map();                    // tile -> puzzles, sparsest first
for (const f of readdirSync(libDir).filter(f => f.endsWith(`_${size}x${size}.csv`))) {
  const puzzles = parseCsv(readFileSync(new URL(f, libDir), 'utf8')).filter(p => TIERS.indexOf(p.tier) >= minTier && blocked(p) <= maxBlocked * size * size && openCellsConnected(p) && !hasSwastika(p, p.solution));
  if (puzzles.length) pools.set(puzzles[0].tile, puzzles.sort((a, b) => blocked(a) - blocked(b) || (hashString(a.name) - hashString(b.name))));
}
for (const p of keptBook) {                  // the book's puzzles come first in their shape's pool (and are in it even if the library lost them)
  pools.set(p.tile, [p, ...(pools.get(p.tile) ?? []).filter(q => puzzleHash(q) !== puzzleHash(p))]);
}
for (const [tile, ps] of pools) pools.set(tile, [...ps.filter(p => kept.has(puzzleHash(p))), ...ps.filter(p => !kept.has(puzzleHash(p)))]);

// Each kind's count is shared among its shapes by weight (tools/lib/tile_weights.mjs: the rigid pentominoes weigh
// a third), each giving its sparsest puzzles; a shape with too few gives up what it cannot supply. A "stuck"
// puzzle (no logical hints) is skipped once the allowance is used up.
let stuckLeft = Math.floor(maxStuck * (wantSingle + wantPairs)) - keptBook.filter(beyondHints).length;
function pick(kind, want) {
  const shapes = [...pools].filter(([tile]) => tileSpecs(tile).length === kind);
  const alloc = weightedAllocation(want, shapes.map(([, ps]) => ps.length), shapes.map(([tile]) => tileWeight(tile)));
  return shapes.flatMap(([, ps], i) => {
    const chosen = [];
    for (const p of ps) {
      const keep = kept.has(puzzleHash(p));
      if (chosen.length >= alloc[i] && !keep) break;
      if (!keep && beyondHints(p)) { if (stuckLeft <= 0) continue; stuckLeft--; }
      chosen.push(p);
    }
    return chosen;
  });
}
const picks = [...pick(1, wantSingle), ...pick(2, wantPairs)];
picks.sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) || a.score - b.score || (a.name < b.name ? -1 : 1));
const book = spreadByTier(picks).map((p, i) => ({ ...p, name: `giants_${String(i + 1).padStart(2, '0')}` }));

writeFileSync(out, `# Giants: ${size}x${size} boards, one or two shapes. Picked by tools/make_giants.mjs from the pools in tools/library/.\n` + toCsv(book));
const count = (f) => book.filter(f).length;
console.log(`${book.length} puzzles: ${count(p => tileSpecs(p.tile).length === 1)} one-shape, ${count(p => tileSpecs(p.tile).length === 2)} two-shape; ` +
  `tiers ${TIERS.map(t => count(p => p.tier === t)).join('/')}; shapes ${[...new Set(book.map(p => p.tile))].sort().join(' ')}; ` +
  `blocked ${Math.min(...book.map(blocked))}..${Math.max(...book.map(blocked))}`);
