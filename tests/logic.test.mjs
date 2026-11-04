// Run with: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  getOrientations, resolveShape, tileSize, parseCsv, solve, searchTilings, countSolutions,
  analyze, edgesFromSolution, setEdge, getEdge, isPlayableEdge, EDGE_EMPTY, EDGE_LINE, EDGE_CROSS,
  checkMarks, crossHints, getSolution, playableEdges, puzzleHash, labelString,
  consistentPlacements, forcedTile, lookaheadTile, shapeName, SHAPES, newEdges, edgeCells,
  cellsFormTile, tileOutline, tileInterior, allForcedTiles, allLookaheadTiles, findPocketContradiction,
  edgeDeduction, allEdgeDeductions, chainTile, allChainTiles, LOOKAHEAD_PARITY, findContradiction,
  EDGES_NARROW, EDGES_WIDE, hasSwastika,
} from '../js/logic.js';
import {
  generatePuzzle, mulberry32, canonicalGrid, defaultHoles, stateFromPuzzle, puzzleFromState, neighborState,
} from '../js/generator.js';
import { referenceSearch } from './reference_solver.mjs';
import { ratePuzzle, compareRatings, sortByRules, TIERS, RULES, RULE_IDS, tierOfRule } from '../js/rating.js';
import { LOOKAHEAD_2, LOOKAHEAD_3 } from '../js/logic.js';

const data = name => parseCsv(readFileSync(new URL(`../data/${name}`, import.meta.url), 'utf8'));

test('orientation counts', () => {
  assert.equal(getOrientations('L').length, 8);
  assert.equal(getOrientations('I').length, 2);
  assert.equal(getOrientations('O').length, 1);
  assert.equal(getOrientations('T').length, 4);
  assert.equal(getOrientations('S').length, 4);
});

test('inline patterns', () => {
  // The pattern for L matches the named L.
  assert.deepEqual(getOrientations('X./X./XX'), getOrientations('L'));
  assert.equal(tileSize('XX/XX/X.'), 5);        // P pentomino
  assert.equal(getOrientations('XX/XX/X.').length, 8);
  assert.equal(getOrientations('.X./XXX/.X.').length, 1); // X pentomino
  assert.throws(() => resolveShape('X.X'), /not connected/);
  assert.throws(() => resolveShape('banana'), /Unknown tile/);
});

test('parseCsv validates', () => {
  assert.throws(() => parseCsv('a,b\n1,2'), /header/);
  assert.throws(() => parseCsv('name,rows,cols,grid\np,2,2,...'), /grid has 3/);
  assert.throws(() => parseCsv('name,rows,cols,tile,grid\np,2,2,Q?,....'), /Unknown tile/);
  const [p] = parseCsv('# c\nname,rows,cols,grid\np,2,2,#...\n');
  assert.equal(p.tile, 'L');
});

test('shipped puzzles each have exactly one solution', () => {
  for (const file of ['L_6x6.csv', 'P5_8x8.csv']) {
    for (const p of data(file)) {
      assert.equal(solve(p, 2).length, 1, p.name);
      assert.equal(solve(p, 2)[0], p.solution, p.name);
    }
  }
});

test('countSolutions agrees with solve; budget aborts', () => {
  const p = { rows: 4, cols: 6, tile: 'L', grid: '.'.repeat(24), solution: '' };
  const all = solve(p, 1000);
  assert.ok(all.length > 1);
  assert.equal(countSolutions(p, 1000), all.length);
  assert.equal(countSolutions(p, 3), 3);                    // capped
  assert.equal(searchTilings(p, { limit: 1000, budget: 3 }).aborted, true);
});

test('randomized search still returns valid tilings', () => {
  const p = { rows: 6, cols: 6, tile: 'L', grid: '#'.repeat(4) + '.'.repeat(32), solution: '' };
  const rng = mulberry32(5);
  const r = searchTilings(p, { limit: 1, rng });
  // 4 blocked cells in the first row: remaining 32 cells tile iff found
  assert.ok(r.count === 0 || r.tilings[0].filter(v => v >= 0).length === 32);
});

test('analyze: solved when every region is an L, not otherwise', () => {
  const p = data('L_6x6.csv')[0];
  const edges = edgesFromSolution(p, p.solution);
  assert.equal(analyze(p, edges).solved, true);
  assert.equal(analyze(p, edges).validCount, analyze(p, edges).total);

  // Remove one solution line: two tiles merge, no longer solved.
  const broken = { h: edges.h.slice(), v: edges.v.slice() };
  outer: for (const kind of ['h', 'v']) {
    for (let r = 0; r <= p.rows; r++) for (let c = 0; c <= p.cols; c++) {
      if (!isPlayableEdge(p, kind, r, c)) continue;
      if (getEdge(p, broken, kind, r, c) === EDGE_LINE) {
        setEdge(p, broken, kind, r, c, EDGE_EMPTY); break outer;
      }
    }
  }
  assert.equal(analyze(p, broken).solved, false);

  // A single extra line splits a tile into wrong-sized pieces.
  const extra = edgesFromSolution(p, p.solution);
  let done = false;
  for (const kind of ['h', 'v']) {
    for (let r = 0; r <= p.rows && !done; r++) for (let c = 0; c <= p.cols && !done; c++) {
      if (isPlayableEdge(p, kind, r, c) && getEdge(p, extra, kind, r, c) === EDGE_EMPTY) {
        setEdge(p, extra, kind, r, c, EDGE_LINE); done = true;
      }
    }
  }
  const a = analyze(p, extra);
  assert.equal(a.solved, false);
  assert.ok(a.regions.some(reg => reg.wrong));
});

test('canonicalGrid ignores rotations and reflections', () => {
  const g = '#...' + '....' + '..#.' + '....';
  const rot = [];
  for (let c = 0; c < 4; c++) for (let r = 3; r >= 0; r--) rot.push(g[r * 4 + c]); // rotate 90
  assert.equal(canonicalGrid(rot.join(''), 4, 4), canonicalGrid(g, 4, 4));
});

test('defaultHoles leaves a tileable number of cells', () => {
  for (const [r, c, t] of [[6, 6, 'L'], [8, 8, 'L'], [10, 10, 'L'], [7, 7, 'L'], [6, 5, 'XX/XX/X.']]) {
    const k = defaultHoles(r, c, t);
    assert.equal((r * c - k) % tileSize(t), 0);
  }
});

test('generator: unique solution for several shapes, reproducible by seed', () => {
  const cases = [
    { rows: 6, cols: 6, tile: 'L' },
    { rows: 6, cols: 6, tile: 'T' },
    { rows: 8, cols: 8, tile: 'S' },
    { rows: 6, cols: 5, tile: 'XX/XX/X.' },     // P pentomino
    { rows: 7, cols: 7, tile: 'XXX/X../X..' },  // V pentomino
  ];
  for (const cfg of cases) {
    const res = generatePuzzle({ ...cfg, rng: mulberry32(7), maxMs: 20000 });
    assert.ok(res, `timed out: ${JSON.stringify(cfg)}`);
    const p = res.puzzle;
    assert.equal(solve(p, 2).length, 1, JSON.stringify(cfg));
    assert.equal(solve(p, 2)[0], p.solution);
    // same seed -> same puzzle
    const again = generatePuzzle({ ...cfg, rng: mulberry32(7), maxMs: 20000 });
    assert.equal(again.puzzle.grid, p.grid);
  }
});

