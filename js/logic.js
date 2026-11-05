// Pure puzzle logic: no DOM access, so it runs in the browser and in node
// (tools/build_csvs.mjs uses it to verify puzzles).
//
// Puzzle model
//   rows, cols : grid size
//   grid       : string of rows*cols chars, row-major. '#' = blocked (red)
//                cell, '.' = open cell.
//   tile       : name of the tile shape the open cells must be cut into
//                (a key of SHAPES). Only "L" is used for now; the others are
//                here so variants don't need new plumbing.
//   solution   : optional string, same layout as grid; each open cell holds a
//                tile label (any char other than '.' / '#'), blocked cells '#'.
//
// Edge model
//   A player's lines live on grid edges. h[r*cols + c]       is the edge ABOVE
//   cell (r,c), r in 0..rows; v[r*(cols+1) + c] is the edge LEFT of cell
//   (r,c), c in 0..cols. Each holds EMPTY, LINE or CROSS.
//   Only "interior" edges (between two open cells) are playable; edges next to
//   a blocked cell or the outer border are implicit walls.

export const BLOCKED = '#';
export const OPEN = '.';

export const EDGE_EMPTY = 0;
export const EDGE_LINE = 1;
export const EDGE_CROSS = 2;

// Named tile shapes. Any rotation/reflection is allowed. Other shapes can be
// given inline as patterns (see resolveShape): rows of 'X' and '.' separated
// by '/'. The one-letter names (L I O T S) are the tetrominoes and are used
// by existing puzzle files; the rest are named by letter + size.
const NAMED_PATTERNS = {
  // tetrominoes
  L: 'X./X./XX',  I: 'X/X/X/X',  O: 'XX/XX',  T: 'XXX/.X.',  S: '.XX/XX.',
  // domino, trominoes
  I2: 'XX',  I3: 'XXX',  V3: 'X./XX',
  // pentominoes
  F5: '.XX/XX./.X.',  I5: 'XXXXX',  L5: 'X./X./X./XX',  N5: '.X/.X/XX/X.',
  P5: 'XX/XX/X.',  T5: 'XXX/.X./.X.',  U5: 'X.X/XXX',  V5: 'X../X../XXX',
  W5: 'X../XX./.XX',  X5: '.X./XXX/.X.',  Y5: '.X/XX/.X/.X',  Z5: 'XX./.X./.XX',
};

// Human-readable names for the named shapes.
const SHAPE_LABELS = {
  L: 'L tetromino', I: 'I tetromino', O: 'O tetromino', T: 'T tetromino', S: 'S tetromino',
  I2: 'domino', I3: 'I tromino', V3: 'V tromino',
  F5: 'F pentomino', I5: 'I pentomino', L5: 'L pentomino', N5: 'N pentomino',
  P5: 'P pentomino', T5: 'T pentomino', U5: 'U pentomino', V5: 'V pentomino',
  W5: 'W pentomino', X5: 'X pentomino', Y5: 'Y pentomino', Z5: 'Z pentomino',
};

// The order shapes are listed in menus (the O tetromino is deliberately absent).
export const SHAPE_ORDER = ['I2', 'I3', 'V3', 'L', 'I', 'T', 'S',
  'F5', 'I5', 'L5', 'N5', 'P5', 'T5', 'U5', 'V5', 'W5', 'X5', 'Y5', 'Z5'];

function patternCells(pattern) {
  const cells = [];
  pattern.split('/').forEach((row, r) => {
    [...row].forEach((ch, c) => { if (ch !== '.') cells.push([r, c]); });
  });
  return cells;
}

// name -> [row, col] cell list
export const SHAPES = Object.fromEntries(
  Object.entries(NAMED_PATTERNS).map(([name, pat]) => [name, patternCells(pat)]));

// --- Shapes ----------------------------------------------------------------

