// Puzzle generator: finds blocked-cell layouts whose open cells can be tiled
// by a given polyomino in exactly one way. Pure logic (no DOM / node APIs), so
// it can run in node (tools/generate.mjs) or, later, in the browser.
//
// Method: local search over (blocked cells, tiling) pairs where the tiling
// is always a valid solution, so the number of solutions is always >= 1.
// Each move picks a small window of nearby tiles + blocked cells, then
// re-randomizes it (moves the blocked cells around inside the window and
// re-tiles it). The move is kept when the puzzle's total number of solutions
// doesn't go up (with occasional uphill moves, simulated-annealing style).
// The search stops when the count reaches exactly 1.
//
// Difficulty is not considered at all; only uniqueness.
import {
  BLOCKED, OPEN, minTileSize, allOrientations, sizeFeasible, solutionShapeCounts, countSolutions, labelString, solve,
  hasSwastika, openCellsConnected,
} from './logic.js';

// Small seedable PRNG (mulberry32) so runs are reproducible.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Is `holes` a number of blocked cells that leaves open cells made of whole tiles?
const holesFit = (rows, cols, tile, holes) => {
  const open = rows * cols - holes;
  return holes >= 0 && open >= minTileSize(tile) && sizeFeasible(tile, open);
};

// Number of blocked cells that makes the open cells divisible into tiles,
// closest to `ratio` of the board (real L-panel puzzles use ~15%).
export function defaultHoles(rows, cols, tile, ratio = 0.15) {
  const cells = rows * cols;
  const target = cells * ratio;
  let best = null;
  for (let k = 0; k <= cells - minTileSize(tile); k++) {
    if (!holesFit(rows, cols, tile, k)) continue;
    if (best === null || Math.abs(k - target) < Math.abs(best - target)) best = k;
  }
  return best;
}

// Smallest grid (over the 8 symmetries of a rectangle that apply) string, so
// that rotated / mirrored copies of a puzzle can be recognised as the same.
export function canonicalGrid(grid, rows, cols) {
  const at = (r, c) => grid[r * cols + c];
  const variants = [];
  for (let t = 0; t < 8; t++) {
    const swap = t >= 4;
    if (swap && rows !== cols) continue; // transposes only keep the shape if square
    const R = swap ? cols : rows, C = swap ? rows : cols;
    let s = '';
    for (let r = 0; r < R; r++) {
      for (let c = 0; c < C; c++) {
        let rr = r, cc = c;
        if (t & 1) rr = R - 1 - rr;
        if (t & 2) cc = C - 1 - cc;
        s += swap ? at(cc, rr) : at(rr, cc);
      }
    }
    variants.push(`${R}x${C}:${s}`);
  }
  return variants.sort()[0];
}

