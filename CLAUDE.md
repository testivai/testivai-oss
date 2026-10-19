# testivai-oss — Claude Code Guide

This is the public open-source repository for the TestivAI SDKs.
All packages here enable **fully local visual regression testing** — no account, no API key, no server.

## Repo layout

```
packages/
  witness/     @testivai/witness     — core SDK: CLI, diff engine, baselines, HTML report
  playwright/  @testivai/witness-playwright  — Playwright reporter + capture adapter
  webdriverio/ @testivai/witness-webdriverio — WebdriverIO service + capture
  selenium/    @testivai/witness-selenium    — Selenium WebDriver capture adapter
  mcp/         @testivai/mcp                 — MCP server: results + diff images for AI agents (approve_snapshot/approve_all act only when a human confirms)

action/        testivai/testivai-oss@v1      — GitHub Action: post PR comment + commit status
approve/       testivai/testivai-oss/approve@v1 — GitHub Action: /testivai approve command handler
review/        testivai/testivai-oss/review@v1  — GitHub Action: Claude triages each diff (glitch / intended change / bug / possible bug); advisory, `enabled: false` turns it off
publish/       testivai/testivai-oss/publish@v1 — GitHub Action: publishes reports to the repository's GitHub Pages site, rebuilt from checked data, and links them in PR comments

examples/      minimal working examples per framework
docs/          public Markdown documentation
e2e/           OSS smoke E2E test suite
```

## Package manager

**pnpm** (version set in `packageManager` field of root `package.json`).  
Never use `npm` or `yarn` inside this repo. Use `pnpm` for all installs, builds, test runs.

## Common commands

```bash
pnpm install          # install all workspace deps
pnpm lint             # biome lint (lint-only; no formatter)
pnpm build            # tsc compile all packages
pnpm test             # run unit tests across all packages (jest)
pnpm e2e              # run OSS smoke E2E suite
pnpm pack:dry         # dry-run npm publish to validate artifacts
pnpm changeset        # add a new changeset entry (use before PRs that change public API)
pnpm version-packages # bump versions from changesets (run by CI, rarely manual)
pnpm release          # publish to npm (run by CI release workflow only)
```

## Architecture — how the OSS lane works

```
User writes test
  → calls witness(page, testInfo, 'my-snapshot')
  → @testivai/witness-playwright captures screenshot via Playwright native API
  → @testivai/witness BaselineStore:
      first run  → writes .testivai/baselines/<name>/{screenshot.png, dom.html, metadata.json}
      later runs → writes .testivai/temp/<name>/{screenshot.png, dom.html, metadata.json}
                   then pixel-diffs baseline vs temp
                   then DOM-diffs baseline.dom.html vs temp.dom.html
  → reporter writes visual-report/results.json + visual-report/index.html

CI (GitHub Actions):
  → testivai/testivai-oss@v1  reads results.json, posts PR comment + commit status
                              bundles .testivai/temp/ → visual-report/pending-baselines/
                              uploads testivai-visual-report artifact
  → developer posts /testivai approve [name|--all] in PR comment
  → testivai/testivai-oss/approve@v1  verifies commenter write access
                                      downloads artifact, copies pending-baselines → .testivai/baselines/
                                      commits updated baselines back to PR branch
                                      pushed with a PAT/App token → CI runs again → passes
                                      (GitHub starts no run for a GITHUB_TOKEN push)
```

## Key files per package

