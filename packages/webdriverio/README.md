# @testivai/witness-webdriverio

WebdriverIO adapter for [TestivAI Witness](https://github.com/testivai/testivai-oss) — local-first visual regression testing with pixel + DOM comparison. No account required.

Pairs with `@testivai/witness` (the local CLI + diff engine + HTML report) and shares the `.testivai/baselines/` layout used by `@testivai/witness-playwright`. Switching between Playwright and WebdriverIO produces the same baselines, the same report, and the same approval workflow.

## Why an adapter and not the `testivai run` sidecar?

The framework-agnostic `testivai run` mode launches your test process and attaches to Chrome via CDP. That works but is brittle: framework-specific Chrome launch flags, target selection across iframes, signal handling. This adapter sidesteps all of that by using WebdriverIO's native `browser.takeScreenshot()` + `browser.execute()`. No port polling, no race conditions.

## Install

```bash
npm install -D @testivai/witness @testivai/witness-webdriverio
```

`webdriverio@>=8` is a peer dependency (you should already have it).

## Quick start

### 1. Tell TestivAI to run in local mode

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

This file is required — it is the marker the service looks for. Without it, the adapter logs a warning and skips report generation.

### 2. Register the service in `wdio.conf.ts`

```ts
import { TestivaiService } from '@testivai/witness-webdriverio/service';

export const config = {
  // ...
  services: [
    [TestivaiService, { quiet: false }],
  ],
};
```

The service runs after all tests complete. It reads `.testivai/temp/` (where `witness()` wrote captures), diffs against `.testivai/baselines/`, and produces `visual-report/` with `index.html` + `results.json`.

### 3. Capture inside your tests

```ts
import { testivai } from '@testivai/witness-webdriverio';

describe('Homepage', () => {
  it('looks correct', async () => {
    await browser.url('https://example.com');
    await testivai.witness(browser, 'homepage');
  });

  it('checkout flow first step', async () => {
    await browser.url('https://example.com/checkout');
    await testivai.witness(browser, 'checkout-step-1');
  });
});
```

### 4. Run

```bash
npx wdio run wdio.conf.ts
```

- **First run**: baselines are written to `.testivai/baselines/<name>/`. Commit them with `git add .testivai/baselines`.
- **Later runs**: screenshots are diffed and a self-contained HTML report is written to `./visual-report/`.

## Approving changes

When the report shows changed snapshots:

```bash
# Review them in visual-report/index.html
open visual-report/index.html

# Approve a single snapshot
npx testivai approve "homepage"

# Approve everything that changed
npx testivai approve --all
```

Approve writes the temp capture over the baseline and backs the previous baseline up to `.testivai/baselines/<name>/.previous/`. `npx testivai approve --undo "homepage"` reverts.

## DOM noise hint and style check

Alongside the screenshot the adapter writes `dom.html` and `elements.json`, the element map: each element's box and a digest of its computed styles, collected by the same function the Playwright and Selenium adapters use.

- When pixels differ but the DOM is structurally identical and no computed style changed, the report flags the change as "likely render noise" (anti-aliasing, font hinting, sub-pixel layout).
- When the DOM is identical but computed styles differ, it reports a style-only change, which is real, and names the restyled elements.
- When the DOM also differs, it shows added / removed / attribute-change counts so you can decide whether the change is intentional.

The element map also powers region attribution (which selectors a diff region covers) and page-shift detection.

WebDriver's screenshot is the **viewport**, not the full page, so the element map keeps only the elements inside the captured viewport, in screenshot coordinates. Size the browser window to what you want compared, and capture at the same scroll position each run.

Both captures happen automatically and are best-effort: if either fails, the pixel diff still runs. To skip them for a single snapshot:

```ts
await testivai.witness(browser, 'no-dom', { skipDom: true, skipElementMap: true });
```

## API

### `testivai.witness(browser, name, options?)`

Captures a viewport screenshot, the DOM and the element map, and writes them as a temp snapshot.

| Param | Type | Description |
|---|---|---|
| `browser` | WebdriverIO browser | Must expose `takeScreenshot()` and (for DOM) `execute()`. |
| `name` | string | Snapshot name. Becomes `.testivai/temp/<name>/` and the key in the report. |
| `options.skipDom` | boolean | Skip DOM capture for this snapshot. |
| `options.skipElementMap` | boolean | Skip the element map for this snapshot (no style check, region attribution or page-shift detection). |
| `options.maxElements` | number | Cap on elements collected for the element map. Default: 3000. |
| `options.ignoreSelectors` | string[] | Elements hidden (`visibility: hidden`) for this capture; merged with the global `ignoreSelectors` from `.testivai/config.json`. |
| `options.stabilize` | boolean | Override capture stabilization (animations frozen, caret hidden, fonts awaited). Default: `true` (or the global `stabilize` setting). |

### `TestivaiService`

Class registered as a WDIO service. Implements `onComplete`.

| Option | Type | Default | Description |
|---|---|---|---|
| `projectRoot` | string | `process.cwd()` | Project root for the test run. |
| `reportDir` | string | local config (`visual-report`) | Override the report directory. |
| `threshold` | number | local config (`0.1`) | Diff threshold (0–1). |
| `autoOpen` | boolean | `false` | Auto-open the report in a browser. |
| `quiet` | boolean | `false` | Suppress all logging except errors. |

## Status

- **Local mode**: stable

## Links

- Repo: https://github.com/testivai/testivai-oss
- Issues: https://github.com/testivai/testivai-oss/issues

## License

MIT
