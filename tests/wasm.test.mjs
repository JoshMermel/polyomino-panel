// The WASM tiling counter (tools/wasm, optional) must agree with the JS counter on every input,
// including how many search nodes it uses before a budget abort. Skipped when tools/lib/dlx.wasm
// has not been built.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCsv, searchTilings } from '../js/logic.js';
import { mulberry32 } from '../js/generator.js';
import { wasmAvailable, wasmCount, wasmNodes } from '../tools/lib/wasm_counter.mjs';

const books = ['one-6', 'one-8', 'one-10', 'two-6', 'two-8', 'two-10'];
const puzzles = books.flatMap(id => parseCsv(readFileSync(new URL(`../data/${id}.csv`, import.meta.url), 'utf8')));

test('wasm counter agrees with the JS counter (counts, aborts, node counts)', { skip: !wasmAvailable && 'tools/lib/dlx.wasm not built' }, () => {
  const rng = mulberry32(5);
  let checks = 0;
  for (let k = 0; k < 150; k++) {
    const p = { ...puzzles[Math.floor(rng() * puzzles.length)] };
    if (k % 2) {                                     // flip a few cells: other counts, infeasible sizes, blocked tiles
      const g = [...p.grid];
      for (let j = 0, n = 1 + Math.floor(rng() * 3); j < n; j++) { const i = Math.floor(rng() * g.length); g[i] = g[i] === '#' ? '.' : '#'; }
      p.grid = g.join('');
    }
    for (const [cap, budget] of [[2, 100000], [40, 20000], [40, 50], [5, 300], [1, 1000]]) {
      const js = searchTilings(p, { limit: cap, budget, keep: false });
      const w = wasmCount(p, cap, budget);
      assert.equal(w, js.aborted ? cap : js.count, `${p.tile} ${p.grid} cap ${cap} budget ${budget}`);
      if (js.nodes > 0) assert.equal(wasmNodes(), js.nodes, `nodes for ${p.tile} ${p.grid} cap ${cap} budget ${budget}`);
      checks++;
    }
  }
  assert.ok(checks >= 700);
});
