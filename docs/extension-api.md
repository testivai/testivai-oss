---
sidebar_position: 6
title: Extension API
---

# Extension API

The OSS lane exposes two stable contracts so that **non-JS frameworks (Selenium-Java, RSpec, Robot, pytest) and community-built adapters can produce reports the TestivAI tooling consumes**:

1. The on-disk **baseline + temp layout** under `.testivai/`
2. The **`results.json`** schema written by `generateReport()` and consumed by the GitHub Action

Conform to either, and the rest of the toolchain (CLI approve, HTML report, GitHub Action) works automatically.

This page is the contract. Changes here follow semver — the schema bumps a major version when fields are removed or repurposed.

## On-disk layout

```
<projectRoot>/
└── .testivai/
    ├── config.json             # { "threshold": 0.1, ... }
    ├── baselines/
    │   └── <name>/
    │       ├── screenshot.png  # required (PNG bytes)
    │       ├── metadata.json   # required ({ name, createdAt, updatedAt, ... })
    │       ├── dom.html        # optional — enables the DOM diff and noise hint
    │       ├── elements.json   # optional — element map: enables the style check, attribution, shift detection
    │       └── .previous/      # snapshot of the baseline before the last approve
    │           ├── screenshot.png
    │           ├── metadata.json
    │           ├── dom.html
    │           └── elements.json
    └── temp/
        └── <name>/
            ├── screenshot.png  # required
            ├── dom.html        # optional
            ├── elements.json   # optional
            └── metadata.json   # optional — capture provenance (`environment`), mask geometry
```

### Adapter responsibilities

A new adapter — JS, Python, or otherwise — needs to do **one required thing, and up to three optional ones**:

1. Capture a full-page screenshot and write it to `.testivai/temp/<name>/screenshot.png`.
2. Optionally capture `document.documentElement.outerHTML` and write it to `.testivai/temp/<name>/dom.html`. This enables the DOM diff and the noise hint.
3. Optionally capture an element map and write it to `.testivai/temp/<name>/elements.json`: a JSON array of `{ path, x, y, width, height, styleHash }`, one entry per collected element, in the screenshot's coordinates (`styleHash` is a digest of the element's computed styles). Generate it with the shared collector (`collectElementMap` in `packages/witness/src/capture/element-map.ts`, which the Python, Java and Ruby packages ship as a generated script) so the paths and digests match what other adapters write against the same baselines.
4. Optionally record where the capture came from as `environment` in `.testivai/temp/<name>/metadata.json` (see "Capture provenance" below). Approving the capture freezes it into the baseline's `metadata.json`, and the compare then says when a diff is rendering drift (the browser, OS or capture method changed, the page did not) instead of calling it render noise.

That's the entire contract for capture. After the test run, the user invokes `npx testivai report` (or the framework adapter triggers it via a lifecycle hook), which:

- Diffs `temp/<name>/` against `baselines/<name>/`
- Writes `visual-report/results.json` and `visual-report/index.html`
- The GitHub Action (or any other tool) reads `results.json`

Without `elements.json` on both sides, computed styles are not compared (`styleCheck: "unavailable"`), and there is no selector attribution or page-shift detection. A pixel diff with an identical DOM then reads *styles not compared* — could be render noise or a stylesheet-only change — rather than likely render noise, and `noiseAutoPass` never passes it.

### `metadata.json`

```jsonc
{
  "name": "homepage",
  "createdAt": "2026-05-08T12:34:56.789Z",
  "updatedAt": "2026-05-08T12:34:56.789Z",
  "approvedBy": "local",     // optional — set by `testivai approve`
  "width": 1280,             // optional — viewport width at capture
  "height": 800,             // optional — viewport height at capture
  "environment": { … }       // optional — capture provenance, see below
}
```

`width` and `height` are advisory; the diff engine re-derives dimensions from the PNG buffer. A capture's `metadata.json` in `temp/<name>/` is optional; the JS adapters always write one, with `environment` and, when masks are used, the mask geometry. `testivai approve` (and the MCP approve tools) copy the capture's `environment` into the baseline's `metadata.json`; a capture without one leaves the baseline without one. The approve GitHub Action copies the capture directory as it is.

### Capture provenance: `environment` in metadata.json

