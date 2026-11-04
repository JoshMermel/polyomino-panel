// Build the books in data/ from the puzzle pools in tools/library/, following
// tools/books/collections.json.
//
//   node tools/build_books.mjs                 stage every book in tools/books_staging/ and print a report
//   node tools/build_books.mjs --promote       ...and copy them into data/ (replacing the old books) + rewrite manifest.json
//   node tools/build_books.mjs --list          what each pool can supply, by tier
//   --seed N                                   tie-break seed (default 1; builds are deterministic for a seed)
//
// The books are:
//   Start here          a guided 6x6 path, one shape at a time, then a taste of two shapes
//   Classical L-panel   L tetromino puzzles, one book per difficulty tier
//   One shape           puzzles with one tile shape (not the L), one book per tier
//   Two shapes          puzzles where each tile is either of two shapes, one book per tier
// Each tier book mixes shapes and board sizes: its puzzles are shared out as evenly as possible
// over the (shape, board size) cells that have puzzles of that tier, then each cell's share is
// spread evenly over that cell's score range, and the book is sorted by score (bigger boards
// score higher, so they land towards the back). Every puzzle is in at most one book: a puzzle
// used by an earlier book is never offered to a later one.
//
// Never published: puzzles whose open cells are not one connected region
// (logic.openCellsConnected) and puzzles whose solution's tile boundaries contain a swastika
// pattern (logic.hasSwastika). The pools to draw from are the shapes and sizes in recipes.json.
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync, rmSync,
} from 'node:fs';
import { parseCsv, toCsv, solve, shapeName, hasSwastika, openCellsConnected } from '../js/logic.js';
import { TIERS, TIER_INFO } from '../js/rating.js';
import { canonicalGrid } from '../js/generator.js';
import { pickEven, evenAllocation } from './lib/pick.mjs';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter(a => a.startsWith('--')));
const seedIdx = argv.indexOf('--seed');
const seed = seedIdx >= 0 ? Number(argv[seedIdx + 1]) : 1;

const root = new URL('..', import.meta.url);
const recipes = JSON.parse(readFileSync(new URL('tools/books/recipes.json', root), 'utf8'));
const config = JSON.parse(readFileSync(new URL('tools/books/collections.json', root), 'utf8'));
const libDir = new URL('tools/library/', root), stageDir = new URL('tools/books_staging/', root), dataDir = new URL('data/', root);
mkdirSync(stageDir, { recursive: true });

// --- The pools -------------------------------------------------------------------------------
const pool = [];                       // every puzzle that may be published
const poolBySize = new Map();          // for the report
for (const tile of recipes.shapes) {
  for (const size of recipes.sizes) {
    const f = new URL(`${tile}_${size}x${size}.csv`, libDir);
    if (!existsSync(f)) continue;
    for (const p of parseCsv(readFileSync(f, 'utf8'))) {
      if (openCellsConnected(p) && !hasSwastika(p, p.solution)) pool.push(p);
    }
  }
}
const isPair = p => p.tile.includes('+');
const tierName = t => TIER_INFO[t].name;
const tierSlug = t => tierName(t).toLowerCase();

if (flags.has('--list')) {
  const sections = [{ group: 'Start here (6x6 curriculum draws from these)', test: p => !isPair(p) && p.rows === config.start.size }, ...config.sections.map(s => ({ group: s.group, test: p => matches(s, p) }))];
  for (const s of sections) {
    const per = TIERS.map(t => pool.filter(p => p.tier === t && s.test(p)).length);
    console.log(`${s.group.padEnd(44)} ${TIERS.map((t, i) => `${tierName(t)} ${per[i]}`).join('  ')}`);
  }
  process.exit(0);
}

// Does this puzzle belong to a section (before the tier is considered)?
function matches(section, p) {
  if (section.only) return section.only.includes(p.tile);
  if (section.kind === 'pair' && !isPair(p)) return false;
  if (section.kind === 'single' && isPair(p)) return false;
  return !(section.exclude ?? []).includes(p.tile);
}

// --- Building ---------------------------------------------------------------------------------
for (const f of readdirSync(stageDir)) if (f.endsWith('.csv')) rmSync(new URL(f, stageDir));
const used = new Set();                // names of puzzles already in a book
const books = [];                      // { meta, puzzles }
const trim = n => (n >= 50 ? { low: 0.02, high: 0.98 } : { low: 0, high: 1 });   // ignore score outliers in big cells

