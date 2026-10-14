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
    "minSize": 10,        // smallest cluster (changed px) listed as a region; smaller ones still count toward diff %
    "mergeDistance": 12   // merge clusters within N px of each other
  }
}
```

`minSize` leaves isolated specks out of the region list (their pixels still
count toward the diff percentage and the status); `mergeDistance` re-joins one
logical change that rasterized as several nearby fragments (e.g. letters
of one word). Merging cascades until stable.

## Element attribution — which element changed

When captures carry an element map (`elements.json`, recorded by the
Playwright JS/TS, WebdriverIO, Selenium and Ruby adapters; not by
playwright-python, playwright-java, the `testivai witness <url>` crawler or
the `testivai run` sidecar), every region is attributed to the smallest
element covering it:

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
older captures, capture paths without one) → regions still work, just
without names, and there is no style check or shift detection.

## Style fingerprint — closing the stylesheet-only gap

The noise hint's historical weakness (documented in our benchmark repo): a
stylesheet-only change alters pixels while the DOM stays identical, which
looked exactly like render noise. With element maps on both sides, the
computed-style digests are compared too, and only a match keeps the
"likely render noise" reading:

| DOM | Style digests | Verdict |
|---|---|---|
| identical | match | likely render noise (`styleCheck: "match"`) when the diff is small and scattered, still not proof; auto-passed only with `noiseAutoPass`, up to `noiseMaxDiffPercent` |
| identical | match, diff concentrated in one area or over 1% | **Not noise**: the digest covers a fixed list of properties, so this is a bad capture or a change it does not cover (size, overflow, transform, images…). Compare the images before approving; `noiseAutoPass` never passes a concentrated diff |
| identical | **differ** | **Styles changed** — real change, attributed to the element(s); `noiseAutoPass` never passes it |
| identical | unavailable | **Styles not compared** (`styleCheck: "unavailable"`: no element map on one or both sides, or no comparable digest) — could be render noise or a stylesheet-only change, which is not ruled out. Compare the images before approving; `noiseAutoPass` never passes it |
| changed | — | DOM changed (counts shown) |

`dom.noiseHint` is `true` in the first, second and fourth rows; `styleCheck`
and the shape of the diff tell them apart. A `maxDiffPercent` / `maxDiffPixels` tolerance is
blind to all of this: it passes any diff within its bound, whatever the row.

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
5. Pass criteria (`maxDiffPercent`, `maxDiffPixels`, `noiseAutoPass`,
   `shiftTolerance`) decide the verdict. Each is off until you configure
   it — see [Getting Started](./intro.md) for those.
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
