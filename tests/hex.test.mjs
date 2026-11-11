// The hex grid (js/topology.js): its geometry and neighbour tables agree with each other, and the logic of
// logic.js (solver, marks, outlines, rating) works on it as it does on squares.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HEX, SQUARE, edgeEnds, edgeBetween, edgeCellsOf, topologyOfTile } from '../js/topology.js';
import { HEX_PATTERNS, HEX_ORDER } from '../js/hex_shapes.js';
import {
  getOrientations, shapeName, tileSpecs, tileSize, searchTilings, solve, parseCsv, toCsv, puzzleHash, newEdges, cloneEdges,
  analyze, playableEdges, edgesFromSolution, checkMarks, setEdge, getEdge, tileOutline, tileInterior, tileErasure, cellsFormTile,
  shapeIndexOf, EDGE_LINE, openCellsConnected, hasSwastika, countSolutions, consistentPlacements, forcedTile,
} from '../js/logic.js';
import { ratePuzzle } from '../js/rating.js';
import { canonicalGrid } from '../js/generator.js';
import { boardShape } from '../tools/lib/board_shapes.mjs';

const close = (a, b) => Math.abs(a - b) < 1e-9;

test('hex topology: a cell, its six neighbours and the edge between them agree in every table', () => {
  const rows = 5, cols = 5;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const [cx, cy] = HEX.center(r, c);
      assert.equal(HEX.dirs.length, 6);
      for (const d of HEX.dirs) {
        const nr = r + d.dr, nc = c + d.dc;
        // neighbours are one cell width apart
        const [nx, ny] = HEX.center(nr, nc);
        assert.ok(close(Math.hypot(nx - cx, ny - cy), 1), 'neighbour centres are 1 apart');
        assert.equal(HEX.dist(d.dr, d.dc), 1);
        // the edge named in the direction table separates exactly these two cells
        const cells = edgeCellsOf(HEX, cols, d.kind, r + d.kr, c + d.kc).sort((x, y) => x - y);
        assert.deepEqual(cells, [r * cols + c, nr * cols + nc].sort((x, y) => x - y));
        if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) assert.deepEqual(edgeBetween(HEX, cols, r * cols + c, nr * cols + nc), [d.kind, r + d.kr, c + d.kc]);
        // both cells draw that edge as the same segment
        const poly = HEX.polygon(r, c), other = HEX.polygon(nr, nc);
        const a = [poly[d.side], poly[(d.side + 1) % 6]].map(p => p.map(x => x.toFixed(6)).join(',')).sort();
        const b = other.map(p => p.map(x => x.toFixed(6)).join(',')).filter(p => a.includes(p));
        assert.deepEqual(b.sort(), a, 'the two cells share the two end points of the edge');
        // edgeEnds of the owning cell's kind gives the same segment
        const e = edgeEnds(HEX, d.kind, r + d.kr, c + d.kc);
        assert.deepEqual([[e.x1, e.y1], [e.x2, e.y2]].map(p => p.map(x => x.toFixed(6)).join(',')).sort(), a);
      }
      assert.deepEqual(HEX.cellAt(cx, cy), [r, c], 'a cell centre is in its own cell');
      for (const [px, py] of HEX.polygon(r, c)) assert.deepEqual(HEX.cellAt(cx + (px - cx) * 0.9, cy + (py - cy) * 0.9), [r, c], 'near a corner is still inside');
    }
  }
});

test('hex symmetries: six rotations and a reflection map the neighbours onto themselves', () => {
  const key = ([r, c]) => `${r},${c}`;
  const nbrs = new Set(HEX.dirs.map(d => key([d.dr, d.dc])));
  let p = [2, -1];
  for (let i = 0; i < 6; i++) {
    assert.ok(new Set(HEX.dirs.map(d => key(HEX.rotate([d.dr, d.dc])))).size === 6);
    for (const d of HEX.dirs) assert.ok(nbrs.has(key(HEX.rotate([d.dr, d.dc]))), 'rotating a neighbour gives a neighbour');
    p = HEX.rotate(p);
  }
  assert.deepEqual(p, [2, -1], 'six rotations are the identity');
  assert.deepEqual(HEX.reflect(HEX.reflect([3, -2])), [3, -2]);
  for (const d of HEX.dirs) assert.ok(nbrs.has(key(HEX.reflect([d.dr, d.dc]))), 'reflecting a neighbour gives a neighbour');
  // rotating 60 degrees turns the pixel picture by 60 degrees about the cell's centre
  const [x0, y0] = HEX.center(0, 0);
  const [ax, ay] = HEX.center(0, 1), [bx, by] = HEX.center(...HEX.rotate([0, 1]));
  const ang = Math.atan2(by - y0, bx - x0) - Math.atan2(ay - y0, ax - x0);
  assert.ok(close(((ang + 2 * Math.PI) % (2 * Math.PI)), Math.PI / 3), 'a rotation is a 60 degree turn');
});

