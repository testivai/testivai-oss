# Fixtures

## `render-noise-shapes.results.json` (real runs, assembled)

Nine changed snapshots, each from a real capture and compare, in which the DOM
is identical and the computed styles match (`dom.changed: false`,
`dom.noiseHint: true`, `dom.styleCheck: "match"`). They are the evidence for
the diff-shape rule (`src/report/diff-shape.ts`): which of these diffs look
like render noise, and which do not.

Produced on 2026-10-14 from
[`testivai/testivai-example`](https://github.com/testivai/testivai-example)
(captures by `@testivai/witness-playwright` 2.0.3, Playwright 1.64, Chromium
141 headless shell). Baselines were captured on the same machine from the
untouched site; each case was then captured or edited as described below and
compared by `compareAll` from this repository (no pass criteria).

Assembled from separate runs: each snapshot was renamed from its page name
(`products`, `home`, `buttons`) to its case name below, with its image paths to
match, and `timestamp` and `baselineApprovedAt` were pinned to a fixed date.
Nothing else was edited.

| Snapshot | Page | How it was made | Shape |
|---|---|---|---|
| `glyph-edge-noise` | products | 60 isolated glyph-edge pixels of the current capture nudged (anti-aliasing noise) | scattered: no regions |
| `card-clipped` | products | real CSS bug: `.cards .card:nth-child(2) .body { max-height: 52px; overflow: hidden; }` | concentrated: 3 regions, 0.8% of the page |
| `card-text-not-painted` | products | bad current capture: card 2's title and description painted over with the card background | concentrated: 1 region, 1.1% of the page |
| `baseline-band-shifted` | home | bad baseline: a 260px band of the baseline image moved down 24px, nothing inserted | concentrated: 1 region, 18.8% of the page (and 2.07% of pixels) |
| `titles-underlined` | products | real CSS change the style check does not cover: `.card h3 { text-decoration: underline; }` (six cards) | concentrated: 6 regions, 14.6% of the page |
| `font-subpixel-noise` | buttons | current captured with `--disable-font-subpixel-positioning`: every text run re-rasterized | scattered: 20 regions over 37.8% of the page, 0.85% of pixels |
| `font-subpixel-noise-over-1pct` | products | the same flag on the products page | large: 1.19% of pixels |
| `fonts-differ-between-machines` | products | the example repository's CI-made baseline against a capture on this machine (different font rendering and metrics) | large: 4.77% of pixels |
| `titles-underlined-long-page` | products, 30 cards | the `titles-underlined` change on a page five times as long | scattered: 30 regions over 40.2% of the page; the rule's known blind spot |

The last row is kept on purpose. A change to a class that repeats down a long
page spreads its regions as widely as text-rendering noise does, and the
regions alone cannot tell them apart. The tests pin that limit so a change to
the rule is a deliberate one.

## `size-mismatch/` (the taller-candidate false negative, reproduced 2026-10-16)

The DOM snapshots of the scenario in which a capture taller than its baseline
passed with 0%: a full-page baseline of nine product cards at 1280×2348, then
one card appended below the fold, so the current capture is 1280×2538. Before
the fix, `compareAll` sized the diff canvas to the baseline and truncated the
candidate to it, so the identical overlap gave `diffCount: 0` and
`applyPassCriteria` reported `passed` while `dom.summary` said
`{ added: 4, textChanges: 2 }`. The mirror case (a card removed, candidate
shorter) was caught, because the missing rows were zero-filled.

- `nine-cards.dom.html` — the baseline's DOM (nine `article.card`)
- `ten-cards.dom.html` — the current capture's DOM (a tenth card appended);
  `domDiff` reports `{ added: 4, removed: 0, attributeChanges: 0, textChanges: 2 }`,
  the same summary as the real run

The screenshots are not committed: `compare-size-mismatch.test.ts` draws the
pages synthetically at the real dimensions (1280×2348 and 1280×2538, one card
per 190px band, the tenth entirely in the added band so the overlap is
pixel-identical) and compares them with these DOMs. The test pins what the real
run must now report: `changed`, `sizeMismatch`, every padded pixel counted,
and the verdict "page grew 190 px".
