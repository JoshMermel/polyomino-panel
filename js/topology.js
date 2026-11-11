// Grid topologies: everything that depends on WHAT KIND of cells a board is made of, so that the rest of the
// code (logic.js, the generator, the renderers) is written once for any of them. Two exist: the square grid
// (the original game) and the hex grid. A triangle grid is meant to fit the same interface later (see the
// notes at the bottom).
//
// Common to all topologies: a board is `rows` x `cols` cells, cell (r, c) is index r*cols + c, and a puzzle's
// `grid` string says which cells are open ('.') or blocked ('#'). A topology says
//   - which cells touch (`dirs`) and which edge each pair shares (`kinds`, `edgeIndex`): an edge is named
//     [kind, r, c] and sits on one SIDE of cell (r, c), the side that faces the neighbour at
//     (r, c) + kindOffset[kind];
//   - how a tile may be turned over (`rotate`, `reflect`), and how far apart two cells are (`dist`);
//   - how it is drawn (`polygon`, `center`, `bounds`, `cellAt`, `hit`), in "cell units": 1 unit is the width
//     of a cell, so line widths and sizes mean the same on every grid;
//   - the named tile shapes it has (`shapes`, `labels`, `order`).
// A puzzle's topology is read from its `tile` string: "hex:..." is a hex puzzle, anything else is square.
// (Every shape spec is global, so the prefix keeps the caches in logic.js apart; each spec in a "+" list
// carries it.)

const SQRT3 = Math.sqrt(3);

// --- Square ---------------------------------------------------------------------------------------
// Edge kinds: 'h' = above a cell, 'v' = left of it. The arrays are (rows+1) x cols and rows x (cols+1):
// the extra edges (below the last row, right of the last column) are never playable.

const SQUARE_DIRS = Object.freeze([
  { dr: -1, dc: 0, kind: 'h', kr: 0, kc: 0, side: 0 },    // up
  { dr: 1, dc: 0, kind: 'h', kr: 1, kc: 0, side: 2 },     // down
  { dr: 0, dc: -1, kind: 'v', kr: 0, kc: 0, side: 3 },    // left
  { dr: 0, dc: 1, kind: 'v', kr: 0, kc: 1, side: 1 },     // right
]);

export const SQUARE = {
  name: 'square',
  prefix: '',
  kinds: ['h', 'v'],
  kindOffset: { h: [-1, 0], v: [0, -1] },
  kindSide: { h: 0, v: 3 },
  dirs: SQUARE_DIRS,
  dirsAt: () => SQUARE_DIRS,
  edgeLength: (rows, cols, kind) => (kind === 'h' ? (rows + 1) * cols : rows * (cols + 1)),
  edgeIndex: (cols, kind, r, c) => (kind === 'h' ? r * cols + c : r * (cols + 1) + c),
  rotations: 4,
  rotate: ([r, c]) => [c, -r],
  reflect: ([r, c]) => [r, -c],
  dist: (dr, dc) => Math.abs(dr) + Math.abs(dc),
  twoColor: true,                                  // a chessboard colouring exists, so the parity rule applies
  colorOf: (r, c) => (r + c) & 1,
  // geometry
  polygon: (r, c) => [[c, r], [c + 1, r], [c + 1, r + 1], [c, r + 1]],
  center: (r, c) => [c + 0.5, r + 0.5],
  bounds: (rows, cols) => [cols, rows],
  cellAt: (x, y) => [Math.floor(y), Math.floor(x)],
  hit: { half: 0.17, inset: 0.16 },                // an edge's click strip: half its width, and how far it stays clear of the ends
  tapSlop: 0.25,
};

// --- Hex (pointy-top hexagons) ----------------------------------------------------------------------
// Cells in axial coordinates: cell (r, c) touches (r, c±1), (r±1, c) and (r-1, c+1), (r+1, c-1). Row r+1 is
// drawn half a cell to the right of row r, so a rows x cols array is a parallelogram; a hexagonal board is
// that array with its two corners cut off (the `outside` column). Edge kinds: 'w' = west of a cell
// (neighbour (r, c-1)), 'nw' = up-left (neighbour (r-1, c)), 'ne' = up-right (neighbour (r-1, c+1)).
// A cell is 1 wide (flat side to flat side); its corner-to-corner radius is R.

const R = 1 / SQRT3;
const HEX_DIRS = Object.freeze([
  { dr: -1, dc: 1, kind: 'ne', kr: 0, kc: 0, side: 0 },    // up-right
  { dr: 0, dc: 1, kind: 'w', kr: 0, kc: 1, side: 1 },      // right
  { dr: 1, dc: 0, kind: 'nw', kr: 1, kc: 0, side: 2 },     // down-right
  { dr: 1, dc: -1, kind: 'ne', kr: 1, kc: -1, side: 3 },   // down-left
  { dr: 0, dc: -1, kind: 'w', kr: 0, kc: 0, side: 4 },     // left
  { dr: -1, dc: 0, kind: 'nw', kr: 0, kc: 0, side: 5 },    // up-left
]);

const hexCenter = (r, c) => [c + r / 2 + 0.5, R * (1 + 1.5 * r)];