test('generator rejects impossible hole counts', () => {
  assert.throws(() => generatePuzzle({ rows: 6, cols: 6, tile: 'L', holes: 3 }), /can't be tiled/);
});

test('checkMarks / crossHints / getSolution', () => {
  const p = data('L_6x6.csv')[0];
  const sol = getSolution(p);
  assert.equal(sol, p.solution);
  const { solution, ...noSol } = p;
  assert.equal(getSolution({ ...noSol, solution: '' }), sol);   // computed when missing

  const expected = edgesFromSolution(p, sol);
  const edges = edgesFromSolution(p, sol);
  assert.deepEqual(checkMarks(p, edges, sol), []);               // perfect board

  // Pick one edge with a solution line and one without.
  const all = playableEdges(p);
  const lineEdge = all.find(([k, r, c]) => getEdge(p, expected, k, r, c) === EDGE_LINE);
  const gapEdge = all.find(([k, r, c]) => getEdge(p, expected, k, r, c) !== EDGE_LINE);

  // Correct crosses and a subset of lines are fine ("correct so far").
  const partial = { h: new Uint8Array(edges.h.length), v: new Uint8Array(edges.v.length) };
  setEdge(p, partial, ...gapEdge, EDGE_CROSS);
  setEdge(p, partial, ...lineEdge, EDGE_LINE);
  assert.deepEqual(checkMarks(p, partial, sol), []);

  // Wrong line where the solution has none; wrong cross where it has a line.
  const bad = { h: partial.h.slice(), v: partial.v.slice() };
  const otherGap = all.filter(([k, r, c]) => getEdge(p, expected, k, r, c) !== EDGE_LINE)[1];
  const otherLine = all.filter(([k, r, c]) => getEdge(p, expected, k, r, c) === EDGE_LINE)[1];
  setEdge(p, bad, ...otherGap, EDGE_LINE);
  setEdge(p, bad, ...otherLine, EDGE_CROSS);
  const wrong = checkMarks(p, bad, sol);
  assert.equal(wrong.length, 2);
  assert.deepEqual(wrong.map(w => w.state).sort(), [EDGE_LINE, EDGE_CROSS]);

  // Hints: only edges without a solution line that the player hasn't marked.
  const hints = crossHints(p, partial, sol);
  assert.ok(hints.length > 0);
  for (const [k, r, c] of hints) {
    assert.notEqual(getEdge(p, expected, k, r, c), EDGE_LINE);
    assert.equal(getEdge(p, partial, k, r, c), EDGE_EMPTY);
  }
  assert.ok(!hints.some(([k, r, c]) => k === gapEdge[0] && r === gapEdge[1] && c === gapEdge[2]));
  // A puzzle with no unique solution has none to give.
  assert.equal(getSolution({ rows: 4, cols: 6, tile: 'L', grid: '.'.repeat(24), solution: '' }), null);
});

test('puzzleHash depends on content only, and is stable', () => {
  const base = { tile: 'L', rows: 4, cols: 4, grid: '..##....#....#..' };
  const h = puzzleHash(base);
  assert.match(h, /^[0-9a-f]{16}$/);
  assert.equal(puzzleHash({ ...base, name: 'renamed', solution: 'x' }), h);   // name/solution ignored
  assert.notEqual(puzzleHash({ ...base, grid: '..#.....#....#..' }), h);      // grid matters
  assert.notEqual(puzzleHash({ ...base, tile: 'T' }), h);                      // tile matters
  assert.notEqual(puzzleHash({ ...base, rows: 2, cols: 8 }), h);               // shape matters
  // Pinned: changing the hash function would orphan every saved game.
  assert.equal(h, '87494036ec1a832e');
  // All shipped puzzles hash uniquely.
  const all = ['L_6x6.csv', 'L_8x8.csv', 'L_10x10.csv'].flatMap(f => data(f));
  assert.equal(new Set(all.map(puzzleHash)).size, all.length);
});

test('DLX search agrees with the reference backtracker', () => {
  const rng = mulberry32(99);
  const shapes = ['L', 'T', 'S', 'O', 'I', 'XX/XX/X.', '.XX/XX./.X.', 'XXX/X../X..'];
  let checked = 0, solvable = 0, many = 0;
  for (const tile of shapes) {
    const size = tileSize(tile);
    for (let trial = 0; trial < 120; trial++) {
      const rows = 3 + Math.floor(rng() * 5), cols = 3 + Math.floor(rng() * 5);
      // random grid with few blocked cells, then block more so the open count divides by the tile size
      const cells = [...'.'.repeat(rows * cols)];
      for (let i = 0; i < cells.length; i++) if (rng() < 0.08) cells[i] = '#';
      let open = cells.filter(ch => ch === '.').length;
      for (let i = cells.length - 1; open % size !== 0 && i >= 0; i--) if (cells[i] === '.') { cells[i] = '#'; open--; }
      const puzzle = { rows, cols, tile, grid: cells.join(''), solution: '' };
      for (const limit of [1, 2, 50]) {
        const ref = referenceSearch(puzzle, { limit });
        const dlx = searchTilings(puzzle, { limit, keep: false });
        assert.equal(dlx.count, ref.count, `${tile} ${rows}x${cols} ${puzzle.grid} limit ${limit}`);
        checked++;
        if (ref.count > 0) solvable++;
        if (ref.count > 1) many++;
      }
    }
  }
  assert.ok(checked > 2500 && solvable > 200 && many > 80,
    `weak coverage: ${checked} checks, ${solvable} solvable, ${many} with several tilings`);
});

test('DLX tilings are genuine tilings (plain and randomized)', () => {
  const unique = data('L_6x6.csv')[0];
  const loose = { rows: 4, cols: 6, tile: 'L', grid: '.'.repeat(24), solution: '' };  // many tilings
  for (const probe of [unique, loose]) {
    for (const rng of [null, mulberry32(3), mulberry32(4)]) {
      const res = searchTilings(probe, { limit: 5, rng });
      assert.ok(res.count > 0);
      for (const t of res.tilings) {
        const a = analyze(probe, edgesFromSolution(probe, labelString(t)));
        assert.equal(a.solved, true);
        assert.equal(a.validCount, a.total);
      }
    }
  }
  // Different seeds give different first tilings on a board with many.
  const first = seed => labelString(searchTilings(loose, { limit: 1, rng: mulberry32(seed) }).tilings[0]);
  assert.ok(new Set([1, 2, 3, 4, 5, 6, 7, 8].map(first)).size > 1);
});

test('forcedTile is sound: repeated forced hints never contradict the solution', () => {
  let puzzles = 0, steps = 0, solvedByHintsAlone = 0;
  for (const file of ['L_6x6.csv', 'L_8x8.csv', 'L_10x10.csv']) {
    for (const p of data(file)) {
      puzzles++;
      const sol = getSolution(p);
      const edges = { h: new Uint8Array((p.rows + 1) * p.cols), v: new Uint8Array(p.rows * (p.cols + 1)) };
      for (let guard = 0; guard < 500; guard++) {
        const f = forcedTile(p, edges);
        if (!f) break;
        for (const [k, r, c] of f.lines) setEdge(p, edges, k, r, c, EDGE_LINE);
        steps++;
        assert.deepEqual(checkMarks(p, edges, sol), [], `${p.name} step ${guard}`);
      }
      if (analyze(p, edges).solved) solvedByHintsAlone++;
    }
  }
  assert.ok(steps > 20, `only ${steps} forced steps over ${puzzles} puzzles`);
  console.log(`# forced-tile hints: ${steps} steps over ${puzzles} puzzles, ${solvedByHintsAlone} solved by them alone`);
});

test('consistentPlacements respects lines and crosses', () => {
  // 4x4 board, all open: the corner cell (0,0) can be covered by several L placements.
  const p = { rows: 4, cols: 4, tile: 'L', grid: '.'.repeat(16), solution: '' };
  const empty = () => ({ h: new Uint8Array(5 * 4), v: new Uint8Array(4 * 5) });
  const e = empty();
  const base = consistentPlacements(p, e, 0);
  assert.ok(base.length >= 3);
  // Pick one placement; a line cutting through it removes it.
  const target = base[0];
  const [a, b] = target.cells;           // two cells of the placement that are orthogonal neighbours
  const nbr = target.cells.find(x => x !== a && (Math.abs(x - a) === 1 && Math.floor(x / 4) === Math.floor(a / 4) || Math.abs(x - a) === 4));
  const [ar, ac] = [Math.floor(a / 4), a % 4], [nr, nc] = [Math.floor(nbr / 4), nbr % 4];
  const inner = ar === nr ? ['v', ar, Math.max(ac, nc)] : ['h', Math.max(ar, nr), ac];
  setEdge(p, e, ...inner, EDGE_LINE);
  const afterLine = consistentPlacements(p, e, 0);
  assert.ok(afterLine.length < base.length);
  assert.ok(!afterLine.some(x => x.cells.join() === target.cells.join()));
  // A cross on its outline removes it too.
  const e2 = empty();
  const [ok, or_, oc] = target.outline[0];
  setEdge(p, e2, ok, or_, oc, EDGE_CROSS);
  assert.ok(!consistentPlacements(p, e2, 0).some(x => x.cells.join() === target.cells.join()));
  // Outline edges are exactly the edges between the tile and open neighbours.
  for (const [k, r, c] of target.outline) assert.ok(isPlayableEdge(p, k, r, c));
});

test('named shapes: sizes, orientation counts and display names', () => {
  // Free orientations of the 12 pentominoes (a classic check that the patterns are right).
  const pent = { F5: 8, I5: 2, L5: 8, N5: 8, P5: 8, T5: 4, U5: 4, V5: 4, W5: 4, X5: 1, Y5: 8, Z5: 4 };
  for (const [name, n] of Object.entries(pent)) {
    assert.equal(tileSize(name), 5, name);
    assert.equal(getOrientations(name).length, n, name);
    assert.equal(shapeName(name), `${name[0]} pentomino`);
  }
  assert.equal(new Set(Object.keys(pent).map(n => shapeName(n))).size, 12);
  assert.equal(tileSize('I2'), 2); assert.equal(getOrientations('I2').length, 2);
  assert.equal(tileSize('I3'), 3); assert.equal(getOrientations('V3').length, 4);
  assert.equal(shapeName('I2'), 'domino');
  assert.equal(shapeName('V3'), 'V tromino');
  // Any rotation/reflection/pattern spelling of a library shape gets its name.
  assert.equal(shapeName('XX/X./X.'), 'L tetromino');
  assert.equal(shapeName('XX/XX/X.'), 'P pentomino');
  assert.equal(shapeName('.X/XX/XX'), 'P pentomino');
  assert.equal(shapeName('XXX/XXX'), '6-cell shape');
  assert.equal(shapeName('X'), 'monomino');
  for (const name of Object.keys(SHAPES)) assert.equal(getOrientations(name).length > 0, true);
});

test('lookaheadTile is sound, and goes beyond forcedTile', () => {
  let lookSteps = 0, forcedOnlySolved = 0, bothSolved = 0, puzzles = 0, sharedCount = 0;
  for (const file of ['L_6x6.csv', 'L_8x8.csv', 'L_10x10.csv']) {
    for (const p of data(file)) {
      puzzles++;
      const sol = getSolution(p);
      // forced only
      let e = newEdges(p);
      for (let g = 0; g < 500; g++) {
        const f = forcedTile(p, e);
        if (!f) break;
        for (const [k, r, c] of f.lines) setEdge(p, e, k, r, c, EDGE_LINE);
      }
      if (analyze(p, e).solved) forcedOnlySolved++;
      // forced, then lookahead when stuck
      e = newEdges(p);
      for (let g = 0; g < 500; g++) {
        let h = forcedTile(p, e), look = false;
        if (!h) { h = lookaheadTile(p, e); look = true; }
        if (!h) break;
        assert.ok(h.lines.length > 0);
        if (look) {
          lookSteps++;
          assert.ok(h.ruledOut >= 1);
          assert.equal(h.alternatives.length, h.ruledOut);
          // each ruled-out alternative really fails, for the reason given
          for (const alt of h.alternatives) {
            const opt = consistentPlacements(p, e, h.cell).find(o => o.cells.join() === alt.cells.join());
            assert.ok(opt, 'alternative is a consistent placement of the cell');
            const trial = { h: e.h.slice(), v: e.v.slice() };
            for (const [k, r, c] of opt.outline) setEdge(p, trial, k, r, c, EDGE_LINE);
            assert.ok(alt.reason, 'a reason is recorded');
            if (alt.reason.kind === 'cell') assert.equal(consistentPlacements(p, trial, alt.reason.cells[0]).length, 0);
            else assert.equal(findPocketContradiction(p, trial, 'size')?.kind, 'size');
            for (const dead of alt.dead) {
              assert.equal(consistentPlacements(p, trial, dead).length, 0, 'dead cell has no placement');
            }
          }
          // a shared cell is stranded by every alternative
          for (const cell of h.sharedDead) {
            for (const alt of h.alternatives) assert.ok(alt.dead.includes(cell));
          }
          sharedCount += h.sharedDead.length > 0 ? 1 : 0;
        }
        for (const [k, r, c] of h.lines) setEdge(p, e, k, r, c, EDGE_LINE);
        assert.deepEqual(checkMarks(p, e, sol), [], `${p.name} step ${g}`);
      }
      if (analyze(p, e).solved) bothSolved++;
    }
  }
  assert.ok(lookSteps > 30, `only ${lookSteps} lookahead steps`);
  console.log(`# lookahead hints with a single shared stranded cell: ${sharedCount} of ${lookSteps}`);
  assert.ok(bothSolved > forcedOnlySolved + 5, `forced ${forcedOnlySolved} vs both ${bothSolved} of ${puzzles}`);
});

test('every set in the manifest loads, has unique solutions, and hints stay sound', () => {
  const manifest = JSON.parse(readFileSync(new URL('../data/manifest.json', import.meta.url), 'utf8'));
  assert.ok(manifest.books.length >= 4);
  assert.ok(manifest.books.some(b => `${b.tile}_${b.rows}x${b.cols}` === manifest.default), 'default book exists');
  const ids = new Set();
  for (const book of manifest.books) {
    const set = { ...book, id: `${book.tile}_${book.rows}x${book.cols}` };
    assert.ok(!ids.has(set.id), `duplicate book ${set.id}`); ids.add(set.id);
    assert.equal(set.file, `${set.id}.csv`);
    const puzzles = data(set.file);
    assert.ok(puzzles.every(q => q.tile === book.tile && q.rows === book.rows && q.cols === book.cols), `${set.id}: puzzles match the book`);
    assert.equal(puzzles.length, set.count, set.id);
    for (const p of puzzles) {
      const sols = solve(p, 2);
      assert.equal(sols.length, 1, `${set.id}/${p.name}`);
      assert.equal(sols[0], p.solution, `${set.id}/${p.name}`);
      // a few hint steps of each kind must never contradict the solution
      let e = newEdges(p);
      for (let g = 0; g < 6; g++) {
        const h = forcedTile(p, e) ?? lookaheadTile(p, e);
        if (!h) break;
        for (const [k, r, c] of h.lines) setEdge(p, e, k, r, c, EDGE_LINE);
        assert.deepEqual(checkMarks(p, e, p.solution), [], `${set.id}/${p.name}`);
      }
    }
  }
});

test('random-cross hints never land inside a closed shape', () => {
  const p = data('L_6x6.csv')[0];
  const sol = getSolution(p);
  const expected = edgesFromSolution(p, sol);
  // Fully solved board: every region is closed, so there is nothing useful to hint.
  assert.deepEqual(crossHints(p, expected, sol), []);

  // Draw only one tile's outline: no hint edge may lie between two cells of that tile.
  const e = newEdges(p);
  const first = [...p.grid].findIndex(ch => ch === '.');
  const mine = [...sol].map((ch, i) => (ch === sol[first] ? i : -1)).filter(i => i >= 0);
  for (const [k, r, c] of playableEdges(p)) {
    const cells = k === 'h' ? [(r - 1) * p.cols + c, r * p.cols + c] : [r * p.cols + c - 1, r * p.cols + c];
    const inMine = cells.map(i => mine.includes(i));
    if (inMine[0] !== inMine[1]) setEdge(p, e, k, r, c, EDGE_LINE);   // its outline only
  }
  assert.ok(analyze(p, e).regions.some(r => r.valid && r.cells.length === mine.length), 'tile is now closed');
  const hints = crossHints(p, e, sol);
  assert.ok(hints.length > 0);
  for (const [k, r, c] of hints) {
    const cells = k === 'h' ? [(r - 1) * p.cols + c, r * p.cols + c] : [r * p.cols + c - 1, r * p.cols + c];
    assert.ok(!(mine.includes(cells[0]) && mine.includes(cells[1])), `hint inside closed tile at ${k}${r},${c}`);
  }
});

test('placements account for every mark: lines inside, crosses on the outline; nothing else', () => {
  const p = { rows: 4, cols: 4, tile: 'L', grid: '.'.repeat(16), solution: '' };
  const fresh = () => newEdges(p);
  const base = consistentPlacements(p, fresh(), 5);                 // a central cell
  const target = base[0];
  const has = (edges, t = target) => consistentPlacements(p, edges, 5).some(x => x.cells.join() === t.cells.join());
  const inside = [], outline = target.outline;
  for (const [k, r, c] of playableEdges(p)) {
    const cells = k === 'h' ? [(r - 1) * 4 + c, r * 4 + c] : [r * 4 + c - 1, r * 4 + c];
    const n = cells.filter(i => target.cells.includes(i)).length;
    if (n === 2) inside.push([k, r, c]);
  }
  const far = playableEdges(p).filter(([k, r, c]) => {
    const cells = k === 'h' ? [(r - 1) * 4 + c, r * 4 + c] : [r * 4 + c - 1, r * 4 + c];
    return cells.every(i => !target.cells.includes(i)) &&
      !outline.some(([ok, or, oc]) => ok === k && or === r && oc === c);
  });
  assert.ok(inside.length === 3 && outline.length > 0 && far.length > 0);

  for (const edge of inside) {                                       // line inside: removes it
    const e = fresh(); setEdge(p, e, ...edge, EDGE_LINE); assert.equal(has(e), false);
  }
  for (const edge of inside) {                                       // cross inside: harmless
    const e = fresh(); setEdge(p, e, ...edge, EDGE_CROSS); assert.equal(has(e), true);
  }
  for (const edge of outline) {
    const e = fresh(); setEdge(p, e, ...edge, EDGE_CROSS); assert.equal(has(e), false);   // cross on outline: removes it
    const e2 = fresh(); setEdge(p, e2, ...edge, EDGE_LINE); assert.equal(has(e2), true);  // line on outline: fine
  }
  for (const edge of far) {                                          // marks elsewhere: irrelevant
    const e = fresh(); setEdge(p, e, ...edge, EDGE_LINE); assert.equal(has(e), true);
    const e2 = fresh(); setEdge(p, e2, ...edge, EDGE_CROSS); assert.equal(has(e2), true);
  }
});

test('ratePuzzle uses only the deduction rules and classifies correctly', () => {
  // books are sorted easiest first, so the first puzzle of the I-tromino book needs only forced steps
  const easy = ratePuzzle(data('I3_6x6.csv')[0]);
  assert.equal(easy.rules, 'forced');
  assert.equal(easy.tier, 'Beginner');
  const r = ratePuzzle(data('L_6x6.csv')[0]);
  assert.ok(RULE_IDS.includes(r.rules) || r.rules === 'unsolved');
  assert.ok(TIERS.includes(r.tier));
  assert.equal(r.tier, tierOfRule(r.rules));
  assert.ok(r.steps > 0);
  assert.equal(Object.values(r.counts).reduce((a, b) => a + b, 0), r.steps);
  if (r.rules === 'unsolved') assert.ok(r.remaining > 0); else assert.equal(r.remaining, 0);
  // the rule table: easiest first, tiers never decrease down the list
  const tierRank = id => TIERS.indexOf(RULES.find(x => x.id === id).tier);
  for (let i = 1; i < RULES.length; i++) assert.ok(tierRank(RULES[i].id) >= tierRank(RULES[i - 1].id));
  assert.equal(tierOfRule('unsolved'), 'Unsolved');
  const rt = (tier, o = {}) => ({ tier, remaining: 0, steps: 1, score: 1, ...o });
  // tier order whatever the scores
  for (let i = 1; i < TIERS.length; i++) assert.ok(compareRatings(rt(TIERS[i - 1], { score: 999 }), rt(TIERS[i], { score: 1 })) < 0);
  // within a tier: lower score first
  assert.ok(compareRatings(rt('Hard', { score: 12 }), rt('Hard', { score: 30 })) < 0);
  assert.ok(compareRatings(rt('Unsolved', { score: 520 }), rt('Unsolved', { score: 300 })) > 0);
});

test('sortByRules renumbers and sorts; every shipped book is sorted and its stored ratings are current', () => {
  const shuffled = [...data('L_6x6.csv')].reverse();
  const { puzzles, counts } = sortByRules(shuffled, 'zz');
  assert.equal(puzzles.length, shuffled.length);
  assert.deepEqual(puzzles.map(p => p.name.slice(0, 3)), puzzles.map(() => 'zz_'));
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), puzzles.length);
  const ratings = puzzles.map(ratePuzzle);
  for (let i = 1; i < ratings.length; i++) assert.ok(compareRatings(ratings[i - 1], ratings[i]) <= 0);

  const manifest = JSON.parse(readFileSync(new URL('../data/manifest.json', import.meta.url), 'utf8'));
  for (const book of manifest.books) {
    const ps = data(book.file);
    const rs = ps.map(ratePuzzle);
    for (let i = 0; i < ps.length; i++) {
      assert.equal(ps[i].rules, rs[i].rules, `${book.file} ${ps[i].name} rules column`);
      assert.equal(ps[i].tier, rs[i].tier, `${book.file} ${ps[i].name} tier column`);
      assert.equal(ps[i].score, rs[i].score, `${book.file} ${ps[i].name} score column`);
    }
    for (let i = 1; i < rs.length; i++) {
      // sorted by tier, then score (ties on both are broken by name, not by step count)
      const byTierScore = (a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) || a.score - b.score;
      assert.ok(byTierScore(rs[i - 1], rs[i]) <= 0, `${book.file} not sorted at ${i}`);
    }
  }
});

