---
"@testivai/witness": minor
---

The HTML report now escapes every value it shows, and each snapshot has its own link target.

- **Escaping.** The report wrote six values from `results.json` into the page without escaping them: the baseline, current and diff image paths, the diff path on each changed region's zoom link, the auto-pass criterion and where a mask came from. A `results.json` with markup in one of those fields (one you did not produce, such as from a fork's CI run) could add elements or script to the page. They are escaped now, like every other value.
- **Link targets.** Each snapshot card has an id, so `index.html#snap-home` opens the report at that snapshot, outlined. On phones the card stays below the top bar. Clicking a snapshot's name puts its link in the address bar. `snapshotAnchorId(name)` is exported, so other tools (the PR comment) build the same link: plain names stay readable (`snap-home`), and any other name gets a hash suffix so that `home page` and `home/page` never share an id.
