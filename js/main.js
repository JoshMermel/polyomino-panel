// App controller: puzzle sets/selection, edge editing with undo/redo, solve
// detection and progress persistence.
import {
  EDGE_EMPTY, EDGE_LINE, EDGE_CROSS,
  parseCsv, newEdges, getEdge, setEdge, analyze, playableEdges, isGivenEdge,
  getSolution, checkMarks, crossHints, edgeCells, puzzleHash, tileErasure,
  cellsFormTile, givensRuleOutTile, tileOutline, tileInterior, tileSizes, tileSpecs, minTileSize, shapeName, shapeIndexOf, shapeOrder, topologyOf, } from './logic.js';
import { SQUARE, HEX, TRI } from './topology.js';
import { Board } from './board.js';
import { renderTileInfo, tileShapeSvg } from './tile-view.js';
import { RULES, TIERS, TIER_INFO, beyondHints, rankPeeks } from './rating.js';
import { parseSelection, planPrint, buildPrintRoot } from './print.js';

const $ = id => document.getElementById(id);

// --- localStorage (may be unavailable, e.g. private mode) -------------------
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

// Edges <-> string for storage: the digits of each edge kind, joined with "|" (square: "<h digits>|<v digits>").
const packEdges = e => Object.values(e).map(a => a.join('')).join('|');
function unpackEdges(puzzle, s) {
  const edges = newEdges(puzzle);
  const kinds = Object.keys(edges);
  const parts = (s || '').split('|');
  if (parts.length !== kinds.length || kinds.some((k, i) => !parts[i] || parts[i].length !== edges[k].length)) return null;
  kinds.forEach((k, i) => { for (let j = 0; j < parts[i].length; j++) edges[k][j] = +parts[i][j]; });
  for (const [type, kind, r, c] of puzzle.givens ?? []) setEdge(puzzle, edges, kind, r, c, type === 'L' ? EDGE_LINE : EDGE_CROSS);   // never lose a given
  return edges;
}

// --- State ------------------------------------------------------------------
const state = {
  sets: [],            // books: [{id, group, title, label, blurb, tier?, file?, count, custom?, puzzles|null}]
  groups: [],          // [{name, blurb}]: the picker's sections, in order
  setIdx: 0,
  puzIdx: 0,
  puzzle: null,
  edges: null,
  browseShapes: new Set(),   // Browse's shape filter: the shapes picked (a puzzle shows if it uses any of them); empty = all. Kept across books; shapes a book lacks are ignored
  hint: null,          // the hint on screen: { tier, rule, items, index, stage?, gains? } (see hint())
  lastEdit: null,      // cells beside the edges of the player's latest mark: hints nearest to them come first
  stepHints: store.get('pp_stepHints') !== '0',   // on unless turned off: Hint escalates (where to look, then the move)
  undo: [],            // each entry: {changes: [{kind,r,c,from,to}]}
  redo: [],
  showTiles: store.get('pp_showTiles') !== '0',
};

let board;

const curSet = () => state.sets[state.setIdx];
// Progress is stored per puzzle *content* (hash of tile + size + grid), not by
// set/name/position, so renumbering or reordering puzzles keeps saves intact.
const hashOf = puzzle => (puzzle._hash ??= puzzleHash(puzzle));
const saveKey = puzzle => `pp2_edges_${hashOf(puzzle)}`;
// "Solved" is remembered separately from the marks, so it survives Reset (as in star battle).
const solvedKey = puzzle => `pp2_solved_${hashOf(puzzle)}`;
const isSolved = puzzle => store.get(solvedKey(puzzle)) === '1';
const hasProgress = puzzle => store.get(saveKey(puzzle)) !== null;   // marks are only stored while some exist

// Remove saves from the old name-based format (pp_edges_*, pp_last).
function purgeLegacySaves() {
  try {
    const stale = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith('pp_edges_') || k === 'pp_last')) stale.push(k);
    }
    stale.forEach(k => localStorage.removeItem(k));
  } catch { /* ignore */ }
}

// Erase all saved puzzle progress (and the "resume here" position), keeping settings.
function clearSaves() {
  try {
    const doomed = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith('pp2_edges_') || k.startsWith('pp2_solved_') || k === 'pp2_last')) doomed.push(k);
    }
    doomed.forEach(k => localStorage.removeItem(k));
  } catch { /* ignore */ }
}

// --- Loading puzzle sets ----------------------------------------------------
async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  return res.text();
}

async function ensureLoaded(set) {
  if (!set.puzzles) set.puzzles = parseCsv(await fetchText(`data/${set.file}`));
  return set.puzzles;
}

async function init() {
  purgeLegacySaves();
  window.addEventListener('resize', syncColumnWidth);
  board = new Board($('board'), {
    onEdgePress, onCellPress, onCellEnter, onRelease, onCancel, onEdgeContext,
  });
  bindControls();

  try {
    const manifest = JSON.parse(await fetchText('data/manifest.json'));
    state.sets = manifest.books.map(b => ({ ...b, puzzles: null }));
    state.groups = manifest.groups ?? [];
    state.defaultSet = Math.max(0, state.sets.findIndex(s => s.id === manifest.default));
    await addScratchBook();
  } catch (err) {
    showFatal(err);
    return;
  }
  // Start where the URL says (?book=L_8x8&puzzle=6, like star battle), else resume at the
  // last puzzle, found by hash so renumbering doesn't matter.
  let setIdx = state.defaultSet ?? 0, puzIdx = 0;
  const params = new URLSearchParams(location.search);
  const bookIdx = state.sets.findIndex(s => s.id === params.get('book'));
  if (bookIdx >= 0) {
    await goTo(bookIdx, (parseInt(params.get('puzzle'), 10) || 1) - 1);
    return;
  }
  try {
    const last = JSON.parse(store.get('pp2_last') || 'null');
    const i = last ? state.sets.findIndex(s => s.id === last.set) : -1;
    if (i >= 0) {
      setIdx = i;
      const puzzles = await ensureLoaded(state.sets[i]);
      const j = puzzles.findIndex(p => hashOf(p) === last.hash);
      if (j >= 0) puzIdx = j;
    }
  } catch { /* ignore */ }
  await goTo(setIdx, puzIdx);
}

// On localhost only: data/tmp.csv (git-ignored; write it with toCsv) shows up as a "tmp" book, for looking
// at example puzzles. It is never fetched from the published site, and the service worker skips it.
const isLocalhost = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
async function addScratchBook() {
  if (!isLocalhost) return;
  try {
    const res = await fetch('data/tmp.csv', { cache: 'no-store' });
    if (!res.ok) return;
    const puzzles = parseCsv(await res.text());
    if (!puzzles.length) return;
    state.sets.push({
      id: 'tmp', group: 'Scratch', title: 'tmp', label: 'tmp (local scratch book)',
      blurb: 'Example puzzles from data/tmp.csv (local only, not committed).', file: 'tmp.csv', count: puzzles.length, puzzles,
    });
  } catch { /* no scratch book */ }
}

