---
sidebar_position: 6
title: Playwright
---

# Playwright

Playwright has its own dedicated TestivAI SDK — `@testivai/witness-playwright`. Unlike other frameworks, Playwright does **not** use the sidecar approach. The SDK integrates directly with Playwright's built-in browser control.

---

## Prerequisites

- Node.js 18+
- `@playwright/test` installed in your project

```bash
npm install @playwright/test
```

---

## 1. Install the Playwright SDK

```bash
npm install -D @testivai/witness-playwright @playwright/test
npx playwright install chromium
```

:::info No `testivai run` wrapper
Playwright uses a dedicated SDK — run your tests with `npx playwright test`, not `testivai run`. The `testivai` CLI is still what gates CI (`npx testivai report --fail-on-diff`); it ships as a dependency of the SDK.
:::

---

## 2. Configure (optional)

Local mode is the default — no API key, no account; diffs and reports are produced on disk with zero configuration. To customize thresholds or paths, create `.testivai/config.json` at your project root:

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

The reporter detects this file and switches to local mode automatically. **Skip to step 3.**

Tolerance & capture settings (all optional — full reference in [Getting Started](../intro.md)):

- `maxDiffPercent` / `maxDiffPixels` — diffs within these bounds report as **passed** (labeled `autoPassed` in the report and `results.json`)
- `noiseAutoPass` + `noiseMaxDiffPercent` — auto-pass DOM-identical diffs (the noise hint) within the bound
- `stabilize` (default `true`) — before every capture: animations/transitions frozen, caret hidden, web fonts awaited — the top causes of flaky visual diffs, neutralized by default
- `ignoreSelectors` — elements hidden (`visibility: hidden`) during capture

---

## 3. Configure Reporter

Add the TestivAI reporter to your `playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  reporter: [
    ['html'], // Keep Playwright's HTML reporter
    ['@testivai/witness-playwright/reporter', {
      // Optional configuration
      debug: false, // Set to true for verbose logging
    }]
  ],
  use: {
    // Your Playwright configuration
  },
});
```

### Reporter Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `debug` | `boolean` | `false` | Enable verbose logging. Can also be set via `TESTIVAI_DEBUG=true` |
| `captureOnly` | `boolean` | auto | Capture without comparing or writing a report. Auto-enables for sharded runs (`--shard=i/N`, N > 1), where comparing inside a shard is wrong. Also settable via `TESTIVAI_CAPTURE_ONLY=1`; set `false` to force per-shard reports. |

:::note The reporter cannot fail your build
Playwright owns the exit code and it reflects test results, not visual ones — so
`npx playwright test` can print `Changed: 3` and still exit `0`. The report is
for looking at; **`npx testivai report --fail-on-diff` is what gates CI.** The
reporter prints a warning saying exactly this whenever something changed.

In CI, `captureOnly` (or `TESTIVAI_CAPTURE_ONLY=1`) is the tidy setup: capture in
the test run, compare once in the gate step. See the
[CI/CD guide](../guides/ci-cd.md).
:::

---

## 4. Add Capture Calls

Import `testivai` from the SDK and call `testivai.witness(page, testInfo, 'name')` in your tests.

**Multiple Playwright projects?** Snapshots are keyed per project
automatically: with projects `chromium-desktop` and `mobile-safari`, the
same call produces `homepage__chromium-desktop` and
`homepage__mobile-safari` — no baseline collisions. Single-project configs
keep plain names. An optional fourth argument takes per-snapshot overrides, e.g. `{ ignoreSelectors: ['.live-widget'], stabilize: false, mask: ['#cookie-banner', { top: 24 }] }` (masks are excluded from the diff and hatched in the report — see [Comparison](../comparison.md)):

```ts
import { test } from '@playwright/test';
import { testivai } from '@testivai/witness-playwright';

test('homepage looks correct', async ({ page }, testInfo) => {
  await page.goto('http://localhost:3000');
  await testivai.witness(page, testInfo, 'homepage');
});

test('login page looks correct', async ({ page }, testInfo) => {
  await page.goto('http://localhost:3000/login');
  await testivai.witness(page, testInfo, 'login-page');
});
```

---

## 5. Full Working Example

```ts
import { test, expect } from '@playwright/test';
import { testivai } from '@testivai/witness-playwright';

test.describe('Visual Regression', () => {
  test('homepage', async ({ page }, testInfo) => {
    await page.goto('/');
    await testivai.witness(page, testInfo, 'homepage');
  });

  test('navigation state', async ({ page }, testInfo) => {
    await page.goto('/');
    await page.click('nav a[href="/about"]');
    await testivai.witness(page, testInfo, 'about-page');
  });

  test('mobile viewport', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    await testivai.witness(page, testInfo, 'homepage-mobile');
  });
});
```