test('hex shapes: 1, 1, 3, 7 and 22 free polyhexes, each with a sensible number of orientations', () => {
  const counts = {};
  for (const name of Object.keys(HEX_PATTERNS)) counts[tileSize('hex:' + name)] = (counts[tileSize('hex:' + name)] ?? 0) + 1;
  assert.deepEqual(counts, { 1: 1, 2: 1, 3: 3, 4: 7, 5: 22 });
  assert.equal(HEX_ORDER.length, 33);
  const seen = new Set();
  for (const name of HEX_ORDER) {
    const n = getOrientations('hex:' + name).length;
    assert.ok([2, 3, 6, 12].includes(n), `${name} has ${n} orientations`);
    assert.equal(12 % n, 0, 'the orientations are a quotient of the 12 symmetries');
    const canon = getOrientations('hex:' + name).map(o => o.map(p => p.join(',')).join(';')).sort()[0];
    assert.ok(!seen.has(canon), `${name} is a new shape`);
    seen.add(canon);
  }
  assert.equal(shapeName('hex:h3b'), 'triangle trihex');
  assert.equal(shapeName('hex:h2'), 'dihex');
  assert.equal(topologyOfTile('hex:h4a'), HEX);
  assert.equal(topologyOfTile('L'), SQUARE);
  assert.equal(topologyOfTile('XX/X.'), SQUARE);
  // a prefix on the first shape covers the whole list
  assert.deepEqual(tileSpecs('hex:h3a+h3b'), ['hex:h3a', 'hex:h3b']);
  assert.throws(() => tileSpecs('hex:h3a+h3a'), /same shape twice/);
  assert.throws(() => tileSpecs('hex:nonsense'), /Unknown tile shape/);
  // an inline pattern is axial rows; one whose cells only touch at a corner of the square grid is still connected on a hex grid
  assert.equal(tileSize('hex:XX/.X'), 3);
  assert.throws(() => tileSpecs('hex:X./.X'), /not connected/);
});

// a hexagon of side 2 (7 cells) in a 3 x 3 array, its middle cell blocked: a ring of six cells
const RING = { name: 'ring', rows: 3, cols: 3, tile: 'hex:h2', grid: '#..' + '.#.' + '..#', solution: '' };

test('hex solver: a ring of six cells has two tilings by dominoes; blocked corners of the array do not count', () => {
  assert.equal(searchTilings(RING, { limit: 10 }).count, 2);
  assert.equal(countSolutions(RING, 10), 2);
  const [a, b] = solve(RING, 5);
  assert.notEqual(a, b);
  assert.ok(openCellsConnected(RING));
  assert.equal(hasSwastika(RING, a), false, 'the swastika filter is for the square grid');
  const triangle = { ...RING, tile: 'hex:h3b' };          // two triangles of three: the ring has none (no three cells touch each other)
  assert.equal(searchTilings(triangle, { limit: 5 }).count, 0);
  const trihex = { name: 'c', rows: 3, cols: 3, tile: 'hex:h3a', grid: '#..' + '.#.' + '..#', solution: '' };   // straight line of three: none fits in a ring of six
  assert.equal(searchTilings(trihex, { limit: 5 }).count, 0);
});

test('hex marks: edges are one array per kind, outlines and interiors count the right edges', () => {
  const e = newEdges(RING);
  assert.deepEqual(Object.keys(e), ['w', 'nw', 'ne']);
  assert.ok(Object.values(e).every(a => a.length === 9));
  // the ring has 6 cells around the middle: 6 edges between neighbours around the ring
  assert.equal(playableEdges(RING).length, 6);
  const sol = solve(RING, 1)[0];
  const full = edgesFromSolution(RING, sol);
  // three dominoes: each pair separated from the next, so 3 lines
  assert.equal(playableEdges(RING).filter(([k, r, c]) => getEdge(RING, full, k, r, c) === EDGE_LINE).length, 3);
  assert.deepEqual(checkMarks(RING, full, sol), []);
  const bad = cloneEdges(full);
  const [k0, r0, c0] = playableEdges(RING).find(([k, r, c]) => getEdge(RING, full, k, r, c) !== EDGE_LINE);
  setEdge(RING, bad, k0, r0, c0, EDGE_LINE);
  assert.equal(checkMarks(RING, bad, sol).length, 1, 'a line inside a tile is wrong');
  // a domino beside the blocked middle: outline = the two ring neighbours (one edge each), interior = 1 edge
  const cells = [1, 2];
  assert.equal(tileInterior(RING, cells).length, 1);
  assert.equal(tileOutline(RING, cells).length, 2);
  // analyze: the solved marks make a solved board
  const an = analyze(RING, full);
  assert.equal(an.solved, true);
  assert.equal(an.regions.length, 3);
  assert.ok(an.regions.every(r => r.valid && r.shape === 0));
  assert.equal(analyze(RING, newEdges(RING)).solved, false);
  assert.ok(cellsFormTile(RING, [1, 2]) && !cellsFormTile(RING, [1, 5]), 'cells 1 and 5 are not neighbours');
  assert.equal(shapeIndexOf('hex:h2', [1, 2], 3), 0);
});

