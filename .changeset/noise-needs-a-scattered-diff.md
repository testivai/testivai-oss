---
"@testivai/witness": minor
---

A diff with an identical DOM and matching computed styles is called likely render noise only when it is also small and scattered. The style digest covers a fixed list of properties, so a real change to size, overflow, position, transform, text decoration, filters, pseudo-elements or an image leaves the DOM identical and the styles matching, and so does a bad capture. Render noise is scattered; those are not.

- **`noiseAutoPass` no longer passes a diff concentrated in one area.** When every diff region fits in a box covering at most a third of the page, the snapshot stays `changed` for a human, whatever `noiseMaxDiffPercent` allows. Scattered diffs pass as before, up to `noiseMaxDiffPercent`. Measured on real runs: a `max-height`/`overflow` bug that clipped one product card (0.03% of pixels, 3 regions in 0.8% of the page), a capture whose card text did not paint, and a baseline with a shifted band no longer auto-pass; text-rendering noise spread over the page (20 regions over 38% of it) still does.
- **The HTML report has its own verdict for these diffs.** "Diff concentrated in one area" names the regions and their box, and says it is a bad capture or a change the style check does not cover. "Large diff" covers a spread-out diff over 1% of pixels. "Likely render noise" now also says the diff is small and scattered.
- **New exports from `@testivai/witness/report`:** `diffShape(result)` reads that shape from `diffPercent`, `totalPixels` and `regions` (with `describeRegions`, `NOISE_MAX_DIFF_PERCENT`, `CONCENTRATED_MAX_PAGE_SHARE` and `STYLE_CHECK_DOES_NOT_COVER`), so `@testivai/mcp` and the GitHub Action apply the same rule.

Known limit: a change to a class that repeats down a long page spreads its regions as widely as text-rendering noise, so a small one can still read as scattered.

`results.json` is unchanged: `dom.noiseHint` still means "DOM identical and no style mismatch found". The shape is read from fields results.json already has, so older results read the same way.