function showFatal(err) {
  console.error(err);
  $('status').className = 'status error';
  $('status').textContent =
    `Couldn't load puzzles (${err.message}). Serve this folder over http, e.g. "python3 -m http.server", ` +
    `rather than opening index.html directly.`;
}

// --- Navigation -------------------------------------------------------------
let navToken = 0;   // the latest goTo wins, whatever order their downloads finish in
async function goTo(setIdx, puzIdx) {
  const token = ++navToken;
  const set = state.sets[setIdx];
  let puzzles;
  try { puzzles = await ensureLoaded(set); } catch (err) { if (token === navToken) showFatal(err); return; }
  if (token !== navToken) return;
  if (!puzzles.length) { showFatal(new Error(`${set.title} has no puzzles`)); return; }
  puzIdx = Math.max(0, Math.min(puzzles.length - 1, puzIdx));

  state.setIdx = setIdx;
  state.puzIdx = puzIdx;
  state.puzzle = puzzles[puzIdx];
  state.undo = [];
  state.lastEdit = null;
  state.redo = [];

  const saved = unpackEdges(state.puzzle, store.get(saveKey(state.puzzle)));
  state.edges = saved || newEdges(state.puzzle);

  store.set('pp2_last', JSON.stringify({ set: set.id, hash: hashOf(state.puzzle) }));
  updateUrlParams(set, puzIdx);
  syncBookButton();
  $('puz-num').value = puzIdx + 1;
  $('puz-total').textContent = puzzles.length;
  board.render(state.puzzle, state.edges);
  syncColumnWidth();
  renderTileInfo($('tile-info'), state.puzzle.tile);
  renderTier(state.puzzle);
  updateFeedbackLink();
  refresh();
}

// Keep the address bar at ?book=<id>&puzzle=<n> (1-based) so the page can be bookmarked or
// shared, without adding history entries. Books loaded from a file have no stable id: no params.
function updateUrlParams(set, puzIdx) {
  try {
    const q = set.custom ? '' : `?book=${encodeURIComponent(set.id)}&puzzle=${puzIdx + 1}`;
    history.replaceState(null, '', location.pathname + q + location.hash);
  } catch { /* e.g. sandboxed or file:// */ }
}

// The help modal's "Report a problem" link opens a GitHub issue that already names the puzzle.
function updateFeedbackLink() {
  const link = $('feedback-link'), p = state.puzzle;
  if (!link || !p) return;
  const id = p.name || hashOf(p);
  const url = new URL('https://github.com/JoshMermel/polyomino-panel/issues/new');
  url.searchParams.set('title', `Feedback on ${id}`);
  url.searchParams.set('body', `Puzzle: ${id}\nTile: ${shapeName(p.tile)}, ${p.rows}x${p.cols}, tier ${p.tier ?? '?'}\nHash: ${hashOf(p)}\nLink: ${location.href}\n\nWhat I noticed:\n`);
  link.href = url.href;
}

// Previous / next puzzle in the current book. Stops at the ends (reloading the same puzzle
// would wipe the undo history for nothing).
const step = d => {
  const i = state.puzIdx + d;
  if (i < 0 || i >= (curSet().puzzles?.length ?? 0)) return;
  return goTo(state.setIdx, i);
};

// Keep the controls above the board exactly as wide as the board (see .column).
function syncColumnWidth() {
  const svg = document.querySelector('.board-svg');
  if (svg) $('game-container').style.setProperty('--board-w', `${svg.getBoundingClientRect().width}px`);
}

// Difficulty tier of the current puzzle as filled/empty stars plus a word; a puzzle the hint rules
// can't finish on their own also says so.
function renderTier(puzzle) {
  const tier = puzzle.tier;
  const el = $('tier-info');
  el.textContent = '';
  const level = TIERS.indexOf(tier);
  if (level < 0) { el.title = ''; return; }
  const stars = document.createElement('span');
  stars.className = 'tier-stars';
  stars.setAttribute('aria-hidden', 'true');
  TIERS.forEach((t, i) => {
    const s = document.createElement('span');
    s.className = i <= level ? 'on' : 'off';
    s.textContent = i <= level ? '★' : '☆';
    stars.appendChild(s);
  });
  el.append(stars, TIER_INFO[tier].name);
  el.title = `${TIER_INFO[tier].name}: ${TIER_INFO[tier].blurb}`;
  if (puzzle.givens?.length) {
    const note = document.createElement('span');
    note.className = 'tier-beyond';
    note.textContent = ' · pre-drawn clues';
    note.title = 'This puzzle comes with some marks already placed (drawn like the blocked cells). They are part of the puzzle and cannot be changed.';
    el.append(note);
  }
  if (beyondHints(puzzle)) {
    const note = document.createElement('span');
    note.className = 'tier-beyond';
    note.textContent = ' · no logical hints';
    note.title = "The hint rules can't finish this puzzle on their own, so Hint will run out of logical steps.";
    el.append(note);
  }
}

// --- Editing ----------------------------------------------------------------
function applyChanges(changes, dir) {
  for (const ch of changes) {
    const to = dir === 'forward' ? ch.to : ch.from;
    setEdge(state.puzzle, state.edges, ch.kind, ch.r, ch.c, to);
    board.setEdge(ch.kind, ch.r, ch.c, to);
  }
}

// Remember where the player just worked (the cells beside the changed edges) so a hint can start nearby.
// A bulk change (Reset) doesn't say anything about where the player is.
function noteEdit(changes) {
  state.lastEdit = changes.length > 14 ? null : changes.flatMap(ch => edgeCells(state.puzzle, ch.kind, ch.r, ch.c));
}

function commit(changes) {
  changes = changes.filter(ch => !isGivenEdge(state.puzzle, ch.kind, ch.r, ch.c));   // given edges are part of the puzzle
  if (!changes.length) return null;
  applyChanges(changes, 'forward');
  noteEdit(changes);
  const entry = { changes };
  state.undo.push(entry);
  state.redo = [];
  refresh();
  return entry;
}

// --- Marking -------------------------------------------------------------------
// Everything is deterministic (no timing involved). Where a press lands decides
// the gesture:
//
//  * on an EDGE: a tap cycles it empty -> line -> ✕ -> empty. Dragging from an
//    edge does nothing (it was only ever done by accident).
//  * on a CELL: drag across cells; if the cells you covered form exactly the
//    tile (any rotation/reflection), releasing draws every outline line of that
//    tile. Anything else is ignored.
//  * right-click on an edge toggles a ✕ directly.
//
// Each of these is one undo step.
let gesture = null;   // { cells: [] } while tracing a tile, else null

const nextMark = cur => (cur === EDGE_EMPTY ? EDGE_LINE : cur === EDGE_LINE ? EDGE_CROSS : EDGE_EMPTY);

function onEdgePress(kind, r, c) {
  const cur = getEdge(state.puzzle, state.edges, kind, r, c);
  commit([{ kind, r, c, from: cur, to: nextMark(cur) }]);
}

