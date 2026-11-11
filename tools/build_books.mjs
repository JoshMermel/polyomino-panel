// Build the books in data/ from the puzzle pools in tools/library/, following
// tools/books/collections.json.
//
//   node tools/build_books.mjs                 stage every book in tools/books_staging/ and print a report
//   node tools/build_books.mjs --promote       ...and copy them into data/ (replacing the old books) + rewrite manifest.json
//   node tools/build_books.mjs --list          what the pools can supply for each book, by tier
//   --seed N                                   tie-break seed (default 1; builds are deterministic for a seed)
//   --fresh                                    ignore the books already in data/ (default: keep their puzzles, see below)
//   --trim                                     also trim shapes whose weight is below 1 down to their share (drops published
//                                              puzzles of those shapes; use after lowering a shapeWeight). Other shapes only grow.
//
// There is one book per (number of tile shapes, board size): "One shape" and "Two shapes", each on
// 6x6, 8x8 and 10x10 boards. A book runs through every difficulty tier (Beginner, Medium, Hard, Expert; see
// js/rating.js), easiest first. How a book is made:
//   1. The book's size is split over the tiers in proportion to their weights (tierWeights in
//      collections.json: Beginner counts half, so a book is about 20% Beginner, 40% Medium, 40% Hard),
//      and a tier with too few puzzles gives up what it can't fill, the others sharing the difference.
//      The 6x6 tour's puzzles count toward its Beginner share.
//   2. Within a tier the puzzles are shared out over the shapes (or pairs) that have puzzles of that tier,
//      in proportion to their weights (shapeWeights in collections.json; 1 unless listed, so evenly; shapeBoost
//      multiplies the weight of every shape or pair that contains a favourite shape),
//      again with the shortfall passed on; each such shape gets at least one.
//   3. Within a shape, puzzles are taken at evenly spaced ranks of their score (pickQuantiles), so a
//      book follows the pool's own spread of difficulty from its easy end to its hard end. Sparse puzzles
//      (few blocked cells) are preferred: the pick only looks at the sparsest `sparseShare` (default half) of
//      a shape's puzzles in that tier, as long as that leaves at least three times the number needed.
//   3a. A tier holds at most `maxLineShare` (a fraction of its share) of line-piece puzzles (domino, I tromino, I tetromino,
//      I pentomino), and the local reshuffle (step 4) treats them as one kind so they never run in a row.
//   3b. Puzzles the hint rules cannot finish are their own tier, Expert, so each book's share of them is set by tierWeights.
//   4. The book is sorted by tier, then score, and then reshuffled locally (spreadByTier in lib/pick.mjs) so the
//      same shape doesn't come up again and again: each puzzle moves only a little, within its tier. One book can start with a shape-by-shape "tour" of
//      easy puzzles (the `tour` entry in collections.json), which comes before the rest.
// Ties (equal scores or sparseness) are broken by a hash of the puzzle's content salted with --seed, not by its name
// or its place in a pool, as in star battle's builder, so rescoring or growing a pool disturbs only the puzzles
// that changed. A puzzle published in one book is never taken by another book, and a published puzzle stays a
// candidate whatever the sparseness slice or the beyond-hints cap would otherwise do: a rebuild only ever adds.
// A rebuild is STABLE: every puzzle already published in data/ stays (pickStable with keepAll), and only
// the gaps in the shares are filled, so adding a shape or growing a book never reshuffles it and
// players keep their progress. The book size in collections.json is therefore a floor: a book can end
// up a little larger when kept puzzles exceed a share. (--fresh picks everything from scratch, which
// is how to trim a book or drop a shape.)
// A group with `maxBlocked` (a fraction of the board, e.g. 0.17) is a "sparse" group: its books only
// take puzzles with that few blocked cells. Such books are built before the others, so they get first
// pick of the sparse puzzles, but they stay in the manifest in the order collections.json lists them.
// Every puzzle is in at most one book. Never published: puzzles whose open cells are not one
// connected region (logic.openCellsConnected) and puzzles whose solution's tile boundaries contain a
// swastika pattern (logic.hasSwastika). The pools to draw from are the shapes and sizes in recipes.json.
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync, rmSync,
} from 'node:fs';
import { parseCsv, toCsv, solveWithGivens, tileSpecs, hasSwastika, openCellsConnected, puzzleHash } from '../js/logic.js';
import { TIERS, TIER_INFO } from '../js/rating.js';
import { canonicalGrid } from '../js/generator.js';
import { pickStable, weightedAllocation, spreadByTier, byScoreThenTie, tieHash } from './lib/pick.mjs';
import { LINEAR } from './lib/tile_weights.mjs';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter(a => a.startsWith('--')));
const seedIdx = argv.indexOf('--seed');
const seed = seedIdx >= 0 ? Number(argv[seedIdx + 1]) : 1;
const fresh = flags.has('--fresh');
const trim = flags.has('--trim');

