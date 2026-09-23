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
    │       ├── dom.html        # optional — enables the noise-hint signal
    │       └── .previous/      # snapshot of the baseline before the last approve
    │           ├── screenshot.png
    │           ├── metadata.json
    │           └── dom.html
    └── temp/
        └── <name>/
            ├── screenshot.png  # required
            └── dom.html        # optional
```

### Adapter responsibilities

A new adapter — JS, Python, or otherwise — needs to do **exactly two things**:

1. Capture a full-page screenshot and write it to `.testivai/temp/<name>/screenshot.png`.
2. Optionally capture `document.documentElement.outerHTML` and write it to `.testivai/temp/<name>/dom.html`.

That's the entire contract for capture. After the test run, the user invokes `npx testivai report` (or the framework adapter triggers it via a lifecycle hook), which:

- Diffs `temp/<name>/` against `baselines/<name>/`
- Writes `visual-report/results.json` and `visual-report/index.html`
- The GitHub Action (or any other tool) reads `results.json`

### `metadata.json` (baseline only)

```jsonc
{
  "name": "homepage",
  "createdAt": "2026-05-08T12:34:56.789Z",
  "updatedAt": "2026-05-08T12:34:56.789Z",
  "approvedBy": "local",     // optional — set by `testivai approve`
  "width": 1280,             // optional — viewport width at capture
  "height": 800              // optional — viewport height at capture
}
```

`width` and `height` are advisory; the diff engine re-derives dimensions from the PNG buffer.

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
  "noiseAutoPass": false,     // auto-pass DOM-identical diffs (autoPassed: "noise")
  "noiseMaxDiffPercent": 1,   // upper bound (diff %) for noiseAutoPass
  "shiftTolerance": 0,        // auto-pass pure element shifts ≤ N px/axis (autoPassed: "shift")
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
  "version": "2.3.0",         // results.json SCHEMA version
  "timestamp": "2026-05-08T12:34:56.789Z",
  "summary": {
    "total": 5,
    "passed": 1,
    "changed": 3,
    "newSnapshots": 1,
    "missing": 1             // baselines that received no capture this run
  },
  "missingBaselines": ["pricing"],   // names behind summary.missing
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
      "status": "changed",
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
                              // "noise" (noiseAutoPass), or "shift"
                              // (shiftTolerance); status is then "passed"
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
| `missingBaselines` | string[] | optional | names behind `summary.missing`; emitted from schema 2.3.0 |
| `snapshots[].name` | string | yes | unique within a report |
| `snapshots[].status` | enum | yes | `passed` &#124; `changed` &#124; `new` |
| `snapshots[].diffPercent` | number | yes | 0–100. 0 for `passed` and `new`. |
| `snapshots[].diffCount` | number | yes | absolute count of differing pixels |
| `snapshots[].totalPixels` | number | yes | total pixels compared (0 for `new`) |
| `snapshots[].baselinePath` | string | optional | relative path under `<reportDir>/`; absent for `new` |
| `snapshots[].currentPath` | string | optional | relative path under `<reportDir>/` |
| `snapshots[].diffPath` | string | optional | only present for `changed` |
| `snapshots[].dom` | object | optional | only present when DOM was captured on both sides for a `changed` snapshot |
| `snapshots[].dom.changed` | boolean | yes within `dom` | true if structural DOM diff detected |
| `snapshots[].dom.summary` | object &#124; null | yes within `dom` | null when `changed` is false |
| `snapshots[].dom.summary.added` / `.removed` / `.attributeChanges` | number | yes within `summary` | structural change counts |
| `snapshots[].dom.summary.textChanges` | number | optional | visible-text token changes |
| `snapshots[].dom.noiseHint` | boolean | yes within `dom` | true when pixel diff exists but DOM unchanged **and** style digests match |
| `snapshots[].dom.styleCheck` | enum | optional | `match` &#124; `mismatch` &#124; `unavailable` — computed-style fingerprint verdict; `unavailable` when the verdict could not be measured — no element map on one or both sides, or no element whose `styleHash` is present on both. An adapter that emits bounds without a `styleHash` gets `unavailable`, never a `match` |
| `snapshots[].dom.styleChanges` | object | optional | present on `mismatch`: `{ count, elements[] }` (up to 10 selectors) |
| `snapshots[].regions` | array | optional | changed-pixel clusters as bounding boxes: `x`, `y`, `width`, `height`, `diffPixels`, `diffPercent`, plus optional `classification` (`shift` &#124; `change`), `shift` (`{ dx, dy }` when classified `shift`), and `elements[]` (`{ selector, role }`, `role` = `shifted` &#124; `changed`, max 3, smallest first). Attribution fields require captured element maps |
| `snapshots[].pageShift` | object | optional | whole-page uniform displacement: `{ dy, belowY, count }`. Requires element maps on both sides |
| `snapshots[].masks` | array | optional | masks applied to this comparison, resolved to pixels: `{ x, y, width, height, source }`. Present when non-empty |
| `snapshots[].maskWarnings` | string[] | optional | mask specs that could not be applied (e.g. a selector with no captured geometry). Present when non-empty |
| `snapshots[].autoPassed` | enum | optional | `threshold` &#124; `noise` &#124; `shift` — which criterion turned a pixel diff into `passed` |
| `snapshots[].baselineApprovedAt` | ISO 8601 string | optional | when the compared baseline was last approved/added |

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

The user then runs `npx testivai report` (or wires it into a pytest hook) and the existing OSS tooling does the rest — diff, report, GitHub Action. No JavaScript code in the adapter; just disk I/O conforming to the layout above.

## Stability promise

Both the on-disk layout and the `results.json` schema are governed by the same compatibility promise as published `@testivai/witness` releases. We will not break either contract within a major version. Breaking changes will be announced in `CHANGELOG.md` and gated by a major version bump on `@testivai/witness`.