test('edgeCells returns the two cells an edge separates', () => {
  const p = { rows: 3, cols: 4, tile: 'L', grid: '.'.repeat(12), solution: '' };
  assert.deepEqual(edgeCells(p, 'h', 1, 2), [2, 6]);      // above (1,2): cells (0,2) and (1,2)
  assert.deepEqual(edgeCells(p, 'v', 2, 3), [10, 11]);    // left of (2,3): cells (2,2) and (2,3)
});

test('cellsFormTile accepts any orientation of the tile, nothing else', () => {
  const p = { rows: 6, cols: 6, tile: 'L', grid: '.'.repeat(36), solution: '' };
  const idx = (...rc) => rc.map(([r, c]) => r * 6 + c);
  // all 8 orientations of the L tetromino, placed at an offset, in scrambled order
  for (const o of getOrientations('L')) {
    const cells = idx(...o.map(([r, c]) => [r + 1, c + 2])).reverse();
    assert.equal(cellsFormTile(p, cells), true);
  }
  assert.equal(cellsFormTile(p, idx([0, 0], [0, 1], [1, 0], [1, 1])), false);       // O square
  assert.equal(cellsFormTile(p, idx([0, 0], [0, 1], [1, 1], [1, 2])), false);       // S
  assert.equal(cellsFormTile(p, idx([0, 0], [1, 0], [2, 0], [3, 0])), false);       // I
  assert.equal(cellsFormTile(p, idx([0, 0], [1, 0], [2, 0])), false);               // too few
  assert.equal(cellsFormTile(p, idx([0, 0], [1, 0], [2, 0], [2, 1], [3, 1])), false); // too many
  assert.equal(cellsFormTile(p, idx([0, 0], [1, 0], [2, 0], [2, 3])), false);       // disconnected
  assert.equal(cellsFormTile(p, [0, 0, 6, 12]), false);                             // repeated cell
  // other shapes
  const pent = { ...p, tile: 'P5' };
  assert.equal(cellsFormTile(pent, idx([2, 2], [2, 3], [3, 2], [3, 3], [4, 3])), true);
  assert.equal(cellsFormTile(pent, idx([2, 2], [2, 3], [3, 2], [3, 3], [4, 4])), false);
});

