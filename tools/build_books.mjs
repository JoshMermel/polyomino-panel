// Build the books in data/ from the puzzle pools in tools/library/, following
// tools/books/collections.json.
//
//   node tools/build_books.mjs                 stage every book in tools/books_staging/ and print a report
//   node tools/build_books.mjs --promote       ...and copy them into data/ (replacing the old books) + rewrite manifest.json
//   node tools/build_books.mjs --list          what the pools can supply for each book, by tier
//   --seed N                                   tie-break seed (default 1; builds are deterministic for a seed)
//
// There is one book per (number of tile shapes, board size): "One shape" and "Two shapes", each on
// 6x6, 8x8 and 10x10 boards. A book runs through every difficulty tier (Beginner, Medium, Hard; see
// js/rating.js), easiest first. How a book is made:
//   1. The tier shares are even: the book's size is split equally over the tiers, and a tier with
//      too few puzzles gives up what it can't fill, the others sharing the difference.
//   2. Within a tier the puzzles are shared out as evenly as possible over the shapes (or pairs) that
//      have puzzles of that tier, again with the shortfall passed on.
//   3. Within a shape, puzzles are taken at evenly spaced ranks of their score (pickQuantiles), so a
//      book follows the pool's own spread of difficulty from its easy end to its hard end.
//   4. The book is sorted by tier, then score. One book can start with a shape-by-shape "tour" of
//      easy puzzles (the `tour` entry in collections.json), which comes before the rest.
// Every puzzle is in at most one book. Never published: puzzles whose open cells are not one
// connected region (logic.openCellsConnected) and puzzles whose solution's tile boundaries contain a
// swastika pattern (logic.hasSwastika). The pools to draw from are the shapes and sizes in recipes.json.
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync, rmSync,
} from 'node:fs';
import { parseCsv, toCsv, solve, tileSpecs, hasSwastika, openCellsConnected } from '../js/logic.js';
import { TIERS, TIER_INFO, beyondHints } from '../js/rating.js';
import { canonicalGrid } from '../js/generator.js';
import { pickQuantiles, evenAllocation } from './lib/pick.mjs';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter(a => a.startsWith('--')));
const seedIdx = argv.indexOf('--seed');
const seed = seedIdx >= 0 ? Number(argv[seedIdx + 1]) : 1;

const root = new URL('..', import.meta.url);
const recipes = JSON.parse(readFileSync(new URL('tools/books/recipes.json', root), 'utf8'));
const config = JSON.parse(readFileSync(new URL('tools/books/collections.json', root), 'utf8'));
const libDir = new URL('tools/library/', root), stageDir = new URL('tools/books_staging/', root), dataDir = new URL('data/', root);
mkdirSync(stageDir, { recursive: true });
for (const t of config.tiers) if (!TIERS.includes(t)) throw new Error(`collections.json: unknown tier ${t}`);

// --- The pools -------------------------------------------------------------------------------
const pool = [];                       // every puzzle that may be published
for (const tile of recipes.shapes) {
  for (const size of recipes.sizes) {
    const f = new URL(`${tile}_${size}x${size}.csv`, libDir);
    if (!existsSync(f)) continue;
    for (const p of parseCsv(readFileSync(f, 'utf8'))) {
      if (openCellsConnected(p) && !hasSwastika(p, p.solution)) pool.push(p);
    }
  }
}
const shapeCount = p => tileSpecs(p.tile).length;

// The books, in order.
const specs = [];
for (const g of config.groups) {
  for (const size of config.sizes) {
    specs.push({
      id: `${g.idPrefix}-${size}`, group: g.name, shapes: g.shapes, size,
      title: `${g.name} · ${size}×${size}`, label: `${size}×${size}`,
      blurb: config.sizeBlurbs?.[size] ?? '', count: config.perBook,
    });
  }
}

const eligible = (spec, used) => pool.filter(p => shapeCount(p) === spec.shapes && p.rows === spec.size && !used.has(p.name));

