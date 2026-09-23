# Changelog

## 2.0.2

### Patch Changes

- fcd39f8: The computed-style check no longer reports a verdict it has no evidence for. A
  `styleHash` is optional in the element map — `parseElementMap` defaults it to
  `''`, because the Extension API asks adapters for a path and a box, not styles —
  so a map can legitimately arrive with no digests at all. Those empty strings were
  being compared like real values, in both directions: two digest-free maps matched
  each other, and the report rendered that as "computed styles are identical" for a
  check that never ran; a digest-free baseline against a digest-carrying capture
  differed on every shared path, naming every element as restyled.

  Pairs are now only compared when both sides carry a non-empty digest, and a run
  with no comparable pair reports `styleCheck: "unavailable"` instead of `"match"`
  or `"mismatch"`. `unavailable` is an existing value of the documented enum and
  already has its own report rendering, so nothing new appears in `results.json`.

  No first-party adapter is affected: every adapter that emits an element map
  (Playwright, Selenium, Python, Java, Ruby) emits digests from the same shared
  collector, and WebdriverIO emits no map at all and was already `unavailable`.
  This matters for community adapters built against the Extension API, and for any
  bounds-only source where there are no computed styles to digest.

## 2.0.1

### Patch Changes

- e289450: Launch Chrome with `--no-sandbox` when running as root, so `testivai witness <url>` works inside containers.

  Chrome refuses to start as root unless its sandbox is disabled, and root is the
  default user in Docker images and CI containers — the standalone witness flow
  failed there with a launch timeout that looked like a broken Chrome binary.
  It now detects the root case (overridable with `TESTIVAI_CHROME_NO_SANDBOX`),
  adds `--disable-dev-shm-usage` alongside it for Docker's 64MB `/dev/shm`, and
  the timeout error names the sandbox as a possible cause.

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

### Minor Changes

- 5af0816: Validate `.testivai/config.json` on load. Unknown keys now warn with a did-you-mean suggestion (`"thresold" — did you mean "threshold"?`), mistyped values (e.g. `"threshold": "0.1"`) warn and fall back to the documented default instead of flowing into comparisons, a leftover `mode` key gets a targeted retirement notice, and a file that isn't valid JSON says so instead of being silently ignored. Warnings only — a config nit never fails a run, and unknown keys are kept for forward compatibility.

## 1.13.0

### Minor Changes

- f80f6c6: Sharded and parallel runs now work the same way in every language, not just Playwright. `TESTIVAI_SHARD=i/N` and `TESTIVAI_CAPTURE_ONLY=1` are honoured by the Playwright, Selenium, Python, Java and Ruby adapters, so a Selenium or pytest suite joins the same capture → merge → compare-once flow with the same completeness guarantee. Playwright still auto-detects `--shard`, now as a convenience on top of the shared contract rather than a separate mechanism.

  Also fixes a real bug in the pytest plugin: `pytest_sessionfinish` fires in every xdist worker, so `pytest -n 8` launched eight concurrent comparisons racing on the same `visual-report/`. Only the controller reports now.

- 09eafd4: Captures now wait for the page to stop changing, in every language. On top of the existing animation/caret/font stabilization, `stabilize` waits for `document.readyState === 'complete'`, for every image to finish, and for 150ms without DOM mutations — bounded at 5 seconds, so a page that never settles is captured rather than hanging the suite. The probe is generated from one TypeScript source and shipped to the Python, Java and Ruby adapters, so all five poll the identical predicate. Deliberately not network idle, which Playwright's own docs mark DISCOURAGED for testing and which is the wrong signal for a screenshot.

### Patch Changes

- 6fdc1db: Adds a verified per-framework recipe for splitting a suite across CI nodes: Playwright's built-in `--shard`, Jest's `--shard`, pytest-split's `--splits/--group`, and deterministic file/class splitters for Maven Surefire and RSpec, which have no shard flag. Also documents that splitting the tests is the runner's job and TestivAI's `TESTIVAI_SHARD` only needs to agree on the index — plus a one-liner to prove the split covers every file.

## 1.12.0

### Minor Changes

