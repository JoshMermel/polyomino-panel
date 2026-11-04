// Hunt for hard puzzles and add them to a pool in tools/library/.
//
//   node tools/hunt_library.mjs --tile L --size 8 --minutes 30
//        [--want Hard,Expert,Unsolved] [--targets Hard=150,Expert=150,Unsolved=100]
//        [--min-distance 4] [--seed N]
//        [--probe-minutes 3] [--stall-minutes 10] [--until EPOCH_MS]
//
// Rejection sampling (what tools/fill_library.mjs does) finds the easy and medium
// puzzles quickly on small boards, but the top tiers are thin, so this tool looks
// specifically for puzzles that need the hard rules (see js/rating.js) and stores only
// those. With --want Beginner,Medium it hunts the other end instead: easy puzzles on
// the bigger boards, where plain sampling almost never lands (the pools were thin there). Two
// modes are mixed:
//   explore  generate fresh uniquely-solvable puzzles at a blocked-cell count picked
//            by a running estimate of which counts yield hard puzzles
//   exploit  take a hard puzzle found earlier, perturb it with the generator's window
//            moves, keep neighbours that are still uniquely solvable, and rate them
// Every puzzle is rated with the real rules, so nothing is stored that the solver
// hasn't verified. Puzzles whose solution's tile boundaries contain a swastika pattern
// (see logic.hasSwastika) are rejected. Rotated/mirrored duplicates are skipped, and so are near-duplicates
// (a perturbed puzzle that differs from a stored one in fewer than --min-distance
// cells), so the pool doesn't fill up with siblings of a few puzzles.
//
// Stops at the time limit, when every target is met, or when nothing new has turned
// up for --stall-minutes. If nothing hard has turned up after --probe-minutes the
// combination is written off (rigid shapes that never get past the easy rules).
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { parseCsv, toCsv, puzzleHash, countSolutions, shapeName, hasSwastika } from '../js/logic.js';
import {
  generatePuzzle, mulberry32, canonicalGrid, stateFromPuzzle, puzzleFromState, neighborState,
} from '../js/generator.js';
import { ratePuzzle, TIERS } from '../js/rating.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]]);
  return acc;
}, []));
const tile = args.tile ?? 'L';
const size = Number(args.size ?? 8);
const rows = size, cols = size;
const minutes = Number(args.minutes ?? 30);
const probeMs = Number(args['probe-minutes'] ?? 3) * 60000;
const stallMs = Number(args['stall-minutes'] ?? 10) * 60000;
const seed = Number(args.seed ?? Math.floor(Math.random() * 2 ** 31));
// which tiers count as finds (default: the hard ones; --want Beginner,Medium hunts easy puzzles)
const want = new Set((args.want ?? 'Hard,Expert,Unsolved').split(',').filter(Boolean));
const targets = { Beginner: 150, Medium: 150, Hard: 150, Expert: 150, Unsolved: 100 };
const minDistance = Number(args['min-distance'] ?? 4);   // a find must differ from stored puzzles in this many cells
for (const kv of (args.targets ?? '').split(',').filter(Boolean)) { const [k, v] = kv.split('='); targets[k] = Number(v); }
const cap = t => (targets[t] ?? 0) * 4;                // stop storing a tier at 4x its target
const quiet = 'quiet' in args;

const t0 = Date.now();
const deadline = Math.min(t0 + minutes * 60000, Number(args.until ?? Infinity));
const dir = new URL('./library/', import.meta.url);
mkdirSync(dir, { recursive: true });
const file = new URL(`${tile}_${rows}x${cols}.csv`, dir);
const pool = existsSync(file) ? parseCsv(readFileSync(file, 'utf8')) : [];
const seen = new Set(pool.map(p => canonicalGrid(p.grid, rows, cols)));
const counts = Object.fromEntries(TIERS.map(t => [t, 0]));
pool.forEach(p => { counts[p.tier] = (counts[p.tier] ?? 0) + 1; });
const startCounts = { ...counts };
const holesOf = p => { let k = 0; for (const c of p.grid) if (c === '#') k++; return k; };

const tierSummary = () => [...want].map(t => `${t} ${counts[t]}`).join(' ');
const log = (...m) => { if (!quiet) console.error(`[${((Date.now() - t0) / 60000).toFixed(1)}m]`, ...m); };
function save() {
  const tmp = new URL(`${tile}_${rows}x${cols}.csv.tmp`, dir);
  writeFileSync(tmp, '# pool: generated, scored puzzles (not published). See tools/fill_library.mjs / hunt_library.mjs\n' + toCsv(pool));
  renameSync(tmp, file);                                 // atomic replace
}

// --- what counts as a find -------------------------------------------------------
const VALUE = { Beginner: 3, Medium: 1, Hard: 1, Expert: 3, Unsolved: 4 };   // how much a find of this tier is worth
const needed = t => want.has(t) && counts[t] < (targets[t] ?? 0);
const worth = t => (needed(t) ? VALUE[t] : 0.05);
const allMet = () => [...want].every(t => !needed(t));