const root = new URL('..', import.meta.url);
// What the local reshuffle keeps apart: the line pieces (domino, I tromino, I tetromino, I pentomino) count as ONE
// kind, so a book never runs a stretch of them even though each is a different shape.
const spreadKey = p => (LINEAR.has(p.tile) ? 'line' : p.tile);
const recipes = JSON.parse(readFileSync(new URL('tools/books/recipes.json', root), 'utf8'));
const config = JSON.parse(readFileSync(new URL('tools/books/collections.json', root), 'utf8'));
const libDir = new URL('tools/library/', root), stageDir = new URL('tools/books_staging/', root), dataDir = new URL('data/', root);
mkdirSync(stageDir, { recursive: true });
for (const t of config.tiers) if (!TIERS.includes(t)) throw new Error(`collections.json: unknown tier ${t}`);

// --- What is published now (for stable rebuilds) -----------------------------------------------
const published = new Map();           // book id -> Set of puzzle hashes
if (!fresh && existsSync(new URL('manifest.json', dataDir))) {
  const old = JSON.parse(readFileSync(new URL('manifest.json', dataDir), 'utf8'));
  for (const b of old.books) {
    const f = new URL(b.file, dataDir);
    if (existsSync(f)) published.set(b.id, new Set(parseCsv(readFileSync(f, 'utf8')).map(puzzleHash)));
  }
}
const hashOf = p => (p._hash ??= puzzleHash(p));
// Which book already publishes each puzzle: another book must not take it (the sparse books are built first
// and would otherwise pick up sparse-enough puzzles that another book publishes, which then loses them).
const owner = new Map();
for (const [id, set] of published) for (const h of set) if (!owner.has(h)) owner.set(h, id);
// Ties (equal scores, equal sparseness) are broken by a hash of the puzzle's CONTENT salted with the seed, as in
// star battle's builder, so they depend on nothing else: not the pool's order or size, not the puzzle's name.
const byTie = (a, b) => tieHash(a, hashOf, seed) - tieHash(b, hashOf, seed) || (hashOf(a) < hashOf(b) ? -1 : 1);
const byScore = byScoreThenTie(hashOf, seed);