const makePuzzle = (rows, cols, tile, holeMask) => ({
  rows, cols, tile,
  grid: Array.from(holeMask, h => (h ? BLOCKED : OPEN)).join(''),
  solution: '',
});

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Randomized search for a packing: place tiles on the open cells (those not
// pre-blocked) so that exactly `holes` open cells stay uncovered. At the first
// empty cell the search either puts a tile there (any orientation) or, if holes
// remain, leaves it as a hole; options are tried in random order.
// Returns a per-cell array (tile id, or -1 for blocked / uncovered cells), or
// null if none was found within the node budget.
function randomPacking(rows, cols, tile, preBlocked, holes, rng, budget) {
  const orients = allOrientations(tile);
  const n = rows * cols;
  const assign = new Int32Array(n);
  for (let i = 0; i < n; i++) assign[i] = preBlocked[i] ? -1 : -2;
  let nodes = 0;

  function rec(from, nextId, holesLeft) {
    if (++nodes > budget) return false;
    let i = from;
    while (i < n && assign[i] !== -2) i++;
    if (i === n) return holesLeft === 0;
    const r = Math.floor(i / cols), c = i % cols;

    const options = [];
    for (const o of orients) {
      const c0 = c - o[0][1];
      const cells = [];
      let ok = true;
      for (const [dr, dc] of o) {
        const nr = r + dr, nc = c0 + dc;
        if (nr >= rows || nc < 0 || nc >= cols || assign[nr * cols + nc] !== -2) { ok = false; break; }
        cells.push(nr * cols + nc);
      }
      if (ok) options.push(cells);
    }
    if (holesLeft > 0) options.push(null); // null = leave this cell as a hole
    shuffle(options, rng);

    for (const cells of options) {
      if (cells === null) {
        assign[i] = -1;
        if (rec(i + 1, nextId, holesLeft - 1)) return true;
        assign[i] = -2;
      } else {
        for (const k of cells) assign[k] = nextId;
        if (rec(i + 1, nextId + 1, holesLeft)) return true;
        for (const k of cells) assign[k] = -2;
      }
      if (nodes > budget) return false;
    }
    return false;
  }
  return rec(0, 0, holes) ? assign : null;
}

// Random valid (blocked cells, tiling) pair with exactly `holes` blocked cells.
export function randomInitial(rows, cols, tile, holes, rng, attempts = 300) {
  const n = rows * cols;
  const none = new Uint8Array(n);
  for (let a = 0; a < attempts; a++) {
    const assign = randomPacking(rows, cols, tile, none, holes, rng, 20000);
    if (assign) {
      const mask = new Uint8Array(n);
      for (let i = 0; i < n; i++) if (assign[i] < 0) mask[i] = 1;
      return { mask, assign };
    }
  }
  return null;
}

// Propose a neighbouring state: re-randomize a window around a random cell.
// Returns a new {mask, assign} (never mutates `state`), or null if the move
// found nothing new.
// With `delta` > 0 the window is re-packed with that many FEWER blocked cells (delta should be a tile
// size, so the open cells still divide into whole tiles): the puzzle gets sparser. The window is then
// centred on a blocked cell.
function proposeMove(state, rows, cols, tile, rng, delta = 0) {
  const { mask, assign } = state;
  const n = rows * cols;
  let centre = Math.floor(rng() * n);
  if (delta > 0) {
    const blocked = [];
    for (let i = 0; i < n; i++) if (mask[i]) blocked.push(i);
    if (!blocked.length) return null;
    centre = blocked[Math.floor(rng() * blocked.length)];
  }
  const cr = Math.floor(centre / cols), cc = centre % cols;
  const radius = [1, 2, 2, 3][Math.floor(rng() * 4)];

  // Tiles and blocked cells within `radius` (Manhattan) of the centre.
  const tileIds = new Set();
  const holesIn = new Set();
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols), c = i % cols;
    if (Math.abs(r - cr) + Math.abs(c - cc) > radius) continue;
    if (mask[i]) holesIn.add(i); else tileIds.add(assign[i]);
  }
  if (tileIds.size === 0 || tileIds.size > 6) return null;

  const window = [...holesIn];
  for (let i = 0; i < n; i++) if (!mask[i] && tileIds.has(assign[i])) window.push(i);
  const holeCount = holesIn.size - delta;
  if (holeCount < 0) return null;

  // The new tiles reuse the old tiles' ids; with one tile size the window holds the same
  // number of tiles as before, with several sizes it may hold more (fresh ids) or fewer.
  const ids = [...tileIds];
  let fresh = 0;
  for (let i = 0; i < n; i++) if (assign[i] >= fresh) fresh = assign[i] + 1;

  // Everything outside the window stays blocked for this sub-problem; inside,
  // re-pack with the same number of blocked cells.
  const outside = new Uint8Array(n).fill(1);
  for (const i of window) outside[i] = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const t = randomPacking(rows, cols, tile, outside, holeCount, rng, 4000);
    if (!t) continue;

    // Map the new tiles' ids onto the old ids.
    const remap = new Map();
    const newMask = mask.slice(), newAssign = assign.slice();
    let changed = false;
    for (const i of window) {
      if (t[i] < 0) {
        newMask[i] = 1; newAssign[i] = -1;
        if (!mask[i]) changed = true;
      } else {
        if (!remap.has(t[i])) remap.set(t[i], remap.size < ids.length ? ids[remap.size] : fresh++);
        newMask[i] = 0; newAssign[i] = remap.get(t[i]);
        if (mask[i] || newAssign[i] !== assign[i]) changed = true;
      }
    }
    if (changed) return { mask: newMask, assign: newAssign };
  }
  return null;
}

