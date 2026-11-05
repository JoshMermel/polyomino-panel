// Drop near-duplicate puzzles from the pools in tools/library/.
//
//   node tools/prune_library.mjs [--min-distance 0.08] [--only L_8x8,P5_*] [--apply]
//
// Two puzzles are near-duplicates when their boards differ in fewer than --min-distance of the
// cells (default 8%: 3 cells on 6x6, 5 on 8x8, 8 on 10x10; at least 2), comparing the blocked
// cells under all rotations and mirrors, within one pool (one tile spec, one size). In each
// group of near-duplicates the hardest puzzle survives: pools are walked Hard first, then
// Medium, then Beginner, by descending score, so the thin top tiers lose the least.
// Without --apply nothing is written; it only prints what would be dropped.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { parseCsv, toCsv } from '../js/logic.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]]);
  return acc;
}, []));
const frac = Number(args['min-distance'] ?? 0.08);
const apply = 'apply' in args;
const only = args.only ? args.only.split(',').map(g => new RegExp('^' + g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')) : null;
const dir = new URL('./library/', import.meta.url);

const popcount = x => { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; };
// the blocked cells as bit words, for each of the 8 symmetries of the square (boards up to 128 cells)
function symmetries(p) {
  const n = p.rows, out = [];
  for (let t = 0; t < 8; t++) {
    const w = new Uint32Array(4);
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      const rr = t & 1 ? n - 1 - r : r, cc = t & 2 ? n - 1 - c : c;
      const [a, b] = t & 4 ? [cc, rr] : [rr, cc];
      if (p.grid[a * n + b] === '#') { const i = r * n + c; w[i >> 5] |= 1 << (i & 31); }
    }
    out.push(w);
  }
  return out;
}
const distance = (A, sym) => { let best = Infinity; for (const B of sym) { let d = 0; for (let k = 0; k < 4; k++) d += popcount(A[k] ^ B[k]); if (d < best) best = d; } return best; };
const TIER_ORDER = { Hard: 0, Medium: 1, Beginner: 2 };

let before = 0, after = 0;
for (const f of readdirSync(dir).filter(f => /^[A-Z0-9+]+_\d+x\d+\.csv$/.test(f)).sort()) {
  if (only && !only.some(re => re.test(f.replace('.csv', '')))) continue;
  const text = readFileSync(new URL(f, dir), 'utf8');
  const puzzles = parseCsv(text);
  if (!puzzles.length) continue;
  const minD = Math.max(2, Math.round(frac * puzzles[0].rows * puzzles[0].cols));
  const order = [...puzzles].sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || b.score - a.score || (a.name < b.name ? -1 : 1));
  const kept = new Set(), syms = [];
  for (const p of order) {
    const s = symmetries(p);
    if (syms.every(k => distance(s[0], k) >= minD)) { kept.add(p); syms.push(s); }
  }
  const survivors = puzzles.filter(p => kept.has(p));      // keep the file's own order
  const tiers = ps => ['Beginner', 'Medium', 'Hard'].map(t => ps.filter(p => p.tier === t).length).join('/');
  console.log(`${f.replace('.csv', '').padEnd(12)} ${String(puzzles.length).padStart(5)} -> ${String(survivors.length).padStart(5)}   (B/M/H ${tiers(puzzles)} -> ${tiers(survivors)})`);
  before += puzzles.length; after += survivors.length;
  if (apply) writeFileSync(new URL(f, dir), text.split('\n').filter(l => l.startsWith('#')).join('\n') + '\n' + toCsv(survivors));
}
console.log(`${before} -> ${after} puzzles${apply ? ' (written)' : ' (dry run; add --apply to write)'}`);