// Translate so min row = min col = 0 and sort row-major.
function normalize(cells) {
  const minR = Math.min(...cells.map(p => p[0]));
  const minC = Math.min(...cells.map(p => p[1]));
  return cells
    .map(([r, c]) => [r - minR, c - minC])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

const cellsKey = cells => cells.map(p => p.join(',')).join(';');

const shapeCache = new Map();

// Resolve a tile spec to a cell list. A spec is either a name in SHAPES or an
// inline pattern: rows of 'X' (tile cell) and '.' (empty) separated by '/',
// e.g. "X./X./XX" is the L tetromino and "XX/XX/X." is the P pentomino. The
// pattern form contains no commas, so it can sit in a CSV column. Patterns
// must be 4-connected.
export function resolveShape(spec) {
  if (SHAPES[spec]) return SHAPES[spec];
  if (shapeCache.has(spec)) return shapeCache.get(spec);
  if (!/^[Xx.]+(\/[Xx.]+)*$/.test(spec)) throw new Error(`Unknown tile shape "${spec}"`);
  const cells = patternCells(spec);
  if (!cells.length) throw new Error(`Tile pattern "${spec}" has no cells`);
  // connectivity check
  const key = ([r, c]) => `${r},${c}`;
  const all = new Set(cells.map(key));
  const seenCells = new Set([key(cells[0])]);
  const stack = [cells[0]];
  while (stack.length) {
    const [r, c] = stack.pop();
    for (const n of [[r + 1, c], [r - 1, c], [r, c + 1], [r, c - 1]]) {
      if (all.has(key(n)) && !seenCells.has(key(n))) { seenCells.add(key(n)); stack.push(n); }
    }
  }
  if (seenCells.size !== cells.length) throw new Error(`Tile pattern "${spec}" is not connected`);
  shapeCache.set(spec, cells);
  return cells;
}

const orientationCache = new Map();

// All distinct orientations (rotations + reflections) of a shape spec, each
// normalized and sorted row-major.
export function getOrientations(spec) {
  if (orientationCache.has(spec)) return orientationCache.get(spec);
  const base = resolveShape(spec);
  const seen = new Map();
  let cur = base;
  for (let flip = 0; flip < 2; flip++) {
    for (let rot = 0; rot < 4; rot++) {
      const norm = normalize(cur);
      seen.set(cellsKey(norm), norm);
      cur = cur.map(([r, c]) => [c, -r]); // rotate 90 degrees
    }
    cur = cur.map(([r, c]) => [r, -c]); // reflect
  }
  const result = [...seen.values()];
  orientationCache.set(spec, result);
  return result;
}

export function tileSize(spec) {
  return resolveShape(spec).length;
}

// --- Several allowed tiles ----------------------------------------------------
// A puzzle's `tile` is one shape spec ("L", "XX/X.") or several joined with '+' ("L+T"):
// every tile of the solution is then one of those shapes (rotations and reflections
// allowed; each may be used any number of times). One shape is just the special case N=1.
const specsCache = new Map();

// The shape specs of a (possibly multi-shape) tile spec, validated and pairwise different.
export function tileSpecs(spec) {
  if (specsCache.has(spec)) return specsCache.get(spec);
  const specs = spec.split('+');
  const keys = new Set();
  for (const sp of specs) {
    resolveShape(sp);
    keys.add(canonicalKey(sp));
  }
  if (keys.size !== specs.length) throw new Error(`Tile "${spec}" lists the same shape twice`);
  specsCache.set(spec, specs);
  return specs;
}

// Every orientation of every allowed shape (the placements a tile can take).
const allOrientationsCache = new Map();
export function allOrientations(spec) {
  if (!allOrientationsCache.has(spec)) allOrientationsCache.set(spec, tileSpecs(spec).flatMap(getOrientations));
  return allOrientationsCache.get(spec);
}

// The distinct tile sizes (cell counts), ascending.
const tileSizesCache = new Map();
export function tileSizes(spec) {
  let sizes = tileSizesCache.get(spec);
  if (!sizes) {
    sizes = [...new Set(tileSpecs(spec).map(tileSize))].sort((a, b) => a - b);
    tileSizesCache.set(spec, sizes);
  }
  return sizes;
}
export const minTileSize = spec => tileSizes(spec)[0];
export const maxTileSize = spec => tileSizes(spec).at(-1);

// Can n cells be made of whole tiles, i.e. is n a sum of allowed tile sizes?
const feasibleCache = new Map();
export function sizeFeasible(spec, n) {
  let ok = feasibleCache.get(spec);
  if (!ok) { ok = [true]; feasibleCache.set(spec, ok); }
  const sizes = tileSizes(spec);
  while (ok.length <= n) {
    const k = ok.length;
    ok.push(sizes.some(z => z <= k && ok[k - z]));
  }
  return ok[n];
}

// Which allowed shape (index into tileSpecs) is this set of cells, or -1.
export function shapeIndexOf(spec, cells, cols) {
  const key = cellsKey(normalize(cells.map(i => [Math.floor(i / cols), i % cols])));
  return tileSpecs(spec).findIndex(sp => getOrientations(sp).some(o => cellsKey(o) === key));
}

// How many tiles of each allowed shape the solution uses: [count of shape 0, count of shape 1, ...].
export function solutionShapeCounts(puzzle, solution) {
  const counts = new Array(tileSpecs(puzzle.tile).length).fill(0);
  const byLabel = new Map();
  for (let i = 0; i < solution.length; i++) {
    if (solution[i] === BLOCKED) continue;
    if (!byLabel.has(solution[i])) byLabel.set(solution[i], []);
    byLabel.get(solution[i]).push(i);
  }
  for (const cells of byLabel.values()) {
    const k = shapeIndexOf(puzzle.tile, cells, puzzle.cols);
    if (k >= 0) counts[k]++;
  }
  return counts;
}

// Orientation-independent identity of a shape (same for all rotations/reflections).
function canonicalKey(spec) {
  return getOrientations(spec).map(cellsKey).sort()[0];
}

let labelByCanonical = null;

// Display name for a tile spec: a name from the library if the shape matches
// one (in any orientation), else "N-cell shape".
export function shapeName(spec) {
  if (spec.includes('+')) return tileSpecs(spec).map(shapeName).join(' + ');
  if (!labelByCanonical) {
    labelByCanonical = new Map(Object.keys(SHAPE_LABELS).map(n => [canonicalKey(n), SHAPE_LABELS[n]]));
  }
  const n = tileSize(spec);
  return labelByCanonical.get(canonicalKey(spec)) ?? (n === 1 ? 'monomino' : `${n}-cell shape`);
}

// --- Parsing ---------------------------------------------------------------

// Parse puzzle CSV text. Needs a header row whose first column is "name".
// Columns: name, rows, cols, grid  (required); tile, solution, rules, tier, score (optional).
// Blank lines and lines starting with '#' are ignored.
// Returns [{name, rows, cols, tile, grid, solution}].
// Given edges: marks that are part of the puzzle (pre-drawn for the player, who can't change them). A
// puzzle with just a few distinct tilings can be made unique by giving an edge or two. In the CSV they
// are one `given` column: items joined by `;`, each `<L or X>:<h or v>:<row>:<col>` (L = a line, X = a
// cross, i.e. "these two cells are in the same tile"; the edge is named as in the rest of the code:
// h = above cell (row, col), v = left of it). In memory: puzzle.givens = [['L', 'v', 2, 3], ...].
export function parseGivens(text, puzzle) {
  const out = [];
  for (const item of text.split(';').map(x => x.trim()).filter(Boolean)) {
    const [type, kind, r, c] = item.split(':');
    const row = Number(r), col = Number(c);
    if (!['L', 'X'].includes(type) || !['h', 'v'].includes(kind) || !Number.isInteger(row) || !Number.isInteger(col)) {
      throw new Error(`Puzzle "${puzzle.name}": bad given edge "${item}"`);
    }
    if (!isPlayableEdge(puzzle, kind, row, col)) throw new Error(`Puzzle "${puzzle.name}": given edge "${item}" is not between two open cells`);
    out.push([type, kind, row, col]);
  }
  return out;
}
// Do the puzzle's given edges rule these cells out as one tile? A given line inside them would cut it in
// two, and a given cross on their outline says a neighbouring cell is in the same tile.
export function givensRuleOutTile(puzzle, cells) {
  if (!puzzle.givens?.length) return false;
  const has = (type, [kind, r, c]) => puzzle.givens.some(g => g[0] === type && g[1] === kind && g[2] === r && g[3] === c);
  return tileInterior(puzzle, cells).some(e => has('L', e)) || tileOutline(puzzle, cells).some(e => has('X', e));
}
export const givensString = puzzle => (puzzle.givens ?? []).map(g => g.join(':')).join(';');
export const isGivenEdge = (puzzle, kind, r, c) => (puzzle.givens ?? []).some(g => g[1] === kind && g[2] === r && g[3] === c);

export function parseCsv(text) {
  const puzzles = [];
  let headers = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const cols = line.split(',').map(s => s.trim());
    if (cols[0] === 'name') { headers = cols; continue; }
    if (!headers) throw new Error('CSV must start with a header row beginning with "name"');
    const rec = {};
    headers.forEach((h, i) => { rec[h] = cols[i] ?? ''; });
    const rows = parseInt(rec.rows, 10);
    const ncols = parseInt(rec.cols, 10);
    const grid = rec.grid;
    if (!(rows > 0 && ncols > 0)) throw new Error(`Puzzle "${rec.name}": bad rows/cols`);
    if (grid.length !== rows * ncols) {
      throw new Error(`Puzzle "${rec.name}": grid has ${grid.length} chars, expected ${rows * ncols}`);
    }
    if (/[^.#]/.test(grid)) throw new Error(`Puzzle "${rec.name}": grid may only contain '.' and '#'`);
    const tile = rec.tile || 'L';
    try { tileSpecs(tile); } catch (err) { throw new Error(`Puzzle "${rec.name}": ${err.message}`); }
    const solution = rec.solution && rec.solution.length === grid.length ? rec.solution : '';
    const puzzle = {
      name: rec.name, rows, cols: ncols, tile, grid, solution,
      rules: rec.rules || '', tier: rec.tier || '',
      score: rec.score === undefined || rec.score === '' ? null : Number(rec.score),
    };
    if (rec.given) puzzle.givens = parseGivens(rec.given, puzzle);
    puzzles.push(puzzle);
  }
  return puzzles;
}

export function toCsv(puzzles) {
  // Optional `rules` column: which deduction rules solve the puzzle (see rating.js).
  const withRules = puzzles.some(p => p.rules);
  const withTier = puzzles.some(p => p.tier);
  const withScore = puzzles.some(p => p.score !== undefined && p.score !== null);
  const withGiven = puzzles.some(p => p.givens?.length);
  const lines = [`name,rows,cols,tile,grid,solution${withRules ? ',rules' : ''}${withTier ? ',tier' : ''}${withScore ? ',score' : ''}${withGiven ? ',given' : ''}`];
  for (const p of puzzles) {
    const row = [p.name, p.rows, p.cols, p.tile, p.grid, p.solution || ''];
    if (withRules) row.push(p.rules || '');
    if (withTier) row.push(p.tier || '');
    if (withScore) row.push(p.score ?? '');
    if (withGiven) row.push(givensString(p));
    lines.push(row.join(','));
  }
  return lines.join('\n') + '\n';
}

// Stable 64-bit identifier (16 hex chars) for a puzzle's content: tile, size,
// grid and given edges. Independent of name and position in any set, so saved progress
// survives renumbering/reordering. (cyrb53-style non-cryptographic hash.)
export function puzzleHash(puzzle) {
  const str = `${puzzle.tile}|${puzzle.rows}x${puzzle.cols}|${puzzle.grid}${puzzle.givens?.length ? '|' + givensString(puzzle) : ''}`;
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

// --- Edges -----------------------------------------------------------------

// A blank set of marks: nothing drawn except the puzzle's given edges, if it has any.
export function newEdges(puzzle) {
  const edges = {
    h: new Uint8Array((puzzle.rows + 1) * puzzle.cols),
    v: new Uint8Array(puzzle.rows * (puzzle.cols + 1)),
  };
  for (const [type, kind, r, c] of puzzle.givens ?? []) edges[kind][kind === 'h' ? r * puzzle.cols + c : r * (puzzle.cols + 1) + c] = type === 'L' ? EDGE_LINE : EDGE_CROSS;
  return edges;
}

export function cloneEdges(e) {
  return { h: e.h.slice(), v: e.v.slice() };
}

export const edgeIndex = (puzzle, kind, r, c) =>
  kind === 'h' ? r * puzzle.cols + c : r * (puzzle.cols + 1) + c;

export const isOpen = (puzzle, r, c) =>
  r >= 0 && r < puzzle.rows && c >= 0 && c < puzzle.cols &&
  puzzle.grid[r * puzzle.cols + c] === OPEN;

// An edge is playable when both cells it separates are open.
// kind 'h': edge above (r,c) separates (r-1,c) and (r,c).
// kind 'v': edge left of (r,c) separates (r,c-1) and (r,c).
export function isPlayableEdge(puzzle, kind, r, c) {
  return kind === 'h'
    ? isOpen(puzzle, r - 1, c) && isOpen(puzzle, r, c)
    : isOpen(puzzle, r, c - 1) && isOpen(puzzle, r, c);
}

export function getEdge(puzzle, edges, kind, r, c) {
  return edges[kind][edgeIndex(puzzle, kind, r, c)];
}

export function setEdge(puzzle, edges, kind, r, c, state) {
  edges[kind][edgeIndex(puzzle, kind, r, c)] = state;
}

// --- Checking --------------------------------------------------------------

// Group open cells into regions connected through edges that are not LINEs
// (crosses are just reminders and don't separate anything), and test each
// region against the puzzle's tile shape.
// Returns { regions: [{cells: [idx...], valid, shape, wrong}], validCount, total, solved }
// (shape = index into tileSpecs(tile) of a valid region's shape, else -1)
// where total = number of tiles a solution needs: open cells / tile size when every allowed
// shape has the same size, else the number in the stored solution (null if there is none).
export function analyze(puzzle, edges) {
  const { rows, cols, tile } = puzzle;
  const sizes = tileSizes(tile);
  const specs = tileSpecs(tile);
  const minSize = sizes[0];
  const keys = new Set(allOrientations(tile).map(cellsKey));
  const seen = new Uint8Array(rows * cols);
  const regions = [];
  let openCount = 0;

  for (let start = 0; start < rows * cols; start++) {
    if (puzzle.grid[start] !== OPEN) continue;
    openCount++;
    if (seen[start]) continue;
    const cells = [];
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop();
      cells.push(i);
      const r = Math.floor(i / cols), c = i % cols;
      const visit = (nr, nc, kind, er, ec) => {
        if (!isOpen(puzzle, nr, nc)) return;
        const j = nr * cols + nc;
        if (seen[j]) return;
        if (getEdge(puzzle, edges, kind, er, ec) === EDGE_LINE) return;
        seen[j] = 1;
        stack.push(j);
      };
      visit(r, c + 1, 'v', r, c + 1);
      visit(r, c - 1, 'v', r, c);
      visit(r + 1, c, 'h', r + 1, c);
      visit(r - 1, c, 'h', r, c);
    }
    let valid = false, shape = -1;               // shape: which allowed shape (index into tileSpecs) a valid tile is
    if (sizes.includes(cells.length)) {
      const norm = normalize(cells.map(i => [Math.floor(i / cols), i % cols]));
      valid = keys.has(cellsKey(norm));
      if (valid) shape = specs.length === 1 ? 0 : shapeIndexOf(tile, cells, cols);
    }
    // A region that is already too small, or exactly tile-sized but the wrong
    // shape, can never become a tile: it's walled in by lines/blocked cells.
    // (Bigger regions might still be cut up later, so they aren't "wrong".)
    regions.push({ cells, valid, shape, wrong: !valid && cells.length <= minSize });
  }

  const validCount = regions.filter(r => r.valid).length;
  const total = sizes.length === 1 ? Math.floor(openCount / minSize)
    : puzzle.solution ? new Set(puzzle.solution.replaceAll(BLOCKED, '')).size : null;
  const solved = regions.length > 0 && validCount === regions.length;
  return { regions, validCount, total, solved };
}

// Convert a solution string (tile labels per cell) into edge lines: a LINE on
// every playable edge whose two cells carry different labels.
export function edgesFromSolution(puzzle, solution) {
  const edges = newEdges(puzzle);
  const { rows, cols } = puzzle;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (c > 0 && isPlayableEdge(puzzle, 'v', r, c) &&
          solution[r * cols + c] !== solution[r * cols + c - 1]) {
        setEdge(puzzle, edges, 'v', r, c, EDGE_LINE);
      }
      if (r > 0 && isPlayableEdge(puzzle, 'h', r, c) &&
          solution[r * cols + c] !== solution[(r - 1) * cols + c]) {
        setEdge(puzzle, edges, 'h', r, c, EDGE_LINE);
      }
    }
  }
  return edges;
}