test('tileOutline: the edges around a tile, skipping walls; solutions decompose into outlines', () => {
  const p = { rows: 4, cols: 4, tile: 'L', grid: '.'.repeat(16), solution: '' };
  // L at (1,1),(2,1),(3,1),(3,2): perimeter edges inside the board
  const cells = [5, 9, 13, 14];
  const out = tileOutline(p, cells);
  assert.equal(new Set(out.map(e => e.join())).size, out.length);       // no duplicates
  for (const [k, r, c] of out) {
    assert.ok(isPlayableEdge(p, k, r, c));
    const [a, b] = edgeCells(p, k, r, c);
    assert.equal(cells.includes(a) !== cells.includes(b), true);        // exactly one side inside
  }
  // left side 3, top 1, right of the two upper cells 2, (3,2): top 1 and right 1
  assert.equal(out.length, 8);
  // Blocked neighbours and the border contribute nothing.
  const blocked = { ...p, grid: '..#.' + '.'.repeat(12) };
  const o2 = tileOutline(blocked, [0, 1, 4, 8]);
  for (const [k, r, c] of o2) assert.ok(isPlayableEdge(blocked, k, r, c));

  // For every shipped puzzle: each solution tile forms the tile, and the union of the
  // tile outlines is exactly the set of solution lines.
  for (const file of ['L_6x6.csv', 'L_8x8.csv', 'P5_8x8.csv', 'T_8x8.csv']) {
    for (const pz of data(file)) {
      const labels = new Map();
      [...pz.solution].forEach((ch, i) => { if (ch !== '#') labels.set(ch, [...(labels.get(ch) ?? []), i]); });
      const union = new Set();
      for (const cellsOfTile of labels.values()) {
        assert.equal(cellsFormTile(pz, cellsOfTile), true, `${pz.name}`);
        for (const e of tileOutline(pz, cellsOfTile)) union.add(e.join());
      }
      const expected = edgesFromSolution(pz, pz.solution);
      const want = new Set(playableEdges(pz).filter(([k, r, c]) => getEdge(pz, expected, k, r, c) === EDGE_LINE).map(e => e.join()));
      assert.deepEqual([...union].sort(), [...want].sort(), pz.name);
    }
  }
});

