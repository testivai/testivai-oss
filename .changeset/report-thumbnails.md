---
'@testivai/witness': minor
---

The report writes `images/<name>/thumb.png` for each `changed` snapshot: the changed area of the baseline, the current capture and the diff side by side, 2 px apart, at most 800×400 px (area-average downscale, never upscaled), small enough to show inline where a full-page diff is not, such as a pull request comment. The area is the union of the up to three largest diff regions padded 24 px, or without regions a 400 px band from the first differing row; on a size change it is on the padded canvas. results.json schema 2.6.0 (additive) records it as `snapshots[].thumbPath`. Never written for passed (auto-passed included) or new snapshots; the HTML report does not show it. `parseReportData` accepts `thumbPath` as text and, like the other image paths, never copies it from the file.