// --- Solver ----------------------------------------------------------------

const LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

// Turn a per-cell tile-id array (negative = blocked) into a label string,
// labelling tiles in order of first appearance, '#' for blocked cells.
export function labelString(assign) {
  const map = new Map();
  let out = '';
  for (let k = 0; k < assign.length; k++) {
    if (assign[k] < 0) { out += BLOCKED; continue; }
    if (!map.has(assign[k])) map.set(assign[k], map.size);
    out += LABELS[map.get(assign[k]) % LABELS.length];
  }
  return out;
}

// Exact-cover search for tilings of a puzzle's open cells: Knuth's Algorithm X
// with dancing links. Items are the open cells; options are all placements of
// the tile on open cells. It always branches on the cell with the fewest
// remaining placements (0 = dead end, 1 = forced), which is what makes it
// several times faster than filling cells in row-major order.
//   limit   stop after this many tilings
//   rng     optional () => [0,1) ; when given, placements are shuffled first,
//           so the first tiling found is a random one
//   budget  max search nodes; exceeding it aborts the search
//   keep    store each tiling (per-cell tile ids, -1 for blocked cells) in
//           result.tilings
// Returns { count, aborted, tilings, nodes }.
// Every placement of the tile that fits inside a rows x cols board (open or not), as cell
// lists, in a fixed order (orientation, then row, then column). Cached per tile and board size:
// a search only has to drop the placements that touch a blocked cell.
const placementsCache = new Map();
export function boardPlacements(tile, rows, cols) {
  const key = `${tile}|${rows}x${cols}`;
  let all = placementsCache.get(key);
  if (!all) {
    all = [];
    for (const o of allOrientations(tile)) {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const cells = [];
          for (const [dr, dc] of o) {
            const nr = r + dr, nc = c + dc - o[0][1];
            if (nr >= rows || nc < 0 || nc >= cols) break;
            cells.push(nr * cols + nc);
          }
          if (cells.length === o.length) all.push(cells);
        }
      }
    }
    placementsCache.set(key, all);
  }
  return all;
}

// The search's linked-list arrays, reused between calls (every entry in use is rewritten).
let dlx = null;
function dlxArrays(total, m) {
  if (!dlx || total > dlx.size) {
    const size = Math.max(total, 2 * (dlx?.size ?? 0));
    const make = () => new Int32Array(size);
    dlx = { size, L: make(), R: make(), U: make(), D: make(), C: make(), S: make(), rowOf: make() };
  }
  dlx.S.fill(0, 0, m + 1);
  return dlx;
}