const dragIsTile = cells => cellsFormTile(state.puzzle, cells) && !givensRuleOutTile(state.puzzle, cells);

function showCellDrag() {
  const { tile, cols } = state.puzzle;
  board.setDrag(gesture.cells, dragIsTile(gesture.cells) ? shapeIndexOf(tile, gesture.cells, cols) : -1);
}

function onCellPress(cell) {
  gesture = { cells: [cell] };
  showCellDrag();
}

function onCellEnter(cell) {
  if (!gesture || gesture.cells.includes(cell)) return;
  gesture.cells.push(cell);
  showCellDrag();
}

function onRelease() {
  const g = gesture;
  gesture = null;
  board.setDrag([], -1);
  if (!g) return;

  // Cell drag.
  const { puzzle } = state;
  if (g.cells.length === 1 && minTileSize(puzzle.tile) > 1) return;   // just a click on a cell
  if (cellsFormTile(puzzle, g.cells) && givensRuleOutTile(puzzle, g.cells)) {
    showToast('A pre-drawn edge rules those cells out as one tile.', 'info', 2500);
    return;
  }
  if (!cellsFormTile(puzzle, g.cells)) {
    showToast(tileSpecs(puzzle.tile).length > 1
      ? `Those cells aren't one of the tile shapes (${shapeName(puzzle.tile)}).`
      : `Those cells aren't the tile shape (${shapeName(puzzle.tile)}).`, 'info', 2500);
    return;
  }
  // Dragging over a tile that is already outlined erases its outline (lines shared with a finished neighbour stay).
  const erase = tileErasure(puzzle, state.edges, g.cells);
  if (erase) {
    const entry = commit(erase.map(([kind, r, c]) => ({ kind, r, c, from: EDGE_LINE, to: EDGE_EMPTY })));
    if (!entry) showToast("That tile's lines are shared with neighbouring tiles or pre-drawn, so nothing was erased.", 'info', 2500);
    return;
  }
  const changes = [];
  for (const [kind, r, c] of tileOutline(puzzle, g.cells)) {
    const cur = getEdge(puzzle, state.edges, kind, r, c);
    if (cur !== EDGE_LINE) changes.push({ kind, r, c, from: cur, to: EDGE_LINE });
  }
  // Lines already inside the shape would cut the tile apart, so erase them too (a ✕ inside
  // just means "same tile" and stays).
  for (const [kind, r, c] of tileInterior(puzzle, g.cells)) {
    if (getEdge(puzzle, state.edges, kind, r, c) === EDGE_LINE) changes.push({ kind, r, c, from: EDGE_LINE, to: EDGE_EMPTY });
  }
  commit(changes);                       // one undo step; no-op if nothing needs to change
}

function onCancel() {
  gesture = null;
  board.setDrag([], -1);
}

function onEdgeContext(kind, r, c) {
  if (gesture) return;
  const cur = getEdge(state.puzzle, state.edges, kind, r, c);
  commit([{ kind, r, c, from: cur, to: cur === EDGE_CROSS ? EDGE_EMPTY : EDGE_CROSS }]);
}

function undo() {
  const entry = state.undo.pop();
  if (!entry) return;
  applyChanges(entry.changes, 'backward');
  noteEdit(entry.changes);
  state.redo.push(entry);
  refresh();
}

function redo() {
  const entry = state.redo.pop();
  if (!entry) return;
  applyChanges(entry.changes, 'forward');
  noteEdit(entry.changes);
  state.undo.push(entry);
  refresh();
}

function reset() {
  const changes = [];
  const { puzzle, edges } = state;
  for (const [kind, r, c] of playableEdges(puzzle)) {
    const cur = getEdge(puzzle, edges, kind, r, c);
    if (cur !== EDGE_EMPTY) changes.push({ kind, r, c, from: cur, to: EDGE_EMPTY });
  }
  commit(changes); // undoable
}

// --- Toast (same behaviour as multiverse-star-battle) -------------------------
let toastTimer = null, toastBorn = 0;

function showToast(message, type = 'info', duration = 2500) {
  const toast = $('toast');
  toast.textContent = message;
  toast.className = `toast-${type} toast-hidden`;
  placeToast(toast);
  void toast.offsetHeight;                 // restart the fade-in
  toast.classList.remove('toast-hidden');
  toastBorn = Date.now();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('toast-hidden'), duration);
}

// Toasts sit at the bottom of the window, like star battle's, unless that would
// cover more of the board than sitting at the top would (short windows): a
// hint's highlights must never be hidden under its own toast.
function placeToast(toast) {
  toast.classList.remove('toast-top');
  const board = $('board').getBoundingClientRect();
  const h = toast.offsetHeight;
  const overlap = top => Math.max(0, Math.min(board.bottom, top + h) - Math.max(board.top, top));
  if (overlap(12) < overlap(window.innerHeight - 30 - h)) toast.classList.add('toast-top');
}

// Dismiss the hint on screen (toast and highlights) but keep the cycle where it is: only a change to the
// board restarts it. A fully shown hint is shown again by the next Hint press (the player probably only
// moved the toast aside to look at the board); a hint dismissed at its first step goes on to its second.
function dismissHint() {
  hideToast();
  board.clearHint();
  if (state.hint && state.hint.stage !== 0) state.hint.repeat = true;
}

function hideToast() {
  clearTimeout(toastTimer);
  $('toast').classList.add('toast-hidden');
}