// Generate one puzzle with a unique solution.
//   rows, cols, tile   board size and tile spec (name or pattern)
//   holes              number of blocked cells (default: ~15% of the board)
//   rng                () => [0,1); default mulberry32(1)
//   maxMs              give up after this long (default 20 s)
//   cap, budget        solution-count cap and node budget per evaluation
//   allowSwastika      keep puzzles whose solution's tile boundaries contain a
//                      swastika pattern (see logic.hasSwastika). Default: reject.
//   allowDisconnected  keep puzzles whose open cells are not one connected region
//                      (see logic.openCellsConnected). Default: reject.
//   minSolutions, maxSolutions  accept a layout with this many solutions instead of exactly one
//                      (default 1 and 1). With more than one the puzzle isn't unique: the caller
//                      has to fix that (see tools/make_given_puzzles.mjs, which adds given edges).
// Returns { puzzle, stats: {moves, restarts, ms} } or null on timeout.
export function generatePuzzle({
  rows, cols, tile = 'L', holes, rng = mulberry32(1),
  maxMs = 20000, cap = 40, budget = 200000, restartAfter = 4000, allowSwastika = false, allowDisconnected = false,
  minSolutions = 1, maxSolutions = 1,
}) {
  holes = holes ?? defaultHoles(rows, cols, tile);
  if (!holesFit(rows, cols, tile, holes)) {
    throw new Error(`${holes} blocked cells leaves ${rows * cols - holes} open cells, ` +
      `which can't be tiled by whole tiles of ${tile}`);
  }
  const start = Date.now();
  const timeLeft = () => Date.now() - start < maxMs;
  const stats = { moves: 0, restarts: 0, ms: 0 };
  const count = mask => countSolutions(makePuzzle(rows, cols, tile, mask), cap, budget);

  while (timeLeft()) {
    stats.restarts++;
    let state = randomInitial(rows, cols, tile, holes, rng);
    if (!state) continue;
    let cost = count(state.mask);

    for (let it = 0; it < restartAfter && timeLeft(); it++) {
      if (cost >= minSolutions && cost <= maxSolutions) {
        const puzzle = makePuzzle(rows, cols, tile, state.mask);
        puzzle.solution = labelString(state.assign);
        // with several allowed shapes, the intended solution must use every one of them
        const usesAll = solutionShapeCounts(puzzle, puzzle.solution).every(k => k > 0);
        if (usesAll && (allowDisconnected || openCellsConnected(puzzle)) && (allowSwastika || !hasSwastika(puzzle, puzzle.solution))) {
          // Independent final check with the plain solver.
          if (maxSolutions === 1 && solve(puzzle, 2).length !== 1) throw new Error('internal error: not unique');
          stats.ms = Date.now() - start;
          return { puzzle, stats };
        }
      }
      const next = proposeMove(state, rows, cols, tile, rng);
      if (!next) continue;
      stats.moves++;
      const c2 = count(next.mask);
      // Accept if no worse; sometimes accept worse (log-scale temperature).
      if (c2 <= cost || rng() < Math.exp(-(Math.log(c2) - Math.log(cost)) / 0.35)) {
        state = next; cost = c2;
      }
    }
  }
  stats.ms = Date.now() - start;
  return null;
}

// Like generatePuzzle, but picks the number of blocked cells itself: starts at
// `holes` (default ~15% of the board) and adds blocked cells (the next count that
// still leaves whole tiles) whenever a level takes longer than `levelMs` (some shapes
// can't pack a board with few holes, or only rarely). Returns { puzzle, stats, holes }
// or null if no level worked.
export function generatePuzzleAuto({ rows, cols, tile = 'L', holes, levelMs = 5000, ...rest }) {
  let h = holes ?? defaultHoles(rows, cols, tile);
  while (h <= rows * cols - minTileSize(tile)) {
    if (holesFit(rows, cols, tile, h)) {
      const res = generatePuzzle({ ...rest, rows, cols, tile, holes: h, maxMs: levelMs });
      if (res) return { ...res, holes: h };
    }
    h++;
  }
  return null;
}

