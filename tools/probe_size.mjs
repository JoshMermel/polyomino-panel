// How hard is it to generate sparse puzzles on a big board? A probe, not a generator: for one shape and
// board size it tries a few blocked-cell counts and reports how long a unique puzzle took (or that none
// was found), and how long rating it takes.
//
//   node tools/probe_size.mjs --tile L --size 12 [--fractions 0.10,0.14,0.17] [--attempts 3] [--max-seconds 90] [--seed N]
import './lib/wasm_counter.mjs';
import { shapeName } from '../js/logic.js';
import { generatePuzzle, mulberry32, holeLadder } from '../js/generator.js';
import { ratePuzzle } from '../js/rating.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]]);
  return acc;
}, []));
const tile = args.tile ?? 'L';
const size = Number(args.size ?? 12);
const fractions = (args.fractions ?? '0.10,0.14,0.17').split(',').map(Number);
const attempts = Number(args.attempts ?? 3);
const maxMs = Number(args['max-seconds'] ?? 90) * 1000;
const rng = mulberry32(Number(args.seed ?? 7));
const cells = size * size;
const ladder = holeLadder(size, size, tile);
for (const f of fractions) {
  const target = f * cells;
  const holes = ladder.reduce((best, k) => (Math.abs(k - target) < Math.abs(best - target) ? k : best), ladder[0]);
  const times = [];
  let rated = null;
  for (let a = 0; a < attempts; a++) {
    const t0 = Date.now();
    const res = generatePuzzle({ rows: size, cols: size, tile, holes, rng, maxMs });
    if (res) {
      times.push((Date.now() - t0) / 1000);
      if (!rated) { const r0 = Date.now(); const r = ratePuzzle(res.puzzle); rated = { tier: r.tier, rules: r.rules, secs: (Date.now() - r0) / 1000 }; }
    }
  }
  console.log(`${tile} ${size}x${size} (${shapeName(tile)}) ${holes} blocked (${(100 * holes / cells).toFixed(0)}%): ${times.length}/${attempts} found` +
    (times.length ? `, ${times.map(t => t.toFixed(1) + 's').join(' ')}` : `, none within ${maxMs / 1000}s each`) +
    (rated ? `; rating took ${rated.secs.toFixed(1)}s (${rated.rules}, ${rated.tier})` : ''));
}
