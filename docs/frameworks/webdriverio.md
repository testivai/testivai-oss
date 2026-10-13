---
sidebar_position: 2
title: WebdriverIO
---

# WebdriverIO

The `@testivai/witness-webdriverio` adapter is a [WDIO service](https://webdriver.io/docs/customservices/) plus an explicit `testivai.witness(browser, name)` capture call. Same `.testivai/baselines/` layout as the Playwright adapter, same HTML report, same approval workflow.

Everything runs on your machine — no account, no API key, fully standalone.

---

## Prerequisites

- Node.js 18 or higher
- WebdriverIO 8 or 9
- A working WDIO config (`wdio.conf.ts` or `wdio.conf.js`)

---

## 1. Install

```bash
npm install -D @testivai/witness @testivai/witness-webdriverio
```

`webdriverio` is a peer dependency — you should already have it from your existing setup.

---

## 2. Configure local mode

Create `.testivai/config.json` at your project root:

```json
{
  "threshold": 0.1,
  "reportDir": "visual-report",
  "autoOpen": false,
  "maxDiffPercent": 0,
  "noiseAutoPass": false,
  "stabilize": true,
  "ignoreSelectors": []
}
```

This file is the local-mode marker. Without it, the adapter logs a warning and skips report generation — pixels are still captured, but no report is built.

---

## 3. Register the WDIO service

In your `wdio.conf.ts`:

```ts
import { TestivaiService } from '@testivai/witness-webdriverio/service';

export const config = {
  // ... your existing config
  services: [
    [TestivaiService, { quiet: false }],
  ],
};
```

The service runs `onComplete` after the test suite finishes. It compares everything in `.testivai/temp/` against `.testivai/baselines/` and writes the report to `visual-report/`.

---

## 4. Capture inside your tests

```ts
import { testivai } from '@testivai/witness-webdriverio';

describe('Homepage', () => {
  it('renders correctly', async () => {
    await browser.url('http://localhost:3000');
    await testivai.witness(browser, 'homepage');
  });

  it('product detail page', async () => {
    await browser.url('http://localhost:3000/products/widget');
    await testivai.witness(browser, 'product-widget');
  });
});
```

The capture function calls `browser.takeScreenshot()` (a viewport screenshot via the WebDriver protocol), then calls `browser.execute()` for the page DOM (the DOM diff and noise hint) and for the element map (each element's box and computed-style digest, which powers the style check, region attribution and page-shift detection).

---

## 5. Run

```bash
npx wdio run wdio.conf.ts
```

- **First run**: baselines are written to `.testivai/baselines/<name>/`. Commit them: `git add .testivai/baselines`.
- **Later runs**: screenshots are diffed and a self-contained HTML report is written to `./visual-report/`.

---

## Approving changes

```bash
# Open the report
open visual-report/index.html

# Approve a single snapshot
npx testivai approve "homepage"

# Approve everything that changed
npx testivai approve --all

# Undo the last approval
npx testivai approve --undo "homepage"
```

Approved snapshots overwrite the baseline; the previous baseline is backed up to `.testivai/baselines/<name>/.previous/`.

---

## Pixel + DOM comparison

Each snapshot stores the screenshot, the page DOM and an element map (computed-style digests). When the report compares them:

- **Pixels match** → `passed`
- **Pixels differ, DOM and computed styles match** → `changed` with a "DOM unchanged — likely render noise. Styles verified unchanged." hint
- **Pixels differ, DOM matches, computed styles differ** → `changed` with "Styles changed" and the restyled elements: a real style-only change, never noise
- **Pixels differ, DOM matches, styles not compared** (no element map on one side, e.g. `skipElementMap` or a baseline captured without one) → `changed` with "DOM unchanged, styles not compared": could be render noise or a stylesheet-only change, so compare the images
- **Pixels differ, DOM differs** → `changed` with a count of added / removed / attribute changes

None of these auto-passes unless you configure a pass criterion (`maxDiffPercent`, `maxDiffPixels`, `noiseAutoPass`, `shiftTolerance`); `noiseAutoPass` only ever passes the "styles verified unchanged" case. The same hints appear in PR comments via the TestivAI GitHub Action.

To skip DOM capture for a single snapshot (rare — useful only when DOM serialization is slow on a particular page):

```ts
await testivai.witness(browser, 'heavy-page', { skipDom: true });

// Hide dynamic elements for this snapshot only (merged with the global
// ignoreSelectors list from .testivai/config.json)
await testivai.witness(browser, 'dashboard', { ignoreSelectors: ['.live-feed'] });

// Opt out of capture stabilization (animations frozen, fonts awaited) per call
await testivai.witness(browser, 'animation-demo', { stabilize: false });

// Multi-capability runs: key baselines per capability so they don't collide
await testivai.witness(browser, 'homepage', { variant: 'firefox-mobile' });
```

---

## Service options

```ts
[TestivaiService, {
  projectRoot: process.cwd(),  // project root for .testivai/
  reportDir: 'visual-report',  // override report output dir
  threshold: 0.1,              // pixel diff threshold (0–1)
  autoOpen: false,             // open report after generation
  quiet: false,                // suppress logging
}]
```

All options are optional; defaults come from `.testivai/config.json`.

---

## Local-only by design

The WDIO adapter is local-only: captures, diffs, and the report are all produced on disk. The legacy `mode` config field is retired and ignored when present.

---

## See also

- [`@testivai/witness-webdriverio` package README](https://github.com/testivai/testivai-oss/tree/main/packages/webdriverio)
- [Quickstart for the Playwright adapter](./playwright.md) (similar shape, different framework)
