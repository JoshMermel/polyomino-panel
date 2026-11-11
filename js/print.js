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
export const KEY_PER_PAGE = 6;           // answer-key boards per page
export const MAX_PRINT = 200;
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

// How many pages a booklet takes.
export function planPrint({ count, perPage, includeKey }) {
  const puzzlePages = Math.ceil(count / perPage);
  const keyPages = includeKey ? Math.ceil(count / KEY_PER_PAGE) : 0;
  return { puzzlePages, keyPages };
}

// One board as an SVG. With `solution`, the solution's tile boundaries are drawn bold.
function boardSvg(puzzle, solution) {
  if (topologyOf(puzzle) !== SQUARE) return shapedBoardSvg(puzzle, solution);
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

// A board on a grid that is not square (hex...): every cell is a polygon, the grid lines are the playable
// edges, and cells outside the board's shape are not drawn.
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
      svgEl('polygon', { points: pts(topo.polygon(r, c)), fill: puzzle.grid[i] === '#' ? INK : '#fff', stroke: puzzle.grid[i] === '#' ? INK : 'none', 'stroke-width': 0.08, 'stroke-linejoin': 'miter' }, svg);
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
  svgEl('path', { d, fill: 'none', stroke: INK, 'stroke-width': 0.08, 'stroke-linecap': 'round' }, svg);
  return svg;
}

// A picture of one allowed shape, `cellMm` millimetres per cell.
function swatchSvg(spec, cellMm = 1.7) {
  const cells = resolveShape(spec);
  const topo = topologyOfTile(spec);
  const polys = cells.map(([r, c]) => topo.polygon(r, c));
  const xs = polys.flat().map(p => p[0]), ys = polys.flat().map(p => p[1]);
  const [x0, y0] = [Math.min(...xs), Math.min(...ys)];
  const cols = Math.max(...xs) - x0, rows = Math.max(...ys) - y0;
  const svg = svgEl('svg', { viewBox: `${x0 - 0.05} ${y0 - 0.05} ${cols + 0.1} ${rows + 0.1}`, class: 'print-swatch' });
  svg.style.height = `${(rows + 0.1) * cellMm}mm`;
  svg.style.width = `${(cols + 0.1) * cellMm}mm`;
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
//   perPage    puzzles per page (1, 2, 4 or 6)
//   solutionOf puzzle -> solution string (or null)
export function buildPrintRoot({ book, puzzles, ids, perPage, includeKey, solutionOf }) {
  let root = document.getElementById('print-root');
  if (!root) { root = document.createElement('div'); root.id = 'print-root'; document.body.appendChild(root); }
  root.textContent = '';
  const bookName = book.title;

  const addPages = (list, k, withSolution, heading) => {
    for (let i = 0; i < list.length; i += k) {
      const page = div(`print-page k${k}`, root);
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
      for (const id of list.slice(i, i + k)) {
        const p = puzzles[id - 1];
        const fig = div('print-item', grid);
        const tier = TIER_INFO[p.tier]?.name;
        // books mix shapes, so each puzzle says which tile shapes it uses
        const cap = div('print-caption', fig);
        cap.append(document.createTextNode(`${withSolution ? 'Answer ' : 'Puzzle '}${id}${!withSolution && tier ? ` · ${tier}` : ''}`));
        for (const sp of tileSpecs(p.tile)) cap.append(swatchSvg(sp));
        fig.append(boardSvg(p, withSolution ? solutionOf(p) : null));
      }
    }
  };

  addPages(ids, perPage, false, null);
  if (includeKey) addPages(ids.filter(id => solutionOf(puzzles[id - 1])), KEY_PER_PAGE, true, 'Answers');
  return root;
}
