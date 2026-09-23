# Changelog

## 0.3.2

### Patch Changes

- Updated dependencies [fcd39f8]
  - @testivai/witness@2.0.2

## 0.3.1

### Patch Changes

- Updated dependencies [e289450]
  - @testivai/witness@2.0.1

## 0.3.0

### Minor Changes

- ec92541: Remove the retired cloud/hosted-service code paths. TestivAI is local-only; every capture now produces full evidence (screenshot, DOM snapshot, computed-style digest, element map) unconditionally.

  BREAKING (`@testivai/witness`):

  - The `testivai auth` CLI command is removed. There is no account and no API key.
  - `mode` is removed from `.testivai/config.json` (`LocalConfig`). Existing configs that still carry it load fine — the field is ignored.
  - Removed exports: `authCommand`, `isLocalMode`, and the `@testivai/common` re-exports (`CoreApiClient`, `DEFAULT_CORE_API_URL`, `saveCredentials`, `loadCredentials`, `deleteCredentials`, `getApiKey`, `isAuthenticated`, `findConfigFile`, `loadConfig`, `configExists`, `getOutputDir`, `CompressionHelper`, `compressionHelper`).
  - Removed types: `GitInfo`, `BrowserInfo`, `BatchPayload`, `CiInfoPayload`, `BatchResult`, `PerformanceTimings`, `LighthouseResults`.
  - `testivai run` no longer takes `--batch-id` and never contacts a server.
  - The `@testivai/common` package is retired; nothing depends on it anymore.

  BREAKING (`@testivai/witness-playwright`):

  - `TESTIVAI_API_KEY`, `TESTIVAI_API_URL`, and `TESTIVAI_MODE` no longer affect the adapter. Previously a stray API key silently switched the reporter into a cloud-upload path that skipped DOM/style capture and report generation.
  - Reporter options `apiUrl`, `apiKey`, and `compression` are removed (`debug` and `captureOnly` remain).
  - `TestivAIConfig` is reduced to the options the local pipeline consumes: `useBrowserCapture`, `ignoreSelectors`, `stabilize`, `mask`. The cloud-analysis knobs (`layout`, `ai`, `structure`, `performanceMetrics`, `selectors`, `environments`, plus `apiKey`/`apiUrl` in `testivai.config.ts`) are removed and were ignored locally.
  - Removed exports: `testivai.ci` and the `StructureAnalysis`/`StructureAnalysisConfig` types.
  - Runtime dependencies dropped: `axios`, `cross-fetch`, `simple-git`, `chalk`, `commander`, `@testivai/common`.

  `@testivai/witness-webdriverio`:

  - The service now generates the report unconditionally in `onComplete`. Previously a project without `.testivai/config.json` (or with a legacy `mode: "cloud"` value) got no report at all and a "Cloud mode is not yet supported" log line. Zero-config projects now work like the other adapters.

  Also fixes a latent bug: DOM snapshots larger than 5 MB were gzip-compressed and then stored as a UTF-8 string, corrupting the stored HTML. The compression step (an upload optimization) is gone.

### Patch Changes

- Updated dependencies [5af0816]
- Updated dependencies [ec92541]
  - @testivai/witness@2.0.0

## 0.2.14

### Patch Changes

- Updated dependencies [f80f6c6]
- Updated dependencies [09eafd4]
- Updated dependencies [6fdc1db]
  - @testivai/witness@1.13.0

## 0.2.13

### Patch Changes

- ffc2171: Docs and CLI output now match what the tool actually does. `testivai init` no longer offers a "Cloud" mode or tells you to run `testivai auth <api-key>`; the second wizard choice is what it always really was — helper-file generation for non-Playwright frameworks. Removed the last `dashboard.testiv.ai` URLs from CLI output and error messages. Corrected the documented exit-code contract (code 3 fires by default), the `results.json` schema version and field list, several nonexistent CLI flags, and the WebdriverIO quickstart, which silently produced no report without `.testivai/config.json`.
- c9b01a6: Refreshes npm descriptions and keywords. `@testivai/witness-playwright` still described itself as a "Playwright sensor for Testivai Visual Regression Test system" — pre-rename terminology with the brand misspelled, on the most-viewed package page. Descriptions now match the local-first positioning and keywords cover the terms people actually search.
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

## 0.2.12

### Patch Changes

- Updated dependencies [b70ebd9]
  - @testivai/witness@1.11.1

## 0.2.11

### Patch Changes

- Updated dependencies [f94048d]
- Updated dependencies [8de6c13]
  - @testivai/witness@1.11.0

## 0.2.10

### Patch Changes

- Updated dependencies [271f30d]
  - @testivai/witness@1.10.0

## 0.2.9

### Patch Changes

- Updated dependencies [381279b]
  - @testivai/witness@1.9.0

## 0.2.8

### Patch Changes

- Updated dependencies [139d28d]
- Updated dependencies [1c4c883]
  - @testivai/witness@1.8.0

## 0.2.7

### Patch Changes

- Updated dependencies [fa0deb5]
- Updated dependencies [e37eb33]
  - @testivai/witness@1.7.1

## 0.2.6

### Patch Changes

- Updated dependencies [5bfdca5]
- Updated dependencies [9db57c2]
  - @testivai/witness@1.7.0

## 0.2.5

### Patch Changes

- Updated dependencies [2168b81]
  - @testivai/witness@1.6.0

## 0.2.4

### Patch Changes

- Updated dependencies [a13563e]
  - @testivai/witness@1.5.0

## 0.2.3

### Patch Changes

- Updated dependencies [a8cbabf]
  - @testivai/witness@1.4.0

## 0.2.2

### Patch Changes

