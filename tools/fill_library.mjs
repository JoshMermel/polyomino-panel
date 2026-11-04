// Fill (or top up) the puzzle pool for one shape at one square size.
//
//   node tools/fill_library.mjs --tile P5 --size 8 [--target 400] [--max-minutes 15] [--seed N]
//
// The pool is tools/library/<tile>_<size>x<size>.csv: many scored puzzles with a
// unique solution each, far more than any book needs. The books in data/ are
// built from pools by tools/build_books.mjs.
//
// How it fills: the number of blocked cells is the main difficulty knob (more
// blocked cells = easier), so the tool sweeps it. It finds the smallest blocked-
// cell count the generator can handle for this shape and size, then spreads the
// target evenly over that count and every larger one (up to 45% of the board).
// Every puzzle is scored (js/rating.js) as it is added. Rotated/mirrored
// duplicates are skipped. Re-running adds to the pool (the file is rewritten
// after every sweep step, so an interrupted run loses little).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { parseCsv, toCsv, puzzleHash, shapeName } from '../js/logic.js';
import { generatePuzzle, mulberry32, canonicalGrid, holeLadder } from '../js/generator.js';
import { ratePuzzle, TIERS } from '../js/rating.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]]);
  return acc;
}, []));
const tile = args.tile ?? 'L';
const size = Number(args.size ?? 8);
const target = Number(args.target ?? 400);
const maxMs = Number(args['max-minutes'] ?? 15) * 60000;
const seed = Number(args.seed ?? Math.floor(Math.random() * 2 ** 31));
const quiet = 'quiet' in args;
const rows = size, cols = size;

const dir = new URL('./library/', import.meta.url);
mkdirSync(dir, { recursive: true });
const file = new URL(`${tile}_${rows}x${cols}.csv`, dir);

const pool = existsSync(file) ? parseCsv(readFileSync(file, 'utf8')) : [];
const seen = new Set(pool.map(p => canonicalGrid(p.grid, rows, cols)));
const t0 = Date.now();
const log = (...m) => { if (!quiet) console.error(...m); };
const save = () => writeFileSync(file, '# pool: generated, scored puzzles (not published). See tools/fill_library.mjs\n' + toCsv(pool));
const holesOf = p => [...p.grid].filter(c => c === '#').length;

const ladder = holeLadder(rows, cols, tile);
if (pool.length >= target) {
  console.log(`${tile} ${size}x${size}: pool already has ${pool.length} >= ${target}`);
  process.exit(0);
}

// 1. Find the smallest blocked-cell count the generator handles (some are impossible or too rare).
let feasible = [];
const rng0 = mulberry32(seed);
for (const k of ladder) {
  let ok = feasible.length > 0;       // once one level works, assume every larger one does
  for (let attempt = 0; !ok && attempt < 2 && Date.now() - t0 < maxMs; attempt++) {
    ok = !!generatePuzzle({ rows, cols, tile, holes: k, rng: rng0, maxMs: 2500 });
  }
  if (ok) feasible.push(k); else log(`  ${k} blocked: not feasible, skipping`);
}
if (!feasible.length) { console.log(`${tile} ${size}x${size}: no feasible blocked-cell count (pool ${pool.length})`); process.exit(0); }

// 2. Spread the target over the feasible levels; leftover quota (exhausted levels) goes to the others.
const perLevel = new Map(feasible.map(k => [k, pool.filter(p => holesOf(p) === k).length]));
const exhausted = new Set();
let added = 0, round = 0;
while (pool.length < target && Date.now() - t0 < maxMs && exhausted.size < feasible.length) {
  const open = feasible.filter(k => !exhausted.has(k));
  const quota = Math.max(1, Math.ceil((target - pool.length) / open.length));
  for (const k of open) {
    if (pool.length >= target || Date.now() - t0 >= maxMs) break;
    const rng = mulberry32(seed * 1000003 + k * 7919 + round);
    let made = 0, dups = 0, fails = 0;
    while (made < quota && dups < 120 && fails < 3 && pool.length < target && Date.now() - t0 < maxMs) {
      const res = generatePuzzle({ rows, cols, tile, holes: k, rng, maxMs: 6000 });
      if (!res) { fails++; continue; }
      const key = canonicalGrid(res.puzzle.grid, rows, cols);
      if (seen.has(key)) { dups++; continue; }
      seen.add(key);
      const r = ratePuzzle(res.puzzle);
      pool.push({ ...res.puzzle, name: `${tile}_${rows}x${cols}_${puzzleHash(res.puzzle).slice(0, 8)}`, rules: r.rules, tier: r.tier, score: r.score });
      made++; added++;
    }
    perLevel.set(k, (perLevel.get(k) ?? 0) + made);
    if (made < quota) exhausted.add(k);            // ran out of distinct puzzles (or too slow) at this level
    save();
    log(`  ${String(k).padStart(3)} blocked: +${made} (pool ${pool.length}/${target})`);
  }
  round++;
}
save();

const lv = Object.fromEntries(TIERS.map(t => [t, 0]));
pool.forEach(p => { lv[p.tier] = (lv[p.tier] ?? 0) + 1; });
const scores = pool.map(p => p.score).sort((a, b) => a - b);
console.log(`${tile} ${size}x${size} (${shapeName(tile)}): pool ${pool.length} (+${added}) tiers ${TIERS.map(t => lv[t]).join('/')} ` +
  `score ${scores[0]}..${scores[scores.length - 1]} blocked ${feasible[0]}..${feasible[feasible.length - 1]} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