export function searchTilings(puzzle, { limit = 2, rng = null, budget = Infinity, keep = true } = {}) {
  const { rows, cols, grid, tile } = puzzle;
  const n = rows * cols;
  const result = { count: 0, aborted: false, tilings: [], nodes: 0 };

  const itemOf = new Int32Array(n).fill(-1);
  let m = 0;
  for (let i = 0; i < n; i++) if (grid[i] === OPEN) itemOf[i] = ++m;   // items 1..m
  if (!sizeFeasible(tile, m)) return result;

  // All placements of the tile on open cells, as lists of cell indices.
  const pls = [];
  for (const cells of boardPlacements(tile, rows, cols)) {
    let open = true;
    for (let k = 0; k < cells.length; k++) if (itemOf[cells[k]] < 0) { open = false; break; }
    if (open) pls.push(cells);
  }
  if (rng) {
    for (let i = pls.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [pls[i], pls[j]] = [pls[j], pls[i]];
    }
  }

  // Dancing-links matrix. Node 0 is the root, 1..m are column headers.
  let total = m + 1;
  for (const cells of pls) total += cells.length;
  // L, R, U, D, C: the links and column of each node; S: column sizes; rowOf: node -> placement index
  const { L, R, U, D, C, S, rowOf } = dlxArrays(total, m);
  for (let j = 0; j <= m; j++) {
    L[j] = j === 0 ? m : j - 1; R[j] = j === m ? 0 : j + 1; U[j] = D[j] = j; C[j] = j;
  }
  let nn = m + 1;
  pls.forEach((cells, pid) => {
    const first = nn;
    for (let k = 0; k < cells.length; k++, nn++) {
      const col = itemOf[cells[k]];
      C[nn] = col; rowOf[nn] = pid;
      U[nn] = U[col]; D[nn] = col; D[U[col]] = nn; U[col] = nn; S[col]++;
      if (k === 0) { L[nn] = R[nn] = nn; } else { L[nn] = nn - 1; R[nn] = first; R[nn - 1] = nn; L[first] = nn; }
    }
  });

  const cover = c => {
    L[R[c]] = L[c]; R[L[c]] = R[c];
    for (let i = D[c]; i !== c; i = D[i]) {
      for (let j = R[i]; j !== i; j = R[j]) { U[D[j]] = U[j]; D[U[j]] = D[j]; S[C[j]]--; }
    }
  };
  const uncover = c => {
    for (let i = U[c]; i !== c; i = U[i]) {
      for (let j = L[i]; j !== i; j = L[j]) { S[C[j]]++; U[D[j]] = j; D[U[j]] = j; }
    }
    L[R[c]] = c; R[L[c]] = c;
  };

  const chosen = [];   // placement ids of the current partial tiling
  // Returns true when the search should stop (limit reached or budget blown).
  // On stopping we return without uncovering: the matrix is discarded anyway.
  const search = () => {
    if (++result.nodes > budget) { result.aborted = true; return true; }
    if (R[0] === 0) {
      result.count++;
      if (keep) {
        const assign = new Int16Array(n).fill(-1);
        chosen.forEach((pid, id) => { for (const cell of pls[pid]) assign[cell] = id; });
        result.tilings.push(assign);
      }
      return result.count >= limit;
    }
    let c = R[0], best = S[c];
    for (let j = R[c]; j !== 0 && best > 1; j = R[j]) if (S[j] < best) { best = S[j]; c = j; }
    if (best === 0) return false;
    cover(c);
    for (let r = D[c]; r !== c; r = D[r]) {
      for (let j = R[r]; j !== r; j = R[j]) cover(C[j]);
      chosen.push(rowOf[r]);
      if (search()) return true;
      chosen.pop();
      for (let j = L[r]; j !== r; j = L[j]) uncover(C[j]);
    }
    uncover(c);
    return false;
  };
  search();
  return result;
}

// Find up to `limit` ways to cut the open cells into tiles of the puzzle's
// shape. Returns an array of solution strings (tile labels per cell, '#' for
// blocked cells).
export function solve(puzzle, limit = 2) {
  return searchTilings(puzzle, { limit }).tilings.map(labelString);
}

// Does a solution agree with the puzzle's given edges (a line where the solution has a tile boundary,
// a cross where both cells are in the same tile)?
export function matchesGivens(puzzle, solution) {
  const { cols } = puzzle;
  return (puzzle.givens ?? []).every(([type, kind, r, c]) => {
    const a = kind === 'v' ? r * cols + c - 1 : (r - 1) * cols + c;
    const b = r * cols + c;
    return type === 'L' ? solution[a] !== solution[b] : solution[a] === solution[b];
  });
}

// The solutions of a puzzle that has given edges: those tilings (looking at up to `scan` of them) that
// agree with the givens. At most `limit` are returned. (For a puzzle without givens it is solve().)
export function solveWithGivens(puzzle, limit = 2, scan = 500) {
  if (!puzzle.givens?.length) return solve(puzzle, limit);
  return solve(puzzle, scan).filter(sol => matchesGivens(puzzle, sol)).slice(0, limit);
}

// Number of tilings, counted up to `cap`. Returns cap if the node budget is
// exhausted first (treat as "at least cap").
// The generator tools can swap in a faster counter (tools/lib/wasm_counter.mjs); it must give the
// same answer for every input.
let customCounter = null;
export function useCounter(fn) { customCounter = fn; }
export function countSolutions(puzzle, cap = 2, budget = Infinity) {
  if (customCounter) return customCounter(puzzle, cap, budget);
  const res = searchTilings(puzzle, { limit: cap, budget, keep: false });
  return res.aborted ? cap : res.count;
}

// --- Marks, hints ----------------------------------------------------------

// Every playable edge as [kind, r, c].
export function playableEdges(puzzle) {
  const out = [];
  for (const kind of ['h', 'v']) {
    const rMax = kind === 'h' ? puzzle.rows : puzzle.rows - 1;
    const cMax = kind === 'h' ? puzzle.cols - 1 : puzzle.cols;
    for (let r = 0; r <= rMax; r++) {
      for (let c = 0; c <= cMax; c++) {
        if (isPlayableEdge(puzzle, kind, r, c)) out.push([kind, r, c]);
      }
    }
  }
  return out;
}

// The puzzle's solution string: the stored one if present, otherwise computed
// when the puzzle has exactly one solution. null if neither is available.
export function getSolution(puzzle) {
  if (puzzle.solution && puzzle.solution.length === puzzle.grid.length) return puzzle.solution;
  const sols = solve(puzzle, 2);
  return sols.length === 1 ? sols[0] : null;
}

// Compare the player's marks with the solution. A line is wrong where the
// solution has no line (both cells in one tile); a cross is wrong where the
// solution does have a line. Returns [{kind, r, c, state}] of wrong marks.
export function checkMarks(puzzle, edges, solution) {
  const expected = edgesFromSolution(puzzle, solution);
  const wrong = [];
  for (const [kind, r, c] of playableEdges(puzzle)) {
    const mark = getEdge(puzzle, edges, kind, r, c);
    const needsLine = getEdge(puzzle, expected, kind, r, c) === EDGE_LINE;
    if ((mark === EDGE_LINE && !needsLine) || (mark === EDGE_CROSS && needsLine)) {
      wrong.push({ kind, r, c, state: mark });
    }
  }
  return wrong;
}

// The two cell indices an interior edge separates.
export function edgeCells(puzzle, kind, r, c) {
  const { cols } = puzzle;
  return kind === 'h' ? [(r - 1) * cols + c, r * cols + c] : [r * cols + c - 1, r * cols + c];
}

// Edges where the solution has no line and the player has made no mark:
// candidates for a "place a cross" hint. Edges inside an already closed shape
// (a region fully walled in, as big as one tile or smaller) are skipped: a
// cross there tells the player nothing. Returns [[kind, r, c], ...].
export function crossHints(puzzle, edges, solution) {
  const expected = edgesFromSolution(puzzle, solution);
  const size = maxTileSize(puzzle.tile);
  // region id per cell, for regions that are closed (tile-sized or smaller)
  const closed = new Map();
  analyze(puzzle, edges).regions.forEach((reg, id) => {
    if (reg.cells.length <= size) reg.cells.forEach(i => closed.set(i, id));
  });
  return playableEdges(puzzle).filter(([kind, r, c]) => {
    if (getEdge(puzzle, expected, kind, r, c) === EDGE_LINE) return false;
    if (getEdge(puzzle, edges, kind, r, c) !== EDGE_EMPTY) return false;
    const [a, b] = edgeCells(puzzle, kind, r, c);
    return !(closed.has(a) && closed.get(a) === closed.get(b));     // inside a closed shape
  });
}

// The edge between two orthogonally adjacent cells (cell indices), as
// [kind, r, c], or null if they aren't adjacent.
function edgeBetween(puzzle, a, b) {
  const { cols } = puzzle;
  const ar = Math.floor(a / cols), ac = a % cols, br = Math.floor(b / cols), bc = b % cols;
  if (ar === br && Math.abs(ac - bc) === 1) return ['v', ar, Math.max(ac, bc)];
  if (ac === bc && Math.abs(ar - br) === 1) return ['h', Math.max(ar, br), ac];
  return null;
}

// --- Placements covering a cell --------------------------------------------
// The geometry of "every way the tile can sit on the board so that it covers
// this cell" never changes for a puzzle, so it is computed once per puzzle and
// cell (lazily) and reused. Each placement is
//   { cells, outline, inner, innerH, innerV, outH, outV }
// where outline = edges between the placement and the open cells around it,
// inner = edges between two of its own cells, both as [kind, r, c], and the
// four typed arrays hold the same edges as indices into edges.h / edges.v for
// fast checking.
const placementCache = new WeakMap();   // puzzle -> per-cell placement lists

