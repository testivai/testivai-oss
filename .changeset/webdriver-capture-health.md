---
"@testivai/witness-selenium": minor
"@testivai/witness-webdriverio": minor
---

Capture health. Each capture of a web page now records what failed to load (web fonts, stylesheets, images, requests that answered 400 or more) as `health` in the capture's `metadata.json`, as the Playwright adapter does. The shared probe (`HEALTH_PROBE_EXPRESSION`) reads it right after the screenshot, before the capture style comes off. Approving a capture freezes it into the baseline.

What changes in the report: a web font or a stylesheet that failed to load makes the snapshot an **unhealthy capture**. It is `changed` and never likely render noise. Until now, a page whose web font answered 404 could auto-pass as render noise with `noiseAutoPass` on: the DOM and the declared styles are the same, and only the glyphs differ. A probe that fails or answers something malformed records nothing, so the capture reads "not checked", never healthy. A native app screen (WebdriverIO with Appium) has no page, so it is never probed.

`witness()` in both adapters was split into helpers first, with the same calls in the same order; the only call added is the probe.
