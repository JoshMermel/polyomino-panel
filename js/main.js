// App controller: puzzle sets/selection, edge editing with undo/redo, solve
// detection and progress persistence.
import {
  EDGE_EMPTY, EDGE_LINE, EDGE_CROSS,
  parseCsv, newEdges, getEdge, setEdge, analyze, playableEdges,
  getSolution, checkMarks, crossHints, edgeCells, puzzleHash,
  cellsFormTile, tileOutline, tileInterior, tileSize, shapeName, SHAPE_ORDER, } from './logic.js';
import { Board } from './board.js';
import { renderTileInfo } from './tile-view.js';
import { RULES, TIERS, TIER_INFO } from './rating.js';
import { parseSelection, planPrint, buildPrintRoot } from './print.js';

const $ = id => document.getElementById(id);

// --- localStorage (may be unavailable, e.g. private mode) -------------------
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

// Edges <-> string for storage: "<h digits>|<v digits>".
const packEdges = e => `${e.h.join('')}|${e.v.join('')}`;
function unpackEdges(puzzle, s) {
  const edges = newEdges(puzzle);
  const [h, v] = (s || '').split('|');
  if (!h || v === undefined || h.length !== edges.h.length || v.length !== edges.v.length) return null;
  for (let i = 0; i < h.length; i++) edges.h[i] = +h[i];
  for (let i = 0; i < v.length; i++) edges.v[i] = +v[i];
  return edges;
}

// --- State ------------------------------------------------------------------
const state = {
  sets: [],            // books: [{id, tile, rows, cols, file?, custom?, title?, puzzles|null}]
  setIdx: 0,
  puzIdx: 0,
  puzzle: null,
  edges: null,
  hint: null,          // the hint on screen: { tier, items, index } (see hint())
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
    onEdgePress, onEdgeEnter, onCellPress, onCellEnter, onRelease, onCancel, onEdgeContext,
  });
  bindControls();

  try {
    const manifest = JSON.parse(await fetchText('data/manifest.json'));
    state.sets = manifest.books.map(b => ({
      id: `${b.tile}_${b.rows}x${b.cols}`, tile: b.tile, rows: b.rows, cols: b.cols, file: b.file, puzzles: null,
    }));
    state.defaultSet = Math.max(0, state.sets.findIndex(s => s.id === manifest.default));
  } catch (err) {
    showFatal(err);
    return;
  }
  renderPickers();

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
  state.redo = [];

  const saved = unpackEdges(state.puzzle, store.get(saveKey(state.puzzle)));
  state.edges = saved || newEdges(state.puzzle);

  store.set('pp2_last', JSON.stringify({ set: set.id, hash: hashOf(state.puzzle) }));
  updateUrlParams(set, puzIdx);
  syncPickers();
  $('puz-num').value = puzIdx + 1;
  $('puz-total').textContent = puzzles.length;
  board.render(state.puzzle, state.edges);
  syncColumnWidth();
  renderTileInfo($('tile-info'), state.puzzle.tile);
  renderTier(state.puzzle.tier);
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

const step = d => goTo(state.setIdx, state.puzIdx + d);

// Keep the controls above the board exactly as wide as the board (see .column).
function syncColumnWidth() {
  const svg = document.querySelector('.board-svg');
  if (svg) $('game-container').style.setProperty('--board-w', `${svg.getBoundingClientRect().width}px`);
}

// Difficulty tier of the current puzzle as filled/empty stars plus a word.
function renderTier(tier) {
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
}

// --- Editing ----------------------------------------------------------------
function applyChanges(changes, dir) {
  for (const ch of changes) {
    const to = dir === 'forward' ? ch.to : ch.from;
    setEdge(state.puzzle, state.edges, ch.kind, ch.r, ch.c, to);
    board.setEdge(ch.kind, ch.r, ch.c, to);
  }
}

