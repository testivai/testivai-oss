# Comparison: masks, regions, and tolerances

How TestivAI decides what counts as a change — and how you tune it.
Everything on this page is deterministic and configured in
`.testivai/config.json` (or per-snapshot in your test code).

## Masks — exclude areas, auditable

Masks remove page areas from the pixel diff. Unlike silent exclusions,
every mask is **hatched in the diff image** and listed in the report with
its source, so a masked-away regression can't hide.

```json
{
  "mask": [
    "#cookie-banner",
    { "x": 0, "y": 0, "width": "100%", "height": 64 },
    { "bottom": 24 }
  ]
}
```

Three shapes:

- **CSS selector** (`"#cookie-banner"`): the adapter records the matched
  elements' geometry at capture time (`getBoundingClientRect`, document
  coordinates). If a capture has no recorded geometry for the selector
  (image-only input, older captures, adapters without support yet), the
  mask is skipped **with a visible warning** in the report and
  `results.json` — never silently.
- **Geometric region**: `x/y/width/height` as px numbers, 0–1 ratios
  (`0.5` = 50%), or `"NN%"` strings. Out-of-bounds regions are clamped.
- **Edge shorthand**: `{ "top": 24 }` masks a full-width 24px strip;
  same for `right`, `bottom`, `left` (one edge per entry).

Per-snapshot masks (merged with the global list):

```ts
await witness(page, testInfo, 'pricing', {
  mask: ['.live-chat', { top: 24 }],
});
```

### mask vs ignoreSelectors — which one when?

| | `ignoreSelectors` | `mask` |
|---|---|---|
| Acts at | capture time (`visibility: hidden`) | comparison time |
| Element still occupies layout | yes | yes |
| Excluded from DOM/text signal | yes | no (DOM still compared) |
| Visible in the diff image | no (element hidden) | yes (hatched) |
| Works without DOM capture | — | geometric masks: yes |
| Good for | content that should never exist in captures (ads, live chat) | areas you want *visibly* excluded, or pixel regions with no stable selector |

Rule of thumb: reach for `ignoreSelectors` when the element is pure noise
you never want captured; reach for `mask` when you want reviewers to *see*
that an area is excluded, or when only coordinates are stable.

## Regions — "3 changed regions", not "2.1% of pixels"

Changed pixels are clustered into connected regions with bounding boxes.
The report shows each region as a clickable chip (zooms the diff), and
`results.json` carries them for CI and agents:

```json
"regions": [
  { "x": 150, "y": 100, "width": 40, "height": 20, "diffPixels": 800, "diffPercent": 100 }
]
```

Tunables:

```json
{
  "diffRegions": {
    "minSize": 10,        // noise floor: ignore clusters smaller than N changed px
    "mergeDistance": 12   // merge clusters within N px of each other
  }
}
```

`minSize` filters isolated speck noise; `mergeDistance` re-joins one
logical change that rasterized as several nearby fragments (e.g. letters
of one word). Merging cascades until stable.

## Element attribution — which element changed

When captures carry an element map (`elements.json`, recorded automatically
by the Playwright adapter in local mode), every region is attributed to the
smallest element covering it:

```json
"regions": [{
  "x": 100, "y": 100, "width": 80, "height": 50,
  "elements": [{ "selector": "body > main > div.card:nth-of-type(2)", "role": "shifted" }],
  "classification": "shift",
  "shift": { "dx": 0, "dy": 10 }
}]
```

**Shift classification is exact, not estimated**: an element present in
both captures with the same size and the same computed-style digest but a
new position is a pure translation — (dx, dy) comes from layout, so the
report can say "`div.card` shifted +10px vertically — content unchanged"
instead of flagging a wall of changed pixels. Anything resized, restyled,
or with different content classifies as a real `change`.

The whole-page variant catches the classic injected-banner case: when
elements below a line all moved by one uniform offset, the snapshot gains

```json
"pageShift": { "dy": 24, "belowY": 80, "count": 14 }
```

and the report explains it in words. No element map (image-only input,
older captures, adapters without support yet) → regions still work, just
without names.

## Style fingerprint — the noise hint you can trust

The noise hint's historical weakness (documented in our benchmark repo): a
stylesheet-only change alters pixels while the DOM stays identical, which
looked exactly like render noise. With element maps on both sides, the
hint now requires the computed-style digests to match too:

| DOM | Style digests | Verdict |
|---|---|---|
| identical | match | likely render noise (`styleCheck: "match"`) |
| identical | **differ** | **Styles changed** — real change, attributed to the element(s); never auto-passed |
| identical | unavailable | legacy DOM-only hint, labeled `styleCheck: "unavailable"` |
| changed | — | DOM changed (counts shown) |

The digest covers a fixed, documented property list (colors, backgrounds,
borders, typography, spacing, shadows, opacity/visibility/display) —
deterministic for identical rendering, captured per element at capture
time.

## Order of operations

1. `ignoreSelectors` hide elements during capture.
2. Masks equalize their areas before the pixel loop.
3. The pixel diff runs with `threshold` (per-pixel) and the engine's
   anti-aliasing absorption.
4. Clustering groups what remains into regions.
5. Pass criteria (`maxDiffPercent`, `maxDiffPixels`, `noiseAutoPass`)
   decide the verdict — see [Getting Started](./intro.md) for those.
6. Mask hatching is drawn onto the diff image (after clustering, so the
   hatch itself never counts as a region).

## results.json additions (current schema: 2.3.0)

Every field below is additive — existing consumers keep working:

- `snapshots[].regions[]` — clustered diff bounding boxes (top-left sorted)
- `snapshots[].masks[]` — every applied mask, resolved to pixels, with
  `source: { type: selector|region|edge, spec, origin: config|call }`
- `snapshots[].maskWarnings[]` — masks that could not be applied and why
- `snapshots[].regions[].elements/classification/shift` — attribution (needs element maps)
- `snapshots[].pageShift` — whole-page uniform displacement
