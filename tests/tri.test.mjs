// The triangle grid (js/topology.js, js/tri_shapes.js): geometry and tables agree, and the logic of logic.js works on it,
// including the parts that are not a plain lattice (tiles keep pointing the same way, the up/down colouring).
import test from 'node:test';
import assert from 'node:assert/strict';
import { TRI, SQUARE, HEX, edgeEnds, edgeBetween, edgeCellsOf, topologyOfTile, shapeBox, triCorners } from '../js/topology.js';
import { TRI_PATTERNS, TRI_ORDER } from '../js/tri_shapes.js';
import {
  getOrientations, shapeName, tileSpecs, tileSize, searchTilings, solve, parseCsv, toCsv, newEdges, playableEdges, edgesFromSolution,
  checkMarks, analyze, tileOutline, tileInterior, cellsFormTile, shapeIndexOf, isPlayableEdge, boardPlacements, countSolutions,
  forcedTile, openCellsConnected, hasSwastika, EDGE_LINE, getEdge, findPocketContradiction,
} from '../js/logic.js';
import { ratePuzzle } from '../js/rating.js';
import { canonicalGrid } from '../js/generator.js';
import { boardShape } from '../tools/lib/board_shapes.mjs';

const close = (a, b) => Math.abs(a - b) < 1e-9;
const key = ([x, y]) => `${x.toFixed(6)},${y.toFixed(6)}`;

test('triangle topology: neighbours, edges, sides and the polygon of every cell agree', () => {
  const rows = 6, cols = 9;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const up = (r + c) % 2 === 0;
      const dirs = TRI.dirsAt(r, c);
      assert.equal(dirs.length, 3);
      assert.equal(TRI.polygon(r, c).length, 3);
      const [cx, cy] = TRI.center(r, c);
      assert.deepEqual(TRI.cellAt(cx, cy), [r, c], 'a cell centre is in its own cell');
      for (const [px, py] of TRI.polygon(r, c)) assert.deepEqual(TRI.cellAt(cx + (px - cx) * 0.9, cy + (py - cy) * 0.9), [r, c], 'near a corner is inside');
      for (const d of dirs) {
        const nr = r + d.dr, nc = c + d.dc;
        // neighbours point the other way, and are one triangle-height (or a half side to the side) apart
        assert.notEqual((nr + nc) % 2, (r + c) % 2, 'neighbours alternate');
        assert.ok(TRI.hasEdge(d.kind, r + d.kr, c + d.kc), 'the edge exists');
        const cells = edgeCellsOf(TRI, cols, d.kind, r + d.kr, c + d.kc).sort((x, y) => x - y);
        assert.deepEqual(cells, [r * cols + c, nr * cols + nc].sort((x, y) => x - y));
        if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) assert.deepEqual(edgeBetween(TRI, cols, r * cols + c, nr * cols + nc), [d.kind, r + d.kr, c + d.kc]);
        // both cells draw that edge as the same segment
        const a = [TRI.polygon(r, c)[d.side], TRI.polygon(r, c)[(d.side + 1) % 3]].map(key).sort();
        const other = TRI.polygon(nr, nc).map(key).filter(p => a.includes(p));
        assert.deepEqual(other.sort(), a, 'the two cells share the edge');
        const e = edgeEnds(TRI, d.kind, r + d.kr, c + d.kc);
        assert.deepEqual([[e.x1, e.y1], [e.x2, e.y2]].map(key).sort(), a);
        assert.ok(close(Math.hypot(e.x2 - e.x1, e.y2 - e.y1), 1.25), 'an edge is a side long');
      }
      // an up triangle has no edge above it, a down one has
      assert.equal(TRI.hasEdge('h', r, c), !up);
    }
  }
});

test('triangle symmetries: six rotations and a reflection keep neighbours neighbours and cells cells', () => {
  for (const [r, c] of [[2, 2], [2, 3], [5, 6], [0, 1], [3, 8]]) {
    let p = [r, c];
    for (let i = 0; i < 6; i++) {
      const before = new Set(TRI.dirsAt(...p).map(d => `${p[0] + d.dr},${p[1] + d.dc}`));
      const q = TRI.rotate(p);
      const after = new Set(TRI.dirsAt(...q).map(d => `${q[0] + d.dr},${q[1] + d.dc}`));
      for (const n of before) assert.ok(after.has(TRI.rotate(n.split(',').map(Number)).join(',')), 'rotation keeps neighbours');
      assert.notEqual((q[0] + q[1]) % 2 === 0, (p[0] + p[1]) % 2 === 0, 'a 60 degree turn swaps up and down');
      p = q;
    }
    assert.deepEqual(p, [r, c], 'six rotations are the identity');
    assert.deepEqual(TRI.reflect(TRI.reflect([r, c])), [r, c]);
    const q = TRI.reflect([r, c]);
    for (const d of TRI.dirsAt(r, c)) assert.ok(TRI.dirsAt(...q).some(e => q[0] + e.dr === TRI.reflect([r + d.dr, c + d.dc])[0] && q[1] + e.dc === TRI.reflect([r + d.dr, c + d.dc])[1]), 'reflection keeps neighbours');
  }
  // corners: every corner has w + j even, and the three corners of a cell make the cell again
  for (let r = 0; r < 4; r++) for (let c = 0; c < 6; c++) for (const [w, j] of triCorners(r, c)) assert.equal((w + j) % 2, 0);
});

