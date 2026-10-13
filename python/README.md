# testivai (Python)

Local-first visual regression for **playwright-python** — pixel + DOM
comparison with tunable tolerances, a self-contained HTML report, and
PR-comment baseline approvals. Shares the exact on-disk contract with the
JS/TS TestivAI adapters, so mixed-language repos use **one set of baselines,
one report, one approval flow**.

```bash
pip install testivai[playwright]
```

## With pytest (pytest-playwright)

```python
def test_homepage(page, testivai_witness):
    page.goto("http://localhost:3000")
    testivai_witness(page, "homepage")
```

The bundled pytest plugin runs `testivai report` at session end: captures are
diffed against `.testivai/baselines/`, tolerances from `.testivai/config.json`
apply, and `visual-report/index.html` + `results.json` are written. Approve
baselines with `npx testivai approve --all` (or a `/testivai approve` PR
comment via the GitHub Action).

## Without pytest

```python
from testivai import witness, run_report

witness(page, "homepage", ignore_selectors=[".live-feed"], variant="firefox")
run_report()
```

## What captures do

- **Stabilization by default**: animations/transitions complete instantly at
  their final state, caret hidden, web fonts awaited — the top causes of
  flaky visual diffs, neutralized.
- **`ignore_selectors`**: hidden from the pixels *and* excluded from the DOM
  snapshot, so the content they match never counts as a change. The hidden
  element keeps its layout (`visibility: hidden`), so a change in its size
  can still shift what's around it. Other dynamic content still shows up
  as a diff until you list it.
- **`variant`**: folds into the snapshot name (`homepage__firefox`) so
  parallel browsers/viewports never overwrite each other's baselines.

The playwright-python adapter does not record an element map yet. Its
snapshots get no style check (`styleCheck: "unavailable"`), no selector
attribution and no page-shift detection, so a pixel diff with an identical
DOM reads *styles not compared* — could be render noise or a
stylesheet-only change — and `noiseAutoPass` never passes it. Selenium
captures (`from testivai.selenium import witness`) record the element map
and get the full style check.

The compare/report half runs via the `@testivai/witness` CLI — Node.js is
already present wherever playwright-python is (Playwright for Python ships a
Node driver). Resolution order: `TESTIVAI_CLI` env → `testivai` on PATH →
`npx --yes @testivai/witness`.

Docs: https://github.com/testivai/testivai-oss/blob/main/docs/frameworks/python.md

MIT.
