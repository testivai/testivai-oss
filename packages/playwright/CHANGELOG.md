# Changelog

## 2.0.2

### Patch Changes

- Updated dependencies [fcd39f8]
  - @testivai/witness@2.0.2

## 2.0.1

### Patch Changes

- 8430822: Bump `sharp` to `^0.35.3` to clear two high-severity libvips advisories.

  `sharp@0.34.x` carries GHSA-f88m-g3jw-g9cj (CVE-2026-33327, CVE-2026-33328,
  CVE-2026-35590, CVE-2026-35591), which `npm audit` reports as unfixable while
  the range is pinned to `^0.34.5` — so a plain
  `npm install -D @testivai/witness-playwright` ended with "2 high severity
  vulnerabilities" attributed to this package, failing any CI that runs
  `npm audit --audit-level=high`. `sharp@0.35.3` audits clean and needs no code
  change: the `create` / `composite` / `png` API used for scroll-and-stitch
  capture is unchanged.

- Updated dependencies [e289450]
  - @testivai/witness@2.0.1

## 2.0.0

### Major Changes

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

## 1.9.0

### Minor Changes

- f80f6c6: Sharded and parallel runs now work the same way in every language, not just Playwright. `TESTIVAI_SHARD=i/N` and `TESTIVAI_CAPTURE_ONLY=1` are honoured by the Playwright, Selenium, Python, Java and Ruby adapters, so a Selenium or pytest suite joins the same capture → merge → compare-once flow with the same completeness guarantee. Playwright still auto-detects `--shard`, now as a convenience on top of the shared contract rather than a separate mechanism.

  Also fixes a real bug in the pytest plugin: `pytest_sessionfinish` fires in every xdist worker, so `pytest -n 8` launched eight concurrent comparisons racing on the same `visual-report/`. Only the controller reports now.

- 09eafd4: Captures now wait for the page to stop changing, in every language. On top of the existing animation/caret/font stabilization, `stabilize` waits for `document.readyState === 'complete'`, for every image to finish, and for 150ms without DOM mutations — bounded at 5 seconds, so a page that never settles is captured rather than hanging the suite. The probe is generated from one TypeScript source and shipped to the Python, Java and Ruby adapters, so all five poll the identical predicate. Deliberately not network idle, which Playwright's own docs mark DISCOURAGED for testing and which is the wrong signal for a screenshot.

### Patch Changes

- Updated dependencies [f80f6c6]
- Updated dependencies [09eafd4]
- Updated dependencies [6fdc1db]
  - @testivai/witness@1.13.0

## 1.8.0

### Minor Changes

- 9aa0f14: Sharded runs now prove every shard reported before comparing. Each shard writes a `testivai-shard.json` manifest alongside its captures at end of run, and `merge-captures` refuses to proceed when one is unaccounted for — naming the missing shard indices. A shard that crashes or is cancelled leaves no manifest, which previously meant the merge compared partial coverage and passed silently whenever `failOnMissing` was off. The shard total is read from the manifests, with `--expect <n>` to assert it explicitly and `--allow-incomplete` to proceed anyway.
- 8997ccd: Sharded Playwright runs now work correctly. A shard only executes a slice of the suite, so comparing inside it reported every baseline owned by another shard as missing coverage — measured on a real 8-shard run, every shard exited 3 with roughly 90% of the suite listed as missing, and produced 8 partial reports with no combined view. The reporter now detects a sharded run (`--shard=i/N`) and switches to capture-only: captures are written, comparison and report generation are skipped. The new `testivai merge-captures <dirs...>` command unions the shards' captures so a single `testivai report` compares the whole suite at once — one exit code, one report, and missing-baseline detection that is correct by construction. Opt in or out explicitly with the `captureOnly` reporter option or `TESTIVAI_CAPTURE_ONLY`.

### Patch Changes

- ffc2171: Docs and CLI output now match what the tool actually does. `testivai init` no longer offers a "Cloud" mode or tells you to run `testivai auth <api-key>`; the second wizard choice is what it always really was — helper-file generation for non-Playwright frameworks. Removed the last `dashboard.testiv.ai` URLs from CLI output and error messages. Corrected the documented exit-code contract (code 3 fires by default), the `results.json` schema version and field list, several nonexistent CLI flags, and the WebdriverIO quickstart, which silently produced no report without `.testivai/config.json`.
- c9b01a6: Refreshes npm descriptions and keywords. `@testivai/witness-playwright` still described itself as a "Playwright sensor for Testivai Visual Regression Test system" — pre-rename terminology with the brand misspelled, on the most-viewed package page. Descriptions now match the local-first positioning and keywords cover the terms people actually search.
- dd8cf22: The Playwright reporter no longer implies a passing check when it isn't one. A reporter cannot set the process exit code, so a run could print `Changed: 3` and still exit `0` — reading like a visual check that passed. When snapshots changed, are new, or have missing baselines, the summary now states plainly that the build was not failed and names the command that gates it. Missing baselines are also counted in the summary line.
- 0eb2adb: The Selenium (JavaScript) adapter now captures the element map, so region→selector attribution, the style-only-change verdict, and page-shift detection work there exactly as they do for Playwright. The page-side collector moved into `@testivai/witness` and is exported as `collectElementMap` / `buildElementMapExpression`, so every adapter injects the identical function rather than a copy. New per-call options: `skipElementMap` and `maxElements`. Capture is best-effort — if the script is blocked, the report falls back to the pixel and DOM layers instead of failing.
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
  - @testivai/common@0.2.3