- Updated dependencies [7cb179f]
  - @testivai/witness@1.3.1

## 0.2.1

### Patch Changes

- Updated dependencies [767385e]
- Updated dependencies [0158619]
  - @testivai/witness@1.3.0

## 0.2.0

### Minor Changes

- e98903b: Fix baseline keying collisions in multi-project / multi-capability runs.

  Previously, two Playwright projects (e.g. `chromium-desktop` and `mobile-safari`) capturing the same snapshot name silently overwrote each other's baselines under `.testivai/baselines/<name>/` — making cross-browser and responsive configs unusable.

  The variant is now folded into the snapshot name:

  - **Playwright**: when the config runs more than one project, snapshots become `<name>__<project>` (e.g. `homepage__mobile-safari`). Single-project configs are completely untouched — `homepage` stays `homepage`, and existing baselines keep working.
  - **WebdriverIO**: new per-call `variant` option — `testivai.witness(browser, 'homepage', { variant: 'firefox-mobile' })` — for multi-capability runs.

  Because the variant lives in the name, the on-disk layout, `results.json` schema, HTML report, `testivai approve`, and `/testivai approve` PR comments all work unchanged.

- d239b31: Attack the top reasons teams abandon visual testing — flaky captures and pixel-perfect strictness:

  **Stabilized captures (both adapters, on by default).** Before every screenshot: CSS animations and transitions are frozen, the text caret is hidden, smooth scrolling is forced instant, and the capture waits (bounded 3s) for web fonts to finish loading. Disable with `stabilize: false` — globally in `.testivai/config.json`, per project in `testivai.config.ts` (Playwright), or per call.

  **Human-intuitive pass criteria (`@testivai/witness`).** New `.testivai/config.json` fields:

  - `maxDiffPercent` (default 0) — diffs at or below this percentage report as passed
  - `maxDiffPixels` — absolute changed-pixel variant; either criterion passing is enough
  - `noiseAutoPass` (default false) + `noiseMaxDiffPercent` (default 1) — DOM-identical diffs (the noise hint) within the bound auto-pass instead of demanding review

  Auto-passed snapshots keep their diff image and carry `autoPassed: "threshold" | "noise"` in `results.json` (additive schema change); the HTML report labels them. Byte-different but visually identical captures (nothing above the per-pixel threshold) now report as passed instead of `changed 0.01%`.

  **WebdriverIO parity: `ignoreSelectors`.** The WebdriverIO adapter now honors `ignoreSelectors` from `.testivai/config.json` and accepts per-call `ignoreSelectors` in `witness()` options, hiding matched elements (`visibility: hidden`, layout-preserving) for the duration of the capture — matching the Playwright adapter.

### Patch Changes

- 6a74d40: Dogfooding fixes — found by running `testivai witness` against our own marketing site:

  **Stabilization no longer hides entry-animated content.** The injected CSS now uses near-zero durations (`animation-duration: 0.001s`, one iteration, `transition-duration: 0.001s`) instead of `animation/transition: none`, so animations **complete instantly at their final state**. Pages whose content starts at `opacity: 0` and reveals via entry animations or class transitions — most modern marketing/vibe-coded sites — render fully instead of capturing blank.

  **Standalone mode reveals scroll-triggered content.** `testivai witness <url>` now scrolls stepwise through the page (bounded) and returns to the top before capturing, so IntersectionObserver reveal-on-scroll sections actually render — without resizing the viewport, which would break `100vh` layouts.

  **The DOM diff now sees text.** Visible text nodes are tokenized (whitespace-normalized; script/style bodies stay opaque) and reported as `textChanges` in the DOM summary. Previously a wording change (`Free` → `Gratis`) read as "structurally identical" — harmless when the noise hint was only a label, but with `noiseAutoPass` enabled it silently auto-passed real text regressions. Text changes now mark the DOM as changed, never auto-pass, and appear in the HTML report, the PR comment, and MCP verdicts (`results.json` schema addition, backward compatible).

  **`ignoreSelectors` now excludes elements from the DOM snapshot too.** Ignored elements were only hidden visually; with the text-aware DOM diff, dynamic ignored content (live counters, feeds) would flag DOM changes the pixels could not show. All three capture paths now serialize the DOM with ignored elements removed — one consistent semantic: ignored means excluded from both signals.

  **Standalone capture hardening (from live-site dogfooding):** layout metrics are polled until non-zero (fresh Chrome can report 0-width before first layout), and the web-font wait is extended to 10s bounded — a fallback-font capture diffs 30%+ against a webfont baseline on real networks.

- Updated dependencies [aa66850]
- Updated dependencies [d239b31]
- Updated dependencies [c0ac195]
- Updated dependencies [6a74d40]
  - @testivai/witness@1.2.0

## 0.1.3

### Patch Changes

- Updated dependencies [0897932]
  - @testivai/witness@1.1.0

## 0.1.2

### Patch Changes

- Updated dependencies [d37a2bc]
  - @testivai/witness@1.0.4

## 0.1.1

### Patch Changes

- Updated dependencies [60a886f]
  - @testivai/witness@1.0.3

All notable changes to @testivai/witness-webdriverio will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-05-08

### Added

- Initial release: local-mode WebdriverIO adapter
- `testivai.witness(browser, name)` capture — writes screenshot + DOM snapshot to `.testivai/baselines/`
- `TestivAIService` WDIO service for automatic local-mode session setup (no `testivai run` sidecar needed)
- Uses `browser.takeScreenshot()` + `browser.execute()` — no CDP, no port polling
- Baseline store integration: first capture creates baseline; subsequent runs compare and write diff to `.testivai/temp/`
- Compatible with local HTML report generated by `@testivai/witness`
- Cloud mode pending (iteration 2)