// --- The pools -------------------------------------------------------------------------------
const pool = [];                       // every puzzle that may be published
for (const tile of recipes.shapes) {
  for (const size of [...recipes.sizes, ...(recipes.extraSizes ?? [])]) {          // extraSizes: the small boards of the Intro book
    const f = new URL(`${tile}_${size}x${size}.csv`, libDir);
    if (!existsSync(f)) continue;
    for (const p of parseCsv(readFileSync(f, 'utf8'))) {
      if (openCellsConnected(p) && !hasSwastika(p, p.solution)) pool.push(p);
    }
  }
}
// Triples (three shapes joined with +) are not listed in recipes.json: every library pool named with three shapes counts.
for (const name of readdirSync(libDir)) {
  const m = name.match(/^([^_]+\+[^_]+\+[^_]+)_(\d+)x\2\.csv$/);
  if (!m || ![...recipes.sizes, ...(recipes.extraSizes ?? [])].includes(Number(m[2]))) continue;
  for (const p of parseCsv(readFileSync(new URL(name, libDir), 'utf8'))) {
    if (openCellsConnected(p) && !hasSwastika(p, p.solution)) pool.push(p);
  }
}
// Hand-assembled books (the Experiments, from files in tools/books/) are copied as they are, so the pool
// books must not take a puzzle those hold (the same board up to rotation or mirror, with the same tile).
// Boards with given edges are different puzzles even on the same layout, so only plain boards are reserved.
const boardKey = p => `${p.tile}|${canonicalGrid(p.grid, p.rows, p.cols, p.tile)}`;
const reserved = new Set();
for (const g of config.groups) {
  if (!g.source) continue;
  for (const p of parseCsv(readFileSync(new URL(`tools/books/${g.source}`, root), 'utf8'))) if (!p.givens?.length) reserved.add(boardKey(p));
}
for (let i = pool.length - 1; i >= 0; i--) if (reserved.has(boardKey(pool[i]))) pool.splice(i, 1);
const shapeCount = p => tileSpecs(p.tile).length;

// The books, in order. A group's perBook (or the global one) is a number or an object by board size.
const bookSize = (g, size) => {
  const n = g.perBook ?? config.perBook;
  return typeof n === 'object' ? n[size] : n;
};
const specs = [];
for (const g of config.groups) {
  const common = { group: g.name, title: g.title ?? g.name, label: g.label ?? g.name, blurb: g.blurb ?? '', order: specs.length };
  if (g.source) {                       // a hand-assembled book: a file in tools/books/ copied as it is
    specs.push({ ...common, id: g.idPrefix, source: g.source, count: 0 });
    continue;
  }
  if (g.sizes) {                        // one book mixing several board sizes (the Intro book)
    specs.push({ ...common, id: g.idPrefix, shapes: g.shapes, sizes: g.sizes, tierList: g.tiers ?? config.tiers, maxScore: g.maxScore ?? null,
      sizeWeights: g.sizeWeights ?? {}, count: g.perBook, maxBlocked: null, sparseShare: 1, first: true });
    continue;
  }
  for (const size of g.boardSizes ?? config.sizes) {          // a group may add sizes (the sparse books also have a 12x12)
    specs.push({
      id: `${g.idPrefix}-${size}`, group: g.name, shapes: g.shapes, size,
      title: `${g.name} · ${size}×${size}`, label: `${size}×${size}`,
      blurb: config.sizeBlurbs?.[size] ?? '', count: bookSize(g, size), maxBlocked: g.maxBlocked ?? null,
      tierMaxBlocked: g.tierMaxBlocked ?? null, tierWeights: g.tierWeights ?? config.tierWeights,
      sparseShare: g.sparseShare ?? config.sparseShare ?? 1, order: specs.length,
    });
  }
}

