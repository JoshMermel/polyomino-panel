// Board shapes for tools/make_shaped.mjs and tools/make_shapes_book.mjs: a bounding box and which cells belong to
// the shape. The cells outside it are always blocked (the generator's `fixed` option) and, in the puzzle's `outside`
// column, not drawn by the app. Rectangles have no outside cells; every other shape (donuts included) does, so the hole of a donut is not drawn.
import { TRI, triCorners } from '../../js/topology.js';

const SHAPES = {
  plus9: () => ({ rows: 9, cols: 9, keep: (r, c) => (r >= 3 && r < 6) || (c >= 3 && c < 6) }),
  octagon8: () => ({ rows: 8, cols: 8, keep: (r, c) => r + c >= 3 && r + (7 - c) >= 3 && (7 - r) + c >= 3 && (7 - r) + (7 - c) >= 3 }),
  // donuts: a square with a square hole in the middle that is not part of the board (not drawn; the frame goes round it)
  donut9: () => ({ rows: 9, cols: 9, keep: (r, c) => !(r >= 3 && r < 6 && c >= 3 && c < 6) }),
  donut10: () => ({ rows: 10, cols: 10, keep: (r, c) => !(r >= 3 && r < 7 && c >= 3 && c < 7) }),
  donut11: () => ({ rows: 11, cols: 11, keep: (r, c) => !(r >= 3 && r < 8 && c >= 3 && c < 8) }),
  plus12: () => ({ rows: 12, cols: 12, keep: (r, c) => (r >= 4 && r < 8) || (c >= 4 && c < 8) }),
  octagon10: () => ({ rows: 10, cols: 10, keep: (r, c) => r + c >= 4 && r + (9 - c) >= 4 && (9 - r) + c >= 4 && (9 - r) + (9 - c) >= 4 }),
  diamond9: () => ({ rows: 9, cols: 9, keep: (r, c) => Math.abs(r - 4) + Math.abs(c - 4) <= 4 }),
  diamond11: () => ({ rows: 11, cols: 11, keep: (r, c) => Math.abs(r - 5) + Math.abs(c - 5) <= 5 }),
  lshape10: () => ({ rows: 10, cols: 10, keep: (r, c) => !(r < 5 && c >= 5) }),
  tshape9: () => ({ rows: 9, cols: 9, keep: (r, c) => r < 3 || (c >= 3 && c < 6) }),
  hshape9: () => ({ rows: 9, cols: 9, keep: (r, c) => c < 3 || c >= 6 || (r >= 3 && r < 6) }),
  ushape9: () => ({ rows: 9, cols: 9, keep: (r, c) => !(r < 6 && c >= 3 && c < 6) }),
  stairs9: () => ({ rows: 9, cols: 9, keep: (r, c) => c <= r }),
  // the 8x8 donut: a 2x2 hole in the middle
  ring8: () => ({ rows: 8, cols: 8, keep: (r, c) => !(r >= 3 && r < 5 && c >= 3 && c < 5) }),
  lshape8: () => ({ rows: 8, cols: 8, keep: (r, c) => !(r < 4 && c >= 4) }),
};
// Hex boards (see js/topology.js): a hexagon with sides of n cells is a (2n-1) x (2n-1) array of axial coordinates
// with the two corners (and nothing else) cut off; a rhombus is the whole array.
const hexDist = (dr, dc) => Math.max(Math.abs(dr), Math.abs(dc), Math.abs(dr + dc));
for (const n of [3, 4, 5, 6, 7]) {
  SHAPES[`hexagon${n}`] = () => ({ rows: 2 * n - 1, cols: 2 * n - 1, keep: (r, c) => hexDist(r - (n - 1), c - (n - 1)) <= n - 1 });
}
// More hex boards: hexrhombusN is the whole N x N array (a slanted rhombus, N*N cells), hextriangleN the half of it with
// r + c < N (a triangle with sides of N cells, N(N+1)/2 cells).
for (const n of [6, 7, 8, 10, 11]) SHAPES[`hexrhombus${n}`] = () => ({ rows: n, cols: n, keep: () => true });
for (const n of [8, 9, 10, 11, 13, 14]) SHAPES[`hextriangle${n}`] = () => ({ rows: n, cols: n, keep: (r, c) => r + c <= n - 1 });
// hexrectWxR: a rectangle of R rows of W cells, every other row shifted half a cell (so the sides zigzag). Row r is drawn
// r / 2 cells to the right of the array's first column, so its cells start at column floor((R - 1) / 2) - floor(r / 2).
for (const [w, r] of [[6, 6], [7, 7], [8, 8], [9, 9], [10, 10]]) {
  SHAPES[`hexrect${w}x${r}`] = () => ({ rows: r, cols: w + Math.floor((r - 1) / 2), keep: (i, c) => { const s = Math.floor((r - 1) / 2) - Math.floor(i / 2); return c >= s && c < s + w; } });
}
// Triangle boards (see js/topology.js): a region of the triangle lattice, in lattice coordinates (u, j) where u counts half
// sides and j rows of lattice points; a cell belongs when all three of its corners are in the region. The region's array is
// cropped to its cells (sliding by an even offset, so up triangles stay up). trihexagonN is a hexagon with sides of N
// triangles (6 N^2 cells), tritriangleN a triangle with sides of N (N^2 cells), trirhombusN a rhombus of N by N (2 N^2).
const triRegion = (rows, inside) => () => {
  const cells = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < 4 * rows + 4; c++) if (triCorners(r, c).every(([w, j]) => inside(w - 1, j))) cells.push([r, c]);
  const minR = Math.min(...cells.map(p => p[0])), minC = Math.min(...cells.map(p => p[1]));
  const [sr, sc] = TRI.originShift(minR, minC);
  const kept = new Set(cells.map(([r, c]) => `${r - sr},${c - sc}`));
  const rowsOut = Math.max(...cells.map(p => p[0])) - sr + 1, colsOut = Math.max(...cells.map(p => p[1])) - sc + 1;
  return { rows: rowsOut, cols: colsOut, keep: (r, c) => kept.has(`${r},${c}`) };
};
for (const n of [1, 2, 3, 4, 5, 6]) {
  const u0 = 2 * n + ((n + 1) % 2);                                       // the hexagon's middle lattice point (u0, n): u0 + 1 + n is even
  SHAPES[`trihexagon${n}`] = triRegion(2 * n, (u, j) => Math.abs(j - n) <= n && Math.abs(u - u0) + Math.abs(j - n) <= 2 * n);
}
for (const n of [4, 5, 6, 7, 8, 10, 12]) {
  const ua = n + ((n + 1) % 2 === 0 ? 0 : 1);                             // the apex's lattice point (ua, 0): ua + 1 is even
  SHAPES[`tritriangle${n}`] = triRegion(n, (u, j) => j >= 0 && j <= n && Math.abs(u - ua) <= j);
}
for (const n of [3, 4, 5, 6]) {
  SHAPES[`trirhombus${n}`] = triRegion(n, (u, j) => j >= 0 && j <= n && u - j >= 1 && u - j <= 1 + 2 * n);
}
// trirectRxW: a rectangle R rows of triangles high and W half sides wide, with zigzag left and right sides (and flat top and bottom)
for (const [r, w] of [[4, 7], [5, 9], [6, 11], [7, 13], [8, 15], [10, 17]]) SHAPES[`trirect${r}x${w}`] = triRegion(r, (u, j) => j >= 0 && j <= r && u >= 0 && u <= w);
// -> { rows, cols, fixed: [bool per cell], outside: string ('x' = outside, '.' = in the shape) or '' for a rectangle }
export function boardShape(name) {
  const m = /^rect(\d+)x(\d+)$/.exec(name);
  const spec = m ? { rows: +m[1], cols: +m[2], keep: () => true } : SHAPES[name]?.();
  if (!spec) throw new Error(`unknown shape ${name}`);
  const { rows, cols } = spec;
  const fixed = Array.from({ length: rows * cols }, (_, i) => !spec.keep(Math.floor(i / cols), i % cols));
  const outline = !m;
  return { rows, cols, fixed, outside: outline ? fixed.map(f => (f ? 'x' : '.')).join('') : '' };
}
