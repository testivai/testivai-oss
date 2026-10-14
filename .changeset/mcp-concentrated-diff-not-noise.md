---
"@testivai/mcp": minor
---

An identical DOM with matching computed styles is no longer called likely render noise when the diff is concentrated in one area or large. The style check covers a fixed list of properties, so a real change to size, overflow, transform or an image, or a bad capture, looks the same to it; render noise is small and scattered.

- `get_visual_results`, `explain_snapshot`, the change groups and the `review-visual-changes` prompt give a diff whose regions all fit in a box covering at most a third of the page its own verdict, which names the regions and their box: "a bad capture, or a change the style check does not cover; compare the images (get_diff) before approving". A spread-out diff over 1% of pixels gets a "large" verdict that says the same. On real runs, the clipped product card from the `triage-visual-diff` eval (0.03% of pixels, 3 regions in 0.8% of the page), a capture whose card text did not paint and a baseline with a shifted band no longer read as noise; scattered text-rendering noise still does.
- `explain_snapshot` adds `layers.pixel.shape` (`scattered`, `concentrated` or `large`, with the regions' box and its share of the page) and, for a concentrated diff, names the element every region maps to.
- Concentrated diffs are never grouped (each sits in its own area); large ones get their own `large-diff` group, apart from noise.
- A `noise` auto-pass of a concentrated diff from an older witness says to look at the diff.

The rule comes from `diffShape` in `@testivai/witness`, read from `results.json` fields older versions already write, so it applies to existing results too.