// Start here: for each stage (a shape or pair, in order) the requested number of puzzles of each tier.
{
  const st = config.start, picked = [];
  for (const stage of st.stages) {
    for (const tier of TIERS) {
      const want = stage[tier] ?? 0;
      if (!want) continue;
      const cands = pool.filter(p => p.tile === stage.tile && p.rows === st.size && p.tier === tier && !used.has(p.name));
      const r = pickEven(cands, { count: want, seed, ...trim(cands.length) });
      if (r.short) console.log(`  start: ${stage.tile} ${tierName(tier)}: only ${r.picks.length} of ${want} available`);
      r.picks.forEach(p => { used.add(p.name); picked.push({ ...p, _stage: st.stages.indexOf(stage) }); });
    }
  }
  picked.sort((a, b) => a._stage - b._stage || TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) || a.score - b.score || (a.name < b.name ? -1 : 1));
  books.push({
    meta: { id: st.id, group: st.group, title: st.title, label: st.title, blurb: st.blurb, ordered: 'curriculum' },
    puzzles: picked,
    target: picked.length,
  });
}

// The sections: one book per tier.
for (const section of config.sections) {
  for (const tier of config.tiers) {
    const cands = pool.filter(p => p.tier === tier && !used.has(p.name) && matches(section, p));
    const cells = new Map();                                    // (tile, size) -> candidates
    for (const p of cands) {
      const key = `${p.tile}|${String(p.rows).padStart(3, '0')}`;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(p);
    }
    const keys = [...cells.keys()].sort();
    const alloc = evenAllocation(section.count, keys.map(k => cells.get(k).length));
    const picks = [];
    keys.forEach((k, i) => {
      if (!alloc[i]) return;
      const c = cells.get(k);
      picks.push(...pickEven(c, { count: alloc[i], seed, ...trim(c.length) }).picks);
    });
    picks.forEach(p => used.add(p.name));
    picks.sort((a, b) => a.score - b.score || (a.name < b.name ? -1 : 1));
    const id = `${section.idPrefix}-${tierSlug(tier)}`;
    books.push({
      meta: { id, group: section.group, title: `${section.group}: ${tierName(tier)}`, label: tierName(tier), blurb: TIER_INFO[tier].blurb, tier, ordered: 'score' },
      puzzles: picks,
      target: section.count,
    });
  }
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
  const book = b.puzzles.map((p, i) => { const { _stage, ...rest } = p; return { ...rest, name: `${b.meta.id}_${String(i + 1).padStart(pad, '0')}` }; });
  const header = `# ${b.meta.title}. Built by tools/build_books.mjs from a pool of ${pool.length} puzzles (seed ${seed}).\n` +
    '# grid: # = blocked cell, . = open cell. solution: tile labels, # = blocked. The tile column lists the allowed shapes (joined with +).\n' +
    `# rules: hardest deduction rule needed; tier: its difficulty tier; score: finer difficulty. ${b.meta.ordered === 'score' ? 'Sorted easiest first.' : 'In curriculum order.'}\n`;
  writeFileSync(new URL(`${b.meta.id}.csv`, stageDir), header + toCsv(book));
  b.meta.file = `${b.meta.id}.csv`;
  b.meta.count = book.length;

  const count = f => { const m = new Map(); b.puzzles.forEach(p => m.set(f(p), (m.get(f(p)) ?? 0) + 1)); return m; };
  const fmt = m => [...m].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([k, v]) => `${k}:${v}`).join(' ');
  const tiers = fmt(count(p => tierName(p.tier)));
  const sizes = fmt(count(p => `${p.rows}x${p.cols}`));
  const shapes = count(p => p.tile);
  const sc = b.puzzles.map(p => p.score);
  console.log(`[${b.meta.id}] ${book.length}/${b.target}  tiers ${tiers}\n    sizes ${sizes}  | ${shapes.size} shape${shapes.size === 1 ? '' : 's'}${shapes.size <= 3 ? ` (${fmt(shapes)})` : ''}  | scores ${Math.min(...sc)}..${Math.max(...sc)}`);
}

if (flags.has('--promote')) {
  for (const f of readdirSync(dataDir)) if (f.endsWith('.csv')) rmSync(new URL(f, dataDir));    // the previous books
  for (const b of books) copyFileSync(new URL(b.meta.file, stageDir), new URL(b.meta.file, dataDir));
  const manifest = {
    default: config.default,
    groups: [{ name: config.start.group, blurb: config.start.blurb }, ...config.sections.map(s => ({ name: s.group, blurb: s.blurb }))],
    books: books.map(b => b.meta).map(({ ordered, ...m }) => m),
  };
  writeFileSync(new URL('manifest.json', dataDir), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`promoted ${books.length} books to data/ (${books.reduce((n, b) => n + b.meta.count, 0)} puzzles)`);
} else {
  console.log(`staged ${books.length} books in tools/books_staging/ (add --promote to publish)`);
}