// Siblings: two puzzles with the same tile spec whose blocked cells differ in at most `minBoardDistance` (a share of
// the board's cells, 0.08 = 5 cells on 8x8) after any rotation or reflection, or that share many tiles (below). The generator and the hunter make families
// of these, and a book that holds several looks repetitive, so a book keeps only one of a family.
const SYM = [(r, c, n) => [r, c], (r, c, n) => [c, n - 1 - r], (r, c, n) => [n - 1 - r, n - 1 - c], (r, c, n) => [n - 1 - c, r]];
const blockedSyms = p => p._syms ??= SYM.flatMap(t => [false, true].map(flip => {
  const n = p.rows, out = new Uint8Array(n * n);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) { const [rr, cc] = t(r, flip ? n - 1 - c : c, n); out[r * n + c] = p.grid[rr * n + cc] === '#' ? 1 : 0; }
  return out;
}));
const blockedBase = p => p._blockedBase ??= Uint8Array.from(p.grid, c => (c === '#' ? 1 : 0));
// The other measure: how many of one solution's tiles sit exactly where a tile of the other solution does (after any
// rotation or reflection of the board). Two puzzles sharing more than `sharedTileShare[size]` of their tiles are siblings.
const tileSyms = p => p._tileSyms ??= SYM.flatMap(t => [false, true].map(flip => {
  const n = p.rows, groups = new Map();
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const ch = p.solution[r * n + c];
    if (ch === '#') continue;
    const [rr, cc] = t(r, flip ? n - 1 - c : c, n);
    if (!groups.has(ch)) groups.set(ch, []);
    groups.get(ch).push(rr * n + cc);
  }
  return new Set([...groups.values()].map(cells => cells.sort((x, y) => x - y).join(',')));
}));
const sharedTiles = (a, b) => {
  const x = tileSyms(a)[0];
  let best = 0;
  for (const y of tileSyms(b)) { let k = 0; for (const key of x) if (y.has(key)) k++; best = Math.max(best, k); }
  return best / Math.min(x.size, tileSyms(b)[0].size);
};
const isSibling = (a, b) => {
  if (a.tile !== b.tile || a.rows !== b.rows || a.cols !== b.cols || a.givens?.length || b.givens?.length) return false;
  if (config.minBoardDistance != null) {
    const max = Math.floor(config.minBoardDistance * a.rows * a.cols), x = blockedBase(a);
    if (blockedSyms(b).some(y => { let d = 0; for (let i = 0; i < x.length && d <= max; i++) d += x[i] !== y[i]; return d <= max; })) return true;
  }
  const share = config.sharedTileShare?.[a.rows];
  if (a.tier === 'Beginner' && b.tier === 'Beginner') return false;       // forced-move puzzles repeat their tiles by nature
  return share != null && sharedTiles(a, b) >= share;
};
// `list` without the puzzles that are siblings of an earlier one, or of any in `against`
const dropSiblings = (list, against = []) => {
  const keep = [];
  for (const p of list) if (!against.some(q => isSibling(p, q)) && !keep.some(q => isSibling(p, q))) keep.push(p);
  return keep;
};
const blockedFraction = p => (p._blocked ??= [...p.grid].filter(c => c === '#').length / p.grid.length);
const eligible = (spec, used) => pool.filter(p => shapeCount(p) === spec.shapes && (spec.sizes ? spec.sizes.includes(p.rows) : p.rows === spec.size) && !used.has(p.name) &&
  (!owner.has(hashOf(p)) || owner.get(hashOf(p)) === spec.id) &&
  (spec.maxBlocked == null || blockedFraction(p) <= (spec.tierMaxBlocked?.[p.tier] ?? spec.maxBlocked)) &&
  (spec.tierList == null || spec.tierList.includes(p.tier)) && (spec.maxScore == null || p.score <= spec.maxScore));

if (flags.has('--list')) {
  for (const s of specs.filter(x => !x.source)) {
    const c = eligible(s, new Set());
    console.log(`${s.id.padEnd(8)} wants ${s.count}  can supply ${config.tiers.map(t => `${t} ${c.filter(p => p.tier === t).length}`).join('  ')}`);
  }
  process.exit(0);
}

// --- Building ---------------------------------------------------------------------------------
for (const f of readdirSync(stageDir)) if (f.endsWith('.csv')) rmSync(new URL(f, stageDir));
const used = new Set();                // names of puzzles already in a book
const books = [];

