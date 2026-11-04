// Independent reference implementation: the original simple backtracking
// tiling search (always fill the first empty cell). Slow but obviously
// correct; used to cross-check the DLX search in js/logic.js and as the
// "current" baseline in tools/bench_solvers.mjs.
import { allOrientations, sizeFeasible, OPEN } from '../js/logic.js';

// Returns { count, aborted, nodes }; stops after `limit` tilings.
export function referenceSearch(puzzle, { limit = 2, budget = Infinity } = {}) {
  const { rows, cols, grid, tile } = puzzle;
  const orients = allOrientations(tile);
  const assign = new Int16Array(rows * cols);
  let openCount = 0;
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] === OPEN) { assign[i] = -2; openCount++; } else assign[i] = -1;
  }
  const result = { count: 0, aborted: false, nodes: 0 };
  if (!sizeFeasible(tile, openCount)) return result;

  function rec(from) {
    if (result.aborted || result.count >= limit) return;
    if (++result.nodes > budget) { result.aborted = true; return; }
    let i = from;
    while (i < assign.length && assign[i] !== -2) i++;
    if (i === assign.length) { result.count++; return; }
    const r = Math.floor(i / cols), c = i % cols;
    for (const o of orients) {
      const c0 = c - o[0][1];
      const cells = [];
      let ok = true;
      for (const [dr, dc] of o) {
        const nr = r + dr, nc = c0 + dc;
        if (nr >= rows || nc < 0 || nc >= cols || assign[nr * cols + nc] !== -2) { ok = false; break; }
        cells.push(nr * cols + nc);
      }
      if (!ok) continue;
      for (const k of cells) assign[k] = 1;
      rec(i + 1);
      for (const k of cells) assign[k] = -2;
      if (result.aborted || result.count >= limit) return;
    }
  }
  rec(0);
  return result;
}
