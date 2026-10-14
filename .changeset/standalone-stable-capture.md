---
"@testivai/witness": patch
---

Standalone captures (`testivai witness <url>`) no longer report an unchanged page as changed now and then. Even after the page had rendered fresh frames, Chrome occasionally returned an older frame for the full-page screenshot: the layout from before the capture viewport was applied (narrow-viewport styles, a collapsed `min-height: 100vh` hero), or an entry animation part-way through. Each page is now captured until two captures in a row match, up to four captures, so a stale frame is caught and replaced. A page whose captures always match costs one extra screenshot.

The wait for a fresh frame before capturing is also retried once when no frame arrives within a second, and runs again when a freshly launched Chrome needed its layout polled before it reported a usable page size.
