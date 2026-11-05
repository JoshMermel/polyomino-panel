// Make sparser puzzles from the ones already in a pool, and add them to it.
//
//   node tools/sparsify_library.mjs --tile L --size 8 [--minutes 20] [--target 0.15] [--attempt-seconds 20] [--seed N]
//
// The original L-panel puzzles have very few black cells, but the random generator rarely gets there:
// with few blocked cells a board has huge numbers of tilings, and almost none is unique. This tool
// walks down from what the pool already has instead. It takes one of the sparsest puzzles in the pool,
// frees a tile's worth of blocked cells in a small window, re-tiles the window and repairs uniqueness
// with the generator's local search (sparsifyPuzzle in js/generator.js). A success has one tile fewer
// of blocked cells and goes back in the queue, so a chain of successes keeps walking down until the
// search can't go further. Every puzzle is rated with the real rules and checked (unique solution,
// connected open cells, no swastika) before it is stored. Stops at --minutes, or when --target (a
// fraction of the board) is reached by a puzzle and --minutes of grace are used up... in short: at the time limit.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { parseCsv, toCsv, puzzleHash, shapeName, tileSizes, sizeFeasible } from '../js/logic.js';
import './lib/wasm_counter.mjs';        // faster tiling counter, when built (tools/wasm)
import { sparsifyPuzzle, mulberry32, canonicalGrid } from '../js/generator.js';
import { ratePuzzle } from '../js/rating.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]]);
  return acc;
}, []));
const tile = args.tile ?? 'L';
const size = Number(args.size ?? 8);
const rows = size, cols = size;
const maxMs = Number(args.minutes ?? 20) * 60000;
const attemptMs = Number(args['attempt-seconds'] ?? 20) * 1000;
const seed = Number(args.seed ?? Math.floor(Math.random() * 2 ** 31));
const quiet = 'quiet' in args;
const rng = mulberry32(seed);

const file = new URL(`./library/${tile}_${rows}x${cols}.csv`, import.meta.url);
mkdirSync(new URL('./library/', import.meta.url), { recursive: true });
const pool = existsSync(file) ? parseCsv(readFileSync(file, 'utf8')) : [];
const seen = new Set(pool.map(p => canonicalGrid(p.grid, rows, cols)));
const blockedOf = p => [...p.grid].filter(c => c === '#').length;
const log = (...m) => { if (!quiet) console.error(...m); };
const save = () => writeFileSync(file, '# pool: generated, scored puzzles (not published). See tools/fill_library.mjs\n' + toCsv(pool));
const cells = rows * cols;
const sizes = tileSizes(tile);

const t0 = Date.now();
const tries = new Map();                      // puzzle name -> failed attempts so far
const MAX_TRIES = 3;
let added = 0, attempts = 0;
const minStart = pool.length ? Math.min(...pool.map(blockedOf)) : null;
if (!pool.length) { console.log(`${tile} ${size}x${size}: empty pool, run tools/fill_library.mjs first`); process.exit(0); }

while (Date.now() - t0 < maxMs) {
  // a seed: one of the sparsest puzzles that can still be tried (random among the sparsest few, so chains branch)
  const live = pool.filter(p => (tries.get(p.name) ?? 0) < MAX_TRIES && blockedOf(p) >= sizes[0]);
  if (!live.length) break;
  live.sort((a, b) => blockedOf(a) - blockedOf(b));
  const seedPuzzle = live[Math.floor(rng() * Math.min(12, live.length))];
  const holes = blockedOf(seedPuzzle);
  const deltas = sizes.filter(d => d <= holes && sizeFeasible(tile, cells - holes + d));
  if (!deltas.length) { tries.set(seedPuzzle.name, MAX_TRIES); continue; }
  const delta = deltas[Math.floor(rng() * deltas.length)];
  attempts++;
  const res = sparsifyPuzzle({ puzzle: seedPuzzle, delta, rng, maxMs: Math.min(attemptMs, maxMs - (Date.now() - t0)) });
  if (!res) { tries.set(seedPuzzle.name, (tries.get(seedPuzzle.name) ?? 0) + 1); continue; }
  const key = canonicalGrid(res.puzzle.grid, rows, cols);
  if (seen.has(key)) { tries.set(seedPuzzle.name, (tries.get(seedPuzzle.name) ?? 0) + 1); continue; }
  seen.add(key);
  const r = ratePuzzle(res.puzzle);
  pool.push({ ...res.puzzle, name: `${tile}_${rows}x${cols}_${puzzleHash(res.puzzle).slice(0, 8)}`, rules: r.rules, tier: r.tier, score: r.score });
  added++;
  save();
  log(`  ${holes} -> ${blockedOf(res.puzzle)} blocked in ${(res.stats.ms / 1000).toFixed(1)}s (${r.tier} ${r.score}); added ${added}`);
}
save();
const mins = pool.map(blockedOf);
const lowest = Math.min(...mins);
console.log(`${tile} ${size}x${size} (${shapeName(tile)}): +${added} sparser puzzles from ${attempts} attempts; fewest blocked cells ${minStart} -> ${lowest} ` +
  `(${pool.filter(p => blockedOf(p) <= 0.17 * cells).length} puzzles at or under 17%) pool ${pool.length} ${((Date.now() - t0) / 60000).toFixed(1)} min`);
