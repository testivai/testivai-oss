---
sidebar_position: 2
title: How It Works
---

# How It Works

TestivAI integrates with your existing test framework via a single function call. This page explains the **local pipeline** that ships with the open-source SDKs.

---

## At a Glance

```text
   ┌──────────────────┐    ┌──────────────────┐    ┌─────────────────────┐
   │  Your test       │───▶│  Capture layer   │───▶│  .testivai/temp/    │
   │  (Playwright,    │    │  (page, layout,  │    │    <name>/          │
   │   Selenium, …)   │    │   styles, …)     │    │      screenshot.png │
   └──────────────────┘    └──────────────────┘    └──────────┬──────────┘
                                                              │
                                  ┌───────────────────────────┘
                                  ▼
                  ┌────────────────────────────┐
                  │  Diff vs baseline          │       ┌──────────────────────────┐
                  │  .testivai/baselines/      │──────▶│  visual-report/          │
                  │    <name>/screenshot.png   │       │    index.html            │
                  └────────────────────────────┘       │    results.json          │
                                                       └──────────────────────────┘
```

Three things happen per test that calls `witness(...)`:

1. **Capture** — the SDK stabilizes the page (CSS animations/transitions frozen, caret hidden, web fonts awaited — disable with `stabilize: false`), then takes a screenshot via the test framework's native screenshot API (full-page where the framework supports it; WebdriverIO captures the viewport) and writes it to `.testivai/temp/<name>/screenshot.png`, with the DOM snapshot (`dom.html`) and, from most adapters, the element map (`elements.json`) beside it.
2. **Diff** — at the end of the run, the Playwright reporter, the WebdriverIO service or `npx testivai report` compares each temp capture against `.testivai/baselines/<name>/screenshot.png`.
3. **Report** — a self-contained `visual-report/index.html` is generated with a summary table, side-by-side images, and a `results.json` for CI consumption.

---

## Capture Layer

What the capture layer writes depends on the framework and on the active mode.

### Playwright (`@testivai/witness-playwright`)

Uses Playwright's native APIs directly:

| Captured | Written to |
|---|---|
| Full-page PNG via `page.screenshot({ fullPage: true })` | `temp/<name>/screenshot.png` |
| Page HTML snapshot | `temp/<name>/dom.html` |
| Element map — selectors, bounding boxes, computed styles | `temp/<name>/elements.json` |

No external Chrome remote-debugging port is needed.

### Other frameworks (`@testivai/witness` CLI)

When you wrap your test command with `testivai run "..."`, the CLI:

1. Starts your test command and waits for its Chrome to open the remote debugging port (`--remote-debugging-port=9222` by default).
2. Connects via Chrome DevTools Protocol (CDP).
3. Listens for `witness(name)` calls from your test helper file.
4. Captures the screenshot and metadata for each call.
5. Keeps each screenshot in memory, with no DOM snapshot and no element map (so these captures could get at most a pixel diff: no DOM diff, noise hint, style check, selector attribution or page-shift detection). Known gap: it does not yet write them to `.testivai/temp/`, so the report it generates at the end covers only captures already on disk.

Frameworks supported by the `init` wizard: Cypress, Puppeteer, Robot Framework, and others without a dedicated adapter. Playwright, WebdriverIO, Selenium (JS / Python / Java) and Ruby (Capybara) have native adapters and do not use this path.

Element maps (`elements.json`) come from the Playwright JS/TS, WebdriverIO, Selenium (JS / Python / Java) and Ruby adapters. playwright-python, playwright-java and the `testivai witness <url>` crawler capture the screenshot and the DOM without one, so computed styles are not compared for them (`styleCheck: "unavailable"`).

### What a capture records about where it came from

