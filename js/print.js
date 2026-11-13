// Printable booklets: pick puzzles from the current book and print them (or "Save as PDF" in
// the browser's print dialog), optionally followed by an answer key. The boards are drawn as
// plain SVG with fixed colours, so a booklet looks the same in dark mode and on paper.
//
// buildPrintRoot() fills the hidden #print-root element; style.css shows only that element
// when printing (see "Printing" there).
import { resolveShape, tileSpecs, edgesFromSolution, playableEdges, getEdge, EDGE_LINE, topologyOf, topologyOfTile } from './logic.js';
import { SQUARE, edgeEnds, shapeBox } from './topology.js';
import { TIER_INFO } from './rating.js';

const NS = 'http://www.w3.org/2000/svg';
const INK = '#111', GRID = '#9a9a9a', SWATCH = '#cfcfcf';
export const MAX_PRINT = 500;
export const SITE_URL = 'https://joshmermelstein.com/polyomino-panel/';   // linked from every page, so a PDF leads back to the puzzles (and a paper copy shows where)

const svgEl = (tag, attrs, parent) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  parent?.appendChild(el);
  return el;
};

// "1-10, 15, 20-22" -> { ids: [1..10, 15, 20, 21, 22] } (ascending, no repeats) or { error }.
export function parseSelection(text, total) {
  // "1 - 5" means 1-5: close up spaces around dashes before splitting on commas and spaces
  const parts = text.replace(/\s*[-\u2013]\s*/g, '-').split(/[,\s]+/).filter(Boolean);
  if (!parts.length) return { error: 'Enter the puzzles to print, for example 1-10 or 3, 7, 12.' };
  const ids = new Set();
  for (const part of parts) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) return { error: `"${part}" isn't a puzzle number or range.` };
    const a = Number(m[1]), b = m[2] === undefined ? a : Number(m[2]);
    if (a < 1 || b < 1 || a > total || b > total) return { error: `This book has puzzles 1 to ${total}.` };
    if (b < a) return { error: `"${part}" is backwards.` };
    for (let i = a; i <= b; i++) ids.add(i);
  }
  if (ids.size > MAX_PRINT) return { error: `Please print at most ${MAX_PRINT} puzzles at a time.` };
  return { ids: [...ids].sort((x, y) => x - y) };
}

// --- Page layout ------------------------------------------------------------------------------------------
// Boards are laid out by CELL SIZE, not by a fixed count: every board in the selection is drawn with cells of about
// `SIZES[size]` millimetres (a puzzle needs room to draw in, an answer only has to show its bold tile outlines), and a page
// carries as many columns and rows of them as fit. (A 6x6 puzzle then gets 16 to a page instead of 6, its answer 36.) The
// printable area is the smaller of A4 and Letter minus the 12 mm margins (see style.css), so the layout is the same on both.
export const SIZES = {
  comfortable: { label: 'Comfortable', puzzle: 6, answer: 3.5 },
  compact: { label: 'Compact', puzzle: 4.5, answer: 3 },
};
export const PAGE = { w: 186, h: 255, head: 14, caption: 8.5, colGap: 5, rowGap: 6 };       // mm
const CAPTION = { charMm: 2.0, gapMm: 2, swatchCellMm: 1.7 };       // a caption's text is about 2 mm a character at 3.6 mm type; a swatch is 1.7 mm a cell
const BOARD_PAD = 0.12;       // a board's svg is this many cell units wider and taller than its cells (see boardSvg)

// A puzzle's board size in cell units (a hex or triangle board is not cols x rows cells).
export function boardUnits(puzzle) {
  const [x0, y0, x1, y1] = shapeBox(topologyOf(puzzle), puzzle.rows, puzzle.cols, puzzle.outside);
  return [x1 - x0 + BOARD_PAD, y1 - y0 + BOARD_PAD];
}

// The grid of boards on a page for these puzzles: { cellMm, cols, rows, perPage }. The cell size is `cellMm`, shrunk if the
// biggest board would not fit on a page at that size, and (`taper`, for puzzles) a little smaller on boards wider than 8
// cells, down to three quarters at 16: a big board is drawn on with a finer pen, and fewer fit otherwise. All boards share the
// cell size and the grid (the biggest board sets it).
// An item is as wide as its board or its caption (the number, the tier and a picture of each shape), whichever is wider: a
// caption is not wrapped, so on a narrow board (a 6x6 at a small cell size, or a hex board) it sets the width of the column.
export function captionMm(puzzle, answer = false) {
  const tier = answer ? '' : TIER_INFO[puzzle.tier]?.name;
  const chars = 1 + 3 + (tier ? 3 + tier.length : 0);                   // '#', up to three digits, ' · ' and the tier
  const shapes = tileSpecs(puzzle.tile).map(sp => swatchSize(sp)[0]);
  return chars * CAPTION.charMm + shapes.reduce((a, w) => a + w + CAPTION.gapMm, 0);
}