Every JS adapter (Playwright, WebdriverIO, Selenium) and `testivai witness <url>` record this block, measured at capture time. A part an adapter cannot observe is left out, never guessed. Community adapters should write the same shape; only `os.platform`, `browser.name` and `adapter.captureMethod` are required for the compare to read it.

```jsonc
"environment": {
  "os":        { "platform": "linux", "release": "6.8.0-1017-azure", "arch": "x64", "distro": "ubuntu 24.04" },
  "browser":   { "name": "chromium", "version": "141.0.7390.37", "channel": "chrome", "headless": true },
  "framework": { "name": "playwright", "version": "1.64.1", "language": "typescript", "runner": "@playwright/test" },
  "adapter":   { "name": "@testivai/witness-playwright", "version": "2.0.7", "captureMethod": "full-page:cdp" },
  "driver":    { "name": "chromedriver", "version": "141.0.7390.37" },
  "render":    { "viewport": { "width": 1280, "height": 720 }, "deviceScaleFactor": 1, "colorScheme": "light",
                 "reducedMotion": "no-preference", "locale": "en-US", "timezone": "UTC" },
  "ci":        { "provider": "github-actions", "runnerImage": "ubuntu24/20251012.1.0" },
  "container": true,
  "label":     "mcr.microsoft.com/playwright:v1.64.1-noble",
  "project":   "chromium"
}
```