---

## 6. Run

Run your tests normally with Playwright — no `testivai run` wrapper needed:

```bash
npx playwright test
```

---

## Cross-browser testing

The capture path uses only native Playwright APIs, so Firefox and WebKit
work exactly like Chromium. Enable them by listing multiple projects:

```ts
projects: [
  { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  { name: 'firefox',  use: { ...devices['Desktop Firefox'] } },
  { name: 'webkit',   use: { ...devices['Desktop Safari'] } },
],
```

With more than one project, every snapshot is keyed per browser
automatically — `header__chromium`, `header__firefox`, `header__webkit` —
so each engine diffs against its own baseline (browsers rasterize fonts
and anti-aliasing differently; comparing across engines would always be
red). Approve them like any other snapshot: `npx testivai approve --all`.

**Migrating from a single-project config:** snapshot names gain the
`__<project>` suffix the moment a second project appears. Your existing
un-suffixed baselines become orphans — delete them, run once, and approve
the new per-browser set.

Remember to install the extra engines in CI:
`npx playwright install chromium firefox webkit --with-deps`.

The standalone `testivai witness <url>` crawler and the experimental
`testivai run` sidecar drive Chrome over CDP and remain Chromium-only.

---

## Mobile web coverage

Mobile web is device emulation, not a separate runner: list one Playwright
project per device and the capture path is unchanged.

```ts
projects: [
  { name: 'desktop-chrome', use: { ...devices['Desktop Chrome'] } },
  { name: 'mobile-safari',  use: { ...devices['iPhone 13'] } },
  { name: 'mobile-chrome',  use: { ...devices['Pixel 7'] } },
],
```

One `testivai.witness(page, testInfo, 'pricing')` call then produces
`pricing__desktop-chrome`, `pricing__mobile-safari` and
`pricing__mobile-chrome` — the same `<name>__<project>` keying as
cross-browser runs (the project name is lowercased and non-alphanumerics
become `_`), each diffed against its own baseline. A change scoped to
a `@media (max-width: 600px)` block is flagged on the mobile variants and
passes on desktop; DOM diff, region→selector attribution and the style check
all work under emulation.

Two caveats, covered in full in the guide: captured resolution is not
uniform across engines — the WebKit path applies `deviceScaleFactor` while
the Chromium path captures CSS pixels, so Mobile Chrome baselines are
lower-fidelity than the device (harmless for detection, since each variant
only ever compares against its own baseline) — and there is no in-project
viewport matrix; one project per device is the mechanism today.

→ Full recipe: **[Mobile web](../guides/mobile-web.md)**

---

## CI/CD

GitHub Actions example:

```yaml
- name: Install dependencies
  run: npm ci

- name: Install Playwright browsers
  run: npx playwright install --with-deps chromium

- name: Run visual tests
  run: npx playwright test

- name: Visual diff gate
  run: npx testivai report --fail-on-diff
```

**Baselines belong to the environment that compares them.** Font
rasterization differs between macOS, Windows, and Linux, so a baseline
captured on your laptop will report diffs on a Linux CI runner every
time — 100% changed, forever. If CI is where comparisons happen, adopt
CI's own captures as baselines: the [report action](../github-action.md)
bundles every changed capture into the artifact as
`visual-report/pending-baselines/`, and a `/testivai approve` PR comment
commits them back to the branch. Local runs on a different OS remain
useful as a smoke check, just not as the source of truth.

---

## What gets captured

| Data | Captured | Powers |
|---|---|---|
| Full-page PNG screenshot | Yes | The pixel diff and heatmap |
| Page HTML snapshot | Yes | DOM diff, render-noise hint, text-change detection |
| Element map (selectors, boxes, computed styles) | Yes | Region→selector attribution, shift detection, style check |

Everything is written under `.testivai/temp/<name>/` and compared against `.testivai/baselines/<name>/`. Nothing leaves your machine.

The screenshot and a DOM snapshot are captured — the DOM snapshot powers the render-noise hint and text-change detection, and the element map powers region→selector attribution, shift detection, and the style-change check.

---

## How it works

The Playwright SDK uses Playwright's native `page.screenshot()`, `page.evaluate()`, and browser session APIs directly — no external Chrome debugging port required, so the adapter runs inside the same browser context as your test.

→ **[See all captured layers](/how-it-works)**

---

## Changelog

Per-release notes live in
[CHANGELOG.md](https://github.com/testivai/testivai-oss/blob/main/packages/playwright/CHANGELOG.md)
and on the [GitHub releases page](https://github.com/testivai/testivai-oss/releases).
