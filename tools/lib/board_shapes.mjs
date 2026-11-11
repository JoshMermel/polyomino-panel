// Board shapes for tools/make_shaped.mjs and tools/make_shapes_book.mjs: a bounding box and which cells belong to
// the shape. The cells outside it are always blocked (the generator's `fixed` option) and, in the puzzle's `outside`
// column, not drawn by the app. Rectangles have no outside cells; every other shape (donuts included) does, so the hole of a donut is not drawn.
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
