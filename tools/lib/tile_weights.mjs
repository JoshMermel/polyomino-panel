// Shape weights for the clue-experiment generators (tools/make_clue_puzzles.mjs, make_given_puzzles.mjs):
// how often a shape is tried, and how many of one shape a bucket may hold.
// The line pieces (domino, I tromino, I tetromino, I pentomino) make dull puzzles (a row of them says
// little), so they are rare; the rigid pentominoes (T, U, V, Z, X) are down-weighted a little less.
const LINEAR = new Set(['I2', 'I3', 'I', 'I5']);
const RIGID = new Set(['T5', 'U5', 'V5', 'Z5', 'X5']);

// A tile spec is one shape or shapes joined by +; a pair weighs as its dullest part.
export function tileWeight(spec) {
  return Math.min(...spec.split('+').map(s => (LINEAR.has(s) ? 0.1 : RIGID.has(s) ? 0.33 : 1)));
}

export function weightedPick(rng, items, weight = tileWeight) {
  const w = items.map(weight);
  let x = rng() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < items.length; i++) { x -= w[i]; if (x < 0) return items[i]; }
  return items.at(-1);
}

// How many puzzles of one shape a bucket may hold: the line pieces get one, every other shape `base`.
export const tileCap = (spec, base) => (spec.split('+').some(s => LINEAR.has(s)) ? 1 : base);
