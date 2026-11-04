# To do

Ideas that are wanted but not scheduled.

- **Daily puzzle.** One puzzle per day picked from across shapes, with the difficulty varying by weekday (as in multiverse star battle). Gives friends a reason to come back.
- **Decide which other shapes to keep.** 16 shapes ship. The domino and the I tetromino and pentomino were cut (every line shape solves the same way; the I tromino stays as the one line shape). The analysis (rule mix per shape, keep-lists of 5 / 8 / 11 shapes) says the other forced-only shapes (X5, Z5, T5, V5, U5) add little too; wait for friends' feedback from real play. To cut: edit `shapes` in `tools/books/recipes.json`, delete the cut books from `data/`, run `node tools/build_books.mjs --all --promote`. Pools in `tools/library/` are kept, so a cut is reversible (re-add the shape and rebuild).
- **Tune difficulty from feedback.** Tier shares are `defaults.tiers` (or per-book `overrides`) in `tools/books/recipes.json`; the author suspects the current corpus is too hard.
- **More two-shape puzzles.** Eight pairs ship (see the README). Ideas: more pairs (e.g. P+Y, W+F, L5+N5 generated fine at 8x8), three or more shapes, and puzzles that *must* use each shape a given number of times. The domino pairs (domino + V tromino, domino + L) found no unique puzzle at 8x8, and V tromino + L has no 10x10 book (only 8 puzzles). Beginner puzzles are scarce for pairs; if friends find the pair books too hard, generate more easy ones (`node tools/hunt_all.mjs --want Beginner,Medium`) or adjust the per-book tier mixes in `tools/books/recipes.json`.
