# TestivAI Open Source

[![@testivai/witness](https://img.shields.io/npm/v/@testivai/witness.svg?label=%40testivai%2Fwitness)](https://www.npmjs.com/package/@testivai/witness)
[![@testivai/witness-playwright](https://img.shields.io/npm/v/@testivai/witness-playwright.svg?label=%40testivai%2Fwitness-playwright)](https://www.npmjs.com/package/@testivai/witness-playwright)
[![@testivai/witness-webdriverio](https://img.shields.io/npm/v/@testivai/witness-webdriverio.svg?label=%40testivai%2Fwitness-webdriverio)](https://www.npmjs.com/package/@testivai/witness-webdriverio)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

**Local-first visual regression testing SDKs for modern web applications.**

This is the home of TestivAI. It contains everything you need to capture, diff, and report visual regressions **fully locally** — MIT-licensed, no account, no server.

> **[See a live report →](https://testivai.github.io/testivai-example/demo/)** — a real TestivAI OSS report rendered in your browser, straight from CI. No install, no signup.

[![Real TestivAI report — style-only-change verdict, selector-attributed regions, heatmap diff](./docs/assets/oss-report.png)](https://testivai.github.io/testivai-example/demo/)

## Why TestivAI?

Pixel-only visual testing drowns you in false positives — a font re-hint or an anti-aliasing shift across machines lights up as a "change," and you spend your time re-approving noise.

**TestivAI pairs the screenshot with a snapshot of the page DOM** (every adapter and the crawler capture one by default; the experimental `testivai run` sidecar does not) and, from most test-framework adapters, a digest of every element's computed styles. When pixels differ but the DOM and the computed styles are identical and the diff is small and scattered, the report labels the diff **likely render noise** instead of crying wolf. When the DOM and styles match but the diff sits in one area, it says that too: the style check covers a fixed list of properties, not size, overflow, transform or images, so that is a bad capture or a real change, not noise. It still shows the diff; it tells you what it most likely is. When only the styles changed, it says so: a style-only change is real. When the styles could not be compared, it says *styles not compared* and does not call the diff noise, because a stylesheet-only change is not ruled out. When the DOM actually changed, you see exactly what (`2 added, 1 removed`). That layered signal is the difference between a flaky test wall and a report you trust.

- **Fully local, no account** — captures, diffs, and a self-contained HTML report all stay on your machine.
- **DOM + style-aware noise hint** — tells likely render jitter from real changes, and catches the stylesheet-only case. When both captures carry an element map (the Playwright JS/TS, WebdriverIO, Selenium and Ruby adapters record one), an identical DOM with changed computed styles reads as "Styles changed on `button.cta`", never as noise. Without an element map on both sides (the `testivai witness <url>` crawler, playwright-python, playwright-java), computed styles are not compared, and an identical-DOM diff reads "styles not compared", not "likely render noise".
- **Auditable masks & region-level diffs** — exclude dynamic areas (selectors or coordinates) with the masked region hatched in the diff, and get "3 changed regions" with bounding boxes instead of a raw pixel percentage.
- **Element attribution & exact shift detection** — the report names *which element* changed ("`div.card:nth-of-type(2)` shifted +8px vertically — content unchanged") and spots the injected-banner case ("everything below y=80 moved +24px"), derived from layout, not pixel guesswork. No local-first tool does this.
- **First-class adapters** — Playwright (TS/JS **and Python**, Java experimental) and WebdriverIO, using each framework's native APIs; every language shares one set of baselines and one report.
- **Mobile web, no extra package** — Playwright device emulation works through the same `witness()` call: one project per device profile, baselines keyed per device automatically, and the DOM and computed-style attribution survives emulation, so a change behind a `@media` query is caught on mobile and correctly passes on desktop. See the [mobile web guide](docs/guides/mobile-web.md).
- **PR-native workflow** — a GitHub Action posts the diff and approves baselines from a `/testivai approve` comment, and a companion action can publish each run's report to the repository's [GitHub Pages](docs/github-action.md#reports-on-github-pages), linked from the comment.
- **No lock-in** — MIT license, baselines live in your git, and `results.json` is a semver-governed public contract.

> **Evaluating this for a team?** [Maintenance & roadmap](docs/maintenance.md)
> covers who builds it, the release cadence, and what happens to your setup if
> maintenance ever stops.

> **Already using Playwright's `toHaveScreenshot()`?** It's good, and if a pixel
> diff answers your question you should keep using it. Here's an honest look at
> [what TestivAI adds and when it isn't worth the dependency](docs/vs-playwright-builtin.md).

## Eyes for your coding agent

If an AI agent (Claude Code, Cursor, Copilot, …) writes your UI code, someone still has to check what the UI *looks like* — and it shouldn't be you, one screenshot at a time. TestivAI is built to be that check:

- **No account, no API key, no network** — an agent can run it inside any sandbox without you provisioning secrets.
- **Machine-readable output** — every run writes `visual-report/results.json` (a [semver-governed schema](./docs/how-it-works.md)) with per-snapshot diff percentages and DOM change summaries, so an agent can read the result and self-correct.
- **Noise-aware verdicts** — the DOM and computed-style checks tell the agent whether a pixel diff is *likely render noise* (identical DOM, styles compared and identical, a small and scattered diff), a *concentrated or large diff* (identical DOM and styles, but the diff sits in one area or covers over 1% of pixels: a bad capture or a change the style check does not cover), a *style-only change* (identical DOM, restyled elements), a *real structural change* (`2 added, 1 removed`), *styles not compared* (identical DOM, but no style data to compare, so a stylesheet-only change is not ruled out), or an *unhealthy capture* (a web font or stylesheet failed to load, so the image is not the page as built: never noise, never a baseline). It doesn't chase anti-aliasing ghosts, and it doesn't label a diff it couldn't check as noise.
- **Explanations, bring-your-own-model** — the MCP `explain_snapshot` tool hands your agent layered evidence (which selectors shifted vs changed, whole-page shift detection, style-only changes) and your model writes the narrative: *"card #2 shifted +24px — likely the banner injected above it."* No hosted AI service in the loop.
- **Human approval stays in the PR** — the agent iterates locally; you approve baselines with one `/testivai approve` comment.

Paste this into your project's `AGENTS.md` / `CLAUDE.md` to wire it up (full guide with MCP setup, a real agent transcript, and the approval rule: [docs/guides/ai-agents.md](./docs/guides/ai-agents.md)):

```markdown
## Visual verification
After changing any UI code, run `npx playwright test` (TestivAI captures
screenshots automatically), then read `visual-report/results.json`.
- `status: "changed"` with `dom.changed: true` → describe the DOM summary and
  ask whether the change is intended before approving.
- `status: "changed"` with `dom.changed: false` and `dom.styleCheck: "mismatch"`
  → style-only change; real, not noise. Compare `dom.styleChanges` with what
  you intended.
- `status: "changed"` with `dom.noiseHint: true`, `dom.styleCheck: "match"`,
  `diffPercent` at most 1, and no `regions` or regions spread out (their
  combined box covers more than a third of the page) → likely render noise;
  mention it but don't block.
- `status: "changed"` with `dom.noiseHint: true` and `dom.styleCheck: "match"`
  but every region within a third of the page, or `diffPercent` over 1 → not
  noise: a bad capture or a change the style check does not cover (size,
  overflow, transform, images). Look at the diff image before approving.
- `status: "changed"` with `dom.noiseHint: true` and `dom.styleCheck`
  `"unavailable"` or missing → styles not compared: could be render noise or a
  stylesheet-only change. Don't treat it as noise: look at the diff image before approving.
- `captureHealth.unhealthy` set → unhealthy capture: a web font or stylesheet
  failed to load (`captureHealth.reasons` says which). Never noise: report what
  failed and fix it; never approve it as a baseline. With
  `captureHealth.sameOnBothSides: true` the baseline failed the same way, so
  the pass tolerances still applied: judge the diff, and report the broken asset.
- Never run `testivai approve` yourself — baseline approval is a human decision.
```

## Packages

Live versions are shown by the badges at the top of this README.

| Package | Description |
|---|---|
| [`@testivai/witness`](./packages/witness) | Core SDK: CLI, local diffing, baselines, HTML report generator |
| [`@testivai/witness-playwright`](./packages/playwright) | Playwright reporter/adapter built on top of `@testivai/witness` |
| [`@testivai/witness-webdriverio`](./packages/webdriverio) | WebdriverIO service + capture function (local mode) |
| [`@testivai/witness-selenium`](./packages/selenium) | Selenium WebDriver capture adapter (Python/Java Selenium live in `python/` and `java/`) |
| [`@testivai/mcp`](./packages/mcp) | MCP server — visual results + diff images for AI coding agents |
| [`testivai` (PyPI)](./python) | Python adapter for playwright-python + pytest plugin — same baselines & report |
| [`ai.testiv:testivai`](./java) | Java adapter for playwright-java + JUnit 5 extension (experimental) |
| [`testivai` (RubyGems)](./ruby) | Ruby adapter for Capybara / RSpec / Cucumber — same baselines & report |

Plus:
- [`action/`](./action) — GitHub Action for PR-based visual approvals
- [`examples/`](./examples) — minimal real-world example projects
  - [`examples/site-check/`](./examples/site-check) — an hourly GitHub Actions check that fails when a page is up but broken (stylesheet, script or font missing, JavaScript error, blank page), with one issue per outage. testiv.ai runs it on itself.
- [`docs/`](./docs) — public documentation
- [`e2e/`](./e2e) — OSS smoke E2E test suite

## No test suite? One command.

AI-built and vibe-coded apps (Lovable, Bolt, v0, ...) usually ship with zero
tests. You still get the full safety net:

```bash
npx testivai witness http://localhost:3000
```

TestivAI launches a headless Chrome, discovers your pages (or takes
`--pages "/,/pricing"`), and captures a screenshot and the DOM of each one.
Baselines, pixel and DOM diffs, the HTML report and PR approvals work as
below, no test framework required. The crawler records no element map, so
computed styles are not compared: a pixel diff with an identical DOM reads
*styles not compared* (could be render noise or a stylesheet-only change),
never likely noise, and there is no selector attribution or page-shift
detection. See the [vibe-coded apps guide](./docs/guides/vibe-coded-apps.md).

## Quick Start (Playwright, Local Mode)

```bash
# 1. Install
npm install -D @testivai/witness-playwright @playwright/test
npx playwright install chromium
```

```jsonc
// 2. (OPTIONAL) Customize tolerances and report settings.
// Everything runs locally — no config needed.
// Only create this file if you want to tune threshold, reportDir, etc.
// File: .testivai/config.json
{
  "threshold": 0.1,            // per-pixel color sensitivity (0-1)
  "maxDiffPercent": 0,         // pass diffs at or below this % (your tolerance dial)
  "noiseAutoPass": false,      // true: diffs with identical DOM AND matching computed styles, not concentrated in one area, within noiseMaxDiffPercent, pass
  "stabilize": true,           // freeze animations, hide caret, wait for fonts
  "ignoreSelectors": [],       // e.g. [".live-chat", "[data-testid=clock]"]
  "reportDir": "visual-report",
  "autoOpen": false
}
```

```ts
// 3. Wire the reporter — playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  reporter: [
    ['list'],
    ['@testivai/witness-playwright/reporter'],
  ],
});
```

```ts
// 4. Add a capture call — tests/example.spec.ts
import { test } from '@playwright/test';
import { witness } from '@testivai/witness-playwright';

test('homepage looks correct', async ({ page }, testInfo) => {
  await page.goto('http://localhost:3000');
  await witness(page, testInfo, 'homepage');
});
```

```bash
# 5. Run
npx playwright test
```

**First run:** baselines are written to `.testivai/baselines/`.
**Later runs:** screenshots are diffed and a self-contained HTML report is written to `./visual-report/`.

## What you get out of the box (free, no account)

- Full-page screenshot capture via Playwright
- **Stabilized captures by default** — animations/transitions frozen, caret hidden, web fonts awaited (the top causes of flaky visual tests, neutralized before every screenshot)
- Local pixel diff with configurable threshold
- **Tunable pass criteria, all opt-in** — `maxDiffPercent` / `maxDiffPixels` tolerances, `shiftTolerance` for pure element shifts, and `noiseAutoPass`, which passes a diff only when the DOM is identical, the computed styles were compared and match, and the diff is not concentrated in one area (never one whose styles were not compared). Nothing auto-passes until you configure it, and auto-passed snapshots stay labeled in the report
- `ignoreSelectors` and `mask` for dynamic content such as timestamps (global or per-snapshot): stabilization does not hide changing content, so you list it
- Self-contained HTML report (`visual-report/index.html`)
- Machine-readable results (`visual-report/results.json`)
- Committed baselines under `.testivai/baselines/` (just `git add` them)

## CI Integration (GitHub Actions)

Copy this single workflow file into your repository. It handles both running the visual regression tests **and** processing `/testivai approve` commands from PR comments — no extra secrets, no external services required.

```yaml
# .github/workflows/testivai-oss.yml
name: TestivAI OSS

on:
  pull_request:
    branches: [main]
  issue_comment:
    types: [created]        # listens for /testivai approve commands

permissions:
  contents: write           # approve action commits updated baselines to the branch
  pull-requests: write      # post PR diff comment
  statuses: write           # set pass/fail indicator on the PR
  actions: read             # approve action finds the CI run and downloads its report artifact

jobs:

  # Runs on every PR — captures screenshots, diffs against baselines, posts report
  visual-regression:
    name: Visual Regression (OSS)
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }
      - run: npm ci
      - run: npx playwright install chromium --with-deps
      - run: npm run build
      - run: npm run test:oss          # runs playwright.oss.config.ts

      - name: Post results + upload report
        uses: testivai/testivai-oss@v1
        if: always()
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          report-dir: visual-report   # where @testivai/witness writes results.json

  # Runs when a collaborator comments /testivai approve on the PR
  approve-baselines:
    name: Approve Baselines
    if: |
      github.event_name == 'issue_comment' &&
      github.event.issue.pull_request != null &&
      startsWith(github.event.comment.body, '/testivai')
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: testivai/testivai-oss/approve@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          workflow: testivai-oss.yml   # this file's name — used to find the report artifact

  # Optional: Claude triages every diff as glitch / intended change / bug /
  # possible bug. Skips (no tokens) without the secret, or with enabled: false.
  ai-triage:
    name: AI triage
    needs: visual-regression
    if: ${{ !cancelled() && github.event_name == 'pull_request' }}
    concurrency: { group: 'ai-triage-${{ github.event.pull_request.number }}', cancel-in-progress: true }
    runs-on: ubuntu-latest
    timeout-minutes: 15
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        continue-on-error: true   # no report when the visual job failed early: the triage skips
        with: { name: testivai-visual-report, path: visual-report }
      - uses: testivai/testivai-oss/review@v1
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          # claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}   # instead, for a Claude subscription
          # enabled: false   # turn it off
```

The `ai-triage` job runs on every pull request with a changed or new
snapshot or a missing baseline (unless .testivai/config.json sets
failOnMissing: false) once an `ANTHROPIC_API_KEY` secret is set (or a
`CLAUDE_CODE_OAUTH_TOKEN` secret, passed as `claude-code-oauth-token`), and
posts one advisory comment: which diffs look like glitches, which
match the PR, and which look like bugs. It never changes the check or a
baseline. See [AI triage of every diff](docs/github-action.md#ai-triage-of-every-diff).

### Reports on GitHub Pages

Instead of a ZIP to download, the comment can link the report itself: the
`testivai/testivai-oss/publish@v1` action publishes each pull request's last
runs, forks included, and the default branch's latest run to the repository's
GitHub Pages site, and adds the links to the comment. Each page is rebuilt from
the run's checked `results.json` and PNGs. Who can open the site is GitHub's
Pages setting: a private repository's reports go on a public site only when
an admin says so. It replaces the repository's whole Pages site. See
[Reports on GitHub Pages](docs/github-action.md#reports-on-github-pages).

### Approve changed baselines

After CI posts the diff report on your PR, review the `testivai-visual-report` artifact, then comment:

| Comment | Effect |
|---|---|
| `/testivai approve homepage` | Approves one named snapshot |
| `/testivai approve --all` | Approves every changed snapshot at once |

**What happens:**
1. Action verifies you have **write** access to the repository (others get a polite rejection)
2. Downloads the `testivai-visual-report` artifact from the latest CI run on your branch
3. Copies approved screenshots into `.testivai/baselines/` and commits them to your PR branch
4. Posts a confirmation comment listing what was approved and from which CI run, with a link to that run's report when it is published on GitHub Pages ([publish@v1](docs/github-action.md#reports-on-github-pages))
5. CI runs again on the new commit — approved snapshots now pass

Step 5 needs a token other than `GITHUB_TOKEN`: GitHub starts no workflow run for a push made with `GITHUB_TOKEN`. Give the approve step a fine-grained personal access token (`github-token: ${{ secrets.TESTIVAI_APPROVE_TOKEN || secrets.GITHUB_TOKEN }}`), or push another commit after approving. See [Approve with a token that re-runs CI](docs/github-action.md#approve-with-a-token-that-re-runs-ci).

### What the PR comment looks like

```
TestivAI Visual Report

4 passed | 4 changed | 1 new — 9 total

Changed Snapshots

▼ homepage — 0.31% different
  DOM unchanged — pixel diff is likely render noise (anti-aliasing, font hinting). Styles verified unchanged; the diff is small and scattered.

▼ products — 0.03% different
  DOM and styles unchanged, but the diff is concentrated in one area — 3 regions within 155×52 px, 0.8% of the page: a bad capture, or a change the style check does not cover (size, overflow, position, transform, text decoration, filters, pseudo-elements, or images and other assets). Compare the images before approving.

▼ pricing — 0.42% different
  DOM unchanged, styles not compared — could be render noise or a stylesheet-only change (no comparable style digests on both sides). Compare the images before approving.

▼ dashboard — 8.91% different
  DOM changed — 2 added, 1 removed.
```

---

## Real-World Example

A complete, minimal consumer project lives at [`testivai-example`](https://github.com/testivai/testivai-example): a static page, three `witness()` calls, the PR `/testivai approve` flow, and a [live report on Pages](https://testivai.github.io/testivai-example/demo/), published with `publish@v1` beside the reports of `main` and each open pull request — all against the published packages.

## Repository Layout

```
packages/
  witness/     @testivai/witness              — CLI, diff engine, baselines, report
  playwright/  @testivai/witness-playwright   — Playwright reporter + capture
  webdriverio/ @testivai/witness-webdriverio  — WebdriverIO service + capture
  selenium/    @testivai/witness-selenium     — Selenium adapter
  mcp/         @testivai/mcp                  — MCP server for AI agents
action/        GitHub Action for PR comments
approve/       GitHub Action for /testivai approve
examples/      framework-specific minimal examples
docs/          public documentation (Markdown)
e2e/           OSS smoke E2E
```

## Development

```bash
# Prereqs: Node 20+, pnpm 10+
pnpm install
pnpm build       # tsc all packages
pnpm test        # unit tests across all packages
pnpm e2e         # smoke E2E
pnpm pack:dry    # validate publish artifacts
```

## Contributing

Bug reports, feature requests, and PRs welcome. Please see:
- [`CONTRIBUTING.md`](./CONTRIBUTING.md)
- [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md)
- [`.github/ISSUE_TEMPLATE/`](./.github/ISSUE_TEMPLATE/)

## Releases

Releases are published to npm under the `latest` dist-tag, with provenance
attestations. The flow is Changesets-driven: a PR that changes a published
package adds a changeset, merging it opens a "version packages" PR collecting
the pending bumps, and merging *that* publishes. See
[`.changeset/README.md`](./.changeset/README.md) for the contributor side and
[`.github/workflows/release.yml`](./.github/workflows/release.yml) for the
workflow itself.

## Attribution

This repository was extracted from the private TestivAI monorepo with a clean initial git history. Original development history is preserved internally; this public repository is the new source of truth for the SDKs going forward.

## License

MIT — see [LICENSE](./LICENSE).
