---
"@testivai/witness": minor
---

New exports for adapters that capture through CDP `Page.captureScreenshot` with `captureBeyondViewport`: `FRESH_FRAME_EXPRESSION` and `FRESH_FRAME_TIMEOUT_MS` (an in-page wait for two rendered animation frames), `settleFreshFrame()` (waits for a fresh frame, retries once, never throws), `captureUntilStable()` (captures until two in a row match, at most `MAX_STABLE_CAPTURES`, 4), and the `CaptureLog` and `CaptureUntilStableOptions` types. They guard against Chrome returning a frame painted for the wrong viewport while it sets up a beyond-viewport capture. `@testivai/witness-playwright` uses them, and `testivai witness <url>` now runs on the same code, with no change in behavior.