// --- Check and hint -----------------------------------------------------------
// The solution is cached on the puzzle object (null = none available).
function solutionFor(puzzle) {
  if (puzzle._solution === undefined) puzzle._solution = getSolution(puzzle);
  return puzzle._solution;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// "Correct so far?": compare every line and cross with the solution and report
// the result in a toast. Nothing is highlighted on the board.
function checkSoFar() {
  const solution = solutionFor(state.puzzle);
  if (!solution) {
    showToast("Can't check: this puzzle has no unique solution.", 'error', 3000);
    return;
  }
  const marks = Object.values(state.edges).reduce((total, a) => total + a.reduce((n, v) => n + (v ? 1 : 0), 0), 0);
  if (marks === 0) { showToast('Nothing to check yet.', 'info'); return; }
  const wrong = checkMarks(state.puzzle, state.edges, solution);
  if (wrong.length === 0) showToast('So far so good!', 'success');
  else showToast(`${plural(wrong.length, 'mark is', 'marks are')} incorrect.`, 'error');
}

// Hints highlight things on the board and explain them in a toast; they never
// change the player's marks. The first press finds every hint of the first kind
// that applies:
//   1. wrong marks (all shown in red);
//   2. the deduction rules in js/rating.js, easiest first (forced tiles, edges that
//      every possible tile agrees on, lookahead, chains: see that file);
//   3. otherwise edges that can take a ✕ (the solution has no line there), random order.
// The hints of that kind are ordered nearest first to where the player last marked (board order
// before any mark). Pressing Hint again while one is on screen steps to the next hint of the same
// kind (wrapping around); with "Step-by-step hints" on (the default), each hint takes two presses:
// where to look (the yellow cell or edge), then the move with its explanation. After the toast is dismissed
// (see dismissHint), Hint shows the same hint again. Colors: yellow = the cell(s) the hint is about, blue =
// the tile to place, dashed = lines to draw, ✕ = marks to place, "!" = a cell the
// text refers to. Highlights stay until the board changes or the toast is dismissed.
const HINT_TOAST_MS = 30000;

// Find the hints to offer: { tier, items, index: 0 }, or { none: message }.
function findHints() {
  const { puzzle, edges } = state;
  const solution = solutionFor(puzzle);

  if (solution) {
    const wrong = checkMarks(puzzle, edges, solution);
    if (wrong.length) return { tier: 'errors', items: [wrong], index: 0 };
  }
  // the same rules, in the same order, as the puzzle ratings (js/rating.js)
  for (const rule of RULES) {
    const items = rule.findAll(puzzle, edges);
    if (items.length) {
      return { tier: rule.hintKind, rule: rule.id, items: nearestFirst(items, item => [item.cell, ...(item.cells ?? [])]), index: 0 };
    }
  }

  // No rule finds anything: peek at the answer. Of the edges known to take a cross, offer first the one
  // that sets off the most logical progress (ties: nearest to the player's last mark, else random).
  if (!solution) return { none: 'No hint available for this puzzle.' };
  const options = crossHints(puzzle, edges, solution);
  if (!options.length) return { none: 'No more hints available.' };
  for (let i = options.length - 1; i > 0; i--) {          // random order
    const j = Math.floor(Math.random() * (i + 1));
    [options[i], options[j]] = [options[j], options[i]];
  }
  const ranked = rankPeeks(puzzle, edges, nearestFirst(options, e => edgeCells(puzzle, ...e)));
  return { tier: 'cross', items: ranked.map(x => x.edge), gains: ranked.map(x => x.gain), index: 0 };
}

// Order hint items by how close they are to the player's last mark (stable: items keep their order
// among equals, and with no mark yet nothing moves). cellsOf gives the cells an item is about.
function nearestFirst(items, cellsOf) {
  const near = state.lastEdit;
  if (!near?.length) return items;
  const { cols } = state.puzzle;
  const gridDist = topologyOf(state.puzzle).dist;
  const dist = item => Math.min(...cellsOf(item).flatMap(a => near.map(b =>
    gridDist(Math.floor(a / cols) - Math.floor(b / cols), (a % cols) - (b % cols)))));
  return items.map((item, i) => ({ item, i, d: dist(item) })).sort((x, y) => x.d - y.d || x.i - y.i).map(x => x.item);
}

// Words for why a hypothetical tile fails, from the contradiction reasons of the
// ruled-out tiles: a stranded cell (marked "!" when every tile strands the same
// one), or a region that can't be tiled.
function failureText(item) {
  const sizes = tileSizes(state.puzzle.tile);
  const kinds = new Set(item.alternatives.map(a => a.reason?.kind));
  const stranded = item.sharedDead?.length ? item.sharedDead[0] : null;
  if (stranded !== null && kinds.size === 1 && kinds.has('cell')) return { text: 'the cell marked ! with nowhere to go', marker: stranded };
  if (kinds.size === 1 && kinds.has('size')) {
    return { text: sizes.length === 1 ? `an enclosed region whose size is not a multiple of ${sizes[0]}`
      : `an enclosed region whose size can't be made from tiles of ${sizes.join(' and ')} cells`, marker: null };
  }
  if (kinds.size === 1 && kinds.has('parity')) return { text: 'an enclosed region whose black and white squares (as on a chessboard) can\'t be tiled', marker: null };
  return { text: 'some cell with nowhere to go, or an enclosed region that can\'t be tiled', marker: null };
}

// Words for an enclosed-region hint: why a region of n cells can't be filled with tiles.
function pocketWhy(n) {
  const sizes = tileSizes(state.puzzle.tile);
  return sizes.length === 1 ? `${n} is not a multiple of ${sizes[0]}` : `${n} cells can't be made from tiles of ${sizes.join(' and ')} cells`;
}

// What a step-by-step hint says and shows on its first press: where to look and a vague idea why, not the move.
// When the move is one edge (tryLine, pocket) the edge is marked with a neutral yellow "?" (not yet a line or a ✕).
function firstHintText(h, item) {
  const cell = { target: [item.cell] };
  const edge = (item.lines?.length ?? 0) + (item.crosses?.length ?? 0) === 1 ? 'an edge' : 'some edges';   // (edges / eliminate hints)
  switch (h.tier) {
    case 'forced': return { show: cell, text: 'there is only one way to cover the yellow cell.' };
    case 'lookahead2': return { show: cell, text: 'the yellow cell has just two ways to be covered, and one of them leads to a dead end.' };
    case 'edges': return { show: cell, text: `every way to cover the yellow cell agrees about ${edge} near it.` };
    case 'tryLine': case 'pocket': return { show: { unknown: item.crosses }, text: `something about ${item.crosses.length === 1 ? 'the yellow edge' : 'each yellow edge'} is certain.` };
    case 'lookahead3': return { show: cell, text: 'the yellow cell has a few ways to be covered, and all but one lead to a dead end.' };
    case 'eliminate': return { show: cell, text: `some ways to cover the yellow cell lead to a dead end, and the ones left agree about ${edge}.` };
    default: return { show: cell, text: 'try the two ways to cover the yellow cell and follow what each forces; one of them fails.' };
  }
}

// Display the current item of a hint set. With step-by-step hints, stage 0 only points at the cell to look at
// and stage 1 (the only one otherwise) shows the move.
function displayHint(h) {
  const { puzzle } = state;
  const item = h.items[h.index];
  const label = 'Hint';
  let text;

  if (h.stage === 0) {
    const first = firstHintText(h, item);
    board.showHint(first.show);
    showToast(`${label}: ${first.text} Press Hint again for the full explanation.`, 'hint', HINT_TOAST_MS);
    return;
  }

  if (h.tier === 'errors') {
    board.showErrors(item);
    text = `${plural(item.length, 'mark is', 'marks are')} incorrect (shown in red). Fix ${item.length === 1 ? 'it' : 'them'} first.`;
  } else if (h.tier === 'forced') {
    board.showHint({ target: [item.cell], tile: item.cells, lines: item.lines });
    text = 'the yellow cell can only be covered by one tile placement (blue). Draw the dashed lines around it.';
  } else if (h.tier === 'edges') {
    board.showHint({ target: [item.cell], lines: item.lines, crosses: item.crosses });
    const parts = [];
    if (item.lines.length) parts.push(`every possible tile for the yellow cell has a boundary along the dashed ${item.lines.length === 1 ? 'line' : 'lines'}, so draw ${item.lines.length === 1 ? 'it' : 'them'}`);
    if (item.crosses.length) parts.push(`every possible tile contains both cells beside the ✕, so there is no line there: mark ${item.crosses.length === 1 ? 'it' : 'them'}`);
    text = `${parts.join('; and ')}.`;
  } else if (h.tier === 'tryLine') {
    board.showHint({ target: [item.cell], crosses: item.crosses });
    text = `a line along the ✕ ${item.crosses.length === 1 ? 'edge' : 'edges'} would leave the yellow cell with no possible tile (every tile that could cover it contains both cells beside the ✕). So there is no line there: mark ${item.crosses.length === 1 ? 'it' : 'them'}.`;
  } else if (h.tier === 'pocket') {
    const n = item.cells.length, small = n <= 12;           // (a big region is not worth colouring in)
    board.showHint({ target: small ? item.cells : edgeCells(puzzle, ...item.crosses[0]), crosses: item.crosses });
    text = `a line along the ✕ would wall off ${small ? `the ${n} yellow cells` : `an enclosed region of ${n} cells`} from the rest, and ${pocketWhy(n)}, so no tiles could fill ${small ? 'them' : 'it'}. So there is no line there: mark it.`;
  } else if (h.tier === 'lookahead2' || h.tier === 'lookahead3') {
    const why = failureText(item);
    board.showHint({ target: [item.cell], lines: item.lines, marker: why.marker });
    text = h.tier === 'lookahead2'
      ? `the yellow cell has just two possible tiles, and one of them would leave ${why.text}. Draw the dashed outline of the other one.`
      : `the yellow cell has ${item.ruledOut + 1} possible tiles, but every one except the dashed one would leave ${why.text}. Draw the dashed outline.`;
  } else if (h.tier === 'eliminate') {
    const why = failureText(item);
    board.showHint({ target: [item.cell], lines: item.lines, crosses: item.crosses, marker: why.marker });
    const parts = [];
    if (item.lines.length) parts.push(`draw the dashed ${item.lines.length === 1 ? 'line' : 'lines'} (every remaining tile has a boundary there)`);
    if (item.crosses.length) parts.push(`mark the ✕ (every remaining tile contains both cells beside it)`);
    text = `the yellow cell has ${item.ruledOut + item.survivors} possible tiles. ${item.ruledOut === 1 ? 'One of them would' : `${item.ruledOut} of them would`} leave ${why.text}, so ${item.ruledOut === 1 ? 'it' : 'they'} can't be right. ` +
      `The other ${item.survivors} all agree: ${parts.join(', and ')}.`;
  } else if (h.tier === 'chain') {
    board.showHint({ target: [item.cell], lines: item.lines });
    text = `the yellow cell has just two possible tiles. Try the other one, not the dashed one, and follow what it forces (the lines and ✕ marks it makes certain)` +
      `${item.maxSteps ? `, up to ${item.maxSteps} ${item.maxSteps === 1 ? 'step' : 'steps'}` : ''}: it ends in a contradiction. Draw the dashed outline.`;
  } else {
    const [kind, r, c] = item;
    board.showHint({ target: edgeCells(puzzle, kind, r, c), crosses: [item] });
    text = "no logical inference is available right now, so here's a peek at the answer: the two yellow cells belong to the same tile. Mark the edge between them with a ✕." +
      (h.gains?.[h.index] ? ' (Of the peeks, this one should open up the most logical hints afterwards.)' : '');
  }
  showToast(`${label}: ${text}`, 'hint', HINT_TOAST_MS);
}

function hint() {
  if (analyze(state.puzzle, state.edges).solved) { showToast('Already solved!', 'success'); return; }
  if (state.hint) {
    const h = state.hint;
    if (h.repeat) h.repeat = false;                                         // dismissed after the full hint: show it again
    else if (h.stage === 0) h.stage = 1;                                    // step-by-step: where to look, then the move
    else {
      h.index = (h.index + 1) % h.items.length;                             // next of the same kind
      if (h.stage !== undefined) h.stage = 0;
    }
  } else {
    const found = findHints();
    if (found.none) { showToast(found.none, 'info'); return; }
    if (state.stepHints && found.rule) found.stage = 0;                     // (not for mistakes or peeks)
    state.hint = found;
  }
  displayHint(state.hint);
}

// --- Refresh: analysis, status, persistence ---------------------------------
function refresh() {
  board.clearHint(); // any change to the board clears hint highlights
  state.hint = null;
  hideToast();
  const a = analyze(state.puzzle, state.edges);
  board.update(a, state.showTiles);
  if (a.solved) store.set(solvedKey(state.puzzle), '1');

  const set = curSet();
  const blank = newEdges(state.puzzle);                  // (a puzzle's given edges don't count as the player's marks)
  const hasMarks = Object.keys(blank).some(k => state.edges[k].some((x, i) => x !== blank[k][i]));

  if (hasMarks) store.set(saveKey(state.puzzle), packEdges(state.edges));
  else store.del(saveKey(state.puzzle));

  $('undo-btn').disabled = state.undo.length === 0;
  $('redo-btn').disabled = state.redo.length === 0;
  $('reset-btn').disabled = !hasMarks;

  const st = $('status');
  if (a.solved) {
    st.className = 'status solved';
    st.textContent = '';
    st.append('Solved! ');
    const puzzles = set.puzzles;
    if (state.puzIdx < puzzles.length - 1) {
      const b = document.createElement('button');
      b.className = 'link-btn';
      b.textContent = 'Next puzzle →';
      b.addEventListener('click', () => step(1));
      st.append(b);
    }
  } else {
    st.className = 'status';
    st.textContent = '';          // nothing until the puzzle is solved (a count of finished tiles was tried and dropped)
  }
}

// --- Browse puzzles -----------------------------------------------------------
// A grid of the current book's puzzles, grouped under their difficulty tier and coloured
// by status: solved (green), in progress (yellow, some marks saved), current (blue ring).
// A row of shape buttons filters the grid (and "First unsolved") by shape: books mix shapes, so someone
// who likes some shapes can play just those puzzles. Several can be on at once (a puzzle shows if it
// uses any of them); none on means every puzzle.
let closeBrowse = () => {};   // set in bindControls
const ALL_SHAPES = [...shapeOrder(SQUARE), ...shapeOrder(HEX), ...shapeOrder(TRI)];
const shapeRank = spec => { const i = ALL_SHAPES.indexOf(spec); return i < 0 ? 999 : i; };
const bookShapes = puzzles => [...new Set(puzzles.flatMap(p => tileSpecs(p.tile)))].sort((a, b) => shapeRank(a) - shapeRank(b) || (a < b ? -1 : 1));
const matchesShapes = (p, shapes) => !shapes.size || tileSpecs(p.tile).some(s => shapes.has(s));

// The shapes the filter is using in the current book: those picked that the book has (empty = no filter).
function activeShapes() {
  const present = new Set(bookShapes(curSet().puzzles ?? []));
  return new Set([...state.browseShapes].filter(s => present.has(s)));
}

// The puzzles of the current book that pass the filter, as [puzzle, number] pairs (number = position in the book).
function browseVisible() {
  const puzzles = curSet().puzzles ?? [], shapes = activeShapes();
  return puzzles.map((p, i) => [p, i]).filter(([p]) => matchesShapes(p, shapes));
}

// Build the shape buttons from the shapes present in the book (hidden when there is only one shape).
// Each shows the piece and how many of the book's puzzles use it.
function fillBrowseFilter(puzzles) {
  const box = $('browse-shapes'), row = $('browse-filter-row');
  const shapes = bookShapes(puzzles), on = activeShapes();
  row.hidden = shapes.length < 2;
  box.textContent = '';
  for (const spec of shapes) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'shape-chip';
    b.dataset.shape = spec;
    b.setAttribute('aria-pressed', on.has(spec) ? 'true' : 'false');
    const count = puzzles.filter(p => tileSpecs(p.tile).includes(spec)).length;
    b.title = `${shapeName(spec)}: ${count} puzzles`;
    b.setAttribute('aria-label', `${shapeName(spec)}, ${count} puzzles`);
    const n = document.createElement('span');
    n.className = 'shape-chip-count';
    n.textContent = count;
    b.append(tileShapeSvg(spec, 0), n);
    box.append(b);
  }
  $('browse-clear-shapes').hidden = !on.size;
}