if (flags.has('--list')) {
  for (const s of specs) {
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
function pickAcross(groups, count) {
  const alloc = evenAllocation(count, groups.map(g => g.length));
  return groups.flatMap((g, i) => (alloc[i] ? pickQuantiles(g, { count: alloc[i], seed }).picks : []));
}
const byTile = cands => {
  const m = new Map();
  for (const p of cands) { if (!m.has(p.tile)) m.set(p.tile, []); m.get(p.tile).push(p); }
  return [...m.keys()].sort().map(k => m.get(k));
};

for (const spec of specs) {
  const tour = [];
  if (config.tour?.book === spec.id) {
    for (const tile of config.tour.shapes) {
      const cands = eligible(spec, used).filter(p => p.tile === tile && p.tier === config.tour.tier);
      const r = pickQuantiles(cands, { count: config.tour.perShape, seed });
      if (r.short) console.log(`  ${spec.id} tour: only ${r.picks.length} of ${config.tour.perShape} ${config.tour.tier} puzzles for ${tile}`);
      r.picks.forEach(p => { used.add(p.name); tour.push(p); });
    }
  }

  const cands = eligible(spec, used);
  const perTier = config.tiers.map(t => cands.filter(p => p.tier === t));
  const alloc = evenAllocation(spec.count - tour.length, perTier.map(c => c.length));
  const rest = perTier.flatMap((c, i) => pickAcross(byTile(c), alloc[i]));
  rest.forEach(p => used.add(p.name));
  rest.sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) || a.score - b.score || (a.name < b.name ? -1 : 1));
  books.push({ meta: { id: spec.id, group: spec.group, title: spec.title, label: spec.label, blurb: spec.blurb }, puzzles: [...tour, ...rest], target: spec.count, tourCount: tour.length });
}

// --- Checks, files, report ---------------------------------------------------------------------
const seenKeys = new Set();
for (const b of books) {
  for (const p of b.puzzles) {
    // every published puzzle must still have exactly its stored solution
    const sols = solve(p, 2);
    if (sols.length !== 1 || sols[0] !== p.solution) throw new Error(`${b.meta.id}: ${p.name} is not uniquely solvable`);
    const key = `${p.tile}|${canonicalGrid(p.grid, p.rows, p.cols)}`;
    if (seenKeys.has(key)) throw new Error(`${b.meta.id}: duplicate puzzle ${p.name}`);
    seenKeys.add(key);
  }
  const pad = Math.max(2, String(b.puzzles.length).length);
  const book = b.puzzles.map((p, i) => ({ ...p, name: `${b.meta.id}_${String(i + 1).padStart(pad, '0')}` }));
  const header = `# ${b.meta.title}. Built by tools/build_books.mjs from a pool of ${pool.length} puzzles (seed ${seed}).\n` +
    '# grid: # = blocked cell, . = open cell. solution: tile labels, # = blocked. The tile column lists the allowed shapes (joined with +).\n' +
    `# rules: hardest deduction rule needed; tier: its difficulty tier; score: finer difficulty. ${b.tourCount ? `The first ${b.tourCount} puzzles are a shape-by-shape tour; the rest are ` : 'Sorted '}by tier, then score.\n`;
  writeFileSync(new URL(`${b.meta.id}.csv`, stageDir), header + toCsv(book));
  b.meta.file = `${b.meta.id}.csv`;
  b.meta.count = book.length;

  const rest = b.puzzles.slice(b.tourCount);
  const tiers = config.tiers.map(t => `${TIER_INFO[t].name} ${b.puzzles.filter(p => p.tier === t).length}`).join('  ');
  const shapes = new Set(b.puzzles.map(p => p.tile));
  const hard = rest.filter(p => p.tier === 'Hard');
  const sc = t => { const s = rest.filter(p => p.tier === t).map(p => p.score); return s.length ? `${Math.min(...s)}..${Math.max(...s)}` : '-'; };
  console.log(`[${b.meta.id}] ${book.length}/${b.target}  ${tiers}  | ${shapes.size} shape sets${b.tourCount ? `, tour ${b.tourCount}` : ''}  | beyond hints ${hard.filter(beyondHints).length}/${hard.length} of Hard\n` +
    `    scores: ${config.tiers.map(t => `${TIER_INFO[t].name} ${sc(t)}`).join('  ')}`);
}

if (flags.has('--promote')) {
  for (const f of readdirSync(dataDir)) if (f.endsWith('.csv')) rmSync(new URL(f, dataDir));    // the previous books
  for (const b of books) copyFileSync(new URL(b.meta.file, stageDir), new URL(b.meta.file, dataDir));
  const manifest = {
    default: config.default,
    groups: config.groups.map(g => ({ name: g.name, blurb: g.blurb })),
    books: books.map(b => b.meta),
  };
  writeFileSync(new URL('manifest.json', dataDir), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`promoted ${books.length} books to data/ (${books.reduce((n, b) => n + b.meta.count, 0)} puzzles)`);
} else {
  console.log(`staged ${books.length} books in tools/books_staging/ (add --promote to publish)`);
}
