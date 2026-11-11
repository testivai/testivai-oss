---
title: Python (Playwright / Selenium)
---

# Python adapter — `testivai` on PyPI

New here? [vs. rolling your own](../vs-selenium-tooling.md) covers what this replaces in a Python suite.

Which capture features this adapter has, next to the other adapters: [adapter parity](../adapter-parity.md).

Local-first visual regression for **playwright-python and Selenium**,
sharing the same baselines, tolerances, report, and PR approval flow as the
JS/TS adapters — one on-disk contract across languages.

```bash
pip install testivai[playwright]   # or testivai[selenium]
```

Using Selenium? `from testivai.selenium import witness` — see the
[Selenium guide](./selenium.md). The rest of this page covers
playwright-python; config, the pytest plugin, and the report flow are
identical for both.

Node.js is required for the compare/report step, and it's already there:
Playwright for Python ships its own Node driver.

## With pytest (recommended)

The package registers a pytest plugin automatically:

```python
# uses the page fixture from pytest-playwright
def test_homepage(page, testivai_witness):
    page.goto("http://localhost:3000")
    testivai_witness(page, "homepage")     # name optional — defaults to the test name

def test_pricing(page, testivai_witness):
    page.goto("http://localhost:3000/pricing")
    testivai_witness(
        page, "pricing",
        ignore_selectors=[".live-chat"],   # hidden from pixels AND the DOM signal
        variant="chromium",                # keys baselines for multi-browser runs
    )
```

At session end the plugin runs `testivai report`: captures are diffed against
`.testivai/baselines/` with the tolerances from `.testivai/config.json`, and
`visual-report/index.html` + `results.json` are written. Disable the hook
with `TESTIVAI_AUTO_REPORT=0`.

First run: everything is `new` — approve and commit baselines:

```bash
npx testivai approve --all
git add .testivai/baselines/
```

## Without pytest

```python
from testivai import witness, run_report

witness(page, "homepage")
run_report()          # or fail_on_diff=True for CI gating
```

## Capture semantics

- **Stabilized by default**: animations/transitions complete instantly at
  their final state, caret hidden, web fonts awaited (bounded 10s). Override
  per call (`stabilize=False`) or globally (`"stabilize": false` in
  `.testivai/config.json`).
- **`ignore_selectors`** merge with the global `ignoreSelectors` config and
  are excluded from both the pixel diff and the DOM/text signal.
- **`variant="firefox"`** → snapshot `homepage__firefox`; parallel
  browsers/viewports never overwrite each other's baselines.

These match the JS adapters. One difference: the playwright-python
`witness()` writes `screenshot.png` and `dom.html` but no element map
(`elements.json`). Its snapshots therefore get no style check
(`styleCheck: "unavailable"`), no selector attribution and no page-shift
detection. When pixels differ and the DOM is identical, the report says
*styles not compared* — could be render noise or a stylesheet-only change —
rather than likely noise, and `noiseAutoPass` never passes it. The Selenium
path (`testivai.selenium`) records the element map and gets the full
analysis.

Both paths (`testivai` 0.3.0 and later) also write `metadata.json` next to
the screenshot, as the JS adapters do:

- **Capture health** (`health`): what failed to load, read in the page right
  after the screenshot by the same probe the JS adapters run. A web font or a
  stylesheet that failed makes the report call the snapshot an **unhealthy
  capture**, never likely render noise, and an unhealthy baseline is called
  out on every compare against it. A stylesheet that answered 404 is found
  through Resource Timing `responseStatus` (Chromium 109 and later) or because
  it has no stylesheet at all; the Python adapters do not watch the network,
  so a failed request to another origin can go unseen.
- **Capture provenance** (`environment`): the OS and Linux distro, the browser
  and its version, Playwright or Selenium and its version, how the screenshot
  was taken (`full-page:playwright`; for Selenium `full-page:cdp`,
  `full-page:firefox` or `viewport:webdriver`), what the page was rendered
  with, the CI provider, a container and `TESTIVAI_ENV_LABEL`. A diff caused
  by a new browser build or another machine then reads as **rendering
  drift**. `variant` is recorded as the `project`.

Approving a capture freezes both into the baseline's `metadata.json`. See
[adapter parity](../adapter-parity.md) for what each adapter records.

## Configuration

Same `.testivai/config.json` as every adapter — `threshold`,
`maxDiffPercent`, `noiseAutoPass`, `ignoreSelectors`, `stabilize`… see
[Getting Started](../intro.md) for the reference. CLI resolution for the
report step: `TESTIVAI_CLI` env → `testivai` on PATH →
`npx --yes @testivai/witness`.

## CI

Identical to the JS setup — run pytest, then the GitHub Action posts the diff
and handles `/testivai approve` comments. See the
[CI/CD guide](../guides/ci-cd.md).
