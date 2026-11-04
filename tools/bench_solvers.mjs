// Benchmark of exact-cover tiling counters (count tilings of a board's open
// cells up to a cap). Not used by the app.
//
//   node tools/bench_solvers.mjs
//
// Solvers
//   current   the original solver (tests/reference_solver.mjs): always fills the
//             first empty cell
//   scan      "smarter own search": at every node, scan all empty cells, count
//             the placements that still fit each one, branch on the cell with
//             the fewest (0 prunes, 1 is forced). No incremental bookkeeping.
//   counters  same choice rule, but per-cell option counts are updated
//             incrementally on place/undo (arrays only, no linked lists)
//   dlx       Knuth's Algorithm X with dancing links, branching on the item
//             with the fewest options (standalone copy used for this benchmark)
//   shipped   js/logic.js searchTilings, which is now DLX too (includes its
//             support for randomization, budgets and keeping tilings)
//
// All four return min(cap, number of tilings), so they must agree exactly.
import { readFileSync } from 'node:fs';
import { parseCsv, searchTilings, getOrientations, tileSize, OPEN } from '../js/logic.js';
import { referenceSearch } from '../tests/reference_solver.mjs';
import { randomInitial, mulberry32 } from '../js/generator.js';

// --- shared preprocessing: every placement of the tile on open cells ---------
function placements(puzzle) {
  const { rows, cols, grid, tile } = puzzle;
  const n = rows * cols;
  const pl = [];
  const cellPl = Array.from({ length: n }, () => []);
  for (const o of getOrientations(tile)) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cells = [];
        let ok = true;
        for (const [dr, dc] of o) {
          const nr = r + dr, nc = c + dc - o[0][1];
          if (nr >= rows || nc < 0 || nc >= cols || grid[nr * cols + nc] !== OPEN) { ok = false; break; }
          cells.push(nr * cols + nc);
        }
        if (!ok) continue;
        const id = pl.length;
        pl.push(Int32Array.from(cells));
        for (const x of cells) cellPl[x].push(id);
      }
    }
  }
  return { n, pl, cellPl, size: tileSize(tile) };
}

const openCount = p => [...p.grid].filter(ch => ch === OPEN).length;

// --- 1. current ----------------------------------------------------------------
function solveCurrent(puzzle, cap) {
  const r = referenceSearch(puzzle, { limit: cap });
  return { count: r.count, nodes: r.nodes };
}

function solveShipped(puzzle, cap) {
  const r = searchTilings(puzzle, { limit: cap, keep: false });
  return { count: r.count, nodes: r.nodes };
}

// --- 2. smarter own search, scanning ----------------------------------------------
function solveScan(puzzle, cap) {
  const { n, pl, cellPl, size } = placements(puzzle);
  const filled = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (puzzle.grid[i] !== OPEN) filled[i] = 1;
  let count = 0, nodes = 0;
  const fits = pid => {
    const cs = pl[pid];
    for (let k = 0; k < cs.length; k++) if (filled[cs[k]]) return false;
    return true;
  };
  const rec = remaining => {
    nodes++;
    if (remaining === 0) { count++; return; }
    let best = -1, bestCnt = 1 << 30;
    for (let i = 0; i < n; i++) {
      if (filled[i]) continue;
      let k = 0;
      const lst = cellPl[i];
      for (let j = 0; j < lst.length; j++) {
        if (fits(lst[j]) && ++k >= bestCnt) break;
      }
      if (k < bestCnt) { bestCnt = k; best = i; if (k <= 1) break; }
    }
    if (bestCnt === 0) return;
    const lst = cellPl[best];
    for (let j = 0; j < lst.length; j++) {
      const pid = lst[j];
      if (!fits(pid)) continue;
      const cs = pl[pid];
      for (let k = 0; k < cs.length; k++) filled[cs[k]] = 1;
      rec(remaining - size);
      for (let k = 0; k < cs.length; k++) filled[cs[k]] = 0;
      if (count >= cap) return;
    }
  };
  if (openCount(puzzle) % size === 0) rec(openCount(puzzle));
  return { count, nodes };
}

