// Printable booklets: pick puzzles from the current book and print them (or "Save as PDF" in
// the browser's print dialog), optionally followed by an answer key. The boards are drawn as
// plain SVG with fixed colours, so a booklet looks the same in dark mode and on paper.
//
// buildPrintRoot() fills the hidden #print-root element; style.css shows only that element
// when printing (see "Printing" there).
import { resolveShape, shapeName, edgesFromSolution, playableEdges, getEdge, EDGE_LINE } from './logic.js';
import { TIER_INFO } from './rating.js';

const NS = 'http://www.w3.org/2000/svg';
const INK = '#111', GRID = '#9a9a9a', SWATCH = '#cfcfcf';
export const KEY_PER_PAGE = 6;           // answer-key boards per page
export const MAX_PRINT = 200;

const svgEl = (tag, attrs, parent) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  parent?.appendChild(el);
  return el;
};

// "1-10, 15, 20-22" -> { ids: [1..10, 15, 20, 21, 22] } (ascending, no repeats) or { error }.
export function parseSelection(text, total) {
  const parts = text.split(/[,\s]+/).filter(Boolean);
  if (!parts.length) return { error: 'Enter the puzzles to print, for example 1-10 or 3, 7, 12.' };
  const ids = new Set();
  for (const part of parts) {
    const m = /^(\d+)(?:\s*[-–]\s*(\d+))?$/.exec(part);
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
  svgEl('rect', { x: 0, y: 0, width: cols, height: rows, fill: 'none', stroke: INK, 'stroke-width': 0.08 }, svg);
  return svg;
}

function swatchSvg(tile) {
  const cells = resolveShape(tile);
  const rows = Math.max(...cells.map(([r]) => r)) + 1, cols = Math.max(...cells.map(([, c]) => c)) + 1;
  const svg = svgEl('svg', { viewBox: `-0.05 -0.05 ${cols + 0.1} ${rows + 0.1}`, class: 'print-swatch' });
  svg.style.height = `${Math.min(9, 4 + 1.4 * rows)}mm`;
  svg.style.width = `${Math.min(9, 4 + 1.4 * rows) * (cols + 0.1) / (rows + 0.1)}mm`;
  for (const [r, c] of cells) svgEl('rect', { x: c, y: r, width: 1, height: 1, fill: SWATCH, stroke: INK, 'stroke-width': 0.06 }, svg);
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
//   book       { tile, rows, cols, title? } the current book
//   puzzles    the book's puzzle array;  ids  the 1-based numbers to print
//   perPage    puzzles per page (1, 2, 4 or 6)
//   solutionOf puzzle -> solution string (or null)
export function buildPrintRoot({ book, puzzles, ids, perPage, includeKey, solutionOf }) {
  let root = document.getElementById('print-root');
  if (!root) { root = document.createElement('div'); root.id = 'print-root'; document.body.appendChild(root); }
  root.textContent = '';
  const bookName = book.custom ? book.title : `${shapeName(book.tile)}, ${book.rows}×${book.cols}`;

  const addPages = (list, k, withSolution, heading) => {
    for (let i = 0; i < list.length; i += k) {
      const page = div(`print-page k${k}`, root);
      const head = div('print-head', page);
      div('print-brand', head, 'Polyomino Panel');
      head.append(swatchSvg(book.tile));
      div('print-book', head, `${bookName}${heading ? ` · ${heading}` : ''}`);
      const grid = div('print-grid', page);
      for (const id of list.slice(i, i + k)) {
        const p = puzzles[id - 1];
        const fig = div('print-item', grid);
        const tier = TIER_INFO[p.tier]?.name;
        div('print-caption', fig, `${withSolution ? 'Answer ' : 'Puzzle '}${id}${!withSolution && tier ? ` · ${tier}` : ''}`);
        fig.append(boardSvg(p, withSolution ? solutionOf(p) : null));
      }
    }
  };

  addPages(ids, perPage, false, null);
  if (includeKey) addPages(ids.filter(id => solutionOf(puzzles[id - 1])), KEY_PER_PAGE, true, 'Answers');
  return root;
}