test('tileInterior: the edges between two cells of the tile; with the outline it covers every edge touching the tile', () => {
  const p = { rows: 4, cols: 4, tile: 'L', grid: '.'.repeat(16), solution: '' };
  const cells = [5, 9, 13, 14];                                         // L: (1,1) (2,1) (3,1) (3,2)
  const inner = tileInterior(p, cells);
  assert.equal(inner.length, 3);                                        // 5-9, 9-13, 13-14
  assert.equal(new Set(inner.map(e => e.join())).size, inner.length);  // each pair once
  for (const [k, r, c] of inner) {
    const [a, b] = edgeCells(p, k, r, c);
    assert.ok(cells.includes(a) && cells.includes(b));
  }
  // no overlap with the outline, and together they are every playable edge at a tile cell
  const outline = tileOutline(p, cells).map(e => e.join());
  assert.ok(inner.every(e => !outline.includes(e.join())));
  const touching = playableEdges(p).filter(([k, r, c]) => edgeCells(p, k, r, c).some(i => cells.includes(i)));
  assert.equal(inner.length + outline.length, touching.length);
  // a blocked neighbour (cell 5) never adds an interior edge
  const blocked = { ...p, grid: '.'.repeat(5) + '#' + '.'.repeat(10) };
  const inner2 = tileInterior(blocked, [0, 1, 4]);
  assert.equal(inner2.length, 2);                                       // 0-1 and 0-4 only
  assert.ok(inner2.every(([k, r, c]) => isPlayableEdge(blocked, k, r, c)));
});