export function layoutFor(puzzles, cellMm, taper = false, answer = false) {
  let w = 0, h = 0;
  for (const p of puzzles) { const [pw, ph] = boardUnits(p); w = Math.max(w, pw); h = Math.max(h, ph); }
  if (!w) return { cellMm, cols: 1, rows: 1, perPage: 1 };
  const size = taper ? cellMm * Math.min(1, Math.max(0.75, 1 - (Math.max(w, h) - 8.2) * 0.032)) : cellMm;
  const cell = Math.min(size, PAGE.w / w, (PAGE.h - PAGE.head - PAGE.caption) / h);
  const boardH = h * cell;
  let itemW = 0;
  for (const p of puzzles) itemW = Math.max(itemW, boardUnits(p)[0] * cell, captionMm(p, answer));
  const cols = Math.max(1, Math.floor((PAGE.w + PAGE.colGap) / (itemW + PAGE.colGap)));
  const rows = Math.max(1, Math.floor((PAGE.h - PAGE.head + PAGE.rowGap) / (boardH + PAGE.caption + PAGE.rowGap)));
  return { cellMm: cell, cols, rows, perPage: cols * rows };
}

// How many pages a booklet takes, and how many boards go on each. `keyIds` are the puzzles that have an answer
// (none: no answer key). `ids` and `puzzles` as in buildPrintRoot.
export function planPrint({ puzzles, ids, keyIds = [], size = 'comfortable' }) {
  const { puzzle: puzzleMm, answer: answerMm } = SIZES[size] ?? SIZES.comfortable;
  const mine = ids.map(id => puzzles[id - 1]);
  const puzzleLayout = layoutFor(mine, puzzleMm, true);
  const keyLayout = keyIds.length ? layoutFor(keyIds.map(id => puzzles[id - 1]), answerMm, false, true) : null;
  return {
    puzzleLayout, keyLayout,
    perPage: puzzleLayout.perPage, keyPerPage: keyLayout?.perPage ?? 0,
    puzzlePages: Math.ceil(ids.length / puzzleLayout.perPage),
    keyPages: keyLayout ? Math.ceil(keyIds.length / keyLayout.perPage) : 0,
  };
}

// One board as an SVG. With `solution`, the solution's tile boundaries are drawn bold.
function boardSvg(puzzle, solution) {
  if (topologyOf(puzzle) !== SQUARE || puzzle.outside) return shapedBoardSvg(puzzle, solution);     // (hex, triangles, or a square board with an outline)
  const { rows, cols } = puzzle;
  const pad = 0.06;
  const svg = svgEl('svg', { viewBox: `${-pad} ${-pad} ${cols + 2 * pad} ${rows + 2 * pad}`, class: 'print-board' });
  svgEl('rect', { x: 0, y: 0, width: cols, height: rows, fill: '#fff' }, svg);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (puzzle.grid[r * cols + c] === '#') svgEl('rect', { x: c, y: r, width: 1, height: 1, fill: INK }, svg);
    }
  }
  for (let i = 1; i < cols; i++) svgEl('line', { x1: i, y1: 0, x2: i, y2: rows, stroke: GRID, 'stroke-width': 0.025, 'stroke-dasharray': '0.07 0.06' }, svg);
  for (let i = 1; i < rows; i++) svgEl('line', { x1: 0, y1: i, x2: cols, y2: i, stroke: GRID, 'stroke-width': 0.025, 'stroke-dasharray': '0.07 0.06' }, svg);
  if (solution) {
    const edges = edgesFromSolution(puzzle, solution);
    for (const [kind, r, c] of playableEdges(puzzle)) {
      if (getEdge(puzzle, edges, kind, r, c) !== EDGE_LINE) continue;
      const [x1, y1, x2, y2] = kind === 'h' ? [c, r, c + 1, r] : [c, r, c, r + 1];
      svgEl('line', { x1, y1, x2, y2, stroke: INK, 'stroke-width': 0.1, 'stroke-linecap': 'round' }, svg);
    }
  }
  for (const [type, kind, r, c] of puzzle.givens ?? []) {       // pre-drawn clues: a bold line, or a small x
    const [x1, y1, x2, y2] = kind === 'h' ? [c, r, c + 1, r] : [c, r, c, r + 1];
    if (type === 'L') {
      svgEl('line', { x1, y1, x2, y2, stroke: INK, 'stroke-width': 0.1, 'stroke-linecap': 'round' }, svg);
    } else {
      const [mx, my, d] = [(x1 + x2) / 2, (y1 + y2) / 2, 0.14];
      svgEl('line', { x1: mx - d, y1: my - d, x2: mx + d, y2: my + d, stroke: INK, 'stroke-width': 0.05, 'stroke-linecap': 'round' }, svg);
      svgEl('line', { x1: mx - d, y1: my + d, x2: mx + d, y2: my - d, stroke: INK, 'stroke-width': 0.05, 'stroke-linecap': 'round' }, svg);
    }
  }
  svgEl('rect', { x: 0, y: 0, width: cols, height: rows, fill: 'none', stroke: INK, 'stroke-width': 0.08 }, svg);
  return svg;
}

