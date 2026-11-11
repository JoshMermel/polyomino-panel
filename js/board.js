// SVG board renderer. One SVG unit = one cell, so all geometry below is in
// cell units and the whole board scales via CSS (--cell-size).
//
// The board is "dumb": it draws what it's told and reports gestures through
// callbacks. Game rules and history live in main.js.
//
// Input: pointer events on the whole SVG, decoded geometrically. Where a press
// lands decides the kind of gesture:
//   on an edge  -> a tap: onEdgePress when the pointer is released without having moved
//                  more than the topology's tapSlop (cell units). A press that does move turns into a "cell"
//                  gesture (below) that starts in the cell the press landed in, so a drag that
//                  happens to start on an edge still works.
//   on a cell   -> a "cell" gesture: onCellPress, then onCellEnter for every
//                  other open cell dragged across, then onRelease (or onCancel if the
//                  browser cancels the pointer).
import {
  EDGE_LINE, EDGE_CROSS, OPEN, isOpen, getEdge, isGivenEdge, playableEdges, topologyOf,
} from './logic.js';
import { edgeEnds as topoEdgeEnds, shapeBox } from './topology.js';

const NS = 'http://www.w3.org/2000/svg';
const SHAPE_COLORS = 4;     // how many shapes have their own color (--shape-N in style.css)
const BAD_DELAY_MS = 300; // how long a wrong-shape (red) tint waits, so a double-click can finish first


function el(tag, attrs = {}, parent = null) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

// The points of a polygon as an SVG `points` / path string.
const pointsOf = poly => poly.map(([x, y]) => `${x},${y}`).join(' ');

export class Board {
  // callbacks: { onEdgePress(kind, r, c),
  //              onCellPress(i), onCellEnter(i), onRelease(), onCancel(),
  //              onEdgeContext(kind, r, c) }
  constructor(container, callbacks) {
    this.container = container;
    this.cb = callbacks;
    this.svg = null;
  }