// --- 3. smarter own search, incremental counters -------------------------------
function solveCounters(puzzle, cap) {
  const { n, pl, cellPl, size } = placements(puzzle);
  const filled = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (puzzle.grid[i] !== OPEN) filled[i] = 1;
  const blocked = new Int32Array(pl.length);          // filled cells inside each placement
  const cnt = new Int32Array(n);                      // live placements covering each cell
  for (let i = 0; i < n; i++) cnt[i] = cellPl[i].length;
  let count = 0, nodes = 0;

  const place = pid => {
    const cs = pl[pid];
    for (let a = 0; a < cs.length; a++) {
      const x = cs[a];
      filled[x] = 1;
      const lst = cellPl[x];
      for (let j = 0; j < lst.length; j++) {
        const q = lst[j];
        if (blocked[q]++ === 0) { const qs = pl[q]; for (let b = 0; b < qs.length; b++) cnt[qs[b]]--; }
      }
    }
  };
  const unplace = pid => {
    const cs = pl[pid];
    for (let a = cs.length - 1; a >= 0; a--) {
      const x = cs[a];
      const lst = cellPl[x];
      for (let j = lst.length - 1; j >= 0; j--) {
        const q = lst[j];
        if (--blocked[q] === 0) { const qs = pl[q]; for (let b = 0; b < qs.length; b++) cnt[qs[b]]++; }
      }
      filled[x] = 0;
    }
  };

  const rec = remaining => {
    nodes++;
    if (remaining === 0) { count++; return; }
    let best = -1, bestCnt = 1 << 30;
    for (let i = 0; i < n; i++) {
      if (filled[i]) continue;
      const k = cnt[i];
      if (k < bestCnt) { bestCnt = k; best = i; if (k <= 1) break; }
    }
    if (bestCnt === 0) return;
    const lst = cellPl[best];
    for (let j = 0; j < lst.length; j++) {
      const pid = lst[j];
      if (blocked[pid] !== 0) continue;
      place(pid);
      rec(remaining - size);
      unplace(pid);
      if (count >= cap) return;
    }
  };
  if (openCount(puzzle) % size === 0) rec(openCount(puzzle));
  return { count, nodes };
}

// --- 4. DLX -------------------------------------------------------------------------
function solveDlx(puzzle, cap) {
  const { n, pl, size } = placements(puzzle);
  if (openCount(puzzle) % size !== 0) return { count: 0, nodes: 0 };
  const itemOf = new Int32Array(n).fill(-1);
  let m = 0;
  for (let i = 0; i < n; i++) if (puzzle.grid[i] === OPEN) itemOf[i] = ++m;
  const total = m + 1 + pl.length * size;
  const L = new Int32Array(total), R = new Int32Array(total), U = new Int32Array(total),
        D = new Int32Array(total), C = new Int32Array(total), S = new Int32Array(m + 1);
  for (let j = 0; j <= m; j++) { L[j] = j === 0 ? m : j - 1; R[j] = j === m ? 0 : j + 1; U[j] = D[j] = j; C[j] = j; }
  let nn = m + 1;
  for (const cs of pl) {
    const first = nn;
    for (let k = 0; k < cs.length; k++, nn++) {
      const col = itemOf[cs[k]];
      C[nn] = col; U[nn] = U[col]; D[nn] = col; D[U[col]] = nn; U[col] = nn; S[col]++;
      if (k === 0) { L[nn] = R[nn] = nn; } else { L[nn] = nn - 1; R[nn] = first; R[nn - 1] = nn; L[first] = nn; }
    }
  }
  let count = 0, nodes = 0;
  const cover = c => {
    L[R[c]] = L[c]; R[L[c]] = R[c];
    for (let i = D[c]; i !== c; i = D[i]) for (let j = R[i]; j !== i; j = R[j]) { U[D[j]] = U[j]; D[U[j]] = D[j]; S[C[j]]--; }
  };
  const uncover = c => {
    for (let i = U[c]; i !== c; i = U[i]) for (let j = L[i]; j !== i; j = L[j]) { S[C[j]]++; U[D[j]] = j; D[U[j]] = j; }
    L[R[c]] = c; R[L[c]] = c;
  };
  const search = () => {
    nodes++;
    if (R[0] === 0) { count++; return; }
    let c = R[0], best = S[c];
    for (let j = R[c]; j !== 0 && best > 1; j = R[j]) if (S[j] < best) { best = S[j]; c = j; }
    if (best === 0) return;
    cover(c);
    for (let r = D[c]; r !== c; r = D[r]) {
      for (let j = R[r]; j !== r; j = R[j]) cover(C[j]);
      search();
      for (let j = L[r]; j !== r; j = L[j]) uncover(C[j]);
      if (count >= cap) break;
    }
    uncover(c);
  };
  search();
  return { count, nodes };
}

