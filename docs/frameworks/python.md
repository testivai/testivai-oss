---
title: Python (Playwright / Selenium)
---

# Python adapter — `testivai` on PyPI

New here? [vs. rolling your own](../vs-selenium-tooling.md) covers what this replaces in a Python suite.

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

## Capture semantics (identical to the JS adapters)

- **Stabilized by default**: animations/transitions complete instantly at
  their final state, caret hidden, web fonts awaited (bounded 10s). Override
  per call (`stabilize=False`) or globally (`"stabilize": false` in
  `.testivai/config.json`).
- **`ignore_selectors`** merge with the global `ignoreSelectors` config and
  are excluded from both the pixel diff and the DOM/text signal.
- **`variant="firefox"`** → snapshot `homepage__firefox`; parallel
  browsers/viewports never overwrite each other's baselines.

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