function renderBrowse() {
  const set = curSet(), puzzles = set.puzzles ?? [];
  fillBrowseFilter(puzzles);
  const grid = $('browse-grid');
  grid.textContent = '';
  const visible = browseVisible();
  const solvedAll = puzzles.filter(isSolved).length, solvedShown = visible.filter(([p]) => isSolved(p)).length;
  const filtered = activeShapes().size > 0;
  $('browse-summary').textContent = filtered
    ? `${set.title}: ${solvedShown} of ${visible.length} solved here (${solvedAll} of ${puzzles.length} in the book)`
    : `${set.title}: ${solvedAll} of ${puzzles.length} solved`;

  // Tier headings only when the shown puzzles run through their tiers in order (a curriculum or a
  // one-tier book would just have a heading in the wrong place, or one pointless heading).
  const order = visible.map(([p]) => TIERS.indexOf(p.tier));
  const byTier = new Set(order).size > 1 && order.every((v, i) => i === 0 || v >= order[i - 1]);
  let tier = null;
  visible.forEach(([p, i]) => {
    if (byTier && p.tier && p.tier !== tier) {
      tier = p.tier;
      const info = TIER_INFO[tier];
      const head = document.createElement('div');
      head.className = 'browse-tier-header';
      const nameEl = document.createElement('span');
      nameEl.className = 'browse-tier-name';
      nameEl.textContent = info?.name ?? tier;
      head.append(nameEl);              // just the tier's name: which solving tools it needs is left for the player to find out
      grid.append(head);
    }
    const done = isSolved(p), started = !done && hasProgress(p);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'browse-tile' + (done ? ' bt-solved' : started ? ' bt-in-progress' : '') + (i === state.puzIdx ? ' bt-current' : '');
    b.textContent = i + 1;
    b.title = shapeName(p.tile);
    b.setAttribute('aria-label', `Puzzle ${i + 1}, ${shapeName(p.tile)}${done ? ' (solved)' : started ? ' (in progress)' : ''}`);
    b.addEventListener('click', () => {
      closeBrowse();
      goTo(state.setIdx, i);
    });
    grid.append(b);
  });
  // the modal becomes visible right after this runs, so wait a frame before scrolling
  requestAnimationFrame(() => grid.querySelector('.bt-current')?.scrollIntoView({ block: 'nearest' }));
}

