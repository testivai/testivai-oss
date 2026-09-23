---
title: Mobile web visual testing
---

# Mobile web visual testing

Mobile web visual regression works **today**, with the Playwright adapter you
already have. There is no mobile package to install, no new API, and no
separate runner. Device emulation is a Playwright concern, so you add
*projects* to `playwright.config.ts` and keep calling
`testivai.witness(page, testInfo, 'name')` exactly as you do on desktop —
the call is unchanged, and every layer (pixel diff, DOM diff, element
attribution, style check) works under emulation.

The capture, keying, detection and report behaviour below was run end to end
against the published packages — `@testivai/witness-playwright@2.0.1`,
`@testivai/witness@2.0.1`, and `@playwright/test@1.58.1`. The CI, config and
crawler notes are traced to the source rather than measured. Read
[Known limits](#known-limits) before you commit a set of mobile baselines.

:::note Scope: mobile **web**
This is browser rendering under Playwright's device emulation — a mobile
viewport plus the matching engine (WebKit for the iPhone profiles, Chromium
for the Android ones). It is not native iOS/Android app testing, and it is not
a real-device farm. Emulation is what CI can run on every push; it catches
layout and CSS regressions, not device-specific browser quirks.
:::

---

## One project per device

Install the adapter and the engines your profiles need. The iPhone profiles
run on WebKit, so `webkit` is not optional here:

```bash
npm install -D @testivai/witness-playwright @playwright/test
npx playwright install chromium webkit --with-deps
```

Then declare a project per device. This is the complete config — nothing else
is required:

```ts title="playwright.config.ts"
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  reporter: [['@testivai/witness-playwright/reporter']],
  projects: [
    { name: 'desktop-chrome', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-safari',  use: { ...devices['iPhone 13'] } },
    { name: 'mobile-chrome',  use: { ...devices['Pixel 7'] } },
  ],
});
```

What those three descriptors actually are, from Playwright's own devices
table:

| Project | Device profile | Engine | Viewport | `deviceScaleFactor` | `isMobile` |
|---|---|---|---|---|---|
| `desktop-chrome` | `Desktop Chrome` | chromium | 1280×720 | 1 | `false` |
| `mobile-safari` | `iPhone 13` | webkit | 390×664 | 3 | `true` |
| `mobile-chrome` | `Pixel 7` | chromium | 412×839 | 2.625 | `true` |

The test is the ordinary one. One `witness()` call, three projects, three
baselines:

```ts title="tests/pricing.spec.ts"
import { test } from '@playwright/test';
import { testivai } from '@testivai/witness-playwright';

test('pricing page', async ({ page }, testInfo) => {
  await page.goto('http://localhost:3000/pricing');
  await testivai.witness(page, testInfo, 'pricing');
});
```

```bash
npx playwright test
```

---

## How baselines are keyed per device

With more than one project configured, the adapter folds the project name
into the snapshot name — `<name>__<project-slug>` — so the three captures
never overwrite each other. The slug is the project name lowercased with any
run of characters outside `a-z0-9_-` collapsed to `_`, so a project called
`Mobile Safari` keys as `mobile_safari`. Named `mobile-safari`, as above, it
stays `mobile-safari`.

The run above produced exactly three capture directories:

```text
.testivai/temp/
  pricing__desktop-chrome/
    screenshot.png
    dom.html
    elements.json
  pricing__mobile-safari/
    screenshot.png
    dom.html
    elements.json
  pricing__mobile-chrome/
    screenshot.png
    dom.html
    elements.json
```

Three files each, and nothing else — `metadata.json` is only written when a
capture has masks to record. `elements.json` held 7 entries per capture on
this fixture page; each entry is a box plus a computed-style digest:

```json
{ "path": "body > h1", "x": 72, "y": 136, "width": 1026, "height": 114, "styleHash": "e7ea8e00" }
```

That `styleHash` is what lets the comparison say *which* element changed and
whether the change was style-only rather than structural — see the worked
example below.

Approving copies each directory to `.testivai/baselines/<name>__<project>/`,
which is what you commit.

---

## Catching a mobile-only regression

This is the case device emulation exists for: a change inside a media query
that desktop cannot see.

The fixture page has a responsive block:

```css
.cta { background: #1f6feb; }        /* untouched */

@media (max-width: 600px) {
  .cta { background: #b3261e; }      /* the only edit */
}
```

The exact colours don't matter — what matters is that the edit is confined to
the `@media (max-width: 600px)` block, so it can only render below 600px CSS
pixels wide. Re-running the same spec and comparing:

```bash
npx playwright test
npx testivai report
```

```text
  ═══ TestivAI Visual Report ═══
  Total: 3  |  Passed: 1  |  Changed: 2  |  New: 0
```

Desktop correctly passes; both mobile variants are flagged:

| Snapshot | Diff | Status |
|---|---|---|
| `pricing__desktop-chrome` | 0% | passed |
| `pricing__mobile-chrome` | 4.29% | changed |
| `pricing__mobile-safari` | 5.42% | changed |

Desktop is the control here. A media-query-only edit *must not* move the
1280×720 rendering, and it didn't — a desktop-only suite would have shipped
this change green.

### The verdict is attributed, not just red

The interesting part is what `visual-report/results.json` (schema
`"version": "2.3.0"`) says about the two flagged snapshots. Both carry the
same payload — abridged here, region geometry omitted:

```json
{
  "dom": {
    "changed": false,
    "summary": null,
    "noiseHint": false,
    "styleCheck": "mismatch",
    "styleChanges": { "count": 1, "elements": ["body > button.cta"] }
  },
  "regions": [
    {
      "classification": "change",
      "elements": [
        { "selector": "body > button.cta", "role": "changed" },
        { "selector": "body", "role": "changed" }
      ]
    }
  ]
}
```

Read that back in words: the markup did not change (`"changed": false`), this
is not render noise (`"noiseHint": false`), exactly one element's computed
style differs (`"styleCheck": "mismatch"` naming `body > button.cta`), and the
pixel cluster is a real change rather than a layout shift
(`"classification": "change"`). That is the full DOM-aware, style-only
attribution — and it survives device emulation intact. The report tells you
*the CTA's style changed on mobile*, not merely *some pixels differ*.

---

## Approving and gating

Accept the new look for every variant at once, then commit the baselines:

```bash
npx testivai approve --all
git add .testivai/baselines/ && git commit -m "mobile baselines"
```

To accept one device only, name it:
`npx testivai approve pricing__mobile-safari`.
The suffixed name is the real snapshot name, so it works everywhere a name is
accepted — the CLI, the report, and `/testivai approve` PR comments.

In CI, remember that `testivai report` **exits 0 on changes unless you gate
it**. Pass `--fail-on-diff`, or set `"failOnDiff": true` in
`.testivai/config.json`. The relevant steps, slotting into the workflow from
the [CI/CD guide](./ci-cd.md):

```yaml
      - run: npm ci
      - run: npx playwright install chromium webkit --with-deps

      # Capture only; the gate below is the authoritative verdict.
      - run: npx playwright test
        env:
          TESTIVAI_CAPTURE_ONLY: '1'

      - name: Visual diff gate
        run: npx testivai report --fail-on-diff
```

Two things carry over unchanged from the [CI/CD guide](./ci-cd.md):

- **Baselines belong to the environment that compares them.** Emulated mobile
  captures are still rasterized by the runner's fonts, so a laptop baseline
  will read as changed on a Linux runner — adopt CI's own captures.
- **Sharded runs must not compare.** Per-device projects multiply the suite,
  which is exactly when sharding starts to look attractive; the capture-only
  and `merge-captures` flow in [Sharded runs](./ci-cd.md#sharded-runs) applies
  as-is.

If you keep a `.testivai/config.json`, note the key names are `baselinesDir`
and `reportDir` — not `baselineDir` or `outputDir`. Unknown keys are ignored,
but never silently: each one warns on stderr, with a did-you-mean suggestion
when the key is close to a real one and the full list of known keys
otherwise.

---

## Known limits

### `deviceScaleFactor` is applied on WebKit and dropped on Chromium

The captured PNGs from the run above:

| Capture | Viewport | `deviceScaleFactor` | Captured PNG |
|---|---|---|---|
| `pricing__desktop-chrome` | 1280×720 | 1 | 1280×720 |
| `pricing__mobile-safari` | 390×664 | 3 | 1170×1992 |
| `pricing__mobile-chrome` | 412×839 | 2.625 | 412×839 |

The WebKit capture is 3× the CSS viewport; the Chromium one is 1×, with the
device scale factor discarded. This traces to the capture path in
`packages/playwright/src/snapshot.ts`: the default full-page route opens a CDP
session and calls `Page.captureScreenshot` with `clip: { …, scale: 1 }`. CDP
is Chromium-only, so on WebKit that call fails and the code falls back to
`page.screenshot({ fullPage: true })`, which honours the device scale factor.

**Consequence.** This is a fidelity gap, not a correctness bug. Baselines are
keyed per project, so each variant only ever compares against a baseline
captured the same way — detection is unaffected, and `mobile-chrome` caught
the regression above at 4.29%. What you lose on the Android profile is
sub-CSS-pixel detail: a hairline border or a half-pixel glyph shift that a
2.625× capture would expose can vanish at 1×. It also means diff percentages
are **not comparable across engines** — the 4.29% / 5.42% split above
reflects two different viewports, page heights and capture scales, so it says
nothing about which regression is worse — and the two mobile PNGs should never
be compared to each other.

**Mitigation.** The default capture path has no per-project setting for
this; treat Android captures as 1× CSS pixels and let the WebKit profile be
your high-DPR signal
on screens where fine detail matters. Judge each variant against its own
history, never against another variant.

### The single-project naming trap

The `__<project>` suffix only appears when the config declares **more than
one** project (`packages/playwright/src/snapshot.ts`):

```ts
if (!Array.isArray(projects) || projects.length <= 1) return baseName;
if (typeof projectName !== 'string' || projectName.length === 0) return baseName;
const safeVariant = projectName.replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();
return `${baseName}__${safeVariant}`;
```

Re-running the same spec with a single-project config produced a capture named
plainly `pricing`, with no suffix at all.

**Consequence.** A team that starts mobile-first with one project commits
baselines named `pricing`. The day a desktop project is added, every name
becomes `pricing__mobile-safari` / `pricing__desktop-chrome` — the committed
baselines match nothing. The run reports a wall of new snapshots, and the
orphaned old baselines receive no capture, tripping the missing-baseline gate
(exit `3`, on by default). Nothing is silently wrong, but the whole set needs
re-approving and those names lose their diff history.

**Mitigation.** Declare the project list — at least two entries, including
the desktop one — from day one, even if you only run one device day to day.
Then check the names before your first approve:

```bash
npx playwright test
ls .testivai/temp/      # expect pricing__desktop-chrome, pricing__mobile-safari, …
```

If you are already past that point, the migration is the same as the
cross-browser one: delete the un-suffixed baselines, run once, and approve the
new per-device set.

### The standalone crawler is single-viewport

`testivai witness <url>` — the no-test-suite crawler used for
[vibe-coded apps](./vibe-coded-apps.md) — takes one viewport per run
(`--viewport <WxH>`, default 1280×800) and applies it with
`deviceScaleFactor: 1` and `mobile: false`. It resizes; it does not emulate a
device. Its snapshot names come from the URL path with no viewport component,
so running it at a mobile width would overwrite the desktop baseline for the
same page. Per-viewport keying (`__WxH`) for this path is still open on the
roadmap. If you need both form factors from the crawler, point the two runs
at different `baselinesDir` values — but the supported route for two form
factors is the per-device Playwright projects above.

### The in-project viewport matrix does not exist yet

To be explicit: roadmap item **2.3, "Multi-viewport matrix"** — a
`viewports: [[1280,800],[375,812]]` list inside a *single* project, with one
`witness()` call capturing each — **is not implemented**. Do not write it in
a config; it will be ignored.

Mobile coverage today is achieved with one Playwright **project** per device
profile, which is what this whole guide documents. 2.3 would remove the
per-device project boilerplate; it would not enable mobile, because mobile
already works.

---

## Next steps

- **[Playwright](../frameworks/playwright.md)** — reporter options, per-call
  overrides, masking, and cross-browser projects
- **[CI/CD Integration](./ci-cd.md)** — the gate, exit codes, and sharding
- **[Stable Baselines](./stable-baselines.md)** — reducing false positives
  before you multiply your suite by three devices