- 003765d: Ruby suites get a native adapter. The new `testivai` gem captures screenshots, DOM snapshots, and element maps directly through Capybara or Selenium — no sidecar, no Chrome debug port, and no wrapper around your test command, so `bundle exec rspec` runs unchanged. `testivai init`'s RSpec and Cucumber templates now use the gem instead of the sidecar binding.
- 0eb2adb: The Selenium (JavaScript) adapter now captures the element map, so region→selector attribution, the style-only-change verdict, and page-shift detection work there exactly as they do for Playwright. The page-side collector moved into `@testivai/witness` and is exported as `collectElementMap` / `buildElementMapExpression`, so every adapter injects the identical function rather than a copy. New per-call options: `skipElementMap` and `maxElements`. Capture is best-effort — if the script is blocked, the report falls back to the pixel and DOM layers instead of failing.
- 9aa0f14: Sharded runs now prove every shard reported before comparing. Each shard writes a `testivai-shard.json` manifest alongside its captures at end of run, and `merge-captures` refuses to proceed when one is unaccounted for — naming the missing shard indices. A shard that crashes or is cancelled leaves no manifest, which previously meant the merge compared partial coverage and passed silently whenever `failOnMissing` was off. The shard total is read from the manifests, with `--expect <n>` to assert it explicitly and `--allow-incomplete` to proceed anyway.
- 8997ccd: Sharded Playwright runs now work correctly. A shard only executes a slice of the suite, so comparing inside it reported every baseline owned by another shard as missing coverage — measured on a real 8-shard run, every shard exited 3 with roughly 90% of the suite listed as missing, and produced 8 partial reports with no combined view. The reporter now detects a sharded run (`--shard=i/N`) and switches to capture-only: captures are written, comparison and report generation are skipped. The new `testivai merge-captures <dirs...>` command unions the shards' captures so a single `testivai report` compares the whole suite at once — one exit code, one report, and missing-baseline detection that is correct by construction. Opt in or out explicitly with the `captureOnly` reporter option or `TESTIVAI_CAPTURE_ONLY`.

### Patch Changes