// A board that is not a plain square grid (hex, triangles, or a square board with an outline: a plus sign, an octagon...):
// every cell is a polygon, the grid lines are the playable edges, and cells outside the board's shape are not drawn.
function shapedBoardSvg(puzzle, solution) {
  const { rows, cols } = puzzle;
  const topo = topologyOf(puzzle);
  const [x0, y0, x1, y1] = shapeBox(topo, rows, cols, puzzle.outside);
  const pad = 0.06;
  const svg = svgEl('svg', { viewBox: `${x0 - pad} ${y0 - pad} ${x1 - x0 + 2 * pad} ${y1 - y0 + 2 * pad}`, class: 'print-board' });
  const outside = i => puzzle.outside?.[i] === 'x';
  const pts = poly => poly.map(([x, y]) => `${x},${y}`).join(' ');
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (outside(i)) continue;
      // (blocked cells are a little oversized; round joins off the square grid, so a 60 degree corner is not a spike: as on screen, style.css)
      svgEl('polygon', { points: pts(topo.polygon(r, c)), fill: puzzle.grid[i] === '#' ? INK : '#fff', stroke: puzzle.grid[i] === '#' ? INK : 'none', 'stroke-width': 0.08, 'stroke-linejoin': topo === SQUARE ? 'miter' : 'round' }, svg);
    }
  }
  for (const [kind, r, c] of playableEdges(puzzle)) {
    const { x1, y1, x2, y2 } = edgeEnds(topo, kind, r, c);
    svgEl('line', { x1, y1, x2, y2, stroke: GRID, 'stroke-width': 0.025, 'stroke-dasharray': '0.07 0.06' }, svg);
  }
  const bold = (kind, r, c) => {
    const { x1, y1, x2, y2 } = edgeEnds(topo, kind, r, c);
    svgEl('line', { x1, y1, x2, y2, stroke: INK, 'stroke-width': 0.08, 'stroke-linecap': 'round' }, svg);
  };
  if (solution) {
    const edges = edgesFromSolution(puzzle, solution);
    for (const [kind, r, c] of playableEdges(puzzle)) if (getEdge(puzzle, edges, kind, r, c) === EDGE_LINE) bold(kind, r, c);
  }
  for (const [type, kind, r, c] of puzzle.givens ?? []) {
    if (type === 'L') { bold(kind, r, c); continue; }
    const { x1, y1, x2, y2 } = edgeEnds(topo, kind, r, c);
    const [mx, my, d] = [(x1 + x2) / 2, (y1 + y2) / 2, 0.11];
    svgEl('line', { x1: mx - d, y1: my - d, x2: mx + d, y2: my + d, stroke: INK, 'stroke-width': 0.05, 'stroke-linecap': 'round' }, svg);
    svgEl('line', { x1: mx - d, y1: my + d, x2: mx + d, y2: my - d, stroke: INK, 'stroke-width': 0.05, 'stroke-linecap': 'round' }, svg);
  }
  // the frame: one segment for every side of a cell that faces outside the board's shape
  const inShape = (r, c) => r >= 0 && r < rows && c >= 0 && c < cols && !outside(r * cols + c);
  let d = '';
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!inShape(r, c)) continue;
      const poly = topo.polygon(r, c);
      for (const dir of topo.dirsAt(r, c)) {
        if (inShape(r + dir.dr, c + dir.dc)) continue;
        const [x1, y1] = poly[dir.side], [x2, y2] = poly[(dir.side + 1) % poly.length];
        d += `M${x1} ${y1}L${x2} ${y2}`;
      }
    }
  }
  svgEl('path', { d, fill: 'none', stroke: INK, 'stroke-width': 0.08, 'stroke-linecap': topo === SQUARE ? 'square' : 'round' }, svg);
  return svg;
}