// Pixel (x, y) -> the axial cell it is in (cube-coordinate rounding).
function hexCellAt(x, y) {
  const rf = (y / R - 1) / 1.5;
  const cf = x - 0.5 - rf / 2;
  const xf = cf, zf = rf, yf = -xf - zf;
  let rx = Math.round(xf), ry = Math.round(yf), rz = Math.round(zf);
  const dx = Math.abs(rx - xf), dy = Math.abs(ry - yf), dz = Math.abs(rz - zf);
  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (dy > dz) ry = -rx - rz;
  else rz = -rx - ry;
  return [rz + 0, rx + 0];                  // (+ 0: no -0)
}

export const HEX = {
  name: 'hex',
  prefix: 'hex:',
  kinds: ['w', 'nw', 'ne'],
  kindOffset: { w: [0, -1], nw: [-1, 0], ne: [-1, 1] },
  kindSide: { w: 4, nw: 5, ne: 0 },
  dirs: HEX_DIRS,
  dirsAt: () => HEX_DIRS,
  edgeLength: (rows, cols) => rows * cols,
  edgeIndex: (cols, kind, r, c) => r * cols + c,
  rotations: 6,
  rotate: ([r, c]) => [c + r, -r],                 // 60 degrees (cube coordinates (x, y, z) -> (-z, -x, -y))
  reflect: ([r, c]) => [c, r],                     // swap two cube axes
  dist: (dr, dc) => Math.max(Math.abs(dr), Math.abs(dc), Math.abs(dr + dc)),
  twoColor: false,                                 // no chessboard colouring: the parity rule is not available
  colorOf: (r, c) => ((c - r) % 3 + 3) % 3,
  polygon: (r, c) => {
    const [x, y] = hexCenter(r, c);
    return [[x, y - R], [x + 0.5, y - R / 2], [x + 0.5, y + R / 2], [x, y + R], [x - 0.5, y + R / 2], [x - 0.5, y - R / 2]];
  },
  center: hexCenter,
  bounds: (rows, cols) => [cols + (rows - 1) / 2, R * (2 + 1.5 * (rows - 1))],
  cellAt: hexCellAt,
  hit: { half: 0.13, inset: 0.1 },
  tapSlop: 0.2,
};

// --- Registry --------------------------------------------------------------------------------------

export const TOPOLOGIES = { square: SQUARE, hex: HEX };

// "hex:h4a" -> HEX; "L" or "XX/X." -> SQUARE. Fast: it runs in hot loops.
export function topologyOfTile(tile) {
  return tile.charCodeAt(0) === 104 && tile.startsWith('hex:') ? HEX : SQUARE;     // 104 = 'h'
}

// A spec without its topology prefix.
export const specBody = spec => (spec.startsWith('hex:') ? spec.slice(4) : spec);

// --- Derived helpers (work for every topology) ---------------------------------------------------------

// The cell index at the far side of an edge from `a`'s point of view is found through dirs; this is the
// edge between two adjacent cell indices as [kind, r, c], or null.
export function edgeBetween(topo, cols, a, b) {
  const ar = Math.floor(a / cols), ac = a % cols;
  for (const d of topo.dirsAt(ar, ac)) {
    if ((ar + d.dr) * cols + ac + d.dc === b && ac + d.dc >= 0 && ac + d.dc < cols) return [d.kind, ar + d.kr, ac + d.kc];
  }
  return null;
}

// The two cell indices an edge separates: the neighbour first (at the kind's offset), then the cell (r, c).
export function edgeCellsOf(topo, cols, kind, r, c) {
  const [dr, dc] = topo.kindOffset[kind];
  return [(r + dr) * cols + c + dc, r * cols + c];
}

// An edge's two end points, in cell units.
export function edgeEnds(topo, kind, r, c) {
  const poly = topo.polygon(r, c);
  const side = topo.kindSide[kind];
  const [x1, y1] = poly[side], [x2, y2] = poly[(side + 1) % poly.length];
  return { x1, y1, x2, y2 };
}

// The box (x0, y0, x1, y1, cell units) round the cells of a board that are part of its shape (`outside` is the
// puzzle's outside column or ''). A hex board is a parallelogram of cells with its corners cut off, so this is
// much smaller than `bounds`; on a square board it is the whole array unless a whole edge row/column is outside.
export function shapeBox(topo, rows, cols, outside = '') {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (outside[r * cols + c] === 'x') continue;
      for (const [x, y] of topo.polygon(r, c)) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    }
  }
  return x0 === Infinity ? [0, 0, ...topo.bounds(rows, cols)] : [x0, y0, x1, y1];
}

// Notes for a triangle grid. Cells would again be rows x cols, cell (r, c) pointing up when (r + c) is even
// and down when it is odd; `dirsAt(r, c)` is why dirs is a function of the cell: an up triangle touches
// left, right and below, a down one left, right and above. Edge kinds would be 'w' (left) and one for
// the horizontal edge above a down triangle. What does NOT fit the lattice shortcut: a tile's placements
// can only be translated by an offset that keeps the up/down pattern (so boardPlacements and the
// generator's random packing need an `anchors`/parity check), and orientations include 12 symmetries.