// --- Print puzzles ------------------------------------------------------------
// Settings -> "Print puzzles" opens a modal to pick a range of the current book, then builds a
// print-only page (js/print.js) and opens the browser's print dialog ("Save as PDF" there).
// The booklet styles apply only while a booklet is being printed, so a plain Ctrl+P prints the page.
const endBookletPrint = () => document.body.classList.remove('printing-booklet');
window.addEventListener('afterprint', endBookletPrint);
matchMedia('print').addEventListener?.('change', e => { if (!e.matches) endBookletPrint(); });   // iOS skips afterprint
function setupPrint(setupModal, hideSettings) {
  const sel = $('print-selection'), sizeSel = $('print-size'), keyBox = $('print-answer-key');
  const err = $('print-error'), summary = $('print-summary'), go = $('print-go-btn');
  const savedSize = store.get('pp_printSize');
  if ([...sizeSel.options].some(o => o.value === savedSize)) sizeSel.value = savedSize;
  keyBox.checked = store.get('pp_printKey') !== '0';

  const update = () => {
    const puzzles = curSet().puzzles ?? [];
    const { ids, error } = parseSelection(sel.value, puzzles.length);
    err.hidden = !error;
    err.textContent = error ?? '';
    go.disabled = Boolean(error);
    if (error) { summary.textContent = ''; return null; }
    const size = sizeSel.value;
    const keyIds = keyBox.checked ? ids.filter(id => solutionFor(puzzles[id - 1])) : [];
    const plan = planPrint({ puzzles, ids, keyIds, size });
    const pages = n => `${n} page${n === 1 ? '' : 's'}`;
    summary.textContent = `${ids.length} puzzle${ids.length === 1 ? '' : 's'}, ${plan.perPage} per page: ${pages(plan.puzzlePages)}` +
      (plan.keyPages ? ` + ${pages(plan.keyPages)} of answers (${plan.keyPerPage} per page).` : '.');
    return { ids, puzzles, size };
  };

  setupModal('print-modal', 'print-btn', () => {
    hideSettings();
    const set = curSet(), total = (set.puzzles ?? []).length;
    $('print-book-name').textContent = set.title;
    $('print-book-total').textContent = total;
    sel.value = total <= 1 ? '1' : `1-${Math.min(total, 10)}`;
    update();
    // focus the field for keyboard users, but not on a phone, where it would pop the keyboard up
    if (matchMedia('(pointer: fine)').matches) setTimeout(() => { sel.focus(); sel.select(); }, 0);
  });
  sel.addEventListener('input', update);
  sizeSel.addEventListener('change', () => { store.set('pp_printSize', sizeSel.value); update(); });
  keyBox.addEventListener('change', () => { store.set('pp_printKey', keyBox.checked ? '1' : '0'); update(); });
  go.addEventListener('click', () => {
    const r = update();
    if (!r) return;
    buildPrintRoot({ book: curSet(), puzzles: r.puzzles, ids: r.ids, size: r.size, includeKey: keyBox.checked, solutionOf: solutionFor });
    document.body.classList.add('printing-booklet');     // style.css prints only the booklet while this is set
    window.print();
  });
}

// The help text names the colors of the board, which depend on the theme: in light mode the cells to
// cut up are white and the blocked ones black; in dark mode the blocked ones are near-white (they use the
// text color, as star battle's void cells do) and the cells to cut up are dark. Re-worded each time the
// dialog opens, so it always matches the current theme.
function syncHelpText() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  $('help-open-cells').textContent = dark ? 'dark' : 'white';
  $('help-blocked-cells').textContent = dark ? 'White' : 'Black';
}