const SOLVERS = { current: solveCurrent, scan: solveScan, counters: solveCounters, dlx: solveDlx, shipped: solveShipped };

// --- harness ----------------------------------------------------------------------------
const LIMIT_MS = 30000;
const now = () => Number(process.hrtime.bigint()) / 1e6;

function runWorkload(name, boards, cap) {
  const results = {};
  let reference = null;
  for (const [sname, fn] of Object.entries(SOLVERS)) {
    let best = Infinity, nodes = 0, counts = null, timedOut = false;
    for (let rep = 0; rep < 3; rep++) {
      const t0 = now();
      const cs = [];
      let nd = 0;
      for (const b of boards) {
        const r = fn(b, cap);
        cs.push(r.count); nd += r.nodes;
        if (now() - t0 > LIMIT_MS) { timedOut = true; break; }
      }
      const ms = now() - t0;
      if (timedOut) { best = ms; counts = null; nodes = nd; break; }
      if (ms < best) best = ms;
      nodes = nd; counts = cs;
      if (ms > 2000) break; // slow: one rep is enough
    }
    results[sname] = { ms: best, nodes, timedOut };
    if (counts) {
      if (!reference) reference = counts;
      else if (JSON.stringify(reference) !== JSON.stringify(counts)) {
        console.log(`  !! ${sname} DISAGREES with reference on ${name}`);
      }
    }
  }
  const base = results.current;
  console.log(`\n${name}  (${boards.length} board${boards.length === 1 ? '' : 's'}, cap ${cap})`);
  console.log('  solver     time ms     nodes   vs current (time | nodes)');
  for (const [sname, r] of Object.entries(results)) {
    const t = r.timedOut ? `>${(r.ms / 1000).toFixed(0)}s` : r.ms.toFixed(1);
    const sp = r.timedOut || base.timedOut ? '   n/a' : `${(base.ms / r.ms).toFixed(1)}x`.padStart(7);
    const ns = r.timedOut || base.timedOut ? '' : `${(base.nodes / Math.max(1, r.nodes)).toFixed(1)}x`;
    console.log(`  ${sname.padEnd(9)} ${t.padStart(9)} ${String(r.nodes).padStart(10)}  ${sp} | ${ns}`);
  }
  if (reference) {
    const exact = reference.filter(c => c < cap).length;
    console.log(`  (counts agree; ${exact}/${reference.length} boards counted exactly, rest hit the cap)`);
  }
}

// random solvable boards for a tile/size (as the generator sees them)
function randomBoards(rows, cols, tile, count, seed) {
  const rng = mulberry32(seed);
  const holes = defaultHolesFor(rows, cols, tile);
  const out = [];
  for (let tries = 0; out.length < count && tries < count * 20; tries++) {
    const st = randomInitial(rows, cols, tile, holes, rng, 50);
    if (st) out.push({ rows, cols, tile, grid: Array.from(st.mask, h => (h ? '#' : '.')).join('') });
  }
  return out;
}
function defaultHolesFor(rows, cols, tile) {
  const cells = rows * cols, size = tileSize(tile), target = cells * 0.15;
  let best = null;
  for (let k = cells % size; k <= cells - size; k += size) if (best === null || Math.abs(k - target) < Math.abs(best - target)) best = k;
  return best;
}

const dataDir = new URL('../data/', import.meta.url);
const shipped = ['L_6x6.csv', 'L_8x8.csv', 'L_10x10.csv']
  .flatMap(f => parseCsv(readFileSync(new URL(f, dataDir), 'utf8')));

runWorkload('A. uniqueness check of shipped puzzles', shipped, 2);
runWorkload('B1. generator-style counting, 8x8 L', randomBoards(8, 8, 'L', 60, 1), 40);
runWorkload('B2. generator-style counting, 10x10 L', randomBoards(10, 10, 'L', 60, 2), 40);
runWorkload('C. larger board, 12x12 L', randomBoards(12, 12, 'L', 20, 3), 40);
runWorkload('D1. other shape: P pentomino, 10x10', randomBoards(10, 10, 'XX/XX/X.', 30, 4), 40);
runWorkload('D2. other shape: F pentomino, 10x10', randomBoards(10, 10, '.XX/XX./.X.', 30, 5), 40);
runWorkload('E. enumerate many tilings: empty 6x8, L, cap 100000',
  [{ rows: 6, cols: 8, tile: 'L', grid: '.'.repeat(48) }], 100000);