### @testivai/witness (`packages/witness/`)
- `src/baselines/store.ts`   — BaselineStore: read/write/approve/undo baselines and temp
- `src/diff/diff.ts`         — pixel comparison (pixelmatch-based)
- `src/diff/dom-diff.ts`     — zero-dep DOM tokenizer + multiset comparator; emits noiseHint
- `src/config/local-config.ts` — LocalConfig type + defaults (single source of truth for config.json fields)
- `src/capture/environment.ts` — capture provenance: the `environment` block every adapter records in metadata.json (host collection, render probe, WebDriver capabilities, `separate` keying)
- `src/report/environment.ts` — what changed since the baseline (`delta` / `renderingDelta`), `isRenderingDrift()`, the shared wording (report, MCP and the action)
- `src/capture/health.ts`    — capture health: `HEALTH_PROBE_EXPRESSION` (what failed to load, read in the page after the capture), `parseHealth`, network-side evidence (`mergeResourceFailures`)
- `src/report/health.ts`     — when a capture is unhealthy (`assessHealth`), `captureHealth` per snapshot, the "Unhealthy capture" wording (report, MCP and the action)
- `src/report/diff-shape.ts` — `diffShape()`: scattered / concentrated / large, the rule for when matching styles still mean likely render noise (shared by compare, the report, MCP and the action)
- `src/report/compare.ts`    — orchestrates diff, writes images to visual-report/images/, applies pass criteria (maxDiffPercent/maxDiffPixels/noiseAutoPass → status passed + autoPassed marker)
- `src/report/generator.ts`  — writes results.json + renders index.html
- `src/report/template.ts`   — HTML template for the report; escapes every value it shows; `snapshotAnchorId()` is each snapshot's link target (`#snap-<name>`), shared with the PR comment
- `src/capture/stable-capture.ts` — fresh-frame wait + capture until two in a row match, guarding against Chrome's wrong-viewport frames in beyond-viewport captures (shared by the standalone CLI and the Playwright and Selenium adapters)

### @testivai/witness-playwright (`packages/playwright/`)
- `src/snapshot.ts`          — `witness()` entry point (stabilizes page, applies ignoreSelectors, captures); `testivai.witness` and `snapshot` are kept as aliases
- `src/config/stabilize.ts`  — capture stabilization CSS + resolution (per-call > project > config.json > default true)
- `src/capture/full-page.ts` — full-page CDP capture: fresh frame, measure, capture until two in a row match (uses `@testivai/witness` stable-capture)
- `src/reporter.ts`          — Playwright reporter (reads config, calls compare, generates report)

### @testivai/witness-selenium (`packages/selenium/`)
- `src/witness.ts`           — `witness()` entry point (stabilizes page, applies ignoreSelectors, captures; viewport screenshot when the driver has no CDP)
- `src/capture/full-page.ts` — full-page CDP capture on Chrome/Edge: fresh frame, measure, capture until two in a row match (uses `@testivai/witness` stable-capture)

### @testivai/mcp (`packages/mcp/`)
- `src/server.ts`            — registers the tools and the `review-visual-changes` and `triage-visual-diff` prompts; starts the stdio server on import
- `src/tool-meta.ts`         — every tool's title and description (what the model reads before calling a tool), and the prompt texts; `TRIAGE_PROMPT.rubric()` is shared with the review action
- `src/lib.ts`               — `verdictFor()` one-line verdicts, `explainSnapshot()` evidence bundle, approve helpers (reuse witness BaselineStore)
- `src/diff-images.ts`       — what `get_diff` returns: the full page downscaled, then native-scale crops of the changed regions (`planCrops`, caps in `CROP_LIMITS`), or one region or band on request

### GitHub Action reporter (`action/`)
- `src/index.ts`             — main entry: reads results.json, bundles pending-baselines, uploads artifact, posts PR comment + commit status
- `src/comment.ts`           — builds PR comment markdown (with DOM noise hint)
- `src/status.ts`            — determines pass/fail commit status
- `src/types.ts`             — shared TypeScript interfaces
- `src/review.ts`            — the review action's logic: when it runs, the triage prompt (MCP rubric), Claude's tools and output schema, the comment
- `src/publish.ts`           — the publish action's github-script steps: `build` (decide, build the site) and `finish` (after the deploy: check it answers, add the links)
- `src/publish/`             — `pages.ts` (publish or not, from the Pages settings; consent `TESTIVAI_PUBLIC_REPORTS`), `plan.ts` (which runs: each open PR's last runs, forks included, and the default branch's latest, under a size budget; folders from numbers only), `archive.ts` (untrusted report ZIP: results.json, run stamp and PNGs only, inflated in slices with caps), `png.ts`, `site.ts` (pages rebuilt from `parseReportData` output with the report template, CSP, noindex; index pages, 404), `comments.ts` (the links in the PR comment; a fork's PR gets the bot's own, numbers and links only), `build.ts` + `api.ts` (orchestration and the GitHub API calls)
- `dist/index.js`, `dist/review.cjs`, `dist/publish.cjs` — bundled output (esbuild); **must be committed**; rebuild with `pnpm run build` inside `action/`