// --- Controls ---------------------------------------------------------------
// The book picker: a button showing the current book opens a modal listing every book, in
// sections (Start here, Classical L-panel, One shape, Two shapes; files loaded from disk get their
// own). Each row shows the book's name, what it holds, and how many puzzles you have solved in it.
function syncBookButton() {
  const btn = $('book-btn');
  btn.textContent = '';
  const name = document.createElement('span');
  name.className = 'book-btn-name';
  name.textContent = curSet().title;
  btn.append(name);
}

let closeBookPicker = () => {};   // set in bindControls
const chooseBook = idx => {
  closeBookPicker();
  if (idx !== state.setIdx) goTo(idx, 0);
};

function renderBookPicker() {
  const body = $('bp-body');
  body.textContent = '';
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

  // Sections in the manifest's order, then any group a book names that the manifest doesn't list. All the Bonus groups
  // are one section, "Bonus". A section whose books are only board sizes (6×6, 8×8, ...) is one row of size buttons.
  const sectionOf = g => (g.startsWith('Bonus') ? 'Bonus' : g);
  const names = [];
  for (const n of [...state.groups.map(g => g.name), ...state.sets.map(s => s.group)]) if (!names.includes(sectionOf(n))) names.push(sectionOf(n));
  const progress = [];                                    // rows to fill in once their book is loaded: { i, show(solved, total) }
  const more = el('details', 'bp-more');                  // secondary groups sit under "More books"
  more.append(el('summary', 'bp-more-summary', 'More books'));
  for (const name of names) {
    const idxs = state.sets.map((s, i) => i).filter(i => sectionOf(state.sets[i].group) === name);
    if (!idxs.length) continue;
    const sec = el('div', 'bp-section');
    const info = state.groups.find(g => sectionOf(g.name) === name);
    const blurb = name === 'Bonus' ? '' : info?.blurb;
    const blurbShownByBook = idxs.length === 1 && state.sets[idxs[0]].blurb === blurb;     // "Start here"
    const sizesOnly = idxs.length > 1 && idxs.every(i => /^\d+×\d+$/.test(state.sets[i].label ?? ''));
    if (sizesOnly) {
      sec.append(el('h3', '', name));                     // a header like the others, then one button per board size across the row
      const row = el('div', 'bp-multi');
      if (blurb) row.title = blurb;                      // what the books hold is a tooltip
      const sizes = el('div', 'bp-sizes');
      for (const i of idxs) {
        const set = state.sets[i];
        const btn = el('button', 'bp-size' + (i === state.setIdx ? ' bp-current' : ''), set.label);
        btn.type = 'button';
        if (i === state.setIdx) btn.setAttribute('aria-current', 'true');
        btn.title = `${name}, ${set.label}: ${set.count ?? set.puzzles?.length ?? ''} puzzles`;
        btn.addEventListener('click', () => chooseBook(i));
        sizes.append(btn);
        progress.push({ i, show: (solved, total) => { btn.title = `${name}, ${set.label}: ${solved ? `${solved} / ${total} solved` : `${total} puzzles`}`; btn.classList.toggle('bp-size-done', solved === total); } });
      }
      row.append(sizes);
      sec.append(row);
    } else {
      sec.append(el('h3', '', name));
      if (blurb && !blurbShownByBook) sec.append(el('p', 'bp-blurb', blurb));
    }
    for (const i of sizesOnly ? [] : idxs) {
      const set = state.sets[i];
      const row = el('button', 'bp-book' + (i === state.setIdx ? ' bp-current' : ''));
      row.type = 'button';
      if (i === state.setIdx) row.setAttribute('aria-current', 'true');
      const text = el('span', 'bp-book-text');
      // a tier book shows its stars; the others just their name
      const level = TIERS.indexOf(set.tier);
      const title = el('span', 'bp-book-title', set.label ?? set.title);
      if (level >= 0) title.prepend(el('span', 'bp-stars', '★'.repeat(level + 1) + '☆'.repeat(TIERS.length - level - 1) + ' '));
      text.append(title);
      // tier books are explained by their stars (and the help dialog); other books say what they hold
      if (set.blurb && level < 0) text.append(el('span', 'bp-book-blurb', set.blurb));
      if (set.blurb) row.title = set.blurb;
      const count = el('span', 'bp-count', `${set.count ?? set.puzzles?.length ?? ''} puzzles`);
      row.append(text, count);
      row.addEventListener('click', () => chooseBook(i));
      sec.append(row);
      progress.push({ i, show: (solved, total) => {
        count.textContent = solved ? `${solved} / ${total} solved` : `${total} puzzles`;
        count.classList.toggle('bp-count-done', solved === total);
      } });
    }
    if (info?.secondary) {
      more.append(sec);
      if (idxs.includes(state.setIdx)) more.open = true;      // never hide the book being played
    } else {
      body.append(sec);
    }
  }
  if (more.querySelector('.bp-section')) body.append(more);
  requestAnimationFrame(() => body.querySelector('.bp-current')?.scrollIntoView({ block: 'center' }));

  // how many of each book's puzzles are solved: needs the book's puzzles, so load them (a small
  // file each, cached by the browser) and update the rows as they arrive
  for (const { i, show } of progress) {
    ensureLoaded(state.sets[i]).then(puzzles => show(puzzles.filter(isSolved).length, puzzles.length)).catch(() => { /* the count stays as it was */ });
  }
}