  render(puzzle, edges) {
    clearTimeout(this._badTimer);
    this.puzzle = puzzle;
    const { rows, cols } = puzzle;
    const topo = this.topo = topologyOf(puzzle);
    const [bx0, by0, bx1, by1] = shapeBox(topo, rows, cols, puzzle.outside);   // the board's box in cell units (a hex board is not cols x rows)
    const width = bx1 - bx0, height = by1 - by0;
    this.container.textContent = '';

    const pad = 0.08;
    const svg = el('svg', {
      viewBox: `${bx0 - pad} ${by0 - pad} ${width + 2 * pad} ${height + 2 * pad}`,
      class: 'board-svg',
      role: 'img',
      'aria-label': `${rows} by ${cols} puzzle board`,
    });
    svg.style.setProperty('--grid-cols', width);
    svg.style.setProperty('--grid-rows', height);

    // Lines are thick with round caps, so one that ends on the grid's outer edge would poke
    // out past it. The line layers are clipped to the grid rectangle to keep them inside.
    const defs = el('defs', {}, svg);
    const clip = el('clipPath', { id: 'board-clip' }, defs);
    el('rect', { x: bx0, y: by0, width, height }, clip);
    // Walled-in regions that can never become a tile are hatched, not just tinted, so they cannot be
    // mistaken for the (also warm-coloured) shape tints, whatever one's colour vision. Colours: style.css.
    const hatch = el('pattern', { id: 'bad-hatch', width: 0.2, height: 0.2, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, defs);
    el('rect', { class: 'pat-cell', width: 0.2, height: 0.2 }, hatch);
    el('rect', { class: 'hatch-bg', width: 0.2, height: 0.2 }, hatch);
    el('line', { class: 'hatch-line', x1: 0.1, y1: 0, x2: 0.1, y2: 0.2 }, hatch);
    // The green glow of a solved board is clipped to the OUTSIDE of the board's shape (the whole plane minus its cells), so it
    // only glows outward and never over the blocked cells inside.
    const outsideClip = el('clipPath', { id: 'board-outside' }, defs);
    let outsideD = `M${bx0 - 3} ${by0 - 3}H${bx1 + 3}V${by1 + 3}H${bx0 - 3}Z`;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (puzzle.outside?.[r * cols + c] !== 'x') outsideD += `M${pointsOf(topo.polygon(r, c))}Z`;
    el('path', { d: outsideD, 'clip-rule': 'evenodd' }, outsideClip);
    // The blocked cells are drawn a little oversized (a stroke, see style.css). A sharp corner of one on the board's edge (the 60
    // degree corner of a triangle) would poke past the frame as a spike, so that layer is masked to the cells of the shape grown by the
    // frame's half width (0.04) with round corners, which is exactly what the frame covers.
    let shapeD = '';
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (puzzle.outside?.[r * cols + c] !== 'x') shapeD += `M${pointsOf(topo.polygon(r, c))}Z`;
    const mask = el('mask', { id: 'board-mask', maskUnits: 'userSpaceOnUse', x: bx0 - 1, y: by0 - 1, width: width + 2, height: height + 2 }, defs);
    el('path', { d: shapeD, fill: '#fff', stroke: '#fff', 'stroke-width': 0.08, 'stroke-linejoin': 'round' }, mask);
    const inside = { 'clip-path': 'url(#board-clip)' };

    // Layers, bottom to top.
    const cellLayer = el('g', { class: 'layer-cells' }, svg);
    const dashLayer = el('g', { class: 'layer-dash', ...inside }, svg);
    // above the open cells and the dashed grid lines, so a blocked cell's stroke (see style.css) is never covered by a neighbour or
    // crossed by a dash that ends at its corner
    const blockedLayer = el('g', { class: 'layer-blocked', mask: 'url(#board-mask)' }, svg);
    const segLayer = el('g', { class: 'layer-seg', ...inside }, svg);
    const xLayer = el('g', { class: 'layer-x' }, svg);
    this.hintLayer = el('g', { class: 'layer-hint', ...inside }, svg);   // ghost lines / cross for hints
    if (puzzle.outside || topo.name !== 'square') {
      // a board with an outline (or a hex board): the frame follows the shape, one segment for every side of a cell on the shape's edge
      const inShape = (r, c) => r >= 0 && r < rows && c >= 0 && c < cols && puzzle.outside?.[r * cols + c] !== 'x';
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
      const cap = topo.name === 'square' ? 'square' : 'round';       // square corners meet at right angles; other angles need round caps
      el('path', { class: 'frame-glow', d, 'stroke-linecap': cap, 'clip-path': 'url(#board-outside)' }, svg);          // shown only on a solved board (style.css)
      el('path', { class: 'frame', d, 'stroke-linecap': cap }, svg);
    } else {
      el('rect', { class: 'frame-glow', x: 0, y: 0, width: cols, height: rows, 'clip-path': 'url(#board-outside)' }, svg);
      el('rect', { class: 'frame', x: 0, y: 0, width: cols, height: rows }, svg);
    }

    this.cellEls = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const open = puzzle.grid[r * cols + c] === OPEN;
        const outside = puzzle.outside?.[r * cols + c] === 'x';      // not part of the board's shape: not drawn at all
        this.cellEls.push(el('polygon', {
          class: open ? 'cell' : outside ? 'cell outside' : 'cell blocked',
          points: pointsOf(topo.polygon(r, c)),
        }, open || outside ? cellLayer : blockedLayer));
      }
    }

    // Per-edge elements, keyed "h:r:c" / "v:r:c".
    this.segs = new Map();
    this.xs = new Map();
    for (const [kind, r, c] of playableEdges(puzzle)) this._buildEdge(kind, r, c, { dashLayer, segLayer, xLayer });

