// Re-rate the published books in data/ IN PLACE, keeping exactly the same puzzles.
//
//   node tools/rerate_books.mjs
//
// Use this after a change to the deduction rules or weights (js/rating.js, js/logic.js) when you
// do not want to reshuffle the books: tools/build_books.mjs picks puzzles by score rank, so even a
// small change to the pools' scores would swap many puzzles for others and restart players'
// progress on them. This tool only rewrites each puzzle's rules/tier/score columns, re-sorts each
// book by tier then score and spreads shapes out locally, as the builder does (a book's opening "tour", if its header names one, stays first), and
// renumbers the names. Saved progress is keyed by puzzle content, so it survives.
// (Re-rate the pools too with tools/rescore_library.mjs so the next rebuild agrees.)
import { readFileSync, writeFileSync } from 'node:fs';
import { parseCsv, toCsv } from '../js/logic.js';
import { ratePuzzle, TIERS } from '../js/rating.js';
import { spreadByTier } from './lib/pick.mjs';

const dataDir = new URL('../data/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', dataDir), 'utf8'));
let changed = 0, total = 0;
for (const book of manifest.books) {
  const file = new URL(book.file, dataDir);
  const text = readFileSync(file, 'utf8');
  const header = text.split('\n').filter(l => l.startsWith('#')).join('\n') + '\n';
  const tour = Number(/The first (\d+) puzzles are a shape-by-shape tour/.exec(header)?.[1] ?? 0);
  const puzzles = parseCsv(text);
  let moved = 0;
  for (const p of puzzles) {
    const r = ratePuzzle({ ...p });
    if (p.rules !== r.rules || p.tier !== r.tier || p.score !== r.score) moved++;
    p.rules = r.rules; p.tier = r.tier; p.score = r.score;
  }
  const sorted = puzzles.slice(tour).sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) || a.score - b.score || (a.name < b.name ? -1 : 1));
  const rest = spreadByTier(sorted, { recent: puzzles.slice(0, tour).map(p => p.tile) });   // no long runs of one shape
  const pad = Math.max(2, String(puzzles.length).length);
  const ordered = [...puzzles.slice(0, tour), ...rest].map((p, i) => ({ ...p, name: `${book.id}_${String(i + 1).padStart(pad, '0')}` }));
  writeFileSync(file, header + toCsv(ordered));
  changed += moved; total += puzzles.length;
  console.log(`${book.id.padEnd(8)} ${String(moved).padStart(3)} of ${puzzles.length} re-rated differently`);
}
console.log(`${changed} of ${total} puzzles changed rating; the books keep the same puzzles.`);