test('allForcedTiles / allLookaheadTiles list every hint: distinct, independently sound, first matches the single-hint call', () => {
  let multiForced = 0, multiLook = 0;
  for (const file of ['L_6x6.csv', 'L_8x8.csv', 'P5_8x8.csv', 'T_8x8.csv']) {
    for (const p of data(file)) {
      const sol = getSolution(p);
      // Look at the board partway through solving, where several hints may be available.
      const e = newEdges(p);
      for (let g = 0; g < 3; g++) {
        const f = forcedTile(p, e) ?? lookaheadTile(p, e);
        if (!f) break;
        for (const [k, r, c] of f.lines) setEdge(p, e, k, r, c, EDGE_LINE);
      }
      for (const [all, first, isLook] of [
        [allForcedTiles(p, e), forcedTile(p, e), false],
        [allLookaheadTiles(p, e), lookaheadTile(p, e), true],
      ]) {
        assert.equal(all.length === 0, first === null);
        if (!first) continue;
        assert.deepEqual(all[0].cells, first.cells);
        assert.deepEqual(all[0].lines, first.lines);
        assert.equal(new Set(all.map(h => h.cells.join())).size, all.length, 'one hint per tile');
        for (const h of all) {
          const trial = { h: e.h.slice(), v: e.v.slice() };
          for (const [k, r, c] of h.lines) setEdge(p, trial, k, r, c, EDGE_LINE);
          assert.deepEqual(checkMarks(p, trial, sol), [], `${p.name}: a listed hint is wrong`);
          assert.ok(h.lines.length > 0);
        }
        if (all.length > 1) isLook ? multiLook++ : multiForced++;
      }
    }
  }
  assert.ok(multiForced > 5 && multiLook > 5, `cycling needs several hints at once: forced ${multiForced}, lookahead ${multiLook}`);
});

test('lookahead splits into a two-option and a three-or-more-option rule', () => {
  let two = 0, many = 0, unionCovers = true;
  for (const file of ['L_6x6.csv', 'L_8x8.csv', 'P5_8x8.csv', 'T_8x8.csv', 'S_8x8.csv']) {
    for (const p of data(file)) {
      const sol = getSolution(p);
      // a position partway through: apply forced / lookahead steps a few times
      const e = newEdges(p);
      for (let g = 0; g < 4; g++) {
        const f = forcedTile(p, e) ?? lookaheadTile(p, e);
        if (!f) break;
        for (const [k, r, c] of f.lines) setEdge(p, e, k, r, c, EDGE_LINE);
      }
      const a2 = allLookaheadTiles(p, e, LOOKAHEAD_2);
      const a3 = allLookaheadTiles(p, e, LOOKAHEAD_3);
      const all = allLookaheadTiles(p, e);
      for (const h of a2) {
        assert.equal(h.ruledOut, 1, 'two-option rule: exactly one failing alternative');
        assert.equal(consistentPlacements(p, e, h.cell).length, 2);
        two++;
      }
      for (const h of a3) {
        assert.ok(h.ruledOut >= 2, 'three-or-more rule: at least two failing alternatives');
        assert.ok(consistentPlacements(p, e, h.cell).length >= 3);
        many++;
      }
      // every hint of either kind is sound on its own
      for (const h of [...a2, ...a3]) {
        const trial = { h: e.h.slice(), v: e.v.slice() };
        for (const [k, r, c] of h.lines) setEdge(p, trial, k, r, c, EDGE_LINE);
        assert.deepEqual(checkMarks(p, trial, sol), [], `${p.name}: split lookahead hint is wrong`);
      }
      // nothing the unsplit search finds is lost by splitting
      const tiles = new Set([...a2, ...a3].map(h => h.cells.join()));
      for (const h of all) if (!tiles.has(h.cells.join())) unionCovers = false;
      // the first result of each kind matches the single-hint call
      assert.deepEqual(lookaheadTile(p, e, LOOKAHEAD_2)?.cells, a2[0]?.cells);
      assert.deepEqual(lookaheadTile(p, e, LOOKAHEAD_3)?.cells, a3[0]?.cells);
    }
  }
  assert.ok(unionCovers);
  assert.ok(two > 10 && many > 5, `weak coverage: ${two} two-option, ${many} three-or-more hints`);
});

test('ratings are consistent with the rules each puzzle actually needs', () => {
  const seen = new Set();
  for (const file of ['L_6x6.csv', 'L_8x8.csv', 'T_8x8.csv', 'V3_6x6.csv', 'W5_8x8.csv', 'I2_6x6.csv']) {
    for (const p of data(file)) {
      const r = ratePuzzle(p);
      seen.add(r.rules);
      const used = RULE_IDS.filter(id => r.counts[id] > 0);
      // the hardest rule recorded is the hardest rule actually used
      if (r.rules !== 'unsolved' && used.length) assert.equal(r.rules, used[used.length - 1]);
      if (r.rules === 'unsolved') assert.ok(r.remaining > 0); else assert.equal(r.remaining, 0);
      // score = weighted steps (+ penalty/tie-break only when stuck)
      const base = RULES.reduce((sum, x) => sum + r.counts[x.id] * x.weight, 0);
      if (r.rules !== 'unsolved') assert.equal(r.score, base);
      else assert.ok(r.score >= base + 40 * r.remaining);
    }
  }
  assert.ok(seen.has('forced') && seen.has('edges'), `rules seen: ${[...seen]}`);
});

test('pocket checks: size and chessboard parity contradictions', () => {
  // L tetromino on an empty 4x4: walling off 3 cells in a corner leaves a pocket of size 3
  const p = { rows: 4, cols: 4, tile: 'L', grid: '.'.repeat(16), solution: '' };
  const e = newEdges(p);
  assert.equal(findPocketContradiction(p, e, 'parity'), null);                // an open board is fine
  for (const [k, r, c] of [['h', 2, 0], ['v', 0, 2], ['h', 1, 1], ['v', 1, 1]]) setEdge(p, e, k, r, c, EDGE_LINE);
  const pocket = findPocketContradiction(p, e, 'size');
  assert.equal(pocket.kind, 'size');
  assert.deepEqual([...pocket.cells].sort((a, b) => a - b), [0, 1, 4]);
  // A 2x2 region has the right size for the T tetromino but the wrong chessboard balance
  const t = { rows: 4, cols: 4, tile: 'T', grid: '.'.repeat(16), solution: '' };
  const e2 = newEdges(t);
  for (const [k, r, c] of [['h', 2, 0], ['h', 2, 1], ['v', 0, 2], ['v', 1, 2]]) setEdge(t, e2, k, r, c, EDGE_LINE);
  assert.equal(findPocketContradiction(t, e2, 'size'), null);
  assert.equal(findPocketContradiction(t, e2, 'parity').kind, 'parity');
  // ...while the same 2x2 pocket is fine for the O tetromino
  const o = { ...t, tile: 'O' };
  assert.equal(findPocketContradiction(o, e2, 'parity'), null);
  // never a false alarm on the true solution (every region is a tile)
  for (const file of ['L_6x6.csv', 'T_8x8.csv', 'W5_8x8.csv', 'X5_10x10.csv']) {
    for (const q of data(file).slice(0, 10)) {
      assert.equal(findPocketContradiction(q, edgesFromSolution(q, q.solution), 'parity'), null, `${file} ${q.name}`);
    }
  }
  // findContradiction: a cell left without any placement
  const dead = { rows: 1, cols: 4, tile: 'I', grid: '....', solution: '' };
  assert.equal(findContradiction(dead, newEdges(dead), [0], 'cell'), null);
});

