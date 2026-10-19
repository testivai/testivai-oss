# @testivai/witness-selenium

## 0.3.12

### Patch Changes

- cd9ffe7: Capture provenance: every capture now records where it came from, and the report says when a diff is the machine changing rather than the page. The Playwright, WebdriverIO and Selenium (JS) adapters and `testivai witness <url>` write an `environment` block into the capture's `metadata.json`: the OS (and the Linux distro), the browser and its version (and the WebDriver binary), the test framework, the adapter and how it took the screenshot (`full-page:cdp`, `full-page:playwright`, `full-page:stitched`, `viewport:webdriver`), what the page was rendered with (viewport, device scale, color scheme, reduced motion, locale, time zone, measured in the page), the CI provider and runner image, a container, and `TESTIVAI_ENV_LABEL`. Approving a capture freezes its block into the baseline's `metadata.json` (and drops a stale one). The compare reads both blocks: results.json schema 2.5.0 (additive) adds `snapshots[].environment` (`delta`, `renderingDelta`, both blocks when they differ) and a run-level `environment` (the fields every capture of the run agrees on). Framework, adapter and driver versions, the CI runner image, the project and the Linux kernel are context; the rest can change rendering. A diff whose DOM is identical, whose computed styles match and whose rendering environment changed is now **rendering drift** in the HTML report, `@testivai/mcp` (`get_visual_results` verdicts, its grouping and a new opening line when several snapshots share one change; `explain_snapshot`'s new `layers.environment`; the `triage-visual-diff` rubric) and the GitHub Action comment, never "likely render noise"; a size change from another capture method says so instead of "page grew". New config `environmentPolicy`: `"warn"` (default) never changes a status; `"separate"` keys snapshots `<name>__<browser>__<platform>` (never by version) and reports missing only the baselines of an environment the run captured; `"strict"` makes a rendering change of environment `changed` whatever its pixels say. New `testivai env` prints this machine's part of the block (`--fonts` adds a fingerprint of the installed fonts, `--json` for machines). `@testivai/witness` exports the collectors (`collectHostEnvironment`, `RENDER_PROBE_EXPRESSION`, `browserFromCapabilities`, `webDriverEnvironment`, `applyEnvironmentPolicyToName`, …) and `@testivai/witness/report` the readings (`diffEnvironments`, `isRenderingDrift`, `environmentChangeGroups`, `environmentChangeLine`, …). `BaselineStore` gains `writeTempMetadata` and `readTempMetadata`. The WebdriverIO and Selenium `WitnessBrowser` / `WitnessDriver` types gain the optional `capabilities` / `getCapabilities()` they read the browser from. The Python, Ruby and Java adapters do not record the block yet; their captures compare exactly as before.
- Updated dependencies [cd9ffe7]
- Updated dependencies [c05d870]
  - @testivai/witness@2.5.0

## 0.3.11

### Patch Changes

- 5adb5e9: Full-page captures on Chrome and Edge no longer report an unchanged page as changed now and then. Chrome can return a frame painted for the wrong viewport while it sets up a beyond-viewport capture, and the adapter kept whatever its single `Page.captureScreenshot` returned. In a local run against headless Chromium 141 with ChromeDriver (two unchanged pages, device scale factor 1 and 2, 20 captures each), the old adapter returned a stray image in 2 to 5 captures in three of the four runs; this one returned none.

  The adapter now waits for a freshly rendered frame before measuring and capturing (retried once when none arrives within a second), measures the page in CSS pixels, then captures until two captures in a row are identical, up to four. This is the guard the Playwright adapter and `testivai witness <url>` use, shared from `@testivai/witness`. A stable page costs one extra screenshot; a page that never stops changing costs four and keeps the last. It runs on every Chromium capture, independent of `stabilize`. `TESTIVAI_DEBUG=true` logs when captures differed. Firefox and Safari keep the viewport screenshot.

  A good capture is unchanged: on the pages tested, the kept image was byte-identical to the old adapter's usual one. Baselines approved from a wrong frame may show as changed once after upgrading: compare the images, then approve the capture that matches the page.

## 0.3.10

### Patch Changes

- Updated dependencies [ebaf705]
  - @testivai/witness@2.4.0

## 0.3.9

### Patch Changes

- Updated dependencies [0ec2cf8]
  - @testivai/witness@2.3.1

## 0.3.8

### Patch Changes

- Updated dependencies [f538f0c]
  - @testivai/witness@2.3.0

## 0.3.7

### Patch Changes

- Updated dependencies [18ef81d]
  - @testivai/witness@2.2.1

## 0.3.6

### Patch Changes

- Updated dependencies [23c126e]
- Updated dependencies [b3fb0e6]
- Updated dependencies [34d7304]
  - @testivai/witness@2.2.0

## 0.3.5

### Patch Changes

- Updated dependencies [10dc7d3]
  - @testivai/witness@2.1.1

## 0.3.4

### Patch Changes

- Updated dependencies [b2892e5]
- Updated dependencies [b380f3c]
  - @testivai/witness@2.1.0

## 0.3.3

### Patch Changes

- Updated dependencies [fcd39f8]
  - @testivai/witness@2.0.2

## 0.3.2

### Patch Changes

- Updated dependencies [e289450]
  - @testivai/witness@2.0.1

## 0.3.1

### Patch Changes

- Updated dependencies [5af0816]
- Updated dependencies [ec92541]
  - @testivai/witness@2.0.0

## 0.3.0

### Minor Changes

- f80f6c6: Sharded and parallel runs now work the same way in every language, not just Playwright. `TESTIVAI_SHARD=i/N` and `TESTIVAI_CAPTURE_ONLY=1` are honoured by the Playwright, Selenium, Python, Java and Ruby adapters, so a Selenium or pytest suite joins the same capture → merge → compare-once flow with the same completeness guarantee. Playwright still auto-detects `--shard`, now as a convenience on top of the shared contract rather than a separate mechanism.

  Also fixes a real bug in the pytest plugin: `pytest_sessionfinish` fires in every xdist worker, so `pytest -n 8` launched eight concurrent comparisons racing on the same `visual-report/`. Only the controller reports now.

- 09eafd4: Captures now wait for the page to stop changing, in every language. On top of the existing animation/caret/font stabilization, `stabilize` waits for `document.readyState === 'complete'`, for every image to finish, and for 150ms without DOM mutations — bounded at 5 seconds, so a page that never settles is captured rather than hanging the suite. The probe is generated from one TypeScript source and shipped to the Python, Java and Ruby adapters, so all five poll the identical predicate. Deliberately not network idle, which Playwright's own docs mark DISCOURAGED for testing and which is the wrong signal for a screenshot.

### Patch Changes

- Updated dependencies [f80f6c6]
- Updated dependencies [09eafd4]
- Updated dependencies [6fdc1db]
  - @testivai/witness@1.13.0

## 0.2.0

### Minor Changes

- 0eb2adb: The Selenium (JavaScript) adapter now captures the element map, so region→selector attribution, the style-only-change verdict, and page-shift detection work there exactly as they do for Playwright. The page-side collector moved into `@testivai/witness` and is exported as `collectElementMap` / `buildElementMapExpression`, so every adapter injects the identical function rather than a copy. New per-call options: `skipElementMap` and `maxElements`. Capture is best-effort — if the script is blocked, the report falls back to the pixel and DOM layers instead of failing.

### Patch Changes

- Updated dependencies [ffc2171]
- Updated dependencies [90109b5]
- Updated dependencies [2a37518]
- Updated dependencies [750562e]
- Updated dependencies [1efe97f]
- Updated dependencies [c9b01a6]
- Updated dependencies [003765d]
- Updated dependencies [cba53b5]
- Updated dependencies [0eb2adb]
- Updated dependencies [9aa0f14]
- Updated dependencies [8997ccd]
  - @testivai/witness@1.12.0

## 0.1.10

### Patch Changes

- Updated dependencies [b70ebd9]
  - @testivai/witness@1.11.1

## 0.1.9

### Patch Changes

- Updated dependencies [f94048d]
- Updated dependencies [8de6c13]
  - @testivai/witness@1.11.0

## 0.1.8

### Patch Changes

- Updated dependencies [271f30d]
  - @testivai/witness@1.10.0

## 0.1.7

### Patch Changes

- Updated dependencies [381279b]
  - @testivai/witness@1.9.0

## 0.1.6

### Patch Changes

- Updated dependencies [139d28d]
- Updated dependencies [1c4c883]
  - @testivai/witness@1.8.0

## 0.1.5

### Patch Changes

- Updated dependencies [fa0deb5]
- Updated dependencies [e37eb33]
  - @testivai/witness@1.7.1

## 0.1.4

### Patch Changes

- Updated dependencies [5bfdca5]
- Updated dependencies [9db57c2]
  - @testivai/witness@1.7.0

## 0.1.3

### Patch Changes

- Updated dependencies [2168b81]
  - @testivai/witness@1.6.0

## 0.1.2

### Patch Changes

- Updated dependencies [a13563e]
  - @testivai/witness@1.5.0

## 0.1.1

### Patch Changes

- Updated dependencies [a8cbabf]
  - @testivai/witness@1.4.0

## 0.1.0

### Minor Changes

- e2d634d: New package: native Selenium WebDriver adapter. `testivai.witness(driver, name)` captures through Selenium's public APIs — full-page via CDP on Chrome/Edge, viewport elsewhere — with the same stabilization, ignoreSelectors, variant keying, and on-disk contract as every other TestivAI adapter. Pairs with `testivai report` for the compare/report half.

### Patch Changes

- Updated dependencies [7cb179f]
  - @testivai/witness@1.3.1
