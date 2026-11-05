// Generate puzzles with a unique solution and write them as puzzle CSV.
//
//   node tools/generate.mjs --size 8 --count 20 --out my_puzzles.csv
//
// Options
//   --rows N / --cols N / --size N   board size (--size sets both)       [8]
//   --tile SPEC                      tile: a library name (tetrominoes L I O T S;
//                                    I2, I3, V3; pentominoes F5 I5 L5 N5 P5 T5
//                                    U5 V5 W5 X5 Y5 Z5) or a pattern like
//                                    "X./X./XX"                            [L]
//                                    Join several with + (e.g. "L+T") to allow
//                                    each tile to be any one of them.
//   --count N                        how many puzzles                     [10]
//   --holes K                        blocked cells. Default: automatic. Starts at
//                                    ~15% of the board and adds a tile's worth
//                                    of blocked cells until generation works
//                                    for the shape; the whole run then keeps
//                                    that level.
//   --seed N                         PRNG seed (printed; reuse to reproduce)
//   --prefix NAME                    puzzle name prefix                   [gen]
//   --max-seconds N                  give up on a puzzle after N seconds  [60]
//   --out FILE                       output CSV (default: stdout)
import { writeFileSync } from 'node:fs';
import { toCsv, tileSpecs, shapeName } from '../js/logic.js';
import './lib/wasm_counter.mjs';        // faster tiling counter, when built (tools/wasm)
import { generatePuzzleAuto, generatePuzzle, mulberry32, canonicalGrid, defaultHoles } from '../js/generator.js';
import { sortByRules } from '../js/rating.js';

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`Unexpected argument "${a}"`);
    const key = a.slice(2);
    const val = argv[++i];
    if (val === undefined) throw new Error(`Missing value for ${a}`);
    opts[key] = val;
  }
  return opts;
}

const int = (v, name) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a non-negative integer`);
  return n;
};

let o;
try { o = parseArgs(process.argv.slice(2)); } catch (err) { console.error(err.message); process.exit(2); }

const rows = int(o.rows ?? o.size ?? 8, 'rows');
const cols = int(o.cols ?? o.size ?? 8, 'cols');
const tile = o.tile ?? 'L';
const count = int(o.count ?? 10, 'count');
const seed = o.seed !== undefined ? int(o.seed, 'seed') : Math.floor(Math.random() * 2 ** 31);
const prefix = o.prefix ?? 'gen';
const maxMs = Number(o['max-seconds'] ?? 60) * 1000;

try { tileSpecs(tile); } catch (err) { console.error(err.message); process.exit(2); }
const fixedHoles = o.holes !== undefined ? int(o.holes, 'holes') : null;
let holes = fixedHoles ?? defaultHoles(rows, cols, tile);

const rng = mulberry32(seed);
const puzzles = [];
const seen = new Set();
const t0 = Date.now();
console.error(`Generating ${count} puzzle(s): ${rows}x${cols}, tile ${tile} (${shapeName(tile)}), ` +
  `${fixedHoles !== null ? holes : `auto, from ${holes}`} blocked cells, seed ${seed}`);

let failures = 0, dupStreak = 0;
while (puzzles.length < count && failures < 5) {
  let res;
  try {
    if (fixedHoles !== null) {
      res = generatePuzzle({ rows, cols, tile, holes, rng, maxMs });
    } else {
      res = generatePuzzleAuto({ rows, cols, tile, holes, rng, levelMs: Math.min(maxMs, 5000) });
      if (res && res.holes !== holes) {
        console.error(`  using ${res.holes} blocked cells for this shape/size`);
        holes = res.holes;           // keep the level for the rest of the run
      }
    }
  } catch (err) { console.error(err.message); process.exit(2); }
  if (!res) { failures++; console.error('  gave up on a puzzle; retrying'); continue; }
  const key = canonicalGrid(res.puzzle.grid, rows, cols);
  if (seen.has(key)) {               // same puzzle up to rotation/reflection
    // Some shapes have very few distinct uniquely-solvable boards; don't spin forever.
    if (++dupStreak >= 200) {
      console.error(`  only ${puzzles.length} distinct puzzles found for this shape/size/blocked-cell count; stopping`);
      break;
    }
    continue;
  }
  dupStreak = 0;
  seen.add(key);
  const idx = String(puzzles.length + 1).padStart(String(count).length, '0');
  res.puzzle.name = `${prefix}_${idx}`;
  puzzles.push(res.puzzle);
  console.error(`  ${res.puzzle.name}: ${res.stats.ms} ms, ${res.stats.moves} moves`);
}
if (puzzles.length < count) console.error(`Only generated ${puzzles.length} of ${count}.`);

// Rate by the deduction rules needed and put the easiest first.
const sorted = sortByRules(puzzles, prefix);
console.error('Rules needed: ' + Object.entries(sorted.counts).map(([l, n]) => `${l} ${n}`).join(', '));
puzzles.splice(0, puzzles.length, ...sorted.puzzles);

const header = `# Generated by tools/generate.mjs: ${rows}x${cols}, tile ${tile} (${shapeName(tile)}), ${holes} blocked, seed ${seed}\n` +
  '# grid: # = blocked cell, . = open cell. solution: tile labels, # = blocked.\n' +
  '# rules: hardest deduction rule needed; tier: its difficulty tier; puzzles are sorted by it.\n';
const csv = header + toCsv(puzzles);

if (o.out) {
  writeFileSync(o.out, csv);
  console.error(`Wrote ${puzzles.length} puzzles to ${o.out} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
} else {
  process.stdout.write(csv);
}