test('edge intersection: dead ends get a cross, shared boundaries get lines', () => {
  // I tromino in a 1x3 corridor... a corner cell with one open neighbour: the edge to it is inside every tile
  const p = { rows: 3, cols: 3, tile: 'I3', grid: '.........', solution: '' };
  const e = newEdges(p);
  const all = allEdgeDeductions(p, e);
  assert.ok(Array.isArray(all));
  // On the shipped books: applying every edge deduction available at the start never contradicts the solution,
  // adds only new marks, and each item is distinct.
  let items = 0;
  for (const file of ['L_6x6.csv', 'L_8x8.csv', 'P5_8x8.csv', 'T_10x10.csv']) {
    for (const q of data(file)) {
      const sol = getSolution(q);
      const e0 = newEdges(q);
      const found = allEdgeDeductions(q, e0);
      const keys = new Set(found.map(h => JSON.stringify([h.lines, h.crosses])));
      assert.equal(keys.size, found.length, 'one item per distinct set of edges');
      for (const h of found) {
        items++;
        assert.ok(h.options >= 2);
        assert.ok(h.lines.length + h.crosses.length > 0);
        const trial = newEdges(q);
        for (const [k, r, c] of h.lines) setEdge(q, trial, k, r, c, EDGE_LINE);
        for (const [k, r, c] of h.crosses) setEdge(q, trial, k, r, c, EDGE_CROSS);
        assert.deepEqual(checkMarks(q, trial, sol), [], `${file} ${q.name}: an edge deduction is wrong`);
      }
      assert.deepEqual(edgeDeduction(q, e0)?.lines, found[0]?.lines);
    }
  }
  assert.ok(items > 50, `only ${items} edge deductions seen`);
});

test('the whole rule ladder is sound on every published puzzle, and solves almost all of them', () => {
  const manifest = JSON.parse(readFileSync(new URL('../data/manifest.json', import.meta.url), 'utf8'));
  let puzzles = 0, solved = 0, chainSteps = 0, crossSteps = 0;
  for (const book of manifest.books) {
    for (const q of data(book.file).slice(0, 12)) {            // a spread of the book (easiest first, so also sample the end below)
      for (const pz of [q]) {
        puzzles++;
        const e = newEdges(pz);
        for (let guard = 0; guard < 500; guard++) {
          let found = null, which = null;
          for (const rule of RULES) { found = rule.find(pz, e); if (found) { which = rule.id; break; } }
          if (!found) break;
          for (const [k, r, c] of found.lines ?? []) setEdge(pz, e, k, r, c, EDGE_LINE);
          for (const [k, r, c] of found.crosses ?? []) { setEdge(pz, e, k, r, c, EDGE_CROSS); crossSteps++; }
          if (which === 'chain') chainSteps++;
          assert.deepEqual(checkMarks(pz, e, pz.solution), [], `${book.file} ${pz.name}: rule ${which} was wrong`);
        }
        if (analyze(pz, e).solved) solved++;
      }
    }
    // and the hard end of each book
    for (const pz of data(book.file).slice(-6)) {
      puzzles++;
      const e = newEdges(pz);
      for (let guard = 0; guard < 500; guard++) {
        let found = null, which = null;
        for (const rule of RULES) { found = rule.find(pz, e); if (found) { which = rule.id; break; } }
        if (!found) break;
        for (const [k, r, c] of found.lines ?? []) setEdge(pz, e, k, r, c, EDGE_LINE);
        for (const [k, r, c] of found.crosses ?? []) setEdge(pz, e, k, r, c, EDGE_CROSS);
        if (which === 'chain') chainSteps++;
        assert.deepEqual(checkMarks(pz, e, pz.solution), [], `${book.file} ${pz.name}: rule ${which} was wrong`);
      }
      if (analyze(pz, e).solved) solved++;
    }
  }
  assert.ok(solved / puzzles > 0.9, `only ${solved}/${puzzles} solved`);
  assert.ok(chainSteps > 0 && crossSteps > 0, `chain steps ${chainSteps}, cross steps ${crossSteps}`);
});

test('chains: all-but-one tiles fail after forced steps; first chain matches the single call', () => {
  let found = 0, deep = 0;
  for (const file of ['L_8x8.csv', 'L_10x10.csv', 'N5_8x8.csv', 'Y5_8x8.csv']) {
    for (const pz of data(file)) {
      const sol = getSolution(pz);
      // walk the ladder until only chains apply, then look at the chain hints
      const e = newEdges(pz);
      for (let guard = 0; guard < 500; guard++) {
        const f = RULES.slice(0, 4).map(r => r.find(pz, e)).find(Boolean);
        if (!f) break;
        for (const [k, r, c] of f.lines ?? []) setEdge(pz, e, k, r, c, EDGE_LINE);
        for (const [k, r, c] of f.crosses ?? []) setEdge(pz, e, k, r, c, EDGE_CROSS);
      }
      const chains = allChainTiles(pz, e);
      assert.equal(chains.length === 0, chainTile(pz, e) === null);
      if (chains.length) assert.deepEqual(chainTile(pz, e).cells, chains[0].cells);
      for (const h of chains) {
        found++;
        assert.ok(h.ruledOut >= 1 && h.alternatives.length === h.ruledOut);
        for (const alt of h.alternatives) assert.ok(alt.reason && ['cell', 'size', 'parity'].includes(alt.reason.kind));
        if (h.maxSteps > 0) deep++;
        const trial = { h: e.h.slice(), v: e.v.slice() };
        for (const [k, r, c] of h.lines) setEdge(pz, trial, k, r, c, EDGE_LINE);
        assert.deepEqual(checkMarks(pz, trial, sol), [], `${file} ${pz.name}: chain hint is wrong`);
      }
    }
  }
  assert.ok(found > 5, `only ${found} chain hints`);
  assert.ok(deep > 0, 'some chains need at least one forced step');
});