// A picture of one allowed shape, `cellMm` millimetres per cell.
function swatchGeometry(spec) {
  const polys = resolveShape(spec).map(([r, c]) => topologyOfTile(spec).polygon(r, c));
  const xs = polys.flat().map(p => p[0]), ys = polys.flat().map(p => p[1]);
  const [x0, y0] = [Math.min(...xs), Math.min(...ys)];
  return { polys, x0, y0, cols: Math.max(...xs) - x0, rows: Math.max(...ys) - y0 };
}
function swatchSize(spec, cellMm = CAPTION.swatchCellMm) {
  const { cols, rows } = swatchGeometry(spec);
  return [(cols + 0.1) * cellMm, (rows + 0.1) * cellMm];
}
function swatchSvg(spec, cellMm = CAPTION.swatchCellMm) {
  const { polys, x0, y0, cols, rows } = swatchGeometry(spec);
  const svg = svgEl('svg', { viewBox: `${x0 - 0.05} ${y0 - 0.05} ${cols + 0.1} ${rows + 0.1}`, class: 'print-swatch' });
  [svg.style.width, svg.style.height] = swatchSize(spec, cellMm).map(v => `${v}mm`);
  for (const poly of polys) svgEl('polygon', { points: poly.map(([x, y]) => `${x},${y}`).join(' '), fill: SWATCH, stroke: INK, 'stroke-width': 0.06 }, svg);
  return svg;
}

const div = (cls, parent, text) => {
  const el = document.createElement('div');
  el.className = cls;
  if (text !== undefined) el.textContent = text;
  parent?.appendChild(el);
  return el;
};

// Fill (and return) the #print-root element.
//   book       { title } the current book
//   puzzles    the book's puzzle array;  ids  the 1-based numbers to print
//   size       'comfortable' or 'compact' (SIZES): how big the boards are, so how many fit on a page
//   solutionOf puzzle -> solution string (or null)
export function buildPrintRoot({ book, puzzles, ids, size = 'comfortable', includeKey, solutionOf }) {
  let root = document.getElementById('print-root');
  if (!root) { root = document.createElement('div'); root.id = 'print-root'; document.body.appendChild(root); }
  root.textContent = '';
  const bookName = book.title;

  const addPages = (list, layout, withSolution, heading) => {
    const k = layout.perPage;
    for (let i = 0; i < list.length; i += k) {
      const page = div('print-page', root);
      const head = div('print-head', page);
      const brand = div('print-brand', head);
      const link = (text, cls) => {
        const a = document.createElement('a');
        a.href = SITE_URL; a.textContent = text; a.className = cls;
        return a;
      };
      brand.append(link('Polyomino Panel', 'print-name'));
      head.append(link(SITE_URL.replace(/^https:\/\//, '').replace(/\/$/, ''), 'print-url'));
      div('print-book', head, `${bookName}${heading ? ` · ${heading}` : ''}`);
      const grid = div('print-grid', page);
      grid.style.setProperty('--cols', layout.cols);
      grid.style.setProperty('--cell', `${layout.cellMm}mm`);
      for (const id of list.slice(i, i + k)) {
        const p = puzzles[id - 1];
        const fig = div('print-item', grid);
        const tier = TIER_INFO[p.tier]?.name;
        // books mix shapes, so each puzzle says which tile shapes it uses
        const cap = div('print-caption', fig);
        cap.append(document.createTextNode(`#${id}${!withSolution && tier ? ` · ${tier}` : ''}`));
        for (const sp of tileSpecs(p.tile)) cap.append(swatchSvg(sp));
        const board = boardSvg(p, withSolution ? solutionOf(p) : null);
        const [bw] = boardUnits(p);
        board.style.width = `${bw * layout.cellMm}mm`;       // the same cell size for every board (they differ when the selection mixes sizes)
        fig.append(board);
      }
    }
  };

  const keyIds = includeKey ? ids.filter(id => solutionOf(puzzles[id - 1])) : [];
  const plan = planPrint({ puzzles, ids, keyIds, size });
  addPages(ids, plan.puzzleLayout, false, null);
  if (keyIds.length) addPages(keyIds, plan.keyLayout, true, 'Answers');
  return root;
}
