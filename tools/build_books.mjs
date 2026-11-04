// Build the books in data/ from the puzzle pools in tools/library/, following
// tools/books/recipes.json.
//
//   node tools/build_books.mjs --list                 every book and where its pool stands
//
// How a book is picked: each difficulty tier (Beginner, Medium, Hard, Expert,
// Unsolved; see js/rating.js for which rules belong to which) gets a share of the
// book (recipe "tiers"); within a tier the puzzles are spread evenly over that
// tier's score range. If the pool has too few puzzles in some tier (marked * in
// the report) the shortfall goes to the other tiers.
//   node tools/build_books.mjs --all                  stage every book, print a report
//   node tools/build_books.mjs L_8x8 'P5_*'           stage some books (globs match book ids)
//   node tools/build_books.mjs --all --promote        ...and copy them into data/ + rewrite manifest.json
//
// A book id is <shape>_<size>x<size>, e.g. P5_8x8. Nothing touches data/ until
// --promote. Builds are deterministic for a given --seed (default 1).
//
// Puzzles whose solution's tile boundaries contain a swastika pattern (see
// logic.hasSwastika) are skipped.
//
// A recipe is the defaults in recipes.json plus any entry in "overrides", keyed
// by book id: { count, minCount, low, high, tiers }. A book with fewer than
// minCount puzzles available is not built. tiers = relative share of each
// difficulty tier; low/high = percentiles bounding each tier's score range (default
// 0.02..0.98, to ignore outliers).
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync,
} from 'node:fs';
import { parseCsv, toCsv, solve, shapeName, hasSwastika } from '../js/logic.js';
import { TIERS } from '../js/rating.js';
import { canonicalGrid } from '../js/generator.js';
import { pickTiered } from './lib/pick.mjs';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter(a => a.startsWith('--')));
const seedIdx = argv.indexOf('--seed');
const seed = seedIdx >= 0 ? Number(argv[seedIdx + 1]) : 1;
const patterns = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--seed');

const root = new URL('..', import.meta.url);
const recipes = JSON.parse(readFileSync(new URL('tools/books/recipes.json', root), 'utf8'));
const libDir = new URL('tools/library/', root), stageDir = new URL('tools/books_staging/', root), dataDir = new URL('data/', root);
mkdirSync(stageDir, { recursive: true });

const bookId = (tile, size) => `${tile}_${size}x${size}`;
const all = [];
for (const tile of recipes.shapes) for (const size of recipes.sizes) all.push({ tile, size, id: bookId(tile, size) });
const recipeFor = id => ({ ...recipes.defaults, ...(recipes.overrides?.[id] ?? {}) });

const globs = patterns.map(g => new RegExp('^' + g.replace(/\*/g, '.*') + '$'));
const selected = flags.has('--all') || flags.has('--list') || !patterns.length
  ? all : all.filter(b => globs.some(re => re.test(b.id)));

const poolOf = id => {
  const f = new URL(`${id}.csv`, libDir);
  return existsSync(f) ? parseCsv(readFileSync(f, 'utf8')) : [];
};

if (flags.has('--list')) {
  for (const b of selected) {
    const pool = poolOf(b.id), r = recipeFor(b.id);
    const have = existsSync(new URL(`${b.id}.csv`, dataDir)) ? 'in data/' : '';
    console.log(`${b.id.padEnd(10)} ${shapeName(b.tile).padEnd(13)} want ${String(r.count).padStart(3)}  pool ${String(pool.length).padStart(5)}  ${have}`);
  }
  process.exit(0);
}

const staged = [];
for (const b of selected) {
  const allPuzzles = poolOf(b.id);
  const r = recipeFor(b.id);
  if (!allPuzzles.length) { console.log(`[${b.id}] no pool (run tools/fill_library.mjs)`); continue; }
  // swastika patterns in a solution's tile boundaries are never published
  const pool = allPuzzles.filter(p => !hasSwastika(p, p.solution));
  const { picks, perTier, short } = pickTiered(pool, { count: r.count, tiers: TIERS, tierKey: 'tier', shares: r.tiers, low: r.low, high: r.high, seed });

  if (picks.length < (r.minCount ?? 1)) {
    console.log(`[${b.id}] only ${picks.length} puzzles available (minimum ${r.minCount}): not built`);
    continue;
  }

  // Safety net: every picked puzzle must still have exactly its stored solution.
  for (const p of picks) {
    const sols = solve(p, 2);
    if (sols.length !== 1 || sols[0] !== p.solution) throw new Error(`${b.id}: ${p.name} is not uniquely solvable`);
  }
  const seenKeys = new Set();
  for (const p of picks) {
    const key = canonicalGrid(p.grid, p.rows, p.cols);
    if (seenKeys.has(key)) throw new Error(`${b.id}: duplicate puzzle ${p.name}`);
    seenKeys.add(key);
  }

  // easiest first: by hardest rule needed, then by score
  const rank = p => TIERS.indexOf(p.tier);
  const ordered = [...picks].sort((x, y) => rank(x) - rank(y) || x.score - y.score || (x.name < y.name ? -1 : 1));
  const book = ordered.map((p, i) => ({ ...p, name: `${b.id}_${String(i + 1).padStart(2, '0')}` }));
  const header = `# ${shapeName(b.tile)} ${b.size}x${b.size}. Built by tools/build_books.mjs from a pool of ${pool.length} (seed ${seed}).\n` +
    '# grid: # = blocked cell, . = open cell. solution: tile labels, # = blocked.\n' +
    '# rules: hardest deduction rule needed; tier: its difficulty tier (Beginner/Medium/Hard/Expert/Unsolved); score: finer difficulty. Sorted easiest first.\n';
  writeFileSync(new URL(`${b.id}.csv`, stageDir), header + toCsv(book));
  staged.push(b);

  const sc = book.map(p => p.score);
  const thin = pool.length < 1.5 * r.count ? '  (thin margin)' : '';
  const mix = TIERS.map(t => `${perTier[t].got}${perTier[t].got < perTier[t].quota ? '*' : ''}`).join('/');
  const avail = TIERS.map(t => perTier[t].avail).join('/');
  console.log(`[${b.id}] ${book.length}/${r.count}  tiers ${mix}  scores ${sc[0]}..${sc[sc.length - 1]}  pool ${pool.length} (${avail})` +
    `${short ? `  SHORT by ${short}` : ''}${thin}`);
}

if (flags.has('--promote')) {
  for (const b of staged) copyFileSync(new URL(`${b.id}.csv`, stageDir), new URL(`${b.id}.csv`, dataDir));

  // manifest.json lists every book present in data/, ordered by recipe.
  const order = new Map(all.map((b, i) => [b.id, i]));
  const books = readdirSync(dataDir).filter(f => /^[A-Z0-9]+_\d+x\d+\.csv$/.test(f)).map(f => {
    const [p] = parseCsv(readFileSync(new URL(f, dataDir), 'utf8'));
    const count = parseCsv(readFileSync(new URL(f, dataDir), 'utf8')).length;
    return { tile: p.tile, rows: p.rows, cols: p.cols, file: f, count };
  }).sort((a, b) => (order.get(bookId(a.tile, a.rows)) ?? 1e9) - (order.get(bookId(b.tile, b.rows)) ?? 1e9));
  writeFileSync(new URL('manifest.json', dataDir), JSON.stringify({ default: recipes.defaultBook, books }, null, 2) + '\n');
  console.log(`promoted ${staged.length} book(s) to data/; manifest lists ${books.length}`);
} else if (staged.length) {
  console.log(`staged ${staged.length} book(s) in tools/books_staging/ (add --promote to publish)`);
}
