---
"@testivai/witness-selenium": patch
---

Full-page captures on Chrome and Edge no longer report an unchanged page as changed now and then. Chrome can return a frame painted for the wrong viewport while it sets up a beyond-viewport capture, and the adapter kept whatever its single `Page.captureScreenshot` returned. In a local run against headless Chromium 141 with ChromeDriver (two unchanged pages, device scale factor 1 and 2, 20 captures each), the old adapter returned a stray image in 2 to 5 captures in three of the four runs; this one returned none.

The adapter now waits for a freshly rendered frame before measuring and capturing (retried once when none arrives within a second), measures the page in CSS pixels, then captures until two captures in a row are identical, up to four. This is the guard the Playwright adapter and `testivai witness <url>` use, shared from `@testivai/witness`. A stable page costs one extra screenshot; a page that never stops changing costs four and keeps the last. It runs on every Chromium capture, independent of `stabilize`. `TESTIVAI_DEBUG=true` logs when captures differed. Firefox and Safari keep the viewport screenshot.

A good capture is unchanged: on the pages tested, the kept image was byte-identical to the old adapter's usual one. Baselines approved from a wrong frame may show as changed once after upgrading: compare the images, then approve the capture that matches the page.