The Playwright JS/TS, WebdriverIO and Selenium (JS) adapters and the `testivai witness <url>` crawler also write `temp/<name>/metadata.json` with an `environment` block: the OS (and the Linux distro), the browser and its version, the test framework, the adapter and how it took the screenshot (`full-page:cdp`, `full-page:playwright`, `full-page:stitched`, `viewport:webdriver`), what the page was rendered with (viewport, device scale, color scheme, reduced motion, locale, time zone, measured in the page), the CI provider and runner image, a container, and `TESTIVAI_ENV_LABEL`. Approving a capture freezes its block into the baseline's `metadata.json`. The Python, Ruby and Java adapters do not record it yet; their captures compare as before. `npx testivai env` prints this machine's part of the block (`--fonts` adds a fingerprint of the installed fonts). The full field list is in the [Extension API](./extension-api.md#capture-provenance-environment-in-metadatajson).

---

## Diff Algorithm

Local-mode diff is performed by `@testivai/witness/report` (`compareAll` in `report/compare.ts`):

1. Enumerate every `temp/<name>/screenshot.png` produced by the run.
2. For each, look up `baselines/<name>/screenshot.png`.
3. If no baseline exists → status `new` (you'll commit the temp file as the baseline).
4. If buffers are byte-identical → status `passed`.
5. If the two images have different dimensions, both are padded to the larger width and height and every padded pixel counts as changed; the result records both sizes in `sizeMismatch`, and the snapshot is never auto-passed. A taller or shorter page is read with the DOM diff and the page shift: the padded band at the bottom is the new height, not where the change is, so a page shift places the change, the DOM diff says what changed, and an identical DOM means the same content laid out taller or shorter (restyled, or fonts and rendering that differ between machines), not content added or removed. A different width is almost always the viewport or device scale factor, not the page, and the report says so.
6. Otherwise → status `changed` with a percent-diff estimate (subject to threshold from `.testivai/config.json`).

The threshold is configurable:

```json
// .testivai/config.json
{
  "threshold": 0.1,
  "reportDir": "visual-report",
  "maxDiffPercent": 0,
  "noiseAutoPass": false,
  "stabilize": true,
  "ignoreSelectors": []
}
```

`threshold` controls per-pixel color sensitivity. The **pass criteria** decide what happens when pixels do differ, and none of them is on until you configure it: diffs within `maxDiffPercent` / `maxDiffPixels` report as passed; with `noiseAutoPass` enabled, diffs within `noiseMaxDiffPercent` whose DOM is identical **and** whose computed styles were compared and match (`dom.styleCheck: "match"`) **and** whose diff is not concentrated in one area pass too (it never passes a diff whose styles were not compared or changed, or whose regions all fit in a box covering at most a third of the page); with `shiftTolerance` set, diffs made only of small pure element shifts pass. No criterion passes a snapshot whose dimensions changed (`sizeMismatch`), whatever its pixel count. A DOM change never decides the status on its own: the pixels do, and the report says when a passed snapshot's DOM differs (nothing visible changed, or within a tolerance). Auto-passed snapshots keep their diff image and carry `autoPassed: "threshold" | "noise" | "shift"` in `results.json`, so tolerance never hides information.

### When pixels differ and the DOM is identical

The DOM diff alone cannot tell render noise from a stylesheet-only change, so the computed-style check decides what the report says:

| `dom.styleCheck` | Reading |
|---|---|
| `"match"`, small and scattered diff | **Likely render noise** (anti-aliasing, font hinting): the DOM and computed styles are identical, at most 1% of pixels differ, and there are no regions or they are spread out. Likely, not proven; worth a glance, not a block. |
| `"match"`, diff concentrated in one area or large | **Diff concentrated in one area** (every region within a box covering at most a third of the page) or **Large diff** (over 1% of pixels): not noise. The style check covers a fixed list of properties, so this is a bad capture or a change it does not cover (size, overflow, position, transform, text decoration, filters, pseudo-elements, images). Compare the images before approving. |
| `"mismatch"` | **Style-only change**: a real change, with the restyled elements in `dom.styleChanges`. |
| `"unavailable"`, or absent in older results | **Styles not compared**: could be render noise or a stylesheet-only change. No comparable style digests on both sides, so a stylesheet-only change is not ruled out. Compare the images before approving. |

`dom.noiseHint` is `true` in the first, second and last rows, so read it together with `dom.styleCheck`, `diffPercent` and `regions` (`diffShape` from `@testivai/witness/report` applies the rule).

### When the environment changed since the baseline

When the baseline and the current capture both recorded their environment, the compare lists what changed (`environment.delta`) and the part of it that can change rendering (`environment.renderingDelta`: the browser, the OS, distro or architecture, the render settings, the capture method, a container or the label; framework, adapter and driver versions, the CI runner image and the project are context). A diff whose DOM is identical, whose styles match and whose rendering environment changed is **rendering drift**: the machine changed, not the page. The report says so ("Rendering drift — the environment changed since the baseline (chromium 130.0.6723.58 → 141.0.7390.37) …") instead of calling it render noise, and says it once at the top when several snapshots share the change. A size change from another capture method reads "Capture method changed — full page (CDP) → viewport (WebDriver)". Any other verdict keeps its reading and mentions the environment change as context.

`environmentPolicy` in `.testivai/config.json` decides what a change of environment does:

| Policy | Effect |
|---|---|
| `"warn"` (default) | Never changes a status: the report, MCP and the PR comment say what changed. |
| `"separate"` | The adapters key each snapshot by environment, `<name>__<browser>__<platform>`, so each browser and OS gates against its own baselines. Never keyed by version. Only baselines of an environment this run captured can be reported missing. |
| `"strict"` | A snapshot whose rendering environment changed is `changed`, whatever its pixels say (`environment.policy: "strict"`, exit 1 with `--fail-on-diff`). Approve it to re-baseline in the new environment. |

---

## Report

`generateReport` writes:

```text
visual-report/
├── index.html          ← self-contained, opens in a browser
├── results.json        ← machine-readable summary
└── images/
    └── <name>/
        ├── baseline.png
        ├── current.png
        ├── diff.png    (when the PNGs differ: changed or auto-passed)
        └── thumb.png   (changed only: baseline | current | diff of the changed area, ≤ 800×400)
```

`results.json` schema (excerpt):

```json
{
  "version": "2.3.0",
  "timestamp": "2026-04-30T...",
  "summary": { "total": 2, "passed": 1, "changed": 1, "newSnapshots": 0 },
  "snapshots": [
    {
      "name": "homepage",
      "status": "changed",
      "diffPercent": 0.4,
      "dom": {
        "changed": true,
        "noiseHint": false,
        "summary": { "added": 2, "removed": 1, "attributeChanges": 0 }
      }
    },
    {
      "name": "hero",
      "status": "passed",
      "diffPercent": 0.3,
      "dom": { "changed": false, "noiseHint": true, "summary": null, "styleCheck": "match" },
      "autoPassed": "noise"
    }
  ]
}
```

This file is what your CI should fail on. See [CI/CD guide](./guides/ci-cd.md). It is also the contract for AI coding agents: an agent can run the tests, read `results.json`, and use `dom.changed`, `dom.styleCheck` and `dom.noiseHint` to decide whether a diff needs human attention: `dom.changed: true` is a structural change, `styleCheck: "mismatch"` with `dom.changed: false` is a real style-only change, and `noiseHint: true` is likely render noise only when `styleCheck` is `"match"` and the diff is small and scattered (with `"unavailable"`, styles were not compared; with every region in one area, or over 1% of pixels, it is a bad capture or a change the style check does not cover). See "Eyes for your coding agent" in the README.

---

## Baseline Lifecycle

```text
First run         →  status: new       →  commit temp/<name>/screenshot.png as baseline
Later runs        →  status: passed    →  no action
                  →  status: changed   →  inspect visual-report/index.html
                                         either approve (replace baseline) or fix code
```

Run `npx testivai approve <name>` (or `--all`) to promote a temp capture to the new baseline. The previous baseline is backed up under `.testivai/baselines/<name>/.previous/`; `--undo` restores it.

---

→ Continue to **[Playwright adapter](./frameworks/playwright.md)** or **[WebdriverIO adapter](./frameworks/webdriverio.md)**, or read the project **[philosophy](./philosophy.md)**.
