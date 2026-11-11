// Grid topologies: everything that depends on WHAT KIND of cells a board is made of, so that the rest of the
// code (logic.js, the generator, the renderers) is written once for any of them. Three exist: the square grid
// (the original game), the hex grid and the triangle grid.
//
// Common to all topologies: a board is `rows` x `cols` cells, cell (r, c) is index r*cols + c, and a puzzle's
// `grid` string says which cells are open ('.') or blocked ('#'). A topology says
//   - which cells touch (`dirsAt(r, c)`: the same for every cell on the square and hex grids, but triangles point
//     up or down) and which edge each pair shares (`kinds`, `edgeIndex`): an edge is named
//     [kind, r, c] and sits on one SIDE of cell (r, c), the side that faces the neighbour at
//     (r, c) + kindOffset[kind];
//   - how a tile may be turned over (`rotate`, `reflect`), and how far apart two cells are (`dist`);
//   - how it is drawn (`polygon`, `center`, `bounds`, `cellAt`, `hit`), in "cell units": 1 unit is the width
//     of a cell, so line widths and sizes mean the same on every grid;
//   - optional hooks for a grid that is not a plain lattice: `hasEdge(kind, r, c)` (does that edge exist at all),
//     `okShift(dr, dc)` (may a tile move by this offset: triangles must keep pointing the same way),
//     `originShift(minR, minC)` (how to slide a shape to the origin) and `flipsColor` (does a one-cell move swap
//     the colours of a two-colourable grid);
//   - the named tile shapes it has (`shapes`, `labels`, `order`).
// A puzzle's topology is read from its `tile` string: "hex:..." is a hex puzzle, "tri:..." a triangle one,
// anything else is square.
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
  flipsColor: true,                                // a one-cell move swaps the colours
  colorOf: (r, c) => (r + c) & 1,
  hasEdge: () => true,
  okShift: () => true,
  originShift: (minR, minC) => [minR, minC],
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
  flipsColor: false,
  colorOf: (r, c) => ((c - r) % 3 + 3) % 3,
  hasEdge: () => true,
  okShift: () => true,
  originShift: (minR, minC) => [minR, minC],
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

// --- Triangles ----------------------------------------------------------------------------------------
// Rows of triangles pointing up and down in turn: cell (r, c) points up when r + c is even and down when it is odd.
// Cell (r, c) spans half a side to the right of cell (r, c-1), so neighbours in a row share a slanted edge, and an
// up triangle sits on the flat top of the down triangle below it: cell (r, c) (up) touches (r, c-1), (r, c+1) and
// (r+1, c); a down cell touches (r, c-1), (r, c+1) and (r-1, c). Edge kinds: 'w' = left of a cell (neighbour
// (r, c-1)), 'h' = the flat edge above a DOWN cell (neighbour (r-1, c)); there is no 'h' edge above an up cell.
// A triangle has side TS, so a cell is TS wide.
// Differences from a lattice of equal cells: a tile can only be moved by an offset with dr + dc even (it must keep
// pointing the same way: `okShift`, `originShift`), rotating by 60 degrees turns up triangles into down ones (the
// rotation works on the triangles' corners), and the two colours (up, down) are not swapped by a move.

const TS = 1.25, TH = TS * SQRT3 / 2;
const TRI_UP = Object.freeze([
  { dr: 0, dc: 1, kind: 'w', kr: 0, kc: 1, side: 0 },      // right
  { dr: 1, dc: 0, kind: 'h', kr: 1, kc: 0, side: 1 },      // below
  { dr: 0, dc: -1, kind: 'w', kr: 0, kc: 0, side: 2 },     // left
]);
const TRI_DOWN = Object.freeze([
  { dr: -1, dc: 0, kind: 'h', kr: 0, kc: 0, side: 0 },     // above
  { dr: 0, dc: 1, kind: 'w', kr: 0, kc: 1, side: 1 },      // right
  { dr: 0, dc: -1, kind: 'w', kr: 0, kc: 0, side: 2 },     // left
]);

