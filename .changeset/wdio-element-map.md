---
"@testivai/witness-webdriverio": minor
---

The WebdriverIO adapter now captures the element map (each element's box and a digest of its computed styles) and writes `elements.json`, like the Playwright and Selenium adapters. The style check now works for WebdriverIO: a stylesheet-only change with an identical DOM is reported as a real style-only change instead of likely render noise. Region attribution and page-shift detection also work. WebDriver screenshots are viewport-sized, so the map keeps only the elements inside the captured viewport, in screenshot coordinates. New options: `skipElementMap` and `maxElements`. Capture is best-effort, like the DOM: if it fails, the pixel diff still runs.