    // a single rectangle that follows the pointer over open cells (hover hint: cells can be dragged across)
    this.cellHoverEl = el('polygon', { class: 'cell-hover', visibility: 'hidden' }, cellLayer);
    this.container.appendChild(svg);
    this.svg = svg;
    this._hoverKey = null;
    this._bindPointer(svg);
    this.setAllEdges(edges);
  }

  _buildEdge(kind, r, c, layers) {
    const key = `${kind}:${r}:${c}`;
    const { x1, y1, x2, y2 } = topoEdgeEnds(this.topo, kind, r, c);
    el('line', { class: 'dash', x1, y1, x2, y2 }, layers.dashLayer);

    const seg = el('line', { class: 'seg', x1, y1, x2, y2 }, layers.segLayer);
    this.segs.set(key, seg);

    // Small X centred on the edge.
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, d = 0.11;
    const x = el('g', { class: 'xmark', visibility: 'hidden' }, layers.xLayer);
    el('line', { x1: mx - d, y1: my - d, x2: mx + d, y2: my + d }, x);
    el('line', { x1: mx - d, y1: my + d, x2: mx + d, y2: my - d }, x);
    this.xs.set(key, x);
  }

  // --- Pointer handling ------------------------------------------------------

  // Pointer position in cell units (0..cols, 0..rows).
  _point(e) {
    const r = this.svg.getBoundingClientRect();
    const vb = this.svg.viewBox.baseVal;
    return [(e.clientX - r.left) / r.width * vb.width + vb.x,
            (e.clientY - r.top) / r.height * vb.height + vb.y];
  }

  // The playable edge at a point, or null. An edge's target area is a thin
  // strip along its middle, inset from the vertices so neighbours never overlap.
  // (A playable edge lies between two open cells, so the point is in one of them.)
  _edgeAt(x, y) {
    const { puzzle, topo } = this;
    const [r, c] = topo.cellAt(x, y);
    if (!isOpen(puzzle, r, c)) return null;
    const { half, inset } = topo.hit;
    for (const d of topo.dirsAt(r, c)) {
      if (!isOpen(puzzle, r + d.dr, c + d.dc)) continue;
      const kind = d.kind, er = r + d.kr, ec = c + d.kc;
      const { x1, y1, x2, y2 } = topoEdgeEnds(topo, kind, er, ec);
      const len = Math.hypot(x2 - x1, y2 - y1);
      const ux = (x2 - x1) / len, uy = (y2 - y1) / len;
      const along = (x - x1) * ux + (y - y1) * uy, across = Math.abs(-(x - x1) * uy + (y - y1) * ux);
      if (across <= half && along >= inset && along <= len - inset) return [kind, er, ec];
    }
    return null;
  }

  // Index of the open cell at a point, or -1.
  _cellAt(x, y) {
    const { rows, cols } = this.puzzle;
    const [r, c] = this.topo.cellAt(x, y);
    return isOpen(this.puzzle, r, c) && r < rows && c < cols ? r * cols + c : -1;
  }

  _setHover(key) {
    if (key === this._hoverKey) return;
    if (this._hoverKey) this.segs.get(this._hoverKey)?.classList.remove('hover');
    this._hoverKey = key;
    if (key) this.segs.get(key)?.classList.add('hover');
    if (key && this.segs.get(key)?.classList.contains('given')) this.segs.get(key).classList.remove('hover');   // can't be changed
  }

  // Show (or hide, for -1) the hover highlight over an open cell.
  _setCellHover(cell) {
    if (!this.cellHoverEl) return;
    if (cell < 0) { this.cellHoverEl.setAttribute('visibility', 'hidden'); return; }
    const { cols } = this.puzzle;
    this.cellHoverEl.setAttribute('points', pointsOf(this.topo.polygon(Math.floor(cell / cols), cell % cols)));
    this.cellHoverEl.setAttribute('visibility', 'visible');
  }

  _bindPointer(svg) {
    let mode = null;          // 'edge' | 'cell' while a gesture is in progress
    let last = null;          // last pointer position (cell units)
    let lastCell = -1;
    let tap = null;           // an edge press waiting for its release: { edge, from: [x, y], moved, cell }

    svg.addEventListener('pointerdown', e => {
      if (e.button !== 0 || mode) return;
      this._setCellHover(-1);                      // the drag preview takes over
      const [x, y] = this._point(e);
      const edge = this._edgeAt(x, y);
      if (edge) {
        mode = 'edge';
        // applied on release, if it really was a tap; `cell` is the open cell the press landed in (the edge
        // band is thin, so the pointer is inside one of the two cells beside the edge): where a drag starts
        tap = { edge, from: [x, y], moved: 0, cell: this._cellAt(x, y) };
      } else {
        const cell = this._cellAt(x, y);
        if (cell < 0) return;
        mode = 'cell';
        lastCell = cell;
        this.cb.onCellPress(cell);
      }
      last = [x, y];
      e.preventDefault();
      try { svg.setPointerCapture(e.pointerId); } catch { /* not an active pointer */ }
    });

    svg.addEventListener('pointermove', e => {
      const [x, y] = this._point(e);
      if (!mode) {
        const edge = this._edgeAt(x, y);
        this._setHover(edge ? edge.join(':') : null);
        const cell = edge ? -1 : this._cellAt(x, y);
        this._setCellHover(cell);
        svg.style.cursor = edge ? 'pointer' : cell >= 0 ? 'cell' : '';
        return;
      }
      if (mode === 'edge') {
        tap.moved = Math.max(tap.moved, Math.hypot(x - tap.from[0], y - tap.from[1]));
        if (tap.moved < this.topo.tapSlop || tap.cell < 0) return;
        // it is a drag, not a tap: carry on as a cell drag that started where the press landed
        mode = 'cell';
        lastCell = tap.cell;
        last = tap.from;
        tap = null;
        this._setHover(null);
        this.cb.onCellPress(lastCell);
      }
      // Sample along the segment from the last position, so a fast drag
      // can't skip over cells.
      const steps = Math.max(1, Math.ceil(Math.hypot(x - last[0], y - last[1]) / 0.1));
      for (let i = 1; i <= steps; i++) {
        const px = last[0] + (x - last[0]) * i / steps, py = last[1] + (y - last[1]) * i / steps;
        const cell = this._cellAt(px, py);
        if (cell >= 0 && cell !== lastCell) { lastCell = cell; this.cb.onCellEnter(cell); }
      }
      last = [x, y];
    });

    const finish = cancelled => e => {
      if (!mode) return;
      const wasEdge = mode === 'edge';
      mode = null;
      try { svg.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      if (wasEdge) {
        const t = tap;
        tap = null;
        if (!cancelled && t.moved < this.topo.tapSlop) this.cb.onEdgePress(...t.edge);
        return;
      }
      if (cancelled) this.cb.onCancel(); else this.cb.onRelease();
    };
    svg.addEventListener('pointerup', finish(false));
    svg.addEventListener('pointercancel', finish(true));
    svg.addEventListener('pointerleave', () => { if (!mode) { this._setHover(null); this._setCellHover(-1); } });

    // Right-click toggles a cross on the edge under the pointer.
    svg.addEventListener('contextmenu', e => {
      e.preventDefault();
      const edge = this._edgeAt(...this._point(e));
      if (edge) this.cb.onEdgeContext(...edge);
    });
  }

  // Preview of a cell-drag: the cells dragged over so far, in green when they
  // already form the tile (releasing now will draw its outline).
  // `shape` is which allowed shape the dragged cells form (index into the puzzle's shapes), or -1 if
  // they don't form one yet; the preview then takes that shape's color (--shape-N-drag).
  setDrag(cells, shape = -1) {
    this.cellEls.forEach((rect, i) => {
      const on = cells.includes(i);
      rect.classList.toggle('drag', on && shape < 0);
      rect.classList.toggle('drag-ok', on && shape >= 0);
      for (let n = 0; n < SHAPE_COLORS; n++) rect.classList.toggle(`drag-shape-${n}`, on && shape === n);
    });
  }

  setAllEdges(edges) {
    for (const key of this.segs.keys()) {
      const [kind, r, c] = key.split(':');
      this.setEdge(kind, +r, +c, getEdge(this.puzzle, edges, kind, +r, +c));
    }
  }

  setEdge(kind, r, c, state) {
    const key = `${kind}:${r}:${c}`;
    const seg = this.segs.get(key);
    if (!seg) return;
    const given = isGivenEdge(this.puzzle, kind, r, c);                   // pre-drawn by the puzzle: drawn in its own colour
    seg.classList.toggle('given', given);
    this.xs.get(key).classList.toggle('given', given);
    seg.classList.toggle('on', state === EDGE_LINE);
    seg.classList.toggle('cross', state === EDGE_CROSS); // suppress hover ghost under an X
    this.xs.get(key).setAttribute('visibility', state === EDGE_CROSS ? 'visible' : 'hidden');
  }

  // Highlight wrong marks ([{kind, r, c, state}] from logic.checkMarks).
  showErrors(wrong) {
    this.clearHint();
    for (const { kind, r, c, state } of wrong) {
      const key = `${kind}:${r}:${c}`;
      (state === EDGE_LINE ? this.segs : this.xs).get(key)?.classList.add('bad');
    }
  }

  // Show a hint without touching the board's marks. All parts are optional:
  //   target  cell indices the hint is about (yellow)
  //   tile    cell indices of a tile to place (blue)
  //   lines   edges [[kind, r, c], ...] to draw, shown as dashed ghost lines
  //   crosses edges [[kind, r, c], ...] that can take a cross, shown as ghost ✕ marks
  //   marker  one cell index to label with a "!" badge (a cell the text refers to)
  showHint({ target = [], tile = [], lines = [], crosses = [], unknown = [], marker = null }) {
    this.clearHint();
    const mark = (cells, cls) => cells.forEach(i => this.cellEls[i].classList.add(cls));
    mark(tile, 'hint-tile');
    mark(target, 'hint-target');
    for (const [kind, r, c] of lines) {
      const { x1, y1, x2, y2 } = topoEdgeEnds(this.topo, kind, r, c);
      el('line', { class: 'hint-line', x1, y1, x2, y2 }, this.hintLayer);
    }
    for (const [kind, r, c] of crosses) {
      const { x1, y1, x2, y2 } = topoEdgeEnds(this.topo, kind, r, c);
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, d = 0.15;
      const g = el('g', { class: 'hint-x' }, this.hintLayer);
      el('line', { x1: mx - d, y1: my - d, x2: mx + d, y2: my + d }, g);
      el('line', { x1: mx - d, y1: my + d, x2: mx + d, y2: my - d }, g);
    }
    for (const [kind, r, c] of unknown) {                 // an edge to look at: a neutral "?", not yet a line or a ✕
      const { x1, y1, x2, y2 } = topoEdgeEnds(this.topo, kind, r, c);
      const g = el('g', { class: 'hint-unknown' }, this.hintLayer);
      el('circle', { cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, r: 0.22 }, g);
      const t = el('text', { x: (x1 + x2) / 2, y: (y1 + y2) / 2, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': 0.34 }, g);
      t.textContent = '?';
    }
    if (marker !== null) {
      const { cols } = this.puzzle;
      const [cx, cy] = this.topo.center(Math.floor(marker / cols), marker % cols);
      const g = el('g', { class: 'hint-marker' }, this.hintLayer);
      el('circle', { cx, cy, r: 0.26 }, g);
      const t = el('text', {
        x: cx, y: cy, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': 0.4,
      }, g);
      t.textContent = '!';
    }
  }

  // Remove hint highlights and error marks.
  clearHint() {
    if (!this.svg) return;
    this.svg.querySelectorAll('.bad').forEach(n => n.classList.remove('bad'));
    for (const cls of ['hint-target', 'hint-tile']) {
      this.svg.querySelectorAll(`.${cls}`).forEach(n => n.classList.remove(cls));
    }
    this.hintLayer.textContent = '';
  }

  // analysis: result of logic.analyze(). When showTiles is on, enclosed regions
  // are tinted blue (valid tile) or red (wrong shape / too small to ever be one).
  update(analysis, showTiles) {
    const valid = new Map(), wrong = new Set();           // valid: cell -> which allowed shape it is part of
    if (showTiles) {
      for (const reg of analysis.regions) {
        if (reg.valid) reg.cells.forEach(i => valid.set(i, reg.shape));
        else if (reg.wrong) reg.cells.forEach(i => wrong.add(i));
      }
    }
    // Red is the only tint that scolds, and a line that closes a wrong shape may just be the
    // first click of a double-click (line -> x), so newly red cells wait BAD_DELAY_MS before
    // showing; any further change to the board cancels the wait. Clearing red is immediate.
    clearTimeout(this._badTimer);
    const newlyBad = [];
    this.cellEls.forEach((rect, i) => {
      rect.classList.toggle('tile-ok', valid.has(i));
      for (let n = 0; n < SHAPE_COLORS; n++) rect.classList.toggle(`shape-${n}`, valid.get(i) === n);   // each shape has its own color
      if (!wrong.has(i)) rect.classList.remove('tile-bad');
      else if (!rect.classList.contains('tile-bad')) newlyBad.push(rect);
    });
    if (newlyBad.length) {
      this._badTimer = setTimeout(() => newlyBad.forEach(rect => rect.classList.add('tile-bad')), BAD_DELAY_MS);
    }
    this.svg.classList.toggle('solved', analysis.solved);
  }
}
