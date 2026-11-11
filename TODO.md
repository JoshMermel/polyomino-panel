# To do

Ideas that are wanted but not scheduled. Trimmed 2026-11-10: finished items were removed (all described in README.md), and the rest were decided as "skip" or "keep as is": ghosting the failing tile in hints, a per-tier blocked-cell cap for Beginner puzzles, the enclosed-region and parity try-a-line rules, more ways to erase, more deduction rules, the 17% sparseness cap, the Bonus clues book, rectangular boards that trim black edges, sparser pools, three-shape extras, a phone warning for Giants, a daily puzzle, the guess layer and generator speed.

## In progress

- **Diversity guard in the book builder.** Make `tools/build_books.mjs` skip a puzzle too close (blocked cells differing in under about 8% of the cells) to one already in the same book (same tile spec), so books stay varied when a pool has siblings. Prototype: measure the near-duplicates in the books first, then add it as an option.

## Ideas for more experiments

- **Non-square boards (a plus sign, a rectangle, other shapes).** Rectangles are close: the generator and most of the code take separate rows and columns. A plus sign or other outline is the same thing as blocking the cells outside the shape, so it only needs generation work (fixed blocked cells) and a book.