function buildPlacements(puzzle, cell) {
  const { cols, tile } = puzzle;
  const r0 = Math.floor(cell / cols), c0 = cell % cols;
  const seen = new Set();
  const out = [];
  for (const o of allOrientations(tile)) {
    for (const [ar, ac] of o) {            // which tile cell lands on `cell`
      const cells = [];
      let ok = true;
      for (const [dr, dc] of o) {
        const r = r0 - ar + dr, c = c0 - ac + dc;
        if (!isOpen(puzzle, r, c)) { ok = false; break; }
        cells.push(r * cols + c);
      }
      if (!ok) continue;
      cells.sort((x, y) => x - y);
      const key = cells.join(',');
      if (seen.has(key)) continue;
      seen.add(key);

      const inside = new Set(cells);
      const outline = [], inner = [];
      for (const a of cells) {
        const ra = Math.floor(a / cols), ca = a % cols;
        for (const [nr, nc] of [[ra - 1, ca], [ra + 1, ca], [ra, ca - 1], [ra, ca + 1]]) {
          if (!isOpen(puzzle, nr, nc)) continue;       // blocked / border: implicit wall
          const b = nr * cols + nc;
          if (!inside.has(b)) outline.push(edgeBetween(puzzle, a, b));
          else if (b > a) inner.push(edgeBetween(puzzle, a, b));   // each inner edge once
        }
      }
      const idx = (list, kind) => Int32Array.from(list.filter(e => e[0] === kind).map(([k, r, c]) => edgeIndex(puzzle, k, r, c)));
      out.push({
        cells, outline, inner,
        innerH: idx(inner, 'h'), innerV: idx(inner, 'v'), outH: idx(outline, 'h'), outV: idx(outline, 'v'),
      });
    }
  }
  return out;
}

function placementsFor(puzzle, cell) {
  let perCell = placementCache.get(puzzle);
  if (!perCell) { perCell = new Array(puzzle.rows * puzzle.cols); placementCache.set(puzzle, perCell); }
  return perCell[cell] ??= buildPlacements(puzzle, cell);
}

// Placements of the tile that cover cell `cell` and don't contradict the
// player's marks: no line between two of its cells, no cross on its outline.
// Returns [{cells, outline, inner, ...}] (shared, read-only objects: see above).
// With `firstOnly`, stops after finding one (enough to test whether any fits).
export function consistentPlacements(puzzle, edges, cell, firstOnly = false) {
  const { h, v } = edges;
  const out = [];
  for (const p of placementsFor(puzzle, cell)) {
    let ok = true;
    for (let i = 0; ok && i < p.innerH.length; i++) if (h[p.innerH[i]] === EDGE_LINE) ok = false;
    for (let i = 0; ok && i < p.innerV.length; i++) if (v[p.innerV[i]] === EDGE_LINE) ok = false;
    for (let i = 0; ok && i < p.outH.length; i++) if (h[p.outH[i]] === EDGE_CROSS) ok = false;
    for (let i = 0; ok && i < p.outV.length; i++) if (v[p.outV[i]] === EDGE_CROSS) ok = false;
    if (ok) {
      out.push(p);
      if (firstOnly) return out;
    }
  }
  return out;
}

// Cells that are already inside a finished tile: a region walled in by lines (and blocked
// cells) that is exactly one valid tile. Hints that reason about "every way to cover this
// cell" skip them: nothing is left to deduce there. (With several allowed shapes a cell in a
// finished big tile can still look as if a smaller tile might cover it, e.g. an L inside a
// finished P, which would only strand the remaining cell.) Returns a 0/1 array per cell.
export function finishedTileCells(puzzle, edges) {
  const done = new Uint8Array(puzzle.rows * puzzle.cols);
  for (const region of analyze(puzzle, edges).regions) if (region.valid) for (const i of region.cells) done[i] = 1;
  return done;
}

// Rudimentary deduction: find an open cell that only one placement of the tile
// can cover (given the marks so far) whose outline isn't fully drawn yet.
// Returns { cell, cells, lines } where lines are the outline edges still
// missing a line, or null. (Assumes the existing marks are correct.)
export function* forcedTiles(puzzle, edges) {
  const seen = new Set();                     // several cells can be forced into one tile
  const done = finishedTileCells(puzzle, edges);
  for (let cell = 0; cell < puzzle.rows * puzzle.cols; cell++) {
    if (puzzle.grid[cell] !== OPEN || done[cell]) continue;
    const options = consistentPlacements(puzzle, edges, cell);
    if (options.length !== 1) continue;
    const { cells, outline } = options[0];
    const key = cells.join(',');
    if (seen.has(key)) continue;
    const lines = outline.filter(([kind, r, c]) => getEdge(puzzle, edges, kind, r, c) !== EDGE_LINE);
    if (!lines.length) continue;
    seen.add(key);
    yield { cell, cells, lines };
  }
}

export function forcedTile(puzzle, edges) {
  return forcedTiles(puzzle, edges).next().value ?? null;
}

// Every such deduction available right now (one per tile), in board order.
export function allForcedTiles(puzzle, edges) {
  return [...forcedTiles(puzzle, edges)];
}

// --- Contradictions ------------------------------------------------------------
// Ways a position can be proven impossible (used to eliminate hypothetical tiles):
//   cell    some open cell has no placement of the tile left
//   size    a region walled in by lines (cells connected through non-line edges;
//           tiles can't cross lines) has a size that isn't a multiple of the tile size
//   parity  such a region has a chessboard black/white imbalance that no set of
//           tiles can produce
// "mode" says which to test: 'cell' < 'size' < 'parity' (each includes the ones before).

// Chessboard imbalance (even-coloured cells minus odd-coloured) one placed tile can
// have: +i or -i for each orientation's i, depending on which colour it starts on.
const imbalanceCache = new Map();
function tileImbalances(spec) {
  if (!imbalanceCache.has(spec)) {
    const set = new Set();
    for (const o of getOrientations(spec)) {
      let i = 0;
      for (const [r, c] of o) i += ((r + c) & 1) === 0 ? 1 : -1;
      set.add(i); set.add(-i);
    }
    imbalanceCache.set(spec, [...set]);
  }
  return imbalanceCache.get(spec);
}

// Imbalances that tiles with n cells in total can add up to (any mix of the allowed
// shapes): reach[k] is the set for k cells.
const reachableCache = new Map();
function reachableImbalances(spec, n) {
  let reach = reachableCache.get(spec);
  if (!reach) { reach = [new Set([0])]; reachableCache.set(spec, reach); }
  const shapes = tileSpecs(spec).map(sp => ({ size: tileSize(sp), d: tileImbalances(sp) }));
  while (reach.length <= n) {
    const k = reach.length, set = new Set();
    for (const { size, d } of shapes) {
      if (size > k) continue;
      for (const s0 of reach[k - size]) for (const x of d) set.add(s0 + x);
    }
    reach.push(set);
  }
  return reach[n];
}

// The first region (see above) that cannot be tiled, as {kind, cells}, or null.
export function findPocketContradiction(puzzle, edges, mode = 'size') {
  const { rows, cols, tile } = puzzle;
  const { h, v } = edges;
  const seen = new Uint8Array(rows * cols);
  const stack = [];
  for (let start = 0; start < rows * cols; start++) {
    if (puzzle.grid[start] !== OPEN || seen[start]) continue;
    const cells = [];
    let balance = 0;
    seen[start] = 1; stack.push(start);
    while (stack.length) {
      const i = stack.pop();
      cells.push(i);
      const r = (i / cols) | 0, c = i % cols;
      balance += ((r + c) & 1) === 0 ? 1 : -1;
      if (c + 1 < cols && puzzle.grid[i + 1] === OPEN && !seen[i + 1] && v[r * (cols + 1) + c + 1] !== EDGE_LINE) { seen[i + 1] = 1; stack.push(i + 1); }
      if (c > 0 && puzzle.grid[i - 1] === OPEN && !seen[i - 1] && v[r * (cols + 1) + c] !== EDGE_LINE) { seen[i - 1] = 1; stack.push(i - 1); }
      if (r + 1 < rows && puzzle.grid[i + cols] === OPEN && !seen[i + cols] && h[(r + 1) * cols + c] !== EDGE_LINE) { seen[i + cols] = 1; stack.push(i + cols); }
      if (r > 0 && puzzle.grid[i - cols] === OPEN && !seen[i - cols] && h[r * cols + c] !== EDGE_LINE) { seen[i - cols] = 1; stack.push(i - cols); }
    }
    if (!sizeFeasible(tile, cells.length)) return { kind: 'size', cells };
    if (mode === 'parity' && !reachableImbalances(tile, cells.length).has(balance)) {
      return { kind: 'parity', cells };
    }
  }
  return null;
}

