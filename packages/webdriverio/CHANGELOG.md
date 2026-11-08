# Changelog

## 0.5.3

### Patch Changes

- Updated dependencies [b9e4795]
- Updated dependencies [74c5082]
  - @testivai/witness@2.7.2

## 0.5.2

### Patch Changes

- Updated dependencies [0f3ae5c]
  - @testivai/witness@2.7.1

## 0.5.1

### Patch Changes

- Updated dependencies [1a3692c]
  - @testivai/witness@2.7.0

## 0.5.0

### Minor Changes

- 117bac5: New opt-in config `elementIdAttributes` (for example `["data-testid"]`) anchors element-map paths on attributes your tests already set. An element's path starts at its nearest ancestor-or-self carrying one of them with a non-empty value no other element in the page shares: `div[data-testid="board"] > div.css-146c3p1` instead of a `body > div > div.css-g5y9jx > div.css-g5y9jx:nth-of-type(2) > …` chain. Content inserted above an anchored element no longer renumbers its path, so an element that only moved reads as a shift (with the page shift detected) instead of a change, and the style check pairs the same elements. The list order is the precedence; a duplicated value is skipped and the path continues upward, so paths stay unique; values are escaped as CSS strings (`>` included), so each anchored path is a working selector. Unset, nothing changes: the attributes are never read and `elements.json`, the style digests, `results.json` and the report are byte-identical. The Playwright, Selenium and WebdriverIO adapters read it from `.testivai/config.json` and record it in the capture's `metadata.json` (only when set); approving freezes it into the baseline, and styles are compared only when both sides used the same setting (`dom.styleCheck: "unavailable"` until baselines are re-approved after a change), so paths built two ways never produce a style verdict on part of the page. `@testivai/witness` exports `normalizeElementIdAttributes`; `buildElementMapExpression` takes the list as a third argument.
- f3e3fc7: Native app screens (experimental): `@testivai/witness-webdriverio` captures native Android and iOS app screens in an Appium session. In a session on Android or iOS that names no browser and is in the `NATIVE_APP` context (or, when the context cannot be read, was started with `app`, `appPackage` or `bundleId`), `witness()` runs no page script: a native screen has no page, Appium rejects them there and WebdriverIO resends each failed one three times (~1.5 s each, ~8 s per capture on an Android 14 emulator). The capture is the whole screen, pixel diff only. The status bar is masked per capture (`masks: [{ "top": <px> }]` in the capture's `metadata.json`): on Android to the bottom of the bar's frame in the window manager at capture time (`mobile: getSystemBars`), so a rotation is followed; UiAutomator2's own reading (`mobile: viewportRect`, the session capabilities) is taken once at the session start and came back 63 px for a 136 px bar in one emulator run, so it is only the fallback. On iOS it comes from `mobile: viewportRect`. The environment block comes from the capabilities, with `browser.name: "native-app"`, capture method `screen:appium` and a new `device` section (platform, OS version, model, the requested device name, the Appium driver, screen size, density). The snapshot is keyed `<name>__<platform>-<device>-<osMajor>` (`login__android-pixel_7-15`) unless the call gives a `variant`. New options `native` (`true` forces native mode, `false` keeps the web path) and `maskStatusBar` (default `true`); `WitnessBrowser` gains the optional `getContext()`. A hybrid app in a web view, and every browser session, keep the web path, and a browser session makes no extra call. Verified on an Android 14 emulator in CI; iOS is not verified.

  `@testivai/witness`: results.json schema 2.9.0 (additive) adds the `device` section of a snapshot's environment blocks and capture method `screen:appium`. The device's platform, OS version, model, screen and density can change rendering; the device name and the Appium driver are context, and so is `os` (the machine running the tests) when both sides are native app captures. The report words device changes ("device sdk_gphone64_x86_64 → Pixel 7, device OS 14 → 15") and the capture method ("full screen (Appium)"). New exports: `appiumEnvironment`, `isNativeAppCapabilities`, `mobilePlatform`, `namesBrowser`, `nativeAppDevice`, `nativeAppVariant`, `statusBarFromCapabilities`, `statusBarFromSystemBars`, `statusBarFromViewportRect`, `CAPTURE_METHODS.APPIUM_SCREEN` and the `DeviceEnvironment` type. Guide: docs/guides/native-mobile.md.

- 8462b36: Hybrid app web views (experimental): new `witness()` option `context` captures in another Appium context for one call and switches back afterwards, also when the capture fails. `context: 'webview'` is the app's web view (the `WEBVIEW_<appPackage>` context on Android, else the first `WEBVIEW_…` context, as iOS numbers them); any other value is an exact context name (`'WEBVIEW_com.example.app'`, `'NATIVE_APP'`). A hybrid app driven in the native context gets its web view captured as a page, with every layer (DOM diff, style check, attribution, shift detection), instead of a native capture; `context: 'NATIVE_APP'` from a web view is a native capture. A session with no web view, or without the name asked for, fails with the contexts it has and what the app's build needs (WebView debugging enabled). `WitnessBrowser` gains the optional `getContexts()` and `switchContext()`.

### Patch Changes

- Updated dependencies [1ac04ef]
- Updated dependencies [117bac5]
- Updated dependencies [f3e3fc7]
- Updated dependencies [9eaa9f4]
- Updated dependencies [a3278e1]
- Updated dependencies [62964eb]
- Updated dependencies [c53604c]
  - @testivai/witness@2.6.0

## 0.4.6

### Patch Changes

- cd9ffe7: Capture provenance: every capture now records where it came from, and the report says when a diff is the machine changing rather than the page. The Playwright, WebdriverIO and Selenium (JS) adapters and `testivai witness <url>` write an `environment` block into the capture's `metadata.json`: the OS (and the Linux distro), the browser and its version (and the WebDriver binary), the test framework, the adapter and how it took the screenshot (`full-page:cdp`, `full-page:playwright`, `full-page:stitched`, `viewport:webdriver`), what the page was rendered with (viewport, device scale, color scheme, reduced motion, locale, time zone, measured in the page), the CI provider and runner image, a container, and `TESTIVAI_ENV_LABEL`. Approving a capture freezes its block into the baseline's `metadata.json` (and drops a stale one). The compare reads both blocks: results.json schema 2.5.0 (additive) adds `snapshots[].environment` (`delta`, `renderingDelta`, both blocks when they differ) and a run-level `environment` (the fields every capture of the run agrees on). Framework, adapter and driver versions, the CI runner image, the project and the Linux kernel are context; the rest can change rendering. A diff whose DOM is identical, whose computed styles match and whose rendering environment changed is now **rendering drift** in the HTML report, `@testivai/mcp` (`get_visual_results` verdicts, its grouping and a new opening line when several snapshots share one change; `explain_snapshot`'s new `layers.environment`; the `triage-visual-diff` rubric) and the GitHub Action comment, never "likely render noise"; a size change from another capture method says so instead of "page grew". New config `environmentPolicy`: `"warn"` (default) never changes a status; `"separate"` keys snapshots `<name>__<browser>__<platform>` (never by version) and reports missing only the baselines of an environment the run captured; `"strict"` makes a rendering change of environment `changed` whatever its pixels say. New `testivai env` prints this machine's part of the block (`--fonts` adds a fingerprint of the installed fonts, `--json` for machines). `@testivai/witness` exports the collectors (`collectHostEnvironment`, `RENDER_PROBE_EXPRESSION`, `browserFromCapabilities`, `webDriverEnvironment`, `applyEnvironmentPolicyToName`, …) and `@testivai/witness/report` the readings (`diffEnvironments`, `isRenderingDrift`, `environmentChangeGroups`, `environmentChangeLine`, …). `BaselineStore` gains `writeTempMetadata` and `readTempMetadata`. The WebdriverIO and Selenium `WitnessBrowser` / `WitnessDriver` types gain the optional `capabilities` / `getCapabilities()` they read the browser from. The Python, Ruby and Java adapters do not record the block yet; their captures compare exactly as before.
- Updated dependencies [cd9ffe7]
- Updated dependencies [c05d870]
  - @testivai/witness@2.5.0

## 0.4.5

### Patch Changes

- Updated dependencies [ebaf705]
  - @testivai/witness@2.4.0

## 0.4.4

### Patch Changes

- Updated dependencies [0ec2cf8]
  - @testivai/witness@2.3.1

## 0.4.3

### Patch Changes

- Updated dependencies [f538f0c]
  - @testivai/witness@2.3.0

## 0.4.2

### Patch Changes

- Updated dependencies [18ef81d]
  - @testivai/witness@2.2.1

## 0.4.1

### Patch Changes

- Updated dependencies [23c126e]
- Updated dependencies [b3fb0e6]
- Updated dependencies [34d7304]
  - @testivai/witness@2.2.0

## 0.4.0

### Minor Changes

- c0097db: The WebdriverIO adapter now captures the element map (each element's box and a digest of its computed styles) and writes `elements.json`, like the Playwright and Selenium adapters. The style check now works for WebdriverIO: a stylesheet-only change with an identical DOM is reported as a real style-only change instead of likely render noise. Region attribution and page-shift detection also work. WebDriver screenshots are viewport-sized, so the map keeps only the elements inside the captured viewport, in screenshot coordinates. New options: `skipElementMap` and `maxElements`. Capture is best-effort, like the DOM: if it fails, the pixel diff still runs.

### Patch Changes

- Updated dependencies [10dc7d3]
  - @testivai/witness@2.1.1

## 0.3.3

### Patch Changes

- Updated dependencies [b2892e5]
- Updated dependencies [b380f3c]
  - @testivai/witness@2.1.0

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
