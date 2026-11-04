# To do

Ideas that are wanted but not scheduled.

- **Daily puzzle.** One puzzle per day picked from across shapes, with the difficulty varying by weekday (as in multiverse star battle). Gives friends a reason to come back.
- **Decide which shapes to keep.** 19 shapes ship today; the analysis (rule mix per shape, three keep-lists of 5 / 8 / 11 shapes) says the forced-only shapes (I2, I3, I5, X5, Z5, T5, V5, U5) add little. Nothing is cut yet: wait for friends' feedback from real play. To cut: edit `shapes` in `tools/books/recipes.json`, delete the cut books from `data/`, run `node tools/build_books.mjs --all --promote`.
- **Tune difficulty from feedback.** Tier shares are `defaults.tiers` (or per-book `overrides`) in `tools/books/recipes.json`; the author suspects the current corpus is too hard.