// Is the position impossible? Looks for a cell with no placement near `nearCells`
// (only cells within one tile's reach of a change can have lost a placement), and,
// for modes beyond 'cell', for an untileable region anywhere. Returns
// {kind, cells} or null.
export function findContradiction(puzzle, edges, nearCells, mode = 'size') {
  const dead = findDeadCellNear(puzzle, edges, nearCells, maxTileSize(puzzle.tile));
  if (dead !== -1) return { kind: 'cell', cells: [dead] };
  return mode === 'cell' ? null : findPocketContradiction(puzzle, edges, mode);
}

// An open cell near `cells` that is left with no placement fitting the marks,
// or -1. Drawing lines around a tile can only affect placements within one
// tile's reach of it, so only cells within Manhattan distance `reach` are
// examined. (Stops at the first one found; see findDeadCellsNear for all.)
function findDeadCellNear(puzzle, edges, cells, reach) {
  const { rows, cols } = puzzle;
  const pts = cells.map(i => [Math.floor(i / cols), i % cols]);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!isOpen(puzzle, r, c)) continue;
      if (!pts.some(([pr, pc]) => Math.abs(pr - r) + Math.abs(pc - c) <= reach)) continue;
      if (consistentPlacements(puzzle, edges, r * cols + c, true).length === 0) return r * cols + c;
    }
  }
  return -1;
}

// All open cells near `cells` that are left with no placement fitting the marks.
function findDeadCellsNear(puzzle, edges, cells, reach) {
  const { rows, cols } = puzzle;
  const pts = cells.map(i => [Math.floor(i / cols), i % cols]);
  const dead = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!isOpen(puzzle, r, c)) continue;
      if (!pts.some(([pr, pc]) => Math.abs(pr - r) + Math.abs(pc - c) <= reach)) continue;
      if (consistentPlacements(puzzle, edges, r * cols + c, true).length === 0) dead.push(r * cols + c);
    }
  }
  return dead;
}

// Lookahead deduction: find an open cell with several
// placements consistent with the marks such that, for all but one of them,
// outlining the placement would leave some other cell with no possible
// placement at all (a contradiction). The one survivor must be right.
// Returns { cell, cells, lines, ruledOut, alternatives, sharedDead } or null:
// (alternatives[i].reason says why that placement fails: a {kind, cells} contradiction)
//   cell         the cell the deduction is about (the "origin")
//   cells, lines the surviving tile and the outline lines still to draw
//   alternatives [{cells, dead: [cell, ...]}] each ruled-out placement with the
//                cells it would strand
//   sharedDead   cells stranded by EVERY alternative, nearest the origin first
//                (often empty; then no single cell explains the deduction)
// An optional {minOptions, maxOptions} restricts which origin cells qualify, by
// their number of consistent placements (see LOOKAHEAD_2 / LOOKAHEAD_3).
// (Assumes the existing marks are correct.)
export function* lookaheadTiles(puzzle, edges, { minOptions = 2, maxOptions = Infinity, mode = 'size' } = {}) {
  const reach = maxTileSize(puzzle.tile);
  const { cols } = puzzle;
  const seen = new Set();                     // several origin cells can lead to one tile
  const done = finishedTileCells(puzzle, edges);
  for (let cell = 0; cell < puzzle.rows * puzzle.cols; cell++) {
    if (puzzle.grid[cell] !== OPEN || done[cell]) continue;
    const options = consistentPlacements(puzzle, edges, cell);
    // (1 option is forcedTile's job)
    if (options.length < Math.max(2, minOptions) || options.length > maxOptions) continue;

    const survivors = [], failed = [];
    for (const opt of options) {
      const trial = cloneEdges(edges);
      for (const [kind, r, c] of opt.outline) setEdge(puzzle, trial, kind, r, c, EDGE_LINE);
      // (only whether the placement fails matters at this stage)
      const reason = findContradiction(puzzle, trial, opt.cells, mode);
      (reason ? failed : survivors).push({ ...opt, trial, reason });
    }
    if (survivors.length !== 1) continue;

    const { cells, outline } = survivors[0];
    const key = cells.join(',');
    if (seen.has(key)) continue;
    const lines = outline.filter(([kind, r, c]) => getEdge(puzzle, edges, kind, r, c) !== EDGE_LINE);
    if (!lines.length) continue;
    seen.add(key);

    // Now that this deduction is going to be reported, work out which cells each
    // alternative strands, and which cells every alternative strands.
    const alternatives = failed.map(f => ({
      cells: f.cells, dead: findDeadCellsNear(puzzle, f.trial, f.cells, reach), reason: f.reason,
    }));
    const candidates = new Set(alternatives.flatMap(a => a.dead));
    const [or, oc] = [Math.floor(cell / cols), cell % cols];
    const sharedDead = [...candidates]
      .filter(c => failed.every(f => consistentPlacements(puzzle, f.trial, c, true).length === 0))
      .sort((a, b) => (Math.abs(Math.floor(a / cols) - or) + Math.abs(a % cols - oc)) -
                      (Math.abs(Math.floor(b / cols) - or) + Math.abs(b % cols - oc)) || a - b);
    yield { cell, cells, lines, ruledOut: alternatives.length, alternatives, sharedDead };
  }
}

// "Eliminate, then compare": a cell with three or more possible tiles where SOME (not all but one)
// lead straight to a contradiction (a cell with no tile, or a pocket that can't be tiled: one
// step, no chain of consequences). Drop those tiles; the tiles that are left must agree: an edge on
// the outline of every one of them is a line, an edge inside every one of them is a cross. (With one
// survivor this is lookahead3, whose result is the whole tile.) Yields
// { cell, lines, crosses, ruledOut, survivors, alternatives: [{cells, dead, reason}], sharedDead }.
export function* eliminateTiles(puzzle, edges, { mode = 'size' } = {}) {
  const reach = maxTileSize(puzzle.tile);
  const { cols } = puzzle;
  const seen = new Set();
  const done = finishedTileCells(puzzle, edges);
  const keyOf = ([kind, r, c]) => `${kind}${r}:${c}`;
  for (let cell = 0; cell < puzzle.rows * puzzle.cols; cell++) {
    if (puzzle.grid[cell] !== OPEN || done[cell]) continue;
    const options = consistentPlacements(puzzle, edges, cell);
    if (options.length < 3) continue;                           // two tiles: lookahead2's job
    const survivors = [], failed = [];
    for (const opt of options) {
      const trial = cloneEdges(edges);
      for (const [kind, r, c] of opt.outline) setEdge(puzzle, trial, kind, r, c, EDGE_LINE);
      const reason = findContradiction(puzzle, trial, opt.cells, mode);
      (reason ? failed : survivors).push({ ...opt, trial, reason });
    }
    if (survivors.length < 2 || !failed.length) continue;       // none dropped: nothing learned; one left: lookahead3
    const outN = new Map(), inN = new Map(), edgeOf = new Map();
    for (const o of survivors) {
      o.outline.forEach(e => { outN.set(keyOf(e), (outN.get(keyOf(e)) ?? 0) + 1); edgeOf.set(keyOf(e), e); });
      o.inner.forEach(e => { inN.set(keyOf(e), (inN.get(keyOf(e)) ?? 0) + 1); edgeOf.set(keyOf(e), e); });
    }
    const lines = [...outN].filter(([, n]) => n === survivors.length).map(([k]) => edgeOf.get(k))
      .filter(([kind, r, c]) => getEdge(puzzle, edges, kind, r, c) !== EDGE_LINE);
    const crosses = [...inN].filter(([, n]) => n === survivors.length).map(([k]) => edgeOf.get(k))
      .filter(([kind, r, c]) => getEdge(puzzle, edges, kind, r, c) === EDGE_EMPTY);
    if (!lines.length && !crosses.length) continue;
    const key = [...lines.map(e => 'L' + keyOf(e)), ...crosses.map(e => 'X' + keyOf(e))].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);

    const alternatives = failed.map(f => ({
      cells: f.cells, dead: findDeadCellsNear(puzzle, f.trial, f.cells, reach), reason: f.reason,
    }));
    const candidates = new Set(alternatives.flatMap(a => a.dead));
    const [or, oc] = [Math.floor(cell / cols), cell % cols];
    const sharedDead = [...candidates]
      .filter(c => failed.every(f => consistentPlacements(puzzle, f.trial, c, true).length === 0))
      .sort((a, b) => (Math.abs(Math.floor(a / cols) - or) + Math.abs(a % cols - oc)) -
                      (Math.abs(Math.floor(b / cols) - or) + Math.abs(b % cols - oc)) || a - b);
    yield { cell, lines, crosses, ruledOut: failed.length, survivors: survivors.length, alternatives, sharedDead };
  }
}

