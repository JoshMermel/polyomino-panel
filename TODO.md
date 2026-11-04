# To do

Ideas that are wanted but not scheduled.

- **Daily puzzle.** One puzzle per day picked from across shapes, with the difficulty varying by weekday (as in multiverse star battle). Gives friends a reason to come back.
- **Decide which other shapes to keep.** 16 shapes ship. The domino and the I tetromino and pentomino were cut (every line shape solves the same way; the I tromino stays as the one line shape). The analysis (rule mix per shape, keep-lists of 5 / 8 / 11 shapes) says the other forced-only shapes (X5, Z5, T5, V5, U5) add little too; wait for friends' feedback from real play. To cut: edit `shapes` in `tools/books/recipes.json`, delete the cut books from `data/`, run `node tools/build_books.mjs --all --promote`. Pools in `tools/library/` are kept, so a cut is reversible (re-add the shape and rebuild).
- **Tune difficulty from feedback.** Tier shares are `defaults.tiers` (or per-book `overrides`) in `tools/books/recipes.json`; the author suspects the current corpus is too hard.