test('edge intersection splits cleanly into narrow (2-3 tiles) and wide (4+ tiles)', () => {
  let narrowItems = 0, wideItems = 0;
  for (const file of ['L_8x8.csv', 'N5_8x8.csv', 'V3_8x8.csv']) {
    for (const q of data(file).slice(0, 15)) {
      const e = newEdges(q);
      const all = allEdgeDeductions(q, e);
      const narrow = allEdgeDeductions(q, e, EDGES_NARROW);
      const wide = allEdgeDeductions(q, e, EDGES_WIDE);
      assert.ok(narrow.every(h => h.options >= 2 && h.options <= 3));
      assert.ok(wide.every(h => h.options >= 4));
      // together they cover everything (an item can differ only by which cell reported it first)
      const covered = new Set([...narrow, ...wide].map(h => JSON.stringify([h.lines, h.crosses])));
      assert.ok(all.every(h => covered.has(JSON.stringify([h.lines, h.crosses]))));
      narrowItems += narrow.length; wideItems += wide.length;
    }
  }
  assert.ok(narrowItems > 10 && wideItems > 10, `narrow ${narrowItems}, wide ${wideItems}`);
});

test('hunter building blocks: state round trip and neighbour moves', () => {
  const rng = mulberry32(11);
  let moves = 0, unique = 0;
  for (const file of ['L_6x6.csv', 'N5_8x8.csv', 'V3_8x8.csv', 'S_10x10.csv']) {
    for (const p of data(file).slice(0, 6)) {
      const st = stateFromPuzzle(p);
      // the state is exactly the stored puzzle + solution
      const back = puzzleFromState(st, p.rows, p.cols, p.tile);
      assert.equal(back.grid, p.grid);
      assert.equal(back.solution, p.solution);
      const holes = [...p.grid].filter(c => c === '#').length;
      for (let i = 0; i < 40; i++) {
        const nb = neighborState(st, p.rows, p.cols, p.tile, rng);
        if (!nb) continue;
        moves++;
        const q = puzzleFromState(nb, p.rows, p.cols, p.tile);
        // a move keeps the number of blocked cells and always yields a genuine tiling
        assert.equal([...q.grid].filter(c => c === '#').length, holes);
        const labels = new Map();
        [...q.solution].forEach((ch, idx) => { if (ch !== '#') labels.set(ch, [...(labels.get(ch) ?? []), idx]); });
        for (const cells of labels.values()) assert.equal(cellsFormTile(q, cells), true, `${file}: neighbour has a malformed tile`);
        assert.equal(labels.size * tileSize(p.tile), q.rows * q.cols - holes);
        // and when the neighbour is uniquely solvable, its stored solution IS the solution
        if (countSolutions(q, 2) === 1) { unique++; assert.equal(solve(q, 2)[0], q.solution); }
      }
    }
  }
  assert.ok(moves > 100 && unique > 5, `${moves} moves, ${unique} unique`);
});

test('swastika: the pinwheel pattern in a solution\'s drawn boundaries', () => {
  // four L tetrominoes tiling a 4x4 square as a windmill: the boundary lines form the pinwheel
  const A = [[0, 0], [1, 0], [2, 0], [2, 1]];
  const rot = cells => cells.map(([r, c]) => [c, 3 - r]);
  const B = rot(A), C = rot(B), D = rot(C);
  const grid = Array(16).fill('.');
  [['A', A], ['B', B], ['C', C], ['D', D]].forEach(([ch, cells]) => cells.forEach(([r, c]) => { grid[r * 4 + c] = ch; }));
  const p4 = { rows: 4, cols: 4, tile: 'L', grid: '.'.repeat(16), solution: '' };
  assert.equal(hasSwastika(p4, grid.join('')), true);

  // it is found in any rotation or mirror image, and anywhere on a bigger board
  const transform = fn => { const out = Array(16); for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) { const [rr, cc] = fn(r, c); out[rr * 4 + cc] = grid[r * 4 + c]; } return out.join(''); };
  for (const fn of [(r, c) => [c, 3 - r], (r, c) => [3 - r, 3 - c], (r, c) => [r, 3 - c], (r, c) => [c, r]]) {
    assert.equal(hasSwastika(p4, transform(fn)), true);
  }
  // embed the windmill at an offset in a 7x7 board (the rest is filled with 1x1-ish nonsense labels)
  const big = { rows: 7, cols: 7, tile: 'L', grid: '.'.repeat(49), solution: '' };
  const lab = Array.from({ length: 49 }, (_, i) => String.fromCharCode(97 + (i % 20)) + '');   // arbitrary labels
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) lab[(r + 2) * 7 + (c + 3)] = grid[r * 4 + c];
  assert.equal(hasSwastika(big, lab.join('')), true);

  // plain tilings and tiny boards are fine
  assert.equal(hasSwastika({ rows: 4, cols: 4, tile: 'I', grid: '.'.repeat(16), solution: '' }, 'AAAABBBBCCCCDDDD'), false);
  assert.equal(hasSwastika({ rows: 3, cols: 3, tile: 'L', grid: '.'.repeat(9), solution: '' }, 'ABCDEFGHI'), false);
});

test('the generator rejects swastika solutions by default (and finds them when allowed)', () => {
  let rejected = 0, allowed = 0, tries = 0;
  const r1 = mulberry32(21), r2 = mulberry32(21);
  for (let i = 0; i < 60; i++) {
    const a = generatePuzzle({ rows: 8, cols: 8, tile: 'T', holes: 8, rng: r1, maxMs: 5000 });
    const b = generatePuzzle({ rows: 8, cols: 8, tile: 'T', holes: 8, rng: r2, maxMs: 5000, allowSwastika: true });
    tries++;
    if (a && hasSwastika(a.puzzle, a.puzzle.solution)) rejected++;
    if (b && hasSwastika(b.puzzle, b.puzzle.solution)) allowed++;
  }
  assert.equal(rejected, 0, 'default generation must never return a swastika');
  assert.ok(allowed > 0, `with allowSwastika some of ${tries} T-tetromino puzzles should contain one`);
});

test('no published puzzle has a swastika in its solution', () => {
  const manifest = JSON.parse(readFileSync(new URL('../data/manifest.json', import.meta.url), 'utf8'));
  for (const book of manifest.books) {
    for (const p of data(book.file)) assert.equal(hasSwastika(p, p.solution), false, `${book.file} ${p.name}`);
  }
});

test('print: selection parsing and page planning', async () => {
  const { parseSelection, planPrint, MAX_PRINT } = await import('../js/print.js');
  assert.deepEqual(parseSelection('1-3, 7', 50).ids, [1, 2, 3, 7]);
  assert.deepEqual(parseSelection('5 3 3, 4-5', 50).ids, [3, 4, 5]);          // sorted, no repeats, spaces ok
  assert.deepEqual(parseSelection('50', 50).ids, [50]);
  assert.deepEqual(parseSelection('1 - 3 , 7 \u2013 8', 50).ids, [1, 2, 3, 7, 8]);   // spaces around dashes are fine
  for (const bad of ['', '  ', 'abc', '0', '51', '3-60', '9-4', '1-', '1--3']) {
    assert.ok(parseSelection(bad, 50).error, `"${bad}" should be rejected`);
  }
  assert.ok(parseSelection(`1-${MAX_PRINT + 1}`, 1000).error);
  assert.deepEqual(planPrint({ count: 10, perPage: 4, includeKey: true }), { puzzlePages: 3, keyPages: 2 });
  assert.deepEqual(planPrint({ count: 1, perPage: 1, includeKey: false }), { puzzlePages: 1, keyPages: 0 });
});