export function eliminateTile(puzzle, edges, options) {
  return eliminateTiles(puzzle, edges, options).next().value ?? null;
}

export function allEliminateTiles(puzzle, edges, options) {
  return [...eliminateTiles(puzzle, edges, options)];
}

export function lookaheadTile(puzzle, edges, range) {
  return lookaheadTiles(puzzle, edges, range).next().value ?? null;
}

// Every such deduction available right now (one per tile), in board order.
export function allLookaheadTiles(puzzle, edges, range) {
  return [...lookaheadTiles(puzzle, edges, range)];
}

// The two flavours of lookahead, by how many placements the origin cell has:
//   LOOKAHEAD_2  exactly two placements, and one of them leads to a contradiction
//                (the easy case: "it's one or the other, and this one fails")
//   LOOKAHEAD_3  three or more placements, all but one of which fail
//   LOOKAHEAD_PARITY  any number of placements, but the contradiction may also be a
//                     region whose chessboard colours are unbalanced
// All three count regions whose size isn't a multiple of the tile as contradictions
// (the parity rule is only reached when the others find nothing).
export const LOOKAHEAD_2 = { minOptions: 2, maxOptions: 2, mode: 'size' };
export const LOOKAHEAD_3 = { minOptions: 3, mode: 'size' };
export const LOOKAHEAD_PARITY = { minOptions: 2, mode: 'parity' };

// --- Edge intersection -----------------------------------------------------------
// For a cell with several possible tiles, an edge that is on the outline of EVERY
// one of them must be a line, and an edge that lies inside EVERY one of them
// (both its cells in the tile) must not be: mark it with a cross. This makes
// progress without choosing between the tiles. (A cell with a single neighbour is
// the simplest case: the edge to that neighbour is inside every tile.)
// An optional {minOptions, maxOptions} restricts which cells qualify, by how many
// possible tiles they have. Yields { cell, lines, crosses, options } where lines/crosses are [[kind, r, c]]
// edges that aren't marked that way yet, one item per distinct set of edges.
export function* edgeDeductions(puzzle, edges, { minOptions = 2, maxOptions = Infinity } = {}) {
  const seen = new Set();
  const done = finishedTileCells(puzzle, edges);
  for (let cell = 0; cell < puzzle.rows * puzzle.cols; cell++) {
    if (puzzle.grid[cell] !== OPEN || done[cell]) continue;
    const options = consistentPlacements(puzzle, edges, cell);
    // (one option is forcedTile's job)
    if (options.length < Math.max(2, minOptions) || options.length > maxOptions) continue;
    // count, per edge, how many of the options have it on their outline / inside
    // (numeric keys: h edges 0.., v edges offset by 1e6)
    const { cols } = puzzle;
    const keyOf = ([kind, r, c]) => (kind === 'h' ? r * cols + c : 1e6 + r * (cols + 1) + c);
    const outCount = new Map(), inCount = new Map(), edgeOf = new Map();
    const bump = (m, e) => { const k = keyOf(e); m.set(k, (m.get(k) ?? 0) + 1); edgeOf.set(k, e); };
    for (const o of options) { o.outline.forEach(e => bump(outCount, e)); o.inner.forEach(e => bump(inCount, e)); }
    const lines = [...outCount].filter(([, n]) => n === options.length).map(([k]) => edgeOf.get(k))
      .filter(([kind, r, c]) => getEdge(puzzle, edges, kind, r, c) !== EDGE_LINE);
    const crosses = [...inCount].filter(([, n]) => n === options.length).map(([k]) => edgeOf.get(k))
      .filter(([kind, r, c]) => getEdge(puzzle, edges, kind, r, c) === EDGE_EMPTY);
    if (!lines.length && !crosses.length) continue;
    const key = [...lines.map(e => 'L' + e.join(':')), ...crosses.map(e => 'X' + e.join(':'))].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    yield { cell, lines, crosses, options: options.length };
  }
}

export function edgeDeduction(puzzle, edges, range) {
  return edgeDeductions(puzzle, edges, range).next().value ?? null;
}

// Every such deduction available right now, in board order.
export function allEdgeDeductions(puzzle, edges, range) {
  return [...edgeDeductions(puzzle, edges, range)];
}

// "Try a line": the crosses among the edge deductions, over cells with any number of possible tiles.
// Suppose a line were drawn on the edge: some cell (anywhere on the board) would be left with no
// possible tile, because every tile that could cover it contains both cells beside the edge. So the
// edge takes a cross. (This is the cross half of the edge rule, here without a limit on how many tiles
// the cell has: a player doesn't compare the tiles, they just see that a line there strands the cell.)
// Yields { cell, lines: [], crosses, options }, where `cell` is the cell the line would strand.
export function* crossDeductions(puzzle, edges) {
  const seen = new Set();
  for (const d of edgeDeductions(puzzle, edges, { minOptions: 2 })) {
    if (!d.crosses.length) continue;
    const key = d.crosses.map(e => e.join(':')).sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    yield { cell: d.cell, lines: [], crosses: d.crosses, options: d.options };
  }
}

export function crossDeduction(puzzle, edges) {
  return crossDeductions(puzzle, edges).next().value ?? null;
}

export function allCrossDeductions(puzzle, edges) {
  return [...crossDeductions(puzzle, edges)];
}

// Edge intersection splits by how many candidate tiles have to be compared:
//   EDGES_NARROW  two or three (easy to keep in your head)
//   EDGES_WIDE    four or more
export const EDGES_NARROW = { minOptions: 2, maxOptions: 3 };
export const EDGES_WIDE = { minOptions: 4 };

// --- Forcing chains ----------------------------------------------------------------
// Suppose a tile were placed: draw its outline, then follow the forced consequences
// (any cell left with a single placement gets that tile's outline too), checking for
// a contradiction after every step. Returns { contradiction, steps } where
// contradiction is {kind, cells} if the assumption leads to an impossible position
// (within maxSteps forced steps), else null.
function propagateHypothesis(puzzle, edges, option, mode, maxSteps) {
  const reach = maxTileSize(puzzle.tile);
  const { rows, cols } = puzzle;
  const trial = cloneEdges(edges);
  for (const [kind, r, c] of option.outline) setEdge(puzzle, trial, kind, r, c, EDGE_LINE);
  let near = option.cells;
  let steps = 0;
  for (;;) {
    const contradiction = findContradiction(puzzle, trial, near, mode);
    if (contradiction) return { contradiction, steps };
    if (steps >= maxSteps) return { contradiction: null, steps };

    // a cell near the last change that now has exactly one placement (with lines still to draw)
    const pts = near.map(i => [(i / cols) | 0, i % cols]);
    let next = null;
    for (let r = 0; r < rows && !next; r++) {
      for (let c = 0; c < cols && !next; c++) {
        if (!isOpen(puzzle, r, c)) continue;
        if (!pts.some(([pr, pc]) => Math.abs(pr - r) + Math.abs(pc - c) <= reach)) continue;
        const opts = consistentPlacements(puzzle, trial, r * cols + c);
        if (opts.length === 1 && opts[0].outline.some(([k, er, ec]) => getEdge(puzzle, trial, k, er, ec) !== EDGE_LINE)) {
          next = opts[0];
        }
      }
    }
    if (!next) return { contradiction: null, steps };
    for (const [kind, r, c] of next.outline) setEdge(puzzle, trial, kind, r, c, EDGE_LINE);
    near = next.cells;
    steps++;
  }
}