## 1.7.1

### Patch Changes

- Updated dependencies [b70ebd9]
  - @testivai/witness@1.11.1

## 1.7.0

### Minor Changes

- f94048d: `witness()` is now the canonical capture call — aligning the Playwright adapter with the package family (`@testivai/witness*`) and the other adapters: `import { witness } from '@testivai/witness-playwright'`. `snapshot` and `testivai.witness` remain as fully compatible aliases; nothing breaks.

### Patch Changes

- Updated dependencies [f94048d]
- Updated dependencies [8de6c13]
  - @testivai/witness@1.11.0

## 1.6.4

### Patch Changes

- Updated dependencies [271f30d]
  - @testivai/witness@1.10.0

## 1.6.3

### Patch Changes

- Updated dependencies [381279b]
  - @testivai/witness@1.9.0

## 1.6.2

### Patch Changes

- Updated dependencies [139d28d]
- Updated dependencies [1c4c883]
  - @testivai/witness@1.8.0

## 1.6.1

### Patch Changes

- Updated dependencies [fa0deb5]
- Updated dependencies [e37eb33]
  - @testivai/witness@1.7.1

## 1.6.0

### Minor Changes

- 5bfdca5: `ignoreSelectors` now supports per-selector modes. Entries may be a bare CSS
  string (default **mask** — `visibility:hidden`, layout preserved) or an object
  `{ selector, mode }` where `mode: "collapse"` uses `display:none` to remove the
  element's layout influence entirely. Collapse fixes the flake class where a
  variable-height ignored region (e.g. a dynamic footer) shifts everything below
  it. The `string[]` shape stays fully valid; both shapes can be mixed and are
  honored from `.testivai/config.json`, `testivai.config.ts`, and per-`snapshot()`
  overrides.
- 9db57c2: Local-first is now the zero-config default. With no `TESTIVAI_API_KEY`, the Playwright reporter runs in **local mode** — capturing to `.testivai/temp/<name>/` and writing the HTML report — instead of disabling itself. The scary `API Key is not configured. Disabling reporter.` error is gone, replaced by a single quiet info line; cloud mode activates only when a key is present.

  Mode is now resolved from a shared rule (`TESTIVAI_MODE` env → `.testivai/config.json` → API-key presence) used by both the reporter and `snapshot()`, fixing a mismatch where worker processes never saw the reporter's runtime mode.

  Local mode also writes a **single canonical layout** — the flat `<timestamp>_<name>.{png,json}` duplicates are no longer emitted alongside `.testivai/temp/<name>/`.

  Restored the named `snapshot` export (`import { snapshot } from '@testivai/witness-playwright'`) as documented, kept as an alias of `testivai.witness`.

### Patch Changes

- Updated dependencies [5bfdca5]
- Updated dependencies [9db57c2]
  - @testivai/witness@1.7.0

## 1.5.2

### Patch Changes

- e885125: Element maps now honor the ignoreSelectors consistency rule: elements covered by `ignoreSelectors` (and their subtrees) are excluded from the captured element map, and `visibility: hidden` elements are skipped (invisible pixels cannot explain a diff; their children still walk since visibility is overridable). Without this, an ignored dynamic element's randomized styles could trip the style fingerprint into suppressing a legitimate noise hint — found by dogfooding in the demo app on day one.

## 1.5.1

### Patch Changes

- Updated dependencies [2168b81]
  - @testivai/witness@1.6.0

## 1.5.0

### Minor Changes

- a13563e: Element attribution + shift classification. The Playwright adapter captures an element map (`elements.json`: deterministic CSS path, rect, computed-style digest per visible element) alongside every local-mode screenshot. The comparison engine intersects diff regions with the map to name WHICH element changed, and classifies pure translations from layout — same element, same size, same style digest, new position → "shifted +8px vertically — content unchanged", with exact (dx, dy). A whole-page pass reports "everything below y=N shifted" (the injected-banner signature) as `pageShift`. All additive in results.json (regions[].elements/classification/shift, snapshot pageShift); image-only inputs and older captures degrade gracefully to plain regions. `approve` carries the element map to the baseline.

### Patch Changes

- Updated dependencies [a13563e]
  - @testivai/witness@1.5.0

## 1.4.0

### Minor Changes

- a8cbabf: Masking DSL + diff clustering. Config/per-call `mask` accepts CSS selectors (geometry captured at capture time) or geometric regions (px, 0–1 ratios, "NN%", single-edge shorthands like `{ top: 24 }`); masked areas are excluded from the pixel diff AND hatched in the diff image with a full audit trail in the report — never silent. Changed pixels are clustered into regions (`results.json` 2.2.0, additive: `regions[]`, `masks[]`, `maskWarnings[]`) with `diffRegions.minSize` / `mergeDistance` tunables; the report shows clickable region chips. Also fixes results.json's schema version field, which previously carried the package version.