// Share `count` slots over `groups` (an array of candidate arrays) evenly, then take each group's
// share at evenly spaced score ranks.
const weightOf = tile => (config.shapeWeights?.[tile] ?? 1) * Math.max(1, ...tile.split('+').map(s => config.shapeBoost?.[s] ?? 1));
function pickAcross(groups, count, isKept, sparseShare = 1) {
  const alloc = weightedAllocation(count, groups.map(g => g.length), groups.map(g => weightOf(g[0].tile)));
  // every shape that has puzzles in this tier gets at least one slot (taken from the biggest share), so a
  // small share (the Beginner tier of a book) doesn't starve the down-weighted shapes out of the book
  if (count >= groups.length) {
    for (let i = 0; i < alloc.length; i++) {
      if (alloc[i] > 0) continue;
      const big = alloc.indexOf(Math.max(...alloc));
      if (alloc[big] > 1) { alloc[big]--; alloc[i] = 1; }
    }
  }
  // prefer sparse puzzles: look only at the sparsest share of each group, keeping at least 3x what it must give
  const sparsest = (g, n) => {
    const keep = Math.min(g.length, Math.max(Math.ceil(g.length * sparseShare), 3 * n));
    if (keep >= g.length) return g;
    // published puzzles always stay candidates, even if the slice's edge moves (a changed tiebreak, a grown pool)
    const slice = [...g].sort((a, b) => blockedFraction(a) - blockedFraction(b) || byTie(a, b)).slice(0, keep);
    const inSlice = new Set(slice);
    return [...slice, ...g.filter(p => !inSlice.has(p) && isKept(p))];
  };
  // --trim only trims down-weighted shapes; every other shape keeps all its published puzzles
  return groups.flatMap((g0, i) => {
    const g = sparsest(g0, alloc[i]);
    const trimmed = trim && weightOf(g[0].tile) < 1;
    return alloc[i] || !trimmed ? pickStable(g, { count: alloc[i], seed, isKept, keepAll: !trimmed, key: hashOf }).picks : [];
  });
}
// The line pieces (domino, I tromino, I tetromino, I pentomino) are the only shapes that make Beginner puzzles on
// a sparse board, so left alone they would be most of a book's opening. A tier holds at most `maxLineShare` of its
// puzzles in ones whose pieces are all line pieces (so at most share/(1-share) times as many as the others, never
// fewer than 2); the rest is not refilled (the tier is just smaller). Like the shape weights, this only drops
// published puzzles with --trim.
const isLine = p => p.tile.split('+').every(s => LINEAR.has(s));
function capLines(picks, isKept) {
  if (config.maxLineShare == null) return picks;
  const lines = picks.filter(isLine), s = config.maxLineShare;
  const max = Math.max(2, Math.floor(s / (1 - s) * (picks.length - lines.length)));
  if (lines.length <= max) return picks;
  const keep = pickStable(lines, { count: max, seed, isKept, keepAll: !trim, key: hashOf }).picks;
  return [...picks.filter(p => !isLine(p)), ...keep];
}
const byTile = cands => {
  const m = new Map();
  for (const p of cands) { if (!m.has(p.tile)) m.set(p.tile, []); m.get(p.tile).push(p); }
  return [...m.keys()].sort().map(k => m.get(k));
};