### GitHub Action AI triage (`review/`)
- `action.yml`               — composite action: github-script prepare → `anthropics/claude-code-action@v1` → github-script post; loads `action/dist/review.cjs`, so it ships with the action's dist at the same `v1` tag

### GitHub Action Pages publisher (`publish/`)
- `action.yml`               — composite action: github-script build → `actions/upload-pages-artifact@v5` → `actions/deploy-pages@v5` → github-script finish; loads `action/dist/publish.cjs`, never checks out code; setup in `docs/github-action.md#reports-on-github-pages`

### GitHub Action approver (`approve/`)
- `action.yml`               — composite action: github-script auth → checkout → shell download and apply → commit → github-script reply; the reply loads `action/dist/approve.cjs` (`action/src/approve.ts`: names the approved run, links its published report from the TestivAI comment)

## Changesets (versioning + publishing)

- Each PR that changes public API must include a changeset: `pnpm changeset`
- Changeset files live in `.changeset/*.md`
- On merge to main, the release workflow opens a "Version Packages" PR automatically
- Merging the Version PR triggers `pnpm release` (publish to npm with provenance)
- When that publishes `@testivai/mcp`, `release.yml` calls `.github/workflows/mcp-registry.yml`, which publishes `packages/mcp/server.json` to the MCP Registry as `ai.testiv/mcp` (decisions in `scripts/mcp-registry.js`; setup in CONTRIBUTING.md, "MCP Registry listing")
- Independent versioning: each package has its own version; `updateInternalDependencies: "patch"` cascades

## Action versioning

The GitHub Action (`action.yml` at repo root → `action/dist/index.js`) uses a separate versioning scheme from the npm packages:
- Semver tags like `v1.0.2` are for the action
- The `v1` major tag is rolled automatically by `.github/workflows/release-action.yml` on every clean semver tag push
- After any change to `action/src/`, rebuild dist AND push a new semver tag to roll `v1`

The approve action (`approve/action.yml`) is a composite action; its reply step loads `action/dist/approve.cjs`, so rebuild the dist after changing `action/src/approve.ts`. It ships with the dist at the same `v1` tag. The review action (`review/action.yml`) is composite too, but its logic is `action/dist/review.cjs`: rebuild the dist after changing `action/src/review.ts` (or the MCP triage rubric it bundles). The publish action (`publish/action.yml`) likewise loads `action/dist/publish.cjs`: rebuild after changing `action/src/publish*` or the witness report code it bundles (template, validate).

## .testivai/ directory layout (on-disk contract)

```
.testivai/
  config.json                          — see LocalConfig in
                                         packages/witness/src/config/local-config.ts
                                         (single source of truth): threshold,
                                         reportDir, autoOpen, baselinesDir,
                                         maxDiffPercent, maxDiffPixels, noiseAutoPass,
                                         noiseMaxDiffPercent, stabilize, shiftTolerance,
                                         volatileAttributes, ignoreSelectors, mask,
                                         diffRegions, failOnDiff, failOnMissing,
                                         shareUploadCommand, mcpApprovalPrompt,
                                         environmentPolicy
  baselines/
    <snapshot-name>/
      screenshot.png                   — committed reference screenshot
      dom.html                         — committed DOM snapshot
      metadata.json                    — { name, createdAt, updatedAt, environment, health, ... }
                                         (environment: capture provenance; health: what failed
                                         to load; both frozen on approve)
  temp/
    <snapshot-name>/
      screenshot.png                   — current run screenshot (gitignored)
      dom.html
      metadata.json                    — { environment, health, masks, ... } written by the adapter
```

`temp/` is gitignored. The `approve` action copies `temp/<name>/` → `baselines/<name>/` to update a baseline.

## results.json schema (public contract, semver-governed)

Version constant: `RESULTS_SCHEMA_VERSION` in `packages/witness/src/report/generator.ts`.