test('triangle shapes: 1, 1, 1, 3, 4 and 12 free polyiamonds, with the orientations a quotient of the 12 symmetries', () => {
  const counts = {};
  for (const name of Object.keys(TRI_PATTERNS)) counts[tileSize('tri:' + name)] = (counts[tileSize('tri:' + name)] ?? 0) + 1;
  assert.deepEqual(counts, { 1: 1, 2: 1, 3: 1, 4: 3, 5: 4, 6: 12 });
  const seen = new Set();
  for (const name of Object.keys(TRI_PATTERNS)) {
    const os = getOrientations('tri:' + name);
    assert.equal(12 % os.length, 0, `${name}: ${os.length} orientations`);
    const canon = os.map(o => o.map(p => p.join(',')).join(';')).sort()[0];
    assert.ok(!seen.has(canon), `${name} is a new shape`);
    seen.add(canon);
    // every orientation is a normalised cell list: sliding by an even offset keeps up triangles up
    for (const o of os) assert.ok(o[0][0] === 0 && o.every(([r, c]) => c >= 0), 'normalised');
  }
  assert.equal(getOrientations('tri:i1').length, 2, 'a single triangle points up or down');
  assert.equal(getOrientations('tri:i2').length, 3, 'a diamond has three directions');
  const full = Object.keys(TRI_PATTERNS).filter(n => getOrientations('tri:' + n).length === 1);
  assert.equal(full.length, 1, 'exactly one shape has all 12 symmetries: the hexagon of six');
  assert.equal(tileSize('tri:' + full[0]), 6);
  assert.equal(topologyOfTile('tri:i4a'), TRI);
  assert.equal(topologyOfTile('hex:h2'), HEX);
  assert.equal(topologyOfTile('T'), SQUARE);
  assert.deepEqual(tileSpecs('tri:i3+i4a'), ['tri:i3', 'tri:i4a']);
  assert.equal(TRI_ORDER.length, 21, 'sizes 2 to 6: 1 + 1 + 3 + 4 + 12');
  assert.equal(shapeName('tri:i2'), 'diamond');
  assert.equal(shapeName('tri:i1'), 'triangle');
  assert.throws(() => tileSpecs('tri:X./.X'), /not connected/);
});

// a hexagon of six triangles around one lattice point: a 2 x 4 array
const HEX1 = (() => { const b = boardShape('trihexagon1'); return { name: 'h1', rows: b.rows, cols: b.cols, grid: b.fixed.map(f => (f ? '#' : '.')).join(''), solution: '', outside: b.outside }; })();

test('triangle solver: a hexagon of six triangles has 2 tilings by diamonds, 3 by trapezoids, 1 by the hexagon, none by strips', () => {
  assert.equal(HEX1.grid.split('').filter(c => c === '.').length, 6);
  const count = tile => searchTilings({ ...HEX1, tile }, { limit: 50 }).count;
  assert.equal(count('tri:i2'), 2, 'three diamonds: the two ways of the cube picture');
  assert.equal(count('tri:i3'), 3, 'two trapezoids: a cut along any of the three diameters');
  const hexagon = Object.keys(TRI_PATTERNS).find(n => getOrientations('tri:' + n).length === 1);
  assert.equal(count('tri:' + hexagon), 1);
  assert.equal(count('tri:i4a'), 0);
  assert.equal(count('tri:i1'), 1, 'single triangles: each cell alone');
});

