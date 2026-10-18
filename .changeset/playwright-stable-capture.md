---
"@testivai/witness-playwright": patch
---

Full-page captures no longer report an unchanged page as changed now and then. Chrome can return a frame painted for the wrong viewport while it sets up a beyond-viewport capture, and the adapter kept whatever the single capture returned. On testivai-site's CI, the home page's em-sized text was drawn at its `@media (max-width: 480px)` size (body 17px instead of 18px) in some captures: every element's measured box and computed styles matched the baseline, the pixels were 4.13% different, and the same commit passed on a re-run.

The adapter now waits for a freshly rendered frame before measuring and capturing (retried once when none arrives within a second), then captures until two captures in a row are identical, up to four. This is the same guard `testivai witness <url>` has used since `@testivai/witness` 2.1.0 and 2.2.0, now shared from `@testivai/witness`. A stable page costs one extra screenshot; a page that never stops changing costs four and keeps the last. It runs on every capture, independent of `stabilize`. `TESTIVAI_DEBUG=true` logs when captures differed.

Baselines approved from a wrong frame may show as changed once after upgrading: compare the images, then approve the capture that matches the page.