function commit(changes) {
  if (!changes.length) return null;
  applyChanges(changes, 'forward');
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
//  * on an EDGE: a tap cycles it empty -> line -> ✕ -> empty. Dragging on
//    paints: every other edge you drag over is set to whatever the first edge
//    just became.
//  * on a CELL: drag across cells; if the cells you covered form exactly the
//    tile (any rotation/reflection), releasing draws every outline line of that
//    tile. Anything else is ignored.
//  * right-click on an edge toggles a ✕ directly.
//
// A whole gesture is one undo step. Edge strokes apply live; Escape or a
// cancelled pointer reverts them.
let gesture = null;   // { type: 'edge', target, touched: Set, changes: [] } | { type: 'cell', cells: [] }

const nextMark = cur => (cur === EDGE_EMPTY ? EDGE_LINE : cur === EDGE_LINE ? EDGE_CROSS : EDGE_EMPTY);

function paintEdge(kind, r, c) {
  const key = `${kind}:${r}:${c}`;
  if (gesture.touched.has(key)) return;
  gesture.touched.add(key);
  const cur = getEdge(state.puzzle, state.edges, kind, r, c);
  if (cur === gesture.target) return;
  const change = { kind, r, c, from: cur, to: gesture.target };
  gesture.changes.push(change);
  applyChanges([change], 'forward');
  refresh();
}

function onEdgePress(kind, r, c) {
  const cur = getEdge(state.puzzle, state.edges, kind, r, c);
  gesture = { type: 'edge', target: nextMark(cur), touched: new Set(), changes: [] };
  paintEdge(kind, r, c);
}

function onEdgeEnter(kind, r, c) {
  if (gesture?.type === 'edge') paintEdge(kind, r, c);
}

function showCellDrag() {
  board.setDrag(gesture.cells, cellsFormTile(state.puzzle, gesture.cells));
}

function onCellPress(cell) {
  gesture = { type: 'cell', cells: [cell] };
  showCellDrag();
}

function onCellEnter(cell) {
  if (gesture?.type !== 'cell' || gesture.cells.includes(cell)) return;
  gesture.cells.push(cell);
  showCellDrag();
}

function onRelease() {
  const g = gesture;
  gesture = null;
  board.setDrag([], false);
  if (!g) return;

  if (g.type === 'edge') {
    if (g.changes.length) {              // already applied live; record it as one step
      state.undo.push({ changes: g.changes });
      state.redo = [];
      refresh();
    }
    return;
  }

  // Cell drag.
  const { puzzle } = state;
  if (g.cells.length === 1 && tileSize(puzzle.tile) > 1) return;      // just a click on a cell
  if (!cellsFormTile(puzzle, g.cells)) {
    showToast(`Those cells aren't the tile shape (${shapeName(puzzle.tile)}).`, 'info', 2500);
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
  const g = gesture;
  gesture = null;
  board.setDrag([], false);
  if (g?.type === 'edge' && g.changes.length) {
    applyChanges(g.changes, 'backward');
    refresh();
  }
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
  state.redo.push(entry);
  refresh();
}

function redo() {
  const entry = state.redo.pop();
  if (!entry) return;
  applyChanges(entry.changes, 'forward');
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

// Dismiss the hint on screen (toast and highlights) but keep the cycle where it is:
// only a change to the board restarts it, so the next Hint press shows the next hint.
function dismissHint() {
  hideToast();
  board.clearHint();
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
  const marks = state.edges.h.reduce((n, v) => n + (v ? 1 : 0), 0) +
                state.edges.v.reduce((n, v) => n + (v ? 1 : 0), 0);
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
// Pressing Hint again while one is on screen steps to the next hint of the same
// kind (wrapping around). Colors: yellow = the cell(s) the hint is about, blue =
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
    if (items.length) return { tier: rule.hintKind, items, index: 0 };
  }

  if (!solution) return { none: 'No hint available for this puzzle.' };
  const options = crossHints(puzzle, edges, solution);
  if (!options.length) return { none: 'No more hints available.' };
  for (let i = options.length - 1; i > 0; i--) {          // random order
    const j = Math.floor(Math.random() * (i + 1));
    [options[i], options[j]] = [options[j], options[i]];
  }
  return { tier: 'cross', items: options, index: 0 };
}

// Words for why a hypothetical tile fails, from the contradiction reasons of the
// ruled-out tiles: a stranded cell (marked "!" when every tile strands the same
// one), or a region that can't be tiled.
function failureText(item) {
  const size = tileSize(state.puzzle.tile);
  const kinds = new Set(item.alternatives.map(a => a.reason?.kind));
  const stranded = item.sharedDead?.length ? item.sharedDead[0] : null;
  if (stranded !== null && kinds.size === 1 && kinds.has('cell')) return { text: 'the cell marked ! with nowhere to go', marker: stranded };
  if (kinds.size === 1 && kinds.has('size')) return { text: `a walled-off pocket whose size is not a multiple of ${size}`, marker: null };
  if (kinds.size === 1 && kinds.has('parity')) return { text: 'a walled-off pocket whose black and white squares (as on a chessboard) can\'t be tiled', marker: null };
  return { text: 'some cell with nowhere to go, or a pocket that can\'t be tiled', marker: null };
}

// Display the current item of a hint set.
function displayHint(h) {
  const { puzzle } = state;
  const item = h.items[h.index];
  const label = 'Hint';
  let text;

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
  } else if (h.tier === 'lookahead2' || h.tier === 'lookahead3') {
    const why = failureText(item);
    board.showHint({ target: [item.cell], lines: item.lines, marker: why.marker });
    text = h.tier === 'lookahead2'
      ? `the yellow cell has just two possible tiles, and one of them would leave ${why.text}. Draw the dashed outline of the other one.`
      : `the yellow cell has ${item.ruledOut + 1} possible tiles, but every one except the dashed one would leave ${why.text}. Draw the dashed outline.`;
  } else if (h.tier === 'chain') {
    board.showHint({ target: [item.cell], lines: item.lines });
    text = `the yellow cell has ${item.ruledOut + 1} possible tiles. Try any tile except the dashed one and follow what it forces` +
      `${item.maxSteps ? ` (up to ${item.maxSteps} ${item.maxSteps === 1 ? 'step' : 'steps'})` : ''}: it always ends in a contradiction. Draw the dashed outline.`;
  } else {
    const [kind, r, c] = item;
    board.showHint({ target: edgeCells(puzzle, kind, r, c), crosses: [item] });
    text = "no logical inference is available right now, so here's a peek at the answer: the two yellow cells belong to the same tile. Mark the edge between them with a ✕.";
  }
  showToast(`${label}: ${text}`, 'hint', HINT_TOAST_MS);
}

function hint() {
  if (analyze(state.puzzle, state.edges).solved) { showToast('Already solved!', 'success'); return; }
  if (state.hint) {
    state.hint.index = (state.hint.index + 1) % state.hint.items.length;   // next of the same kind
  } else {
    const found = findHints();
    if (found.none) { showToast(found.none, 'info'); return; }
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
  // remembered only once a move is finished: a drag that is cancelled with Esc must not count
  if (a.solved && !gesture) store.set(solvedKey(state.puzzle), '1');

  const set = curSet();
  const hasMarks = state.edges.h.some(Boolean) || state.edges.v.some(Boolean);

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
    st.textContent = `${a.validCount} / ${a.total} tiles`;
  }
}

// --- Browse puzzles -----------------------------------------------------------
// A grid of the current book's puzzles, grouped under their difficulty tier and coloured
// by status: solved (green), in progress (yellow, some marks saved), current (blue ring).
let closeBrowse = () => {};   // set in bindControls
function renderBrowse() {
  const set = curSet(), puzzles = set.puzzles ?? [];
  const grid = $('browse-grid');
  grid.textContent = '';
  const solved = puzzles.filter(isSolved).length;
  const name = set.custom ? set.title : `${shapeName(set.tile)}, ${set.rows}×${set.cols}`;
  $('browse-summary').textContent = `${name}: ${solved} of ${puzzles.length} solved`;

  let tier = null;
  puzzles.forEach((p, i) => {
    if (p.tier && p.tier !== tier) {
      tier = p.tier;
      const info = TIER_INFO[tier];
      const head = document.createElement('div');
      head.className = 'browse-tier-header';
      const nameEl = document.createElement('span');
      nameEl.className = 'browse-tier-name';
      nameEl.textContent = info?.name ?? tier;
      head.append(nameEl);
      if (info?.blurb) {
        const blurb = document.createElement('span');
        blurb.className = 'browse-tier-blurb';
        blurb.textContent = info.blurb;
        head.append(blurb);
      }
      grid.append(head);
    }
    const done = isSolved(p), started = !done && hasProgress(p);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'browse-tile' + (done ? ' bt-solved' : started ? ' bt-in-progress' : '') + (i === state.puzIdx ? ' bt-current' : '');
    b.textContent = i + 1;
    b.setAttribute('aria-label', `Puzzle ${i + 1}${done ? ' (solved)' : started ? ' (in progress)' : ''}`);
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
  const sel = $('print-selection'), perPageSel = $('print-per-page'), keyBox = $('print-answer-key');
  const err = $('print-error'), summary = $('print-summary'), go = $('print-go-btn');
  const savedPer = store.get('pp_printPerPage');
  if ([...perPageSel.options].some(o => o.value === savedPer)) perPageSel.value = savedPer;
  keyBox.checked = store.get('pp_printKey') !== '0';

  const update = () => {
    const puzzles = curSet().puzzles ?? [];
    const { ids, error } = parseSelection(sel.value, puzzles.length);
    err.hidden = !error;
    err.textContent = error ?? '';
    go.disabled = Boolean(error);
    if (error) { summary.textContent = ''; return null; }
    const perPage = Number(perPageSel.value);
    const keyIds = ids.filter(id => solutionFor(puzzles[id - 1]));
    const plan = planPrint({ count: ids.length, perPage, includeKey: keyBox.checked && keyIds.length > 0 });
    const pages = n => `${n} page${n === 1 ? '' : 's'}`;
    summary.textContent = `${ids.length} puzzle${ids.length === 1 ? '' : 's'}, ${perPage} per page: ${pages(plan.puzzlePages)}` +
      (plan.keyPages ? ` + ${pages(plan.keyPages)} of answers.` : '.');
    return { ids, puzzles, perPage };
  };

  setupModal('print-modal', 'print-btn', () => {
    hideSettings();
    const set = curSet(), total = (set.puzzles ?? []).length;
    $('print-book-name').textContent = set.custom ? set.title : `${shapeName(set.tile)}, ${set.rows}×${set.cols}`;
    $('print-book-total').textContent = total;
    sel.value = total <= 1 ? '1' : `1-${Math.min(total, 10)}`;
    update();
    // focus the field for keyboard users, but not on a phone, where it would pop the keyboard up
    if (matchMedia('(pointer: fine)').matches) setTimeout(() => { sel.focus(); sel.select(); }, 0);
  });
  sel.addEventListener('input', update);
  perPageSel.addEventListener('change', () => { store.set('pp_printPerPage', perPageSel.value); update(); });
  keyBox.addEventListener('change', () => { store.set('pp_printKey', keyBox.checked ? '1' : '0'); update(); });
  go.addEventListener('click', () => {
    const r = update();
    if (!r) return;
    buildPrintRoot({ book: curSet(), puzzles: r.puzzles, ids: r.ids, perPage: r.perPage, includeKey: keyBox.checked, solutionOf: solutionFor });
    document.body.classList.add('printing-booklet');     // style.css prints only the booklet while this is set
    window.print();
  });
}

// --- Controls ---------------------------------------------------------------
// Cell-count groups for the shape menu.
const SHAPE_GROUPS = [[3, 'Trominoes'], [4, 'Tetrominoes'], [5, 'Pentominoes']];
const shapeGroup = tile => SHAPE_GROUPS.find(([max]) => tileSize(tile) <= max)[1];

// Two pickers: the shape (grouped by cell count; files loaded from disk get their
// own group) and the board size for that shape. Only combinations that have a
// book appear.
function renderPickers() {
  const sel = $('shape-select');
  sel.textContent = '';
  const groups = new Map();
  const add = (groupName, value, label) => {
    if (!groups.has(groupName)) {
      const g = document.createElement('optgroup');
      g.label = groupName;
      groups.set(groupName, g);
    }
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    groups.get(groupName).appendChild(o);
  };
  const tiles = [...new Set(state.sets.filter(s => !s.custom).map(s => s.tile))]
    .sort((a, b) => SHAPE_ORDER.indexOf(a) - SHAPE_ORDER.indexOf(b));
  tiles.forEach(t => add(shapeGroup(t), t, shapeName(t)));
  state.sets.forEach((s, i) => { if (s.custom) add('Loaded from file', `custom:${i}`, s.title); });
  for (const g of groups.values()) sel.appendChild(g);
}

// Show the current set in the pickers (and list the sizes available for its shape).
function syncPickers() {
  const set = curSet();
  const shapeSel = $('shape-select'), sizeSel = $('size-select');
  shapeSel.value = set.custom ? `custom:${state.setIdx}` : set.tile;
  sizeSel.textContent = '';
  const siblings = set.custom ? [state.setIdx]
    : state.sets.map((s, i) => i).filter(i => !state.sets[i].custom && state.sets[i].tile === set.tile)
        .sort((a, b) => state.sets[a].rows - state.sets[b].rows);
  for (const i of siblings) {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = state.sets[i].custom ? 'all puzzles' : `${state.sets[i].rows}×${state.sets[i].cols}`;
    sizeSel.appendChild(o);
  }
  sizeSel.value = String(state.setIdx);
  sizeSel.disabled = siblings.length < 2;
}

// Switching shape keeps the board size if that shape has it, else the nearest.
function pickShape(value) {
  if (value.startsWith('custom:')) { goTo(+value.slice(7), 0); return; }
  const cur = curSet();
  const options = state.sets.map((s, i) => i).filter(i => !state.sets[i].custom && state.sets[i].tile === value);
  const want = cur.rows;
  options.sort((a, b) => Math.abs(state.sets[a].rows - want) - Math.abs(state.sets[b].rows - want));
  goTo(options[0], 0);
}

function bindControls() {
  $('prev-puz').addEventListener('click', () => step(-1));
  $('next-puz').addEventListener('click', () => step(1));
  $('shape-select').addEventListener('change', e => pickShape(e.target.value));
  $('size-select').addEventListener('change', e => goTo(+e.target.value, 0));
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
  const browse = setupModal('browse-modal', 'browse-btn', renderBrowse);
  closeBrowse = browse.close;
  setupPrint(setupModal, settings.close);
  $('browse-jump-btn').addEventListener('click', () => {
    const i = (curSet().puzzles ?? []).findIndex(p => !isSolved(p));
    if (i < 0) { showToast("You've solved every puzzle in this book! 🎉", 'success', 3000); return; }
    browse.close();
    goTo(state.setIdx, i);
  });
  const help = setupModal('help-modal', 'help-btn');
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
      state.sets.push({ id: `custom:${file.name}`, custom: true, title: `📄 ${file.name}`, tile: puzzles[0].tile, rows: puzzles[0].rows, cols: puzzles[0].cols, puzzles });
      renderPickers();
      $('settings-modal').classList.add('modal-hidden');
      await goTo(state.sets.length - 1, 0);
    } catch (err) {
      $('settings-modal').classList.add('modal-hidden');
      showToast(`Couldn't load ${file.name}: ${err.message}`, 'error', 4000);
    }
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