// A triangle's corners in lattice coordinates (w, j): j is the row line, w = (half-side position) + 1, so every
// corner has w + j even. An up triangle has its apex on line r and its base on line r+1; a down one the reverse.
export function triCorners(r, c) {
  return (r + c) % 2 === 0
    ? [[c + 2, r], [c + 3, r + 1], [c + 1, r + 1]]
    : [[c + 1, r], [c + 3, r], [c + 2, r + 1]];
}
// The cell whose corners these are.
function triFromCorners(corners) {
  const r = Math.min(...corners.map(([, j]) => j));
  const top = corners.filter(([, j]) => j === r);
  return top.length === 1 ? [r, top[0][0] - 2] : [r, Math.min(...top.map(([w]) => w)) - 1];
}
const triRotate = ([r, c]) => triFromCorners(triCorners(r, c).map(([w, j]) => [(w - 3 * j) / 2, (w + j) / 2]));     // 60 degrees about the lattice point (0, 0)
const triReflect = ([r, c]) => triFromCorners(triCorners(r, c).map(([w, j]) => [2 - w, j]));

export const TRI = {
  name: 'tri',
  prefix: 'tri:',
  kinds: ['w', 'h'],
  kindOffset: { w: [0, -1], h: [-1, 0] },
  kindSide: { w: 2, h: 0 },
  dirs: null,                                       // (not the same for every cell: use dirsAt)
  dirsAt: (r, c) => ((r + c) % 2 === 0 ? TRI_UP : TRI_DOWN),
  edgeLength: (rows, cols) => rows * cols,
  edgeIndex: (cols, kind, r, c) => r * cols + c,
  hasEdge: (kind, r, c) => kind === 'w' || (r + c) % 2 !== 0,
  rotations: 6,
  rotate: triRotate,
  reflect: triReflect,
  okShift: (dr, dc) => (dr + dc) % 2 === 0,
  originShift: (minR, minC) => [minR, minC - ((minR + minC) & 1)],
  // a step changes exactly one of r and c by 1, so Manhattan distance never overestimates the distance between cells
  dist: (dr, dc) => Math.abs(dr) + Math.abs(dc),
  twoColor: true,                                   // up and down triangles alternate, so a region's up and down counts are tested like chessboard colours
  flipsColor: false,                                // and a tile keeps its colours when it is moved
  colorOf: (r, c) => (r + c) & 1,
  polygon: (r, c) => {
    const x = c * TS / 2, y = r * TH;
    return (r + c) % 2 === 0
      ? [[x + TS / 2, y], [x + TS, y + TH], [x, y + TH]]
      : [[x, y], [x + TS, y], [x + TS / 2, y + TH]];
  },
  center: (r, c) => [c * TS / 2 + TS / 2, r * TH + ((r + c) % 2 === 0 ? 2 * TH / 3 : TH / 3)],
  bounds: (rows, cols) => [(cols + 1) * TS / 2, rows * TH],
  cellAt: (x, y) => {
    const r = Math.floor(y / TH), v = y / TH - r, u = x / (TS / 2), k = Math.floor(u);
    // inside the column [k, k + 1] (in half sides) the point is in cell k or cell k - 1, split by a slanted line
    return [r, (r + k) % 2 === 0 ? (u >= k + 1 - v ? k : k - 1) : (u - k >= v ? k : k - 1)];
  },
  hit: { half: 0.14, inset: 0.12 },                 // (triangles are small on a phone: a wider strip along each edge)
  tapSlop: 0.2,
};

// --- Registry --------------------------------------------------------------------------------------

export const TOPOLOGIES = { square: SQUARE, hex: HEX, tri: TRI };

// "hex:h4a" -> HEX; "tri:i4a" -> TRI; "L" or "XX/X." -> SQUARE. Fast: it runs in hot loops.
export function topologyOfTile(tile) {
  const first = tile.charCodeAt(0);
  if (first === 104 && tile.startsWith('hex:')) return HEX;       // 104 = 'h'
  if (first === 116 && tile.startsWith('tri:')) return TRI;       // 116 = 't'
  return SQUARE;
}

// A spec without its topology prefix.
export const specBody = spec => (spec.startsWith('hex:') || spec.startsWith('tri:') ? spec.slice(4) : spec);

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