### Patch Changes

- Updated dependencies [a8cbabf]
  - @testivai/witness@1.4.0

## 1.3.3

### Patch Changes

- Updated dependencies [7cb179f]
  - @testivai/witness@1.3.1

## 1.3.2

### Patch Changes

- Updated dependencies [767385e]
- Updated dependencies [0158619]
  - @testivai/witness@1.3.0

## 1.3.1

### Patch Changes

- cc6f3eb: Fix per-call `ignoreSelectors` (and `stabilize`) being dropped by the config merge. `testivai.witness(page, testInfo, 'name', { ignoreSelectors: ['.badge'] })` silently ignored the selectors — the elements were neither hidden from the screenshot nor excluded from the DOM snapshot. Long masked by the diff engine's cumulated threshold absorbing the few leaked pixels; surfaced by the text-aware DOM diff correctly flagging the leaked dynamic text.

## 1.3.0

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

- aa66850: Remove the duplicate `testivai` bin and the undocumented `./cli` subpath export from `@testivai/witness-playwright`.

  Both `@testivai/witness` and `@testivai/witness-playwright` declared a `testivai` bin, so which CLI answered `npx testivai` depended on install/hoisting order. When the playwright package's init-only CLI won, documented commands like `testivai approve --all` failed. `@testivai/witness` (a dependency of this package) is now the single owner of the `testivai` bin; its CLI provides `init`, `auth`, `run`, `witness`, and `approve`, so `npx testivai init` keeps working.

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

## 1.2.1

### Patch Changes

- db80bc5: refactor: extract ignoreSelectors logic into pure testable helper module

  Move the `collectIgnoreSelectors`, `buildIgnoreSelectorsCSS`, and
  `readWitnessConfigSelectors` functions from inline code inside `snapshot.ts`
  into a dedicated `src/config/ignore-selectors.ts` module.

  No behaviour change — the logic is identical. The refactor makes the
  three-source selector merge and CSS generation unit-testable without
  a browser (26 unit tests added covering all edge cases).

## 1.2.0

### Minor Changes

- 0897932: feat: OSS noise warning in HTML report + ignoreSelectors support

  **HTML report** — adds an "OSS mode — pixel-exact" notice in the sidebar
  explaining that dynamic content may cause false positives, how to reduce
  noise (`threshold`, `ignoreSelectors`), and a pointer to TestivAI Cloud
  for AI-powered noise filtering.

  **ignoreSelectors** — new config option that hides matched CSS elements
  (via `visibility: hidden`) before the screenshot is taken, so dynamic
  content never contributes to the diff. Works in both baseline and
  candidate runs so hidden areas are always identical.

  Configure globally in `.testivai/config.json`:

  ```json
  { "ignoreSelectors": [".version-badge", "[data-testivai-ignore]"] }
  ```

  Or per-snapshot in the test:

  ```ts
  await testivai.witness(page, testInfo, "home", {
    ignoreSelectors: ["#live-chat-widget"],
  });
  ```

### Patch Changes

- Updated dependencies [0897932]
  - @testivai/witness@1.1.0

## 1.1.5

### Patch Changes

- Updated dependencies [d37a2bc]
  - @testivai/witness@1.0.4

## 1.1.4

### Patch Changes

- 60a886f: **DOM diff noise-hint** — `@testivai/witness` now runs a lightweight DOM comparison alongside every pixel diff. When screenshots diverge but the DOM tree is structurally identical, the diff is flagged with `"noiseHint": true` in `results.json` and in the GitHub Action PR comment, signalling render-timing or anti-aliasing noise rather than a real UI change. No external dependencies added (~5 KB gzipped).

  `@testivai/witness-playwright` reporter updated to read and surface the `dom` field from `results.json` in the HTML report and via `mcbuddy/testivai-oss@v1` PR comments.

- Updated dependencies [60a886f]
  - @testivai/witness@1.0.3

All notable changes to @testivai/witness-playwright will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Local mode support for visual regression testing without cloud
- Reporter detects local mode via `.testivai/config.json`
- Screenshot-only capture in local mode (skips DOM/CSS/performance)
- Integration with `@testivai/witness` for report generation

## [1.1.1] - 2026-03-19

### Changed

- Renamed from `@testivai/witness-cdp-playwright` to `@testivai/witness-playwright`
- Updated `useCDP` option to `useBrowserCapture` for IP protection

## [1.1.0] - 2026-02-28

### Added

- Unified performance metrics capture via browser Performance.getMetrics
- Integration with TestivAI Core API performance comparison service

## [1.0.0] - 2025-01-15

### Added

- Initial release
- Playwright test reporter for TestivAI
- Screenshot capture with scroll-and-stitch
- Browser integration for full-page screenshots
- DOM structure capture
- CSS computed styles capture
- Layout metrics capture