| Field | Source | Notes |
|---|---|---|
| `os.platform`, `os.arch` | `process.platform`, `process.arch` (or the language's equivalent) | required (`platform`) |
| `os.release` | `os.release()` | the kernel on Linux, the OS version on macOS and Windows |
| `os.distro` | `<ID> <VERSION_ID>` from `/etc/os-release` | Linux only; the distro decides the fonts and FreeType build |
| `browser.name` | the driver, else the user agent | required; the engine family: `chromium`, `firefox`, `webkit` |
| `browser.version` | the driver (Playwright `browser.version()`, WebDriver `browserVersion`, CDP `Browser.getVersion`), else the user agent | `null` when unknown |
| `browser.channel`, `browser.headless` | the runner's configuration | a branded build (`chrome`, `msedge`); headless or not |
| `framework` | the test framework | `name`, `version`, `language`, `runner`; absent for `testivai witness <url>` |
| `adapter.name`, `adapter.version` | the adapter package | |
| `adapter.captureMethod` | what took the screenshot | required. `<extent>:<mechanism>`: `full-page:cdp`, `full-page:playwright`, `full-page:stitched`, `full-page:firefox`, `viewport:webdriver` |
| `driver` | the WebDriver binary | `name`, `version`; when the adapter talks to one |
| `render.viewport`, `render.deviceScaleFactor`, `render.colorScheme`, `render.reducedMotion`, `render.locale`, `render.timezone` | measured in the page (`RENDER_PROBE_EXPRESSION` in `packages/witness/src/capture/environment.ts`) | `innerWidth`/`innerHeight`, `devicePixelRatio`, the two media queries, `navigator.language`, the `Intl` time zone |
| `ci.provider`, `ci.runnerImage` | CI environment variables | `github-actions` (with `ImageOS/ImageVersion`), `gitlab`, `circleci`, `buildkite`, `jenkins`, `azure-pipelines`, or `ci`; absent outside CI |
| `container` | `/.dockerenv` or `/run/.containerenv` | present (`true`) only inside a container |
| `label` | `TESTIVAI_ENV_LABEL` | a name the team gives the environment, e.g. its image tag |
| `project` | the runner's project or variant | e.g. the Playwright project |

The compare reads the baseline's and the capture's blocks side by side (`snapshots[].environment` in results.json). A field recorded on one side only is unknown, not a change; `container`, `label` and `ci.provider` are always decided by the collector, so their absence means "no". Only some fields can change rendering (`renderingDelta`): the browser, `os.platform`, `os.arch`, `os.distro` (and `os.release` on macOS and Windows), every `render` field, `adapter.captureMethod`, `container` and `label`. Framework, adapter and driver versions, the CI runner image and the project are context. `testivai env` prints this machine's part of the block.

### `config.json`

```jsonc
{
  "threshold": 0.1,           // pixel diff threshold (0–1)
  "reportDir": "visual-report",
  "autoOpen": false,          // open report in a browser after generation
  "failOnDiff": false,        // exit non-zero from `testivai report` when diffs exist
  "failOnMissing": true,      // default true — exit 3 when a baseline got no capture
  "baselinesDir": ".testivai/baselines",  // override baseline storage ({platform} token supported)
  "maxDiffPercent": 0,        // pass diffs at or below this % (autoPassed: "threshold")
  "maxDiffPixels": 100,       // absolute variant; either criterion passing suffices
  "noiseAutoPass": false,     // auto-pass diffs with identical DOM AND styleCheck "match", not concentrated in one area (autoPassed: "noise")
  "noiseMaxDiffPercent": 1,   // upper bound (diff %) for noiseAutoPass
  "shiftTolerance": 0,        // auto-pass pure element shifts ≤ N px/axis, needs element maps (autoPassed: "shift")
  "environmentPolicy": "warn", // what an environment change since the baseline does: "warn" (report only), "separate" (key snapshots <name>__<browser>__<platform>), "strict" (changed, whatever the pixels)
  "stabilize": true,          // freeze animations, hide caret, await fonts pre-capture
  "ignoreSelectors": [],      // elements hidden (visibility:hidden) during capture
  "mask": [],                 // areas excluded from the pixel diff; selectors or regions
  "volatileAttributes": [],   // attribute names whose VALUES the DOM diff ignores
  "diffRegions": { "minSize": 10, "mergeDistance": 12 },  // diff clustering tunables
  "shareUploadCommand": ""    // shell hook for `report --share`; {file} is the share file
}
```

`config.json` is optional. With no file at all, tools run with the defaults above — local operation is simply how the toolchain works, not a mode you switch on. The file exists to customize thresholds and paths.

The full field list, with types and defaults, lives in `LocalConfig` (`packages/witness/src/config/local-config.ts`).

## `results.json` schema

Written by `generateReport()` to `<reportDir>/results.json`. Consumed by the GitHub Action and any third-party reporter.

```jsonc
{
  "version": "2.5.0",         // results.json SCHEMA version
  "timestamp": "2026-05-08T12:34:56.789Z",
  "summary": {
    "total": 7,
    "passed": 2,
    "changed": 4,
    "newSnapshots": 1,
    "missing": 1             // baselines that received no capture this run
  },
  "missingBaselines": ["pricing"],   // names behind summary.missing
  "environment": {           // this run's captures: the fields they all agree on
    "os": { "platform": "linux", "release": "6.8.0-1017-azure", "arch": "x64", "distro": "ubuntu 24.04" },
    "browser": { "name": "chromium", "version": "141.0.7390.37", "headless": true },
    "adapter": { "name": "@testivai/witness-playwright", "version": "2.0.7", "captureMethod": "full-page:cdp" }
  },
  "snapshots": [
    {
      "name": "homepage",
      "status": "passed",     // "passed" | "changed" | "new"
      "diffPercent": 0,
      "diffCount": 0,
      "totalPixels": 1024000,
      "baselinePath": "images/homepage/baseline.png",
      "currentPath":  "images/homepage/current.png",
      "diffPath":     "images/homepage/diff.png",
      "baselineApprovedAt": "2026-04-02T09:00:00.000Z"
    },
    {
      "name": "checkout-page",
      "status": "passed",     // auto-passed: the pixel diff is kept below
      "diffPercent": 0.5,
      "diffCount": 5120,
      "totalPixels": 1024000,
      "baselinePath": "images/checkout-page/baseline.png",
      "currentPath":  "images/checkout-page/current.png",
      "diffPath":     "images/checkout-page/diff.png",
      "dom": {
        "changed": false,
        "summary": null,
        "noiseHint": true,
        "styleCheck": "match" // "match" | "mismatch" | "unavailable"
      },
      "masks": [              // applied masks — the audit trail for excluded areas
        { "x": 0, "y": 0, "width": 320, "height": 48, "source": "config" }
      ],
      "maskWarnings": [],     // mask specs that could not be resolved
      "autoPassed": "noise"   // present only when a pass criterion applied:
                              // "threshold" (maxDiffPercent/maxDiffPixels),
                              // "noise" (noiseAutoPass: needs noiseHint AND
                              // styleCheck "match" AND a diff not
                              // concentrated in one area), or "shift"
                              // (shiftTolerance); status is then "passed"
    },
    {
      "name": "promo-banner",
      "status": "changed",    // not auto-passed: styles were not compared
      "diffPercent": 0.4,
      "diffCount": 4096,
      "totalPixels": 1024000,
      "baselinePath": "images/promo-banner/baseline.png",
      "currentPath":  "images/promo-banner/current.png",
      "diffPath":     "images/promo-banner/diff.png",
      "dom": {
        "changed": false,
        "summary": null,
        "noiseHint": true,    // DOM identical, no style MISMATCH found...
        "styleCheck": "unavailable" // ...but none compared: render noise or a
                              // stylesheet-only change, not ruled out
      }
    },
    {
      "name": "nav-redesign",
      "status": "changed",
      "diffPercent": 8.5,
      "diffCount": 87040,
      "totalPixels": 1024000,
      "baselinePath": "images/nav-redesign/baseline.png",
      "currentPath":  "images/nav-redesign/current.png",
      "diffPath":     "images/nav-redesign/diff.png",
      "dom": {
        "changed": true,
        "summary": {
          "added": 2,
          "removed": 0,
          "attributeChanges": 1,
          "textChanges": 3
        },
        "noiseHint": false,
        "styleCheck": "mismatch",
        "styleChanges": {     // present on a "mismatch" styleCheck
          "count": 2,
          "elements": ["header > nav", "header > nav > a:nth-child(2)"]
        }
      },
      "regions": [            // changed-pixel clusters, top-left sorted
        {
          "x": 10, "y": 20, "width": 100, "height": 40,
          "diffPixels": 812, "diffPercent": 20.3,
          "classification": "change",   // "shift" | "change"
          "elements": [ { "selector": "header > nav", "role": "changed" } ]
        },
        {
          "x": 0, "y": 120, "width": 1280, "height": 640,
          "diffPixels": 86228, "diffPercent": 10.5,
          "classification": "shift",
          "shift": { "dx": 0, "dy": -1 },
          "elements": [ { "selector": "main", "role": "shifted" } ]
        }
      ],
      "pageShift": { "dy": -1, "belowY": 120, "count": 4 }
    },
    {
      "name": "products",
      "status": "changed",    // never passed: the dimensions changed
      "diffPercent": 7.49,
      "diffCount": 243200,    // on the padded canvas: every padded pixel counts
      "totalPixels": 3248640, // 1280 × 2538, the larger of the two sizes
      "baselinePath": "images/products/baseline.png",
      "currentPath":  "images/products/current.png",
      "diffPath":     "images/products/diff.png",
      "sizeMismatch": {       // the two sizes; a height change is content
        "baseline":  { "width": 1280, "height": 2348 },   // added or removed, a
        "candidate": { "width": 1280, "height": 2538 }    // width change the viewport
      },
      "dom": {
        "changed": true,
        "summary": { "added": 4, "removed": 0, "attributeChanges": 0, "textChanges": 2 },
        "noiseHint": false
      },
      "regions": [ { "x": 0, "y": 2348, "width": 1280, "height": 190, "diffPixels": 243200, "diffPercent": 100 } ]
    },
    {
      "name": "pricing-table",
      "status": "changed",    // rendering drift: the browser changed, the page did not
      "diffPercent": 0.62,
      "diffCount": 6348,
      "totalPixels": 1024000,
      "baselinePath": "images/pricing-table/baseline.png",
      "currentPath":  "images/pricing-table/current.png",
      "diffPath":     "images/pricing-table/diff.png",
      "dom": { "changed": false, "summary": null, "noiseHint": true, "styleCheck": "match" },
      "environment": {
        "delta": ["browser.version", "framework.version"],  // every field that differs
        "renderingDelta": ["browser.version"],               // the ones that can change rendering
        "baseline":  { "browser": { "name": "chromium", "version": "130.0.6723.58" }, "…": "…" },
        "candidate": { "browser": { "name": "chromium", "version": "141.0.7390.37" }, "…": "…" }
      }
    },
    {
      "name": "fresh-baseline",
      "status": "new",
      "diffPercent": 0,
      "diffCount": 0,
      "totalPixels": 0,
      "currentPath": "images/fresh-baseline/current.png"
    }
  ]
}
```

### Field guarantees

| Field | Type | Required | Notes |
|---|---|---|---|
| `version` | string | yes | semver of the **results.json schema** (not the writer's package version) |
| `timestamp` | ISO 8601 string | yes | when the report was generated |
| `summary.total` | number | yes | == `snapshots.length` |
| `summary.passed` / `.changed` / `.newSnapshots` | number | yes | partition of `total` |
| `summary.missing` | number | optional | baselines that received no capture this run; emitted from schema 2.3.0 |
| `missingBaselines` | string[] | optional | names behind `summary.missing`; emitted from schema 2.3.0. Under `environmentPolicy: "separate"`, only baselines of an environment (`__<browser>__<platform>`) this run captured are listed |
| `environment` | object | optional | emitted from schema 2.5.0: the capture environment of this run, as the fields every capture that recorded one agrees on (a multi-browser run shares no `browser`). Same shape as the metadata.json block above; absent when no capture recorded one |
| `snapshots[].name` | string | yes | unique within a report |
| `snapshots[].status` | enum | yes | `passed` &#124; `changed` &#124; `new` |
| `snapshots[].diffPercent` | number | yes | 0–100. 0 for `new` and for a `passed` snapshot with no pixel above `threshold`; an auto-passed snapshot keeps its diff percentage |
| `snapshots[].diffCount` | number | yes | absolute count of differing pixels |
| `snapshots[].totalPixels` | number | yes | total pixels compared (0 for `new`, for a byte-identical `passed` snapshot, and for a `changed` snapshot whose PNG failed to decode); with `sizeMismatch`, the padded canvas (max width × max height) |
| `snapshots[].baselinePath` | string | optional | relative path under `<reportDir>/`; absent for `new` |
| `snapshots[].currentPath` | string | optional | relative path under `<reportDir>/` |
| `snapshots[].diffPath` | string | optional | present whenever the two PNGs differ byte-wise and decode: `changed`, auto-passed, or a `passed` snapshot with no pixel above `threshold`; absent for byte-identical passes, `new`, and a `changed` snapshot whose PNG failed to decode |
| `snapshots[].dom` | object | optional | only present when DOM was captured on both sides and the PNGs differ byte-wise (`changed`, auto-passed, or `passed` with no pixel above `threshold`) |
| `snapshots[].dom.changed` | boolean | yes within `dom` | true if structural DOM diff detected |
| `snapshots[].dom.summary` | object &#124; null | yes within `dom` | null when `changed` is false |
| `snapshots[].dom.summary.added` / `.removed` / `.attributeChanges` | number | yes within `summary` | structural change counts |
| `snapshots[].dom.summary.textChanges` | number | optional | visible-text token changes |
| `snapshots[].dom.noiseHint` | boolean | yes within `dom` | true when pixel diff exists but DOM unchanged **and** no style mismatch was found: either the style digests match (`styleCheck: "match"`) or none were comparable (`styleCheck: "unavailable"`, so styles were not compared). Read it with `styleCheck` and the shape of the diff: only `noiseHint` + `match` with a small, scattered diff (at most 1% of pixels, and no `regions` or regions spread over more than a third of the page; `diffShape` from `@testivai/witness/report`) is likely render noise; `noiseHint` + `match` with every region in a box covering at most a third of the page is a bad capture or a change the style check does not cover; `noiseHint` + `unavailable` means a stylesheet-only change is not ruled out |
| `snapshots[].dom.styleCheck` | enum | optional | `match` &#124; `mismatch` &#124; `unavailable` — computed-style fingerprint verdict; `unavailable` when the verdict could not be measured — no element map on one or both sides, or no element whose `styleHash` is present on both. An adapter that emits bounds without a `styleHash` gets `unavailable`, never a `match`. Absent in results written before the style check existed: treat as `unavailable` |
| `snapshots[].dom.styleChanges` | object | optional | present on `mismatch`: `{ count, elements[] }` (up to 10 selectors) |
| `snapshots[].regions` | array | optional | changed-pixel clusters as bounding boxes: `x`, `y`, `width`, `height`, `diffPixels`, `diffPercent`, plus optional `classification` (`shift` &#124; `change`), `shift` (`{ dx, dy }` when classified `shift`), and `elements[]` (`{ selector, role }`, `role` = `shifted` &#124; `changed`, max 3, smallest first). Attribution fields require captured element maps |
| `snapshots[].pageShift` | object | optional | whole-page uniform displacement: `{ dy, belowY, count }`. Requires element maps on both sides |
| `snapshots[].masks` | array | optional | masks applied to this comparison, resolved to pixels: `{ x, y, width, height, source }`. Present when non-empty |
| `snapshots[].maskWarnings` | string[] | optional | mask specs that could not be applied (e.g. a selector with no captured geometry). Present when non-empty |
| `snapshots[].autoPassed` | enum | optional | `threshold` &#124; `noise` &#124; `shift` — which criterion turned a pixel diff into `passed`. `noise` requires `dom.noiseHint` true **and** `dom.styleCheck: "match"` (changed in this release: `@testivai/witness` 2.1.1 and earlier also gave it to `unavailable` diffs). Never present with `sizeMismatch`: from schema 2.4.0 no criterion passes a size change. A DOM change does not block a criterion (the pixel tolerances stay pixel tolerances); a passed snapshot whose `dom.changed` is true is reported as such |
| `snapshots[].baselineApprovedAt` | ISO 8601 string | optional | when the compared baseline was last approved/added |
| `snapshots[].environment` | object | optional | emitted from schema 2.5.0 when the baseline and the current capture both recorded an `environment` in their metadata.json (one side unrecorded is unknown, not a change) |
| `snapshots[].environment.delta` | string[] | yes within `environment` | every field that differs, as sorted dotted paths (`browser.version`); empty when the environments match |
| `snapshots[].environment.renderingDelta` | string[] | yes within `environment` | the subset that can change rendering (see "Capture provenance"). Pixels differ, `dom.changed` false, `dom.styleCheck: "match"`, a diff not concentrated in one area and a non-empty `renderingDelta` is **rendering drift**: the environment changed, not the page (`isRenderingDrift` from `@testivai/witness/report`). Never word it as render noise |
| `snapshots[].environment.baseline` / `.candidate` | object | optional | both recorded blocks; present when `delta` is non-empty |
| `snapshots[].environment.policy` | `"strict"` | optional | present when `environmentPolicy: "strict"` made the snapshot `changed` because `renderingDelta` is non-empty, whatever its pixels (a byte-identical capture included, with `diffPercent` 0). Under `"warn"` (default) and `"separate"`, the environment never changes a status |
| `snapshots[].sizeMismatch` | object | optional | emitted from schema 2.4.0 when the current capture's dimensions differ from the baseline's: `{ baseline: { width, height }, candidate: { width, height } }`. The two are padded to max width × max height before diffing and every padded pixel counts as changed, so `diffCount`, `diffPercent`, `totalPixels` and `regions` are on that canvas and the snapshot is `changed`, never `passed`. A height change is content added or removed (read it with `dom.summary`); a width change is almost always the viewport or device scale factor, not the page. Before 2.4.0 the candidate was truncated or zero-filled to the baseline's size, so a taller page with an identical overlap passed at 0% |

### Schema versioning

- Adding a new optional field is a **minor** bump (consumers should ignore unknown fields).
- Removing a field, changing a type, or changing a status value is a **major** bump.
- The `version` field is the **schema** version (`RESULTS_SCHEMA_VERSION` in `packages/witness/src/report/generator.ts`), not the version of the package that wrote the file. Consumers that need cross-version compatibility should branch on the schema major.

## Worked example: a hypothetical pytest adapter

Pseudocode for a pytest plugin that produces TestivAI-compatible captures:

```python
import os
from pathlib import Path

def witness(driver, name: str, *, project_root: Path = Path.cwd()):
    """Capture a screenshot + DOM into .testivai/temp/<name>/."""
    temp_dir = project_root / ".testivai" / "temp" / name
    temp_dir.mkdir(parents=True, exist_ok=True)

    # 1. Screenshot
    driver.save_screenshot(str(temp_dir / "screenshot.png"))

    # 2. DOM (best-effort)
    try:
        html = driver.execute_script("return document.documentElement.outerHTML")
        if isinstance(html, str) and html:
            (temp_dir / "dom.html").write_text(html, encoding="utf-8")
    except Exception:
        pass  # noise hint just won't be available
```

The user then runs `npx testivai report` (or wires it into a pytest hook) and the existing OSS tooling does the rest — diff, report, GitHub Action. No JavaScript code in the adapter; just disk I/O conforming to the layout above. This sketch writes no `elements.json`, so its identical-DOM diffs read *styles not compared*; inject the shared element-map collector (step 3 above) to get the style check.

## Stability promise

Both the on-disk layout and the `results.json` schema are governed by the same compatibility promise as published `@testivai/witness` releases. We will not break either contract within a major version. Breaking changes will be announced in `CHANGELOG.md` and gated by a major version bump on `@testivai/witness`.