```json
{
  "version": "2.6.0",
  "timestamp": "<ISO>",
  "summary": { "total": 5, "passed": 1, "changed": 4, "newSnapshots": 0, "missing": 1 },
  "missingBaselines": ["pricing"],
  "environment": { "os": { "platform": "linux", "distro": "ubuntu 24.04" },
                   "browser": { "name": "chromium", "version": "141.0.7390.37" },
                   "adapter": { "captureMethod": "full-page:cdp" } },
  "snapshots": [
    {
      "name": "homepage",
      "status": "changed",
      "diffPercent": 12.34,
      "baselinePath": "images/homepage/baseline.png",
      "currentPath":  "images/homepage/current.png",
      "diffPath":     "images/homepage/diff.png",
      "baselineApprovedAt": "<ISO>",
      "dom": {
        "changed":   false,
        "noiseHint": false,
        "summary":   null,
        "styleCheck":   "mismatch",
        "styleChanges": { "count": 1, "elements": [".hero > h1"] }
      },
      "regions":   [{ "x": 10, "y": 20, "width": 100, "height": 40,
                      "classification": "change",
                      "elements": [{ "selector": ".hero > h1", "role": "changed" }] },
                    { "x": 0, "y": 120, "width": 1280, "height": 640,
                      "classification": "shift", "shift": { "dx": 0, "dy": -1 },
                      "elements": [{ "selector": "main", "role": "shifted" }] }],
      "pageShift": { "dy": -1, "belowY": 120, "count": 4 },
      "masks": [], "maskWarnings": []
    },
    {
      "name": "footer",
      "status": "passed",
      "diffPercent": 0.3,
      "diffPath":  "images/footer/diff.png",
      "dom": { "changed": false, "noiseHint": true, "summary": null, "styleCheck": "match" },
      "autoPassed": "noise"
    },
    {
      "name": "products",
      "status": "changed",
      "diffPercent": 7.49,
      "sizeMismatch": { "baseline": { "width": 1280, "height": 2348 },
                        "candidate": { "width": 1280, "height": 2538 } },
      "dom": { "changed": true, "noiseHint": false,
               "summary": { "added": 4, "removed": 0, "attributeChanges": 0, "textChanges": 2 } }
    },
    {
      "name": "pricing-table",
      "status": "changed",
      "diffPercent": 0.62,
      "dom": { "changed": false, "noiseHint": true, "summary": null, "styleCheck": "match" },
      "environment": { "delta": ["browser.version", "framework.version"],
                       "renderingDelta": ["browser.version"],
                       "baseline":  { "browser": { "name": "chromium", "version": "130.0.6723.58" } },
                       "candidate": { "browser": { "name": "chromium", "version": "141.0.7390.37" } } }
    },
    {
      "name": "fancy-font",
      "status": "changed",
      "diffPercent": 0.07,
      "dom": { "changed": false, "noiseHint": false, "summary": null, "styleCheck": "match" },
      "captureHealth": { "unhealthy": "candidate",
                         "reasons": ["web font 'Fancy' failed to load, so the page rendered with a fallback font"],
                         "warnings": [],
                         "candidate": { "fonts": { "status": "loaded",
                                                   "failed": [{ "family": "Fancy", "weight": "normal", "style": "normal" }] } } }
    }
  ]
}
```

`environment` (schema 2.5.0) is capture provenance: each adapter records where a capture
came from (OS and distro, browser and version, framework, adapter and capture method,
render settings, CI) in the capture's `metadata.json`, and approving freezes it into the
baseline's. Per snapshot, `environment` is present when both sides recorded one: `delta`
lists every differing field, `renderingDelta` the ones that can change rendering
(framework, adapter and driver versions, the CI runner image and the project are
context only), and both blocks are included when they differ. Pixels differ, the DOM is
identical, styles `"match"`, the diff is not concentrated in one area and
`renderingDelta` is non-empty → **rendering drift**, the environment changed and the page
did not (`isRenderingDrift` in `packages/witness/src/report/environment.ts`): never word
it as render noise. Config `environmentPolicy`: `"warn"` (default) never changes a
status; `"strict"` makes a rendering change `changed` whatever the pixels say
(`environment.policy: "strict"`); `"separate"` has the adapters key snapshots
`<name>__<browser>__<platform>`. The run-level `environment` is the fields every capture
of the run agrees on.

