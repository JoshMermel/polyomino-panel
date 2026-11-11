// Board shapes for tools/make_shaped.mjs and tools/make_shapes_book.mjs: a bounding box and which cells belong to
// the shape. The cells outside it are always blocked (the generator's `fixed` option) and, in the puzzle's `outside`
// column, not drawn by the app. Rectangles have no outside cells.
const SHAPES = {
  plus9: () => ({ rows: 9, cols: 9, keep: (r, c) => (r >= 3 && r < 6) || (c >= 3 && c < 6) }),
  octagon8: () => ({ rows: 8, cols: 8, keep: (r, c) => r + c >= 3 && r + (7 - c) >= 3 && (7 - r) + c >= 3 && (7 - r) + (7 - c) >= 3 }),
  // donuts: a square with a square hole in the middle that is not part of the board (not drawn; the frame goes round it)
  donut9: () => ({ rows: 9, cols: 9, keep: (r, c) => !(r >= 3 && r < 6 && c >= 3 && c < 6) }),
  donut10: () => ({ rows: 10, cols: 10, keep: (r, c) => !(r >= 3 && r < 7 && c >= 3 && c < 7) }),
  // a ring whose hole is blocked cells inside the board (drawn black)
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
  // the ring's hole is a part of the board that is blocked (drawn black), not outside it
  const outline = !m && name !== 'ring8';
  return { rows, cols, fixed, outside: outline ? fixed.map(f => (f ? 'x' : '.')).join('') : '' };
}
