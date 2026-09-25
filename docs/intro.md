---
sidebar_position: 1
title: Getting Started
slug: /intro
---

# Getting Started

Add visual regression testing to your test suite in under 5 minutes — fully local, no account needed.

## Prerequisites

- Node.js 18+ (Node 20+ recommended)
- A test suite that drives a real browser (Playwright, Selenium, WebdriverIO, Cypress, Puppeteer, etc.)

---

## Path A — Dedicated adapters (recommended)

Most suites have a first-class adapter today: **Playwright**, **WebdriverIO**, **Selenium** (JavaScript, Python, Java), and **Ruby** (Capybara / RSpec). They use the framework's native screenshot APIs — no CLI wrapper, no Chrome remote debugging port, no race conditions.

### Playwright

The Playwright adapter integrates as a reporter. Just install and add a capture call.

### 1. Install

```bash
npm install -D @testivai/witness-playwright @playwright/test
npx playwright install chromium
```

### 2. (Optional) Customize settings

The reporter compares locally and writes an HTML report with zero configuration — **no account, no API key, nothing uploaded.**

If you want to tune tolerances or change the report output directory, create `.testivai/config.json` at your project root:

```json
{
  "threshold": 0.1,
  "reportDir": "visual-report",
  "autoOpen": false
}
```

Optional tolerance and capture settings (all have safe defaults):

| Field | Default | What it does |
|---|---|---|
| `maxDiffPercent` | `0` | Diffs at or below this percentage report as **passed** — your team's tolerance dial |
| `maxDiffPixels` | unset | Absolute variant: pass when changed-pixel count is at or below this |
| `noiseAutoPass` | `false` | Auto-pass diffs whose DOM is structurally identical (the noise hint), up to `noiseMaxDiffPercent` |
| `noiseMaxDiffPercent` | `1` | Upper bound (diff %) for `noiseAutoPass` |
| `stabilize` | `true` | Freeze animations/transitions, hide the caret, and wait for web fonts before every capture |
| `ignoreSelectors` | `[]` | Elements hidden (`visibility: hidden`) during capture — timestamps, ads, live widgets |
| `mask` | `[]` | Areas excluded from the pixel diff and hatched in the report — selectors or geometric regions ([details](./comparison.md)) |
| `diffRegions` | `{minSize: 10, mergeDistance: 12}` | Diff clustering tunables: noise floor + merge gap ([details](./comparison.md)) |
| `shiftTolerance` | unset | Pass diffs that are pure vertical shifts up to N pixels — content moved, nothing changed |
| `volatileAttributes` | `[]` | Attributes whose *value* is ignored by the DOM diff (presence still counts) |
| `baselinesDir` | `.testivai/baselines` | Where baselines live; supports a `{platform}` token for per-OS baselines |
| `failOnDiff` | `false` | Exit non-zero on changes without passing `--fail-on-diff` |
| `failOnMissing` | `true` | Exit 3 when a committed baseline receives no capture (silent coverage loss) |
| `shareUploadCommand` | unset | Command template run by `report --share` to push `share.html` to your own storage |

Crawler-only fields, used by `testivai witness <url>`: `pages`, `maxPages` (default 10), `viewport` (default 1280×800).