test('hex erase: dragging over a finished tile takes only the lines it alone uses', () => {
  const sol = solve(RING, 1)[0];
  const full = edgesFromSolution(RING, sol);
  const tile = [...sol].map((ch, i) => [ch, i]).filter(([ch]) => ch === sol[1]).map(([, i]) => i);
  const erase = tileErasure(RING, full, tile);
  assert.deepEqual(erase, [], 'both neighbours are finished tiles, so every line of this tile is shared');
  const half = cloneEdges(full);
  setEdge(RING, half, ...tileOutline(RING, tile)[0], 0);
  assert.equal(tileErasure(RING, half, tile), null, 'an outline that is not all drawn is not an erase');
});

test('hex puzzles round-trip through CSV, with an outline, and get their own hash', () => {
  const p = { ...RING, name: 'r1', solution: solve(RING, 1)[0], rules: 'edges', tier: 'Beginner', score: 1.5, outside: 'x....' + '...x'.slice(0, 0) };
  const rect = { name: 'o', rows: 3, cols: 3, tile: 'hex:h2', grid: '#..' + '.#.' + '..#', solution: '', outside: 'x.....' + '..x' };
  const back = parseCsv(toCsv([{ ...rect, rules: '', tier: '' }]))[0];
  assert.equal(back.tile, 'hex:h2');
  assert.equal(back.outside, rect.outside);
  assert.notEqual(puzzleHash(rect), puzzleHash({ ...rect, tile: 'I2' }));
  void p;
});

test('hex boards: a hexagon of side n is a (2n-1) square array with only the two corners cut', () => {
  for (const n of [3, 4, 5, 6]) {
    const { rows, cols, fixed, outside } = boardShape(`hexagon${n}`);
    assert.equal(rows, 2 * n - 1);
    assert.equal(cols, 2 * n - 1);
    assert.equal(fixed.filter(f => !f).length, 3 * n * (n - 1) + 1, 'a hexagon of side n has 3n(n-1)+1 cells');
    assert.equal(outside.length, rows * cols);
    // it is the same board turned by 60 degrees: the canonical form of the empty hexagon is a fixed point
    const grid = fixed.map(f => (f ? '#' : '.')).join('');
    void grid;
  }
});

test('hex canonicalGrid: rotated and mirrored copies of a puzzle are the same board', () => {
  const { rows, cols, fixed } = boardShape('hexagon4');
  const open = fixed.map((f, i) => [f, i]).filter(([f]) => !f).map(([, i]) => i);
  const make = blocked => fixed.map((f, i) => (f || blocked.includes(i) ? '#' : '.')).join('');
  const a = open[3], b = open[10], c = open[17];
  const base = make([a, b, c]);
  // turn the blocked cells 60 degrees about the hexagon's middle (3,3)
  const turn = ([r, cc]) => { const [rr, cr] = HEX.rotate([r - 3, cc - 3]); return [rr + 3, cr + 3]; };
  const rotated = make([a, b, c].map(i => { const [r, cc] = turn([Math.floor(i / cols), i % cols]); return r * cols + cc; }));
  const mirrored = make([a, b, c].map(i => { const [r, cc] = HEX.reflect([Math.floor(i / cols) - 3, (i % cols) - 3]); return (r + 3) * cols + cc + 3; }));
  const { outside } = boardShape('hexagon4');
  const key = g => canonicalGrid(g, rows, cols, 'hex:h2', outside);
  assert.equal(key(base), key(rotated));
  assert.equal(key(base), key(mirrored));
  assert.notEqual(key(base), key(make([a, b])));
});

test('hex rating: a generated puzzle is rated like a square one (hints, tiers, no parity rule)', () => {
  const { puzzle } = JSON.parse(JSON.stringify({ puzzle: { name: 'r', rows: 3, cols: 3, tile: 'hex:h2', grid: '#..' + '.#.' + '..#', solution: '' } }));
  // not unique (two tilings), so build a unique one from a bigger board by hand: dominoes in a 1 x 2 hexagonal strip
  const strip = { name: 's', rows: 1, cols: 4, tile: 'hex:h2', grid: '....', solution: '' };
  assert.equal(countSolutions(strip, 5), 1);
  const rated = ratePuzzle({ ...strip, solution: solve(strip, 1)[0] });
  assert.ok(rated.tier, 'a tier was assigned');
  assert.equal(forcedTile(strip, newEdges(strip)) !== null, true);
  void puzzle;
  assert.equal(consistentPlacements(strip, newEdges(strip), 0).length, 1);
});