const rank = s => (s.first ? 0 : s.maxBlocked != null ? 1 : 2);        // Intro first, then the sparse books, then the rest
const buildOrder = [...specs].sort((a, b) => rank(a) - rank(b) || a.order - b.order);
for (const spec of buildOrder) {
  if (spec.source) {
    const puzzles = parseCsv(readFileSync(new URL(spec.source, new URL('tools/books/', root)), 'utf8'));
    books.push({ order: spec.order, meta: { id: spec.id, group: spec.group, title: spec.title, label: spec.label, blurb: spec.blurb }, puzzles, target: puzzles.length, tourCount: 0, before: undefined });
    continue;
  }
  if (spec.sizes) {                       // the Intro book: shares by board size, then shapes within each size
    const cands = eligible(spec, used);
    const bySize = spec.sizes.map(sz => cands.filter(p => p.rows === sz));
    const alloc = weightedAllocation(spec.count, bySize.map(c => c.length), spec.sizes.map(sz => spec.sizeWeights[sz] ?? 1));
    const before = published.get(spec.id);
    const isKept = before ? (p => before.has(hashOf(p))) : (() => false);
    const picks = bySize.flatMap((c, i) => (alloc[i] ? pickAcross(byTile(c), alloc[i], isKept, 1) : []));
    picks.forEach(p => used.add(p.name));
    picks.sort((a, b) => a.rows - b.rows || byScore(a, b));      // smallest boards first
    const spread = spreadByTier(picks, { tierOf: p => p.rows, key: spreadKey });                  // shapes mixed within a size
    books.push({ order: spec.order, meta: { id: spec.id, group: spec.group, title: spec.title, label: spec.label, blurb: spec.blurb }, puzzles: spread, target: spec.count, tourCount: 0, before });
    continue;
  }
  const before = published.get(spec.id);
  const isKept = before ? (p => before.has(hashOf(p))) : (() => false);
  const tour = [];
  if (config.tour?.book === spec.id) {
    for (const tile of config.tour.shapes) {
      const cands = eligible(spec, used).filter(p => p.tile === tile && p.tier === config.tour.tier);
      const r = pickStable(cands, { count: config.tour.perShape, seed, isKept, key: hashOf });
      if (r.short) console.log(`  ${spec.id} tour: only ${r.picks.length} of ${config.tour.perShape} ${config.tour.tier} puzzles for ${tile}`);
      r.picks.forEach(p => { used.add(p.name); tour.push(p); });
    }
  }

  const cands = eligible(spec, used);
  const perTier = config.tiers.map(t => cands.filter(p => p.tier === t));
  // Expert (the puzzles the hint rules cannot finish) is the same share in every book, never more: when another tier
  // comes up short its slots go to the others, not to Expert.
  const tierSum = config.tiers.reduce((sum, t) => sum + (spec.tierWeights?.[t] ?? 1), 0);
  const tierCap = (t, n) => (t === 'Expert' ? Math.min(n, Math.round(spec.count * (spec.tierWeights?.[t] ?? 1) / tierSum)) : n);
  const alloc = weightedAllocation(spec.count, perTier.map((c, i) => tierCap(config.tiers[i], c.length)), config.tiers.map(t => spec.tierWeights?.[t] ?? 1));
  const tourTier = config.tiers.indexOf(config.tour?.tier);
  if (tour.length && tourTier >= 0) alloc[tourTier] = Math.max(0, alloc[tourTier] - tour.length);   // the tour is part of that tier's share
  let rest = dropSiblings(perTier.flatMap((c, i) => capLines(pickAcross(byTile(c), alloc[i], isKept, spec.sparseShare), isKept)));
  // A tier that comes up short (the line-piece cap leaves Beginner small, a thin pool, dropped siblings) would leave the
  // book under its size, and the main books should all be the same size. Top up from the Medium and Hard tiers, by their
  // weights, with puzzles that are not line pieces (those are what the cap holds back) and not siblings of one already in.
  for (let round = 0; round < 6; round++) {
    const deficit = spec.count - tour.length - rest.length;
    if (deficit <= 0) break;
    const taken = new Set(rest.map(p => p.name));
    const fillTiers = config.tiers.map((t, i) => i).filter(i => ['Medium', 'Hard', 'Expert'].includes(config.tiers[i]));
    const left = fillTiers.map(i => perTier[i].filter(p => !taken.has(p.name) && !isLine(p) && !rest.some(q => isSibling(p, q))));
    // Expert only up to its share (a dropped sibling of an Expert puzzle is replaced by another Expert one, never by more),
    // and first: its share is the same in every book
    const expertK = fillTiers.findIndex(i => config.tiers[i] === 'Expert');
    const room = expertK < 0 ? 0 : Math.max(0, tierCap('Expert', Infinity) - rest.filter(p => p.tier === 'Expert').length);
    const exN = expertK < 0 ? 0 : Math.min(deficit, room, left[expertK].length);
    const others = fillTiers.map((_, k) => (k === expertK ? 0 : left[k].length));
    const extra = weightedAllocation(deficit - exN, others, fillTiers.map(i => spec.tierWeights?.[config.tiers[i]] ?? 1));
    if (expertK >= 0) extra[expertK] = exN;
    const before = rest.length;
    fillTiers.forEach((_, k) => { if (extra[k]) rest = [...rest, ...dropSiblings(pickAcross(byTile(left[k]), extra[k], isKept, spec.sparseShare), rest)]; });
    if (rest.length === before) break;
  }
  rest.forEach(p => used.add(p.name));
  rest.sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) || byScore(a, b));
  const spread = spreadByTier(rest, { key: spreadKey, recent: tour.map(spreadKey) });       // no long runs of one shape
  books.push({ order: spec.order, meta: { id: spec.id, group: spec.group, title: spec.title, label: spec.label, blurb: spec.blurb }, puzzles: [...tour, ...spread], target: spec.count, tourCount: tour.length, before });
}