The full list with types lives in `LocalConfig` — see
[`packages/witness/src/config/local-config.ts`](https://github.com/testivai/testivai-oss/blob/main/packages/witness/src/config/local-config.ts).

Auto-passed snapshots keep their diff image and are labeled in the report and in `results.json` (`autoPassed: "threshold" | "noise" | "shift"`), so tolerance never hides information — it just stops demanding review for changes you've declared acceptable.

### 3. Add the reporter

In `playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  reporter: [
    ['list'],
    ['@testivai/witness-playwright/reporter'],
  ],
});
```

### 4. Add a capture call

```ts
import { test } from '@playwright/test';
import { witness } from '@testivai/witness-playwright';

test('homepage looks correct', async ({ page }, testInfo) => {
  await page.goto('http://localhost:3000');
  await witness(page, testInfo, 'homepage');
});
```

### 5. Run

```bash
npx playwright test
```

**First run:** baselines are created under `.testivai/baselines/<name>/screenshot.png` and the report shows `New: N`. Commit them to git.
**Later runs:** screenshots are compared, the HTML report opens at `visual-report/index.html`, and `results.json` is produced.

### WebdriverIO

```bash
npm install -D @testivai/witness @testivai/witness-webdriverio
```

Create `.testivai/config.json` at your project root — the WebdriverIO service
only writes a report when it finds this file:

```json
{}
```

Add the service to `wdio.conf.ts`:

```ts
import { TestivaiService } from '@testivai/witness-webdriverio/service';

export const config = {
  services: [[TestivaiService, {}]],
};
```

Capture inside a test:

```ts
import { testivai } from '@testivai/witness-webdriverio';

it('homepage looks correct', async () => {
  await browser.url('http://localhost:3000');
  await testivai.witness(browser, 'homepage');
});
```

Same `.testivai/baselines/` layout, same HTML report, same approval workflow as the Playwright lane.

→ See the full [WebdriverIO quickstart](./frameworks/webdriverio.md) for service options.

### Ruby (Capybara / RSpec)

```ruby
# Gemfile
gem "testivai", group: :test
```

```ruby
require "testivai"

RSpec.describe "Homepage", type: :feature, js: true do
  it "looks right" do
    visit "/"
    Testivai.witness(page, "homepage")
  end
end
```

Run your suite exactly as you do today, then compare:

```bash
bundle exec rspec
npx testivai report
```

→ See the full [Ruby quickstart](./frameworks/ruby.md) for options and driver notes.

### Selenium, Python, Java

Native adapters share the same baselines and report — see
[Selenium](./frameworks/selenium.md), [Python](./frameworks/python.md), and
[Java](./frameworks/java.md).

---

## Path B — Other Frameworks (experimental)

For Cypress, Puppeteer, Robot Framework and similar, use the framework-agnostic CLI from `@testivai/witness`. It wraps your test command and captures via Chrome's DevTools Protocol.

:::warning Experimental
This sidecar mode is labeled experimental — launch coordination across frameworks is brittle. For Playwright and WebdriverIO, prefer the dedicated adapters above. See [the sidecar caveats](./sidecar-testivai-run.md) for the full picture, and [community adapter contract](./extension-api.md) if you'd like to write a proper adapter for your framework.
:::

### 1. Install the CLI

```bash
npm install -D @testivai/witness
```

### 2. Run the setup wizard

```bash
npx testivai init
```

The wizard detects your framework and generates helper files plus a `testivai.config.ts`.

### 3. Add a capture call

The wizard generates an example file. The key call is `witness('name')`:

```js
// Cypress
it('homepage looks correct', () => {
  cy.visit('/');
  cy.witness('homepage');
});
```

```python
# pytest
from testivai_witness import witness

def test_homepage(driver):
    driver.get('http://localhost:3000')
    witness(driver, 'homepage')
```

### 4. Run

```bash
# Cypress
npx testivai run "cypress run --browser chrome"

# pytest
npx testivai run "pytest tests/ -v"
```

The wrapper boots Chrome with `--remote-debugging-port=9222`, runs your tests, captures screenshots, and writes baselines + report.

---

## What gets produced (local mode)

| Path | Purpose |
|---|---|
| `.testivai/baselines/<name>/screenshot.png` | Committed baseline (track in git) |
| `.testivai/temp/` | Transient per-run captures (gitignore this) |
| `visual-report/index.html` | Self-contained HTML diff report |
| `visual-report/results.json` | Machine-readable summary |

Recommended `.gitignore`:

```
.testivai/temp/
visual-report/
```

---

## What's Next

- **[How It Works](./how-it-works.md)** — local pipeline, capture layers, diff algorithm
- **[vs. Playwright's built-in](./vs-playwright-builtin.md)** — honest comparison with `toHaveScreenshot()`
- **[vs. rolling your own (Selenium)](./vs-selenium-tooling.md)** — for Selenium suites, where there is no built-in
- **[Philosophy](./philosophy.md)** — local-first detection, bring-your-own-model AI
- **[MCP server](./mcp.md)** — hand your agent the evidence; your model does the reasoning
- **[Maintenance & roadmap](./maintenance.md)** — who builds this, cadence, and what happens if it stops
- **[Playwright adapter](./frameworks/playwright.md)** / **[WebdriverIO adapter](./frameworks/webdriverio.md)**
- **[GitHub Action](./github-action.md)** — post results to PRs
- **[Extension API](./extension-api.md)** — write a community adapter for your framework
- **[Guides: CI/CD](./guides/ci-cd.md)** — running OSS lane in GitHub Actions