function bindControls() {
  $('prev-puz').addEventListener('click', () => step(-1));
  $('next-puz').addEventListener('click', () => step(1));
  $('puz-num').addEventListener('change', e => goTo(state.setIdx, (parseInt(e.target.value, 10) || 1) - 1));
  $('undo-btn').addEventListener('click', undo);
  $('redo-btn').addEventListener('click', redo);
  $('reset-btn').addEventListener('click', reset);

  $('toast').addEventListener('click', () => {
    if (Date.now() - toastBorn > 500) dismissHint();
  });
  // Clicking on empty page (not the board, a control, or a dialog) dismisses the hint.
  document.addEventListener('pointerdown', e => {
    if (e.target.closest('#board, #toast, button, select, input, label, a, .modal-overlay')) return;
    dismissHint();
  });
  $('check-btn').addEventListener('click', checkSoFar);
  $('hint-btn').addEventListener('click', hint);

  // --- Modals (settings, help) ---
  const modals = [];
  const setupModal = (modalId, openBtnId, onOpen) => {
    const modal = $(modalId), openBtn = $(openBtnId);
    const close = () => { modal.classList.add('modal-hidden'); openBtn.focus(); };
    const open = () => {
      onOpen?.();
      modal.classList.remove('modal-hidden');
      modal.querySelector('[data-close]').focus();
    };
    openBtn.addEventListener('click', open);
    modal.querySelector('[data-close]').addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    modals.push({ modal, close });
    return { open, close };
  };
  const settings = setupModal('settings-modal', 'settings-btn');
  closeBookPicker = setupModal('book-modal', 'book-btn', renderBookPicker).close;
  const browse = setupModal('browse-modal', 'browse-btn', renderBrowse);
  closeBrowse = browse.close;
  setupPrint(setupModal, settings.close);
  $('browse-jump-btn').addEventListener('click', () => {
    const next = browseVisible().find(([p]) => !isSolved(p));     // respects the shape filter
    if (!next) { showToast(activeShapes().size ? "You've solved every puzzle with those shapes! 🎉" : "You've solved every puzzle in this book! 🎉", 'success', 3000); return; }
    browse.close();
    goTo(state.setIdx, next[1]);
  });
  $('browse-shapes').addEventListener('click', e => {
    const spec = e.target.closest('.shape-chip')?.dataset.shape;
    if (!spec) return;
    if (!state.browseShapes.delete(spec)) state.browseShapes.add(spec);
    renderBrowse();
  });
  $('browse-clear-shapes').addEventListener('click', () => { state.browseShapes.clear(); renderBrowse(); });

  const help = setupModal('help-modal', 'help-btn', syncHelpText);
  // Like star battle: show the help modal the very first time, then remember it was seen.
  if (!store.get('pp_seenHelp')) {
    store.set('pp_seenHelp', '1');
    help.open();
  }
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (gesture) { onCancel(); return; }
    modals.find(({ modal }) => !modal.classList.contains('modal-hidden'))?.close();
  });

  const steps = $('setting-step-hints');
  steps.checked = state.stepHints;
  steps.addEventListener('change', () => {
    state.stepHints = steps.checked;
    store.set('pp_stepHints', steps.checked ? '1' : '0');
    state.hint = null;
  });

  const tiles = $('setting-tint-tiles');
  tiles.checked = state.showTiles;
  tiles.addEventListener('change', () => {
    state.showTiles = tiles.checked;
    store.set('pp_showTiles', tiles.checked ? '1' : '0');
    if (state.puzzle) refresh();
  });

  // Dark mode: the page's inline <head> script already applied the saved (or
  // system) theme; just sync the switch and handle changes.
  const dark = $('setting-dark-mode');
  dark.checked = document.documentElement.getAttribute('data-theme') === 'dark';
  dark.addEventListener('change', () => {
    document.documentElement.setAttribute('data-theme', dark.checked ? 'dark' : 'light');
    store.set('pp_dark', dark.checked ? '1' : '0');
    if (state.puzzle) renderTileInfo($('tile-info'), state.puzzle.tile);       // its tooltip names the colour of the cells to tile
  });

  // Offline play: register / remove the service worker (sw.js) and keep every book cached.
  const offline = $('setting-offline');
  offline.checked = store.get('pp_offline') === '1';
  offline.addEventListener('change', async () => {
    if (!('serviceWorker' in navigator)) {
      offline.checked = false;
      showToast('Offline play is not supported in this browser.', 'error', 3000);
      return;
    }
    store.set('pp_offline', offline.checked ? '1' : '0');
    try {
      if (offline.checked) {
        await navigator.serviceWorker.register('sw.js');
        await navigator.serviceWorker.ready;
        // The worker only caches what passes through it, so wait until it controls this page.
        if (!navigator.serviceWorker.controller) {
          await new Promise(resolve => {
            const timer = setTimeout(resolve, 4000);
            navigator.serviceWorker.addEventListener('controllerchange', () => { clearTimeout(timer); resolve(); }, { once: true });
          });
        }
        if (!navigator.serviceWorker.controller) {
          showToast('Offline play is on. Reload the page once to finish saving the books.', 'info', 5000);
          return;
        }
        const books = state.sets.filter(s => !s.custom);
        await fetchText('data/manifest.json');
        for (const b of books) await fetchText(`data/${b.file}`);          // the worker caches each as it passes
        showToast(`Offline play is on: the app and all ${books.length} books are saved on this device.`, 'success', 3500);
      } else {
        (await navigator.serviceWorker.getRegistrations()).forEach(r => r.unregister());
        (await caches.keys()).filter(k => k.startsWith('pp-')).forEach(k => caches.delete(k));
        showToast('Offline play is off.', 'info', 2500);
      }
    } catch (err) {
      console.error(err);
      offline.checked = false;
      store.set('pp_offline', '0');
      showToast('Could not turn offline play on.', 'error', 3000);
    }
  });

  // Clear saves: first click asks "Are you sure?" (reverts after 4 s), second click erases.
  const clearBtn = $('clear-saves-btn');
  let clearTimer = null;
  const disarmClear = () => {
    clearTimeout(clearTimer);
    clearBtn.textContent = 'Clear saves';
    clearBtn.classList.remove('danger-btn--confirm');
  };
  clearBtn.addEventListener('click', async () => {
    if (!clearBtn.classList.contains('danger-btn--confirm')) {
      clearBtn.textContent = 'Are you sure?';
      clearBtn.classList.add('danger-btn--confirm');
      clearTimer = setTimeout(disarmClear, 4000);
      return;
    }
    disarmClear();
    clearSaves();
    await goTo(state.setIdx, state.puzIdx);       // reload the current puzzle, now blank
    showToast('Saved progress cleared.', 'success', 2500);
  });
  $('settings-btn').addEventListener('click', disarmClear);
  $('csv-btn').addEventListener('click', () => $('csv-file').click());
  $('csv-file').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const puzzles = parseCsv(await file.text());
      if (!puzzles.length) throw new Error('no puzzles found');
      state.sets.push({ id: `custom:${file.name}`, custom: true, group: 'Loaded from file', title: `📄 ${file.name}`, label: `📄 ${file.name}`, count: puzzles.length, puzzles });
      $('settings-modal').classList.add('modal-hidden');
      await goTo(state.sets.length - 1, 0);
    } catch (err) {
      $('settings-modal').classList.add('modal-hidden');
      showToast(`Couldn't load ${file.name}: ${err.message}`, 'error', 4000);
    }
  });

  // Left / right arrow: previous / next puzzle in this book (as in star battle). Not while typing,
  // dragging, or with a dialog open; holding the key keeps stepping.
  document.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.defaultPrevented || gesture) return;
    if (e.target.closest?.('input:not([type=checkbox]), textarea, select, [contenteditable]')) return;
    if (modals.some(({ modal }) => !modal.classList.contains('modal-hidden'))) return;
    e.preventDefault();
    step(e.key === 'ArrowRight' ? 1 : -1);
  });

  document.addEventListener('keydown', e => {
    // leave Ctrl+Z to text fields (the print range, puzzle number) and to open dialogs
    if (e.target.closest?.('input:not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable]')) return;
    if (modals.some(({ modal }) => !modal.classList.contains('modal-hidden'))) return;
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'z') { e.preventDefault(); (e.shiftKey ? redo : undo)(); }
    else if (k === 'y') { e.preventDefault(); redo(); }
  });
}

init();