books.sort((a, b) => a.order - b.order);          // manifest order = collections.json order

// --- Checks, files, report ---------------------------------------------------------------------
const seenKeys = new Set();
for (const b of books) {
  for (const p of b.puzzles) {
    // every published puzzle must still have exactly its stored solution
    const sols = solveWithGivens(p, 2);
    if (sols.length !== 1 || sols[0] !== p.solution) throw new Error(`${b.meta.id}: ${p.name} is not uniquely solvable`);
    // (a board with given edges is a different puzzle: the clue books reuse near-empty boards)
    const key = p.givens?.length ? puzzleHash(p) : `${p.tile}|${canonicalGrid(p.grid, p.rows, p.cols, p.tile)}`;
    if (seenKeys.has(key)) throw new Error(`${b.meta.id}: duplicate puzzle ${p.name}`);
    seenKeys.add(key);
  }
  const pad = Math.max(2, String(b.puzzles.length).length);
  const book = b.puzzles.map((p, i) => ({ ...p, name: `${b.meta.id}_${String(i + 1).padStart(pad, '0')}` }));
  const header = `# ${b.meta.title}. Built by tools/build_books.mjs from a pool of ${pool.length} puzzles (seed ${seed}).\n` +
    '# grid: # = blocked cell, . = open cell. solution: tile labels, # = blocked. The tile column lists the allowed shapes (joined with +).\n' +
    `# rules: hardest deduction rule needed; tier: its difficulty tier; score: finer difficulty. ${b.tourCount ? `The first ${b.tourCount} puzzles are a shape-by-shape tour; the rest are ` : 'Sorted '}by tier, then (roughly) score; shapes are mixed locally so they don't repeat.\n`;
  writeFileSync(new URL(`${b.meta.id}.csv`, stageDir), header + toCsv(book));
  b.meta.file = `${b.meta.id}.csv`;
  b.meta.count = book.length;

  const rest = b.puzzles.slice(b.tourCount);
  const tiers = config.tiers.map(t => `${TIER_INFO[t].name} ${b.puzzles.filter(p => p.tier === t).length}`).join('  ');
  const shapes = new Set(b.puzzles.map(p => p.tile));
  const sc = t => { const s = rest.filter(p => p.tier === t).map(p => p.score); return s.length ? `${Math.min(...s)}..${Math.max(...s)}` : '-'; };
  const keptNow = b.before ? b.puzzles.filter(p => b.before.has(hashOf(p))).length : 0;
  console.log(`[${b.meta.id}] ${book.length}/${b.target}  ${tiers}  | ${shapes.size} shape sets${b.tourCount ? `, tour ${b.tourCount}` : ''}` +
    `${b.before ? `  | kept ${keptNow} of ${b.before.size} published (${b.before.size - keptNow} dropped, ${book.length - keptNow} new)` : ''}\n` +
    `    scores: ${config.tiers.map(t => `${TIER_INFO[t].name} ${sc(t)}`).join('  ')}`);
}

if (flags.has('--promote')) {
  for (const f of readdirSync(dataDir)) if (f.endsWith('.csv')) rmSync(new URL(f, dataDir));    // the previous books
  for (const b of books) copyFileSync(new URL(b.meta.file, stageDir), new URL(b.meta.file, dataDir));
  const manifest = {
    default: config.default,
    groups: config.groups.map(g => ({ name: g.name, blurb: g.blurb, ...(g.secondary ? { secondary: true } : {}) })),
    books: books.map(b => b.meta),
  };
  writeFileSync(new URL('manifest.json', dataDir), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`promoted ${books.length} books to data/ (${books.reduce((n, b) => n + b.meta.count, 0)} puzzles)`);
} else {
  console.log(`staged ${books.length} books in tools/books_staging/ (add --promote to publish)`);
}