- ffc2171: Docs and CLI output now match what the tool actually does. `testivai init` no longer offers a "Cloud" mode or tells you to run `testivai auth <api-key>`; the second wizard choice is what it always really was — helper-file generation for non-Playwright frameworks. Removed the last `dashboard.testiv.ai` URLs from CLI output and error messages. Corrected the documented exit-code contract (code 3 fires by default), the `results.json` schema version and field list, several nonexistent CLI flags, and the WebdriverIO quickstart, which silently produced no report without `.testivai/config.json`.
- 90109b5: The element-map collector is now generated into a JavaScript asset for the Python wheel and the Java jar (`scripts/generate-element-map-asset.js`), so all four adapters inject the identical function. CI regenerates the asset and fails if the checked-in copies are stale — adapters that share one baseline directory can no longer drift into producing different maps for the same page.
- 2a37518: Documents two questions teams actually ask before adopting: what committing baselines does to repository size (with measured numbers and honest Git LFS guidance — usually don't), and what connecting an AI model adds over the deterministic verdict (interpretation, not detection).
- 750562e: Adds a "Maintenance & roadmap" documentation page answering what a team evaluating a dependency actually needs to know: who maintains it, the real release cadence, where the public roadmap is, and precisely what happens to your setup if maintenance stops. Also refreshes ROADMAP.md, which still described Ruby as sidecar-only and MCP image downscaling as upcoming.
- 1efe97f: Fixes the agent-facing verdict for style-only changes. When the DOM was identical but computed styles differed, `explain_snapshot` and `get_visual_results` reported "no DOM data; treat as needing human review" — contradicting the HTML report, which correctly calls it a style-only change, and hiding the signal agents most need. Verdicts now say "style-only change: N elements restyled with identical DOM" with the affected selectors, and a captured-but-unremarkable DOM no longer claims to be missing. Adds a dedicated MCP documentation page.
- c9b01a6: Refreshes npm descriptions and keywords. `@testivai/witness-playwright` still described itself as a "Playwright sensor for Testivai Visual Regression Test system" — pre-rename terminology with the brand misspelled, on the most-viewed package page. Descriptions now match the local-first positioning and keywords cover the terms people actually search.
- cba53b5: Docs now present Ruby as a first-class adapter: the `testivai` gem is published on RubyGems, so Capybara/RSpec suites no longer route through the experimental sidecar. The getting-started guide gains a Ruby quickstart and the `init` wizard's framework list reflects which frameworks have native adapters.
- Updated dependencies [ffc2171]
  - @testivai/common@0.2.3

## 1.11.1

### Patch Changes

- b70ebd9: The HTML report is now mobile-friendly: on narrow screens (≤900px) the sidebar becomes an off-canvas drawer — collapsed by default behind a hamburger top bar — the baseline/diff/current images stack vertically, and long commands/selectors wrap instead of overflowing. Desktop layout is unchanged.

## 1.11.0

### Minor Changes

- 8de6c13: New `shiftTolerance` pass criterion — the layout-tolerance layer, reimplemented local-first. When every diff region is a **pure element shift** (content unchanged, element just moved) of at most N pixels per axis, the snapshot auto-passes as `autoPassed: "shift"` (auditable in the report and results.json). Kills sub-pixel/rounding layout jitter without masking real changes: content-changed regions, unattributed regions, or shifts beyond the bound keep the snapshot `changed`. Config: `"shiftTolerance": 2` in `.testivai/config.json`. Off by default.

### Patch Changes

- f94048d: `testivai init`'s Playwright scaffold now prints the canonical `witness()` capture example.

## 1.10.0

### Minor Changes

- 271f30d: The diff image is now a proper **heatmap**. Previously changed pixels were direction-colored at ≤75% alpha on a fully transparent background — subtle diffs were nearly invisible. Now:

  - **Washed context**: unchanged pixels render as a light grayscale of the baseline, so the heat sits on the actual page instead of a void.
  - **Magnitude heat ramp**: changed pixels are fully opaque, yellow (subtle) → orange → red (strong), normalized from the configured threshold to the YIQ maximum.
  - **Region outlines**: every detected region gets a 2px deep-red box, so even a handful of changed pixels is findable at page zoom.
  - The report's Diff column gains a `subtle → strong` gradient legend.

  Diff _detection_ (counts, threshold, hash, regions) is byte-for-byte unchanged — this is presentation only.

## 1.9.0

### Minor Changes

- 381279b: Field-feedback fixes for noise-hint robustness and cross-platform teams:

  - **`volatileAttributes` config**: attribute names whose _values_ the DOM diff ignores (presence still counts) — stops per-run `src`/`srcset` URL churn from poisoning the render-noise hint with `attributeChanges: 1`. Independent of the list, `blob:` object URLs are now always normalized (they are per-session by construction); `data:` URIs stay significant.
  - **`baselinesDir` config is now honored** (it existed but was silently ignored) with a `{platform}` token for per-OS baselines: `".testivai/baselines-{platform}"` gives mac devs and linux CI their own committed baseline sets instead of permanent cross-OS font-rasterization noise. Element-map attribution and the MCP server resolve the same directory.
  - **Silently-green guard**: `testivai report` now prints a loud warning when snapshots changed but no diff gate is configured (`--fail-on-diff` / `failOnDiff`), so a report-only pipeline can't quietly pass with visual changes. (Note: the diff gate has been opt-in since the command was introduced — this release makes the tradeoff visible, and new docs cover both gates.)

## 1.8.0

### Minor Changes

- 139d28d: Report UI overhaul:
  - **Light theme by default** with a persisted dark-mode toggle (CSS custom properties; preference stored in `localStorage`).
  - New per-snapshot **"Layered analysis"** panel with a plain-language verdict headline — "Style-only change (real, not noise)", "Layout shift — look above y=N for inserted content", "Structural change (n added)", "Likely render noise" — synthesized from the DOM/style signal, attributed regions, and page-shift detection. This is the human-facing view of the same evidence `@testivai/mcp`'s `explain_snapshot` serves to AI agents (noted in the panel header).
  - General polish: summary card grid, softer cards/shadows, section dot-titles, themed region chips and mask hatching.
- 1c4c883: Team-workflow hardening for the report and CI gate:

  - **Missing-baseline coverage gate is ON by default**: results.json (schema **2.3.0**, additive) reports `missingBaselines[]` + `summary.missing` — baselines that received no capture this run (the way a deleted/renamed test silently stops guarding its page). `testivai report` exits **3** when any are found (precedence: changed 1 > missing 3 > new 2). Disable via config `failOnMissing: false`, or per-run with `--allow-missing` for filtered runs (`--grep`). The HTML report shows a coverage-loss notice.
  - **`testivai report --share`** writes `share.html` — one self-contained file with every image inlined as a data URI. Optional **storage-agnostic upload hook**: config `shareUploadCommand` runs any shell command (`aws s3 cp`, `gsutil`, `rclone`, `curl` — `{file}` placeholder), and its last stdout line is printed as the shared URL. No cloud SDKs shipped; local file is the default.
  - **Baseline provenance**: each result now carries `baselineApprovedAt` (from the baseline's metadata, stamped on approve/add) and the report shows "baseline approved YYYY-MM-DD" — a months-old baseline deserves a closer look than yesterday's. Only the last approved baseline is kept (plus the `.previous/` undo slot), so the flow is unchanged.

  The GitHub Action's PR comment carries the layered-analysis verdicts — "Style-only change — real, not noise (`button.cta`)", "Layout shift — look above y=N", and the missing-baselines coverage warning — and its footer points agents at `@testivai/mcp` instead of the retired hosted service.

## 1.7.1

### Patch Changes

- fa0deb5: `testivai auth` now prints a deprecation notice: TestivAI is local-first and the hosted service is discontinued — no account or API key is needed. The command still works (`--delete` clears stored credentials) and will be removed in the next major release.
- e37eb33: The HTML report sidebar now points AI-agent users at `@testivai/mcp` (including the new `explain_snapshot` tool) instead of a hosted-service upsell, and the noise-reduction tips mention `mode: "collapse"` for variable-height regions.

## 1.7.0

### Minor Changes

- 5bfdca5: Agent-grade `testivai report` CLI contract:

  - `--json` prints the `results.json` payload (the public schema, incl. per-snapshot region→selector attribution) to stdout instead of the pretty summary — so agents/CI parse one stable contract, no ANSI scraping.
  - Documented exit codes, enforced when gated (`--fail-on-diff` or config `failOnDiff`): **0** pass · **1** changed · **2** new-only. New snapshots get their own code instead of conflating with regressions.
  - `--allow-new` treats new snapshots as passing (exit 0) for first runs before baselines exist.

  `--json` also added to `approve` (`{ approved, failed }`) and `init` (Playwright scaffold `{ framework, mode, created }`).

- 9db57c2: `testivai init` now detects Playwright projects **first** and scaffolds the local reporter flow — `.testivai/config.json` (`mode: "local"`), the baselines directory, `.gitignore` entries, and the reporter snippet to add to `playwright.config.ts` — instead of emitting the CDP `browserPort` sidecar config. It is idempotent (existing config left untouched without `--force`) and exits 0 cleanly on success.

## 1.6.0

### Minor Changes

- 2168b81: Computed-style fingerprint — closes the documented noise-hint false negative. A stylesheet-only change (identical DOM, different pixels) used to read as "likely render noise"; the hint now also requires the computed-style digests (captured in the element map) to match. A digest mismatch becomes an explicit, attributed signal — "Styles changed: 1 element restyled with identical DOM: `button.cta`" — surfaced in the report and results.json (`dom.styleCheck`, `dom.styleChanges`), and `noiseAutoPass` can never auto-pass it. Captures without element maps keep the legacy DOM-only hint, visibly labeled `styleCheck: "unavailable"`.

## 1.5.0

### Minor Changes

- a13563e: Element attribution + shift classification. The Playwright adapter captures an element map (`elements.json`: deterministic CSS path, rect, computed-style digest per visible element) alongside every local-mode screenshot. The comparison engine intersects diff regions with the map to name WHICH element changed, and classifies pure translations from layout — same element, same size, same style digest, new position → "shifted +8px vertically — content unchanged", with exact (dx, dy). A whole-page pass reports "everything below y=N shifted" (the injected-banner signature) as `pageShift`. All additive in results.json (regions[].elements/classification/shift, snapshot pageShift); image-only inputs and older captures degrade gracefully to plain regions. `approve` carries the element map to the baseline.

## 1.4.0

### Minor Changes

- a8cbabf: Masking DSL + diff clustering. Config/per-call `mask` accepts CSS selectors (geometry captured at capture time) or geometric regions (px, 0–1 ratios, "NN%", single-edge shorthands like `{ top: 24 }`); masked areas are excluded from the pixel diff AND hatched in the diff image with a full audit trail in the report — never silent. Changed pixels are clustered into regions (`results.json` 2.2.0, additive: `regions[]`, `masks[]`, `maskWarnings[]`) with `diffRegions.minSize` / `mergeDistance` tunables; the report shows clickable region chips. Also fixes results.json's schema version field, which previously carried the package version.

## 1.3.1

### Patch Changes

- 7cb179f: `TESTIVAI_MODE=cloud|local` now overrides `.testivai/config.json` for lane selection. Repos hosting both lanes side by side (like the demo app) previously had the cloud lane silently hijacked into local mode by the OSS lane's `{ "mode": "local" }` marker file.

## 1.3.0

### Minor Changes

- 767385e: Added `--dry-run` flag to `testivai approve` that prints what would be approved without modifying files. Also changed `testivai approve --undo` (without a name) to automatically undo the last approval by finding the most recent `.previous/` backup — no longer requires an explicit snapshot name.
- 0158619: New `testivai report` command — the language-agnostic half of the adapter contract. Any Playwright binding (Python, Java, .NET, …) can capture by writing `.testivai/temp/<name>/screenshot.png` (+ `dom.html`) with its native APIs, then run `testivai report` for diffing, tolerances, the noise hint, the HTML report, and CI exit codes (`--fail-on-diff`, `--open`). This powers the new `testivai` Python package (PyPI) and the experimental Java adapter.

## 1.2.0

### Minor Changes

- d239b31: Attack the top reasons teams abandon visual testing — flaky captures and pixel-perfect strictness:

  **Stabilized captures (both adapters, on by default).** Before every screenshot: CSS animations and transitions are frozen, the text caret is hidden, smooth scrolling is forced instant, and the capture waits (bounded 3s) for web fonts to finish loading. Disable with `stabilize: false` — globally in `.testivai/config.json`, per project in `testivai.config.ts` (Playwright), or per call.

  **Human-intuitive pass criteria (`@testivai/witness`).** New `.testivai/config.json` fields:

  - `maxDiffPercent` (default 0) — diffs at or below this percentage report as passed
  - `maxDiffPixels` — absolute changed-pixel variant; either criterion passing is enough
  - `noiseAutoPass` (default false) + `noiseMaxDiffPercent` (default 1) — DOM-identical diffs (the noise hint) within the bound auto-pass instead of demanding review

  Auto-passed snapshots keep their diff image and carry `autoPassed: "threshold" | "noise"` in `results.json` (additive schema change); the HTML report labels them. Byte-different but visually identical captures (nothing above the per-pixel threshold) now report as passed instead of `changed 0.01%`.

  **WebdriverIO parity: `ignoreSelectors`.** The WebdriverIO adapter now honors `ignoreSelectors` from `.testivai/config.json` and accepts per-call `ignoreSelectors` in `witness()` options, hiding matched elements (`visibility: hidden`, layout-preserving) for the duration of the capture — matching the Playwright adapter.

- c0ac195: Zero-test-suite mode: `testivai witness <url>` captures a running app with no test framework at all — built for AI-generated and vibe-coded apps that ship without tests.

  ```bash
  npx testivai witness http://localhost:3000
  ```

  - Discovers same-origin pages by crawling the start page's links (cap with `--max-pages`), or capture exactly the routes you list via `--pages "/,/pricing"` or `pages` in `.testivai/config.json`
  - Launches its own headless Chrome (or reuses a debuggable one via `--port`); set `TESTIVAI_CHROME_PATH` to point at any Chrome/Chromium binary, including a Playwright-downloaded one
  - Full-page screenshot + DOM snapshot per page, with the same capture stabilization and `ignoreSelectors` handling as the test-suite adapters
  - Everything downstream is the standard pipeline: baselines, pixel diff with your configured tolerances, DOM noise hint, HTML report, `testivai approve`, and the GitHub Action PR flow
  - New config fields: `pages`, `maxPages`, `viewport`; new flags: `--pages`, `--max-pages`, `--viewport`

  The existing sidecar form (`testivai witness <name>` against an already-running debuggable Chrome) is unchanged.

- 6a74d40: Dogfooding fixes — found by running `testivai witness` against our own marketing site:

  **Stabilization no longer hides entry-animated content.** The injected CSS now uses near-zero durations (`animation-duration: 0.001s`, one iteration, `transition-duration: 0.001s`) instead of `animation/transition: none`, so animations **complete instantly at their final state**. Pages whose content starts at `opacity: 0` and reveals via entry animations or class transitions — most modern marketing/vibe-coded sites — render fully instead of capturing blank.

  **Standalone mode reveals scroll-triggered content.** `testivai witness <url>` now scrolls stepwise through the page (bounded) and returns to the top before capturing, so IntersectionObserver reveal-on-scroll sections actually render — without resizing the viewport, which would break `100vh` layouts.

  **The DOM diff now sees text.** Visible text nodes are tokenized (whitespace-normalized; script/style bodies stay opaque) and reported as `textChanges` in the DOM summary. Previously a wording change (`Free` → `Gratis`) read as "structurally identical" — harmless when the noise hint was only a label, but with `noiseAutoPass` enabled it silently auto-passed real text regressions. Text changes now mark the DOM as changed, never auto-pass, and appear in the HTML report, the PR comment, and MCP verdicts (`results.json` schema addition, backward compatible).

  **`ignoreSelectors` now excludes elements from the DOM snapshot too.** Ignored elements were only hidden visually; with the text-aware DOM diff, dynamic ignored content (live counters, feeds) would flag DOM changes the pixels could not show. All three capture paths now serialize the DOM with ignored elements removed — one consistent semantic: ignored means excluded from both signals.

  **Standalone capture hardening (from live-site dogfooding):** layout metrics are polled until non-zero (fresh Chrome can report 0-width before first layout), and the web-font wait is extended to 10s bounded — a fallback-font capture diffs 30%+ against a webfont baseline on real networks.

### Patch Changes

- aa66850: Fix the `testivai` CLI crashing on startup with commander 14. Commander 14 treats conflicting flags as fatal, and the CLI declared `-v` for both `--version` and `--verbose`; every invocation threw `Cannot add option '-v, --verbose'`. Version now uses the conventional `-V, --version`, leaving `-v` for `--verbose`. The startup banner also now uses local-first wording.

## 1.1.0

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

## 1.0.4

### Patch Changes

- d37a2bc: fix: properly decode PNG files before pixel diff

  The diff image in the visual report was rendering as a broken image
  because the compare engine was treating compressed PNG buffers as raw
  RGBA pixel data. Added `pngjs` to decode PNG → RGBA before diffing
  and encode the diff output back to a valid PNG file. Diff percentages
  and diff heatmap images in the HTML report now display correctly.

## 1.0.3

### Patch Changes

- 60a886f: **DOM diff noise-hint** — `@testivai/witness` now runs a lightweight DOM comparison alongside every pixel diff. When screenshots diverge but the DOM tree is structurally identical, the diff is flagged with `"noiseHint": true` in `results.json` and in the GitHub Action PR comment, signalling render-timing or anti-aliasing noise rather than a real UI change. No external dependencies added (~5 KB gzipped).

  `@testivai/witness-playwright` reporter updated to read and surface the `dom` field from `results.json` in the HTML report and via `mcbuddy/testivai-oss@v1` PR comments.

All notable changes to @testivai/witness will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Local mode support for visual regression testing without cloud
- Baseline store for local filesystem storage
- HTML report generator
- CLI commands: `init`, `run`, `approve`
- Subpath exports: `/diff`, `/baselines`, `/config`, `/report`

## [1.0.1] - 2026-03-19

### Changed

- Renamed from `@testivai/witness-cdp` to `@testivai/witness`
- Updated terminology for IP protection (CDP → browser integration)

## [1.0.0] - 2025-01-15

### Added

- Initial release
- Visual diff engine with pbd algorithm
- Screenshot capture via browser integration
- DOM structure analysis
- CSS computed styles capture
- Layout metrics capture