// The blocked-cell counts that leave a tileable number of open cells, from the
// smallest up to `maxFraction` of the board: [k0, k0 + size, k0 + 2*size, ...] for one
// tile size, every count that fits for several.
export function holeLadder(rows, cols, tile, maxFraction = 0.45) {
  const cells = rows * cols;
  const out = [];
  for (let k = 0; k <= cells * maxFraction; k++) if (holesFit(rows, cols, tile, k)) out.push(k);
  return out;
}

// --- Moving between unique puzzles (used by the hunter, tools/hunt_library.mjs) ----
// A search "state" is {mask, assign}: which cells are blocked and a tile id per open
// cell (-1 for blocked), i.e. a puzzle together with its solution.

export function stateFromPuzzle(puzzle) {
  const n = puzzle.rows * puzzle.cols;
  const mask = new Uint8Array(n);
  const assign = new Int32Array(n).fill(-1);
  const ids = new Map();
  for (let i = 0; i < n; i++) {
    if (puzzle.grid[i] === BLOCKED) { mask[i] = 1; continue; }
    const label = puzzle.solution[i];
    if (!ids.has(label)) ids.set(label, ids.size);
    assign[i] = ids.get(label);
  }
  return { mask, assign };
}

// The puzzle for a state, with its (canonically labelled) solution filled in. It is
// only *uniquely* solvable if countSolutions(puzzle, 2) says so.
export function puzzleFromState(state, rows, cols, tile) {
  const puzzle = makePuzzle(rows, cols, tile, state.mask);
  puzzle.solution = labelString(state.assign);
  return puzzle;
}

// Make a unique puzzle SPARSER: the same kind of puzzle with `delta` fewer blocked cells (delta: a tile
// size). Frees blocked cells in one small window and re-tiles it, which almost always makes the puzzle
// ambiguous, then runs the generator's own local search (moves of the same number of blocked cells) from
// there until the solution is unique again, trying new windows after `restartAfter` moves. Returns
// { puzzle, stats } or null when `maxMs` runs out.
export function sparsifyPuzzle({
  puzzle, delta, rng = mulberry32(1), maxMs = 20000, cap = 40, budget = 200000, restartAfter = 1500,
}) {
  const { rows, cols, tile } = puzzle;
  const start = Date.now();
  const timeLeft = () => Date.now() - start < maxMs;
  const stats = { moves: 0, restarts: 0, ms: 0 };
  const count = mask => countSolutions(makePuzzle(rows, cols, tile, mask), cap, budget);
  const base = stateFromPuzzle(puzzle);
  while (timeLeft()) {
    stats.restarts++;
    let state = proposeMove(base, rows, cols, tile, rng, delta);
    if (!state) continue;
    let cost = count(state.mask);
    for (let it = 0; it < restartAfter && timeLeft(); it++) {
      if (cost === 1) {
        const out = puzzleFromState(state, rows, cols, tile);
        const usesAll = solutionShapeCounts(out, out.solution).every(k => k > 0);
        if (usesAll && openCellsConnected(out) && !hasSwastika(out, out.solution)) {
          if (solve(out, 2).length !== 1) throw new Error('internal error: not unique');
          stats.ms = Date.now() - start;
          return { puzzle: out, stats };
        }
      }
      const next = proposeMove(state, rows, cols, tile, rng);
      if (!next) continue;
      stats.moves++;
      const c2 = count(next.mask);
      if (c2 <= cost || rng() < Math.exp(-(Math.log(c2) - Math.log(cost)) / 0.35)) { state = next; cost = c2; }
    }
  }
  stats.ms = Date.now() - start;
  return null;
}

// A neighbouring state: re-randomizes a small window of tiles and blocked cells
// (the generator's own move). Returns null if the move found nothing new.
export function neighborState(state, rows, cols, tile, rng) {
  return proposeMove(state, rows, cols, tile, rng);
}