`captureHealth` (schema 2.6.0) is capture health: the Playwright JS/TS adapter and
`testivai witness <url>` record what failed to load (`health` in the capture's
`metadata.json`: web fonts, stylesheets, images, requests that answered 400 or more, read
after the capture by `HEALTH_PROBE_EXPRESSION` in `packages/witness/src/capture/health.ts`),
and approving freezes it into the baseline's. Per snapshot, `captureHealth` is present when
either side recorded one: both blocks, `unhealthy` (`"candidate"`, `"baseline"`, `"both"` or
`null`), and `reasons` and `warnings` in plain words (the baseline's prefixed `baseline: `).
Web fonts still loading, a font face that errored, a failed stylesheet, or a css or font
request that failed → **unhealthy capture** (`assessHealth` in
`packages/witness/src/report/health.ts`): never word it as render noise. `dom.noiseHint` is
then false and no pass criterion applies while pixels differ (a zero-pixel diff still
passes, and the warning is still shown); an unhealthy baseline is called out on every
compare against it (re-baseline from a healthy run); unhealthy and rendering drift can both
be true, unhealthy first. Broken images and failed scripts are warnings only. An adapter
that does not run the probe writes no `health`: not checked, never healthy.

`sizeMismatch` (schema 2.4.0) is present when the current capture's dimensions differ
from the baseline's. The two are padded to max width × max height before diffing and
every padded pixel counts as changed, so `totalPixels`, `diffCount` and `regions` are on
that canvas and the snapshot is never `passed`: no pass criterion applies to a snapshot
with `sizeMismatch`. A DOM change on its own never decides the status: the pixels do
(a zero-count diff passes, a diff within `maxDiffPercent` / `maxDiffPixels` auto-passes),
and the report, the MCP verdicts and the action say when a passed snapshot's DOM differs. A
height change is read with the DOM signal and the page shift: the padded band at the
bottom is the new height, not where the change is (a banner inserted near the top grows
the page too), so `pageShift` places it, `dom.summary` says what changed, and an identical
DOM is the same content laid out taller or shorter (restyled, or fonts and rendering that
differ between machines), never content added or removed. A width change is almost always
the viewport or device scale factor, not the page. Word it that way (`describeSizeChange` /
`explainHeightChange` / `formatSizeMismatch` in `packages/witness/src/report/size-mismatch.ts`,
shared by the report, MCP and the action).

When pixels differ and `dom.changed` is false, `dom.styleCheck` decides the reading:
`"match"` → likely render noise (not proof) only when the diff is also small and
scattered (`diffShape` in `packages/witness/src/report/diff-shape.ts`: at most 1% of
pixels, and no regions or regions spread over more than a third of the page); a
`"match"` diff concentrated in one area, or larger, is a bad capture or a change the
style check does not cover (size, overflow, transform, images…): never word it as
noise; `"mismatch"` → a real style-only change (`noiseHint` is then false);
`"unavailable"`, or absent in older results → styles not compared, so a
stylesheet-only change is not ruled out: never word it as noise.
`noiseAutoPass` gives `autoPassed: "noise"` only to the `"match"` case whose diff is
not concentrated in one area (`noiseHint` true AND `styleCheck: "match"` AND
`diffShape(...).kind !== "concentrated"`, within `noiseMaxDiffPercent`), never to an
unhealthy capture, and `autoPassed` always comes with `status: "passed"`.

Exit-code contract (`packages/witness/src/commands/exit-codes.ts`): 0 pass / 1 changed / 2 new-only (gated by `--fail-on-diff`) / 3 missing-only (`failOnMissing` defaults **true**; escape with config `false` or `--allow-missing`). Precedence: changed > missing > new.

## Terminology

- Core vocabulary: pixel diff, DOM diff, noise hint, layered analysis, baselines, threshold, heatmap.
- TestivAI is **local-first and OSS-only** — there is no hosted service. Never reference a cloud product, dashboard, account, or API key in docs or code; AI-powered explanation is bring-your-own-model via `@testivai/mcp` (`explain_snapshot`). See `docs/philosophy.md`.

## PR conventions

- Branch names: `feat/`, `fix/`, `chore/`, `docs/`
- Every public API change needs a changeset (`pnpm changeset`)
- `action/dist/index.js` must always be committed — CI verifies this
- Composite actions need no build step of their own, but `approve/`, `review/` and `publish/` load `action/dist/*.cjs`: rebuild it with `pnpm run build` in `action/`
