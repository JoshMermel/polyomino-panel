// Optional fast tiling counter for the generator tools: the WASM build of tools/wasm (see
// tools/wasm/build.sh). Importing this module installs it as `countSolutions` (js/logic.js)
// when tools/lib/dlx.wasm exists; otherwise nothing changes. PP_NO_WASM=1 turns it off.
// It visits the same search nodes as the JS counter, so results (including budget aborts) agree.
import { readFileSync, existsSync } from 'node:fs';
import { OPEN, boardPlacements, sizeFeasible, useCounter } from '../../js/logic.js';

const file = new URL('./dlx.wasm', import.meta.url);
export const wasmAvailable = existsSync(file) && !process.env.PP_NO_WASM;

let ex = null;
const tileIds = new Map();                 // "tile|rows|cols" -> id inside the module

function load() {
  const mod = new WebAssembly.Module(readFileSync(file));
  ex = new WebAssembly.Instance(mod, {}).exports;
}

function io(n) {                           // the shared byte buffer, grown to n bytes (re-read after any call that may grow memory)
  const p = ex.io_ptr(n);
  return new Uint8Array(ex.memory.buffer, p, n);
}

function tileId(tile, rows, cols) {
  const key = `${tile}|${rows}|${cols}`;
  let id = tileIds.get(key);
  if (id === undefined) {
    const pls = boardPlacements(tile, rows, cols);
    const words = pls.reduce((n, c) => n + 1 + c.length, 0);
    const buf = io(words * 2);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let o = 0;
    for (const cells of pls) { view.setUint16(o, cells.length, true); o += 2; for (const c of cells) { view.setUint16(o, c, true); o += 2; } }
    id = ex.register(words * 2);
    tileIds.set(key, id);
  }
  return id;
}

export function wasmCount(puzzle, cap = 2, budget = Infinity) {
  const { rows, cols, grid, tile } = puzzle;
  const n = rows * cols;
  let m = 0;
  for (let i = 0; i < n; i++) if (grid[i] === OPEN) m++;
  if (!sizeFeasible(tile, m)) return 0;
  const id = tileId(tile, rows, cols);
  const buf = io(n);
  for (let i = 0; i < n; i++) buf[i] = grid[i] === OPEN ? 1 : 0;
  const r = ex.count(id, n, cap, budget);
  return r < 0 ? cap : r;
}
export const wasmNodes = () => ex.nodes();

if (wasmAvailable) { load(); useCounter(wasmCount); }