// Blocked-cell counts to try: the ones the pool already has puzzles for (so known feasible).
const levels = [...new Set(pool.map(holesOf))].sort((a, b) => a - b);
if (!levels.length) { console.log(`${tile} ${size}x${size}: empty pool (run fill_library first)`); process.exit(0); }
const arms = new Map(levels.map(k => [k, { secs: 0, value: 0, tries: 0 }]));
const rng = mulberry32(seed);
const pickArm = () => {
  if (rng() < 0.25) return levels[Math.floor(rng() * levels.length)];
  let best = levels[0], bestRate = -1;
  for (const k of levels) { const a = arms.get(k); const rate = (a.value + 0.5) / (a.secs + 5); if (rate > bestRate) { best = k; bestRate = rate; } }
  return best;
};

// Near-duplicate guard: stored grids grouped by blocked-cell count (a window move
// keeps the count), compared cell by cell.
const byHoles = new Map();
const addGrid = g => { let k = 0; for (const c of g) if (c === '#') k++; if (!byHoles.has(k)) byHoles.set(k, []); byHoles.get(k).push(g); };
pool.forEach(p => addGrid(p.grid));
function tooSimilar(grid) {
  let k = 0; for (const c of grid) if (c === '#') k++;
  const list = byHoles.get(k);
  if (!list) return false;
  for (const g of list) {
    let d = 0;
    for (let i = 0; i < grid.length && d < minDistance; i++) if (grid[i] !== g[i]) d++;
    if (d < minDistance) return true;
  }
  return false;
}

// Parents for exploit mode: puzzles found (or already in the pool) that need hard rules.
const parents = pool.filter(p => want.has(p.tier));
parents.forEach(p => { p.uses = 0; });
const stats = { explore: { tries: 0, found: 0, secs: 0 }, exploit: { tries: 0, found: 0, secs: 0 } };
let lastFind = Date.now(), added = 0, nextSave = Date.now() + 60000, nextLog = Date.now() + 60000;

function consider(puzzle, mode, arm) {
  const key = canonicalGrid(puzzle.grid, rows, cols);
  if (seen.has(key)) return 0;
  seen.add(key);
  if (hasSwastika(puzzle, puzzle.solution)) return 0;            // a swastika in the tile boundaries: reject
  const r = ratePuzzle(puzzle);
  if (!want.has(r.tier) || counts[r.tier] >= cap(r.tier)) return 0;
  if (tooSimilar(puzzle.grid)) return 0;
  addGrid(puzzle.grid);
  const row = { ...puzzle, name: `${tile}_${rows}x${cols}_${puzzleHash(puzzle).slice(0, 8)}`, rules: r.rules, tier: r.tier, score: r.score };
  pool.push(row);
  row.uses = 0;
  parents.push(row);
  counts[r.tier]++;
  added++;
  stats[mode].found++;
  lastFind = Date.now();
  if (arm !== undefined) arms.get(arm).value += worth(r.tier);
  return worth(r.tier);
}

while (Date.now() < deadline && !allMet()) {
  const now = Date.now();
  if (now - lastFind > stallMs && now - t0 > probeMs) { log('stalled: nothing new for a while'); break; }
  if (now - t0 > probeMs && added === 0 && !parents.length) { log('probe found nothing hard: giving up on this combination'); break; }

  const exploit = parents.length > 0 && rng() < 0.6;
  const s0 = Date.now();
  if (exploit) {
    // a few perturbations of one parent; prefer parents that are harder
    const parent = (() => {
      let best = null;
      for (let i = 0; i < 6; i++) {
        const c = parents[Math.floor(rng() * parents.length)];
        if (!best || c.uses < best.uses || (c.uses === best.uses && VALUE[c.tier] > VALUE[best.tier])) best = c;
      }
      best.uses++;
      return best;
    })();
    const base = stateFromPuzzle(parent);
    let state = base;
    for (let step = 0; step < 10 && Date.now() < deadline; step++) {
      const nb = neighborState(state, rows, cols, tile, rng);
      stats.exploit.tries++;
      if (!nb) continue;
      const q = puzzleFromState(nb, rows, cols, tile);
      if (countSolutions(q, 2, 100000) !== 1) continue;      // a perturbation that broke uniqueness
      state = nb;                                              // random walk through unique puzzles
      consider(q, 'exploit');
    }
    stats.exploit.secs += (Date.now() - s0) / 1000;
  } else {
    const k = pickArm();
    const res = generatePuzzle({ rows, cols, tile, holes: k, rng, maxMs: 5000 });
    stats.explore.tries++;
    if (res) consider(res.puzzle, 'explore', k);
    const dt = (Date.now() - s0) / 1000;
    stats.explore.secs += dt;
    arms.get(k).secs += dt; arms.get(k).tries++;
  }
  if (Date.now() >= nextSave) { save(); nextSave = Date.now() + 60000; }
  if (Date.now() >= nextLog) {
    nextLog = Date.now() + 60000;
    log(`${tierSummary()} (+${added})  ` +
      `explore ${stats.explore.found}/${stats.explore.tries}  exploit ${stats.exploit.found}/${stats.exploit.tries}`);
  }
}
save();

const gained = t => counts[t] - (startCounts[t] ?? 0);
const rate = m => (stats[m].secs ? (60 * stats[m].found / stats[m].secs).toFixed(1) : '-');
console.log(`${tile} ${size}x${size} (${shapeName(tile)}): +${added} hard puzzles in ${((Date.now() - t0) / 60000).toFixed(1)}m -> ` +
  `${[...want].map(t => `${t} ${counts[t]} (+${gained(t)})`).join(' ')}  ` +
  `finds/min explore ${rate('explore')} exploit ${rate('exploit')}`);