// The hardest deduction: a cell with several possible tiles where, for all but one,
// assuming the tile and following the forced consequences ends in a contradiction
// (a cell with no placement, or a region that cannot be tiled, including the
// chessboard test). The survivor must be right. Yields
// { cell, cells, lines, ruledOut, alternatives, maxSteps } where alternatives =
// [{cells, steps, reason}] and maxSteps is the longest chain needed.
export function* chainTiles(puzzle, edges, { mode = 'parity', maxSteps = 60, maxOptions = Infinity } = {}) {
  const seen = new Set();
  const done = finishedTileCells(puzzle, edges);
  for (let cell = 0; cell < puzzle.rows * puzzle.cols; cell++) {
    if (puzzle.grid[cell] !== OPEN || done[cell]) continue;
    const options = consistentPlacements(puzzle, edges, cell);
    if (options.length < 2 || options.length > maxOptions) continue;
    const survivors = [], failed = [];
    for (const opt of options) {
      const res = propagateHypothesis(puzzle, edges, opt, mode, maxSteps);
      (res.contradiction ? failed : survivors).push({ opt, res });
    }
    if (survivors.length !== 1) continue;
    const { cells, outline } = survivors[0].opt;
    const key = cells.join(',');
    if (seen.has(key)) continue;
    const lines = outline.filter(([kind, r, c]) => getEdge(puzzle, edges, kind, r, c) !== EDGE_LINE);
    if (!lines.length) continue;
    seen.add(key);
    yield {
      cell, cells, lines, ruledOut: failed.length,
      alternatives: failed.map(f => ({ cells: f.opt.cells, steps: f.res.steps, reason: f.res.contradiction })),
      maxSteps: Math.max(...failed.map(f => f.res.steps)),
    };
  }
}

export function chainTile(puzzle, edges, options) {
  return chainTiles(puzzle, edges, options).next().value ?? null;
}

export function allChainTiles(puzzle, edges, options) {
  return [...chainTiles(puzzle, edges, options)];
}

// --- Drawing a tile by dragging across cells ---------------------------------

// Do these cells (indices) form exactly one tile of the puzzle's shape, in any
// rotation or reflection?
export function cellsFormTile(puzzle, cells) {
  const { cols, tile } = puzzle;
  if (new Set(cells).size !== cells.length || !tileSizes(tile).includes(cells.length)) return false;
  const keys = new Set(allOrientations(tile).map(cellsKey));
  return keys.has(cellsKey(normalize(cells.map(i => [Math.floor(i / cols), i % cols]))));
}

// Every playable edge between one of `cells` and an open cell outside the set,
// i.e. the outline you would draw around that tile. Returns [[kind, r, c], ...].
export function tileOutline(puzzle, cells) {
  const { cols } = puzzle;
  const inside = new Set(cells);
  const out = [];
  for (const a of cells) {
    const ra = Math.floor(a / cols), ca = a % cols;
    for (const [nr, nc] of [[ra - 1, ca], [ra + 1, ca], [ra, ca - 1], [ra, ca + 1]]) {
      if (!isOpen(puzzle, nr, nc)) continue;          // blocked / border: implicit wall
      const b = nr * cols + nc;
      if (!inside.has(b)) out.push(edgeBetween(puzzle, a, b));
    }
  }
  return out;
}

// Every playable edge between two of `cells`, i.e. the edges inside the shape. A line
// here would cut the tile in two. Returns [[kind, r, c], ...].
export function tileInterior(puzzle, cells) {
  const { cols } = puzzle;
  const inside = new Set(cells);
  const out = [];
  for (const a of cells) {
    const ra = Math.floor(a / cols), ca = a % cols;
    for (const [nr, nc] of [[ra + 1, ca], [ra, ca + 1]]) {   // down and right only: each pair once
      if (!isOpen(puzzle, nr, nc)) continue;
      const b = nr * cols + nc;
      if (inside.has(b)) out.push(edgeBetween(puzzle, a, b));
    }
  }
  return out;
}

// True when the open (white) cells form one orthogonally connected region, i.e. the board has no
// islands cut off from the rest by blocked cells. Puzzles that fail this are not generated or published.
export function openCellsConnected(puzzle) {
  const { rows, cols } = puzzle;
  let first = -1, total = 0;
  for (let i = 0; i < rows * cols; i++) if (puzzle.grid[i] === OPEN) { total++; if (first < 0) first = i; }
  if (total === 0) return false;
  const seen = new Set([first]), stack = [first];
  while (stack.length) {
    const a = stack.pop(), r = Math.floor(a / cols), c = a % cols;
    for (const [nr, nc] of [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]) {
      if (!isOpen(puzzle, nr, nc)) continue;
      const b = nr * cols + nc;
      if (!seen.has(b)) { seen.add(b); stack.push(b); }
    }
  }
  return seen.size === total;
}

// --- Swastikas ---------------------------------------------------------------------
// A "swastika" is a pinwheel pattern in the drawn tile boundaries of a solution (the
// lines between different tiles): the 8 segments of a central cross with four hooks
// (in any rotation or mirror image) all present inside some 4x4 window of the board.
// It is ported from multiverse star battle (tools/filter.py), which rejects boards
// whose bold region boundaries form it. Generated puzzles whose solution contains one
// can be rejected.
//
// Star battle names edges ('v', r, c) = right of cell (r, c) and ('h', r, c) = below
// cell (r, c); this file's edges are 'v' = left of a cell and 'h' = above, so the
// pattern is stored in star battle's terms and boundary edges are converted.
const SWASTIKA_WINDOW = 4;
const SWASTIKA_BASE = [['v', 1, 0], ['v', 1, 1], ['v', 2, 1], ['v', 2, 2], ['h', 0, 2], ['h', 1, 1], ['h', 1, 2], ['h', 2, 1]];

function edgeToPoints(kind, r, c, n) {            // endpoints in grid-line coordinates, y up
  if (kind === 'v') return [[c + 1, n - 1 - r], [c + 1, n - r]];
  return [[c, n - 1 - r], [c + 1, n - 1 - r]];
}
function pointsToEdge([x0, y0], [x1, y1], n) {
  if (x0 === x1) return ['v', n - Math.max(y0, y1), x0 - 1];
  return ['h', n - 1 - y0, Math.min(x0, x1)];
}
const DIHEDRAL = [
  (x, y, n) => [x, y], (x, y, n) => [y, n - x], (x, y, n) => [n - x, n - y], (x, y, n) => [n - y, x],
  (x, y, n) => [n - x, y], (x, y, n) => [x, n - y], (x, y, n) => [y, x], (x, y, n) => [n - y, n - x],
];
const SWASTIKA_VARIANTS = (() => {
  const n = SWASTIKA_WINDOW, seen = new Set(), out = [];
  const base = SWASTIKA_BASE.map(([k, r, c]) => edgeToPoints(k, r, c, n));
  for (const fn of DIHEDRAL) {
    const edges = base.map(([p0, p1]) => pointsToEdge(fn(...p0, n), fn(...p1, n), n).join(':'));
    const key = [...edges].sort().join('|');
    if (!seen.has(key)) { seen.add(key); out.push(edges); }
  }
  return out;
})();

// Does this solution's drawn boundary contain a swastika?
export function hasSwastika(puzzle, solution) {
  const { rows, cols } = puzzle;
  const n = SWASTIKA_WINDOW;
  if (rows < n || cols < n) return false;
  const lines = edgesFromSolution(puzzle, solution);
  const has = new Set();                         // in star battle's edge terms
  for (const [kind, r, c] of playableEdges(puzzle)) {
    if (getEdge(puzzle, lines, kind, r, c) !== EDGE_LINE) continue;
    has.add(kind === 'v' ? `v:${r}:${c - 1}` : `h:${r - 1}:${c}`);
  }
  for (let r0 = 0; r0 + n <= rows; r0++) {
    for (let c0 = 0; c0 + n <= cols; c0++) {
      for (const variant of SWASTIKA_VARIANTS) {
        if (variant.every(e => { const [k, r, c] = e.split(':'); return has.has(`${k}:${+r + r0}:${+c + c0}`); })) return true;
      }
    }
  }
  return false;
}