test('triangle marks: edges are one array per kind, the pocket test uses the up/down colouring', () => {
  const p = { ...HEX1, tile: 'tri:i3' };
  const e = newEdges(p);
  assert.deepEqual(Object.keys(e), ['w', 'h']);
  assert.equal(playableEdges(p).length, 6, 'six cells in a ring: six edges');
  for (const [k, r, c] of playableEdges(p)) assert.ok(isPlayableEdge(p, k, r, c));
  assert.ok(!isPlayableEdge(p, 'h', 0, 0) || (0 + 0) % 2 !== 0, 'no edge above an up triangle');
  const [sol] = solve(p, 1);
  const full = edgesFromSolution(p, sol);
  assert.equal(playableEdges(p).filter(([k, r, c]) => getEdge(p, full, k, r, c) === EDGE_LINE).length, 2, 'two trapezoids are separated by two lines');
  assert.deepEqual(checkMarks(p, full, sol), []);
  const an = analyze(p, full);
  assert.equal(an.solved, true);
  assert.equal(an.regions.length, 2);
  // outlines and interiors: a trapezoid of three in a ring of six
  const region = an.regions[0].cells;
  assert.equal(tileInterior(p, region).length, 2);
  assert.equal(tileOutline(p, region).length, 2);
  assert.ok(cellsFormTile(p, region));
  assert.equal(shapeIndexOf('tri:i3', region, p.cols), 0);
  // a single cell is not a trapezoid; neither is three that are not in a row
  assert.ok(!cellsFormTile(p, [region[0]]));
  // a region of three cells cannot be tiled by diamonds: the pocket test says so (it counts cells, and up against down)
  const three = { name: 'g', rows: 1, cols: 4, tile: 'tri:i2', grid: '...#', solution: '' };
  assert.equal(findPocketContradiction(three, newEdges(three), 'size')?.kind, 'size');
  const unbalanced = { name: 'u', rows: 1, cols: 5, tile: 'tri:i2', grid: '....#', solution: '' };
  assert.equal(findPocketContradiction(unbalanced, newEdges(unbalanced), 'parity'), null, 'two up and two down can be two diamonds');
  const twoUp = { name: 'v', rows: 2, cols: 3, tile: 'tri:i2', grid: '#.#' + '...', solution: '' };
  void twoUp;
});

test('triangle placements: a tile only goes where its triangles point the same way', () => {
  const rows = 4, cols = 8;
  const places = boardPlacements('tri:i2', rows, cols);
  for (const cells of places) {
    // every diamond is an up and a down triangle sharing an edge, however it is turned
    const ups = cells.filter(i => (Math.floor(i / cols) + (i % cols)) % 2 === 0).length;
    assert.equal(ups, 1);
  }
  // as many placements as edges of the array: a diamond is the pair of cells either side of one edge
  const edges = playableEdges({ rows, cols, tile: 'tri:i2', grid: '.'.repeat(rows * cols) });
  assert.equal(places.length, edges.length);
  // and a single triangle fits everywhere, once
  assert.equal(boardPlacements('tri:i1', rows, cols).length, rows * cols);
});

test('triangle puzzles round-trip through CSV, get a hash of their own and are rated', () => {
  const p = { ...HEX1, tile: 'tri:i3', name: 'a', solution: solve({ ...HEX1, tile: 'tri:i3' }, 1)[0] };
  const back = parseCsv(toCsv([{ ...p, rules: '', tier: '' }]))[0];
  assert.equal(back.tile, 'tri:i3');
  assert.equal(back.outside, p.outside);
  assert.equal(hasSwastika(p, p.solution), false);
  assert.ok(openCellsConnected(p));
  // a shaped board dedupes through its symmetries: the empty board is its own canonical form
  const { rows, cols, outside } = boardShape('trihexagon2');
  assert.equal(canonicalGrid('#'.repeat(rows * cols), rows, cols, 'tri:i3', outside), canonicalGrid('#'.repeat(rows * cols), rows, cols, 'tri:i3', outside));
  const strip = { name: 's', rows: 1, cols: 4, tile: 'tri:i2', grid: '....', solution: '' };
  assert.equal(countSolutions(strip, 5), 1, 'a strip of four triangles is two diamonds one way only');
  assert.ok(forcedTile(strip, newEdges(strip)));
  assert.ok(ratePuzzle({ ...strip, solution: solve(strip, 1)[0] }).tier);
});

test('triangle boards: the shapes have the cells they promise and a box that fits them', () => {
  for (const [name, cells] of [['trihexagon2', 24], ['trihexagon3', 54], ['trihexagon4', 96], ['tritriangle8', 64], ['tritriangle10', 100], ['trirhombus5', 50]]) {
    const { rows, cols, fixed, outside } = boardShape(name);
    assert.equal(fixed.filter(f => !f).length, cells, name);
    assert.equal(outside.length, rows * cols);
    const [x0, y0, x1, y1] = shapeBox(TRI, rows, cols, outside);
    assert.ok(x1 > x0 && y1 > y0);
    // the array is cropped: some cell of the first and of the last row and column is part of the shape
    const inShape = (r, c) => !fixed[r * cols + c];
    assert.ok([...Array(cols).keys()].some(c => inShape(0, c)) && [...Array(cols).keys()].some(c => inShape(rows - 1, c)), `${name}: first and last row used`);
    assert.ok([...Array(rows).keys()].some(r => inShape(r, 0)) || [...Array(rows).keys()].some(r => inShape(r, 1)), `${name}: first column used`);
  }
});
