// Build a bonus source book with a chosen mix: the puzzles of an existing book plus new candidates, at a given size,
// with every tier's share fixed and, inside each tier, a fixed share of one-shape puzzles and of two-shape puzzles.
//
//   node tools/mix_book.mjs --base tools/books/sym_voids.csv --add new1.csv,new2.csv --out tools/books/sym_voids.csv
//        [--size 150] [--tiers 0.10,0.45,0.32,0.13] [--pair-share 0.3] [--no-pair-beginner 1]
//
// --tiers      the share of Beginner, Medium, Hard and Expert in the book (the main books' 10/45/32/12.5).
// --pair-share the share of two-shape puzzles in each tier; Beginner has none (two-shape Beginner puzzles hardly exist).
// A tier (or a kind inside it) that the candidates cannot fill makes that tier smaller, in proportion, rather than
// breaking the mix. The base puzzles are taken first, then the new ones, each kind spread evenly over the tile specs.
// Duplicates (the same board up to rotation and reflection, with the same tile and pre-drawn edges) are dropped.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseCsv, toCsv, tileSpecs, puzzleHash } from '../js/logic.js';
import { canonicalGrid } from '../js/generator.js';
import { TIERS } from '../js/rating.js';
import { spreadByTier } from './lib/pick.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => { if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]]); return acc; }, []));
const size = Number(args.size ?? 150), pairShare = Number(args['pair-share'] ?? 0.3);
const tierShare = (args.tiers ?? '0.10,0.45,0.32,0.13').split(',').map(Number);
const read = f => readFileSync(f, 'utf8');
const header = read(args.base).split('\n').filter(l => l.startsWith('#')).join('\n') + '\n';
const base = parseCsv(read(args.base)), added = (args.add ?? '').split(',').filter(Boolean).flatMap(f => parseCsv(read(f)));
const keyOf = p => (p.givens?.length ? puzzleHash(p) : `${p.tile}|${canonicalGrid(p.grid, p.rows, p.cols)}`);
const seen = new Set(), pool = [];
for (const [list, isBase] of [[base, true], [added, false]]) for (const p of list) { const k = keyOf(p); if (!seen.has(k)) { seen.add(k); pool.push({ p, isBase }); } }
const isPair = p => tileSpecs(p.tile).length === 2;
// each kind spread evenly over its tile specs, base puzzles first
const take = (cands, n) => {
  const by = new Map();
  for (const c of cands.sort((a, b) => (b.isBase - a.isBase) || a.p.score - b.p.score)) { if (!by.has(c.p.tile)) by.set(c.p.tile, []); by.get(c.p.tile).push(c); }
  const lists = [...by.values()], out = [];
  for (let r = 0; out.length < n && lists.some(l => l.length); r++) for (const l of lists) if (l.length && out.length < n) out.push(l.shift());
  return out;
};
const picks = [];
TIERS.forEach((tier, i) => {
  const cands = pool.filter(c => c.p.tier === tier);
  const ps = tier === 'Beginner' ? 0 : pairShare;
  const singles = cands.filter(c => !isPair(c.p)), pairs = cands.filter(c => isPair(c.p));
  let n = Math.round(size * tierShare[i]);
  // base puzzles that would not fit the shares are still kept: they were chosen before
  if (ps === 0) n = Math.min(n, singles.length);
  else n = Math.floor(Math.min(n, singles.length / (1 - ps), pairs.length / ps));
  const nPairs = Math.round(n * ps), nSingles = n - nPairs;
  picks.push(...take(singles, nSingles), ...take(pairs, nPairs));
  console.log(`${tier.padEnd(9)} wanted ${Math.round(size * tierShare[i])}, got ${n}: ${nSingles} single + ${nPairs} pair (candidates ${singles.length}/${pairs.length})`);
});
picks.sort((a, b) => TIERS.indexOf(a.p.tier) - TIERS.indexOf(b.p.tier) || a.p.score - b.p.score);
const ordered = spreadByTier(picks.map(c => c.p), { key: p => p.tile });
const name = (args.name ?? (args.out.split('/').pop().replace(/\.csv$/, '')));
writeFileSync(args.out, header + toCsv(ordered.map((p, i) => ({ ...p, name: `${name}_${String(i + 1).padStart(String(ordered.length).length < 2 ? 2 : String(ordered.length).length, '0')}` }))));
const pairs = ordered.filter(isPair).length;
console.log(`${ordered.length} puzzles (${ordered.length - pairs} single, ${pairs} pair = ${Math.round(100 * pairs / ordered.length)}% pairs) -> ${args.out}`);
